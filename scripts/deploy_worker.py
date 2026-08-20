#!/usr/bin/env python3
"""Deploy the Worker AND update `worker/.last_deploy_commit` in one step.

## Why this exists

`worker/.last_deploy_commit` is how this repo answers "is the deployed
Worker bundle current with the data files?" -- `worker_deploy_staleness_check.py`
reads it, and `preship_gate.py` surfaces the result as a ship advisory. It
is load-bearing: a stale marker means a future session cannot tell whether
a data-correctness fix actually reached production.

But NOTHING wrote it automatically. It was a manual step, documented in
`prevention_register.md` and in the deploy notes, and therefore a step that
gets skipped -- which is exactly what happened across the 2026-07-31 ship
sequence (four production deploys, marker left at a commit from days
earlier). Documenting a manual step harder does not fix a step that gets
forgotten; removing the human from it does.

So: deploy through this, and the marker cannot drift.

## Behaviour worth knowing

  * PRODUCTION deploys update the marker. PREVIEW deploys do NOT -- the
    marker tracks what is live in production, and letting a preview deploy
    stamp it would make it actively lie.
  * A dirty `worker/` tree ABORTS by default. The marker records a commit
    hash as shorthand for "this code is deployed"; deploying uncommitted
    code makes that claim false. `--allow-dirty` overrides for genuine
    emergencies, and deliberately skips the marker update rather than
    writing something untrue.
  * The marker is only written if wrangler actually succeeded.
  * PRODUCTION deploys also REFUSE if any repo migration hasn't been applied
    to the remote D1 database yet -- AuditLab DEPLOY-2 (2026-08-20): the
    dirty-tree guard only answers "is this code committed", never "is the
    database ready for it". A committed-but-not-yet-migrated schema change
    (SMS-2, same day) shipped straight through that gap: the code referenced
    columns migration 0068 was supposed to add first, but nothing checked
    whether it actually had. Two of the three failure modes were loud (SQL
    errors on live writes), but the reminder-send read path degraded
    SILENTLY -- `SELECT *` doesn't error on a missing column, so it just
    read the new field as undefined and "failed closed" for the wrong
    reason, meaning real subscribers quietly stopped getting texted with no
    crash to notice by. `--allow-dirty` and `--skip-migration-check` both
    skip this (same "genuine emergency, and the marker doesn't get written"
    posture as the dirty-tree override).

Usage:
    python3 scripts/deploy_worker.py                     # production
    python3 scripts/deploy_worker.py --preview           # preview (no marker write)
    python3 scripts/deploy_worker.py --allow-dirty       # emergency, no marker write
    python3 scripts/deploy_worker.py --skip-migration-check   # emergency override only
"""

from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WORKER_DIR = ROOT / "worker"
MARKER = WORKER_DIR / ".last_deploy_commit"


def exe(name: str) -> str:
    """Resolve a command to a real executable path.

    Needed because this repo is developed on Windows, where `npx` is
    `npx.cmd` and `git` may be `git.exe`: subprocess.run() without
    shell=True does NOT consult PATHEXT, so a bare "npx" raises
    FileNotFoundError. That is exactly how this script failed the first
    time it was used for real (2026-07-31) -- which would have pushed
    whoever hit it straight back to running wrangler by hand, i.e. back to
    the forgotten-marker problem this script exists to remove. A deploy
    tool that only works on one platform is a deploy tool people route
    around.
    """
    found = shutil.which(name)
    if found is None:
        raise SystemExit(f"Could not find '{name}' on PATH. Is Node/git installed?")
    return found


def run(cmd: list[str], cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [exe(cmd[0]), *cmd[1:]], cwd=cwd, capture_output=True, text=True, encoding="utf-8"
    )


def worker_tree_dirty() -> bool:
    r = run(["git", "status", "--porcelain", "--", "worker/"], ROOT)
    return bool(r.stdout.strip())


def unapplied_migrations() -> list[str] | None:
    """Returns the names of repo migrations not yet applied to the remote D1
    database, or None if the check itself could not run (e.g. no network,
    no D1 permission) -- distinct from an empty list (checked, genuinely
    none pending). AuditLab DEPLOY-2: `wrangler d1 migrations list --remote`
    exits 0 whether or not migrations are pending, so this parses the
    printed table rather than the exit code -- confirmed live against both
    states (a real pending migration, and a clean tree) before relying on
    it. `--json` is not supported by this wrangler subcommand, so it's a
    plain substring/regex read of the human-readable table, same
    "best-effort, honest about it" posture as this repo's other CLI-output
    parsers."""
    r = run(["npx", "wrangler", "d1", "migrations", "list", "deadlineradar", "--remote"], WORKER_DIR)
    combined = r.stdout + r.stderr
    if "No migrations to apply" in combined:
        return []
    if "Migrations to be applied" not in combined:
        # Neither expected phrase appeared -- an auth/network failure or an
        # unrecognised wrangler output format. Fail OPEN on the check
        # itself (can't prove anything either way) but say so loudly,
        # same as this file's own deploy-failure guidance below: never
        # silently assume success on an inconclusive signal.
        return None
    names = re.findall(r"\b(\d{4}_\S+?\.sql)\b", combined)
    return names


def head_commit() -> str:
    return run(["git", "rev-parse", "HEAD"], ROOT).stdout.strip()


def main() -> int:
    ap = argparse.ArgumentParser(description="Deploy the Worker and keep .last_deploy_commit honest.")
    ap.add_argument("--preview", action="store_true", help="deploy to preview (marker NOT updated)")
    ap.add_argument("--allow-dirty", action="store_true", help="deploy with uncommitted worker changes (marker NOT updated)")
    ap.add_argument("--skip-migration-check", action="store_true", help="emergency override for the pending-migration guard")
    args = ap.parse_args()

    dirty = worker_tree_dirty()
    if dirty and not args.allow_dirty:
        print("REFUSING: worker/ has uncommitted changes.", file=sys.stderr)
        print("The deploy marker records a commit hash as shorthand for 'this code is deployed'.", file=sys.stderr)
        print("Deploying uncommitted code would make that claim false. Commit first,", file=sys.stderr)
        print("or use --allow-dirty (which will NOT update the marker).", file=sys.stderr)
        return 1

    # AuditLab DEPLOY-2 (2026-08-20): production only -- a preview deploy
    # doesn't touch the real database, and the emergency override exists
    # for exactly the case where this check itself can't be trusted (no
    # network, no D1 permission on the current token, wrangler output
    # format changed).
    if not args.preview and not args.skip_migration_check:
        pending = unapplied_migrations()
        if pending is None:
            print(
                "WARNING: could not determine whether all migrations are applied to the remote "
                "database (wrangler d1 migrations list --remote gave an unrecognised result -- "
                "no network, no D1 permission on this token, or its output format changed).",
                file=sys.stderr,
            )
            print(
                "Proceeding is your call, not a verified-safe one. Re-run with --skip-migration-check "
                "to acknowledge and continue, or check manually first.",
                file=sys.stderr,
            )
            return 1
        if pending:
            print("REFUSING: the remote database is missing migration(s) this deploy's code may depend on:", file=sys.stderr)
            for name in pending:
                print(f"  - {name}", file=sys.stderr)
            print(
                "\nAuditLab DEPLOY-2 (2026-08-20): shipping code before its migration is applied can fail "
                "LOUDLY (a SQL error on a live write) or SILENTLY (a SELECT * read path that degrades "
                "without crashing) -- the silent case is the dangerous one, since nothing signals it until "
                "a person notices the feature quietly stopped working. Apply the migration first "
                "(wrangler d1 migrations apply deadlineradar --remote), or if this deploy genuinely does "
                "not depend on the pending migration, re-run with --skip-migration-check.",
                file=sys.stderr,
            )
            return 1

    cmd = ["npx", "wrangler", "deploy"]
    if args.preview:
        cmd += ["--config", "wrangler.preview.toml"]

    print(f"$ {' '.join(cmd)}  (cwd=worker)")
    proc = subprocess.run([exe(cmd[0]), *cmd[1:]], cwd=WORKER_DIR)
    if proc.returncode != 0:
        print("\nDeploy FAILED -- marker left unchanged.", file=sys.stderr)
        print(
            "\nIF THE ERROR MENTIONED /zones/.../workers/routes WITH 'Authentication error"
            " [code: 10000]',\n"
            "the SCRIPT almost certainly uploaded fine and only the ROUTE binding call failed.\n"
            "That happened on 2026-07-31: the API token lacks Zone > Workers Routes: Edit, but the\n"
            "routes for deadline-radar.com/api/* already existed, so nothing actually needed\n"
            "changing and the new code went live anyway.\n"
            "\n"
            "DO NOT assume either outcome. Fetch the deployed bundle and grep it -- that is the\n"
            "only ground truth (see HANDOFF's verification traps):\n"
            "  curl -H \"Authorization: Bearer $CLOUDFLARE_API_TOKEN\" \\\n"
            "    https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/deadlineradar-api\n"
            "If your change IS in that bundle, the deploy landed: write HEAD into\n"
            "worker/.last_deploy_commit by hand, or the marker silently lies in the other\n"
            "direction (code deployed, marker stale) -- the exact drift this script exists to stop.",
            file=sys.stderr,
        )
        return proc.returncode

    if args.preview:
        print("\nPreview deploy done. Marker deliberately NOT updated (it tracks production).")
        return 0
    if dirty:
        print("\nDeploy done, but marker NOT updated because the tree was dirty (--allow-dirty).")
        return 0

    commit = head_commit()
    MARKER.write_text(commit + "\n", encoding="utf-8")
    print(f"\nDeploy done. Updated worker/.last_deploy_commit -> {commit[:7]}")
    print("Remember to COMMIT the marker change so the repo reflects reality.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
