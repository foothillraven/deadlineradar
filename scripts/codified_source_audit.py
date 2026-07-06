#!/usr/bin/env python3
"""Codified-source audit (2026-07-06, prevention-loop for the P2 failure class).

ADVISORY ONLY -- does not exit non-zero, does not block a build. Flags non-null
next_deadline_computed records whose codified-law basis (statute/administrative
code, independent of the board's own operational webpage) isn't evident from
either the cited source URLs or the record's own citation text. This is a
heuristic triage tool: it tells you WHERE to spend a human/agent adversarial
re-verification pass, not a verdict on its own. A flagged record may turn out
fine on inspection (a codified citation given only by name, not a live URL);
an unflagged record could still be wrong in a way this can't detect (e.g. the
right kind of source, wrong specific value -- exactly the P2 failure mode,
which this tool does NOT catch on its own; only a live re-fetch-and-compare
against the actual statute text catches that).

Usage: python scripts/codified_source_audit.py [repo_root]
"""
import json
import re
import sys
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


def main():
    repo_root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent
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

    with open(repo_root / "scripts" / "_codified_audit_result.json", "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2)


if __name__ == "__main__":
    main()
