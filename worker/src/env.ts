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
 *
 * `EMAIL_ALLOWLIST` is an OPTIONAL wrangler var -- a comma-separated list of
 * exact email addresses (e.g. "dlhall86@gmail.com,dlhall86+test@gmail.com").
 * This is a PREVIEW/STAGING-ONLY safety gate: when set, sendViaSendGrid()
 * (sender.ts) refuses to send to any recipient not on the list, before making
 * any network call. It MUST be left unset in production -- an unset/empty
 * value leaves sendViaSendGrid()'s behavior completely unchanged (no gate).
 *
 * `ACTION_BASE_URL` is an OPTIONAL wrangler var -- overrides index.ts's and
 * scheduler.ts's hardcoded `https://deadline-radar.com/api` action-link base
 * (used to build every confirm/unsubscribe/renewed/rearm/firm-login link a
 * built email points at). PREVIEW/STAGING-ONLY: a preview deployment lives
 * at its own workers.dev URL, not deadline-radar.com, so its emailed links
 * must point back at ITSELF, not at production. Unset in production, where
 * the hardcoded default is exactly correct.
 *
 * `STATIC_SITE_BASE_URL` is an OPTIONAL wrangler var -- overrides the
 * relative `/firm-dashboard/` and `/` redirect targets handleFirmLoginVerify()/
 * handleFirmLogout() send a browser to after login/logout. In production the
 * Worker and the static site share one origin (deadline-radar.com), so a
 * relative redirect is correct. In preview, the Worker lives on its own
 * workers.dev origin while the static pages are a SEPARATE Pages deployment
 * -- a relative redirect from the Worker would send the browser to a
 * "/firm-dashboard/" path ON THE WORKER's own domain, which doesn't exist
 * there. Set to the preview Pages site's full origin (e.g.
 * "https://deadlineradar-preview.pages.dev") so the redirect crosses back to
 * where the actual dashboard HTML is served. Unset in production.
 */
export interface Env {
  DB: D1Database;
  TURNSTILE_SECRET_KEY?: string;
  SENDGRID_API_KEY?: string;
  REMINDERS_DAILY_SEND_CAP?: string;
  EMAIL_ALLOWLIST?: string;
  ACTION_BASE_URL?: string;
  STATIC_SITE_BASE_URL?: string;
}
