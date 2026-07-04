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
import os
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
TEST_CB_STATE_PATH = HERE / "_test_send_circuit_breaker_state.json"
TEST_CB_ALERT_LOG_PATH = HERE / "_test_circuit_breaker_alerts.log.jsonl"
TEST_HTTP_PORT = 8799
TEST_HTTP_PORT_2 = 8798

# A fake, obviously-test-only mailing address -- NEVER a real one. Set as the
# test override for every test in this suite EXCEPT the ones that
# specifically verify the hard-fail-when-unset behavior (Part 23), which
# clear it deliberately and restore it afterward.
TEST_MAILING_ADDRESS = "123 Test Fixture Way, Testville, TS 00000 (fake -- test suite only)"

FAILURES: list[str] = []


def check(label: str, condition: bool, detail: str = "") -> None:
    status = "PASS" if condition else "FAIL"
    print(f"  [{status}] {label}" + (f" -- {detail}" if detail and not condition else ""))
    if not condition:
        FAILURES.append(f"{label}: {detail}")


def reset_storage() -> None:
    store.STORE_PATH = TEST_STORE_PATH
    sender_module.DRY_RUN_LOG_PATH = TEST_LOG_PATH
    sender_module.CIRCUIT_BREAKER_STATE_PATH = TEST_CB_STATE_PATH
    sender_module.CIRCUIT_BREAKER_ALERT_LOG_PATH = TEST_CB_ALERT_LOG_PATH
    # Also reset the in-memory per-IP rate limiter between tests -- otherwise
    # an earlier test's hammering would bleed into a later test's quota.
    server_module._RATE_LIMIT_HITS.clear()
    # This suite exercises real email-building code paths (emails.py now
    # hard-fails without a mailing address -- see Part 23 below, which is
    # the ONE test group that deliberately clears this). Every other test
    # needs a fake-but-configured address so it can exercise the rest of the
    # send path without hitting that hard-fail.
    emails.set_test_mailing_address_override(TEST_MAILING_ADDRESS)
    for p in (TEST_STORE_PATH, TEST_LOG_PATH, TEST_CB_STATE_PATH, TEST_CB_ALERT_LOG_PATH):
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
    # This test path only ever calls scheduler.run_once() directly -- no
    # confirmation/stop-confirmation email is ever built or sent here (those
    # only happen via server.py's handlers) -- so every log entry IS a
    # reminder email; no subject-text filter needed (and the new escalating
    # subjects don't all share one common substring like the old ones did).
    reminder_entries = log
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
        check("first fire was the 7-day tier's subject (deadline-front-loaded, 'in 7 days')",
              "in 7 days" in tone_order_fired[0], tone_order_fired[0])
        check("second fire (after the gap) jumped straight to the 1-day tier's subject "
              "(overdue by the time it fired, correctly says so), skipping stale 3-day",
              "your Michigan CPA license renewal is due" in tone_order_fired[1]
              and "Overdue" in tone_order_fired[1],
              tone_order_fired[1])
        check("the STALE 3-day tier's subject never fired at all across the gap",
              not any("in 3 days" in s for s in tone_order_fired))

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
# Parts 11-17: abuse-hardening audit (2026-07-03) -- real attacks against the
# real code, one per audited row. Each test tries to actually break the
# defense, not just call the happy path.
# ---------------------------------------------------------------------------

def test_cooldown_and_dedupe_block_repeat_signup_spam() -> None:
    """Attack simulation for row 2 (dedupe + cooldown). Directive's own
    attack test: 'submit victim@x 100x -> exactly 1 email would send.'"""
    print("\n== Part 11 (abuse-hardening row 2): cooldown+dedupe block repeat-signup spam ==")
    reset_storage()
    victim = "victim@example.invalid"

    sent_count = 0
    for _ in range(100):
        if store.within_signup_cooldown(victim) or store.find_active_or_pending(victim, "michigan") is not None:
            continue  # server.py's _handle_subscribe would no-op here too
        store.add_pending(victim, "michigan", {})
        sent_count += 1

    check("100 rapid submissions of the same email produce at most 1 real signup", sent_count == 1, f"got {sent_count}")
    all_records = [s for s in json.loads(TEST_STORE_PATH.read_text(encoding="utf-8")) if s["email"] == victim]
    check("only 1 subscriber record exists for the victim after 100 submissions", len(all_records) == 1,
          f"got {len(all_records)}")
    check("cooldown blocks even a DIFFERENT state for the same email (can't dodge via state=)",
          store.within_signup_cooldown(victim))


def test_honeypot_silently_blocks_bots() -> None:
    """Attack simulation for row 3a (honeypot). A bot that fills every field
    (including the hidden one) must get a fake-success response and cause
    NO record and NO email -- never a visible rejection that would teach
    the bot to stop filling that field."""
    print("\n== Part 12 (abuse-hardening row 3a): honeypot silently no-ops bot submissions ==")
    reset_storage()
    httpd = HTTPServer(("127.0.0.1", TEST_HTTP_PORT + 1), server_module.Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    time.sleep(0.3)
    base = f"http://127.0.0.1:{TEST_HTTP_PORT + 1}"
    try:
        form_data = urllib.parse.urlencode({
            "email": "bot-target@example.invalid",
            "state": "michigan",
            server_module.HONEYPOT_FIELD_NAME: "http://spam.example",
        }).encode()
        req = urllib.request.Request(f"{base}/subscribe", data=form_data, method="POST")
        with urllib.request.urlopen(req, timeout=3) as resp:
            body = resp.read()
            check("honeypot-tripped submission still returns 200 (never tips off the bot)", resp.status == 200)
            check("honeypot-tripped submission gets the IDENTICAL success page a real signup gets",
                  b"Almost done" in body)
        subs = json.loads(TEST_STORE_PATH.read_text(encoding="utf-8")) if TEST_STORE_PATH.exists() else []
        matching = [s for s in subs if s["email"] == "bot-target@example.invalid"]
        check("NO subscriber record created for the honeypot-tripped submission", len(matching) == 0,
              f"got {len(matching)}")
        check("NO confirmation email sent for the honeypot-tripped submission", len(read_dry_run_log()) == 0,
              f"got {len(read_dry_run_log())}")
    finally:
        httpd.shutdown()
        thread.join(timeout=2)


def test_rate_limit_blocks_ip_hammering() -> None:
    """Attack simulation for row 3b (per-IP rate limit). Script-hammers
    /subscribe with distinct emails (isolating the IP limiter from
    cooldown/dedupe) and confirms it gets throttled, per the directive's own
    attack test."""
    print("\n== Part 13 (abuse-hardening row 3b): per-IP rate limit throttles script-hammering ==")
    reset_storage()
    httpd = HTTPServer(("127.0.0.1", TEST_HTTP_PORT + 2), server_module.Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    time.sleep(0.3)
    base = f"http://127.0.0.1:{TEST_HTTP_PORT + 2}"
    try:
        max_allowed, _ = server_module.RATE_LIMIT_SUBSCRIBE
        statuses = []
        for i in range(max_allowed + 5):
            form_data = urllib.parse.urlencode({"email": f"hammer{i}@example.invalid", "state": "michigan"}).encode()
            req = urllib.request.Request(f"{base}/subscribe", data=form_data, method="POST")
            try:
                with urllib.request.urlopen(req, timeout=3) as resp:
                    statuses.append(resp.status)
            except urllib.error.HTTPError as e:
                statuses.append(e.code)
        allowed = [s for s in statuses if s == 200]
        blocked = [s for s in statuses if s == 429]
        check(f"exactly {max_allowed} requests allowed from one IP before the limit trips",
              len(allowed) == max_allowed, f"statuses were: {statuses}")
        check("every request past the limit is blocked (429), not silently processed",
              len(blocked) == 5, f"statuses were: {statuses}")
    finally:
        httpd.shutdown()
        thread.join(timeout=2)


def test_circuit_breaker_halts_after_daily_cap() -> None:
    """Attack simulation for row 4 (send circuit breaker). Drives a
    low-cap breaker past its limit and confirms it HALTS rather than ever
    exceeding the cap, and that the trip is alerted, not silent."""
    print("\n== Part 14 (abuse-hardening row 4): circuit breaker halts sends after the daily cap ==")
    reset_storage()
    cb = sender_module.CircuitBreakerSender(sender_module.DryRunSender(), daily_cap=3)
    results = [cb.send(f"test{i}@example.invalid", "subject", "body") for i in range(5)]
    check("first 3 sends succeed (under the cap)", results[:3] == [True, True, True], f"got {results}")
    check("4th and 5th sends are refused once the cap is hit, never exceeding it",
          results[3:] == [False, False], f"got {results}")
    check("exactly 3 emails reached the underlying sender, never more than the cap",
          len(read_dry_run_log()) == 3, f"got {len(read_dry_run_log())}")
    check("the breaker tripping wrote an alert, not a silent halt", TEST_CB_ALERT_LOG_PATH.exists())
    if TEST_CB_ALERT_LOG_PATH.exists():
        alerts = [json.loads(line) for line in TEST_CB_ALERT_LOG_PATH.read_text(encoding="utf-8").splitlines() if line.strip()]
        check("at least one alert entry was actually written", len(alerts) >= 1, f"got {len(alerts)}")


def test_permanent_suppression_survives_a_status_bug() -> None:
    """Attack simulation for row 5 (permanent suppression). Directly
    corrupts a stopped subscriber's status field (bypassing store.rearm()
    entirely, simulating a hypothetical future bug elsewhere) and confirms
    the INDEPENDENT suppression check still blocks the send -- defense in
    depth, not reliant on the status field alone."""
    print("\n== Part 15 (abuse-hardening row 5): suppression holds even if status gets corrupted ==")
    reset_storage()
    sub = store.add_pending("stopped-victim@example.invalid", "michigan", {})
    store.confirm(sub["confirm_token"])
    result = scheduler.compute_subscriber_deadline(sub, date(2026, 7, 3))
    deadline_date, _ = result
    store.stop(sub["unsubscribe_token"], "unsubscribed")

    # Simulate a hypothetical status-field bug: flip status back to
    # "confirmed" by editing the store file directly, NOT via store.rearm()
    # (which correctly refuses unsubscribed records). A real bug like this
    # would be a defect elsewhere -- this test proves is_permanently_suppressed()
    # is a second, independent line of defense against exactly that.
    subs = json.loads(TEST_STORE_PATH.read_text(encoding="utf-8"))
    for s in subs:
        if s["id"] == sub["id"]:
            s["status"] = store.STATUS_CONFIRMED
    TEST_STORE_PATH.write_text(json.dumps(subs), encoding="utf-8")

    check("is_permanently_suppressed() still True despite the corrupted status field",
          store.is_permanently_suppressed("stopped-victim@example.invalid"))

    test_sender = sender_module.DryRunSender()
    # Evaluate right at the "tomorrow" threshold -- genuinely due for a real
    # active subscriber -- to prove the block below is the suppression
    # check firing, not simply "nothing was due yet."
    summary = scheduler.run_once(as_of=deadline_date - timedelta(days=1), sender=test_sender)
    check("scheduler blocks the send despite status=confirmed and a genuinely due threshold",
          summary["sent"] == 0, f"summary was: {summary}")
    check("the blocked send is recorded as an explicit error, not silently dropped",
          any("suppressed" in e["error"] for e in summary["errors"]), f"errors were: {summary['errors']}")


def test_input_validation_rejects_malformed_and_injection_payloads() -> None:
    """Attack simulation for row 6 (input validation/sanitization). Fires a
    header-injection-style payload and a non-numeric field at the real
    server and confirms both are rejected cleanly -- no crash, and (fixing
    a bug found during this audit) no orphaned pending record left behind
    from a submission that fails validation partway through."""
    print("\n== Part 16 (abuse-hardening row 6): malformed/injection payloads rejected, no crash, no orphan ==")
    reset_storage()
    httpd = HTTPServer(("127.0.0.1", TEST_HTTP_PORT + 3), server_module.Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    time.sleep(0.3)
    base = f"http://127.0.0.1:{TEST_HTTP_PORT + 3}"
    try:
        payload = urllib.parse.urlencode({
            "email": "inject@example.invalid",
            "state": "michigan",
            "license_type_id": "x\r\nBcc: victim2@example.invalid",
        }).encode()
        req = urllib.request.Request(f"{base}/subscribe", data=payload, method="POST")
        try:
            urllib.request.urlopen(req, timeout=3)
            check("CRLF header-injection payload is rejected, not accepted", False, "expected an HTTP error, got 200")
        except urllib.error.HTTPError as e:
            check("CRLF header-injection payload is rejected with 400", e.code == 400, f"got {e.code}")

        payload2 = urllib.parse.urlencode({
            "email": "crash-attempt@example.invalid",
            "state": "texas",
            "birth_month": "'; DROP TABLE subscribers; --",
        }).encode()
        req2 = urllib.request.Request(f"{base}/subscribe", data=payload2, method="POST")
        try:
            urllib.request.urlopen(req2, timeout=3)
            check("non-numeric birth_month is rejected, not accepted", False, "expected an HTTP error, got 200")
        except urllib.error.HTTPError as e:
            check("non-numeric birth_month is rejected with 400, not a 500 crash", e.code == 400, f"got {e.code}")

        with urllib.request.urlopen(f"{base}/health", timeout=3) as resp:
            check("server survives both attack payloads and still answers /health", resp.status == 200)

        subs = json.loads(TEST_STORE_PATH.read_text(encoding="utf-8")) if TEST_STORE_PATH.exists() else []
        check("neither attack payload left an orphaned subscriber record behind",
              all(s["email"] not in ("inject@example.invalid", "crash-attempt@example.invalid") for s in subs),
              f"records: {[s['email'] for s in subs]}")
    finally:
        httpd.shutdown()
        thread.join(timeout=2)


def test_pii_locality_reverified() -> None:
    """Re-verification for row 7 (PII locality), technically not just by
    policy: .gitignore actually covers every generated-state file, and the
    long-standing minimal-collection claim (birth YEAR is never persisted,
    only parity) still holds after this audit's changes."""
    print("\n== Part 17 (abuse-hardening row 7): PII locality + minimal-collection re-verified ==")
    reset_storage()
    sub = store.add_pending("ca-sub@example.invalid", "california", {"birth_month": "3", "birth_year_parity": "odd"})
    check("California subscriber record has NO birth_year field, only parity",
          "birth_year" not in sub["deadline_fields"], f"deadline_fields were: {sub['deadline_fields']}")

    # Checks actual `git check-ignore` behavior, not just gitignore text
    # content -- the abuse-hardening audit's row 7 fix replaced an
    # enumerated-filename list with a content-shape denylist
    # (`reminders/*.json` / `*.jsonl` / `_*`), so asserting on the OLD exact
    # strings would be a stale test giving a false failure on a real fix.
    import subprocess
    pii_paths = [
        "reminders/subscribers.json",
        "reminders/dry_run_sent.log.jsonl",
        "reminders/send_circuit_breaker_state.json",
        "reminders/circuit_breaker_alerts.log.jsonl",
        "reminders/_attack_whatever_prefix.json",  # any future scratch prefix
    ]
    result = subprocess.run(
        ["git", "check-ignore"] + pii_paths, cwd=HERE.parent, capture_output=True, text=True,
    )
    ignored_paths = set(result.stdout.strip().splitlines())
    for p in pii_paths:
        check(f"git actually ignores {p}", p in ignored_paths, f"git check-ignore output: {result.stdout!r}")

    tracked_paths = ["reminders/__init__.py", "reminders/subscribers.example.json"]
    result2 = subprocess.run(
        ["git", "check-ignore"] + tracked_paths, cwd=HERE.parent, capture_output=True, text=True,
    )
    for p in tracked_paths:
        check(f"git does NOT ignore real tracked file {p}", p not in result2.stdout, f"output: {result2.stdout!r}")


# ---------------------------------------------------------------------------
# Parts 18-22: regression tests for the 5 real bypasses an INDEPENDENT
# adversarial workflow (a separate set of agents red-teaming this same
# feature, not this file) found in the first abuse-hardening pass. Each test
# reproduces the exact attack that broke it before the fix.
# ---------------------------------------------------------------------------

def test_pending_subscriber_cannot_bypass_double_optin() -> None:
    """Regression test for a real bypass an independent red-team pass
    found: a still-pending (never confirmed) subscriber could be flipped
    all the way to status=confirmed via /renewed + /rearm using only
    signup-time tokens, with /confirm never called -- and could get a
    second (spurious) email via /unsubscribe before ever confirming."""
    print("\n== Part 18 (abuse-hardening row 1 fix): pending subscriber can't bypass double opt-in ==")
    reset_storage()
    httpd = HTTPServer(("127.0.0.1", TEST_HTTP_PORT + 4), server_module.Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    time.sleep(0.3)
    base = f"http://127.0.0.1:{TEST_HTTP_PORT + 4}"
    try:
        form_data = urllib.parse.urlencode({"email": "pending-victim@example.invalid", "state": "michigan"}).encode()
        req = urllib.request.Request(f"{base}/subscribe", data=form_data, method="POST")
        urllib.request.urlopen(req, timeout=3).read()
        subs = json.loads(TEST_STORE_PATH.read_text(encoding="utf-8"))
        pending = next(s for s in subs if s["email"] == "pending-victim@example.invalid")
        check("subscriber created as pending, never confirmed", pending["status"] == store.STATUS_PENDING)
        check("exactly 1 email (the confirmation) sent so far", len(read_dry_run_log()) == 1)

        try:
            urllib.request.urlopen(f"{base}/renewed?token={pending['renewed_token']}", timeout=3)
            renewed_status = 200
        except urllib.error.HTTPError as e:
            renewed_status = e.code
        check("/renewed on a never-confirmed subscriber is REFUSED (404), not honored",
              renewed_status == 404, f"got {renewed_status}")
        still_pending = next(s for s in json.loads(TEST_STORE_PATH.read_text(encoding="utf-8")) if s["id"] == pending["id"])
        check("status is still pending_confirmation after the /renewed attack",
              still_pending["status"] == store.STATUS_PENDING, f"got {still_pending['status']}")

        try:
            urllib.request.urlopen(f"{base}/rearm?token={pending['unsubscribe_token']}", timeout=3)
            rearm_status = 200
        except urllib.error.HTTPError as e:
            rearm_status = e.code
        check("/rearm on a subscriber never legitimately stopped-via-renewed is REFUSED (404)",
              rearm_status == 404, f"got {rearm_status}")
        check("scheduler still excludes this record (all_confirmed_active)",
              pending["id"] not in [s["id"] for s in store.all_confirmed_active()])

        with urllib.request.urlopen(f"{base}/unsubscribe?token={pending['unsubscribe_token']}", timeout=3) as resp:
            check("/unsubscribe on a pending subscriber is still honored (200)", resp.status == 200)
        stopped = next(s for s in json.loads(TEST_STORE_PATH.read_text(encoding="utf-8")) if s["id"] == pending["id"])
        check("pending subscriber is now permanently stopped", stopped["status"] == store.STATUS_STOPPED)
        check("STILL only 1 email total was ever sent to this never-confirmed address",
              len(read_dry_run_log()) == 1, f"got {len(read_dry_run_log())}")
    finally:
        httpd.shutdown()
        thread.join(timeout=2)


def test_gmail_style_dot_plustag_addresses_share_cooldown() -> None:
    """Regression test for a real bypass an independent red-team pass
    found: Gmail-style dot-insensitivity and '+tag' sub-addressing let
    an attacker generate multiple distinct confirmation emails to the
    SAME real inbox within the cooldown window."""
    print("\n== Part 19 (abuse-hardening row 2 fix): Gmail dot/+tag variants share one cooldown ==")
    reset_storage()
    variants = [
        "victim.name@gmail.com",
        "victim.name+a@gmail.com",
        "victim.name+b@gmail.com",
        "victimname@gmail.com",
        "vic.tim.name@gmail.com",
    ]
    sent_count = 0
    for v in variants:
        if store.within_signup_cooldown(v) or store.find_active_or_pending(v, "michigan") is not None:
            continue
        store.add_pending(v, "michigan", {})
        sent_count += 1
    check("5 Gmail dot/+tag variants of the same real inbox produce at most 1 real signup",
          sent_count == 1, f"got {sent_count}")
    check("an unrelated address is NOT swept into the Gmail victim's cooldown",
          not store.within_signup_cooldown("totally-different@example.invalid"))


def test_honeypot_whitespace_only_value_still_blocked() -> None:
    """Regression test for a real bypass an independent red-team pass
    found: a whitespace-only honeypot value slipped past the old
    `.strip()`-truthiness check."""
    print("\n== Part 20 (abuse-hardening row 3 fix): whitespace-only honeypot value still caught ==")
    reset_storage()
    httpd = HTTPServer(("127.0.0.1", TEST_HTTP_PORT + 5), server_module.Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    time.sleep(0.3)
    base = f"http://127.0.0.1:{TEST_HTTP_PORT + 5}"
    try:
        form_data = urllib.parse.urlencode({
            "email": "whitespace-bot@example.invalid",
            "state": "michigan",
            server_module.HONEYPOT_FIELD_NAME: "   ",
        }).encode()
        req = urllib.request.Request(f"{base}/subscribe", data=form_data, method="POST")
        with urllib.request.urlopen(req, timeout=3) as resp:
            check("whitespace-only honeypot submission still returns 200 (doesn't tip off the bot)",
                  resp.status == 200)
        subs = json.loads(TEST_STORE_PATH.read_text(encoding="utf-8")) if TEST_STORE_PATH.exists() else []
        check("NO subscriber record created for a whitespace-only honeypot fill",
              len([s for s in subs if s["email"] == "whitespace-bot@example.invalid"]) == 0)
        check("NO email sent for a whitespace-only honeypot fill", len(read_dry_run_log()) == 0)
    finally:
        httpd.shutdown()
        thread.join(timeout=2)


def test_circuit_breaker_holds_cap_under_concurrency() -> None:
    """Regression test for a real bypass an independent red-team pass
    found: the unlocked load-check-increment-save sequence let concurrent
    threads blow well past the configured daily cap."""
    print("\n== Part 21 (abuse-hardening row 4 fix): circuit breaker holds the cap under real thread concurrency ==")
    reset_storage()
    cap = 5
    n_threads = 40
    cb = sender_module.CircuitBreakerSender(sender_module.DryRunSender(), daily_cap=cap)
    results: list = [None] * n_threads

    def worker(i: int) -> None:
        results[i] = cb.send(f"race{i}@example.invalid", "subject", "body")

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(n_threads)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=5)

    true_sends = len(read_dry_run_log())
    check(f"under {n_threads}-thread concurrency, at most {cap} sends actually went through, never more",
          true_sends <= cap, f"got {true_sends} real sends logged (cap was {cap})")
    check("the number of True-returning calls matches the real send count (no lost/duplicate accounting)",
          sum(1 for r in results if r) == true_sends,
          f"True count was {sum(1 for r in results if r)}, log had {true_sends}")


def test_suppression_lifts_after_a_genuine_later_confirm() -> None:
    """Regression test for a real bypass (in the over-blocking direction)
    an independent red-team pass found: is_permanently_suppressed() used
    to block EVERY future signup for an email that had ever unsubscribed,
    even a wholly separate, genuinely re-confirmed later record -- a
    product-breaking bug, not a security win."""
    print("\n== Part 22 (abuse-hardening row 5 fix): a later, real confirm lifts suppression ==")
    reset_storage()
    email = "reformed-victim@example.invalid"
    sub_a = store.add_pending(email, "florida", {"license_type_id": "fl-individual-odd"})
    store.confirm(sub_a["confirm_token"])
    store.stop(sub_a["unsubscribe_token"], "unsubscribed")
    check("immediately after unsubscribing, the email is suppressed", store.is_permanently_suppressed(email))

    sub_b = store.add_pending(email, "ohio", {"cohort_group": "Group 1"})
    check("a fresh pending signup does NOT itself lift suppression (no confirm yet)",
          store.is_permanently_suppressed(email))
    store.confirm(sub_b["confirm_token"])
    check("a GENUINE later confirm lifts suppression -- the person re-initiated consent",
          not store.is_permanently_suppressed(email))

    corrupted_email = "still-suppressed-if-corrupted@example.invalid"
    sub_c = store.add_pending(corrupted_email, "michigan", {})
    store.confirm(sub_c["confirm_token"])
    store.stop(sub_c["unsubscribe_token"], "unsubscribed")
    subs = json.loads(TEST_STORE_PATH.read_text(encoding="utf-8"))
    for s in subs:
        if s["id"] == sub_c["id"]:
            s["status"] = store.STATUS_CONFIRMED  # corrupt status directly; confirmed_at stays pre-unsubscribe
    TEST_STORE_PATH.write_text(json.dumps(subs), encoding="utf-8")
    check("a status-corrupted record with NO new confirm timestamp remains suppressed (fix didn't weaken this)",
          store.is_permanently_suppressed(corrupted_email))


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


def test_mailing_address_hard_fail_and_override() -> None:
    print("\n== Part 23 (v2): mailing address hard-fails when unset; override affects only the test self-test path ==")
    reset_storage()  # sets the test override to TEST_MAILING_ADDRESS

    ok_email = emails.confirmation_email("Michigan", "https://x/confirm?token=t", "https://x/unsub?token=t")
    check("email builds successfully when a (test) address is configured", bool(ok_email["text_body"]))
    check(
        "old leaked dev placeholder string never appears anywhere in a built email",
        "REQUIRED BEFORE ANY REAL SEND" not in ok_email["text_body"]
        and "REQUIRED BEFORE ANY REAL SEND" not in ok_email["html_body"],
    )

    emails.clear_test_mailing_address_override()
    saved_env = os.environ.pop(emails.MAILING_ADDRESS_ENV_VAR, None)
    try:
        check(
            "mailing_address_configured() is False with no override and no env var",
            emails.mailing_address_configured() is False,
        )

        def _expect_hard_fail(label: str, fn) -> None:
            try:
                fn()
                check(f"{label} raises RuntimeError with no address configured", False, "did not raise")
            except RuntimeError as exc:
                check(f"{label} raises RuntimeError with no address configured", True)
                check(
                    f"{label}'s hard-fail error message itself contains no placeholder address text",
                    "[MAILING ADDRESS" not in str(exc),
                )

        _expect_hard_fail(
            "confirmation_email",
            lambda: emails.confirmation_email("Michigan", "https://x/confirm?token=t", "https://x/unsub?token=t"),
        )
        _expect_hard_fail(
            "reminder_email",
            lambda: emails.reminder_email(
                "Michigan", "July 31, 2027", 30, 30, "https://x/renewed?token=t", "https://x/unsub?token=t"
            ),
        )
        _expect_hard_fail(
            "stop_confirmation_email",
            lambda: emails.stop_confirmation_email("unsubscribed", "Michigan", None, "https://x/unsub?token=t"),
        )
    finally:
        if saved_env is not None:
            os.environ[emails.MAILING_ADDRESS_ENV_VAR] = saved_env
        emails.set_test_mailing_address_override(TEST_MAILING_ADDRESS)  # restore suite default for later tests


def test_first_name_greeting_and_sanitization() -> None:
    print("\n== Part 24 (v2): optional first-name greeting, safe fallback, and injection resistance ==")
    reset_storage()

    with_name = emails.confirmation_email(
        "Ohio", "https://x/confirm?token=t", "https://x/unsub?token=t", first_name="Priya"
    )
    check("greeting uses the first name when provided (text)", "Hi Priya," in with_name["text_body"])
    check("greeting uses the first name when provided (html)", "Hi Priya," in with_name["html_body"])

    blank = emails.confirmation_email(
        "Ohio", "https://x/confirm?token=t", "https://x/unsub?token=t", first_name=None
    )
    check("falls back to 'Hi there,' when blank (text)", "Hi there," in blank["text_body"])
    check("falls back to 'Hi there,' when blank (html)", "Hi there," in blank["html_body"])

    whitespace_only = emails.confirmation_email(
        "Ohio", "https://x/confirm?token=t", "https://x/unsub?token=t", first_name="   "
    )
    check("whitespace-only first name treated as blank, not rendered literally", "Hi there," in whitespace_only["text_body"])

    # HTML-injection attempt in the name -- must render as inert escaped
    # text, never as live markup, and must not corrupt the page structure.
    malicious_name = "<script>alert(1)</script><b>bold</b>"
    injected = emails.confirmation_email(
        "Ohio", "https://x/confirm?token=t", "https://x/unsub?token=t", first_name=malicious_name
    )
    check("raw <script> tag never appears unescaped in the html body", "<script>alert(1)</script>" not in injected["html_body"])
    check(
        "escaped form of the payload IS present (proves it rendered, not silently dropped)",
        "&lt;script&gt;" in injected["html_body"],
    )
    check(
        "html document is still exactly one well-formed shell after injection attempt",
        injected["html_body"].count("<html") == 1 and injected["html_body"].strip().endswith("</html>"),
    )
    # Plain-text body never HTML-escapes -- a name should render as literal
    # text there (there's no markup to inject into in a text/plain body).
    check(
        "plain-text body shows the name literally, not HTML-entity-escaped",
        malicious_name.strip() in injected["text_body"] and "&lt;" not in injected["text_body"],
    )

    long_name = "A" * 500
    check(
        f"emails._safe_first_name caps length at {emails.MAX_FIRST_NAME_LEN} chars",
        len(emails._safe_first_name(long_name)) == emails.MAX_FIRST_NAME_LEN,
    )
    check(
        f"store._sanitize_first_name caps length at {store.MAX_FIRST_NAME_LEN} chars",
        len(store._sanitize_first_name(long_name)) == store.MAX_FIRST_NAME_LEN,
    )
    check(
        "store._sanitize_first_name strips embedded control characters (e.g. an embedded newline)",
        store._sanitize_first_name("Jo\nhn") == "John",
    )

    # End-to-end through store.add_pending() -- the sanitizer actually runs
    # on the persisted record, not just when called directly.
    sub = store.add_pending("nametest@example.invalid", "michigan", {}, first_name="  Riley  ")
    check("add_pending() persists a trimmed first_name", sub["first_name"] == "Riley")
    sub_blank = store.add_pending("nametest2@example.invalid", "michigan", {}, first_name=None)
    check("add_pending() persists first_name=None when omitted", sub_blank["first_name"] is None)


def test_html_branding_buttons_and_dark_mode() -> None:
    print("\n== Part 25 (v2): branded HTML template -- buttons instead of raw URLs, dark mode, mobile ==")
    reset_storage()

    confirm_url = "https://example-deadlineradar-api.test/confirm?token=abcdefghijklmnopqrstuvwxyzABCDEFGH0123456789"
    unsub_url = "https://example-deadlineradar-api.test/unsubscribe?token=abcdefghijklmnopqrstuvwxyzABCDEFGH0123456789"
    email = emails.confirmation_email("Michigan", confirm_url, unsub_url)
    html_body = email["html_body"]

    check("html_body is populated (multipart, not text-only)", bool(html_body))
    check("a styled button anchor is present", 'class="dr-btn"' in html_body)
    check("the confirm URL is the button's real href", f'href="{confirm_url}"' in html_body)
    # The core fix: a raw URL must never be the user-visible LABEL of a
    # link -- i.e. never appear immediately followed by "</a>", the way a
    # naively-linkified raw URL would render.
    check(
        "the raw confirm URL is never used as an anchor's own visible text",
        f">{confirm_url}</a>" not in html_body,
    )
    check("button label text is human copy, not a URL", "Confirm my email" in html_body)
    check("dark-mode media query present", "prefers-color-scheme: dark" in html_body)
    check("mobile-responsive media query present", "max-width: 600px" in html_body)
    check(
        "a plain-text fallback is also present and DOES contain the raw URL (expected for text/plain)",
        bool(email["text_body"]) and confirm_url in email["text_body"],
    )
    check(
        "html_body is a single, complete HTML document",
        html_body.strip().startswith("<!doctype html>") and html_body.strip().endswith("</html>"),
    )
    check("no internal placeholder token leaks into the html footer", "REQUIRED BEFORE ANY REAL SEND" not in html_body)
    check("wordmark links to the real live site, not the inert API placeholder", emails.SITE_URL in html_body)


def test_server_first_name_and_address_precheck_http() -> None:
    print("\n== Part 26 (v2): first-name field + mailing-address precheck over the real HTTP server ==")
    reset_storage()
    httpd = HTTPServer(("127.0.0.1", TEST_HTTP_PORT_2), server_module.Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    time.sleep(0.3)
    base = f"http://127.0.0.1:{TEST_HTTP_PORT_2}"

    try:
        form_data = urllib.parse.urlencode({
            "email": "namehttp-test@example.invalid", "state": "michigan", "first_name": "  Alex  ",
        }).encode()
        req = urllib.request.Request(f"{base}/subscribe", data=form_data, method="POST")
        with urllib.request.urlopen(req, timeout=3) as resp:
            check("POST /subscribe with a first_name still returns 200", resp.status == 200)
        subs = json.loads(TEST_STORE_PATH.read_text(encoding="utf-8"))
        matching = [s for s in subs if s["email"] == "namehttp-test@example.invalid"]
        check(
            "subscriber persisted with the trimmed first name via the real HTTP path",
            len(matching) == 1 and matching[0].get("first_name") == "Alex",
        )

        form_data2 = urllib.parse.urlencode({"email": "nonamehttp-test@example.invalid", "state": "michigan"}).encode()
        req2 = urllib.request.Request(f"{base}/subscribe", data=form_data2, method="POST")
        with urllib.request.urlopen(req2, timeout=3) as resp2:
            check("POST /subscribe with NO first_name still returns 200 (it's optional)", resp2.status == 200)
        subs2 = json.loads(TEST_STORE_PATH.read_text(encoding="utf-8"))
        matching2 = [s for s in subs2 if s["email"] == "nonamehttp-test@example.invalid"]
        check(
            "subscriber persisted with first_name=None when the field is omitted",
            len(matching2) == 1 and matching2[0].get("first_name") is None,
        )

        emails.clear_test_mailing_address_override()
        try:
            form_data3 = urllib.parse.urlencode({"email": "noaddress-test@example.invalid", "state": "michigan"}).encode()
            req3 = urllib.request.Request(f"{base}/subscribe", data=form_data3, method="POST")
            try:
                urllib.request.urlopen(req3, timeout=3)
                check("POST /subscribe with no mailing address configured is rejected", False, "expected an HTTP error, got 200")
            except urllib.error.HTTPError as e:
                check("POST /subscribe with no mailing address configured is rejected with 503", e.code == 503, f"got {e.code}")
            subs3 = json.loads(TEST_STORE_PATH.read_text(encoding="utf-8"))
            matching3 = [s for s in subs3 if s["email"] == "noaddress-test@example.invalid"]
            check(
                "no orphaned pending record created when the address precheck blocks the signup",
                len(matching3) == 0,
            )
        finally:
            emails.set_test_mailing_address_override(TEST_MAILING_ADDRESS)
    finally:
        httpd.shutdown()
        thread.join(timeout=2)


def test_sendgrid_click_tracking_disabled() -> None:
    print("\n== Part 27 (v2): SendGrid payload disables click + open tracking ==")
    captured: dict = {}

    class _FakeResponse:
        status = 202
        headers = {"X-Message-Id": "fake-id"}

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return b""

    def fake_urlopen(req, timeout=10):
        captured["body"] = json.loads(req.data.decode("utf-8"))
        return _FakeResponse()

    real_urlopen = urllib.request.urlopen
    urllib.request.urlopen = fake_urlopen
    try:
        s = sender_module.SendGridSender(
            api_key="fake-key-not-real", from_email="noreply@deadline-radar.com", from_name="DeadlineRadar"
        )
        ok = s.send("someone@example.invalid", "Test subject", "text body", "<p>html body</p>")
        check("SendGridSender.send() reports success against the faked transport", ok is True)
    finally:
        urllib.request.urlopen = real_urlopen

    tracking = captured.get("body", {}).get("tracking_settings", {})
    check("tracking_settings present in the outbound SendGrid payload", bool(tracking))
    check("click_tracking.enable is False", tracking.get("click_tracking", {}).get("enable") is False)
    check("click_tracking.enable_text is False", tracking.get("click_tracking", {}).get("enable_text") is False)
    check("open_tracking.enable is False", tracking.get("open_tracking", {}).get("enable") is False)


def test_degenerate_address_rejected_and_override_caller_restricted() -> None:
    """Regression tests for two real gaps an independent adversarial pass
    found in the v2 build: (1) an env var containing ONLY zero-width/
    whitespace-like characters (or just a couple of ordinary characters)
    passed the old bare `.strip()` truthiness check, and (2)
    set_test_mailing_address_override() had no actual runtime enforcement
    of "only run_live_selftest.py may call this," just a docstring."""
    print("\n== Part 28 (v2 regression): degenerate mailing addresses rejected; override caller restricted ==")
    emails.clear_test_mailing_address_override()
    saved_env = os.environ.pop(emails.MAILING_ADDRESS_ENV_VAR, None)
    try:
        zero_width_space = chr(0x200B)  # U+200B, explicit codepoint -- avoids any source-encoding ambiguity
        degenerates = [
            zero_width_space * 3,               # zero-width-space-only (the exact bug an adversarial pass found)
            ".",                                 # single ordinary character
            "   ",                               # whitespace-only
            zero_width_space + " " + zero_width_space,  # mixed zero-width + ordinary space
        ]
        for degenerate in degenerates:
            os.environ[emails.MAILING_ADDRESS_ENV_VAR] = degenerate
            check(
                f"degenerate address {degenerate!r} does NOT count as configured",
                emails.mailing_address_configured() is False,
            )
        os.environ[emails.MAILING_ADDRESS_ENV_VAR] = "123 Real Enough Street, Sometown, ST 00000"
        check("a normal-length real-looking address DOES count as configured", emails.mailing_address_configured() is True)
    finally:
        os.environ.pop(emails.MAILING_ADDRESS_ENV_VAR, None)
        if saved_env is not None:
            os.environ[emails.MAILING_ADDRESS_ENV_VAR] = saved_env
        emails.set_test_mailing_address_override(TEST_MAILING_ADDRESS)

    # Exercise the REAL enforcement path: run the setter from a frame whose
    # __file__ is NOT on the allow-list (this test file itself IS on the
    # allow-list, so calling it directly here would prove nothing -- exec()
    # gives us a fresh frame with attacker-controlled globals to simulate an
    # unauthorized caller without needing a separate on-disk module).
    fake_globals = {"emails": emails, "__file__": "some_unrelated_module.py"}
    try:
        exec("emails.set_test_mailing_address_override('attacker-supplied placeholder')", fake_globals)
        check("a caller not on the allow-list is refused", False, "did not raise")
    except RuntimeError:
        check("a caller not on the allow-list is refused", True)
    check(
        "the refused call did NOT poison the module-level override state",
        emails._TEST_MAILING_ADDRESS_OVERRIDE == TEST_MAILING_ADDRESS,
    )


def test_scheduler_one_bad_subscriber_does_not_abort_the_batch() -> None:
    print("\n== Part 29 (v2 regression): a mid-batch email-build failure doesn't crash the whole scheduler run ==")
    reset_storage()
    sub_a = store.add_pending("batch-a@example.invalid", "michigan", {})
    store.confirm(sub_a["confirm_token"])
    sub_b = store.add_pending("batch-b@example.invalid", "michigan", {})
    store.confirm(sub_b["confirm_token"])

    result = scheduler.compute_subscriber_deadline(sub_a, date(2026, 7, 3))
    deadline_date, _ = result
    sim_today = deadline_date - timedelta(days=60)

    real_reminder_email = emails.reminder_email
    call_count = {"n": 0}

    def flaky_reminder_email(*args, **kwargs):
        call_count["n"] += 1
        if call_count["n"] == 1:
            raise RuntimeError("simulated mid-run failure for the FIRST subscriber only")
        return real_reminder_email(*args, **kwargs)

    emails.reminder_email = flaky_reminder_email
    try:
        test_sender = sender_module.DryRunSender()
        summary = scheduler.run_once(as_of=sim_today, sender=test_sender)
    finally:
        emails.reminder_email = real_reminder_email

    check("the run recorded exactly 1 error for the failing subscriber", len(summary["errors"]) == 1, summary["errors"])
    check(
        "the run still SENT to the second, unaffected subscriber (batch didn't abort)",
        summary["sent"] == 1,
        f"summary={summary}",
    )


def test_urgency_subjects_and_priority_headers() -> None:
    """Regression tests for the 2026-07-04T00:05 'urgency done right'
    directive: escalating, deadline-front-loaded subjects per tier, and
    high-importance transport headers reserved for the 1-day tier ONLY."""
    print("\n== Part 30 (v2.1): escalating subjects + 1-day-only high-importance headers ==")
    reset_storage()

    def build(threshold: int, actual_days_remaining: int) -> dict:
        return emails.reminder_email(
            "Michigan", "July 31, 2027", threshold, actual_days_remaining,
            "https://x/renewed?token=t", "https://x/unsub?token=t",
        )

    def is_calm(s: str) -> bool:
        return "!" not in s and s.upper() != s  # no exclamation, not ALL-CAPS shouting

    for threshold in (60, 30, 14, 7, 3, 1):
        subject = build(threshold, threshold)["subject"]
        check(f"tier {threshold}: subject is calm (no '!' / not ALL CAPS)", is_calm(subject), subject)
        check(f"tier {threshold}: subject names the state and CPA license",
              "Michigan CPA license" in subject, subject)
        if threshold != 1:
            check(f"tier {threshold}: subject front-loads the deadline date",
                  "July 31, 2027" in subject, subject)

    subj60 = build(60, 60)["subject"]
    check("60-day tier: calm 'expires' framing, deadline front-loaded",
          "expires in 60 days" in subj60, subj60)

    for threshold in (30, 14, 7):
        subj = build(threshold, threshold)["subject"]
        check(f"{threshold}-day tier: firmer 'a good time to start' framing",
              "a good time to start" in subj, subj)

    subj3 = build(3, 3)["subject"]
    check(
        "3-day tier: pointed -- plain due-date statement, no softening tag",
        "renewal is due in 3 days" in subj3 and "a good time to start" not in subj3,
        subj3,
    )

    subj1_tomorrow = build(1, 1)["subject"]
    check("1-day tier, exactly 1 day left: 'Tomorrow:' lead", subj1_tomorrow.startswith("Tomorrow:"), subj1_tomorrow)
    subj1_today = build(1, 0)["subject"]
    check("1-day tier, due today (0 left): 'Today:' lead, never claims 'Tomorrow'",
          subj1_today.startswith("Today:"), subj1_today)
    subj1_overdue = build(1, -3)["subject"]
    check("1-day tier, already overdue: 'Overdue:' lead, never claims 'Tomorrow'",
          subj1_overdue.startswith("Overdue:"), subj1_overdue)
    subj1_early = build(1, 5)["subject"]
    check("1-day tier, scheduler-gap catch-up landed 5 days early: stays accurate, doesn't lie 'Tomorrow'",
          subj1_early.startswith("In 5 days:"), subj1_early)

    # Headers: high-importance ONLY on the 1-day tier -- every other tier
    # (including confirmation/stop-confirmation) stays normal priority.
    for threshold in (60, 30, 14, 7, 3):
        h = build(threshold, threshold)["headers"]
        check(f"tier {threshold}: no high-importance headers (normal priority)", h == {}, h)
    h1 = build(1, 1)["headers"]
    check("1-day tier: Importance: High is set", h1.get("Importance") == "High", h1)
    check("1-day tier: X-Priority: 1 is set", h1.get("X-Priority") == "1", h1)
    check("1-day tier: X-MSMail-Priority: High is set", h1.get("X-MSMail-Priority") == "High", h1)

    conf = emails.confirmation_email("Michigan", "https://x/confirm?token=t", "https://x/unsub?token=t")
    check("confirmation email carries no high-importance headers", conf.get("headers", {}) == {}, conf.get("headers"))
    stop = emails.stop_confirmation_email("renewed", "Michigan", None, "https://x/unsub?token=t")
    check("stop-confirmation email carries no high-importance headers", stop.get("headers", {}) == {}, stop.get("headers"))


def test_headers_plumbed_through_sender_chain() -> None:
    """Regression test: the 1-day tier's high-importance headers must
    actually reach a real send, not just exist in the dict emails.py
    returns -- every sender wrapper in the chain (DryRunSender,
    CircuitBreakerSender, WhitelistedSender, SendGridSender) must forward
    `headers` unchanged rather than silently dropping it."""
    print("\n== Part 31 (v2.1): high-importance headers actually reach the wire, through every wrapper ==")
    reset_storage()

    dry = sender_module.DryRunSender()
    dry.send("someone@example.invalid", "subj", "text", "<p>html</p>", emails.HIGH_IMPORTANCE_HEADERS)
    log = read_dry_run_log()
    check("DryRunSender logs the headers dict unchanged",
          log[-1].get("headers") == emails.HIGH_IMPORTANCE_HEADERS, log[-1].get("headers"))

    dry.send("someone2@example.invalid", "subj2", "text2")
    log2 = read_dry_run_log()
    check("DryRunSender logs an empty headers dict when none passed", log2[-1].get("headers") == {}, log2[-1].get("headers"))

    captured: dict = {}

    class _FakeResponse:
        status = 202
        headers = {"X-Message-Id": "fake-id"}

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return b""

    def fake_urlopen(req, timeout=10):
        captured["body"] = json.loads(req.data.decode("utf-8"))
        return _FakeResponse()

    real_urlopen = urllib.request.urlopen
    urllib.request.urlopen = fake_urlopen
    try:
        s = sender_module.SendGridSender(api_key="fake-key-not-real", from_email="noreply@deadline-radar.com")
        s.send("someone@example.invalid", "subj", "text", None, emails.HIGH_IMPORTANCE_HEADERS)
    finally:
        urllib.request.urlopen = real_urlopen
    sent_headers = captured.get("body", {}).get("personalizations", [{}])[0].get("headers", {})
    check(
        "SendGridSender attaches headers on personalizations[0], not top-level",
        sent_headers == emails.HIGH_IMPORTANCE_HEADERS,
        sent_headers,
    )

    captured2: dict = {}

    def fake_urlopen2(req, timeout=10):
        captured2["body"] = json.loads(req.data.decode("utf-8"))
        return _FakeResponse()

    urllib.request.urlopen = fake_urlopen2
    try:
        s2 = sender_module.SendGridSender(api_key="fake-key-not-real", from_email="noreply@deadline-radar.com")
        s2.send("someone@example.invalid", "subj", "text")
    finally:
        urllib.request.urlopen = real_urlopen
    check(
        "no 'headers' key at all on the personalization when none was passed (normal-priority tiers)",
        "headers" not in captured2.get("body", {}).get("personalizations", [{}])[0],
        captured2.get("body", {}).get("personalizations"),
    )

    class _CapturingSender(sender_module.EmailSender):
        def __init__(self):
            self.last_headers = "NEVER CALLED"

        def send(self, to_email, subject, text_body, html_body=None, headers=None):
            self.last_headers = headers
            return True

    capturing = _CapturingSender()
    breaker = sender_module.CircuitBreakerSender(capturing, daily_cap=10)
    breaker.send("x@example.invalid", "s", "t", None, emails.HIGH_IMPORTANCE_HEADERS)
    check("CircuitBreakerSender forwards headers to the wrapped sender unchanged",
          capturing.last_headers == emails.HIGH_IMPORTANCE_HEADERS, capturing.last_headers)

    capturing2 = _CapturingSender()
    whitelisted = sender_module.WhitelistedSender(capturing2, allowed_recipients={"x@example.invalid"})
    whitelisted.send("x@example.invalid", "s", "t", None, emails.HIGH_IMPORTANCE_HEADERS)
    check("WhitelistedSender forwards headers to the wrapped sender unchanged",
          capturing2.last_headers == emails.HIGH_IMPORTANCE_HEADERS, capturing2.last_headers)


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
        test_cooldown_and_dedupe_block_repeat_signup_spam()
        test_honeypot_silently_blocks_bots()
        test_rate_limit_blocks_ip_hammering()
        test_circuit_breaker_halts_after_daily_cap()
        test_permanent_suppression_survives_a_status_bug()
        test_input_validation_rejects_malformed_and_injection_payloads()
        test_pii_locality_reverified()
        test_pending_subscriber_cannot_bypass_double_optin()
        test_gmail_style_dot_plustag_addresses_share_cooldown()
        test_honeypot_whitespace_only_value_still_blocked()
        test_circuit_breaker_holds_cap_under_concurrency()
        test_suppression_lifts_after_a_genuine_later_confirm()
        test_mailing_address_hard_fail_and_override()
        test_first_name_greeting_and_sanitization()
        test_html_branding_buttons_and_dark_mode()
        test_server_first_name_and_address_precheck_http()
        test_sendgrid_click_tracking_disabled()
        test_degenerate_address_rejected_and_override_caller_restricted()
        test_scheduler_one_bad_subscriber_does_not_abort_the_batch()
        test_urgency_subjects_and_priority_headers()
        test_headers_plumbed_through_sender_chain()
    finally:
        for p in (TEST_STORE_PATH, TEST_LOG_PATH, TEST_CB_STATE_PATH, TEST_CB_ALERT_LOG_PATH):
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
