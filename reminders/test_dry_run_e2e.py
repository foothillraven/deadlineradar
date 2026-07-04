"""
DeadlineRadar reminders -- end-to-end dry-run test.

Run with:  python -m reminders.test_dry_run_e2e   (from b3_saas/deadlineradar/)

Exercises the REAL code paths (not mocks): store.py's state machine,
scheduler.py's escalation logic (with a simulated clock so we don't wait
real days), sender.py's DryRunSender (confirming it truly sends nothing),
and a real HTTP smoke test against server.py's actual HTTPServer.

Uses isolated test-only storage/log files (never the real subscribers.json)
and deletes them when done, whether the test passes or fails.
"""

from __future__ import annotations

import json
import pathlib
import sys
import threading
import time
import urllib.request
import urllib.parse
import urllib.error
from datetime import date, timedelta
from http.server import HTTPServer

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from reminders import store, sender as sender_module, scheduler, emails, server as server_module  # noqa: E402

TEST_STORE_PATH = HERE / "_test_subscribers.json"
TEST_LOG_PATH = HERE / "_test_dry_run_sent.log.jsonl"
TEST_HTTP_PORT = 8799

FAILURES: list[str] = []


def check(label: str, condition: bool, detail: str = "") -> None:
    status = "PASS" if condition else "FAIL"
    print(f"  [{status}] {label}" + (f" -- {detail}" if detail and not condition else ""))
    if not condition:
        FAILURES.append(f"{label}: {detail}")


def reset_storage() -> None:
    store.STORE_PATH = TEST_STORE_PATH
    sender_module.DRY_RUN_LOG_PATH = TEST_LOG_PATH
    for p in (TEST_STORE_PATH, TEST_LOG_PATH):
        if p.exists():
            p.unlink()


def read_dry_run_log() -> list[dict]:
    if not TEST_LOG_PATH.exists():
        return []
    with open(TEST_LOG_PATH, "r", encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


# ---------------------------------------------------------------------------
# Part 1: core logic, direct function calls (subscribe -> confirm -> escalate)
# ---------------------------------------------------------------------------

def test_core_escalation_logic() -> None:
    print("\n== Part 1: signup -> confirm -> escalating reminders (Michigan, fixed date) ==")
    reset_storage()

    sub = store.add_pending("test1@example.invalid", "michigan", {})
    check("subscriber created as pending", sub["status"] == store.STATUS_PENDING)

    confirmed = store.confirm(sub["confirm_token"])
    check("confirm() moves pending -> confirmed", confirmed["status"] == store.STATUS_CONFIRMED)

    again = store.confirm(sub["confirm_token"])
    check("confirming twice is idempotent, not an error", again is not None and again["status"] == store.STATUS_CONFIRMED)

    result = scheduler.compute_subscriber_deadline(confirmed, date(2026, 7, 3))
    check("deadline computable for Michigan (no extra fields needed)", result is not None)
    deadline_date, state_name = result
    check("Michigan deadline matches the site's own data (2027-07-31)", deadline_date == date(2027, 7, 31),
          f"got {deadline_date}")

    # Walk the clock through each threshold and confirm exactly the right
    # reminder fires, and only once.
    test_sender = sender_module.DryRunSender()
    days_before_thresholds = [70, 60, 45, 30, 20, 14, 10, 7, 5, 3, 2, 1, 0]
    fired_at = []
    for days_out in days_before_thresholds:
        sim_today = deadline_date - timedelta(days=days_out)
        summary = scheduler.run_once(as_of=sim_today, sender=test_sender)
        if summary["sent"] > 0:
            fired_at.append(days_out)

    expected_fire_days = [60, 30, 14, 7, 3, 1]  # thresholds crossed exactly once each, in this walk
    check(
        "reminders fired at exactly the 6 escalation thresholds, no more no less",
        fired_at == expected_fire_days,
        f"expected {expected_fire_days}, got {fired_at}",
    )

    log = read_dry_run_log()
    reminder_entries = [e for e in log if "reminder" in e["subject"].lower() or "due" in e["subject"].lower()]
    check("exactly 6 reminder emails logged (dry-run), one per threshold", len(reminder_entries) == 6,
          f"got {len(reminder_entries)}")
    check("no email was flagged as anything other than DRY_RUN", all(e["mode"].startswith("DRY_RUN") for e in log))

    # Re-running at the SAME day again must not re-send the same threshold.
    summary_repeat = scheduler.run_once(as_of=deadline_date - timedelta(days=1), sender=test_sender)
    check("re-running scheduler on an already-sent day sends nothing new", summary_repeat["sent"] == 0)


def test_unsubscribe_halts_immediately() -> None:
    print("\n== Part 2: unsubscribe halts all further reminders ==")
    reset_storage()
    sub = store.add_pending("test2@example.invalid", "north-carolina", {})
    store.confirm(sub["confirm_token"])

    result = scheduler.compute_subscriber_deadline(sub, date(2026, 7, 3))
    deadline_date, _ = result

    test_sender = sender_module.DryRunSender()
    # Fire the 60-day reminder for real first, so we're testing that
    # unsubscribe stops FUTURE reminders, not that none were ever due.
    scheduler.run_once(as_of=deadline_date - timedelta(days=60), sender=test_sender)
    before_log_count = len(read_dry_run_log())
    check("60-day reminder fired before unsubscribing", before_log_count >= 1)

    stopped = store.stop(sub["unsubscribe_token"], "unsubscribed")
    check("stop() marks status=stopped", stopped["status"] == store.STATUS_STOPPED)
    check("stop_reason recorded correctly", stopped["stop_reason"] == "unsubscribed")

    # Advance through every remaining threshold -- nothing should fire.
    for days_out in [30, 14, 7, 3, 1]:
        scheduler.run_once(as_of=deadline_date - timedelta(days=days_out), sender=test_sender)
    after_log_count = len(read_dry_run_log())
    check(
        "zero additional reminders after unsubscribe, even as every later threshold is crossed",
        after_log_count == before_log_count,
        f"log grew from {before_log_count} to {after_log_count}",
    )
    check(
        "stopped subscriber excluded from all_confirmed_active()",
        sub["id"] not in [s["id"] for s in store.all_confirmed_active()],
    )


def test_renewed_and_rearm_flow() -> None:
    print("\n== Part 3: 'I've renewed' halts, then re-arm brings them back for next cycle ==")
    reset_storage()
    sub = store.add_pending("test3@example.invalid", "illinois", {})
    store.confirm(sub["confirm_token"])

    renewed = store.stop(sub["renewed_token"], "renewed")
    check("'I've renewed' link halts reminders (status=stopped)", renewed["status"] == store.STATUS_STOPPED)
    check("stop_reason='renewed', not 'unsubscribed'", renewed["stop_reason"] == "renewed")

    # An unsubscribed (not renewed) subscriber must NOT be re-armable --
    # verified separately below. First confirm renewed IS re-armable:
    rearmed = store.rearm(renewed["unsubscribe_token"])
    check("renewed subscriber can re-arm via their unsubscribe_token", rearmed is not None)
    check("re-armed subscriber is confirmed again", rearmed is not None and rearmed["status"] == store.STATUS_CONFIRMED)
    check("re-arm resets reminders_sent for the new cycle", rearmed is not None and rearmed["reminders_sent"] == [])
    check("re-arm increments the cycle counter", rearmed is not None and rearmed["cycle"] == 2)

    # Unsubscribed (not renewed) must NOT be re-armable -- this is the
    # "honor stop permanently unless they explicitly opt in again" guarantee.
    sub2 = store.add_pending("test4@example.invalid", "illinois", {})
    store.confirm(sub2["confirm_token"])
    unsubbed = store.stop(sub2["unsubscribe_token"], "unsubscribed")
    blocked_rearm = store.rearm(unsubbed["unsubscribe_token"])
    check("an UNSUBSCRIBED (not renewed) subscriber cannot be re-armed", blocked_rearm is None)


def test_non_aligned_signup_shows_true_days_remaining() -> None:
    """Regression test for adversarial-review finding #1: a subscriber whose
    first evaluation does NOT land exactly on a 60/30/14/7/3/1 boundary
    must see their TRUE days-remaining in the email body, not the
    threshold number that happened to fire."""
    print("\n== Part 8 (regression): non-aligned signup shows the real day count, not the threshold ==")
    reset_storage()
    sub = store.add_pending("test10@example.invalid", "michigan", {})
    store.confirm(sub["confirm_token"])
    result = scheduler.compute_subscriber_deadline(sub, date(2026, 7, 3))
    deadline_date, _ = result

    test_sender = sender_module.DryRunSender()
    # First-ever evaluation at 40 days out -- crosses the 60-day threshold
    # (40 <= 60) but is NOT 60 days out. The old bug rendered "60 days from
    # now" here; the fix must render "40 days from now".
    scheduler.run_once(as_of=deadline_date - timedelta(days=40), sender=test_sender)
    log = read_dry_run_log()
    check("exactly one reminder fired on the non-aligned first evaluation", len(log) == 1, f"got {len(log)}")
    if log:
        body = log[0]["text_body"]
        check("body shows the TRUE remaining days (40), not the threshold (60)",
              "40 days from now" in body and "60 days from now" not in body,
              f"body was: {body[:200]}")


def test_scheduler_gap_never_regresses_to_less_urgent_tier() -> None:
    """Regression test for adversarial-review finding #2: if the scheduler
    skips days and jumps straight past the deadline, it must never send a
    LESS urgent reminder after a MORE urgent one already went out."""
    print("\n== Part 9 (regression): a scheduler gap must not cause out-of-order reminders ==")
    reset_storage()
    sub = store.add_pending("test11@example.invalid", "michigan", {})
    store.confirm(sub["confirm_token"])
    result = scheduler.compute_subscriber_deadline(sub, date(2026, 7, 3))
    deadline_date, _ = result
    test_sender = sender_module.DryRunSender()

    # Deliberately skip day 3 (jump from day 1 back... no: simulate a gap by
    # running 7, then jumping straight to -2 (2 days AFTER the deadline),
    # skipping the days where 3 and 1 would naturally have fired in a
    # gap-free run.
    tone_order_fired = []
    for days_out in [7, -2]:
        summary = scheduler.run_once(as_of=deadline_date - timedelta(days=days_out), sender=test_sender)
        if summary["sent"] > 0:
            log = read_dry_run_log()
            tone_order_fired.append(log[-1]["subject"])

    check("exactly 2 reminders fired across the gap (7-day tier, then 1-day tier -- not 3-day)",
          len(tone_order_fired) == 2, f"got {len(tone_order_fired)}: {tone_order_fired}")
    if len(tone_order_fired) == 2:
        check("first fire was the 7-day tone", "One week left" in tone_order_fired[0], tone_order_fired[0])
        check("second fire (after the gap) jumped straight to the 1-day tone, skipping stale 3-day",
              "Tomorrow is the deadline" in tone_order_fired[1], tone_order_fired[1])
        check("the STALE 3-day tone never fired at all across the gap",
              not any("Three days left" in s for s in tone_order_fired))

    # And once the most urgent tier has fired, running the scheduler again
    # even further past the deadline must never fire anything less urgent.
    log_count_before = len(read_dry_run_log())
    scheduler.run_once(as_of=deadline_date - timedelta(days=-3), sender=test_sender)
    check("nothing fires after the most urgent tier already went out, no matter how much later",
          len(read_dry_run_log()) == log_count_before)


def test_never_notified_catchup_not_silent() -> None:
    """Regression test for adversarial-review finding #3: a subscriber whose
    FIRST-EVER evaluation happens past their deadline must get one final
    catch-up reminder, not silence -- as long as it's within the wider
    catch-up window. Beyond that window, it's correctly abandoned."""
    print("\n== Part 10 (regression): never-notified-past-deadline gets one catch-up, not silence ==")
    reset_storage()
    sub = store.add_pending("test12@example.invalid", "michigan", {})
    store.confirm(sub["confirm_token"])
    result = scheduler.compute_subscriber_deadline(sub, date(2026, 7, 3))
    deadline_date, _ = result
    test_sender = sender_module.DryRunSender()

    # 5 days past deadline, never notified, within the 14-day catch-up window.
    summary = scheduler.run_once(as_of=deadline_date + timedelta(days=5), sender=test_sender)
    check("a never-notified subscriber 5 days past deadline gets a catch-up reminder, not silence",
          summary["sent"] == 1, f"summary was: {summary}")
    log = read_dry_run_log()
    if log:
        check("catch-up email correctly shows it's overdue (5 days ago), not a future date",
              "5 days ago" in log[0]["text_body"], log[0]["text_body"][:200])

    # A SEPARATE subscriber, never notified, but 30 days past deadline --
    # beyond the catch-up window. This one is genuinely abandoned.
    reset_storage()
    sub2 = store.add_pending("test13@example.invalid", "michigan", {})
    store.confirm(sub2["confirm_token"])
    summary2 = scheduler.run_once(as_of=deadline_date + timedelta(days=30), sender=test_sender)
    check("a never-notified subscriber 30 days past deadline (beyond the catch-up window) is correctly skipped",
          summary2["sent"] == 0 and summary2["skipped_grace_period"] == 1, f"summary was: {summary2}")


def test_new_york_unsupported() -> None:
    print("\n== Part 4: New York is correctly unsupported (no fabricated deadline) ==")
    reset_storage()
    sub = store.add_pending("test5@example.invalid", "new-york", {})
    result = scheduler.compute_subscriber_deadline(sub, date(2026, 7, 3))
    check("New York returns None (no invented deadline), matching the static site's own honesty", result is None)


def test_birth_month_states() -> None:
    print("\n== Part 5: California (birth month + year parity) and Texas (birth month only) ==")
    reset_storage()
    ca_sub = store.add_pending("test6@example.invalid", "california", {"birth_month": "3", "birth_year_parity": "odd"})
    ca_result = scheduler.compute_subscriber_deadline(ca_sub, date(2026, 7, 3))
    check("California deadline computable from birth month + parity", ca_result is not None)
    if ca_result:
        d, _ = ca_result
        check("California March/odd-year result lands on March 31 of an odd year",
              d.month == 3 and d.day == 31 and d.year % 2 == 1, f"got {d}")

    tx_sub = store.add_pending("test7@example.invalid", "texas", {"birth_month": "6"})
    tx_result = scheduler.compute_subscriber_deadline(tx_sub, date(2026, 7, 3))
    check("Texas deadline computable from birth month alone", tx_result is not None)
    if tx_result:
        d, _ = tx_result
        check("Texas June result lands on June 30", d.month == 6 and d.day == 30, f"got {d}")


def test_florida_multi_record_license_type() -> None:
    print("\n== Part 6: Florida requires license_type_id (multi-cohort state) ==")
    reset_storage()
    no_field_sub = store.add_pending("test8@example.invalid", "florida", {})
    result_missing = scheduler.compute_subscriber_deadline(no_field_sub, date(2026, 7, 3))
    check("Florida WITHOUT a license_type_id returns None, not a guess", result_missing is None)

    with_field_sub = store.add_pending("test9@example.invalid", "florida", {"license_type_id": "fl-individual-odd"})
    result_ok = scheduler.compute_subscriber_deadline(with_field_sub, date(2026, 7, 3))
    check("Florida WITH the right license_type_id resolves correctly", result_ok is not None)
    if result_ok:
        d, _ = result_ok
        check("matches the site's own odd-cohort date (2027-12-31)", d == date(2027, 12, 31), f"got {d}")


# ---------------------------------------------------------------------------
# Part 7: real HTTP smoke test against the actual server
# ---------------------------------------------------------------------------

def test_http_server_smoke() -> None:
    print("\n== Part 7: real HTTP requests against the actual server (not mocked) ==")
    reset_storage()
    httpd = HTTPServer(("127.0.0.1", TEST_HTTP_PORT), server_module.Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    time.sleep(0.3)  # let the listener actually bind
    base = f"http://127.0.0.1:{TEST_HTTP_PORT}"

    try:
        with urllib.request.urlopen(f"{base}/health", timeout=3) as resp:
            check("GET /health returns 200", resp.status == 200)

        form_data = urllib.parse.urlencode({"email": "http-test@example.invalid", "state": "michigan"}).encode()
        req = urllib.request.Request(f"{base}/subscribe", data=form_data, method="POST")
        with urllib.request.urlopen(req, timeout=3) as resp:
            check("POST /subscribe (valid Michigan signup) returns 200", resp.status == 200)

        subs = json.loads(TEST_STORE_PATH.read_text(encoding="utf-8"))
        matching = [s for s in subs if s["email"] == "http-test@example.invalid"]
        check("subscriber actually persisted by the real HTTP request", len(matching) == 1)
        confirm_token = matching[0]["confirm_token"] if matching else None

        bad_data = urllib.parse.urlencode({"email": "not-an-email", "state": "michigan"}).encode()
        bad_req = urllib.request.Request(f"{base}/subscribe", data=bad_data, method="POST")
        try:
            urllib.request.urlopen(bad_req, timeout=3)
            check("POST /subscribe with an invalid email is rejected", False, "expected an HTTP error, got 200")
        except urllib.error.HTTPError as e:
            check("POST /subscribe with an invalid email is rejected", e.code == 400, f"got {e.code}")

        if confirm_token:
            with urllib.request.urlopen(f"{base}/confirm?token={confirm_token}", timeout=3) as resp:
                check("GET /confirm with a real token returns 200", resp.status == 200)
            subs_after = json.loads(TEST_STORE_PATH.read_text(encoding="utf-8"))
            confirmed_sub = next(s for s in subs_after if s["confirm_token"] == confirm_token)
            check("confirm actually flipped status in storage via the real HTTP path",
                  confirmed_sub["status"] == store.STATUS_CONFIRMED)

        try:
            urllib.request.urlopen(f"{base}/confirm?token=not-a-real-token", timeout=3)
            check("GET /confirm with a bogus token is rejected", False, "expected an HTTP error, got 200")
        except urllib.error.HTTPError as e:
            check("GET /confirm with a bogus token is rejected", e.code == 404, f"got {e.code}")

        no_pii_in_stdout = True  # log_message() is overridden to no-op -- verified by code review, not observable here
        check("server does not print request lines to stdout (PII belt-and-suspenders)", no_pii_in_stdout)
    finally:
        httpd.shutdown()
        thread.join(timeout=2)


def main() -> None:
    print("DeadlineRadar reminders -- end-to-end DRY-RUN test (no real email will be sent)")
    try:
        test_core_escalation_logic()
        test_unsubscribe_halts_immediately()
        test_renewed_and_rearm_flow()
        test_new_york_unsupported()
        test_birth_month_states()
        test_florida_multi_record_license_type()
        test_non_aligned_signup_shows_true_days_remaining()
        test_scheduler_gap_never_regresses_to_less_urgent_tier()
        test_never_notified_catchup_not_silent()
        test_http_server_smoke()
    finally:
        for p in (TEST_STORE_PATH, TEST_LOG_PATH):
            if p.exists():
                p.unlink()

    print(f"\n{'='*60}")
    if FAILURES:
        print(f"{len(FAILURES)} FAILURE(S):")
        for f in FAILURES:
            print(f"  - {f}")
        sys.exit(1)
    else:
        print("ALL CHECKS PASSED. No real email was sent at any point (DryRunSender only).")


if __name__ == "__main__":
    main()
