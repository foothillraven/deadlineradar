/**
 * Shared Worker environment binding shape. `DB` matches wrangler.toml's D1
 * binding name.
 *
 * `TURNSTILE_SECRET_KEY` is OPTIONAL -- see validation.ts's `verifyTurnstile()`,
 * which treats an unset secret as "not configured yet" and lets requests
 * through. It is set (as a wrangler secret) once a real Turnstile widget
 * exists, at which point the signup form is bot-protected.
 *
 * `SENDGRID_API_KEY` is OPTIONAL -- a wrangler secret, never hardcoded, never
 * committed. When present, `/subscribe` sends a double-opt-in confirmation
 * email (Phase 2). When absent, the subscribe handler skips sending entirely
 * and behaves as capture-only (Phase 1) -- so an accidental unset degrades
 * safely to "store but don't email" rather than erroring.
 *
 * `REMINDERS_DAILY_SEND_CAP` is an OPTIONAL wrangler var (a plain string
 * number) -- the circuit-breaker daily cap; defaults to DEFAULT_DAILY_SEND_CAP
 * in sender.ts when unset.
 */
export interface Env {
  DB: D1Database;
  TURNSTILE_SECRET_KEY?: string;
  SENDGRID_API_KEY?: string;
  REMINDERS_DAILY_SEND_CAP?: string;
}
