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

# If a subscriber's deadline is more than this many days in the past AND
# they've already received at least one reminder, the scheduler stops
# sending for it rather than emailing forever about a deadline nobody
# confirmed renewing. This is a safety net, not the primary UX -- the
# primary UX is the 1-day reminder's "I've renewed" link.
GRACE_PERIOD_PAST_DEADLINE_DAYS = 3

# Found by adversarial review: a subscriber whose FIRST-EVER scheduler
# evaluation happens after their deadline already passed (a real scenario --
# a scheduler outage, a late confirmation) would previously get zero
# reminders, silently, forever. That's worse than one late "catch-up"
# email. Within this wider window (but still bounded -- beyond it the
# signup is stale/abandoned and not worth reminding about), a
# never-yet-notified subscriber gets exactly one final 1-day-tier reminder
# instead of nothing.
NEVER_NOTIFIED_CATCHUP_WINDOW_DAYS = 14


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
    """The single nearest (most urgent) threshold that's newly due.

    Found by adversarial review and fixed here: this must never return a
    LESS urgent threshold than the most urgent one already sent, or a
    scheduler gap (the run skipping a day) can send reminders out of order
    -- e.g. the "tomorrow" (1-day) reminder going out, then days later a
    "three days left" (3-day) reminder arriving AFTER the deadline already
    passed, because 3 had never technically been marked sent. Once the most
    urgent tier fires, no less-urgent tier may ever fire after it for this
    subscriber's current cycle."""
    most_urgent_sent = min(already_sent) if already_sent else None
    for threshold in sorted(store.ESCALATION_THRESHOLDS_DAYS):  # ascending: 1,3,7,14,30,60
        if threshold in already_sent:
            continue
        if most_urgent_sent is not None and threshold >= most_urgent_sent:
            continue  # would be a regression to a less-urgent tier -- never send it
        if days_remaining <= threshold:
            return threshold
    return None


def run_once(as_of: date | None = None, sender: sender_module.EmailSender | None = None) -> dict:
    """Runs one scheduling pass. `as_of` defaults to real wall-clock today;
    a test harness can override it to simulate the clock advancing without
    waiting real days. Returns a summary dict for logging/testing."""
    real_today = as_of or date.today()
    check_data_freshness(real_today if as_of is None else date.today())
    # Same HARD-STOP posture as check_data_freshness() above: a real
    # reminder email requires a real mailing address (CAN-SPAM), and this is
    # an offline batch job, not a per-request handler -- silently skipping
    # every subscriber's due reminder would look like "ran successfully, 0
    # sent" and mask a real configuration gap. Refuse the whole run instead.
    if not emails.mailing_address_configured():
        raise SystemExit(
            f"REFUSING TO RUN SCHEDULER: no real mailing address configured ({emails.MAILING_ADDRESS_ENV_VAR} "
            "is unset). CAN-SPAM requires a real physical address in every commercial email -- set it "
            "before running real reminders."
        )
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
        never_notified = not subscriber["reminders_sent"]

        if days_remaining < -GRACE_PERIOD_PAST_DEADLINE_DAYS:
            if never_notified and days_remaining >= -NEVER_NOTIFIED_CATCHUP_WINDOW_DAYS:
                # Found by adversarial review: don't let a subscriber whose
                # first-ever evaluation lands past-deadline get silently
                # skipped forever -- send one final catch-up at the most
                # urgent tier instead. Beyond the wider window, give up (the
                # elif below falls through to the normal grace-period skip).
                threshold = min(store.ESCALATION_THRESHOLDS_DAYS)
            else:
                summary["skipped_grace_period"] += 1
                continue
        else:
            threshold = next_due_threshold(days_remaining, subscriber["reminders_sent"])
            if threshold is None:
                continue

        # Defense-in-depth (abuse-hardening audit): all_confirmed_active()
        # already filters to status=confirmed, but a status-field bug
        # elsewhere (or a future code change) shouldn't be the ONLY thing
        # standing between a permanently-unsubscribed address and a send.
        # Check the independent suppression signal again, right here, right
        # before the one call that actually sends.
        if store.is_permanently_suppressed(subscriber["email"]):
            summary["errors"].append({
                "subscriber_id": subscriber["id"],
                "error": "BLOCKED: email is permanently suppressed (unsubscribed) -- refusing to send "
                         "despite status=confirmed. This indicates a data-integrity bug elsewhere.",
            })
            continue

        renewed_url = f"{emails.BACKEND_BASE_URL}/renewed?token={subscriber['renewed_token']}"
        unsubscribe_url = f"{emails.BACKEND_BASE_URL}/unsubscribe?token={subscriber['unsubscribe_token']}"
        try:
            email = emails.reminder_email(
                state_name=state_name,
                deadline_date_str=fmt_date(deadline_date),
                threshold=threshold,
                actual_days_remaining=days_remaining,
                renewed_url=renewed_url,
                unsubscribe_url=unsubscribe_url,
                first_name=subscriber.get("first_name"),
            )
        except RuntimeError as exc:
            # Found by adversarial review: emails.reminder_email() can raise
            # (e.g. mailing_address_configured() was true when this run
            # started but became false mid-run) -- letting that propagate
            # uncaught would abort every REMAINING subscriber in this batch,
            # contradicting this loop's own "one bad record must not kill
            # the whole run" design. The top-of-run_once() precheck already
            # prevents starting a run with no address configured at all;
            # this is defense-in-depth for the narrower mid-run case.
            summary["errors"].append({"subscriber_id": subscriber["id"], "error": f"email build failed: {exc}"})
            continue
        ok = active_sender.send(
            subscriber["email"], email["subject"], email["text_body"], email["html_body"], email.get("headers")
        )
        if ok:
            store.mark_reminder_sent(subscriber["id"], threshold)
            summary["sent"] += 1
        else:
            summary["errors"].append({"subscriber_id": subscriber["id"], "error": "sender.send() returned False"})

    return summary
