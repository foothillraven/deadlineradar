# DeadlineRadar Worker -- Phase 1 (capture + D1 storage ONLY)

**This is Phase 1. It captures signups into Cloudflare D1 and does nothing
else. Email sending is intentionally, completely absent from this Worker's
code.** There is no SendGrid integration, no outbound email call of any
kind, anywhere in this directory (verified by grepping the shipped `src/`
for `fetch(` and for `sendgrid`/`smtp`/`mailgun`/`postmark` -- the only
`fetch(` calls are the Worker's own `fetch(request, env)` entry point and
the Cloudflare Turnstile siteverify call, which is itself unreachable while
`TURNSTILE_SECRET_KEY` is unset, as it is in this Phase). A real signup is
stored as a `pending_confirmation` D1 row and nothing else happens -- no
confirmation email, no reminder email, no notification of any kind leaves
this Worker.

Phase 2 (a separate, later, **separately-approved** build) is what adds the
confirmation send and the rest of the email lifecycle. Do not add an email
call to this codebase under the assumption that "Phase 2" means "later in
this same session" -- it means a distinct future ticket, gated the same way
this one was (plan-first to the orchestrator, explicit go).

## Status: local / staged only -- NOT deployed

Nothing in this directory has been deployed to any real Cloudflare account.
Specifically, as of this commit:

- `wrangler d1 create deadlineradar` has **not** been run. `wrangler.toml`'s
  `database_id` is the literal placeholder string `REPLACE_AFTER_D1_CREATE`,
  not a real D1 database UUID.
- `wrangler deploy` has **not** been run. The `[[routes]]` entry for
  `deadline-radar.com/api/*` is inert configuration only -- it does not
  register anything with Cloudflare or put anything on the public internet
  until a real deploy happens against a real account.
- No Cloudflare account, zone, or DNS changes have been made on this
  project's behalf.

Per AssetLab's standing guardrails, creating the real D1 database and
running a real deploy are both **plan-first, account-creating /
publish-to-external-platform actions** -- they require an explicit go from
the orchestrator, tracked separately from this scaffolding step.

## What's here

| File | Purpose |
|---|---|
| `wrangler.toml` | Worker config: name `deadlineradar-api`, D1 binding `DB`, inert route entry. No `[triggers]` cron block -- Phase 1 has no scheduler. |
| `package.json` | `typescript`, `wrangler`, `vitest`, `@cloudflare/workers-types`, `@cloudflare/vitest-pool-workers` (local D1-emulated test runner). Note: `@cloudflare/workers-types` is pinned to the latest **v4.x** release (`4.20260702.1`), not the newer v5 line -- `wrangler@4.107.0`'s own peer dependency still expects `^4.20260701.1` as of this writing, and installing v5 produced an `ERESOLVE` conflict. Re-check this pin next time these deps are bumped. |
| `tsconfig.json` | Workers-appropriate strict TS config (`ES2022` target, `ESNext` module, `@cloudflare/workers-types`). |
| `migrations/0001_init_schema.sql` | D1 schema, ported field-for-field from `../reminders/store.py`. |
| `migrations/0002_rate_limit_hits.sql` | `rate_limit_hits(ip, bucket, ts)` -- the D1-backed per-IP rate limiter's storage (see `src/validation.ts`'s `checkRateLimit()`). Not in `0001` because that migration was already committed by the time rate limiting was ported; new migration file rather than editing an already-numbered one, per normal migration discipline. |
| `migrations/0003_email_normalized_index.sql` | Expression index `idx_subscribers_email_normalized ON subscribers (LOWER(TRIM(email)))`, backing `store.ts`'s `isPermanentlySuppressed()`. Added after an adversarial review found that function ran a full-table scan (`SELECT` with no `WHERE`, filtered by normalized email in JS); the query is now filtered in SQL against this index instead. |
| `src/index.ts` | The full Phase-1 fetch handler: routes `POST /subscribe`, `GET /confirm` / `/unsubscribe` / `/renewed` / `/rearm` / `/health`, in the same abuse-hardening check order as `../reminders/server.py`'s `_handle_subscribe()`. |
| `src/store.ts` | D1-backed subscriber storage -- `addPending`/`confirm`/`stop`/`rearm`/`withinSignupCooldown`/`findActiveOrPending`/`isPermanentlySuppressed`/`cooldownKey`/`sanitizeFirstName` (via `validation.ts`), ported field-for-field from `../reminders/store.py`. |
| `src/validation.ts` | Email regex, control-character rejection, honeypot constant, `strictParseInt` (Python `int()`-semantics integer parsing -- deliberately NOT `Number.parseInt`, see its own doc-comment), the D1-backed per-IP rate limiter (`checkRateLimit`, replacing `server.py`'s in-memory dict since Workers instances share no process memory), and the Cloudflare Turnstile hook (`verifyTurnstile`, inert while `TURNSTILE_SECRET_KEY` is unset). |
| `src/deadline.ts` | Date math ported from `../generate.py` (`next_birth_month_parity_date`, `next_annual_month_end`) and the deadline-computability probe ported from `../reminders/scheduler.py`'s `compute_subscriber_deadline()`, narrowed to Phase 1's one use: a "can we compute a deadline at all" check run BEFORE persisting a signup. |
| `src/cpa_deadlines.json` | Bundled copy of `../data/cpa_deadlines.json`, imported directly (not fetched at runtime) so `deadline.ts` never needs network/filesystem access to compute a probe. |
| `src/env.ts` | The `Env` binding-shape type (`DB: D1Database`, optional `TURNSTILE_SECRET_KEY`). |
| `test/worker.spec.ts` | `@cloudflare/vitest-pool-workers` integration tests against a real Miniflare-emulated D1 instance (migrations applied for real, not a hand-rolled schema) -- signup happy path, validation, honeypot (incl. whitespace-only), cooldown/dedupe (incl. Gmail dot/+tag folding), the full confirm/unsubscribe/renewed/rearm lifecycle (incl. the double-opt-in-bypass regression test), permanent-suppression, rate limiting, and pure-function unit tests. |

## Status: WORKING and green, still NOT deployed

`npm run typecheck` and `npm test` both pass clean (35/35 tests) as of this
commit. "Working" here means: builds, typechecks, and passes its own test
suite against a real D1 schema under Miniflare -- it does NOT mean deployed,
see the deployment-gap section below, which is still fully true.

## Schema provenance

`migrations/0001_init_schema.sql` is a direct port of the subscriber record
shape defined in `../reminders/store.py` (the Python reference implementation
-- read in full before writing this schema, and **not modified** by this
work: it remains the test oracle for Phase 1's D1 logic).

- `subscribers` -- one row per subscriber record. Every field `store.py`'s
  `add_pending()` / `confirm()` / `stop()` / `rearm()` /
  `mark_reminder_sent()` touch is present: `id`, `email`, `state_slug`,
  `deadline_fields` (JSON text), `first_name`, `status`,
  `confirm_token` / `unsubscribe_token` / `renewed_token` (each `UNIQUE`),
  `created_at`, `confirmed_at`, `stopped_at`, `stop_reason`,
  `reminders_sent` (JSON text), `cycle`. Plus a computed `cooldown_key`
  column (see below) not present as a stored field in `store.py` but
  required to port its cooldown/dedupe logic into SQL efficiently.
- `cooldown_key` -- **not** a raw copy of `store.py`'s in-memory
  `_cooldown_key()` result cached lazily; it must be **computed at insert
  time** by whatever Worker code writes a row, using the exact same
  algorithm: lowercase + strip the address, then fold Gmail-style
  `+tag` sub-addressing and dot-insensitivity in the local part
  (`victim.name+promo@gmail.com` -> `victimname@gmail.com`). This is what
  lets `within_signup_cooldown()` / `find_active_or_pending()` port to an
  indexed `WHERE cooldown_key = ?` instead of a full-table Python-side scan.
  Get the port of this function byte-for-byte equivalent to `store.py`'s
  before trusting it -- a divergence here silently reopens the abuse-
  hardening audit's original finding (see `store.py`'s own docstring).
- `circuit_breaker` -- `(day TEXT PRIMARY KEY, count INTEGER)`, ported from
  `sender.py`'s `CIRCUIT_BREAKER_STATE_PATH` JSON file (a `{<today>: <count>}`
  dict, reset to hold only the current day's key on every write). Created
  now for schema parity; stays at zero rows through all of Phase 1 since
  nothing here sends anything yet.
- Indexes on `cooldown_key`, `email`, and `status` -- the three columns
  `store.py`'s lookup functions (`within_signup_cooldown`,
  `find_active_or_pending`, `all_confirmed_active`, `is_permanently_suppressed`)
  filter or scan by. Plus a fourth, `idx_subscribers_email_normalized`
  (migration 0003) on the expression `LOWER(TRIM(email))`, added after
  adversarial review found `is_permanently_suppressed()`'s TS port was doing
  a full-table scan rather than using the plain `email` index (case folding
  meant it couldn't use a plain-column index) -- see `store.ts`'s
  `isPermanentlySuppressed()` doc-comment.

## What's deliberately NOT here yet

- No scheduler / cron (`../reminders/scheduler.py`'s `run_once()` and its
  escalation-threshold (60/30/14/7/3/1-day) reminder logic are not ported --
  `deadline.ts` ports the underlying date math and the computability probe
  scheduler.py also depends on, so Phase 2's port is a drop-in, not new
  logic, but nothing schedules or sends a reminder in Phase 1).
- No "mailing address configured" / CAN-SPAM gate (`server.py:395`,
  `emails.mailing_address_configured()`) -- there is nothing to gate since
  Phase 1 never builds or sends an email.
- No email sending of any kind, from any provider, under any code path --
  see the Phase 1 disclaimer at the top of this file.
- `store.markReminderSent()` / `store.allConfirmedActive()` are ported (for
  Phase 2 drop-in readiness, matching `store.py`'s full function list) but
  are not called from any Phase-1 route.

## Toolchain check (this session)

`node --version` / `npm --version` and `npm view` against the real npm
registry all succeeded in this environment (see the delegating agent's
summary for exact output) -- network access to npm was available. `npm
install` was attempted; see that summary for whether it completed cleanly.
No `wrangler dev`, `wrangler deploy`, or `wrangler d1` command has been run.
