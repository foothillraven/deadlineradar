"""
DeadlineRadar reminders -- local backend engine (stdlib http.server, no
framework, no new dependencies -- matches the rest of this repo).

Endpoints:
  POST /subscribe    signup form target: email, state, +state-specific fields
  GET  /confirm       double-opt-in step 2 (link in the confirmation email)
  GET  /unsubscribe   one-click unsubscribe, honored instantly and permanently
  GET  /renewed       one-click "I've renewed", stops reminders, offers re-arm
  GET  /rearm         re-arm a renewed (not unsubscribed) subscriber for next cycle
  GET  /health        liveness check

This is a LOCAL, staged, dependency-free reference implementation. It is not
deployed anywhere -- see reminders/README.md "Deployment gap" for what a
real deployment needs (this can't run on GitHub Pages; Pages is static-only).
Every email send in this server goes through sender.get_sender(), which is
hardcoded to DryRunSender -- see sender.py. No real email goes out from
running this file, ever, regardless of input.
"""

from __future__ import annotations

import json
import pathlib
import sys
from datetime import date
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from generate import fmt_date  # noqa: E402

from . import store
from . import emails
from . import sender as sender_module
from .scheduler import compute_subscriber_deadline, check_data_freshness

PORT = 8791

# States the signup form actually supports. New York is deliberately absent
# -- same reasoning as the static site: its rule needs a fact (first
# registration date) this dataset doesn't have, so no reminder can be
# computed for it.
SUPPORTED_STATE_SLUGS = {
    "florida", "illinois", "pennsylvania", "georgia", "north-carolina",
    "michigan", "ohio", "california", "texas",
}


def _html_page(title: str, body_html: str) -> bytes:
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>{title}</title>
<style>body{{font-family:-apple-system,sans-serif;max-width:520px;margin:3rem auto;padding:0 1.25rem;line-height:1.5;}}</style>
</head><body>{body_html}</body></html>""".encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    def _send(self, status: int, body: bytes, content_type: str = "text/html; charset=utf-8") -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _error_page(self, status: int, message: str) -> None:
        self._send(status, _html_page("Error", f"<p>{message}</p>"))

    def do_GET(self) -> None:  # noqa: N802 -- stdlib naming convention
        parsed = urlparse(self.path)
        qs = parse_qs(parsed.query)
        token = (qs.get("token") or [None])[0]

        if parsed.path == "/health":
            self._send(200, b'{"status": "ok"}', "application/json")
            return

        if parsed.path == "/confirm":
            self._handle_confirm(token)
        elif parsed.path == "/unsubscribe":
            self._handle_unsubscribe(token)
        elif parsed.path == "/renewed":
            self._handle_renewed(token)
        elif parsed.path == "/rearm":
            self._handle_rearm(token)
        else:
            self._error_page(404, "Not found.")

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path != "/subscribe":
            self._error_page(404, "Not found.")
            return
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length).decode("utf-8")
        form = {k: v[0] for k, v in parse_qs(raw).items()}
        self._handle_subscribe(form)

    # -- handlers -----------------------------------------------------

    def _handle_subscribe(self, form: dict) -> None:
        email = (form.get("email") or "").strip()
        state_slug = (form.get("state") or "").strip()

        if "@" not in email or "." not in email.split("@")[-1]:
            self._error_page(400, "That doesn't look like a valid email address.")
            return
        if state_slug not in SUPPORTED_STATE_SLUGS:
            self._error_page(400, "Unsupported or missing state.")
            return

        deadline_fields: dict = {}
        if state_slug == "california":
            birth_month = form.get("birth_month")
            birth_year = form.get("birth_year")
            if not birth_month or not birth_year or not birth_year.isdigit():
                self._error_page(400, "California needs your birth month and birth year.")
                return
            # Users give their actual birth year (natural to answer); we
            # compute odd/even parity server-side rather than asking someone
            # to self-report "odd or even," which is confusing and error-prone.
            parity = "odd" if int(birth_year) % 2 == 1 else "even"
            deadline_fields = {"birth_month": birth_month, "birth_year_parity": parity}
        elif state_slug == "texas":
            deadline_fields = {"birth_month": form.get("birth_month")}
            if not deadline_fields["birth_month"]:
                self._error_page(400, "Texas needs your birth month.")
                return
        elif state_slug == "ohio":
            deadline_fields = {"cohort_group": form.get("cohort_group")}
            if deadline_fields["cohort_group"] not in ("Group 1", "Group 2", "Group 3"):
                self._error_page(400, "Ohio needs your cohort group.")
                return
        elif form.get("license_type_id"):
            deadline_fields = {"license_type_id": form.get("license_type_id")}

        # Validate we can actually compute a deadline before creating the
        # subscriber -- fail loudly here rather than silently storing a
        # signup the scheduler can never resolve.
        check_data_freshness(date.today())
        probe = store.add_pending(email, state_slug, deadline_fields)
        result = compute_subscriber_deadline(probe, date.today())
        if result is None:
            self._error_page(400, "Couldn't compute a deadline from what you gave us -- please check your inputs.")
            return

        confirm_url = f"{emails.BACKEND_BASE_URL}/confirm?token={probe['confirm_token']}"
        unsubscribe_url = f"{emails.BACKEND_BASE_URL}/unsubscribe?token={probe['unsubscribe_token']}"
        _, state_name = result
        email_content = emails.confirmation_email(state_name, confirm_url, unsubscribe_url)
        sender_module.get_sender().send(
            probe["email"], email_content["subject"], email_content["text_body"], email_content["html_body"]
        )
        self._send(200, _html_page(
            "Check your email",
            "<h1>Almost done</h1><p>We sent a confirmation email -- click the link in it to "
            "start getting reminders. If you don't click it, you won't hear from us again.</p>",
        ))

    def _handle_confirm(self, token: str | None) -> None:
        if not token:
            self._error_page(400, "Missing confirmation link.")
            return
        subscriber = store.confirm(token)
        if not subscriber:
            self._error_page(404, "That confirmation link is invalid or already used.")
            return
        self._send(200, _html_page(
            "Confirmed",
            "<h1>You're all set</h1><p>We'll email you as your renewal deadline approaches -- "
            "60, 30, 14, 7, 3, and 1 day before. Nothing else, ever.</p>",
        ))

    def _handle_unsubscribe(self, token: str | None) -> None:
        if not token:
            self._error_page(400, "Missing unsubscribe link.")
            return
        subscriber = store.stop(token, "unsubscribed")
        if not subscriber:
            self._error_page(404, "That link is invalid.")
            return
        state_name = subscriber["state_slug"].replace("-", " ").title()
        # Found by adversarial review: this previously passed "" as the
        # unsubscribe_url, so the stop-confirmation email's footer rendered
        # a dead, empty unsubscribe link -- the one template in the system
        # that didn't have a real one. Build it the same way every other
        # handler does.
        unsubscribe_url = f"{emails.BACKEND_BASE_URL}/unsubscribe?token={subscriber['unsubscribe_token']}"
        email_content = emails.stop_confirmation_email("unsubscribed", state_name, None, unsubscribe_url)
        sender_module.get_sender().send(subscriber["email"], email_content["subject"], email_content["text_body"], None)
        self._send(200, _html_page("Unsubscribed", "<h1>Done</h1><p>You're unsubscribed, instantly and permanently.</p>"))

    def _handle_renewed(self, token: str | None) -> None:
        if not token:
            self._error_page(400, "Missing link.")
            return
        subscriber = store.stop(token, "renewed")
        if not subscriber:
            self._error_page(404, "That link is invalid.")
            return
        state_name = subscriber["state_slug"].replace("-", " ").title()
        rearm_url = f"{emails.BACKEND_BASE_URL}/rearm?token={subscriber['unsubscribe_token']}"
        unsubscribe_url = f"{emails.BACKEND_BASE_URL}/unsubscribe?token={subscriber['unsubscribe_token']}"
        email_content = emails.stop_confirmation_email("renewed", state_name, rearm_url, unsubscribe_url)
        sender_module.get_sender().send(subscriber["email"], email_content["subject"], email_content["text_body"], None)
        self._send(200, _html_page(
            "Nice work",
            "<h1>Congrats on renewing</h1><p>All reminders for this deadline are stopped. "
            "Check your email if you'd like a reminder next cycle too.</p>",
        ))

    def _handle_rearm(self, token: str | None) -> None:
        if not token:
            self._error_page(400, "Missing link.")
            return
        subscriber = store.rearm(token)
        if not subscriber:
            self._error_page(404, "That link is invalid or already used, or this subscriber wasn't eligible to re-arm.")
            return
        self._send(200, _html_page("Re-armed", "<h1>You're back in</h1><p>We'll remind you again as your next deadline approaches.</p>"))

    def log_message(self, format: str, *args) -> None:  # noqa: A002 -- stdlib signature
        # Quiet by default; PII (email addresses) must never hit stdout/logs.
        # Override to no-op rather than the default which prints the request
        # line (which could include an email in a query string in principle
        # -- our endpoints only put tokens in query strings, never emails,
        # but silencing this is a cheap belt-and-suspenders guard).
        pass


def run(port: int = PORT) -> None:
    httpd = HTTPServer(("127.0.0.1", port), Handler)
    print(f"DeadlineRadar reminders backend (DRY RUN -- no real emails) on http://127.0.0.1:{port}")
    httpd.serve_forever()


if __name__ == "__main__":
    run()
