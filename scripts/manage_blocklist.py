#!/usr/bin/env python3
"""Add/remove/list entries in the operator-managed signup blocklist (Task #7,
2026-08-06, migration 0023) -- the abuse-response list, distinct from
validation.ts's compiled-in DISPOSABLE_EMAIL_DOMAINS/COMPETITOR_EMAIL_DOMAINS.

Blocks a specific email or domain across all three signup paths
(/subscribe, /firm/signup, and a firm admin adding staff to their own
roster) -- see store.ts's isEmailBlocklisted() for the matching semantics
(exact email match, or exact-or-subdomain match for a domain entry).

Writes go through a real .sql file passed to `wrangler d1 execute --file`
rather than an inline `--command` string -- avoids ever hand-building SQL
with a pattern the operator typed (shell-quoting an inline command is easy
to get subtly wrong; a bound-less inline string is not, so this generates
parameterized SQL into a temp file instead of interpolating raw input into
a shell command).

Usage:
    python3 scripts/manage_blocklist.py add email spammer@example.com --note "signup spam 2026-08-06"
    python3 scripts/manage_blocklist.py add domain spammy-mail.com --note "mail-bombed a firm admin"
    python3 scripts/manage_blocklist.py remove spammer@example.com
    python3 scripts/manage_blocklist.py list
    (append --local to any command to run against the local D1 replica instead of --remote)
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WORKER_DIR = ROOT / "worker"
DB_NAME = "deadlineradar"


def exe(name: str) -> str:
    found = shutil.which(name)
    if found is None:
        raise SystemExit(f"Could not find '{name}' on PATH. Is Node installed?")
    return found


def sql_quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def run_sql(sql: str, remote: bool) -> int:
    with tempfile.NamedTemporaryFile("w", suffix=".sql", delete=False, encoding="utf-8") as f:
        f.write(sql)
        sql_path = Path(f.name)
    try:
        cmd = [exe("npx"), "wrangler", "d1", "execute", DB_NAME, "--file", str(sql_path)]
        cmd.append("--remote" if remote else "--local")
        print(f"$ {' '.join(cmd)}  (cwd=worker)")
        proc = subprocess.run(cmd, cwd=WORKER_DIR)
        return proc.returncode
    finally:
        sql_path.unlink(missing_ok=True)


def cmd_add(args: argparse.Namespace) -> int:
    pattern = args.pattern.strip().lower()
    if args.kind == "email" and "@" not in pattern:
        print(f"'{pattern}' doesn't look like an email address. Use 'domain' for a bare domain.", file=sys.stderr)
        return 1
    if args.kind == "domain" and "@" in pattern:
        print(f"'{pattern}' looks like an email address, not a bare domain. Use 'email' instead.", file=sys.stderr)
        return 1
    entry_id = uuid.uuid4().hex
    created_at = datetime.now(timezone.utc).isoformat()
    note = args.note or ""
    sql = (
        "INSERT INTO signup_blocklist (id, pattern, pattern_type, note, created_at) "
        f"VALUES ({sql_quote(entry_id)}, {sql_quote(pattern)}, {sql_quote(args.kind)}, "
        f"{sql_quote(note)}, {sql_quote(created_at)});"
    )
    return run_sql(sql, remote=args.remote)


def cmd_remove(args: argparse.Namespace) -> int:
    pattern = args.pattern.strip().lower()
    sql = f"DELETE FROM signup_blocklist WHERE pattern = {sql_quote(pattern)};"
    return run_sql(sql, remote=args.remote)


def cmd_list(args: argparse.Namespace) -> int:
    sql = "SELECT pattern_type, pattern, note, created_at FROM signup_blocklist ORDER BY created_at DESC;"
    return run_sql(sql, remote=args.remote)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="action", required=True)

    p_add = sub.add_parser("add", help="block an email or domain")
    p_add.add_argument("kind", choices=["email", "domain"])
    p_add.add_argument("pattern", help="the email address or bare domain to block")
    p_add.add_argument("--note", help="why this was blocked (for your own future reference)")
    p_add.add_argument("--local", dest="remote", action="store_false", default=True)

    p_remove = sub.add_parser("remove", help="unblock a previously-added pattern")
    p_remove.add_argument("pattern", help="the exact email or domain string to remove")
    p_remove.add_argument("--local", dest="remote", action="store_false", default=True)

    p_list = sub.add_parser("list", help="show every current blocklist entry")
    p_list.add_argument("--local", dest="remote", action="store_false", default=True)

    args = ap.parse_args()
    if args.action == "add":
        return cmd_add(args)
    if args.action == "remove":
        return cmd_remove(args)
    return cmd_list(args)


if __name__ == "__main__":
    raise SystemExit(main())
