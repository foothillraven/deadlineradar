"""
DeadlineRadar reminders -- all email copy in one place.

Every email built here carries:
  - Sender identification (CAN-SPAM requirement): who this is from, in
    plain language, every time.
  - A REAL physical mailing address (CAN-SPAM legally requires one in every
    commercial email). This module never fabricates one: `_mailing_address()`
    raises `RuntimeError` if a real address isn't configured. The ONLY way
    to get a non-real value through is `set_test_mailing_address_override()`,
    which is technically restricted (not just documented) to callers named
    `run_live_selftest.py` (the hard-whitelisted live self-test) or
    `test_dry_run_e2e.py` (this repo's own test suite) -- see that
    function's docstring. Production code paths (`server.py`, `scheduler.py`)
    are not on that list, so a real subscriber can never receive a
    placeholder address: the send simply fails closed with a clear error
    first.
  - A one-click unsubscribe link, honored instantly per store.py.

Every email is built as BOTH a plain-text body and an HTML body (multipart
-- callers pass both to sender.py). The HTML view uses styled buttons /
anchor text for actions instead of ever printing a raw URL, matching the
static site's own visual language (same CSS custom-property values as
generate.py's PAGE_CSS) so the email reads as the same product, not a
script. No network calls, no rendering framework -- an f-string-based
template, matching the rest of this repo's dependency-free approach.
"""

from __future__ import annotations

import html
import os
import pathlib
import sys

# Placeholder only -- swap for a real base URL once hosting exists for the
# reminder backend (this is separate from the static Pages hosting for
# docs/ -- see reminders/README.md "Deployment gap" section). Used for
# confirm/unsubscribe/renewed/rearm action links, which need the (not yet
# deployed) backend.
BACKEND_BASE_URL = "https://example-deadlineradar-api.test"

# The REAL, already-public marketing site -- deadline-radar.com is
# registered and live (see HANDOFF.md 2026-07-03T20:18 escalation, resolved
# as authorized by the orchestrator 2026-07-03T20:10). Deliberately a
# SEPARATE constant from BACKEND_BASE_URL above: this is just the wordmark
# link in the email header pointing at the real, already-live static site --
# it does not touch, deploy, or depend on the still-inert signup backend.
SITE_URL = "https://deadline-radar.com"

SITE_NAME = "DeadlineRadar"
BRAND_NAME = "Moose & Raven LLC"
SENDER_LINE = f"{SITE_NAME} (a {BRAND_NAME} project)"

# CAN-SPAM requires a valid physical postal address in every commercial
# email -- a real legal requirement, not a formatting nicety. This module
# refuses to fabricate one. Set the real address via this environment
# variable once the project maintainer has one (a PO box or a commercial
# mail-receiving agency is the normal solution for a project like this).
MAILING_ADDRESS_ENV_VAR = "REMINDERS_MAILING_ADDRESS"

# ONLY ever set by run_live_selftest.py, which is itself hard-gated to a
# single whitelisted recipient (sender.WhitelistedSender). Do not set this
# from any other caller -- see set_test_mailing_address_override()'s own
# docstring for why that would defeat the whole point of this guard. This
# is TECHNICALLY enforced (not just documented) in that function -- only a
# caller whose own source filename is in this set is allowed through.
_ALLOWED_OVERRIDE_CALLERS = frozenset({"run_live_selftest.py", "test_dry_run_e2e.py"})

_TEST_MAILING_ADDRESS_OVERRIDE: str | None = None

MAX_FIRST_NAME_LEN = 60


def set_test_mailing_address_override(marker: str) -> None:
    """FOR run_live_selftest.py ONLY. Lets the hard-whitelisted self-test
    (which can only ever send to one pre-approved address) render a
    clearly-fake, obviously-internal marker in the footer instead of
    hard-failing, so a human can review the rest of the template before a
    real address exists. Any OTHER caller setting this would reopen the
    exact hole `_mailing_address()` exists to close -- a placeholder
    reaching a real recipient -- so this function must never be called from
    server.py, scheduler.py, or any code path that can reach a real
    subscriber.

    Found by adversarial review: a docstring alone is not a technical
    control -- nothing previously stopped ANY caller in-process from
    setting this. Now enforced at the call site: only a caller whose own
    source file is in `_ALLOWED_OVERRIDE_CALLERS` may set it; anyone else
    gets a RuntimeError instead of silently poisoning global state that
    every subsequent email-build in this process would then use."""
    caller_file = pathlib.Path(sys._getframe(1).f_globals.get("__file__", "")).name
    if caller_file not in _ALLOWED_OVERRIDE_CALLERS:
        raise RuntimeError(
            f"REFUSING: set_test_mailing_address_override() may only be called from "
            f"{sorted(_ALLOWED_OVERRIDE_CALLERS)}, not {caller_file!r}. This override exists solely for "
            "the hard-whitelisted live self-test -- any other caller setting it would let a placeholder "
            "address reach a real recipient."
        )
    global _TEST_MAILING_ADDRESS_OVERRIDE
    _TEST_MAILING_ADDRESS_OVERRIDE = marker


def clear_test_mailing_address_override() -> None:
    """Test/teardown helper -- restores the hard-fail-by-default posture."""
    global _TEST_MAILING_ADDRESS_OVERRIDE
    _TEST_MAILING_ADDRESS_OVERRIDE = None


# A real physical mailing address is never this short. Catches an env var
# accidentally set to whitespace, a single punctuation character, or (found
# by adversarial review) a string made ENTIRELY of zero-width/format
# characters (e.g. U+200B) -- those pass a bare `.strip()` truthiness check
# but would render an invisible, useless "address" into a real CAN-SPAM
# footer. Not a rigorous address validator (impossible in general) -- just
# enough to reject the degenerate cases a bare non-empty check let through.
MIN_MAILING_ADDRESS_LEN = 10


def _cleaned_configured_address() -> str | None:
    """Single source of truth for both `mailing_address_configured()` and
    `_mailing_address()` -- keeping them as two separate checks over the raw
    env var/override previously let them drift (exactly the TOCTOU shape an
    adversarial review would look for); now both delegate here."""
    raw = _TEST_MAILING_ADDRESS_OVERRIDE or os.environ.get(MAILING_ADDRESS_ENV_VAR, "")
    # Strip ordinary whitespace, then drop any remaining non-printable/
    # format character (zero-width spaces, RTLO, etc.) before judging
    # whether this looks like a real, displayable address.
    cleaned = "".join(ch for ch in raw.strip() if ch.isprintable())
    if len(cleaned) < MIN_MAILING_ADDRESS_LEN:
        return None
    return cleaned


def mailing_address_configured() -> bool:
    """True if a send can proceed without hitting the hard-fail in
    `_mailing_address()` below. Callers that persist state before building
    an email (server.py's /subscribe, which creates a pending record) should
    check this FIRST and refuse gracefully -- same "probe before persist"
    pattern already used for deadline-computability, so a missing address
    can never leave an orphaned record with no confirmation email sent."""
    return _cleaned_configured_address() is not None


def _mailing_address() -> str:
    """The single choke point every email-building function below calls
    FIRST, before composing any text or HTML. Raises immediately if no real
    address is configured -- this is deliberate: it means a half-built email
    object containing a placeholder can never exist in the first place, let
    alone be returned to a caller that might send it."""
    cleaned = _cleaned_configured_address()
    if cleaned is None:
        raise RuntimeError(
            f"REFUSING TO BUILD EMAIL: no real mailing address configured ({MAILING_ADDRESS_ENV_VAR} "
            "is unset or too short/invisible to be a real address). CAN-SPAM requires a real physical "
            "postal address in every commercial email -- it cannot be fabricated, and a placeholder "
            "must never reach a real recipient. Set the env var (a PO box or commercial mail-receiving "
            "agency) before any real send."
        )
    return cleaned


def _esc(s: str) -> str:
    return html.escape(str(s), quote=True)


def _safe_first_name(first_name: str | None) -> str | None:
    """Defense-in-depth ONLY -- server.py already validates length and
    rejects control characters (including CR/LF) on every form field before
    this ever runs. This module must never trust that blindly: strip
    whitespace, drop anything non-printable, and cap length again here, so
    a future caller that forgets to validate still can't smuggle control
    characters or an unbounded string into an email."""
    if not first_name:
        return None
    name = "".join(ch for ch in first_name.strip() if ch.isprintable())[:MAX_FIRST_NAME_LEN]
    return name or None


def _text_greeting(first_name: str | None) -> str:
    name = _safe_first_name(first_name)
    return f"Hi {name}," if name else "Hi there,"


def _html_greeting(first_name: str | None) -> str:
    name = _safe_first_name(first_name)
    return f"Hi {_esc(name)}," if name else "Hi there,"


# ---------------------------------------------------------------------------
# HTML shell -- same color values as generate.py's PAGE_CSS custom
# properties, so the email reads as the same product as the site, not a
# separate thing. Table-based layout (not flexbox/grid) for email-client
# compatibility; inline styles carry the base look for clients that strip
# <style> blocks, the <style> block itself adds dark-mode overrides and
# small responsive tweaks on top.
# ---------------------------------------------------------------------------

_LIGHT = dict(bg="#f3f5f7", card="#ffffff", fg="#1a2129", muted="#5b6572", border="#d8dee5", accent="#1f5fbf")
_DARK = dict(bg="#0d1013", card="#1a1f26", fg="#e7ebf0", muted="#9aa5b1", border="#2a323c", accent="#7fb0ff")


def _button(url: str, label: str) -> str:
    return (
        f'<a href="{_esc(url)}" class="dr-btn" '
        f'style="display:inline-block;background:{_LIGHT["accent"]};color:#ffffff;'
        f'text-decoration:none;font-weight:700;font-size:15px;line-height:1;'
        f'padding:13px 24px;border-radius:8px;">{_esc(label)}</a>'
    )


def _text_link(url: str, label: str) -> str:
    return (
        f'<a href="{_esc(url)}" class="dr-accent" '
        f'style="color:{_LIGHT["accent"]};text-decoration:underline;font-size:13px;">{_esc(label)}</a>'
    )


def _html_footer(unsubscribe_url: str, addr: str) -> str:
    return (
        f'<p class="dr-muted" style="font-size:12px;color:{_LIGHT["muted"]};line-height:1.6;margin:0 0 10px;">'
        f"You're getting this because you asked {_esc(SITE_NAME)} to track a CPA license renewal "
        f"deadline. We send only renewal reminders for that one deadline &mdash; no marketing, ever."
        f"</p>"
        f'<p style="font-size:13px;margin:0 0 10px;">{_text_link(unsubscribe_url, "Unsubscribe")}</p>'
        f'<p class="dr-muted" style="font-size:11px;color:{_LIGHT["muted"]};line-height:1.5;margin:0;">'
        f"{_esc(SENDER_LINE)}<br>{_esc(addr)}</p>"
    )


def _text_footer(unsubscribe_url: str, addr: str) -> str:
    return (
        f"\n\n---\n"
        f"You're getting this because you asked {SITE_NAME} to track a CPA license renewal deadline. "
        f"We send only renewal reminders for that one deadline -- no marketing, ever.\n\n"
        f"Unsubscribe any time, instantly: {unsubscribe_url}\n\n"
        f"{SENDER_LINE}\n{addr}"
    )


def _html_shell(preheader: str, body_html: str, footer_html: str) -> str:
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>{_esc(SITE_NAME)}</title>
<style>
  body, table, td, a {{ -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }}
  body {{ margin: 0; padding: 0; }}
  img {{ border: 0; line-height: 100%; outline: none; text-decoration: none; }}
  @media (prefers-color-scheme: dark) {{
    .dr-bg {{ background: {_DARK["bg"]} !important; }}
    .dr-card {{ background: {_DARK["card"]} !important; border-color: {_DARK["border"]} !important; }}
    .dr-fg {{ color: {_DARK["fg"]} !important; }}
    .dr-muted {{ color: {_DARK["muted"]} !important; }}
    .dr-accent {{ color: {_DARK["accent"]} !important; }}
    .dr-btn {{ background: {_DARK["accent"]} !important; color: #0d1013 !important; }}
  }}
  @media (max-width: 600px) {{
    .dr-container {{ width: 100% !important; }}
    .dr-pad {{ padding: 22px !important; }}
  }}
</style>
</head>
<body class="dr-bg" style="margin:0;padding:0;background:{_LIGHT["bg"]};">
<span style="display:none;max-height:0;overflow:hidden;mso-hide:all;">{_esc(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="dr-bg" style="background:{_LIGHT["bg"]};">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" class="dr-container" style="width:560px;max-width:100%;">
<tr><td class="dr-pad" style="padding-bottom:20px;">
  <a href="{_esc(SITE_URL)}" style="text-decoration:none;">
    <span class="dr-fg" style="font-size:20px;font-weight:800;letter-spacing:-0.02em;color:{_LIGHT["fg"]};">{_esc(SITE_NAME)}</span>
  </a>
</td></tr>
<tr><td class="dr-card dr-pad" style="background:{_LIGHT["card"]};border:1px solid {_LIGHT["border"]};border-radius:12px;padding:32px;">
{body_html}
</td></tr>
<tr><td class="dr-pad" style="padding-top:20px;">
{footer_html}
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>"""


def _p(text: str, size: int = 15, color: str | None = None) -> str:
    color = color or _LIGHT["fg"]
    return f'<p class="dr-fg" style="margin:0 0 16px;font-size:{size}px;line-height:1.6;color:{color};">{text}</p>'


def confirmation_email(state_name: str, confirm_url: str, unsubscribe_url: str, first_name: str | None = None) -> dict:
    # Hard-fail FIRST, before composing anything -- see _mailing_address()'s
    # own docstring for why this ordering matters.
    addr = _mailing_address()
    subject = f"Confirm your {state_name} CPA renewal reminder"
    # Normal priority -- high-importance headers are reserved for the 1-day
    # reminder tier only (see HIGH_IMPORTANCE_HEADERS above).
    headers: dict = {}

    text_body = (
        f"{_text_greeting(first_name)}\n\n"
        f"Someone (hopefully you) asked {SITE_NAME} to send renewal reminders for a {state_name} CPA "
        f"license. Please confirm this is really your inbox before we send anything else:\n\n"
        f"{confirm_url}\n\n"
        f"If you don't click that link, we will never email you again -- nothing else happens "
        f"automatically.\n\n"
        f"Once confirmed, we'll email you as the renewal date approaches: 60, 30, 14, 7, 3, and 1 day "
        f"before. That's the whole schedule -- no marketing, no third-party offers, ever."
        f"{_text_footer(unsubscribe_url, addr)}"
    )

    html_body = _html_shell(
        preheader=f"Confirm your {state_name} CPA renewal reminder",
        body_html=(
            f'<h1 class="dr-fg" style="margin:0 0 16px;font-size:19px;font-weight:700;color:{_LIGHT["fg"]};">'
            f"Confirm your reminder</h1>"
            + _p(
                f"{_html_greeting(first_name)}<br><br>"
                f"Someone (hopefully you) asked {_esc(SITE_NAME)} to send renewal reminders for a "
                f"{_esc(state_name)} CPA license. Please confirm this is really your inbox before we "
                f"send anything else."
            )
            + f'<p style="margin:0 0 20px;">{_button(confirm_url, "Confirm my email")}</p>'
            + _p(
                "If you don't click that button, we will never email you again &mdash; nothing else "
                "happens automatically.",
                size=13,
                color=_LIGHT["muted"],
            )
            + _p(
                "Once confirmed, we'll email you as the renewal date approaches: 60, 30, 14, 7, 3, and "
                "1 day before. That's the whole schedule &mdash; no marketing, no third-party offers, ever.",
                size=13,
                color=_LIGHT["muted"],
            )
        ),
        footer_html=_html_footer(unsubscribe_url, addr),
    )

    return {"subject": subject, "text_body": text_body, "html_body": html_body, "headers": headers}


# `threshold` (one of 60/30/14/7/3/1) picks the urgency LEAD phrase only.
# `actual_days_remaining` (see reminder_email()) is the TRUE number of days
# left and is what gets shown in the body -- kept deliberately separate.
# Found by adversarial review: an earlier version used the threshold itself
# as the displayed day-count, so a subscriber whose real deadline was e.g.
# 40 days out (crossing the 60-day tier for the first time, since 40 <= 60)
# got an email claiming "60 days from now" -- factually wrong. Lead phrases
# below deliberately avoid stating a specific day count themselves (that's
# `when_phrase`'s job, computed once from the real value) so the two can
# never contradict each other, including in the threshold=1 catch-up case
# where actual_days_remaining can be 0 or negative rather than exactly 1.
_URGENCY_LEAD = {
    60: "Nothing urgent yet, just flagging it early",
    30: "A good time to start gathering what you'll need",
    14: "Two weeks out, worth doing this now rather than later",
    7: "One week to go",
    3: "Just a few days left",
    1: "This is your final reminder for this deadline",
}


# ---------------------------------------------------------------------------
# "Urgency done right" (orchestrator directive, 2026-07-04) -- specific,
# deadline-front-loaded subject lines that escalate in FIRMNESS across tiers,
# never in formatting tricks. No clickbait, no ALL CAPS, no "!!!": the real
# date/countdown IS the urgency. High-importance transport headers are
# reserved for the single most urgent tier (1-day) -- flagging every email
# high-priority is a cry-wolf spam signal that actively hurts deliverability;
# see sender.py for where these headers actually get attached to a send.
# ---------------------------------------------------------------------------

HIGH_IMPORTANCE_HEADERS = {
    "Importance": "High",
    "X-Priority": "1",
    "X-MSMail-Priority": "High",
}


def _days_phrase(actual_days_remaining: int) -> str:
    """Same day-count math as `reminder_email()`'s own `when_phrase` below --
    kept as one function so the subject and body can never disagree about
    the real count, the same class of bug an earlier adversarial pass found
    when a lead phrase's own wording doubled as the displayed number."""
    if actual_days_remaining > 0:
        return f"in {actual_days_remaining} day{'s' if actual_days_remaining != 1 else ''}"
    if actual_days_remaining == 0:
        return "today"
    return f"{-actual_days_remaining} day{'s' if actual_days_remaining != -1 else ''} ago"


def _reminder_subject(state_name: str, threshold: int, actual_days_remaining: int, deadline_date_str: str) -> str:
    """Built from `actual_days_remaining` (the TRUE remaining count), never
    the threshold -- same non-negotiable rule as the body's `when_phrase`:
    stating the threshold instead of the real count is exactly the bug an
    earlier adversarial pass found and fixed for the body; the subject must
    not reintroduce it, including in the threshold=1 catch-up case where a
    scheduler gap can mean the "final" tier fires with more than 1 day, or
    fewer than 0 days (already overdue), actually remaining."""
    if threshold == 1:
        if actual_days_remaining == 1:
            lead_word = "Tomorrow"
        elif actual_days_remaining == 0:
            lead_word = "Today"
        elif actual_days_remaining < 0:
            lead_word = "Overdue"
        else:
            # Catch-up landed on the final tier more than a day early --
            # stay accurate rather than claim "Tomorrow" for a false date.
            lead_word = _days_phrase(actual_days_remaining).capitalize()
        return f"{lead_word}: your {state_name} CPA license renewal is due"

    days_phrase = _days_phrase(actual_days_remaining)
    if threshold == 60:
        # Calm heads-up -- softest verb, no call to action implied yet.
        return f"Your {state_name} CPA license expires {days_phrase} ({deadline_date_str})"
    if threshold in (30, 14, 7):
        # Firmer: names the action window, still no pressure tactics.
        return (
            f"Your {state_name} CPA license renewal is due {days_phrase} ({deadline_date_str}) "
            f"— a good time to start"
        )
    # threshold == 3: pointed -- the plain, unsoftened statement itself
    # carries the urgency at this tier.
    return f"Your {state_name} CPA license renewal is due {days_phrase} ({deadline_date_str})"


def reminder_email(
    state_name: str,
    deadline_date_str: str,
    threshold: int,
    actual_days_remaining: int,
    renewed_url: str,
    unsubscribe_url: str,
    first_name: str | None = None,
) -> dict:
    if threshold not in _URGENCY_LEAD:
        raise ValueError(f"threshold must be one of {sorted(_URGENCY_LEAD)}, got {threshold}")
    addr = _mailing_address()
    lead = _URGENCY_LEAD[threshold]
    subject = _reminder_subject(state_name, threshold, actual_days_remaining, deadline_date_str)
    # High-importance transport headers ONLY on the final (1-day) tier --
    # every other tier stays at normal priority. See HIGH_IMPORTANCE_HEADERS'
    # own comment for why: flagging every email high-priority is a cry-wolf
    # signal that hurts deliverability, so it's reserved for when it's
    # genuinely warranted.
    headers = dict(HIGH_IMPORTANCE_HEADERS) if threshold == 1 else {}

    if actual_days_remaining > 0:
        when_phrase = f"{actual_days_remaining} day{'s' if actual_days_remaining != 1 else ''} from now"
    elif actual_days_remaining == 0:
        when_phrase = "today"
    else:
        when_phrase = f"{-actual_days_remaining} day{'s' if actual_days_remaining != -1 else ''} ago"

    text_body = (
        f"{_text_greeting(first_name)}\n\n"
        f"{lead} -- your {state_name} CPA license renewal is due {deadline_date_str} ({when_phrase}).\n\n"
        f"Already renewed? One click stops every further reminder for this deadline:\n"
        f"{renewed_url}\n\n"
        f"Nothing to do yet? We'll remind you again as it gets closer, right up through the day before."
        f"{_text_footer(unsubscribe_url, addr)}"
    )

    html_body = _html_shell(
        preheader=f"{lead}: {state_name} CPA renewal due {deadline_date_str}",
        body_html=(
            f'<h1 class="dr-fg" style="margin:0 0 16px;font-size:19px;font-weight:700;color:{_LIGHT["fg"]};">'
            f"{_esc(lead)}</h1>"
            + _p(
                f"{_html_greeting(first_name)}<br><br>"
                f"Your {_esc(state_name)} CPA license renewal is due <strong>{_esc(deadline_date_str)}</strong> "
                f"({_esc(when_phrase)})."
            )
            + f'<p style="margin:0 0 20px;">{_button(renewed_url, "Stop these reminders")}</p>'
            + _p("Already renewed? The button above stops every further reminder for this deadline.", size=13, color=_LIGHT["muted"])
            + _p("Nothing to do yet? We'll remind you again as it gets closer, right up through the day before.", size=13, color=_LIGHT["muted"])
        ),
        footer_html=_html_footer(unsubscribe_url, addr),
    )

    return {"subject": subject, "text_body": text_body, "html_body": html_body, "headers": headers}


def stop_confirmation_email(
    reason: str,
    state_name: str,
    rearm_url: str | None,
    unsubscribe_url: str,
    first_name: str | None = None,
) -> dict:
    assert reason in ("unsubscribed", "renewed")
    addr = _mailing_address()
    greeting_text = _text_greeting(first_name)
    greeting_html = _html_greeting(first_name)

    if reason == "renewed":
        subject = f"No more reminders for this {state_name} renewal"
        text_body = (
            f"{greeting_text}\n\n"
            f"Nice work -- we've stopped every reminder for this {state_name} CPA renewal cycle. "
            f"You won't hear from us again about this deadline.\n\n"
        )
        body_html_extra = ""
        if rearm_url:
            text_body += (
                f"Want a reminder next cycle too? One click re-arms it, nothing else changes:\n"
                f"{rearm_url}\n\n"
                f"If you don't click that, we simply won't email you again about this."
            )
            body_html_extra = (
                f'<p style="margin:0 0 20px;">{_button(rearm_url, "Remind me next time")}</p>'
                + _p("Nothing else changes if you don't click it -- we simply won't email you again about this.", size=13, color=_LIGHT["muted"])
            )
        else:
            text_body += "Want reminders again someday? You're welcome to sign up fresh any time."
            body_html_extra = _p("Want reminders again someday? You're welcome to sign up fresh any time.", size=13, color=_LIGHT["muted"])

        html_body_inner = (
            f'<h1 class="dr-fg" style="margin:0 0 16px;font-size:19px;font-weight:700;color:{_LIGHT["fg"]};">Nice work</h1>'
            + _p(
                f"{greeting_html}<br><br>"
                f"We've stopped every reminder for this {_esc(state_name)} CPA renewal cycle. You won't "
                f"hear from us again about this deadline."
            )
            + body_html_extra
        )
    else:
        subject = f"You're unsubscribed from {state_name} renewal reminders"
        text_body = (
            f"{greeting_text}\n\n"
            f"You're unsubscribed. We've stopped every reminder for this {state_name} CPA renewal "
            f"immediately and permanently -- you won't hear from us again unless you sign up again "
            f"yourself.\n\n"
            f"Sorry to see you go, and thanks for trying {SITE_NAME}."
        )
        html_body_inner = (
            f'<h1 class="dr-fg" style="margin:0 0 16px;font-size:19px;font-weight:700;color:{_LIGHT["fg"]};">'
            f"You're unsubscribed</h1>"
            + _p(
                f"{greeting_html}<br><br>"
                f"We've stopped every reminder for this {_esc(state_name)} CPA renewal immediately and "
                f"permanently &mdash; you won't hear from us again unless you sign up again yourself."
            )
            + _p(f"Sorry to see you go, and thanks for trying {_esc(SITE_NAME)}.", size=13, color=_LIGHT["muted"])
        )

    text_body += _text_footer(unsubscribe_url, addr)
    html_body = _html_shell(
        preheader=subject,
        body_html=html_body_inner,
        footer_html=_html_footer(unsubscribe_url, addr),
    )

    # Normal priority -- high-importance headers are reserved for the 1-day
    # reminder tier only (see HIGH_IMPORTANCE_HEADERS above).
    return {"subject": subject, "text_body": text_body, "html_body": html_body, "headers": {}}
