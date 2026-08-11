#!/usr/bin/env python3
"""Renewal-fee staleness check (2026-08-11, roadmap 14:30 item #6).

`data/renewal_fees.json` records their verification date the same way
`cpa_deadlines.json`/`cpe_hours.json`/`reinstatement.json` do: a
`verified_date` field (ISO date string). Same shape as
cpe_hours_staleness_check.py -- one script per dataset is this repo's own
established convention, even though the date-comparison logic itself is
identical across all of them.

Run standalone, this prints a report and never exits non-zero on its own.
`data/renewal_fees.json` is inlined into state pages at build time by
generate.py, entirely client-side/static -- there is no Worker-side
runtime path this could gate even if it wanted to. A human/agent
re-verifying a flagged record (including the unconfirmed ones, where
"we checked and found nothing official" is itself a fact worth
re-checking periodically) and bumping its verified_date is the fix, not
code.

Usage:
    python scripts/renewal_fee_staleness_check.py [repo_root]
"""
import json
import sys
from datetime import date, datetime
from pathlib import Path

# Same bar every sibling dataset in this file uses -- no reason found to
# pick a different cadence for a fee dataset with the same board-page-or-
# codified-rule verification standard.
STALENESS_THRESHOLD_DAYS = 30


def collect_stale(records: list[dict]) -> tuple[list, list, list, list]:
    """Sorts records into (fresh, stale, unparseable, missing) by
    verified_date age. Split out of main() so preship_gate.py can promote
    this from an advisory into a hard gate without re-implementing the
    same date logic, same pattern as every sibling staleness script."""
    today = date.today()
    fresh, stale, unparseable, missing = [], [], [], []
    for r in records:
        vd = r.get("verified_date")
        if not vd:
            missing.append(r)
            continue
        try:
            verified = datetime.strptime(vd, "%Y-%m-%d").date()
        except ValueError:
            unparseable.append(r)
            continue
        age_days = (today - verified).days
        (stale if age_days > STALENESS_THRESHOLD_DAYS else fresh).append((r, age_days))
    return fresh, stale, unparseable, missing


def main() -> None:
    repo_root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent
    data_path = repo_root / "data" / "renewal_fees.json"
    data = json.loads(data_path.read_text(encoding="utf-8"))

    today = date.today()
    fresh, stale, unparseable, missing = collect_stale(data["records"])

    print(f"Renewal-fee staleness check -- {today.isoformat()} (threshold {STALENESS_THRESHOLD_DAYS}d)")
    print(f"  fresh: {len(fresh)}   stale: {len(stale)}   unparseable: {len(unparseable)}   missing verified_date: {len(missing)}")

    if stale:
        print(f"\nSTALE -- past the {STALENESS_THRESHOLD_DAYS}-day bar, re-verify before next ship ({len(stale)}):")
        for r, age_days in sorted(stale, key=lambda pair: -pair[1]):
            print(f"  [{r['id']}] {r['state']} -- verified_date={r['verified_date']} ({age_days}d old)")
            print(f"    fee_usd: {r.get('fee_usd')!r} -- {r.get('source_url')}")
    if unparseable:
        print(f"\nUNPARSEABLE verified_date ({len(unparseable)}) -- treat as stale until fixed:")
        for r in unparseable:
            print(f"  [{r['id']}] {r['state']} -- verified_date={r.get('verified_date')!r}")
    if missing:
        print(f"\nMISSING verified_date entirely ({len(missing)}) -- treat as stale until fixed:")
        for r in missing:
            print(f"  [{r['id']}] {r['state']}")

    if not (stale or unparseable or missing):
        print("\nPASS -- every record is within the freshness bar.")


if __name__ == "__main__":
    main()
