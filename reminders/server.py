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
hardcoded to a circuit-breaker-wrapped DryRunSender -- see sender.py. No real
email goes out from running this file, ever, regardless of input.

## Abuse-hardening (2026-07-03 audit)

This module is the ONLY thing standing between the public internet and a
real inbox once deployed. Everything below exists because the signup form is
attacker-reachable: anyone can POST any email address, including a stranger
enrolling a THIRD PARTY's address. Defenses, in the order they're checked:

  1. Per-IP rate limiting (all endpoints) -- throttles scripted hammering.
  2. Hidden honeypot field -- silently no-ops bots that fill every field.
  3. Cloudflare Turnstile hook (_verify_turnstile) -- inert until a real
     secret key is configured (same gating pattern as sender.py's
     SendGridSender), ready to drop in the moment the site fronts Turnstile.
  4. Control-character / length / format validation on every field, BEFORE
     anything is persisted or computed -- rejects header-injection-style and
     stored-XSS-style payloads outright.
  5. Cooldown + dedupe (store.within_signup_cooldown /
     find_active_or_pending) -- one confirmation email per address per
     SIGNUP_COOLDOWN_HOURS, and never more than one active record per
     email+state, no matter how many times the form is submitted.
  6. Deadline computability is validated on a throwaway probe dict BEFORE
     store.add_pending() ever runs -- a malformed-but-passable submission
     can no longer create an orphaned pending-confirmation record.

Every one of these fails toward the SAME generic "check your email" response
the real success path uses, so none of them creates an oracle an attacker
could use to enumerate which addresses are already subscribed.
"""

from __future__ import annotations

import json
import os
import pathlib
import re
import sys
import threading
import time
from datetime import date
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlencode, urlparse

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

# -- Bot defense --------------------------------------------------------

# Must match the hidden field name generate.py renders in every signup form.
# A real human never sees or fills this field (styled off-screen); a bot
# that blindly fills every input in the form will. Any non-empty value here
# means "silently do nothing, but LOOK like it worked" -- never tip off the
# bot that it was detected.
HONEYPOT_FIELD_NAME = "hp_website"

# Cloudflare Turnstile drop-in point. The site is already on Cloudflare, so
# Turnstile (free, invisible-mode-capable) is the natural bot wall once a
# public endpoint exists. TURNSTILE_SECRET_KEY is None until the project
# maintainer configures a real secret (env var, never hardcoded/committed --
# same pattern as sender.py's SENDGRID_API_KEY). While unset, verification
# is a documented no-op and the honeypot + rate limit are the active
# defenses; once a secret is set, _verify_turnstile() performs the real
# siteverify call and the form's `cf-turnstile-response` field (reserved,
# see generate.py) is enforced.
TURNSTILE_SECRET_KEY = os.environ.get("TURNSTILE_SECRET_KEY")
TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"


def _verify_turnstile(token: str | None) -> bool:
    if not TURNSTILE_SECRET_KEY:
        return True  # not configured yet -- see module docstring above
    if not token:
        return False
    import urllib.request
    import urllib.error

    payload = urlencode({"secret": TURNSTILE_SECRET_KEY, "response": token}).encode()
    req = urllib.request.Request(TURNSTILE_VERIFY_URL, data=payload, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            result = json.loads(resp.read().decode("utf-8"))
            return bool(result.get("success"))
    except (urllib.error.URLError, urllib.error.HTTPError, ValueError, OSError):
        # Fail CLOSED -- if Turnstile's API is unreachable, treat it as an
        # unverified request rather than silently letting it through.
        return False


# -- Per-IP rate limiting ------------------------------------------------
#
# In-memory, per-process sliding window. Deliberately simple: this is a
# local reference implementation, not the deployed backend. A real
# deployment (see HOSTING_PROPOSAL.md) needs a shared store (Cloudflare
# Workers KV / Durable Objects) since serverless instances don't share
# process memory -- documented there, not solved here.

_RATE_LIMIT_LOCK = threading.Lock()
_RATE_LIMIT_HITS: dict[tuple[str, str], list[float]] = {}

# (max requests, window in seconds) per bucket.
RATE_LIMIT_SUBSCRIBE = (5, 600)     # 5 signups per IP per 10 minutes
RATE_LIMIT_ACTION = (30, 600)       # 30 confirm/unsubscribe/renewed/rearm clicks per IP per 10 minutes


def _check_rate_limit(ip: str, bucket: str, limit: tuple[int, float]) -> bool:
    """Returns True if this request is ALLOWED, False if it should be
    blocked (limit exceeded)."""
    max_requests, window_seconds = limit
    key = (ip, bucket)
    now = time.time()
    with _RATE_LIMIT_LOCK:
        hits = [t for t in _RATE_LIMIT_HITS.get(key, []) if now - t < window_seconds]
        if len(hits) >= max_requests:
            _RATE_LIMIT_HITS[key] = hits
            return False
        hits.append(now)
        _RATE_LIMIT_HITS[key] = hits
        return True


# -- Input validation -----------------------------------------------------

# Deliberately stricter than "contains an @ and a dot" (the previous check):
# rejects whitespace, control characters, multiple @ signs, and malformed
# domains outright. Not a full RFC 5322 implementation (nothing reasonably
# is) -- good enough to reject the payloads an abuse attempt would try.
_EMAIL_RE = re.compile(r"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$")
MAX_EMAIL_LEN = 254  # RFC 5321 5.3.1.3 upper bound

# Any ASCII control character, including CR/LF -- rejecting these anywhere
# closes the door on header-injection-style and stored-XSS-style payloads
# regardless of whether any current code path happens to render or
# transmit them unsafely (defense-in-depth, not "it's currently exploitable").
_CONTROL_CHAR_RE = re.compile(r"[\x00-\x1f\x7f]")

MAX_FIELD_LEN = 120  # generous for a birth month/year/cohort/license id; not free-text

# Cap the request body BEFORE reading it, so a client can't force this
# single-threaded server to allocate/parse an arbitrarily large POST body
# (a trivial memory/CPU DoS otherwise -- Content-Length is entirely
# client-controlled).
MAX_BODY_BYTES = 8192


def _has_control_chars(value: str) -> bool:
    return bool(_CONTROL_CHAR_RE.search(value))


def _valid_email(email: str) -> bool:
    return (
        0 < len(email) <= MAX_EMAIL_LEN
        and not _has_control_chars(email)
        and bool(_EMAIL_RE.match(email))
    )


def _html_page(title: str, body_html: str) -> bytes:
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>{title}</title>
<style>body{{font-family:-apple-system,sans-serif;max-width:520px;margin:3rem auto;padding:0 1.25rem;line-height:1.5;}}</style>
</head><body>{body_html}</body></html>""".encode("utf-8")


_SUBSCRIBE_SUCCESS_PAGE = _html_page(
    "Check your email",
    "<h1>Almost done</h1><p>We sent a confirmation email -- click the link in it to "
    "start getting reminders. If you don't click it, you won't hear from us again.</p>",
)


class Handler(BaseHTTPRequestHandler):
    def _send(self, status: int, body: bytes, content_type: str = "text/html; charset=utf-8") -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _error_page(self, status: int, message: str) -> None:
        self._send(status, _html_page("Error", f"<p>{message}</p>"))

    def _client_ip(self) -> str:
        return self.client_address[0]

    def do_GET(self) -> None:  # noqa: N802 -- stdlib naming convention
        parsed = urlparse(self.path)

        if parsed.path == "/health":
            self._send(200, b'{"status": "ok"}', "application/json")
            return

        if not _check_rate_limit(self._client_ip(), "action", RATE_LIMIT_ACTION):
            self._error_page(429, "Too many requests. Please try again later.")
            return

        try:
            qs = parse_qs(parsed.query)
            token = (qs.get("token") or [None])[0]

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
        except Exception:  # noqa: BLE001 -- a single bad request must never crash the server
            self._error_page(400, "Something went wrong processing that request.")

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path != "/subscribe":
            self._error_page(404, "Not found.")
            return

        ip = self._client_ip()
        if not _check_rate_limit(ip, "subscribe", RATE_LIMIT_SUBSCRIBE):
            self._error_page(429, "Too many signups from this address. Please try again later.")
            return

        # Found by attack-test (2026-07-03 abuse-hardening audit): a
        # malformed (non-integer) Content-Length is client-controlled input
        # and must be validated, not trusted -- int() used to run before
        # this handler's try/except, so a bad header crashed the request
        # with an unhandled ValueError instead of the intended clean 400.
        try:
            length = int(self.headers.get("Content-Length", 0) or 0)
        except ValueError:
            self._error_page(400, "Invalid Content-Length header.")
            return
        if length <= 0 or length > MAX_BODY_BYTES:
            self._error_page(400, "Request too large or empty.")
            return

        try:
            raw = self.rfile.read(length).decode("utf-8")
            form = {k: v[0] for k, v in parse_qs(raw).items()}
            self._handle_subscribe(form)
        except Exception:  # noqa: BLE001 -- a single bad request must never crash the server
            self._error_page(400, "Something went wrong processing that request.")

    # -- handlers -----------------------------------------------------

    def _handle_subscribe(self, form: dict) -> None:
        # Honeypot: a real human never sees or fills this field. ANY
        # non-empty raw value here is treated as a bot -- respond with the
        # IDENTICAL success page a real signup gets (never reveal
        # detection to the bot), but do nothing: no record, no email.
        # Found by adversarial review: an earlier version checked
        # `.strip()` truthiness, so a whitespace-only value (a single
        # space, a tab) fooled the detector -- any bot padding the field
        # with whitespace instead of leaving it truly empty sailed through
        # undetected. Check the raw value's emptiness, not its
        # stripped/truthy form.
        honeypot_value = form.get(HONEYPOT_FIELD_NAME)
        if honeypot_value is not None and honeypot_value != "":
            self._send(200, _SUBSCRIBE_SUCCESS_PAGE)
            return

        # Reject control characters (incl. CR/LF) anywhere in the raw
        # submission before touching any individual field -- closes the
        # door on header-injection/stored-XSS-style payloads regardless of
        # which field they're smuggled in.
        for value in form.values():
            if isinstance(value, str) and _has_control_chars(value):
                self._error_page(400, "Invalid characters in submission.")
                return

        email = (form.get("email") or "").strip()
        state_slug = (form.get("state") or "").strip()
        # Optional, purely cosmetic (an email greeting) -- control chars
        # already rejected above for every field including this one; cap
        # length here too (store.add_pending() re-sanitizes again,
        # defense-in-depth, see its own docstring).
        first_name = (form.get("first_name") or "").strip()[:store.MAX_FIRST_NAME_LEN] or None

        if not _valid_email(email):
            self._error_page(400, "That doesn't look like a valid email address.")
            return
        if state_slug not in SUPPORTED_STATE_SLUGS:
            self._error_page(400, "Unsupported or missing state.")
            return

        if not _verify_turnstile(form.get("cf-turnstile-response")):
            self._error_page(400, "Verification failed -- please try again.")
            return

        deadline_fields: dict = {}
        if state_slug == "california":
            birth_month = form.get("birth_month")
            birth_year = form.get("birth_year")
            if not birth_month or not birth_year or len(birth_year) > 4 or not birth_year.isdigit():
                self._error_page(400, "California needs your birth month and birth year.")
                return
            try:
                birth_month_int = int(birth_month)
                birth_year_int = int(birth_year)
            except ValueError:
                self._error_page(400, "California needs a valid birth month and birth year.")
                return
            if not (1 <= birth_month_int <= 12) or not (1900 <= birth_year_int <= 2100):
                self._error_page(400, "California needs a valid birth month and birth year.")
                return
            # We ask for the user's actual birth year (natural to answer)
            # but only ever PERSIST the odd/even parity the deadline math
            # needs -- the full birth year is used transiently right here
            # and discarded, never written to storage (PII minimization).
            parity = "odd" if birth_year_int % 2 == 1 else "even"
            deadline_fields = {"birth_month": str(birth_month_int), "birth_year_parity": parity}
        elif state_slug == "texas":
            birth_month = form.get("birth_month")
            if not birth_month:
                self._error_page(400, "Texas needs your birth month.")
                return
            try:
                birth_month_int = int(birth_month)
            except ValueError:
                self._error_page(400, "Texas needs a valid birth month.")
                return
            if not (1 <= birth_month_int <= 12):
                self._error_page(400, "Texas needs a valid birth month.")
                return
            deadline_fields = {"birth_month": str(birth_month_int)}
        elif state_slug == "ohio":
            cohort_group = form.get("cohort_group")
            if cohort_group not in ("Group 1", "Group 2", "Group 3"):
                self._error_page(400, "Ohio needs your cohort group.")
                return
            deadline_fields = {"cohort_group": cohort_group}
        elif form.get("license_type_id"):
            license_type_id = form.get("license_type_id")
            if len(license_type_id) > MAX_FIELD_LEN:
                self._error_page(400, "Invalid license type.")
                return
            deadline_fields = {"license_type_id": license_type_id}

        try:
            check_data_freshness(date.today())
        except SystemExit as exc:
            # check_data_freshness() intentionally raises SystemExit to
            # HARD-STOP an offline batch run (the scheduler) on stale data --
            # correct there, but SystemExit is not an Exception subclass, so
            # letting it propagate here would kill this request's thread
            # (and, in a single-threaded HTTPServer, the whole serve_forever
            # loop) on every future request too. A stale-data operational
            # problem must degrade to "signups temporarily unavailable,"
            # never to "the entire backend process exits."
            self._error_page(503, f"Signups are temporarily paused: {exc}")
            return

        # Same "probe before persist" reasoning as the deadline-computability
        # check below: if no real mailing address is configured yet,
        # emails.confirmation_email() would hard-fail with a RuntimeError --
        # correct (CAN-SPAM requires a real address, never a placeholder),
        # but checking BEFORE store.add_pending() means a misconfigured
        # deploy never leaves an orphaned pending record with no
        # confirmation email ever sent.
        if not emails.mailing_address_configured():
            self._error_page(503, "Signups are temporarily paused: service configuration incomplete.")
            return

        # Validate deadline-computability on a THROWAWAY probe BEFORE ever
        # persisting anything. Previously this created the store record
        # first and validated after -- a malformed-but-form-valid submission
        # (e.g. a nonsensical license_type_id) could leave an orphaned,
        # never-confirmable pending record behind. Now nothing is written
        # unless we already know a deadline is computable.
        probe_fields = {"state_slug": state_slug, "deadline_fields": deadline_fields}
        if compute_subscriber_deadline(probe_fields, date.today()) is None:
            self._error_page(400, "Couldn't compute a deadline from what you gave us -- please check your inputs.")
            return

        # Cooldown + dedupe -- BOTH checked before creating anything or
        # sending anything. Either one silently succeeds with the exact
        # same response a real new signup gets, so neither creates an
        # oracle for enumerating existing subscribers. This is what turns
        # "submit victim@x 100 times" into "at most 1 email ever sent."
        if store.within_signup_cooldown(email) or store.find_active_or_pending(email, state_slug) is not None:
            self._send(200, _SUBSCRIBE_SUCCESS_PAGE)
            return

        probe = store.add_pending(email, state_slug, deadline_fields, first_name=first_name)
        result = compute_subscriber_deadline(probe, date.today())
        if result is None:
            # Should be unreachable given the probe check above (same
            # inputs, same function) -- kept as a last-resort guard so a
            # future code change can't silently reintroduce the
            # orphaned-record bug this restructuring fixed.
            self._error_page(400, "Couldn't compute a deadline from what you gave us -- please check your inputs.")
            return

        confirm_url = f"{emails.BACKEND_BASE_URL}/confirm?token={probe['confirm_token']}"
        unsubscribe_url = f"{emails.BACKEND_BASE_URL}/unsubscribe?token={probe['unsubscribe_token']}"
        _, state_name = result
        email_content = emails.confirmation_email(
            state_name, confirm_url, unsubscribe_url, first_name=probe.get("first_name")
        )
        sender_module.get_sender().send(
            probe["email"], email_content["subject"], email_content["text_body"], email_content["html_body"]
        )
        self._send(200, _SUBSCRIBE_SUCCESS_PAGE)

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
        # Abuse-hardening audit finding (row 1): a still-pending (never
        # confirmed) subscriber's unsubscribe_token IS legitimately reachable
        # -- the confirmation email's own footer includes a real unsubscribe
        # link -- so store.stop() still honors it here (permanently killing
        # the pending signup). But "an unconfirmed signup gets exactly one
        # email, ever" means that ONE confirmation email must stay the only
        # one: only send this stop-confirmation email if the subscriber had
        # actually been confirmed at some point. A pending subscriber's
        # unsubscribe is honored silently, with no second email.
        # Only send a notification if BOTH a stop-confirmation email is
        # actually warranted (subscriber was confirmed at some point) AND a
        # real mailing address is configured. The stop/unsubscribe itself
        # (store.stop() above) has already happened either way -- honoring
        # a stop instantly is the priority; a missing address should only
        # ever suppress the notification email, never the underlying action.
        if subscriber.get("confirmed_at") is not None and emails.mailing_address_configured():
            state_name = subscriber["state_slug"].replace("-", " ").title()
            # Found by adversarial review: this previously passed "" as the
            # unsubscribe_url, so the stop-confirmation email's footer rendered
            # a dead, empty unsubscribe link -- the one template in the system
            # that didn't have a real one. Build it the same way every other
            # handler does.
            unsubscribe_url = f"{emails.BACKEND_BASE_URL}/unsubscribe?token={subscriber['unsubscribe_token']}"
            email_content = emails.stop_confirmation_email(
                "unsubscribed", state_name, None, unsubscribe_url, first_name=subscriber.get("first_name")
            )
            sender_module.get_sender().send(
                subscriber["email"], email_content["subject"], email_content["text_body"], email_content["html_body"]
            )
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
        # Same posture as _handle_unsubscribe above: the stop itself already
        # happened (store.stop() call), a missing mailing address only ever
        # suppresses the notification email, never the underlying action.
        if emails.mailing_address_configured():
            email_content = emails.stop_confirmation_email(
                "renewed", state_name, rearm_url, unsubscribe_url, first_name=subscriber.get("first_name")
            )
            sender_module.get_sender().send(
                subscriber["email"], email_content["subject"], email_content["text_body"], email_content["html_body"]
            )
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
