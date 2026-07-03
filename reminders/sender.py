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


def get_sender() -> EmailSender:
    """Single choke point for which sender is active. Hardcoded to
    DryRunSender -- changing this to a real sender is a deliberate,
    reviewable one-line edit, not something that can happen by accident
    (e.g. via an environment variable silently flipping behavior)."""
    return DryRunSender()
