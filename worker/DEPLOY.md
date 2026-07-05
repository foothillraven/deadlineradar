# Phase 1 deploy — exact token, commands, rollback

**Status: NOT deployed. Nothing below has been run against a real Cloudflare account.**
This document exists so the orchestrator/project maintainer can review the exact scope of what a real
deploy would touch, and so the deploy itself is a fast, mechanical copy-paste once the go
+ a token arrive — not something worked out live against production.

## 1. Exact Cloudflare API token permissions needed

Create a **scoped** token (Cloudflare dashboard → My Profile → API Tokens → Create Token
→ Custom token), not the Global API Key. Minimum permission set for everything Phase 1
needs:

| Resource | Permission | Scope |
|---|---|---|
| Account | Workers Scripts — Edit | This account only |
| Account | D1 — Edit | This account only |
| Zone | Workers Routes — Edit | **Only** the `deadline-radar.com` zone |
| Zone | Zone — Read | **Only** the `deadline-radar.com` zone (wrangler needs this to resolve the zone ID for the Route binding) |

Do **not** grant: DNS edit, Zone Settings edit, Account Settings edit, Pages edit, or
"All zones" scope. The existing GitHub Pages site and DNS for `deadline-radar.com` are
untouched by anything in this build — this token should not be able to touch them either.

Set the token as an environment variable, never pasted into any file in this repo:

```
export CLOUDFLARE_API_TOKEN="<the token>"
```

(PowerShell: `$env:CLOUDFLARE_API_TOKEN = "<the token>"` — session-scoped, not persisted.)

## 2. Exact deploy command sequence, in order

Run from `worker/`. Every command up through step 4 is reversible / additive; step 5 is
the one that makes the Worker reachable at a real Route.

```sh
# 0. Confirm the token actually authenticates before doing anything else.
npx wrangler whoami

# 1. Create the real D1 database. Cloudflare returns a real database_id in the output --
#    copy it into wrangler.toml's database_id field, replacing "REPLACE_AFTER_D1_CREATE".
#    This is the ONLY manual edit required between commands.
npx wrangler d1 create deadlineradar

# 2. Apply the schema to the REAL (remote) database -- not --local this time.
#    Run both migrations in order (0001 then 0002); `migrations apply` applies whichever
#    haven't been applied yet, in filename order, so a single invocation covers both.
npx wrangler d1 migrations apply deadlineradar --remote

# 3. Dry-run the deploy first -- validates the Worker bundles and the config resolves
#    (including the D1 binding and the Route's zone) WITHOUT actually publishing anything.
npx wrangler deploy --dry-run

# 4. Real deploy. This publishes the Worker AND activates the wrangler.toml [[routes]]
#    entry (deadline-radar.com/api/* -> this Worker) in the same step -- from this command
#    onward, the Worker is reachable at https://deadline-radar.com/api/* to anyone who
#    knows or guesses a URL, even though the live site's own form still points elsewhere
#    (see item 4 below, "staged, not pushed").
npx wrangler deploy

# 5. Turnstile stays OFF in Phase 1 -- do not run `wrangler secret put TURNSTILE_SECRET_KEY`
#    yet. (Listed here only so it's not accidentally run out of order; it is NOT part of
#    this deploy sequence.)

# 6. Smoke-test against the real deployment (see ACCEPTANCE.md for the full acceptance
#    checklist -- this is just the fastest possible first check):
curl -s https://deadline-radar.com/api/health
#   Expect: {"status":"ok"}
```

Nothing above touches `SENDGRID_API_KEY`, `REMINDERS_MAILING_ADDRESS`, or
`TURNSTILE_SECRET_KEY` — none of those secrets are set in Phase 1, and this Worker's code
has no path that would use the first two even if they were set (see `PHASE1_NOTES.md`).

## 3. Rollback (each independent — pick whichever matches what needs undoing)

| To undo | Command | Effect |
|---|---|---|
| The live deploy, instantly | `npx wrangler rollback` | Reverts the Worker to its previous deployed version. If this is the FIRST deploy, use the Route removal below instead -- there is no "previous version" to roll back to. |
| Public reachability, instantly | Remove the `[[routes]]` block from `wrangler.toml` and re-run `npx wrangler deploy` | The Worker stops being reachable at `deadline-radar.com/api/*` immediately. Zero data loss -- D1 is untouched. This is the fastest "make it stop being public" lever. |
| The Worker entirely | `npx wrangler delete` | Deletes the Worker script itself. D1 data is NOT deleted by this (D1 databases are separate resources) -- run the next row too if the data should also go. |
| The D1 database and all captured signups | `npx wrangler d1 delete deadlineradar` | Irreversible. Only do this if the captured data itself needs to go, not just the Worker. |
| Just today's captured data, keeping the schema | D1 has Time Travel: `npx wrangler d1 time-travel restore deadlineradar --timestamp=<ISO-8601>` | Restores to a point-in-time snapshot (30-day window on the free tier). |

**Recommended incident response order** if something goes wrong post-deploy: (1) Route
removal first (kills public reachability in seconds, no data loss), (2) `wrangler rollback`
if a bad code version is the issue, (3) D1 Time Travel only if bad data was written and
needs undoing, (4) full delete only as a last resort.

## 4. The staged (not pushed) site form-action change

Separate from the Worker deploy above. `../generate.py`'s `REMINDER_BACKEND_BASE_URL`
constant currently is `""` (same-origin) with the form action pointing at `/api/subscribe`
— this repo's local commit already has that change staged (see the repo's own git log), but
it has **not been pushed**, and per the orchestrator directive it should not be pushed until
AFTER the Worker is deployed and verified responding (step 6 above). Pushing this before the
Worker is live would point the real, public signup form at a 404/dead route. The push itself
is a separate, later, explicit go — this build only prepares and locally commits the change.

## 5. What this deploy does NOT do

- Does not enable Turnstile (secret stays unset).
- Does not enable any email sending (no such code exists in this Worker at all — see
  `PHASE1_NOTES.md` and the "no email-sending code path" check in `test/worker.spec.ts`).
- Does not touch DNS, Zone Settings, GitHub Pages, or any other zone's configuration.
- Does not push the site's form-action change (item 4 above is a separate, later step).
