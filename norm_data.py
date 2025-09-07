# -*- coding: utf-8 -*-
"""
Normalize Israeli street names from CSV.
- Reads from street_names.csv with columns: city_code, city_name, street_code, street_name
- Produces: city_code, city_name, street_code, street_name, norm_display, norm_key
"""

import re
import unicodedata
import csv
from pathlib import Path
from typing import Dict, Iterable, List

# ---- Configurable knobs ----
TYPE_PREFIXES = {
    "רחוב", "רח", "רח'", "שדרות", "שד", "שד'", "דרך", "כביש",
    "שביל", "סמטה", "מבוי", "כיכר", "מעלה", "ככר", "מחלף"
}

DROP_DEF_HE = False  # drop leading ה- (definite article) if True

FINAL_MAP = str.maketrans({
    "ך": "כ", "ם": "מ", "ן": "נ", "ף": "פ", "ץ": "צ",
})

# hyphens/maqaf to spaces
# includes Hebrew maqaf '־'
HYPHENS = "".join(["-", "-", "–", "—", "‒", "﹘", "﹣", "－", "־"])
HYPHEN_RE = re.compile(r"[" + re.escape(HYPHENS) + r"]")

# apostrophes/quotes to remove  -> now includes ASCII " and common doubles
APOSTR = "'`´’‘ʼ՚ʹʾ"          # single-quote-ish
HEB_QUOTE = "״׳"              # Hebrew gershayim/geresh
DBL_QUOTES = '"“”„«»＂'        # ASCII ", curly/low-9, guillemets, fullwidth
QUOTE_RE = re.compile(r"[" + re.escape(APOSTR + HEB_QUOTE + DBL_QUOTES) + r"]")


# parentheses/brackets content to drop
PARENS_RE = re.compile(r"[\(\[\{].*?[\)\]\}]")

# bidi controls & other formatting to drop


def _strip_controls(s):
    return "".join(ch for ch in s if unicodedata.category(ch) != "Cf")

# Hebrew niqqud (combining marks) to drop


def _strip_nikud(s):
    return "".join(ch for ch in s if unicodedata.category(ch) != "Mn")


# collapse whitespace
WS_RE = re.compile(r"\s+")


def _ws_collapse(s):
    return WS_RE.sub(" ", s).strip()


def strip_type_prefix(s):
    tokens = s.split()
    while tokens and tokens[0] in TYPE_PREFIXES:
        tokens = tokens[1:]
    return " ".join(tokens)


def drop_def_he(s):
    # If first token starts with ה, drop that leading ה only (e.g., "הדובדבנים" -> "דובדבנים")
    tokens = s.split()
    if not tokens:
        return s
    t0 = tokens[0]
    if t0.startswith("ה") and len(t0) > 1:
        tokens[0] = t0[1:]
    return " ".join(tokens)


def normalize_name(raw, drop_he=False):
    if raw is None:
        raw = ""
    # 1) trim + NFKC
    s = unicodedata.normalize("NFKC", raw.strip())
    # 2) remove bidi controls & nikud
    s = _strip_controls(_strip_nikud(s))
    # 3) drop parenthetical qualifiers
    s = PARENS_RE.sub("", s)
    # 4) unify hyphens to spaces, remove apostrophes/quotes
    s = HYPHEN_RE.sub(" ", s)
    s = QUOTE_RE.sub("", s)
    # 5) normalize final letters
    s = s.translate(FINAL_MAP)
    # 6) collapse whitespace
    s = _ws_collapse(s)
    # 7) strip leading type prefixes
    s = strip_type_prefix(s)
    # 8) optionally drop leading ה (definite article)
    if drop_he:
        s = drop_def_he(s)
    # 9) collapse again (in case)
    s = _ws_collapse(s)
    # 10) build a join-friendly key (no spaces)
    key = s.replace(" ", "")
    return {"display": s, "key": key}


def read_csv_rows(path):
    """
    Returns an iterator of row dictionaries from the CSV file.
    Assumes UTF-8 encoding. Handles Hebrew column headers.
    """
    with open(path, 'r', encoding='cp1255') as f:
        # First check the headers to determine field names
        sample = f.read(1024)
        f.seek(0)
        sniffer = csv.Sniffer()
        try:
            delimiter = sniffer.sniff(sample).delimiter
        except:
            delimiter = ','  # Default to comma if sniffing fails

        reader = csv.DictReader(f, delimiter=delimiter)
        # Map Hebrew headers to English keys
        header_map = {
            "סמל_ישוב": "city_code",
            "שם_ישוב": "city_name",
            "סמל_רחוב": "street_code",
            "שם_רחוב": "street_name",
            "city_code": "city_code",
            "city_name": "city_name",
            "street_code": "street_code",
            "street_name": "street_name"
        }

        for row in reader:
            yield {
                "city_code": row.get("סמל_ישוב", row.get("city_code", "")).strip(),
                "city_name": row.get("שם_ישוב", row.get("city_name", "")).strip(),
                "street_code": row.get("סמל_רחוב", row.get("street_code", "")).strip(),
                "street_name": row.get("שם_רחוב", row.get("street_name", "")).strip(),
            }


def normalize_csv_file(csv_path):
    # Read all rows first to build anchor_set
    rows_data = list(read_csv_rows(csv_path))

    # First pass: build set of all normalized keys (without dropping he)
    anchor_set = set()
    for row in rows_data:
        street_name = row["street_name"]
        if street_name:
            n = normalize_name(street_name, drop_he=False)
            anchor_set.add(n['key'])
            # Also add dropped version if applicable
            tokens = street_name.split()
            if tokens and tokens[0].startswith("ה") and len(tokens[0]) > 1:
                dropped_s = drop_def_he(street_name)
                dropped_normed = normalize_name(dropped_s, drop_he=False)
                anchor_set.add(dropped_normed['key'])

    # Second pass: process each row with conditional drop of he
    normalized_rows = []
    for row in rows_data:
        city_code = row["city_code"]
        city_name = row["city_name"]
        street_code = row["street_code"]
        street_name = row["street_name"]

        normed = normalize_name(street_name, drop_he=False)

        # Check if normalized result can drop he
        norm_tokens = normed["display"].split()
        if norm_tokens and norm_tokens[0].startswith("ה") and len(norm_tokens[0]) > 1:
            dropped_s = drop_def_he(normed["display"])
            dropped_normed = normalize_name(dropped_s, drop_he=False)
            if dropped_normed['key'] in anchor_set:
                normed = dropped_normed
                print(
                    f"Removed 'ה' from '{street_name}' to '{dropped_s}' -> '{dropped_normed['display']}' because short form exists")
            else:
                print(
                    f"Kept 'ה' in '{street_name}' because no short form exists")

        normalized_rows.append({
            "city_code": city_code,
            "city_name": _ws_collapse(city_name),
            "street_code": street_code,
            "street_name": _ws_collapse(street_name),
            "norm_display": normed["display"],
            "norm_key": normed["key"],
        })
    return normalized_rows


# Test the fix with example streets
def test_examples():
    test_rows = [
        {"city_code": "1", "city_name": "Test City", "street_code": "1", "street_name": "שיטה"},
        {"city_code": "1", "city_name": "Test City", "street_code": "2", "street_name": "השיטה"},
        {"city_code": "1", "city_name": "Test City", "street_code": "3", "street_name": "שביל השיטה"},
    ]
    print("Testing normalization with examples:")
    normalized = normalize_csv_file_from_rows(test_rows)
    for row in normalized:
        print(f"'{row['street_name']}' -> '{row['norm_display']}' (key: {row['norm_key']})")

def normalize_csv_file_from_rows(rows_data):
    # Adapted from normalize_csv_file to work with in-memory rows
    from collections import defaultdict

    # First pass: build set of all normalized keys (without dropping he)
    anchor_set = set()
    for row in rows_data:
        street_name = row["street_name"]
        if street_name:
            n = normalize_name(street_name, drop_he=False)
            anchor_set.add(n['key'])
            # Also add dropped version if applicable
            tokens = street_name.split()
            if tokens and tokens[0].startswith("ה") and len(tokens[0]) > 1:
                dropped_s = drop_def_he(street_name)
                dropped_normed = normalize_name(dropped_s, drop_he=False)
                anchor_set.add(dropped_normed['key'])

    # Second pass: process each row with conditional drop of he
    normalized_rows = []
    for row in rows_data:
        city_code = row["city_code"]
        city_name = row["city_name"]
        street_code = row["street_code"]
        street_name = row["street_name"]

        normed = normalize_name(street_name, drop_he=False)

        # Check if normalized result can drop he
        norm_tokens = normed["display"].split()
        if norm_tokens and norm_tokens[0].startswith("ה") and len(norm_tokens[0]) > 1:
            dropped_s = drop_def_he(normed["display"])
            dropped_normed = normalize_name(dropped_s, drop_he=False)
            if dropped_normed['key'] in anchor_set:
                normed = dropped_normed
                print(
                    f"Removed 'ה' from '{street_name}' to '{dropped_s}' -> '{dropped_normed['display']}' because short form exists")
            else:
                print(
                    f"Kept 'ה' in '{street_name}' because no short form exists")

        normalized_rows.append({
            "city_code": city_code,
            "city_name": _ws_collapse(city_name),
            "street_code": street_code,
            "street_name": _ws_collapse(street_name),
            "norm_display": normed["display"],
            "norm_key": normed["key"],
        })
    return normalized_rows

# --- Optional: quick CLI preview ---
if __name__ == "__main__":
    import sys

    # Default input and output files
    default_input = "street_names.csv"
    default_output = "norm.csv"

    if len(sys.argv) < 2:
        # Test with examples
        test_examples()
        sys.exit(0)
    elif sys.argv[1] == "test":
        test_examples()
        sys.exit(0)
    else:
        inp = sys.argv[1] if len(sys.argv) > 1 else default_input
        outp = sys.argv[2] if len(sys.argv) > 2 else default_output
        print(f"Using input: {inp}, output: {outp}")

    # Check if input file exists
    try:
        data = normalize_csv_file(inp)
    except FileNotFoundError:
        print(f"Error: Input file '{inp}' not found.")
        sys.exit(1)

    # Print a few before/after samples
    for r in data[:10]:  # Show first 10 instead of 100 for brevity
        print(f"{r['street_name']}  -->  {r['norm_display']}  | key={r['norm_key']}")

    # Write normalized data to output CSV
    with open(outp, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=[
            "city_code", "city_name", "street_code", "street_name", "norm_display", "norm_key"
        ])
        writer.writeheader()
        writer.writerows(data)
    print(f"Wrote {len(data)} rows to {outp}")
