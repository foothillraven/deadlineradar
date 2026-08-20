#!/usr/bin/env python3
"""Sync DiffLab's live coverage_stats.json into this repo's data/ (MON-3 root cause).

## Why this exists

`/rule-changes/` makes this site's strongest freshness claim -- "watching
N primary sources ... daily" -- backed by `data/rule_change_coverage_stats.json`.
generate.py's own comment on that path says it's "copied in from
Orchestrator/reg_change_events/coverage_stats.json each capture cycle."
`git log` shows that copy happened exactly once, at initial build
(2026-08-03), and never again -- so the claim quietly went 17 days stale
while DiffLab's own monitor kept running fine the whole time (confirmed via
its own HANDOFF: 20/20 capture cycles, no gaps). MON-3's disclosure fix
(2026-08-20) made the site stop OVERCLAIMING freshness it didn't have; this
script is the other half -- making the freshness claim true again by
actually doing the copy DiffLab was never responsible for doing itself
(read-only on this side, per the orchestrator's ruling: DiffLab does not
write into this repo).

## Why a sync script, not a build-time read

generate.py reads every other data source from data/ -- checked into this
repo, versioned, gate-verified. Having it read
Orchestrator/reg_change_events/coverage_stats.json directly at build time
would make a build's output depend on a path OUTSIDE this repo tree, breaking
that invariant (a checkout without sibling access to Orchestrator/ couldn't
build the same page) and blurring exactly the "live external state vs.
this repo's own versioned data" line whose blurring caused the original bug
(a manual copy step that silently stopped happening, unnoticed for 17 days).
A small script that copies-then-you-run-generate.py keeps generate.py itself
simple, self-contained, and reproducible from data/ alone -- same posture as
every other "advisory tells you to go fix something" pattern in this repo,
just with an actual fix now available to run instead of a fact to accept.

## Usage

    python scripts/sync_rule_change_coverage_stats.py [repo_root]

Exit 0 on a successful sync (source found, valid JSON, written). Exit 1 if
the source file is missing or unparseable -- refuses to overwrite a working
local file with nothing, same "a stale number is worse than no number, but
don't destroy what you have to chase freshness" posture as every staleness
check in this repo. Prints whether the write actually changed anything
(idempotent re-runs report cleanly instead of claiming a phantom sync).
"""
import json
import sys
from pathlib import Path

# Two directories above this repo's root (b3_saas/deadlineradar) -- same
# sibling-project layout as the .secrets/ path SEC-4 fixed tonight, and
# genuinely read-only here: this script never writes back to Orchestrator/.
DIFFLAB_SOURCE_PATH = Path(r"C:\Users\Devin\Orchestrator\reg_change_events\coverage_stats.json")


def main() -> int:
    repo_root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent
    dest_path = repo_root / "data" / "rule_change_coverage_stats.json"

    if not DIFFLAB_SOURCE_PATH.exists():
        print(f"REFUSING: DiffLab's coverage_stats.json not found at {DIFFLAB_SOURCE_PATH} "
              f"-- nothing synced, dest left untouched.", file=sys.stderr)
        return 1

    try:
        source_data = json.loads(DIFFLAB_SOURCE_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as e:
        print(f"REFUSING: could not read/parse {DIFFLAB_SOURCE_PATH} ({e}) "
              f"-- nothing synced, dest left untouched.", file=sys.stderr)
        return 1

    required_keys = {"sources_monitored", "jurisdictions_monitored", "last_checked_at"}
    missing = required_keys - source_data.keys()
    if missing:
        print(f"REFUSING: source is missing required key(s) {sorted(missing)} "
              f"-- nothing synced, dest left untouched.", file=sys.stderr)
        return 1

    old_text = dest_path.read_text(encoding="utf-8") if dest_path.exists() else None
    new_text = json.dumps(source_data, indent=2, ensure_ascii=False) + "\n"

    if old_text == new_text:
        print(f"No change -- dest already matches source "
              f"(last_checked_at={source_data['last_checked_at']}).")
        return 0

    dest_path.write_text(new_text, encoding="utf-8", newline="\n")
    print(f"Synced {DIFFLAB_SOURCE_PATH} -> {dest_path}")
    print(f"  last_checked_at:            {source_data['last_checked_at']}")
    print(f"  clean_monitoring_streak_days: {source_data.get('clean_monitoring_streak_days')}")
    print(f"  full_capture_count:          {source_data.get('full_capture_count')}")
    print("Run `python generate.py` and commit both data/rule_change_coverage_stats.json "
          "and the regenerated docs/ to actually ship this.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
