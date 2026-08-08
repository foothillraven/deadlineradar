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


def check_terms_version_sync(repo_root: Path) -> list[str]:
    """Roadmap #56 (2026-08-07): generate.py's TERMS_LAST_CHANGED (the
    "Last updated" date shown on /terms/) and worker/src/validation.ts's
    TERMS_VERSION (the value written into firms.tos_accepted_version at
    signup) are two copies of the same fact in two languages that can't
    share a literal constant. A silent drift between them would mean a
    firm's stored "version accepted" date doesn't match what the live
    Terms page actually claims was last changed -- the exact kind of
    hand-maintained-copy decay check_json_copies_identical() already
    guards for the cpa_deadlines.json/mobility_rules.json pair, applied to
    a single date string instead of a whole file."""
    generate_py = repo_root / "generate.py"
    validation_ts = repo_root / "worker" / "src" / "validation.ts"
    if not validation_ts.exists():
        print("  (skipping terms-version-sync check -- worker/ tree not present in this checkout)")
        return []
    py_text = generate_py.read_text(encoding="utf-8")
    ts_text = validation_ts.read_text(encoding="utf-8")

    py_match = re.search(r"TERMS_LAST_CHANGED\s*=\s*date\((\d+),\s*(\d+),\s*(\d+)\)", py_text)
    if not py_match:
        return ["[TERMS] generate.py's TERMS_LAST_CHANGED constant not found -- can't verify sync with worker/src"]
    py_date = f"{int(py_match.group(1)):04d}-{int(py_match.group(2)):02d}-{int(py_match.group(3)):02d}"

    ts_match = re.search(r'TERMS_VERSION\s*=\s*"([\d-]+)"', ts_text)
    if not ts_match:
        return ["[TERMS] worker/src/validation.ts's TERMS_VERSION constant not found -- can't verify sync with generate.py"]
    ts_date = ts_match.group(1)

    if py_date != ts_date:
        return [
            f"[TERMS] generate.py's TERMS_LAST_CHANGED ({py_date}) and worker/src/validation.ts's "
            f"TERMS_VERSION ({ts_date}) have drifted -- update both together, at the same time the "
            "Terms wording actually changes"
        ]
    return []


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


SITE_BASE_URL_RE = re.compile(r'<loc>(https?://[^<]+)</loc>')


def check_sitemap_completeness(html_files: list[Path], docs_dir: Path) -> list[str]:
    """AuditLab CRAWL-2 (LOW, 2026-08-07): the third hand-maintained-list
    decay found in ~24 hours (after CRAWL-1's /terms/ omission and RETAIN-1's
    deletion-loop gap) -- build_sitemap() adds each new standalone page from
    a hardcoded literal list, and /roadmap/ was forgotten the same way
    /terms/ was. Same fix shape as RETAIN-1: don't just add the one missing
    entry, assert the invariant so the NEXT omission fails the gate instead
    of waiting for another live audit to find it.

    Checks both directions: every built page without a noindex meta tag
    must appear in sitemap.xml (a page nobody can find via the sitemap is
    an SEO gap), and every sitemap.xml entry must resolve to a real built
    page (a dead sitemap entry wastes crawl budget on a 404)."""
    sitemap_path = docs_dir / "sitemap.xml"
    if not sitemap_path.exists():
        return ["[SITEMAP] docs/sitemap.xml not found -- did generate.py run?"]

    sitemap_urls = set(SITE_BASE_URL_RE.findall(sitemap_path.read_text(encoding="utf-8")))
    # /path/ from a URL like https://deadline-radar.com/path/
    sitemap_paths = {re.sub(r"^https?://[^/]+", "", u) for u in sitemap_urls}

    indexable_paths: set[str] = set()
    for f in html_files:
        if f.name != "index.html":
            continue
        text = f.read_text(encoding="utf-8")
        if 'name="robots" content="noindex"' in text:
            continue
        rel = f.relative_to(docs_dir).parent.as_posix()
        indexable_paths.add("/" if rel == "." else f"/{rel}/")

    missing = sorted(indexable_paths - sitemap_paths)
    dead = sorted(sitemap_paths - indexable_paths)

    errors = []
    if missing:
        errors.append(
            f"[SITEMAP] {len(missing)} indexable page(s) built but missing from sitemap.xml: {', '.join(missing)}"
        )
    if dead:
        errors.append(
            f"[SITEMAP] {len(dead)} sitemap.xml entr(y/ies) point at no built page: {', '.join(dead)}"
        )
    return errors


def _strip_ts_comments(text: str) -> str:
    """Best-effort TS/JS comment stripper for the source-scanning guards in
    this file -- NOT a real parser (doesn't understand `//`/`/* */` inside
    a string literal), but catches the real failure mode a positive-control
    mutation test on check_write_endpoint_rate_limits() surfaced 2026-08-07:
    a naive `"checkRateLimit(" in body` substring search is fooled by a
    COMMENT that mentions the function by name in prose (e.g. "...see
    RATE_LIMIT_X's own comment for why checkRateLimit()'s `ip` parameter is
    deliberately reused..." reads as a real call to a substring search) --
    the guard passed clean with the actual call deleted, exactly the
    "guard exists vs guard fires" gap this whole file exists to prevent.
    Block comments stripped first, then `//` line comments -- `(?<!:)`
    avoids treating a `://` inside a URL string as a comment opener."""
    text = re.sub(r"/\*[\s\S]*?\*/", "", text)
    text = re.sub(r"(?<!:)//.*", "", text)
    return text


def check_demo_locked_email_coverage(repo_root: Path) -> list[str]:
    """AuditLab DEMO-4 (MEDIUM, 2026-08-07): the 4th sibling-decay in ~24
    hours -- an invariant (session-authenticated handlers that email a
    roster-controlled/attacker-suppliable address must skip the send for
    demo_locked firms) enforced ad hoc, nothing asserting it. Without this,
    "one new roster-email feature away from reopening" per AuditLab's own
    framing, since roster-email features have shipped several times a day
    this session.

    AuditLab DEMO-5 (MEDIUM, 2026-08-07): this guard originally scanned
    ONLY `async function handle*` in index.ts -- exactly the scope of the
    finding it was built from, which is exactly how the four decay classes
    in this file all started. The reminder cron (worker/src/scheduler.ts)
    also calls sendViaSendGrid() with no demo_locked check and this guard
    did not catch it. Broadened to every function (any name, async or not)
    in every worker/src/*.ts file -- the invariant is "does this function
    send to a roster-derived address," which has nothing to do with what
    the function is named or which file it lives in.

    Source-scanned (balanced-brace parse), not imported, same
    source-of-truth-not-import approach every sibling guard in this file
    uses. Requires each sender to also reference demo_locked -- UNLESS
    explicitly allowlisted below with the reason it's safe. The allowlist
    is the opt-out AuditLab itself asked for; every entry names why the
    recipient isn't attacker-controlled, not just "already reviewed"."""
    worker_src = repo_root / "worker" / "src"
    if not worker_src.exists():
        print("  (skipping demo-locked-email-coverage check -- worker/ tree not present in this checkout)")
        return []

    # name -> reason the recipient is NOT attacker/demo-visitor-controlled.
    allowlisted = {
        "handleSubscribe": "public /subscribe form -- no firm session exists at all (anonymous signup)",
        "handleRoadmapNotifySignup": "public /roadmap/ voting page -- no firm session exists at all (anonymous)",
        "handleUnsubscribe": "sends only to firm.admin_email (the firm's own address), not an attacker-suppliable one",
        "handleRenewed": "sends only to the subscriber's OWN address, keyed by a token minted for that same address",
        "handleFirmSignOutOtherDevices": "sends only to firm.admin_email (the firm's own address)",
        "handleOauthCallback": "sends only to firm.admin_email on a genuine new-signup notification",
        "handleFirmChangeEmailRequest": "already demo_locked-gated for the whole request (403), not just the send",
        "handleFirmPasswordSet": "already demo_locked-gated for the whole request (403), not just the send",
        "handleFirmAccountDelete": "already demo_locked-gated for the whole request (403), not just the send",
        # Surfaced by DEMO-5's broadened per-function (not just handle*)
        # scan -- these are HELPERS the handle* functions above delegate
        # the actual send to, so the old index.ts/handle*-only scope never
        # looked inside them directly.
        "sendSignupNotification": "sends to the hardcoded INTERNAL_NOTIFY_EMAIL operator address, never a roster/attacker-suppliable one",
        "issueAndSendFirmLoginLink": "sends only to a firm's OWN admin_email -- callers pass either the just-typed signup email (self-referential, same category as handleSubscribe) or the email of an ALREADY-EXISTING firm looked up by store.findFirmByAdminEmail(), never an arbitrary third party",
        "issueAndSendFirmMemberInviteEmail": "recipient IS admin-suppliable (any address a Partner/Office Manager wants to invite), but handleFirmMemberInvite() 403s the WHOLE request for a demo_locked firm before this is ever called -- same front-door posture as handleFirmPasswordSet/handleFirmChangeEmailRequest/handleFirmAccountDelete above, not a per-send check",
        "issueAndSendSubscriberLoginLink": "free-tier individual magic-link sign-in -- public, anonymous, no firm session exists at all (same category as handleSubscribe); demo_locked is a firm-scoped property and doesn't apply here",
    }

    errors = []
    found_names = set()
    for ts_file in sorted(worker_src.glob("*.ts")):
        text = ts_file.read_text(encoding="utf-8")
        for name, body in _balanced_brace_function_bodies(text, r"\w+"):
            found_names.add(name)
            body = _strip_ts_comments(body)
            if "sendViaSendGrid(" not in body:
                continue
            if "demo_locked" in body:
                continue
            if name in allowlisted:
                continue
            errors.append(
                f"[DEMO-EMAIL] {name}() ({ts_file.name}) calls sendViaSendGrid() but has no demo_locked "
                "check and isn't in check_demo_locked_email_coverage()'s allowlist -- either gate the "
                "send for a demo_locked firm, or add it to the allowlist with the reason its recipient "
                "is never attacker-controlled"
            )

    # Reverse direction: an allowlist entry for a function that no longer
    # exists, or that NOW has demo_locked (so the entry is stale/redundant),
    # should be trimmed -- same "both directions" discipline the sitemap and
    # retention guards apply.
    stale_allowlist = sorted(set(allowlisted) - found_names)
    if stale_allowlist:
        errors.append(
            f"[DEMO-EMAIL] allowlist entry for function(s) that no longer exist: {', '.join(stale_allowlist)}"
        )
    return errors


def check_retention_coverage(repo_root: Path) -> list[str]:
    """AuditLab RETAIN-1 (MEDIUM, 2026-08-07): store.hardDeleteExpiredFirms()'s
    table list is hand-maintained with nothing enforcing it -- 5 firm-scoped
    tables (documents, feature_questionnaire_responses, reminder_log,
    firm_nps_responses, firm_testimonials) were added across migrations
    0029-0043 and none was added to the deletion loop, silently breaking the
    "permanently erased" promise the Terms of Service and delete-account
    modal both make. This is a HARD gate check, not an advisory -- a
    data-retention promise silently going unkept is worse than a broken page
    render, and the fix is always a one-line addition, never a judgment call
    that needs a human to weigh in before the gate can pass.

    Parses worker/migrations/*.sql directly (the same source of truth a
    human would check) for every CREATE TABLE with a firm_id column, and
    worker/src/store.ts's FIRM_SCOPED_TABLES array -- source-scanned rather
    than imported, same pattern guide_review_staleness_check.py already uses
    on generate.py, so this runs without a TypeScript toolchain."""
    migrations_dir = repo_root / "worker" / "migrations"
    store_ts = repo_root / "worker" / "src" / "store.ts"
    if not migrations_dir.exists() or not store_ts.exists():
        print("  (skipping retention-coverage check -- worker/ tree not present in this checkout)")
        return []

    # firms: the root row itself, deleted last, not "firm-scoped data".
    # subscribers: deleted via its own dedicated DELETE line (children of a
    #   firm's roster, not a flat firm-id-keyed log table).
    # stripe_webhook_events: migration 0018's own comment -- a raw Stripe
    #   idempotency/audit log; erasing it could let a late-redelivered
    #   webhook for this firm_id be reprocessed as new.
    deliberately_excluded = {"firms", "subscribers", "stripe_webhook_events"}

    table_block_re = re.compile(r"CREATE TABLE(?:\s+IF NOT EXISTS)?\s+(\w+)\s*\(([\s\S]*?)\n\);")
    in_migrations: set[str] = set()
    for sql_file in sorted(migrations_dir.glob("*.sql")):
        text = sql_file.read_text(encoding="utf-8")
        for name, body in table_block_re.findall(text):
            if re.search(r"\bfirm_id\b", body):
                in_migrations.add(name)

    store_src = store_ts.read_text(encoding="utf-8")
    m = re.search(r"FIRM_SCOPED_TABLES\s*=\s*\[([\s\S]*?)\]", store_src)
    if not m:
        return ["[RETAIN] store.ts's FIRM_SCOPED_TABLES array not found -- hardDeleteExpiredFirms()'s table list can't be verified"]
    covered = set(re.findall(r'"(\w+)"', m.group(1)))

    missing = sorted(in_migrations - covered - deliberately_excluded)
    stale = sorted(covered - in_migrations)

    errors = []
    if missing:
        errors.append(
            "[RETAIN] firm-scoped table(s) NOT in store.ts's FIRM_SCOPED_TABLES and not "
            f"deliberately excluded -- a deleted firm's rows here survive forever: {', '.join(missing)}"
        )
    if stale:
        errors.append(
            f"[RETAIN] store.ts's FIRM_SCOPED_TABLES lists table(s) no migration creates: {', '.join(stale)}"
        )
    return errors


def _balanced_brace_function_bodies(text: str, name_pattern: str) -> list[tuple[str, str]]:
    """Balanced-brace parse: for every `(export )?(async )?function <name>(...)`
    whose name matches `name_pattern`, returns (name, full body text
    including the outer braces). Source-scanned, not imported -- same
    posture every sibling guard in this file uses so it runs without a
    TypeScript toolchain."""
    results = []
    for m in re.finditer(rf"(?:export )?(?:async )?function ({name_pattern})\s*\([^)]*\)[^{{]*\{{", text):
        name = m.group(1)
        start = m.end() - 1
        depth = 0
        i = start
        while i < len(text):
            if text[i] == "{":
                depth += 1
            elif text[i] == "}":
                depth -= 1
                if depth == 0:
                    break
            i += 1
        results.append((name, text[start : i + 1]))
    return results


def check_write_endpoint_rate_limits(repo_root: Path) -> list[str]:
    """AuditLab SEC-2 (LOW, 2026-08-07): the third hand-maintained-list
    decay found in ~24 hours, and the one sibling of the pattern that
    hadn't landed a hard gate yet -- SEC-1 fixed 7 write endpoints that
    shipped with no rate limit (4 of them from copying a sibling's
    session+CSRF shape without the checkRateLimit line), but nothing
    asserted new write endpoints keep the pattern. /security/'s own claim
    ("Every write endpoint is rate-limited...") only stays true if
    something enforces it.

    Deliberately scoped to index.ts's handle* functions ONLY (unlike
    check_demo_locked_email_coverage()'s DEMO-5 broadening to every
    worker/src/*.ts function) -- AuditLab flagged this same index.ts-only
    scoping assumption on that guard and it's worth being explicit here:
    "rate limit" is a per-HTTP-request concept, and handle* functions are
    the only HTTP-request-triggered code in this codebase. scheduler.ts's
    cron isn't triggered by a request at all (no caller to rate-limit), so
    broadening this guard the same way would be a category error, not
    just extra work.

    A handle* function in index.ts is "write" if it calls a store.ts
    function whose OWN SQL contains INSERT/UPDATE/DELETE -- derived from
    store.ts's actual .prepare() calls, not guessed from the handler or
    store function's name (a store function like `rearm` or `stop` doesn't
    obviously read as a write verb), same "source of truth, not
    convention" posture check_retention_coverage already uses against
    store.ts. Every such handler must reference checkRateLimit(, unless
    allowlisted below with the reason a rate limit doesn't apply there."""
    index_ts = repo_root / "worker" / "src" / "index.ts"
    store_ts = repo_root / "worker" / "src" / "store.ts"
    if not index_ts.exists() or not store_ts.exists():
        print("  (skipping write-endpoint-rate-limit check -- worker/ tree not present in this checkout)")
        return []

    store_src = store_ts.read_text(encoding="utf-8")
    mutating_fns = set()
    for name, body in _balanced_brace_function_bodies(store_src, r"\w+"):
        body = _strip_ts_comments(body)
        if re.search(r"\.prepare\(\s*[`\"'][^`\"']*?\b(?:INSERT|UPDATE|DELETE)\b", body, re.IGNORECASE):
            mutating_fns.add(name)

    index_src = index_ts.read_text(encoding="utf-8")

    # name -> reason a per-caller rate limit doesn't apply here. Every entry
    # names why, same discipline check_demo_locked_email_coverage's
    # allowlist already established.
    allowlisted = {
        "handleStripeWebhook": "Stripe-signed (verified via webhook secret) server-to-server callback, not a "
        "client-reachable form -- rate-limiting it risks dropping legitimate billing events "
        "under a burst, and the signature check is the real access control here",
        # Token-keyed action links (AuditLab's own suggested exception
        # category): each takes a large random unguessable `token` as its
        # actual identifier, so the token's own entropy -- not a per-IP/
        # global counter -- is the real access control. Confirmed each
        # genuinely requires `token: string | null` before doing anything,
        # not just named like one.
        "handleFirmLoginVerify": "consumes a firm login/magic-link token (store.verifyAndConsumeLoginToken) -- "
        "the token's entropy is the access control, not a counter",
        "handleSubscriberLoginVerify": "consumes a subscriber login/magic-link token (store.verifyAndConsumeSubscriberLoginToken)",
        "handleRoadmapNotifyConfirm": "consumes a roadmap-notify confirmation token",
        "handleUnsubscribe": "consumes a subscriber's own unsubscribe token -- the one-click, no-login unsubscribe promise means this can't require a session, and the token itself is the only credential by design",
        "handleSnooze": "consumes a subscriber's own snooze token (store.snoozeByToken)",
        "handleRearm": "consumes a subscriber's own rearm token (store.renewAndRearmByToken)",
    }

    errors = []
    found_names = set()
    for name, body in _balanced_brace_function_bodies(index_src, r"handle\w+"):
        found_names.add(name)
        body = _strip_ts_comments(body)
        if not any(f"store.{fn}(" in body for fn in mutating_fns):
            continue
        if "checkRateLimit(" in body:
            continue
        if name in allowlisted:
            continue
        errors.append(
            f"[RATELIMIT] {name}() calls a mutating store.* function but has no checkRateLimit() "
            "and isn't in check_write_endpoint_rate_limits()'s allowlist -- either add a rate limit, "
            "or add it to the allowlist with the reason one doesn't apply"
        )

    stale_allowlist = sorted(set(allowlisted) - found_names)
    if stale_allowlist:
        errors.append(
            f"[RATELIMIT] allowlist entry for function(s) that no longer exist: {', '.join(stale_allowlist)}"
        )
    return errors


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


def print_cpa_deadlines_staleness_advisory(repo_root: Path) -> None:
    """Surfaces cpa_deadlines_staleness_check.py (roadmap #45, 2026-08-07) as
    part of the normal pre-ship run, same treatment as the CPE-hours/
    reinstatement/rule-change-monitoring advisories -- printed, never affects
    exit code. cpa_deadlines.json's 88 records each have their own
    last_verified date; the Worker's runtime guard (checkDataFreshness())
    only checks a single whole-dataset as_of_date, which is real but blind
    to one state's citation quietly going stale while as_of_date looks fresh
    because some other record was more recently touched. This is the only
    place PER-CITATION staleness on the product's most important dataset
    gets surfaced at all."""
    sys.path.insert(0, str(repo_root / "scripts"))
    try:
        import cpa_deadlines_staleness_check as cdsc
    except ImportError:
        print("  (skipping cpa-deadlines-staleness advisory -- cpa_deadlines_staleness_check.py not importable)")
        return
    print("\n--- cpa-deadlines-staleness advisory (does not affect gate exit code) ---")
    try:
        cdsc.main()
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


def print_rule_change_monitoring_staleness_advisory(repo_root: Path) -> None:
    """Surfaces rule_change_monitoring_staleness_check.py (AuditLab MON-1,
    2026-08-04) as part of the normal pre-ship run, same treatment as the
    CPE-hours/reinstatement advisories above -- printed, never affects exit
    code. /rule-changes/'s "daily" monitoring claim had no freshness check
    at all before this; see the checker's own docstring for why."""
    sys.path.insert(0, str(repo_root / "scripts"))
    try:
        import rule_change_monitoring_staleness_check as rcmsc
    except ImportError:
        print("  (skipping rule-change-monitoring-staleness advisory -- rule_change_monitoring_staleness_check.py not importable)")
        return
    print("\n--- rule-change-monitoring-staleness advisory (does not affect gate exit code) ---")
    try:
        rcmsc.main()
    except SystemExit:
        pass


def print_guide_review_staleness_advisory(repo_root: Path) -> None:
    """Surfaces guide_review_staleness_check.py (AuditLab PROSE-1, 2026-08-04
    -> tripwire built 2026-08-07) as part of the normal pre-ship run, same
    treatment as the four sibling advisories above -- printed, never affects
    exit code. The blog guides' prose-only regulatory facts had no freshness
    machinery of any kind before this; see the checker's own docstring."""
    sys.path.insert(0, str(repo_root / "scripts"))
    try:
        import guide_review_staleness_check as grsc
    except ImportError:
        print("  (skipping guide-review-staleness advisory -- guide_review_staleness_check.py not importable)")
        return
    print("\n--- guide-review-staleness advisory (does not affect gate exit code) ---")
    try:
        grsc.main()
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

    state_dirs = {p.parent for p in html_files if p.parent.name not in ("privacy", "contact", "terms")} - {docs_dir}
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
    all_errors += check_terms_version_sync(repo_root)
    all_errors += check_retention_coverage(repo_root)
    all_errors += check_sitemap_completeness(html_files, docs_dir)
    all_errors += check_demo_locked_email_coverage(repo_root)
    all_errors += check_write_endpoint_rate_limits(repo_root)

    print(f"Pre-ship gate: scanned {len(html_files)} rendered pages, {len(state_dirs)} state dirs.")
    if all_errors:
        print(f"\nFAIL -- {len(all_errors)} violation(s):\n")
        for e in all_errors:
            print(" ", e)
        print_worker_deploy_staleness_advisory(repo_root)
        print_cpa_deadlines_staleness_advisory(repo_root)
        print_cpe_hours_staleness_advisory(repo_root)
        print_reinstatement_staleness_advisory(repo_root)
        print_rule_change_monitoring_staleness_advisory(repo_root)
        print_guide_review_staleness_advisory(repo_root)
        print_dual_credential_citation_advisory(repo_root)
        print_seo_length_drift_advisory(html_files)
        sys.exit(1)
    print("\nPASS -- no violations found.")
    print_worker_deploy_staleness_advisory(repo_root)
    print_cpa_deadlines_staleness_advisory(repo_root)
    print_cpe_hours_staleness_advisory(repo_root)
    print_reinstatement_staleness_advisory(repo_root)
    print_rule_change_monitoring_staleness_advisory(repo_root)
    print_guide_review_staleness_advisory(repo_root)
    print_dual_credential_citation_advisory(repo_root)
    print_seo_length_drift_advisory(html_files)
    sys.exit(0)


if __name__ == "__main__":
    main()
