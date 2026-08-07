"""
CRM Routes — SMS & Call communication features for blue-pen.
Separate database (crm.db / Turso) from master/monthly data.
"""

import os, json, re, sqlite3, logging
from datetime import datetime, timezone, timedelta
from fastapi import APIRouter, HTTPException, Request, Header
from fastapi.responses import JSONResponse
from typing import Optional

log = logging.getLogger("online_sheet.crm")

# ── IST midnight helper ─────────────────────────────────────────────────────────
_IST = timezone(timedelta(hours=5, minutes=30))

def _today_midnight_utc() -> str:
    """Return today's 00:00 IST as a UTC timestamp string (for SQLite comparison).
    Example: 2026-07-02 00:00 IST = 2026-07-01 18:30 UTC → '2026-07-01 18:30:00'
    """
    now_ist = datetime.now(_IST)
    midnight_ist = now_ist.replace(hour=0, minute=0, second=0, microsecond=0)
    midnight_utc = midnight_ist.astimezone(timezone.utc)
    return midnight_utc.strftime("%Y-%m-%d %H:%M:%S")

router = APIRouter()

# ── Config ──────────────────────────────────────────────────────────────────────
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
GATEWAY_API_KEY = os.environ.get("GATEWAY_API_KEY", "dev-gateway-key-change-me")
HELP_PHONE1     = os.environ.get("HELP_PHONE1", "9228093681")
HELP_PHONE2     = os.environ.get("HELP_PHONE2", "7984843660")

# ── CRM Database (separate from main online_sheet.db) ───────────────────────────
TURSO_URL   = os.environ.get("TURSO_DATABASE_URL", "")
TURSO_TOKEN = os.environ.get("TURSO_AUTH_TOKEN", "")
USE_TURSO   = bool(TURSO_URL and TURSO_TOKEN)
CRM_DB_PATH = os.path.join(BASE_DIR, "crm.db")


def dict_factory(cursor, row):
    return dict(zip([col[0] for col in cursor.description], row))


def get_crm_db():
    """CRM database connection — Turso in production, local SQLite in dev."""
    if USE_TURSO:
        # Reuse TursoConn from main module
        from main import TursoConn
        conn = TursoConn(TURSO_URL, TURSO_TOKEN)
    else:
        conn = sqlite3.connect(CRM_DB_PATH)
        conn.execute("PRAGMA journal_mode=WAL")
    conn.row_factory = dict_factory
    return conn


def init_crm_db():
    with get_crm_db() as conn:
        conn.execute("""CREATE TABLE IF NOT EXISTS sms_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            policy_no TEXT NOT NULL,
            name TEXT NOT NULL,
            mobile TEXT NOT NULL,
            message TEXT NOT NULL,
            status TEXT DEFAULT 'pending',
            retry_count INTEGER DEFAULT 0,
            batch_id TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            processed_at TIMESTAMP
        )""")
        conn.execute("""CREATE TABLE IF NOT EXISTS sms_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            policy_no TEXT NOT NULL,
            name TEXT NOT NULL,
            mobile TEXT NOT NULL,
            message TEXT NOT NULL,
            status TEXT NOT NULL,
            sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )""")
        conn.execute("""CREATE TABLE IF NOT EXISTS call_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            policy_no TEXT NOT NULL,
            name TEXT NOT NULL,
            mobile TEXT NOT NULL,
            status TEXT DEFAULT 'pending',
            triggered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )""")
        conn.execute("""CREATE TABLE IF NOT EXISTS gateway_heartbeat (
            id INTEGER PRIMARY KEY DEFAULT 1,
            last_seen TIMESTAMP
        )""")
        # Ensure heartbeat row exists
        conn.execute("INSERT OR IGNORE INTO gateway_heartbeat (id, last_seen) VALUES (1, NULL)")


# GSM 7-bit only (no Unicode like ₹ — that triggers UCS-2 = 70 chars/segment).
# Rs. with commas (Rs.12,340) is detected by most phones as currency.
# +91 XXXXXXXXXX with space makes phone numbers tappable.
# Keep each template under 160 chars with typical data (1 SMS segment).
# Use simple language — no jargon (ASAP, sufficient, etc).

TEMPLATE_DUE = (
    "Dear {name}, Rs.{premium} due for Policy {policy_no}, "
    "not paid for {fup_month}. Please pay now to avoid penalty. "
    "Call +91 {help_phone1}"
)

TEMPLATE_AUTODEBIT = (
    "Dear {name}, Rs.{premium} for Policy {policy_no} ({fup_month}) "
    "auto debit on {debit_date}. Keep balance ready. "
    "Call +91 {help_phone1}, +91 {help_phone2}"
)

MONTH_NAMES = [
    "", "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
]


def format_fup_month(fup: str) -> str:
    """'01/07/2026' → 'July 2026'"""
    parts = fup.split("/")
    if len(parts) == 3:
        m, y = int(parts[1]), parts[2]
        if 1 <= m <= 12:
            return f"{MONTH_NAMES[m]} {y}"
    return fup


def get_debit_date(doc: str, fup: str) -> str:
    """Calculate auto debit date from DOC day + FUP month/year."""
    doc_day = int(doc.split("/")[0])
    fup_parts = fup.split("/")
    fup_month = int(fup_parts[1]) if len(fup_parts) >= 2 else 1
    fup_year  = fup_parts[2] if len(fup_parts) >= 3 else "2026"

    if doc_day <= 7:    debit_day = 7
    elif doc_day <= 14: debit_day = 14
    elif doc_day <= 21: debit_day = 21
    else:               debit_day = 28

    ordinal = "st" if debit_day == 21 else "th"
    month_name = MONTH_NAMES[fup_month] if 1 <= fup_month <= 12 else str(fup_month)
    return f"{debit_day}{ordinal} {month_name} {fup_year}"


def _format_indian_amount(val: str) -> str:
    """Format amount with Indian-style commas: 1,23,456"""
    try:
        n = int(str(val).replace(",", "").strip())
        s = str(n)
        if len(s) > 3:
            last3 = s[-3:]
            rest = s[:-3]
            parts = []
            while len(rest) > 2:
                parts.insert(0, rest[-2:])
                rest = rest[:-2]
            if rest:
                parts.insert(0, rest)
            return ",".join(parts) + "," + last3
        return s
    except (ValueError, TypeError):
        return str(val)


def render_sms(contact: dict) -> str:
    """Render SMS template based on contact status."""
    status = (contact.get("status") or "").strip().lower()
    fup = contact.get("fup", "")
    doc = contact.get("doc", "")
    fup_month = format_fup_month(fup)

    base = {
        "name": contact.get("name", ""),
        "premium": _format_indian_amount(contact.get("premium", "")),
        "policy_no": contact.get("policy_no", ""),
        "fup_month": fup_month,
        "help_phone1": HELP_PHONE1,
        "help_phone2": HELP_PHONE2,
    }

    if status in ("autodebit", "auto debit"):
        base["debit_date"] = get_debit_date(doc, fup)
        return TEMPLATE_AUTODEBIT.format(**base)
    else:
        return TEMPLATE_DUE.format(**base)


# ── Auth helper ─────────────────────────────────────────────────────────────────

def verify_gateway_key(key: Optional[str]):
    if not key or key != GATEWAY_API_KEY:
        raise HTTPException(status_code=401, detail="Invalid gateway key")


# ══════════════════════════════════════════════════════════════════════════════════
# API ROUTES
# ══════════════════════════════════════════════════════════════════════════════════

# ── SMS Send (frontend → queue) ─────────────────────────────────────────────────

@router.post("/api/sms/send")
async def sms_send(request: Request):
    """Receive contacts, render templates, insert to sms_queue."""
    body = await request.json()
    contacts = body.get("contacts", [])
    if not contacts:
        raise HTTPException(400, "No contacts provided")

    batch_id = datetime.now().strftime("%Y%m%d%H%M%S")
    inserted = 0

    with get_crm_db() as conn:
        for c in contacts:
            mobile = (c.get("mobile") or "").strip()
            if not mobile:
                continue
            message = render_sms(c)
            conn.execute(
                "INSERT INTO sms_queue (policy_no, name, mobile, message, batch_id) VALUES (?,?,?,?,?)",
                (c.get("policy_no", ""), c.get("name", ""), mobile, message, batch_id)
            )
            inserted += 1

    return {"ok": True, "queued": inserted, "batch_id": batch_id}


# ── Custom SMS — Overdue + Blank Templates ──────────────────────────────────────

# Mode → step in months (how many calendar months between payment periods)
MODE_STEP = {
    "mly": 1, "monthly": 1,
    "qly": 3, "quarterly": 3,
    "hly": 6, "half yearly": 6, "half-yearly": 6,
    "yly": 12, "yearly": 12,
}

MONTH_ABBR = [
    "", "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
]


def parse_due_months(text: str):
    """Parse freeform text like '4 months 12340 rs' → (count, amount).
    Handles: '4 months 12340 rupees', '4 month 12340 rs', '3 months 5000 rupeess'
    Returns (None, None) if unparseable.
    """
    if not text or not text.strip():
        return None, None
    t = text.strip().lower()
    # Extract the number before 'month'
    m_count = re.search(r'(\d+)\s*months?', t)
    # Extract the number that's NOT the month count (the amount)
    m_amount = re.search(r'(\d+)\s*(?:rupee|rs|rupes)', t)
    if not m_amount:
        # fallback: second number in the string
        nums = re.findall(r'\d+', t)
        if len(nums) >= 2:
            m_amount_val = int(nums[1])
        else:
            m_amount_val = None
    else:
        m_amount_val = int(m_amount.group(1))

    count = int(m_count.group(1)) if m_count else None
    return count, m_amount_val


def calc_overdue_months(mode_str: str, count: int):
    """Calculate which months are due working backwards from current month.
    Returns list of (month_number, year) tuples, oldest first.
    """
    step = MODE_STEP.get((mode_str or "").strip().lower(), 1)
    now = datetime.now(_IST)
    cur_m, cur_y = now.month, now.year
    result = []
    for i in range(count):
        m = cur_m - (i * step)
        y = cur_y
        while m <= 0:
            m += 12
            y -= 1
        result.append((m, y))
    result.reverse()  # oldest first
    return result


def render_overdue_sms(contact: dict) -> str:
    """Build overdue SMS from contact data + due_months field."""
    due_text = contact.get("due_months", "")
    count, amount = parse_due_months(due_text)
    if count is None or amount is None:
        return None  # can't render without both

    mode = contact.get("mode", "MLY")
    months = calc_overdue_months(mode, count)

    if count <= 4:
        months_text = ", ".join(f"{MONTH_ABBR[m]}'{str(y)[-2:]}" for m, y in months)
    else:
        months_text = f"{count} months"

    name = contact.get("name", "")
    pno = contact.get("policy_no", "")

    amt_str = _format_indian_amount(amount)

    # Build SMS — simple language, under 160 chars
    msg = (
        f"Dear {name}, Policy {pno} "
        f"{months_text} not paid. "
        f"Rs.{amt_str} + late fee due. "
        f"Please pay now. Call +91 {HELP_PHONE1}"
    )
    return msg


def render_blank_sms(contact: dict, template: str) -> str:
    """Replace tags in user-written template with contact values."""
    replacements = {
        "{Name}": contact.get("name", ""),
        "{POL-NUM}": contact.get("policy_no", ""),
        "{Premium}": contact.get("premium", ""),
        "{FUP}": contact.get("fup", ""),
        "{Mobile}": contact.get("mobile", ""),
        "{Mode}": contact.get("mode", ""),
    }
    msg = template
    for tag, val in replacements.items():
        msg = msg.replace(tag, val)
    return msg


@router.post("/api/sms/preview-overdue")
async def sms_preview_overdue(request: Request):
    """Preview overdue SMS — renders messages for each contact without queuing.
    Returns array of {policy_no, name, message} or {policy_no, name, error}."""
    body = await request.json()
    contacts = body.get("contacts", [])
    if not contacts:
        raise HTTPException(400, "No contacts provided")

    previews = []
    for c in contacts:
        pno = c.get("policy_no", "?")
        name = c.get("name", "")
        message = render_overdue_sms(c)
        if message is None:
            previews.append({"policy_no": pno, "name": name, "error": "Missing/invalid due_months"})
        else:
            previews.append({"policy_no": pno, "name": name, "message": message, "chars": len(message)})
    return {"previews": previews}


@router.post("/api/sms/send-custom")
async def sms_send_custom(request: Request):
    """Send custom SMS — overdue template or blank user-written template.
    Completely separate from the normal SMS send flow.
    """
    body = await request.json()
    template_type = body.get("template_type", "")  # "overdue" or "custom"
    custom_message = body.get("custom_message", "")
    contacts = body.get("contacts", [])

    if not contacts:
        raise HTTPException(400, "No contacts provided")
    if template_type not in ("overdue", "custom"):
        raise HTTPException(400, "template_type must be 'overdue' or 'custom'")
    if template_type == "custom" and not custom_message.strip():
        raise HTTPException(400, "custom_message is required for custom template")

    batch_id = "C" + datetime.now().strftime("%Y%m%d%H%M%S")
    inserted = 0
    skipped = []

    with get_crm_db() as conn:
        for c in contacts:
            mobile = (c.get("mobile") or "").strip()
            if not mobile:
                continue

            if template_type == "overdue":
                message = render_overdue_sms(c)
                if message is None:
                    skipped.append(c.get("policy_no", "?"))
                    continue
            else:
                message = render_blank_sms(c, custom_message)

            conn.execute(
                "INSERT INTO sms_queue (policy_no, name, mobile, message, batch_id) VALUES (?,?,?,?,?)",
                (c.get("policy_no", ""), c.get("name", ""), mobile, message, batch_id)
            )
            inserted += 1

    result = {"ok": True, "queued": inserted, "batch_id": batch_id}
    if skipped:
        result["skipped"] = skipped
        result["skipped_reason"] = "Missing or invalid due_months data"
    return result



@router.get("/api/sms/queue")
async def sms_queue_poll(x_gateway_key: Optional[str] = Header(None)):
    """Android polls: returns ONE pending job, marks it 'processing'.
    Rate limits: 60s between sends, max 60 per 24 hours."""
    verify_gateway_key(x_gateway_key)

    with get_crm_db() as conn:
        # Check daily limit: max 60 SMS per day (resets at midnight IST)
        cutoff = _today_midnight_utc()
        sent_today = conn.execute(
            "SELECT COUNT(*) as cnt FROM sms_logs WHERE sent_at >= ?", (cutoff,)
        ).fetchone()
        if (sent_today or {}).get("cnt", 0) >= 50:
            return {"job": None, "reason": "daily_limit", "limit": 50}

        # Check 60-second gap since last send
        last_sent = conn.execute(
            "SELECT sent_at FROM sms_logs ORDER BY id DESC LIMIT 1"
        ).fetchone()
        if last_sent and last_sent.get("sent_at"):
            try:
                ts = last_sent["sent_at"]
                ls_dt = datetime.strptime(ts, "%Y-%m-%d %H:%M:%S") if " " in ts else datetime.fromisoformat(ts.replace("Z", "+00:00"))
                elapsed = (datetime.utcnow() - ls_dt).total_seconds()
                if elapsed < 60:
                    return {"job": None, "reason": "cooldown", "wait": int(60 - elapsed)}
            except Exception:
                pass

        job = conn.execute(
            "SELECT id, policy_no, name, mobile, message FROM sms_queue "
            "WHERE status = 'pending' ORDER BY id ASC LIMIT 1"
        ).fetchone()

        if not job:
            return {"job": None}

        conn.execute("UPDATE sms_queue SET status = 'processing' WHERE id = ?", (job["id"],))

    return {"job": job}


@router.post("/api/sms/queue/{job_id}")
async def sms_queue_report(job_id: int, request: Request, x_gateway_key: Optional[str] = Header(None)):
    """Android reports: done or failed. On done → copy to sms_logs, delete from queue."""
    verify_gateway_key(x_gateway_key)
    body = await request.json()
    status = body.get("status", "failed")

    with get_crm_db() as conn:
        job = conn.execute("SELECT * FROM sms_queue WHERE id = ?", (job_id,)).fetchone()
        if not job:
            raise HTTPException(404, "Job not found")

        if status == "done":
            conn.execute(
                "INSERT INTO sms_logs (policy_no, name, mobile, message, status) VALUES (?,?,?,?,?)",
                (job["policy_no"], job["name"], job["mobile"], job["message"], "sent")
            )
            conn.execute("DELETE FROM sms_queue WHERE id = ?", (job_id,))
        elif status == "failed":
            retry = (job.get("retry_count") or 0) + 1
            if retry >= 3:
                conn.execute(
                    "INSERT INTO sms_logs (policy_no, name, mobile, message, status) VALUES (?,?,?,?,?)",
                    (job["policy_no"], job["name"], job["mobile"], job["message"], "failed")
                )
                conn.execute("DELETE FROM sms_queue WHERE id = ?", (job_id,))
            else:
                conn.execute(
                    "UPDATE sms_queue SET status = 'pending', retry_count = ? WHERE id = ?",
                    (retry, job_id)
                )

    return {"ok": True}


# ── SMS Queue Cancel (individual item) ────────────────────────────────────────

@router.delete("/api/sms/queue/{job_id}")
async def sms_queue_cancel(job_id: int):
    """Cancel a single pending SMS from the queue."""
    with get_crm_db() as conn:
        job = conn.execute("SELECT id, status FROM sms_queue WHERE id = ?", (job_id,)).fetchone()
        if not job:
            raise HTTPException(404, "Job not found")
        conn.execute("DELETE FROM sms_queue WHERE id = ?", (job_id,))
    return {"ok": True}


# ── SMS Queue Cancel All ──────────────────────────────────────────────────────

@router.delete("/api/sms/queue")
async def sms_queue_cancel_all():
    """Cancel all pending SMS from the queue."""
    with get_crm_db() as conn:
        deleted = conn.execute("DELETE FROM sms_queue WHERE status IN ('pending', 'processing')").rowcount
    return {"ok": True, "cancelled": deleted}


# ── SMS Queue Status (frontend polls progress) ────────────────────────────────

@router.get("/api/sms/queue/status")
async def sms_queue_status():
    """Frontend polls: returns batch progress."""
    cutoff = _today_midnight_utc()

    with get_crm_db() as conn:
        rows = conn.execute(
            "SELECT id, policy_no, name, status FROM sms_queue ORDER BY id ASC"
        ).fetchall()

        # All-time sent/failed from sms_logs
        all_sent = conn.execute("SELECT COUNT(*) as cnt FROM sms_logs WHERE status = 'sent'").fetchone()
        all_failed = conn.execute("SELECT COUNT(*) as cnt FROM sms_logs WHERE status = 'failed'").fetchone()

        # Today's sent (for rate limit display)
        sent_row = conn.execute(
            "SELECT COUNT(*) as cnt FROM sms_logs WHERE status = 'sent' AND sent_at >= ?", (cutoff,)
        ).fetchone()

        # Recent log items (last 50) for display in queue view
        log_items = conn.execute(
            "SELECT id, policy_no, name, status, sent_at FROM sms_logs ORDER BY sent_at DESC LIMIT 50"
        ).fetchall()

    sent_today = (sent_row or {}).get("cnt", 0)
    total_sent = (all_sent or {}).get("cnt", 0)
    total_failed = (all_failed or {}).get("cnt", 0)
    processing = sum(1 for r in rows if r["status"] == "processing")
    pending = sum(1 for r in rows if r["status"] == "pending")

    current = None
    for r in rows:
        if r["status"] == "processing":
            current = {"policy_no": r["policy_no"], "name": r["name"]}
            break

    return {
        "total": pending + processing, "done": total_sent, "failed": total_failed,
        "processing": processing, "pending": pending,
        "current": current, "items": rows, "logs": log_items,
        "sent_today": sent_today, "daily_limit": 50,
        "daily_remaining": max(0, 50 - sent_today)
    }


# ── Calls Trigger ──────────────────────────────────────────────────────────────

@router.post("/api/calls/trigger")
async def calls_trigger(request: Request):
    """Insert a call job for Android to pick up."""
    body = await request.json()
    policy_no = body.get("policy_no", "")
    name = body.get("name", "")
    mobile = (body.get("mobile") or "").strip()
    if not mobile:
        raise HTTPException(400, "No mobile number")

    with get_crm_db() as conn:
        conn.execute(
            "INSERT INTO call_logs (policy_no, name, mobile) VALUES (?,?,?)",
            (policy_no, name, mobile)
        )

    return {"ok": True}


# ── Calls Queue (Android polls) ───────────────────────────────────────────────
# Call logs double as queue — last unprocessed entry = pending call

@router.get("/api/calls/queue")
async def calls_queue_poll(x_gateway_key: Optional[str] = Header(None)):
    """Android polls: returns ONE pending call, marks it 'picked' immediately.
    Each call fires exactly once — never re-returned."""
    verify_gateway_key(x_gateway_key)

    with get_crm_db() as conn:
        job = conn.execute(
            "SELECT id, policy_no, name, mobile FROM call_logs "
            "WHERE status = 'pending' ORDER BY id DESC LIMIT 1"
        ).fetchone()

        if job:
            # Mark as picked immediately — will never be returned again
            conn.execute("UPDATE call_logs SET status = 'picked' WHERE id = ?", (job["id"],))

    return {"job": job}


@router.post("/api/calls/queue/{job_id}")
async def calls_queue_report(job_id: int, request: Request, x_gateway_key: Optional[str] = Header(None)):
    """Android reports call result. Already logged — just acknowledge."""
    verify_gateway_key(x_gateway_key)
    return {"ok": True}


# ── Gateway Heartbeat ──────────────────────────────────────────────────────────

@router.post("/api/gateway/ping")
@router.get("/api/gateway/ping")
async def gateway_ping(
    x_gateway_key: Optional[str] = Header(None),
    key: Optional[str] = None,  # Allow ?key= query param for browser testing
):
    """Android posts every 30s to signal it's alive."""
    effective_key = x_gateway_key or key
    verify_gateway_key(effective_key)

    now_utc = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    with get_crm_db() as conn:
        conn.execute("UPDATE gateway_heartbeat SET last_seen = ? WHERE id = 1", (now_utc,))
    log.info(f"Gateway ping received, last_seen={now_utc}")

    return {"ok": True, "last_seen": now_utc}


@router.get("/api/gateway/status")
async def gateway_status():
    """Frontend checks: is Android gateway online?"""
    with get_crm_db() as conn:
        row = conn.execute("SELECT last_seen FROM gateway_heartbeat WHERE id = 1").fetchone()

    if not row or not row.get("last_seen"):
        log.warning("Gateway status: no last_seen in DB")
        return {"online": False, "last_seen": None}

    last = row["last_seen"]
    # Online = last_seen within 2 minutes
    try:
        ls_dt = datetime.fromisoformat(last.replace("Z", "+00:00")) if "T" in last else datetime.strptime(last, "%Y-%m-%d %H:%M:%S")
        now = datetime.utcnow()
        diff = (now - ls_dt).total_seconds()
        online = diff < 120
        if not online:
            log.warning(f"Gateway offline: last_seen={last}, now={now.strftime('%Y-%m-%d %H:%M:%S')}, diff={diff:.0f}s")
    except Exception as exc:
        log.error(f"Gateway status parse error: last_seen={last!r}, err={exc}")
        online = False

    return {"online": online, "last_seen": last}


# ── Logs (frontend history tab) ────────────────────────────────────────────────

@router.get("/api/sms/logs")
async def sms_logs():
    """Recent SMS history — last 50."""
    with get_crm_db() as conn:
        rows = conn.execute(
            "SELECT policy_no, name, mobile, message, status, sent_at FROM sms_logs ORDER BY id DESC LIMIT 50"
        ).fetchall()
    return {"logs": rows}


@router.get("/api/calls/logs")
async def call_logs_list():
    """Recent call history — last 50."""
    with get_crm_db() as conn:
        rows = conn.execute(
            "SELECT policy_no, name, mobile, triggered_at FROM call_logs ORDER BY id DESC LIMIT 50"
        ).fetchall()
    return {"logs": rows}
