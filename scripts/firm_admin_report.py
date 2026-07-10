#!/usr/bin/env python3
"""
CSV-roster -> weekly-admin-status-report flow (2026-07-10 Wave-1 B2B inbound directive).

Manual-onboarding tool for a firm's staff roster: takes a CSV (columns: name, email,
state_slug, license_type optional) and produces a markdown status report matching the
admin-status table format drafted during the Synthetic Firm Pilot
(assetlab_20260709T_synthetic_pilot_nonturnstile_progress.md), ready for an operator to
paste into an email to the firm's admin contact.

Does NOT create subscriptions, send email, or write to D1 -- per the orchestrator's
per-seat ruling (2026-07-09), each staff member confirms their OWN subscription through
the public double opt-in form; this tool only REPORTS on subscriptions that already
exist. Deadline/pattern text comes from the local cpa_deadlines.json reference data
(static, no live query needed); actual subscription status (pending/confirmed/none)
comes from one read-only (SELECT-only) live D1 query per run.

The "Verified status" column is intentionally left BLANK for the operator to fill in by
hand after a manual CPAverify.org / state-board lookup (2026-07-09 license-verification
directive) -- never auto-populated, per that directive's "manual human lookups only,
zero scraping/automation" rule.

Usage:
    python scripts/firm_admin_report.py <roster.csv> <firm_name> [--out report.md]

Requires CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment (same as
every other live-D1 operator script in this repo) and must be run from worker/'s
parent so `npx wrangler` resolves -- run from the repo root.
"""
import argparse
import csv
import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_PATH = ROOT / "data" / "cpa_deadlines.json"
WORKER_DIR = ROOT / "worker"


def load_deadline_data() -> dict[str, list[dict]]:
    with open(DATA_PATH, encoding="utf-8") as f:
        data = json.load(f)
    by_state: dict[str, list[dict]] = {}
    for r in data["records"]:
        by_state.setdefault(r["state_slug"], []).append(r)
    return by_state


def read_roster(csv_path: Path) -> list[dict]:
    with open(csv_path, encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        required = {"name", "email", "state_slug"}
        missing = required - set(h.strip() for h in (reader.fieldnames or []))
        if missing:
            raise SystemExit(
                f"Roster CSV is missing required column(s): {sorted(missing)}. "
                f"See scripts/roster_template.example.csv for the expected format."
            )
        return [{k.strip(): (v or "").strip() for k, v in row.items()} for row in reader]


def _pick_deadline_record(records: list[dict], license_type_hint: str) -> dict | None:
    """Matches a roster row's requested license type to the closest real record.
    Falls back to the state's only record if there's just one, or the first record
    whose license_type contains the hint. Returns None (never a guess) if nothing
    reasonably matches -- same "don't fabricate, disclose the gap" rule as every
    other record-shape check in generate.py."""
    if not records:
        return None
    if len(records) == 1:
        return records[0]
    hint = (license_type_hint or "").lower()
    if hint:
        for r in records:
            if hint in (r.get("license_type") or "").lower():
                return r
    return records[0]


def _sql_literal(s: str) -> str:
    """Standard SQL single-quote escaping for a literal inside an ad-hoc `wrangler d1
    execute --command` string (that CLI path has no separate bind-params flag the way
    the Worker's own D1Database.prepare().bind() does) -- doubling embedded quotes is
    the correct, sufficient escape for a string literal in this position."""
    return s.replace("'", "''")


def query_subscription_status(emails: list[str]) -> dict[str, list[dict]]:
    """Read-only (SELECT-only) live D1 query -- reports on existing subscriptions,
    never creates one. Returns {normalized_email: [{"state_slug", "status",
    "confirmed_at"}, ...]}. Empty dict (not an error) if the roster is empty or the
    query returns nothing -- absence of a subscription is itself real, reportable
    information (task #29/#33's whole finding), not a failure state."""
    normalized = sorted({e.strip().lower() for e in emails if e.strip()})
    if not normalized:
        return {}
    values = ",".join(f"'{_sql_literal(e)}'" for e in normalized)
    sql = (
        "SELECT LOWER(TRIM(email)) AS email, state_slug, status, confirmed_at "
        f"FROM subscribers WHERE LOWER(TRIM(email)) IN ({values})"
    )
    # shutil.which(), not a bare "npx" -- on Windows the real executable is
    # npx.cmd, and subprocess's default (non-shell) CreateProcess call does not
    # resolve .cmd shims from PATH the way a shell would.
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
    rows = payload[0]["results"] if payload and payload[0].get("results") else []
    by_email: dict[str, list[dict]] = {}
    for row in rows:
        by_email.setdefault(row["email"], []).append(row)
    return by_email


def build_report(firm_name: str, roster: list[dict], by_state: dict[str, list[dict]],
                  subs_by_email: dict[str, list[dict]]) -> str:
    lines = [
        f"# DeadlineRadar — {firm_name} status",
        "",
        "| Staff | State | License type | Next deadline | Pattern | Subscription | Verified status |",
        "|---|---|---|---|---|---|---|",
    ]
    unmatched_states = []
    for person in roster:
        name = person.get("name") or "(name not given)"
        state_slug = person.get("state_slug", "")
        email = person.get("email", "")
        state_records = by_state.get(state_slug, [])
        if not state_records:
            unmatched_states.append((name, state_slug))
        record = _pick_deadline_record(state_records, person.get("license_type", ""))

        if record is None:
            state_label, license_label, deadline_label, pattern_label = (
                state_slug or "(unknown)", "-", "*(no matching record found)*", "-",
            )
        else:
            state_label = record["state"]
            license_label = record.get("license_type_label", "-")
            pattern_label = record.get("renewal_pattern", "-")
            deadline = record.get("next_deadline_computed")
            deadline_label = deadline if deadline else "*(needs licensee-specific info -- see free site page)*"

        subs = subs_by_email.get(email.strip().lower(), [])
        state_sub = next((s for s in subs if s["state_slug"] == state_slug), None)
        if state_sub:
            sub_label = state_sub["status"]
            if state_sub["status"] == "pending_confirmation":
                sub_label += " (email sent, awaiting click)"
        else:
            sub_label = "not signed up yet"

        lines.append(
            f"| {name} | {state_label} | {license_label} | {deadline_label} | "
            f"{pattern_label} | {sub_label} | *(pending manual lookup)* |"
        )

    lines.append("")
    lines.append(
        "*Verified status column is filled in by hand after a manual CPAverify.org / "
        "state-board lookup -- never automated, never scraped.*"
    )
    if unmatched_states:
        lines.append("")
        lines.append(
            f"**Data gap, not silently dropped**: {len(unmatched_states)} roster row(s) referenced "
            f"a state_slug with no record in cpa_deadlines.json: "
            + ", ".join(f"{n} ({s})" for n, s in unmatched_states)
            + " -- check the slug for a typo before treating this report as complete."
        )
    return "\n".join(lines) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("roster_csv", type=Path)
    parser.add_argument("firm_name")
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args()

    roster = read_roster(args.roster_csv)
    if not roster:
        raise SystemExit(f"{args.roster_csv} has no data rows -- nothing to report.")

    by_state = load_deadline_data()
    subs_by_email = query_subscription_status([p["email"] for p in roster])
    report = build_report(args.firm_name, roster, by_state, subs_by_email)

    if args.out:
        args.out.write_text(report, encoding="utf-8")
        print(f"wrote {args.out}")
    else:
        print(report)


if __name__ == "__main__":
    main()
