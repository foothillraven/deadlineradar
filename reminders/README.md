# DeadlineRadar reminders — the "remind me" feature

**Status: built, dry-run tested end-to-end, abuse-hardened (2026-07-03 audit), template
v2 shipped (2026-07-03 email overhaul), NOT deployed. Zero real emails have ever been sent
to anyone other than one project-maintainer-controlled address in a hard-whitelisted,
gated live self-test — `DryRunSender` (wrapped in a send circuit breaker) remains the
only sender wired up in `get_sender()` anywhere in this codebase.**

## Email template v2 (2026-07-03)

The v1 live self-test landed in the inbox (SPF/DKIM passed) but looked unpolished: raw
tracking URLs rendered as giant blue walls of text, a dev TODO placeholder leaked into
the live footer, and the copy was templated/redundant. Fixed in `emails.py`:

- **Branded HTML + plain-text multipart.** Every email now returns a real `html_body`
  (previously always `None`) alongside `text_body`. The HTML template reuses the static
  site's own CSS custom-property values (`generate.py`'s `PAGE_CSS`), dark-mode-aware via
  `@media (prefers-color-scheme: dark)`, and mobile-responsive.
- **Buttons instead of raw URLs.** Action links ("Confirm my email," "Stop these
  reminders," "Remind me next time") render as styled anchor buttons in the HTML view; a
  small "Unsubscribe" text link sits in the footer. **SendGrid click AND open tracking
  are now explicitly disabled** (`sender.py`'s `SendGridSender`) — these are transactional
  emails, not marketing, and click-tracking's URL-rewrite was exactly what mangled the
  displayed hrefs in v1.
- **The leaked dev placeholder is gone.** `emails.py` no longer contains any
  `MAILING_ADDRESS_PLACEHOLDER` string that could reach an email. Every email-building
  function now calls `_mailing_address()` first, which **raises `RuntimeError`** unless a
  real address is configured via the `REMINDERS_MAILING_ADDRESS` env var. The **only**
  way to get a non-real value through is `set_test_mailing_address_override()`, which is
  itself technically restricted (not just documented) to being called from
  `run_live_selftest.py` or `test_dry_run_e2e.py` — any other caller gets refused with a
  `RuntimeError`. `server.py`'s `/subscribe` handler checks `mailing_address_configured()`
  *before* creating a pending record (so a misconfigured deploy can't orphan records), and
  `scheduler.py`'s `run_once()` hard-stops the whole batch at the top if unconfigured.
- **Optional first-name greeting.** The signup form (both `generate.py` variants) gained
  an optional `first_name` field. Emails greet "Hi {FirstName}," when set, "Hi there,"
  when blank. Treated as untrusted input throughout: `store.py`'s
  `_sanitize_first_name()` and `emails.py`'s `_safe_first_name()` both independently
  strip, drop non-printable characters (closes a zero-width/RTLO smuggling path), and cap
  length at `MAX_FIRST_NAME_LEN` (60); `emails.py` HTML-escapes it for the HTML body and
  never escapes it for the plain-text body (there's no markup to inject into there).
- **Copy polish.** Em-dashes, not `--`; each escalation tier (60/30/14/7/3/1) has a
  distinct, non-redundant lead phrase that never restates the exact day count (that's
  `when_phrase`'s job, computed once from the real value — kept deliberately separate
  from the tier's tone, same reasoning as the original day-count correctness fix below).

An independent adversarial pass (a fresh agent, no access to this codebase's own tests,
attacking the real running code) found and this build fixed two real gaps: (1) an
`REMINDERS_MAILING_ADDRESS` env var containing ONLY zero-width/format characters (or a
single ordinary character) passed the original bare `.strip()` truthiness check —
`_mailing_address()` now requires the cleaned string to be at least
`MIN_MAILING_ADDRESS_LEN` (10) characters after stripping whitespace and non-printable
characters; (2) `scheduler.run_once()`'s per-subscriber loop didn't catch a `RuntimeError`
from `emails.reminder_email()`, so one subscriber hitting the mailing-address hard-fail
mid-batch would abort evaluation of every remaining subscriber that run — now caught and
recorded as a per-subscriber error, consistent with the loop's existing "one bad record
must not kill the whole run" design. Both have dedicated regression tests (Parts 28-29).
The pass also confirmed HELD: first-name HTML/script injection (21+ payloads, real
rendering + real HTTP requests), and HTML-template structural robustness (no payload ever
produced anything but one well-formed document).

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
bots). Audited against 7 rows, each enforced in code with its own attack-simulation test
in `test_dry_run_e2e.py`. **This ran in two passes, and the second one mattered as much
as the first:**

**Pass 1** built the defenses below and wrote same-file tests (Parts 11–17) asserting
they held. **Pass 2** was an INDEPENDENT adversarial workflow — seven separate agents,
each handed only the row it was attacking and told to write its own fresh attack script
(not read or trust the pass-1 tests) and try to actually break the live server/store.
**It broke 5 of the 7 rows.** Every finding below was real, reproduced with a concrete
request/input, and is now fixed with its own regression test (Parts 18–22) targeting the
exact bypass found — this is the same "don't trust your own done" pattern that already
paid off three times earlier this sprint (see HANDOFF.md), now run on this feature a
second time on the same day.

1. **Double opt-in.** Design: a signup can never trigger more than the one confirmation
   email until that link is clicked. **Pass 2 broke this**: `store.stop()` and
   `store.rearm()` never checked whether a subscriber had ever actually been confirmed —
   a still-*pending* record's OWN signup-time tokens (issued before `/confirm` is ever
   clicked) could reach `/renewed` then `/rearm` and flip all the way to
   `status=confirmed`, after which the real scheduler sent it a live reminder — a full
   double-opt-in bypass with no `/confirm` click anywhere in the chain. Separately,
   `/unsubscribe` on a still-pending record triggered a SECOND email, violating "an
   unconfirmed signup gets exactly one email, ever." **Fixed:** `stop()` now refuses
   `reason="renewed"` unless `confirmed_at is not None` (the renewed-link is never even
   included in the confirmation email, only in reminder emails that pending records never
   receive, so reaching it on a pending record is never legitimate); `rearm()`
   independently re-checks the same `confirmed_at` requirement as belt-and-suspenders;
   `/unsubscribe` still honors a pending record's own token (the confirmation email's
   footer legitimately contains it) but no longer sends a second email if it was never
   confirmed.
2. **Dedupe + cooldown.** Design: `store.within_signup_cooldown()` / `find_active_or_pending()`
   block repeat submissions of the same address, keyed on a normalized (stripped,
   lowercased) email. **Pass 2 broke this**: Gmail-style dot-insensitivity and `+tag`
   sub-addressing (`victim.name@gmail.com` / `victim.name+a@gmail.com` /
   `vic.tim.name@gmail.com`, all delivered to the same real inbox by Gmail) were treated
   as distinct addresses, letting an attacker generate multiple confirmation-email sends
   to one real inbox inside the cooldown window. **Fixed:** cooldown/dedupe now key on a
   separate `_cooldown_key()` that additionally folds `+tag` suffixes and dots in the
   local part — deliberately more aggressive than the exact address used for actual
   delivery/storage/suppression, since over-folding here just shares a cooldown window
   between two unrelated people (self-correcting), while under-folding is what let a
   stranger spam a real inbox.
3. **Bot defense.** Design: a hidden honeypot field + per-IP rate limiter. Rate limiting
   held up completely under attack (no IP-spoofing-header bypass, no cross-bucket
   leakage). **Pass 2 broke the honeypot**: the check used `.strip()`-truthiness, so a
   whitespace-only fill (a single space) slipped through as "empty." **Fixed:** checks
   the raw field value's emptiness directly (`is not None and != ""`), not its stripped
   form.
4. **Send circuit breaker.** Design: a hard daily cap enforced by
   `sender.CircuitBreakerSender`. **Pass 2 broke this under concurrency**: the
   load-check-increment-save sequence had no lock and no atomic write; a 40-thread burst
   against a cap of 5 let through up to 14 real sends (not 5), and a write landing
   mid-read from another thread could crash the reader with `JSONDecodeError`. **Fixed:**
   a module-level `threading.Lock` (not instance-level — `get_sender()` can hand back a
   fresh instance per call, so only a process-wide lock actually serializes every
   send) now guards the whole critical section, and state-file writes are atomic
   (temp file + `os.replace`). Regression test drives 40 real threads at a cap of 5 and
   asserts the real send count never exceeds it.
5. **Permanent suppression.** Design: `store.is_permanently_suppressed()`, keyed on
   `stop_reason` rather than `status` so a hypothetical status-corruption bug can't
   resurrect a real unsubscribe. **Pass 2 broke this in the OVER-blocking direction**:
   the check suppressed EVERY future signup for an email that had EVER unsubscribed —
   even a wholly separate, genuinely re-confirmed record for a different state — which
   is a real product-breaking bug (a customer who unsubscribes once could never
   resubscribe with that address, for anything, ever), and directly contradicts "never
   re-emailed unless THEY re-initiate." **Fixed:** suppression now lifts if ANY record for
   the email has a `confirmed_at` later than the most recent unsubscribe's `stopped_at` —
   a genuine later `/confirm` click IS the person re-initiating consent. Verified this
   didn't weaken the original defense-in-depth guarantee: a status-corrupted record with
   no new confirm timestamp still stays suppressed (same test as before, still passing).
6. **Input validation / sanitization.** Stricter email regex, control-character sweep,
   8KB body cap, numeric fields parsed inside `try/except`, deadline-computability
   checked on a throwaway probe before any record is persisted (fixes an orphaned-record
   bug pass 1 itself found), `check_data_freshness()`'s `SystemExit` now caught explicitly
   so stale data degrades to a 503 instead of killing the whole process. **Pass 2 could
   not break this row** — a genuinely thorough, independent attempt (oversized fields,
   NUL bytes, multi-address emails, RTLO/zero-width unicode, 300+ char emails, huge-int
   and out-of-range birth months, missing/non-numeric/lying `Content-Length`) came back
   clean. The one PASS among the five FAILs.
7. **PII locality.** Runtime behavior was clean in both passes (no PII in stdout/HTTP
   responses, nothing ever historically committed). **Pass 2 found a real gap in
   `.gitignore` itself**: it enumerated exact filenames plus a `_test_*` prefix, which
   missed any OTHER scratch-file naming convention — reproduced live, not hypothetically,
   by a sibling attack agent's own leftover `_attack_row6_script.py` sitting untracked in
   the working tree during the same session. **Fixed:** replaced the enumerated list with
   a content-shape denylist (`reminders/*.json` / `*.jsonl`, with `subscribers.example.json`
   explicitly re-included) plus a general `reminders/_*` scratch-file rule (with
   `__init__.py` explicitly re-included so the real source file isn't dropped) — this
   catches `_test_*`, `_attack_*`, and any future prefix automatically.

**73/73 checks passed after pass 1. 96/96 pass after pass 2's fixes** (23 more checks:
17 attack-simulation groups from pass 1, plus 5 new regression-test groups — Parts
18–22 — targeting the exact bypasses pass 2 found, one per broken row).

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
   fabricated. `emails.py` no longer has a placeholder string at all: every email-building function
   calls `_mailing_address()`, which raises `RuntimeError` unless a real address is set via the
   `REMINDERS_MAILING_ADDRESS` environment variable, so a real send cannot go out with a fake or
   missing address (see "Email template v2" above). A PO box or a commercial mail-receiving agency
   is the normal solution for a project like this.
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

**150/150 checks pass** (up from 96/96 before the email template v2 pass), including 3
regression tests (Parts 8-10) added after an earlier adversarial review found and this
build fixed 3 real correctness bugs the *original* 33-check suite didn't catch (because
it only ever advanced the clock to exact threshold boundaries), 7 attack-simulation test
groups (Parts 11-17) from the 2026-07-03 abuse-hardening audit's first pass, 5 more
regression-test groups (Parts 18-22) added after an independent adversarial workflow broke
5 of those 7 rows on a second, separate pass, and 7 new test groups (Parts 23-29) added for
the email template v2 pass — mailing-address hard-fail + override behavior, first-name
greeting/sanitization/injection-resistance, HTML branding/buttons/dark-mode, the
first-name + mailing-address server integration over real HTTP, SendGrid tracking
disablement, and 2 regression tests for the exact gaps a fresh independent adversarial
pass found in the v2 build (see "Email template v2" above) — see "Abuse-hardening" above
for the full story of what each earlier attack targets:

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
