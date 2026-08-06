#!/usr/bin/env python3
"""Pre-ship gate for DeadlineRadar.

Run before every commit that touches docs/ or the data files. Exits non-zero
(and prints every violation) if anything on the checklist fails. This is a
structural backstop, not a substitute for judgment -- it catches the
mechanical classes of defect (leaked research language, broken rendering,
data/manifest drift, missing legal copy), not wording quality.

Usage: python scripts/preship_gate.py [repo_root]
"""
import html
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
    # Real owner name -- found leaked into a shipped CSS comment on every live
    # page (2026-07-25, caught by a manual sanitization sweep this check
    # didn't cover; fixed in generate.py, added here so this exact class of
    # leak can't ship unnoticed again).
    r"\bDevin\b",
]
LEAK_RE = re.compile("|".join(LEAK_PATTERNS), re.IGNORECASE)

EMPTY_TAG_RE = re.compile(r"<(em|p|li|strong|span|h[1-6])>\s*</\1>", re.IGNORECASE)

DISCLAIMER_PHRASE = "affiliated with"
REQUIRED_ADDRESS = "18121 E Hampden Ave, Unit C #1324, Aurora, CO 80013"

# AuditLab GATE-2 (2026-08-05, LOW): check_stylesheet_integrity's three
# assertions (leaked '#', balanced braces, balanced comments) all pass
# VACUOUSLY on a truncated or completely emptied stylesheet -- with nothing
# there, nothing is unbalanced and nothing leaks. Same "passes BECAUSE the
# thing under test is missing" failure mode that function's own docstring
# names as the worst kind of check. This floor is a cheap belt for that
# specific blind spot; it is a raw '{' count (same signal the brace-balance
# assertion above it already computes), not a claim about the exact rule
# count -- current shipped baseline is ~580. If PAGE_CSS ever legitimately
# shrinks a lot, lower this deliberately; do not raise it to silence a
# real drop.
MIN_SHIPPED_CSS_RULE_BLOCKS = 400
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


def check_stylesheet_integrity(html_files: list[Path]) -> list[str]:
    """Catch a TRUNCATED stylesheet -- the worst silent failure this site has.

    On 2026-07-31 a block of Python `#` comments was inserted INTO generate.py's
    PAGE_CSS string. `#` is not a CSS comment, so every browser stopped parsing
    at that point and dropped ~400 of ~413 rules on EVERY page. The site
    rendered as unstyled HTML.

    What makes it worth a permanent check rather than a lesson: it defeated the
    verification too. A 55-page geometry audit passed clean immediately
    afterwards, because with no CSS there were no grid columns to be crushed
    and nothing to overflow. The audit was measuring a page with no layout at
    all and reporting success. A check that can pass BECAUSE the thing under
    test is missing is worse than no check.

    So: assert the shipped CSS contains nothing that a CSS parser will choke
    on, and that the stylesheet still ends where a complete one should.
    """
    errors = []
    for f in html_files:
        text = f.read_text(encoding="utf-8")
        for m in re.finditer(r"<style>(.*?)</style>", text, re.S):
            css = m.group(1)
            base_line = text.count("\n", 0, m.start(1)) + 1
            for i, line in enumerate(css.split("\n")):
                s = line.strip()
                if s.startswith("#") and not s.startswith("#-"):
                    errors.append(
                        f"[B][{f}:{base_line + i}] python comment leaked into shipped CSS "
                        f"-- a CSS parser stops here and drops every rule after it: {s[:60]}"
                    )
                    break
            if css.count("{") != css.count("}"):
                errors.append(
                    f"[B][{f}] unbalanced braces in shipped CSS "
                    f"({css.count('{')} open vs {css.count('}')} close)"
                )
            if css.count("/*") != css.count("*/"):
                errors.append(
                    f"[B][{f}] unterminated CSS comment -- everything after it is swallowed"
                )
            if css.count("{") < MIN_SHIPPED_CSS_RULE_BLOCKS:
                errors.append(
                    f"[B][{f}] shipped CSS has only {css.count('{')} rule blocks "
                    f"(floor: {MIN_SHIPPED_CSS_RULE_BLOCKS}) -- a truncated or emptied "
                    f"stylesheet passes every other assertion in this check vacuously"
                )
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


# AuditLab CR-1 (2026-08-04): the Nevada CPE page's own notes field named
# three CPE-vendor competitors (Surgent, NinjaCPE, Encoursa) and asserted
# their published info was wrong -- factually defensible, but an evidence-
# free, unexpiring, named-party disparagement claim is the single most
# expensive sentence a site like this can ship (cease-and-desist bait
# regardless of whether the underlying fact holds up). Fixed by dropping the
# names while keeping the correction; this check exists so the NEXT record
# authored with a "vendor X gets this wrong" aside gets caught before it
# ships, not after an audit finds it.
#
# Proximity-based (name + a disparagement term within a short window), not a
# bare name scan -- generate.py's own sanctioned affiliate copy legitimately
# names several of these same vendors positively ("Becker offers CPE courses
# and exam-prep for CPAs"), and a bare name match would flag every one of
# those as a false positive.
DISPARAGEMENT_VENDOR_NAMES = [
    "Surgent", "NinjaCPE", "Encoursa", "Becker", "Gleim", "Wiley",
    "CE Broker", "MyCPE", "MYCPE ONE", "Canopy", "TaxDome", "Karbon",
    "Illumeo", "WebCE",
]
DISPARAGEMENT_TERMS_RE = re.compile(
    r"\b(wrongly|incorrectly|mistaken|misleads?|misleading|inaccurate(?:ly)?|"
    r"gets? (?:it|this) wrong|is wrong|not accurate)\b",
    re.IGNORECASE,
)
_DISPARAGEMENT_WINDOW_CHARS = 200


def check_named_vendor_disparagement(html_files: list[Path]) -> list[str]:
    errors = []
    vendor_re = re.compile("|".join(re.escape(n) for n in DISPARAGEMENT_VENDOR_NAMES))
    for f in html_files:
        text = f.read_text(encoding="utf-8")
        for m in vendor_re.finditer(text):
            window_start = max(0, m.start() - _DISPARAGEMENT_WINDOW_CHARS)
            window_end = min(len(text), m.end() + _DISPARAGEMENT_WINDOW_CHARS)
            window = text[window_start:window_end]
            term = DISPARAGEMENT_TERMS_RE.search(window)
            if term:
                line_no = text.count("\n", 0, m.start()) + 1
                errors.append(
                    f"[H][{f}:{line_no}] named vendor '{m.group(0)}' appears within "
                    f"{_DISPARAGEMENT_WINDOW_CHARS} chars of disparagement term '{term.group(0)}' -- "
                    f"drop the name, keep the correction (see AuditLab CR-1)"
                )
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


def check_deadline_currency(data_path: Path) -> list[str]:
    """AuditLab DATE-1 (MEDIUM, 2026-08-04): deadlines come from two paths --
    computed at build time (next_birth_month_parity_date()/next_annual_month_end(),
    self-rolling by construction, immune to this) and hand-maintained JSON
    (next_deadline_computed for fixed-calendar states, cohort_groups[].next_deadline
    for cohort states) that nothing ever re-derives. A hand-maintained date is only
    ever as current as the last edit -- Kentucky's even-numbered cohort shipped
    "next deadline: July 31, 2026" live on the site for 4 days after that date had
    already passed, surviving two unrelated data-file edits in between, because
    nothing checked CURRENCY (only render-consistency -- see
    check_data_manifest_consistency() above, which confirms the page repeats
    whatever the manifest says without ever asking whether the manifest is still
    true). Fails the build the moment any hand-maintained deadline elapses, so this
    is caught in review instead of shipping live and unnoticed."""
    errors = []
    data = json.loads(data_path.read_text(encoding="utf-8"))
    today = date.today().isoformat()
    for r in data["records"]:
        ndc = r.get("next_deadline_computed")
        if ndc and ndc < today:
            errors.append(
                f"[C][{r['state_slug']}/{r['id']}] next_deadline_computed={ndc} has already elapsed "
                f"(today={today}) -- this is a hand-maintained value nothing re-derives; update it or "
                f"move this state onto a self-rolling computed path"
            )
        for g in r.get("cohort_groups") or []:
            gd = g.get("next_deadline")
            if gd and gd < today:
                errors.append(
                    f"[C][{r['state_slug']}/{r['id']}] cohort_groups['{g.get('group')}'].next_deadline={gd} "
                    f"has already elapsed (today={today}) -- same hand-maintained-date risk as "
                    f"next_deadline_computed above, just inside a cohort_groups entry"
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


TITLE_RE = re.compile(r"<title>(.*?)</title>", re.DOTALL)
META_DESCRIPTION_RE = re.compile(r'<meta name="description" content="(.*?)">', re.DOTALL)
SEO_TITLE_MAX = 60
SEO_DESCRIPTION_MAX = 160


def print_seo_length_drift_advisory(html_files: list[Path]) -> None:
    """AuditLab SEO-4 (LOW, 2026-08-04): 115 titles / 22 descriptions already
    exceeded Google's ~60/~160-char SERP display limits when first filed --
    fixing all of them wasn't worth the effort at LOW severity, but nothing
    enforced a budget, so the count DRIFTED UPWARD (22 -> 28 descriptions)
    just from ordinary copy edits during other fixes this same session. This
    doesn't re-fix the existing 143 (that's still a deliberate LOW-priority
    call) -- it only stops the drift by surfacing the current count every
    build, the same "advisory, never gates" treatment as every other
    detector here. If this number climbs on a future page you're actively
    writing, that's the signal to trim ITS title/description, not to chase
    the whole backlog."""
    over_title = 0
    over_description = 0
    for f in html_files:
        text = f.read_text(encoding="utf-8")
        m = TITLE_RE.search(text)
        if m and len(html.unescape(m.group(1))) > SEO_TITLE_MAX:
            over_title += 1
        m = META_DESCRIPTION_RE.search(text)
        if m and len(html.unescape(m.group(1))) > SEO_DESCRIPTION_MAX:
            over_description += 1
    print(f"\n--- SEO title/description length advisory (does not affect gate exit code) ---")
    print(f"titles > {SEO_TITLE_MAX} chars       : {over_title} / {len(html_files)}")
    print(f"descriptions > {SEO_DESCRIPTION_MAX} chars : {over_description} / {len(html_files)}")


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


def print_dual_credential_citation_advisory(repo_root: Path) -> None:
    """AuditLab DATA-3 (MEDIUM, 2026-08-04): dc-all's citation covered the firm-permit
    half of an "individual CPA license and firm permit" claim, not the individual half
    -- a citation existing is not the same as a citation covering everything a record
    claims. That can't be checked automatically (it requires reading the cited legal
    text, which is AuditLab's job, not this gate's), so this only surfaces the
    candidate list: every record whose license_type_label names more than one
    credential type, and whether it currently opts out of the full-claim assumption
    via citation_covers_full_claim. Advisory only -- a name change here doesn't mean a
    problem, it means "read this one against its citation if nobody has yet."""
    data_path = repo_root / "data" / "cpa_deadlines.json"
    if not data_path.exists():
        print("  (skipping dual-credential-citation advisory -- data/cpa_deadlines.json not present in this checkout)")
        return
    data = json.loads(data_path.read_text(encoding="utf-8"))
    dual = [r for r in data["records"] if " and " in (r.get("license_type_label") or "").lower()]
    print(f"\n--- dual-credential-citation advisory (does not affect gate exit code) ---")
    print(f"{len(dual)} record(s) whose license_type_label names more than one credential type:")
    for r in dual:
        scoped = r.get("citation_covers_full_claim", True)
        flag = "full-claim citation assumed" if scoped else "EXPLICITLY SCOPED (partial citation, see cycle_description)"
        print(f"  [{r['id']}] {r['state']} -- \"{r['license_type_label']}\" -- {flag}")


def print_cpe_hours_staleness_advisory(repo_root: Path) -> None:
    """Surfaces cpe_hours_staleness_check.py (AuditLab ST-2, 2026-08-04) as
    part of the normal pre-ship run, same treatment as the worker-deploy
    advisory above -- printed, never affects exit code. cpe_hours.json has no
    runtime guard of its own (it's inlined into static pages at build time),
    so this is the only place staleness gets surfaced at all."""
    sys.path.insert(0, str(repo_root / "scripts"))
    try:
        import cpe_hours_staleness_check as chsc
    except ImportError:
        print("  (skipping cpe-hours-staleness advisory -- cpe_hours_staleness_check.py not importable)")
        return
    print("\n--- cpe-hours-staleness advisory (does not affect gate exit code) ---")
    try:
        chsc.main()
    except SystemExit:
        pass


def print_reinstatement_staleness_advisory(repo_root: Path) -> None:
    """Surfaces reinstatement_staleness_check.py (AuditLab REIN-1, 2026-08-05)
    as part of the normal pre-ship run, same treatment as the CPE-hours
    advisory above -- printed, never affects exit code. reinstatement.json
    has no runtime guard of its own (inlined into static pages at build
    time), so this is the only place its 51 "Last verified" dates get a
    freshness check at all."""
    sys.path.insert(0, str(repo_root / "scripts"))
    try:
        import reinstatement_staleness_check as rsc
    except ImportError:
        print("  (skipping reinstatement-staleness advisory -- reinstatement_staleness_check.py not importable)")
        return
    print("\n--- reinstatement-staleness advisory (does not affect gate exit code) ---")
    try:
        rsc.main()
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
    all_errors += check_stylesheet_integrity(html_files)
    all_errors += check_legal_safety(html_files, state_page_files)
    all_errors += check_affiliate_disclosure(html_files)
    all_errors += check_named_vendor_disparagement(html_files)
    all_errors += check_data_manifest_consistency(data_path, docs_dir)
    all_errors += check_deadline_currency(data_path)
    all_errors += check_json_copies_identical(repo_root)

    print(f"Pre-ship gate: scanned {len(html_files)} rendered pages, {len(state_dirs)} state dirs.")
    if all_errors:
        print(f"\nFAIL -- {len(all_errors)} violation(s):\n")
        for e in all_errors:
            print(" ", e)
        print_worker_deploy_staleness_advisory(repo_root)
        print_cpe_hours_staleness_advisory(repo_root)
        print_reinstatement_staleness_advisory(repo_root)
        print_dual_credential_citation_advisory(repo_root)
        print_seo_length_drift_advisory(html_files)
        sys.exit(1)
    print("\nPASS -- no violations found.")
    print_worker_deploy_staleness_advisory(repo_root)
    print_cpe_hours_staleness_advisory(repo_root)
    print_reinstatement_staleness_advisory(repo_root)
    print_dual_credential_citation_advisory(repo_root)
    print_seo_length_drift_advisory(html_files)
    sys.exit(0)


if __name__ == "__main__":
    main()
