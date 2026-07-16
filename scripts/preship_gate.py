#!/usr/bin/env python3
"""Pre-ship gate for DeadlineRadar.

Run before every commit that touches docs/ or the data files. Exits non-zero
(and prints every violation) if anything on the checklist fails. This is a
structural backstop, not a substitute for judgment -- it catches the
mechanical classes of defect (leaked research language, broken rendering,
data/manifest drift, missing legal copy), not wording quality.

Usage: python scripts/preship_gate.py [repo_root]
"""
import json
import re
import sys
from datetime import date
from pathlib import Path

MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
]


def fmt_date(iso: str) -> str:
    y, m, d = (int(x) for x in iso.split("-"))
    return f"{MONTH_NAMES[m - 1]} {d}, {y}"


# --- Section A: copy hygiene -------------------------------------------------
# Deliberately excludes plain honest-uncertainty phrasing ("could not confirm
# this date against two independent authoritative sources") -- the orchestrator
# affirmed that specific construction as acceptable user copy (2026-07-05).
# This list only matches mechanics/process/self-instruction language that has
# no legitimate reason to appear in rendered site copy.
LEAK_PATTERNS = [
    r"\bHTTP\s*\d{3}\b",
    r"\b(?:403|404|429|500|502|503)\s+(?:Forbidden|Not Found|Bad Gateway|Service Unavailable|Too Many Requests)\b",
    r"\bbot[- ]block(?:ed)?\b",
    r"\bverifier\b",
    r"\badversarial\b",
    r"\bin this (?:pass|run)\b",
    r"\bour verification\b",
    r"\bre-?verified\b",
    r"\bdo not (?:compute|display|publish)\b",
    r"\borchestrator-recommended\b",
    r"\ban earlier draft\b",
    r"\bTODO\b",
    r"\{\{.*?\}\}",
    r"\bundefined\b",
    r"\bNaN\b",
    r"\[object Object\]",
    r"\blorem ipsum\b",
    r"\bWAF\b",
    r"\bcuration mirror\b",
    r"\bWebFetch\b",
    r"\bcurl\b",
    r"\bmust say\b",
    r"\bgenerated page\b",
    r"\bthis dataset\b",
    r"\border(?:s)? the record\b",
    r"\bby the orchestrator\b",
    r"\borchestrator review\b",
    # Tooling/research-process jargon leaking into public copy (e.g. "403'd
    # this tool's direct fetch", "gap/BYOD record in the ... dataset") --
    # caught on live CPE-hours pages 2026-07-16, same spirit as the
    # internal-tool-name check above but broader.
    r"\bthis tool\b",
    r"\bBYOD\b",
    r"\bautomated fetch\b",
    r"\bsame known tooling\b",
    r"\bbot-detection\b",
    r"\bpdftotext\b",
    r"\bsummarizer\b",
    r"\bbrowser identification string\b",
]
LEAK_RE = re.compile("|".join(LEAK_PATTERNS), re.IGNORECASE)

EMPTY_TAG_RE = re.compile(r"<(em|p|li|strong|span|h[1-6])>\s*</\1>", re.IGNORECASE)

DISCLAIMER_PHRASE = "affiliated with"
REQUIRED_ADDRESS = "18121 E Hampden Ave, Unit C #1324, Aurora, CO 80013"
FORBIDDEN_ADDRESS_HINTS = []  # populated by caller if a real home/work address is known


def check_copy_hygiene(html_files: list[Path]) -> list[str]:
    errors = []
    for f in html_files:
        text = f.read_text(encoding="utf-8")
        for m in LEAK_RE.finditer(text):
            line_no = text.count("\n", 0, m.start()) + 1
            snippet = text[max(0, m.start() - 40): m.end() + 40].replace("\n", " ")
            errors.append(f"[A][{f}:{line_no}] leaked pattern '{m.group(0)}' -- ...{snippet}...")
    return errors


def check_rendering_integrity(html_files: list[Path]) -> list[str]:
    errors = []
    for f in html_files:
        text = f.read_text(encoding="utf-8")
        for m in EMPTY_TAG_RE.finditer(text):
            line_no = text.count("\n", 0, m.start()) + 1
            errors.append(f"[B][{f}:{line_no}] empty tag: {m.group(0)}")
    return errors


def check_legal_safety(html_files: list[Path], state_page_files: list[Path]) -> list[str]:
    errors = []
    for f in html_files:
        text = f.read_text(encoding="utf-8")
        if DISCLAIMER_PHRASE not in text:
            errors.append(f"[F][{f}] missing non-affiliation disclaimer")
    for f in state_page_files:
        text = f.read_text(encoding="utf-8")
        if REQUIRED_ADDRESS.split(",")[0] in text and REQUIRED_ADDRESS not in text:
            errors.append(f"[F][{f}] contains a partial/incorrect mailing address (address text present but doesn't match the exact required string)")
    return errors


CPE_AFFILIATE_BLOCK_RE = re.compile(r'<div class="cpe-affiliate">.*?</div>', re.IGNORECASE | re.DOTALL)
AFFILIATE_DISCLOSURE_PHRASE = "paid affiliate link"


def check_affiliate_disclosure(html_files: list[Path]) -> list[str]:
    """[G] Defense-in-depth for the FTC Endorsement Guides (16 CFR Part 255)
    requirement: every rendered `cpe-affiliate` block must carry its own disclosure,
    immediately next to the link, every time it appears -- not a one-time site-wide
    mention. generate.py's _cpe_provider_html() already guarantees this by
    construction (every gated provider block calls the shared
    _affiliate_disclosure_html() helper), but this check exists as a second,
    independent line of defense: if a future edit ever adds a new CPE-affiliate
    block by hand instead of through that shared renderer, this still catches a
    live affiliate link shipping with no disclosure, rather than relying solely on
    the Python source being correct."""
    errors = []
    for f in html_files:
        text = f.read_text(encoding="utf-8")
        for m in CPE_AFFILIATE_BLOCK_RE.finditer(text):
            if AFFILIATE_DISCLOSURE_PHRASE not in m.group(0).lower():
                line_no = text.count("\n", 0, m.start()) + 1
                errors.append(f"[G][{f}:{line_no}] cpe-affiliate block rendered with no FTC disclosure ('{AFFILIATE_DISCLOSURE_PHRASE}' not found)")
    return errors


def check_data_manifest_consistency(data_path: Path, docs_dir: Path) -> list[str]:
    errors = []
    data = json.loads(data_path.read_text(encoding="utf-8"))
    by_state = {}
    for r in data["records"]:
        by_state.setdefault(r["state_slug"], []).append(r)

    for state_slug, records in by_state.items():
        page = docs_dir / state_slug / "index.html"
        if not page.exists():
            errors.append(f"[C][{state_slug}] no rendered page found at {page}")
            continue
        text = page.read_text(encoding="utf-8")
        for r in records:
            ndc = r.get("next_deadline_computed")
            if ndc:
                expected = fmt_date(ndc)
                if expected not in text:
                    errors.append(
                        f"[C][{state_slug}/{r['id']}] manifest asserts {ndc} ({expected}) "
                        f"but that string does not appear on the rendered page -- possible stale render or silent date drift"
                    )
            # Regression guard: a record explicitly marked null/gap must never show
            # a fabricated-looking specific date attributed to IT. We can't
            # perfectly attribute per-record text on a combined page, but we can
            # catch the worst case: a null record with no cohort_groups and no
            # data_gap_note existing at all (a record that used to be null+noted
            # silently regaining a bare, uncited date).
            if ndc is None and not r.get("cohort_groups") and not r.get("data_gap_note") and not r.get("computation"):
                errors.append(
                    f"[C][{state_slug}/{r['id']}] null next_deadline_computed with no "
                    f"cohort_groups, data_gap_note, or computation field -- a null record must explain itself to the reader"
                )
    return errors


def check_json_copies_identical(repo_root: Path) -> list[str]:
    a = repo_root / "data" / "cpa_deadlines.json"
    b = repo_root / "worker" / "src" / "cpa_deadlines.json"
    if not b.exists():
        # Scratch/partial checkouts (e.g. a data-only copy for render verification)
        # won't have the worker tree -- this check only makes sense against a full
        # repo checkout, so skip it rather than false-failing.
        print(f"  (skipping byte-identical check -- {b} not present in this checkout)")
        return []
    if a.read_bytes() != b.read_bytes():
        return [f"[C] {a} and {b} are NOT byte-identical"]
    return []


def print_worker_deploy_staleness_advisory(repo_root: Path) -> None:
    """Surfaces the existing worker_deploy_staleness_check.py advisory as part
    of the normal pre-ship run, instead of relying on someone remembering to
    invoke it separately -- this is the exact "static site and Worker deploy
    through separate pipelines" class that silently broke South Dakota/Hawaii/
    Oklahoma signups on 2026-07-09 (see that script's own docstring). Advisory
    only, matching every other detector here: printed, never affects exit code
    or blocks a commit -- data/cpa_deadlines.json and worker/src/cpa_deadlines.json
    changing together is normal and expected; this just reminds a human to run
    `wrangler deploy` (and update worker/.last_deploy_commit) before assuming
    the live Worker has picked up a data change."""
    sys.path.insert(0, str(repo_root / "scripts"))
    try:
        import worker_deploy_staleness_check as wdsc
    except ImportError:
        print("  (skipping worker-deploy-staleness advisory -- worker_deploy_staleness_check.py not importable)")
        return
    print("\n--- worker-deploy-staleness advisory (does not affect gate exit code) ---")
    try:
        wdsc.main()
    except SystemExit:
        pass


def main():
    repo_root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent
    docs_dir = repo_root / "docs"
    data_path = repo_root / "data" / "cpa_deadlines.json"

    html_files = sorted(docs_dir.rglob("*.html"))
    if not html_files:
        print(f"FATAL: no HTML files found under {docs_dir} -- did you run generate.py first?")
        sys.exit(2)

    state_dirs = {p.parent for p in html_files if p.parent.name not in ("privacy", "contact")} - {docs_dir}
    state_page_files = [d / "index.html" for d in state_dirs if (d / "index.html").exists()]

    all_errors = []
    all_errors += check_copy_hygiene(html_files)
    all_errors += check_rendering_integrity(html_files)
    all_errors += check_legal_safety(html_files, state_page_files)
    all_errors += check_affiliate_disclosure(html_files)
    all_errors += check_data_manifest_consistency(data_path, docs_dir)
    all_errors += check_json_copies_identical(repo_root)

    print(f"Pre-ship gate: scanned {len(html_files)} rendered pages, {len(state_dirs)} state dirs.")
    if all_errors:
        print(f"\nFAIL -- {len(all_errors)} violation(s):\n")
        for e in all_errors:
            print(" ", e)
        print_worker_deploy_staleness_advisory(repo_root)
        sys.exit(1)
    print("\nPASS -- no violations found.")
    print_worker_deploy_staleness_advisory(repo_root)
    sys.exit(0)


if __name__ == "__main__":
    main()
