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

MON-3 (2026-08-20): 17 days of real staleness here turned out to be a
missing sync step (data/rule_change_coverage_stats.json was supposed to be
copied in from DiffLab's own output "each capture cycle," per generate.py's
own comment, and that copy ran exactly once, at initial build) -- DiffLab's
actual monitor never stopped (20/20 capture cycles, confirmed via its own
HANDOFF). scripts/sync_rule_change_coverage_stats.py now does that copy.

Orchestrator's ruling on hard-gating this (refined after the root cause
came in): DiffLab's own monitor uptime genuinely isn't fixable from inside
this repo, so THAT dependency stays advisory-only -- same bar as MON-3's
original disclosure-only fix. But the sync step failing silently again IS
fixable from inside this repo in minutes (re-run the sync script), the
same bar every other hard gate here already uses. So: promoted to a hard
gate in preship_gate.py (check_rule_change_monitoring_currency(), BADGE-1's
own promotion pattern) -- but the check itself is unchanged; it was always
measuring "is the LOCAL file stale," never DiffLab's uptime directly. Only
the SEVERITY changed, from advisory to blocking. collect_staleness() below
is the split-out pure logic BADGE-1's own promotion of
cpe_hours_staleness_check.py established the pattern for -- so
preship_gate.py can reuse it without re-implementing the date math.

Still runnable standalone; still prints the same report either way.
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


def collect_staleness(repo_root: Path) -> dict:
    """Pure logic, no printing -- split out (BADGE-1's own pattern) so
    preship_gate.py's hard gate can reuse this instead of re-implementing
    the date math. Returns a dict with `status` ('ok' | 'missing' |
    'unparseable' | 'stale' | 'no_data_file') and, when relevant,
    `age_hours` / `raw` / `cadence`."""
    data_path = repo_root / "data" / "rule_change_coverage_stats.json"
    if not data_path.exists():
        return {"status": "no_data_file"}
    stats = json.loads(data_path.read_text(encoding="utf-8"))

    raw = stats.get("last_checked_at")
    if not raw:
        return {"status": "missing"}

    try:
        checked = datetime.fromisoformat(raw)
        if checked.tzinfo is None:
            checked = checked.replace(tzinfo=timezone.utc)
    except ValueError:
        return {"status": "unparseable", "raw": raw}

    age_hours = (datetime.now(timezone.utc) - checked).total_seconds() / 3600
    cadence = stats.get("capture_cadence", "unknown cadence")
    status = "stale" if age_hours > STALENESS_THRESHOLD_HOURS else "ok"
    return {"status": status, "age_hours": age_hours, "raw": raw, "cadence": cadence}


def main() -> None:
    repo_root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent
    now = datetime.now(timezone.utc)
    print(f"Rule-change monitoring staleness check -- {now.isoformat()} (threshold {STALENESS_THRESHOLD_HOURS}h)")

    result = collect_staleness(repo_root)
    status = result["status"]

    if status == "no_data_file":
        print(f"\nMISSING data/rule_change_coverage_stats.json entirely -- treat as stale until fixed.")
        return
    if status == "missing":
        print(f"\nMISSING last_checked_at entirely -- treat as stale until fixed.")
        return
    if status == "unparseable":
        print(f"\nUNPARSEABLE last_checked_at ({result['raw']!r}) -- treat as stale until fixed.")
        return

    print(f"  last_checked_at: {result['raw']}   age: {result['age_hours']:.1f}h   claimed cadence: {result['cadence']!r}")
    if status == "stale":
        print(
            f"\nSTALE -- {result['age_hours']:.1f}h since the last capture, past the {STALENESS_THRESHOLD_HOURS}h bar. "
            f"/rule-changes/ is still asserting \"{result['cadence']}\" against this date -- run "
            f"scripts/sync_rule_change_coverage_stats.py before the next ship, or update the page's claim if the "
            f"cadence has genuinely changed."
        )
    else:
        print(f"\nPASS -- within the freshness bar.")


if __name__ == "__main__":
    main()
