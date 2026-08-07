#!/usr/bin/env python3
"""CPA-deadlines per-citation staleness check (2026-08-07, roadmap #45).

`data/cpa_deadlines.json` -- the product's single most important dataset -- has a per-record
`last_verified` field on all 88 records, but until now had no script surfacing which INDIVIDUAL
citations are overdue for re-verification, unlike its three sibling datasets
(cpe_hours_staleness_check.py, reinstatement_staleness_check.py,
rule_change_monitoring_staleness_check.py all already exist). The Worker's own runtime guard
(worker/src/deadline.ts's checkDataFreshness()) only checks a single WHOLE-DATASET `as_of_date` --
a real, meaningful signal for "was this file regenerated/reviewed recently," but blind to a single
state's citation going stale for months while `as_of_date` looks fresh because some OTHER state was
more recently touched. This script closes that per-citation blind spot the same way the CPE-hours
script closed it for that dataset (see that script's own docstring).

Advisory only: prints a report, never blocks a build or exits non-zero on its own -- same posture as
every other staleness script in this directory. A human/agent re-verifying a flagged citation's
source_url and bumping its last_verified is the fix, not code.

Usage:
    python scripts/cpa_deadlines_staleness_check.py [repo_root]
"""
import json
import sys
from datetime import date, datetime
from pathlib import Path

# Same bar every sibling staleness script in this directory uses (and the
# same number worker/src/deadline.ts's own STALENESS_THRESHOLD_DAYS applies
# to the whole-dataset as_of_date) -- not a hard requirement this dataset
# must match that exactly, but no reason found to pick a different number
# for the SAME board-page-plus-statute verification standard.
STALENESS_THRESHOLD_DAYS = 30


def main() -> None:
    repo_root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent
    data_path = repo_root / "data" / "cpa_deadlines.json"
    data = json.loads(data_path.read_text(encoding="utf-8"))

    today = date.today()
    fresh, stale, unparseable, missing = [], [], [], []
    for r in data["records"]:
        lv = r.get("last_verified")
        if not lv:
            missing.append(r)
            continue
        try:
            verified = datetime.strptime(lv, "%Y-%m-%d").date()
        except ValueError:
            unparseable.append(r)
            continue
        age_days = (today - verified).days
        (stale if age_days > STALENESS_THRESHOLD_DAYS else fresh).append((r, age_days))

    print(f"CPA-deadlines per-citation staleness check -- {today.isoformat()} (threshold {STALENESS_THRESHOLD_DAYS}d)")
    print(f"  fresh: {len(fresh)}   stale: {len(stale)}   unparseable: {len(unparseable)}   missing last_verified: {len(missing)}")

    if stale:
        print(f"\nSTALE -- past the {STALENESS_THRESHOLD_DAYS}-day bar, re-verify before next ship ({len(stale)}):")
        for r, age_days in sorted(stale, key=lambda pair: -pair[1]):
            print(f"  [{r['id']}] {r['state']} ({r.get('license_type_label')}) -- last_verified={r['last_verified']} ({age_days}d old)")
            print(f"    source: {r.get('source_url')}")
    if unparseable:
        print(f"\nUNPARSEABLE last_verified ({len(unparseable)}) -- treat as stale until fixed:")
        for r in unparseable:
            print(f"  [{r['id']}] {r['state']} -- last_verified={r.get('last_verified')!r}")
    if missing:
        print(f"\nMISSING last_verified entirely ({len(missing)}) -- treat as stale until fixed:")
        for r in missing:
            print(f"  [{r['id']}] {r['state']}")

    if not (stale or unparseable or missing):
        print("\nPASS -- every citation is within the freshness bar.")


if __name__ == "__main__":
    main()
