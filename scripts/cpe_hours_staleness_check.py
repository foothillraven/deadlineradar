#!/usr/bin/env python3
"""CPE-hours staleness check (2026-08-04, AuditLab ST-2).

`data/cpe_hours.json` records their verification date the same way
`cpa_deadlines.json` and `mobility_rules.json` do now: a `verified_date`
field (ISO date string). Before this, the date was encoded in a per-record
JSON *key name* (`"verified_2026-07-15": true`) -- nothing could compare a
key name against a threshold, so this 50-record, board-page-plus-statute
dataset had no freshness guard of any kind while its two sibling datasets
did. This script closes that gap the same way worker_deploy_staleness_check.py
and cpa_deadlines.json's own STALENESS_THRESHOLD_DAYS do.

Run standalone, this prints a report and never exits non-zero on its own.
`data/cpe_hours.json` is inlined into the public CPE pages at build time
by generate.py, entirely client-side/static -- there is no Worker-side
runtime path this could gate even if it wanted to (unlike
cpa_deadlines.json's signup-pausing guard). A human/agent re-verifying a
flagged record and bumping its verified_date is the fix, not code.

AuditLab BADGE-1 (MEDIUM, 2026-08-09): collect_stale() (below) is ALSO
imported by preship_gate.py's check_cpe_hours_currency(), which DOES fail
the build on a stale/unparseable/missing record -- roadmap #47 upgraded
the public badge from a bare "Verified" to a dated "Verified 2026-07-15",
making the freshness claim specific and publicly checkable, but this
checker stayed advisory-only, so a build could still ship 22 badges past
the 30-day bar without failing. Same "print + hard gate together" pattern
cpa_deadlines.json's check_deadline_currency() already uses.

Usage:
    python scripts/cpe_hours_staleness_check.py [repo_root]
"""
import json
import sys
from datetime import date, datetime
from pathlib import Path

# Same bar cpa_deadlines.json's runtime guard uses (worker/src/deadline.ts's
# STALENESS_THRESHOLD_DAYS) -- not a hard requirement CPE data must match that
# exactly, but no reason found to pick a different number for a sibling
# board-page-plus-statute dataset with the same verification standard.
STALENESS_THRESHOLD_DAYS = 30


def collect_stale(records: list[dict]) -> tuple[list, list, list, list]:
    """Sorts records into (fresh, stale, unparseable, missing) by
    verified_date age. Split out of main() (AuditLab BADGE-1, 2026-08-09)
    so preship_gate.py can promote this from an advisory into a hard gate
    without re-implementing the same date logic -- see that function's own
    check_cpe_hours_currency() docstring for why."""
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
    data_path = repo_root / "data" / "cpe_hours.json"
    data = json.loads(data_path.read_text(encoding="utf-8"))

    today = date.today()
    fresh, stale, unparseable, missing = collect_stale(data["records"])

    print(f"CPE-hours staleness check -- {today.isoformat()} (threshold {STALENESS_THRESHOLD_DAYS}d)")
    print(f"  fresh: {len(fresh)}   stale: {len(stale)}   unparseable: {len(unparseable)}   missing verified_date: {len(missing)}")

    if stale:
        print(f"\nSTALE -- past the {STALENESS_THRESHOLD_DAYS}-day bar, re-verify before next ship ({len(stale)}):")
        for r, age_days in sorted(stale, key=lambda pair: -pair[1]):
            print(f"  [{r['id']}] {r['state']} -- verified_date={r['verified_date']} ({age_days}d old)")
            print(f"    citation: {r.get('citation')!r} -- {r.get('citation_url')}")
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
