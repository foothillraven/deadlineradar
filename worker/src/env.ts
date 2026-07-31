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
  /**
   * OAuth/SSO client credentials (2026-07-30, auth suite). OPTIONAL and
   * gated PER PROVIDER: `getConfiguredProvider()` in oauth.ts returns null
   * unless BOTH of a provider's values are present, in which case that
   * provider's routes 404 and its sign-in button is not rendered. Same
   * degrade-safely convention as TURNSTILE_SECRET_KEY/SENDGRID_API_KEY --
   * an unconfigured provider is invisible, never a broken button.
   *
   * Set via `wrangler secret put` per environment, never in wrangler.toml
   * and never committed. See worker/AUTH_SSO_SETUP.md for the registration
   * steps and the exact redirect URIs that must be registered.
   *
   * Microsoft is intentionally absent: deferred 2026-07-30 (Devin's call)
   * because Microsoft deprecated directory-less app registration, leaving
   * only an expiring dev-sandbox tenant or a card-on-file Azure signup --
   * neither justified pre-revenue. Adding it later is one PROVIDERS entry
   * in oauth.ts plus its two secrets; no other code changes.
   */
  /**
   * OPTIONAL HMAC pepper for password hashing (2026-07-30, from security
   * review). Held as a Worker secret, deliberately NEVER in D1 -- that
   * separation is the entire point: a stolen database snapshot is not
   * offline-attackable at any work factor without a secret from a
   * different trust domain, which is what makes the 200k-vs-OWASP-600k
   * iteration shortfall irrelevant for the threat iterations defend
   * against.
   *
   * Unset is fully supported: hashes are written as v1 (no pepper) and
   * nothing changes. Setting it makes new and changed passwords v2, and
   * existing v1 records upgrade transparently on next successful login.
   *
   * WARNING: once v2 records exist, LOSING this secret makes them
   * unverifiable -- affected admins must use the emailed sign-in link and
   * set a new password. Treat it as a durable secret, not a rotatable one.
   */
  PASSWORD_PEPPER?: string;
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
}
