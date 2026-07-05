# Phase 1 acceptance test — capture without sending email

Two layers of proof, per the directive's ask ("how we'll verify capture works... WITHOUT
any email being sent"):

1. **Automated** — `npm test` (30 checks as of this build, `test/worker.spec.ts`), runs
   against a real local D1 emulation via `@cloudflare/vitest-pool-workers`, not a mock.
   Covers the happy path, every validation rule, honeypot (incl. the whitespace-only
   bypass regression), cooldown/dedupe (incl. the Gmail dot/+tag regression), the full
   confirm/unsubscribe/renewed/rearm lifecycle (incl. the double-opt-in-bypass
   regression), rate limiting on both buckets, and `isPermanentlySuppressed()` directly.
   Run it yourself: `cd worker && npm install && npm test`.
2. **Manual, against the real deployed Worker** — the checklist below. Do this once after
   the real Phase-1 deploy (`DEPLOY.md`) and before pushing the site's form-action change.

## Manual acceptance checklist (run after a real deploy, before the site push)

```sh
BASE=https://deadline-radar.com/api

# 1. Health check.
curl -s "$BASE/health"
# Expect: {"status":"ok"}

# 2. A real signup.
curl -s -X POST "$BASE/subscribe" \
  -d "email=YOUR_TEST_ADDRESS@example.com" \
  -d "state=florida" \
  -d "license_type_id=fl-individual-odd" \
  -d "hp_website="
# Expect: HTTP 200, an HTML page that does NOT say "we sent you an email" -- it should say
# signups are recorded but automated email isn't switched on yet in this phase.
```

```sh
# 3. THE ACCEPTANCE CHECK: inspect the D1 row directly -- this is the "without any email
#    being sent" proof. Requires wrangler + the same API token from DEPLOY.md.
npx wrangler d1 execute deadlineradar --remote \
  --command "SELECT email, state_slug, status, confirm_token, created_at FROM subscribers WHERE email = 'YOUR_TEST_ADDRESS@example.com'"
# Expect: exactly one row, status = 'pending_confirmation', a real confirm_token.
```

```sh
# 4. Confirm this signup returns a "temporarily paused" 503 if you dropped a test row
#    outside the freshness window, or 200 if within it. If you got the row from step 3,
#    exercise the rest of the lifecycle directly using its tokens:
curl -s "$BASE/confirm?token=<confirm_token from step 3>"
# Expect: 200, "You're all set... marked confirmed."

npx wrangler d1 execute deadlineradar --remote \
  --command "SELECT status, confirmed_at FROM subscribers WHERE email = 'YOUR_TEST_ADDRESS@example.com'"
# Expect: status = 'confirmed', confirmed_at is now set.
```

```sh
# 5. Confirm NO email was sent at any point above. There is no SendGrid account
#    connected to this Worker, no API key configured, and no code path that could
#    reach one -- but as a live, observable confirmation rather than just a code claim:
#    check the test inbox used for step 2's YOUR_TEST_ADDRESS. Nothing should arrive,
#    ever, no matter how long you wait -- because nothing in this Worker can send it.
```

```sh
# 6. Clean up the test row (do this before switching to a real signup flow test, so a
#    later cooldown/dedupe check isn't confused by leftover test data):
npx wrangler d1 execute deadlineradar --remote \
  --command "DELETE FROM subscribers WHERE email = 'YOUR_TEST_ADDRESS@example.com'"
```

## What "acceptance" means for Phase 1 specifically

Passing this checklist proves: the Worker is live and reachable at the real Route, D1
storage works end-to-end (write + read), the full signup/confirm/lifecycle state machine
works against real (not local-emulated) D1, and — the actual point of Phase 1 — **capture
happens with zero email risk**, because there is no email-sending code in this Worker to
accidentally trigger. It does NOT prove anything about real end-user traffic yet, since
the live site's form still posts to the placeholder domain until a separate, later,
explicitly-approved push (see `DEPLOY.md` §4).
