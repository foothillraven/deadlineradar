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

Usage:
    python3 scripts/deploy_worker.py                 # production
    python3 scripts/deploy_worker.py --preview       # preview (no marker write)
    python3 scripts/deploy_worker.py --allow-dirty   # emergency, no marker write
"""

from __future__ import annotations

import argparse
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


def head_commit() -> str:
    return run(["git", "rev-parse", "HEAD"], ROOT).stdout.strip()


def main() -> int:
    ap = argparse.ArgumentParser(description="Deploy the Worker and keep .last_deploy_commit honest.")
    ap.add_argument("--preview", action="store_true", help="deploy to preview (marker NOT updated)")
    ap.add_argument("--allow-dirty", action="store_true", help="deploy with uncommitted worker changes (marker NOT updated)")
    args = ap.parse_args()

    dirty = worker_tree_dirty()
    if dirty and not args.allow_dirty:
        print("REFUSING: worker/ has uncommitted changes.", file=sys.stderr)
        print("The deploy marker records a commit hash as shorthand for 'this code is deployed'.", file=sys.stderr)
        print("Deploying uncommitted code would make that claim false. Commit first,", file=sys.stderr)
        print("or use --allow-dirty (which will NOT update the marker).", file=sys.stderr)
        return 1

    cmd = ["npx", "wrangler", "deploy"]
    if args.preview:
        cmd += ["--config", "wrangler.preview.toml"]

    print(f"$ {' '.join(cmd)}  (cwd=worker)")
    proc = subprocess.run([exe(cmd[0]), *cmd[1:]], cwd=WORKER_DIR)
    if proc.returncode != 0:
        print("\nDeploy FAILED -- marker left unchanged.", file=sys.stderr)
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
