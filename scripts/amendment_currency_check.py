#!/usr/bin/env python3
"""Amendment-currency check (2026-07-13) -- a sibling to codified_source_audit.py's
freshness sweep, closing a DIFFERENT gap that sweep exposed: the South Dakota `52 SDR
125` miss. That sweep diffs a text WINDOW around the citation fragment against its own
last snapshot -- it only notices a change once it's already run past it, and it goes
blind whenever the fetch fails (PDF binaries, JS-rendered pages), which the 2026-07-13
sweep log shows happens for 13+ of our ~47 cited records already.

This script instead tries to read each source's own AMENDMENT-HISTORY metadata (a
"History:", "Source:", "Amended", "[L ...]", "(A ...)" style line -- every state
publishes one somewhere, in a different format) and extract the most recent year
mentioned in it, then compares that year against the record's own `last_verified`
year. A source whose latest documented amendment is NEWER than our last_verified date
is exactly the class of miss this exists to catch -- regardless of whether the
citation-fragment text itself happens to look unchanged.

ADVISORY ONLY -- does not exit non-zero, does not block a build, and does not touch
cpa_deadlines.json. It is a heuristic year-extractor (regex over fetched text, not
real parsing of each state's citation grammar), so:
  - a clean extraction with year <= last_verified's year is NOT proof nothing changed
    (the SD case had a valid amendment predating this check's own snapshot horizon
    once too) -- it's a triage signal, same spirit as codified_source_audit.py's own
    checks.
  - "could not extract a year" is reported explicitly as MANUAL-REVIEW-REQUIRED, never
    silently dropped -- per-record coverage tier is recorded in SOURCE_REGISTRY below
    so the gap is visible in the log, not invisible.

Usage:
    python scripts/amendment_currency_check.py [repo_root]

Recommended cadence: monthly, alongside the existing freshness sweep (same
schtasks-driven cadence works -- see scripts/run_freshness_sweep.bat for the pattern;
this script could be added as a second line in that same .bat, or its own task).
"""
import json
import re
import subprocess
import sys
import tempfile
import urllib.request
import urllib.error
from pathlib import Path

_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"

# ---------------------------------------------------------------------------
# Per-record source registry, built from the 2026-07-13 amendment-currency audit
# (41 citation sources independently researched -- see Orchestrator outbox entry
# dated 2026-07-13 for the full per-record evidence trail). Three tiers:
#
#   "api"     -- a genuine structured endpoint that returns a clean amendment-
#                history line on every fetch (South Dakota's sdlegislature.gov
#                /api/Rules/*.html is the only one found this pass).
#   "page"    -- an ordinary HTML/PDF page from the state's own authoritative
#                compiler that DOES carry a parseable history/amendment line
#                somewhere in the fetched text (a "History:", "Source:",
#                "Amended", "[L ...]", "(A YYYY, ...)" style annotation) --
#                the year-extractor below has a real shot at these.
#   "manual"  -- no reliable machine-extractable amendment date this pass:
#                either the true authoritative host actively blocks scripted
#                access (403/WAF/JS-SPA/unreachable port), or the only
#                available document doesn't carry a clean per-section date.
#                Logged explicitly every run so the gap stays visible.
#
# This is a snapshot of what this audit found, not a guarantee the tier is
# permanent -- a future run that finds a better source for a "manual" record
# should move it up a tier here.
# ---------------------------------------------------------------------------
SOURCE_REGISTRY = {
    "sd-all": "api",
    "il-individual": "page", "ga-individual": "page", "ga-firm": "page",
    "nc-all": "page", "mn-individual": "page", "mn-firm": "page",
    "wi-individual": "page", "wi-firm": "page", "mo-individual": "page",
    "mo-firm": "page", "ct-individual": "page", "la-individual": "page",
    "la-firm": "page", "or-firm": "page", "sc-individual": "page",
    "sc-firm": "page", "al-all": "page", "ok-firm": "page",
    "ia-individual": "page", "ia-firm": "page", "dc-all": "page",
    "ks-firm": "page", "nv-individual": "page", "nv-firm": "page",
    "ne-firm": "page", "wv-individual": "page", "wv-firm": "page",
    "de-all": "page", "nd-individual": "page", "nd-firm": "page",
    "hi-all": "page", "pa-individual": "page", "va-individual": "page",
    "va-firm": "page",
    # manual: true authoritative source blocks scripted access, or no clean
    # per-section date is available from anything reachable this pass.
    "ak-individual": "manual", "ak-firm": "manual",      # akleg.gov 403s
    "in-individual": "manual", "in-firm": "manual",       # iar.iga.in.gov WAF/SPA
    "ut-all": "manual",                                    # adminrules.utah.gov JS SPA
    "mt-all": "manual",                                    # rules.mt.gov SPA, port 8443 blocked
    "vt-individual": "manual",                             # secure.vermont.gov 403s (PDF works but no per-rule tag)
    "wy-individual": "manual", "wy-firm": "manual",       # no queryable index; PDF has no per-section date
    "ar-individual": "manual", "ar-firm": "manual",       # arkleg has Act PDFs only, no running code lookup
    "ms-individual": "manual", "ms-firm": "manual",       # no free official MS statute DB
    "id-firm": "manual",                                   # PDF has inline dates but format is per-subsection, not chapter-level
}

# A handful of keywords that tend to introduce an amendment-history annotation,
# in roughly the order of how commonly they appear across the sources found
# this pass. Deliberately broad -- this is a triage heuristic, not a parser.
_HISTORY_KEYWORDS = [
    "History:", "HISTORY:", "Source History", "Amended:", "amended,",
    "eff.", "effective", "[L ", "(A ", "AMD,", "am ",
]
_YEAR_RE = re.compile(r"\b(20[0-3]\d)\b")


def _fetch_text(url: str) -> str | None:
    """Fetch a URL and return decoded text -- runs the PDF through `pdftotext`
    if the content looks binary/PDF, same fallback used during this audit's
    own manual research. Returns None on any failure (network, 403, etc.)."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": _UA})
        with urllib.request.urlopen(req, timeout=20) as resp:
            raw = resp.read()
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ValueError):
        return None

    if raw[:4] == b"%PDF":
        try:
            with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
                tmp.write(raw)
                tmp_path = tmp.name
            result = subprocess.run(
                ["pdftotext", "-layout", tmp_path, "-"],
                capture_output=True, timeout=30,
            )
            if result.returncode == 0:
                return result.stdout.decode("utf-8", errors="replace")
            return None
        except (FileNotFoundError, subprocess.SubprocessError):
            return None  # pdftotext not installed on this machine -- manual-review
    return raw.decode("utf-8", errors="replace")


def _extract_latest_year(text: str, fragment: str | None) -> int | None:
    """Best-effort: search near the citation fragment first (if found), then
    fall back to the whole document, for the latest year adjacent to a
    history-style keyword. Returns None if nothing plausible is found."""
    windows = []
    if fragment:
        idx = text.find(fragment)
        if idx != -1:
            windows.append(text[max(0, idx - 200): idx + 1500])
    windows.append(text)  # whole-document fallback

    best_year = None
    for window in windows:
        for kw in _HISTORY_KEYWORDS:
            for m in re.finditer(re.escape(kw), window):
                snippet = window[m.start(): m.start() + 300]
                years = [int(y) for y in _YEAR_RE.findall(snippet)]
                if years:
                    best_year = max(best_year or 0, max(years))
        if best_year:
            break
    return best_year


_CITATION_FRAGMENT_RE = re.compile(r"[\d][\d.:\-()a-zA-Z]*\d")


def _citation_fragment(citation: str) -> str | None:
    trimmed = re.split(r"\(", citation, maxsplit=1)[0]
    candidates = _CITATION_FRAGMENT_RE.findall(trimmed) or _CITATION_FRAGMENT_RE.findall(citation)
    return max(candidates, key=len) if candidates else None


def check_amendment_currency(records: list[dict]) -> dict:
    checked, flagged, manual, unregistered = [], [], [], []

    for r in records:
        rid = r["id"]
        citation = r.get("citation")
        url = r.get("citation_url")
        last_verified = r.get("last_verified")
        if not citation or not url or not last_verified:
            continue

        tier = SOURCE_REGISTRY.get(rid)
        if tier is None:
            unregistered.append({"id": rid, "state": r.get("state"), "citation_url": url})
            continue
        if tier == "manual":
            manual.append({"id": rid, "state": r.get("state"), "citation_url": url,
                            "reason": "no reliable machine-extractable amendment date this pass"})
            continue

        text = _fetch_text(url)
        if text is None:
            manual.append({"id": rid, "state": r.get("state"), "citation_url": url,
                            "reason": "fetch failed at check time -- re-run or review by hand"})
            continue

        fragment = _citation_fragment(citation)
        latest_year = _extract_latest_year(text, fragment)
        last_verified_year = int(last_verified[:4])

        entry = {
            "id": rid, "state": r.get("state"), "citation": citation,
            "citation_url": url, "last_verified": last_verified,
            "latest_year_found": latest_year,
        }
        if latest_year is None:
            manual.append({**entry, "reason": "fetched OK but no history/amendment year pattern matched"})
        elif latest_year > last_verified_year:
            flagged.append(entry)
        else:
            checked.append(entry)

    return {
        "checked_clean": checked, "flagged": flagged,
        "manual_review_required": manual, "unregistered": unregistered,
    }


def main():
    repo_root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent
    import datetime

    data = json.loads((repo_root / "data" / "cpa_deadlines.json").read_text(encoding="utf-8"))
    cited = [r for r in data["records"] if r.get("citation") and r.get("citation_url")]
    result = check_amendment_currency(cited)

    today = datetime.date.today().isoformat()
    lines = [f"Amendment-currency check -- {today}", ""]
    lines.append(f"Checked, no newer amendment found: {len(result['checked_clean'])}")
    lines.append(
        f"\nFLAGGED -- source shows an amendment year newer than last_verified ({len(result['flagged'])}):"
    )
    for f in result["flagged"]:
        lines.append(
            f"  [{f['id']}] {f['state']} -- last_verified={f['last_verified']}, "
            f"latest amendment year found={f['latest_year_found']}"
        )
        lines.append(f"    citation: {f['citation']!r} -- {f['citation_url']}")
        lines.append("    ACTION: propose-first if this changes the displayed deadline; safe-fix "
                      "(bump last_verified + note) if the deadline still holds under current text.")
    lines.append(f"\nMANUAL-REVIEW-REQUIRED -- not machine-checkable this run ({len(result['manual_review_required'])}):")
    for m in result["manual_review_required"]:
        lines.append(f"  [{m['id']}] {m['state']} -- {m['reason']}")
        lines.append(f"    citation_url: {m['citation_url']}")
    if result["unregistered"]:
        lines.append(
            f"\nUNREGISTERED -- cited record not yet classified in SOURCE_REGISTRY ({len(result['unregistered'])}), "
            f"treat as manual-review-required until added:"
        )
        for u in result["unregistered"]:
            lines.append(f"  [{u['id']}] {u['state']} -- {u['citation_url']}")

    log_text = "\n".join(lines)
    log_dir = repo_root / "freshness_sweep_log"
    log_dir.mkdir(exist_ok=True)
    (log_dir / f"{today}-amendment-currency.txt").write_text(log_text, encoding="utf-8")
    print(log_text)
    if result["flagged"]:
        print(f"\n*** {len(result['flagged'])} record(s) show a newer amendment than last_verified -- "
              f"needs a human/agent review before the next ship. ***")


if __name__ == "__main__":
    main()
