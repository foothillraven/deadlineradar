# DeadlineRadar reminders — the "remind me" feature

**Status: built, dry-run tested end-to-end, abuse-hardened (2026-07-03 audit), NOT
deployed. Zero real emails have ever been sent — `DryRunSender` (now wrapped in a send
circuit breaker) is the only sender wired up anywhere in this codebase.**

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

## Abuse-hardening (2026-07-03 audit)

The product promise is zero spam — which cuts both ways. Before this ever touches a real
inbox, it has to be safe against a STRANGER using the signup form to spam a THIRD
PARTY (enrolling someone else's address, bombing an inbox, flooding the system with
bots). Audited against 7 rows; each is enforced in code and has a real attack-simulation
test in `test_dry_run_e2e.py` (Parts 11–17) that tries to actually break it, not just a
happy-path check:

1. **Double opt-in.** Already the core design (see above) — a signup can never trigger
   more than the one confirmation email until that link is clicked. PASS, pre-existing.
2. **Dedupe + cooldown — ADDED.** `store.within_signup_cooldown()` blocks a second
   confirmation to the same normalized email within 24h regardless of state (closes the
   gap this doc used to list as a known limitation); `store.find_active_or_pending()`
   refuses to create a second pending/confirmed record for the same email+state even
   after the cooldown expires. Both fail toward the IDENTICAL success response a real
   signup gets, so neither creates an email-enumeration oracle. Attack test: 100 rapid
   submissions of the same address → exactly 1 real signup, 1 email.
3. **Bot defense — ADDED.** A hidden honeypot field (`hp_website`, rendered off-screen
   in every form by `generate.py`) — any non-empty value silently no-ops the submission
   behind the same fake-success response. A per-IP sliding-window rate limiter
   (`server.py`, 5 signups / 10 min, 30 action-link clicks / 10 min) throttles scripted
   hammering. A Cloudflare Turnstile hook (`_verify_turnstile()`) is wired but inert
   until `TURNSTILE_SECRET_KEY` is configured — see `HOSTING_PROPOSAL.md`. Attack tests:
   a honeypot-filled submission creates zero records/emails; hammering `/subscribe`
   with 10 distinct emails from one IP gets exactly 5 through and 5 blocked with 429.
4. **Send circuit breaker — ADDED.** `sender.CircuitBreakerSender` wraps every sender
   (including `DryRunSender` — the breaker is exercised by every existing test and
   dry-run, not bolted on only at real-send time) with a hard daily cap
   (`REMINDERS_DAILY_SEND_CAP`, default 500/UTC-day). Once hit, every further send is
   refused and an alert is appended to `circuit_breaker_alerts.log.jsonl` — this
   protects the free-tier quota and, more importantly, sender reputation (a burst of
   bogus sends is exactly what gets a domain flagged as a spammer). Attack test: a
   3-send cap under load → exactly 3 sends succeed, 2 refused, alert written.
5. **Permanent suppression — hardened.** Tokens were already unguessable
   (`secrets.token_urlsafe(32)`); `store.is_permanently_suppressed()` is a NEW,
   independent check (keyed on `stop_reason`, deliberately NOT on `status`) enforced a
   second time at the scheduler's actual send call site, so a hypothetical future bug
   that corrupts the `status` field back to `confirmed` still cannot resurrect a real
   unsubscribe. This was caught refining itself: an earlier version of this check also
   required `status == stopped`, which defeated its own "independent of status" claim —
   the attack test (Part 15, corrupt `status` directly, bypassing `rearm()`) failed
   against that version and is what caught it.
6. **Input validation / sanitization — hardened.** Stricter email regex (rejects
   whitespace/control chars/malformed domains, not just "has an @ and a dot"); every
   submitted field is swept for control characters (closes the door on
   header-injection/stored-XSS-style payloads) before anything is processed; the POST
   body is capped at 8KB before it's even read (a client-controlled `Content-Length`
   could otherwise force unbounded memory use); state-specific numeric fields
   (birth month/year) are parsed inside `try/except ValueError` instead of letting a
   malformed value raise uncaught. **A real bug this audit found and fixed:**
   `_handle_subscribe()` used to call `store.add_pending()` BEFORE validating that a
   deadline was actually computable, so a malformed-but-form-valid submission (or the
   int-parsing crash above) could leave an orphaned, never-confirmable pending record
   behind — now deadline-computability is checked on a throwaway probe first, and
   nothing is persisted unless it already succeeds. **A second real bug found and
   fixed:** `check_data_freshness()` deliberately raises `SystemExit` to hard-stop the
   offline scheduler on stale data — correct there, but `SystemExit` isn't an
   `Exception` subclass, so letting it propagate from a live HTTP request would have
   killed this single-threaded server's entire process on the next signup attempt if
   the data ever went stale. Now caught explicitly and degrades to a 503, not a process
   exit. Attack test: a CRLF-injection payload and a SQL-injection-shaped non-numeric
   field both get a clean 400, the server still answers `/health` afterward, and neither
   attempt leaves a subscriber record behind.
7. **PII locality — re-verified technically.** `.gitignore` coverage re-checked by
   reading the actual file content (not just policy) for every generated-state file,
   including the two new ones this audit added
   (`send_circuit_breaker_state.json`, `circuit_breaker_alerts.log.jsonl`). Re-confirmed
   the minimal-collection claim with a real assertion: California's signup form still
   asks for a full birth year (to compute odd/even parity server-side, which is easier
   for a human to answer correctly than self-reporting parity), but the actual year is
   discarded immediately after computing parity and NEVER appears in the persisted
   record — only `birth_year_parity` does.

**Hosting note:** GitHub Pages (where `docs/` is hosted) is static-only and cannot run
this backend. `HOSTING_PROPOSAL.md` proposes Cloudflare Workers + D1 as the natural next
step (the project is already on Cloudflare) — a proposal only, not deployed, not
decided. Standing up any public endpoint is a plan-first item per CLAUDE.md.

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

**73/73 checks pass**, including 3 regression tests (Parts 8-10) added after an earlier
adversarial review found and this build fixed 3 real correctness bugs the *original*
33-check suite didn't catch (because it only ever advanced the clock to exact threshold
boundaries), and 7 more attack-simulation test groups (Parts 11-17) added by the
2026-07-03 abuse-hardening audit — see "Abuse-hardening" above for what each attacks:

1. **Reminder emails showed the wrong "days from now"** whenever a subscriber's first evaluation
   didn't land exactly on a threshold (e.g. confirmed 40 days out, crossing the 60-day tier,
   previously said "60 days from now" instead of the true 40). Fixed by separating the threshold
   (picks the tone) from the actual computed days-remaining (what's displayed) — see
   `emails.reminder_email()`.
2. **A scheduler gap could send a less-urgent reminder AFTER a more-urgent one already fired**
   (e.g. "3 days left" arriving after "tomorrow is the deadline" already went out, because a
   missed run left the 3-day tier technically un-sent). Fixed in `scheduler.next_due_threshold()`
   — once the most urgent tier a subscriber has received fires, no less-urgent tier can ever fire
   after it.
3. **A subscriber whose first-ever evaluation happened after their deadline already passed got
   silently zero reminders, forever.** Fixed with a bounded catch-up window (14 days past
   deadline): a never-notified subscriber inside that window gets one final 1-day-tier reminder
   instead of silence; beyond it, correctly abandoned as a stale signup.

Also fixed as part of the same review: **the stop-confirmation email (sent after unsubscribe or
"I've renewed") carried a dead, empty unsubscribe link** — every other email template built a real
one from the subscriber's token, these two passed an empty string. Fixed in `server.py`.

No real email was sent at any point in testing — the only sender exercised anywhere in this suite
is `DryRunSender`.

## Known limitations (found by adversarial review, not fixed this pass — documented, not hidden)

- **Unsubscribe/renewed/rearm links stop working after a re-arm.** `store.rearm()` issues fresh
  tokens for the new cycle, so a link embedded in an *already-sent* email from the prior cycle
  (e.g. the original confirmation email) 404s after a re-arm. Not a security issue (fails closed,
  not open), but it means an old email's unsubscribe link isn't permanently reliable the way the
  product promise implies. Fix path: keep prior-cycle tokens valid as aliases rather than fully
  replacing them.
- **`/confirm`, `/unsubscribe`, `/renewed`, `/rearm` are plain `GET`s with side effects.** This is
  an extremely common pattern (CAN-SPAM's one-click bar pushes most implementations this way), but
  it means a corporate email-security link-prefetcher could in principle trigger one of these
  before a human ever opens the email. Fix path: make the `GET` show a confirmation page with a
  button that `POST`s the actual action.
- ~~No de-duplication on repeat signup.~~ **Fixed in the 2026-07-03 abuse-hardening audit** —
  see "Abuse-hardening" row 2 above (`store.within_signup_cooldown()` / `find_active_or_pending()`).
- **No file locking on `subscribers.json`.** Every read-modify-write is a full file overwrite with
  no locking. Two overlapping requests (e.g. the scheduler running while a `/subscribe` request is
  in flight) could race. Low likelihood for a single-operator local/staged setup; worth revisiting
  before any real-scale deployment — moot if/when the Cloudflare D1 hosting proposal is adopted,
  since D1 handles concurrent writes itself.
- **The in-memory per-IP rate limiter is single-process and resets on restart.** Fine for this
  local reference implementation; a real deployment needs a shared store (see
  `HOSTING_PROPOSAL.md` — Cloudflare's Rate Limiting rules / Durable Objects, not an in-process dict).
- **The 24h signup cooldown blocks a legitimate "I never got the email, let me try again" retry
  for the same window it blocks an attacker.** Deliberate tradeoff — a dedicated "resend
  confirmation" flow (which would need its own abuse-hardening, e.g. only resending to the
  original address, never creating a new record) is a reasonable future addition, not built here.

## Running the backend locally (dry-run only)

```
cd b3_saas/deadlineradar
python -m reminders.server
```

Serves on `http://127.0.0.1:8791`. Every "sent" email is appended to
`reminders/dry_run_sent.log.jsonl` (gitignored) instead of actually being sent — inspect that file
to see exactly what would have gone out.
