#!/usr/bin/env python3
"""
Advisory-only detector for the "static site and Worker deploy through separate
pipelines" prevention-register class (instance: 2026-07-09, South Dakota/Hawaii/
Oklahoma silently rejected real signups because the deployed Worker's bundled
cpa_deadlines.json predated their addition, even though the GitHub-Pages-deployed
static site already showed those states' pages correctly).

The static site (docs/) redeploys automatically on every push via GitHub Pages.
The Worker does NOT -- it only picks up worker/src/*.ts (and its bundled JSON
data) when someone explicitly runs `wrangler deploy`. This script does not
live-probe the deployed Worker (that would burn the real per-IP rate limit
budget); it compares local git history instead: has ANYTHING under worker/src/
changed since the commit recorded in worker/.last_deploy_commit?

AuditLab BILL-7 (2026-08-09, restated with a live counterexample 2026-08-13):
the original version of this script compared only worker/src/cpa_deadlines.json
against the deploy marker, then printed a claim about "the Worker bundle" --
the whole directory, not the one file it actually checked. Demonstrated false-
PASS window: between two real commits today, deadline.ts/emails.ts/index.ts/
store.ts were all undeployed (including the staleness guard itself) while the
old check would have reported "Worker bundle should be current", because none
of those changes touched cpa_deadlines.json specifically. Now scoped to the
whole worker/src/ tree, so the claim matches what's actually checked.

Advisory only, same treatment as every other detector in this project: it flags
a candidate for a human to check, it does not gate a build or a push. Update
worker/.last_deploy_commit's contents after every real `wrangler deploy`.

Usage:
    python scripts/worker_deploy_staleness_check.py
"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LAST_DEPLOY_FILE = ROOT / "worker" / ".last_deploy_commit"
WORKER_SRC_DIR = "worker/src"


def git(*args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=ROOT, capture_output=True, text=True, check=True
    ).stdout.strip()


def main() -> None:
    if not LAST_DEPLOY_FILE.exists():
        print(
            f"ADVISORY: {LAST_DEPLOY_FILE} does not exist -- cannot check staleness. "
            f"Create it with the commit hash of the last real `wrangler deploy`."
        )
        sys.exit(0)

    last_deploy_commit = LAST_DEPLOY_FILE.read_text(encoding="utf-8").strip()
    last_src_commit = git("log", "--format=%H", "-1", "--", WORKER_SRC_DIR)

    if not last_src_commit:
        print(f"ADVISORY: could not find any commit touching {WORKER_SRC_DIR}/.")
        sys.exit(0)

    # Is last_src_commit an ancestor of (or equal to) last_deploy_commit? If so,
    # nothing under worker/src/ has changed since the deploy the marker records
    # -- not stale. If NOT an ancestor, something in the bundle changed after
    # the last deploy.
    result = subprocess.run(
        ["git", "merge-base", "--is-ancestor", last_src_commit, last_deploy_commit],
        cwd=ROOT,
    )
    if result.returncode == 0:
        print(
            f"PASS -- no file under {WORKER_SRC_DIR}/ has changed since the last recorded "
            f"deploy ({last_deploy_commit[:7]}). Worker bundle should be current."
        )
    else:
        undeployed = git(
            "log", "--format=%h %s", f"{last_deploy_commit}..HEAD", "--", WORKER_SRC_DIR
        )
        undeployed_lines = undeployed.splitlines() if undeployed else []
        files_touched = git(
            "diff", "--name-only", last_deploy_commit, "HEAD", "--", WORKER_SRC_DIR
        )
        files_lines = files_touched.splitlines() if files_touched else []
        print(
            f"ADVISORY: {WORKER_SRC_DIR}/ changed AFTER the last recorded deploy "
            f"({last_deploy_commit[:7]}) -- the live Worker may be running stale code or "
            f"stale bundled data (this is the exact class that broke South Dakota/Hawaii/"
            f"Oklahoma signups on 2026-07-09). Run `wrangler deploy` from worker/, then "
            f"update worker/.last_deploy_commit with the new HEAD hash.\n"
            f"  Undeployed commits touching {WORKER_SRC_DIR}/ ({len(undeployed_lines)}):"
        )
        for line in undeployed_lines:
            print(f"    {line}")
        print(f"  Files changed: {', '.join(files_lines) if files_lines else '(none found)'}")


if __name__ == "__main__":
    main()
