/**
 * Shared Worker environment binding shape. `DB` matches wrangler.toml's D1
 * binding name. `TURNSTILE_SECRET_KEY` is intentionally OPTIONAL and unset
 * in Phase 1 -- see validation.ts's `verifyTurnstile()`, which treats an
 * unset secret as "not configured yet" and lets the request through
 * (matching reminders/server.py's `_verify_turnstile()` gating). There is
 * deliberately no `SENDGRID_API_KEY` field here: Phase 1 has no code path
 * anywhere in src/ that could use one even if a wrangler secret of that
 * name were ever set.
 */
export interface Env {
  DB: D1Database;
  TURNSTILE_SECRET_KEY?: string;
}
