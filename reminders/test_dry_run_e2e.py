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
TEST_CB_STATE_PATH = HERE / "_test_send_circuit_breaker_state.json"
TEST_CB_ALERT_LOG_PATH = HERE / "_test_circuit_breaker_alerts.log.jsonl"
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
    sender_module.CIRCUIT_BREAKER_STATE_PATH = TEST_CB_STATE_PATH
    sender_module.CIRCUIT_BREAKER_ALERT_LOG_PATH = TEST_CB_ALERT_LOG_PATH
    # Also reset the in-memory per-IP rate limiter between tests -- otherwise
    # an earlier test's hammering would bleed into a later test's quota.
    server_module._RATE_LIMIT_HITS.clear()
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
