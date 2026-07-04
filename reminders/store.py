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
from datetime import date, datetime, timedelta, timezone

STORE_PATH = pathlib.Path(__file__).resolve().parent / "subscribers.json"

STATUS_PENDING = "pending_confirmation"
STATUS_CONFIRMED = "confirmed"
STATUS_STOPPED = "stopped"

# Every escalation threshold, in days-before-deadline, descending. A reminder
# fires the first time `days_until_deadline <= threshold` for each threshold,
# tracked per-subscriber in `reminders_sent` so the same milestone never
# fires twice even if the scheduler runs more than once a day.
ESCALATION_THRESHOLDS_DAYS = [60, 30, 14, 7, 3, 1]

# Abuse-hardening: one confirmation email per address per this window,
# full stop -- regardless of state, regardless of how many times the form is
# submitted. This is what stops "submit victim@x 100x" from generating 100
# confirmation emails to a third party: only the very first submission in
# the window can ever trigger a send; every repeat gets the same generic
# "check your email" response with no email actually sent.
SIGNUP_COOLDOWN_HOURS = 24

# Optional first-name field (server.py already validates length/control
# chars on every form field before this runs) -- capped again here,
# defense-in-depth, since this is what renders into an email greeting.
MAX_FIRST_NAME_LEN = 60


def _sanitize_first_name(first_name: str | None) -> str | None:
    if not first_name:
        return None
    name = "".join(ch for ch in first_name.strip() if ch.isprintable())[:MAX_FIRST_NAME_LEN]
    return name or None


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


def _normalize_email(email: str) -> str:
    # Case-insensitive per the email spec's common practice (mailbox names
    # are technically case-sensitive per RFC, but no real-world provider
    # treats them that way) -- without this, "Victim@X.com" and
    # "victim@x.com" would dodge cooldown/dedupe/suppression as "different"
    # addresses.
    return email.strip().lower()


def _cooldown_key(email: str) -> str:
    """A MORE aggressive normalization than `_normalize_email()`, used ONLY
    for cooldown/dedupe comparisons -- never for the actual stored/sent-to
    address, and never for is_permanently_suppressed(). Folds Gmail-style
    '+tag' sub-addressing and dot-insensitivity in the local part, which
    several major providers (Gmail/Google Workspace among them) treat as
    equivalent to the base address when delivering mail.

    Found by the abuse-hardening audit's own attack test: without this, an
    attacker could generate victim.name@gmail.com, victim.name+a@gmail.com,
    victim.na.me@gmail.com, etc. -- each treated as a "different" address by
    plain lowercase/strip normalization, each triggering its own
    confirmation email, all delivered to the SAME real inbox. Over-folding
    here just means two genuinely different people who happen to share a
    dot/plus-tag-adjacent local part share a cooldown window -- a minor,
    self-correcting inconvenience (one of them waits out the window). Under-
    folding is what let a stranger spam a real inbox with distinct
    "confirm this" emails -- fails toward safety, not permissiveness."""
    normalized = _normalize_email(email)
    local, _, domain = normalized.partition("@")
    local = local.split("+", 1)[0].replace(".", "")
    return f"{local}@{domain}"


def within_signup_cooldown(email: str, cooldown_hours: float = SIGNUP_COOLDOWN_HOURS) -> bool:
    """True if ANY record (any state, any status) for this email's cooldown
    key was created within the cooldown window. Used to block repeat-
    submission spam -- see SIGNUP_COOLDOWN_HOURS docstring above. Keyed on
    `_cooldown_key()`, not just `_normalize_email()` -- see that function's
    docstring for why (Gmail dot/+tag sub-addressing)."""
    key = _cooldown_key(email)
    cutoff = datetime.now(timezone.utc) - timedelta(hours=cooldown_hours)
    for s in _load():
        if _cooldown_key(s["email"]) != key:
            continue
        created = datetime.fromisoformat(s["created_at"])
        if created >= cutoff:
            return True
    return False


def find_active_or_pending(email: str, state_slug: str) -> dict | None:
    """An existing PENDING or CONFIRMED record for this email+state, if any
    -- used to refuse creating a duplicate subscriber (dedupe) even outside
    the cooldown window. Keyed on `_cooldown_key()` for the same
    dot/+tag-folding reason as `within_signup_cooldown()`."""
    key = _cooldown_key(email)
    for s in _load():
        if (
            _cooldown_key(s["email"]) == key
            and s["state_slug"] == state_slug
            and s["status"] in (STATUS_PENDING, STATUS_CONFIRMED)
        ):
            return s
    return None


def is_permanently_suppressed(email: str) -> bool:
    """True if this email is CURRENTLY suppressed: it has a record stopped
    with reason='unsubscribed', AND no record for this email has been
    independently CONFIRMED (a real /confirm click -- a fresh double
    opt-in) since that unsubscribe. Deliberately keys the "was it ever
    unsubscribed" half off `stop_reason` alone, not `status` -- checking
    both would make this dependent on the very field a hypothetical
    status-corruption bug could have flipped, defeating the point of a
    defense-in-depth check (see test_permanent_suppression_survives_a_status_bug).

    The "...unless a later confirm happened" half is REQUIRED, not
    optional: found by the abuse-hardening audit's own attack test that an
    earlier version of this function suppressed EVERY future signup for an
    email that had EVER unsubscribed -- even a wholly separate, genuinely
    re-confirmed record for a different state years later -- which is a
    real product-breaking bug (a customer who unsubscribes once could
    never resubscribe with that address, for anything, ever) and directly
    contradicts "never re-emailed unless THEY re-initiate." A fresh signup
    followed by a real confirm click IS the subscriber re-initiating
    consent -- that must lift the suppression, not be silently ignored by
    it. A bug that resurrects a record's `status` WITHOUT a real confirm
    (i.e. `confirmed_at` stays from before the unsubscribe, or stays null)
    remains correctly suppressed, since only a confirm timestamp AFTER the
    most recent unsubscribe lifts it."""
    normalized = _normalize_email(email)
    records = [s for s in _load() if _normalize_email(s["email"]) == normalized]
    unsubscribed_stops = [s for s in records if s.get("stop_reason") == "unsubscribed" and s.get("stopped_at")]
    if not unsubscribed_stops:
        return False
    most_recent_unsub_at = max(datetime.fromisoformat(s["stopped_at"]) for s in unsubscribed_stops)
    for s in records:
        confirmed_at = s.get("confirmed_at")
        if confirmed_at and datetime.fromisoformat(confirmed_at) > most_recent_unsub_at:
            return False  # a real, later confirm -- the subscriber re-initiated consent
    return True


def add_pending(email: str, state_slug: str, deadline_fields: dict, first_name: str | None = None) -> dict:
    """Create a new pending-confirmation subscriber. `deadline_fields` is a
    small dict of whatever the signup form collected beyond email+state --
    e.g. {"license_type_id": "fl-individual-odd"} for a fixed-date state, or
    {"birth_month": 3, "birth_year_parity": "odd"} for California, or
    {"cohort_group": "Group 2"} for Ohio. The scheduler uses this to compute
    THIS subscriber's specific next deadline.

    `first_name` is OPTIONAL, purely cosmetic (an email greeting), and
    sanitized again here even though server.py already validates it --
    never trust that blindly, see `_sanitize_first_name()`.

    Does not send anything -- that's the caller's job (server.py), so this
    module stays pure storage with no email-sending side effects."""
    subscribers = _load()
    record = {
        "id": _new_token(),
        "email": email,
        "state_slug": state_slug,
        "deadline_fields": deadline_fields,
        "first_name": _sanitize_first_name(first_name),
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
    stop-confirmation email copy and whether to later offer a re-arm.

    Found by the abuse-hardening audit's own attack test: this used to
    match ANY record by token regardless of `status`, with no regard for
    whether the subscriber had ever actually confirmed. That meant a
    still-pending (never-confirmed) subscriber's OWN signup-time tokens
    (issued before any /confirm click) could reach /renewed, flipping them
    to status=stopped/reason=renewed -- and THEN /rearm would happily flip
    that same record all the way to status=confirmed, WITHOUT /confirm ever
    having been called once. That's a full double-opt-in bypass: the
    scheduler would then send a live reminder to an address that was never
    verified. Fix: reason="renewed" only ever applies to a subscriber who
    was actually confirmed at some point (`confirmed_at is not None`) --
    the renewed_token is never even included in the confirmation email (only
    reminder emails carry it, and those only go to confirmed subscribers),
    so reaching this for a still-pending record is never a legitimate user
    action. reason="unsubscribed" is still honored regardless of
    confirmed_at, since the confirmation email's own footer DOES include a
    real unsubscribe link -- someone who never confirms is entitled to kill
    a pending signup that way (server.py is responsible for NOT sending a
    second email in that case; see its docstring)."""
    assert reason in ("unsubscribed", "renewed")
    subscribers = _load()
    for s in subscribers:
        if s["unsubscribe_token"] == token or s["renewed_token"] == token:
            if reason == "renewed" and s.get("confirmed_at") is None:
                return None
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
    permanently" until they explicitly opt back in via a fresh signup.
    Also requires `confirmed_at is not None` -- belt-and-suspenders with the
    same fix in stop() above, so even if stop() were ever weakened again, a
    record that reached STOPPED/renewed without ever passing through a real
    /confirm cannot be re-armed into CONFIRMED here either."""
    subscribers = _load()
    for s in subscribers:
        if (
            s["unsubscribe_token"] == unsubscribe_token
            and s["status"] == STATUS_STOPPED
            and s["stop_reason"] == "renewed"
            and s.get("confirmed_at") is not None
        ):
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
