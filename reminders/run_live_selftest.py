"""
DeadlineRadar reminders -- LIVE SendGrid self-test, hard-gated to a single
whitelisted recipient. v1 ran per the orchestrator's 2026-07-03T20:05
directive (project maintainer's go at 20:10). v2 (this version) rebuilds
the templates per the 20:20 "email template overhaul" directive + the 20:30
clarification on first-name (approved) and mailing address (still pending,
handled below).

WHAT THIS DOES: sends the full real email sequence (confirmation, six
escalating reminders, one stop-confirmation -- 8 real SendGrid sends total)
to ONE address, technically enforced by WhitelistedSender so a bug here can
never reach anyone else. Subjects are prefixed "[TEST] <stage>" so a human
reviewing an inbox can tell these apart from anything real at a glance. Now
sends real branded HTML (with a plain-text fallback), a test first name to
exercise the "Hi {FirstName}," greeting, and a clearly-fake mailing-address
marker (see TEST_MAILING_ADDRESS_MARKER below) -- this script is the ONLY
caller anywhere in this codebase allowed to set that marker, since it's the
only caller hard-whitelisted to a single pre-approved recipient.

WHAT THIS DOES NOT DO: it does not stand up the reminder capture endpoint
(server.py) anywhere public, does not touch DNS/Pages, does not change
get_sender()'s default (still DryRunSender), does not widen the whitelist,
does not remove it, and does not use a real mailing address (none exists
yet -- see TEST_MAILING_ADDRESS_MARKER). All storage is isolated to this
script's own scratch files, never the real subscribers.json.

The SendGrid API key is read from disk INSIDE this script and is never
printed, logged, or included in any output this script produces -- only
send outcomes (status codes, message-ids, SendGrid error bodies, which
never echo the key back) are reported.
"""
from __future__ import annotations

import sys
import uuid
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from reminders import store as store_module  # noqa: E402
from reminders import emails  # noqa: E402
from reminders import sender as sender_module  # noqa: E402

# Relative to the workspace root (two levels above this repo's own root:
# b3_saas/deadlineradar -> b3_saas -> the workspace root) rather than a
# hardcoded absolute path -- found during this session's own sanitization
# sweep: a hardcoded `C:\Users\<name>\...` path would leak the machine
# owner's identity into this repo's git history the moment it's ever pushed.
KEY_PATH = REPO_ROOT.parent.parent / ".sendgrid_key"
FROM_EMAIL = "noreply@deadline-radar.com"
FROM_NAME = "DeadlineRadar"
WHITELISTED_RECIPIENT = "foothillraven@gmail.com"

TAG = uuid.uuid4().hex[:8]
SCRATCH_DIR = Path(__file__).resolve().parent
store_module.STORE_PATH = SCRATCH_DIR / f"_selftest_subscribers_{TAG}.json"
sender_module.CIRCUIT_BREAKER_STATE_PATH = SCRATCH_DIR / f"_selftest_cbstate_{TAG}.json"
sender_module.CIRCUIT_BREAKER_ALERT_LOG_PATH = SCRATCH_DIR / f"_selftest_cbalert_{TAG}.jsonl"

STATE_SLUG = "texas"
STATE_NAME = "Texas"
DEADLINE_DATE_STR = "September 30, 2026"  # illustrative only -- test content, not a real subscriber deadline

# Obviously-generic test value -- NOT any real person's name -- just enough
# to demonstrate the "Hi {FirstName}," greeting renders correctly. Never use
# a real identity (project maintainer's or otherwise) in test content that
# could end up in a screenshot or a shared inbox.
TEST_FIRST_NAME = "Jordan"

# Per orchestrator directive 2026-07-03T20:30 (first-name approved, address
# still pending): the real mailing address doesn't exist yet, but this
# self-test is hard-whitelisted to ONE address the project maintainer
# controls (WHITELISTED_RECIPIENT above), so a clearly-fake, obviously-
# internal marker is safe to render here -- it is technically incapable of
# reaching anyone else. Production code paths (server.py, scheduler.py)
# never call set_test_mailing_address_override() -- only this script does --
# so a real subscriber can never receive this marker; a real send with no
# real address configured hard-fails instead (see emails._mailing_address()).
TEST_MAILING_ADDRESS_MARKER = "[MAILING ADDRESS — pending, added before launch]"


def load_key() -> str:
    if not KEY_PATH.exists():
        raise SystemExit(f"REFUSING TO PROCEED: key file not found at {KEY_PATH}")
    key = KEY_PATH.read_text(encoding="utf-8").strip()
    if not key:
        raise SystemExit("REFUSING TO PROCEED: key file is empty")
    return key


def build_sender() -> tuple[sender_module.WhitelistedSender, sender_module.SendGridSender]:
    key = load_key()
    real = sender_module.SendGridSender(api_key=key, from_email=FROM_EMAIL, from_name=FROM_NAME)
    breaker = sender_module.CircuitBreakerSender(real, daily_cap=20)
    whitelisted = sender_module.WhitelistedSender(breaker, allowed_recipients={WHITELISTED_RECIPIENT})
    return whitelisted, real


def send_and_report(sender, real_sendgrid, stage: str, email: dict, results: list) -> None:
    tagged_subject = f"[TEST] {stage}: {email['subject']}"
    ok = sender.send(WHITELISTED_RECIPIENT, tagged_subject, email["text_body"], email.get("html_body"))
    results.append({
        "stage": stage,
        "subject": tagged_subject,
        "sent_ok": ok,
        "sendgrid_status": real_sendgrid.last_status,
        "sendgrid_message_id": real_sendgrid.last_message_id,
        "sendgrid_error": real_sendgrid.last_error,
    })
    status = "OK" if ok else "FAILED"
    print(f"[{status}] {stage} -- status={real_sendgrid.last_status} "
          f"message_id={real_sendgrid.last_message_id} error={real_sendgrid.last_error}")


def main() -> None:
    print(f"=== DeadlineRadar LIVE self-test (scratch tag {TAG}) ===")
    print(f"Recipient (hard-whitelisted): {WHITELISTED_RECIPIENT}")
    print(f"From: {FROM_NAME} <{FROM_EMAIL}>")
    print()

    whitelisted_sender, real_sendgrid = build_sender()
    results = []

    # See TEST_MAILING_ADDRESS_MARKER's docstring above for why this is safe
    # ONLY in this hard-whitelisted script. Cleared in `finally` below so the
    # hard-fail-by-default posture is restored the moment this run ends,
    # even if a send raises partway through.
    emails.set_test_mailing_address_override(TEST_MAILING_ADDRESS_MARKER)

    try:
        # 1. Real signup -> pending record (isolated scratch storage).
        record = store_module.add_pending(
            WHITELISTED_RECIPIENT, STATE_SLUG, {"birth_month": 9}, first_name=TEST_FIRST_NAME
        )
        confirm_url = f"{emails.BACKEND_BASE_URL}/confirm?token={record['confirm_token']}"
        unsubscribe_url = f"{emails.BACKEND_BASE_URL}/unsubscribe?token={record['unsubscribe_token']}"

        # 2. Confirmation / double-opt-in email -- real production copy.
        conf_email = emails.confirmation_email(STATE_NAME, confirm_url, unsubscribe_url, first_name=TEST_FIRST_NAME)
        send_and_report(whitelisted_sender, real_sendgrid, "1. Confirmation (double opt-in)", conf_email, results)

        # 3. Simulate the confirm click -- real state-machine transition,
        #    no email tied to this step (matches server.py's own /confirm,
        #    which just flips status and does not send anything).
        confirmed = store_module.confirm(record["confirm_token"])
        print(f"[STATE] confirm() -> status={confirmed['status']!r}, confirmed_at={confirmed['confirmed_at']!r}")

        renewed_url = f"{emails.BACKEND_BASE_URL}/renewed?token={confirmed['renewed_token']}"

        # 4. Each reminder in the escalation, compressed (no real waiting).
        #    threshold == actual_days_remaining for each, so what's displayed
        #    matches the tier exactly -- this is a content/deliverability
        #    test, not a re-test of the scheduler's date math (already
        #    covered by test_dry_run_e2e.py's 150 checks).
        for threshold in sorted(store_module.ESCALATION_THRESHOLDS_DAYS, reverse=True):
            rem_email = emails.reminder_email(
                state_name=STATE_NAME,
                deadline_date_str=DEADLINE_DATE_STR,
                threshold=threshold,
                actual_days_remaining=threshold,
                renewed_url=renewed_url,
                unsubscribe_url=unsubscribe_url,
                first_name=TEST_FIRST_NAME,
            )
            send_and_report(
                whitelisted_sender, real_sendgrid, f"Reminder ({threshold}-day tier)", rem_email, results
            )
            store_module.mark_reminder_sent(confirmed["id"], threshold)

        # 5. "I've renewed" stop-confirmation.
        stopped = store_module.stop(confirmed["renewed_token"], reason="renewed")
        rearm_url = f"{emails.BACKEND_BASE_URL}/rearm?token={stopped['unsubscribe_token']}"
        stop_email = emails.stop_confirmation_email(
            "renewed", STATE_NAME, rearm_url,
            f"{emails.BACKEND_BASE_URL}/unsubscribe?token={stopped['unsubscribe_token']}",
            first_name=TEST_FIRST_NAME,
        )
        send_and_report(whitelisted_sender, real_sendgrid, "8. Stop confirmation (renewed)", stop_email, results)

    finally:
        # Restore the hard-fail-by-default posture immediately, even if a
        # send above raised -- this override must never outlive this run.
        emails.clear_test_mailing_address_override()
        print()
        print(f"WhitelistedSender refused {whitelisted_sender.refused_count} out-of-whitelist send(s) this run.")
        print(f"Total attempted sends: {len(results)}. Succeeded: {sum(1 for r in results if r['sent_ok'])}.")
        # Clean up scratch storage -- never leave test artifacts behind.
        for p in (store_module.STORE_PATH, sender_module.CIRCUIT_BREAKER_STATE_PATH,
                  sender_module.CIRCUIT_BREAKER_ALERT_LOG_PATH):
            try:
                if p.exists():
                    p.unlink()
            except Exception:
                pass

    print()
    print("=== Results summary (no API key ever printed) ===")
    for r in results:
        print(r)


if __name__ == "__main__":
    main()
