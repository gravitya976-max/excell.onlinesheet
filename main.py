"""
Online Sheet — Monthly Due List Generator (v2)
Upload Excel sheets → Master Data → Generate Monthly Due Lists.
Local dev: SQLite file. Production (Render): Turso cloud via libsql-experimental.
"""

import os, json, sqlite3, math, asyncio, logging
from datetime import datetime, date

log = logging.getLogger("online_sheet")
from fastapi import FastAPI, HTTPException, Query, Request, UploadFile, File
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, JSONResponse

from contextlib import asynccontextmanager

@asynccontextmanager
async def lifespan(app):
    """Start background sync task on startup, cancel on shutdown."""
    task = asyncio.create_task(master_sync_loop())
    yield
    task.cancel()
    try: await task
    except asyncio.CancelledError: pass

app = FastAPI(title="Online Sheet", lifespan=lifespan)

SYNC_INTERVAL_SECONDS = 180  # 3 minutes

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
os.makedirs(STATIC_DIR, exist_ok=True)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

# ── Database ────────────────────────────────────────────────────────────────────
# Local dev  → plain SQLite file (online_sheet.db)
# Production → Turso cloud DB via libsql-experimental (set env vars on Render)

TURSO_URL   = os.environ.get("TURSO_DATABASE_URL", "")
TURSO_TOKEN = os.environ.get("TURSO_AUTH_TOKEN", "")
USE_TURSO   = bool(TURSO_URL and TURSO_TOKEN)

DB_PATH = os.path.join(BASE_DIR, "online_sheet.db")  # always keep local file for fallback

if USE_TURSO:
    try:
        import libsql_experimental as libsql
        log.info("Turso / libsql-experimental loaded ✓")
    except ImportError:
        log.warning("libsql-experimental not installed — falling back to local SQLite")
        USE_TURSO = False


def dict_factory(cursor, row):
    return dict(zip([col[0] for col in cursor.description], row))


def get_db():
    """Return a DB connection. Turso in production, SQLite locally."""
    if USE_TURSO:
        conn = libsql.connect(
            database=DB_PATH,      # local replica cache
            sync_url=TURSO_URL,
            auth_token=TURSO_TOKEN,
        )
        conn.sync()                # pull latest state from Turso
    else:
        conn = sqlite3.connect(DB_PATH)
        conn.execute("PRAGMA journal_mode=WAL")

    conn.row_factory = dict_factory
    return conn


def db_push():
    """Push writes to Turso (no-op when running locally)."""
    if USE_TURSO:
        conn = libsql.connect(
            database=DB_PATH,
            sync_url=TURSO_URL,
            auth_token=TURSO_TOKEN,
        )
        try:
            conn.sync()
        finally:
            conn.close()


NOTE_COLS = [f"note{i}" for i in range(1, 11)]  # note1..note10

def init_db():
    with get_db() as conn:
        conn.execute("""CREATE TABLE IF NOT EXISTS master_policies (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            policyno TEXT UNIQUE NOT NULL,
            name TEXT, doc TEXT, fup TEXT, sumass TEXT,
            plan TEXT, mode TEXT, premium TEXT, mobileno TEXT, status TEXT,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )""")
        conn.execute("""CREATE TABLE IF NOT EXISTS monthly_lists (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            year INTEGER NOT NULL, month INTEGER NOT NULL,
            generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            source_total INTEGER DEFAULT 0, filtered_count INTEGER DEFAULT 0,
            UNIQUE(year, month)
        )""")
        conn.execute("""CREATE TABLE IF NOT EXISTS monthly_entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            list_id INTEGER NOT NULL, policyno TEXT NOT NULL,
            name TEXT, doc TEXT, fup TEXT, sumass TEXT,
            plan TEXT, mode TEXT, premium TEXT, mobileno TEXT, status TEXT,
            fup_day INTEGER DEFAULT 0,
            note1 TEXT DEFAULT '', note2 TEXT DEFAULT '', note3 TEXT DEFAULT '',
            note4 TEXT DEFAULT '', note5 TEXT DEFAULT '', note6 TEXT DEFAULT '',
            note7 TEXT DEFAULT '', note8 TEXT DEFAULT '', note9 TEXT DEFAULT '',
            note10 TEXT DEFAULT '',
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(list_id, policyno)
        )""")
        conn.execute("""CREATE TABLE IF NOT EXISTS pending_syncs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            policyno TEXT NOT NULL,
            field TEXT NOT NULL,
            value TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )""")
        # Migrate: add note columns if missing
        existing_cols = {r["name"] for r in conn.execute("PRAGMA table_info(monthly_entries)").fetchall()}
        for nc in NOTE_COLS:
            if nc not in existing_cols:
                conn.execute(f"ALTER TABLE monthly_entries ADD COLUMN {nc} TEXT DEFAULT ''")
    db_push()

init_db()

# ── Background sync: flush pending edits to master every 3 min ─────────────────

# Fields that should NEVER sync to master when changed in monthly list
_STATUS_SKIP = {"due", "paid", ""}

async def master_sync_loop():
    """Every 3 minutes, flush pending_syncs → master_policies."""
    while True:
        await asyncio.sleep(SYNC_INTERVAL_SECONDS)
        try:
            flush_pending_syncs()
        except Exception as e:
            log.error(f"Sync error: {e}")

def flush_pending_syncs():
    """Process all pending syncs: apply to master_policies, then clear."""
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM pending_syncs ORDER BY created_at ASC"
        ).fetchall()
        if not rows:
            return

        # Group by policyno → latest value per field wins
        updates_map = {}  # policyno → { field: value }
        for r in rows:
            pno = r["policyno"]
            field = r["field"]
            value = r["value"]
            if pno not in updates_map:
                updates_map[pno] = {}
            updates_map[pno][field] = value

        for pno, fields in updates_map.items():
            sets, params = [], []
            for f, v in fields.items():
                sets.append(f"{f} = ?")
                params.append(v)
            if sets:
                sets.append("updated_at = ?")
                params.append(datetime.now().isoformat())
                params.append(pno)
                conn.execute(
                    f"UPDATE master_policies SET {', '.join(sets)} WHERE policyno = ?",
                    params
                )

        conn.execute("DELETE FROM pending_syncs")
    db_push()
    log.info(f"Synced {len(rows)} pending edits to master.")

# ── Import data processor (after DB init) ──────────────────────────────────────

from data_processor import (
    FIELDS, parse_excel, clean_val, normalize_policyno,
    is_due_in_month, calc_fup_for_month, status_for_list, parse_date
)

# ── Master data upsert ─────────────────────────────────────────────────────────

def upsert_master(records):
    """Insert or progressively enrich master data. Never duplicate."""
    inserted, updated = 0, 0
    non_pno = [f for f in FIELDS if f != "policyno"]

    with get_db() as conn:
        for rec in records:
            pno = rec.get("policyno")
            if not pno:
                continue
            existing = conn.execute(
                "SELECT * FROM master_policies WHERE policyno = ?", (pno,)
            ).fetchone()

            if existing:
                # Only fill empty fields (progressive enrichment)
                updates, params = [], []
                for f in non_pno:
                    new_val = rec.get(f)
                    if not new_val:
                        continue
                    old_val = existing.get(f)
                    if not old_val or str(old_val).strip() == "":
                        updates.append(f"{f} = ?")
                        params.append(new_val)
                if updates:
                    updates.append("updated_at = ?")
                    params.append(datetime.now().isoformat())
                    params.append(pno)
                    conn.execute(
                        f"UPDATE master_policies SET {', '.join(updates)} WHERE policyno = ?",
                        params
                    )
                    updated += 1
            else:
                vals = {f: rec.get(f) for f in FIELDS}
                vals["policyno"] = pno
                vals["updated_at"] = datetime.now().isoformat()
                cols = list(vals.keys())
                conn.execute(
                    f"INSERT INTO master_policies ({','.join(cols)}) VALUES ({','.join('?' for _ in cols)})",
                    [vals[c] for c in cols]
                )
                inserted += 1
    return inserted, updated


# ── Endpoints ──────────────────────────────────────────────────────────────────

@app.get("/")
def root():
    return HTMLResponse(open(os.path.join(BASE_DIR, "index.html"), encoding="utf-8").read())


@app.api_route("/health", methods=["GET", "HEAD"])
def health():
    return {"status": "ok"}


# ── Upload ─────────────────────────────────────────────────────────────────────

@app.post("/api/upload")
async def upload_files(files: list[UploadFile] = File(...)):
    """Upload Excel files → parse → upsert into master data."""
    results = {"files_processed": 0, "total_inserted": 0, "total_updated": 0,
               "total_records": 0, "errors": []}

    for f in files:
        try:
            content = await f.read()
            records = parse_excel(content, f.filename)
            results["total_records"] += len(records)
            ins, upd = upsert_master(records)
            results["total_inserted"] += ins
            results["total_updated"] += upd
            results["files_processed"] += 1
        except Exception as e:
            results["errors"].append({"file": f.filename, "error": str(e)})

    db_push()
    return results


# ── Master data ────────────────────────────────────────────────────────────────

@app.get("/api/master")
def get_master(limit: int = Query(100, ge=1, le=5000), offset: int = Query(0, ge=0)):
    """Get master policy data (paginated)."""
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM master_policies ORDER BY id DESC LIMIT ? OFFSET ?",
            (limit, offset)
        ).fetchall()
        total = conn.execute("SELECT COUNT(*) AS cnt FROM master_policies").fetchone()["cnt"]
    return {"total": total, "data": [dict(r) for r in rows]}


@app.get("/api/master/count")
def master_count():
    with get_db() as conn:
        cnt = conn.execute("SELECT COUNT(*) AS cnt FROM master_policies").fetchone()["cnt"]
    return {"count": cnt}


@app.delete("/api/master")
def clear_master(confirm: str = Query(...)):
    if confirm != "yes":
        raise HTTPException(400, "Pass ?confirm=yes")
    with get_db() as conn:
        conn.execute("DELETE FROM master_policies")
    db_push()
    return {"message": "All master data deleted."}


# ── Search master data (fallback when monthly has no results) ───────────────────

@app.get("/api/search/master")
def search_master(q: str = Query(..., min_length=1)):
    """Search master_policies by policyno, name, mobileno, plan, doc, mode."""
    pattern = f"%{q}%"
    with get_db() as conn:
        rows = conn.execute(
            """SELECT * FROM master_policies
               WHERE policyno LIKE ? OR name LIKE ? OR mobileno LIKE ?
                  OR plan LIKE ? OR doc LIKE ? OR mode LIKE ?
               ORDER BY name ASC LIMIT 100""",
            (pattern, pattern, pattern, pattern, pattern, pattern)
        ).fetchall()
    return {"source": "master", "results": [dict(r) for r in rows]}


# ── Generate monthly list ──────────────────────────────────────────────────────

@app.post("/api/generate")
def generate_list(year: int = Query(None), month: int = Query(None)):
    """Generate a monthly due list from master data."""
    now = date.today()
    target_year = year or now.year
    target_month = month or now.month

    if not 1 <= target_month <= 12:
        raise HTTPException(400, "Month must be 1-12.")

    with get_db() as conn:
        all_policies = conn.execute("SELECT * FROM master_policies").fetchall()
        source_total = len(all_policies)

        # Filter + deduplicate
        seen, due_entries = set(), []
        for p in all_policies:
            pno = p["policyno"]
            if pno in seen:
                continue
            seen.add(pno)
            if is_due_in_month(p["doc"], p["mode"], target_year, target_month):
                fup = calc_fup_for_month(p["doc"], target_year, target_month)
                fup_day = parse_date(fup).day if parse_date(fup) else 0
                status = status_for_list(p.get("status", ""))
                due_entries.append({**dict(p), "fup": fup, "fup_day": fup_day, "status": status})

        # Sort by FUP day
        due_entries.sort(key=lambda e: e.get("fup_day", 0))

        # Create or replace list
        existing = conn.execute(
            "SELECT id FROM monthly_lists WHERE year=? AND month=?",
            (target_year, target_month)
        ).fetchone()

        if existing:
            list_id = existing["id"]
            conn.execute("DELETE FROM monthly_entries WHERE list_id=?", (list_id,))
            conn.execute(
                "UPDATE monthly_lists SET generated_at=?, source_total=?, filtered_count=? WHERE id=?",
                (datetime.now().isoformat(), source_total, len(due_entries), list_id)
            )
        else:
            conn.execute(
                "INSERT INTO monthly_lists (year,month,generated_at,source_total,filtered_count) VALUES (?,?,?,?,?)",
                (target_year, target_month, datetime.now().isoformat(), source_total, len(due_entries))
            )
            list_id = conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]

        # Insert entries
        for e in due_entries:
            conn.execute(
                """INSERT OR REPLACE INTO monthly_entries
                   (list_id,policyno,name,doc,fup,sumass,plan,mode,premium,mobileno,status,fup_day,updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (list_id, e["policyno"], e.get("name",""), e.get("doc",""),
                 e.get("fup",""), e.get("sumass",""), e.get("plan",""),
                 e.get("mode",""), e.get("premium",""), e.get("mobileno",""),
                 e.get("status",""), e.get("fup_day",0), datetime.now().isoformat())
            )

    db_push()
    return {
        "message": f"Generated list for {target_month}/{target_year}",
        "source_total": source_total,
        "filtered_count": len(due_entries),
    }


# ── Monthly list endpoints ─────────────────────────────────────────────────────

@app.get("/api/list/{year}/{month}")
def get_monthly_list(year: int, month: int):
    with get_db() as conn:
        meta = conn.execute(
            "SELECT * FROM monthly_lists WHERE year=? AND month=?", (year, month)
        ).fetchone()
        if not meta:
            return {"list": None, "entries": []}
        entries = conn.execute(
            "SELECT * FROM monthly_entries WHERE list_id=? ORDER BY fup_day ASC, id ASC",
            (meta["id"],)
        ).fetchall()

    def safe(obj):
        if isinstance(obj, float) and (math.isnan(obj) or math.isinf(obj)):
            return None
        raise TypeError

    result = {"list": dict(meta), "entries": [dict(e) for e in entries]}
    return JSONResponse(json.loads(json.dumps(result, default=safe, allow_nan=False)))


@app.get("/api/list/months")
def get_available_months():
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM monthly_lists ORDER BY year DESC, month DESC"
        ).fetchall()
    return [dict(r) for r in rows]


# ── Add single policy to master data ──────────────────────────────────────────

@app.post("/api/master/new")
async def create_master_policy(request: Request):
    """Add a single policy directly to master_policies (permanent)."""
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, "Invalid JSON.")

    pno = (body.get("policyno") or "").strip()
    if not pno:
        raise HTTPException(400, "policyno is required.")

    master_fields = ["name", "doc", "fup", "sumass", "plan", "mode", "premium", "mobileno", "status"]
    now_str = datetime.now().isoformat()

    with get_db() as conn:
        existing = conn.execute(
            "SELECT id FROM master_policies WHERE policyno=?", (pno,)
        ).fetchone()

        if existing:
            # Update any provided fields
            updates, params = [], []
            for f in master_fields:
                if f in body and body[f] is not None:
                    updates.append(f"{f} = ?")
                    params.append(body[f])
            if updates:
                updates.append("updated_at = ?")
                params.append(now_str)
                params.append(pno)
                conn.execute(
                    f"UPDATE master_policies SET {', '.join(updates)} WHERE policyno=?", params
                )
            action = "updated"
        else:
            vals = {f: body.get(f) for f in master_fields}
            vals["policyno"] = pno
            vals["updated_at"] = now_str
            if vals.get("fup"):
                d = parse_date(vals["fup"])
                vals["fup_day"] = d.day if d else 0
            cols = [k for k in vals if vals[k] is not None]
            conn.execute(
                f"INSERT INTO master_policies ({','.join(cols)}) VALUES ({','.join('?' for _ in cols)})",
                [vals[c] for c in cols]
            )
            action = "created"

    db_push()
    return {"message": f"Policy {action}.", "policyno": pno, "action": action}


# ── Add single entry to monthly list (auto-syncs to master) ───────────────────

@app.post("/api/list/{year}/{month}/new")
async def create_monthly_entry(year: int, month: int, request: Request):
    """Add a single entry to a monthly list. If policyno not in master, adds it there too."""
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, "Invalid JSON.")

    pno = (body.get("policyno") or "").strip()
    if not pno:
        raise HTTPException(400, "policyno is required.")

    master_fields = ["name", "doc", "fup", "sumass", "plan", "mode", "premium", "mobileno", "status"]
    now_str = datetime.now().isoformat()

    with get_db() as conn:
        # Ensure monthly list exists for this year/month
        list_row = conn.execute(
            "SELECT id FROM monthly_lists WHERE year=? AND month=?", (year, month)
        ).fetchone()
        if not list_row:
            conn.execute(
                "INSERT INTO monthly_lists (year, month, generated_at) VALUES (?,?,?)",
                (year, month, now_str)
            )
            list_row = conn.execute(
                "SELECT id FROM monthly_lists WHERE year=? AND month=?", (year, month)
            ).fetchone()
        list_id = list_row["id"]

        # Check if entry already exists in this list
        existing_entry = conn.execute(
            "SELECT id FROM monthly_entries WHERE list_id=? AND policyno=?", (list_id, pno)
        ).fetchone()

        fup_val = body.get("fup", "")
        fup_day = 0
        if fup_val:
            d = parse_date(fup_val)
            fup_day = d.day if d else 0

        if existing_entry:
            raise HTTPException(409, f"Policy {pno} already exists in this month's list.")

        # Insert into monthly_entries
        entry_fields = master_fields + NOTE_COLS
        vals = {f: body.get(f, "") for f in entry_fields}
        vals["policyno"] = pno
        vals["list_id"] = list_id
        vals["fup_day"] = fup_day
        vals["updated_at"] = now_str
        cols = list(vals.keys())
        conn.execute(
            f"INSERT INTO monthly_entries ({','.join(cols)}) VALUES ({','.join('?' for _ in cols)})",
            [vals[c] for c in cols]
        )
        new_id = conn.execute("SELECT last_insert_rowid() as id").fetchone()["id"]

        # Auto-add to master if not present
        master_exists = conn.execute(
            "SELECT id FROM master_policies WHERE policyno=?", (pno,)
        ).fetchone()
        added_to_master = False
        if not master_exists:
            mvals = {f: body.get(f) for f in master_fields}
            mvals["policyno"] = pno
            mvals["updated_at"] = now_str
            if fup_day:
                mvals["fup_day"] = fup_day
            mcols = [k for k in mvals if mvals[k] is not None]
            conn.execute(
                f"INSERT INTO master_policies ({','.join(mcols)}) VALUES ({','.join('?' for _ in mcols)})",
                [mvals[c] for c in mcols]
            )
            added_to_master = True

    db_push()
    return {
        "message": "Entry created.",
        "id": new_id,
        "policyno": pno,
        "added_to_master": added_to_master
    }


@app.put("/api/entry/{entry_id}")
async def update_entry(entry_id: int, request: Request):
    """Update a monthly entry. Also updates master data for the same policy."""
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, "Invalid JSON.")
    if not body:
        raise HTTPException(400, "Empty body.")

    # Cannot change policyno, id, list_id
    for k in ("policyno", "id", "list_id", "fup_day", "updated_at"):
        body.pop(k, None)

    master_fields = ["name", "doc", "fup", "sumass", "plan", "mode", "premium", "mobileno", "status"]
    allowed = master_fields + NOTE_COLS  # note1-note10 saved monthly only
    updates, params = [], []
    for f in allowed:
        if f in body:
            updates.append(f"{f} = ?")
            params.append(body[f])
    if not updates:
        raise HTTPException(400, "No valid fields.")

    # Recalculate fup_day if fup changed
    if "fup" in body:
        d = parse_date(body["fup"])
        updates.append("fup_day = ?")
        params.append(d.day if d else 0)

    updates.append("updated_at = ?")
    params.append(datetime.now().isoformat())
    params.append(entry_id)

    with get_db() as conn:
        row = conn.execute("SELECT policyno FROM monthly_entries WHERE id=?", (entry_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Entry not found.")
        policyno = row["policyno"]

        # Update monthly entry (immediate)
        conn.execute(f"UPDATE monthly_entries SET {', '.join(updates)} WHERE id = ?", params)

        # Queue edits for delayed master sync (3 min)
        # Skip status='due'/'paid'/'' — those are transient monthly states
        # Skip note columns — they are monthly-only, not synced to master
        for f in master_fields:
            if f not in body:
                continue
            val = body[f]
            if f == "status" and (val or "").strip().lower() in _STATUS_SKIP:
                continue  # don't push due/paid to master
            conn.execute(
                "INSERT INTO pending_syncs (policyno, field, value) VALUES (?,?,?)",
                (policyno, f, val)
            )

    db_push()
    return {"message": "Updated.", "id": entry_id, "policyno": policyno}
