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
 * `DRIP_COURSE_DAILY_SEND_CAP` is an OPTIONAL wrangler var (a plain string
 * number) -- same shape as REMINDERS_DAILY_SEND_CAP above, but for the drip
 * course's own independent circuit breaker (sender.ts's
 * checkAndCountDripCourseSend() / DEFAULT_DAILY_DRIP_COURSE_SEND_CAP).
 *
 * `RULE_CHANGE_ALERT_DAILY_SEND_CAP` is an OPTIONAL wrangler var (a plain
 * string number) -- same shape again, for the proactive rule-change alert
 * cron's own independent circuit breaker (sender.ts's
 * checkAndCountRuleChangeAlertSend() / DEFAULT_DAILY_RULE_CHANGE_ALERT_SEND_CAP).
 *
 * `DIGEST_DAILY_SEND_CAP` is an OPTIONAL wrangler var (a plain string
 * number) -- same shape again, for the weekly digest cron's own independent
 * circuit breaker (sender.ts's checkAndCountDigestSend() /
 * DEFAULT_DAILY_DIGEST_SEND_CAP).
 *
 * `EMAIL_ALLOWLIST` is an OPTIONAL wrangler var -- a comma-separated list of
 * exact email addresses (e.g. "owner@example.com,owner+test@example.com").
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
  DRIP_COURSE_DAILY_SEND_CAP?: string;
  RULE_CHANGE_ALERT_DAILY_SEND_CAP?: string;
  DIGEST_DAILY_SEND_CAP?: string;
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
  /**
   * Two-factor authentication (roadmap #53, 2026-08-07). A base64-encoded
   * 32-byte AES-GCM key (`wrangler secret put TOTP_ENCRYPTION_KEY`),
   * generated once and held as a Worker secret, never in D1 -- same trust-
   * domain-separation reasoning as PASSWORD_PEPPER above. UNLIKE the
   * pepper, this is NOT optional in the way that one is: a TOTP secret
   * must be recoverable to verify a code (unlike a password, which is
   * only ever hashed), so there is no safe "write v1, no encryption"
   * fallback -- enrollment is refused outright while this is unset,
   * rather than ever storing a secret unencrypted.
   */
  TOTP_ENCRYPTION_KEY?: string;
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  /**
   * Stripe billing (2026-08-05, paid tiers). OPTIONAL, same degrade-safely
   * convention as SENDGRID_API_KEY/TURNSTILE_SECRET_KEY: unset means
   * checkout.ts's routes refuse with a clear error instead of throwing, so a
   * preview/dev environment with no Stripe config simply can't reach
   * checkout rather than crashing.
   *
   * STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are `wrangler secret put`
   * values, never committed. During Gate 1 these are TEST-mode values
   * (`sk_test_...` / a `whsec_...` from a test-mode webhook endpoint);
   * swapping to live values at Gate 2 is a pure secret rotation, zero code
   * diff, by design (PRO_TIER_SPEC / the paid-tiers plan).
   *
   * The four STRIPE_PRICE_* values are Stripe Price ids, not secrets (Stripe
   * price ids are safe to expose client-side), but are still env-sourced
   * rather than hardcoded because test-mode and live-mode prices are
   * DIFFERENT ids on the same Stripe account -- hardcoding would break the
   * Gate 1 -> Gate 2 swap the same way hardcoding the key would.
   */
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PRICE_INDIVIDUAL?: string;
  STRIPE_PRICE_FIRM_STARTER?: string;
  STRIPE_PRICE_FIRM_GROWTH?: string;
  STRIPE_PRICE_FIRM_STANDARD?: string;
  /**
   * Roadmap #1/#2 (2026-08-07, document storage). R2 bucket bound in
   * wrangler.toml (bucket `deadlineradar-documents`) -- holds the actual
   * uploaded file bytes for license/CPE certificates. D1's `documents`
   * table (migration 0032) holds only metadata + this bucket's object key.
   */
  DOCUMENTS: R2Bucket;
}
