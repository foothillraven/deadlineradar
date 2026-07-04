"""
DeadlineRadar reminders -- pluggable email-sender interface.

DEFAULT IS DRY-RUN. Nothing gets emailed to a real person until:
  1. a real EmailSender implementation is selected AND
  2. a real API key is present (via environment variable, never hardcoded,
     never committed) AND
  3. the project maintainer has given an explicit go for the first real send
     (this module cannot and does not enforce that go itself; it's a
     deliberate one-line code change in get_sender() below, reviewed by a
     human, not something an environment variable can silently trigger).

Every sender implementation gets called through the same interface, so
swapping DryRunSender for a real provider is a one-line change in
`get_sender()` -- no other code needs to know which one is active.
"""

from __future__ import annotations

import json
import os
import pathlib
import threading
from datetime import datetime, timezone

DRY_RUN_LOG_PATH = pathlib.Path(__file__).resolve().parent / "dry_run_sent.log.jsonl"
CIRCUIT_BREAKER_STATE_PATH = pathlib.Path(__file__).resolve().parent / "send_circuit_breaker_state.json"
CIRCUIT_BREAKER_ALERT_LOG_PATH = pathlib.Path(__file__).resolve().parent / "circuit_breaker_alerts.log.jsonl"


class EmailSender:
    """Abstract interface. `send()` returns True on success."""

    def send(self, to_email: str, subject: str, text_body: str, html_body: str | None = None) -> bool:
        raise NotImplementedError


class DryRunSender(EmailSender):
    """Sends nothing. Logs exactly what WOULD have been sent, to a local
    gitignored file, so a real end-to-end test can be inspected and verified
    without risking a single real email going out. This is the only sender
    wired up until a real transactional-email account exists."""

    def send(self, to_email: str, subject: str, text_body: str, html_body: str | None = None) -> bool:
        entry = {
            "sent_at": datetime.now(timezone.utc).isoformat(),
            "to": to_email,
            "subject": subject,
            "text_body": text_body,
            "html_body": html_body,
            "mode": "DRY_RUN -- not actually sent",
        }
        DRY_RUN_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(DRY_RUN_LOG_PATH, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        return True


class SendGridSender(EmailSender):
    """Real-provider stub. Requires SENDGRID_API_KEY in the environment --
    never hardcoded, never committed. NOT wired up as the active sender
    anywhere in this codebase yet (see get_sender() below) -- this class
    exists so the shape is ready the moment a real key exists, not so it
    runs today. Uses only the Python standard library (urllib) so this
    repo stays dependency-free until a real send is actually authorized;
    swap in the official `sendgrid` package at that point if preferred.

    Click and open tracking are explicitly disabled on every send (see
    `tracking_settings` in send() below) -- these are transactional emails,
    not marketing, and SendGrid's click-tracking rewrite is what mangled
    action links into long tracking-domain URLs in the v1 self-test."""

    API_URL = "https://api.sendgrid.com/v3/mail/send"

    def __init__(
        self,
        api_key: str | None = None,
        from_email: str = "reminders@example.invalid",
        from_name: str | None = None,
    ):
        self.api_key = api_key or os.environ.get("SENDGRID_API_KEY")
        self.from_email = from_email
        self.from_name = from_name
        # Diagnostic-only, set by the most recent send() call -- NEVER
        # includes the API key. Lets a caller report the exact SendGrid
        # error string (e.g. a 401/403 body) without this class needing to
        # print anything itself.
        self.last_status: int | None = None
        self.last_error: str | None = None
        self.last_message_id: str | None = None
        if not self.api_key:
            raise RuntimeError(
                "SendGridSender requires SENDGRID_API_KEY in the environment. "
                "This is an account/key the project maintainer creates and supplies -- see "
                "reminders/README.md. Refusing to silently fall back to dry-run here; callers "
                "should choose DryRunSender explicitly if that's what they want."
            )

    def send(self, to_email: str, subject: str, text_body: str, html_body: str | None = None) -> bool:
        import urllib.request
        import urllib.error

        from_field = {"email": self.from_email}
        if self.from_name:
            from_field["name"] = self.from_name
        payload = {
            "personalizations": [{"to": [{"email": to_email}]}],
            "from": from_field,
            "subject": subject,
            "content": [{"type": "text/plain", "value": text_body}],
            # These are transactional reminders, not marketing -- click
            # tracking has no analytics value here and actively hurts the
            # product: it rewrites every href to a long redirect URL through
            # a SendGrid tracking domain, which is exactly what made action
            # links look like giant, phishing-style tracking URLs when
            # rendered (the v1 self-test's #1 reported problem). Open
            # tracking (a 1x1 pixel) is disabled for the same
            # "transactional, not marketing" reasoning -- no analytics need
            # justifies adding tracking infrastructure to a CAN-SPAM email.
            "tracking_settings": {
                "click_tracking": {"enable": False, "enable_text": False},
                "open_tracking": {"enable": False},
            },
        }
        if html_body:
            payload["content"].append({"type": "text/html", "value": html_body})
        req = urllib.request.Request(
            self.API_URL,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        self.last_status = None
        self.last_error = None
        self.last_message_id = None
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                self.last_status = resp.status
                self.last_message_id = resp.headers.get("X-Message-Id")
                return 200 <= resp.status < 300
        except urllib.error.HTTPError as exc:
            self.last_status = exc.code
            try:
                body = exc.read().decode("utf-8", errors="replace")
            except Exception:  # noqa: BLE001 -- diagnostic best-effort only
                body = "<could not read error body>"
            # SendGrid error bodies are JSON describing what's wrong with the
            # request/key -- never includes the key itself (the key is sent
            # only in the outbound Authorization header, never echoed back).
            self.last_error = f"HTTP {exc.code}: {body}"
            return False
        except urllib.error.URLError as exc:
            self.last_error = f"Network error: {exc.reason}"
            return False


# Module-level (not instance-level) lock, deliberately: get_sender() may
# hand back a FRESH CircuitBreakerSender instance on every call, and an
# instance-level lock would do nothing to serialize two different
# instances racing on the SAME state file. A module-level lock serializes
# every CircuitBreakerSender.send() call in this process regardless of how
# many instances exist. Found by the abuse-hardening audit's own attack
# test: without this, concurrent threads could each read the state file
# before any of them had written their increment, letting the daily cap be
# blown well past (measured letting through nearly 2x the configured cap
# under a 40-thread burst) -- and a write landing mid-read from another
# thread could crash the reader with a JSONDecodeError, since the old
# _save_state() was a plain non-atomic overwrite.
_CIRCUIT_BREAKER_LOCK = threading.Lock()


class CircuitBreakerSender(EmailSender):
    """Wraps another EmailSender with a hard DAILY send cap. Protects two
    things at once: the free-tier send quota, and -- more importantly --
    sender reputation. A bug (or an attack) that tries to blow through
    thousands of sends in a burst gets the whole domain flagged as a
    spammer, which kills deliverability for every legitimate subscriber,
    not just the bad batch. Once the cap is hit for the current UTC day,
    EVERY further .send() call this day is refused (returns False) without
    ever reaching the wrapped sender -- and an ALERT is appended to a local
    log so a human/monitoring can see it tripped. The cap resets at UTC
    midnight, tracked in a small local JSON state file (not PII -- just a
    date and a count). The load-check-increment-save sequence is guarded by
    a process-wide lock (`_CIRCUIT_BREAKER_LOCK`) and state-file writes are
    atomic (write-temp-then-replace) -- see that lock's module-level
    docstring for why both are load-bearing, not just tidiness."""

    DEFAULT_DAILY_CAP = 500

    def __init__(self, wrapped: EmailSender, daily_cap: int | None = None):
        self.wrapped = wrapped
        self.daily_cap = daily_cap if daily_cap is not None else int(
            os.environ.get("REMINDERS_DAILY_SEND_CAP", self.DEFAULT_DAILY_CAP)
        )

    def _today_key(self) -> str:
        return datetime.now(timezone.utc).date().isoformat()

    def _load_state(self) -> dict:
        if not CIRCUIT_BREAKER_STATE_PATH.exists():
            return {}
        with open(CIRCUIT_BREAKER_STATE_PATH, "r", encoding="utf-8") as f:
            return json.load(f)

    def _save_state(self, state: dict) -> None:
        # Atomic write (temp file + os.replace) rather than a direct
        # overwrite -- so a concurrent reader (another thread, a human
        # tailing the file, a future multi-process deployment) can never
        # observe a half-written file and crash on invalid JSON. The
        # _CIRCUIT_BREAKER_LOCK already prevents concurrent WRITER/WRITER
        # races within this process; this protects READERS against
        # partial writes regardless of what's holding (or not holding) the
        # lock.
        CIRCUIT_BREAKER_STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = CIRCUIT_BREAKER_STATE_PATH.with_suffix(".tmp")
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(state, f, indent=2)
        os.replace(tmp_path, CIRCUIT_BREAKER_STATE_PATH)

    def _alert(self, message: str, count: int) -> None:
        entry = {
            "at": datetime.now(timezone.utc).isoformat(),
            "day": self._today_key(),
            "count": count,
            "daily_cap": self.daily_cap,
            "message": message,
        }
        CIRCUIT_BREAKER_ALERT_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(CIRCUIT_BREAKER_ALERT_LOG_PATH, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        # No PII in this line (no email addresses, just counts/dates) -- safe
        # to also surface on stderr for a human watching the process.
        print(f"[CIRCUIT BREAKER] {message}", flush=True)

    def send(self, to_email: str, subject: str, text_body: str, html_body: str | None = None) -> bool:
        # The load-check-increment-save sequence is the circuit breaker's
        # entire reason for existing -- it MUST be atomic across threads/
        # instances, or the cap can be blown straight past under concurrent
        # sends (confirmed by the abuse-hardening audit's attack test).
        with _CIRCUIT_BREAKER_LOCK:
            today = self._today_key()
            state = self._load_state()
            count = state.get(today, 0)

            if count >= self.daily_cap:
                self._alert(
                    f"Daily send cap ({self.daily_cap}) already reached for {today} -- HALTING further sends today.",
                    count,
                )
                return False

            count += 1
            # Keep the state file from growing forever -- only today's count
            # matters for the breaker; drop any older days.
            state = {today: count}
            self._save_state(state)

            if count == self.daily_cap:
                self._alert(
                    f"Daily send cap ({self.daily_cap}) just reached for {today} on this send -- "
                    f"halting all further sends until UTC midnight.",
                    count,
                )

        # Deliberately OUTSIDE the lock: the underlying send (a real network
        # call, in a non-dry-run sender) shouldn't serialize every other
        # thread's cap-checking while it's in flight. This matches the
        # pre-existing semantic (the counter reflects attempted sends, not
        # confirmed-successful ones) -- not a new behavior introduced by
        # the lock.
        return self.wrapped.send(to_email, subject, text_body, html_body)


class WhitelistedSender(EmailSender):
    """Wraps another sender with a HARD, technically-enforced recipient
    whitelist. Built for a live-provider self-test where a real API key is
    wired up but the ONLY acceptable recipient is a single pre-approved
    address -- any other recipient is refused BEFORE the wrapped sender
    (and therefore the real network call) is ever touched, so a bug
    elsewhere (a bad loop, a wrong variable, a leftover real subscriber
    record) can never actually reach a real third party during a test.

    This is deliberately NOT wired into get_sender() below and must never
    become the permanent default without an explicit go that also removes
    (not just widens) this whitelist -- see the 2026-07-03 SendGrid
    self-test directive in Orchestrator/outbox. Refusals are logged locally
    without ever printing the refused recipient's raw address (PII-locality
    posture, same as the rest of this module) -- only that a refusal
    happened and how many, which is enough to catch a bug without adding a
    second place a real email address could leak to a local log."""

    def __init__(self, wrapped: EmailSender, allowed_recipients: set[str]):
        self.wrapped = wrapped
        self._allowed = {e.strip().lower() for e in allowed_recipients}
        self.refused_count = 0

    def send(self, to_email: str, subject: str, text_body: str, html_body: str | None = None) -> bool:
        normalized = (to_email or "").strip().lower()
        if normalized not in self._allowed:
            self.refused_count += 1
            print(
                f"[WHITELIST BLOCK] refused a send to a non-whitelisted recipient "
                f"({self.refused_count} refused so far this run) -- only "
                f"{len(self._allowed)} address(es) are permitted for this test.",
                flush=True,
            )
            return False
        return self.wrapped.send(to_email, subject, text_body, html_body)


def get_sender() -> EmailSender:
    """Single choke point for which sender is active. Hardcoded to
    DryRunSender, wrapped in the circuit breaker -- changing the underlying
    sender to a real provider is a deliberate, reviewable one-line edit, not
    something that can happen by accident (e.g. via an environment variable
    silently flipping behavior). The circuit breaker wraps EVERY sender,
    dry-run included, so its daily-cap logic is exercised by every existing
    test and dry-run, not bolted on only at real-send time."""
    return CircuitBreakerSender(DryRunSender())
