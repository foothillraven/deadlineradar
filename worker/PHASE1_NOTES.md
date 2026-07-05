# Phase 1 — deliberate divergences from the Python reference

Per `orchestrator_20260704T500000_phase1_worker_build.md`: port the endpoints with the
SAME hardened validation, keep all abuse defenses, hard-disable email sending. This Worker
does that, but two small, deliberate divergences from `../reminders/server.py` follow
directly from "hard-disable email sending" and are worth calling out explicitly rather
than leaving implicit in code comments alone.

## 1. No "mailing address configured" gate on `/subscribe`

`server.py:395` refuses a signup with a 503 if `REMINDERS_MAILING_ADDRESS` isn't set,
specifically to prevent a misconfigured deploy from creating a `pending_confirmation`
record that can never receive its confirmation email (an orphaned record). That gate only
exists because the Python original CAN send a confirmation email once a mailing address
exists.

This Worker has no email-sending code at all in Phase 1 — a signup is *always* going to sit
as `pending_confirmation` with no confirmation email, regardless of whether a mailing
address is configured. Carrying the gate forward would just mean every real signup gets a
confusing 503 (since `REMINDERS_MAILING_ADDRESS` will never be set against this Worker in
Phase 1), for a failure mode ("orphaned record") that doesn't apply yet. The gate is
removed for Phase 1 and will need to be added back — this time checking a real
confirmation-send capability, not just an env var — when Phase 2 adds sending.

## 2. Success-page copy does not promise an email

`server.py`'s success page says "we sent a confirmation email." Phase 1 never sends one, so
that copy would be false here. Every Phase-1 response that would otherwise reference an
email that "was sent" or invite the reader to "check your email" has been reworded to state
plainly that automated email isn't switched on yet in this rollout phase (see
`src/index.ts`'s `SUBSCRIBE_SUCCESS_PAGE` and the `/confirm`, `/renewed` handlers). This is a
deliberate honesty call, not an oversight — CLAUDE.md's standing instruction is to never
overclaim, and a test signup that gets told "check your email" when no email exists would be
exactly that.

One consequence worth naming: because the confirm/renewed/rearm tokens are only ever
delivered via email in the original design, and Phase 1 sends no email, there is currently
**no way for a real end user to reach `/confirm` in Phase 1** — they would receive a token
they never see. This is expected and by design: the directive's own acceptance criterion is
"inspect the D1 row after a test signup," i.e. the Phase-1 acceptance test (see
`ACCEPTANCE.md`) reads the `confirm_token` directly out of D1 rather than receiving it by
email. Real end users don't reach this Worker at all in Phase 1 anyway — the live site's
form action is staged to point here but deliberately **not pushed** (see the top-level repo
notes / outbox report), so there is no real public traffic to this Worker until a separate,
later, explicitly-approved step flips that.

## Everything else is an unchanged, faithful port

Every abuse-hardening check ported 1:1 from `reminders/server.py` / `reminders/store.py`:
honeypot (including the whitespace-only bypass fix), per-IP rate limiting (D1-backed,
same 5/600s and 30/600s buckets), control-character rejection, the email regex, the
double-opt-in-bypass fix in `stop()`, the Gmail dot/+tag cooldown-key folding, the
over-broad-suppression fix in `isPermanentlySuppressed()` (ported but not yet wired into
any Phase-1 route — see `src/store.ts`'s docstring; the Python original only calls it from
the scheduler, which Phase 1 does not deploy; its query was rewritten to use an indexed
lookup, `migrations/0003_email_normalized_index.sql`, after an adversarial review found the
first port did a full-table scan), and the "probe before persist"
deadline-computability check. See `src/*.ts` docstrings for the line-by-line provenance of
each one.
