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
    swap in the official `sendgrid` package at that point if preferred."""

    API_URL = "https://api.sendgrid.com/v3/mail/send"

    def __init__(self, api_key: str | None = None, from_email: str = "reminders@example.invalid"):
        self.api_key = api_key or os.environ.get("SENDGRID_API_KEY")
        self.from_email = from_email
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

        payload = {
            "personalizations": [{"to": [{"email": to_email}]}],
            "from": {"email": self.from_email},
            "subject": subject,
            "content": [{"type": "text/plain", "value": text_body}],
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
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return 200 <= resp.status < 300
        except urllib.error.HTTPError:
            return False


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
    date and a count)."""

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
        CIRCUIT_BREAKER_STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(CIRCUIT_BREAKER_STATE_PATH, "w", encoding="utf-8") as f:
            json.dump(state, f, indent=2)

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
        state[today] = count
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
