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


def fetch_confirmed_subscribers() -> list[dict]:
    sql = (
        "SELECT id, email, state_slug, deadline_fields, confirmed_at "
        "FROM subscribers WHERE status = 'confirmed'"
    )
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

    print(f"silent-dropped-subscribers-check @ {today.isoformat()}")
    print(f"  confirmed subscribers checked: {len(subscribers)}")
    print(f"  resolve to NO computable deadline (will never be reminded): {len(dropped)}")
    if dropped:
        print()
        print("  These subscribers believe they are covered. Nothing on their end reveals")
        print("  otherwise. Each needs either a fields backfill, a re-subscribe prompt, or")
        print("  (if their state genuinely can't be computed, e.g. legacy test rows) removal")
        print("  from this list by design -- not silence.")
        print()
        for row in dropped:
            print(f"    - {row['email']}  state={row['state_slug']}  "
                  f"fields={row.get('deadline_fields')}  confirmed_at={row.get('confirmed_at')}")
        sys.exit(1)
    sys.exit(0)


if __name__ == "__main__":
    main()
