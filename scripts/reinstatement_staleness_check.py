#!/usr/bin/env python3
"""Reinstatement staleness check (2026-08-05, AuditLab REIN-1).

`data/reinstatement.json` drives 51 public *-cpa-license-reinstatement pages,
each rendering its own `last_verified` date to the visitor ("Last verified:
2026-07-25"), the same "Last verified" promise cpa_deadlines.json and
cpe_hours.json make -- but unlike those two siblings, nothing has ever
checked whether these 51 dates are still within the site's own 30-day
freshness bar. Mirrors cpe_hours_staleness_check.py exactly (same threshold,
same report shape) rather than generalizing it into a shared multi-dataset
script -- a second small script with an identical, easy-to-read structure is
lower-risk than widening an existing script's call interface out from under
whatever already imports it.

Run standalone, this prints a report and never exits non-zero on its own.
`data/reinstatement.json` is inlined into the public reinstatement pages
at build time by generate.py, entirely client-side/static -- there is no
Worker-side runtime path this could gate even if it wanted to. A human/agent
re-verifying a flagged record and bumping its last_verified date is the fix,
not code.

AuditLab BADGE-1 (MEDIUM, 2026-08-09): collect_stale() (below) is ALSO
imported by preship_gate.py's check_reinstatement_currency(), which DOES
fail the build on a stale/unparseable/missing record -- same "print +
hard gate together" pattern cpa_deadlines.json's check_deadline_currency()
already uses, extended to this sibling dataset's own dated "Last verified"
public claim.

Usage:
    python scripts/reinstatement_staleness_check.py [repo_root]
"""
import json
import sys
from datetime import date, datetime
from pathlib import Path

# Same bar cpe_hours_staleness_check.py and cpa_deadlines.json's runtime
# guard use -- no reason found to hold this sibling dataset to a different
# verification standard.
STALENESS_THRESHOLD_DAYS = 30


def collect_stale(records: list[dict]) -> tuple[list, list, list, list]:
    """Sorts records into (fresh, stale, unparseable, missing) by
    last_verified age. Split out of main() (AuditLab BADGE-1, 2026-08-09)
    so preship_gate.py can promote this from an advisory into a hard gate
    -- see that function's own check_reinstatement_currency() docstring."""
    today = date.today()
    fresh, stale, unparseable, missing = [], [], [], []
    for r in records:
        vd = r.get("last_verified")
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
    data_path = repo_root / "data" / "reinstatement.json"
    data = json.loads(data_path.read_text(encoding="utf-8"))
    records = data["records"] if isinstance(data, dict) else data

    today = date.today()
    fresh, stale, unparseable, missing = collect_stale(records)

    print(f"Reinstatement staleness check -- {today.isoformat()} (threshold {STALENESS_THRESHOLD_DAYS}d)")
    print(f"  fresh: {len(fresh)}   stale: {len(stale)}   unparseable: {len(unparseable)}   missing last_verified: {len(missing)}")

    if stale:
        print(f"\nSTALE -- past the {STALENESS_THRESHOLD_DAYS}-day bar, re-verify before next ship ({len(stale)}):")
        for r, age_days in sorted(stale, key=lambda pair: -pair[1]):
            print(f"  [{r['id']}] {r['state']} -- last_verified={r['last_verified']} ({age_days}d old)")
            print(f"    citation: {r.get('citation')!r} -- {r.get('citation_url')}")
    if unparseable:
        print(f"\nUNPARSEABLE last_verified ({len(unparseable)}) -- treat as stale until fixed:")
        for r in unparseable:
            print(f"  [{r['id']}] {r['state']} -- last_verified={r.get('last_verified')!r}")
    if missing:
        print(f"\nMISSING last_verified entirely ({len(missing)}) -- treat as stale until fixed:")
        for r in missing:
            print(f"  [{r['id']}] {r['state']}")

    if not (stale or unparseable or missing):
        print("\nPASS -- every record is within the freshness bar.")


if __name__ == "__main__":
    main()
