# DeadlineRadar reminders — the "remind me" feature

**Status: built, dry-run tested end-to-end, NOT deployed. Zero real emails have ever been sent —
`DryRunSender` is the only sender wired up anywhere in this codebase.**

## What this is

A signup form (on every state page + the homepage) that captures an email address and enough
state-specific detail (birth month, cohort group, etc.) to compute *that person's own* renewal
deadline, then emails them reminders on an escalating schedule as it approaches: **60, 30, 14, 7,
3, and 1 day before.** Double opt-in, one-click unsubscribe, one-click "I've renewed" that halts
reminders instantly, and an offer to re-arm for the next cycle.

## Product requirements this satisfies

- **Zero spam.** The email is used for exactly one thing: reminders about the deadline the person
  signed up for. Never sold, never shared, never repurposed for anything else — there is no code
  path anywhere in this feature that does anything else with an email address.
- **Trust-first UX.** The signup form shows the privacy microcopy ("We only email you deadline
  reminders. We never sell or share your address. Unsubscribe anytime.") *before* the email
  field, not after.
- **Double opt-in.** Signing up sends a confirmation email; nothing else happens until that link
  is clicked. An unconfirmed signup gets exactly one email, ever.
- **Escalating reminders**, exactly the requested cadence, verified end-to-end (see Testing below)
  to fire each threshold exactly once, never twice, never skipped.
- **One-click "I've renewed"** on every reminder, halts immediately, offers to re-arm for next
  cycle. **One-click unsubscribe**, halts immediately and permanently — verified in the test suite
  that an unsubscribed (not "renewed") subscriber can never be silently re-armed; they'd have to
  sign up fresh, which is itself explicit re-consent.

## Architecture

```
reminders/
  store.py        subscriber storage (subscribers.json, GITIGNORED -- real PII)
  sender.py        pluggable email-sender interface; DryRunSender is the only one active
  emails.py        all email copy (confirmation, 6 reminder stages, stop-confirmation)
  scheduler.py     escalation logic -- reuses generate.py's OWN date-math functions
  server.py        stdlib http.server backend: /subscribe /confirm /unsubscribe /renewed /rearm
  test_dry_run_e2e.py   real end-to-end test (run it: see Testing below)
  subscribers.example.json   fake-data schema example (the real file is gitignored)
```

Stdlib only — no new dependencies, matching the rest of this repo. The signup form itself lives
in `generate.py` (the static site generator), not here — see "Site-side form" below.

### Why the deadline computation reuses `generate.py`, not a re-implementation

`scheduler.py` imports `next_birth_month_parity_date` and `next_annual_month_end` directly from
`generate.py` rather than re-deriving the same math. Two implementations of the same date rule
can drift apart over time as one gets edited and the other doesn't — reusing the exact functions
means the reminder a subscriber gets can never disagree with what the state's own page displays.

For fixed-calendar states, the scheduler reads the same `next_deadline_computed` values from
`data/cpa_deadlines.json` the static site uses, and inherits the exact same wall-clock staleness
guard (`check_data_freshness()`, mirroring `generate.py`'s `STALENESS_THRESHOLD_DAYS` check) — the
reminder scheduler refuses to run on data more than 30 days unverified, for the same reason the
site refuses to build on it.

### Site-side form

`generate.py` gained a `signup_form_for_state()` (state pages, all fields known statically) and
`signup_form_homepage()` (homepage, state picked at runtime via a small vanilla-JS show/hide
handler — the only JS on the site, used because it clearly helps here). Every field the backend
needs to compute a deadline is collected: license-type picker for Florida/Georgia's multiple
cohorts, birth month + year for California, birth month for Texas, cohort group for Ohio. **New
York has no signup form at all** — same honesty as the static site: its rule depends on a fact
(first-registration date) this dataset doesn't have, so no reminder can be computed for it.

## The deployment gap (real, not yet solved — needs a decision)

The static site (`docs/`) can be hosted for free on GitHub Pages. **This backend cannot** — Pages
serves static files only, it can't run `server.py`. Before any real signup can work, the backend
needs to run somewhere reachable from the public internet (options: a small always-on host, a
serverless function behind an API gateway, etc.) — that's a hosting decision with its own cost/
complexity tradeoffs, separate from the free Pages hosting for the static site, and **not made
yet**. `REMINDER_BACKEND_BASE_URL` (in `generate.py`) and `BACKEND_BASE_URL` (in `emails.py`) are
both placeholders (`https://example-deadlineradar-api.test`) — swap both, together, once a real
backend host exists.

## What's needed from the project maintainer (surfacing, not doing myself)

1. **A transactional email-service account + API key.** `sender.py` has a ready `SendGridSender`
   stub (SendGrid picked as the example since it has a workable free tier; Postmark/SES would be
   similar swaps). Until a real `SENDGRID_API_KEY` exists in the environment, `get_sender()` stays
   hardcoded to `DryRunSender` — flipping that is a deliberate one-line code change, not something
   an environment variable can silently trigger.
2. **A real physical mailing address for the email footer.** CAN-SPAM legally requires a valid
   physical postal address in every commercial email — this is not something that can be
   fabricated. The current placeholder (`MAILING_ADDRESS_PLACEHOLDER` in `emails.py`) is
   deliberately impossible to miss so a real send could never accidentally go out without a real
   address in it. A PO box or a commercial mail-receiving agency is the normal solution for a
   project like this.
3. **A hosting decision for the backend** (see "deployment gap" above).
4. Anything that costs money or stands up a public endpoint is gated on explicit approval — none
   of the above happens without that.

## PII security

`subscribers.json` (real email addresses) and `dry_run_sent.log.jsonl` (which contains the same
PII, since dry-run logs exactly what *would* have been sent) are both `.gitignore`d. Only
`subscribers.example.json` — fake data, `@example.invalid` addresses — is tracked. `server.py`
overrides `log_message()` to a no-op so request lines never hit stdout/logs (belt-and-suspenders;
our endpoints only ever put opaque tokens in query strings, never raw email addresses, but this
closes the door on that class of accidental leak regardless).

## Testing

`python -m reminders.test_dry_run_e2e` (run from `b3_saas/deadlineradar/`) — a real end-to-end
test, not mocks: exercises `store.py`'s state machine directly, walks a simulated clock through
every escalation threshold and confirms each fires exactly once, confirms unsubscribe permanently
halts even as later thresholds are crossed, confirms the renewed-vs-unsubscribed re-arm
distinction, confirms New York is correctly unsupported rather than given a fabricated deadline,
confirms California/Texas/Florida's special fields all resolve correctly, and finishes with a real
HTTP smoke test — an actual `HTTPServer` instance, real `urllib` requests, not simulated calls —
against `/health`, `/subscribe`, and `/confirm`, including invalid-input rejection paths. Test
storage/log files are isolated from the real ones and deleted whether the run passes or fails.

**As of this build: 33/33 checks passed on the first run.** No real email was sent — the only
sender exercised anywhere in this test is `DryRunSender`.

## Running the backend locally (dry-run only)

```
cd b3_saas/deadlineradar
python -m reminders.server
```

Serves on `http://127.0.0.1:8791`. Every "sent" email is appended to
`reminders/dry_run_sent.log.jsonl` (gitignored) instead of actually being sent — inspect that file
to see exactly what would have gone out.
