"""
DeadlineRadar reminders -- the escalating reminder scheduler.

Computes each confirmed subscriber's OWN specific next deadline, checks it
against the escalation thresholds (60/30/14/7/3/1 days), and sends exactly
one reminder per scheduler run per subscriber (the nearest newly-due
threshold) via the pluggable sender from sender.py.

Deliberately reuses the SAME date-computation functions from generate.py
(not a re-implementation) for the birth-month states, so this can never
silently disagree with what the static site displays. For fixed-calendar
states, this reads the same data/cpa_deadlines.json next_deadline_computed
values the site uses, and inherits the same wall-clock staleness posture --
see `check_data_freshness()` below.

New York is deliberately NOT supported here, same as the static site: its
rule depends on a fact (first-registration date) this dataset doesn't have,
so no reminder can be computed for it. The signup form does not offer NY.
"""

from __future__ import annotations

import json
import pathlib
import sys
from datetime import date, datetime, timezone

# Reuse generate.py's date-math functions directly rather than re-deriving
# them -- see module docstring.
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from generate import (  # noqa: E402
    next_birth_month_parity_date,
    next_annual_month_end,
    fmt_date,
    STALENESS_THRESHOLD_DAYS,
)

from . import store
from . import emails
from . import sender as sender_module

DATA_PATH = pathlib.Path(__file__).resolve().parent.parent / "data" / "cpa_deadlines.json"

# If a subscriber's deadline is more than this many days in the past with no
# stop recorded, the scheduler stops sending for it rather than emailing
# forever about a deadline nobody confirmed renewing. This is a safety net,
# not the primary UX -- the primary UX is the 1-day reminder's "I've
# renewed" link.
GRACE_PERIOD_PAST_DEADLINE_DAYS = 3


def _load_cpa_records() -> list[dict]:
    with open(DATA_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)
    return data["records"], date.fromisoformat(data["as_of_date"])


def check_data_freshness(real_today: date) -> None:
    """Same posture as generate.py's staleness guard: refuse to schedule
    reminders off data that hasn't been re-verified recently. A stale
    reminder (wrong date) is worse than a stale static page -- it's an
    email telling someone the wrong deadline."""
    _, as_of = _load_cpa_records()
    age_days = (real_today - as_of).days
    if age_days > STALENESS_THRESHOLD_DAYS:
        raise SystemExit(
            f"REFUSING TO SCHEDULE: data/cpa_deadlines.json's as_of_date is {age_days} days old, "
            f"past the {STALENESS_THRESHOLD_DAYS}-day freshness threshold. Re-verify the data "
            f"(same process as generate.py) before running the reminder scheduler."
        )


def compute_subscriber_deadline(subscriber: dict, as_of: date) -> tuple[date, str] | None:
    """Returns (deadline_date, state_name) for this subscriber's specific
    next deadline, or None if it can't be computed (e.g. bad/missing
    deadline_fields). Never raises on bad subscriber data -- a malformed
    record should be skipped and logged, not crash the whole scheduler run
    for every other subscriber."""
    records, _ = _load_cpa_records()
    state_slug = subscriber["state_slug"]
    fields = subscriber.get("deadline_fields", {})
    state_records = [r for r in records if r["state_slug"] == state_slug]
    if not state_records:
        return None
    state_name = state_records[0]["state"]

    if state_slug == "california":
        month = fields.get("birth_month")
        parity = fields.get("birth_year_parity")
        if not month or parity not in ("odd", "even"):
            return None
        d = next_birth_month_parity_date(as_of, int(month), parity)
        return d, state_name

    if state_slug == "texas":
        month = fields.get("birth_month")
        if not month:
            return None
        d = next_annual_month_end(as_of, int(month))
        return d, state_name

    if state_slug == "ohio":
        group = fields.get("cohort_group")
        record = state_records[0]
        for g in record.get("cohort_groups", []):
            if g["group"] == group:
                return date.fromisoformat(g["next_deadline"]), state_name
        return None

    # Fixed-calendar states, possibly with multiple records (e.g. Florida's
    # odd/even cohort, Georgia's individual-vs-firm) -- the subscriber picks
    # which record applies to them at signup (license_type_id).
    license_type_id = fields.get("license_type_id")
    if license_type_id:
        for r in state_records:
            if r["id"] == license_type_id and r.get("next_deadline_computed"):
                return date.fromisoformat(r["next_deadline_computed"]), state_name
        return None
    # Single-record states (no license_type_id needed) -- just use the one
    # record if there's exactly one with a computed date.
    computed = [r for r in state_records if r.get("next_deadline_computed")]
    if len(computed) == 1:
        return date.fromisoformat(computed[0]["next_deadline_computed"]), state_name
    return None


def next_due_threshold(days_remaining: int, already_sent: list[int]) -> int | None:
    """The single nearest (most urgent) threshold that's newly due -- see
    module docstring for why this sends at most one reminder per run rather
    than flooding all missed thresholds at once."""
    for threshold in sorted(store.ESCALATION_THRESHOLDS_DAYS):  # ascending: 1,3,7,14,30,60
        if days_remaining <= threshold and threshold not in already_sent:
            return threshold
    return None


def run_once(as_of: date | None = None, sender: sender_module.EmailSender | None = None) -> dict:
    """Runs one scheduling pass. `as_of` defaults to real wall-clock today;
    a test harness can override it to simulate the clock advancing without
    waiting real days. Returns a summary dict for logging/testing."""
    real_today = as_of or date.today()
    check_data_freshness(real_today if as_of is None else date.today())
    active_sender = sender or sender_module.get_sender()

    summary = {"checked": 0, "sent": 0, "skipped_no_deadline": 0, "skipped_grace_period": 0, "errors": []}

    for subscriber in store.all_confirmed_active():
        summary["checked"] += 1
        try:
            result = compute_subscriber_deadline(subscriber, real_today)
        except Exception as exc:  # noqa: BLE001 -- one bad record must not kill the whole run
            summary["errors"].append({"subscriber_id": subscriber["id"], "error": str(exc)})
            continue

        if result is None:
            summary["skipped_no_deadline"] += 1
            continue

        deadline_date, state_name = result
        days_remaining = (deadline_date - real_today).days

        if days_remaining < -GRACE_PERIOD_PAST_DEADLINE_DAYS:
            summary["skipped_grace_period"] += 1
            continue

        threshold = next_due_threshold(days_remaining, subscriber["reminders_sent"])
        if threshold is None:
            continue

        renewed_url = f"{emails.BACKEND_BASE_URL}/renewed?token={subscriber['renewed_token']}"
        unsubscribe_url = f"{emails.BACKEND_BASE_URL}/unsubscribe?token={subscriber['unsubscribe_token']}"
        email = emails.reminder_email(
            state_name=state_name,
            deadline_date_str=fmt_date(deadline_date),
            days_remaining=threshold,
            renewed_url=renewed_url,
            unsubscribe_url=unsubscribe_url,
        )
        ok = active_sender.send(subscriber["email"], email["subject"], email["text_body"], email["html_body"])
        if ok:
            store.mark_reminder_sent(subscriber["id"], threshold)
            summary["sent"] += 1
        else:
            summary["errors"].append({"subscriber_id": subscriber["id"], "error": "sender.send() returned False"})

    return summary
