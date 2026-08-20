#!/usr/bin/env python3
"""
Monitoring surface for AuditLab's SILENT-1 finding (2026-08-19): confirmed
subscribers whose deadline_fields resolve to NO computable deadline get no
reminder, ever, with nothing on their end (or ours, until now) to reveal it.
Making that failure visible here is the fix AuditLab's report offered as
the alternative to a broadcast email to existing subscribers -- see
inbox/SCAN_FINDINGS_20260819_auditlab_SILENT1_florida_subscribers_silently_dropped.md.

Queries confirmed subscribers (one read-only live D1 SELECT) and runs each
one through reminders/scheduler.py's own compute_subscriber_deadline() --
the exact function the real reminder cron uses -- so a silent drop here IS
a silent drop in production, not a re-implementation that could disagree.

2026-08-20 (Devin's own "wire it into a surface" directive): also reads
`silent_drop_log` (migration 0067) -- the durable table
worker/src/scheduler.ts's runReminderPass() now upserts into on every real
production cron run. That table is the actual dashboard: it answers "how
long has this subscriber been silently dropped" and "did a fix land,
however briefly", which a point-in-time live check like the one above
cannot. This script reports both: the live snapshot (is it broken RIGHT
NOW) and the persisted history (is it broken according to the real cron's
own runs, and since when).

Usage:
    python scripts/silent_dropped_subscribers_check.py

Requires CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment
(same as scripts/firm_admin_report.py) and must be run from the repo root
so `npx wrangler` resolves from worker/.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
from datetime import date, timezone, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WORKER_DIR = ROOT / "worker"
sys.path.insert(0, str(ROOT))

from reminders.scheduler import compute_subscriber_deadline  # noqa: E402


def _run_d1_query(sql: str) -> list[dict]:
    npx = shutil.which("npx")
    if npx is None:
        raise SystemExit("Could not find `npx` on PATH -- required to run `wrangler d1 execute`.")
    result = subprocess.run(
        [npx, "wrangler", "d1", "execute", "deadlineradar", "--remote", "--json",
         "--command", sql],
        cwd=WORKER_DIR, capture_output=True, text=True,
    )
    if result.returncode != 0:
        raise SystemExit(
            f"Live D1 query failed (exit {result.returncode}). stderr:\n{result.stderr}\n"
            f"Check CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID are set and try again -- "
            f"this script does not fall back to a guess."
        )
    payload = json.loads(result.stdout)
    return payload[0]["results"] if payload and payload[0].get("results") else []


def fetch_confirmed_subscribers() -> list[dict]:
    return _run_d1_query(
        "SELECT id, email, state_slug, deadline_fields, confirmed_at FROM subscribers WHERE status = 'confirmed'"
    )


def fetch_silent_drop_log() -> list[dict]:
    """The durable table runReminderPass() (worker/src/scheduler.ts,
    migration 0067) upserts on every real production cron run -- the
    persisted half of this report, not a live re-check."""
    return _run_d1_query(
        "SELECT subscriber_id, email, state_slug, reason, first_detected_at, last_seen_at, resolved_at "
        "FROM silent_drop_log WHERE resolved_at IS NULL ORDER BY first_detected_at ASC"
    )


def main() -> None:
    today = datetime.now(timezone.utc).date()
    subscribers = fetch_confirmed_subscribers()
    dropped = []
    for row in subscribers:
        try:
            fields = json.loads(row.get("deadline_fields") or "{}")
        except json.JSONDecodeError:
            fields = {}
        subscriber = {"state_slug": row["state_slug"], "deadline_fields": fields}
        result = compute_subscriber_deadline(subscriber, today)
        if result is None:
            dropped.append(row)

    open_log_rows = fetch_silent_drop_log()

    print(f"silent-dropped-subscribers-check @ {today.isoformat()}")
    print(f"  confirmed subscribers checked (live, right now): {len(subscribers)}")
    print(f"  resolve to NO computable deadline (live, right now): {len(dropped)}")
    print(f"  open in silent_drop_log (persisted, per the real cron's own runs): {len(open_log_rows)}")

    if dropped:
        print()
        print("  LIVE SNAPSHOT -- these subscribers believe they are covered. Nothing on")
        print("  their end reveals otherwise. Each needs either a fields backfill, a")
        print("  re-subscribe prompt, or (if their state genuinely can't be computed, e.g.")
        print("  legacy test rows) removal from this list by design -- not silence.")
        print()
        for row in dropped:
            print(f"    - {row['email']}  state={row['state_slug']}  "
                  f"fields={row.get('deadline_fields')}  confirmed_at={row.get('confirmed_at')}")

    if open_log_rows:
        print()
        print("  PERSISTED HISTORY -- open since the real cron first saw each one:")
        print()
        for row in open_log_rows:
            print(f"    - {row['email']}  state={row['state_slug']}  reason={row['reason']}  "
                  f"first_detected_at={row['first_detected_at']}  last_seen_at={row['last_seen_at']}")

    sys.exit(1 if (dropped or open_log_rows) else 0)


if __name__ == "__main__":
    main()
