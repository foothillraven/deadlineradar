"""
DeadlineRadar reminders -- subscriber storage.

Stdlib only (json, pathlib, secrets, datetime). One flat JSON file,
`subscribers.json`, holding a list of subscriber records. This file is
GITIGNORED -- it holds real email addresses (PII) and must never be
committed, never appear in the firm-chat bus, never leave this machine.
`subscribers.example.json` (checked in) shows the schema with fake data only.

Subscriber lifecycle:
  pending_confirmation -> confirmed -> (stopped | re-arm-eligible)
A subscriber can be `stopped` (unsubscribed or clicked "I've renewed") and
later choose to re-arm for the next cycle -- re-arming creates a fresh
pending_confirmation-free "confirmed" record for the next deadline, it does
NOT require a second double-opt-in (the address was already verified once;
re-arming is opt-in via a link click, which is itself explicit consent).
"""

from __future__ import annotations

import json
import pathlib
import secrets
from datetime import date, datetime, timezone

STORE_PATH = pathlib.Path(__file__).resolve().parent / "subscribers.json"

STATUS_PENDING = "pending_confirmation"
STATUS_CONFIRMED = "confirmed"
STATUS_STOPPED = "stopped"

# Every escalation threshold, in days-before-deadline, descending. A reminder
# fires the first time `days_until_deadline <= threshold` for each threshold,
# tracked per-subscriber in `reminders_sent` so the same milestone never
# fires twice even if the scheduler runs more than once a day.
ESCALATION_THRESHOLDS_DAYS = [60, 30, 14, 7, 3, 1]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _new_token() -> str:
    # 32 bytes of CSPRNG, url-safe -- used for confirm/unsubscribe/renewed
    # links. Long and random enough that guessing another subscriber's token
    # is not a practical attack.
    return secrets.token_urlsafe(32)


def _load() -> list[dict]:
    if not STORE_PATH.exists():
        return []
    with open(STORE_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def _save(subscribers: list[dict]) -> None:
    STORE_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(STORE_PATH, "w", encoding="utf-8") as f:
        json.dump(subscribers, f, indent=2, ensure_ascii=False)


def add_pending(email: str, state_slug: str, deadline_fields: dict) -> dict:
    """Create a new pending-confirmation subscriber. `deadline_fields` is a
    small dict of whatever the signup form collected beyond email+state --
    e.g. {"license_type_id": "fl-individual-odd"} for a fixed-date state, or
    {"birth_month": 3, "birth_year_parity": "odd"} for California, or
    {"cohort_group": "Group 2"} for Ohio. The scheduler uses this to compute
    THIS subscriber's specific next deadline.

    Does not send anything -- that's the caller's job (server.py), so this
    module stays pure storage with no email-sending side effects."""
    subscribers = _load()
    record = {
        "id": _new_token(),
        "email": email,
        "state_slug": state_slug,
        "deadline_fields": deadline_fields,
        "status": STATUS_PENDING,
        "confirm_token": _new_token(),
        "unsubscribe_token": _new_token(),
        "renewed_token": _new_token(),
        "created_at": _now_iso(),
        "confirmed_at": None,
        "stopped_at": None,
        "stop_reason": None,  # "renewed" | "unsubscribed" | None
        "reminders_sent": [],  # list of thresholds (ints) already sent this cycle
        "cycle": 1,  # increments each time the subscriber re-arms for a new deadline
    }
    subscribers.append(record)
    _save(subscribers)
    return record


def find_by_confirm_token(token: str) -> dict | None:
    for s in _load():
        if s["confirm_token"] == token and s["status"] == STATUS_PENDING:
            return s
    return None


def find_by_unsubscribe_token(token: str) -> dict | None:
    for s in _load():
        if s["unsubscribe_token"] == token:
            return s
    return None


def find_by_renewed_token(token: str) -> dict | None:
    for s in _load():
        if s["renewed_token"] == token:
            return s
    return None


def confirm(confirm_token: str) -> dict | None:
    """Double opt-in step 2: subscriber clicked the link in their
    confirmation email. Moves pending -> confirmed. Idempotent: confirming
    an already-confirmed subscriber is a no-op, not an error, since a user
    might click the link twice."""
    subscribers = _load()
    for s in subscribers:
        if s["confirm_token"] == confirm_token:
            if s["status"] == STATUS_PENDING:
                s["status"] = STATUS_CONFIRMED
                s["confirmed_at"] = _now_iso()
            _save(subscribers)
            return s
    return None


def stop(token: str, reason: str) -> dict | None:
    """Unsubscribe or 'I've renewed' -- both HALT reminders immediately.
    `reason` is "unsubscribed" or "renewed", used only to pick the right
    stop-confirmation email copy and whether to later offer a re-arm."""
    assert reason in ("unsubscribed", "renewed")
    subscribers = _load()
    for s in subscribers:
        if s["unsubscribe_token"] == token or s["renewed_token"] == token:
            s["status"] = STATUS_STOPPED
            s["stopped_at"] = _now_iso()
            s["stop_reason"] = reason
            _save(subscribers)
            return s
    return None


def rearm(unsubscribe_token: str) -> dict | None:
    """Re-arm a stopped-by-renewal subscriber for their NEXT cycle (e.g. next
    year's or next-biennium's deadline). Only valid for subscribers stopped
    with reason="renewed" -- someone who unsubscribed outright should not be
    silently re-armed, that would violate "honor stop instantly and
    permanently" until they explicitly opt back in via a fresh signup."""
    subscribers = _load()
    for s in subscribers:
        if s["unsubscribe_token"] == unsubscribe_token and s["status"] == STATUS_STOPPED and s["stop_reason"] == "renewed":
            s["status"] = STATUS_CONFIRMED
            s["stopped_at"] = None
            s["stop_reason"] = None
            s["reminders_sent"] = []
            s["cycle"] += 1
            # Fresh tokens for the new cycle's links, old ones stop working.
            s["unsubscribe_token"] = _new_token()
            s["renewed_token"] = _new_token()
            _save(subscribers)
            return s
    return None


def mark_reminder_sent(subscriber_id: str, threshold_days: int) -> None:
    subscribers = _load()
    for s in subscribers:
        if s["id"] == subscriber_id:
            if threshold_days not in s["reminders_sent"]:
                s["reminders_sent"].append(threshold_days)
            _save(subscribers)
            return


def all_confirmed_active() -> list[dict]:
    """Subscribers eligible for reminder scheduling: confirmed, not stopped."""
    return [s for s in _load() if s["status"] == STATUS_CONFIRMED]
