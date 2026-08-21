"""source_check.py -- classify a source URL honestly before anything reaches data_gap_note.

Devin's directive (2026-08-14): the verification pipeline must stop conflating two
different failure modes. Three same-day incidents (mass.gov 252 CMR 2.14 and 2.16,
Utah's CPE FAQ PDF) each wrote "the host blocks automated access" into a public
data_gap_note when the truth was that the FETCH SUCCEEDED and only our local
text-extraction step choked on the returned bytes.

Classification contract:
  BLOCKED            non-2xx status, timeout, connection failure, or an empty body.
                     The only class that may be described as blocked/unreachable.
  EXTRACTION_FAILED  real bytes came back but no extractor produced text. This is
                     OUR failure. It must never be written up as a host block; the
                     honest note is "fetched but not machine-readable by our
                     tooling" and the record goes to a manual/browser queue.
  CONFIRMED_TEXT     text was extracted. Whether the CONTENT supports the record's
                     claim is the caller's judgment -- this tool only settles
                     reachability + readability, the two things that keep getting
                     conflated.
  SOFT_404           2xx with substantive body that is actually an error/"site has
                     moved"/placeholder page (detected by marker phrases). The
                     rendered-content lesson from the SPA/404 class.

PDF extraction ladder: pypdf first, then PyMuPDF (fitz) if importable -- the retry
the directive names -- before EXTRACTION_FAILED is allowed.

Usage:
  python scripts/source_check.py <url> [...]        classify each URL, print report
  python scripts/source_check.py --json <url> [...] machine-readable output
Exit code 0 always (it's a reporter, not a gate).
"""
from __future__ import annotations

import io
import json
import re
import sys
import time
import html as html_mod
import urllib.request
import urllib.error

BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/128.0 Safari/537.36"
)
TIMEOUT_S = 30

# Below this many characters of extracted text, a 2xx is not a readable source.
# Set at 200 deliberately: the thinnest LEGITIMATE source observed in the corpus
# is well above it, while the JS shells that prompted this (11 and 63 chars) sit
# far below. Raising it much further would start swallowing short but real rule
# pages, which is the false-positive direction that makes a check ignorable.
_MIN_SOURCE_CHARS = 200

# 2xx pages that are really failures -- learned set, extend as encountered.
SOFT_404_MARKERS = [
    "site has moved",
    "page not found",
    "not allowed",
    "access denied",
    "error 404",
    "no longer available",
    "this page has moved",
    # Server-side crash pages returned with HTTP 200. Added 2026-08-14 after
    # both Arkansas citation_urls (17 CAR 236-1101 / 236-1203) were classified
    # CONFIRMED_TEXT: codeofarrules.arkansas.gov returns 200 with ~1kB of site
    # chrome whose only body content is the .NET exception below. The links were
    # LIVE on our state pages, dead-ending readers into a stack-trace stub --
    # the same shape as the Colorado raw-JSON citation Devin found. A crash page
    # is not a source, and "we fetched 1061 characters" is not evidence.
    "object reference not set",
    "runtime error",
    "server error in '/' application",
    "an unhandled exception",
    "unexpected error occurred",
]

# 2xx interstitials that are really fetcher blocks -- discovered live on the
# first full sweep: mn.gov/boa serves a Radware captcha page with HTTP 200,
# which the first version of this tool mislabelled CONFIRMED_TEXT. A bot
# wall is a BLOCK (fingerprint-specific, browser-queue it), never a
# confirmation.
#
# SRC-9 (AuditLab, 2026-08-20): the original fixed phrase list missed
# www.oscn.net's Cloudflare Turnstile page -- it says "verify they are
# human" (pronoun "they", not "you"), so it fell through every marker and
# was classified CONFIRMED_TEXT for a 386-char CAPTCHA body. Same shape as
# SRC-7's BLOCK_CLAIM_RE fix: widened from an exact phrase list to a shape
# regex (phrasing variants) plus vendor/challenge-script signatures, since
# a bot-wall vendor rotates its exact copy far more than its script names.
#
# SRC-12 (AuditLab, 2026-08-20): eregulations.ct.gov serves an Akamai Bot
# Manager challenge that reads CONFIRMED_TEXT -- the existing `_abck` marker
# is an Akamai COOKIE name, but this challenge body never emits it; instead
# it opens with a literal `<APM_DO_NOT_TOUCH>` tag and obfuscated bootstrap
# JS (`window.Btaz=...`), and clears `_MIN_SOURCE_CHARS` at 774 chars -- the
# same "vendor nominally covered, this signature isn't" gap SRC-9 closed for
# Turnstile. Three Connecticut citation_urls were affected.
#
# SRC-13 (AuditLab, 2026-08-20): the SRC-12 fix landed but never fired --
# `check()` matches BOT_WALL_RE against `text`, the output of
# _extract_html()/_extract_pdf()/_extract_docx(), which strips tags and
# scripts BEFORE this regex ever runs. `apm_do_not_touch` is a literal HTML
# tag name; `_extract_html()`'s `re.sub(r"<[^>]+>", " ", raw)` removes it
# before the matcher sees it. AuditLab checked every vendor signature this
# way and found most of BOT_WALL_RE was unreachable for the same reason:
# bobcmn, /tspd/, challenges.cloudflare.com, _incapsula_resource, _abck,
# apm_do_not_touch -- all markup/script-identifier signatures, all stripped
# by design before the check runs. Only the prose-visible signatures
# (captcha, turnstile-as-rendered-text, "verify you/they are human") ever
# actually matched anything. Split by where each signature lives: markup
# signatures are checked against the RAW decoded body (before extraction),
# prose signatures stay checked against the extracted text -- each matched
# at the point in the pipeline where it can actually appear.
MARKUP_BOT_RE = re.compile(
    r"(bobcmn|/tspd/|challenges\.cloudflare\.com|_incapsula_resource|"
    r"_abck|apm_do_not_touch|bm-verify|akam(?:ai)?[-_]?(?:bm|sensor)|"
    r"distil|perimeterx|px-captcha)",
    re.IGNORECASE,
)
PROSE_BOT_RE = re.compile(
    r"(captcha|bot manager|are you a robot|checking your browser|attention required|"
    r"verify (?:you|they)(?:'re| are)? human|automated traffic|prove you are|"
    r"turnstile|cf-turnstile)",
    re.IGNORECASE,
)

# Found live while re-testing SRC-9's fix (2026-08-20): sd-all's citation_url
# (sdlegislature.gov/Rules/...) returns a 286-char "please enable JavaScript"
# shell -- the same failure shape as Montana's 11-char and Indiana's 63-char
# shells that _MIN_SOURCE_CHARS=200 exists to catch, just verbose enough
# (browser-download links, "Chrome Firefox Edge") to clear that threshold and
# sail through as CONFIRMED_TEXT. A length floor alone can't catch every
# host's shell size, so this checks for the shell's own wording directly,
# same shape as BOT_WALL_RE. Length-gated at 2000 chars for the same reason
# BOT_WALL_RE is gated at 3000 -- a long, real page that happens to mention
# "enable JavaScript" once in a footer should not be swept up.
SPA_SHELL_RE = re.compile(
    r"(doesn'?t work properly without javascript|"
    r"enable javascript to (?:run this app|continue)|"
    r"your browser is not supported|"
    r"please enable (?:it|javascript) to continue)",
    re.IGNORECASE,
)


# SRC-7 (AuditLab, 2026-08-20): the phrase list this started as
# (blocks?/bot.?wall/resists non-browser/could not be reached-fetched-accessed)
# missed 4 live records verbatim -- "blocked TO automated fetches" (not
# "blocks"), "not reachable via automated tooling", "render only in a
# browser", and a note quoting this module's own "BLOCKED" verdict back at
# the reader. Each miss means check_block_claims_corroborated() in
# preship_gate.py silently skips that record's own live-check -- a claim the
# regex doesn't recognize never reaches source_check.check() at all, so the
# gate can report "all corroborated" while checking nothing. Widened to
# match by SHAPE (block-language, unreachability, browser-only rendering)
# rather than an exact phrase list, on the same theory as the SRC-4 gap-list
# and GATE-1 prose-leak detectors: over-matching here is cheap (source_check
# just runs on a few more records), under-matching is what silently empties
# a gate. Single-sourced here and imported by both preship_gate.py and
# gap_list_check.py so the two can no longer drift out of sync with each
# other (SRC-7's second, smaller defect: they already had).
BLOCK_CLAIM_RE = re.compile(
    r"(block\w*|not reachable|unreachable|could not be (?:reached|fetched|accessed|parsed)|"
    r"bot.?(?:wall|filter|manager)|captcha|resists? non-browser|"
    r"renders? only in a browser|requires? (?:a )?browser|javascript application)",
    re.IGNORECASE,
)

# SRC-8 (AuditLab, 2026-08-20): gap_list_check.py's field list (which fields
# per dataset can carry a gap/verification note) and preship_gate.py's
# `_BLOCK_CLAIM_DATASETS` had ALSO drifted apart, one level under SRC-7's
# regex fix -- `check_block_claims_corroborated()` only ever scanned
# `data_gap_note`, never `verification_note`, so ak-individual/ak-firm's
# block claim (which lives in verification_note, the only two records that
# do) was never live-checked at all, before or after SRC-7's widening. Only
# `cpa_deadlines.json` carries `verification_note` as a field distinct from
# `data_gap_note`; the other three datasets only ever use `data_gap_note`.
# Single-sourced here for the same reason as BLOCK_CLAIM_RE above.
GAP_NOTE_FIELDS = [
    ("cpa_deadlines.json", ["data_gap_note", "verification_note"]),
    ("cpe_hours.json", ["data_gap_note"]),
    ("reinstatement.json", ["data_gap_note"]),
    ("renewal_fees.json", ["data_gap_note"]),
]


def _fetch(url: str) -> tuple[str, bytes | None, str, int | None]:
    """Returns (status_class, body_bytes, content_type, http_status)."""
    req = urllib.request.Request(url, headers={"User-Agent": BROWSER_UA, "Accept": "*/*"})
    # One retry, transient failures only. A single timeout or reset is not an
    # observation about the host, and since the preship gate now treats a
    # status-less failure as INCONCLUSIVE (rather than silently corroborating a
    # block claim), every unretried hiccup costs real coverage -- 5 records went
    # unassessed on 2026-08-14 for exactly this reason.
    #
    # AuditLab SRC-5: a single HTTPError is not always decisive either.
    # rules.sos.ga.gov returned 200x3 then 403x4 across a controlled retest with
    # IDENTICAL headers minutes apart -- rate limiting, not a real block, and a
    # single-sample BLOCKED on it would license writing a host-block claim into
    # public copy that is false. 403/429/503 are the rate-limit-shaped codes and
    # get the same one retry as a connection failure. 404/401/451 are decisive
    # on the first try -- "not found" or "not authorized" does not become truer
    # on a second attempt, and re-asking a host that gave a real answer is rude.
    RETRIABLE_HTTP_CODES = {403, 429, 503}
    last_exc_status = None
    for attempt in range(2):
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
                body = resp.read()
                ctype = (resp.headers.get("Content-Type") or "").lower()
                status = resp.status
            break
        except urllib.error.HTTPError as e:
            if e.code in RETRIABLE_HTTP_CODES and attempt == 0:
                time.sleep(2)
                continue
            return ("BLOCKED", None, "", e.code)
        except Exception:
            last_exc_status = None
            if attempt == 0:
                time.sleep(2)
                continue
            return ("BLOCKED", None, "", last_exc_status)
    if not (200 <= status < 300) or not body:
        return ("BLOCKED", body, ctype, status)
    return ("FETCHED", body, ctype, status)


def _extract_pdf(body: bytes) -> str | None:
    """The ladder the directive names: pypdf, then PyMuPDF, before giving up."""
    try:
        from pypdf import PdfReader

        reader = PdfReader(io.BytesIO(body))
        text = "\n".join((p.extract_text() or "") for p in reader.pages)
        if text.strip():
            return text
    except Exception:
        pass
    try:
        import fitz  # PyMuPDF

        doc = fitz.open(stream=body, filetype="pdf")
        text = "\n".join(page.get_text() for page in doc)
        if text.strip():
            return text
    except Exception:
        pass
    return None


def _extract_docx(body: bytes) -> str | None:
    """SRC-10 (AuditLab, 2026-08-20): a .docx is a ZIP container, and
    _extract_html() previously handled it by decoding the raw ZIP bytes as
    UTF-8 text -- which "succeeds" (it's valid-enough UTF-8-with-
    replacement-chars) and produces tens of thousands of characters of
    binary noise, clearing every length floor in this module and reporting
    CONFIRMED_TEXT for a document nobody actually read. Live case: Maine's
    official .docx fee schedule (introduced by CITE-34's citation_url
    repoint) -- correct data, false CONFIRMED_TEXT read of the wrapper.
    Reads word/document.xml directly (the actual document body inside the
    OOXML zip) and strips markup the same way _extract_html() does."""
    try:
        import zipfile

        with zipfile.ZipFile(io.BytesIO(body)) as z:
            xml = z.read("word/document.xml").decode("utf-8", errors="replace")
        text = re.sub(r"<[^>]+>", " ", xml)
        text = html_mod.unescape(text)
        text = re.sub(r"\s+", " ", text).strip()
        return text or None
    except Exception:
        return None


def _extract_html(body: bytes) -> str | None:
    try:
        raw = body.decode("utf-8", errors="replace")
    except Exception:
        return None
    raw = re.sub(r"<script\b.*?</script\s*>", " ", raw, flags=re.S | re.I)
    raw = re.sub(r"<style\b.*?</style\s*>", " ", raw, flags=re.S | re.I)
    text = re.sub(r"<[^>]+>", " ", raw)
    text = html_mod.unescape(text)
    text = re.sub(r"\s+", " ", text).strip()
    return text or None


def check(url: str) -> dict:
    status_class, body, ctype, http_status = _fetch(url)
    result = {"url": url, "http_status": http_status, "content_type": ctype}
    if status_class == "BLOCKED":
        result["classification"] = "BLOCKED"
        result["detail"] = "non-2xx / timeout / connection failure / empty body -- genuinely unreachable to this fetcher"
        return result

    is_pdf = "pdf" in ctype or (body is not None and body[:5] == b"%PDF-")
    is_docx = "officedocument" in ctype or (body is not None and body[:4] == b"PK\x03\x04")
    # SRC-11 (AuditLab, 2026-08-20): legacy .doc is an OLE compound file (a
    # DIFFERENT container from .docx's ZIP), and fell through to
    # _extract_html() the same way .docx did before SRC-10 -- decoding the
    # binary as UTF-8 "succeeds" and reports CONFIRMED_TEXT on noise. Live
    # case: 4 Florida records (flrules.org serves .doc, passed as a query
    # param -- fl-individual, fl-cpe, florida-reinstatement,
    # florida-renewal-fee). Unlike .docx there's no cheap stdlib parse for
    # the legacy OLE format, and AuditLab's own follow-up confirmed no
    # readable HTML/PDF alternative exists on flrules.org either (its
    # apparent HTML alternative is a rulemaking-HISTORY index that quotes
    # rule numbers from variance notices and proposed amendments, not the
    # operative text -- a worse citation than an honestly-unreadable one).
    # So: classify EXTRACTION_FAILED rather than attempt a parse, matching
    # this module's own "OUR failure, not a host block, queue for a
    # browser-session read" contract for every other unparseable format.
    is_legacy_doc = "msword" in ctype or (body is not None and body[:8] == b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1")
    if is_pdf:
        text = _extract_pdf(body)
    elif is_docx:
        text = _extract_docx(body)
    elif is_legacy_doc:
        text = None
    else:
        text = _extract_html(body)

    if text is None:
        result["classification"] = "EXTRACTION_FAILED"
        result["detail"] = (
            "fetch SUCCEEDED (%d bytes) but no extractor produced text -- this is a local "
            "tooling failure, NOT a host block; do not write it up as blocked. Queue for a "
            "browser-session read instead." % len(body or b"")
        )
        return result

    low = text[:4000].lower()
    bot_match = PROSE_BOT_RE.search(low)
    # SRC-13: markup/script-identifier signatures live in the tags _extract_*()
    # already stripped -- check those against the RAW decoded body instead.
    # Only meaningful for the HTML path (PDF/DOCX bodies are binary/zip, not
    # markup, so there is nothing for these signatures to match there).
    if not bot_match and not is_pdf and not is_docx and not is_legacy_doc and body is not None:
        try:
            raw_low = body.decode("utf-8", errors="replace")[:8000].lower()
        except Exception:
            raw_low = ""
        bot_match = MARKUP_BOT_RE.search(raw_low)
    if bot_match and len(text) < 3000:
        result["classification"] = "BLOCKED"
        result["detail"] = "2xx but the body is a bot-wall interstitial (marker: %r) -- fingerprint block, queue for a browser-session read" % bot_match.group(0)
        result["text_chars"] = len(text)
        return result
    marker = next((m for m in SOFT_404_MARKERS if m in low), None)
    # A tiny body with an error marker is a soft 404; a large body that merely
    # mentions e.g. "page not found" in a nav link is not.
    if marker and len(text) < 3000:
        result["classification"] = "SOFT_404"
        result["detail"] = "2xx but the served page is an error/moved placeholder (marker: %r)" % marker
        result["text_chars"] = len(text)
        return result
    spa_match = SPA_SHELL_RE.search(low)
    if spa_match and len(text) < 2000:
        result["classification"] = "EXTRACTION_FAILED"
        result["detail"] = (
            "2xx and parsed (%d chars), but the body is a \"please enable JavaScript\" shell "
            "(marker: %r) -- not readable as a source no matter the length; this is our tooling's "
            "failure, not a host block. Queue for a browser-session read." % (len(text), spa_match.group(0))
        )
        result["text_chars"] = len(text)
        result["text_head"] = text[:240]
        return result

    # A handful of characters is not a source. rules.mt.gov and in.gov/legislative
    # return 11 and 63 characters respectively -- JS shells whose real content
    # never arrives to a plain fetch -- and both were classified CONFIRMED_TEXT
    # on 2026-08-14, the same failure shape as the Arkansas crash page: a 2xx
    # with a body that contains no source text. CONFIRMED_TEXT is what lets a
    # caller say "I read this at the source", so it has to mean there was
    # something to read. Routed to EXTRACTION_FAILED, which is already defined as
    # OUR failure and already queues for a browser read -- never written up as a
    # host block.
    if len(text) < _MIN_SOURCE_CHARS:
        result["classification"] = "EXTRACTION_FAILED"
        result["detail"] = (
            "2xx and parsed, but only %d characters of text -- almost certainly a "
            "JS shell whose content never arrives to a plain fetch. Not readable "
            "as a source; queue for a browser-session read." % len(text)
        )
        result["text_chars"] = len(text)
        result["text_head"] = text[:240]
        return result

    result["classification"] = "CONFIRMED_TEXT"
    result["text_chars"] = len(text)
    result["text_head"] = text[:240]
    return result


def main() -> None:
    args = [a for a in sys.argv[1:] if a != "--json"]
    as_json = "--json" in sys.argv[1:]
    out = [check(u) for u in args]
    if as_json:
        print(json.dumps(out, indent=1))
    else:
        for r in out:
            print("%-18s %s" % (r["classification"], r["url"]))
            print("    ", r.get("detail") or ("%d chars extracted" % r.get("text_chars", 0)))


if __name__ == "__main__":
    main()
