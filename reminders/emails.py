"""
DeadlineRadar reminders -- all email copy in one place.

Every email in this file carries:
  - Sender identification (CAN-SPAM requirement): who this is from, in
    plain language, every time.
  - A physical mailing address placeholder. CAN-SPAM legally requires a
    valid physical postal address in every commercial email. This is NOT
    something that can be fabricated -- it needs a real address (a PO box
    or a commercial mail-receiving agency is normally used for a project
    like this) that the project maintainer sets up. The placeholder below
    is deliberately impossible to miss so a real send can never
    accidentally go out with a fake or missing address -- see
    reminders/README.md.
  - A one-click unsubscribe link, honored instantly per store.py.

No network calls, no real addresses, no rendering framework -- plain
f-strings, matching the rest of this repo's dependency-free approach.
"""

from __future__ import annotations

# Placeholder only -- swap for a real base URL once hosting exists for the
# reminder backend (this is separate from the static Pages hosting for
# docs/ -- see reminders/README.md "Deployment gap" section).
BACKEND_BASE_URL = "https://example-deadlineradar-api.test"

# CAN-SPAM requires a valid physical postal address in every commercial
# email. This is a real legal requirement, not a formatting nicety -- it
# cannot be fabricated. The project maintainer needs to set up a real
# address (PO box or a commercial mail-receiving agency) before any real
# send. Left as an unmistakable placeholder so it can never be silently
# forgotten.
MAILING_ADDRESS_PLACEHOLDER = "[MAILING ADDRESS REQUIRED BEFORE ANY REAL SEND -- see reminders/README.md]"

SENDER_LINE = "DeadlineRadar (a Ravenline project)"


def _footer(unsubscribe_url: str) -> str:
    return (
        f"\n\n---\n"
        f"You're receiving this because you asked {SENDER_LINE} to remind you about a CPA "
        f"license renewal deadline. We only ever email you about that deadline -- we never "
        f"sell or share your email address, and there's nothing else we send.\n\n"
        f"Unsubscribe any time, instantly: {unsubscribe_url}\n\n"
        f"{SENDER_LINE}\n{MAILING_ADDRESS_PLACEHOLDER}"
    )


def confirmation_email(state_name: str, confirm_url: str, unsubscribe_url: str) -> dict:
    subject = f"Confirm your {state_name} CPA renewal reminder"
    text_body = (
        f"Hi,\n\n"
        f"Someone (hopefully you!) asked {SENDER_LINE} to send deadline reminders for a "
        f"{state_name} CPA license renewal. Before we send anything else, please confirm this "
        f"is really your email address:\n\n"
        f"{confirm_url}\n\n"
        f"If you don't click that link, we will never email you again -- nothing else happens "
        f"automatically.\n\n"
        f"Once confirmed: we'll only ever email you about this one deadline, on a schedule that "
        f"gets more frequent as the date gets closer (60, 30, 14, 7, 3, and 1 day before). We "
        f"never sell or share your address, and every email has a one-click way to stop."
        f"{_footer(unsubscribe_url)}"
    )
    return {"subject": subject, "text_body": text_body, "html_body": None}


_URGENCY_TONE = {
    60: "Just a heads up, nothing urgent yet",
    30: "Worth putting on your calendar now",
    14: "Two weeks out — a good time to actually do this",
    7: "One week left",
    3: "Three days left",
    1: "Tomorrow is the deadline",
}


def reminder_email(
    state_name: str,
    deadline_date_str: str,
    days_remaining: int,
    renewed_url: str,
    unsubscribe_url: str,
) -> dict:
    if days_remaining not in _URGENCY_TONE:
        raise ValueError(f"days_remaining must be one of {sorted(_URGENCY_TONE)}, got {days_remaining}")
    tone = _URGENCY_TONE[days_remaining]
    subject = f"{tone}: {state_name} CPA renewal due {deadline_date_str}"
    text_body = (
        f"Hi,\n\n"
        f"{tone.rstrip('.')} — your {state_name} CPA license renewal is due {deadline_date_str} "
        f"({days_remaining} day{'s' if days_remaining != 1 else ''} from now).\n\n"
        f"Already renewed? One click stops all further reminders for this deadline:\n"
        f"{renewed_url}\n\n"
        f"Haven't renewed yet? No action needed from us -- we'll remind you again as it gets "
        f"closer, right up through the day before."
        f"{_footer(unsubscribe_url)}"
    )
    return {"subject": subject, "text_body": text_body, "html_body": None}


def stop_confirmation_email(reason: str, state_name: str, rearm_url: str | None, unsubscribe_url: str) -> dict:
    assert reason in ("unsubscribed", "renewed")
    if reason == "renewed":
        subject = f"Got it — no more reminders for this {state_name} renewal"
        text_body = (
            f"Hi,\n\n"
            f"Nice work -- we've stopped all reminders for this {state_name} CPA renewal cycle. "
            f"You won't get anything else about this deadline.\n\n"
        )
        if rearm_url:
            text_body += (
                f"Want a reminder next cycle too? One click re-arms it for the next renewal "
                f"period, nothing else changes:\n{rearm_url}\n\n"
                f"If you don't click that, we simply won't email you again about this."
            )
        else:
            text_body += "If you ever want reminders again, you're welcome to sign up fresh any time."
    else:
        subject = f"Unsubscribed — no more {state_name} renewal reminders"
        text_body = (
            f"Hi,\n\n"
            f"You're unsubscribed. We've stopped all reminders for this {state_name} CPA renewal "
            f"immediately and permanently -- you won't hear from us again unless you sign up "
            f"again yourself.\n\n"
            f"Sorry to see you go, and thanks for trying it."
        )
    text_body += _footer(unsubscribe_url)
    return {"subject": subject, "text_body": text_body, "html_body": None}
