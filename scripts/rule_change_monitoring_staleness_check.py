#!/usr/bin/env python3
"""Rule-change monitoring staleness check (2026-08-06, AuditLab MON-1).

`/rule-changes/` makes this site's strongest freshness claim -- "watching
500 primary sources across all 55 U.S. jurisdictions daily", with a real,
build-time-derived "Last checked <date>" pulled from
`data/rule_change_coverage_stats.json`'s `last_checked_at`. Every other
dataset on this site has a decay mechanism (`cpa_deadlines` pauses signups
past its threshold, `cpe_hours`/`reinstatement` have this same advisory
pattern, `mobility_rules` downgrades verdicts via `isRuleStale()`) -- this
one had a perfectly machine-readable timestamp and nothing that read it. If
the monitor silently stops, this JSON freezes and the page keeps asserting
"daily" against a frozen date indefinitely, with no way to tell "benign
(stats regenerate on build, not on capture)" from "the monitor died".

Advisory only: prints a report, never blocks a build or exits non-zero on
its own -- same posture as cpe_hours_staleness_check.py, which this mirrors.
`rule_change_coverage_stats.json` is inlined into /rule-changes/ at build
time by generate.py; there is no Worker-side runtime path this could gate.

Usage:
    python scripts/rule_change_monitoring_staleness_check.py [repo_root]
"""
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

# A small multiple of the "daily" capture cadence the page itself claims --
# loose enough that ordinary build/deploy timing (stats computed once,
# published on the next build, not necessarily same-day) doesn't false-
# positive, tight enough that a monitor that's actually stopped gets caught
# well before the page's own claim goes stale by days. Not tied to any other
# dataset's STALENESS_THRESHOLD_DAYS -- this is capture-cadence staleness,
# a different question from citation/rule-verification staleness.
STALENESS_THRESHOLD_HOURS = 48


def main() -> None:
    repo_root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent
    data_path = repo_root / "data" / "rule_change_coverage_stats.json"
    stats = json.loads(data_path.read_text(encoding="utf-8"))

    now = datetime.now(timezone.utc)
    raw = stats.get("last_checked_at")

    print(f"Rule-change monitoring staleness check -- {now.isoformat()} (threshold {STALENESS_THRESHOLD_HOURS}h)")

    if not raw:
        print(f"\nMISSING last_checked_at entirely -- treat as stale until fixed.")
        return

    try:
        checked = datetime.fromisoformat(raw)
        if checked.tzinfo is None:
            checked = checked.replace(tzinfo=timezone.utc)
    except ValueError:
        print(f"\nUNPARSEABLE last_checked_at ({raw!r}) -- treat as stale until fixed.")
        return

    age_hours = (now - checked).total_seconds() / 3600
    cadence = stats.get("capture_cadence", "unknown cadence")
    print(f"  last_checked_at: {raw}   age: {age_hours:.1f}h   claimed cadence: {cadence!r}")

    if age_hours > STALENESS_THRESHOLD_HOURS:
        print(
            f"\nSTALE -- {age_hours:.1f}h since the last capture, past the {STALENESS_THRESHOLD_HOURS}h bar. "
            f"/rule-changes/ is still asserting \"{cadence}\" against this date -- confirm the monitor is "
            f"still running before the next ship, or update the page's claim if the cadence has genuinely changed."
        )
    else:
        print(f"\nPASS -- within the freshness bar.")


if __name__ == "__main__":
    main()
