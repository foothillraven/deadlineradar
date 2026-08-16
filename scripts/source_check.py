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
BOT_WALL_MARKERS = [
    "captcha",
    "bot manager",
    "are you a robot",
    "verify you are human",
    "checking your browser",
    "attention required",
]


def _fetch(url: str) -> tuple[str, bytes | None, str, int | None]:
    """Returns (status_class, body_bytes, content_type, http_status)."""
    req = urllib.request.Request(url, headers={"User-Agent": BROWSER_UA, "Accept": "*/*"})
    # One retry, transient failures only. A single timeout or reset is not an
    # observation about the host, and since the preship gate now treats a
    # status-less failure as INCONCLUSIVE (rather than silently corroborating a
    # block claim), every unretried hiccup costs real coverage -- 5 records went
    # unassessed on 2026-08-14 for exactly this reason. HTTPError is NOT retried:
    # a 403/404 is a decisive answer, and re-asking a host that just refused us
    # is both pointless and rude.
    last_exc_status = None
    for attempt in range(2):
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
                body = resp.read()
                ctype = (resp.headers.get("Content-Type") or "").lower()
                status = resp.status
            break
        except urllib.error.HTTPError as e:
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
    text = _extract_pdf(body) if is_pdf else _extract_html(body)

    if text is None:
        result["classification"] = "EXTRACTION_FAILED"
        result["detail"] = (
            "fetch SUCCEEDED (%d bytes) but no extractor produced text -- this is a local "
            "tooling failure, NOT a host block; do not write it up as blocked. Queue for a "
            "browser-session read instead." % len(body or b"")
        )
        return result

    low = text[:4000].lower()
    bot = next((m for m in BOT_WALL_MARKERS if m in low), None)
    if bot and len(text) < 3000:
        result["classification"] = "BLOCKED"
        result["detail"] = "2xx but the body is a bot-wall interstitial (marker: %r) -- fingerprint block, queue for a browser-session read" % bot
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
