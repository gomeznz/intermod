#!/usr/bin/env python3
"""Build data/channels.json from RSM PIB 23 (Mobile Service Bands in New Zealand, Issue 9.1).

Usage:
    pdftotext -layout sources/pib-23-mobile-service-bands.pdf /tmp/pib23.txt
    python3 tools/parse_pib23.py /tmp/pib23.txt data/channels.json

The PDF text (layout mode) keeps column positions, which is how 6.25 / 12.5 / 25 kHz
columns are told apart in the interleaved tables.
"""
import json
import re
import sys
from collections import Counter, OrderedDict

SRC = sys.argv[1]
OUT = sys.argv[2] if len(sys.argv) > 2 else "data/channels.json"

lines = open(SRC, encoding="utf-8").read().splitlines()

# Body starts after the contents/amendment pages.
start = next(i for i, l in enumerate(lines) if l.strip().startswith("1. LAND MOBILE BANDS") and "---" not in l)

heading_re = re.compile(r"^\s*(\d(?:\.\d+){1,3})\s+(\S.*?)\s*$")
band_re = re.compile(r"^\s*([A-Za-z][A-Za-z0-9 ()]*?\bBand)\s*$")
bw_hdr_re = re.compile(r"(6\.25|12\.5|25)\s*kHz")
# channel name (may contain one space, e.g. "RP 1B") followed by a frequency in MHz
tok_re = re.compile(r"([A-Z][A-Z]*\s?\d+\s?[A-Z]?#?)\s+(\d{2,3}\.\d{3,6})(?=\s|$)")

section = None      # e.g. ("1.1.4.1", "6.25 & 12.5 kHz Two Frequency Channelling")
top = None          # e.g. ("1.1.4", "E BAND 150 - 156 MHz")
table = None        # e.g. "E Band"
bw_cols = []        # [(column, bw_kHz)]
entries = []

# Sections whose tables carry no "<x> Band" caption of their own
BAND_OVERRIDE = {
    "2.3": "Aeronautical Repeaters",
    "3.2": "Maritime UHF On-board",
    "4.2": "Telecommand & Telemetry",
    "4.3": "Radio Paging",
    "4.4": "Radio Reporter",
}

def section_bw(title):
    m = bw_hdr_re.findall(title or "")
    return float(m[0]) if len(m) == 1 else None

for ln in range(start, len(lines)):
    l = lines[ln]
    if "RADIO SPECTRUM MANAGEMENT" in l:
        continue
    h = heading_re.match(l)
    if h and not tok_re.search(l) and "---" not in l and len(h.group(2)) < 90:
        num, title = h.group(1), h.group(2)
        if num.count(".") >= 3 or "Channelling" in title or num.startswith(("2.", "3.", "4.")):
            section = (num, title)
            bw_cols = []
        if num.count(".") == 2 or num.count(".") == 1:
            top = (num, title)
        continue
    b = band_re.match(l)
    if b and not tok_re.search(l):
        table = b.group(1).strip()
        continue
    toks = list(tok_re.finditer(l))
    if not toks:
        hdrs = [(m.start(), float(m.group(1))) for m in bw_hdr_re.finditer(l)]
        if hdrs and "dBW" not in l:
            bw_cols = hdrs
        continue
    tail = l[toks[-1].end():].strip()
    for m in toks:
        name = m.group(1).replace(" ", "")
        f = float(m.group(2))
        col = m.start()
        bw = None
        if bw_cols:
            bw = min(bw_cols, key=lambda c: abs(c[0] - col))[1]
        if bw is None:
            bw = section_bw(section[1] if section else "")
        entries.append(OrderedDict(
            n=name, f=f, bw=bw, band=BAND_OVERRIDE.get(section[0] if section else None, table), sec=section[0] if section else None,
            plan=section[1] if section else None, u=tail, line=ln + 1,
        ))

# De-duplicate (pages repeat the first row of a table, etc.)
seen = set()
uniq = []
for e in entries:
    k = (e["n"], e["f"])
    if k in seen:
        continue
    seen.add(k)
    uniq.append(e)

# Spacing not stated in the table: infer from nearest neighbour in the same section (cap 25 kHz)
for e in uniq:
    if e["bw"] is None:
        others = [abs(o["f"] - e["f"]) * 1000 for o in uniq if o["sec"] == e["sec"] and o is not e]
        e["bw"] = min(25.0, round(min(others), 3)) if others else 25.0

names = {e["n"] for e in uniq}
for e in uniq:
    n = e["n"]
    if n.endswith("#"):
        e["role"] = "M"           # mobile / ship transmit
        e["p"] = n[:-1] if n[:-1] in names else None
    elif n + "#" in names:
        e["role"] = "B"           # base / repeater transmit
        e["p"] = n + "#"
    else:
        e["role"] = "S"           # simplex
        e["p"] = None
    del e["line"]

# Band summary for the UI
bands = OrderedDict()
for e in uniq:
    key = e["band"] or "Other"
    b = bands.setdefault(key, {"band": key, "lo": e["f"], "hi": e["f"], "count": 0})
    b["lo"] = min(b["lo"], e["f"]); b["hi"] = max(b["hi"], e["f"]); b["count"] += 1

out = {
    "source": "RSM PIB 23 - Mobile Service Bands in New Zealand, Issue 9.1 (April 2019)",
    "fields": {"n": "channel", "f": "MHz", "bw": "channel spacing kHz", "band": "band table",
               "sec": "PIB section", "plan": "channelling plan", "u": "use/remarks",
               "role": "B=base Tx, M=mobile Tx, S=simplex", "p": "paired channel"},
    "bands": list(bands.values()),
    "channels": uniq,
}
json.dump(out, open(OUT, "w"), separators=(",", ":"))
print(f"{len(uniq)} channels ({len(entries) - len(uniq)} duplicates dropped) -> {OUT}")
c = Counter((e["band"], e["sec"], e["bw"], e["role"]) for e in uniq)
for k in sorted(c, key=lambda k: (k[1] or "", k[0] or "")):
    print(f"  {c[k]:5d}  {k}")
