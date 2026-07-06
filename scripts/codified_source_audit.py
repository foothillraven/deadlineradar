#!/usr/bin/env python3
"""Codified-source audit (2026-07-06, prevention-loop for the P2 failure class;
extended 2026-07-06 for the citation<->link-mismatch class the trust-pass review
caught -- a citation naming one rule while "read the rule" links to a different
one, or to a generic homepage with no specific section reference at all).

ADVISORY ONLY -- does not exit non-zero, does not block a build. Two independent
checks, both heuristic triage tools that tell you WHERE to spend a human/agent
adversarial re-verification pass, not a verdict on their own:

1. `audit()` (offline, default) -- flags non-null records whose codified-law
   basis isn't evident from either the cited source URLs or the record's own
   citation text. A flagged record may turn out fine on inspection (a citation
   given only by name, not a live URL); an unflagged record could still be
   wrong in a way this can't detect (e.g. the right KIND of source, wrong
   specific value -- the original P2 failure mode; only a live re-fetch-and-
   compare against the actual statute text catches that).

2. `check_citation_link_consistency()` (network, opt-in via --check-links) --
   for every record with both a `citation` and a `citation_url`, fetches the
   URL and checks whether the citation's own distinctive number/section
   fragment actually appears on that page. Catches gross mismatches (a wrong
   section number, a citation pointing at a different record's link) the way
   the sd-all and Nevada errors were -- it is a substring check, not semantic
   understanding, so it can still miss a link that's topically close but
   factually wrong; it exists to catch the class of error already seen twice,
   not to replace an adversarial read.

Usage:
    python scripts/codified_source_audit.py [repo_root]                (offline only)
    python scripts/codified_source_audit.py [repo_root] --check-links  (adds the network pass)
"""
import json
import re
import sys
import urllib.request
import urllib.error
from pathlib import Path
from urllib.parse import urlparse

# Substrings in a hostname that suggest a codified-law host: a state
# legislature/statute/administrative-code portal, or a known compiler that
# mirrors real codified text (not a summary/blog of it).
CODIFIED_HOST_HINTS = [
    "legis", "legislature", "statutes", "revisor", "admincode", "adminrules",
    "ilga.gov", "wvlegislature", "ndlegis", "delcode", "nebraskalegislature",
    "elaws", "dcrules", "law.cornell.edu", "findlaw.com", "justia.com",
    "casetext.com", "ksrevisor.gov", "capitol.",
]

# Text patterns that read as an actual codified citation (section symbol,
# common statute/admin-code abbreviations, or a rule-number shape) appearing
# in the record's own cycle_description -- catches cases where the codified
# source is named but not separately linked (e.g. "20 CSR 2010-2.070(1)").
CITATION_TEXT_RE = re.compile(
    r"§|"
    r"\bStat\.|\bC\.F\.R\.|\bAdmin\.?\s*Code\b|\bAdm\.?\s*Code\b|"
    r"\bCSR\b|\bNCAC\b|\bKAR\b|\bWAC\b|\bNAC\b|\bARSD\b|\bIAC\b|\bCCR\b|"
    r"\bRCSA\b|\bRev\.?\s*Stat|\bComp\.?\s*Laws\b|\bCode\s+(?:Ann\.|of)\b",
    re.IGNORECASE,
)


def host_is_codified(url: str) -> bool:
    if not url:
        return False
    netloc = urlparse(url).netloc.lower()
    return any(h in netloc for h in CODIFIED_HOST_HINTS)


def audit(records: list[dict]) -> dict:
    flagged = []      # no codified reference found anywhere -- the hard flag
    weak_independence = []  # has a codified reference, but secondary source is
                             # missing or same-domain as source_url -- worth a
                             # lighter second look, not a hard flag

    for r in records:
        if not r.get("next_deadline_computed"):
            continue  # audit only covers published (non-null) dates

        source_url = r.get("source_url", "")
        secondary_url = r.get("secondary_source_url", "")
        text = r.get("cycle_description", "") or ""

        has_codified_host = host_is_codified(source_url) or host_is_codified(secondary_url)
        has_citation_text = bool(CITATION_TEXT_RE.search(text))
        has_codified_reference = has_codified_host or has_citation_text

        if not has_codified_reference:
            flagged.append({
                "id": r["id"],
                "state": r["state"],
                "next_deadline_computed": r["next_deadline_computed"],
                "source_url": source_url,
                "secondary_source_url": secondary_url,
                "reason": "no codified-law host or citation text found anywhere on this record",
            })
            continue

        src_domain = urlparse(source_url).netloc.lower()
        sec_domain = urlparse(secondary_url).netloc.lower() if secondary_url else ""
        same_domain_or_missing = (not secondary_url) or (sec_domain == src_domain)
        if same_domain_or_missing:
            weak_independence.append({
                "id": r["id"],
                "state": r["state"],
                "next_deadline_computed": r["next_deadline_computed"],
                "source_url": source_url,
                "secondary_source_url": secondary_url,
                "reason": (
                    "no secondary_source_url" if not secondary_url
                    else "secondary_source_url is the same domain as source_url"
                ),
            })

    return {"flagged": flagged, "weak_independence": weak_independence}


_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"

# A citation's most distinctive substring for a crude but cheap match: the
# longest run of digits/section-punctuation (handles "20:75:03:12", "628.380",
# "440.08(2)(a)1.", "1-308", "18VAC5-22-180", etc.) -- deliberately not trying
# to parse citation grammar properly, just extracting something specific
# enough that an unrelated page won't contain it by accident.
_CITATION_FRAGMENT_RE = re.compile(r"[\d][\d.:\-()a-zA-Z]*\d")


def _citation_fragment(citation: str) -> str | None:
    """The base section/number, deliberately trimmed at the first subsection
    parenthetical (e.g. '628.380(2)' -> '628.380') -- a citation's subsection
    marker often renders with different spacing/formatting than the source
    text ('(2)' vs ' 2.' vs a nested list), so keeping it in the match target
    produced false positives on otherwise-correct citations during this
    check's first real run. The base number is still specific enough to rule
    out an unrelated page/section."""
    trimmed = re.split(r"\(", citation, maxsplit=1)[0]
    candidates = _CITATION_FRAGMENT_RE.findall(trimmed) or _CITATION_FRAGMENT_RE.findall(citation)
    if not candidates:
        return None
    return max(candidates, key=len)


def check_citation_link_consistency(records: list[dict]) -> list[dict]:
    """Network pass: fetch each non-null record's citation_url and confirm the
    citation's own distinctive fragment appears somewhere on that page. Flags
    a mismatch (fragment absent) or a fetch failure (can't confirm either way)
    -- both are worth a human look, not a verdict."""
    problems = []
    for r in records:
        citation = r.get("citation")
        url = r.get("citation_url")
        if not citation or not url:
            continue
        fragment = _citation_fragment(citation)
        if not fragment:
            problems.append({
                "id": r["id"], "citation": citation, "citation_url": url,
                "issue": "could not extract a checkable fragment from this citation string",
            })
            continue
        try:
            req = urllib.request.Request(url, headers={"User-Agent": _UA})
            with urllib.request.urlopen(req, timeout=15) as resp:
                body = resp.read().decode("utf-8", errors="replace")
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as e:
            problems.append({
                "id": r["id"], "citation": citation, "citation_url": url,
                "issue": f"fetch failed ({e}) -- cannot confirm, re-check by hand",
            })
            continue
        if fragment not in body:
            problems.append({
                "id": r["id"], "citation": citation, "citation_url": url,
                "issue": f"citation fragment {fragment!r} not found on the linked page -- "
                         f"possible wrong link or wrong citation",
            })
    return problems


def main():
    repo_root = Path(sys.argv[1]) if len(sys.argv) > 1 and not sys.argv[1].startswith("--") \
        else Path(__file__).resolve().parent.parent
    check_links = "--check-links" in sys.argv
    data = json.loads((repo_root / "data" / "cpa_deadlines.json").read_text(encoding="utf-8"))
    nonnull = [r for r in data["records"] if r.get("next_deadline_computed")]
    result = audit(data["records"])

    print(f"Audited {len(nonnull)} published (non-null) records.\n")
    print(f"FLAGGED -- no codified-law reference found ({len(result['flagged'])}):")
    for f in result["flagged"]:
        print(f"  [{f['id']}] {f['state']} -- {f['next_deadline_computed']} -- {f['reason']}")
        print(f"    source_url: {f['source_url']}")
        if f["secondary_source_url"]:
            print(f"    secondary_source_url: {f['secondary_source_url']}")

    print(f"\nWEAK INDEPENDENCE -- has a codified reference, but the second source is "
          f"missing or same-domain ({len(result['weak_independence'])}):")
    for f in result["weak_independence"]:
        print(f"  [{f['id']}] {f['state']} -- {f['next_deadline_computed']} -- {f['reason']}")

    print(f"\nTotal candidates for adversarial re-verification: "
          f"{len(result['flagged']) + len(result['weak_independence'])} of {len(nonnull)}")

    if check_links:
        print("\n--check-links: fetching every citation_url, this takes a while...")
        link_problems = check_citation_link_consistency(data["records"])
        print(f"\nCITATION<->LINK MISMATCHES ({len(link_problems)}):")
        for p in link_problems:
            print(f"  [{p['id']}] citation={p['citation']!r}")
            print(f"    {p['issue']}")
            print(f"    citation_url: {p['citation_url']}")
        result["citation_link_problems"] = link_problems

    with open(repo_root / "scripts" / "_codified_audit_result.json", "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2)


if __name__ == "__main__":
    main()
