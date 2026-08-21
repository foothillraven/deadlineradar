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
    # AuditLab COPY-1 (LOW, 2026-08-13): "A real correctness catch during
    # research... fetched that section directly" shipped in a live CPE
    # record's public notes field -- a researcher narrating their OWN
    # workflow to a colleague, not the site addressing a reader. None of
    # the existing patterns matched (not "curl", "WebFetch", or
    # "re-verified"), which is the actual gap: this is a denylist, so it
    # stops phrasings someone already thought of and lets the next
    # paraphrase through. These few additions close the one instance
    # found; a denylist can't be made complete this way, only less
    # incomplete -- see COPY-1's own note that a real fix for the class
    # would need a different check shape (allowlist for free-prose
    # fields), which is a bigger, separate judgment call.
    r"\bcorrectness catch\b",
    r"\bduring research\b",
    r"\bfetched (?:that|this|it) [a-z ]{0,20}directly\b",
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


# ---------------------------------------------------------------------------
# Shape-based leak detection (orchestrator Fable-window directive,
# 2026-08-14): COPY-1 through COPY-4 each sailed past LEAK_PATTERNS above,
# and each fix appended a few more literal phrases -- four consecutive
# demonstrations that a denylist stops only the phrasings someone already
# thought of. These two detectors match the SHAPE of the leak class instead
# of its vocabulary, using the exact signatures every COPY-x instance
# shared:
#   1. a raw snake_case identifier in rendered prose (COPY-2's `confidence:
#      single_source`, COPY-3's `penalty_cpe_hours`, `reinstatement_fee_usd`,
#      ...) -- no legitimate reader-facing sentence on this site contains a
#      snake_case token;
#   2. a "(YYYY-MM-DD: ..." dated maintenance parenthetical (COPY-4's two
#      Nevada instances) -- record-keeping changelog syntax, not prose.
#
# Extraction recipe (AuditLab's validated order, from their COPY-3 residual
# report): strip HTML comments FIRST (so a commented-out block can't hide a
# token from the tag-stripper), then scripts/styles wholesale (they are
# legitimately full of snake_case), then tags (attribute values go with
# them), then entity-unescape, then URLs (path segments legitimately contain
# underscores). What remains is what a human actually reads.
#
# GATE-5 hardening (AuditLab, 2026-08-20, orchestrator-approved 19:12 MDT):
# "attribute values go with them" was wrong for the handful of attributes a
# browser actually RENDERS to the user -- title (hover tooltip), alt (image
# fallback/screen reader), aria-label (screen reader), placeholder (empty
# input text). A `data_gap_note` written for a future maintainer landed
# verbatim in a `title=` tooltip on 4 live pages (citation_url, source_url,
# cpa_deadlines, fee_notes -- schema field names, customer-visible) and no
# detector saw it, because the old recipe discarded ALL attribute values
# before scanning. `class`/`id`/`data-*` correctly stay discarded -- they are
# legitimately snake_case and a browser never shows them to a user. So this
# extracts only the 4 user-visible attributes' values and folds them into the
# scanned prose before the wholesale tag-strip removes them from the tag.
# ---------------------------------------------------------------------------

_PROSE_VISIBLE_ATTR_RE = re.compile(
    r'\b(?:title|alt|aria-label|placeholder)\s*=\s*(?:"([^"]*)"|\'([^\']*)\')',
    re.IGNORECASE,
)

_PROSE_SNAKE_CASE_RE = re.compile(r"\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b")
# GATE-1 (AuditLab, 2026-08-14): the original `\(20\d\d-\d\d-\d\d:` required a
# literal "(" and missed docs/michigan's live parenthesis-free changelog
# ("...2026-07-30: Michigan's official sources could not be reached..."). The
# actual tell is an ISO date immediately followed by a colon introducing a
# note -- with or without a wrapping paren. `(?<!\d)` keeps it from firing
# mid-longer-number. Legit reader copy uses spelled-out dates ("August 10,
# 2026"), never `YYYY-MM-DD:`, so this shape is unambiguous.
_PROSE_DATED_PAREN_RE = re.compile(r"(?<!\d)20\d\d-\d\d-\d\d:")
_PROSE_URL_RE = re.compile(r"(?:https?://|www\.)[^\s<>\"')]+|\b[a-z0-9.-]+\.(?:gov|com|org|net|edu|us|io)(?:/[^\s<>\"')]*)?", re.IGNORECASE)
# GATE-2 (2026-08-14): found live on /firm-mobility/, where the "Check whole
# roster" panel shipped its own ticket description as the customer-facing
# subhead ("Roadmap #320: run every roster member's own home state..."). The
# two shapes above could not catch it -- it is neither snake_case nor a dated
# changelog note, just ordinary English with an internal tracker reference
# welded to the front. Two distinct tells, both unambiguous in reader copy:
# a tracker id ("Roadmap #320", "ticket 412"), and the fleet's own internal
# agent/tool names, which a customer has no concept of and which also reveal
# how the site is built. Neither has any legitimate reason to appear in
# public prose, so both are flat denials with no allowlist.
_PROSE_TRACKER_REF_RE = re.compile(r"\b(?:roadmap|ticket|backlog|issue|epic|story)\s*#?\s*\d+", re.IGNORECASE)
# "Raven" and "Contender" are deliberately NOT in this list: the operating
# entity is literally named Moose & Raven LLC, so the token appears in the
# footer of all 235 pages and in every legal page by design -- a detector on
# it is pure noise and would train the next reader to ignore this gate.
# "Contender" is likewise an ordinary English word. Both are unmatchable
# against their internal use here, so they get no rule rather than a bad one.
_PROSE_INTERNAL_NAME_RE = re.compile(
    r"\b(?:AuditLab|ValueLab|DiffLab|AssetLab|BotLab|StockLab|PortfolioMeta|"
    r"BettingBot|FleetDeck|firmchat|HANDOFF)\b"
)

# GATE-1 hardening (AuditLab, COPY-3 2026-08-14 residual report, implemented
# 2026-08-20): COPY-3's own writeup named the second half of the shape it was
# fixing -- "snake_case identifiers and [A-Z]+-\d+ finding IDs are
# mechanically detectable" -- but only the snake_case half was ever built.
# The finding-ID half (every AuditLab/AssetLab finding across this whole
# session -- COPY-3, GATE-1, BADGE-2, SILENT-1, DATA-12, CITE-26, ...) never
# got a detector, so a note like "see COPY-3" pasted into reader copy would
# sail past every existing check the same way COPY-3 itself did. Same
# rationale as the snake_case rule: no legitimate reader-facing sentence on
# this site refers to itself by an internal tracker's finding ID.
_PROSE_FINDING_ID_RE = re.compile(r"\b[A-Z]{2,10}-\d{1,4}\b")

# Tokens that are legitimately part of reader-facing prose. Keep this SHORT
# and justified per entry -- an unexplained entry defeats the whole point.
_PROSE_SNAKE_CASE_ALLOWLIST: dict[str, str] = {
    # (none currently -- the 2026-08-14 baseline sweep of all 235 rendered
    # pages found zero legitimate snake_case tokens in extracted prose. If a
    # future hit is genuinely reader-appropriate, add it here WITH a reason.)
}

# GATE-1's finding-ID shape also matches real legal/technical citation
# formats that happen to look like a tracker ID. Confirmed by a full sweep of
# docs/ on 2026-08-20 -- these are the only 3 tokens live on the site today
# that match the shape, and all 3 are genuine reader-facing citations, not a
# leaked finding ID.
_PROSE_FINDING_ID_ALLOWLIST: dict[str, str] = {
    "PRE-2024": "Georgia CPE page's plain-English 'PRE-2024' cohort label, not a finding ID",
    "RICR-00": "Rhode Island's own regulatory citation prefix (Rhode Island Code of Regulations)",
    "SHA-256": "the security page's cryptographic hash-algorithm name",
}


def _extract_rendered_prose(page_html: str) -> str:
    """Reduce a rendered page to the text a human actually reads -- see the
    recipe comment above for why the order matters."""
    text = re.sub(r"<!--.*?-->", " ", page_html, flags=re.DOTALL)
    text = re.sub(r"<script\b.*?</script\s*>", " ", text, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r"<style\b.*?</style\s*>", " ", text, flags=re.DOTALL | re.IGNORECASE)
    # <code> spans are the site's explicit "this is a deliberate technical
    # token" marker (e.g. the firm dashboard's CSV import help, which must
    # state the exact column headers a user's file needs). Content inside
    # them is intentional notation, not leaked prose -- stripped wholesale.
    # A raw identifier OUTSIDE <code> stays caught, which is the leak class.
    text = re.sub(r"<code\b.*?</code\s*>", " ", text, flags=re.DOTALL | re.IGNORECASE)
    visible_attr_text = " ".join(
        g1 or g2 for g1, g2 in _PROSE_VISIBLE_ATTR_RE.findall(text)
    )
    text = re.sub(r"<[^>]+>", " ", text)
    text = text + " " + visible_attr_text
    text = html.unescape(text)
    text = _PROSE_URL_RE.sub(" ", text)
    return text


def check_prose_leak_shapes(html_files: list[Path]) -> list[str]:
    errors = []
    for f in html_files:
        prose = _extract_rendered_prose(f.read_text(encoding="utf-8"))
        for m in _PROSE_SNAKE_CASE_RE.finditer(prose):
            token = m.group(0)
            if token in _PROSE_SNAKE_CASE_ALLOWLIST:
                continue
            snippet = prose[max(0, m.start() - 60): m.end() + 60].replace("\n", " ").strip()
            errors.append(
                f"[SHAPE][{f}] snake_case identifier '{token}' in rendered prose -- ...{snippet}... "
                f"(internal field/enum names never belong in reader copy; reword in plain English or, "
                f"if genuinely reader-appropriate, allowlist WITH a reason)"
            )
        for m in _PROSE_DATED_PAREN_RE.finditer(prose):
            snippet = prose[max(0, m.start() - 60): m.end() + 80].replace("\n", " ").strip()
            errors.append(
                f"[SHAPE][{f}] dated changelog note '{m.group(0)}...' in rendered prose -- "
                f"...{snippet}... (changelog syntax belongs in verification_history, not public copy)"
            )
        for m in _PROSE_TRACKER_REF_RE.finditer(prose):
            snippet = prose[max(0, m.start() - 60): m.end() + 90].replace("\n", " ").strip()
            errors.append(
                f"[SHAPE][{f}] internal tracker reference '{m.group(0)}' in rendered prose -- "
                f"...{snippet}... (a ticket id means the ticket text was pasted in as copy; "
                f"rewrite it as a sentence written for the reader)"
            )
        for m in _PROSE_INTERNAL_NAME_RE.finditer(prose):
            snippet = prose[max(0, m.start() - 60): m.end() + 90].replace("\n", " ").strip()
            errors.append(
                f"[SHAPE][{f}] internal fleet name '{m.group(0)}' in rendered prose -- "
                f"...{snippet}... (internal agent/tool names are meaningless to a customer and "
                f"disclose how the site is built)"
            )
        for m in _PROSE_FINDING_ID_RE.finditer(prose):
            token = m.group(0)
            if token in _PROSE_FINDING_ID_ALLOWLIST:
                continue
            snippet = prose[max(0, m.start() - 60): m.end() + 90].replace("\n", " ").strip()
            errors.append(
                f"[SHAPE][{f}] internal finding-ID shape '{token}' in rendered prose -- "
                f"...{snippet}... (looks like an AuditLab/AssetLab tracker ID pasted into copy; "
                f"reword in plain English or, if it's a genuine citation, allowlist WITH a reason)"
            )
    return errors


# ERR-1 (AuditLab, 2026-08-20, orchestrator-approved 19:25 MDT): the "Mark
# renewed" 400 error told a CPA to "Re-add them (POST /firm/licenses)" --
# same leak family as GATE-5 (internal vocabulary reaching a customer), but a
# different surface: Worker error strings, not generated HTML, so the
# title/alt/aria-label fix above doesn't reach it and no prior gate scanned
# it. This is a lightweight sibling check over `error: "..."` literals in
# index.ts for a raw HTTP verb or an internal API path -- the same shape that
# instance had.
_WORKER_ERROR_STRING_RE = re.compile(r'error:\s*"((?:[^"\\]|\\.)*)"')
_WORKER_ERROR_API_LEAK_RE = re.compile(r"\b(?:GET|POST|PUT|PATCH|DELETE)\s+/\S*|/[a-zA-Z][a-zA-Z0-9_-]*/[a-zA-Z][a-zA-Z0-9_/-]*")


def check_worker_error_strings_no_api_internals(repo_root: Path) -> list[str]:
    path = repo_root / "worker" / "src" / "index.ts"
    if not path.exists():
        return []
    source = path.read_text(encoding="utf-8")
    errors = []
    for m in _WORKER_ERROR_STRING_RE.finditer(source):
        message = m.group(1)
        if "http://" in message or "https://" in message:
            continue  # a linked/quoted URL is a legitimate citation, not a route leak
        leak = _WORKER_ERROR_API_LEAK_RE.search(message)
        if leak:
            line_no = source.count("\n", 0, m.start()) + 1
            errors.append(
                f"[ERR][{path}:{line_no}] user-facing error string contains an API path/verb "
                f"{leak.group(0)!r} -- {message!r}. A customer has no concept of our routes; "
                f"reword to describe the remedy in plain English (match the register of the "
                f"neighbouring error strings in the same handler)."
            )
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
        # DATE-2 (2026-08-20): generate.py's _roll_forward_recurring_deadline()
        # now advances any computation.type == fixed_calendar_recurring_no_anchor
        # record past an elapsed raw JSON value at BUILD time, in memory --
        # it deliberately never writes the rolled-forward date back to this
        # file, so the raw value here can legitimately look "elapsed" while
        # the generated site is correct. Skip those; every other record is
        # still genuinely hand-maintained and this check still protects it.
        self_rolling = (r.get("computation") or {}).get("type") == "fixed_calendar_recurring_no_anchor"
        if ndc and ndc < today and not self_rolling:
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


_TABLE_ROW_RE = re.compile(r'<tr data-month="(\d+)">(.*?)</tr>')
_TABLE_CELL_RE = re.compile(r"<td>(.*?)</td>")
_MONTH_NAME_TO_NUM = {name: i + 1 for i, name in enumerate(MONTH_NAMES)}
_TABLE_DATE_RE = re.compile(r"^(" + "|".join(MONTH_NAMES) + r") (\d{1,2}), (\d{4})$")


def check_birth_month_table_currency(html_files: list[Path]) -> list[str]:
    """AuditLab TABLE-1 (LOW, 2026-08-08): the CA/TX-shaped birth-month tables
    (render_california/render_texas, plus the generic
    render_birth_month_year_parity_state/render_birth_month_annual_state pair
    added for Arizona/Oklahoma/New Mexico) are computed fresh at build time
    from `as_of` -- so unlike next_deadline_computed in cpa_deadlines.json
    (covered by check_deadline_currency above), nothing in the JSON goes
    stale here; the HTML itself does, purely as a function of build age. A
    build that ships a week after `as_of`, across a month boundary, can
    serve a table row with a date that has already elapsed -- same shape as
    DATE-1's Kentucky incident, just on generated HTML instead of hand-
    maintained JSON, and 729bbe69 raised the stakes by promoting the same
    per-row value into the page's headline answer. Parses every
    `data-month` table row directly out of the generated HTML and fails the
    build the moment any cell's date has already passed."""
    errors = []
    today = date.today().isoformat()
    for f in html_files:
        html_text = f.read_text(encoding="utf-8")
        for row_match in _TABLE_ROW_RE.finditer(html_text):
            month_num = row_match.group(1)
            row_html = row_match.group(2)
            for cell in _TABLE_CELL_RE.findall(row_html):
                cell_text = html.unescape(cell).strip()
                m = _TABLE_DATE_RE.match(cell_text)
                if not m:
                    continue  # month-name cell, or some other non-date cell shape
                month_name, day, year = m.group(1), int(m.group(2)), int(m.group(3))
                iso = f"{year:04d}-{_MONTH_NAME_TO_NUM[month_name]:02d}-{day:02d}"
                if iso < today:
                    errors.append(
                        f"[TABLE-1][{f}] data-month={month_num} row shows an elapsed date "
                        f"'{cell_text}' (today={today}) -- this is a build-time-computed "
                        f"birth-month table cell, not hand-maintained JSON; the build is "
                        f"simply too old. Regenerate docs/ (re-run generate.py) before shipping."
                    )
    return errors


_HIDDEN_TAG_RE = re.compile(r"<[a-zA-Z][a-zA-Z0-9]*\b[^>]*>")
_HIDDEN_ATTR_RE = re.compile(r"(?<![\w-])hidden(?![\w-])")
_HIDDEN_CLASS_ATTR_RE = re.compile(r'\bclass="([^"]*)"')
_STYLE_BLOCK_RE = re.compile(r"<style[^>]*>(.*?)</style>", re.DOTALL)
_CSS_RULE_RE = re.compile(r"([^{}]+)\{([^{}]*)\}")
_CSS_DISPLAY_RE = re.compile(r"display\s*:\s*([a-zA-Z-]+)")

# HIDDEN-1's allowlist (per AuditLab's own caution: every entry must name why
# the class is safe, not just "already reviewed") -- a class here carries a
# bare `hidden` attribute AND an unconditional non-`none` display rule AND no
# `.cls[hidden]` override, but is confirmed safe for a stated reason (e.g. the
# display rule only ever applies inside a state that's mutually exclusive
# with `hidden` being set, verified by reading the JS that toggles it).
_HIDDEN_DISPLAY_OVERRIDE_ALLOWLIST: set[str] = set()


def check_hidden_display_override(html_files: list[Path]) -> list[str]:
    """AuditLab HIDDEN-1 (LOW/preventive, 2026-08-07, recommended for
    wiring in): a class-based `display` rule with equal CSS specificity to
    the browser's built-in `[hidden] { display: none }` UA rule wins the
    cascade tie by source order (author styles load after the UA
    stylesheet) -- so an element that ships with a bare `hidden` attribute
    can still render visible if its class has an unconditional `display`
    rule and nothing re-asserts `display: none` at `.cls[hidden]` (higher
    specificity, wins regardless of order). This exact bug reached
    production 3 for 3 times (cookie notice, roadmap notify form, dashboard
    view switcher), caught only by Devin using the product on his phone --
    invisible by construction, since the DOM state (`hidden` really is set)
    is correct and only the pixels are wrong; no error, no console warning.

    AuditLab's own design note: scan the built HTML/CSS, not the JS --
    `errEl`/`okEl`/`panel`-style local variable names are reused across
    scopes and defeat a source-level scan, but the shipped DOM already
    names the real classes on the real elements and the shipped <style>
    block already has every rule, so no variable-name inference or scope
    analysis is needed. Validated 2/2 against the pre-fix versions of two
    of the three historical bugs before being recommended for wiring in.

    Known, stated incompleteness (AuditLab's own words, not silently
    dropped): this only catches elements that SHIP hidden. An element that
    starts visible and is only ever hidden at runtime (`el.hidden = true`
    from JS) is the same underlying bug but outside this check's reach --
    flagged as a follow-on if it ever bites, not treated as covered here."""
    errors = []
    for f in html_files:
        html_text = f.read_text(encoding="utf-8")
        style_text = " ".join(m.group(1) for m in _STYLE_BLOCK_RE.finditer(html_text))
        if not style_text.strip():
            continue
        css_rules = [(sel, decl) for sel, decl in _CSS_RULE_RE.findall(style_text)]

        def _class_has_unconditional_visible_display(cls: str) -> bool:
            escaped = re.escape(cls)
            simple_selector_re = re.compile(r"^\." + escaped + r"$")
            for sel, decl in css_rules:
                branches = [b.strip() for b in sel.split(",")]
                if not any(simple_selector_re.match(b) for b in branches):
                    continue
                m = _CSS_DISPLAY_RE.search(decl)
                if m and m.group(1).strip().lower() != "none":
                    return True
            return False

        def _class_has_hidden_override(cls: str) -> bool:
            escaped = re.escape(cls)
            override_marker = f".{cls}[hidden]"
            for sel, decl in css_rules:
                if override_marker in sel:
                    m = _CSS_DISPLAY_RE.search(decl)
                    if m and m.group(1).strip().lower() == "none":
                        return True
            return False

        for tag_match in _HIDDEN_TAG_RE.finditer(html_text):
            tag_text = tag_match.group(0)
            if not _HIDDEN_ATTR_RE.search(tag_text):
                continue
            class_match = _HIDDEN_CLASS_ATTR_RE.search(tag_text)
            if not class_match:
                continue
            for cls in class_match.group(1).split():
                if cls in _HIDDEN_DISPLAY_OVERRIDE_ALLOWLIST:
                    continue
                if _class_has_unconditional_visible_display(cls) and not _class_has_hidden_override(cls):
                    errors.append(
                        f"[HIDDEN-1][{f}] element ships with `hidden` and class '.{cls}' has an "
                        f"unconditional non-none `display` rule with no `.{cls}[hidden]` override -- "
                        f"the class rule and the browser's built-in [hidden] rule tie on specificity "
                        f"and author styles win by source order, so this element can render visible "
                        f"despite `hidden` being set. Add `.{cls}[hidden] {{ display: none; }}`, or if "
                        f"this is confirmed safe, allowlist '{cls}' in "
                        f"_HIDDEN_DISPLAY_OVERRIDE_ALLOWLIST with a stated reason."
                    )
    return errors


def check_cpe_hours_currency(repo_root: Path) -> list[str]:
    """AuditLab BADGE-1 (MEDIUM, 2026-08-09): roadmap #47 upgraded the public
    CPE badge from a bare "Verified" to a dated "Verified 2026-07-15" on 50
    live pages -- a specific, publicly checkable claim. cpe_hours_staleness_check.py
    already computes exactly which records are past the 30-day bar, but was
    wired into preship_gate.py as an advisory only (print_cpe_hours_staleness_advisory()
    below), same as cpa_deadlines.json's per-citation staleness was before
    DATE-1 promoted THAT dataset's check_deadline_currency() into a hard
    gate. Without this, 22 badges were on track to cross 30 days on
    2026-08-14 with the build still passing -- a dated, predictable failure,
    not a hypothetical. Same fix shape as DATE-1: promote, don't just print."""
    sys.path.insert(0, str(repo_root / "scripts"))
    try:
        import cpe_hours_staleness_check as chsc
    except ImportError:
        return []
    data_path = repo_root / "data" / "cpe_hours.json"
    if not data_path.exists():
        return []
    data = json.loads(data_path.read_text(encoding="utf-8"))
    _fresh, stale, unparseable, missing = chsc.collect_stale(data["records"])
    errors = []
    for r, age_days in stale:
        errors.append(
            f"[BADGE][cpe/{r['id']}] {r.get('state')} -- verified_date={r['verified_date']} is {age_days}d old, "
            f"past the {chsc.STALENESS_THRESHOLD_DAYS}-day bar the public 'Verified {r['verified_date']}' badge "
            f"asserts -- re-verify and bump verified_date before shipping"
        )
    for r in unparseable:
        errors.append(f"[BADGE][cpe/{r['id']}] {r.get('state')} -- verified_date={r.get('verified_date')!r} is unparseable -- treat as stale")
    for r in missing:
        errors.append(f"[BADGE][cpe/{r['id']}] {r.get('state')} -- verified_date is missing entirely -- treat as stale")
    return errors


def check_annual_minimum_not_alternative_track(repo_root: Path) -> list[str]:
    """CITE-52 (AuditLab, 2026-08-20, orchestrator-approved): Arkansas's
    cpe_hours.json record had annual_minimum_hours=40 rendered as a per-year
    FLOOR under its 120-hour/3-year total, but 17 CAR 236-1203(a) actually
    grants a CHOICE between two equivalent tracks (120hrs/36mo OR 40hrs/12mo)
    -- not a floor layered on top of either. The rendered page told a CPA
    who correctly used the 40-hour track they'd failed a requirement that
    doesn't exist.

    AuditLab's tell, generalised into a permanent check: a genuine per-year
    floor is always strictly LESS than the period total spread evenly over
    the period (every real floor clears this -- 20x2=40 of 80, Oregon
    24x2=48 of 80). Arkansas was the only record where annual_minimum x
    period_years == total_hours exactly (40x3=120) -- the arithmetic
    signature of "this is actually an alternative total, not a floor."
    A record legitimately shaped this way must say so explicitly via
    annual_minimum_basis='alternative_track' (which also switches the
    template's rendering, see build_cpe_hours_page()); anything else that
    matches this arithmetic without the flag is the exact silent-regression
    shape CITE-52 fixed once already."""
    data_path = repo_root / "data" / "cpe_hours.json"
    if not data_path.exists():
        return []
    data = json.loads(data_path.read_text(encoding="utf-8"))
    errors = []
    for r in data["records"]:
        annual_minimum = r.get("annual_minimum_hours")
        period_years = r.get("period_years")
        total_hours = r.get("total_hours")
        if not annual_minimum or not period_years or not total_hours:
            continue
        # AuditLab's tell is specifically about MULTI-year records -- a
        # 1-year-period record where annual_minimum == total_hours is the
        # separate, already-handled "same fact stated twice" case
        # build_cpe_hours_page() already suppresses the bullet for (see its
        # own comment above), not this defect class. Confirmed by running
        # this check unscoped first: it produced 9 false positives, every
        # one a period_years==1 record (Alabama, Maine, Michigan,
        # Mississippi, Missouri, Nevada, New York, North Carolina, South
        # Carolina) -- caught before shipping, not after.
        if period_years == 1:
            continue
        basis = r.get("annual_minimum_basis") or "floor"
        if basis == "alternative_track":
            continue
        if annual_minimum * period_years == total_hours:
            errors.append(
                f"[FLOOR][cpe/{r['id']}] {r.get('state')} -- annual_minimum_hours ({annual_minimum}) x "
                f"period_years ({period_years}) == total_hours ({total_hours}) exactly. A genuine per-year "
                f"floor is always strictly LESS than the period total (CITE-52's tell) -- this is very "
                f"likely a disjunctive alternative track mislabeled as a floor, not a real annual minimum. "
                f"Read the primary source before shipping: if it's genuinely a floor, this is a coincidence "
                f"worth a comment explaining why; if it's a choice-of-tracks shape like Arkansas, set "
                f"annual_minimum_basis='alternative_track'."
            )
    return errors


def check_rule_change_monitoring_currency(repo_root: Path) -> list[str]:
    """MON-3 (AuditLab, 2026-08-20, orchestrator's refined ruling): 17 days
    of real staleness on /rule-changes/'s "watching ... daily" claim turned
    out to be a missing sync step, not a dead monitor -- DiffLab's own
    capture cadence never stopped (20/20 cycles). The original ruling
    against hard-gating this ("depends on another team's cron, would block
    unrelated fixes hostage to their uptime") no longer applies to the
    ACTUAL failure mode: the sync step (scripts/sync_rule_change_coverage_stats.py)
    silently not running is fixable from inside this repo in minutes -- the
    same bar every other hard gate here already uses (BADGE-1's own
    promotion of cpe_hours_staleness_check.py is the direct precedent).
    DiffLab's real uptime still isn't checkable from here and stays outside
    this gate's scope entirely -- this only ever asks "is the LOCAL file
    stale," the same question the advisory always asked; only the severity
    changed."""
    sys.path.insert(0, str(repo_root / "scripts"))
    try:
        import rule_change_monitoring_staleness_check as rcmsc
    except ImportError:
        return []
    result = rcmsc.collect_staleness(repo_root)
    status = result["status"]
    if status == "ok":
        return []
    if status == "no_data_file":
        return []  # dataset genuinely absent in this checkout -- not this gate's concern
    if status == "missing":
        return ["[MON3] data/rule_change_coverage_stats.json has no last_checked_at at all -- "
                "run scripts/sync_rule_change_coverage_stats.py"]
    if status == "unparseable":
        return [f"[MON3] data/rule_change_coverage_stats.json's last_checked_at ({result['raw']!r}) "
                f"is unparseable -- re-run scripts/sync_rule_change_coverage_stats.py"]
    # status == "stale"
    return [
        f"[MON3] rule_change_coverage_stats.json is {result['age_hours']:.1f}h old, past the "
        f"{rcmsc.STALENESS_THRESHOLD_HOURS}h bar -- /rule-changes/ and the homepage hero strip are "
        f"asserting \"{result['cadence']}\" against a stale capture. Run "
        f"scripts/sync_rule_change_coverage_stats.py to pull DiffLab's current output before shipping."
    ]


def check_fee_basis_supported(repo_root: Path) -> list[str]:
    """fee_basis='codified' must carry a citation_url; 'board_schedule' must
    carry a citation_url or source_url. 'unverifiable' is unrestricted -- that
    label IS the honest state of having nothing to point to.

    Found live 2026-08-15: indiana-renewal-fee and montana-renewal-fee both
    asserted fee_basis='codified' with NO citation_url at all -- not merely an
    unfinished record, an unsupported claim sitting in shipped data. Nothing
    was checking the label against the evidence backing it. 'codified' is the
    strongest claim this dataset makes about a fee (there is a specific rule
    section a reader can go read); it must not be assertable for free.
    """
    errors = []
    path = repo_root / "data" / "renewal_fees.json"
    if not path.exists():
        return []
    data = json.loads(path.read_text(encoding="utf-8"))
    for r in data["records"]:
        basis = r.get("fee_basis")
        if basis == "codified" and not r.get("citation_url"):
            errors.append(
                f"[FEEBASIS][{r.get('id')}] fee_basis='codified' but citation_url is empty -- "
                f"a codified claim with no rule section to point to is unsupported. Either add "
                f"the citation or downgrade to 'board_schedule'/'unverifiable' to match what "
                f"is actually known."
            )
        elif basis == "board_schedule" and not r.get("citation_url") and not r.get("source_url"):
            errors.append(
                f"[FEEBASIS][{r.get('id')}] fee_basis='board_schedule' but neither citation_url "
                f"nor source_url is set -- nothing backs the claim that a regulator publishes "
                f"this figure."
            )
    return errors


def check_renewal_fee_currency(repo_root: Path) -> list[str]:
    """Roadmap 2026-08-11 (14:30 item #6): the state pages now show a public,
    dated renewal-fee claim (or an honest "unconfirmed" disclosure) sourced
    from data/renewal_fees.json -- same promote-to-hard-gate shape as
    check_cpe_hours_currency() above, so this dataset can't silently drift
    stale the way CPE hours briefly did before BADGE-1 caught it."""
    sys.path.insert(0, str(repo_root / "scripts"))
    try:
        import renewal_fee_staleness_check as rfsc
    except ImportError:
        return []
    data_path = repo_root / "data" / "renewal_fees.json"
    if not data_path.exists():
        return []
    data = json.loads(data_path.read_text(encoding="utf-8"))
    _fresh, stale, unparseable, missing = rfsc.collect_stale(data["records"])
    errors = []
    for r, age_days in stale:
        errors.append(
            f"[FEE][{r['id']}] {r.get('state')} -- verified_date={r['verified_date']} is {age_days}d old, "
            f"past the {rfsc.STALENESS_THRESHOLD_DAYS}-day recheck cadence -- re-verify against the "
            f"official source and bump verified_date before shipping"
        )
    for r in unparseable:
        errors.append(f"[FEE][{r['id']}] {r.get('state')} -- verified_date={r.get('verified_date')!r} is unparseable -- treat as stale")
    for r in missing:
        errors.append(f"[FEE][{r['id']}] {r.get('state')} -- verified_date is missing entirely -- treat as stale")
    return errors


# ---------------------------------------------------------------------------
# DERIV-1 (2026-08-14). Some reinstatement records don't state an independent
# dollar amount -- they DERIVE one from a state's base renewal fee, and print
# the computed result as customer-facing copy. That coupling is invisible:
# editing renewal_fees.json looks like a one-record change and silently
# desyncs a different dataset's published figures.
#
# This is not hypothetical. Texas's base fee was corrected 118 -> 112 the same
# day this check was written; its reinstatement record multiplies that base by
# 22 TAC 515.5's 1.5x/2x/3x tiers and was still publishing $177/$236/$354.
# Nothing would have caught it -- the record's own verified_date was fresh and
# every citation was valid. It was found only because a build output was
# grepped by hand for the old number.
#
# Each entry names the base fee it depends on and the exact arithmetic, and
# the check asserts the RESULT literally appears in the prose. So a base-fee
# edit fails the build until the dependent copy is updated with it.
#
# Deliberately a hand-maintained registry, not a prose-scanner: a regex over
# "$N" in fee notes matches dozens of unrelated amounts and would be noise.
# Adding an entry is 3 lines; a wrong entry is worse than a missing one.
_DERIVED_FEE_CHECKS: list[dict] = [
    {
        "state": "texas", "field": "reinstatement_fee_notes",
        "why": "22 TAC 515.5 tiers the reinstatement fee as a multiple of the base renewal fee",
        # (label, multiplier, addend)
        "terms": [("1.5x tier", 1.5, 0), ("2x tier", 2.0, 0), ("3x tier", 3.0, 0)],
    },
    {
        "state": "wisconsin", "field": "reinstatement_fee_notes",
        "why": "the $68 total is the base renewal fee plus the $25 late fee at Wis. Stat. 440.08(3)(a)",
        "terms": [("renewal + $25 late fee", 1.0, 25)],
    },
    {
        "state": "rhode-island", "field": "reinstatement_fee_notes",
        "why": "total out-of-pocket is the $500 reinstatement fee plus the triennial renewal fee",
        "terms": [("reinstatement + renewal total", 1.0, 500)],
    },
    {
        "state": "south-dakota", "field": "reinstatement_fee_notes",
        "why": "ARSD 20:75:03:03 is the base renewal fee plus a $100/year late fee; the stated minimum is one year",
        "terms": [("minimum, lapse under 1 year", 1.0, 100)],
    },
    {
        "state": "montana", "field": "reinstatement_fee_notes",
        "why": "the late-renewal penalty is 100% of the renewal fee, so the stated rough total is double it",
        "terms": [("renewal + 100% penalty", 2.0, 0)],
    },
    {
        "state": "california", "field": "reinstatement_fee_notes",
        "why": "Bus. & Prof. Code 163.5 sets the delinquency fee at 50% of the renewal fee",
        "terms": [("50% delinquency fee", 0.5, 0)],
    },
    {
        "state": "idaho", "field": "reinstatement_fee_notes",
        "why": "IDAPA 24.30.01.400 sums the unpaid license fees for the preceding 3 cycles",
        "terms": [("3-cycle representative case", 3.0, 0)],
    },
    {
        "state": "vermont", "field": "reinstatement_fee_notes",
        "why": "3 V.S.A. 127(d)(1): renewal fee plus a $100 flat penalty within 30 days",
        "terms": [("renewal + $100 flat penalty", 1.0, 100)],
    },
    {
        "state": "south-carolina", "field": "reinstatement_fee_notes",
        # Registered 2026-08-14 when CITE-21 #6 closed: the field now carries
        # the codified $500 and the prose quotes the $595 total ($95 renewal +
        # $500 reinstatement), matching the rhode-island pattern above.
        "why": "total out-of-pocket is the $500 codified reinstatement fee plus the annual renewal fee",
        "terms": [("reinstatement + renewal total", 1.0, 500)],
    },
    # DERIV-2 (AuditLab, 2026-08-20): registered 6 real couplings an
    # arithmetic sweep found unguarded -- same exposure DERIV-1 exists to
    # prevent (Texas's base moved 118 -> 112 while its reinstatement record
    # kept publishing the old-base-derived totals; nothing caught it until a
    # build output was grepped by hand). All 6 are correct against current
    # base fees today; the risk is a future base-fee edit silently
    # falsifying them, which is exactly what already happened once.
    {
        # Structured field, not prose -- see check_derived_fee_consistency()'s
        # numeric-field branch above.
        "state": "maryland", "field": "reinstatement_fee_usd",
        "why": "COMAR 09.24.01.09.B(9)/(4) sets the reinstatement fee at double the standard renewal fee",
        "terms": [("2x renewal fee", 2.0, 0)],
    },
    {
        "state": "alaska", "field": "reinstatement_fee_usd",
        "why": "12 AAC 02.340(4)/(13): the biennial renewal fee plus a $100 delayed-renewal penalty",
        "terms": [("renewal + $100 penalty (under-1-year lapse)", 1.0, 100)],
    },
    {
        "state": "nebraska", "field": "reinstatement_fee_usd",
        "why": "no separately named reinstatement fee is published; a returning registrant pays the board's current Active Permit to Practice fee",
        "terms": [("equals the base renewal fee", 1.0, 0)],
    },
    {
        "state": "utah", "field": "reinstatement_fee_notes",
        "why": "DOPL's reinstatement application: $50 reinstatement fee plus the license renewal fee, for a license expired under 2 years",
        "terms": [("reinstatement + renewal total, under-2-year lapse", 1.0, 50)],
    },
    {
        "state": "pennsylvania", "field": "reinstatement_fee_notes",
        "why": "the reinstatement fee is paid IN ADDITION TO the current biennial renewal fee",
        "terms": [("reinstatement + renewal total", 1.0, 35)],
    },
    {
        "state": "west-virginia", "field": "reinstatement_fee_notes",
        "why": "W. Va. C.S.R. Sec1-1-18: base renewal fee, plus an $85 reinstatement fee and a $50 late fee (both fixed, not derived from the base)",
        "terms": [("base + $220 total", 1.0, 135)],
    },
]


# ---------------------------------------------------------------------------
# SRC-5 (2026-08-14, orchestrator/AuditLab recommendation after two block
# claims survived a sweep aimed at them): a reader-facing note may only
# assert that a source "blocks" access if source_check.py actually returns
# BLOCKED for that record's own URLs. Without this, "my parser choked"
# prose can quietly re-enter data_gap_note and nothing catches it until the
# next manual audit. Network calls at gate time are deliberately capped to
# ONLY the records whose notes make a block claim (a handful), not all 245.
#
# SRC-7 (2026-08-20): the phrase-list regex used to live here as its own
# copy; moved to source_check.BLOCK_CLAIM_RE (see that module for the full
# rationale) so this check and gap_list_check.py's inventory can't drift
# out of sync the way they already had -- see that constant's own comment.
#
# SRC-8 (2026-08-20): this list ALSO used to live here as its own copy, one
# field per dataset -- missing that cpa_deadlines.json carries a SECOND
# gap-note-shaped field (verification_note), which is where ak-individual/
# ak-firm's block claim actually lived. That meant those two records were
# never scanned by this check at all, before or after SRC-7's regex fix --
# a structurally different miss than a phrase-list gap. Moved to
# source_check.GAP_NOTE_FIELDS (imported, not copied) for the same reason
# as BLOCK_CLAIM_RE.
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# DATA-7 (2026-08-14, AuditLab, found on a live page): correcting a claim in
# one field does NOT correct it in its siblings. Louisiana's fee_notes was
# rewritten to say no multiplier is codified while data_gap_note -- rendered
# right below it as "Sourcing note:" -- kept naming "twice the renewal fee"
# as a live possibility. The page argued with itself. A per-record content
# sweep cannot catch this, because each field reads fine alone; only grepping
# for the phrase you deleted finds it.
#
# This registry is that grep, run at build time. Each entry is a claim we
# affirmatively disproved against primary text, plus the record it belongs
# to -- so the phrase can never quietly reappear in ANY rendered field of
# that record. Scoped per-record on purpose: "$150" is wrong for Arkansas's
# renewal fee and perfectly correct for New Jersey's reinstatement fee, so a
# global phrase ban would be pure noise.
_RETIRED_CLAIMS: list[tuple[str, str, str]] = [
    # (record id, phrase that must not reappear, why it was retired)
    ("louisiana-reinstatement", "twice the renewal",
     "no multiplier is codified anywhere in the board's rules (SRC-1)"),
    ("oh-individual", "January 31 grace",
     "no ORC/OAC text establishes a grace period; a late fee accrues monthly (SRC-6)"),
    ("oh-individual", "3-group cohort",
     "the cohort is arithmetic of the triennial cycle, not a stated three-group system (SRC-6)"),
    ("rhode-island-renewal-fee", "statutory maximum",
     "R.I. Gen. Laws 5-3.1-7(f) sets $375 as a MINIMUM, not a maximum (SRC-6)"),
    ("virginia-renewal-fee", "no late fee",
     "18VAC5-22-20(A) codifies a $100 untimely-renewal fee (SRC-6)"),
    ("south-dakota-renewal-fee", "stale $50",
     "ARSD 20:75:03:12 was amended eff. 2026-07-01 and now codifies $100 (SRC-6)"),
    ("colorado-renewal-fee", "24-34-102",
     "repealed; the fee provision moved to 12-20-105 in 2019 (SRC-6)"),
    ("tn-all", "older administrative rule",
     "the conflicting annual-firm-permit rule is the CURRENT compilation (SRC-6)"),
    ("arkansas-renewal-fee", "$150 annual",
     "the board's rules set $110; $150 is the reinstatement fee (SRC-6)"),
    ("texas-renewal-fee", "$118",
     "unsourced; the Board's published figure is $112 (CITE-21)"),
    ("ga-cpe", "16 hours shall be in accounting",
     "superseded pre-2024 text; the current rule requires 50% technical (SRC-6)"),
    ("az-individual", "5:00pm",
     "no such cutoff in the current A.A.C. R4-1-345(B) text"),
    ("az-firm", "5:00pm",
     "no such cutoff in the current A.A.C. R4-1-345(B) text"),
]
_RETIRED_SKIP_FIELDS = {"verification_history", "verification_note", "status_evidence"}


# ---------------------------------------------------------------------------
# The published post states three rules that "now run on every build". Two of
# them were genuinely gated when it shipped (block claims -> SRC-5, derived
# figures -> DERIV-1). The first -- "primary sources only as the citation of
# record" -- was NOT: nothing stopped a new third-party-mirror citation from
# being added tomorrow, and SRC-6 proved that gap is live, finding
# oregon.public.law had survived SRC-1 because that sweep only matched three
# hosts by name. This closes it, so the claim on the public page is true.
#
# Only citation_url is policed. A mirror kept as secondary_source_url is the
# INTENDED end state of SRC-1 (demoted, not discarded) and is never an error.
_MIRROR_HOST_RE = re.compile(
    r"(law\.cornell\.edu|codes\.findlaw\.com|law\.justia\.com|regulations\.justia\.com"
    r"|casetext\.com|\.public\.law|anylaw\.com|leagle\.com)",
    re.IGNORECASE,
)
# Records allowed to keep a mirror as citation_url, because no official host
# serves the text at all. Each needs a reason AND a disclosure in the record's
# own data_gap_note -- the gate checks that disclosure exists, so an exception
# can't be silently granted to dodge the rule.
_MIRROR_CITATION_EXCEPTIONS: dict[str, str] = {
    "tx-cpe": (
        "Texas SOS migrated the TAC to a JS-only Appian portal; per-rule pages render only in a "
        "browser, and a JS shell is a worse citation than a mirror that shows the text."
    ),
}


def check_citations_are_primary(repo_root: Path) -> list[str]:
    """Enforce the published 'primary sources only as the citation of record' rule."""
    errors = []
    for fname in ("cpa_deadlines.json", "cpe_hours.json", "reinstatement.json", "renewal_fees.json"):
        path = repo_root / "data" / fname
        if not path.exists():
            continue
        for r in json.loads(path.read_text(encoding="utf-8"))["records"]:
            url = r.get("citation_url")
            if not isinstance(url, str) or not _MIRROR_HOST_RE.search(url):
                continue
            rid = r.get("id")
            if rid not in _MIRROR_CITATION_EXCEPTIONS:
                errors.append(
                    f"[MIRROR][{rid}] citation_url points at a third-party legal mirror ({url}) -- "
                    f"the site publicly commits to primary sources as the citation of record. Repoint "
                    f"it at the state's own publication, or add it to _MIRROR_CITATION_EXCEPTIONS with "
                    f"a reason and disclose the gap in the record's data_gap_note."
                )
                continue
            gap = r.get("data_gap_note")
            if not isinstance(gap, str) or not gap.strip():
                errors.append(
                    f"[MIRROR][{rid}] is an allowed mirror-citation exception but has no data_gap_note "
                    f"telling the reader why -- an exception the reader can't see is just an "
                    f"unannounced broken promise"
                )
    return errors


_FEE_LINE_RE = re.compile(r"<strong>Renewal fee:</strong>\s*\$[\d,]+\.(.{0,600}?)</p>", re.DOTALL)


def check_published_figures_link_source(html_files: list[Path]) -> list[str]:
    """The published post 'How a superseded rule hid on an official site' tells
    readers, in its closing line, that EVERY figure on this site links to its
    source. That was false when it shipped: six board-set renewal fees (DC,
    IN, MT, PR, TX, USVI) have no citation_url and were rendering the dollar
    amount with no link at all. Fixed by falling back to source_url -- this
    gate keeps the promise true, because a public claim about our own rigour
    should be enforced, not just asserted once and hoped for."""
    errors = []
    for f in html_files:
        text = f.read_text(encoding="utf-8")
        for m in _FEE_LINE_RE.finditer(text):
            if "cite-link" not in m.group(1):
                errors.append(
                    f"[FIGURE][{f}] a rendered renewal-fee figure has no source link -- the published "
                    f"blog post promises every figure links to its source, so either give this record "
                    f"a citation_url/source_url or change that published claim"
                )
    return errors


def check_retired_claims_absent(repo_root: Path) -> list[str]:
    """Fail the build if a disproved claim reappears in any reader-facing field
    of the record it was retired from. See the registry comment above."""
    by_id: dict[str, dict] = {}
    for fname in ("cpa_deadlines.json", "cpe_hours.json", "reinstatement.json", "renewal_fees.json"):
        path = repo_root / "data" / fname
        if not path.exists():
            continue
        for r in json.loads(path.read_text(encoding="utf-8"))["records"]:
            if r.get("id"):
                by_id[r["id"]] = r

    errors = []
    for rid, phrase, why in _RETIRED_CLAIMS:
        rec = by_id.get(rid)
        if rec is None:
            errors.append(
                f"[RETIRED][{rid}] registered as having a retired claim but the record no longer "
                f"exists -- update _RETIRED_CLAIMS if it was intentionally removed"
            )
            continue
        for field, value in rec.items():
            if field in _RETIRED_SKIP_FIELDS or not isinstance(value, str):
                continue
            if phrase.lower() in value.lower():
                errors.append(
                    f"[RETIRED][{rid}] .{field} contains the retired claim {phrase!r} -- {why}. "
                    f"This claim was disproved against primary text; if it is back, either a sibling "
                    f"field was missed when the correction was applied or the correction was reverted."
                )
    return errors


_SRC5_UNVERIFIED: list[str] = []


def check_block_claims_corroborated(repo_root: Path) -> list[str]:
    _SRC5_UNVERIFIED.clear()
    sys.path.insert(0, str(repo_root / "scripts"))
    try:
        import source_check
    except ImportError:
        return []
    errors = []
    for fname, fields in source_check.GAP_NOTE_FIELDS:
        path = repo_root / "data" / fname
        if not path.exists():
            continue
        data = json.loads(path.read_text(encoding="utf-8"))
        for r in data["records"]:
            matched_field = next((f for f in fields
                                   if isinstance(r.get(f), str) and source_check.BLOCK_CLAIM_RE.search(r.get(f))), None)
            if matched_field is None:
                continue
            field = matched_field
            urls = [r.get(k) for k in ("citation_url", "source_url") if r.get(k)]
            if not urls:
                continue
            verdicts = {}
            for u in urls:
                try:
                    res = source_check.check(u)
                    cls = res["classification"]
                    # A timeout or connection failure is NOT evidence about the
                    # host's behaviour -- source_check reports both as BLOCKED
                    # with http_status None, while a real refusal carries a
                    # status code. Treating the two alike made this gate
                    # nondeterministic: the SAME tree passed or failed depending
                    # on whether a state server happened to answer in 30s (slow
                    # -> BLOCKED -> "claim corroborated" -> pass; responsive ->
                    # SOFT_404 -> fail). Observed live 2026-08-14: three
                    # consecutive runs gave exit 0, 1, 0 with nothing changed.
                    # A hard gate whose verdict depends on the network is worse
                    # than no gate -- it teaches you to re-run until it's green.
                    if cls == "BLOCKED" and res.get("http_status") is None:
                        cls = "INCONCLUSIVE(transient)"
                    verdicts[u] = cls
                except Exception as e:  # network hiccup at gate time: warn, don't false-fail
                    verdicts[u] = "CHECK_ERROR(%s)" % type(e).__name__
            # The claim is corroborated if at least one of the record's own URLs
            # is genuinely BLOCKED, or EXTRACTION_FAILED -- STALE-9's residual
            # (AuditLab, 2026-08-20): EXTRACTION_FAILED means real bytes came
            # back but nothing readable did (an SPA shell, a PDF our ladder
            # can't parse) -- source_check.py's own docstring calls this "OUR
            # failure," never a host block, but from THIS gate's perspective a
            # record honestly saying "renders only in a browser" or "requires a
            # browser" about a URL that source_check independently confirms is
            # unreadable is telling the truth, not asserting a block that
            # doesn't exist. Excluding it here was the same harm SRC-9 fixed
            # one classification over: a true caveat pressured into deletion
            # because the corroboration path was too narrow. If every URL
            # fetches with genuinely readable text, the prose asserts a
            # problem that does not exist. Anything inconclusive suppresses
            # the verdict entirely rather than deciding it in either direction.
            if not any(v in ("BLOCKED", "EXTRACTION_FAILED") for v in verdicts.values()) and \
               not any(v.startswith("CHECK_ERROR") for v in verdicts.values()) and \
               not any(v.startswith("INCONCLUSIVE") for v in verdicts.values()):
                errors.append(
                    f"[SRC5][{r.get('id')}] {fname}.{field} claims a source blocks access, but "
                    f"source_check classifies its URLs as {verdicts} -- either the block healed "
                    f"(remove/reword the claim) or the note is the parser-choke misdiagnosis this "
                    f"gate exists to stop"
                )
            elif any(str(v).startswith(("INCONCLUSIVE", "CHECK_ERROR"))
                     for v in verdicts.values()):
                _SRC5_UNVERIFIED.append(f"{r.get('id')} ({fname})")

    # Say out loud which records this check could not actually assess. A gate
    # that quietly checks nothing reads identically to one that checked and
    # found nothing -- that is how a passing build stops meaning anything.
    if _SRC5_UNVERIFIED:
        print(f"  [SRC5] NOT ASSESSED this run ({len(_SRC5_UNVERIFIED)} record(s)) -- their hosts "
              f"did not answer, so the block claim was neither corroborated nor refuted: "
              f"{', '.join(sorted(set(_SRC5_UNVERIFIED)))}")
    return errors


# ---------------------------------------------------------------------------
# HEDGE-1 (2026-08-19, Orchestrator/accuracy_plan.md section 2, dispatched
# 2026-08-18T18:05): the direct structural fix for how New Jersey happened.
# NJ's 2026-07-17 verification_history entry already said the njcpa.org/
# NASBA "December 31" figure was "insufficient to publish as fact" -- but
# the record's data_gap_note stayed null (no reader-facing caveat at all)
# and cycle_description/citation shipped that exact unverified claim as
# settled fact anyway. The caveat existed in the record's OWN history;
# nothing machine-enforced it reaching the reader. Same bug shape as the
# Stripe classifier note and the admin-digest cron this session: a
# human-readable warning existed, nothing checked it at build time.
#
# Deliberately narrow, not a blanket "hedge word" scanner: a record whose
# verification_history discusses a PAST problem it has since fixed (this
# session alone wrote dozens of entries like "AuditLab flagged X, checked
# it, here's the correction") must NOT trip this -- only a record that (a)
# has hedge language ANYWHERE in its own history, AND (b) currently ships
# with NO data_gap_note at all (i.e. presents to the reader as fully
# confirmed, no caveat whatsoever) is the exact NJ shape: an internal
# caveat that never reached the surface. A record with any data_gap_note,
# however worded, has already reflected SOME caveat and is not this bug.
_HEDGE_MARKER_RE = re.compile(
    r"insufficient to (ship|publish)|not enough to confirm|secondary source only|"
    r"flagged\b.{0,40}\bnot fixed",
    re.IGNORECASE | re.DOTALL,
)


def _latest_history_entry(history: str) -> str:
    """verification_history is a sequence of dated entries appended in order,
    each starting 'YYYY-MM-DD (...)', joined by blank lines (confirmed
    convention -- checked against real records, no entry itself contains an
    internal blank line). Split on that separator and return the LAST one --
    positional append-order, not a max() over the date strings, since same-
    day entries (a record can get 2+ entries in one session) would tie on
    date alone."""
    return history.split("\n\n")[-1]


def check_hedge_language_enforced(repo_root: Path) -> list[str]:
    """Fail the build if a record's own verification_history flags its
    sourcing as insufficient/unconfirmed but the record currently ships
    with no data_gap_note -- an internal caveat that never reached the
    reader. See HEDGE-1 above.

    2026-08-19 (AuditLab GATE-4, found the same day HEDGE-1 shipped): the
    original version searched the WHOLE history string for the marker
    phrases. A record whose CURRENT state is genuinely clean -- an earlier
    entry once used trigger language, a LATER entry resolved it, no
    data_gap_note today because there's nothing left to caveat -- still
    tripped this, because the marker search doesn't care which entry it
    matches in. 0 live records affected (reran against all 4 real datasets),
    but the next record narrating a past hedge-language problem in a
    resolution entry would false-positive. Scoped to the LATEST entry only:
    a record whose most recent history entry still uses hedge language is
    the actual NJ shape (an unresolved caveat as of right now); one whose
    hedge language is confined to an OLDER, superseded entry is not.

    Deliberately checks ONLY the reader-facing data_gap_note field, not
    cpa_deadlines.json's internal-only verification_note (SRC-8, 2026-08-20,
    split GAP_NOTE_FIELDS off into source_check.py with both fields for the
    block-claim check's purposes -- this check's purpose is different: "did
    the caveat reach the reader," which verification_note structurally
    cannot answer since it never renders anywhere)."""
    errors = []
    field = "data_gap_note"
    for fname in ("cpa_deadlines.json", "cpe_hours.json", "reinstatement.json", "renewal_fees.json"):
        path = repo_root / "data" / fname
        if not path.exists():
            continue
        for r in json.loads(path.read_text(encoding="utf-8"))["records"]:
            history = r.get("verification_history")
            if not isinstance(history, str):
                continue
            latest = _latest_history_entry(history)
            match = _HEDGE_MARKER_RE.search(latest)
            if not match:
                continue
            if r.get(field):
                continue  # data_gap_note present -- caveat already reflected, not this bug
            errors.append(
                f"[HEDGE1][{r.get('id')}] {fname}: verification_history's LATEST entry flags this "
                f"record's own sourcing as insufficient/unconfirmed ({match.group(0)!r}), "
                f"but {field} is empty -- the record ships with no reader-facing caveat at all. "
                f"Either the flagged claim was never actually corrected (add {field} explaining the "
                f"gap, same as every other unconfirmed record) or the history entry describing a "
                f"since-fixed problem needs a follow-up entry making clear it was resolved."
            )
    return errors


# AuditLab CITE-29 (2026-08-20): CITE-13's own fix (same commit as CITE-12's,
# which DID set the flag) rewrote ak-firm's cycle_description to admit its
# citation doesn't establish the current renewal window, but forgot the
# machine-readable half -- citation_covers_full_claim stayed unset (defaults
# True). trust_line() reads ONLY that flag, so /alaska/ rendered the exact
# contradiction the flag exists to prevent: "checked against ... not just a
# board webpage" directly beside a caveat admitting a board document is
# exactly what established the date. The existing dual-credential-citation
# advisory (above) couldn't have caught this even in principle -- ak-firm's
# license_type_label is "Firm permit," a single credential, never in that
# advisory's candidate population at all. This is the third instance today
# of the same shape (SRC-8's missed field, CITE-28's un-updated helper): a
# prose fix shipped without its machine-readable sibling. Closes the CLASS,
# not just ak-firm -- tested against the full live dataset before adopting:
# matches all 4 records that currently and correctly carry the flag
# (dc-all, de-all, ak-firm, us-virgin-islands-all), zero false positives
# against the other 85.
#
# AuditLab re-verify (same day): a hand-built phrase list, the same SRC-7
# shape -- tested it against 8 plausible future phrasings and missed all 8,
# including the gate's OWN docstring wording ("doesn't establish"). Widened
# the verb list and added a few more phrase shapes (silent-on, inferred-not-
# cited, corroborated-separately). Deliberately did NOT go as far as a bare
# "does not (establish|cover|confirm|state|name)" with no "itself" anchor --
# tested that broader version against the live dataset first and it produced
# a real false positive on or-individual, whose "The Board's page does NOT
# state how parity is originally assigned" is legitimate prose about a fact
# the record explicitly does NOT claim (only the recurring pattern, which
# IS fully cited) -- not an admission that its OWN claim is under-cited.
# Unlike SRC-7's "over-matching is cheap" (a missed live-check), a false
# positive here would push someone to add a citation_covers_full_claim=false
# flag to a record that is genuinely fully covered, which is its own kind of
# dishonesty. The "itself" anchor is the line between "this citation doesn't
# itself establish X" (an admission about THIS record's own coverage) and
# "the source doesn't state Y" (routine prose about an unrelated fact) --
# kept it. Re-tested full coverage + zero false positives after this change.
_PARTIAL_CITATION_ADMISSION_RE = re.compile(
    r"does not itself (state|name|spell out|establish|cover|confirm)|"
    r"not independently confirmed|not confirmed in|"
    r"instead confirmed|confirmed instead|corroborated (?:separately|instead)|"
    r"(?:is|remains|stays) silent on|"
    r"inferred,? not cited|inferred rather than cited",
    re.IGNORECASE,
)


def check_partial_citation_flag_set(repo_root: Path) -> list[str]:
    """A record whose prose admits its own citation doesn't establish the full
    claim must set citation_covers_full_claim=False -- otherwise trust_line()
    (which reads ONLY that flag, never the prose) asserts full codified-law
    confirmation right beside a caveat saying otherwise. See CITE-29.

    CITE-32 (AuditLab, 2026-08-20): this only ever read cpa_deadlines.json.
    trust_line() and _record_fully_cited() are already dataset-agnostic
    (generate.py's guide-page call sites at :19010/:19602 pass records from
    all four files) -- only the GATE was scoped to one file, so
    reinstatement.json/cpe_hours.json/renewal_fees.json records could carry
    the same admission with no gate ever checking them. Live proof:
    louisiana-reinstatement's data_gap_note says its ethics-hours figure is
    'not independently confirmed in the codified rule text' while
    citation_covers_full_claim was unset -- the page rendered the confident
    sentence directly above its own contradiction. Widened to loop all four
    datasets and both admission-bearing fields (cycle_description is
    cpa_deadlines-only; the other three datasets carry the same kind of
    prose in data_gap_note), same loop shape as
    check_retired_claims_absent_from_guides's sibling fix for the identical
    one-dataset-only gap."""
    errors = []
    for name in ("cpa_deadlines", "cpe_hours", "reinstatement", "renewal_fees"):
        data_path = repo_root / "data" / f"{name}.json"
        if not data_path.exists():
            continue
        data = json.loads(data_path.read_text(encoding="utf-8"))
        for r in data["records"]:
            if r.get("citation_class") == "operational_record":
                continue  # trust_line() never renders the codified-law sentence for these -- no contradiction possible
            prose = r.get("cycle_description") or r.get("data_gap_note")
            if not isinstance(prose, str):
                continue
            match = _PARTIAL_CITATION_ADMISSION_RE.search(prose)
            if not match:
                continue
            if r.get("citation_covers_full_claim", True) is False:
                continue  # already flagged -- the contradiction is already suppressed
            errors.append(
                f"[CITE29][{name}.json:{r.get('id')}] admits its citation doesn't establish the "
                f"full claim ({match.group(0)!r}), but citation_covers_full_claim is unset (defaults "
                f"True) -- trust_line() will render the confident 'not just a board webpage' sentence "
                f"directly beside this admission. Set citation_covers_full_claim: false."
            )
    return errors


def check_retired_claims_absent_from_guides(repo_root: Path, html_files) -> list[str]:
    """Retired claims must not survive in hand-written guide prose either.

    DATA-8 (AuditLab, 2026-08-14): f51791c37 corrected Arizona's deadline in the
    data record, but /blog/arizona-cpa-license-renewal-guide/ kept the old
    "5:00pm on the last business day" wording -- twice. Two different filing
    deadlines for the same license were live simultaneously.

    The galling part: _RETIRED_CLAIMS ALREADY carried ("az-individual", "5:00pm").
    check_retired_claims_absent() only ever scans data records, so the identical
    phrase sat untouched in prose the generator hard-codes. Same registry, same
    phrase, a surface nothing was looking at.

    Scoped by slug prefix: a phrase retired for Arizona is sought only in blog
    pages whose slug starts with "arizona". Deliberate limitation, stated plainly
    -- a guide that discusses another state in passing is not covered, and
    widening it to every page would resurrect the per-record scoping problem the
    main registry exists to avoid ("$150" is wrong for Arkansas, right for New
    Jersey). Slug scoping is what would have caught this defect.

    Sibling check to check_retired_claims_absent(); both read one registry.
    """
    errors = []
    rec_state: dict[str, str] = {}
    for name in ("cpa_deadlines", "cpe_hours", "reinstatement", "renewal_fees"):
        path = repo_root / "data" / f"{name}.json"
        if not path.exists():
            continue
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        for rec in doc.get("records", []):
            if rec.get("id"):
                rec_state[rec["id"]] = rec.get("state_slug") or ""

    blog_pages = [p for p in html_files if "blog" in p.parts]
    if not blog_pages:
        return ["check_retired_claims_absent_from_guides found NO built blog "
                "pages. Either guides stopped building or the docs/blog/ layout "
                "changed -- this check is measuring nothing and must be repaired."]

    for page in blog_pages:
        slug = page.parent.name
        html = page.read_text(encoding="utf-8", errors="ignore")
        for rid, phrase, why in _RETIRED_CLAIMS:
            state = rec_state.get(rid)
            if not state or not slug.startswith(state):
                continue
            if phrase in html:
                errors.append(
                    f"blog/{slug}: contains \"{phrase}\", a claim retired for "
                    f"record {rid} ({why}). The data record was corrected but "
                    f"this guide's prose still states the old fact -- the page "
                    f"and its state page now disagree. Update the guide text in "
                    f"generate.py's BLOG_ARTICLES."
                )
    return errors


def check_stale_thresholds_unified(html_files) -> list[str]:
    """The seal and the small text caveat must flip on the SAME day count.

    Orchestrator decision 2026-08-14, replacing an earlier 30/45 split: a record
    aged 31-44 days rendered a green "Verified" caveat directly beside a red
    "RE-VERIFY NEEDED" seal for that same record -- a self-contradiction visible
    to any reader. Both now derive from generate.py's _STALE_DAYS.

    Checked against BUILT output, not the source constants, because the failure
    mode that matters is what a visitor's browser actually evaluates: the two
    values are inlined into every page's JS by separate runtime blocks, and
    nothing but this check stops a future edit from re-splitting them. Source
    comments say "do not re-split"; a comment cannot fail a build.

    Zero false-positive risk by construction -- it compares two numbers that are
    required to be equal, rather than inferring intent from prose.
    """
    errors = []
    seal_re = re.compile(r"SEAL_STALE_DAYS\s*=\s*(\d+)")
    badge_re = re.compile(r"RUNTIME_STALE_DAYS\s*=\s*(\d+)")
    checked = 0
    for path in html_files:
        html = path.read_text(encoding="utf-8", errors="ignore")
        seal = seal_re.search(html)
        badge = badge_re.search(html)
        if not seal or not badge:
            continue
        checked += 1
        if seal.group(1) != badge.group(1):
            errors.append(
                f"{path.name}: staleness thresholds diverged -- seal flips at "
                f"{seal.group(1)} days but the text caveat flips at "
                f"{badge.group(1)}. A record aged between them shows a green "
                f"'Verified' caveat beside a red 'RE-VERIFY NEEDED' seal. Both "
                f"must read generate.py's _STALE_DAYS."
            )
    if checked == 0 and html_files:
        errors.append(
            "check_stale_thresholds_unified found NO page carrying both "
            "SEAL_STALE_DAYS and RUNTIME_STALE_DAYS. Either the seal/badge "
            "runtimes stopped shipping or their variable names changed -- this "
            "check is no longer measuring anything and must be repaired."
        )
    return errors


def check_derived_fee_consistency(repo_root: Path) -> list[str]:
    """Fail the build when a published figure derived from a base renewal fee
    no longer matches that fee. See the registry comment above."""
    fees_path = repo_root / "data" / "renewal_fees.json"
    reinst_path = repo_root / "data" / "reinstatement.json"
    if not fees_path.exists() or not reinst_path.exists():
        return []
    fees = {r.get("state_slug"): r for r in json.loads(fees_path.read_text(encoding="utf-8"))["records"]}
    reinst = {r.get("state_slug"): r for r in json.loads(reinst_path.read_text(encoding="utf-8"))["records"]}

    errors = []
    for spec in _DERIVED_FEE_CHECKS:
        slug = spec["state"]
        base_row, dep_row = fees.get(slug), reinst.get(slug)
        if base_row is None or dep_row is None:
            errors.append(f"[DERIV][{slug}] registered as a derived-fee dependency but the record is missing -- "
                          f"update _DERIVED_FEE_CHECKS if this state was intentionally removed")
            continue
        base = base_row.get("fee_usd")
        if not isinstance(base, (int, float)):
            errors.append(f"[DERIV][{slug}] base renewal fee is {base!r}, so the derived figures in "
                          f"reinstatement.{spec['field']} can no longer be checked -- either restore the base "
                          f"fee or reword that copy to stop quoting a computed amount ({spec['why']})")
            continue
        # DERIV-2 (AuditLab, 2026-08-20): 3 of 6 newly-registered couplings
        # derive the STRUCTURED reinstatement_fee_usd number itself (the
        # page's headline figure), not just prose -- the original substring-
        # in-prose check can't validate a bare int field. Numeric fields are
        # checked by exact equality instead of substring match.
        field_value = dep_row.get(spec["field"])
        if isinstance(field_value, (int, float)):
            for label, mult, add in spec["terms"]:
                expected = int(round(base * mult + add))
                if int(field_value) != expected:
                    errors.append(
                        f"[DERIV][{slug}] reinstatement.{spec['field']} is {field_value}, but should be "
                        f"{expected} for the {label} (base renewal fee ${int(base)} -- {spec['why']}). "
                        f"A base-fee edit desyncs this derived figure silently; update both together."
                    )
            continue
        prose = field_value or ""
        for label, mult, add in spec["terms"]:
            expected = int(round(base * mult + add))
            if f"${expected}" not in prose:
                found = sorted({int(x) for x in re.findall(r"\$(\d+)", prose)})
                errors.append(
                    f"[DERIV][{slug}] reinstatement.{spec['field']} should quote ${expected} for the "
                    f"{label} (base renewal fee ${int(base)} -- {spec['why']}), but that amount does not "
                    f"appear. Amounts currently in that copy: {found}. A base-fee edit desyncs derived "
                    f"copy silently; update both together."
                )
    return errors


def check_reinstatement_currency(repo_root: Path) -> list[str]:
    """AuditLab BADGE-1 (MEDIUM, 2026-08-09): same promotion as
    check_cpe_hours_currency() above, for the sibling reinstatement dataset
    -- see that function's own docstring for the full reasoning."""
    sys.path.insert(0, str(repo_root / "scripts"))
    try:
        import reinstatement_staleness_check as rsc
    except ImportError:
        return []
    data_path = repo_root / "data" / "reinstatement.json"
    if not data_path.exists():
        return []
    data = json.loads(data_path.read_text(encoding="utf-8"))
    records = data["records"] if isinstance(data, dict) else data
    _fresh, stale, unparseable, missing = rsc.collect_stale(records)
    errors = []
    for r, age_days in stale:
        errors.append(
            f"[BADGE][reinstatement/{r['id']}] {r.get('state')} -- last_verified={r['last_verified']} is {age_days}d old, "
            f"past the {rsc.STALENESS_THRESHOLD_DAYS}-day bar the public 'Last verified {r['last_verified']}' badge "
            f"asserts -- re-verify and bump last_verified before shipping"
        )
    for r in unparseable:
        errors.append(f"[BADGE][reinstatement/{r['id']}] {r.get('state')} -- last_verified={r.get('last_verified')!r} is unparseable -- treat as stale")
    for r in missing:
        errors.append(f"[BADGE][reinstatement/{r['id']}] {r.get('state')} -- last_verified is missing entirely -- treat as stale")
    return errors


def check_competitor_price_currency(repo_root: Path) -> list[str]:
    """Roadmap #336 (2026-08-11, the real cost calculator): Devin's own
    condition before shipping a calculator that names real competitor
    prices was a price-recheck cadence commitment, not just a one-time
    check -- "90 days it is." Same promote-to-hard-gate shape as
    check_deadline_currency() above: a competitor's published price can
    change at any time, and nothing else re-derives verified_date, so a
    stale figure would otherwise sit silently on /compare/ and its per-
    competitor pages forever. /compare/ and /cost-calculator/ (the two
    surfaces that ever rendered this data) were both removed 2026-08-12
    (roadmap #336, #33) -- AuditLab's GATE-3 finding caught this docstring
    still claiming a live surface after the removal. Auto-skips while
    docs/compare/ doesn't exist so this can't silently block unrelated
    ships over data nothing renders; reinstating the /compare/ write-out
    loop in generate.py re-arms the check automatically, no manual flip
    needed. Small, self-contained dataset (4 records total) -- inlined
    directly rather than a separate staleness-check module, matching
    check_deadline_currency()'s own simpler shape rather than the bigger
    datasets' import-a-script indirection (those also serve a standalone
    advisory script; this one doesn't need one yet)."""
    data_path = repo_root / "data" / "competitor_prices.json"
    if not data_path.exists():
        return []
    if not (repo_root / "docs" / "compare").exists():
        return []
    data = json.loads(data_path.read_text(encoding="utf-8"))
    threshold_days = data.get("_meta", {}).get("staleness_threshold_days", 90)
    today = date.today()
    errors = []
    records = list(data.get("records", []))
    if data.get("mycpe_one"):
        records.append(data["mycpe_one"])
    for r in records:
        vd = r.get("verified_date")
        if not vd:
            errors.append(f"[PRICE][{r.get('slug')}] {r.get('name')} -- verified_date is missing entirely -- treat as stale")
            continue
        try:
            age_days = (today - date.fromisoformat(vd)).days
        except ValueError:
            errors.append(f"[PRICE][{r.get('slug')}] {r.get('name')} -- verified_date={vd!r} is unparseable -- treat as stale")
            continue
        if age_days > threshold_days:
            errors.append(
                f"[PRICE][{r.get('slug')}] {r.get('name')} -- verified_date={vd} is {age_days}d old, "
                f"past the {threshold_days}-day recheck cadence -- re-verify the published price against "
                f"the vendor's own pricing page and bump verified_date before shipping"
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


def check_sms_consent_version_sync(repo_root: Path) -> list[str]:
    """AuditLab DOC-1 report, SMS_CONSENT_VERSION advisory (2026-08-21,
    orchestrator-approved): sms.ts's SMS_CONSENT_VERSION is exported and
    read by nothing at runtime -- SMS-3's design deliberately records
    whatever version string the client sends rather than validating it
    server-side -- but its own docstring instructs a future maintainer to
    "bump this AND the matching string literal generate.py's /my/ SMS
    panel sends," two hand-kept copies with nothing enforcing they match.
    A drift here is a TCPA consent-artifact defect: the version recorded
    against a real consent would silently stop matching what the current
    UI actually presented at the moment of consent. Same
    hand-maintained-copy-decay shape check_terms_version_sync() already
    guards for TERMS_LAST_CHANGED/TERMS_VERSION, applied to this pair."""
    sms_ts = repo_root / "worker" / "src" / "sms.ts"
    generate_py = repo_root / "generate.py"
    if not sms_ts.exists():
        print("  (skipping sms-consent-version-sync check -- worker/ tree not present in this checkout)")
        return []
    ts_text = sms_ts.read_text(encoding="utf-8")
    py_text = generate_py.read_text(encoding="utf-8")

    ts_match = re.search(r'SMS_CONSENT_VERSION\s*=\s*"([^"]+)"', ts_text)
    if not ts_match:
        return ["[SMS-CONSENT] worker/src/sms.ts's SMS_CONSENT_VERSION constant not found -- can't verify sync with generate.py"]
    ts_version = ts_match.group(1)

    # GATE-9 (AuditLab, 2026-08-21, self-directed): consent_version is a
    # JSON PAYLOAD KEY, not a declaration -- unlike every other sync check
    # in this file (a language-enforced-unique constant declaration), a
    # second `consent_version: '...'` literal is a normal, expected shape
    # (a second consent panel, a variant signup flow, a re-send path each
    # naturally carrying their own), not a duplicate-definition error. The
    # original re.search() silently validated only the FIRST occurrence and
    # would let any later one drift unseen -- exactly the hand-maintained-
    # copy decay this gate exists to prevent, just one hop further in. Uses
    # findall() and requires EVERY occurrence to match, not just the first.
    py_versions = re.findall(r"consent_version:\s*'([^']+)'", py_text)
    if not py_versions:
        return ["[SMS-CONSENT] generate.py's consent_version literal (the /my/ SMS panel's consent send) not found -- can't verify sync with worker/src/sms.ts"]

    drifted = sorted({v for v in py_versions if v != ts_version})
    if drifted:
        return [
            f"[SMS-CONSENT] worker/src/sms.ts's SMS_CONSENT_VERSION ({ts_version}) and generate.py's "
            f"consent_version literal(s) ({', '.join(drifted)}) have drifted -- bump every copy "
            "together, at the same time the actual SMS consent wording changes"
        ]
    return []


def check_cpe_cycle_window_sync(repo_root: Path) -> list[str]:
    """AuditLab CPE-4 decay-gate advisory (2026-08-21, orchestrator-approved):
    the CPE-4 fix ported (not shared) the cycle-window scoping logic from
    the firm dashboard's drCpeProgressForSubscriber() into /my/'s own
    separate drCpeProgressFor() -- the pragmatic call, since the two pages
    are entirely separate generated scripts with no common module to
    import from. AuditLab verified the port was byte-identical the day it
    shipped, but flagged that two verbatim copies of a compliance
    calculation is exactly the precondition that produced CPE-4 in the
    first place: one number, two implementations, nothing making them
    agree if either is edited without the other. Same hand-maintained-copy
    decay shape as check_sms_consent_version_sync() above, narrowed here to
    just drCpeCycleWindow() -- the smallest unit whose divergence would
    silently reintroduce CPE-4's own overstatement defect -- rather than
    the whole progress function, most of which (carryover application,
    ethics-window handling, the pace-aware verdict /my/ deliberately omits)
    is expected to differ or already documented as a deliberate scope
    difference."""
    generate_py = repo_root / "generate.py"
    if not generate_py.exists():
        return ["[CPE-CYCLE-WINDOW] generate.py not found -- can't verify drCpeCycleWindow sync"]
    src = generate_py.read_text(encoding="utf-8")

    matches = list(re.finditer(r"function drCpeCycleWindow\([^)]*\)\s*\{", src))
    if len(matches) != 2:
        return [
            f"[CPE-CYCLE-WINDOW] expected exactly 2 copies of drCpeCycleWindow() in generate.py "
            f"(/my/'s own script and the firm dashboard's), found {len(matches)} -- either a copy "
            "was removed (fold the callers back onto a single shared definition, one is enough) or "
            "a third was added (this gate needs updating to cover it too)."
        ]

    bodies = []
    for m in matches:
        # Inline bracket match, not shared with the consent-gate check's
        # _bracket_match() below -- this one only ever runs twice per gate
        # invocation and keeping it self-contained avoids a forward
        # reference to a helper defined 1000+ lines later in this file.
        depth = 0
        end = None
        for i in range(m.end() - 1, len(src)):
            if src[i] == "{":
                depth += 1
            elif src[i] == "}":
                depth -= 1
                if depth == 0:
                    end = i
                    break
        if end is None:
            return ["[CPE-CYCLE-WINDOW] a drCpeCycleWindow() definition has unbalanced braces -- can't verify sync"]
        # Normalize whitespace: the two copies live at different nesting
        # depths (one inside /my/'s own IIFE, one at module level for the
        # firm dashboard), so leading indentation legitimately differs even
        # when the two are otherwise identical. Collapsing every run of
        # whitespace to a single space verifies LOGIC parity, not
        # incidental formatting.
        body = src[m.end() - 1 : end + 1]
        bodies.append(re.sub(r"\s+", " ", body).strip())

    if bodies[0] != bodies[1]:
        return [
            "[CPE-CYCLE-WINDOW] the two drCpeCycleWindow() copies in generate.py (/my/'s "
            "drCpeProgressFor() and the firm dashboard's drCpeProgressForSubscriber()) have "
            "diverged -- this is the exact precondition that produced CPE-4 (one cycle-window "
            "calculation, two implementations, nothing keeping them in sync). Keep them "
            "byte-identical (modulo indentation), or fold them into one shared definition."
        ]
    return []


def check_field_computed_states_sync(repo_root: Path) -> list[str]:
    """AuditLab SYNC-1 (MEDIUM, 2026-08-09): worker/src/deadline.ts's
    FIELD_COMPUTED_STATES and generate.py's _WORKER_FIELD_COMPUTED_STATES
    are the same set of states hand-duplicated across two languages -- and
    unlike TERMS_LAST_CHANGED/TERMS_VERSION above (which at least admit
    they're two copies), both comments here claimed the sets "can never
    drift out of sync", which was false: nothing enforced it. A drift
    breaks signup in BOTH directions for the affected state (the page
    renders one set of fields, the worker expects the other -- see
    generate.py's own docstring on _WORKER_FIELD_COMPUTED_STATES for the
    exact 400 each direction produces), and hits both public signup and
    the dashboard staff-add form. Same "parse both literals, diff them"
    shape as check_terms_version_sync() above -- this is the 5th instance
    of this hand-maintained-duplicate-list class in the codebase (after
    CRAWL-1/2, RETAIN-1, DEMO-4/5, SEC-1/2), and the first one that was
    actively documented as impossible, which is exactly why it survived a
    hand review."""
    generate_py = repo_root / "generate.py"
    deadline_ts = repo_root / "worker" / "src" / "deadline.ts"
    if not deadline_ts.exists():
        print("  (skipping field-computed-states-sync check -- worker/ tree not present in this checkout)")
        return []
    py_text = generate_py.read_text(encoding="utf-8")
    ts_text = deadline_ts.read_text(encoding="utf-8")

    py_match = re.search(r"_WORKER_FIELD_COMPUTED_STATES\s*=\s*\{([^}]*)\}", py_text)
    if not py_match:
        return ["[SYNC] generate.py's _WORKER_FIELD_COMPUTED_STATES literal not found -- can't verify sync with worker/src"]
    py_states = set(re.findall(r'"([a-z_]+)"', py_match.group(1)))

    ts_match = re.search(r"FIELD_COMPUTED_STATES\s*=\s*new Set\(\[([^\]]*)\]\)", ts_text)
    if not ts_match:
        return ["[SYNC] worker/src/deadline.ts's FIELD_COMPUTED_STATES literal not found -- can't verify sync with generate.py"]
    ts_states = set(re.findall(r'"([a-z_]+)"', ts_match.group(1)))

    if py_states != ts_states:
        only_py = sorted(py_states - ts_states)
        only_ts = sorted(ts_states - py_states)
        detail = []
        if only_py:
            detail.append(f"only in generate.py's _WORKER_FIELD_COMPUTED_STATES: {only_py}")
        if only_ts:
            detail.append(f"only in deadline.ts's FIELD_COMPUTED_STATES: {only_ts}")
        return [
            "[SYNC] generate.py's _WORKER_FIELD_COMPUTED_STATES and worker/src/deadline.ts's "
            "FIELD_COMPUTED_STATES have drifted (" + "; ".join(detail) + ") -- a state on only one "
            "side breaks signup, since the page and the worker disagree on which fields to show/"
            "require. Update both together."
        ]
    return []


def check_json_copies_identical(repo_root: Path) -> list[str]:
    # Roadmap #9/#319 (2026-08-08): reg_change_events.json added as a SECOND
    # data/ -> worker/src/ hand-synced pair, same "two copies, byte-identical"
    # convention cpa_deadlines.json already established -- same decay risk,
    # same guard, just a second file name.
    pairs = [
        (repo_root / "data" / "cpa_deadlines.json", repo_root / "worker" / "src" / "cpa_deadlines.json"),
        (repo_root / "data" / "reg_change_events.json", repo_root / "worker" / "src" / "reg_change_events.json"),
    ]
    errors = []
    for a, b in pairs:
        if not b.exists():
            # Scratch/partial checkouts (e.g. a data-only copy for render verification)
            # won't have the worker tree -- this check only makes sense against a full
            # repo checkout, so skip it rather than false-failing.
            print(f"  (skipping byte-identical check -- {b} not present in this checkout)")
            continue
        if a.read_bytes() != b.read_bytes():
            errors.append(f"[C] {a} and {b} are NOT byte-identical")
    return errors


SITE_BASE_URL_RE = re.compile(r'<loc>(https?://[^<]+)</loc>')


def check_sms_cron_hour_matches_wrangler(repo_root: Path) -> list[str]:
    """AuditLab SYNC-2 (2026-08-09, fixed 2026-08-13): worker/src/sms.ts's
    SMS_UNAVAILABLE_STATE_SLUGS used to be a hand-maintained literal that
    happened to be correct at the current "0 18 * * *" cron by only a
    two-hour margin on each side (AuditLab quantified the drift: a 2-hour
    earlier cron under-reports, silently letting Alaska/Hawaii subscribers
    opt into a channel that will never fire for them -- the exact harm
    SMS-1 exists to prevent). Fixed by computing the set from a named
    CRON_HOUR_UTC constant instead, but that constant is now its OWN
    hand-maintained duplicate of the real schedule in wrangler.toml/
    wrangler.preview.toml -- same class this function's siblings
    (check_terms_version_sync, check_field_computed_states_sync) already
    guard against. Asserts all three agree: CRON_HOUR_UTC, wrangler.toml's
    cron, and wrangler.preview.toml's cron."""
    sms_ts = repo_root / "worker" / "src" / "sms.ts"
    wrangler_toml = repo_root / "worker" / "wrangler.toml"
    wrangler_preview_toml = repo_root / "worker" / "wrangler.preview.toml"
    if not sms_ts.exists():
        print("  (skipping sms-cron-hour-sync check -- worker/ tree not present in this checkout)")
        return []

    ts_match = re.search(r"CRON_HOUR_UTC\s*=\s*(\d+)", sms_ts.read_text(encoding="utf-8"))
    if not ts_match:
        return ["[SYNC] worker/src/sms.ts's CRON_HOUR_UTC constant not found -- can't verify sync with the real cron schedule"]
    ts_hour = int(ts_match.group(1))

    errors = []
    for wrangler_path in (wrangler_toml, wrangler_preview_toml):
        if not wrangler_path.exists():
            errors.append(f"[SYNC] {wrangler_path.relative_to(repo_root)} not found -- can't verify sms.ts's CRON_HOUR_UTC against it")
            continue
        cron_match = re.search(r'crons\s*=\s*\[\s*"(\d+)\s+(\d+)\s+\*\s+\*\s+\*"\s*\]', wrangler_path.read_text(encoding="utf-8"))
        if not cron_match:
            errors.append(f"[SYNC] {wrangler_path.relative_to(repo_root)}'s daily cron expression not found in the expected 'M H * * *' shape")
            continue
        wrangler_hour = int(cron_match.group(2))
        if wrangler_hour != ts_hour:
            errors.append(
                f"[SYNC] worker/src/sms.ts's CRON_HOUR_UTC ({ts_hour}) does not match "
                f"{wrangler_path.relative_to(repo_root)}'s cron hour ({wrangler_hour}) -- "
                f"SMS_UNAVAILABLE_STATE_SLUGS would be computed against the WRONG cron time, "
                f"silently reintroducing the under-report risk SYNC-2 fixed. Update CRON_HOUR_UTC "
                f"to match the real schedule (or fix the schedule, if that's what changed)."
            )
    return errors


def check_pricing_matches_tiers(repo_root: Path) -> list[str]:
    """AuditLab PRICE-1 (2026-08-09, closed 2026-08-13): worker/src/tiers.ts's
    FIRM_TIERS is the source of truth for what a firm is actually charged and
    how many seats that buys; generate.py duplicates those numbers as literal
    marketing copy in roughly 20 places. All correct at filing time and still
    correct today, but nothing enforced it -- and a drifted price is worse
    than the other hand-maintained-duplicate classes this file already
    guards (terms version, computed-field states, the SMS cron hour):
    it's advertised to every visitor on /pricing/ while Stripe bills
    something else, silently.

    Deliberately scoped to the two most structurally-identifiable,
    highest-stakes surfaces rather than a blind whole-file '$NNN' sweep --
    generate.py legitimately contains other dollar amounts that are NOT
    DeadlineRadar's own pricing (state-board late/reinstatement fees baked
    into the CPA-deadline dataset, a folded-away $39/year individual tier
    mentioned only in a docstring) and a blind sweep would false-positive on
    every one of them. Both surfaces checked here carry a `data-tier`
    attribute that maps directly to a FIRM_TIERS entry, so there's no
    ordering assumption to get wrong: the /pricing/ page's 4 price cards,
    and the in-app paywall modal's upgrade buttons."""
    tiers_ts = repo_root / "worker" / "src" / "tiers.ts"
    generate_py = repo_root / "generate.py"
    if not tiers_ts.exists():
        print("  (skipping pricing-matches-tiers check -- worker/ tree not present in this checkout)")
        return []

    ts_text = tiers_ts.read_text(encoding="utf-8")
    tiers_match = re.search(r"FIRM_TIERS[^=]*=\s*\[(.*?)\n\];", ts_text, re.DOTALL)
    if not tiers_match:
        return ["[SYNC] worker/src/tiers.ts's FIRM_TIERS literal not found -- can't verify generate.py's pricing copy against it"]
    tier_rows = re.findall(r'planTier:\s*"([a-z_]+)".*?priceUsd:\s*(\d+).*?seatCap:\s*(\d+)', tiers_match.group(1))
    if not tier_rows:
        return ["[SYNC] Could not parse individual tier entries out of worker/src/tiers.ts's FIRM_TIERS"]
    by_plan_tier = {pt: {"priceUsd": int(price), "seatCap": int(cap)} for pt, price, cap in tier_rows}

    py_text = generate_py.read_text(encoding="utf-8")
    errors = []

    button_rows = re.findall(
        r'data-tier="([a-z_]+)" data-seat-cap="(\d+)"[^>]*>[^<]*<br><span>\$(\d+)/year &middot; up to (\d+) staff</span>',
        py_text,
    )
    if not button_rows:
        errors.append("[SYNC] Could not find the in-app paywall modal's tier buttons in generate.py -- markup shape may have changed; update check_pricing_matches_tiers()")
    for plan_tier, seat_cap_attr, price_str, up_to_str in button_rows:
        tier = by_plan_tier.get(plan_tier)
        if tier is None:
            errors.append(f'[SYNC] generate.py\'s paywall modal references data-tier="{plan_tier}", which is not in worker/src/tiers.ts\'s FIRM_TIERS')
            continue
        if int(price_str) != tier["priceUsd"] or int(seat_cap_attr) != tier["seatCap"] or int(up_to_str) != tier["seatCap"]:
            errors.append(
                f'[SYNC] generate.py\'s paywall modal button for "{plan_tier}" shows ${price_str}/year, '
                f"data-seat-cap={seat_cap_attr}, \"up to {up_to_str} staff\", but worker/src/tiers.ts's "
                f"FIRM_TIERS says ${tier['priceUsd']}/year, {tier['seatCap']} seats -- a customer would see "
                f"a different price/cap than what the seat-cap gate actually enforces."
            )

    # P5/i18n Phase A (2026-08-20): the "Up to N staff." detail line moved
    # behind _t("pricing.staff_up_to", lang, n=N) so it can render in
    # Spanish too -- the literal English text no longer appears in
    # generate.py's SOURCE (this check reads the .py file directly, not
    # rendered HTML), so the old regex silently stopped matching anything.
    # Matches the templated call instead and still extracts n= as the seat
    # cap, same semantic check as before.
    card_rows = re.findall(
        r'<div class="pricing-card" id="[a-z]+">\s*<h2>[^<]*</h2>\s*<p class="price">\$(\d+)<span>/year</span></p>\s*'
        r'<p class="detail">\{_t\("pricing\.staff_up_to", lang, n=(\d+)\)\}</p>.*?data-tier="([a-z_]+)"',
        py_text,
        re.DOTALL,
    )
    if not card_rows:
        errors.append("[SYNC] Could not find /pricing/ page's price cards in generate.py -- markup shape may have changed; update check_pricing_matches_tiers()")
    for price_str, seat_cap_str, plan_tier in card_rows:
        tier = by_plan_tier.get(plan_tier)
        if tier is None:
            errors.append(f'[SYNC] generate.py\'s /pricing/ page has a card with data-tier="{plan_tier}", which is not in worker/src/tiers.ts\'s FIRM_TIERS')
            continue
        if int(price_str) != tier["priceUsd"] or int(seat_cap_str) != tier["seatCap"]:
            errors.append(
                f'[SYNC] generate.py\'s /pricing/ page shows a ${price_str}/year, up-to-{seat_cap_str}-staff '
                f'card for "{plan_tier}", but worker/src/tiers.ts\'s FIRM_TIERS says '
                f"${tier['priceUsd']}/year, {tier['seatCap']} seats for it -- the pricing page and the "
                f"actual seat-cap gate/checkout would disagree."
            )
    return errors


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


def _blank_strings_and_comments(text: str) -> str:
    """AuditLab GUARD-1 (2026-08-20): the original `_strip_ts_comments()`
    doesn't understand string literals, so a `/*`/`*/`/`//`-shaped sequence
    INSIDE a string confuses it two ways -- a live comment-shaped iCalendar
    PRODID ('PRODID:-//Deadline-Radar//...', real code already in
    worker/src/ics.ts) can truncate a real check off the end of a `//`
    match (false alarm on correct code), and a string literal containing
    both `/*` and `*/` (e.g. two separate `const pattern = "/*"` / `const
    closer = "*/"` string constants) can make the block-comment regex
    swallow everything between them -- including a real sendViaSendGrid()
    call -- making the whole function INVISIBLE to a guard, worse than a
    false pass since nothing hints anything was skipped. Also closes
    GUARD-1's case E: a bare identifier like `demo_locked` mentioned inside
    an ordinary string ("demo_locked handled upstream") read as a real code
    reference to a substring search.

    The first version of this fix ran string-blanking and comment-stripping
    as two SEPARATE sequential passes (string-blank, then the existing
    `_strip_ts_comments`) -- and that was itself broken by the identical
    class of bug it was fixing: a `//` comment containing an apostrophe
    ("...became demo_locked and confirm it after, same 'don't trust an
    earlier gate alone' posture...", real prose already in
    worker/src/index.ts) was misread as OPENING a string literal by the
    string-blanking pass, which then ran to the NEXT apostrophe anywhere
    later in the file, silently swallowing the real `if (firm.demo_locked)`
    check that comment sits directly above. Caught by testing this fix
    against the live codebase before shipping, not by the fix's own design
    -- proof that two passes over an ambiguous grammar (comments can
    contain quote characters, strings can contain comment-opener
    characters) can't be ordered correctly no matter which runs first.

    This function is the corrected single-pass tokenizer: walks the text
    once, character by character, and handles whichever construct -- a
    string/template literal or a `//`/`/* */` comment -- actually opens at
    the current position, so the other's delimiter characters occurring
    INSIDE it are never misinterpreted. String/template contents are
    blanked (space-for-char, newlines kept); comments are removed entirely
    (newlines kept for block comments so line-based reporting elsewhere
    stays accurate). Not a real tokenizer -- template literal `${...}`
    interpolations are blanked along with the rest of the template rather
    than parsed, which is conservative (a real code reference inside one is
    missed, never fabricated)."""
    out = []
    i = 0
    n = len(text)
    while i < n:
        c = text[i]
        if c in ("'", '"', "`"):
            quote = c
            out.append(" ")
            i += 1
            while i < n:
                c2 = text[i]
                if c2 == "\\" and i + 1 < n:
                    out.append("  ")
                    i += 2
                    continue
                if c2 == quote:
                    out.append(" ")
                    i += 1
                    break
                out.append(c2 if c2 == "\n" else " ")
                i += 1
            continue
        if c == "/" and i + 1 < n and text[i + 1] == "/":
            i += 2
            while i < n and text[i] != "\n":
                i += 1
            continue
        if c == "/" and i + 1 < n and text[i + 1] == "*":
            i += 2
            while i < n and not (text[i] == "*" and i + 1 < n and text[i + 1] == "/"):
                out.append("\n" if text[i] == "\n" else "")
                i += 1
            i += 2
            continue
        out.append(c)
        i += 1
    return "".join(out)


def _condition_is_constant_false(cond: str) -> bool:
    """True if an `if(...)` condition string is a literal-false short-circuit
    (`false`, `false && x`, `x && false`, `!true`, `!1`) rather than a real
    comparison (`x === false`, `x !== false`) -- the latter is legitimate
    code that happens to compare against the boolean literal and must not
    be treated as dead. Strips `===`/`!==`/`==`/`!=` comparisons against
    `false` first, then checks whether a bare `false`/`!true`/`!1` remains.

    AuditLab GUARD-1 follow-up (2026-08-20, adversarial mutation testing
    against the shipped fix): `!true` and `!1` are the same constant-false
    short-circuit as `false`/`0`, one negation away, and weren't
    recognised -- `if (!true) { if (firm.demo_locked) return; }` and
    `if (!true) { checkRateLimit(...) }` both still passed. Confirmed
    real code uses bare negated variables (`!allowed`) legitimately, so
    only the LITERAL `!true`/`!1` forms are treated as dead, never a
    negated identifier."""
    stripped = re.sub(r"[=!]==?\s*false\b", "", cond)
    stripped = re.sub(r"\bfalse\s*[=!]==?", "", stripped)
    if re.search(r"\bfalse\b", stripped):
        return True
    if re.search(r"(?<![\w.])0(?![\w.])\s*(&&|$)", cond.strip()):
        return True
    if re.search(r"(?<![!\w])!\s*true\b", cond):
        return True
    if re.search(r"(?<![!\w])!\s*1\b(?!\d)", cond):
        return True
    return False


def _find_if_conditions(text: str) -> list[tuple[str, int, int]]:
    """Yields (condition_text, if_keyword_start, index_just_past_the_close_paren)
    for every `if (...)` in text, using balanced-paren matching -- NOT the
    naive `if\\s*\\(([^)]*)\\)` regex every caller in this file used to use,
    which stops at the FIRST `)` and mis-extracts as soon as the condition
    contains a nested call.

    AuditLab GUARD-1 follow-up (2026-08-20, adversarial mutation testing):
    demonstrated `if (ok(a, b) && firm.demo_locked)` -- the naive regex
    captures only `ok(a, b`, so the real `demo_locked` flag falls OUTSIDE
    the captured condition and correctly-guarded code gets flagged as a
    violation. Not firing today against the live tree, but it silently
    constrains how a future guard may legally be written (a function call
    before the flag in the same condition breaks the gate on working
    code) -- exactly the kind of false-positive that makes a gate get
    disabled or ignored, which is its own path back to GUARD-1's original
    problem."""
    results = []
    n = len(text)
    for m in re.finditer(r"if\s*\(", text):
        start = m.end() - 1
        depth = 0
        i = start
        while i < n:
            if text[i] == "(":
                depth += 1
            elif text[i] == ")":
                depth -= 1
                if depth == 0:
                    break
            i += 1
        if i >= n:
            continue
        results.append((text[start + 1 : i], m.start(), i + 1))
    return results


def _strip_dead_if_false_blocks(text: str) -> str:
    """AuditLab GUARD-1 (2026-08-20): a guard's own invariant check can be
    neutralised by wrapping it in dead code -- `if (false) { if
    (firm.demo_locked) return; }` -- and a bare substring search still
    finds the token, passing clean with the real call left fully live.
    Balanced-brace-walks every `if (<condition>) { ... }` block whose
    condition contains a literal `false` (or a bare `0` ANDed in / alone),
    and blanks that block's contents (newlines kept, so line-based error
    reporting elsewhere stays accurate) before any caller searches the body
    for a token -- so a check buried inside dead code no longer counts as
    real coverage. Deliberately narrow (constant-false conditions only, not
    general dead-code elimination): this is the exact shape demonstrated
    live, and a full control-flow solver is the "full TS parsing is
    overkill" AuditLab itself ruled out."""
    out = []
    i = 0
    n = len(text)
    if_re = re.compile(r"if\s*\(")
    while i < n:
        m = if_re.search(text, i)
        if not m:
            out.append(text[i:])
            break
        cond_start = m.end() - 1
        depth = 0
        k = cond_start
        while k < n:
            if text[k] == "(":
                depth += 1
            elif text[k] == ")":
                depth -= 1
                if depth == 0:
                    break
            k += 1
        if k >= n:
            out.append(text[i:])
            break
        cond = text[cond_start + 1 : k]
        after_paren = k + 1
        brace_m = re.match(r"\s*\{", text[after_paren:])
        if not brace_m:
            # Bodyless `if (cond) statement;` -- not this function's shape
            # (it only blanks braced blocks); leave it for the caller's own
            # condition-level check via _find_if_conditions() instead.
            out.append(text[i:after_paren])
            i = after_paren
            continue
        is_dead = _condition_is_constant_false(cond)
        brace_start = after_paren + brace_m.end() - 1
        depth = 0
        j = brace_start
        while j < n:
            if text[j] == "{":
                depth += 1
            elif text[j] == "}":
                depth -= 1
                if depth == 0:
                    break
            j += 1
        block_end = j + 1 if j < n else n
        if is_dead:
            out.append(text[i : m.start()])
            dead_slice = text[m.start() : block_end]
            out.append(re.sub(r"[^\n]", " ", dead_slice))
        else:
            out.append(text[i:block_end])
        i = block_end
    return "".join(out)


def _strip_ts_comments(text: str) -> str:
    """Best-effort TS/JS comment stripper for the source-scanning guards in
    this file -- NOT a real parser, but catches the real failure mode a
    positive-control mutation test on check_write_endpoint_rate_limits()
    surfaced 2026-08-07: a naive `"checkRateLimit(" in body` substring
    search is fooled by a COMMENT that mentions the function by name in
    prose (e.g. "...see RATE_LIMIT_X's own comment for why
    checkRateLimit()'s `ip` parameter is deliberately reused..." reads as
    a real call to a substring search) -- the guard passed clean with the
    actual call deleted, exactly the "guard exists vs guard fires" gap
    this whole file exists to prevent. Block comments stripped first, then
    `//` line comments -- `(?<!:)` avoids treating a `://` inside a URL
    string as a comment opener.

    AuditLab GUARD-1 (2026-08-20): this function doesn't understand string
    literals, and -- proven the hard way -- can't be safely composed with a
    separate string-blanking pass in either order (each mis-tokenizes the
    other's delimiter characters when they appear inside its own construct:
    a `//` comment containing an apostrophe, a string containing `//`/`/*`).
    Superseded by `_blank_strings_and_comments()`, a single-pass tokenizer
    that handles both correctly together. Left standalone (not deleted) only
    because some future caller might genuinely want comment-stripped-but-
    string-intact text; every guard in this file that gates a real security
    or billing invariant should use `_blank_strings_and_comments()`, not
    this function alone."""
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
        "notifyOperatorOfStaleData": "AuditLab STALE-3 -- sends to the hardcoded INTERNAL_NOTIFY_EMAIL operator address, same category as sendSignupNotification above; also structurally not firm-scoped at all (fires from scheduled(), not a firm's own session)",
        "issueAndSendFirmLoginLink": "sends only to a firm's OWN admin_email -- callers pass either the just-typed signup email (self-referential, same category as handleSubscribe) or the email of an ALREADY-EXISTING firm looked up by store.findFirmByAdminEmail(), never an arbitrary third party",
        "issueAndSendFirmMemberInviteEmail": "recipient IS admin-suppliable (any address a Partner/Office Manager wants to invite), but handleFirmMemberInvite() 403s the WHOLE request for a demo_locked firm before this is ever called -- same front-door posture as handleFirmPasswordSet/handleFirmChangeEmailRequest/handleFirmAccountDelete above, not a per-send check",
        "issueAndSendSubscriberLoginLink": "free-tier individual magic-link sign-in -- public, anonymous, no firm session exists at all (same category as handleSubscribe); demo_locked is a firm-scoped property and doesn't apply here",
        "handleSubscriberChangeEmailRequest": "roadmap #12 subscriber self-service email change -- subscriber_sessions has no firm_id/demo_locked concept at all (migration 0012's own docstring: an individual principal must never be resolvable to a firm), and both sends go to addresses the subscriber's OWN request supplies for their OWN account, same category as handleFirmChangeEmailRequest's already-demo_locked-gated pattern but for a principal type demo_locked was never defined for",
        "runDripCoursePass": "roadmap #34 drip course cron -- targets ONLY confirmed free-tier (firm_id IS NULL) subscribers by construction (store.findEligibleDripCourseLeads()'s own query), so recipients have no firm association at all; demo_locked is a firm-scoped property and structurally cannot apply, same category as issueAndSendSubscriberLoginLink/handleSubscriberChangeEmailRequest above",
        "handleNewsletterSubscribe": "roadmap #124 compliance-news newsletter -- public /newsletter/subscribe form, own newsletter_subscribers table with no firm_id/demo_locked column at all (migration 0066), same category as handleSubscribe above (anonymous signup, no firm session exists)",
        "runComplianceNewsletterPass": "roadmap #124 -- targets ONLY store.listConfirmedNewsletterSubscribers(), a table with no firm association at all (migration 0066), same category as runDripCoursePass above; demo_locked is a firm-scoped property and structurally cannot apply",
    }

    errors = []
    found_names = set()
    for ts_file in sorted(worker_src.glob("*.ts")):
        text = ts_file.read_text(encoding="utf-8")
        for name, raw_body in _balanced_brace_function_bodies(text, r"\w+"):
            found_names.add(name)
            # GUARD-1 (AuditLab, 2026-08-20): single-pass string/comment
            # tokenizer first (a separate string-blank-then-comment-strip
            # pipeline mis-tokenizes each other's delimiters -- see that
            # function's docstring), then strip dead `if (false...)` blocks
            # so a demo_locked check nested inside unreachable code doesn't
            # count as coverage.
            body = _blank_strings_and_comments(raw_body)
            body = _strip_dead_if_false_blocks(body)
            if "sendViaSendGrid(" not in body:
                continue
            # Require demo_locked in a LIVE if() condition, not merely
            # present in the body -- closes `if (false && firm.demo_locked)`,
            # which has no enclosing braces for _strip_dead_if_false_blocks
            # to catch, and is otherwise indistinguishable from a real guard
            # to a bare substring search. Balanced-paren extraction (not a
            # naive `[^)]*` regex, which mis-truncates on a nested call --
            # see _find_if_conditions()'s docstring, GUARD-1 follow-up).
            guarded = any(
                "demo_locked" in cond and not _condition_is_constant_false(cond)
                for cond, _, _ in _find_if_conditions(body)
            )
            if guarded:
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

    # GATE-7 (AuditLab, 2026-08-21, LOW, self-directed): the original
    # `\n\);` closer only matched a CREATE TABLE whose closing paren is the
    # first thing on its own line -- a one-line or indented-`);` table
    # definition parsed as zero firm_id tables, silently. Relaxed to
    # `\)\s*;` (still safe against a CHECK(...)'s own inner closing paren,
    # since that is followed by more of the table body, not immediately by
    # `;`). Also now scans `ALTER TABLE <t> ADD [COLUMN] firm_id` -- not
    # hypothetical here: subscribers gains firm_id exactly this way in
    # 0008_firm_accounts.sql, and the original regex could not see it at
    # all. Zero effect on today's result (subscribers is already in
    # deliberately_excluded below) -- this closes the blind spot in the
    # exact decay path the gate exists to catch, before a future table
    # ever needs it.
    table_block_re = re.compile(r"CREATE TABLE(?:\s+IF NOT EXISTS)?\s+(\w+)\s*\(([\s\S]*?)\)\s*;")
    alter_firm_id_re = re.compile(r"ALTER TABLE\s+(\w+)\s+ADD\s+(?:COLUMN\s+)?firm_id\b")
    # RETAIN-2 (AuditLab, 2026-08-21, orchestrator-approved, HIGH): a THIRD
    # blind-spot class, on top of GATE-7's ALTER/one-line ones -- a table
    # with no firm_id of its own but a FK column into a table that IS
    # (transitively) firm-scoped is exactly as unpurged-forever as one with
    # a bare, unlisted firm_id. Found via 4 real tables (Slack/Teams/SMS/
    # admin-digest notification dedup) that reference subscribers(id), one
    # hop from firms. Any `<col> ... REFERENCES <parent>(` anywhere in a
    # table body or an ALTER ADD COLUMN is an edge in the same graph.
    references_re = re.compile(r"\w+\s+[^,\n]*?REFERENCES\s+(\w+)\s*\(")
    alter_references_re = re.compile(r"ALTER TABLE\s+(\w+)\s+ADD\s+(?:COLUMN\s+)?\w+[^;]*?REFERENCES\s+(\w+)\s*\(")
    in_migrations: set[str] = set()
    ref_edges: dict[str, set[str]] = {}
    for sql_file in sorted(migrations_dir.glob("*.sql")):
        text = sql_file.read_text(encoding="utf-8")
        for name, body in table_block_re.findall(text):
            if re.search(r"\bfirm_id\b", body):
                in_migrations.add(name)
            for parent in references_re.findall(body):
                ref_edges.setdefault(name, set()).add(parent)
        for name in alter_firm_id_re.findall(text):
            in_migrations.add(name)
        for table, parent in alter_references_re.findall(text):
            ref_edges.setdefault(table, set()).add(parent)

    store_src = store_ts.read_text(encoding="utf-8")
    m = re.search(r"FIRM_SCOPED_TABLES\s*=\s*\[([\s\S]*?)\]", store_src)
    if not m:
        return ["[RETAIN] store.ts's FIRM_SCOPED_TABLES array not found -- hardDeleteExpiredFirms()'s table list can't be verified"]
    covered = set(re.findall(r'"(\w+)"', m.group(1)))

    def _no_firm_id_registry(const_name: str) -> set[str]:
        rm = re.search(rf"{const_name}\s*=\s*\[([\s\S]*?)\]", store_src)
        return set(re.findall(r'"(\w+)"', rm.group(1))) if rm else set()

    subscriber_scoped_covered = _no_firm_id_registry("SUBSCRIBER_SCOPED_NO_FIRM_ID_TABLES")
    member_scoped_covered = _no_firm_id_registry("FIRM_MEMBER_SCOPED_NO_FIRM_ID_TABLES")
    no_firm_id_covered = subscriber_scoped_covered | member_scoped_covered

    missing = sorted(in_migrations - covered - deliberately_excluded)
    stale = sorted(covered - in_migrations)

    # Anchors: tables whose rows are known to be purged (or, for
    # `subscribers` itself, deliberately handled by a dedicated DELETE)
    # when a firm is hard-deleted. NOT the full deliberately_excluded set --
    # stripe_webhook_events is deliberately KEPT, so something referencing
    # it is not thereby "covered" the way referencing subscribers is.
    anchors = {"firms", "subscribers"} | covered | no_firm_id_covered

    def _descends_from_firms(table: str, seen: set[str]) -> bool:
        if table in seen:
            return False  # cycle guard
        seen.add(table)
        for parent in ref_edges.get(table, ()):
            if parent in anchors:
                return True
            if _descends_from_firms(parent, seen):
                return True
        return False

    transitive_gap = sorted(
        table
        for table in ref_edges
        if table not in anchors
        and table not in in_migrations  # already has its own firm_id -- covered by missing/stale above
        and _descends_from_firms(table, set())
    )

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
    if transitive_gap:
        errors.append(
            "[RETAIN] table(s) with no firm_id of their own, but transitively reachable from firms via "
            "a foreign key, and not covered by SUBSCRIBER_SCOPED_NO_FIRM_ID_TABLES or "
            f"FIRM_MEMBER_SCOPED_NO_FIRM_ID_TABLES -- a deleted firm's rows here survive forever: {', '.join(transitive_gap)}"
        )
    return errors


# GATE-8 (AuditLab, 2026-08-21, LOW, self-directed): the original pattern
# only matched backtick-delimited SQL literals. This codebase also writes
# SQL as `.prepare("...")` with double quotes (stop(), confirmIfPending(),
# updateFirmMemberRole() among others) -- zero exposure today (both real
# cycle-bump statements happen to use backticks), but the same blind spot
# GATE-7 closed for the retention-coverage gate's own CREATE TABLE parser.
# Widened to match either delimiter.
_CYCLE_BUMP_SQL_RE = re.compile(
    r"`([^`]*?cycle\s*=\s*cycle\s*\+\s*1[^`]*?)`" r'|"([^"]*?cycle\s*=\s*cycle\s*\+\s*1[^"]*?)"', re.DOTALL
)


def check_snoozed_until_cleared_on_cycle_bump(repo_root: Path) -> list[str]:
    """AuditLab SNOOZE-1 (MEDIUM, 2026-08-21, orchestrator-approved defense-
    in-depth, self-directed as a static gate rather than a runtime schema
    change): migration 0040's own invariant is that a snooze from the PRIOR
    cycle must never suppress the NEW cycle's reminders, so every UPDATE
    that bumps `cycle` must also clear `snoozed_until` in the same
    statement -- exactly the one line rearm() omitted while its twin
    applyRenewAndRearm() had it. subscribers has no column recording which
    cycle a snooze was set during, so a genuinely cycle-aware RUNTIME check
    in scheduler.ts would need a migration; this instead closes the same
    gap at the source that actually decays -- a future cycle-bumping
    UPDATE that forgets the one line -- the same shape check_retention_coverage()
    above uses for a different invariant. Source-scanned (every backtick-
    OR double-quote-delimited SQL literal containing `cycle = cycle + 1`
    -- GATE-8, AuditLab, 2026-08-21: the original backtick-only pattern
    missed this codebase's double-quoted `.prepare("...")` calls, zero
    exposure today since both real cycle-bump statements use backticks,
    but the same blind spot GATE-7 closed for the retention gate), not
    imported, same pattern every sibling guard in this file uses."""
    store_ts = repo_root / "worker" / "src" / "store.ts"
    if not store_ts.exists():
        print("  (skipping snoozed-until-on-cycle-bump check -- worker/ tree not present in this checkout)")
        return []
    text = store_ts.read_text(encoding="utf-8")
    errors = []
    for i, (backtick_sql, dquote_sql) in enumerate(_CYCLE_BUMP_SQL_RE.findall(text), start=1):
        sql = backtick_sql or dquote_sql
        if "snoozed_until" not in sql:
            snippet = " ".join(sql.split())[:100]
            errors.append(
                f"[SNOOZE] a cycle-bumping UPDATE in store.ts (occurrence {i}: \"{snippet}...\") does not "
                "also clear snoozed_until in the same statement -- a snooze from the prior cycle would "
                "silently suppress reminders in the new one, contradicting migration 0040's own stated "
                "invariant. Add `snoozed_until = NULL` to this UPDATE's SET clause."
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
        # GUARD-1 (AuditLab, 2026-08-20): same hardening as
        # check_demo_locked_email_coverage -- single-pass tokenizer, then
        # strip dead if(false) blocks, before the substring search.
        body = _blank_strings_and_comments(body)
        body = _strip_dead_if_false_blocks(body)
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
        "handleSmsInbound": "Twilio-signed (verified via X-Twilio-Signature, isValidTwilioSignature()) "
        "server-to-server callback, same category as handleStripeWebhook above -- rate-limiting it "
        "risks dropping a legitimate burst of real inbound STOP replies, and the signature check is "
        "the real access control here, not a counter",
        "handleEmailEventsWebhook": "SendGrid-signed (verified via X-Twilio-Email-Event-Webhook-Signature, "
        "verifySendGridEventSignature()) server-to-server callback, same category as handleStripeWebhook/ "
        "handleSmsInbound above -- rate-limiting it risks dropping a legitimate burst of real bounce/ "
        "complaint events (batches can carry 1000+ events), and the signature check is the real access "
        "control here, not a counter",
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
        "handleDripCourseUnsubscribe": "consumes a drip-course enrollment's own unsubscribe token (store.stopDripCourseByToken) -- same one-click, no-login, token-is-the-credential shape as handleUnsubscribe",
        "handleFirmAdminUnsubscribe": "consumes a firm's own admin_unsubscribe_token (store.findFirmByAdminUnsubscribeToken, migration 0062, AuditLab UNSUB-2) -- same one-click, no-login, token-is-the-credential shape as handleUnsubscribe, RFC 8058 List-Unsubscribe-Post requires this to work without a session",
        "handleFeatureIdeaSignupUnsubscribe": "consumes a feature-idea signup row's own id-as-token (store.optOutFeatureIdeaSignupByToken, migration 0065, AuditLab UNSUB-4) -- same one-click, no-login, token-is-the-credential shape as handleUnsubscribe, RFC 8058 List-Unsubscribe-Post requires this to work without a session",
    }

    errors = []
    found_names = set()
    for name, body in _balanced_brace_function_bodies(index_src, r"handle\w+"):
        found_names.add(name)
        # GUARD-1 (AuditLab, 2026-08-20): same hardening as the mutating_fns
        # scan above -- single-pass tokenizer, then strip dead if(false)
        # blocks, before the checkRateLimit( substring search, so a bypass
        # shaped like `if (false) { checkRateLimit(...) }` or a string
        # literal mentioning "checkRateLimit(" can't fool it. Deliberately
        # NOT requiring checkRateLimit( inside a live if()-condition the way
        # check_demo_locked_email_coverage does -- real usage here is
        # typically `const limited = await checkRateLimit(...); if
        # (limited) return 429;`, a statement followed by a separate
        # condition, not the call itself inside the if().
        body = _blank_strings_and_comments(body)
        body = _strip_dead_if_false_blocks(body)
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


def check_i18n_reviewed_entries_not_stale(repo_root: Path) -> list[str]:
    """i18n.py's t() already refuses to show an unreviewed or stale Spanish
    string at runtime (falls back to English) -- that's the primary
    protection. This is the data-integrity backstop: if an ES entry is
    marked reviewed=True but its stored en_hash does NOT match the
    CURRENT hash of the English string it claims to translate, something
    is wrong (a hand-edit set reviewed=True without actually re-approving
    the new English text, or the hash was computed against stale EN).
    That combination is exactly the "not self-certified" invariant this
    whole i18n system exists to enforce -- fail loud rather than let a
    reviewed-but-actually-stale translation quietly ship."""
    sys.path.insert(0, str(repo_root))
    try:
        import i18n
    except ImportError:
        return []
    errors = []
    for key, entry in i18n.ES.items():
        if key not in i18n.EN:
            errors.append(f"[I18N] i18n.py ES has a translation for {key!r}, which no longer exists in EN -- remove the stale entry")
            continue
        if entry.get("reviewed") and entry.get("en_hash") != i18n.en_hash(key):
            errors.append(
                f"[I18N] i18n.py ES[{key!r}] is marked reviewed=True but its en_hash doesn't match "
                f"the current English text -- either the English changed after review (needs a fresh "
                f"draft + re-review, not reviewed=True carried over) or the hash was set wrong. "
                f"A reviewed=True entry must always be provably translated FROM the current EN string."
            )
    return errors


def check_email_link_helper_usage(repo_root: Path) -> list[str]:
    """AuditLab EMAIL-2 (LOW-MED, filed 2026-08-08, widened 2026-08-12): dark
    mode recolors links by CSS class (.dr-accent/.dr-btn), not by attribute --
    a hand-rolled `<a style="color:...">` with no dr- class keeps its light-
    mode color on a dark card (2.72:1 measured, vs 7.54:1 through
    textLink()). The finding's own root-cause note: half the 6 instances
    were introduced by a LATER commit (7d6ca102, the UNSUB-2 fix) that had
    nothing stopping it from hand-rolling a new link. This is that stop.

    Flags any `<a href=...>` in emails.ts carrying an inline `style="color:`
    with no `class="dr-` in the same opening tag -- textLink()'s own
    definition is exempt because its two template-literal halves both
    contain `class="dr-accent"` before the `style="color:` half, same for
    button()'s `class="dr-btn"` (which never matches `style="color:` at all
    -- its style starts `display:inline-block;background:...`). The shell
    logo link is exempt too: its style is `text-decoration:none`, no color."""
    emails_ts = repo_root / "worker" / "src" / "emails.ts"
    if not emails_ts.exists():
        print("  (skipping email-link-helper check -- worker/ tree not present in this checkout)")
        return []
    src = emails_ts.read_text(encoding="utf-8")
    errors = []
    for m in re.finditer(r'<a\s+href="[^"]*"([^>]*)>', src):
        attrs = m.group(1)
        if 'style="color:' in attrs and 'class="dr-' not in attrs:
            line_no = src.count("\n", 0, m.start()) + 1
            errors.append(
                f"[EMAIL-LINK] emails.ts:{line_no} -- hand-rolled <a> with an inline color and no "
                f"dr- class; dark mode will not recolor it (EMAIL-2 class). Use textLink()/button() "
                f"instead of a raw anchor tag."
            )
    return errors


# Orchestrator consent-gate directive (Devin, 2026-08-21, filed during the
# DEAD-2 investigation): "NOTHING is sent without my consent." Any NEW send
# pass wired into scheduled() going forward must call
# requireSendApproval(env, "<name>") (scheduler.ts) at its own entry point.
# These 8 are the passes dispatched BEFORE that directive existed and are
# explicitly NOT required to retrofit it -- the directive's own scope was
# going-forward only, not a sweep of every existing send. Do NOT add a name
# here to make a new pass pass this gate; grandfathering is for history,
# not for skipping the actual requirement on new work.
GRANDFATHERED_PRE_CONSENT_GATE_PASSES = {
    "runReminderPass",
    "runDripCoursePass",
    "runRuleChangeAlertPass",
    "runDigestPass",
    "runSlackAlertPass",
    "runTeamsAlertPass",
    "runSmsAlertPass",
    "runComplianceNewsletterPass",
}


def _bracket_match(src: str, open_brace_index: int) -> int | None:
    """Returns the index of the `{` at open_brace_index's own matching `}`,
    or None if unbalanced. Shared by check_send_pass_consent_gate_coverage()
    below for both scheduled()'s body and each dispatched pass's body --
    same "no TypeScript toolchain" source-scan posture as every other
    gate in this file."""
    depth = 0
    for i in range(open_brace_index, len(src)):
        if src[i] == "{":
            depth += 1
        elif src[i] == "}":
            depth -= 1
            if depth == 0:
                return i
    return None


def check_send_pass_consent_gate_coverage(repo_root: Path) -> list[str]:
    """AuditLab advisory (2026-08-21, orchestrator-approved): the consent
    gate's fail-closed default (requireSendApproval()) is solid, but
    ADOPTION of it by a future pass #9 still depended on the author reading
    a comment and choosing to call it -- structurally the same "trust the
    prose" shape the whole directive exists to close, just moved up one
    level. Same in-house precedent as check_retention_coverage()'s
    FIRM_SCOPED_TABLES check: extract every run*Pass awaited inside
    scheduled() (worker/src/index.ts) and require each one to either call
    requireSendApproval() in its own body (scheduler.ts), or appear in the
    explicit GRANDFATHERED_PRE_CONSENT_GATE_PASSES list above. Converts
    "the next author will remember" into "the next author cannot forget."
    """
    index_ts = repo_root / "worker" / "src" / "index.ts"
    scheduler_ts = repo_root / "worker" / "src" / "scheduler.ts"
    # AuditLab observation (2026-08-21, orchestrator-approved, same class as
    # GATE-10): a missing worker/src/ file used to return [] here -- a
    # silent clean pass, unlike every OTHER guard clause in this function
    # (below), which fails closed with a real error. Matched to this
    # function's own posture rather than left as its one fail-open exit.
    if not index_ts.exists() or not scheduler_ts.exists():
        return ["[CONSENT-GATE] worker/src/index.ts or worker/src/scheduler.ts not found -- "
                "consent-gate coverage can't be verified and must be repaired."]

    index_src = index_ts.read_text(encoding="utf-8")
    sig_m = re.search(r"async scheduled\([^)]*\)[^{]*\{", index_src)
    if not sig_m:
        return ["[CONSENT-GATE] worker/src/index.ts's scheduled() handler not found -- "
                "consent-gate coverage can't be verified and must be repaired."]
    body_end = _bracket_match(index_src, sig_m.end() - 1)
    if body_end is None:
        return ["[CONSENT-GATE] scheduled()'s closing brace not found (unbalanced braces?) -- "
                "consent-gate coverage can't be verified and must be repaired."]
    scheduled_body = index_src[sig_m.end() - 1 : body_end]

    passes = sorted(set(re.findall(r"await\s+(run\w+Pass)\(env\b", scheduled_body)))
    if not passes:
        return ["[CONSENT-GATE] found NO run*Pass dispatches inside scheduled(). Either the cron "
                "dispatch changed shape or nothing is wired -- this check is measuring nothing and "
                "must be repaired."]

    scheduler_src = scheduler_ts.read_text(encoding="utf-8")
    errors = []
    for pass_name in passes:
        if pass_name in GRANDFATHERED_PRE_CONSENT_GATE_PASSES:
            continue
        fn_m = re.search(rf"export async function {re.escape(pass_name)}\([^)]*\)[^{{]*\{{", scheduler_src)
        if not fn_m:
            errors.append(
                f"[CONSENT-GATE] {pass_name} is dispatched in scheduled() but its definition was not "
                f"found in scheduler.ts as `export async function {pass_name}(...)` -- consent-gate "
                f"coverage can't be verified for it."
            )
            continue
        fn_end = _bracket_match(scheduler_src, fn_m.end() - 1)
        fn_body = scheduler_src[fn_m.end() - 1 : fn_end] if fn_end is not None else ""
        if "requireSendApproval(" not in fn_body:
            errors.append(
                f"[CONSENT-GATE] {pass_name} is dispatched in scheduled() but is neither in "
                f"GRANDFATHERED_PRE_CONSENT_GATE_PASSES nor calls requireSendApproval() in its own "
                f"body -- a new send pass must not go live without Devin's explicit consent-gate "
                f"sign-off (orchestrator directive, 2026-08-21)."
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


def print_silent_drop_advisory(repo_root: Path) -> None:
    """AuditLab DROP-1 (MEDIUM, 2026-08-21): silent_dropped_subscribers_check.py
    is the last mile of AuditLab's own SILENT-1 (2026-08-19) -- it detects
    subscribers receiving NO reminders at all, the exact failure mode
    neither the customer nor we can otherwise tell is happening -- but had
    no automated caller. Twelve sibling monitoring scripts are wired into
    this gate; this one wasn't, so an open silent_drop_log row was only
    ever found if a human remembered to run it manually with
    CLOUDFLARE_API_TOKEN set. Same wiring shape as
    print_worker_deploy_staleness_advisory() above (also network-dependent,
    also degrades gracefully) -- advisory only, never affects exit code.

    silent_dropped_subscribers_check.main() raises SystemExit(int) on its
    normal path (1 if anything is dropped/open, 0 if clean -- its own
    prints already ran before that) and SystemExit(str) if the live D1
    query itself failed (missing credentials, network). Only the second
    shape gets a skip line here; the first shape's informative output
    already printed."""
    sys.path.insert(0, str(repo_root / "scripts"))
    try:
        import silent_dropped_subscribers_check as sdsc
    except ImportError:
        print("  (skipping silent-drop advisory -- silent_dropped_subscribers_check.py not importable)")
        return
    print("\n--- silent-drop advisory (does not affect gate exit code) ---")
    try:
        sdsc.main()
    except SystemExit as exc:
        if isinstance(exc.code, str):
            print(f"  (skipping silent-drop advisory -- {exc.code})")


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


def print_renewal_fee_staleness_advisory(repo_root: Path) -> None:
    """Surfaces renewal_fee_staleness_check.py (2026-08-11) as part of the
    normal pre-ship run, same treatment as the CPE-hours/reinstatement
    advisories above -- printed, never affects exit code (check_renewal_fee_currency()
    above is the actual hard gate). renewal_fees.json has no runtime guard
    of its own (inlined into static pages at build time), so this is the
    only place its 55 verified_date stamps get a freshness check at all."""
    sys.path.insert(0, str(repo_root / "scripts"))
    try:
        import renewal_fee_staleness_check as rfsc
    except ImportError:
        print("  (skipping renewal-fee-staleness advisory -- renewal_fee_staleness_check.py not importable)")
        return
    print("\n--- renewal-fee-staleness advisory (does not affect gate exit code) ---")
    try:
        rfsc.main()
    except SystemExit:
        pass


def print_gap_list_advisory(repo_root: Path) -> None:
    """Surfaces gap_list_check.py (SRC-4, AuditLab 2026-08-14) as part of the
    normal pre-ship run -- printed, never affects exit code. Regenerates
    data/gap_list.json on every run so the mechanically-derived inventory of
    every sourcing-gap/verification-note record can never be a stale or
    remembered subset; see that script's own docstring for the finding this
    closes."""
    sys.path.insert(0, str(repo_root / "scripts"))
    try:
        import gap_list_check as glc
    except ImportError:
        print("  (skipping gap-list advisory -- gap_list_check.py not importable)")
        return
    print("\n--- gap-list advisory (does not affect gate exit code) ---")
    try:
        glc.main()
    except SystemExit:
        pass


def print_es_translation_review_advisory(repo_root: Path) -> None:
    """Phase A i18n rollout (2026-08-19) status at a glance: how many keys
    exist, how many have a reviewed+current Spanish translation, how many
    are still pending AuditLab's review. Informational only -- t()'s own
    runtime fallback is what actually keeps an unreviewed string off a
    real page, this is just visibility into the review queue."""
    sys.path.insert(0, str(repo_root))
    try:
        import i18n
    except ImportError:
        print("  (skipping ES translation-review advisory -- i18n.py not importable)")
        return
    print("\n--- es-translation-review advisory (does not affect gate exit code) ---")
    total = len(i18n.EN)
    pending = i18n.stale_or_missing_keys()
    reviewed = total - len(pending)
    print(f"i18n.py Phase A keys: {total}   reviewed & current: {reviewed}   pending review: {len(pending)}")
    if pending:
        print(f"  Pending (falls back to English until AuditLab approves): {', '.join(sorted(pending)[:10])}"
              + (f" ... and {len(pending) - 10} more" if len(pending) > 10 else ""))
    else:
        print("  PASS -- every Phase A key has a reviewed, current Spanish translation.")


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

    # GATE-10 (MEDIUM, 2026-08-21): cpa_deadlines.json is protected --
    # check_data_manifest_consistency() reads it with no .exists() guard, so
    # a missing file throws and nothing ships. The other three sibling
    # datasets were not: both generate.py (returns {} on a missing file) and
    # the six sourcing gates below (each .continue()s or return []s past a
    # dataset that isn't there) fail OPEN -- a renamed/moved dataset makes
    # every one of those gates report clean having audited 3 of 4 datasets,
    # while the guide pages built from the fourth ship with whatever {}
    # renders as. Same fail-closed shape as the HTML-corpus check above,
    # covering all four dataset paths at one entry point rather than
    # thirteen individual call sites -- every per-gate .exists() becomes
    # harmless defense-in-depth instead of the only control.
    for sibling_name in ("cpe_hours.json", "reinstatement.json", "renewal_fees.json"):
        sibling_path = repo_root / "data" / sibling_name
        if not sibling_path.exists():
            print(f"FATAL: expected dataset missing: {sibling_path}")
            sys.exit(2)

    state_dirs = {p.parent for p in html_files if p.parent.name not in ("privacy", "contact", "terms")} - {docs_dir}
    state_page_files = [d / "index.html" for d in state_dirs if (d / "index.html").exists()]

    all_errors = []
    all_errors += check_copy_hygiene(html_files)
    all_errors += check_rendering_integrity(html_files)
    all_errors += check_prose_leak_shapes(html_files)
    all_errors += check_worker_error_strings_no_api_internals(repo_root)
    all_errors += check_stylesheet_integrity(html_files)
    all_errors += check_legal_safety(html_files, state_page_files)
    all_errors += check_affiliate_disclosure(html_files)
    all_errors += check_named_vendor_disparagement(html_files)
    all_errors += check_data_manifest_consistency(data_path, docs_dir)
    all_errors += check_deadline_currency(data_path)
    all_errors += check_birth_month_table_currency(html_files)
    all_errors += check_hidden_display_override(html_files)
    all_errors += check_cpe_hours_currency(repo_root)
    all_errors += check_annual_minimum_not_alternative_track(repo_root)
    all_errors += check_rule_change_monitoring_currency(repo_root)
    all_errors += check_reinstatement_currency(repo_root)
    all_errors += check_stale_thresholds_unified(html_files)
    all_errors += check_derived_fee_consistency(repo_root)
    all_errors += check_block_claims_corroborated(repo_root)
    all_errors += check_hedge_language_enforced(repo_root)
    all_errors += check_partial_citation_flag_set(repo_root)
    all_errors += check_retired_claims_absent(repo_root)
    all_errors += check_retired_claims_absent_from_guides(repo_root, html_files)
    all_errors += check_published_figures_link_source(html_files)
    all_errors += check_citations_are_primary(repo_root)
    all_errors += check_fee_basis_supported(repo_root)
    all_errors += check_renewal_fee_currency(repo_root)
    all_errors += check_competitor_price_currency(repo_root)
    all_errors += check_field_computed_states_sync(repo_root)
    all_errors += check_sms_cron_hour_matches_wrangler(repo_root)
    all_errors += check_pricing_matches_tiers(repo_root)
    all_errors += check_json_copies_identical(repo_root)
    all_errors += check_terms_version_sync(repo_root)
    all_errors += check_sms_consent_version_sync(repo_root)
    all_errors += check_cpe_cycle_window_sync(repo_root)
    all_errors += check_retention_coverage(repo_root)
    all_errors += check_snoozed_until_cleared_on_cycle_bump(repo_root)
    all_errors += check_sitemap_completeness(html_files, docs_dir)
    all_errors += check_demo_locked_email_coverage(repo_root)
    all_errors += check_write_endpoint_rate_limits(repo_root)
    all_errors += check_email_link_helper_usage(repo_root)
    all_errors += check_i18n_reviewed_entries_not_stale(repo_root)
    all_errors += check_send_pass_consent_gate_coverage(repo_root)

    print(f"Pre-ship gate: scanned {len(html_files)} rendered pages, {len(state_dirs)} state dirs.")
    if all_errors:
        print(f"\nFAIL -- {len(all_errors)} violation(s):\n")
        for e in all_errors:
            print(" ", e)
        print_worker_deploy_staleness_advisory(repo_root)
        print_silent_drop_advisory(repo_root)
        print_cpa_deadlines_staleness_advisory(repo_root)
        print_cpe_hours_staleness_advisory(repo_root)
        print_reinstatement_staleness_advisory(repo_root)
        print_renewal_fee_staleness_advisory(repo_root)
        print_rule_change_monitoring_staleness_advisory(repo_root)
        print_guide_review_staleness_advisory(repo_root)
        print_dual_credential_citation_advisory(repo_root)
        print_gap_list_advisory(repo_root)
        print_es_translation_review_advisory(repo_root)
        print_seo_length_drift_advisory(html_files)
        sys.exit(1)
    print("\nPASS -- no violations found.")
    print_worker_deploy_staleness_advisory(repo_root)
    print_silent_drop_advisory(repo_root)
    print_cpa_deadlines_staleness_advisory(repo_root)
    print_cpe_hours_staleness_advisory(repo_root)
    print_reinstatement_staleness_advisory(repo_root)
    print_renewal_fee_staleness_advisory(repo_root)
    print_rule_change_monitoring_staleness_advisory(repo_root)
    print_guide_review_staleness_advisory(repo_root)
    print_dual_credential_citation_advisory(repo_root)
    print_gap_list_advisory(repo_root)
    print_es_translation_review_advisory(repo_root)
    print_seo_length_drift_advisory(html_files)
    sys.exit(0)


if __name__ == "__main__":
    main()
