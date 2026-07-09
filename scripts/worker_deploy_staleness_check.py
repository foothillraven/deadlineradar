#!/usr/bin/env python3
"""
Advisory-only detector for the "static site and Worker deploy through separate
pipelines" prevention-register class (instance: 2026-07-09, South Dakota/Hawaii/
Oklahoma silently rejected real signups because the deployed Worker's bundled
cpa_deadlines.json predated their addition, even though the GitHub-Pages-deployed
static site already showed those states' pages correctly).

The static site (docs/) redeploys automatically on every push via GitHub Pages.
The Worker does NOT -- it only picks up a new cpa_deadlines.json when someone
explicitly runs `wrangler deploy`. This script does not live-probe the deployed
Worker (that would burn the real per-IP rate limit budget); it compares local
git history instead: has worker/src/cpa_deadlines.json changed since the commit
recorded in worker/.last_deploy_commit?

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
DATA_FILE = "worker/src/cpa_deadlines.json"


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
    last_data_commit = git("log", "--format=%H", "-1", "--", DATA_FILE)

    if not last_data_commit:
        print(f"ADVISORY: could not find any commit touching {DATA_FILE}.")
        sys.exit(0)

    # Is last_data_commit an ancestor of (or equal to) last_deploy_commit? If so,
    # the deployed data is at least as new as the data file's own history --
    # not stale. If NOT an ancestor, the data changed after the last deploy.
    result = subprocess.run(
        ["git", "merge-base", "--is-ancestor", last_data_commit, last_deploy_commit],
        cwd=ROOT,
    )
    if result.returncode == 0:
        print(
            f"PASS -- {DATA_FILE} has not changed since the last recorded deploy "
            f"({last_deploy_commit[:7]}). Worker bundle should be current."
        )
    else:
        data_summary = git("log", "--format=%h %s", "-1", last_data_commit)
        print(
            f"ADVISORY: {DATA_FILE} changed AFTER the last recorded deploy "
            f"({last_deploy_commit[:7]}) -- most recent data-touching commit: "
            f"{data_summary}. The live Worker may be serving stale state data "
            f"(this is the exact class that broke South Dakota/Hawaii/Oklahoma "
            f"signups on 2026-07-09). Run `wrangler deploy` from worker/, then "
            f"update worker/.last_deploy_commit with the new HEAD hash."
        )


if __name__ == "__main__":
    main()
