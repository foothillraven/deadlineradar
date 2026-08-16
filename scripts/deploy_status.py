"""Report whether the deployed Worker is behind HEAD, and whether it MATTERS.

Motivation: the static site (docs/, Pages) and the Worker deploy on separate
triggers, so worker/src/ can move ahead of `worker/.last_deploy_commit` silently.
That happened on 2026-08-14: a data fix landed in the mirror after the last
deploy. It turned out to be inert -- the drifted fields were ones no worker code
reads -- but nothing in the repo could tell me that, so I had to grep by hand.

This does that grep automatically. The behavioural/inert split is the whole point:
a plain "you have undeployed changes" warning fires constantly (worker deploys
legitimately lag static ones) and would train a reader to ignore it. Only the
BEHAVIOURAL verdict is worth acting on.

Not a build gate: deploy lag is a normal, frequent state, not a defect. Hard-
failing the build on it would be exactly the noise this project keeps rejecting.

Usage: python scripts/deploy_status.py   (exit 0 always; read the verdict)
"""
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MARKER = ROOT / "worker" / ".last_deploy_commit"
WORKER_SRC = ROOT / "worker" / "src"


def git(*args):
    """Always decode git's output as UTF-8 explicitly.

    text=True decodes with the locale codec (cp1252 on this box), which turns
    every em-dash in the repo's prose into mojibake. That silently made ~40
    unchanged records compare as different the first time this script ran --
    a phantom drift report. Bytes in, utf-8 out, no newline translation.
    """
    out = subprocess.run(["git", "-C", str(ROOT), *args],
                         capture_output=True).stdout
    return out.decode("utf-8", errors="strict").replace("\r\n", "\n").strip()


def git_ok(*args):
    """True when the git command succeeds. Use where the EXIT CODE is the
    answer -- git() keeps stdout only, so a failure there reads as empty
    output, which several callers cannot distinguish from a clean result."""
    return subprocess.run(["git", "-C", str(ROOT), *args],
                          capture_output=True).returncode == 0


def changed_json_keys(deployed, path):
    """Top-level record keys whose values differ between deployed and HEAD."""
    rel = str(path.relative_to(ROOT)).replace("\\", "/")
    old_raw = git("show", f"{deployed}:{rel}")
    if not old_raw:
        return None  # file is new since deploy
    try:
        old = json.loads(old_raw)
        new = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None

    def index(doc):
        """{key: record}, or None when this shape yields nothing comparable.

        AuditLab DEPLOY-1: the original returned {} for any shape it could not
        walk. An empty dict slipped past the `keys is None` guard, produced an
        empty key set, and the file was then appended to NEITHER the
        behavioural nor the inert list -- it vanished from the report while the
        headline still read "nothing the worker serves has changed". Two of the
        four mirrors are dict-shaped (firm_mobility_rules.json keyed by slug,
        reg_change_events.json as {_meta, events}) and BOTH are imported by
        worker code, so drift in either is behavioural by definition.

        Returning None routes unknown shapes to behavioural, which is the safe
        direction: it can over-warn, never under-warn. Deliberately not teaching
        this function each dict shape -- precise field-level verdicts only earn
        their keep for cpa_deadlines.json, where most fields are display-only.
        For a file compiled wholesale into the Worker, "it changed" IS the
        answer.
        """
        recs = doc.get("records") if isinstance(doc, dict) else doc
        if not isinstance(recs, list):
            return None
        out = {r.get("id") or r.get("state_slug") or i: r
               for i, r in enumerate(recs) if isinstance(r, dict)}
        return out or None

    o, n = index(old), index(new)
    if o is None or n is None:
        return None  # not comparable -> caller treats as behavioural
    keys = set()
    for rid in set(o) | set(n):
        a, b = o.get(rid, {}), n.get(rid, {})
        for k in set(a) | set(b):
            if a.get(k) != b.get(k):
                keys.add(k)
    return keys


def main():
    if not MARKER.exists():
        print("no deploy marker; cannot assess drift")
        return 0
    deployed = MARKER.read_text(encoding="utf-8").strip()

    # AuditLab DEPLOY-1(B): git() keeps stdout and drops the exit code, so a
    # diff against a SHA this repo does not contain returns "" -- indistinguish-
    # able from a genuinely clean deploy, and it printed the same reassuring
    # "nothing to deploy" sentence. Reachable via shallow clone, a rebase or
    # squash of the marked commit, or a corrupt marker: exactly the situations
    # where a successor is least able to notice. Resolve the marker first.
    if not git_ok("cat-file", "-e", f"{deployed}^{{commit}}"):
        print(f"CANNOT ASSESS: marker commit {deployed[:9]} does not resolve in this repo "
              f"(shallow clone, rebased/squashed history, or a corrupt "
              f"worker/.last_deploy_commit). Deploy state is UNKNOWN -- this is not "
              f"an all-clear. Re-point the marker at a commit that exists, or redeploy "
              f"and let scripts/deploy_worker.py rewrite it.")
        return 1

    head = git("rev-parse", "HEAD")
    if deployed == head:
        print(f"worker deploy current @ {head[:9]}")
        return 0

    files = [f for f in git("diff", "--name-only", deployed, head,
                            "--", "worker/src/").splitlines() if f.strip()]
    if not files:
        print(f"worker deploy @ {deployed[:9]} behind HEAD {head[:9]}, "
              "but no worker/src/ changes -- nothing to deploy")
        return 0

    # Anything that is not a data mirror is code: assume behavioural.
    code = [f for f in files if not f.endswith(".json")]
    data = [f for f in files if f.endswith(".json")]

    # Which field names does worker code actually read? Cheap but sound: a field
    # the worker never mentions by name cannot change its behaviour.
    src_text = "\n".join(p.read_text(encoding="utf-8", errors="ignore")
                         for p in WORKER_SRC.glob("*.ts"))
    read_names = set(re.findall(r"[A-Za-z_][A-Za-z0-9_]*", src_text))

    behavioural, inert = list(code), []
    for f in data:
        keys = changed_json_keys(deployed, ROOT / f)
        if keys is None:
            behavioural.append(
                f + " (new, unparseable, or a shape this script cannot compare "
                    "field-by-field -- reported as behavioural on purpose)")
            continue
        hot = sorted(k for k in keys if k in read_names)
        cold = sorted(k for k in keys if k not in read_names)
        if hot:
            behavioural.append(f"{f} (worker reads: {', '.join(hot)})")
        elif cold:
            inert.append(f"{f} (only: {', '.join(cold)})")

    print(f"worker deployed @ {deployed[:9]}, HEAD @ {head[:9]}")
    if behavioural:
        print("\nBEHAVIOURAL DRIFT -- the running worker differs in what it serves:")
        for f in behavioural:
            print("  " + f)
        print("\n  -> run: python scripts/deploy_worker.py")
    if inert:
        print("\ninert drift (mirror moved, but on fields no worker code reads):")
        for f in inert:
            print("  " + f)
    if not behavioural:
        print("\nverdict: nothing the worker serves has changed. Deploy when "
              "convenient; no live impact.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
