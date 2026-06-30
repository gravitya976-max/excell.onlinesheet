"""
Data Processor — Excel parsing, fuzzy column matching, normalization.
Handles all 3 column-naming styles from the raw data files.
"""

import re, io, math
import pandas as pd
from datetime import date
from dateutil import parser as dateparser

# ── Target fields (master schema) ──────────────────────────────────────────────

FIELDS = ["policyno", "name", "doc", "fup", "sumass", "plan", "mode", "premium", "mobileno", "status"]

# ── Column name mapping (fuzzy) ────────────────────────────────────────────────

COL_MAP = {
    # Policy number
    "policyno": "policyno", "policynumber": "policyno", "policynum": "policyno",
    "policy": "policyno", "polno": "policyno", "no": "policyno",
    # Name
    "name": "name", "nameofassured": "name", "assuredname": "name",
    "holdername": "name", "insuredname": "name", "clientname": "name",
    "policyname": "name", "policyholdername": "name", "insured": "name",
    # DOC
    "doc": "doc", "dateofcommencement": "doc", "commencementdate": "doc",
    "dtofcomm": "doc", "dtofcommencement": "doc", "commdate": "doc",
    "dateofcommence": "doc", "dateofcomm": "doc", "startdate": "doc",
    # FUP
    "fup": "fup", "firstunpaidpremium": "fup", "duedate": "fup",
    "nextdue": "fup", "nextduedate": "fup", "unpaidpremium": "fup",
    "firstunpaid": "fup",
    # Sum assured
    "sumass": "sumass", "sumassured": "sumass", "suminsured": "sumass",
    "sa": "sumass",
    # Plan
    "plan": "plan", "planname": "plan", "planno": "plan", "plantype": "plan",
    "plntm": "plan", "pln": "plan",
    # Mode
    "mode": "mode", "mod": "mode", "premiummode": "mode",
    "paymentmode": "mode", "frequency": "mode", "paymode": "mode",
    # Premium
    "premium": "premium", "premiumpayable": "premium", "premiumamount": "premium",
    "amt": "premium", "amount": "premium", "prem": "premium",
    "instprem": "premium", "premiumtax": "premium", "totprem": "premium",
    # Mobile
    "mobileno": "mobileno", "mobile": "mobileno", "phone": "mobileno",
    "phoneno": "mobileno", "contactno": "mobileno", "contact": "mobileno",
    "cellno": "mobileno", "mobilenumber": "mobileno", "phonenumber": "mobileno",
    "cell": "mobileno", "mob": "mobileno",
    # Status
    "status": "status", "policystatus": "status", "paymentstatus": "status",
}

# Substrings to exclude from fuzzy matching
_FUZZY_EXCLUDE = {"unnamed", "untitled", "column", "header", "field", "call",
                  "option", "date", "gst", "flg", "flag", "due", "tarikh"}


def normalize_col(name):
    """Map a raw column header to a standard field name."""
    if not name:
        return None
    # Clean: remove special chars, whitespace, newlines
    cleaned = re.sub(r"[^a-z0-9]", "", str(name).lower().strip())
    if not cleaned:
        return None
    # Exact match
    if cleaned in COL_MAP:
        return COL_MAP[cleaned]
    # Skip known non-column strings
    if any(ex in cleaned for ex in _FUZZY_EXCLUDE):
        return None
    # Fuzzy substring match
    for key, val in COL_MAP.items():
        if len(key) >= 4 and key in cleaned:
            if len(key) / len(cleaned) >= 0.4:
                return val
    return None


# ── Date normalization ─────────────────────────────────────────────────────────

def parse_date(s):
    """Parse a date string into a date object. Handles DD/MM/YYYY and Excel datetime."""
    if not s:
        return None
    s = str(s).strip()
    if not s or s.lower() == "nan":
        return None
    try:
        return dateparser.parse(s, dayfirst=True).date()
    except Exception:
        return None


def format_date(d):
    """Format a date object to DD/MM/YYYY string."""
    if not d:
        return None
    return d.strftime("%d/%m/%Y")


def normalize_date_str(s):
    """Parse and re-format a date string to DD/MM/YYYY."""
    d = parse_date(s)
    return format_date(d) if d else clean_val(s)


# ── Value cleaning ─────────────────────────────────────────────────────────────

def clean_val(v):
    """Clean a cell value — strip whitespace, convert NaN/None to None."""
    if v is None:
        return None
    if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
        return None
    s = str(v).strip()
    if s.lower() in ("nan", "none", ""):
        return None
    return s


def normalize_policyno(v):
    """Normalize a policy number — strip formatting artifacts."""
    s = clean_val(v)
    if not s:
        return None
    s = re.sub(r"[,\s\.]", "", s)
    # Must look like a number (policy numbers are numeric)
    digits = re.sub(r"\D", "", s)
    # LIC policy numbers are always exactly 9 digits
    if len(digits) != 9:
        return None
    return digits


def to_number_str(v):
    """Convert a text-as-number to a clean number string (no decimals for ints)."""
    s = clean_val(v)
    if not s:
        return None
    # Remove currency symbols, commas, spaces
    cleaned = re.sub(r"[₹,\s]", "", s)
    try:
        num = float(cleaned)
        if num == int(num):
            return str(int(num))
        return str(num)
    except ValueError:
        return s


# ── Mode normalization ─────────────────────────────────────────────────────────

MODE_MAP = {
    "m": 1, "mly": 1, "monthly": 1,
    "q": 3, "qly": 3, "quarterly": 3,
    "h": 6, "hly": 6, "hy": 6, "halfyearly": 6, "sly": 6,
    "s": 6, "semiannually": 6,
    "y": 12, "yly": 12, "ann": 12, "annually": 12, "yearly": 12,
    "a": 12, "aly": 12, "annual": 12,
}

# SGL (single premium) → no recurring dues
SKIP_MODES = {"sgl", "single", "sp"}


def parse_mode(mode_str):
    """Return interval in months, or None if unrecognized/single."""
    if not mode_str:
        return None
    cleaned = re.sub(r"[^a-z0-9]", "", str(mode_str).lower().strip())
    if cleaned in SKIP_MODES:
        return None
    if cleaned in MODE_MAP:
        return MODE_MAP[cleaned]
    return None


def normalize_mode_str(mode_str):
    """Normalize mode to a standard short form."""
    s = clean_val(mode_str)
    if not s:
        return None
    cleaned = re.sub(r"[^a-z0-9]", "", s.lower())
    if cleaned in SKIP_MODES:
        return "SGL"
    interval = parse_mode(s)
    if interval == 1:  return "MLY"
    if interval == 3:  return "QLY"
    if interval == 6:  return "HLY"
    if interval == 12: return "YLY"
    return s.upper()


# ── Status normalization ───────────────────────────────────────────────────────

SPECIAL_STATUSES = {"autodebit", "dailycollection", "branchpaid"}


def normalize_status(val):
    """Normalize status. Returns known status string or None for empty/unknown."""
    if not val or str(val).strip() == "":
        return None
    cleaned = re.sub(r"[^a-z ]", "", str(val).lower().strip()).strip()
    nospace = cleaned.replace(" ", "")
    if not nospace or nospace in ("none", "nan", "null"):
        return None
    if nospace in SPECIAL_STATUSES:
        return nospace
    if "autodebit" in nospace or "auto" in nospace:
        return "autodebit"
    if "branchpaid" in nospace or "branch" in nospace:
        return "branchpaid"
    if "dailycollection" in nospace or "daily" in nospace:
        return "dailycollection"
    if nospace == "paid":
        return "paid"
    if nospace == "due":
        return None  # due = default, same as empty
    return cleaned if cleaned else None


def status_for_list(status_str):
    """Status for monthly list: only 'paid' resets to due (empty), all others stay as-is."""
    norm = normalize_status(status_str)
    if norm == "paid":
        return ""
    return norm or ""


# ── Due month calculation ──────────────────────────────────────────────────────

def is_due_in_month(doc_str, mode_str, target_year, target_month):
    """Check if a policy is due in the target month based on DOC + Mode."""
    doc_date = parse_date(doc_str)
    if not doc_date:
        return False
    interval = parse_mode(mode_str)
    if not interval:
        return False
    months_diff = (target_year - doc_date.year) * 12 + (target_month - doc_date.month)
    if months_diff < 0:
        return False
    return months_diff % interval == 0


def calc_fup_for_month(doc_str, target_year, target_month):
    """Calculate FUP date: DOC_day / target_month / target_year.
    Handles month-end edge cases (e.g., day 31 in a 30-day month)."""
    doc_date = parse_date(doc_str)
    if not doc_date:
        return None
    import calendar
    max_day = calendar.monthrange(target_year, target_month)[1]
    fup_day = min(doc_date.day, max_day)
    fup_date = date(target_year, target_month, fup_day)
    return format_date(fup_date)


# ── Excel parsing ─────────────────────────────────────────────────────────────

def _find_header_row(df_raw, max_scan=10):
    """Scan first rows to find the best header row (most recognized columns)."""
    best_idx, best_score = 0, 0
    for idx in range(min(len(df_raw), max_scan)):
        row_vals = [str(v) if pd.notna(v) else None for v in df_raw.iloc[idx]]
        score = sum(1 for v in row_vals if v and normalize_col(v))
        if score > best_score:
            best_score = score
            best_idx = idx
    return best_idx if best_score >= 2 else 0


def parse_excel(content, filename):
    """Parse an Excel file and return a list of normalized record dicts.
    Each record has keys from FIELDS. Deduplicates by policyno within the file."""
    ext = filename.rsplit(".", 1)[-1].lower()
    engine = "openpyxl"

    xls = pd.ExcelFile(io.BytesIO(content), engine=engine)
    all_records = []
    seen_pnos = set()

    for sheet in xls.sheet_names:
        # Skip known non-data sheets
        sheet_lower = sheet.lower()
        if any(skip in sheet_lower for skip in ("scribbled", "summary", "sheet2", "sheet3")):
            continue

        df_raw = pd.read_excel(xls, sheet_name=sheet, dtype=str, header=None, nrows=10)
        header_idx = _find_header_row(df_raw)
        df = pd.read_excel(xls, sheet_name=sheet, dtype=str, header=header_idx)

        # Map columns
        col_mapping = {}
        for c in df.columns:
            norm = normalize_col(c)
            if norm and norm not in col_mapping.values():
                col_mapping[c] = norm
        df = df.rename(columns=col_mapping)

        # Only keep recognized columns
        keep = [c for c in df.columns if c in FIELDS]
        if "policyno" not in keep:
            continue
        df = df[keep]

        for _, row in df.iterrows():
            pno = normalize_policyno(row.get("policyno"))
            if not pno:
                continue
            if pno in seen_pnos:
                continue
            seen_pnos.add(pno)

            rec = {"policyno": pno}
            rec["name"] = clean_val(row.get("name"))
            rec["doc"] = normalize_date_str(row.get("doc"))
            rec["fup"] = normalize_date_str(row.get("fup"))
            rec["sumass"] = to_number_str(row.get("sumass"))
            rec["plan"] = clean_val(row.get("plan"))
            rec["mode"] = normalize_mode_str(row.get("mode"))
            rec["premium"] = to_number_str(row.get("premium"))
            rec["mobileno"] = to_number_str(row.get("mobileno"))
            rec["status"] = normalize_status(row.get("status"))
            all_records.append(rec)

    return all_records
