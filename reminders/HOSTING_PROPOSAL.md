# Reminder backend hosting — proposal (NOT deployed)

**Status: a proposal to resolve the deployment gap in `README.md`. Nothing in this
document has been stood up, deployed, or purchased. Standing up any public endpoint is
a plan-first item per CLAUDE.md guardrail 6 (publish-to-external-platform) — this file
exists to give the project maintainer a concrete architecture to say go/no-go on, not to
pre-empt that decision.**

## The gap

`docs/` (the static site) is free to host on GitHub Pages — Pages serves static files
only. `reminders/server.py` is a real HTTP server with side effects (it writes
`subscribers.json`, sends email, runs scheduled logic) — Pages cannot run it. Something
else has to host the backend before a single real signup can work.

## Recommendation: Cloudflare Workers

The project is already on Cloudflare (Pages + presumably DNS for any custom domain), so
Workers is the natural fit — no new vendor relationship, and its free tier comfortably
covers this project's scale.

| Piece | Today (local reference impl) | Proposed (Cloudflare) |
|---|---|---|
| HTTP endpoints | `http.server.HTTPServer` + `Handler` in `server.py` | A Worker `fetch` handler — same route dispatch (`/subscribe`, `/confirm`, `/unsubscribe`, `/renewed`, `/rearm`, `/health`), same validation logic, ported from Python to JS/TS (or left in Python via Cloudflare's Python Workers beta) |
| Subscriber storage | One flat `subscribers.json`, full read-modify-write per operation (`store.py`) | **D1** (Cloudflare's serverless SQLite), one `subscribers` table. D1 gets us indexed lookups for the abuse-hardening checks this audit just added — `within_signup_cooldown` / `find_active_or_pending` / `is_permanently_suppressed` become a `WHERE email = ?` query instead of scanning every record in memory. KV was considered and rejected: KV has no query capability beyond exact-key lookup, so cooldown/dedupe-by-email (not by a single primary key) would still mean loading everything, same scaling ceiling as today's JSON file. |
| Per-IP rate limiting | In-memory dict in `server.py`, per-process, resets on restart, doesn't survive multiple instances | Cloudflare's built-in **Rate Limiting rules** (available on the free tier for basic cases) in front of the Worker, PLUS the same logical check re-implemented against a Durable Object or D1 for the precise sliding window this audit's tests assert on — Workers are stateless/ephemeral per-request, so the in-memory dict this local reference implementation uses does NOT carry over as-is. |
| Bot defense | Honeypot field (portable as-is) + inert Turnstile hook | Same honeypot, PLUS a real Cloudflare **Turnstile** widget (free, invisible-mode-capable) on the form and `_verify_turnstile()`'s siteverify call turned on for real once `TURNSTILE_SECRET_KEY` is configured — this audit already built that hook so this is a config flip, not new code. |
| Send circuit breaker | Local JSON file counter (`sender.py`'s `CircuitBreakerSender`) | Same logic, counter row lives in D1 instead of a JSON file (Workers have no local filesystem) |
| Scheduler (`scheduler.py`'s `run_once()`) | A manually-invoked local script | Workers **Cron Triggers** (free tier includes these) — a `scheduled()` handler fires hourly, runs the same escalation logic against D1 |
| Email send | `DryRunSender` / `SendGridSender` (stdlib `urllib`, direct HTTPS POST) | Same HTTPS POST, called via Workers' `fetch()` instead of `urllib` — the request/response shape is identical, so `SendGridSender`'s logic ports almost line-for-line |
| Custom domain | N/A locally | A Worker can be bound to the same custom domain as the Pages site via a Workers **Route** (e.g. `deadline-radar.com/api/*` → the Worker, everything else → Pages) — no second domain needed |

## Why this preserves the architecture, not just the hosting

`store.py`, `sender.py`, and `scheduler.py`/`emails.py` are already split along exactly
the seams a Workers port needs: storage is one small function API
(`add_pending`/`confirm`/`stop`/`rearm`/the abuse-hardening lookups), sending is one
`EmailSender` interface, and the date math / email copy have zero I/O dependencies at
all. A Cloudflare port is "swap the storage backend and the HTTP entrypoint," not
"rewrite the business logic" — the same reasoning `README.md` already gives for why
`scheduler.py` reuses `generate.py`'s date functions instead of re-deriving them.

## Cost (stays inside the "no capital" charter constraint)

Workers free tier: 100k requests/day. D1 free tier: 5GB storage, 5M rows read/day. Cron
Triggers: included free. At DeadlineRadar's realistic early scale (dozens to low
hundreds of subscribers), none of these limits are close to being touched — this stays
a $0/month backend, same posture as free-tier Pages for the static site.

## What this proposal does NOT do

- Does not create a Cloudflare account, Worker, D1 database, or DNS/Route binding.
- Does not enable Turnstile (the secret key gate stays unset).
- Does not touch the existing `origin` remote or push anything.
- Does not resolve the separate, already-flagged, unanswered questions about the
  `foothillraven` GitHub identity or the `deadline-radar.com` custom domain that already
  appears configured in this repo's git history (see this session's outbox report) —
  those are prerequisite decisions, not something this hosting proposal resolves.

**Standing any of this up is a plan-first item.** This document is meant to make that
future plan-first concrete and fast to approve/reject, not to start building it now.
