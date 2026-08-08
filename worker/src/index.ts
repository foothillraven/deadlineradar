/**
 * DeadlineRadar Worker -- capture + double-opt-in confirmation email.
 *
 * Endpoints, same route dispatch as reminders/server.py: POST /subscribe,
 * GET /confirm, GET /unsubscribe, GET /renewed, GET /rearm, GET /health.
 *
 * A successful /subscribe stores a `pending_confirmation` row and, when a
 * SendGrid key is configured (env.SENDGRID_API_KEY), sends ONE double-opt-in
 * confirmation email (see emails.ts / sender.ts). No further email is ever
 * sent unless the recipient clicks the confirm link. Reminder emails belong to
 * the Phase-3 scheduler (a cron the confirmation email promises: 60/30/14/7/3/1
 * days out) and are NOT sent from this Worker yet. If SENDGRID_API_KEY is
 * unset, /subscribe degrades safely to capture-only (store the row, send
 * nothing) rather than erroring.
 *
 * Sending is gated on env.SENDGRID_API_KEY AND, at the network edge, on
 * Turnstile (env.TURNSTILE_SECRET_KEY): with the secret set, a bot that can't
 * solve the challenge never reaches the send path, so the public form can't be
 * used to blast confirmation emails at arbitrary addresses. A per-day circuit
 * breaker (sender.checkAndCountActionSend) is the last-resort cap on total
 * sends -- its own counter (migration 0019, AuditLab TS-1), separate from
 * the reminder scheduler's, so a burst against any of these routes can never
 * starve real deadline reminders of the shared budget they used to share.
 *
 * Abuse-hardening carried forward from reminders/server.py's module
 * docstring, in the same checked order:
 *   1. Per-IP rate limiting (validation.ts, D1-backed).
 *   2. Hidden honeypot field.
 *   3. Cloudflare Turnstile hook (validation.ts) -- inert until a real
 *      secret is configured.
 *   4. Control-character / length / format validation on every field,
 *      BEFORE anything is persisted or computed.
 *   5. Cooldown + dedupe (store.ts) -- never more than one active record per
 *      email+state, and only one BRAND NEW state accepted per address per
 *      SIGNUP_COOLDOWN_HOURS. A repeat submission for an email+state that
 *      already has a pending record does NOT just no-op, though: it
 *      resends the same confirmation link (store.resendEligible /
 *      recordResend), itself rate-limited (RESEND_COOLDOWN_MINUTES) so this
 *      can't become its own mail-bombing vector. This closes the gap where
 *      someone who lost or never received their first confirmation email
 *      had no way to get a new one within the cooldown window.
 *   6. Deadline computability validated on a throwaway probe BEFORE
 *      store.addPending() ever runs.
 * Every one of these fails toward the SAME generic success response, so
 * none of them creates an oracle an attacker could use to enumerate which
 * addresses are already subscribed -- including the resend path: a real
 * resend and a no-op look identical from the outside.
 */

import type { Env } from "./env";
import {
  HONEYPOT_FIELD_NAME,
  MAX_ADMIN_NAME_LEN,
  MAX_BODY_BYTES,
  MAX_CPE_DESCRIPTION_LEN,
  MAX_CPE_HOURS_PER_ENTRY,
  MAX_FIELD_LEN,
  MAX_FIRM_NAME_LEN,
  MAX_STAFF_COUNT_HINT_LEN,
  MAX_STAFF_LABEL_LEN,
  MAX_OFFICE_TAG_LEN,
  MAX_INTERNAL_NOTES_LEN,
  RATE_LIMIT_ACTION,
  RATE_LIMIT_FIRM_PASSWORD_LOGIN,
  RATE_LIMIT_FIRM_2FA_VERIFY,
  RATE_LIMIT_FIRM_2FA_VERIFY_ACCOUNT,
  RATE_LIMIT_FIRM_2FA_ENROLL,
  RATE_LIMIT_FIRM_2FA_DISABLE,
  RATE_LIMIT_FIRM_BILLING_CANCEL,
  RATE_LIMIT_FIRM_ACCOUNT_DELETE,
  DELETION_SURVEY_REASONS,
  MAX_DELETION_SURVEY_DETAIL_LEN,
  RATE_LIMIT_FIRM_SIGNOUT_OTHER,
  RATE_LIMIT_FIRM_SESSION_REVOKE,
  RATE_LIMIT_FIRM_MEMBER_INVITE,
  RATE_LIMIT_FIRM_MEMBER_ROLE_CHANGE,
  RATE_LIMIT_FIRM_MEMBER_REMOVE,
  RATE_LIMIT_FIRM_MEMBER_MAKE_PRIMARY,
  RATE_LIMIT_FIRM_NPS,
  RATE_LIMIT_FIRM_TESTIMONIAL,
  MAX_TESTIMONIAL_LEN,
  RATE_LIMIT_FIRM_DISMISS,
  RATE_LIMIT_LOGOUT,
  RATE_LIMIT_FIRM_CHANGE_EMAIL,
  RATE_LIMIT_FIRM_PASSWORD_SET,
  RATE_LIMIT_OAUTH_START,
  RATE_LIMIT_CPE_ENTRY_CREATE,
  RATE_LIMIT_FIRM_DOCUMENT_UPLOAD,
  RATE_LIMIT_FIRM_PEER_REVIEW_SET,
  RATE_LIMIT_FIRM_REPLY_TO_SET,
  RATE_LIMIT_FIRM_REMINDER_CADENCE_SET,
  RATE_LIMIT_FIRM_RULE_CHANGE_ALERTS_SET,
  parseReminderThresholds,
  RATE_LIMIT_SUBSCRIBER_CPE_CREATE,
  RATE_LIMIT_SUBSCRIBER_CHANGE_EMAIL,
  RATE_LIMIT_SUBSCRIBER_PROFILE_UPDATE,
  RATE_LIMIT_SUBSCRIBER_REMINDER_CADENCE,
  RATE_LIMIT_FIRM_STAFF_CPE_REMINDER,
  RATE_LIMIT_FIRM_RULE_CHANGE_NOTIFY,
  RATE_LIMIT_ROADMAP_VOTE,
  RATE_LIMIT_ROADMAP_NOTIFY_SIGNUP,
  RATE_LIMIT_FIRM_LEAD,
  RATE_LIMIT_MOBILITY_CHECK,
  RATE_LIMIT_MOBILITY_CHECK_BATCH,
  RATE_LIMIT_MOBILITY_CHECK_UNMETERED,
  RATE_LIMIT_FIRM_LICENSE_CREATE,
  RATE_LIMIT_FIRM_LICENSE_PATCH,
  RATE_LIMIT_FIRM_LICENSE_DELETE,
  RATE_LIMIT_FIRM_LICENSE_RENEW,
  RATE_LIMIT_CPE_ENTRY_DELETE,
  RATE_LIMIT_OAUTH_IDENTITY_DELETE,
  RATE_LIMIT_MOBILITY_COMPLETION_CREATE,
  RATE_LIMIT_MOBILITY_COMPLETION_DELETE,
  RATE_LIMIT_DEBUG_REMINDER_PASS,
  RATE_LIMIT_FIRM_LOGIN,
  RATE_LIMIT_SUBSCRIBER_LOGIN_ACCOUNT,
  RATE_LIMIT_FIRM_LOGIN_ACCOUNT,
  RATE_LIMIT_FIRM_SIGNUP,
  RATE_LIMIT_FIRM_SIGNUP_ACCOUNT,
  RATE_LIMIT_FIRM_BILLING_CHECKOUT,
  RATE_LIMIT_SUBSCRIBE,
  checkRateLimit,
  checkSignupDomainGate,
  escapeHtml,
  getCookie,
  hasControlChars,
  isValidCpeCategory,
  isValidEmail,
  parseStrictCpeHours,
  parseStrictDollarsToCents,
  parseStrictCarryoverHours,
  sanitizeFreeText,
  strictParseInt,
  parseStrictIsoDate,
  verifyTurnstile,
  TERMS_VERSION,
} from "./validation";
import {
  StaleDataError,
  checkDataFreshness,
  computeSubscriberDeadline,
  dataFreshnessInfo,
  isStateComputable,
  stateNameForSlug,
  SUPPORTED_STATE_SLUGS,
  USER_DEADLINE_MAX_DAYS,
  type DeadlineFields,
} from "./deadline";
import * as store from "./store";
import {
  buildConfirmationEmail,
  buildFirmLoginEmail,
  buildFirmMemberInviteEmail,
  buildSubscriberLoginEmail,
  buildSubscriberEmailChangeConfirmEmail,
  buildSubscriberEmailChangeRequestedNoticeEmail,
  buildStaffCpeReminderEmail,
  buildRuleChangeNotificationEmail,
  buildStaffUnsubscribedNotificationEmail,
  buildFeatureIdeaNotifyConfirmEmail,
  buildFeatureIdeaShippedEmail,
  buildFirmPasswordChangedEmail,
  buildFirmTwoFactorChangedEmail,
  buildFirmSessionsEndedEmail,
  buildFirmEmailChangeConfirmEmail,
  buildFirmEmailChangeRequestedNoticeEmail,
  buildFirmOauthLinkedEmail,
  buildFirmStaffAddedEmail,
  buildStopConfirmationEmail,
  buildSignupNotificationEmail,
  buildAccountDeletionNotificationEmail,
  fmtDate,
  SNOOZE_DAYS,
} from "./emails";
import { DEFAULT_DAILY_SEND_CAP, checkAndCountActionSend, isEmailAllowlisted, sendViaSendGrid } from "./sender";
import { StaleDataError as SchedulerStaleDataError, runReminderPass, runDripCoursePass, runRuleChangeAlertPass } from "./scheduler";
import { isUsFederalHoliday } from "./holidays";
import {
  MAX_PASSWORD_LEN,
  hashPassword,
  verifyPassword,
  validatePasswordStrength,
  needsRehash,
  dummyVerifyForTiming,
} from "./password";
import {
  generateTotpSecretBase32,
  verifyTotp,
  buildOtpauthUri,
  encryptTotpSecret,
  decryptTotpSecret,
  generateBackupCodes,
  hashBackupCode,
} from "./totp";
import {
  getConfiguredProvider,
  buildRedirectUri,
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  parseAndValidateIdToken,
} from "./oauth";
import mobilityRulesData from "./mobility_rules.json";
import {
  MOBILITY_DISCLAIMER,
  evaluateMobility,
  isValidServiceType,
  normalizeRuleRow,
  type MobilityRuleRow,
} from "./mobility";
import { checkPaidFeatureAccess, paidFeatureDenialMessage } from "./entitlements";
import { firmTierByPlanTier, firmTierForSeatCount, seatCapForFirmTier, stripePriceIdForTier } from "./tiers";
import {
  createCheckoutSession,
  updateSubscriptionCancelAtPeriodEnd,
  getLatestInvoiceForSubscription,
  computeProratedRefundCents,
  refundPaymentIntent,
  cancelSubscriptionImmediately,
  verifyWebhookSignature,
  StripeApiError,
  type StripeWebhookEvent,
} from "./stripe";
import { buildIcs, type IcsEvent } from "./ics";

const SITE_NAME_FOR_WORKER = "DeadlineRadar";

// Brand glyph, kept in sync by eye with generate.py's _BRAND_GLYPH_SVG --
// this worker has no build-time dependency on the static site's Python, so
// the two copies must be updated together if the mark ever changes.
const _WORKER_BRAND_GLYPH_SVG = `<svg viewBox="0 0 32 32" fill="none" aria-hidden="true" width="24" height="24">
  <circle cx="16" cy="16" r="13.5" stroke="#1f3d54" stroke-width="1.6"/>
  <circle cx="16" cy="16" r="8" stroke="#c8d2db" stroke-width="1.2"/>
  <circle cx="16" cy="16" r="2.3" fill="#8a6a33"/>
  <path d="M16 16 L26 9" stroke="#8a6a33" stroke-width="1.8" stroke-linecap="round"/>
  <path d="M16 3.5 L16 6" stroke="#1f3d54" stroke-width="1.6" stroke-linecap="round"/>
</svg>`;

// Reported directly, 2026-08-04: every one of these transactional pages
// (subscribe/confirm/unsubscribe/renew/rearm/login-verify -- the entire
// first-time consumer conversion funnel, landing right after a styled
// email) rendered as plain white/default-serif with no branding, "looks
// broken/abandoned mid-flow." This worker deliberately does NOT import
// generate.py's full page shell (52KB of inlined CSS per AuditLab's PERF-1)
// -- these are single-purpose action pages, not the marketing site, so a
// small purpose-built shell matching the SAME color tokens generate.py uses
// (light/dark via prefers-color-scheme, same hex values) is the right size
// for the job. homeUrl defaults to "" (a relative "/") because
// STATIC_SITE_BASE_URL is only ever set in preview/staging (see this file's
// other env.STATIC_SITE_BASE_URL call sites) -- production always resolves
// "/" correctly on the same origin.
function htmlPage(title: string, bodyHtml: string, homeUrl = ""): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{min-height:100vh;display:flex;flex-direction:column;background:#f7f9fb;color:#17212b;font-family:-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;line-height:1.55}
@media (prefers-color-scheme:dark){body{background:#12151a;color:#e7ebf0}}
.dr-hdr{padding:1rem 1.25rem;border-bottom:1px solid #e0e6ec}
@media (prefers-color-scheme:dark){.dr-hdr{border-bottom-color:#2a323c}}
.dr-hdr a{display:inline-flex;align-items:center;gap:.5rem;color:inherit;text-decoration:none;font-weight:700;font-size:1.05rem}
.dr-main{flex:1;display:flex;align-items:center;justify-content:center;padding:2.5rem 1.25rem}
.dr-card{max-width:440px;width:100%;background:#fff;border:1px solid #e0e6ec;border-radius:12px;padding:2rem}
@media (prefers-color-scheme:dark){.dr-card{background:#1a1f26;border-color:#2a323c}}
.dr-card h1{margin:0 0 .6rem;font-size:1.3rem;line-height:1.3}
.dr-card p{margin:0 0 1rem;color:#5a6b7a}
@media (prefers-color-scheme:dark){.dr-card p{color:#9aa5b1}}
.dr-card p:last-child{margin-bottom:0}
.dr-card a{color:#1f3d54}
@media (prefers-color-scheme:dark){.dr-card a{color:#7fa8d9}}
.dr-card button{font:inherit;font-size:1rem;font-weight:700;padding:.75rem 1.5rem;border:0;border-radius:8px;background:#1f3d54;color:#fff;cursor:pointer;width:100%}
@media (prefers-color-scheme:dark){.dr-card button{background:#7fa8d9;color:#0d1824}}
.dr-card button:hover{opacity:.92}
.dr-card input[type=password]{width:100%;font-size:16px;padding:.6rem .7rem;border:1px solid #e0e6ec;border-radius:6px;background:#fff;color:inherit;font-family:inherit}
@media (prefers-color-scheme:dark){.dr-card input[type=password]{background:#12151a;border-color:#2a323c}}
.dr-card label{display:block;font-size:.8rem;margin-bottom:.3rem}
.dr-ftr{padding:1.25rem;text-align:center;font-size:.78rem;color:#5a6b7a}
@media (prefers-color-scheme:dark){.dr-ftr{color:#9aa5b1}}
</style>
</head><body>
<div class="dr-hdr"><a href="${escapeHtml(homeUrl)}/">${_WORKER_BRAND_GLYPH_SVG}<span>${escapeHtml(SITE_NAME_FOR_WORKER)}</span></a></div>
<div class="dr-main"><div class="dr-card">${bodyHtml}</div></div>
<div class="dr-ftr">${escapeHtml(SITE_NAME_FOR_WORKER)} is an independent reminder service. Not affiliated with any state board of accountancy.</div>
</body></html>`;
}

// Copy for the GET confirmation pages -- the landing page an action link opens.
// The link itself changes nothing; only the button (a POST) does. This is what
// makes the actions prefetch-safe against email link scanners.
const ACTION_PAGES: Record<string, { heading: string; intro: string; button: string }> = {
  "/confirm": {
    heading: "Confirm your email",
    intro: "Click below to confirm your email and start your DeadlineRadar reminders.",
    button: "Confirm my email",
  },
  "/unsubscribe": {
    heading: "Unsubscribe",
    intro: "Click below to stop all reminder emails for this deadline. This is instant and permanent.",
    button: "Unsubscribe me",
  },
  // Roadmap #34 (2026-08-08): separate from /unsubscribe above -- this only
  // stops the drip course series, never a subscriber's actual renewal-
  // deadline reminders (see store.stopDripCourseByToken()'s own comment).
  "/drip-course/unsubscribe": {
    heading: "Unsubscribe from this email series",
    intro: "Click below to stop the rest of this email series. Your actual renewal-deadline reminders are unaffected either way.",
    button: "Unsubscribe me from this series",
  },
  "/renewed": {
    heading: "Stop reminders entirely",
    intro: "Click below to stop all further reminders for this deadline, permanently.",
    button: "Yes, stop these reminders entirely",
  },
  "/renewed-next-cycle": {
    heading: "You've renewed -- keep my reminders going",
    intro:
      "Click below to confirm you've renewed. We'll immediately re-arm reminders for your next " +
      "renewal cycle -- nothing else to do.",
    button: "Yes, I've renewed -- remind me next cycle",
  },
  "/rearm": {
    heading: "Turn reminders back on",
    intro: "Click below to get reminders again for your next renewal cycle.",
    button: "Yes, remind me next cycle",
  },
  // Roadmap #26 (2026-08-07). SNOOZE_DAYS interpolated so this copy can
  // never drift from the actual duration store.snoozeByToken() applies.
  "/snooze": {
    heading: "Remind me again later",
    intro: `Click below to pause this reminder for ${SNOOZE_DAYS} days. We'll pick up right where we left off after that -- nothing else changes.`,
    button: `Remind me again in ${SNOOZE_DAYS} days`,
  },
  "/firm/login/verify": {
    heading: "Sign in to DeadlineRadar",
    intro: "Click below to finish signing in.",
    button: "Sign in",
  },
  // Free-tier individual sign-in (2026-07-31). Routed through the same
  // render-then-POST machinery as everything above, for the same reason:
  // corporate mail scanners prefetch links, and a token consumed by a
  // scanner leaves the real person permanently stuck on "already used".
  "/subscriber/login/verify": {
    heading: "Sign in to DeadlineRadar",
    intro: "Click below to see the renewal deadlines we're tracking for you.",
    button: "Sign in",
  },
  // Task #19 (2026-08-06). Same prefetch-safety reasoning as every route
  // above -- an email scanner auto-visiting this link must not silently
  // confirm a real person's notify-signup.
  "/roadmap/notify-confirm": {
    heading: "Confirm your roadmap notification",
    intro: "Click below to confirm -- you'll get one email if and when this ships, nothing else.",
    button: "Confirm notification",
  },
};

const ACTION_PATHS = new Set(Object.keys(ACTION_PAGES));

// ---------------------------------------------------------------------------
// LOGIN CSRF / session fixation defence (2026-07-31, from the free-tier
// security review, which demonstrated the attack against a live route).
//
// The attack: an attacker requests a sign-in link for THEIR OWN address,
// never clicks it, and instead hosts an auto-submitting cross-site form
// POSTing that still-valid token to /subscriber/login/verify. The victim's
// browser silently receives Set-Cookie and is now signed in AS THE
// ATTACKER, looking at the attacker's deadlines on our domain -- shown, for
// a renewal-deadline product, exactly the wrong dates. It also pre-poisons
// any write endpoint either dashboard grows later.
//
// SameSite=Lax does not stop this, and this repo already knows why:
// migration 0011 says it verbatim -- Lax governs cookie SENDING, not
// Set-Cookie. 0011 fixed this same attack class for the OAuth flow one day
// before the magic-link flow reintroduced it; this is the same fix carried
// across, and it closes the identical pre-existing hole on
// /firm/login/verify at the same time.
//
// The mechanism is double-submit: the GET render mints a CSPRNG nonce, puts
// it in a hidden field AND in a short-lived cookie, and the POST requires
// the two to match. An attacker can produce a valid token and a valid form,
// but cannot set a cookie in the victim's browser from their own site, so
// the halves can never match in a victim's browser.
const ACTION_CSRF_COOKIE_NAME = "dr_action_csrf";
const ACTION_CSRF_FIELD_NAME = "action_csrf";
// Long enough to read an email and click, short enough that a stale nonce
// on a shared machine is not lying around. Expiry is enforced only by the
// cookie: the nonce is a same-browser proof, not a credential -- the actual
// authority is the login token, which has its own 15-minute server-side TTL.
const ACTION_CSRF_MAX_AGE_SECONDS = 30 * 60;

/**
 * The paths where the POST actually requires the nonce.
 *
 * Deliberately NOT every action path. /unsubscribe in particular must keep
 * accepting a bare cross-origin POST, because RFC 8058 List-Unsubscribe
 * one-click is a POST issued by the MAIL CLIENT, which never renders our
 * page and so can never carry a nonce -- requiring one there would break
 * one-click unsubscribe, a deliverability and CAN-SPAM obligation.
 *
 * That is an acceptable line to draw because CSRF only matters where the
 * request GRANTS something. /confirm, /unsubscribe, /renewed and /rearm all
 * require an unguessable per-subscriber token and change only that
 * subscriber's own reminder state; the two login routes below are the only
 * ones that hand the browser a session.
 */
const ACTION_CSRF_REQUIRED_PATHS = new Set(["/firm/login/verify", "/subscriber/login/verify"]);

function actionCsrfSetCookieHeader(nonce: string, env: Env): string {
  return (
    `${ACTION_CSRF_COOKIE_NAME}=${encodeURIComponent(nonce)}; HttpOnly; Secure; ` +
    `SameSite=${firmSessionCookieSameSite(env)}; Path=/; Max-Age=${ACTION_CSRF_MAX_AGE_SECONDS}`
  );
}

/**
 * Compares the form's nonce against the cookie's. Constant-time is not
 * required (the nonce is not a secret being guessed one byte at a time --
 * it is a same-browser proof, and a mismatch reveals nothing), but a
 * non-empty check is: two absent values must never compare equal, or the
 * whole defence inverts into "send neither and you're in."
 */
function actionCsrfOk(request: Request, pathname: string, formNonce: string | null): boolean {
  const cookieNonce = getCookie(request, ACTION_CSRF_COOKIE_NAME);
  if (!cookieNonce || !formNonce) return false;
  // Bound to the PATH it was minted for, so a nonce handed out by one login
  // route cannot be replayed at the other (2026-07-31 verification pass).
  // The binding is in the cookie's own value rather than a second cookie,
  // which keeps this to one name and one comparison.
  return cookieNonce === `${pathname}|${formNonce}`;
}

/**
 * ORIGIN CHECK for the session-granting POSTs that are NOT action pages
 * (2026-07-31, verification pass).
 *
 * The nonce above only protects routes that have a GET render to mint it.
 * POST /firm/login/password has none -- it is a direct form POST that ends
 * in Set-Cookie: dr_firm_session -- so the verification pass demonstrated
 * the SAME login-CSRF/session-fixation attack against it: an attacker
 * auto-submits their own credentials from their own site, and the victim's
 * browser silently becomes signed in as the attacker. That route is the
 * PAID tier's primary sign-in, so leaving it open while announcing the
 * class closed would have been the worst of both.
 *
 * Origin is the right tool here because there is no render step to hang a
 * nonce on: every browser sends Origin on a cross-site POST, and a page on
 * evil.example cannot forge it.
 *
 * Absent Origin is ALLOWED, deliberately. Some non-browser clients and
 * older agents omit it entirely, and the attack this defends against is
 * inherently browser-driven -- a browser that can be made to submit a
 * cross-site form is also a browser that sends Origin on it. Rejecting
 * absent-Origin would break legitimate callers without closing anything.
 *
 * The allowed set mirrors the CORS allowlist: this Worker's own origin,
 * plus env.STATIC_SITE_BASE_URL when set. That second entry is required,
 * not optional -- on a preview deploy the static site and the Worker are
 * genuinely different origins, so the honest form POST IS cross-origin
 * there and would otherwise be rejected.
 */
function originAllowed(request: Request, env: Env): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  const allowed = new Set<string>();
  try {
    allowed.add(new URL(actionBaseUrl(env)).origin);
  } catch {
    // a malformed ACTION_BASE_URL must not silently allow everything
  }
  try {
    allowed.add(new URL(request.url).origin);
  } catch {
    /* unreachable for a real Request */
  }
  if (env.STATIC_SITE_BASE_URL) {
    try {
      allowed.add(new URL(env.STATIC_SITE_BASE_URL).origin);
    } catch {
      /* ignore a malformed override */
    }
  }
  return allowed.has(origin);
}

async function actionConfirmPage(pathname: string, token: string, env: Env): Promise<Response> {
  const meta = ACTION_PAGES[pathname];
  if (!meta) return errorPage(404, "Not found.");
  const action = `/api${pathname}`; // the Worker is bound to /api/*
  const needsCsrf = ACTION_CSRF_REQUIRED_PATHS.has(pathname);
  const nonce = needsCsrf ? store.newToken() : null;
  const csrfFieldHtml = nonce
    ? `<input type="hidden" name="${ACTION_CSRF_FIELD_NAME}" value="${escapeHtml(nonce)}">`
    : "";
  // Optional password field, /firm/login/verify only (2026-08-02). Signup
  // never asks for a password and the dashboard's own account panel to set
  // one afterward went undiscovered in practice -- this puts the option on
  // the FIRST screen a firm sees, right where they're already about to
  // click "Sign in". Handled server-side in handleFirmLoginVerify(): a
  // value here is ignored for a password-reset link (that flow has its own
  // dedicated set-password page next) and ignored if the firm already has a
  // password, so this can only ever set a first password, never silently
  // change one.
  //
  // That "ignored for a password-reset link" behavior used to be invisible
  // here: this page rendered the field regardless of the token's purpose,
  // so a firm resetting their password would fill it in, submit, and land
  // on /set-password/ anyway with their input silently dropped -- reads as
  // being asked to set a password twice (reported directly, 2026-08-03).
  // A non-consuming peek at the token's purpose lets the copy match what
  // will actually happen, without spending the token's one-time use just to
  // render a page.
  const passwordEligibility =
    pathname === "/firm/login/verify" ? await store.peekLoginTokenPasswordEligibility(env.DB, token) : null;
  const tokenPurpose = passwordEligibility?.purpose ?? null;
  // AuditLab/adversarial-review M1 (2026-08-05, Task #29): was
  // `tokenPurpose !== "password_reset"` -- true for BOTH "login" and the
  // new "email_change" purpose, so an email-change confirmation link
  // (which can land in a STRANGER's inbox if the admin mistypes the new
  // address) also rendered an offer to set a password on the account,
  // wired to actually apply it below. A typo victim could then both
  // confirm the email swap and set a password in the same click -- a full
  // account takeover, not just a wrong-address annoyance. Narrowed to
  // exactly "login": password_reset already has its own dedicated flow,
  // and email_change gets nothing extra here now, matching the same posture.
  const passwordFieldHtml =
    pathname === "/firm/login/verify" && tokenPurpose === "login" && passwordEligibility?.firmHasPassword === false
      ? `<div style="margin:0 0 1rem;">` +
        `<label for="dr-optional-password">` +
        `Optional: set a password now, so you can skip this email next time</label>` +
        `<input type="password" id="dr-optional-password" name="new_password" minlength="12" maxlength="200" ` +
        `autocomplete="new-password" placeholder="At least 12 characters">` +
        `</div>`
      : "";
  // Same purpose peek as the password field above: a password-reset link
  // lands on "Choose a new password" next (handleFirmLoginVerify), so say
  // so here instead of the generic "finish signing in" copy that reads like
  // the reset is already done.
  const intro =
    pathname === "/firm/login/verify" && tokenPurpose === "password_reset"
      ? "Click below, then choose a new password on the next screen."
      : meta.intro;
  const body =
    `<h1>${escapeHtml(meta.heading)}</h1>` +
    `<p>${escapeHtml(intro)}</p>` +
    `<form method="post" action="${escapeHtml(action)}">` +
    `<input type="hidden" name="token" value="${escapeHtml(token)}">` +
    csrfFieldHtml +
    passwordFieldHtml +
    `<button type="submit">${escapeHtml(meta.button)}</button>` +
    `</form>`;
  const headers: Record<string, string> = { "Content-Type": "text/html; charset=utf-8" };
  if (nonce) headers["Set-Cookie"] = actionCsrfSetCookieHeader(`${pathname}|${nonce}`, env);
  // This page carries a live login token in its URL and its markup, and its
  // button grants a session (2026-07-31 verification pass):
  //   * DENY framing, so it cannot be overlaid in a clickjacking frame;
  //   * no-store, so a shared machine's cache/back-button cannot resurrect
  //     the token;
  //   * no-referrer, so the token in the URL is not leaked to anything the
  //     page links to.
  headers["X-Frame-Options"] = "DENY";
  headers["Content-Security-Policy"] = "frame-ancestors 'none'";
  headers["Cache-Control"] = "no-store, no-cache, must-revalidate, private";
  headers["Referrer-Policy"] = "no-referrer";
  return new Response(htmlPage(meta.heading, body), { status: 200, headers });
}

function htmlResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function jsonResponse(status: number, obj: unknown): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

// `link` (2026-08-03, AuditLab-adjacent finding): several of these error
// pages tell the reader to "request a new one" or "try again" with no
// actual way to do either from that page -- a dead end, reported directly
// off a screenshot of the reused-login-link case. Optional so every
// existing call site (most of which have no obvious next step to offer)
// is unaffected.
// Roadmap #61 (2026-08-07): sitewide error-message quality pass. Audited
// every distinct errorPage() message in this file -- the single biggest
// finding was structural, not wording: 23+ call sites (mostly defensive
// request-parsing catches that fire on a genuinely rare malformed/dropped
// request, not a normal validation failure) render with NO `link` param
// at all, leaving a visitor with nothing but the header logo to click
// back to the homepage -- no "try again," no way to get real help. Rather
// than hand-writing a bespoke link for 23 different call sites (many of
// which a generic "try again" would be actively WRONG for -- a permanently
// expired token retrying does nothing), fixed it at the one choke point
// every errorPage() call already passes through: an unset `link` now
// falls back to a real, always-correct-regardless-of-cause escape hatch
// instead of silently rendering nothing.
function errorPage(status: number, message: string, link?: { href: string; text: string }): Response {
  const resolvedLink = link ?? { href: "/contact/", text: "If this keeps happening, let us know." };
  const linkHtml = `<p><a href="${escapeHtml(resolvedLink.href)}">${escapeHtml(resolvedLink.text)}</a></p>`;
  return htmlResponse(status, htmlPage("Error", `<p>${escapeHtml(message)}</p>${linkHtml}`));
}

// Every /subscribe path (real signup, resend, honeypot no-op, cooldown/
// dedupe no-op) returns this SAME response, so none of them is an oracle an
// attacker could use to enumerate already-subscribed addresses -- some paths
// send a real email (first-time signup, or a rate-limited resend for an
// existing pending record) and some send nothing at all, but the copy is
// deliberately generic ("check your email") so it's accurate either way and
// never reveals which branch actually ran.
const SUBSCRIBE_SUCCESS_PAGE = htmlPage(
  "Almost there",
  "<h1>Almost there &mdash; check your email</h1><p>Look for a confirmation link in your inbox and " +
    "click it to start your reminders. If it's not there in a minute, check your spam folder. " +
    "(Didn't sign up? Just ignore it &mdash; you won't hear from us again.)</p>"
);

// The Worker is bound to deadline-radar.com/api/*, so action links the
// confirmation email points back at must include the /api prefix (the fetch
// handler strips it again on the way in). This is the public base for
// /confirm and /unsubscribe links.
const ACTION_BASE_URL = "https://deadline-radar.com/api";

// Preview/staging override -- see env.ts's ACTION_BASE_URL docstring. Every
// call site below must use this function, not the raw constant above,
// so a preview deployment's emailed links point back at itself.
function actionBaseUrl(env: Env): string {
  return env.ACTION_BASE_URL || ACTION_BASE_URL;
}

// Where signup notifications go (2026-08-05, Devin: "I want an email
// notification on every signup. So I can personally reach out and greet
// them."). Devin's own choice -- the existing public contact address, not a
// new one. A fixed constant, never derived from anything a request carries,
// so nothing about who signed up can redirect this to another address.
const INTERNAL_NOTIFY_EMAIL = "support@deadline-radar.com";

/**
 * Best-effort internal notification -- same posture as every other send in
 * this file (never fails the caller's real action, degrades to a no-op
 * without SENDGRID_API_KEY, shares the one daily circuit breaker). Fires on:
 *   - an individual's double-opt-in CONFIRMATION (handleConfirm), not the
 *     initial /subscribe capture -- confirms the address is real and the
 *     signup wasn't abandoned before ever being useful to greet.
 *   - a firm's FIRST-EVER successful login (handleFirmLoginVerify), not
 *     account creation -- confirms the admin email is real and the firm
 *     actually followed through, not just submitted a form (Devin's
 *     explicit choice over notifying at creation time).
 */
async function sendSignupNotification(
  env: Env,
  kind: "individual" | "firm",
  details: { email: string; stateName?: string; firmName?: string; adminName?: string | null }
): Promise<void> {
  if (!env.SENDGRID_API_KEY) return;
  try {
    const underCap = await checkAndCountActionSend(env.DB, dailySendCap(env));
    if (!underCap) return;
    const built = buildSignupNotificationEmail(kind, details);
    await sendViaSendGrid(env.SENDGRID_API_KEY, INTERNAL_NOTIFY_EMAIL, built, env.EMAIL_ALLOWLIST);
  } catch {
    // Best-effort, same posture as every other send in this file -- never
    // let a notification failure affect the real signup/login it's about.
  }
}

// The static site's own absolute origin (no /api -- unlike ACTION_BASE_URL
// above, this points at the Pages-served site itself, e.g. /firm-dashboard/).
// Every OTHER `env.STATIC_SITE_BASE_URL || ""` call site in this file is a
// browser REDIRECT (a relative Location header resolves fine against
// whatever origin the browser is already on), so those correctly stay
// relative. Stripe's Checkout Session API is different: success_url/
// cancel_url are validated SERVER-SIDE by Stripe itself, which has no
// browser context to resolve a relative path against -- a relative value
// there is rejected outright (2026-08-05, live Gate-1 test: this is exactly
// what produced "Couldn't start checkout" / a 502, verified against the
// real Stripe API before this fix).
const SITE_ORIGIN = "https://deadline-radar.com";
function staticSiteAbsoluteBaseUrl(env: Env): string {
  return env.STATIC_SITE_BASE_URL || SITE_ORIGIN;
}

// migration 0008 -- firm admin login cookie. HttpOnly (never readable from
// JS -- the dashboard's frontend never needs the raw token, only the
// server does), Secure (HTTPS-only transmission), SameSite=Lax (sent on
// top-level navigation -- e.g. following the emailed login link and its
// redirect -- but not on cross-site subresource/XHR requests, a real CSRF
// mitigation for a cookie whose mere presence grants dashboard access).
// Max-Age matches store.SESSION_TTL_DAYS exactly -- kept as a separate
// literal (not imported) since this is a COOKIE lifetime (seconds, HTTP
// semantics) and that's a session-ROW lifetime (days, app semantics); see
// the comment on FIRM_SESSION_COOKIE_MAX_AGE_SECONDS below for what breaks
// if these two are ever allowed to drift apart.
const FIRM_SESSION_COOKIE_NAME = "dr_firm_session";
// Must stay equal to store.SESSION_TTL_DAYS * 86400 -- this is only the
// BROWSER's copy of the expiry (when the browser stops sending the cookie
// at all); store.ts's verifySession() independently checks the session
// row's own `expires_at` on every request regardless, so a mismatch here
// could only ever make the cookie disappear EARLIER than the server-side
// session actually expires, never grant extra access.
const FIRM_SESSION_COOKIE_MAX_AGE_SECONDS = store.SESSION_TTL_DAYS * 24 * 60 * 60;

// PREVIEW/STAGING cross-origin fix (2026-07-28): a preview deploy has the
// static site and the Worker on two different origins (pages.dev vs.
// workers.dev), so a Lax cookie is never sent on the dashboard's credentialed
// cross-origin fetch() calls -- the roster silently fails to load (401,
// looks like an auth bug, is really a cookie-scoping one). None=Secure fixes
// that, but ONLY when env.STATIC_SITE_BASE_URL is set (i.e. never in
// production, where Lax is the correct, tighter CSRF posture -- see the
// comment above these functions). Same gate used for CORS below.
function firmSessionCookieSameSite(env: Env): string {
  return env.STATIC_SITE_BASE_URL ? "None" : "Lax";
}

function firmSessionSetCookieHeader(rawSessionToken: string, env: Env): string {
  return (
    `${FIRM_SESSION_COOKIE_NAME}=${encodeURIComponent(rawSessionToken)}; HttpOnly; Secure; ` +
    `SameSite=${firmSessionCookieSameSite(env)}; Path=/; Max-Age=${FIRM_SESSION_COOKIE_MAX_AGE_SECONDS}`
  );
}

function firmSessionClearCookieHeader(env: Env): string {
  return `${FIRM_SESSION_COOKIE_NAME}=; HttpOnly; Secure; SameSite=${firmSessionCookieSameSite(env)}; Path=/; Max-Age=0`;
}

// ---------------------------------------------------------------------------
// FREE-TIER individual session cookie (2026-07-31, migration 0012).
//
// A DIFFERENT COOKIE NAME from the firm one, on purpose. If both principals
// shared `dr_firm_session`, a browser signed in as an individual would send
// a value that every firm-scoped route would then try to resolve -- and the
// only thing standing between that and a cross-principal bug would be
// store.verifySession() happening to miss. Separate names mean a firm route
// never even SEES an individual's token: getCookie() returns undefined and
// requireFirmSession() 401s before touching the database. It also means a
// person can be signed in as both at once (a firm admin who also tracks
// their own licence) without either session evicting the other.
const SUBSCRIBER_SESSION_COOKIE_NAME = "dr_sub_session";
// Mirrors store.SUBSCRIBER_SESSION_TTL_DAYS for the same reason the firm
// constant mirrors SESSION_TTL_DAYS: this is only the browser's copy of the
// expiry. verifySubscriberSession() re-checks the row's own expires_at on
// every request, so drift here can only ever expire the cookie EARLIER than
// the server-side session, never extend access.
const SUBSCRIBER_SESSION_COOKIE_MAX_AGE_SECONDS = store.SUBSCRIBER_SESSION_TTL_DAYS * 24 * 60 * 60;

function subscriberSessionSetCookieHeader(rawSessionToken: string, env: Env): string {
  return (
    `${SUBSCRIBER_SESSION_COOKIE_NAME}=${encodeURIComponent(rawSessionToken)}; HttpOnly; Secure; ` +
    `SameSite=${firmSessionCookieSameSite(env)}; Path=/; Max-Age=${SUBSCRIBER_SESSION_COOKIE_MAX_AGE_SECONDS}`
  );
}

function subscriberSessionClearCookieHeader(env: Env): string {
  return `${SUBSCRIBER_SESSION_COOKIE_NAME}=; HttpOnly; Secure; SameSite=${firmSessionCookieSameSite(env)}; Path=/; Max-Age=0`;
}

/** "north-carolina" -> "North Carolina", "california" -> "California". */
function stateNameFromSlug(slug: string): string {
  return slug
    .split("-")
    .map((w) => (w.length > 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function dailySendCap(env: Env): number {
  const n = Number.parseInt(env.REMINDERS_DAILY_SEND_CAP ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DAILY_SEND_CAP;
}

function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "0.0.0.0";
}

interface ResolvedDeadlineInput {
  deadlineFields: DeadlineFields;
  deadlineSource: string;
  userDeadline: string | null;
}

/**
 * Shared by handleSubscribe() (the public /subscribe form) and
 * handleFirmLicenseCreate()/handleFirmLicensePatch() (the firm dashboard's
 * add/edit-staff routes, added in the same build) -- the exact per-state
 * "what deadline-computation fields does this state need" logic, in ONE
 * place, so the dashboard's staff-add form and the public signup form can
 * never drift apart on what a valid submission for a given state looks like.
 * `stateSlug` must already be a validated member of SUPPORTED_STATE_SLUGS --
 * every caller checks that itself first (the error copy for an unsupported
 * slug differs slightly by caller: an HTML errorPage() for the public form,
 * a JSON error for the dashboard API).
 *
 * Returns the resolved fields on success, or an error Response the caller
 * should return immediately (an errorPage() -- callers that need a JSON
 * response instead read the same message off it; see toErrorMessage() below).
 */
function resolveDeadlineInput(stateSlug: string, form: Record<string, string>): ResolvedDeadlineInput | Response {
  const computable = isStateComputable(stateSlug);

  if (computable) {
    if (stateSlug === "california") {
      const birthMonth = form.birth_month;
      const birthYear = form.birth_year;
      if (!birthMonth || !birthYear || birthYear.length > 4 || !/^\d+$/.test(birthYear)) {
        return errorPage(400, "California needs your birth month and birth year.");
      }
      const birthMonthInt = strictParseInt(birthMonth);
      const birthYearInt = strictParseInt(birthYear);
      if (
        birthMonthInt === null ||
        birthYearInt === null ||
        birthMonthInt < 1 ||
        birthMonthInt > 12 ||
        birthYearInt < 1900 ||
        birthYearInt > 2100
      ) {
        return errorPage(400, "California needs a valid birth month and birth year.");
      }
      // Only the odd/even parity is ever persisted -- the full birth year is
      // used transiently right here and discarded (PII minimization), same
      // as server.py:345's comment.
      const parity = birthYearInt % 2 === 1 ? "odd" : "even";
      return {
        deadlineFields: { birth_month: String(birthMonthInt), birth_year_parity: parity },
        deadlineSource: store.DEADLINE_SOURCE_COMPUTED,
        userDeadline: null,
      };
    } else if (stateSlug === "texas") {
      const birthMonth = form.birth_month;
      if (!birthMonth) return errorPage(400, "Texas needs your birth month.");
      const birthMonthInt = strictParseInt(birthMonth);
      if (birthMonthInt === null || birthMonthInt < 1 || birthMonthInt > 12) {
        return errorPage(400, "Texas needs a valid birth month.");
      }
      return {
        deadlineFields: { birth_month: String(birthMonthInt) },
        deadlineSource: store.DEADLINE_SOURCE_COMPUTED,
        userDeadline: null,
      };
    } else if (stateSlug === "ohio") {
      const cohortGroup = form.cohort_group;
      if (cohortGroup !== "Group 1" && cohortGroup !== "Group 2" && cohortGroup !== "Group 3") {
        return errorPage(400, "Ohio needs your cohort group.");
      }
      return {
        deadlineFields: { cohort_group: cohortGroup },
        deadlineSource: store.DEADLINE_SOURCE_COMPUTED,
        userDeadline: null,
      };
    } else if (form.license_type_id) {
      const licenseTypeId = form.license_type_id;
      if (licenseTypeId.length > MAX_FIELD_LEN) {
        return errorPage(400, "Invalid license type.");
      }
      return {
        deadlineFields: { license_type_id: licenseTypeId },
        deadlineSource: store.DEADLINE_SOURCE_COMPUTED,
        userDeadline: null,
      };
    }
    return { deadlineFields: {}, deadlineSource: store.DEADLINE_SOURCE_COMPUTED, userDeadline: null };
  }

  // "Bring your own date": the worker has no way to derive this state's
  // deadline from state rules, so the subscriber supplies their own
  // (printed on their license). The <input type="date">'s HTML min/max
  // (generate.py) is a UX nicety only -- this is the real, authoritative
  // check, same "validation authority stays server-side" rule this file
  // already follows for every other per-state field.
  const rawDate = (form.license_expiration_date ?? "").trim();
  const parsedDate = parseStrictIsoDate(rawDate);
  if (!parsedDate) {
    return errorPage(400, "Please enter your license expiration date (a real calendar date).");
  }
  const now = new Date();
  const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (parsedDate.getTime() <= todayUtc.getTime()) {
    return errorPage(400, "That date has already passed -- please double-check your license.");
  }
  const maxDate = new Date(todayUtc.getTime() + USER_DEADLINE_MAX_DAYS * 86_400_000);
  if (parsedDate.getTime() > maxDate.getTime()) {
    return errorPage(400, "That date looks too far out -- please double-check your license.");
  }
  return { deadlineFields: {}, deadlineSource: store.DEADLINE_SOURCE_USER, userDeadline: rawDate };
}

async function handleSubscribe(request: Request, env: Env, ip: string): Promise<Response> {
  const allowed = await checkRateLimit(env.DB, ip, "subscribe", RATE_LIMIT_SUBSCRIBE);
  if (!allowed) {
    // AuditLab RL-2 (LOW, 2026-08-04): "later" doesn't tell a real person --
    // e.g. several colleagues at one shared office IP signing up together --
    // when to come back. The sibling firm-lead rate limit (handleFirmLead,
    // same 10-minute window) already says the concrete wait; this route
    // didn't. Matches that copy exactly rather than inventing new wording.
    return errorPage(429, "Too many signups from this address. Please try again in about 10 minutes.");
  }

  // Cap the decoded body size -- the equivalent hardening to server.py's
  // pre-read Content-Length check (see validation.ts's MAX_BODY_BYTES
  // docstring for why the ORIGINAL bug -- an unhandled ValueError from a
  // malformed Content-Length header -- cannot occur in a Workers fetch
  // handler, since nothing here manually parses that header).
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return errorPage(400, "Something went wrong processing that request.");
  }
  if (raw.length === 0 || raw.length > MAX_BODY_BYTES) {
    return errorPage(400, "Request too large or empty.");
  }

  let form: Record<string, string>;
  try {
    form = Object.fromEntries(new URLSearchParams(raw).entries());
  } catch {
    return errorPage(400, "Something went wrong processing that request.");
  }

  // Honeypot: ANY non-empty raw value (including whitespace-only -- checked
  // against the raw value, not a `.trim()`ed/truthy form, per the same
  // adversarial-review finding server.py:292 documents) means "silently do
  // nothing, but look like it worked."
  const honeypotValue = form[HONEYPOT_FIELD_NAME];
  if (honeypotValue !== undefined && honeypotValue !== "") {
    return htmlResponse(200, SUBSCRIBE_SUCCESS_PAGE);
  }

  for (const value of Object.values(form)) {
    if (hasControlChars(value)) {
      return errorPage(400, "Invalid characters in submission.");
    }
  }

  const email = (form.email ?? "").trim();
  const stateSlug = (form.state ?? "").trim();
  const firstNameRaw = (form.first_name ?? "").trim().slice(0, 60);
  const firstName = firstNameRaw.length > 0 ? firstNameRaw : null;

  if (!isValidEmail(email)) {
    return errorPage(400, "That doesn't look like a valid email address.");
  }
  // Task #7 (2026-08-06): operator-managed blocklist, unconditional (unlike
  // checkSignupDomainGate's existing-account exemption below in
  // handleFirmSignup) -- an entry here means an operator specifically
  // decided to block this address/domain, so it applies every time, not
  // just to brand-new signups.
  if (await store.isEmailBlocklisted(env.DB, email)) {
    return errorPage(400, "We're not able to add that address right now.");
  }
  if (!SUPPORTED_STATE_SLUGS.has(stateSlug)) {
    return errorPage(400, "Unsupported or missing state.");
  }

  const turnstileOk = await verifyTurnstile(form["cf-turnstile-response"], env.TURNSTILE_SECRET_KEY, true);
  if (!turnstileOk) {
    return errorPage(400, "Verification failed -- please try again.");
  }

  const resolved = resolveDeadlineInput(stateSlug, form);
  if (resolved instanceof Response) return resolved;
  const { deadlineFields, deadlineSource, userDeadline } = resolved;

  try {
    checkDataFreshness(new Date());
  } catch (err) {
    if (err instanceof StaleDataError) {
      return errorPage(503, `Signups are temporarily paused: ${err.message}`);
    }
    throw err;
  }

  // Deliberately NO "mailing address configured" gate here -- unlike
  // server.py:395, Phase 1 makes no promise of ever sending an email, so
  // there is no orphaned-record-with-no-confirmation-email risk that gate
  // existed to prevent. See ../PHASE1_NOTES.md.

  // Only the computed path needs the throwaway probe -- a user-provided date
  // was already validated directly above and doesn't go through
  // computeSubscriberDeadline() at all (see scheduler.ts's own
  // deadline_source branch for the read-side of this same split).
  if (
    deadlineSource === store.DEADLINE_SOURCE_COMPUTED &&
    computeSubscriberDeadline(stateSlug, deadlineFields, new Date()) === null
  ) {
    return errorPage(400, "Couldn't compute a deadline from what you gave us -- please check your inputs.");
  }

  // Dedupe (same email+state) is checked FIRST, unconditionally -- this is
  // what lets a genuine "I lost my confirmation email, let me try again"
  // resubmission actually resend something (below) instead of silently
  // doing nothing. A still-pending record has no time bound here on purpose:
  // whether it's 5 minutes or 5 days old, a repeat attempt for the exact
  // same email+state is someone who didn't finish confirming, not abuse.
  const existing = await store.findActiveOrPending(env.DB, email, stateSlug);
  if (existing) {
    if (existing.status === store.STATUS_PENDING && env.SENDGRID_API_KEY) {
      try {
        if (store.resendEligible(existing, new Date())) {
          const underCap = await checkAndCountActionSend(env.DB, dailySendCap(env));
          if (underCap) {
            const confirmUrl = `${actionBaseUrl(env)}/confirm?token=${encodeURIComponent(existing.confirm_token)}`;
            const unsubscribeUrl = `${actionBaseUrl(env)}/unsubscribe?token=${encodeURIComponent(existing.unsubscribe_token)}`;
            const built = buildConfirmationEmail(
              stateNameFromSlug(stateSlug),
              confirmUrl,
              unsubscribeUrl,
              existing.first_name,
              existing.user_deadline ? fmtDate(new Date(`${existing.user_deadline}T00:00:00Z`)) : null
            );
            await sendViaSendGrid(env.SENDGRID_API_KEY, existing.email, built, env.EMAIL_ALLOWLIST);
            await store.recordResend(env.DB, existing.id);
          }
        }
        // Not eligible yet (resent too recently) or over the daily cap: fall
        // through to the same generic response as every other path below --
        // still no oracle, since "nothing happened" and "we just resent it"
        // look identical from the outside, same as the original design.
      } catch {
        // Swallow, same reasoning as the first-send path below: a resend
        // failure must not surface differently than an ordinary duplicate.
      }
    }
    // A CONFIRMED existing record needs no resend -- they're already getting
    // reminders. Either way, same response as a brand-new signup: this
    // branch must never be distinguishable from one (no-enumeration-oracle).
    return htmlResponse(200, SUBSCRIBE_SUCCESS_PAGE);
  }

  // No record for this exact email+state. The broader per-IDENTITY cooldown
  // (ANY state, SIGNUP_COOLDOWN_HOURS) still applies here -- this is the real
  // mail-bombing backstop (stops a burst of brand-new confirmation emails
  // across many different states from hitting one inbox) and stays silent on
  // purpose: giving it distinct copy would create a NEW oracle ("this address
  // signed up recently, just for a different state") that doesn't exist
  // today. The resend fix above only ever applies to a matching email+state,
  // so it can't be used to route around this cooldown by varying the state.
  const cooldownHit = await store.withinSignupCooldown(env.DB, email);
  if (cooldownHit) {
    return htmlResponse(200, SUBSCRIBE_SUCCESS_PAGE);
  }

  const record = await store.addPending(env.DB, {
    email,
    stateSlug,
    deadlineFields,
    firstName,
    deadlineSource,
    userDeadline,
  });

  // Send the double-opt-in confirmation email. Best-effort and fully isolated:
  //   - Only when a SendGrid key is configured (absent key => capture-only).
  //   - Guarded by the daily circuit breaker (checkAndCountActionSend) so a
  //     burst can never blow past the cap and torch sender reputation.
  //   - Wrapped so ANY failure (SendGrid down, cap hit, build error) never
  //     turns an already-stored signup into an error response. The record is
  //     persisted regardless; the user sees the same success page either way,
  //     which also preserves the no-enumeration-oracle property.
  if (env.SENDGRID_API_KEY) {
    try {
      const underCap = await checkAndCountActionSend(env.DB, dailySendCap(env));
      if (underCap) {
        const confirmUrl = `${actionBaseUrl(env)}/confirm?token=${encodeURIComponent(record.confirm_token)}`;
        const unsubscribeUrl = `${actionBaseUrl(env)}/unsubscribe?token=${encodeURIComponent(record.unsubscribe_token)}`;
        const built = buildConfirmationEmail(
          stateNameFromSlug(stateSlug),
          confirmUrl,
          unsubscribeUrl,
          record.first_name,
          record.user_deadline ? fmtDate(new Date(`${record.user_deadline}T00:00:00Z`)) : null
        );
        await sendViaSendGrid(env.SENDGRID_API_KEY, record.email, built, env.EMAIL_ALLOWLIST);
      }
    } catch {
      // Swallow -- the signup is stored; a confirmation-email failure is not
      // the subscriber's problem and must not fail their request.
    }
  }

  return htmlResponse(200, SUBSCRIBE_SUCCESS_PAGE);
}

// Same "one generic response regardless of which internal branch ran"
// no-enumeration-oracle posture as SUBSCRIBE_SUCCESS_PAGE above -- a real
// insert and a honeypot no-op must look identical from the outside.
//
// COPY FIX (2026-08-05, orchestrator live-test): this used to say "we'll
// email you the moment self-serve signup opens... no account has been
// created yet" -- stale from before self-serve firm signup existed. A
// prospect who filled out THIS lower-commitment "just leave your email"
// form specifically because they weren't ready to commit was told to wait
// for a launch that already happened, instead of being pointed at the
// signup they could complete right now -- a real, avoidable lost
// conversion. Now offers the real signup link unconditionally, same
// pattern as firmLoginSentPage()'s "New here? create your account" line.
function firmLeadSuccessPage(env: Env): string {
  const homeUrl = env.STATIC_SITE_BASE_URL || "";
  return htmlPage(
    "You've got it saved",
    "<h1>You've got it saved</h1><p>We've got your info and may follow up. If you're ready now, " +
      `self-serve signup is live &mdash; <a href="${homeUrl}/firm-login/">create your firm account</a> ` +
      "any time, no waiting required.</p>" +
      `<p><a href="${homeUrl}/">&larr; Back to the homepage</a></p>`
  );
}

/**
 * POST /api/firm/lead -- the /for-firms/ page's "reserve early access" form
 * (generate.py's build_firms_page()). Structurally the same hardening as
 * handleSubscribe() above (rate limit -> body-size cap -> honeypot ->
 * control-char check -> email format -> Turnstile), deliberately simpler
 * where the two genuinely differ: no confirmation email, no token/lifecycle
 * fields, and no dedupe-by-cooldown-key -- a firm_leads row isn't a consent
 * record and this endpoint never sends anyone anything, so a repeat
 * submission from the same address isn't a mail-bombing vector the way a
 * repeat /subscribe would be. See store.addFirmLead()'s own docstring for
 * why this deliberately does not reuse the subscribers table/lifecycle.
 */
async function handleFirmLead(request: Request, env: Env, ip: string): Promise<Response> {
  const allowed = await checkRateLimit(env.DB, ip, "firm_lead", RATE_LIMIT_FIRM_LEAD);
  if (!allowed) {
    // Orchestrator abuse-test pass (2026-08-05, LOW, 4 UX defects fired via
    // real 429 testing): the generic errorPage() gave this real, user-
    // facing throttle no Retry-After header, a bare "Error" <title>, no
    // <h1> (unlike this route's own 200 success page), and no way back to
    // /for-firms/. Purpose-built response fixes all four. Typed firm name/
    // email being lost on throttle is real too (this is a full-page POST,
    // not AJAX) but isn't fixed here -- echoing submitted values back would
    // mean parsing the body BEFORE the rate-limit check, reordering a
    // security-relevant check ahead of doing real work for an IP already
    // being throttled; left as a separate, deliberate follow-up rather than
    // bundled into this fix.
    const homeUrl = env.STATIC_SITE_BASE_URL || "";
    return new Response(
      htmlPage(
        "Slow down a little",
        "<h1>Slow down a little</h1><p>Too many submissions from this address. Please try again in about " +
          "10 minutes.</p>" +
          `<p><a href="${homeUrl}/for-firms/">&larr; Back to DeadlineRadar for Firms</a></p>`,
        homeUrl
      ),
      { status: 429, headers: { "Content-Type": "text/html; charset=utf-8", "Retry-After": String(RATE_LIMIT_FIRM_LEAD.windowSeconds) } }
    );
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return errorPage(400, "Something went wrong processing that request.");
  }
  if (raw.length === 0 || raw.length > MAX_BODY_BYTES) {
    return errorPage(400, "Request too large or empty.");
  }

  let form: Record<string, string>;
  try {
    form = Object.fromEntries(new URLSearchParams(raw).entries());
  } catch {
    return errorPage(400, "Something went wrong processing that request.");
  }

  // Honeypot: same "any non-empty raw value, including whitespace-only"
  // check as handleSubscribe() -- silently looks like success to a bot.
  const honeypotValue = form[HONEYPOT_FIELD_NAME];
  if (honeypotValue !== undefined && honeypotValue !== "") {
    return htmlResponse(200, firmLeadSuccessPage(env));
  }

  for (const value of Object.values(form)) {
    if (hasControlChars(value)) {
      return errorPage(400, "Invalid characters in submission.");
    }
  }

  const email = (form.email ?? "").trim();
  if (!isValidEmail(email)) {
    return errorPage(400, "That doesn't look like a valid email address.");
  }

  const turnstileOk = await verifyTurnstile(form["cf-turnstile-response"], env.TURNSTILE_SECRET_KEY, true);
  if (!turnstileOk) {
    return errorPage(400, "Verification failed -- please try again.");
  }

  const firmNameRaw = (form.firm_name ?? "").trim().slice(0, MAX_FIRM_NAME_LEN);
  const firmName = firmNameRaw.length > 0 ? firmNameRaw : null;
  const staffCountHintRaw = (form.staff_count_hint ?? "").trim().slice(0, MAX_STAFF_COUNT_HINT_LEN);
  const staffCountHint = staffCountHintRaw.length > 0 ? staffCountHintRaw : null;

  await store.addFirmLead(env.DB, { email, firmName, staffCountHint });

  return htmlResponse(200, firmLeadSuccessPage(env));
}

// ---------------------------------------------------------------------------
// migration 0008 -- firm accounts + login/session auth. This is the repo's
// FIRST real login system: every route above this line is a capability-URL
// token (one purpose, then inert), never a standing account. Auth-bypass is
// the top risk here (a later step adversarially tests whether firm A's
// admin can ever see firm B's data) -- requireFirmSession() at the bottom
// of this section is the ONE place every future firm-scoped route (staff
// CRUD, the dashboard itself -- neither built in this step) must call
// first, and is written to make that a single obvious line, not something
// easy to forget.
// ---------------------------------------------------------------------------

// Same anti-enumeration posture as SUBSCRIBE_SUCCESS_PAGE / FIRM_LEAD_SUCCESS_PAGE
// above: /firm/signup and /firm/login BOTH return this exact page regardless
// of which internal branch ran (new firm created, existing firm found and
// re-sent a link, honeypot no-op, or -- for /firm/login only -- no firm at
// all for that email). The copy is deliberately non-committal ("if that
// address has...") so it's truthful in every branch and never reveals
// whether a given email has an account.
/**
 * 2026-07-30 (UX fix): a first-time firm submitting the Sign In form here
 * used to land on this exact page with ZERO navigation and ZERO email ever
 * sent (handleFirmLogin no-ops for an unknown email, by design -- see its
 * own anti-enumeration comment) -- a real dead end for a brand-new
 * customer. Two additions, both deliberately generic (shown identically
 * regardless of whether the submitted email actually has an account, so
 * the anti-enumeration property this page exists for is unchanged): a
 * pointer to the Create-account form for anyone who doesn't already have
 * one, and a way back to the site instead of a blank terminal page.
 * `env.STATIC_SITE_BASE_URL` is the same preview-vs-production absolute-
 * vs-relative link pattern already used for the /firm/login/verify and
 * /firm/logout redirects just below.
 */
/** Short-lived cookie binding an in-flight OAuth handshake to the browser
 * that started it (migration 0011). SameSite=Lax is required, not Lax by
 * habit: the callback arrives as a cross-site TOP-LEVEL GET navigation
 * from the provider, which Lax permits and Strict would block -- Strict
 * here would break every SSO sign-in. 10 minutes matches the handshake TTL. */
const OAUTH_HANDSHAKE_COOKIE_NAME = "dr_oauth_handshake";

function oauthHandshakeSetCookieHeader(rawBinding: string): string {
  return (
    `${OAUTH_HANDSHAKE_COOKIE_NAME}=${encodeURIComponent(rawBinding)}; HttpOnly; Secure; ` +
    `SameSite=Lax; Path=/; Max-Age=600`
  );
}

/** Clears the short-lived handshake cookie. AuditLab SSO-D, 2026-08-03: this
 * existed with a docstring claiming exactly this, but no callback response
 * ever actually sent it -- harmless (the state row behind it is already
 * single-use and the cookie self-expires at 600s regardless), but a comment
 * claiming a control that isn't wired in is worse than no comment. Now
 * called from every successful-callback response via oauthSuccessResponse(). */
function oauthHandshakeClearCookieHeader(): string {
  return `${OAUTH_HANDSHAKE_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

/** The 302-with-session-cookie response every successful SSO callback
 * branch (existing identity, race-fallback, fresh link) returns. Also clears
 * the handshake cookie -- see oauthHandshakeClearCookieHeader(). */
function oauthSuccessResponse(env: Env, rawSessionToken: string): Response {
  const headers = new Headers({ Location: `${env.STATIC_SITE_BASE_URL || ""}/firm-dashboard/` });
  headers.append("Set-Cookie", firmSessionSetCookieHeader(rawSessionToken, env));
  headers.append("Set-Cookie", oauthHandshakeClearCookieHeader());
  return new Response(null, { status: 302, headers });
}

/** One message for every credential failure -- no such firm, no password
 * set, wrong password. Distinct wording per branch would rebuild exactly
 * the enumeration oracle the timing equalization exists to close. */
const INVALID_CREDENTIALS_MESSAGE = "That email and password combination isn't right.";

const SSO_FAILED_MESSAGE = "We couldn't complete that sign-in. Please try again.";

const SSO_UNVERIFIED_EMAIL_MESSAGE =
  "Your provider didn't confirm that email address is verified, so we can't connect it to a DeadlineRadar account. Please verify the address with your provider and try again.";

const SSO_NO_ACCOUNT_MESSAGE =
  "We couldn't find a DeadlineRadar firm account for that email address. Please create your firm account first, then connect this sign-in method.";

const SSO_EMAIL_REASSIGNED_MESSAGE =
  "This sign-in method was connected under a different admin email, which has since changed. Please sign in with the current admin email (or a password/magic link) and reconnect it from the Account tab.";

// AuditLab ROLE-1 (MEDIUM, 2026-08-07): migration 0045 gave every firm more
// than one signed-in identity, each with its own role -- but
// firm_oauth_identities has no member_id column (a known, flagged scope
// limit -- see handleOauthCallback()'s own comment), so createSession()
// falls back to the firm's PRIMARY member whenever no memberId is passed.
// A brand-new Google link for a NON-primary member's verified email would
// silently mint a session attributed to the PRIMARY member (a Partner) --
// a real privilege-escalation path the moment any endpoint gates on role,
// which requireFirmRole() now does. Cheapest correct fix until per-member
// OAuth linking exists: refuse to link/sign-in via SSO for anyone who
// isn't the firm's primary member. Fails closed, and matches this
// account's actual pre-0045 behavior exactly (there was only ever one
// person to resolve to). The already-linked-identity branch above needs no
// equivalent check: by the time this restriction is in place, every row
// that can ever exist in firm_oauth_identities was linked by a primary
// member, so it can never point at anyone else.
const SSO_NON_PRIMARY_MEMBER_MESSAGE =
  "Google sign-in is available for your firm's primary contact only right now. Please sign in with a password or emailed link instead.";

// AuditLab SSO-C, 2026-08-03: every SSO error page was a dead end -- the
// `link` param errorPage() grew in 38baca94 specifically to kill this class
// of page, but SSO never actually used it. Two destinations cover all of
// them: back to sign-in (works for anything the reader can just retry or
// switch method for) and contact (the two suspended-firm cases, where
// retrying accomplishes nothing).
function ssoSigninLink(env: Env): { href: string; text: string } {
  return { href: `${env.STATIC_SITE_BASE_URL || ""}/firm-login/`, text: "Go to firm sign-in" };
}
function ssoContactLink(env: Env): { href: string; text: string } {
  return { href: `${env.STATIC_SITE_BASE_URL || ""}/contact/`, text: "Contact us" };
}

function firmLoginSentPage(env: Env): string {
  const homeUrl = env.STATIC_SITE_BASE_URL || "";
  return htmlPage(
    "Check your email",
    "<h1>Check your email</h1><p>If that email has (or can have) a DeadlineRadar firm account, we've " +
      "just sent a sign-in link. It expires in 15 minutes and works once &mdash; if it's expired by " +
      "the time you click it, just request a new one.</p>" +
      `<p>New here? If you haven't created a firm account yet, nothing will arrive for that address &mdash; ` +
      `<a href="${homeUrl}/firm-login/">create your account</a> instead.</p>` +
      `<p><a href="${homeUrl}/">&larr; Back to the homepage</a></p>`
  );
}

/**
 * The one response POST /subscriber/login ever returns -- real send,
 * no-such-subscriber, and honeypot alike. See that handler's own comment
 * for why the branch must be invisible.
 *
 * The second paragraph is what stops this being a dead end for someone who
 * never signed up: it can't ask "did you mean to create an account?"
 * conditionally without leaking the branch, so it offers the signup path
 * unconditionally, to everyone, as ordinary copy.
 */
function subscriberLoginSentPage(env: Env): string {
  const homeUrl = env.STATIC_SITE_BASE_URL || "";
  return htmlPage(
    "Check your email",
    "<h1>Check your email</h1><p>If we're tracking any renewal deadlines for that address, we've " +
      "just sent a sign-in link. It expires in 15 minutes and works once &mdash; if it's expired by " +
      "the time you click it, just request a new one.</p>" +
      `<p>Not signed up yet? Nothing will arrive for an address we don't have &mdash; ` +
      `<a href="${homeUrl}/">pick your state</a> to start getting free renewal reminders.</p>`
  );
}

/**
 * Shared by handleFirmSignup() and handleFirmLogin(): issues a login token
 * for `firmId` and, best-effort, emails it. Wrapped so ANY failure (SendGrid
 * down, daily cap hit, build error) never surfaces as an error response --
 * same posture as handleSubscribe()'s confirmation-email send: the caller
 * always returns the same generic success page regardless of whether this
 * actually sent anything, both for anti-enumeration and because a mail
 * failure here must not be the requester's problem.
 *
 * Deliberately follows /subscribe's existing "no SENDGRID_API_KEY => no-op,
 * don't crash" convention (see env.ts's own docstring) -- unconfigured
 * sending degrades to "token created in the DB, nothing emailed" rather
 * than an error.
 */
async function issueAndSendFirmLoginLink(
  env: Env,
  firmId: string,
  adminEmail: string,
  purpose: store.LoginTokenPurpose = "login",
  adminName: string | null = null,
  /** migration 0045: WHICH member this link is for -- optional (defaults
   * to the firm's primary_member_id inside createLoginToken()), but every
   * caller that has already resolved a SPECIFIC member (e.g. a
   * non-primary member requesting their own "email me a sign-in link")
   * must pass it explicitly, or the token would silently default to the
   * primary contact regardless of who actually asked. */
  memberId?: string
): Promise<void> {
  const { rawToken } = await store.createLoginToken(env.DB, firmId, purpose, undefined, memberId);
  if (!env.SENDGRID_API_KEY) return;
  try {
    const underCap = await checkAndCountActionSend(env.DB, dailySendCap(env));
    if (!underCap) return;
    const loginUrl = `${actionBaseUrl(env)}/firm/login/verify?token=${encodeURIComponent(rawToken)}`;
    // COPY HONESTY (2026-07-31): a link issued from "Forgot password" must
    // say it leads to setting a password. An email promising a plain sign-in
    // and then landing on a password screen is the same class of mismatch as
    // the bug this fixes, just pointed the other way.
    const built = buildFirmLoginEmail(loginUrl, purpose === "password_reset", adminName);
    await sendViaSendGrid(env.SENDGRID_API_KEY, adminEmail, built, env.EMAIL_ALLOWLIST);
  } catch {
    // Swallow -- same reasoning as every other best-effort send in this
    // file: the caller's response must never depend on whether this
    // succeeded.
  }
}

const ROLE_LABELS: Record<store.FirmMemberRole, string> = {
  partner: "Partner",
  office_manager: "Office Manager",
  staff: "Staff",
};

/**
 * migration 0045 (roadmap #11/#13/#14): issues the SAME kind of "login"-
 * purpose token issueAndSendFirmLoginLink() does, just for a brand-new
 * member instead of a returning one -- clicking it lands on the ordinary
 * /firm/login/verify flow, which already handles "this member has never
 * signed in before" via markFirmMemberJoined(), so no separate accept
 * endpoint is needed. Only the EMAIL COPY differs (buildFirmMemberInviteEmail
 * instead of buildFirmLoginEmail), since the recipient has no prior context.
 *
 * demo_locked NOT checked here (see check_demo_locked_email_coverage()'s
 * allowlist entry for this function in preship_gate.py): handleFirmMemberInvite()
 * below 403s the WHOLE request for a demo_locked firm before this is ever
 * called, the same front-door posture handleFirmPasswordSet()/
 * handleFirmChangeEmailRequest()/handleFirmAccountDelete() already use --
 * an invite creates a real login-capable identity from an admin-suppliable
 * address, which is exactly the class of self-serve credential path Devin
 * ruled out entirely for the shared demo account.
 */
async function issueAndSendFirmMemberInviteEmail(
  env: Env,
  firmId: string,
  memberId: string,
  email: string,
  firmName: string,
  roleLabel: string,
  inviterName: string | null
): Promise<void> {
  const { rawToken } = await store.createLoginToken(env.DB, firmId, "login", undefined, memberId);
  if (!env.SENDGRID_API_KEY) return;
  try {
    const underCap = await checkAndCountActionSend(env.DB, dailySendCap(env));
    if (!underCap) return;
    const loginUrl = `${actionBaseUrl(env)}/firm/login/verify?token=${encodeURIComponent(rawToken)}`;
    const built = buildFirmMemberInviteEmail(loginUrl, firmName, roleLabel, inviterName);
    await sendViaSendGrid(env.SENDGRID_API_KEY, email, built, env.EMAIL_ALLOWLIST);
  } catch {
    // Swallow -- same reasoning as issueAndSendFirmLoginLink() above.
  }
}

/**
 * POST /firm/signup -- body: `name` (firm name), `admin_email`. Same
 * hardening pipeline as handleFirmLead() (rate limit -> body-size cap ->
 * honeypot -> control-char check -> email format -> Turnstile).
 *
 * Anti-enumeration judgment call: if `admin_email` already has a firm, this
 * does NOT create a second one and does NOT say so -- it just sends that
 * firm a fresh login link, exactly like a /firm/login request would. An
 * attacker probing "does this email already have an account" gets the
 * identical response either way (firmLoginSentPage(env)), matching this
 * codebase's existing SUBSCRIBE_SUCCESS_PAGE / FIRM_LEAD_SUCCESS_PAGE
 * convention of one generic response regardless of internal branch.
 */
async function handleFirmSignup(request: Request, env: Env, ip: string): Promise<Response> {
  const allowed = await checkRateLimit(env.DB, ip, "firm_signup", RATE_LIMIT_FIRM_SIGNUP);
  if (!allowed) {
    return errorPage(429, "Too many requests from this address. Please try again later.");
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return errorPage(400, "Something went wrong processing that request.");
  }
  if (raw.length === 0 || raw.length > MAX_BODY_BYTES) {
    return errorPage(400, "Request too large or empty.");
  }

  let form: Record<string, string>;
  try {
    form = Object.fromEntries(new URLSearchParams(raw).entries());
  } catch {
    return errorPage(400, "Something went wrong processing that request.");
  }

  const honeypotValue = form[HONEYPOT_FIELD_NAME];
  if (honeypotValue !== undefined && honeypotValue !== "") {
    return htmlResponse(200, firmLoginSentPage(env));
  }

  for (const value of Object.values(form)) {
    if (hasControlChars(value)) {
      return errorPage(400, "Invalid characters in submission.");
    }
  }

  const email = (form.admin_email ?? "").trim();
  if (!isValidEmail(email)) {
    return errorPage(400, "That doesn't look like a valid email address.");
  }
  // Task #7 (2026-08-06): see handleSubscribe()'s own comment on this same
  // check for why it's unconditional, ahead of the existing-account
  // exemption the disposable/competitor domain gate below still has.
  if (await store.isEmailBlocklisted(env.DB, email)) {
    return errorPage(400, "We're not able to add that address right now.");
  }
  const nameRaw = (form.name ?? "").trim().slice(0, MAX_FIRM_NAME_LEN);
  if (nameRaw.length === 0) {
    return errorPage(400, "Please enter your firm's name.");
  }
  // Optional (2026-08-05, Devin: "to make the email more personal when I
  // email them") -- never required, same "empty -> null, never an error"
  // convention as handleSubscribe()'s first_name field. AuditLab review
  // (2026-08-05): sanitizeFreeText() strips C1 control chars (U+0080-U+009F)
  // that the blanket hasControlChars() sweep above does not cover (that regex
  // is /[\x00-\x1f\x7f]/, ASCII-only) -- no exploitable path today (this
  // field only ever reaches an email BODY greeting, never a subject/header),
  // but every other free-text field in this file uses sanitizeFreeText(), and
  // matching that standard here costs nothing.
  const adminName = sanitizeFreeText(form.admin_name, MAX_ADMIN_NAME_LEN);

  // Trial gate (2026-07-30, BUILD v2 item 4): a free-pilot firm account is a
  // real product surface a competitor could use to see how this works. Looked
  // up BEFORE the gate (not after) and skipped entirely when a firm already
  // exists for this email -- an adversarial RE-QA pass on the first version
  // of this gate (which ran unconditionally) correctly caught that blocking
  // an EXISTING account's repeat visit to the signup form would be a real
  // regression from today's silent-resend behavior, and that this product's
  // own target market includes solo practitioners who may only have a
  // personal-email-provider address as their "business" email -- an already-
  // created account under such a domain must keep working. This does mean
  // POST /firm/signup's response can now distinguish "blocked domain, has an
  // account" (generic resend) from "blocked domain, no account" (explicit
  // 400) -- a narrow anti-enumeration exception scoped ONLY to the 24
  // hardcoded domains in validation.ts, accepted as the better tradeoff (see the
  // "existing account" test for exactly what this proves).
  // Deliberately NOT applied to /firm/login at all: an existing account must
  // always be able to sign back in regardless of what domain it was created
  // under. Exempts env.EMAIL_ALLOWLIST addresses (preview/staging only, never
  // set in production -- see sender.ts's isEmailAllowlisted docstring) so a
  // real tester can still stand up a preview firm under their own personal
  // address, same posture as the rest of this Worker's EMAIL_ALLOWLIST gate.
  // migration 0045: findFirmMemberByEmail(), not findFirmByAdminEmail() --
  // the member table is the authoritative "does this email already have
  // firm access anywhere" answer now (a firm's admin_email is a mirror of
  // its PRIMARY member's email, which is not necessarily every member's
  // email).
  const existing = await store.findFirmMemberByEmail(env.DB, email);
  if (!existing && !isEmailAllowlisted(env.EMAIL_ALLOWLIST, email)) {
    const domainGate = checkSignupDomainGate(email);
    if (domainGate.blocked) {
      // Distinct copy per reason. A disposable address is a deliverability
      // problem the user can fix in seconds by using a real one, and saying
      // so is more useful than a generic refusal -- this product's entire
      // value is emailing you before a deadline, which a temp-mail address
      // structurally cannot receive.
      return errorPage(
        400,
        domainGate.reason === "disposable"
          ? "That looks like a temporary or disposable email address. DeadlineRadar works by emailing " +
              "you before your renewal is due, so please use an address you'll still be able to read " +
              "in a year -- a personal address is completely fine."
          : "We don't offer trial accounts to other compliance-software vendors."
      );
    }
  }

  // AuditLab TS-1 (2026-08-05, revised after correction): this is the ONE
  // relaxed route that also writes a real, persistent row (a new `firms`
  // row with an attacker-chosen name) -- unlike the other 4 relaxed routes,
  // where a token-less submission can only cause an email to be sent.
  // AuditLab's explicit revised recommendation was to re-require the token
  // HERE specifically while leaving the email-only routes relaxed, so this
  // does NOT pass allowMissingToken. An ad-blocked visitor hitting this one
  // still gets a real, actionable error instead of the original silent dead
  // end: the informational notice near the widget (visible after ~4s if it
  // never resolves) plus this message's own explicit "allow
  // challenges.cloudflare.com" instruction -- the fallback for THIS one
  // route is a clear explanation, not a bypass.
  const turnstileOk = await verifyTurnstile(form["cf-turnstile-response"], env.TURNSTILE_SECRET_KEY);
  if (!turnstileOk) {
    return errorPage(
      400,
      "Verification failed. If you use an ad blocker or privacy extension, allow " +
        "challenges.cloudflare.com for this page and try again."
    );
  }

  // AuditLab F-4, 2026-08-02: `existing` was checked above, but nothing
  // stopped two concurrent signups for the same email from BOTH seeing
  // `existing === null` and both reaching createFirm() -- a plain TOCTOU
  // window, reproduced with two concurrent requests from the same IP (the
  // rate-limit bucket doesn't serialize them). Migration 0015 added a
  // UNIQUE index on the normalized admin_email specifically so the LOSING
  // insert now fails loudly instead of silently creating an unreachable
  // second row (findFirmByAdminEmail() is LIMIT 1 with no ORDER BY -- only
  // one of the two would ever be reachable by any auth path, orphaning the
  // other's roster). Caught here and re-read, same posture as
  // handleOauthCallback()'s existing linkOauthIdentity() race handling: a
  // concurrent winner is not an error condition for THIS request, it's the
  // expected outcome of the exact race this migration exists to survive.
  let firmId: string;
  let memberId: string;
  // Existing member's own stored name (if any) wins on a resend -- this
  // request's adminName field only ever applies to a BRAND NEW firm; a
  // repeat /firm/signup submission must not silently overwrite a name the
  // member already has on file (or blank it out, if this attempt left the
  // field empty).
  let resolvedAdminName = adminName;
  if (existing) {
    firmId = existing.firm_id;
    memberId = existing.id;
    resolvedAdminName = existing.name;
  } else {
    try {
      const created = await store.createFirm(env.DB, {
        name: nameRaw,
        adminEmail: email,
        adminName,
        tosAcceptedVersion: TERMS_VERSION,
      });
      firmId = created.id;
      memberId = created.memberId;
    } catch {
      const raced = await store.findFirmMemberByEmail(env.DB, email);
      if (!raced) throw new Error("firm signup: insert failed and no concurrent winner found");
      firmId = raced.firm_id;
      memberId = raced.id;
      resolvedAdminName = raced.name;
    }
  }

  // AuditLab RL-7 (2026-08-06): second bucket keyed on the RECIPIENT, same
  // shape as RL-6's fix on /firm/login just above. Unlike that route, this
  // one always sends on every non-blocked, Turnstile-passed submission (no
  // anti-enumeration branch to piggyback on -- the domain gate above already
  // distinguishes "has an account" from "doesn't" for blocked domains), so
  // the bucket is charged unconditionally right before the send.
  const signupAccountAllowed = await checkRateLimit(
    env.DB,
    `account:${store.normalizeEmail(email)}`,
    "firm_signup_account",
    RATE_LIMIT_FIRM_SIGNUP_ACCOUNT
  );
  if (!signupAccountAllowed) {
    return errorPage(429, "Too many requests for this account. Please try again later.");
  }

  await issueAndSendFirmLoginLink(env, firmId, email, undefined, resolvedAdminName, memberId);

  return htmlResponse(200, firmLoginSentPage(env));
}

/**
 * POST /firm/login -- body: `admin_email` only. If a firm exists for that
 * email, issues + emails a fresh login link. If NOT, this is a silent no-op
 * -- but the response is IDENTICAL either way (firmLoginSentPage(env)): never
 * reveal whether a given email has an account.
 */
async function handleFirmLogin(request: Request, env: Env, ip: string): Promise<Response> {
  const allowed = await checkRateLimit(env.DB, ip, "firm_login", RATE_LIMIT_FIRM_LOGIN);
  if (!allowed) {
    return errorPage(429, "Too many requests from this address. Please try again later.");
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return errorPage(400, "Something went wrong processing that request.");
  }
  if (raw.length === 0 || raw.length > MAX_BODY_BYTES) {
    return errorPage(400, "Request too large or empty.");
  }

  let form: Record<string, string>;
  try {
    form = Object.fromEntries(new URLSearchParams(raw).entries());
  } catch {
    return errorPage(400, "Something went wrong processing that request.");
  }

  const honeypotValue = form[HONEYPOT_FIELD_NAME];
  if (honeypotValue !== undefined && honeypotValue !== "") {
    return htmlResponse(200, firmLoginSentPage(env));
  }

  for (const value of Object.values(form)) {
    if (hasControlChars(value)) {
      return errorPage(400, "Invalid characters in submission.");
    }
  }

  const email = (form.admin_email ?? "").trim();
  if (!isValidEmail(email)) {
    return errorPage(400, "That doesn't look like a valid email address.");
  }

  const turnstileOk = await verifyTurnstile(form["cf-turnstile-response"], env.TURNSTILE_SECRET_KEY, true);
  if (!turnstileOk) {
    return errorPage(400, "Verification failed -- please try again.");
  }

  // Which affordance the user came from. Client-supplied, and that is fine:
  // it only decides what the user is asking FOR, and the answer is then
  // written onto the server-side token row. An attacker submitting
  // intent=reset for someone else's address cannot reach the resulting link
  // -- it goes to that account's own inbox, exactly like any other magic
  // link. What they must never be able to do is flip the meaning of a token
  // at REDEMPTION time, which is why the purpose is stored, not passed
  // through the URL. See migration 0013.
  //
  // M2 (adversarial review, 2026-08-05, Task #29): store.normalizeLoginTokenPurpose()
  // widened to also accept "email_change" for POST /firm/change-email's own
  // use -- but THIS is an unauthenticated, pre-session form, and
  // "email_change" is a privileged purpose that's only ever supposed to be
  // mintable by an already-signed-in admin who supplied a real target
  // address. Letting this form pass "email_change" through would let
  // anyone mint one (with pending_new_email left NULL, since this form has
  // no such field) for ANY existing firm's email -- harmless today only
  // because handleFirmLoginVerify()'s apply branch happens to also check
  // `result.pendingNewEmail`, which is one future edit away from being the
  // only thing standing between "unauthenticated request" and "privileged
  // token minted." Restricted to exactly the two intents this form can
  // legitimately produce, independent of whatever normalizeLoginTokenPurpose()
  // accepts elsewhere.
  const purpose = form.intent === "password_reset" ? "password_reset" : "login";

  // migration 0045: findFirmMemberByEmail(), not findFirmByAdminEmail() --
  // resolves the SPECIFIC member requesting a link, which may not be the
  // firm's primary contact.
  const existingMember = await store.findFirmMemberByEmail(env.DB, email);
  const existingFirm = existingMember ? await store.getFirmById(env.DB, existingMember.firm_id) : null;
  // AuditLab re-verify follow-up, 2026-08-03: a suspended firm's magic link
  // still redeems to a 403 (requireFirmSession()/handleFirmLoginVerify()
  // both check status), so this was never an access gap -- but sending the
  // email at all spends one send from the GLOBAL daily cap shared with the
  // real reminder cron, and mails an account that's been cut off for a
  // reason. `existingFirm.status === "active"` added to the SAME condition
  // (not a separate branch) -- the response stays byte-identical to "no
  // firm for this email" either way, so this does not introduce a new
  // enumeration signal.
  if (existingMember && existingFirm && existingFirm.status === "active") {
    // AuditLab RL-6 (2026-08-06): second bucket keyed on the RECIPIENT, same
    // rationale/shape as handleSubscriberLoginRequest()'s account bucket --
    // the per-IP bucket above cannot see a distributed mail-bomb aimed at
    // one firm admin. Charged only on this branch (a send would actually
    // fire), so an attacker probing addresses with no active firm cannot
    // spend it, and the response below stays identical either way -- no new
    // enumeration signal.
    const accountAllowed = await checkRateLimit(
      env.DB,
      `account:${store.normalizeEmail(email)}`,
      "firm_login_account",
      RATE_LIMIT_FIRM_LOGIN_ACCOUNT
    );
    if (accountAllowed) {
      await issueAndSendFirmLoginLink(env, existingMember.firm_id, email, purpose, existingMember.name, existingMember.id);
    }
  }
  // No firm for this email, an inactive one, or the account bucket above was
  // exhausted: fall through to the SAME response, sending nothing -- this is
  // the anti-enumeration branch this handler exists for.

  return htmlResponse(200, firmLoginSentPage(env));
}

/**
 * POST /firm/login/verify -- verifies + consumes the raw login token, and on
 * success creates a session and sets the session cookie. Follows this
 * Worker's standard GET-render/POST-act pattern (same as /confirm,
 * /unsubscribe, /renewed, /rearm -- see ACTION_PAGES/ACTION_PATHS): the
 * emailed link itself only renders a "Sign in" button (actionConfirmPage()),
 * this handler only runs when that button's POST arrives. An earlier version
 * of this route acted directly on GET (the standard "magic link" UX), but
 * corporate mail-security gateways (Microsoft Defender Safe Links and
 * similar, common at CPA firms -- exactly this product's buyer) routinely
 * prefetch links server-side before the human clicks, which would burn the
 * single-use token on the scanner's own request and leave the real admin
 * stuck on "invalid or expired" every time. Render-then-POST avoids that
 * failure mode entirely, at the cost of one extra click.
 *
 * `optionalNewPassword` (2026-08-02): signup never asked for a password, and
 * the only way to set one afterward was to find the account panel buried in
 * the dashboard -- in practice nobody did. actionConfirmPage() now offers an
 * optional password field on this same landing page, so a firm can set one
 * as part of the SAME click that signs them in, no extra step. Deliberately
 * narrow and fails silent-safe: ignored entirely for a password-reset token
 * (that flow already has its own dedicated /set-password/ page), ignored if
 * the firm already has a password (changing an EXISTING password must go
 * through handleFirmPasswordSet's current-password check or the reset flow,
 * never sneak in here), and a too-weak value is just skipped rather than
 * blocking sign-in over an optional field -- the firm still gets in, and can
 * set a password later from the dashboard exactly as before.
 */
async function handleFirmLoginVerify(
  env: Env,
  token: string | null,
  optionalNewPassword: string | null
): Promise<Response> {
  if (!token) return errorPage(400, "Missing sign-in link.");
  const result = await store.verifyAndConsumeLoginToken(env.DB, token);
  if (!result) {
    return errorPage(
      400,
      "That sign-in link is invalid, expired, or already used. Please request a new one and try again.",
      { href: `${env.STATIC_SITE_BASE_URL || ""}/firm-login/`, text: "Go to firm sign-in" }
    );
  }
  // The token is already consumed at this point (verifyAndConsumeLoginToken
  // is single-use), so a suspended firm's still-unused link is burned by
  // this check rather than reusable later once/if reactivated -- consistent
  // with every other "prove you're allowed in, THEN act" gate in this file.
  // (AuditLab F-1, 2026-08-02: session creation itself, not just an
  // existing session's continued use, must respect firms.status.)
  const firm = await store.getFirmById(env.DB, result.firmId);
  if (!firm || firm.status !== "active") {
    return errorPage(403, "This account isn't active. Get in touch and we'll sort it out.");
  }
  // migration 0045: the specific member this token is FOR -- a removed
  // member's still-outstanding token must not be able to sign back in
  // (getFirmMemberById already excludes removed_at rows).
  const member = await store.getFirmMemberById(env.DB, result.firmId, result.memberId);
  if (!member) {
    return errorPage(403, "This account isn't active. Get in touch and we'll sort it out.");
  }

  // Roadmap #53: gate at the EARLIEST point -- immediately after the
  // ORIGINAL token is resolved to a real member, before ANY purpose-
  // specific side effect (email_change apply, opportunistic password-set,
  // session creation). Gating only the final createSession() call while
  // letting those side effects fire immediately would leave a real hole:
  // a stolen/live session could request an email change, and the confirm
  // click alone (no TOTP) would complete the takeover. purpose/
  // pendingNewEmail are carried forward on the pending row so the SAME
  // deferred side effects replay, unchanged, once TOTP succeeds -- see
  // finishFirmLoginVerify() below and migration 0047's own docstring.
  if (member.totp_enrolled_at) {
    const { rawToken } = await store.createFirm2faPendingToken(env.DB, member.id, firm.id, result.purpose, result.pendingNewEmail);
    return new Response(null, {
      status: 302,
      headers: { Location: `${env.STATIC_SITE_BASE_URL || ""}/firm-login/2fa/?pending=${encodeURIComponent(rawToken)}` },
    });
  }

  return finishFirmLoginVerify(env, firm, member, result.purpose, result.pendingNewEmail, optionalNewPassword);
}

/**
 * The deferred continuation of handleFirmLoginVerify() -- everything that
 * happens once a login token's identity is fully proven, whether that
 * proof completed in one step (no 2FA) or two (2FA: original token, then
 * a TOTP/backup code against the pending token it minted). Called from
 * TWO places: directly above when 2FA isn't enrolled, and from
 * handleFirm2faVerify() after a successful code check. `optionalNewPassword`
 * is only ever non-null from the first call site -- the 2FA-entry page has
 * no such field (a member with 2FA enrolled already has a real credential
 * by construction, so the "set a password on first login" opportunity
 * doesn't apply to that path anyway).
 */
async function finishFirmLoginVerify(
  env: Env,
  firm: store.FirmRow,
  member: store.FirmMemberRow,
  purpose: store.LoginTokenPurpose,
  pendingNewEmail: string | null,
  optionalNewPassword: string | null
): Promise<Response> {
  const result = { firmId: firm.id, memberId: member.id, purpose, pendingNewEmail };
  // Task #29: the token PROVED control of the new inbox by arriving there at
  // all -- applying the change here, not on a separate page, since (unlike
  // password_reset) there is no follow-up form to fill in first. `newEmail`
  // comes only from the TOKEN row (pendingNewEmail), never from anything
  // this request supplied -- same "intent lives on the token" rule as
  // purpose itself. updateFirmAdminEmail() returns false rather than
  // throwing on the real, expected race where someone else claimed that
  // exact address between when this link was issued and clicked; either
  // way the click still signs the admin in (they proved a real inbox),
  // just without the swap applying, and the destination query string says
  // which happened so the dashboard can show the right banner.
  let emailChangeOutcome: "applied" | "conflict" | null = null;
  if (result.purpose === "email_change" && result.pendingNewEmail) {
    // migration 0045: applies to the MEMBER's own login email first (the
    // real source of truth going forward) -- if they're also the firm's
    // primary contact, firms.admin_email is kept as a mirror of that same
    // update so every existing billing/Stripe/outbound-email call site
    // that still reads it directly keeps working unchanged.
    const applied = await store.setFirmMemberEmail(env.DB, member.id, result.pendingNewEmail);
    const alsoMirrored =
      applied && firm.primary_member_id === member.id
        ? await store.updateFirmAdminEmail(env.DB, firm.id, result.pendingNewEmail)
        : true;
    emailChangeOutcome = applied && alsoMirrored ? "applied" : "conflict";
    if (applied) {
      member.email = result.pendingNewEmail;
      if (firm.primary_member_id === member.id) firm.admin_email = result.pendingNewEmail;
      // Adversarial-review L3 (2026-08-05): any OTHER unused login/reset
      // link was minted to and sits in the OLD address's inbox. If that
      // inbox outlives the account's association with it (a departing
      // employee, a shared address later reassigned), a still-live link
      // there could otherwise sign in to THIS account after the email
      // supposedly moved away from it. This token is already consumed
      // (verifyAndConsumeLoginToken) so the WHERE used_at IS NULL below
      // cannot touch it. Deliberately does NOT also end other SESSIONS
      // here (unlike a password change) -- unlike a password, no existing
      // session's authentication becomes invalid just because the sign-in
      // ADDRESS changed, and the old-address notice email is the intended
      // remediation path if this wasn't the real admin, same as it is for
      // every other account-security email in this file.
      await store.invalidateOutstandingLoginTokensForMember(env.DB, member.id);
    }
  }
  // M1 (see actionConfirmPage's matching comment): narrowed from
  // `!== "password_reset"` to `=== "login"` so an email_change token can
  // never ALSO set a password -- the apply-side half of that fix. Without
  // this, actionConfirmPage's own gate would be the only thing stopping a
  // mistyped-address stranger from a full takeover; defense-in-depth means
  // this side must independently refuse it too, not just trust the render.
  // AuditLab DEMO-1 (LOW, 2026-08-06): the demo_locked tightening pass gated
  // setFirmPassword's other two call sites but missed this one. Inert today
  // (a demo firm has a password by the nature of the feature, so
  // !firm.password_hash is false) -- but demo_locked is a raw DB column with
  // no ordering guarantee against password_hash, and the invariant Devin
  // stated ("no self-serve password path AT ALL, even inbox-proving ones")
  // applies identically here.
  if (
    result.purpose === "login" &&
    typeof optionalNewPassword === "string" &&
    optionalNewPassword.length > 0 &&
    validatePasswordStrength(optionalNewPassword).ok &&
    !member.password_hash &&
    !firm.demo_locked
  ) {
    try {
      await store.setFirmMemberPassword(env.DB, member.id, await hashPassword(optionalNewPassword, env.PASSWORD_PEPPER));
    } catch {
      // Never let a failed opportunistic password-set fail the sign-in
      // itself -- same posture as handleFirmPasswordLogin's rehash step.
    }
  }
  // Checked BEFORE createSession() inserts the new row -- see
  // hasAnyFirmSession()'s own docstring for why this is the signal for
  // "the firm's first-ever successful login," not account creation.
  // Deliberately still keyed on the whole FIRM, not this one member --
  // this notification means "a brand-new firm just completed signup,"
  // which is a one-time firm-level event regardless of which member (the
  // founder, today; an invited member accepting their very first invite
  // in the future) happens to be the one triggering it.
  const isFirstEverSession = !(await store.hasAnyFirmSession(env.DB, result.firmId));
  const { rawSessionToken } = await store.createSession(
    env.DB,
    result.firmId,
    member.id,
    result.purpose === "password_reset"
  );
  // migration 0045: marks THIS member as having completed a real login --
  // independent of the firm-wide notification above, this is what lets a
  // "Team" panel show an invited member's status as accepted rather than
  // still-pending. No-op if already set (the founder's very first login
  // sets it once; every login after that is a no-op UPDATE).
  await store.markFirmMemberJoined(env.DB, member.id);
  if (isFirstEverSession) {
    await sendSignupNotification(env, "firm", { email: firm.admin_email, firmName: firm.name, adminName: firm.admin_name });
  }
  // The destination comes from the TOKEN's stored purpose, never from the
  // request. A password-reset link lands directly on "Choose a password"
  // instead of the dashboard -- the whole point of the fix, since the old
  // flow signed you in and then silently forgot you had asked to reset.
  let destination = result.purpose === "password_reset" ? "/set-password/" : "/firm-dashboard/";
  if (emailChangeOutcome === "applied") destination = "/firm-dashboard/#account?email_changed=1";
  else if (emailChangeOutcome === "conflict") destination = "/firm-dashboard/#account?email_change_failed=conflict";
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${env.STATIC_SITE_BASE_URL || ""}${destination}`,
      "Set-Cookie": firmSessionSetCookieHeader(rawSessionToken, env),
    },
  });
}

/**
 * POST /firm/2fa/verify -- roadmap #53. Body: pending (the token minted by
 * handleFirmPasswordLogin()/handleFirmLoginVerify() when 2FA is enrolled),
 * code (a 6-digit TOTP code or a 10-character backup code). On success,
 * replays the SAME deferred continuation the non-2FA path would have run
 * immediately -- see finishFirmLoginVerify()'s own docstring.
 */
async function handleFirm2faVerify(request: Request, env: Env, ip: string): Promise<Response> {
  // Same login-CSRF reasoning as handleFirmPasswordLogin() -- this route
  // ends in Set-Cookie: dr_firm_session with no separate GET-rendered
  // nonce of its own.
  if (!originAllowed(request, env)) {
    return errorPage(400, "That sign-in couldn't be completed. Please sign in from the DeadlineRadar site.");
  }

  const ipAllowed = await checkRateLimit(env.DB, ip, "firm_2fa_verify", RATE_LIMIT_FIRM_2FA_VERIFY);
  if (!ipAllowed) {
    return errorPage(429, "Too many attempts from this address. Please try again later.");
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return errorPage(400, "Something went wrong processing that request.");
  }
  if (raw.length === 0 || raw.length > MAX_BODY_BYTES) {
    return errorPage(400, "Request too large or empty.");
  }
  let form: Record<string, string>;
  try {
    form = Object.fromEntries(new URLSearchParams(raw).entries());
  } catch {
    return errorPage(400, "Something went wrong processing that request.");
  }

  const signinLink = { href: `${env.STATIC_SITE_BASE_URL || ""}/firm-login/`, text: "Go to firm sign-in" };
  const pendingToken = (form.pending ?? "").trim();
  const submittedCode = (form.code ?? "").trim();
  if (!pendingToken || !submittedCode) {
    return errorPage(400, "Please enter your 6-digit code.", signinLink);
  }

  // peekFirm2faPendingToken() already refuses unknown/expired/used/
  // attempts-exhausted rows -- all indistinguishable to this caller, same
  // no-oracle posture every other token lookup in this file uses.
  const pending = await store.peekFirm2faPendingToken(env.DB, pendingToken);
  if (!pending) {
    return errorPage(400, "That sign-in attempt has expired or already been used. Please sign in again.", signinLink);
  }

  // Second bucket, keyed on the ACCOUNT rather than the source IP -- same
  // "per-IP alone does nothing against a distributed attack aimed at one
  // account" reasoning as handleFirmPasswordLogin()'s own account bucket.
  const accountAllowed = await checkRateLimit(env.DB, `account:${pending.member_id}`, "firm_2fa_verify_account", RATE_LIMIT_FIRM_2FA_VERIFY_ACCOUNT);
  if (!accountAllowed) {
    return errorPage(429, "Too many attempts for this account. Please try again later.", signinLink);
  }

  const member = await store.getFirmMemberById(env.DB, pending.firm_id, pending.member_id);
  if (!member || !member.totp_secret_encrypted || !member.totp_secret_iv || !env.TOTP_ENCRYPTION_KEY) {
    // 2FA was disabled (or the encryption key is unexpectedly unset)
    // between minting the pending token and now -- fail closed rather
    // than crash or silently succeed.
    return errorPage(400, "That sign-in attempt is no longer valid. Please sign in again.", signinLink);
  }

  let verified = false;
  const looksLikeTotp = /^\d{6}$/.test(submittedCode);
  if (looksLikeTotp) {
    const secret = await decryptTotpSecret(member.totp_secret_encrypted, member.totp_secret_iv, member.id, env.TOTP_ENCRYPTION_KEY);
    if (secret) {
      const matchedCounter = await verifyTotp(secret, submittedCode);
      // AuditLab 2FA-1 (MEDIUM, 2026-08-07): RFC 6238 Section 5.2 replay
      // prevention -- a code already accepted (matchedCounter <= the
      // stored floor) is refused even though it is still inside its +/-1
      // step validity window, closing the gap a real-time phishing proxy
      // would otherwise exploit (relay the victim's password+code, then
      // replay that same code into a second, attacker-controlled login).
      if (matchedCounter !== null && (member.totp_last_used_timestep === null || matchedCounter > member.totp_last_used_timestep)) {
        verified = true;
        await store.setFirmMemberTotpLastUsedTimestep(env.DB, member.id, matchedCounter);
      }
    }
  } else {
    // Not TOTP-shaped -- try it as a backup code instead of wasting a
    // decrypt+HMAC on a value that can never match.
    const codeHash = await hashBackupCode(submittedCode);
    verified = await store.consumeFirmMemberBackupCode(env.DB, member.id, codeHash);
  }

  if (!verified) {
    await store.incrementFirm2faPendingAttempts(env.DB, pending.id);
    return errorPage(400, "That code wasn't right. Please try again.", {
      href: `${env.STATIC_SITE_BASE_URL || ""}/firm-login/2fa/?pending=${encodeURIComponent(pendingToken)}`,
      text: "Try again",
    });
  }

  const consumed = await store.consumeFirm2faPendingToken(env.DB, pending.id);
  if (!consumed) {
    // A race -- this exact pending token was already redeemed (e.g. two
    // tabs). Fails closed rather than signing in twice from one code.
    return errorPage(400, "That sign-in attempt was already completed. Please sign in again.", signinLink);
  }

  const firm = await store.getFirmById(env.DB, pending.firm_id);
  if (!firm || firm.status !== "active") {
    return errorPage(403, "This account isn't active. Get in touch and we'll sort it out.");
  }

  return finishFirmLoginVerify(env, firm, member, store.normalizeLoginTokenPurpose(pending.purpose), pending.pending_new_email, null);
}

/** POST /firm/logout -- reads the session cookie (if any), deletes the
 * matching session row (a no-op if there wasn't one), and clears the
 * cookie. Always succeeds from the caller's perspective -- there is no
 * meaningful "logout failed" state to report. */
async function handleFirmLogout(request: Request, env: Env, ip: string): Promise<Response> {
  // AuditLab SEC-1 (2026-08-07): no rate limit at all before this -- keyed
  // on IP, not firmId, since there's no verified session at this point
  // (the raw cookie may not even name a real session) -- same posture as
  // every other pre-session bucket in this file.
  const allowed = await checkRateLimit(env.DB, ip, "firm_logout", RATE_LIMIT_LOGOUT);
  if (allowed) {
    const raw = getCookie(request, FIRM_SESSION_COOKIE_NAME);
    if (raw) {
      await store.deleteSession(env.DB, raw);
    }
  }
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${env.STATIC_SITE_BASE_URL || ""}/`,
      "Set-Cookie": firmSessionClearCookieHeader(env),
    },
  });
}

/**
 * THE single auth gate every firm-scoped route (staff CRUD, the dashboard
 * itself -- both built by a later step on top of this branch) must call
 * FIRST, as a one-line check:
 *
 *   const session = await requireFirmSession(request, env);
 *   if (session instanceof Response) return session;
 *   // session.firmId is now a verified, current, non-expired firm id --
 *   // every query in this handler MUST filter by it.
 *
 * Returns either the resolved `{ firmId }` or a ready-to-return 401
 * Response -- there is no third "maybe" state, and no separate step a
 * future route could accidentally skip: either you get a firmId you can
 * trust, or you get a Response you return immediately. This shape (rather
 * than e.g. throwing, or returning `firmId | null` and leaving the 401 to
 * each caller) is deliberate: a caller that forgets to check
 * `instanceof Response` will fail TypeScript's type-narrowing on
 * `session.firmId` (a Response has no `firmId` property), so skipping the
 * check is a compile error, not a silent auth bypass.
 */
export async function requireFirmSession(
  request: Request,
  env: Env
): Promise<
  | { firmId: string; sessionId: string; memberId: string; role: store.FirmMemberRole; passwordResetAuthorized: boolean }
  | Response
> {
  // Orchestrator abuse-test pass (2026-08-05, side note): every caller of
  // this function is a JSON API handler (jsonResponse() on every success
  // path) -- errorPage() returning a full HTML page here (2,921 bytes) was
  // a pure content-type inconsistency. Confirmed harmless in practice
  // (dashboard JS only ever checks res.status on a 401, never reads the
  // body -- window.location.href = '/firm-login/' pattern), but not free:
  // wasted bytes on every unauthenticated/expired request, and wrong for
  // any future consumer that actually parses the body. jsonResponse() to
  // match every real caller.
  const raw = getCookie(request, FIRM_SESSION_COOKIE_NAME);
  if (!raw) {
    return jsonResponse(401, { error: "You need to sign in to view this." });
  }
  const result = await store.verifySession(env.DB, raw);
  if (!result) {
    return jsonResponse(401, { error: "Your session has expired or is invalid. Please sign in again." });
  }
  // A suspended/inactive firm must not keep working just because its
  // session predates the suspension (AuditLab F-1, 2026-08-02: this was
  // previously checked on 2 of 12+ firm routes -- the two mobility ones --
  // leaving every other route, including the roster and CPE data, fully
  // readable/writable regardless of status). This is the ONE place that
  // check now needs to live, since it's the one gate every firm route
  // already calls first.
  if (result.firmStatus !== "active") {
    return jsonResponse(403, { error: "This account isn't active. Get in touch and we'll sort it out." });
  }
  return result;
}

/**
 * requireFirmSession() -> getFirmById(), with NO entitlement check at all
 * (2026-08-06) -- for the standing free-tier routes (Roster, Calendar, CPE
 * Hours, billing self-management) that still need the FirmRow itself
 * (name, admin_email, plan_tier, stripe ids, ...) but must never be
 * paywalled. Replaces requireFirmSessionAndEntitlement() at every call site
 * that isn't Map/Practice Privilege Check -- those free features have no
 * expiration and no tier requirement, just "signed in, account active."
 */
async function requireFirmSessionWithFirm(
  request: Request,
  env: Env
): Promise<
  | { firmId: string; sessionId: string; memberId: string; role: store.FirmMemberRole; passwordResetAuthorized: boolean; firm: store.FirmRow }
  | Response
> {
  const session = await requireFirmSession(request, env);
  if (session instanceof Response) return session;
  const firm = await store.getFirmById(env.DB, session.firmId);
  if (!firm) return jsonResponse(404, { error: "Not found." });
  return { ...session, firm };
}

/**
 * migration 0045 (roadmap #11/#13/#14): requireFirmSessionWithFirm() plus a
 * role check. Billing, account deletion, and member management are
 * Partner-only per the role table this feature shipped with; every other
 * roster/CPE/calendar/report route stays open to all three roles for
 * reads, with a narrower Staff-write-gate applied separately at each
 * mutating route (Staff is read-only there, not locked out entirely the
 * way this function's callers are for non-listed roles).
 */
async function requireFirmRole(
  request: Request,
  env: Env,
  ...allowedRoles: store.FirmMemberRole[]
): Promise<
  | { firmId: string; sessionId: string; memberId: string; role: store.FirmMemberRole; passwordResetAuthorized: boolean; firm: store.FirmRow }
  | Response
> {
  const session = await requireFirmSessionWithFirm(request, env);
  if (session instanceof Response) return session;
  if (!allowedRoles.includes(session.role)) {
    return jsonResponse(403, { error: "You don't have permission to do that." });
  }
  return session;
}

// ---------------------------------------------------------------------------
// Firm members (2026-08-07, migration 0045, roadmap #11/#13/#14/#51). See
// hazy-cooking-codd.md's role table: Partner/Office Manager can invite and
// manage the team, Staff stays read-only; only a Partner can grant
// Partner/Office Manager access or touch billing; a firm always keeps at
// least one active Partner.
// ---------------------------------------------------------------------------

/** GET /firm/members -- visible to all three roles (same "transparency,
 * not secrecy" posture as every other read in this dashboard); only the
 * write actions below are role-gated. */
async function handleFirmMembersList(request: Request, env: Env): Promise<Response> {
  const session = await requireFirmSessionWithFirm(request, env);
  if (session instanceof Response) return session;
  const members = await store.listFirmMembers(env.DB, session.firmId);
  return jsonResponse(200, {
    members: members.map((m) => ({
      id: m.id,
      email: m.email,
      name: m.name,
      role: m.role,
      invited_at: m.invited_at,
      joined_at: m.joined_at,
      is_primary: m.id === session.firm.primary_member_id,
      is_you: m.id === session.memberId,
    })),
  });
}

/**
 * POST /firm/members/invite -- body: { email, role, name? }. Partner or
 * Office Manager only; an Office Manager may only invite Staff (granting
 * Office Manager/Partner access is Partner-only). Devin's pricing decision
 * (2026-08-07): a firm on the free plan_tier cannot add a second person at
 * all -- inviting requires a paid tier first, no separate per-member SKU
 * once on one. Reuses the ordinary login-token/verify machinery for
 * acceptance -- see issueAndSendFirmMemberInviteEmail()'s own docstring.
 */
async function handleFirmMemberInvite(request: Request, env: Env): Promise<Response> {
  const session = await requireFirmRole(request, env, "partner", "office_manager");
  if (session instanceof Response) return session;

  if (!originAllowed(request, env)) {
    return jsonResponse(400, { error: "That request couldn't be completed. Please try again from the DeadlineRadar site." });
  }

  // Devin, 2026-08-07: the free INDIVIDUAL product must never gain a
  // multi-person capability, and neither may a FREE firm -- adding a
  // second person requires a paid plan_tier first, matching the existing
  // "want more? upgrade" pattern rather than a new per-member SKU.
  if (session.firm.plan_tier === "free") {
    return jsonResponse(402, {
      error: "Adding team members requires a paid plan. Upgrade to invite your team.",
      pay_now_url: "/firm-dashboard/#account",
    });
  }

  // Same "no self-serve credential path at all for the shared demo
  // account" posture as handleFirmPasswordSet()/handleFirmChangeEmailRequest()/
  // handleFirmAccountDelete() -- an invite creates a real login-capable
  // identity at an address this session fully controls the choice of.
  if (session.firm.demo_locked) {
    return jsonResponse(403, { error: "This is a shared demo account. Inviting team members isn't available for this account." });
  }

  const allowed = await checkRateLimit(env.DB, session.firmId, "firm_member_invite", RATE_LIMIT_FIRM_MEMBER_INVITE);
  if (!allowed) {
    return jsonResponse(429, { error: "Too many invites sent today for this firm. Please try again tomorrow." });
  }

  let body: Record<string, unknown>;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return jsonResponse(400, { error: "Request too large." });
    body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return jsonResponse(400, { error: "Something went wrong processing that request." });
  }

  const emailRaw = typeof body.email === "string" ? body.email : "";
  const nameRaw = typeof body.name === "string" ? body.name : null;
  if (hasControlChars(emailRaw) || (nameRaw !== null && hasControlChars(nameRaw))) {
    return jsonResponse(400, { error: "Invalid characters in submission." });
  }
  const email = emailRaw.trim();
  if (!isValidEmail(email)) {
    return jsonResponse(400, { error: "That doesn't look like a valid email address." });
  }
  if (await store.isEmailBlocklisted(env.DB, email)) {
    return jsonResponse(400, { error: "That address can't be invited right now." });
  }

  const roleRaw = typeof body.role === "string" ? body.role : "";
  if (roleRaw !== "partner" && roleRaw !== "office_manager" && roleRaw !== "staff") {
    return jsonResponse(400, { error: "Please choose a valid role." });
  }
  const role = roleRaw as store.FirmMemberRole;

  // Role-hierarchy: matches the "Invite a new Office Manager or Partner"
  // row of the permission table this feature shipped with.
  if (session.role === "office_manager" && role !== "staff") {
    return jsonResponse(403, { error: "Only a Partner can invite an Office Manager or Partner." });
  }

  const name = sanitizeFreeText(nameRaw, MAX_ADMIN_NAME_LEN);

  const existing = await store.findFirmMemberByEmail(env.DB, email);
  if (existing) {
    return jsonResponse(409, {
      error:
        existing.firm_id === session.firmId
          ? "That person is already on your team."
          : "That email address is already associated with a different firm account.",
    });
  }

  const { id: memberId } = await store.createFirmMember(env.DB, {
    firmId: session.firmId,
    email,
    name,
    role,
    invitedByMemberId: session.memberId,
  });

  const inviter = await store.getFirmMemberById(env.DB, session.firmId, session.memberId);
  await issueAndSendFirmMemberInviteEmail(env, session.firmId, memberId, email, session.firm.name, ROLE_LABELS[role], inviter?.name ?? null);

  return jsonResponse(201, { id: memberId, email, name, role, joined_at: null });
}

/**
 * PATCH /firm/members/:id -- body: { role }. Partner-only: granting or
 * removing Office Manager/Partner access is reserved for Partners alone
 * (an Office Manager's power over Staff is limited to REMOVAL below, not
 * role changes). Refuses to demote a firm's last active Partner.
 */
async function handleFirmMemberRoleChange(request: Request, env: Env, memberId: string): Promise<Response> {
  const session = await requireFirmRole(request, env, "partner");
  if (session instanceof Response) return session;

  if (!originAllowed(request, env)) {
    return jsonResponse(400, { error: "That request couldn't be completed. Please try again from the DeadlineRadar site." });
  }

  const allowed = await checkRateLimit(env.DB, session.firmId, "firm_member_role_change", RATE_LIMIT_FIRM_MEMBER_ROLE_CHANGE);
  if (!allowed) {
    return jsonResponse(429, { error: "Too many changes. Please try again later." });
  }

  const target = await store.getFirmMemberById(env.DB, session.firmId, memberId);
  if (!target || target.firm_id !== session.firmId) {
    return jsonResponse(404, { error: "Not found." });
  }

  let body: Record<string, unknown>;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return jsonResponse(400, { error: "Request too large." });
    body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return jsonResponse(400, { error: "Something went wrong processing that request." });
  }

  const roleRaw = typeof body.role === "string" ? body.role : "";
  if (roleRaw !== "partner" && roleRaw !== "office_manager" && roleRaw !== "staff") {
    return jsonResponse(400, { error: "Please choose a valid role." });
  }
  const role = roleRaw as store.FirmMemberRole;

  if (target.role === "partner" && role !== "partner") {
    const activePartners = await store.countActivePartners(env.DB, session.firmId);
    if (activePartners <= 1) {
      return jsonResponse(400, { error: "A firm must always have at least one Partner." });
    }
  }

  await store.updateFirmMemberRole(env.DB, session.firmId, memberId, role);
  return jsonResponse(200, { id: memberId, role });
}

/**
 * DELETE /firm/members/:id -- Partner may remove anyone except the firm's
 * last active Partner and except its current primary contact (transfer
 * primary contact to another Partner first -- #51's make-primary). Office
 * Manager may remove Staff only. Soft-delete, and ends every session and
 * outstanding login/invite token the removed member had -- a removed
 * member must not be able to keep using an already-issued cookie or a
 * still-live invite link.
 */
async function handleFirmMemberRemove(request: Request, env: Env, memberId: string): Promise<Response> {
  const session = await requireFirmRole(request, env, "partner", "office_manager");
  if (session instanceof Response) return session;

  if (!originAllowed(request, env)) {
    return jsonResponse(400, { error: "That request couldn't be completed. Please try again from the DeadlineRadar site." });
  }

  const allowed = await checkRateLimit(env.DB, session.firmId, "firm_member_remove", RATE_LIMIT_FIRM_MEMBER_REMOVE);
  if (!allowed) {
    return jsonResponse(429, { error: "Too many changes. Please try again later." });
  }

  const target = await store.getFirmMemberById(env.DB, session.firmId, memberId);
  if (!target || target.firm_id !== session.firmId) {
    return jsonResponse(404, { error: "Not found." });
  }

  if (session.role === "office_manager" && target.role !== "staff") {
    return jsonResponse(403, { error: "You don't have permission to do that." });
  }

  if (target.id === session.firm.primary_member_id) {
    return jsonResponse(400, { error: "Transfer primary contact to another Partner before removing this member." });
  }

  if (target.role === "partner") {
    const activePartners = await store.countActivePartners(env.DB, session.firmId);
    if (activePartners <= 1) {
      return jsonResponse(400, { error: "A firm must always have at least one Partner." });
    }
  }

  await store.removeFirmMember(env.DB, session.firmId, memberId);
  await store.deleteAllSessionsForMember(env.DB, memberId);
  await store.invalidateOutstandingLoginTokensForMember(env.DB, memberId);

  return jsonResponse(200, { ok: true });
}

/**
 * POST /firm/members/:id/make-primary -- roadmap #51, migration 0045.
 * Partner-only. Transfers firm-level billing/email correspondence to a
 * DIFFERENT existing active Partner; the current primary keeps their
 * Partner role (this only moves the pointer, it never removes anyone --
 * see store.setPrimaryMember()'s own docstring).
 */
async function handleFirmMemberMakePrimary(request: Request, env: Env, memberId: string): Promise<Response> {
  const session = await requireFirmRole(request, env, "partner");
  if (session instanceof Response) return session;

  if (!originAllowed(request, env)) {
    return jsonResponse(400, { error: "That request couldn't be completed. Please try again from the DeadlineRadar site." });
  }

  const allowed = await checkRateLimit(env.DB, session.firmId, "firm_member_make_primary", RATE_LIMIT_FIRM_MEMBER_MAKE_PRIMARY);
  if (!allowed) {
    return jsonResponse(429, { error: "Too many changes. Please try again later." });
  }

  const target = await store.getFirmMemberById(env.DB, session.firmId, memberId);
  if (!target || target.firm_id !== session.firmId) {
    return jsonResponse(404, { error: "Not found." });
  }
  if (target.role !== "partner") {
    return jsonResponse(400, { error: "Only a Partner can become the firm's primary contact." });
  }
  if (target.id === session.firm.primary_member_id) {
    return jsonResponse(200, { ok: true, primary_member_id: target.id });
  }

  const applied = await store.setPrimaryMember(env.DB, session.firmId, memberId);
  if (!applied) {
    return jsonResponse(404, { error: "Not found." });
  }

  return jsonResponse(200, { ok: true, primary_member_id: memberId });
}

/**
 * requireFirmSession() -> getFirmById() -> checkPaidFeatureAccess(), in one
 * call (2026-08-06, Map/Practice Privilege Check pay-gating). Only the two
 * genuinely paid features use this now -- Roster/Calendar/CPE Hours are a
 * standing free tier and just call requireFirmSession() directly, no
 * entitlement check at all. Always 403 (no read/write 402 split anymore --
 * that existed for roster mutations, which are no longer pay-gated; every
 * remaining caller of this wrapper is GET-or-GET-shaped).
 */
async function requireFirmSessionAndPaidTier(
  request: Request,
  env: Env
): Promise<
  | { firmId: string; sessionId: string; memberId: string; role: store.FirmMemberRole; passwordResetAuthorized: boolean; firm: store.FirmRow }
  | Response
> {
  const session = await requireFirmSession(request, env);
  if (session instanceof Response) return session;

  const firm = await store.getFirmById(env.DB, session.firmId);
  if (!firm) return jsonResponse(404, { error: "Not found." });

  const access = checkPaidFeatureAccess(firm);
  if (!access.allowed) {
    return jsonResponse(403, {
      error: paidFeatureDenialMessage(access.reason),
      reason: access.reason,
      pay_now_url: "/firm-dashboard/#account",
    });
  }

  return { ...session, firm };
}

// ---------------------------------------------------------------------------
// Stripe billing (2026-08-05, paid tiers). No `stripe` npm package -- see
// stripe.ts's own docstring for why this Worker hand-writes its Stripe
// calls the same way it hand-writes SendGrid/Turnstile.
// ---------------------------------------------------------------------------

/**
 * POST /firm/billing/checkout -- creates a Stripe Checkout Session for the
 * signed-in firm to convert onto a paid tier, at ANY point: while free or
 * already paid (upgrading tiers). Deliberately session-gated only, NOT
 * paid-feature-gated -- requireFirmSessionAndPaidTier() would 403 exactly
 * the free-tier firms this route exists to convert.
 */
async function handleFirmBillingCheckout(request: Request, env: Env): Promise<Response> {
  // migration 0045 (roadmap #11/#13/#14): billing is Partner-only.
  const session = await requireFirmRole(request, env, "partner");
  if (session instanceof Response) return session;

  // CSRF defense-in-depth (2026-08-05) -- see handleFirmLicenseCreate's own comment.
  if (!originAllowed(request, env)) {
    return jsonResponse(400, { error: "That request couldn't be completed. Please try again from the DeadlineRadar site." });
  }

  if (!env.STRIPE_SECRET_KEY) {
    return jsonResponse(503, { error: "Billing isn't set up yet. Get in touch and we'll sort it out." });
  }

  // AuditLab RL-5 (2026-08-06): sibling cancel/resume toggle below already
  // rate-limits on the authenticated firm ID before touching Stripe; this
  // route hit CreateCheckoutSession with no equivalent guard.
  const billingCheckoutAllowed = await checkRateLimit(env.DB, session.firmId, "firm_billing_checkout", RATE_LIMIT_FIRM_BILLING_CHECKOUT);
  if (!billingCheckoutAllowed) {
    return jsonResponse(429, { error: "Too many attempts. Please try again later." });
  }

  // CSRF defense-in-depth -- see readFirmLicenseJsonBody()'s own comment.
  const billingContentType = request.headers.get("content-type") ?? "";
  if (!billingContentType.toLowerCase().startsWith("application/json")) {
    return jsonResponse(400, { error: "Expected a JSON request body." });
  }

  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return jsonResponse(400, { error: "Invalid request body." });
  }
  const requestedTier =
    typeof parsed === "object" && parsed !== null && typeof (parsed as Record<string, unknown>).tier === "string"
      ? ((parsed as Record<string, unknown>).tier as string)
      : null;
  const tierDef = requestedTier ? firmTierByPlanTier(requestedTier) : null;
  if (!tierDef) {
    return jsonResponse(400, { error: "Unrecognised plan." });
  }

  const firm = await store.getFirmById(env.DB, session.firmId);
  if (!firm) return jsonResponse(404, { error: "Not found." });

  // The firm's LIVE roster count at click-time -- never trusted from the
  // request -- so a client can never buy a cheaper tier than its real
  // headcount qualifies for. There is no staff-count value captured at
  // signup to compare against instead; this is the actual source of truth.
  const seatCount = await store.countFirmLicenses(env.DB, session.firmId);
  const minimumTier = firmTierForSeatCount(seatCount);
  if (!minimumTier || tierDef.seatCap < minimumTier.seatCap) {
    return jsonResponse(400, {
      error: minimumTier
        ? `Your roster (${seatCount} staff) needs at least the ${minimumTier.label} plan.`
        : `Your roster (${seatCount} staff) is above our self-serve tiers. Get in touch for a custom plan.`,
    });
  }

  const priceId = stripePriceIdForTier(env, tierDef.planTier);
  if (!priceId) {
    return jsonResponse(503, { error: "That plan isn't available for checkout yet." });
  }

  const dashboardBase = `${staticSiteAbsoluteBaseUrl(env)}/firm-dashboard/`;
  try {
    const checkoutSession = await createCheckoutSession(env.STRIPE_SECRET_KEY, {
      priceId,
      successUrl: `${dashboardBase}#account?checkout=success`,
      cancelUrl: `${dashboardBase}#account?checkout=cancelled`,
      metadata: { firm_id: firm.id, target_plan_tier: tierDef.planTier },
      customerId: firm.stripe_customer_id ?? undefined,
      customerEmail: firm.stripe_customer_id ? undefined : firm.admin_email,
    });
    return jsonResponse(200, { checkout_url: checkoutSession.url });
  } catch (err) {
    if (err instanceof StripeApiError) {
      return jsonResponse(502, { error: "Couldn't start checkout. Please try again." });
    }
    throw err;
  }
}

/**
 * POST /firm/billing/cancel and POST /firm/billing/resume -- self-serve
 * subscription cancellation (2026-08-05, Devin's decision: build self-serve
 * cancel now; no refunds, access continues to the current period's end).
 * Both call the SAME Stripe toggle (cancel_at_period_end), just opposite
 * values -- see stripe.ts's own comment for why this is a scheduling flag,
 * not an immediate cancellation. Neither touches plan_tier: the firm keeps
 * full access either way until Stripe's own customer.subscription.deleted
 * webhook fires at the real period end (handleStripeWebhook, unchanged).
 *
 * Session-gated only (2026-08-06), NOT paid-feature-gated -- billing
 * self-management isn't a paid FEATURE, a free-tier firm must be able to
 * reach it too (if only to discover it has nothing to cancel, via the
 * plain 400 below for a missing stripe_subscription_id).
 */
async function handleFirmBillingCancellationToggle(request: Request, env: Env, cancelAtPeriodEnd: boolean): Promise<Response> {
  // migration 0045 (roadmap #11/#13/#14): billing is Partner-only.
  const session = await requireFirmRole(request, env, "partner");
  if (session instanceof Response) return session;

  // CSRF defense-in-depth (2026-08-05) -- see handleFirmLicenseCreate's own comment.
  if (!originAllowed(request, env)) {
    return jsonResponse(400, { error: "That request couldn't be completed. Please try again from the DeadlineRadar site." });
  }

  if (!env.STRIPE_SECRET_KEY) {
    return jsonResponse(503, { error: "Billing isn't set up yet. Get in touch and we'll sort it out." });
  }

  const allowed = await checkRateLimit(env.DB, session.firmId, "firm_billing_cancel", RATE_LIMIT_FIRM_BILLING_CANCEL);
  if (!allowed) {
    return jsonResponse(429, { error: "Too many attempts. Please try again later." });
  }

  // Task #27 follow-up (2026-08-06, reported live): see
  // handleFirmChangeEmailRequest's identical comment -- a demo visitor could
  // otherwise cancel the plan the shared demo account exists to showcase for
  // the next visitor.
  if (session.firm.demo_locked) {
    return jsonResponse(403, {
      error: "This is a shared demo account. Billing changes aren't available for this account.",
    });
  }

  if (!session.firm.stripe_subscription_id) {
    return jsonResponse(400, { error: "No active subscription to update." });
  }

  try {
    const result = await updateSubscriptionCancelAtPeriodEnd(env.STRIPE_SECRET_KEY, session.firm.stripe_subscription_id, cancelAtPeriodEnd);
    await store.updateFirmCancellation(env.DB, session.firmId, {
      cancelAtPeriodEnd: result.cancelAtPeriodEnd,
      currentPeriodEnd: result.currentPeriodEnd,
    });
    return jsonResponse(200, { cancel_at_period_end: result.cancelAtPeriodEnd, current_period_end: result.currentPeriodEnd });
  } catch (err) {
    if (err instanceof StripeApiError) {
      return jsonResponse(502, { error: "Couldn't update your subscription. Please try again." });
    }
    throw err;
  }
}

/**
 * POST /firm/account/delete -- Task #3 (2026-08-06, Devin's decision:
 * soft-deactivate immediately, hard-delete after a 30-day grace period).
 *
 * Session-gated only, NOT entitlement-gated -- same reasoning as
 * handleFirmPasswordSet: deleting the account must work regardless of
 * plan_tier/pilot-expiry state, not just for firms currently entitled to
 * paid features.
 *
 * The exit survey (reason + free-text detail) is entirely OPTIONAL, per
 * the task's own scope -- both may be omitted, and an unrecognised reason
 * value is silently dropped to null rather than 400ing the whole deletion
 * over a cosmetic mismatch (deleting the account is the part that must not
 * fail; the survey is a courtesy on top of it).
 */
async function handleFirmAccountDelete(request: Request, env: Env): Promise<Response> {
  // migration 0045 (roadmap #11/#13/#14): deleting the whole firm is
  // Partner-only -- an Office Manager or Staff member must never be able
  // to delete the account out from under every other member.
  const session = await requireFirmRole(request, env, "partner");
  if (session instanceof Response) return session;

  // CSRF defense-in-depth (2026-08-05) -- see handleFirmLicenseCreate's own comment.
  if (!originAllowed(request, env)) {
    return jsonResponse(400, { error: "That request couldn't be completed. Please try again from the DeadlineRadar site." });
  }

  const allowed = await checkRateLimit(env.DB, session.firmId, "firm_account_delete", RATE_LIMIT_FIRM_ACCOUNT_DELETE);
  if (!allowed) {
    return jsonResponse(429, { error: "Too many attempts. Please try again later." });
  }

  const contentType = request.headers.get("content-type") ?? "";
  let body: Record<string, unknown> = {};
  if (contentType.toLowerCase().startsWith("application/json")) {
    try {
      const raw = await request.text();
      if (raw.length > 0 && raw.length <= MAX_BODY_BYTES) {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed;
      }
    } catch {
      // A malformed/missing body just means "no survey answer" -- the
      // survey is optional, so this is never a reason to refuse deletion.
    }
  }

  const reasonRaw = typeof body.reason === "string" ? body.reason : null;
  const reason = reasonRaw && DELETION_SURVEY_REASONS.has(reasonRaw) ? reasonRaw : null;
  const detail = sanitizeFreeText(typeof body.detail === "string" ? body.detail : null, MAX_DELETION_SURVEY_DETAIL_LEN);
  const currentPassword = typeof body.current_password === "string" ? body.current_password : "";

  const firm = await store.getFirmById(env.DB, session.firmId);
  if (!firm) {
    return jsonResponse(404, { error: "Not found." });
  }
  // Task #27 follow-up (2026-08-06, reported live): see
  // handleFirmChangeEmailRequest's identical comment -- the shared demo
  // account existing at all depends on nobody being able to delete it out
  // from under the next visitor.
  if (firm.demo_locked) {
    return jsonResponse(403, {
      error: "This is a shared demo account. Account deletion isn't available for this account.",
    });
  }
  if (firm.status === store.FIRM_STATUS_DELETED) {
    // Guards the narrow concurrent-request race: two delete calls close
    // enough together that requireFirmSession() (which only ever sees the
    // status as of ITS OWN read) passed both before either write below
    // committed. A sequential retry never reaches this branch --
    // requireFirmSession() itself already 403s once status has actually
    // flipped, same as any other route on an inactive firm.
    return jsonResponse(200, { ok: true });
  }

  // AuditLab DELETE-1 (HIGH, 2026-08-06): this route used to have ZERO
  // step-up check -- a bare session cookie alone triggered immediate
  // full-firm lockout, an immediate Stripe refund + subscription
  // cancellation, and an eventual irreversible data wipe, with no proof of
  // credential possession required. The demo_locked check above only ever
  // protected the one shared public demo account; every real firm was
  // still exposed. Mirrors handleFirmPasswordSet's own gate exactly (same
  // exemptions: a magic-link-only firm with no password has nothing to
  // verify against, and a session that just redeemed a password-RESET
  // link already proved control of the account's own inbox -- stronger
  // evidence than the password this check would otherwise demand).
  if (firm.password_hash && !session.passwordResetAuthorized) {
    const currentOk = await verifyPassword(
      currentPassword,
      {
        algo: firm.password_algo ?? undefined,
        salt: firm.password_salt ?? undefined,
        iterations: firm.password_iterations ?? undefined,
        rounds: firm.password_rounds ?? undefined,
        hash: firm.password_hash,
      },
      env.PASSWORD_PEPPER
    );
    if (!currentOk) {
      return jsonResponse(400, { error: "That current password isn't right." });
    }
  }

  await store.requestFirmDeletion(env.DB, session.firmId, { reason, detail });

  // Best-effort from here down -- the account is already, irreversibly (in
  // effect) deactivated by the line above. None of the following may fail
  // the request.
  //
  // Task #32 (2026-08-06, Devin's decision): DELETION gets a prorated
  // refund for the unused remainder of the current billing period, plus an
  // IMMEDIATE Stripe cancellation -- deliberately different from plain
  // "Cancel subscription" (handleFirmBillingCancellationToggle above),
  // which stays no-refund/access-continues-to-period-end. The distinction
  // is access: a plain cancel keeps the firm using the product through
  // what it already paid for, so no refund is owed; deletion cuts access
  // RIGHT NOW, so holding payment for days that can never be used isn't
  // right. Applies regardless of whether the firm had already clicked
  // "Cancel" first -- deleting is what triggers the refund, not a prior
  // cancellation state.
  let refundCents: number | null = null;
  if (env.STRIPE_SECRET_KEY && firm.stripe_subscription_id) {
    try {
      const invoice = await getLatestInvoiceForSubscription(env.STRIPE_SECRET_KEY, firm.stripe_subscription_id);
      if (invoice && invoice.paymentIntentId && invoice.amountPaid > 0) {
        const proratedCents = computeProratedRefundCents(invoice.amountPaid, invoice.periodStart, invoice.periodEnd, new Date());
        if (proratedCents > 0) {
          const refund = await refundPaymentIntent(env.STRIPE_SECRET_KEY, invoice.paymentIntentId, proratedCents);
          await store.recordFirmDeletionRefund(env.DB, session.firmId, proratedCents, refund.refundId);
          refundCents = proratedCents;
        }
      }
      await cancelSubscriptionImmediately(env.STRIPE_SECRET_KEY, firm.stripe_subscription_id);
    } catch {
      // Stripe outage must not block account deletion -- access is already
      // gone via status='deleted' regardless of what Stripe billing does.
      // A failure here (refund OR cancellation) needs a human to reconcile
      // -- the internal notification email below fires regardless of this
      // try/catch and is the detection signal for that.
    }
  }

  try {
    await store.invalidateOutstandingLoginTokens(env.DB, session.firmId);
  } catch {
    // Non-fatal -- see above.
  }
  try {
    await store.deleteAllSessionsForFirm(env.DB, session.firmId);
  } catch {
    // Non-fatal -- status='deleted' already blocks any surviving session
    // at the very next request regardless.
  }

  if (env.SENDGRID_API_KEY) {
    try {
      const underCap = await checkAndCountActionSend(env.DB, dailySendCap(env));
      if (underCap) {
        const built = buildAccountDeletionNotificationEmail({
          firmName: firm.name,
          adminEmail: firm.admin_email,
          reason,
          detail,
          refundCents,
        });
        await sendViaSendGrid(env.SENDGRID_API_KEY, INTERNAL_NOTIFY_EMAIL, built, env.EMAIL_ALLOWLIST);
      }
    } catch {
      // Non-fatal -- see above.
    }
  }

  return jsonResponse(200, { ok: true });
}

/**
 * POST /stripe/webhook -- Stripe calls this directly, not a browser. Reads
 * the RAW body before any parsing (signature verification is over the exact
 * bytes Stripe sent, not a re-serialized copy) and rejects with 400 before
 * trusting the body at all if the `Stripe-Signature` header doesn't verify.
 *
 * Idempotent via store.recordWebhookEventIfNew() (migration 0018's
 * stripe_webhook_events ledger) -- Stripe retries any non-2xx delivery, so a
 * redelivered event must be a no-op, not a second plan-tier flip.
 */
async function handleStripeWebhook(request: Request, env: Env): Promise<Response> {
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) {
    // Not configured -- reject rather than silently accepting unverifiable
    // webhook calls. Stripe will retry once configuration lands.
    return jsonResponse(503, { error: "Billing isn't set up yet." });
  }

  const rawBody = await request.text();
  const sigHeader = request.headers.get("Stripe-Signature");
  const verified = await verifyWebhookSignature(rawBody, sigHeader, env.STRIPE_WEBHOOK_SECRET);
  if (!verified) {
    return jsonResponse(400, { error: "Invalid signature." });
  }

  let event: StripeWebhookEvent;
  try {
    event = JSON.parse(rawBody) as StripeWebhookEvent;
  } catch {
    return jsonResponse(400, { error: "Invalid payload." });
  }
  if (!event.id || !event.type) {
    return jsonResponse(400, { error: "Invalid event." });
  }

  const object = event.data.object as Record<string, unknown>;

  if (event.type === "checkout.session.completed") {
    const metadata = (object.metadata as Record<string, unknown> | undefined) ?? {};
    const firmId = typeof metadata.firm_id === "string" ? metadata.firm_id : null;
    const targetPlanTier = typeof metadata.target_plan_tier === "string" ? metadata.target_plan_tier : null;
    const customerId = typeof object.customer === "string" ? object.customer : null;
    const subscriptionId = typeof object.subscription === "string" ? object.subscription : null;

    if (firmId && targetPlanTier && customerId && subscriptionId) {
      const isNew = await store.recordWebhookEventIfNew(env.DB, event.id, event.type, firmId);
      if (isNew) {
        await store.updateFirmBilling(env.DB, firmId, {
          planTier: targetPlanTier,
          stripeCustomerId: customerId,
          stripeSubscriptionId: subscriptionId,
        });
        await store.markWebhookEventProcessed(env.DB, event.id);
      }
    }
    return jsonResponse(200, { received: true });
  }

  if (event.type === "customer.subscription.deleted") {
    const subscriptionId = typeof object.id === "string" ? object.id : null;
    if (subscriptionId) {
      const isNew = await store.recordWebhookEventIfNew(env.DB, event.id, event.type, null);
      if (isNew) {
        const firm = await store.findFirmByStripeSubscriptionId(env.DB, subscriptionId);
        // A cancellation reverts to `free`, not a hard lockout -- Roster/
        // Calendar/CPE Hours stay fully usable (the free tier has no
        // expiration), Map/Practice Privilege Check lose access the same
        // way they would for a firm that never paid. That's the correct
        // floor for a cancelled subscription.
        if (firm) {
          await store.updateFirmBilling(env.DB, firm.id, {
            planTier: "free",
            stripeCustomerId: firm.stripe_customer_id ?? "",
            stripeSubscriptionId: null,
          });
        }
        await store.markWebhookEventProcessed(env.DB, event.id);
      }
    }
    return jsonResponse(200, { received: true });
  }

  if (event.type === "invoice.payment_failed") {
    // Best-effort record only -- Stripe's own retry/dunning cycle handles
    // the grace period, so this does not revoke access mid-retry. If
    // retries exhaust, Stripe itself fires customer.subscription.deleted
    // (handled above), which is what actually changes access.
    const isNew = await store.recordWebhookEventIfNew(env.DB, event.id, event.type, null);
    if (isNew) {
      await store.markWebhookEventProcessed(env.DB, event.id);
    }
    return jsonResponse(200, { received: true });
  }

  // Unrecognised event types are acknowledged, not errored -- the webhook
  // endpoint is registered for a fixed set of events, but Stripe's retry
  // behavior treats any non-2xx as "try again forever," so an event this
  // handler doesn't act on must still 200.
  return jsonResponse(200, { received: true });
}

// ---------------------------------------------------------------------------
// FREE-TIER individual sign-in (2026-07-31, migration 0012).
//
// Individuals have had a working free product since day one -- per-state
// signup, escalating 60/30/14/7/3/1-day reminders, 55 jurisdictions,
// bring-your-own dates, and (because dedupe is on `(email, state)`) as many
// licences as they like. What they have never had is a way to SEE any of
// it. Everything below adds only that: sign in, look at your own deadlines,
// sign out. It grants no new capability over the data.
//
// Deliberately magic-link only, with NO password and NO SSO. The firm tier
// has those because a paid work tool with a roster of other people's data
// warrants them; an individual signing in occasionally to read a list does
// not, and every credential we don't store is one we can't leak.
// ---------------------------------------------------------------------------

/**
 * Issues a sign-in token and best-effort emails it. Mirrors
 * issueAndSendFirmLoginLink() exactly, including its "no SENDGRID_API_KEY =>
 * token created, nothing sent, don't crash" convention: the caller's
 * response must never depend on whether delivery worked.
 */
async function issueAndSendSubscriberLoginLink(env: Env, email: string): Promise<void> {
  // Suppression is checked HERE, not at the caller, so no future caller can
  // route around it (2026-07-31, security review: every other send path in
  // this Worker honours suppression -- see scheduler.ts -- and this one
  // originally did not, which meant a person who had unsubscribed from
  // everything could still be mailed indefinitely at a stranger's request).
  if (await store.isPermanentlySuppressed(env.DB, email)) return;
  const { rawToken } = await store.createSubscriberLoginToken(env.DB, email);
  if (!env.SENDGRID_API_KEY) return;
  try {
    const underCap = await checkAndCountActionSend(env.DB, dailySendCap(env));
    if (!underCap) return;
    const loginUrl = `${actionBaseUrl(env)}/subscriber/login/verify?token=${encodeURIComponent(rawToken)}`;
    const built = buildSubscriberLoginEmail(loginUrl);
    await sendViaSendGrid(env.SENDGRID_API_KEY, email, built, env.EMAIL_ALLOWLIST);
  } catch {
    // Swallow -- same best-effort posture as every other send in this file.
  }
}

/**
 * POST /subscriber/login -- request a sign-in link. Same hardening pipeline
 * as every other public form here (rate limit -> body cap -> honeypot ->
 * control chars -> email format -> Turnstile).
 *
 * ANTI-ENUMERATION: a link is sent only if that email actually has at least
 * one live subscription, but the RESPONSE is identical either way. Without
 * that, this endpoint would be a clean oracle for "is this person tracking
 * a CPA licence with you" -- and unlike the firm signup path (where an
 * unknown email legitimately creates an account), there is nothing to create
 * here, so the branch would be perfectly observable.
 *
 * It is also why we don't email non-subscribers "you have no account": that
 * turns any address into a target for someone else's sign-in attempts, i.e.
 * a free mail-bombing primitive pointed at strangers.
 *
 * The dead-end this creates (a person with no subscriptions clicks Sign In,
 * gets "check your email", and no email arrives) is handled in the RESPONSE
 * COPY, which always also offers the signup path -- the same fix applied to
 * /firm-login/ after Devin walked into its version of this trap. Fixing it
 * by branching the copy would just reintroduce the oracle.
 */
async function handleSubscriberLoginRequest(
  request: Request,
  env: Env,
  ip: string,
  ctx: ExecutionContext
): Promise<Response> {
  const allowed = await checkRateLimit(env.DB, ip, "subscriber_login", RATE_LIMIT_FIRM_LOGIN);
  if (!allowed) {
    return errorPage(429, "Too many requests from this address. Please try again later.");
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return errorPage(400, "Something went wrong processing that request.");
  }
  if (raw.length === 0 || raw.length > MAX_BODY_BYTES) {
    return errorPage(400, "Request too large or empty.");
  }

  let form: Record<string, string>;
  try {
    form = Object.fromEntries(new URLSearchParams(raw).entries());
  } catch {
    return errorPage(400, "Something went wrong processing that request.");
  }

  const honeypotValue = form[HONEYPOT_FIELD_NAME];
  if (honeypotValue !== undefined && honeypotValue !== "") {
    return htmlResponse(200, subscriberLoginSentPage(env));
  }

  for (const value of Object.values(form)) {
    if (hasControlChars(value)) {
      return errorPage(400, "Invalid characters in submission.");
    }
  }

  const email = (form.email ?? "").trim();
  if (!isValidEmail(email)) {
    return errorPage(400, "That doesn't look like a valid email address.");
  }

  const turnstileOk = await verifyTurnstile(form["cf-turnstile-response"], env.TURNSTILE_SECRET_KEY, true);
  if (!turnstileOk) {
    return errorPage(400, "Verification failed -- please try again.");
  }

  // PER-RECIPIENT throttle, on top of the per-IP one above (2026-07-31,
  // security review). Per-IP alone does nothing against a distributed
  // attack aimed at one person -- the review demonstrated 12 sends to one
  // victim from 12 IPs. This is the same second bucket
  // handleFirmPasswordLogin() already keys on the account rather than the
  // caller, for the same reason.
  //
  // It also protects the reminders themselves: the daily send cap is GLOBAL
  // and shared with them, so an unthrottled mail-bomb here would exhaust the
  // day's budget and silently stop that day's real renewal reminders.
  // Only send if there's actually something to sign in to. Note this reads
  // through the SAME scoping function the dashboard uses, so "we sent a
  // link" and "you'll see rows" can never disagree.
  //
  // CONFIRMED rows only. A `pending_confirmation` row proves nothing -- it
  // is created by anyone who types an address into the public signup form,
  // so honouring it would turn this route into a mail primitive pointed at
  // any stranger (plant a pending row, then request sign-in links forever).
  // Someone whose rows are all still pending has nothing to look at anyway;
  // their next step is the confirmation email they were already sent.
  const existing = await store.listSubscriberLicenses(env.DB, store.normalizeEmail(email));
  const hasRealAccount = existing.some((r) => r.status !== store.STATUS_PENDING);

  // The per-recipient bucket is consumed ONLY when a send would actually
  // fire (2026-07-31, verification pass). Charging it earlier turned the
  // mail-bomb fix into a silent lockout: an attacker spent the victim's
  // whole hourly allowance from throwaway IPs without a single email being
  // sent, and the victim -- who has no password and no SSO to fall back on
  // -- then got "check your email" and nothing in their inbox, with no way
  // to tell why. Now an attacker aiming at a non-subscriber burns nothing,
  // and aiming at a real subscriber costs them the same sends it caps.
  //
  // Note this check sits AFTER the two reads both branches already perform
  // and gates only the deferred send, so it adds no observable difference
  // between a known and an unknown address.
  const accountAllowed =
    hasRealAccount &&
    (await checkRateLimit(
      env.DB,
      `account:${store.normalizeEmail(email)}`,
      "subscriber_login_account",
      RATE_LIMIT_SUBSCRIBER_LOGIN_ACCOUNT
    ));

  if (accountAllowed && hasRealAccount) {
    // ctx.waitUntil, NOT await (2026-07-31, security review): issuing the
    // token writes to D1 and sends an HTTPS request to SendGrid, work the
    // no-such-subscriber branch never does. Awaiting it made the two
    // branches differ by a visible ~100-500ms -- byte-identical bodies over
    // a plainly different response time, which is exactly the timing oracle
    // this repo already had to fix once on the firm password login. Off the
    // response path, both branches return immediately.
    ctx.waitUntil(issueAndSendSubscriberLoginLink(env, email));
  }

  return htmlResponse(200, subscriberLoginSentPage(env));
}

/**
 * POST /subscriber/login/verify -- consumes the token, creates the session,
 * sets the cookie. Routed through ACTION_PAGES like every other emailed
 * link in this Worker, which is what makes it safe against corporate mail
 * scanners that prefetch URLs: the GET only renders a button, and nothing
 * is consumed until that button POSTs.
 */
async function handleSubscriberLoginVerify(env: Env, token: string | null): Promise<Response> {
  if (!token) return errorPage(400, "Missing sign-in link.");
  const result = await store.verifyAndConsumeSubscriberLoginToken(env.DB, token);
  if (!result) {
    return errorPage(
      400,
      "That sign-in link is invalid, expired, or already used. Please request a new one and try again.",
      { href: `${env.STATIC_SITE_BASE_URL || ""}/signin/`, text: "Go to sign-in" }
    );
  }
  // Roadmap #12: the token PROVED control of the new inbox by arriving
  // there at all -- applying the change here, same "intent lives on the
  // token, never on what the redeeming request supplies" rule migration
  // 0022/handleFirmLoginVerify() already established. Re-checks the
  // conflict at REDEMPTION time too (not just request time), since another
  // party could have claimed the address in the interim -- if so, the
  // click still signs the person in (they proved a real inbox), just
  // without the swap applying, same "conflict, not a hard failure" posture
  // handleFirmLoginVerify() uses for updateFirmAdminEmail()'s own race.
  let signInEmail = result.emailNormalized;
  let emailChangeOutcome: "applied" | "conflict" | null = null;
  if (result.purpose === "email_change" && result.pendingNewEmail) {
    const alreadyClaimed = await store.hasAnySubscriberRowForEmail(env.DB, result.pendingNewEmail);
    if (alreadyClaimed) {
      emailChangeOutcome = "conflict";
    } else {
      await store.setSubscriberEmail(env.DB, result.emailNormalized, result.pendingNewEmail);
      signInEmail = store.normalizeEmail(result.pendingNewEmail);
      emailChangeOutcome = "applied";
      // Any OTHER unused login/email-change link sits in the OLD address's
      // inbox -- burn it now, same reasoning as
      // invalidateOutstandingLoginTokensForMember()'s own comment on the
      // firm side.
      await store.invalidateOutstandingSubscriberEmailChangeTokens(env.DB, result.emailNormalized);
    }
  }
  const { rawSessionToken, sessionId } = await store.createSubscriberSession(env.DB, signInEmail);
  // Signing in revokes every other session for this email -- see
  // deleteOtherSubscriberSessions()'s own docstring. This tier has no
  // account screen, so "request a fresh link" IS the sign-out-everywhere
  // control, and it only works if it actually revokes.
  await store.deleteOtherSubscriberSessions(env.DB, signInEmail, sessionId);
  const destinationQuery =
    emailChangeOutcome === "applied" ? "?email_changed=1" : emailChangeOutcome === "conflict" ? "?email_change_failed=conflict" : "";
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${env.STATIC_SITE_BASE_URL || ""}/my/${destinationQuery}`,
      "Set-Cookie": subscriberSessionSetCookieHeader(rawSessionToken, env),
    },
  });
}

/**
 * POST /subscriber/change-email -- roadmap #12. Mirrors
 * handleFirmChangeEmailRequest() exactly: verify-new-address-before-
 * applying, notice to the old address, no step-up re-auth (unlike the
 * firm side, this tier has no password to re-prove -- the session cookie
 * itself, minted by a magic link, is already the full authentication this
 * tier has ever had; requiring anything more here would be a new bar this
 * tier's login flow doesn't otherwise clear).
 *
 * Applies to EVERY subscribers row sharing the caller's current email,
 * firm-tracked rows included -- moving where reminders land doesn't
 * remove anyone from a firm's coverage, it only changes the address (see
 * migration 0046's own docstring for the full reasoning).
 */
async function handleSubscriberChangeEmailRequest(request: Request, env: Env): Promise<Response> {
  const session = await requireSubscriberSession(request, env);
  if (session instanceof Response) return session;

  if (!originAllowed(request, env)) {
    return jsonResponse(400, { error: "That request couldn't be completed. Please try again from the DeadlineRadar site." });
  }

  const allowed = await checkRateLimit(env.DB, session.emailNormalized, "subscriber_change_email", RATE_LIMIT_SUBSCRIBER_CHANGE_EMAIL);
  if (!allowed) {
    return jsonResponse(429, { error: "Too many attempts. Please try again later." });
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return jsonResponse(400, { error: "Expected a JSON request body." });
  }
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return jsonResponse(400, { error: "Something went wrong processing that request." });
  }
  if (raw.length === 0 || raw.length > MAX_BODY_BYTES) {
    return jsonResponse(400, { error: "Request too large or empty." });
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return jsonResponse(400, { error: "Something went wrong processing that request." });
  }
  const newEmailRaw = typeof body.new_email === "string" ? body.new_email.trim() : "";
  if (!isValidEmail(newEmailRaw)) {
    return jsonResponse(400, { error: "That doesn't look like a valid email address." });
  }
  if (await store.isEmailBlocklisted(env.DB, newEmailRaw)) {
    return jsonResponse(400, { error: "We're not able to use that address right now." });
  }
  if (store.normalizeEmail(newEmailRaw) === session.emailNormalized) {
    return jsonResponse(400, { error: "That's already your email address." });
  }
  // Same anti-enumeration trade-off handleFirmChangeEmailRequest() makes
  // (and the same reasoning): the caller here is already an authenticated
  // subscriber, not an anonymous visitor, and a silent failure at
  // redemption time is strictly worse UX for zero real benefit -- that
  // outcome already confirms the same fact one click later regardless.
  if (await store.hasAnySubscriberRowForEmail(env.DB, newEmailRaw)) {
    return jsonResponse(400, { error: "That email address is already in use." });
  }

  await store.invalidateOutstandingSubscriberEmailChangeTokens(env.DB, session.emailNormalized);
  const { rawToken } = await store.createSubscriberLoginToken(env.DB, session.emailNormalized, "email_change", newEmailRaw);

  if (env.SENDGRID_API_KEY) {
    try {
      // Notice to the OLD address first -- same ordering fix (and same
      // reasoning) as handleFirmChangeEmailRequest()'s own comment: a
      // starved daily-send budget should drop the (harmless, reversible)
      // confirm email, never the time-sensitive warning.
      const noticeUnderCap = await checkAndCountActionSend(env.DB, dailySendCap(env));
      if (noticeUnderCap) {
        const noticeEmail = buildSubscriberEmailChangeRequestedNoticeEmail(newEmailRaw, new Date().toISOString());
        await sendViaSendGrid(env.SENDGRID_API_KEY, session.emailNormalized, noticeEmail, env.EMAIL_ALLOWLIST);
      }
      const confirmUnderCap = await checkAndCountActionSend(env.DB, dailySendCap(env));
      if (confirmUnderCap) {
        const confirmUrl = `${actionBaseUrl(env)}/subscriber/login/verify?token=${encodeURIComponent(rawToken)}`;
        const confirmEmail = buildSubscriberEmailChangeConfirmEmail(confirmUrl);
        await sendViaSendGrid(env.SENDGRID_API_KEY, newEmailRaw, confirmEmail, env.EMAIL_ALLOWLIST);
      }
    } catch {
      // Swallow -- same best-effort posture as every other send in this
      // file. The token already exists in the DB either way.
    }
  }

  return jsonResponse(200, { ok: true });
}

/**
 * POST /subscriber/profile -- roadmap #12. Body: { first_name: string |
 * null }. Sets ONLY first_name -- the subscriber-supplied, cosmetic-only
 * field (migration 0001's own comment) -- never staff_label (the FIRM's
 * own organizational tag for a tracked row) and never anything
 * compliance-relevant (state, license type, deadline), which stay
 * firm-admin-only by construction: this handler has no path to them at
 * all, not just a check that happens to refuse them.
 */
async function handleSubscriberProfileUpdate(request: Request, env: Env): Promise<Response> {
  const session = await requireSubscriberSession(request, env);
  if (session instanceof Response) return session;

  if (!originAllowed(request, env)) {
    return jsonResponse(400, { error: "That request couldn't be completed. Please try again from the DeadlineRadar site." });
  }

  const allowed = await checkRateLimit(env.DB, session.emailNormalized, "subscriber_profile_update", RATE_LIMIT_SUBSCRIBER_PROFILE_UPDATE);
  if (!allowed) {
    return jsonResponse(429, { error: "Too many changes. Please try again later." });
  }

  let body: Record<string, unknown>;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return jsonResponse(400, { error: "Request too large." });
    body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return jsonResponse(400, { error: "Something went wrong processing that request." });
  }

  const firstNameRaw = typeof body.first_name === "string" ? body.first_name : "";
  if (hasControlChars(firstNameRaw)) {
    return jsonResponse(400, { error: "Invalid characters in submission." });
  }
  // Same 60-char cap and empty-means-unset posture as handleSubscribe()'s
  // own first_name field (index.ts's public signup form) -- one cap for
  // the same column, set at signup or edited later.
  const trimmed = firstNameRaw.trim().slice(0, 60);
  const firstName = trimmed.length > 0 ? trimmed : null;

  await store.setSubscriberFirstName(env.DB, session.emailNormalized, firstName);
  return jsonResponse(200, { first_name: firstName });
}

/**
 * PATCH /subscriber/reminder-cadence -- roadmap #12. Body: { thresholds:
 * number[] | null }. The subscriber's OWN override of which of the 6
 * fixed escalation points (60/30/14/7/3/1 days) they personally receive
 * -- null means "use the firm's setting" (or the full default for a
 * free-tier row). Same validation (parseReminderThresholds) as
 * handleReminderCadenceSet()'s firm-level version; applies across every
 * row sharing this email, same reach as the profile/email setters above.
 */
async function handleSubscriberReminderCadenceSet(request: Request, env: Env): Promise<Response> {
  const session = await requireSubscriberSession(request, env);
  if (session instanceof Response) return session;

  if (!originAllowed(request, env)) {
    return jsonResponse(400, { error: "That request couldn't be completed. Please try again from the DeadlineRadar site." });
  }

  const allowed = await checkRateLimit(env.DB, session.emailNormalized, "subscriber_reminder_cadence", RATE_LIMIT_SUBSCRIBER_REMINDER_CADENCE);
  if (!allowed) {
    return jsonResponse(429, { error: "Too many changes. Please try again later." });
  }

  let body: Record<string, unknown>;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return jsonResponse(400, { error: "Request too large." });
    body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return jsonResponse(400, { error: "Something went wrong processing that request." });
  }

  if (body.thresholds === null) {
    await store.setSubscriberReminderThresholds(env.DB, session.emailNormalized, null);
    return jsonResponse(200, { reminder_thresholds: null });
  }

  const parsed = parseReminderThresholds(body.thresholds);
  if (!parsed) {
    return jsonResponse(400, { error: "Please choose at least one valid reminder timing." });
  }

  await store.setSubscriberReminderThresholds(env.DB, session.emailNormalized, JSON.stringify(parsed));
  return jsonResponse(200, { reminder_thresholds: parsed });
}

/** POST /subscriber/logout -- deletes the session row (no-op if there wasn't
 * one) and clears the cookie. Never reports failure; there is no useful
 * "logout failed" state. */
async function handleSubscriberLogout(request: Request, env: Env, ip: string): Promise<Response> {
  // AuditLab SEC-1 (2026-08-07): same fix/reasoning as handleFirmLogout()'s
  // own comment above (IP-keyed, no verified session at this point).
  const allowed = await checkRateLimit(env.DB, ip, "subscriber_logout", RATE_LIMIT_LOGOUT);
  if (allowed) {
    const raw = getCookie(request, SUBSCRIBER_SESSION_COOKIE_NAME);
    if (raw) {
      await store.deleteSubscriberSession(env.DB, raw);
    }
  }
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${env.STATIC_SITE_BASE_URL || ""}/`,
      "Set-Cookie": subscriberSessionClearCookieHeader(env),
    },
  });
}

/**
 * The individual counterpart to requireFirmSession(), with the identical
 * "either a principal you can trust, or a Response you return immediately"
 * shape -- a caller that forgets `instanceof Response` fails type-narrowing
 * on `.emailNormalized`, so skipping the check is a compile error rather
 * than a silent auth bypass.
 *
 * Note what it CANNOT return: a firmId. An individual principal has no firm
 * and no way to acquire one, because this reads a different table than
 * verifySession() does.
 */
export async function requireSubscriberSession(
  request: Request,
  env: Env
): Promise<{ emailNormalized: string; sessionId: string } | Response> {
  // Same content-type fix as requireFirmSession() -- see its own comment.
  const raw = getCookie(request, SUBSCRIBER_SESSION_COOKIE_NAME);
  if (!raw) {
    return jsonResponse(401, { error: "You need to sign in to view this." });
  }
  const result = await store.verifySubscriberSession(env.DB, raw);
  if (!result) {
    return jsonResponse(401, { error: "Your session has expired or is invalid. Please sign in again." });
  }
  return result;
}

/**
 * GET /subscriber/licenses -- every deadline tracked for the signed-in
 * email.
 *
 * Scoped ONLY by session.emailNormalized. There is deliberately no way to
 * ask for someone else's: no id parameter, no email parameter, nothing
 * client-supplied reaches the query at all.
 *
 * `managed_by_firm` is the important field. A staffer added by their firm
 * genuinely has this licence tracked and already receives its reminder
 * emails, so hiding those rows would show them an incomplete picture of
 * their own deadlines -- but the rows belong to the firm's roster, and
 * letting an individual edit or delete one would silently punch a hole in
 * that firm's coverage. So they're shown, flagged, and read-only. The one
 * control they keep is the unsubscribe link already in every reminder
 * email, which is a legal right rather than ours to withhold.
 */
async function handleSubscriberLicensesList(request: Request, env: Env): Promise<Response> {
  const session = await requireSubscriberSession(request, env);
  if (session instanceof Response) return session;

  const rows = await store.listSubscriberLicenses(env.DB, session.emailNormalized);
  const asOf = new Date();
  const items = rows.map((r) => ({
    // Reuses the firm dashboard's own derivations rather than
    // re-implementing them -- one definition of "next deadline" and one of
    // "status" across both tiers, so the two views can never disagree about
    // the same row.
    id: r.id,
    state_slug: r.state_slug,
    state_name: stateNameForSlug(r.state_slug),
    license_type_id: firmLicenseLicenseTypeId(r),
    status: firmLicenseStatus(r),
    next_deadline: firmLicenseNextDeadline(r, asOf),
    deadline_source: r.deadline_source,
    cycle: r.cycle,
    created_at: r.created_at,
    stopped_at: r.stopped_at,
    stop_reason: r.stop_reason,
    managed_by_firm: r.firm_id !== null,
    // Intentionally ABSENT: unsubscribe_token, confirm_token,
    // renewed_token, cooldown_key, firm_id, staff_label. The tokens are
    // live bearer credentials and must never reach a page; firm_id and
    // staff_label are the firm's internal data about this person, and the
    // boolean above carries everything the UI actually needs from them.
  }));
  items.sort((a, b) => {
    const ad = a.next_deadline;
    const bd = b.next_deadline;
    if (ad === null && bd === null) return 0;
    if (ad === null) return 1;
    if (bd === null) return -1;
    return ad < bd ? -1 : ad > bd ? 1 : 0;
  });
  // Roadmap #12: first_name/reminder_thresholds are PERSON-level (every
  // row sharing this email carries the same value -- see
  // setSubscriberFirstName()/setSubscriberReminderThresholds()'s own
  // "every row sharing this email" reach), so they're surfaced once here
  // rather than per-license, for the self-service profile form to
  // pre-fill. Read from the first row; every row agrees by construction.
  let reminderThresholds: number[] | null = null;
  if (rows[0]?.reminder_thresholds) {
    try {
      const parsed = JSON.parse(rows[0].reminder_thresholds);
      if (Array.isArray(parsed) && parsed.length > 0) reminderThresholds = parsed;
    } catch {
      // Malformed value somehow reached storage -- same fall-through
      // posture as scheduler.ts's own parse.
    }
  }
  return jsonResponse(200, {
    email: session.emailNormalized,
    first_name: rows[0]?.first_name ?? null,
    reminder_thresholds: reminderThresholds,
    licenses: items,
  });
}

// ---------------------------------------------------------------------------
// Staff self-service CPE entry (2026-08-05). The "/my/" page used to be
// read-only by design (see build_my_page()'s own docstring in generate.py) --
// this is the first WRITE capability added to it, deliberately narrow: a
// signed-in subscriber may only ever touch cpe_entries rows scoped to their
// OWN subscriber row(s), proven by email match (store.addCpeEntryForSubscriber()),
// never by anything client-supplied. Free individuals (no firm_id) cannot
// have CPE entries at all -- cpe_entries.firm_id is NOT NULL by schema
// (migration 0009) -- so this only ever does anything for firm-tracked staff.
// ---------------------------------------------------------------------------

/** GET /subscriber/cpe -- every non-deleted CPE entry across every
 * subscriber row this signed-in email owns. Empty for a free individual, not
 * an error -- see this section's own comment for why. */
async function handleSubscriberCpeEntriesList(request: Request, env: Env): Promise<Response> {
  const session = await requireSubscriberSession(request, env);
  if (session instanceof Response) return session;

  const rows = await store.listCpeEntriesForSubscriberEmail(env.DB, session.emailNormalized);
  return jsonResponse(200, { entries: rows.map(toCpeEntryJson) });
}

/**
 * POST /subscriber/cpe -- body: subscriber_id (which of the signed-in
 * email's tracked licenses this is for), entry_date, hours, category,
 * description. Validation is deliberately duplicated from handleCpeEntryCreate()
 * rather than shared: the two differ in exactly one place (how ownership is
 * proven -- firm_id vs email), and sharing would mean threading a
 * discriminated-union principal through one function for a handful of
 * identical lines.
 */
async function handleSubscriberCpeEntryCreate(request: Request, env: Env): Promise<Response> {
  const session = await requireSubscriberSession(request, env);
  if (session instanceof Response) return session;

  // CSRF defense-in-depth (2026-08-05) -- see handleFirmLicenseCreate's own comment.
  if (!originAllowed(request, env)) {
    return jsonResponse(400, { error: "That request couldn't be completed. Please try again from the DeadlineRadar site." });
  }

  const allowed = await checkRateLimit(env.DB, session.emailNormalized, "subscriber_cpe_create", RATE_LIMIT_SUBSCRIBER_CPE_CREATE);
  if (!allowed) {
    return jsonResponse(429, { error: "Too many entries logged today. Please try again tomorrow." });
  }

  const parsed = await readFirmLicenseJsonBody(request); // generic despite the name -- see that function's own signature
  if (parsed instanceof Response) return parsed;
  const form = stringFieldsOf(parsed);

  for (const value of Object.values(form)) {
    if (hasControlChars(value)) {
      return jsonResponse(400, { error: "Invalid characters in submission." });
    }
  }

  const subscriberId = (form.subscriber_id ?? "").trim();
  if (!subscriberId) {
    return jsonResponse(400, { error: "Missing subscriber_id." });
  }

  const entryDateParsed = parseStrictIsoDate(form.entry_date ?? "");
  if (!entryDateParsed) {
    return jsonResponse(400, { error: "Please enter a valid completion date." });
  }
  const entryDateIso = (form.entry_date ?? "").trim();
  // Same one-UTC-day grace window as handleCpeEntryCreate() -- see that
  // handler's own comment for why a raw `> Date.now()` comparison would
  // wrongly reject a same-day entry from most positive-UTC-offset timezones.
  const now = new Date();
  const utcTodayPlusOneDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  if (entryDateParsed.getTime() > utcTodayPlusOneDay) {
    return jsonResponse(400, { error: "Completion date can't be in the future." });
  }

  const hours = parseStrictCpeHours(form.hours ?? "");
  if (hours === null) {
    return jsonResponse(400, { error: `Please enter a valid number of hours (greater than 0, up to ${MAX_CPE_HOURS_PER_ENTRY}).` });
  }

  const categoryRaw = (form.category ?? "general").trim();
  if (!isValidCpeCategory(categoryRaw)) {
    return jsonResponse(400, { error: "Category must be general, ethics, or other." });
  }

  const descriptionRaw = (form.description ?? "").trim();
  const description = descriptionRaw.length > 0 ? sanitizeFreeText(descriptionRaw, MAX_CPE_DESCRIPTION_LEN) : null;

  const created = await store.addCpeEntryForSubscriber(env.DB, session.emailNormalized, {
    subscriberId,
    entryDate: entryDateIso,
    hours,
    category: categoryRaw,
    description,
  });
  if (!created) return jsonResponse(404, { error: "Not found." });

  return jsonResponse(201, toCpeEntryJson(created));
}

/**
 * POST /firm/staff-cpe-reminder -- body: subscriber_id. Admin-triggered
 * nudge (2026-08-05): mints the SAME subscriber magic-link token
 * issueAndSendSubscriberLoginLink() uses, but with copy specific to "log
 * your CPE hours" (buildStaffCpeReminderEmail) naming the firm that asked --
 * same transparency convention as buildFirmStaffAddedEmail(). Response is
 * deliberately honest about WHY nothing sent (suppressed / cap hit / no
 * SendGrid key) rather than a blanket "sent" -- this is an authenticated
 * admin action against their own roster, not a public route, so there is no
 * enumeration risk in telling the truth, and an admin wondering why a
 * staffer never got the email is exactly the confusion this avoids.
 */
async function handleFirmStaffCpeReminder(request: Request, env: Env): Promise<Response> {
  // migration 0045 (roadmap #11/#13/#14): Staff stays read-only on roster
  // actions -- sending a reminder is a write-shaped action even though it
  // doesn't touch the roster row itself.
  const session = await requireFirmRole(request, env, "partner", "office_manager");
  if (session instanceof Response) return session;

  // CSRF defense-in-depth (2026-08-05) -- see handleFirmLicenseCreate's own comment.
  if (!originAllowed(request, env)) {
    return jsonResponse(400, { error: "That request couldn't be completed. Please try again from the DeadlineRadar site." });
  }

  const allowed = await checkRateLimit(env.DB, session.firmId, "firm_staff_cpe_reminder", RATE_LIMIT_FIRM_STAFF_CPE_REMINDER);
  if (!allowed) {
    return jsonResponse(429, { error: "Too many reminders sent today. Please try again tomorrow." });
  }

  const parsed = await readFirmLicenseJsonBody(request);
  if (parsed instanceof Response) return parsed;
  const form = stringFieldsOf(parsed);
  const subscriberId = (form.subscriber_id ?? "").trim();
  if (!subscriberId) return jsonResponse(400, { error: "Missing subscriber_id." });

  const staffRow = await store.getFirmLicense(env.DB, session.firmId, subscriberId);
  if (!staffRow) return jsonResponse(404, { error: "Not found." });

  let sent = false;
  let reason: string | null = null;
  // AuditLab DEMO-4 (MEDIUM, 2026-08-07): a demo visitor can set a roster
  // row's email to ANY address and this handler mints and mails a real
  // subscriber login token to it -- an email-arbitrary-third-parties
  // primitive reachable from a password published on our own site,
  // drawing on the shared daily send cap. Gate the SEND, not the request
  // itself -- the demo stays fully interactive, no third party ever hears
  // from us. Same "gate the send, not the edit" line DEMO-3 already draws
  // for the dismiss-endpoint class of finding.
  if (session.firm.demo_locked) {
    reason = "This is a shared demo account -- emails aren't sent from it.";
  } else if (!env.SENDGRID_API_KEY) {
    reason = "Email sending isn't configured.";
  } else if (await store.isPermanentlySuppressed(env.DB, staffRow.email)) {
    reason = "This person has unsubscribed from all emails, so we can't reach them.";
  } else {
    try {
      const underCap = await checkAndCountActionSend(env.DB, dailySendCap(env));
      if (!underCap) {
        reason = "Today's email limit has been reached. Please try again tomorrow.";
      } else {
        const { rawToken } = await store.createSubscriberLoginToken(env.DB, staffRow.email);
        const loginUrl = `${actionBaseUrl(env)}/subscriber/login/verify?token=${encodeURIComponent(rawToken)}`;
        const built = buildStaffCpeReminderEmail(loginUrl, session.firm.name, stateNameFromSlug(staffRow.state_slug));
        sent = await sendViaSendGrid(env.SENDGRID_API_KEY, staffRow.email, built, env.EMAIL_ALLOWLIST);
        if (!sent) reason = "Something went wrong sending the email. Please try again.";
      }
    } catch {
      reason = "Something went wrong sending the email. Please try again.";
    }
  }

  return jsonResponse(200, { sent, reason });
}

// ---------------------------------------------------------------------------
// Firm-dashboard MVP (2026-07-28, step 2/3) -- staff license CRUD,
// /firm/licenses*. EVERY handler below starts with requireFirmSession() as
// its very first line, per that function's own docstring. These are a JSON
// API (the dashboard's own frontend, not a public HTML form) -- request
// bodies are parsed as JSON, not application/x-www-form-urlencoded, and
// responses are JSON, not the errorPage()/htmlPage() HTML this file's public
// routes return. Deliberately do NOT run the honeypot/Turnstile/anonymous-IP
// rate-limit hardening the public /subscribe form needs (see this build's
// task doc: the requester already proved firm ownership via a verified
// session, not an anonymous form submission) -- but DO still validate every
// field (control chars, length, email format, state slug) exactly like
// handleSubscribe() does, and DO still rate-limit staff creation, keyed on
// the firm id rather than an IP (see RATE_LIMIT_FIRM_LICENSE_CREATE's own
// comment).
// ---------------------------------------------------------------------------

const MAX_FIRM_LICENSE_BODY_BYTES = MAX_BODY_BYTES;

/**
 * Reads and JSON-parses a request body for the /firm/licenses* routes,
 * capped at the same size this codebase already enforces on every other
 * request body (MAX_BODY_BYTES) and tolerant of an empty body (treated as
 * `{}`, so a PATCH with nothing to change isn't an error). Returns a
 * ready-to-return error Response on any failure, or the parsed object on
 * success -- same "Response | T" calling convention as resolveDeadlineInput()
 * above, for the same reason (a caller that forgets to check
 * `instanceof Response` fails type-narrowing, not silently misbehaves).
 */
async function readFirmLicenseJsonBody(request: Request): Promise<Record<string, unknown> | Response> {
  // CSRF defense-in-depth (2026-08-05, orchestrator abuse-test pass): this
  // never checked Content-Type, so a cross-site <form enctype="text/plain">
  // posting a JSON-shaped body would be accepted on content alone --
  // text/plain is one of the fetch spec's "simple" content types, meaning a
  // cross-site form submission carrying it never triggers a CORS preflight,
  // unlike a real application/json fetch() would. Requiring the real
  // content type here closes that specific bypass; originAllowed() (added
  // to every caller of this function) is the other, independent layer.
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return jsonResponse(400, { error: "Expected a JSON request body." });
  }
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return jsonResponse(400, { error: "Something went wrong processing that request." });
  }
  if (raw.length > MAX_FIRM_LICENSE_BODY_BYTES) {
    return jsonResponse(400, { error: "Request body too large." });
  }
  if (raw.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return jsonResponse(400, { error: "Request body must be a JSON object." });
    }
    return parsed as Record<string, unknown>;
  } catch {
    return jsonResponse(400, { error: "Malformed JSON body." });
  }
}

/** Every string-valued field in a parsed JSON body, for the same
 * every-field control-char check handleSubscribe() runs on its form fields. */
function stringFieldsOf(body: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(body)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

const DEADLINE_FIELD_KEYS = ["birth_month", "birth_year", "cohort_group", "license_type_id", "license_expiration_date"];

/** The dashboard's clean status vocabulary (loosely mirrors generate.py's
 * illustrative _MOCKUP_STATUS_CLASS terminology -- Confirmed/Pending/Needs
 * attention -- though that's frontend copy for a marketing mockup, not this
 * API's contract to match verbatim). A row stopped for any reason OTHER than
 * STOP_REASON_REMOVED_BY_ADMIN (which listFirmLicenses() already filters out
 * entirely -- see that function's own comment) surfaces as "needs-attention"
 * so the admin notices someone stopped getting reminders unexpectedly,
 * rather than that record silently vanishing from the roster. */
/**
 * HYBRID consent model (2026-07-28): a firm-added staffer is ACTIVE the
 * moment they're added (see store.ts's addPending() `skipConfirmation`) --
 * there is no more "pending" state on this path going forward. "pending" is
 * kept in the return type/mapping only for OLD rows that predate this model
 * (a stale preview record, or a genuine in-flight free-tier row that
 * somehow ended up firm-scoped) so this function degrades sensibly rather
 * than mislabeling them, not because new firm-add rows can produce it.
 * "opted_out" is split out from the old catch-all "needs-attention" bucket
 * specifically so an admin can see, at a glance, who exercised the one-click
 * opt-out this consent model depends on -- a self-serve "renewed but not yet
 * re-armed" row (stop_reason='renewed') is a different situation and stays
 * "needs-attention".
 */
function firmLicenseStatus(row: store.SubscriberRow): "active" | "pending" | "opted_out" | "needs-attention" {
  if (row.status === store.STATUS_CONFIRMED) return "active";
  if (row.status === store.STATUS_PENDING) return "pending";
  if (row.status === store.STATUS_STOPPED && row.stop_reason === "unsubscribed") return "opted_out";
  return "needs-attention";
}

const MAX_RULE_CHANGE_FIELD_LEN = 2000;
const MAX_RULE_CHANGE_SHORT_FIELD_LEN = 200;

/**
 * POST /firm/rule-change/notify -- live request off the Calendar's
 * rule-change badges (2026-08-06): "notify staff in that state." Body:
 * `state_slug`, `jurisdiction`, `summary`, `effective_date_label`,
 * `citation_url` (optional). Every field is content the client already
 * renders publicly in the rule-change modal (DR_RULE_CHANGE_EVENTS, baked
 * into the page at build time) -- there is no separate server-side copy of
 * this data to look up by id, so the client passes the specific event's own
 * fields through rather than duplicating a whole data-sync pipeline for a
 * single admin-triggered action. Treated as untrusted display text
 * regardless (length-capped, control-char-checked) -- the same posture
 * every other admin-supplied string in an email gets, not a new exception.
 *
 * Emails every roster staffer licensed in state_slug who hasn't opted out
 * (firmLicenseStatus() !== "opted_out") -- pending/needs-attention staff
 * still get it, since a rule change isn't about their own deadline status.
 * One click can reach the whole state at once, so the rate limit bounds
 * CLICKS (RATE_LIMIT_FIRM_RULE_CHANGE_NOTIFY's own comment), and each send
 * still goes through the SAME suppression list and daily send cap as any
 * other outbound mail this file sends.
 */
async function handleFirmRuleChangeNotify(request: Request, env: Env): Promise<Response> {
  // migration 0045 (roadmap #11/#13/#14): same reasoning as
  // handleFirmStaffCpeReminder() -- Staff stays read-only.
  const session = await requireFirmRole(request, env, "partner", "office_manager");
  if (session instanceof Response) return session;

  if (!originAllowed(request, env)) {
    return jsonResponse(400, { error: "That request couldn't be completed. Please try again from the DeadlineRadar site." });
  }

  const allowed = await checkRateLimit(env.DB, session.firmId, "firm_rule_change_notify", RATE_LIMIT_FIRM_RULE_CHANGE_NOTIFY);
  if (!allowed) {
    return jsonResponse(429, { error: "Too many notifications sent today. Please try again tomorrow." });
  }

  const parsed = await readFirmLicenseJsonBody(request);
  if (parsed instanceof Response) return parsed;
  const form = stringFieldsOf(parsed);

  const stateSlug = (form.state_slug ?? "").trim();
  const jurisdiction = (form.jurisdiction ?? "").trim();
  const summary = (form.summary ?? "").trim();
  const effectiveDateLabel = (form.effective_date_label ?? "").trim();
  const citationUrlRaw = (form.citation_url ?? "").trim();

  if (!stateSlug || !jurisdiction || !summary || !effectiveDateLabel) {
    return jsonResponse(400, { error: "Missing rule-change details." });
  }
  for (const [value, maxLen] of [
    [stateSlug, MAX_RULE_CHANGE_SHORT_FIELD_LEN],
    [jurisdiction, MAX_RULE_CHANGE_SHORT_FIELD_LEN],
    [summary, MAX_RULE_CHANGE_FIELD_LEN],
    [effectiveDateLabel, MAX_RULE_CHANGE_SHORT_FIELD_LEN],
    [citationUrlRaw, MAX_RULE_CHANGE_FIELD_LEN],
  ] as const) {
    if (hasControlChars(value) || value.length > maxLen) {
      return jsonResponse(400, { error: "Invalid rule-change details." });
    }
  }
  // Belt-and-suspenders: only ever actually link a citation that looks like
  // a real http(s) URL, never whatever a tampered client sent through as
  // citation_url (mailto:/javascript:/plain text, etc.) -- see button()'s
  // own href handling in emails.ts, which trusts this value verbatim.
  const citationUrl = /^https:\/\//.test(citationUrlRaw) ? citationUrlRaw : null;

  const roster = await store.listFirmLicenses(env.DB, session.firmId);
  const targets = roster.filter(
    (row) => row.state_slug === stateSlug && firmLicenseStatus(row) !== "opted_out"
  );

  // AuditLab DEMO-4 (MEDIUM, 2026-08-07): fans out to every roster staffer
  // in the state -- see handleFirmStaffCpeReminder's own comment for the
  // "gate the send, not the edit" reasoning.
  const demoLocked = session.firm.demo_locked;
  let sent = 0;
  let skipped = 0;
  if (demoLocked) {
    skipped = targets.length;
  } else if (targets.length > 0 && env.SENDGRID_API_KEY) {
    const stateName = stateNameFromSlug(stateSlug);
    const built = buildRuleChangeNotificationEmail(
      session.firm.name ?? "Your firm",
      jurisdiction,
      stateName,
      summary,
      effectiveDateLabel,
      citationUrl
    );
    for (const target of targets) {
      if (await store.isPermanentlySuppressed(env.DB, target.email)) {
        skipped++;
        continue;
      }
      const underCap = await checkAndCountActionSend(env.DB, dailySendCap(env));
      if (!underCap) {
        skipped += targets.length - sent - skipped;
        break;
      }
      const ok = await sendViaSendGrid(env.SENDGRID_API_KEY, target.email, built, env.EMAIL_ALLOWLIST);
      if (ok) sent++;
      else skipped++;
    }
  } else {
    skipped = targets.length;
  }

  return jsonResponse(200, {
    sent,
    skipped,
    total: targets.length,
    reason: demoLocked
      ? "This is a shared demo account -- emails aren't sent from it."
      : !env.SENDGRID_API_KEY
        ? "Email sending isn't configured."
        : null,
  });
}

// ---------------------------------------------------------------------------
// Public /roadmap/ voting (Task #19, 2026-08-06). See migration 0029's own
// docstring for the full design reasoning: anonymous cookie-based voting
// (no account, no email required), a separate opt-in "notify me when this
// ships" that DOES require a confirm-click, an operator-curated idea list
// (no free-form submission -- zero moderation surface to build).
// ---------------------------------------------------------------------------

const ROADMAP_VOTER_COOKIE_NAME = "dr_roadmap_voter";
// A year -- long enough that a real repeat visitor's vote still "sticks"
// without them re-voting, short enough that this isn't presented as a
// permanent identifier. Not a security boundary (see migration 0029's own
// docstring on why voting is deliberately low-friction, not high-assurance).
const ROADMAP_VOTER_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

function roadmapVoterCookieHeader(voterId: string, env: Env): string {
  return (
    `${ROADMAP_VOTER_COOKIE_NAME}=${encodeURIComponent(voterId)}; HttpOnly; Secure; ` +
    `SameSite=${firmSessionCookieSameSite(env)}; Path=/; Max-Age=${ROADMAP_VOTER_COOKIE_MAX_AGE_SECONDS}`
  );
}

/** GET /roadmap-data -- public, no session. Returns every active idea with
 * its live vote count and whether THIS browser (by cookie) already voted
 * for it. No cookie yet (first-ever visit) reads as "voted nothing", never
 * an error -- an anonymous GET has nothing to mint a cookie FOR until a
 * real vote happens. */
async function handleRoadmapData(request: Request, env: Env): Promise<Response> {
  const voterId = getCookie(request, ROADMAP_VOTER_COOKIE_NAME) ?? "";
  const ideas = await store.listActiveFeatureIdeasWithVotes(env.DB, voterId);
  return jsonResponse(200, {
    ideas: ideas.map((i) => ({
      id: i.id,
      title: i.title,
      description: i.description,
      status: i.status,
      vote_count: i.vote_count,
      voted_by_me: i.voted_by_me,
    })),
  });
}

/** POST /roadmap/vote -- body: `idea_id`. Public, no session -- see this
 * section's own header comment for the full anti-abuse layering (IP rate
 * limit + Turnstile here, UNIQUE(idea_id, voter_id) at the DB layer doing
 * the actual dedup work). Mints a voter cookie on first-ever vote if the
 * request didn't already carry one. */
async function handleRoadmapVote(request: Request, env: Env, ip: string): Promise<Response> {
  if (!originAllowed(request, env)) {
    return jsonResponse(400, { error: "That request couldn't be completed. Please try again from the DeadlineRadar site." });
  }

  const allowed = await checkRateLimit(env.DB, ip, "roadmap_vote", RATE_LIMIT_ROADMAP_VOTE);
  if (!allowed) {
    return jsonResponse(429, { error: "Too many votes from this address. Please try again later." });
  }

  const parsed = await readFirmLicenseJsonBody(request); // generic despite the name -- see that function's own signature
  if (parsed instanceof Response) return parsed;
  const form = stringFieldsOf(parsed);
  const ideaId = (form.idea_id ?? "").trim();
  if (!ideaId || hasControlChars(ideaId)) {
    return jsonResponse(400, { error: "Missing idea_id." });
  }

  const turnstileOk = await verifyTurnstile(form["cf-turnstile-response"], env.TURNSTILE_SECRET_KEY, true);
  if (!turnstileOk) {
    return jsonResponse(400, { error: "Verification failed -- please try again." });
  }

  if (!(await store.ideaExists(env.DB, ideaId))) {
    return jsonResponse(404, { error: "Not found." });
  }

  let voterId = getCookie(request, ROADMAP_VOTER_COOKIE_NAME);
  const mintedNewVoterId = !voterId;
  if (!voterId) voterId = store.newToken();

  await store.recordFeatureIdeaVote(env.DB, ideaId, voterId);
  const ideas = await store.listActiveFeatureIdeasWithVotes(env.DB, voterId);
  const updated = ideas.find((i) => i.id === ideaId);

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (mintedNewVoterId) headers["Set-Cookie"] = roadmapVoterCookieHeader(voterId, env);
  return new Response(JSON.stringify({ vote_count: updated?.vote_count ?? 0, voted_by_me: true }), { status: 200, headers });
}

/** POST /roadmap/notify-signup -- body: `idea_id`, `email`. Public, no
 * session. Sends a confirm-click email (nothing is stored as confirmed
 * until that's clicked -- see store.createFeatureIdeaNotifySignup()'s own
 * docstring). Reuses the same email-blocklist gate signup uses (Task #7)
 * and Turnstile the same way every other public form here does. */
async function handleRoadmapNotifySignup(request: Request, env: Env, ip: string): Promise<Response> {
  if (!originAllowed(request, env)) {
    return jsonResponse(400, { error: "That request couldn't be completed. Please try again from the DeadlineRadar site." });
  }

  const allowed = await checkRateLimit(env.DB, ip, "roadmap_notify_signup", RATE_LIMIT_ROADMAP_NOTIFY_SIGNUP);
  if (!allowed) {
    return jsonResponse(429, { error: "Too many requests from this address. Please try again later." });
  }

  const parsed = await readFirmLicenseJsonBody(request);
  if (parsed instanceof Response) return parsed;
  const form = stringFieldsOf(parsed);
  const ideaId = (form.idea_id ?? "").trim();
  const email = (form.email ?? "").trim();
  if (!ideaId || hasControlChars(ideaId)) {
    return jsonResponse(400, { error: "Missing idea_id." });
  }
  if (!isValidEmail(email)) {
    return jsonResponse(400, { error: "That doesn't look like a valid email address." });
  }
  if (await store.isEmailBlocklisted(env.DB, email)) {
    return jsonResponse(400, { error: "We're not able to use that address right now." });
  }

  const turnstileOk = await verifyTurnstile(form["cf-turnstile-response"], env.TURNSTILE_SECRET_KEY, true);
  if (!turnstileOk) {
    return jsonResponse(400, { error: "Verification failed -- please try again." });
  }

  const idea = (await store.listActiveFeatureIdeasWithVotes(env.DB, "")).find((i) => i.id === ideaId);
  if (!idea) {
    return jsonResponse(404, { error: "Not found." });
  }

  let sent = false;
  if (env.SENDGRID_API_KEY) {
    const signup = await store.createFeatureIdeaNotifySignup(env.DB, ideaId, email);
    if (signup) {
      const underCap = await checkAndCountActionSend(env.DB, dailySendCap(env));
      if (underCap) {
        const confirmUrl = `${actionBaseUrl(env)}/roadmap/notify-confirm?token=${encodeURIComponent(signup.rawToken)}`;
        const built = buildFeatureIdeaNotifyConfirmEmail(idea.title, confirmUrl);
        sent = await sendViaSendGrid(env.SENDGRID_API_KEY, email, built, env.EMAIL_ALLOWLIST);
      }
    } else {
      // Already confirmed for this idea -- nothing to (re-)send, but this
      // is success from the caller's perspective (they're already on the list).
      sent = true;
    }
  }

  // Same anti-enumeration posture as every other public form here: no
  // distinction in the response between "sent", "already confirmed", and
  // "SendGrid not configured" -- a generic acknowledgement either way.
  return jsonResponse(200, { ok: true, sent });
}

async function handleRoadmapNotifyConfirm(env: Env, token: string | null): Promise<Response> {
  if (!token) return errorPage(400, "Missing confirmation link.");
  const confirmed = await store.confirmFeatureIdeaNotifySignup(env.DB, token);
  if (!confirmed) return errorPage(404, "That link is invalid or already used.");
  return htmlResponse(
    200,
    htmlPage("Confirmed", "<h1>Done</h1><p>You'll get an email if and when this ships.</p>")
  );
}

/** Reuses deadline.ts's own computeSubscriberDeadline() -- never
 * re-implements the date math, per this build's own instructions. */
function firmLicenseNextDeadline(row: store.SubscriberRow, asOf: Date): string | null {
  if (row.deadline_source === store.DEADLINE_SOURCE_USER) {
    return row.user_deadline;
  }
  let fields: Record<string, string>;
  try {
    fields = JSON.parse(row.deadline_fields || "{}");
  } catch {
    return null;
  }
  const d = computeSubscriberDeadline(row.state_slug, fields, asOf);
  return d ? d.toISOString().slice(0, 10) : null;
}

/** Only the fixed-calendar "multiple records per state" family
 * (deadline.ts's computeSubscriberDeadline license_type_id branch --
 * Florida's odd/even cohort, Georgia's individual-vs-firm, etc.) actually
 * has a license_type_id; California/Texas/Ohio use different per-state
 * fields and "bring your own date" states have none at all -- null in every
 * one of those cases, not an error. */
function firmLicenseLicenseTypeId(row: store.SubscriberRow): string | null {
  try {
    const fields = JSON.parse(row.deadline_fields || "{}") as Record<string, string>;
    return fields.license_type_id ?? null;
  } catch {
    return null;
  }
}

function toFirmLicenseJson(row: store.SubscriberRow, asOf: Date): Record<string, unknown> {
  return {
    id: row.id,
    staff_label: row.staff_label,
    email: row.email,
    state_slug: row.state_slug,
    state_name: stateNameForSlug(row.state_slug),
    license_type_id: firmLicenseLicenseTypeId(row),
    status: firmLicenseStatus(row),
    next_deadline: firmLicenseNextDeadline(row, asOf),
    deadline_source: row.deadline_source,
    cycle: row.cycle,
    // 2026-07-30 (BUILD v2 Phase B) -- surfaces columns this table has always
    // had (created_at since migration 0001, confirmed_at/stopped_at/
    // stop_reason since the HYBRID consent model) for the dashboard's
    // "recent activity" panel. last_edited_at/renewed_at (migration 0017,
    // 2026-08-04) closed the gap this comment used to describe -- PATCH and
    // POST .../renew now stamp real timestamps for those facts instead of
    // the dashboard having nothing to show for an edit or a renewal.
    created_at: row.created_at,
    confirmed_at: row.confirmed_at,
    stopped_at: row.stopped_at,
    stop_reason: row.stop_reason,
    last_edited_at: row.last_edited_at,
    renewed_at: row.renewed_at,
    // Roadmap #7: self-reported, in cents -- see migration 0034's own
    // docstring for why this is never a verified/sourced fact. The
    // dashboard's own client-side roster sum (drRenderStats()) is the
    // rollup; no separate aggregate endpoint needed for it.
    renewal_fee_cents: row.renewal_fee_cents,
    // Roadmap #10: self-reported carryover hours -- see migration 0036's own
    // docstring for why this is never a state-asserted fact.
    carryover_hours: row.carryover_hours,
    // Roadmap #16: office/department tag -- see migration 0037's own docstring.
    office_tag: row.office_tag,
    // Roadmap #68: internal-only note -- see migration 0041's own docstring.
    internal_notes: row.internal_notes,
    // Roadmap #26: self-service snooze the subscriber set themselves from
    // a reminder email -- surfaced so the admin isn't left guessing why
    // someone stopped getting reminders. Read-only from the dashboard's
    // side; only the subscriber's own link (or a renewal) can change it.
    snoozed_until: row.snoozed_until,
  };
}

/** GET /firm/licenses -- every roster row for the session's firm, sorted by
 * soonest deadline first (a null/uncomputable deadline sorts last -- there's
 * nothing more urgent to show for it). */
async function handleFirmLicensesList(request: Request, env: Env): Promise<Response> {
  const session = await requireFirmSessionWithFirm(request, env);
  if (session instanceof Response) return session;

  const rows = await store.listFirmLicenses(env.DB, session.firmId);
  const asOf = new Date();
  const items = rows.map((r) => toFirmLicenseJson(r, asOf));
  // Roadmap #66: "what changed since your last login" -- computed here
  // rather than a separate endpoint since this is already the one call the
  // dashboard makes on every load.
  const previousLoginAt = await store.getPreviousLoginAt(env.DB, session.firmId, session.sessionId);
  // Roadmap #144: computed here (not a separate endpoint) since this is
  // already the one call the dashboard makes on every load. demo_locked
  // firms are never prompted (caught live 2026-08-07, the prompt fired on
  // the shared demo account minutes after #144 shipped): anonymous demo
  // visitors answering NPS would pollute the only real product-feedback
  // signal this survey exists to collect.
  const npsPromptDue = !session.firm.demo_locked && store.shouldPromptNps(session.firm);
  items.sort((a, b) => {
    const ad = a.next_deadline as string | null;
    const bd = b.next_deadline as string | null;
    if (ad === null && bd === null) return 0;
    if (ad === null) return 1;
    if (bd === null) return -1;
    return ad < bd ? -1 : ad > bd ? 1 : 0;
  });
  // AuditLab ST-1: every date above is derived from the same reference data
  // the write guards (checkDataFreshness()) can refuse to trust -- surface
  // its freshness here too instead of rendering it silently, since the
  // dashboard has no other signal that adding a new staff member could be
  // refused right now. (Not "Mark renewed" -- that route stays unguarded on
  // purpose, see deadline.ts's dataFreshnessInfo() docstring; the dashboard
  // banner still discloses staleness while renew keeps working.)
  const freshness = dataFreshnessInfo(asOf);
  // seat_cap (2026-08-05, Devin's dashboard-polish request #1, tier-aware
  // since the same-day paid-tiers build): the cap was invisible until a firm
  // actually hit it and got a 402 from POST /firm/licenses -- the dashboard
  // had no way to show usage against a limit nobody could see coming.
  // seatCapForFirmTier() is the SAME lookup the create route enforces below,
  // not a second hardcoded number, so the two can never drift apart.
  return jsonResponse(200, {
    licenses: items,
    previous_login_at: previousLoginAt,
    nps_prompt_due: npsPromptDue,
    firm_name: session.firm.name ?? null,
    // Task #29 (2026-08-05): the Account tab's email-change form needs to
    // show what it's changing FROM. Safe to include -- this is the
    // session's own firm, the same trust boundary firm_name above already
    // crosses.
    admin_email: session.firm.admin_email,
    data_as_of: freshness.as_of_date,
    data_stale: freshness.stale,
    seat_cap: seatCapForFirmTier(session.firm.plan_tier),
    // Self-serve cancellation UI (migration 0021) reads these three to
    // decide what the Account tab's billing panel shows -- see
    // handleFirmBillingCancellationToggle()'s own docstring for why
    // cancel_at_period_end never implies a plan_tier change.
    plan_tier: session.firm.plan_tier,
    cancel_at_period_end: Boolean(session.firm.cancel_at_period_end),
    current_period_end: session.firm.current_period_end,
    // Account-tab lockdown (2026-08-06, reported live against the newly
    // public demo): the frontend needs this to grey out email/password/
    // billing/delete controls up front, rather than letting a demo visitor
    // fill out a form and only find out it's refused on submit.
    demo_locked: Boolean(session.firm.demo_locked),
    // migration 0045 (roadmap #11/#13/#14/#51): the Team panel needs to
    // know the CALLER's own role to decide which invite/manage controls to
    // show -- the backend is the real gate either way (every mutating
    // /firm/members/* route re-checks this itself), but rendering buttons
    // a Staff member can't use anyway is just noise, not defense-in-depth.
    role: session.role,
    member_id: session.memberId,
    // Task #19 (2026-08-06): drives the one-time post-signup feature-
    // request questionnaire prompt -- true until the firm either submits
    // it or explicitly skips it, never shown again after either.
    questionnaire_pending: session.firm.feature_questionnaire_dismissed_at === null,
    // Roadmap #28: drives the guided onboarding checklist panel -- true
    // until the firm explicitly dismisses it (it does NOT auto-dismiss on
    // completion; see migration 0030's own docstring for why).
    onboarding_checklist_pending: session.firm.onboarding_checklist_dismissed_at === null,
    // Roadmap #30: drives the auto-shown in-app product tour -- true until
    // the firm skips it or finishes the last step, never shown again after
    // either. A voluntary replay from the Account tab is client-side only
    // and never touches this flag.
    product_tour_pending: session.firm.product_tour_dismissed_at === null,
    // Roadmap #6: firm-level (not per-staff) peer-review due date, admin-
    // entered. Null when not tracked yet -- the client shows a "set a date"
    // prompt rather than a deadline in that case.
    peer_review_due_date: session.firm.peer_review_due_date,
    // Roadmap #19: optional reply-to for reminder emails sent to this
    // firm's tracked staff. Null when not set -- reminders keep their
    // existing (no explicit Reply-To) behavior.
    reply_to_email: session.firm.reply_to_email,
    // Roadmap #23: which of the 6 fixed escalation points this firm's
    // tracked staff receive. Null (parsed here, not just passed through)
    // means every threshold -- the client shouldn't have to know that a
    // raw-null column value means "everything" versus re-deriving that
    // itself.
    reminder_thresholds: session.firm.reminder_thresholds ? JSON.parse(session.firm.reminder_thresholds) : null,
    // Roadmap #9/#319: opt-out, defaults true -- see migration 0050's own
    // docstring for why on-by-default is the deliberate call here.
    rule_change_alerts_enabled: session.firm.rule_change_alerts_enabled !== 0,
  });
}

/** GET /firm/activity -- durable Recent Activity feed (Task #26, migration
 * 0025). Same read-gate as GET /firm/licenses -- a lapsed/pilot-expired firm
 * shouldn't see a working panel here either. Capped at 20 -- the dashboard
 * panel itself only ever renders the newest 6, but a small buffer avoids a
 * pointless re-fetch just because a couple of the newest 6 happen to filter
 * out client-side for some future reason. */
async function handleFirmActivityList(request: Request, env: Env): Promise<Response> {
  const session = await requireFirmSessionWithFirm(request, env);
  if (session instanceof Response) return session;

  const events = await store.listRecentActivity(env.DB, session.firmId, 20);
  return jsonResponse(200, {
    events: events.map((e) => ({
      id: e.id,
      staff_label: e.staff_label,
      email: e.email,
      event_type: e.event_type,
      created_at: e.created_at,
    })),
  });
}

/** GET /firm/audit-trail -- roadmap #8, the full "reasonable process"
 * export: EVERY roster event (activity_log, uncapped, unlike the small
 * Recent Activity panel's own 20-item cap) plus every real reminder-send
 * date (reminder_log, migration 0035). Same read-gate as GET /firm/licenses
 * -- a lapsed/expired firm shouldn't get a working export either. Staff
 * names are resolved from the CURRENT roster where possible (a removed
 * staffer's activity_log rows already carry their own snapshot label/email,
 * matching that table's own "outlive the row it describes" design). */
async function handleAuditTrail(request: Request, env: Env): Promise<Response> {
  const session = await requireFirmSessionWithFirm(request, env);
  if (session instanceof Response) return session;

  const [activity, reminders, licenses] = await Promise.all([
    store.listActivityLogForFirm(env.DB, session.firmId),
    store.listReminderLogForFirm(env.DB, session.firmId),
    store.listFirmLicenses(env.DB, session.firmId),
  ]);

  const staffById = new Map(licenses.map((l) => [l.id, l.staff_label || l.email]));

  return jsonResponse(200, {
    activity: activity.map((e) => ({
      id: e.id,
      staff_label: e.staff_label,
      email: e.email,
      event_type: e.event_type,
      created_at: e.created_at,
    })),
    reminders: reminders.map((r) => ({
      id: r.id,
      subscriber_id: r.subscriber_id,
      // Falls back to "Removed staff member" for a subscriber this firm no
      // longer has active -- same fallback label drRenderCpeRecent() already
      // uses client-side for the identical situation.
      staff_label: staffById.get(r.subscriber_id) || "Removed staff member",
      threshold_days: r.threshold_days,
      sent_at: r.sent_at,
    })),
  });
}

const MAX_QUESTIONNAIRE_FEATURES = 20;
const MAX_QUESTIONNAIRE_FEATURE_LEN = 100;
const MAX_QUESTIONNAIRE_OTHER_LEN = 1000;

/** POST /firm/questionnaire -- body: `selected_features` (array of
 * strings), `other_text` (optional). Task #19 (2026-08-06): the post-signup
 * feature-request prompt. Not validated against feature_ideas' exact id
 * list -- this is free-text-adjacent feedback for a human (Devin) to read,
 * not something that grants access to anything, so a loose length/count
 * cap is the right amount of validation, not an exact-match gate that
 * would just break the moment the checkbox list changes. */
async function handleFirmQuestionnaireSubmit(request: Request, env: Env): Promise<Response> {
  const session = await requireFirmSessionWithFirm(request, env);
  if (session instanceof Response) return session;

  if (!originAllowed(request, env)) {
    return jsonResponse(400, { error: "That request couldn't be completed. Please try again from the DeadlineRadar site." });
  }

  // AuditLab SEC-1 (2026-08-07): was missing on this and 6 sibling
  // endpoints, contradicting the /security/ page's own claim.
  const allowed = await checkRateLimit(env.DB, session.firmId, "firm_questionnaire_submit", RATE_LIMIT_FIRM_DISMISS);
  if (!allowed) {
    return jsonResponse(429, { error: "Too many attempts. Please try again later." });
  }

  // AuditLab DEMO-3 (LOW, 2026-08-06): a demo visitor's submit/dismiss must
  // never persist to the SHARED demo row (one visitor's action degrading
  // the next visitor's experience -- and a demo submit would be fake
  // feature-request data anyway). ok:true, not 403: the visitor's own modal
  // still closes normally for their visit; the write just never lands.
  if (session.firm.demo_locked) {
    return jsonResponse(200, { ok: true });
  }

  const parsed = await readFirmLicenseJsonBody(request);
  if (parsed instanceof Response) return parsed;
  const body = parsed as Record<string, unknown>;

  const rawFeatures = Array.isArray(body.selected_features) ? body.selected_features : [];
  if (rawFeatures.length > MAX_QUESTIONNAIRE_FEATURES) {
    return jsonResponse(400, { error: "Too many selections." });
  }
  const selectedFeatures: string[] = [];
  for (const f of rawFeatures) {
    if (typeof f !== "string" || f.length === 0 || f.length > MAX_QUESTIONNAIRE_FEATURE_LEN || hasControlChars(f)) {
      return jsonResponse(400, { error: "Invalid selection." });
    }
    selectedFeatures.push(f);
  }
  const otherText = sanitizeFreeText(typeof body.other_text === "string" ? body.other_text : null, MAX_QUESTIONNAIRE_OTHER_LEN);

  await store.submitFeatureQuestionnaire(env.DB, session.firmId, selectedFeatures, otherText);
  return jsonResponse(200, { ok: true });
}

/** POST /firm/questionnaire/dismiss -- skip without answering. Idempotent:
 * a firm that already dismissed (submitted or previously skipped) just
 * gets ok:true again, never an error. */
async function handleFirmQuestionnaireDismiss(request: Request, env: Env): Promise<Response> {
  const session = await requireFirmSessionWithFirm(request, env);
  if (session instanceof Response) return session;

  if (!originAllowed(request, env)) {
    return jsonResponse(400, { error: "That request couldn't be completed. Please try again from the DeadlineRadar site." });
  }

  // AuditLab SEC-1 (2026-08-07).
  const allowed = await checkRateLimit(env.DB, session.firmId, "firm_questionnaire_dismiss", RATE_LIMIT_FIRM_DISMISS);
  if (!allowed) {
    return jsonResponse(429, { error: "Too many attempts. Please try again later." });
  }

  // AuditLab DEMO-3 -- see handleFirmQuestionnaireSubmit's own comment.
  if (session.firm.demo_locked) {
    return jsonResponse(200, { ok: true });
  }

  await store.dismissFeatureQuestionnaire(env.DB, session.firmId);
  return jsonResponse(200, { ok: true });
}

/** POST /firm/onboarding-checklist/dismiss -- roadmap #28. Same shape as
 * handleFirmQuestionnaireDismiss just above (idempotent, session-gated). */
async function handleOnboardingChecklistDismiss(request: Request, env: Env): Promise<Response> {
  const session = await requireFirmSessionWithFirm(request, env);
  if (session instanceof Response) return session;

  if (!originAllowed(request, env)) {
    return jsonResponse(400, { error: "That request couldn't be completed. Please try again from the DeadlineRadar site." });
  }

  // AuditLab SEC-1 (2026-08-07).
  const allowed = await checkRateLimit(env.DB, session.firmId, "firm_onboarding_checklist_dismiss", RATE_LIMIT_FIRM_DISMISS);
  if (!allowed) {
    return jsonResponse(429, { error: "Too many attempts. Please try again later." });
  }

  // AuditLab DEMO-3 -- see handleFirmQuestionnaireSubmit's own comment.
  if (session.firm.demo_locked) {
    return jsonResponse(200, { ok: true });
  }

  await store.dismissOnboardingChecklist(env.DB, session.firmId);
  return jsonResponse(200, { ok: true });
}

/** POST /firm/product-tour/dismiss -- roadmap #30. Same shape as
 * handleOnboardingChecklistDismiss just above (idempotent, session-gated). */
async function handleProductTourDismiss(request: Request, env: Env): Promise<Response> {
  const session = await requireFirmSessionWithFirm(request, env);
  if (session instanceof Response) return session;

  if (!originAllowed(request, env)) {
    return jsonResponse(400, { error: "That request couldn't be completed. Please try again from the DeadlineRadar site." });
  }

  // AuditLab SEC-1 (2026-08-07).
  const allowed = await checkRateLimit(env.DB, session.firmId, "firm_product_tour_dismiss", RATE_LIMIT_FIRM_DISMISS);
  if (!allowed) {
    return jsonResponse(429, { error: "Too many attempts. Please try again later." });
  }

  // AuditLab DEMO-3 -- see handleFirmQuestionnaireSubmit's own comment.
  if (session.firm.demo_locked) {
    return jsonResponse(200, { ok: true });
  }

  await store.dismissProductTour(env.DB, session.firmId);
  return jsonResponse(200, { ok: true });
}

/** PATCH /firm/peer-review -- sets or clears the firm's own next peer-
 * review due date (roadmap #6, migration 0033). Body: { due_date: "YYYY-
 * MM-DD" | null }. Firm-level, not per-staff -- no subscriber id involved.
 * Same strict-ISO-date validation every per-staff deadline field already
 * uses (parseStrictIsoDate), so this can't silently store an unparseable
 * string that would break drDaysUntil()/drFormatDeadline() downstream. */
async function handlePeerReviewSet(request: Request, env: Env): Promise<Response> {
  // migration 0045 (roadmap #11/#13/#14): firm-level setting, same tier as
  // roster mutations -- Staff stays read-only.
  const session = await requireFirmRole(request, env, "partner", "office_manager");
  if (session instanceof Response) return session;

  if (!originAllowed(request, env)) {
    return jsonResponse(400, { error: "That request couldn't be completed. Please try again from the DeadlineRadar site." });
  }

  const allowed = await checkRateLimit(env.DB, session.firmId, "firm_peer_review_set", RATE_LIMIT_FIRM_PEER_REVIEW_SET);
  if (!allowed) {
    return jsonResponse(429, { error: "Too many changes. Please try again later." });
  }

  let body: Record<string, unknown>;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return jsonResponse(400, { error: "Request too large." });
    body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return jsonResponse(400, { error: "Something went wrong processing that request." });
  }

  if (body.due_date === null) {
    await store.setPeerReviewDueDate(env.DB, session.firmId, null);
    return jsonResponse(200, { peer_review_due_date: null });
  }

  const dueDateRaw = typeof body.due_date === "string" ? body.due_date.trim() : "";
  if (!parseStrictIsoDate(dueDateRaw)) {
    return jsonResponse(400, { error: "Please enter a valid date." });
  }

  await store.setPeerReviewDueDate(env.DB, session.firmId, dueDateRaw);
  return jsonResponse(200, { peer_review_due_date: dueDateRaw });
}

/** PATCH /firm/reply-to -- sets or clears the firm's own reply-to address
 * for reminder emails sent to its tracked staff (roadmap #19, migration
 * 0038). Body: { email: string | null }. Firm-level, same shape as
 * handlePeerReviewSet() above -- deliberately does NOT touch the sending
 * domain/from-address (still noreply@deadline-radar.com, still
 * DeadlineRadar's own CAN-SPAM footer) -- only the Reply-To header on
 * reminders this firm's staff receive. */
async function handleReplyToSet(request: Request, env: Env): Promise<Response> {
  // migration 0045 (roadmap #11/#13/#14): firm-level setting -- Staff
  // stays read-only.
  const session = await requireFirmRole(request, env, "partner", "office_manager");
  if (session instanceof Response) return session;

  if (!originAllowed(request, env)) {
    return jsonResponse(400, { error: "That request couldn't be completed. Please try again from the DeadlineRadar site." });
  }

  const allowed = await checkRateLimit(env.DB, session.firmId, "firm_reply_to_set", RATE_LIMIT_FIRM_REPLY_TO_SET);
  if (!allowed) {
    return jsonResponse(429, { error: "Too many changes. Please try again later." });
  }

  let body: Record<string, unknown>;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return jsonResponse(400, { error: "Request too large." });
    body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return jsonResponse(400, { error: "Something went wrong processing that request." });
  }

  if (body.email === null) {
    await store.setReplyToEmail(env.DB, session.firmId, null);
    return jsonResponse(200, { reply_to_email: null });
  }

  const emailRaw = typeof body.email === "string" ? body.email.trim() : "";
  if (!isValidEmail(emailRaw)) {
    return jsonResponse(400, { error: "That doesn't look like a valid email address." });
  }

  await store.setReplyToEmail(env.DB, session.firmId, emailRaw);
  return jsonResponse(200, { reply_to_email: emailRaw });
}

/** PATCH /firm/reminder-cadence -- sets or clears which of the 6 fixed
 * escalation points (roadmap #23, migration 0039) this firm's tracked staff
 * receive. Body: { thresholds: number[] | null }. See migration 0039's own
 * docstring for why this is a subset of a fixed set, not arbitrary values. */
async function handleReminderCadenceSet(request: Request, env: Env): Promise<Response> {
  // migration 0045 (roadmap #11/#13/#14): firm-level setting -- Staff
  // stays read-only, same as handlePeerReviewSet().
  const session = await requireFirmRole(request, env, "partner", "office_manager");
  if (session instanceof Response) return session;

  if (!originAllowed(request, env)) {
    return jsonResponse(400, { error: "That request couldn't be completed. Please try again from the DeadlineRadar site." });
  }

  const allowed = await checkRateLimit(env.DB, session.firmId, "firm_reminder_cadence_set", RATE_LIMIT_FIRM_REMINDER_CADENCE_SET);
  if (!allowed) {
    return jsonResponse(429, { error: "Too many changes. Please try again later." });
  }

  let body: Record<string, unknown>;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return jsonResponse(400, { error: "Request too large." });
    body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return jsonResponse(400, { error: "Something went wrong processing that request." });
  }

  if (body.thresholds === null) {
    await store.setReminderThresholds(env.DB, session.firmId, null);
    return jsonResponse(200, { reminder_thresholds: null });
  }

  const parsed = parseReminderThresholds(body.thresholds);
  if (!parsed) {
    return jsonResponse(400, { error: "Please choose at least one valid reminder timing." });
  }

  const asJson = JSON.stringify(parsed);
  await store.setReminderThresholds(env.DB, session.firmId, asJson);
  return jsonResponse(200, { reminder_thresholds: parsed });
}

/** PATCH /firm/rule-change-alerts -- roadmap #9/#319. Body: { enabled:
 * boolean }. Toggles the opt-out, on-by-default proactive alert setting --
 * see migration 0050's own docstring for why it defaults on. */
async function handleRuleChangeAlertsSet(request: Request, env: Env): Promise<Response> {
  const session = await requireFirmRole(request, env, "partner", "office_manager");
  if (session instanceof Response) return session;

  if (!originAllowed(request, env)) {
    return jsonResponse(400, { error: "That request couldn't be completed. Please try again from the DeadlineRadar site." });
  }

  const allowed = await checkRateLimit(env.DB, session.firmId, "firm_rule_change_alerts_set", RATE_LIMIT_FIRM_RULE_CHANGE_ALERTS_SET);
  if (!allowed) {
    return jsonResponse(429, { error: "Too many changes. Please try again later." });
  }

  let body: Record<string, unknown>;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return jsonResponse(400, { error: "Request too large." });
    body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return jsonResponse(400, { error: "Something went wrong processing that request." });
  }

  if (typeof body.enabled !== "boolean") {
    return jsonResponse(400, { error: "Missing or invalid 'enabled' value." });
  }

  await store.setFirmRuleChangeAlertsEnabled(env.DB, session.firmId, body.enabled);
  return jsonResponse(200, { rule_change_alerts_enabled: body.enabled });
}

/**
 * POST /firm/nps -- roadmap #144, the 1-question NPS micro-survey. Score
 * must be a whole number 0-10 (standard NPS scale); anything else is
 * rejected rather than silently clamped, since a malformed score would
 * poison real aggregate signal that isn't worth much to begin with without
 * clean data.
 */
async function handleNpsResponse(request: Request, env: Env): Promise<Response> {
  const session = await requireFirmSessionWithFirm(request, env);
  if (session instanceof Response) return session;

  if (!originAllowed(request, env)) {
    return jsonResponse(400, { error: "That request couldn't be completed. Please try again from the DeadlineRadar site." });
  }

  const allowed = await checkRateLimit(env.DB, session.firmId, "firm_nps", RATE_LIMIT_FIRM_NPS);
  if (!allowed) {
    return jsonResponse(429, { error: "Too many attempts. Please try again later." });
  }

  let body: Record<string, unknown>;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return jsonResponse(400, { error: "Request too large." });
    body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return jsonResponse(400, { error: "Something went wrong processing that request." });
  }

  const score = typeof body.score === "number" ? body.score : NaN;
  if (!Number.isInteger(score) || score < 0 || score > 10) {
    return jsonResponse(400, { error: "Please choose a score from 0 to 10." });
  }

  // AuditLab DEMO-3 class (2026-08-07): nps_prompt_due already suppresses
  // the PROMPT for demo firms, but a direct POST could still record a demo
  // visitor's score -- the exact data pollution that suppression exists to
  // prevent. Same silent-ok posture as the dismiss endpoints.
  if (session.firm.demo_locked) {
    return jsonResponse(200, { ok: true });
  }

  await store.recordNpsResponse(env.DB, session.firmId, score);
  return jsonResponse(200, { ok: true });
}

/** POST /firm/nps/dismiss -- resets the same cooldown as a real response,
 * without recording a score. See store.shouldPromptNps()'s own docstring. */
async function handleNpsDismiss(request: Request, env: Env): Promise<Response> {
  const session = await requireFirmSessionWithFirm(request, env);
  if (session instanceof Response) return session;

  if (!originAllowed(request, env)) {
    return jsonResponse(400, { error: "That request couldn't be completed. Please try again from the DeadlineRadar site." });
  }

  const allowed = await checkRateLimit(env.DB, session.firmId, "firm_nps_dismiss", RATE_LIMIT_FIRM_NPS);
  if (!allowed) {
    return jsonResponse(429, { error: "Too many attempts. Please try again later." });
  }

  // AuditLab DEMO-3 class -- see handleNpsResponse's own comment.
  if (session.firm.demo_locked) {
    return jsonResponse(200, { ok: true });
  }

  await store.recordNpsPromptDismissed(env.DB, session.firmId);
  return jsonResponse(200, { ok: true });
}

/**
 * POST /firm/testimonial -- roadmap #312, chained off a promoter-tier NPS
 * score client-side (the frontend only ever offers this after a >=9
 * response -- server-side accepts it independent of that, same
 * trust-the-caller posture as every other write route in this file, since
 * there's no meaningful abuse vector in submitting a private quote).
 * Never auto-published -- see store.recordTestimonial()'s own docstring.
 */
async function handleTestimonialSubmit(request: Request, env: Env): Promise<Response> {
  const session = await requireFirmSessionWithFirm(request, env);
  if (session instanceof Response) return session;

  if (!originAllowed(request, env)) {
    return jsonResponse(400, { error: "That request couldn't be completed. Please try again from the DeadlineRadar site." });
  }

  const allowed = await checkRateLimit(env.DB, session.firmId, "firm_testimonial", RATE_LIMIT_FIRM_TESTIMONIAL);
  if (!allowed) {
    return jsonResponse(429, { error: "Too many attempts. Please try again later." });
  }

  let body: Record<string, unknown>;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return jsonResponse(400, { error: "Request too large." });
    body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return jsonResponse(400, { error: "Something went wrong processing that request." });
  }

  const quoteText = sanitizeFreeText(typeof body.quote_text === "string" ? body.quote_text : null, MAX_TESTIMONIAL_LEN);
  if (!quoteText) {
    return jsonResponse(400, { error: "Please enter a quote before submitting." });
  }
  const canPublish = body.can_publish === true;

  // AuditLab DEMO-3 class -- a demo visitor's "testimonial" is not a real
  // firm's quote; see handleNpsResponse's own comment.
  if (session.firm.demo_locked) {
    return jsonResponse(200, { ok: true });
  }

  await store.recordTestimonial(env.DB, session.firmId, quoteText, canPublish);
  return jsonResponse(200, { ok: true });
}

/** GET /firm/calendar.ics -- static, one-time roster export (2026-08-06,
 * off Devin's live Calendar-feature feedback). Deliberately NOT a live
 * webcal:// subscription -- see ics.ts's own docstring for why that's a
 * separate, deliberately-deferred feature. Same read-gate
 * handleFirmLicensesList uses -- a lapsed/pilot-expired firm shouldn't get a
 * working export either. */
async function handleFirmCalendarIcs(request: Request, env: Env): Promise<Response> {
  const session = await requireFirmSessionWithFirm(request, env);
  if (session instanceof Response) return session;

  const rows = await store.listFirmLicenses(env.DB, session.firmId);
  const asOf = new Date();
  const events: IcsEvent[] = [];
  for (const row of rows) {
    // Same filter drLicensesByDate() already applies client-side (opted-out
    // staff and unresolvable deadlines don't get a calendar day) -- just
    // server-side this time, since there's no client JS to filter here.
    if (firmLicenseStatus(row) === "opted_out") continue;
    const nextDeadline = firmLicenseNextDeadline(row, asOf);
    if (!nextDeadline) continue;
    const stateName = stateNameForSlug(row.state_slug) ?? row.state_slug;
    events.push({
      uid: row.id,
      summary: `${row.staff_label || row.email} — ${stateName} license renewal`,
      dateIso: nextDeadline,
    });
  }

  const filenameSlug =
    (session.firm.name ?? "deadlineradar")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "deadlineradar";

  return new Response(buildIcs(events, asOf), {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="deadlineradar-${filenameSlug}.ics"`,
    },
  });
}

/**
 * POST /firm/licenses -- adds a staff member to the firm's roster.
 *
 * HYBRID consent model (2026-07-28, Devin's decision, firm path ONLY):
 * reuses store.addPending() (same row shape/tokens as a free-tier signup)
 * but with `skipConfirmation: true` -- the row is created already
 * `confirmed`/active, reminders start immediately, no pending gate. This is
 * DIFFERENT from handleSubscribe() (the public form), which still calls
 * addPending() WITHOUT that flag and stays double-opt-in, unchanged. What
 * keeps this CAN-SPAM-clean in exchange for skipping confirmation:
 * buildFirmStaffAddedEmail() below (not buildConfirmationEmail()) fires
 * instead, naming the firm and pointing at the SAME unsubscribe token/link
 * every other email already uses -- a firm admin adding someone doesn't
 * grant silent consent, it grants transparent, easily-declinable consent.
 */
async function handleFirmLicenseCreate(request: Request, env: Env): Promise<Response> {
  // migration 0045 (roadmap #11/#13/#14): Staff stays read-only on the
  // roster -- can view coverage, can't add/edit/remove staff.
  const session = await requireFirmRole(request, env, "partner", "office_manager");
  if (session instanceof Response) return session;

  // CSRF defense-in-depth (2026-08-05, orchestrator abuse-test pass):
  // SameSite=Lax is the ONLY barrier on this route today -- originAllowed()
  // already existed (handleFirmPasswordLogin's login-CSRF fix) but had
  // exactly one call site, leaving every actual state-changing endpoint
  // unchecked. A second layer independent of browser SameSite enforcement.
  if (!originAllowed(request, env)) {
    return jsonResponse(400, { error: "That request couldn't be completed. Please try again from the DeadlineRadar site." });
  }

  // Per-FIRM daily cap (not per-IP) -- see RATE_LIMIT_FIRM_LICENSE_CREATE's
  // own comment for why checkRateLimit()'s `ip` parameter is deliberately
  // reused here as "the bucket's identity key," bound to the authenticated
  // firm id rather than the caller's network address.
  const allowed = await checkRateLimit(env.DB, session.firmId, "firm_license_create", RATE_LIMIT_FIRM_LICENSE_CREATE);
  if (!allowed) {
    return jsonResponse(429, { error: "Too many staff added today for this firm. Please try again tomorrow." });
  }

  // BILL-1 (2026-08-04, Devin's decision): enforce the advertised self-serve
  // cap -- tier-aware since the same-day paid-tiers build (seatCapForFirmTier
  // falls back to today's SELF_SERVE_SEAT_CAP for `pilot`/any unrecognised
  // tier, so pre-conversion behavior is unchanged). Frozen-at-current-count
  // grandfathering, not a retroactive lockout: a firm already AT or OVER the
  // cap is never touched here -- existing roster rows keep working exactly
  // as before, nothing is deactivated -- this only blocks adding MORE staff
  // once the count is at or past the cap. That freezes any already-over-cap
  // firm at whatever it already had, which was the explicit instruction
  // rather than either force-removing rows down to the cap or silently
  // exempting them from it going forward.
  const seatCap = seatCapForFirmTier(session.firm.plan_tier);
  const currentSeatCount = await store.countFirmLicenses(env.DB, session.firmId);
  if (currentSeatCount >= seatCap) {
    return jsonResponse(402, {
      error: `Your plan covers up to ${seatCap} staff. Upgrade to add more.`,
      pay_now_url: "/firm-dashboard/#account",
    });
  }

  const parsed = await readFirmLicenseJsonBody(request);
  if (parsed instanceof Response) return parsed;
  const form = stringFieldsOf(parsed);

  for (const value of Object.values(form)) {
    if (hasControlChars(value)) {
      return jsonResponse(400, { error: "Invalid characters in submission." });
    }
  }

  const email = (form.email ?? "").trim();
  if (!isValidEmail(email)) {
    return jsonResponse(400, { error: "That doesn't look like a valid email address." });
  }
  // Task #7 (2026-08-06): same operator blocklist as the two public signup
  // routes -- see handleSubscribe()'s own comment. Firm staff-roster adds
  // are session-authenticated (not anonymous), but the blocklist is about
  // the ADDRESS being blocked, not who's submitting it.
  if (await store.isEmailBlocklisted(env.DB, email)) {
    return jsonResponse(400, { error: "That address can't be added right now." });
  }

  const stateSlug = (form.state_slug ?? "").trim();
  if (!SUPPORTED_STATE_SLUGS.has(stateSlug)) {
    return jsonResponse(400, { error: "Unsupported or missing state." });
  }

  const staffLabelRaw = (form.staff_label ?? "").trim();
  const staffLabel = staffLabelRaw.length > 0 ? staffLabelRaw.slice(0, MAX_STAFF_LABEL_LEN) : null;

  // Roadmap #16 (2026-08-07): office/department tag, same optional/empty-
  // means-untagged posture as staffLabel above.
  const officeTagRaw = (form.office_tag ?? "").trim();
  const officeTag = officeTagRaw.length > 0 ? officeTagRaw.slice(0, MAX_OFFICE_TAG_LEN) : null;

  const resolved = resolveDeadlineInput(stateSlug, form);
  if (resolved instanceof Response) {
    // resolveDeadlineInput() returns an HTML errorPage() Response (shared
    // with the public form) -- re-wrap its message as JSON for this API.
    const text = await resolved.text();
    return jsonResponse(resolved.status, { error: stripHtmlErrorMessage(text) });
  }
  const { deadlineFields, deadlineSource, userDeadline } = resolved;

  try {
    checkDataFreshness(new Date());
  } catch (err) {
    if (err instanceof StaleDataError) {
      return jsonResponse(503, { error: `Signups are temporarily paused: ${err.message}` });
    }
    throw err;
  }

  if (
    deadlineSource === store.DEADLINE_SOURCE_COMPUTED &&
    computeSubscriberDeadline(stateSlug, deadlineFields, new Date()) === null
  ) {
    return jsonResponse(400, { error: "Couldn't compute a deadline from what you gave us -- please check your inputs." });
  }

  // Surface a conflict rather than silently creating a second row for an
  // email+state that already has an active or pending record (free-tier or
  // another firm's) -- findActiveOrPending() is the same dedupe check
  // handleSubscribe() uses; this table has no UNIQUE constraint on
  // (email, state_slug) to enforce this at the DB layer, so the application
  // layer is what has to catch it.
  const existing = await store.findActiveOrPending(env.DB, email, stateSlug);
  if (existing) {
    return jsonResponse(409, {
      error: "A subscriber already exists for this email and state (possibly a free-tier signup, or already on a firm's roster).",
    });
  }

  // HYBRID consent model (2026-07-28, Devin's decision, firm path only):
  // admin-added staff go ACTIVE immediately (skipConfirmation) -- no
  // pending-confirmation gap in the firm's coverage. The free-tier
  // /subscribe path above is completely untouched (never passes this flag,
  // still double opt-in). Transparency is what keeps this CAN-SPAM-clean:
  // buildFirmStaffAddedEmail() below, not the confirm email, is sent instead
  // -- states plainly who added them and gives an equally prominent
  // one-click opt-out.
  // Reported directly, 2026-08-05: adding this email onto a DIFFERENT state
  // than one already on the roster goes through cleanly with no signal at
  // all -- both rows count toward the 25-staff cap as if they're distinct
  // people. Deliberately NOT a block: one real CPA licensed in multiple
  // states is legitimately tracked as multiple rows sharing an email (see
  // findOtherFirmRowsByEmail()'s own docstring), so this only ever
  // surfaces a non-blocking warning for the admin to eyeball, never
  // refuses the add.
  const duplicateEmailRows = await store.findOtherFirmRowsByEmail(env.DB, session.firmId, email, "");
  const duplicateEmailWarning =
    duplicateEmailRows.length > 0
      ? `This email is already on your roster for ${duplicateEmailRows
          .map((r) => stateNameFromSlug(r.state_slug))
          .join(", ")}. If this is a different state license for the same person, that's fine -- just double-check it isn't a typo of someone else.`
      : null;

  // Roadmap #7 (2026-08-07): self-reported, optional. Empty/omitted -> null
  // (not tracked), matching every other optional field on this form.
  const renewalFeeRaw = (form.renewal_fee ?? "").trim();
  let renewalFeeCents: number | null = null;
  if (renewalFeeRaw.length > 0) {
    renewalFeeCents = parseStrictDollarsToCents(renewalFeeRaw);
    if (renewalFeeCents === null) {
      return jsonResponse(400, { error: "Please enter a valid renewal fee." });
    }
  }

  const record = await store.addPending(env.DB, {
    email,
    stateSlug,
    deadlineFields,
    firstName: null,
    deadlineSource,
    userDeadline,
    firmId: session.firmId,
    staffLabel,
    skipConfirmation: true,
    renewalFeeCents,
    officeTag,
  });

  // AuditLab LC-1 (LOW, 2026-08-04): if this same person was previously
  // removed from this exact state on this firm's roster, their real
  // CPE history is stranded on that now-inert row -- move it here so it
  // counts toward the requirement again, same person and same state.
  // Best-effort: a failure here must not roll back the staff-add itself,
  // same posture as the transparency email below.
  try {
    await store.reattachOrphanedCpeEntries(env.DB, session.firmId, email, stateSlug, record.id);
  } catch {
    // Non-fatal -- worst case, history stays where it was, exactly the
    // pre-existing (LOW-severity, safe-direction) behavior this improves on.
  }

  // Task #26 (2026-08-06): durable Recent Activity, independent of whether
  // this row is still on the live roster later -- see migration 0025's own
  // docstring for why a live-roster-derived feed can't show a removal.
  // Best-effort, same posture as every other non-critical write in this
  // handler above.
  try {
    await store.logActivity(env.DB, {
      firmId: session.firmId,
      subscriberId: record.id,
      staffLabel: record.staff_label,
      email: record.email,
      eventType: "added",
    });
  } catch {
    // Non-fatal -- the roster add already succeeded regardless.
  }

  // AuditLab DEMO-4 (MEDIUM, 2026-08-07): the sharpest path of the four --
  // no PATCH, no reminder click, just Add Staff with skipConfirmation:
  // true. A demo visitor types any address here and our servers email it
  // in one step. See handleFirmStaffCpeReminder's own comment for the
  // "gate the send, not the edit" reasoning.
  if (env.SENDGRID_API_KEY && !session.firm.demo_locked) {
    try {
      const underCap = await checkAndCountActionSend(env.DB, dailySendCap(env));
      if (underCap) {
        const firm = await store.getFirmById(env.DB, session.firmId);
        const unsubscribeUrl = `${actionBaseUrl(env)}/unsubscribe?token=${encodeURIComponent(record.unsubscribe_token)}`;
        const built = buildFirmStaffAddedEmail(firm?.name || "Your firm", stateNameFromSlug(stateSlug), unsubscribeUrl);
        await sendViaSendGrid(env.SENDGRID_API_KEY, record.email, built, env.EMAIL_ALLOWLIST);
      }
    } catch {
      // Best-effort, same posture as handleSubscribe() -- the record is
      // already stored (and already ACTIVE) regardless of whether this
      // transparency email succeeds; a mail failure must not roll back
      // consent state or silently leave reminders un-started.
    }
  }

  return jsonResponse(201, { ...toFirmLicenseJson(record, new Date()), duplicate_email_warning: duplicateEmailWarning });
}

/** Strips this file's htmlPage() wrapper down to just the inner error
 * message text, for re-wrapping an errorPage() Response's copy as JSON --
 * shared error copy (resolveDeadlineInput()) without shipping HTML tags in a
 * JSON API response. */
function stripHtmlErrorMessage(html: string): string {
  const match = /<p>([\s\S]*?)<\/p>/.exec(html);
  const inner = match?.[1] ?? html;
  return inner.replace(/&mdash;/g, "--").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}

/**
 * PATCH /firm/licenses/:id -- edits staff_label/email/state/deadline fields.
 * Ownership is enforced TWICE: once here (existing lookup, for the 404) and
 * again inside store.updateFirmLicense()'s own WHERE clause -- see that
 * function's docstring for why. Every field is optional (a true partial
 * update): state_slug/deadline fields are only re-resolved (and
 * re-validated, using the SAME resolveDeadlineInput() the create route uses)
 * when the request actually touches state_slug or one of the per-state
 * deadline field keys; otherwise the existing state/deadline fields are left
 * untouched.
 */
async function handleFirmLicensePatch(request: Request, env: Env, id: string): Promise<Response> {
  // migration 0045 (roadmap #11/#13/#14): Staff stays read-only.
  const session = await requireFirmRole(request, env, "partner", "office_manager");
  if (session instanceof Response) return session;

  // CSRF defense-in-depth (2026-08-05) -- see handleFirmLicenseCreate's own comment.
  if (!originAllowed(request, env)) {
    return jsonResponse(400, { error: "That request couldn't be completed. Please try again from the DeadlineRadar site." });
  }

  // Per-FIRM daily cap -- AuditLab F-2, 2026-08-02. This route previously
  // had none at all, unlike POST /firm/licenses (RATE_LIMIT_FIRM_LICENSE_CREATE
  // above): every email change here fires a confirmation email to the NEW
  // address, so an unbounded PATCH is a mail-bomb primitive against any
  // third-party address, from an authenticated session. Checked before any
  // other work, same placement as the POST handler.
  const patchAllowed = await checkRateLimit(env.DB, session.firmId, "firm_license_patch", RATE_LIMIT_FIRM_LICENSE_PATCH);
  if (!patchAllowed) {
    return jsonResponse(429, { error: "Too many changes. Please try again later." });
  }

  const existing = await store.getFirmLicense(env.DB, session.firmId, id);
  if (!existing) return jsonResponse(404, { error: "Not found." });

  const parsed = await readFirmLicenseJsonBody(request);
  if (parsed instanceof Response) return parsed;
  const form = stringFieldsOf(parsed);

  for (const value of Object.values(form)) {
    if (hasControlChars(value)) {
      return jsonResponse(400, { error: "Invalid characters in submission." });
    }
  }

  let email = existing.email;
  if (typeof parsed.email === "string") {
    const trimmed = parsed.email.trim();
    if (!isValidEmail(trimmed)) {
      return jsonResponse(400, { error: "That doesn't look like a valid email address." });
    }
    // AuditLab BLOCKLIST-1 class fix (2026-08-07): AuditLab's finding named
    // /firm/change-email; grepping for the same defining behavior (a route
    // that accepts a NEW email address without the operator blocklist
    // check) found this second instance -- a roster row's email could be
    // PATCHed onto a blocked address even though CREATE checks it. Only
    // checked when the address is actually changing, so an unrelated field
    // edit on a row whose address was blocklisted AFTER it was added never
    // bricks that edit.
    if (store.normalizeEmail(trimmed) !== store.normalizeEmail(existing.email) && (await store.isEmailBlocklisted(env.DB, trimmed))) {
      return jsonResponse(400, { error: "That address can't be added right now." });
    }
    email = trimmed;
  }

  let staffLabel = existing.staff_label;
  if (typeof parsed.staff_label === "string") {
    const trimmed = parsed.staff_label.trim();
    staffLabel = trimmed.length > 0 ? trimmed.slice(0, MAX_STAFF_LABEL_LEN) : null;
  }

  // Roadmap #16 (2026-08-07): office/department tag. Same present-but-empty-
  // clears / absent-leaves-untouched semantics as staff_label above -- this
  // is also what the bulk-tag UI relies on, sending only { office_tag } for
  // each selected staffer rather than the full record.
  let officeTag = existing.office_tag;
  if (typeof parsed.office_tag === "string") {
    const trimmed = parsed.office_tag.trim();
    officeTag = trimmed.length > 0 ? trimmed.slice(0, MAX_OFFICE_TAG_LEN) : null;
  }

  // Roadmap #68 (2026-08-07): internal-only note. Same present-but-empty-
  // clears / absent-leaves-untouched partial-update semantics as office_tag
  // above.
  let internalNotes = existing.internal_notes;
  if (typeof parsed.internal_notes === "string") {
    const trimmed = parsed.internal_notes.trim();
    internalNotes = trimmed.length > 0 ? trimmed.slice(0, MAX_INTERNAL_NOTES_LEN) : null;
  }

  // Roadmap #7 (2026-08-07): self-reported, optional. Present-but-empty
  // explicitly clears it (matches staff_label's own empty-string-clears
  // convention above); absent from the body leaves the existing value
  // untouched, true partial-update semantics.
  let renewalFeeCents = existing.renewal_fee_cents;
  if (typeof parsed.renewal_fee === "string") {
    const trimmed = parsed.renewal_fee.trim();
    if (trimmed.length === 0) {
      renewalFeeCents = null;
    } else {
      const parsedCents = parseStrictDollarsToCents(trimmed);
      if (parsedCents === null) {
        return jsonResponse(400, { error: "Please enter a valid renewal fee." });
      }
      renewalFeeCents = parsedCents;
    }
  }

  // Roadmap #10 (2026-08-07): self-reported, optional. Same present-but-
  // empty-clears / absent-leaves-untouched partial-update semantics as
  // renewal_fee above.
  let carryoverHours = existing.carryover_hours;
  if (typeof parsed.carryover_hours === "string") {
    const trimmed = parsed.carryover_hours.trim();
    if (trimmed.length === 0) {
      carryoverHours = null;
    } else {
      const parsedHours = parseStrictCarryoverHours(trimmed);
      if (parsedHours === null) {
        return jsonResponse(400, { error: "Please enter a valid number of carryover hours." });
      }
      carryoverHours = parsedHours;
    }
  }

  let stateSlug = existing.state_slug;
  let deadlineFields: Record<string, string> = JSON.parse(existing.deadline_fields || "{}");
  let deadlineSource = existing.deadline_source;
  let userDeadline = existing.user_deadline;

  const stateSlugProvided = typeof parsed.state_slug === "string";
  const deadlineFieldsProvided = DEADLINE_FIELD_KEYS.some((k) => typeof parsed[k] === "string");

  if (stateSlugProvided) {
    const trimmed = (parsed.state_slug as string).trim();
    if (!SUPPORTED_STATE_SLUGS.has(trimmed)) {
      return jsonResponse(400, { error: "Unsupported or missing state." });
    }
    stateSlug = trimmed;
  }

  if (stateSlugProvided || deadlineFieldsProvided) {
    const resolved = resolveDeadlineInput(stateSlug, form);
    if (resolved instanceof Response) {
      const text = await resolved.text();
      return jsonResponse(resolved.status, { error: stripHtmlErrorMessage(text) });
    }
    deadlineFields = resolved.deadlineFields;
    deadlineSource = resolved.deadlineSource;
    userDeadline = resolved.userDeadline;

    try {
      checkDataFreshness(new Date());
    } catch (err) {
      if (err instanceof StaleDataError) {
        return jsonResponse(503, { error: `Temporarily paused: ${err.message}` });
      }
      throw err;
    }
    if (
      deadlineSource === store.DEADLINE_SOURCE_COMPUTED &&
      computeSubscriberDeadline(stateSlug, deadlineFields, new Date()) === null
    ) {
      return jsonResponse(400, { error: "Couldn't compute a deadline from what you gave us -- please check your inputs." });
    }
  }

  const emailChanged = store.normalizeEmail(email) !== store.normalizeEmail(existing.email);
  const stateChanged = stateSlug !== existing.state_slug;

  // Same dedupe POST /firm/licenses already enforces (AuditLab F-3,
  // 2026-08-02: PATCH skipped it entirely -- a firm could PATCH a roster
  // row onto an (email, state_slug) that already has a live record,
  // including a free-tier individual's, producing two live rows for the
  // same person/state with no way for the affected person to reconcile
  // them). Only checked when the (email, state_slug) PAIR is actually
  // changing -- re-saving a row's OWN unchanged pair would otherwise
  // "conflict" with itself, since it's already active/confirmed. Excluding
  // this row's own id is extra defensive insurance, not load-bearing today
  // (unreachable when the pair is unchanged, given the condition above).
  if (emailChanged || stateChanged) {
    const conflict = await store.findActiveOrPending(env.DB, email, stateSlug);
    if (conflict && conflict.id !== existing.id) {
      return jsonResponse(409, {
        error: "A subscriber already exists for this email and state (possibly a free-tier signup, or already on a firm's roster).",
      });
    }
  }

  // Same non-blocking warning POST /firm/licenses gives -- see
  // findOtherFirmRowsByEmail()'s own docstring for why this is a warning,
  // not a second dedupe gate. Computed BEFORE the write so the "other"
  // rows reflect current state -- this row's own id is always excluded, so
  // an unrelated field edit (e.g. staff_label) never warns about itself.
  const duplicateEmailRows = await store.findOtherFirmRowsByEmail(env.DB, session.firmId, email, existing.id);
  const duplicateEmailWarning =
    duplicateEmailRows.length > 0
      ? `This email is already on your roster for ${duplicateEmailRows
          .map((r) => stateNameFromSlug(r.state_slug))
          .join(", ")}. If this is a different state license for the same person, that's fine -- just double-check it isn't a typo of someone else.`
      : null;

  const updated = await store.updateFirmLicense(env.DB, session.firmId, id, {
    email,
    staffLabel,
    stateSlug,
    deadlineFields,
    deadlineSource,
    userDeadline,
    renewalFeeCents,
    carryoverHours,
    officeTag,
    internalNotes,
    resetConfirmation: emailChanged,
  });
  if (!updated) return jsonResponse(404, { error: "Not found." });

  // Editing the delivery address is, in effect, re-consenting a DIFFERENT
  // inbox -- see UpdateFirmLicenseInput.resetConfirmation's own doc. Send
  // that new address its own fresh confirm email, same best-effort posture
  // as every other send in this file.
  // AuditLab DEMO-4 (MEDIUM, 2026-08-07): same "gate the send, not the
  // edit" reasoning as handleFirmLicenseCreate's own comment -- the PATCH
  // (including the email swap itself) still succeeds normally for a demo
  // visitor, only the outbound email to the new address is skipped.
  if (emailChanged && env.SENDGRID_API_KEY && !session.firm.demo_locked) {
    try {
      const underCap = await checkAndCountActionSend(env.DB, dailySendCap(env));
      if (underCap) {
        const confirmUrl = `${actionBaseUrl(env)}/confirm?token=${encodeURIComponent(updated.confirm_token)}`;
        const unsubscribeUrl = `${actionBaseUrl(env)}/unsubscribe?token=${encodeURIComponent(updated.unsubscribe_token)}`;
        const built = buildConfirmationEmail(
          stateNameFromSlug(updated.state_slug),
          confirmUrl,
          unsubscribeUrl,
          updated.first_name,
          updated.user_deadline ? fmtDate(new Date(`${updated.user_deadline}T00:00:00Z`)) : null
        );
        await sendViaSendGrid(env.SENDGRID_API_KEY, updated.email, built, env.EMAIL_ALLOWLIST);
      }
    } catch {
      // Best-effort -- the record is already updated regardless.
    }
  }

  // Task #26 -- see handleFirmLicenseCreate's own comment on this same call.
  try {
    await store.logActivity(env.DB, {
      firmId: session.firmId,
      subscriberId: updated.id,
      staffLabel: updated.staff_label,
      email: updated.email,
      eventType: "edited",
    });
  } catch {
    // Non-fatal -- the edit already succeeded regardless.
  }

  return jsonResponse(200, { ...toFirmLicenseJson(updated, new Date()), duplicate_email_warning: duplicateEmailWarning });
}

/** DELETE /firm/licenses/:id -- removes a staff member from the roster (see
 * store.STOP_REASON_REMOVED_BY_ADMIN's own comment for why this is a
 * status/stop_reason change, not a SQL row delete, and why that alone is
 * sufficient to also stop any further reminder sends for this record: the
 * reminder cron's allConfirmedActive() only ever reads status='confirmed'
 * rows). */
async function handleFirmLicenseDelete(request: Request, env: Env, id: string): Promise<Response> {
  // migration 0045 (roadmap #11/#13/#14): Staff stays read-only.
  const session = await requireFirmRole(request, env, "partner", "office_manager");
  if (session instanceof Response) return session;

  // CSRF defense-in-depth (2026-08-05) -- see handleFirmLicenseCreate's own comment.
  if (!originAllowed(request, env)) {
    return jsonResponse(400, { error: "That request couldn't be completed. Please try again from the DeadlineRadar site." });
  }

  // Per-FIRM daily cap -- AuditLab S-3, 2026-08-03. No send path here (unlike
  // F-2/RATE_LIMIT_FIRM_LICENSE_PATCH), but still unbounded D1 write
  // amplification with nothing bounding it before this.
  const allowed = await checkRateLimit(env.DB, session.firmId, "firm_license_delete", RATE_LIMIT_FIRM_LICENSE_DELETE);
  if (!allowed) {
    return jsonResponse(429, { error: "Too many changes. Please try again later." });
  }

  const result = await store.removeFirmLicense(env.DB, session.firmId, id);
  if (!result) return jsonResponse(404, { error: "Not found." });

  // Task #26 -- the ONE case this whole feature exists for: removeFirmLicense()
  // soft-deletes (see its own docstring), and listFirmLicenses() then
  // deliberately excludes the row from every future GET /firm/licenses --
  // meaning a live-roster-derived activity feed can never show a removal at
  // all, the exact bug this durable log fixes. staffLabel/email are read
  // from `result` (still populated -- nothing was actually SQL-deleted),
  // not re-fetched.
  try {
    await store.logActivity(env.DB, {
      firmId: session.firmId,
      subscriberId: result.id,
      staffLabel: result.staff_label,
      email: result.email,
      eventType: "removed",
    });
  } catch {
    // Non-fatal -- the removal already succeeded regardless.
  }

  return jsonResponse(200, { id: result.id, status: "removed" });
}

/**
 * POST /firm/licenses/:id/renew -- the dashboard's one-step "Mark renewed"
 * action (Part A #5). Hits the SAME store.ts atomic write
 * (store.applyRenewAndRearm(), via the firm-ownership-scoped
 * store.renewAndRearm() wrapper) that the free-tier email's
 * "I've renewed -- remind me next cycle" CTA uses (handleRenewedNextCycle()
 * above, via store.renewAndRearmByToken()) -- one shared piece of logic, two
 * different authorization/lookup paths, per this build's own instruction not
 * to build two different code paths for the same operation.
 */
async function handleFirmLicenseRenew(request: Request, env: Env, id: string): Promise<Response> {
  // migration 0045 (roadmap #11/#13/#14): Staff stays read-only.
  const session = await requireFirmRole(request, env, "partner", "office_manager");
  if (session instanceof Response) return session;

  // CSRF defense-in-depth (2026-08-05) -- see handleFirmLicenseCreate's own comment.
  if (!originAllowed(request, env)) {
    return jsonResponse(400, { error: "That request couldn't be completed. Please try again from the DeadlineRadar site." });
  }

  // Per-FIRM daily cap -- AuditLab S-3, 2026-08-03. Same reasoning as the
  // DELETE handler above: no send path, but unbounded D1 write amplification.
  const renewAllowed = await checkRateLimit(env.DB, session.firmId, "firm_license_renew", RATE_LIMIT_FIRM_LICENSE_RENEW);
  if (!renewAllowed) {
    return jsonResponse(429, { error: "Too many changes. Please try again later." });
  }

  // Read the row first (ownership-scoped) so a refusal can be given a
  // specific, honest reason -- store.renewAndRearm() itself only ever
  // returns SubscriberRow | null, the same "no distinguishing detail" shape
  // every other store.ts mutation in this file uses.
  const existing = await store.getFirmLicense(env.DB, session.firmId, id);
  if (!existing) return jsonResponse(404, { error: "Not found." });

  const updated = await store.renewAndRearm(env.DB, session.firmId, id);
  if (!updated) {
    if (existing.stop_reason === store.STOP_REASON_REMOVED_BY_ADMIN) {
      return jsonResponse(400, {
        error: "This person was removed from the roster. Re-add them (POST /firm/licenses) to track a new cycle.",
      });
    }
    if (!existing.confirmed_at) {
      return jsonResponse(400, { error: "This person hasn't confirmed their email yet -- there's nothing to renew." });
    }
    if (existing.deadline_source === store.DEADLINE_SOURCE_USER) {
      return jsonResponse(400, {
        error: "We can't auto-compute this person's next renewal date. Edit their record with the new expiration date once they have it.",
      });
    }
    return jsonResponse(400, { error: "Couldn't renew this record." });
  }

  // Task #26 -- see handleFirmLicenseCreate's own comment on this same call.
  try {
    await store.logActivity(env.DB, {
      firmId: session.firmId,
      subscriberId: updated.id,
      staffLabel: updated.staff_label,
      email: updated.email,
      eventType: "renewed",
    });
  } catch {
    // Non-fatal -- the renewal already succeeded regardless.
  }

  return jsonResponse(200, toFirmLicenseJson(updated, new Date()));
}

// ---------------------------------------------------------------------------
// CPE-hours tracker (2026-07-30, new BUILD v2 phase). Lightweight INTERNAL
// firm visibility only -- NOT an official state-reporting integration (CE
// Broker is the mandated official reporter in several states, e.g. Florida),
// NOT a course marketplace, NOT a provider integration. v1 is admin-only
// (the firm's own session logs entries on a staffer's behalf), but every
// entry already carries entered_by_actor_type/entered_by_firm_session_id so
// a future individual staff login is additive, not a rewrite -- see
// migration 0009's own comment for the full rationale.
//
// Requirement matching (how many hours are required, ethics sub-requirement,
// cycle length) happens entirely CLIENT-SIDE in the dashboard JS, from
// data/cpe_hours.json inlined at build time (generate.py) -- same "static
// reference data inlined once, dynamic per-firm data fetched live" split
// this dashboard already uses everywhere else (e.g. DR_STATES). The worker
// only owns the cpe_entries CRUD below; it has no opinion on what any given
// state requires.
function toCpeEntryJson(row: store.CpeEntryRow): Record<string, unknown> {
  return {
    id: row.id,
    subscriber_id: row.subscriber_id,
    entry_date: row.entry_date,
    hours: row.hours,
    category: row.category,
    description: row.description,
    certificate_document_id: row.certificate_document_id,
    entered_by_actor_type: row.entered_by_actor_type,
  };
}

/** GET /firm/cpe -- every non-deleted CPE entry across the firm's whole
 * roster. The dashboard rolls this up per staffer client-side (same
 * pattern as GET /firm/licenses's roster-wide fetch). */
async function handleCpeEntriesList(request: Request, env: Env): Promise<Response> {
  const session = await requireFirmSessionWithFirm(request, env);
  if (session instanceof Response) return session;
  const rows = await store.listCpeEntriesForFirm(env.DB, session.firmId);
  return jsonResponse(200, { entries: rows.map(toCpeEntryJson) });
}

/**
 * POST /firm/cpe -- body: `subscriber_id`, `entry_date` (YYYY-MM-DD, must
 * not be in the future -- can't log CPE not yet completed), `hours`
 * (decimal string), `category` (general|ethics|other), `description`
 * (optional). store.addCpeEntry() itself re-confirms subscriber_id belongs
 * to this firm before writing anything (defense-in-depth, not just this
 * handler's own check) -- returns null -> 404 for a subscriber_id belonging
 * to a different firm, same anti-enumeration posture as every other
 * firm-scoped mutation in this file.
 */
async function handleCpeEntryCreate(request: Request, env: Env): Promise<Response> {
  // migration 0045 (roadmap #11/#13/#14): Staff stays read-only.
  const session = await requireFirmRole(request, env, "partner", "office_manager");
  if (session instanceof Response) return session;

  // CSRF defense-in-depth (2026-08-05) -- see handleFirmLicenseCreate's own comment.
  if (!originAllowed(request, env)) {
    return jsonResponse(400, { error: "That request couldn't be completed. Please try again from the DeadlineRadar site." });
  }

  const allowed = await checkRateLimit(env.DB, session.firmId, "cpe_entry_create", RATE_LIMIT_CPE_ENTRY_CREATE);
  if (!allowed) {
    return jsonResponse(429, { error: "Too many CPE entries logged today for this firm. Please try again tomorrow." });
  }

  const parsed = await readFirmLicenseJsonBody(request); // generic despite the name -- see that function's own signature
  if (parsed instanceof Response) return parsed;
  const form = stringFieldsOf(parsed);

  for (const value of Object.values(form)) {
    if (hasControlChars(value)) {
      return jsonResponse(400, { error: "Invalid characters in submission." });
    }
  }

  const subscriberId = (form.subscriber_id ?? "").trim();
  if (!subscriberId) {
    return jsonResponse(400, { error: "Missing subscriber_id." });
  }

  const entryDateParsed = parseStrictIsoDate(form.entry_date ?? "");
  if (!entryDateParsed) {
    return jsonResponse(400, { error: "Please enter a valid completion date." });
  }
  const entryDateIso = (form.entry_date ?? "").trim();
  // A one-UTC-day grace window, not a raw `> Date.now()` comparison
  // (adversarial review caught this): entryDateParsed is always UTC
  // midnight of the given date, but the Worker runs in UTC while the actual
  // submitter can be in any timezone -- for anyone at a positive UTC offset
  // (most of Europe/Africa/Asia/Pacific), their own local "today" is
  // already UTC's "tomorrow" for part of the day. Without this grace, a
  // completely legitimate same-day entry from those timezones would get
  // wrongly rejected as "in the future." Allowing up to UTC-tomorrow still
  // catches the real abuse case this check exists for (a date dated weeks
  // or months ahead).
  const now = new Date();
  const utcTodayPlusOneDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  if (entryDateParsed.getTime() > utcTodayPlusOneDay) {
    return jsonResponse(400, { error: "Completion date can't be in the future." });
  }

  const hours = parseStrictCpeHours(form.hours ?? "");
  if (hours === null) {
    return jsonResponse(400, { error: `Please enter a valid number of hours (greater than 0, up to ${MAX_CPE_HOURS_PER_ENTRY}).` });
  }

  const categoryRaw = (form.category ?? "general").trim();
  if (!isValidCpeCategory(categoryRaw)) {
    return jsonResponse(400, { error: "Category must be general, ethics, or other." });
  }

  const descriptionRaw = (form.description ?? "").trim();
  const description = descriptionRaw.length > 0 ? sanitizeFreeText(descriptionRaw, MAX_CPE_DESCRIPTION_LEN) : null;

  // Roadmap #1/#2 (2026-08-07): optional link to a supporting certificate
  // already uploaded for this SAME subscriber -- re-checked here (not just
  // trusted from the client) so a crafted document_id belonging to a
  // different staff member (or a different firm entirely) can never get
  // silently attached to someone else's CPE entry.
  const documentIdRaw = (form.document_id ?? "").trim();
  let certificateDocumentId: string | null = null;
  if (documentIdRaw) {
    const doc = await store.getDocumentForFirm(env.DB, session.firmId, documentIdRaw);
    if (!doc || doc.subscriber_id !== subscriberId) {
      return jsonResponse(400, { error: "That certificate doesn't belong to this staff member." });
    }
    certificateDocumentId = doc.id;
  }

  const created = await store.addCpeEntry(env.DB, {
    firmId: session.firmId,
    subscriberId,
    entryDate: entryDateIso,
    hours,
    category: categoryRaw,
    description,
    certificateDocumentId,
    enteredByFirmSessionId: session.sessionId,
    enteredByActorType: "admin",
  });
  if (!created) return jsonResponse(404, { error: "Not found." });

  return jsonResponse(201, toCpeEntryJson(created));
}

/** DELETE /firm/cpe/:id -- soft-delete (see migration 0009's comment for
 * why it's not a real DELETE), firm-scoped. */
async function handleCpeEntryDelete(request: Request, env: Env, id: string): Promise<Response> {
  // migration 0045 (roadmap #11/#13/#14): Staff stays read-only.
  const session = await requireFirmRole(request, env, "partner", "office_manager");
  if (session instanceof Response) return session;

  // CSRF defense-in-depth (2026-08-05) -- see handleFirmLicenseCreate's own comment.
  if (!originAllowed(request, env)) {
    return jsonResponse(400, { error: "That request couldn't be completed. Please try again from the DeadlineRadar site." });
  }

  // Per-FIRM daily cap -- AuditLab S-3, 2026-08-03. Same reasoning as
  // RATE_LIMIT_CPE_ENTRY_CREATE's own comment, applied to the delete side.
  const allowed = await checkRateLimit(env.DB, session.firmId, "cpe_entry_delete", RATE_LIMIT_CPE_ENTRY_DELETE);
  if (!allowed) {
    return jsonResponse(429, { error: "Too many changes. Please try again later." });
  }

  const removed = await store.removeCpeEntry(env.DB, session.firmId, id);
  if (!removed) return jsonResponse(404, { error: "Not found." });
  return jsonResponse(200, { id, status: "removed" });
}

// ---------------------------------------------------------------------------
// Document storage (2026-08-07, roadmap #1/#2). D1 (store.ts's `documents`
// table) holds only metadata; env.DOCUMENTS (R2) holds the actual bytes,
// keyed by an opaque r2_key minted here, independent of the D1 row's own id
// -- the two are correlated only through that stored key, never assumed to
// match.
// ---------------------------------------------------------------------------

function toDocumentJson(row: store.DocumentRow): Record<string, unknown> {
  return {
    id: row.id,
    subscriber_id: row.subscriber_id,
    kind: row.kind,
    filename: row.filename,
    content_type: row.content_type,
    size_bytes: row.size_bytes,
    uploaded_at: row.uploaded_at,
  };
}

// Strips path separators/control chars and caps length -- this value is
// echoed back into a Content-Disposition header on download, so it must
// never contain anything that could break out of that header's own quoted
// filename or smuggle a path. Falls back to a generic name if nothing
// printable survives, rather than ever storing/serving an empty filename.
function sanitizeDocumentFilename(raw: string): string {
  const stripped = raw
    .replace(/[\\/]/g, "-")
    .split("")
    .filter((ch) => !hasControlChars(ch))
    .join("")
    .trim()
    .slice(0, 150);
  return stripped.length > 0 ? stripped : "document";
}

/** POST /firm/licenses/:id/documents -- upload a license or CPE certificate
 * for one staff member. multipart/form-data: `file` (the upload) + `kind`
 * ("license" | "cpe"). Ownership of the subscriber is checked up front
 * (existing lookup, 404 if it doesn't belong to this firm) and again inside
 * store.createDocument()'s own WHERE clause, same double-check convention
 * as handleFirmLicensePatch. The R2 write happens BEFORE the D1 insert, and
 * is cleaned up if the D1 insert is ever refused -- an orphaned R2 object
 * with no D1 row is just unreferenced storage; a D1 row pointing at a
 * missing R2 object would break every future download of it. */
async function handleDocumentUpload(request: Request, env: Env, subscriberId: string): Promise<Response> {
  // migration 0045 (roadmap #11/#13/#14): Staff stays read-only.
  const session = await requireFirmRole(request, env, "partner", "office_manager");
  if (session instanceof Response) return session;

  if (!originAllowed(request, env)) {
    return jsonResponse(400, { error: "That request couldn't be completed. Please try again from the DeadlineRadar site." });
  }

  const uploadAllowed = await checkRateLimit(env.DB, session.firmId, "firm_document_upload", RATE_LIMIT_FIRM_DOCUMENT_UPLOAD);
  if (!uploadAllowed) {
    return jsonResponse(429, { error: "Too many uploads. Please try again later." });
  }

  const existing = await store.getFirmLicense(env.DB, session.firmId, subscriberId);
  if (!existing) return jsonResponse(404, { error: "Not found." });

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return jsonResponse(400, { error: "Couldn't read that upload. Please try again." });
  }

  // This version of @cloudflare/workers-types types FormData.get() as
  // always returning `string | null`, missing the real File case entirely
  // -- a real multipart upload DOES hand back a genuine File at runtime, the
  // TYPE just doesn't say so, which makes `instanceof File` fail to type-
  // check (a `string | null` isn't an object type). typeof narrows first
  // (true only for the real File case, false for a plain text field), then
  // the cast through `unknown` is honest about working around the package's
  // gap rather than pretending it's correct.
  const rawFile = formData.get("file");
  if (typeof rawFile !== "object" || rawFile === null) {
    return jsonResponse(400, { error: "No file was attached." });
  }
  const file = rawFile as unknown as File;

  const kindRaw = formData.get("kind");
  const kind =
    typeof kindRaw === "string" && (store.DOCUMENT_KINDS as string[]).includes(kindRaw) ? (kindRaw as store.DocumentKind) : null;
  if (!kind) {
    return jsonResponse(400, { error: "Missing or invalid document kind." });
  }

  if (!store.DOCUMENT_ALLOWED_CONTENT_TYPES.includes(file.type)) {
    return jsonResponse(400, { error: "Only PDF, JPG, or PNG files are supported." });
  }

  if (file.size <= 0 || file.size > store.DOCUMENT_MAX_FILE_BYTES) {
    return jsonResponse(400, { error: "That file is too large -- the limit is 2MB." });
  }

  const currentTotal = await store.sumFirmDocumentBytes(env.DB, session.firmId);
  if (currentTotal + file.size > store.DOCUMENT_MAX_FIRM_TOTAL_BYTES) {
    return jsonResponse(400, { error: "Your firm has reached its document storage limit. Remove an old document before adding a new one." });
  }

  const filename = sanitizeDocumentFilename(file.name || "document");
  const r2Key = `${session.firmId}/${subscriberId}/${store.newToken()}`;
  const bytes = await file.arrayBuffer();
  await env.DOCUMENTS.put(r2Key, bytes, { httpMetadata: { contentType: file.type } });

  const doc = await store.createDocument(env.DB, {
    firmId: session.firmId,
    subscriberId,
    kind,
    r2Key,
    filename,
    contentType: file.type,
    sizeBytes: file.size,
  });
  if (!doc) {
    await env.DOCUMENTS.delete(r2Key);
    return jsonResponse(404, { error: "Not found." });
  }

  return jsonResponse(201, { document: toDocumentJson(doc) });
}

/** GET /firm/licenses/:id/documents -- metadata only (never the bytes) for
 * every non-deleted document attached to one staff member. */
async function handleDocumentList(request: Request, env: Env, subscriberId: string): Promise<Response> {
  const session = await requireFirmSessionWithFirm(request, env);
  if (session instanceof Response) return session;

  const existing = await store.getFirmLicense(env.DB, session.firmId, subscriberId);
  if (!existing) return jsonResponse(404, { error: "Not found." });

  const documents = await store.listDocumentsForSubscriber(env.DB, session.firmId, subscriberId);
  return jsonResponse(200, { documents: documents.map(toDocumentJson) });
}

/** GET /firm/documents/:id/download -- streams the R2 object. firm_id-bound
 * ownership check (store.getDocumentForFirm) before anything else -- a
 * document id alone is never enough to read it. Content-Disposition:
 * attachment + X-Content-Type-Options: nosniff on every response: a
 * maliciously crafted upload must never be interpretable as inline HTML/JS
 * by a browser, regardless of what content-type made it past the upload
 * allowlist (defense-in-depth, not a substitute for that allowlist). */
async function handleDocumentDownload(request: Request, env: Env, id: string): Promise<Response> {
  const session = await requireFirmSessionWithFirm(request, env);
  if (session instanceof Response) return session;

  const doc = await store.getDocumentForFirm(env.DB, session.firmId, id);
  if (!doc) return jsonResponse(404, { error: "Not found." });

  const object = await env.DOCUMENTS.get(doc.r2_key);
  if (!object) return jsonResponse(404, { error: "Not found." });

  const headers = new Headers();
  headers.set("Content-Type", doc.content_type);
  headers.set("Content-Disposition", `attachment; filename="${doc.filename.replace(/"/g, "'")}"`);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Content-Length", String(doc.size_bytes));
  return new Response(object.body, { status: 200, headers });
}

/** DELETE /firm/documents/:id -- soft-deletes the D1 row, then deletes the
 * matching R2 object. Order matters: if the D1 soft-delete succeeds but the
 * R2 delete somehow fails, the object is merely orphaned (unreferenced,
 * harmless) rather than the reverse (a "deleted" document whose bytes a
 * still-live r2_key could somehow still be reached through). */
async function handleDocumentDelete(request: Request, env: Env, id: string): Promise<Response> {
  // migration 0045 (roadmap #11/#13/#14): Staff stays read-only.
  const session = await requireFirmRole(request, env, "partner", "office_manager");
  if (session instanceof Response) return session;

  if (!originAllowed(request, env)) {
    return jsonResponse(400, { error: "That request couldn't be completed. Please try again from the DeadlineRadar site." });
  }

  // AuditLab SEC-1 (2026-08-07): the original finding -- this endpoint had
  // no rate limit at all, contradicting the /security/ page's own claim.
  const allowed = await checkRateLimit(env.DB, session.firmId, "firm_document_delete", RATE_LIMIT_FIRM_DISMISS);
  if (!allowed) {
    return jsonResponse(429, { error: "Too many attempts. Please try again later." });
  }

  const removed = await store.removeDocument(env.DB, session.firmId, id);
  if (!removed) return jsonResponse(404, { error: "Not found." });

  await env.DOCUMENTS.delete(removed.r2_key);
  return jsonResponse(200, { id, status: "removed" });
}

async function handleConfirm(env: Env, token: string | null): Promise<Response> {
  if (!token) return errorPage(400, "Missing confirmation link.");
  const result = await store.confirmIfPending(env.DB, token);
  if (!result) return errorPage(404, "That confirmation link is invalid or already used.");
  const { subscriber, wasNewlyConfirmed } = result;
  if (wasNewlyConfirmed) {
    await sendSignupNotification(env, "individual", {
      email: subscriber.email,
      stateName: stateNameFromSlug(subscriber.state_slug),
    });
  }
  return htmlResponse(
    200,
    htmlPage(
      "Confirmed",
      "<h1>You're all set</h1><p>Your email is confirmed. We'll send a reminder as your renewal " +
        "deadline approaches &mdash; and nothing else. You can unsubscribe instantly from any email " +
        "we send.</p>"
    )
  );
}

async function handleUnsubscribe(env: Env, token: string | null): Promise<Response> {
  if (!token) return errorPage(400, "Missing unsubscribe link.");
  const subscriber = await store.stop(env.DB, token, "unsubscribed");
  if (!subscriber) return errorPage(404, "That link is invalid.");

  // AuditLab UNSUB-1 (2026-08-06, MEDIUM): unsubscribe_token never expires
  // or rotates BY DESIGN (store.stop()'s own docstring) -- corporate email
  // scanners routinely pre-fetch/re-scan a message's links, sometimes more
  // than once, so this route has always been re-visitable indefinitely.
  // That was harmless before the Activity entry + admin-notify email
  // below existed; now a repeat hit must log/send NEITHER, or a single
  // real unsubscribe turns into an unbounded stream of duplicate "Alex
  // unsubscribed" events and emails every time a scanner revisits the
  // link. store.stop() itself already skips the now-redundant DB write.
  if (subscriber.firm_id && !subscriber.alreadyStopped) {
    try {
      await store.logActivity(env.DB, {
        firmId: subscriber.firm_id,
        subscriberId: subscriber.id,
        staffLabel: subscriber.staff_label,
        email: subscriber.email,
        eventType: "opted_out",
      });
    } catch {
      // Non-fatal -- honoring the unsubscribe already happened regardless.
    }

    // Task #10 (2026-08-06): the Recent Activity entry above is passive --
    // an admin only sees it if they happen to open the dashboard. This
    // pushes it instead, same best-effort/never-block-the-real-action
    // posture as every other notification in this file (checked AFTER the
    // stop already committed, wrapped so a send failure can't turn a
    // successful unsubscribe into an error page).
    try {
      if (env.SENDGRID_API_KEY) {
        const firm = await store.getFirmById(env.DB, subscriber.firm_id);
        if (firm && firm.admin_email) {
          const underCap = await checkAndCountActionSend(env.DB, dailySendCap(env));
          if (underCap) {
            const built = buildStaffUnsubscribedNotificationEmail(
              firm.name ?? "your firm",
              subscriber.staff_label,
              subscriber.email,
              stateNameFromSlug(subscriber.state_slug),
              firm.admin_name
            );
            await sendViaSendGrid(env.SENDGRID_API_KEY, firm.admin_email, built, env.EMAIL_ALLOWLIST);
          }
        }
      }
    } catch {
      // Non-fatal -- same reasoning as the Activity log write above.
    }
  }

  return htmlResponse(
    200,
    htmlPage("Unsubscribed", "<h1>Done</h1><p>You're unsubscribed, instantly and permanently.</p>")
  );
}

/**
 * Roadmap #34 (2026-08-08). Deliberately separate from handleUnsubscribe()
 * above and its own token -- stopping the drip course must never touch a
 * subscriber's actual renewal-deadline reminders, and vice versa (see
 * store.stopDripCourseByToken()'s own comment). Idempotent, same repeat-
 * visit posture as every other action route here.
 */
async function handleDripCourseUnsubscribe(env: Env, token: string | null): Promise<Response> {
  if (!token) return errorPage(400, "Missing unsubscribe link.");
  const stopped = await store.stopDripCourseByToken(env.DB, token);
  if (!stopped) return errorPage(404, "That link is invalid.");
  return htmlResponse(
    200,
    htmlPage(
      "Unsubscribed",
      "<h1>Done</h1><p>You're unsubscribed from this email series, instantly. Your actual renewal-deadline reminders are unaffected.</p>"
    )
  );
}

async function handleRenewed(env: Env, token: string | null): Promise<Response> {
  if (!token) return errorPage(400, "Missing link.");
  const subscriber = await store.stop(env.DB, token, "renewed");
  if (!subscriber) return errorPage(404, "That link is invalid.");

  // Send a stop-confirmation email. Best-effort + isolated, same posture as
  // the confirmation send: only when a key is configured, guarded by the
  // daily circuit breaker, and never allowed to fail the stop itself (the
  // stop already happened above and is what matters).
  //
  // Deliberately NO re-arm offer here (2026-07-28) -- passing `null` instead
  // of a rearmUrl. The re-arm-for-next-cycle choice is now its OWN co-equal
  // CTA in the original reminder email itself (buildReminderEmail's
  // renewedNextCycleUrl / handleRenewedNextCycle() below); anyone reaching
  // THIS follow-up already clicked the OTHER button ("Stop reminders
  // entirely"), so dangling a still-open re-arm offer here would contradict
  // the choice they just made -- exactly the "no email offering a choice
  // that's already been made" rule this build's task called out.
  //
  // AuditLab UNSUB-1 (2026-08-06, same fix applied here too): this route
  // has the identical repeat-visit shape /unsubscribe does -- the token
  // never expires, so a scanner re-fetch would otherwise re-send this
  // confirmation every time. subscriber.alreadyStopped gates it the same way.
  if (env.SENDGRID_API_KEY && !subscriber.alreadyStopped) {
    try {
      const underCap = await checkAndCountActionSend(env.DB, dailySendCap(env));
      if (underCap) {
        const unsubscribeUrl = `${actionBaseUrl(env)}/unsubscribe?token=${encodeURIComponent(subscriber.unsubscribe_token)}`;
        const built = buildStopConfirmationEmail(
          "renewed",
          stateNameFromSlug(subscriber.state_slug),
          null,
          unsubscribeUrl,
          subscriber.first_name
        );
        await sendViaSendGrid(env.SENDGRID_API_KEY, subscriber.email, built, env.EMAIL_ALLOWLIST);
      }
    } catch {
      // Swallow -- the reminders are already stopped; a follow-up email
      // failure must not turn a successful stop into an error page.
    }
  }

  return htmlResponse(
    200,
    htmlPage(
      "Nice work",
      "<h1>Congrats on renewing</h1><p>All reminders for this deadline are stopped, and we've emailed " +
        "you a confirmation. Want reminders again someday? You're welcome to sign up fresh any time.</p>"
    )
  );
}

/**
 * POST /renewed-next-cycle -- the free-tier reminder email's new co-equal
 * "I've renewed -- remind me next cycle" CTA (Part B, 2026-07-28). One
 * atomic stop-this-cycle-AND-rearm-for-next-cycle action
 * (store.renewAndRearmByToken()) using the subscriber's EXISTING
 * renewed_token/unsubscribe_token -- no new token type minted, same
 * GET-render/POST-act prefetch-safe pattern as every other action link here
 * (see ACTION_PAGES["/renewed-next-cycle"] for the GET-render copy).
 *
 * This is deliberately a SEPARATE route/handler from the firm dashboard's
 * POST /firm/licenses/:id/renew (handleFirmLicenseRenew() below) rather than
 * one shared HTTP endpoint -- the two are authorized completely differently
 * (this one by possessing a valid capability-URL token; that one by a
 * verified firm session owning the record) and return different response
 * shapes (an HTML landing page here; JSON there). What they DO share is the
 * one underlying atomic write: both ultimately call store.ts's
 * applyRenewAndRearm() (via renewAndRearmByToken() here, renewAndRearm() with
 * firm-ownership there) -- see that function's own comment for the
 * atomicity reasoning, and for why "one shared store.ts function" was the
 * right place to de-duplicate this, not "one shared HTTP route."
 */
async function handleRenewedNextCycle(env: Env, token: string | null): Promise<Response> {
  if (!token) return errorPage(400, "Missing link.");
  const updated = await store.renewAndRearmByToken(env.DB, token);
  if (!updated) {
    // "Bring your own date" (migration 0005): same tailored refusal as
    // handleRearm() gives -- a real, otherwise-eligible record refused
    // specifically because we can't auto-derive its NEXT date, not a
    // generic "invalid or already used" 404.
    if (await store.isUserDateRenewBlocked(env.DB, token)) {
      return errorPage(
        400,
        "Since we can't automatically know your next renewal date, we can't mark this renewed and " +
          "re-arm it for you. Use \"Stop these reminders entirely\" instead, then sign up again at " +
          "deadline-radar.com once you have your new expiration date -- it takes 10 seconds."
      );
    }
    return errorPage(404, "That link is invalid or already used, or this subscriber wasn't eligible to renew.");
  }
  return htmlResponse(
    200,
    htmlPage(
      "Nice work",
      "<h1>You're all set</h1><p>You're marked as renewed, and we'll remind you again as your next " +
        "renewal deadline approaches. Nothing else to do.</p>"
    )
  );
}

/** GET-render/POST-act action link for roadmap #26 (self-service snooze,
 * migration 0040) -- same shared-token, prefetch-safe pattern as every
 * action link in this file (see ACTION_PAGES["/snooze"] for the GET-render
 * copy). store.snoozeByToken() refuses an unconfirmed or already-stopped
 * row -- the stopped case gets its own tailored message since "nothing to
 * snooze, you already stopped these" is a genuinely different situation
 * than a bad/reused link. */
async function handleSnooze(env: Env, token: string | null): Promise<Response> {
  if (!token) return errorPage(400, "Missing link.");
  const updated = await store.snoozeByToken(env.DB, token, SNOOZE_DAYS);
  if (!updated) {
    return errorPage(
      404,
      "That link is invalid or already used, or this subscriber isn't currently eligible to snooze " +
        "(already stopped, never confirmed, or too close to the actual deadline for any snooze link -- " +
        "even an older one from a prior reminder -- to push it back further)."
    );
  }
  return htmlResponse(
    200,
    htmlPage(
      "You're all set",
      `<h1>Reminder paused</h1><p>We'll pick this back up in ${SNOOZE_DAYS} days. Nothing else changes -- ` +
        `if you renew before then, use the link in your original reminder email to mark it done early.</p>`
    )
  );
}

async function handleRearm(env: Env, token: string | null): Promise<Response> {
  if (!token) return errorPage(400, "Missing link.");
  const subscriber = await store.rearm(env.DB, token);
  if (!subscriber) {
    // "Bring your own date" (migration 0005): a user-provided-date subscriber
    // is a real, otherwise-eligible record that rearm() deliberately refused
    // (see that function's own comment) -- give them an honest, specific
    // reason rather than the generic "invalid or already used" message.
    if (await store.isUserDateRearmBlocked(env.DB, token)) {
      return errorPage(
        400,
        "Since we can't automatically know your next renewal date, we can't re-arm this reminder " +
          "for you. When you have your new expiration date, just sign up again at " +
          "deadline-radar.com -- it takes 10 seconds."
      );
    }
    return errorPage(404, "That link is invalid or already used, or this subscriber wasn't eligible to re-arm.");
  }
  return htmlResponse(
    200,
    htmlPage("Re-armed", "<h1>You're back in</h1><p>We'll remind you again as your next deadline approaches.</p>")
  );
}

// PREVIEW/STAGING CORS (2026-07-28): companion to firmSessionCookieSameSite()
// above. When env.STATIC_SITE_BASE_URL is set (never in production), the
// dashboard's fetch() calls are genuinely cross-origin (pages.dev site,
// workers.dev API), so the browser (a) sends a CORS preflight OPTIONS ahead
// of any PATCH/DELETE/JSON-body request and (b) requires an explicit,
// exact-origin Access-Control-Allow-Origin (not "*") plus
// Access-Control-Allow-Credentials on every response before it will expose
// the response to JS or send the cookie at all. Origin is always the exact
// preview site (never reflected from the request), matching the same site
// the cookie's SameSite=None already trusts.
function corsHeaders(env: Env): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": env.STATIC_SITE_BASE_URL || "",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

function withCorsHeaders(response: Response, env: Env): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders(env))) headers.set(k, v);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

// AuditLab S-1, 2026-08-03: neither origin sent any of the 5 standard security
// response headers. GitHub Pages (the static site) can't be fixed from code --
// that side needs a Cloudflare Response Header Transform Rule -- but every
// response from THIS Worker can carry them. Set-if-absent so this never
// overrides a route's own more specific choice (e.g. the token-bearing action
// pages already set their own stricter frame-ancestors CSP + no-referrer).
// The CSP here covers only what this Worker's own HTML actually needs
// (htmlPage()'s inline <style>, no scripts, no external subresource,
// same-origin form posts) -- it says nothing about the static site's pages.
function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  const defaults: Record<string, string> = {
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'",
    // Orchestrator abuse-test finding (2026-08-05, LOW, latent): every
    // response from this Worker is per-request/per-session (JSON API data
    // or a one-off confirmation/error page) and must never be cached by an
    // intermediary. Not currently exploitable -- Cf-Cache-Status is absent
    // on /api/* today, confirmed via distinct CF-RAYs on repeat calls, so
    // Cloudflare itself isn't caching these -- but nothing on the wire
    // currently SAYS that, so a future Cache Rule change or a corporate/ISP
    // proxy has no signal that a response is per-user. Applied here, the
    // one place that already wraps every response this Worker returns.
    "Cache-Control": "private, no-store",
    Vary: "Cookie",
  };
  for (const [k, v] of Object.entries(defaults)) {
    if (!headers.has(k)) headers.set(k, v);
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function routeRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);

    // This Worker is bound to the deadline-radar.com/api/* route, so every
    // request arrives with an /api prefix the path checks below don't expect.
    // Strip it once here so "/api/health" -> "/health", "/api/subscribe" ->
    // "/subscribe", etc. Bare paths (used by the unit tests) pass through
    // unchanged, so this stays backward-compatible.
    if (url.pathname === "/api" || url.pathname === "/api/") {
      url.pathname = "/";
    } else if (url.pathname.startsWith("/api/")) {
      url.pathname = url.pathname.slice(4);
    }

    if (url.pathname === "/health") {
      return jsonResponse(200, { status: "ok" });
    }

    const ip = clientIp(request);

    // /firm/licenses*, migration 0008's firm-dashboard JSON API (2026-07-28)
    // -- matched once here, up front, so every HTTP method branch below can
    // reuse the same parsed :id. Every handler these route to still starts
    // with requireFirmSession() as its own first line (see that function's
    // docstring); this parsing step is not itself an auth check.
    const firmLicenseRenewMatch = /^\/firm\/licenses\/([^/]+)\/renew$/.exec(url.pathname);
    const firmLicenseIdMatch = firmLicenseRenewMatch ? null : /^\/firm\/licenses\/([^/]+)$/.exec(url.pathname);

    // /firm/cpe/:id, same up-front-parsing pattern as /firm/licenses/:id
    // above -- 2026-07-30, CPE-hours tracker.
    const cpeEntryIdMatch = /^\/firm\/cpe\/([^/]+)$/.exec(url.pathname);

    // /firm/oauth-identities/:id -- same up-front parsing pattern.
    const oauthIdentityIdMatch = /^\/firm\/oauth-identities\/([^/]+)$/.exec(url.pathname);

    // /firm/mobility/completions/:id -- same up-front parsing pattern.
    // 2026-08-04, practice-privilege completion tracking (migration 0016).
    const mobilityCompletionIdMatch = /^\/firm\/mobility\/completions\/([^/]+)$/.exec(url.pathname);

    // /firm/licenses/:id/documents (upload/list) and /firm/documents/:id
    // (download/delete) -- roadmap #1/#2 (2026-08-07), same up-front
    // parsing pattern as every route above. Structurally distinct from
    // firmLicenseIdMatch/firmLicenseRenewMatch (a trailing /documents or a
    // different path prefix), so no ambiguity between them.
    const subscriberDocumentsMatch = /^\/firm\/licenses\/([^/]+)\/documents$/.exec(url.pathname);
    const documentDownloadMatch = /^\/firm\/documents\/([^/]+)\/download$/.exec(url.pathname);
    const documentIdMatch = /^\/firm\/documents\/([^/]+)$/.exec(url.pathname);

    // /firm/sessions/:id -- roadmap #52 (2026-08-07), same up-front parsing pattern.
    const firmSessionIdMatch = /^\/firm\/sessions\/([^/]+)$/.exec(url.pathname);

    // /firm/members/:id/make-primary -- roadmap #51, matched BEFORE
    // firmMemberIdMatch below (same "renew before :id" disambiguation
    // firmLicenseRenewMatch/firmLicenseIdMatch already established) so a
    // POST to this path is never mistaken for a :id route with literal id
    // "make-primary".
    const firmMemberMakePrimaryMatch = /^\/firm\/members\/([^/]+)\/make-primary$/.exec(url.pathname);

    // /firm/members/:id -- migration 0045 (roadmap #11/#13/#14/#51), same
    // up-front parsing pattern. /firm/members/invite is matched separately
    // below (a literal path, not this dynamic :id form).
    const firmMemberIdMatch = firmMemberMakePrimaryMatch ? null : /^\/firm\/members\/([^/]+)$/.exec(url.pathname);

    // GET on an action path renders a confirmation PAGE only -- it never
    // changes state. Email providers (Gmail, corporate filters) automatically
    // GET the links in a message to scan them; if the action fired on GET, a
    // scan could silently stop/unsubscribe/re-arm a subscriber, or consume a
    // one-time link before the human ever clicks it. The state change happens
    // only on the POST below (the button on this page), which scanners don't do.
    if (request.method === "GET") {
      if (url.pathname === "/roadmap-data") {
        try {
          return await handleRoadmapData(request, env);
        } catch {
          return jsonResponse(400, { error: "Something went wrong processing that request." });
        }
      }

      if (url.pathname === "/subscriber/licenses") {
        try {
          return await handleSubscriberLicensesList(request, env);
        } catch {
          return jsonResponse(400, { error: "Something went wrong processing that request." });
        }
      }

      if (url.pathname === "/subscriber/cpe") {
        try {
          return await handleSubscriberCpeEntriesList(request, env);
        } catch {
          return jsonResponse(400, { error: "Something went wrong processing that request." });
        }
      }

      if (url.pathname === "/firm/licenses") {
        try {
          return await handleFirmLicensesList(request, env);
        } catch {
          return jsonResponse(400, { error: "Something went wrong processing that request." });
        }
      }
      if (url.pathname === "/firm/calendar.ics") {
        try {
          return await handleFirmCalendarIcs(request, env);
        } catch {
          return jsonResponse(400, { error: "Something went wrong processing that request." });
        }
      }
      if (url.pathname === "/firm/activity") {
        try {
          return await handleFirmActivityList(request, env);
        } catch {
          return jsonResponse(400, { error: "Something went wrong processing that request." });
        }
      }
      if (url.pathname === "/firm/audit-trail") {
        try {
          return await handleAuditTrail(request, env);
        } catch {
          return jsonResponse(400, { error: "Something went wrong processing that request." });
        }
      }
      if (url.pathname === "/firm/oauth-identities") {
        try {
          return await handleOauthIdentitiesList(request, env);
        } catch {
          return jsonResponse(400, { error: "Something went wrong processing that request." });
        }
      }
      if (url.pathname === "/firm/sessions") {
        try {
          return await handleFirmSessionsList(request, env);
        } catch {
          return jsonResponse(400, { error: "Something went wrong processing that request." });
        }
      }
      if (url.pathname === "/firm/2fa/status") {
        try {
          return await handleFirm2faStatus(request, env);
        } catch {
          return jsonResponse(400, { error: "Something went wrong processing that request." });
        }
      }
      if (url.pathname === "/firm/members") {
        try {
          return await handleFirmMembersList(request, env);
        } catch {
          return jsonResponse(400, { error: "Something went wrong processing that request." });
        }
      }
      if (url.pathname === "/firm/mobility/coverage") {
        try {
          return await handleMobilityCoverage(request, env);
        } catch {
          return jsonResponse(400, { error: "Something went wrong processing that request." });
        }
      }
      if (url.pathname === "/firm/cpe") {
        try {
          return await handleCpeEntriesList(request, env);
        } catch {
          return jsonResponse(400, { error: "Something went wrong processing that request." });
        }
      }
      if (url.pathname === "/firm/mobility/completions") {
        try {
          return await handleMobilityCompletionsList(request, env);
        } catch {
          return jsonResponse(400, { error: "Something went wrong processing that request." });
        }
      }
      if (subscriberDocumentsMatch) {
        try {
          return await handleDocumentList(request, env, subscriberDocumentsMatch[1] as string);
        } catch {
          return jsonResponse(400, { error: "Something went wrong processing that request." });
        }
      }
      if (documentDownloadMatch) {
        try {
          return await handleDocumentDownload(request, env, documentDownloadMatch[1] as string);
        } catch {
          return jsonResponse(400, { error: "Something went wrong processing that request." });
        }
      }
      // SSO (2026-07-30). The provider id is constrained by the pattern
      // itself, and getConfiguredProvider() 404s anything unknown or
      // unconfigured -- so an unregistered provider cannot be reached by
      // guessing a URL.
      const oauthStartMatch = /^\/firm\/auth\/([a-z0-9-]+)\/start$/.exec(url.pathname);
      if (oauthStartMatch) {
        try {
          return await handleOauthStart(env, ip, oauthStartMatch[1] as string);
        } catch {
          return errorPage(400, "Something went wrong processing that request.");
        }
      }
      const oauthCallbackMatch = /^\/firm\/auth\/([a-z0-9-]+)\/callback$/.exec(url.pathname);
      if (oauthCallbackMatch) {
        try {
          return await handleOauthCallback(request, env, ip, oauthCallbackMatch[1] as string);
        } catch {
          return errorPage(400, "Something went wrong processing that request.");
        }
      }

      if (ACTION_PATHS.has(url.pathname)) {
        const allowed = await checkRateLimit(env.DB, ip, "action", RATE_LIMIT_ACTION);
        if (!allowed) return errorPage(429, "Too many requests. Please try again later.");
        const token = url.searchParams.get("token");
        if (!token) return errorPage(400, "That link is missing its token.");
        return await actionConfirmPage(url.pathname, token, env);
      }
      return errorPage(404, "Not found.");
    }

    if (request.method === "PATCH") {
      if (firmLicenseIdMatch) {
        try {
          return await handleFirmLicensePatch(request, env, firmLicenseIdMatch[1] as string);
        } catch {
          return jsonResponse(400, { error: "Something went wrong processing that request." });
        }
      }
      if (url.pathname === "/firm/peer-review") {
        try {
          return await handlePeerReviewSet(request, env);
        } catch {
          return jsonResponse(400, { error: "Something went wrong processing that request." });
        }
      }
      if (url.pathname === "/firm/reply-to") {
        try {
          return await handleReplyToSet(request, env);
        } catch {
          return jsonResponse(400, { error: "Something went wrong processing that request." });
        }
      }
      if (url.pathname === "/firm/reminder-cadence") {
        try {
          return await handleReminderCadenceSet(request, env);
        } catch {
          return jsonResponse(400, { error: "Something went wrong processing that request." });
        }
      }
      if (url.pathname === "/firm/rule-change-alerts") {
        try {
          return await handleRuleChangeAlertsSet(request, env);
        } catch {
          return jsonResponse(400, { error: "Something went wrong processing that request." });
        }
      }
      if (firmMemberIdMatch) {
        try {
          return await handleFirmMemberRoleChange(request, env, firmMemberIdMatch[1] as string);
        } catch {
          return jsonResponse(400, { error: "Something went wrong processing that request." });
        }
      }
      if (url.pathname === "/subscriber/reminder-cadence") {
        try {
          return await handleSubscriberReminderCadenceSet(request, env);
        } catch {
          return jsonResponse(400, { error: "Something went wrong processing that request." });
        }
      }
      return errorPage(404, "Not found.");
    }

    if (request.method === "DELETE") {
      if (oauthIdentityIdMatch) {
        try {
          return await handleOauthIdentityDelete(request, env, oauthIdentityIdMatch[1] as string);
        } catch {
          return jsonResponse(400, { error: "Something went wrong processing that request." });
        }
      }
      if (firmLicenseIdMatch) {
        try {
          return await handleFirmLicenseDelete(request, env, firmLicenseIdMatch[1] as string);
        } catch {
          return jsonResponse(400, { error: "Something went wrong processing that request." });
        }
      }
      if (cpeEntryIdMatch) {
        try {
          return await handleCpeEntryDelete(request, env, cpeEntryIdMatch[1] as string);
        } catch {
          return jsonResponse(400, { error: "Something went wrong processing that request." });
        }
      }
      if (mobilityCompletionIdMatch) {
        try {
          return await handleMobilityCompletionDelete(request, env, mobilityCompletionIdMatch[1] as string);
        } catch {
          return jsonResponse(400, { error: "Something went wrong processing that request." });
        }
      }
      if (firmSessionIdMatch) {
        try {
          return await handleFirmSessionRevoke(request, env, firmSessionIdMatch[1] as string);
        } catch {
          return jsonResponse(400, { error: "Something went wrong processing that request." });
        }
      }
      if (documentIdMatch) {
        try {
          return await handleDocumentDelete(request, env, documentIdMatch[1] as string);
        } catch {
          return jsonResponse(400, { error: "Something went wrong processing that request." });
        }
      }
      if (firmMemberIdMatch) {
        try {
          return await handleFirmMemberRemove(request, env, firmMemberIdMatch[1] as string);
        } catch {
          return jsonResponse(400, { error: "Something went wrong processing that request." });
        }
      }
      return errorPage(404, "Not found.");
    }

    if (request.method === "POST") {
      if (url.pathname === "/firm/licenses") {
        try {
          return await handleFirmLicenseCreate(request, env);
        } catch {
          return jsonResponse(400, { error: "Something went wrong processing that request." });
        }
      }

      if (firmLicenseRenewMatch) {
        try {
          return await handleFirmLicenseRenew(request, env, firmLicenseRenewMatch[1] as string);
        } catch {
          return jsonResponse(400, { error: "Something went wrong processing that request." });
        }
      }

      if (url.pathname === "/firm/cpe") {
        try {
          return await handleCpeEntryCreate(request, env);
        } catch {
          return jsonResponse(400, { error: "Something went wrong processing that request." });
        }
      }

      if (url.pathname === "/firm/nps") {
        try {
          return await handleNpsResponse(request, env);
        } catch {
          return jsonResponse(400, { error: "Something went wrong processing that request." });
        }
      }
      if (url.pathname === "/firm/nps/dismiss") {
        try {
          return await handleNpsDismiss(request, env);
        } catch {
          return jsonResponse(400, { error: "Something went wrong processing that request." });
        }
      }
      if (url.pathname === "/firm/testimonial") {
        try {
          return await handleTestimonialSubmit(request, env);
        } catch {
          return jsonResponse(400, { error: "Something went wrong processing that request." });
        }
      }

      if (subscriberDocumentsMatch) {
        try {
          return await handleDocumentUpload(request, env, subscriberDocumentsMatch[1] as string);
        } catch {
          return jsonResponse(400, { error: "Something went wrong processing that request." });
        }
      }

      if (url.pathname === "/firm/mobility/completions") {
        try {
          return await handleMobilityCompletionCreate(request, env);
        } catch {
          return jsonResponse(400, { error: "Something went wrong processing that request." });
        }
      }

      if (url.pathname === "/firm/billing/checkout") {
        try {
          return await handleFirmBillingCheckout(request, env);
        } catch {
          return jsonResponse(400, { error: "Something went wrong processing that request." });
        }
      }

      if (url.pathname === "/firm/billing/cancel") {
        try {
          return await handleFirmBillingCancellationToggle(request, env, true);
        } catch {
          return jsonResponse(400, { error: "Something went wrong processing that request." });
        }
      }

      if (url.pathname === "/firm/billing/resume") {
        try {
          return await handleFirmBillingCancellationToggle(request, env, false);
        } catch {
          return jsonResponse(400, { error: "Something went wrong processing that request." });
        }
      }

      if (url.pathname === "/firm/account/delete") {
        try {
          return await handleFirmAccountDelete(request, env);
        } catch {
          return jsonResponse(400, { error: "Something went wrong processing that request." });
        }
      }

      if (url.pathname === "/firm/members/invite") {
        try {
          return await handleFirmMemberInvite(request, env);
        } catch {
          return jsonResponse(400, { error: "Something went wrong processing that request." });
        }
      }

      if (firmMemberMakePrimaryMatch) {
        try {
          return await handleFirmMemberMakePrimary(request, env, firmMemberMakePrimaryMatch[1] as string);
        } catch {
          return jsonResponse(400, { error: "Something went wrong processing that request." });
        }
      }

      if (url.pathname === "/stripe/webhook") {
        try {
          return await handleStripeWebhook(request, env);
        } catch {
          // Deliberately 400, not the generic 500 a raw throw would produce
          // -- Stripe treats anything outside 2xx as "retry me," and a body
          // it can't recover from (e.g. a transient D1 error mid-processing)
          // SHOULD be retried, same as every other failure mode this handler
          // returns non-2xx for.
          return jsonResponse(400, { error: "Webhook processing failed." });
        }
      }

      if (url.pathname === "/subscribe") {
        try {
          return await handleSubscribe(request, env, ip);
        } catch {
          return errorPage(400, "Something went wrong processing that request.");
        }
      }

      if (url.pathname === "/firm/lead") {
        try {
          return await handleFirmLead(request, env, ip);
        } catch {
          return errorPage(400, "Something went wrong processing that request.");
        }
      }

      if (url.pathname === "/firm/signup") {
        try {
          return await handleFirmSignup(request, env, ip);
        } catch {
          return errorPage(400, "Something went wrong processing that request.");
        }
      }

      if (url.pathname === "/firm/login") {
        try {
          return await handleFirmLogin(request, env, ip);
        } catch {
          return errorPage(400, "Something went wrong processing that request.");
        }
      }

      if (url.pathname === "/firm/login/password") {
        try {
          return await handleFirmPasswordLogin(request, env, ip);
        } catch {
          return errorPage(400, "Something went wrong processing that request.");
        }
      }

      if (url.pathname === "/firm/2fa/verify") {
        try {
          return await handleFirm2faVerify(request, env, ip);
        } catch {
          return errorPage(400, "Something went wrong processing that request.");
        }
      }

      if (url.pathname === "/firm/password") {
        try {
          return await handleFirmPasswordSet(request, env, ip);
        } catch {
          return jsonResponse(400, { error: "Something went wrong processing that request." });
        }
      }

      if (url.pathname === "/firm/2fa/enroll") {
        try {
          return await handleFirm2faEnroll(request, env);
        } catch {
          return jsonResponse(400, { error: "Something went wrong processing that request." });
        }
      }

      if (url.pathname === "/firm/2fa/enroll/confirm") {
        try {
          return await handleFirm2faEnrollConfirm(request, env);
        } catch {
          return jsonResponse(400, { error: "Something went wrong processing that request." });
        }
      }

      if (url.pathname === "/firm/2fa/disable") {
        try {
          return await handleFirm2faDisable(request, env);
        } catch {
          return jsonResponse(400, { error: "Something went wrong processing that request." });
        }
      }

      if (url.pathname === "/firm/sign-out-other-devices") {
        try {
          return await handleFirmSignOutOtherDevices(request, env);
        } catch {
          return jsonResponse(400, { error: "Something went wrong processing that request." });
        }
      }

      if (url.pathname === "/firm/change-email") {
        try {
          return await handleFirmChangeEmailRequest(request, env);
        } catch {
          return jsonResponse(400, { error: "Something went wrong processing that request." });
        }
      }

      if (url.pathname === "/firm/mobility/check") {
        try {
          return await handleMobilityCheck(request, env, ip);
        } catch {
          return jsonResponse(400, { error: "Something went wrong processing that request." });
        }
      }

      if (url.pathname === "/firm/mobility/check-batch") {
        try {
          return await handleMobilityCheckBatch(request, env);
        } catch {
          return jsonResponse(400, { error: "Something went wrong processing that request." });
        }
      }

      if (url.pathname === "/firm/logout") {
        try {
          return await handleFirmLogout(request, env, ip);
        } catch {
          return errorPage(400, "Something went wrong processing that request.");
        }
      }

      if (url.pathname === "/subscriber/login") {
        try {
          return await handleSubscriberLoginRequest(request, env, ip, ctx);
        } catch {
          return errorPage(400, "Something went wrong processing that request.");
        }
      }

      if (url.pathname === "/subscriber/logout") {
        try {
          return await handleSubscriberLogout(request, env, ip);
        } catch {
          return errorPage(400, "Something went wrong processing that request.");
        }
      }

      if (url.pathname === "/subscriber/cpe") {
        try {
          return await handleSubscriberCpeEntryCreate(request, env);
        } catch {
          return jsonResponse(400, { error: "Something went wrong processing that request." });
        }
      }

      if (url.pathname === "/subscriber/change-email") {
        try {
          return await handleSubscriberChangeEmailRequest(request, env);
        } catch {
          return jsonResponse(400, { error: "Something went wrong processing that request." });
        }
      }

      if (url.pathname === "/subscriber/profile") {
        try {
          return await handleSubscriberProfileUpdate(request, env);
        } catch {
          return jsonResponse(400, { error: "Something went wrong processing that request." });
        }
      }

      if (url.pathname === "/firm/staff-cpe-reminder") {
        try {
          return await handleFirmStaffCpeReminder(request, env);
        } catch {
          return jsonResponse(400, { error: "Something went wrong processing that request." });
        }
      }

      if (url.pathname === "/firm/rule-change/notify") {
        try {
          return await handleFirmRuleChangeNotify(request, env);
        } catch {
          return jsonResponse(400, { error: "Something went wrong processing that request." });
        }
      }

      if (url.pathname === "/firm/questionnaire") {
        try {
          return await handleFirmQuestionnaireSubmit(request, env);
        } catch {
          return jsonResponse(400, { error: "Something went wrong processing that request." });
        }
      }

      if (url.pathname === "/firm/questionnaire/dismiss") {
        try {
          return await handleFirmQuestionnaireDismiss(request, env);
        } catch {
          return jsonResponse(400, { error: "Something went wrong processing that request." });
        }
      }

      if (url.pathname === "/firm/onboarding-checklist/dismiss") {
        try {
          return await handleOnboardingChecklistDismiss(request, env);
        } catch {
          return jsonResponse(400, { error: "Something went wrong processing that request." });
        }
      }

      if (url.pathname === "/firm/product-tour/dismiss") {
        try {
          return await handleProductTourDismiss(request, env);
        } catch {
          return jsonResponse(400, { error: "Something went wrong processing that request." });
        }
      }

      if (url.pathname === "/roadmap/vote") {
        try {
          return await handleRoadmapVote(request, env, ip);
        } catch {
          return jsonResponse(400, { error: "Something went wrong processing that request." });
        }
      }

      if (url.pathname === "/roadmap/notify-signup") {
        try {
          return await handleRoadmapNotifySignup(request, env, ip);
        } catch {
          return jsonResponse(400, { error: "Something went wrong processing that request." });
        }
      }

      // PREVIEW/STAGING ONLY -- see RATE_LIMIT_DEBUG_REMINDER_PASS's own
      // comment. Gated on env.EMAIL_ALLOWLIST being SET, which is never true
      // in production (that env var only exists on a preview deployment) --
      // so this route is unconditionally 404 in production regardless of
      // this check ever being reached, and every email it can possibly send
      // is itself gated by sendViaSendGrid()'s allowlist. Lets a human tester
      // fire the daily reminder cron on demand rather than waiting for the
      // real 18:00 UTC trigger.
      if (url.pathname === "/debug/run-reminder-pass") {
        if (!env.EMAIL_ALLOWLIST) return errorPage(404, "Not found.");
        const allowed = await checkRateLimit(env.DB, ip, "debug_reminder_pass", RATE_LIMIT_DEBUG_REMINDER_PASS);
        if (!allowed) return errorPage(429, "Too many requests. Please try again later.");
        try {
          const summary = await runReminderPass(env);
          return jsonResponse(200, summary);
        } catch (err) {
          if (err instanceof SchedulerStaleDataError) {
            return jsonResponse(200, { paused: true, reason: "stale_reference_data", message: err.message });
          }
          return errorPage(500, "Reminder pass failed.");
        }
      }

      if (ACTION_PATHS.has(url.pathname)) {
        const allowed = await checkRateLimit(env.DB, ip, "action", RATE_LIMIT_ACTION);
        if (!allowed) return errorPage(429, "Too many requests. Please try again later.");
        // Token from the form body (our confirmation-page button) OR the URL
        // query (RFC 8058 List-Unsubscribe one-click POST, whose body is
        // "List-Unsubscribe=One-Click" and carries no token of its own).
        //
        // The query fallback is NOT allowed for the login routes (2026-07-31,
        // security review): it exists solely for that one-click unsubscribe
        // case, and on a route that hands out a session it just makes the
        // CSRF attack a one-liner -- no body to forge, only a URL. A login
        // token must arrive in the form body, alongside its nonce.
        const csrfRequired = ACTION_CSRF_REQUIRED_PATHS.has(url.pathname);
        let token = csrfRequired ? null : url.searchParams.get("token");
        let formNonce: string | null = null;
        // Only meaningful on /firm/login/verify -- see handleFirmLoginVerify()'s
        // own docstring for why this rides the same one-click form instead of
        // a separate step (2026-08-02, Devin's own feedback: signup never
        // surfaced a way to set a password at all).
        let optionalNewPassword: string | null = null;
        try {
          const raw = await request.text();
          if (raw.length > 0 && raw.length <= MAX_BODY_BYTES) {
            const parsed = new URLSearchParams(raw);
            token = parsed.get("token") ?? token;
            formNonce = parsed.get(ACTION_CSRF_FIELD_NAME);
            optionalNewPassword = parsed.get("new_password");
          }
        } catch {
          // keep whatever the query gave us
        }
        if (csrfRequired && !actionCsrfOk(request, url.pathname, formNonce)) {
          // Deliberately does NOT consume the login token -- a victim hit by
          // this must still be able to use their own link afterwards.
          return errorPage(
            400,
            "That sign-in couldn't be completed. Please open the sign-in link from your email " +
              "again and use the button on that page."
          );
        }
        try {
          switch (url.pathname) {
            case "/confirm":
              return await handleConfirm(env, token);
            case "/unsubscribe":
              return await handleUnsubscribe(env, token);
            case "/drip-course/unsubscribe":
              return await handleDripCourseUnsubscribe(env, token);
            case "/renewed":
              return await handleRenewed(env, token);
            case "/renewed-next-cycle":
              return await handleRenewedNextCycle(env, token);
            case "/rearm":
              return await handleRearm(env, token);
            case "/snooze":
              return await handleSnooze(env, token);
            case "/firm/login/verify":
              return await handleFirmLoginVerify(env, token, optionalNewPassword);
            case "/subscriber/login/verify":
              return await handleSubscriberLoginVerify(env, token);
            case "/roadmap/notify-confirm":
              return await handleRoadmapNotifyConfirm(env, token);
          }
        } catch {
          return errorPage(400, "Something went wrong processing that request.");
        }
      }
    }

    return errorPage(404, "Not found.");
}


// ---------------------------------------------------------------------------
// Auth suite (2026-07-30): password login, password set/change, and SSO.
//
// The emailed magic link is NOT removed. It is demoted in the UI to the
// "no password yet / forgot password" path, and its existing route pair
// (/firm/login -> /firm/login/verify) is untouched. That matters for a
// concrete reason: every firm that existed before this change has NO
// password, so the emailed link is still their only way in. Deleting it
// would have locked out every current customer, including Devin's own
// production firm.
// ---------------------------------------------------------------------------

/**
 * POST /firm/login/password -- email + password.
 *
 * Anti-enumeration is the whole shape of this handler. Every failure path
 * -- no such firm, firm with no password set, wrong password -- returns
 * the SAME generic message, and the no-such-firm branch still burns an
 * equivalent PBKDF2 derivation via dummyVerifyForTiming(). Without that
 * dummy, a wrong email returns in ~5ms while a wrong password takes
 * ~120ms, which turns this form into a firm-directory oracle that
 * cheerfully confirms which accounting firms use the product.
 */
async function handleFirmPasswordLogin(request: Request, env: Env, ip: string): Promise<Response> {
  // LOGIN CSRF (2026-07-31, verification pass): this route ends in
  // Set-Cookie: dr_firm_session, and unlike the magic-link routes it has no
  // GET render to mint a nonce from -- so an attacker could auto-submit
  // their OWN credentials cross-site and silently sign the victim in as
  // themselves. See originAllowed()'s docstring. Checked FIRST, before the
  // rate limit, so a cross-site attempt cannot burn the victim's bucket.
  if (!originAllowed(request, env)) {
    return errorPage(400, "That sign-in couldn't be completed. Please sign in from the DeadlineRadar site.");
  }

  const ipAllowed = await checkRateLimit(env.DB, ip, "firm_password_login", RATE_LIMIT_FIRM_PASSWORD_LOGIN);
  if (!ipAllowed) {
    return errorPage(429, "Too many sign-in attempts from this address. Please try again later.");
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return errorPage(400, "Something went wrong processing that request.");
  }
  if (raw.length === 0 || raw.length > MAX_BODY_BYTES) {
    return errorPage(400, "Request too large or empty.");
  }

  let form: Record<string, string>;
  try {
    form = Object.fromEntries(new URLSearchParams(raw).entries());
  } catch {
    return errorPage(400, "Something went wrong processing that request.");
  }

  const honeypotValue = form[HONEYPOT_FIELD_NAME];
  if (honeypotValue !== undefined && honeypotValue !== "") {
    return errorPage(400, INVALID_CREDENTIALS_MESSAGE);
  }

  // Deliberately does NOT control-char-check the password itself: a
  // password is never rendered or stored raw, and rejecting on content
  // here would leak that the field reached validation. The email is
  // checked, since it IS echoed into queries and logs.
  const email = (form.admin_email ?? "").trim();
  if (hasControlChars(email) || !isValidEmail(email)) {
    return errorPage(400, INVALID_CREDENTIALS_MESSAGE);
  }
  const password = form.password ?? "";

  // Out-of-range candidates are rejected HERE, before the firm lookup, and
  // still pay the full KDF cost.
  //
  // Both 2026-07-30 security reviews caught this independently, and one
  // reproduced it end to end: verifyPassword() returns early (no
  // derivation) for an empty or over-length password, while the
  // no-such-firm branch runs the full dummy derivation. That INVERTS the
  // timing signal this handler exists to remove -- a firm that exists WITH
  // a password answered in ~12ms, a nonexistent one in ~68ms, making a
  // fast reply a positive existence signal. Response bodies were
  // byte-identical throughout, which is why the original tests passed:
  // they asserted equal bodies, never equal work.
  //
  // Handling length uniformly for every email, before any lookup, means no
  // input shape can produce a branch that skips the derivation.
  if (password.length === 0 || password.length > MAX_PASSWORD_LEN) {
    await dummyVerifyForTiming(env.PASSWORD_PEPPER);
    return errorPage(400, INVALID_CREDENTIALS_MESSAGE);
  }

  // 2026-08-05: this route grants direct access on success (a password
  // check, not a magic-link email), so it deliberately does NOT pass
  // allowMissingToken -- unlike the other 5 verifyTurnstile() call sites,
  // there is no secondary "must click a real emailed link" gate here to
  // fall back on. Relaxing it would mean a password-guessing bot no longer
  // needs to solve Turnstile at all, which is a real regression on the one
  // route that grants access directly -- so this stays strict.
  //
  // AuditLab TS-2 (MEDIUM, 2026-08-05): the ORIGINAL copy here said "please
  // try again", which cannot succeed while the blocker stays active and
  // sends an ad-blocked visitor into a retry loop with no way out -- on
  // /firm-login/, the primary paid-firm sign-in path, no less. The fix is
  // not to relax the check (see above) but to point at the fallback that
  // already exists on the SAME page and IS relaxed: the magic-link "Email
  // me a sign-in link instead" option, unaffected by Turnstile since it
  // doesn't grant access directly. ajaxifyForm() shows this text inline on
  // /firm-login/ without navigating away, so that link is already visible
  // right there when this message renders.
  const turnstileOk = await verifyTurnstile(form["cf-turnstile-response"], env.TURNSTILE_SECRET_KEY);
  if (!turnstileOk) {
    return errorPage(
      400,
      "Verification failed. If you use an ad blocker or privacy extension, it may be blocking " +
        "our security check for password sign-in specifically -- use \"Email me a sign-in link " +
        "instead\" below, which doesn't need it."
    );
  }

  // Second bucket, keyed on the ACCOUNT rather than the source IP. Per-IP
  // throttling alone does nothing against a distributed attack aimed at
  // one high-value firm. Keyed on the normalized email so case/whitespace
  // variants share a bucket instead of each getting a fresh allowance.
  const accountAllowed = await checkRateLimit(
    env.DB,
    `account:${store.normalizeEmail(email)}`,
    "firm_password_login_account",
    RATE_LIMIT_FIRM_PASSWORD_LOGIN
  );
  if (!accountAllowed) {
    return errorPage(429, "Too many sign-in attempts for this account. Please try again later.");
  }

  // migration 0045: findFirmMemberByEmail(), not findFirmByAdminEmail() --
  // a password login authenticates a SPECIFIC member, not "the firm."
  const member = await store.findFirmMemberByEmail(env.DB, email);

  if (!member || !member.password_hash) {
    // No account, or an account that has never set a password (SSO-only or
    // magic-link-only). Burn comparable work so this branch is not
    // distinguishable by timing, then fail identically.
    await dummyVerifyForTiming(env.PASSWORD_PEPPER);
    return errorPage(400, INVALID_CREDENTIALS_MESSAGE);
  }

  const ok = await verifyPassword(
    password,
    {
      algo: member.password_algo ?? undefined,
      salt: member.password_salt ?? undefined,
      iterations: member.password_iterations ?? undefined,
      rounds: member.password_rounds ?? undefined,
      hash: member.password_hash,
    },
    env.PASSWORD_PEPPER
  );
  if (!ok) {
    return errorPage(400, INVALID_CREDENTIALS_MESSAGE);
  }

  // Checked AFTER password verification, deliberately -- moving this earlier
  // would let a caller distinguish "wrong password" from "suspended account"
  // by response, handing an attacker free account-status enumeration on top
  // of a correct guess. Once they've proven they hold the real password,
  // revealing suspension is no longer a new leak. (AuditLab F-1, 2026-08-02.)
  const firm = await store.getFirmById(env.DB, member.firm_id);
  if (!firm || firm.status !== "active") {
    return errorPage(403, "This account isn't active. Get in touch and we'll sort it out.");
  }

  // Roadmap #53: gate at the EARLIEST point after credential proof, before
  // ANY side effect (the rehash upgrade below is itself a side effect,
  // though a harmless one) -- mirrors handleFirmLoginVerify()'s own gate
  // placement and the same reasoning migration 0047's docstring gives:
  // this is the "credential proven, TOTP not yet entered" boundary, not
  // just "before createSession()".
  if (member.totp_enrolled_at) {
    const { rawToken } = await store.createFirm2faPendingToken(env.DB, member.id, firm.id, "login", null);
    return new Response(null, {
      status: 302,
      headers: { Location: `${env.STATIC_SITE_BASE_URL || ""}/firm-login/2fa/?pending=${encodeURIComponent(rawToken)}` },
    });
  }

  // Successful login is the only moment the plaintext is legitimately in
  // hand, so it is the only moment an outdated work factor can be upgraded
  // without asking the user to do anything.
  if (
    needsRehash(
      {
        algo: member.password_algo ?? undefined,
        iterations: member.password_iterations ?? undefined,
        rounds: member.password_rounds ?? undefined,
        hash: member.password_hash,
      },
      env.PASSWORD_PEPPER
    )
  ) {
    try {
      await store.setFirmMemberPassword(env.DB, member.id, await hashPassword(password, env.PASSWORD_PEPPER));
    } catch {
      // A failed opportunistic upgrade must never fail the login itself.
    }
  }

  // A brand-new session row per login (never reusing or accepting a
  // caller-supplied identifier) is what makes session fixation impossible
  // here: there is no way to pre-plant a session id and have it become
  // authenticated.
  const { rawSessionToken } = await store.createSession(env.DB, firm.id, member.id);
  await store.markFirmMemberJoined(env.DB, member.id);
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${env.STATIC_SITE_BASE_URL || ""}/firm-dashboard/`,
      "Set-Cookie": firmSessionSetCookieHeader(rawSessionToken, env),
    },
  });
}

// ---------------------------------------------------------------------------
// Mobility / practice-privilege checks (2026-07-30). PAY-GATED -- the first
// premium-only feature in this Worker.
//
// Two properties matter more than anything else here, and both are enforced
// at this layer rather than trusted to the caller:
//   * the entitlement check happens BEFORE any determination is computed,
//     so a non-paying firm never receives a result, not even a cached one;
//   * every response carries the not-legal-advice disclaimer and, where one
//     exists, the citation -- the UI cannot render a determination without
//     them because they arrive in the same payload.
// ---------------------------------------------------------------------------

/** Rules are looked up by slug. Built once at module load rather than per
 * request -- the dataset is static and small. */
const MOBILITY_RULES_BY_SLUG: Record<string, MobilityRuleRow> = Object.create(null);
for (const raw of (mobilityRulesData.records ?? []) as unknown[]) {
  // normalizeRuleRow() coerces every field to a strict tri-state and drops
  // unusable rows. Without it, an OMITTED key in the JSON reads as
  // `undefined`, passes both the `=== null` and `=== false` guards
  // downstream, and yields a green "practice privilege exists" verdict for
  // a row that verified nothing -- reproduced over HTTP in the 2026-07-30
  // review. TypeScript cannot catch this at the JSON boundary.
  const row = normalizeRuleRow(raw);
  if (row) MOBILITY_RULES_BY_SLUG[row.state_slug] = row;
}

/**
 * GET /firm/mobility/coverage -- which states we hold verified rules for.
 *
 * Exists so the UI can be HONEST about coverage up front rather than
 * letting a firm run a check and discover we have nothing. Returns the
 * covered slugs and the dataset's as-of date; deliberately does not return
 * the rules themselves (that is the paid determination).
 *
 * Pay-gated like the check itself: coverage is a product detail, and
 * leaking the shape of the premium dataset to non-subscribers is free
 * competitive intelligence for the incumbents this feature competes with.
 */
async function handleMobilityCoverage(request: Request, env: Env): Promise<Response> {
  const session = await requireFirmSessionAndPaidTier(request, env);
  if (session instanceof Response) return session;

  const covered = Object.values(MOBILITY_RULES_BY_SLUG).map((r) => ({
    state_slug: r.state_slug,
    state: r.state,
    confidence: r.confidence,
    verified_date: r.verified_date,
  }));
  return jsonResponse(200, {
    covered,
    covered_count: covered.length,
    as_of: (mobilityRulesData._meta as Record<string, unknown> | undefined)?.as_of_date ?? null,
    disclaimer: MOBILITY_DISCLAIMER,
  });
}

/**
 * POST /firm/password -- set a first password, or change an existing one.
 *
 * Requires a live session. If the firm ALREADY has a password, the current
 * one must be supplied: a session cookie alone must not be enough to
 * silently rotate the credential, or an attacker with a stolen cookie
 * could lock the real owner out permanently. When no password exists yet
 * (the normal case right after a magic-link sign-in), there is nothing to
 * prove and the current-password field is not required.
 */
async function handleFirmPasswordSet(request: Request, env: Env, ip: string): Promise<Response> {
  const session = await requireFirmSession(request, env);
  if (session instanceof Response) return session;

  // CSRF defense-in-depth (2026-08-05) -- see handleFirmLicenseCreate's own comment.
  if (!originAllowed(request, env)) {
    return jsonResponse(400, { error: "That request couldn't be completed. Please try again from the DeadlineRadar site." });
  }

  const allowed = await checkRateLimit(env.DB, ip, "firm_password_set", RATE_LIMIT_FIRM_PASSWORD_SET);
  if (!allowed) {
    return jsonResponse(429, { error: "Too many attempts. Please try again later." });
  }

  // Size-capped like every other JSON route in this file (the others go
  // through readFirmLicenseJsonBody). Flagged in review as the one
  // deviation from that convention.
  //
  // CSRF defense-in-depth -- see readFirmLicenseJsonBody()'s own comment.
  // Especially load-bearing on THIS route: it sets the firm's password.
  const passwordSetContentType = request.headers.get("content-type") ?? "";
  if (!passwordSetContentType.toLowerCase().startsWith("application/json")) {
    return jsonResponse(400, { error: "Expected a JSON request body." });
  }
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return jsonResponse(400, { error: "Something went wrong processing that request." });
  }
  if (raw.length === 0 || raw.length > MAX_BODY_BYTES) {
    return jsonResponse(400, { error: "Request too large or empty." });
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return jsonResponse(400, { error: "Something went wrong processing that request." });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonResponse(400, { error: "Something went wrong processing that request." });
  }

  const newPassword = typeof body.new_password === "string" ? body.new_password : "";
  const currentPassword = typeof body.current_password === "string" ? body.current_password : "";

  const strength = validatePasswordStrength(newPassword);
  if (!strength.ok) {
    return jsonResponse(400, { error: strength.error });
  }

  const firm = await store.getFirmById(env.DB, session.firmId);
  if (!firm) {
    return jsonResponse(404, { error: "Not found." });
  }
  // migration 0045: a password is now set on the SIGNED-IN MEMBER, not the
  // firm -- every check below (current-password proof, the hash itself)
  // reads/writes session.memberId's own firm_members row.
  const member = await store.getFirmMemberById(env.DB, session.firmId, session.memberId);
  if (!member) {
    return jsonResponse(404, { error: "Not found." });
  }

  // Task #27 (2026-08-06, Devin's explicit call): unconditional, no
  // exception for a password-RESET-authorized session either. An earlier
  // version of this gate left that path open (redeeming a reset link
  // proves control of the account's registered inbox) -- Devin explicitly
  // didn't want "Forgot password" to work for this account AT ALL, not
  // even for someone who genuinely controls the inbox, so there is no
  // self-serve rotation path left for a demo_locked firm by design.
  // Rotating the password is now an operator action only (ask
  // AssetLab/orchestrator to do it directly), never something reachable
  // from the public site.
  if (firm.demo_locked) {
    return jsonResponse(403, {
      error: "This is a shared demo account. Password changes aren't available for this account.",
    });
  }

  // A session minted by redeeming a password-RESET link is exempt from
  // proving the old password (migration 0014). It has to be: the person who
  // clicked "Forgot password" is by definition the person who cannot supply
  // it, so requiring it would leave the reset flow refusing the only user it
  // exists for. The exemption is safe because that session proves control of
  // the account's own inbox -- stronger evidence than the cookie the
  // prove-the-old-password rule guards against -- and it is spent below, so
  // one emailed link authorises exactly one password set.
  if (member.password_hash && !session.passwordResetAuthorized) {
    const currentOk = await verifyPassword(
      currentPassword,
      {
        algo: member.password_algo ?? undefined,
        salt: member.password_salt ?? undefined,
        iterations: member.password_iterations ?? undefined,
        rounds: member.password_rounds ?? undefined,
        hash: member.password_hash,
      },
      env.PASSWORD_PEPPER
    );
    if (!currentOk) {
      return jsonResponse(400, { error: "That current password isn't right." });
    }
  }

  await store.setFirmMemberPassword(env.DB, member.id, await hashPassword(newPassword, env.PASSWORD_PEPPER));

  // Changing a password must end every OTHER session. If the reason for
  // the change is that a session was stolen, leaving that session alive
  // makes the change cosmetic -- the attacker just keeps using the cookie
  // they already hold. The caller's own session survives so they aren't
  // logged out of the tab they're sitting in.
  // migration 0045: scoped to THIS member's own other sessions, not every
  // member of the firm -- see deleteOtherSessionsForMember()'s own
  // docstring for why the firm-wide version would be a real bug here.
  const endedSessions = await store.deleteOtherSessionsForMember(env.DB, member.id, session.sessionId);

  // ...and every UNUSED sign-in / reset link (2026-07-31). Same reasoning one
  // step earlier in the chain: an outstanding emailed link is a live bearer
  // credential for this account, so finishing a reset while leaving older
  // links redeemable would make the reset only half-true. Cheap, and it also
  // tidies up the duplicates people generate by clicking "email me a link"
  // several times when the first is slow to arrive.
  await store.invalidateOutstandingLoginTokensForMember(env.DB, member.id);

  // Spend the one-shot reset authority. Left set, it would sit on a 30-day
  // session and allow unlimited future password rewrites without the old
  // password -- exactly what the rule above exists to prevent.
  await store.clearSessionResetAuthorization(env.DB, session.sessionId);

  // Notify the account owner. This is the DETECTION control for the hole
  // the security review found: every firm predating migration 0010 has no
  // password, so the "prove the current password" branch above does not
  // run for them -- meaning a single stolen session cookie can mint a
  // permanent credential AND (via the line above) sign the real owner out
  // everywhere. Without this email the owner sees only one logout, which
  // is indistinguishable from ordinary session expiry.
  //
  // Best-effort and never allowed to fail the request, matching every
  // other send in this file: a mail outage must not leave the user unsure
  // whether their password actually changed.
  //
  // Guarded and capped exactly like issueAndSendFirmLoginLink(): no API key
  // means no send (unconfigured degrades to silence, not an error), and it
  // counts against the same daily circuit breaker. Letting a security
  // notice bypass the cap would hand an attacker a way to burn the send
  // quota, so consistency wins over always-notify here.
  if (env.SENDGRID_API_KEY) {
    try {
      const underCap = await checkAndCountActionSend(env.DB, dailySendCap(env));
      if (underCap) {
        // migration 0045: notifies the MEMBER whose password actually
        // changed, not the firm's primary contact -- a teammate's password
        // change is that teammate's own security event, not necessarily
        // something every other member should be emailed about.
        const built = buildFirmPasswordChangedEmail(firm.name, new Date().toISOString(), member.name);
        await sendViaSendGrid(env.SENDGRID_API_KEY, member.email, built, env.EMAIL_ALLOWLIST);
      }
    } catch {
      // Intentionally swallowed -- see above.
    }
  }

  return jsonResponse(200, { ok: true, other_sessions_ended: endedSessions });
}

/**
 * GET /firm/2fa/status -- roadmap #53. Read-only, same shape as
 * handleFirmSessionsList()/handleFirmIdentitiesList() just above: session-
 * gated only, no CSRF/rate-limit needed for a read. Lets the Account tab
 * render "Enable"/"Disable" without guessing from any other endpoint's
 * side data.
 */
async function handleFirm2faStatus(request: Request, env: Env): Promise<Response> {
  const session = await requireFirmSession(request, env);
  if (session instanceof Response) return session;
  const member = await store.getFirmMemberById(env.DB, session.firmId, session.memberId);
  if (!member) {
    return jsonResponse(404, { error: "Not found." });
  }
  const enabled = Boolean(member.totp_enrolled_at);
  const backupCodesRemaining = enabled ? await store.countUnusedFirmMemberBackupCodes(env.DB, member.id) : 0;
  return jsonResponse(200, { enabled, backup_codes_remaining: backupCodesRemaining });
}

/**
 * POST /firm/2fa/enroll -- roadmap #53, enrollment step 1. Generates a fresh
 * secret and returns it (base32 + otpauth:// URI) for the caller to add to
 * an authenticator app. Deliberately persists NOTHING yet -- the secret
 * only becomes real once handleFirm2faEnrollConfirm() proves a code was
 * actually derived from it, so an abandoned enrollment (closed tab, changed
 * mind) leaves no half-enrolled row to clean up. The secret is round-
 * tripped back to the client on /enroll/confirm; that adds no new exposure
 * (the client is about to display it to the member for manual entry into
 * their app anyway, which is the whole point of this step), and confirm
 * never trusts it without independently TOTP-verifying a real code
 * alongside it -- see that handler's own comment.
 */
async function handleFirm2faEnroll(request: Request, env: Env): Promise<Response> {
  const session = await requireFirmSession(request, env);
  if (session instanceof Response) return session;

  if (!originAllowed(request, env)) {
    return jsonResponse(400, { error: "That request couldn't be completed. Please try again from the DeadlineRadar site." });
  }

  if (!env.TOTP_ENCRYPTION_KEY) {
    return jsonResponse(503, { error: "Two-factor authentication isn't available right now. Please try again later." });
  }

  const allowed = await checkRateLimit(env.DB, session.memberId, "firm_2fa_enroll", RATE_LIMIT_FIRM_2FA_ENROLL);
  if (!allowed) {
    return jsonResponse(429, { error: "Too many attempts. Please try again later." });
  }

  const firm = await store.getFirmById(env.DB, session.firmId);
  const member = await store.getFirmMemberById(env.DB, session.firmId, session.memberId);
  if (!firm || !member) {
    return jsonResponse(404, { error: "Not found." });
  }
  // Same posture as SSO-linking's own demo_locked refusal (Task #27): the
  // shared demo account is used by many people who all need the same
  // sign-in to keep working. Two-factor authentication tying sign-in to
  // ONE person's authenticator app would lock everyone else out of the
  // exact account this exists to let anyone freely try.
  if (firm.demo_locked) {
    return jsonResponse(400, { error: "Two-factor authentication isn't available for this shared demo account." });
  }
  if (member.totp_enrolled_at) {
    return jsonResponse(400, { error: "Two-factor authentication is already enabled on this account. Disable it first to re-enroll." });
  }

  // AuditLab 2FA-2 (MEDIUM, 2026-08-07): every other credential-changing
  // action in this file requires step-up (handleFirmPasswordSet,
  // handleFirmChangeEmailRequest's own EMAILCHG-1 fix, account deletion's
  // DELETE-1 fix) -- enrollment was the outlier. Without this, a stolen
  // session enrolls 2FA with an ATTACKER-controlled secret and receives the
  // 8 backup codes in the response, locking the real owner out of their own
  // account with no self-recovery path (disable itself requires a TOTP/
  // backup code the attacker now holds) -- strictly worse than the
  // email-change hijack EMAILCHG-1 already established as worth gating.
  // Mirrors handleFirmChangeEmailRequest's exact gate, including the same
  // two exemptions: skipped when the firm has no password yet (a magic-
  // link-only firm must still be able to use this feature) or the session
  // is passwordResetAuthorized (already proved control of the inbox via a
  // fresh reset link).
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return jsonResponse(400, { error: "Something went wrong processing that request." });
  }
  if (raw.length > MAX_BODY_BYTES) {
    return jsonResponse(400, { error: "Request too large." });
  }
  let body: Record<string, unknown> = {};
  if (raw.length > 0) {
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return jsonResponse(400, { error: "Something went wrong processing that request." });
    }
  }
  const currentPassword = typeof body.current_password === "string" ? body.current_password : "";
  if (member.password_hash && !session.passwordResetAuthorized) {
    const currentOk = await verifyPassword(
      currentPassword,
      {
        algo: member.password_algo ?? undefined,
        salt: member.password_salt ?? undefined,
        iterations: member.password_iterations ?? undefined,
        rounds: member.password_rounds ?? undefined,
        hash: member.password_hash,
      },
      env.PASSWORD_PEPPER
    );
    if (!currentOk) {
      return jsonResponse(400, { error: "That current password isn't right." });
    }
  }

  const secret = generateTotpSecretBase32();
  return jsonResponse(200, { secret, otpauth_uri: buildOtpauthUri(secret, member.email, "DeadlineRadar") });
}

/**
 * POST /firm/2fa/enroll/confirm -- roadmap #53, enrollment step 2. Body:
 * secret (the value /enroll just returned), code (what the member's app
 * shows for it right now). Verifying the code against the CLIENT-SUPPLIED
 * secret before ever persisting anything is the whole security argument
 * for the stateless enroll/confirm split above: this route only ever
 * writes a secret it just watched produce a real, currently-valid code, so
 * there is no path where an unverified value reaches storage.
 *
 * Refuses outright if the member is already enrolled -- without this, a
 * stolen session could silently swap out a legitimate member's TOTP secret
 * for an attacker-controlled one, which would be a full account takeover
 * masquerading as "re-enrollment." Disabling has its own step-up-gated
 * route (handleFirm2faDisable) for a reason; this must never become a side
 * door around it.
 */
async function handleFirm2faEnrollConfirm(request: Request, env: Env): Promise<Response> {
  const session = await requireFirmSession(request, env);
  if (session instanceof Response) return session;

  if (!originAllowed(request, env)) {
    return jsonResponse(400, { error: "That request couldn't be completed. Please try again from the DeadlineRadar site." });
  }

  if (!env.TOTP_ENCRYPTION_KEY) {
    return jsonResponse(503, { error: "Two-factor authentication isn't available right now. Please try again later." });
  }

  const allowed = await checkRateLimit(env.DB, session.memberId, "firm_2fa_enroll", RATE_LIMIT_FIRM_2FA_ENROLL);
  if (!allowed) {
    return jsonResponse(429, { error: "Too many attempts. Please try again later." });
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return jsonResponse(400, { error: "Expected a JSON request body." });
  }
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return jsonResponse(400, { error: "Something went wrong processing that request." });
  }
  if (raw.length === 0 || raw.length > MAX_BODY_BYTES) {
    return jsonResponse(400, { error: "Request too large or empty." });
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return jsonResponse(400, { error: "Something went wrong processing that request." });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonResponse(400, { error: "Something went wrong processing that request." });
  }

  const secret = typeof body.secret === "string" ? body.secret.trim().toUpperCase() : "";
  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!secret || !code) {
    return jsonResponse(400, { error: "Enter the 6-digit code from your authenticator app." });
  }

  const firm = await store.getFirmById(env.DB, session.firmId);
  const member = await store.getFirmMemberById(env.DB, session.firmId, session.memberId);
  if (!firm || !member) {
    return jsonResponse(404, { error: "Not found." });
  }
  // Defense-in-depth: the SAME check handleFirm2faEnroll already makes,
  // repeated here rather than trusted from that earlier call -- a client
  // could otherwise hold a secret from before a firm became demo_locked
  // and confirm it after, same "don't trust an earlier gate alone" posture
  // as this file's own M1 fix for email_change/password purposes.
  if (firm.demo_locked) {
    return jsonResponse(400, { error: "Two-factor authentication isn't available for this shared demo account." });
  }
  if (member.totp_enrolled_at) {
    return jsonResponse(400, { error: "Two-factor authentication is already enabled on this account." });
  }

  const matchedCounter = await verifyTotp(secret, code);
  if (matchedCounter === null) {
    return jsonResponse(400, { error: "That code wasn't right. Please try again." });
  }

  const { ciphertextBase64, ivBase64 } = await encryptTotpSecret(secret, member.id, env.TOTP_ENCRYPTION_KEY);
  // AuditLab 2FA-1: seed the replay-prevention floor with the counter that
  // just confirmed enrollment, so that exact code cannot also be replayed
  // against /firm/2fa/verify for the rest of its validity window.
  await store.setFirmMemberTotpSecret(env.DB, member.id, ciphertextBase64, ivBase64, matchedCounter);
  const backupCodes = generateBackupCodes();
  await store.createFirmMemberBackupCodes(env.DB, member.id, await Promise.all(backupCodes.map(hashBackupCode)));

  // Best-effort security notice, same guarded/capped/never-fails-the-request
  // pattern as handleFirmPasswordSet's own send above.
  if (env.SENDGRID_API_KEY) {
    try {
      const underCap = await checkAndCountActionSend(env.DB, dailySendCap(env));
      if (underCap) {
        const built = buildFirmTwoFactorChangedEmail(firm.name, true, new Date().toISOString(), member.name);
        await sendViaSendGrid(env.SENDGRID_API_KEY, member.email, built, env.EMAIL_ALLOWLIST);
      }
    } catch {
      // Intentionally swallowed -- see above.
    }
  }

  return jsonResponse(200, { ok: true, backup_codes: backupCodes });
}

/**
 * POST /firm/2fa/disable -- roadmap #53. Body: code (a current TOTP code or
 * an unused backup code). Requires fresh proof of the SECOND factor being
 * removed, not just the session cookie or the account password -- the
 * standard step-up bar mainstream providers use for turning 2FA off, and
 * the one that actually matches the threat this feature defends against: a
 * stolen session cookie proves nothing about knowing the password OR
 * holding the authenticator, so a password-only check would not catch
 * exactly the attacker this route needs to stop.
 */
async function handleFirm2faDisable(request: Request, env: Env): Promise<Response> {
  const session = await requireFirmSession(request, env);
  if (session instanceof Response) return session;

  if (!originAllowed(request, env)) {
    return jsonResponse(400, { error: "That request couldn't be completed. Please try again from the DeadlineRadar site." });
  }

  const allowed = await checkRateLimit(env.DB, session.memberId, "firm_2fa_disable", RATE_LIMIT_FIRM_2FA_DISABLE);
  if (!allowed) {
    return jsonResponse(429, { error: "Too many attempts. Please try again later." });
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return jsonResponse(400, { error: "Expected a JSON request body." });
  }
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return jsonResponse(400, { error: "Something went wrong processing that request." });
  }
  if (raw.length === 0 || raw.length > MAX_BODY_BYTES) {
    return jsonResponse(400, { error: "Request too large or empty." });
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return jsonResponse(400, { error: "Something went wrong processing that request." });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonResponse(400, { error: "Something went wrong processing that request." });
  }

  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!code) {
    return jsonResponse(400, { error: "Enter a current code from your authenticator app, or a backup code." });
  }

  const firm = await store.getFirmById(env.DB, session.firmId);
  const member = await store.getFirmMemberById(env.DB, session.firmId, session.memberId);
  if (!firm || !member || !member.totp_secret_encrypted || !member.totp_secret_iv) {
    return jsonResponse(400, { error: "Two-factor authentication isn't enabled on this account." });
  }
  // Unreachable in practice today (a demo_locked firm can never enroll --
  // see handleFirm2faEnroll's own gate), kept explicit anyway rather than
  // relying on that invariant holding forever across future changes.
  if (firm.demo_locked) {
    return jsonResponse(400, { error: "Two-factor authentication isn't available for this shared demo account." });
  }
  if (!env.TOTP_ENCRYPTION_KEY) {
    return jsonResponse(503, { error: "Two-factor authentication isn't available right now. Please try again later." });
  }

  let verified = false;
  if (/^\d{6}$/.test(code)) {
    const secret = await decryptTotpSecret(member.totp_secret_encrypted, member.totp_secret_iv, member.id, env.TOTP_ENCRYPTION_KEY);
    if (secret) {
      const matchedCounter = await verifyTotp(secret, code);
      // AuditLab 2FA-1: same replay floor as the login-gate verify path --
      // clearFirmMemberTotpSecret() below makes this moot for a SUBSEQUENT
      // disable attempt (nothing left to decrypt against), but a
      // concurrent duplicate request racing this exact call is still worth
      // closing, and consistency with the other two verify sites means
      // there is only one rule to reason about, not an exception here.
      if (matchedCounter !== null && (member.totp_last_used_timestep === null || matchedCounter > member.totp_last_used_timestep)) {
        verified = true;
      }
    }
  } else {
    const codeHash = await hashBackupCode(code);
    verified = await store.consumeFirmMemberBackupCode(env.DB, member.id, codeHash);
  }
  if (!verified) {
    return jsonResponse(400, { error: "That code wasn't right." });
  }

  await store.clearFirmMemberTotpSecret(env.DB, member.id);
  await store.deleteFirmMemberBackupCodes(env.DB, member.id);

  if (env.SENDGRID_API_KEY) {
    try {
      const underCap = await checkAndCountActionSend(env.DB, dailySendCap(env));
      if (underCap) {
        const built = buildFirmTwoFactorChangedEmail(firm.name, false, new Date().toISOString(), member.name);
        await sendViaSendGrid(env.SENDGRID_API_KEY, member.email, built, env.EMAIL_ALLOWLIST);
      }
    } catch {
      // Intentionally swallowed -- see above.
    }
  }

  return jsonResponse(200, { ok: true });
}

/**
 * POST /firm/sign-out-other-devices -- Task #18 (2026-08-05). Self-serve
 * version of the same store.deleteOtherSessionsForFirm() sweep a password
 * change already triggers (see handleFirmPasswordSet's own comment) --
 * lets an admin end every OTHER session (e.g. a shared/public computer they
 * forgot to sign out of) WITHOUT having to change their password to do it.
 * The caller's own session survives, same as the password-change sweep.
 *
 * Session-gated only, not entitlement-gated -- ending stray sessions is a
 * security action, not a paid feature, so a lapsed-pilot firm can still use
 * it (matches handleFirmPasswordSet's own gate for the same reason).
 *
 * Rate-limited per SESSION, not per firm (2026-08-05, adversarial review
 * finding). A per-firm key would let a single stolen session burn the
 * firm's whole hourly budget across every IP, 429-ing the real owner's own
 * fresh session out of the exact remedy this route exists to offer them --
 * the attacker's stolen session would still be sitting there, un-ended,
 * while its victim gets "too many attempts." Per-session means every NEW
 * session (i.e. the owner signing back in) always starts with a clean
 * budget, regardless of what an old, possibly-stolen session already spent.
 */
async function handleFirmSignOutOtherDevices(request: Request, env: Env): Promise<Response> {
  const session = await requireFirmSession(request, env);
  if (session instanceof Response) return session;

  // CSRF defense-in-depth (2026-08-05) -- see handleFirmLicenseCreate's own comment.
  if (!originAllowed(request, env)) {
    return jsonResponse(400, { error: "That request couldn't be completed. Please try again from the DeadlineRadar site." });
  }

  const allowed = await checkRateLimit(env.DB, session.sessionId, "firm_signout_other", RATE_LIMIT_FIRM_SIGNOUT_OTHER);
  if (!allowed) {
    return jsonResponse(429, { error: "Too many attempts. Please try again later." });
  }

  // migration 0045: this member's own other sessions only -- see
  // deleteOtherSessionsForMember()'s own docstring for why the firm-wide
  // version would wrongly sign out teammates who did nothing.
  const endedSessions = await store.deleteOtherSessionsForMember(env.DB, session.memberId, session.sessionId);

  if (endedSessions > 0) {
    // Same reasoning as handleFirmPasswordSet's own token sweep: an
    // outstanding emailed link is a live bearer credential too, so ending
    // every session but leaving a still-redeemable link would only close
    // part of the door.
    await store.invalidateOutstandingLoginTokensForMember(env.DB, session.memberId);

    const firm = await store.getFirmById(env.DB, session.firmId);
    const member = await store.getFirmMemberById(env.DB, session.firmId, session.memberId);
    // Best-effort and never allowed to fail the request -- see
    // handleFirmPasswordSet's own comment on the identical pattern. This is
    // the DETECTION control: if the click that triggered this came from a
    // stolen session rather than the real member, this email is the only
    // signal they ever get. Sent to the MEMBER whose own sessions were
    // ended, not the firm's primary contact.
    if (firm && member && env.SENDGRID_API_KEY) {
      try {
        const underCap = await checkAndCountActionSend(env.DB, dailySendCap(env));
        if (underCap) {
          const built = buildFirmSessionsEndedEmail(firm.name, new Date().toISOString(), endedSessions, member.name);
          await sendViaSendGrid(env.SENDGRID_API_KEY, member.email, built, env.EMAIL_ALLOWLIST);
        }
      } catch {
        // Intentionally swallowed -- see above.
      }
    }
  }

  return jsonResponse(200, { ok: true, other_sessions_ended: endedSessions });
}

/**
 * POST /firm/change-email -- Task #29 (2026-08-05). Requests a change to the
 * firm's sign-in email. Deliberately does NOT change anything itself --
 * same "confirm-before-it-takes-effect" pattern as password reset, but
 * stronger here: an unverified instant swap would let a stolen session
 * silently hand the account to an address the attacker controls, with no
 * proof the requester can actually receive mail there at all. Two emails
 * go out: a confirm link to the NEW address (the proof-of-control step;
 * nothing changes until that link is clicked), and a notice to the CURRENT
 * address (the detection control -- see buildFirmEmailChangeRequestedNoticeEmail's
 * own comment for why it can't wait until confirmation).
 *
 * Session-gated only, not entitlement-gated -- same reasoning as password
 * set and sign-out-other-devices: this is account security, not a paid
 * feature.
 */
async function handleFirmChangeEmailRequest(request: Request, env: Env): Promise<Response> {
  const session = await requireFirmSession(request, env);
  if (session instanceof Response) return session;

  // CSRF defense-in-depth (2026-08-05) -- see handleFirmLicenseCreate's own comment.
  if (!originAllowed(request, env)) {
    return jsonResponse(400, { error: "That request couldn't be completed. Please try again from the DeadlineRadar site." });
  }

  const allowed = await checkRateLimit(env.DB, session.firmId, "firm_change_email", RATE_LIMIT_FIRM_CHANGE_EMAIL);
  if (!allowed) {
    return jsonResponse(429, { error: "Too many attempts. Please try again later." });
  }

  // CSRF defense-in-depth -- see readFirmLicenseJsonBody()'s own comment.
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return jsonResponse(400, { error: "Expected a JSON request body." });
  }
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return jsonResponse(400, { error: "Something went wrong processing that request." });
  }
  if (raw.length === 0 || raw.length > MAX_BODY_BYTES) {
    return jsonResponse(400, { error: "Request too large or empty." });
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return jsonResponse(400, { error: "Something went wrong processing that request." });
  }
  const newEmailRaw = typeof body.new_email === "string" ? body.new_email.trim() : "";
  if (!isValidEmail(newEmailRaw)) {
    return jsonResponse(400, { error: "That doesn't look like a valid email address." });
  }
  // AuditLab BLOCKLIST-1 (MEDIUM, 2026-08-06): the operator blocklist was
  // enforced on all three SIGNUP paths but not here -- an existing firm
  // could self-serve rotate its account onto an explicitly-blocked
  // address/domain. The control was deliberately designed with no
  // existing-account exemption (see store.isEmailBlocklisted's own
  // comment), so this route skipping it contradicted its own design.
  if (await store.isEmailBlocklisted(env.DB, newEmailRaw)) {
    return jsonResponse(400, { error: "We're not able to use that address right now." });
  }
  const currentPassword = typeof body.current_password === "string" ? body.current_password : "";

  const firm = await store.getFirmById(env.DB, session.firmId);
  if (!firm) return jsonResponse(404, { error: "Not found." });
  // migration 0045: this route now changes the SIGNED-IN MEMBER's own
  // login email, not the firm's admin_email directly (though the mirror
  // update still applies if they happen to be the primary contact -- see
  // handleFirmLoginVerify()'s own comment on that mirroring).
  const member = await store.getFirmMemberById(env.DB, session.firmId, session.memberId);
  if (!member) return jsonResponse(404, { error: "Not found." });

  // Task #27 follow-up (2026-08-06, reported live): this route, the billing
  // cancellation toggle, and account deletion were the three Account-tab
  // mutations demo_locked never actually covered -- handleFirmPasswordSet
  // and SSO-linking already refuse a demo_locked firm (see their own
  // comments), but a visitor to the now-public demo could still repoint the
  // shared account's own sign-in email, cancel the plan the demo exists to
  // showcase, or delete the account outright. Same message shape as the
  // password-set refusal.
  if (firm.demo_locked) {
    return jsonResponse(403, {
      error: "This is a shared demo account. Email changes aren't available for this account.",
    });
  }

  // AuditLab EMAILCHG-1 (2026-08-05, MEDIUM): a session cookie alone used to
  // be enough to REQUEST an email change, unlike handleFirmPasswordSet's own
  // step-up check for the exact same class of risk (a credential change).
  // The admin_email is the account's recovery channel -- every password-
  // reset and magic-link sign-in resolves through it -- so a session
  // compromise that a password change would correctly still require the
  // OLD password to fix becomes PERMANENT if routed through email-change
  // first: once confirmed, the attacker's address IS the account's login
  // identity, independent of whether the stolen session cookie is ever
  // revoked. Mirrors handleFirmPasswordSet's exact gate: skipped only when
  // the firm has no password yet (a magic-link-only firm must still be able
  // to use this feature) or the session itself is passwordResetAuthorized
  // (already proved control of the current inbox via a fresh reset link).
  if (member.password_hash && !session.passwordResetAuthorized) {
    const currentOk = await verifyPassword(
      currentPassword,
      {
        algo: member.password_algo ?? undefined,
        salt: member.password_salt ?? undefined,
        iterations: member.password_iterations ?? undefined,
        rounds: member.password_rounds ?? undefined,
        hash: member.password_hash,
      },
      env.PASSWORD_PEPPER
    );
    if (!currentOk) {
      return jsonResponse(400, { error: "That current password isn't right." });
    }
  }

  // Same LOWER(TRIM()) normalization findFirmMemberByEmail()/the migration
  // 0045 unique index use, so this comparison agrees with what the actual
  // constraint will enforce at redemption time.
  if (newEmailRaw.trim().toLowerCase() === member.email.trim().toLowerCase()) {
    return jsonResponse(400, { error: "That's already your email address." });
  }
  // Adversarial-review L2 (2026-08-05): this IS an account-existence oracle
  // for an arbitrary address, the same shape handleFirmSignup()/handleFirmLogin()
  // deliberately avoid pre-auth. Kept anyway, deliberately: unlike those,
  // the caller here is ALREADY an authenticated firm admin (requireFirmSession()
  // above), not an anonymous visitor -- and a silent failure at redemption
  // time (the alternative) would be strictly worse UX for zero real
  // anti-enumeration benefit, since redemption's own "conflict" outcome
  // (updateFirmAdminEmail()) already confirms the same fact one click
  // later regardless. migration 0045: findFirmMemberByEmail(), checking
  // against every member across every firm, not just each firm's primary.
  const conflicting = await store.findFirmMemberByEmail(env.DB, newEmailRaw);
  if (conflicting) {
    return jsonResponse(400, { error: "That email address is already in use." });
  }

  // Only the LATEST requested address should ever be confirmable -- see
  // invalidateOutstandingEmailChangeTokensForMember()'s own comment. Scoped
  // to THIS member -- a teammate's own outstanding email-change request
  // must not be silently invalidated by someone else's request.
  await store.invalidateOutstandingEmailChangeTokensForMember(env.DB, member.id);
  const { rawToken } = await store.createLoginToken(env.DB, session.firmId, "email_change", newEmailRaw, member.id);

  if (env.SENDGRID_API_KEY) {
    try {
      // Adversarial-review M3 (2026-08-05): the detection notice to the OLD
      // address goes FIRST now, not second. Both sends draw from the same
      // shared daily cap, so at exactly one send of remaining budget the
      // ORIGINAL ordering let the confirm email through and silently
      // dropped the notice -- the change would proceed with zero warning
      // to the real admin if this was a stolen-session request. Sending
      // the notice first means a starved budget instead drops the confirm
      // email, which just delays the (harmless, reversible) change rather
      // than suppressing the (time-sensitive) warning.
      const noticeUnderCap = await checkAndCountActionSend(env.DB, dailySendCap(env));
      if (noticeUnderCap) {
        // migration 0045: notice goes to the MEMBER's own current (OLD)
        // address -- the person actually being warned, not necessarily
        // the firm's primary contact.
        const noticeEmail = buildFirmEmailChangeRequestedNoticeEmail(
          firm.name,
          newEmailRaw,
          new Date().toISOString(),
          member.name
        );
        await sendViaSendGrid(env.SENDGRID_API_KEY, member.email, noticeEmail, env.EMAIL_ALLOWLIST);
      }
      // Independent send, independent cap check -- this is a SECOND real
      // email (to a different address, for a different purpose), not a
      // retry of the first.
      const confirmUnderCap = await checkAndCountActionSend(env.DB, dailySendCap(env));
      if (confirmUnderCap) {
        const confirmUrl = `${actionBaseUrl(env)}/firm/login/verify?token=${encodeURIComponent(rawToken)}`;
        const confirmEmail = buildFirmEmailChangeConfirmEmail(confirmUrl, member.name);
        await sendViaSendGrid(env.SENDGRID_API_KEY, newEmailRaw, confirmEmail, env.EMAIL_ALLOWLIST);
      }
    } catch {
      // Intentionally swallowed -- same posture as every other best-effort
      // send in this file. The token already exists in the DB either way;
      // a mail outage must not turn into a confusing error for the request
      // itself, and there is nothing sensitive to protect by failing loud.
    }
  }

  return jsonResponse(200, { ok: true });
}

/**
 * GET /firm/auth/:provider/start -- opens an SSO handshake and redirects.
 *
 * 404s for an unknown or unconfigured provider, so a provider that has no
 * secrets set is genuinely absent rather than a button that errors.
 */
async function handleOauthStart(env: Env, ip: string, providerId: string): Promise<Response> {
  const provider = getConfiguredProvider(env, providerId);
  if (!provider) return errorPage(404, "Not found.");

  const allowed = await checkRateLimit(env.DB, ip, "oauth_start", RATE_LIMIT_OAUTH_START);
  if (!allowed) return errorPage(429, "Too many requests. Please try again later.");

  // Opportunistic cleanup of handshakes nobody ever completed, so the
  // table can't grow without bound from abandoned sign-ins.
  try {
    await store.deleteExpiredOauthStates(env.DB);
  } catch {
    // Housekeeping must never block a sign-in.
  }

  const { rawState, codeVerifier, nonce, rawBrowserBinding } = await store.createOauthState(env.DB, provider.id);
  const redirectUri = buildRedirectUri(actionBaseUrl(env), provider.id);
  const authorizeUrl = await buildAuthorizeUrl({ provider, redirectUri, state: rawState, nonce, codeVerifier });

  return new Response(null, {
    status: 302,
    headers: {
      Location: authorizeUrl,
      // The authorize URL carries a live single-use state; keep it out of
      // any shared cache.
      "Cache-Control": "no-store",
      // Proves same-browser at the callback. `state` alone cannot: an
      // attacker can mint a valid one by calling /start themselves.
      "Set-Cookie": oauthHandshakeSetCookieHeader(rawBrowserBinding),
    },
  });
}

/**
 * GET /firm/auth/:provider/callback -- completes the handshake.
 *
 * Order matters here. `state` is consumed BEFORE the code is exchanged, so
 * a replayed callback URL is rejected without ever spending a network call
 * on the provider, and so a captured URL cannot mint a second session.
 */
async function handleOauthCallback(request: Request, env: Env, ip: string, providerId: string): Promise<Response> {
  const provider = getConfiguredProvider(env, providerId);
  if (!provider) return errorPage(404, "Not found.");

  // Review finding 4c: this was the only unauthenticated auth route with no
  // rate limit. Every request costs a SHA-256 plus a D1 SELECT, and one
  // carrying valid state costs an outbound fetch to the provider -- so it
  // was both a cheap amplification target and a way to burn the provider
  // token-endpoint quota.
  const allowed = await checkRateLimit(env.DB, ip, "oauth_callback", RATE_LIMIT_OAUTH_START);
  if (!allowed) return errorPage(429, "Too many requests. Please try again later.", ssoSigninLink(env));

  const url = new URL(request.url);

  // The user declined consent, or the provider rejected the request. Not
  // an error to surface verbatim -- provider error text echoes request
  // parameters back and would leak configuration into the browser.
  if (url.searchParams.get("error")) {
    return errorPage(400, SSO_FAILED_MESSAGE, ssoSigninLink(env));
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return errorPage(400, SSO_FAILED_MESSAGE, ssoSigninLink(env));

  const browserBinding = getCookie(request, OAUTH_HANDSHAKE_COOKIE_NAME);
  const consumed = await store.consumeOauthState(env.DB, state, browserBinding);
  if (!consumed) return errorPage(400, SSO_FAILED_MESSAGE, ssoSigninLink(env));

  // A handshake opened for one provider must not be redeemable at
  // another's callback.
  if (consumed.provider !== provider.id) return errorPage(400, SSO_FAILED_MESSAGE, ssoSigninLink(env));

  const redirectUri = buildRedirectUri(actionBaseUrl(env), provider.id);
  const tokens = await exchangeCodeForTokens({
    provider,
    code,
    redirectUri,
    codeVerifier: consumed.codeVerifier,
  });
  if (!tokens || !tokens.id_token) return errorPage(400, SSO_FAILED_MESSAGE, ssoSigninLink(env));

  const claims = parseAndValidateIdToken({
    idToken: tokens.id_token,
    provider,
    expectedNonce: consumed.nonce,
  });
  if (!claims) return errorPage(400, SSO_FAILED_MESSAGE, ssoSigninLink(env));

  // Already-linked identity: the stable subject resolves the firm
  // directly, and no email is consulted at all.
  const existingIdentity = await store.findOauthIdentity(env.DB, provider.id, claims.sub);
  if (existingIdentity) {
    // SSO must respect suspension too -- previously only checked on the
    // password/magic-link paths (AuditLab F-1, 2026-08-02). A linked
    // provider account is exactly the kind of access a suspension needs to
    // actually revoke.
    const linkedFirm = await store.getFirmById(env.DB, existingIdentity.firm_id);
    if (!linkedFirm || linkedFirm.status !== "active") {
      return errorPage(403, "This account isn't active. Get in touch and we'll sort it out.", ssoContactLink(env));
    }
    // AuditLab SSO-A, 2026-08-03: `sub` alone is a PERMANENT credential --
    // resolving straight to the firm without ever re-checking email meant a
    // Google account that once matched admin_email kept working forever,
    // even after the firm reassigned that address to someone else (a
    // departing employee's linked account, or a deliberate admin change).
    // Re-validate against the firm's CURRENT admin_email on every login,
    // the same way the first-link path validates it once. This does not
    // touch the DB row -- a legitimate admin_email change is expected to
    // require reconnecting SSO, not to silently keep the old link alive.
    if (
      !claims.email ||
      !claims.emailVerified ||
      store.normalizeEmail(claims.email) !== store.normalizeEmail(linkedFirm.admin_email)
    ) {
      return errorPage(403, SSO_EMAIL_REASSIGNED_MESSAGE, ssoSigninLink(env));
    }
    await store.touchOauthIdentityLogin(env.DB, existingIdentity.id, existingIdentity.firm_id, claims.email);
    const { rawSessionToken } = await store.createSession(env.DB, existingIdentity.firm_id);
    return oauthSuccessResponse(env, rawSessionToken);
  }

  // First time this provider account has been seen. Linking it to an
  // existing firm requires a VERIFIED email: an unverified address proves
  // nothing, and honouring it would let anyone who can create an account
  // at a provider with an arbitrary unverified email claim a firm.
  if (!claims.email || !claims.emailVerified) {
    return errorPage(400, SSO_UNVERIFIED_EMAIL_MESSAGE, ssoSigninLink(env));
  }

  // migration 0045: findFirmMemberByEmail(), not findFirmByAdminEmail() --
  // "does an account already exist for this verified email" must find a
  // non-primary member's own address too, not just the firm's primary
  // contact, so the "no account" error below is accurate for them as well.
  // KNOWN SCOPE LIMIT (not fixed in this pass): the OAuth link itself
  // (firm_oauth_identities) still has no member_id column. AuditLab ROLE-1
  // (2026-08-07): that gap meant a non-primary member's Google account
  // would silently mint a session resolved to the firm's PRIMARY member via
  // createSession()'s own default -- a real privilege-escalation path once
  // role-gating went live. Closed below by refusing SSO outright for anyone
  // who isn't the primary member, until true per-member linking exists
  // (still a real follow-up, not silently forgotten).
  const memberForEmail = await store.findFirmMemberByEmail(env.DB, claims.email);
  if (!memberForEmail) {
    // Deliberately NOT auto-creating a firm here. Signup runs a domain
    // gate (checkSignupDomainGate: disposable domains and competitor
    // domains are refused a trial), and minting an account through the
    // SSO callback would route straight around it. SSO connects to an
    // account that already exists; it is not a second signup door.
    return errorPage(400, SSO_NO_ACCOUNT_MESSAGE, ssoSigninLink(env));
  }
  const firm = await store.getFirmById(env.DB, memberForEmail.firm_id);
  if (!firm) {
    return errorPage(400, SSO_NO_ACCOUNT_MESSAGE, ssoSigninLink(env));
  }
  // AuditLab F-1, 2026-08-02: a suspended firm must not be able to LINK a
  // new provider identity to itself, any more than it can log in any other
  // way. `firm` here is fresh (fetched moments ago in this same request),
  // so it covers both branches below (new link, and the concurrent-link
  // race, which re-validates against this same firm.id).
  if (firm.status !== "active") {
    return errorPage(403, "This account isn't active. Get in touch and we'll sort it out.", ssoContactLink(env));
  }
  // Task #27 (2026-08-06, Devin's call): a linked Google identity would let
  // whoever linked it keep signing in without ever needing the shared
  // password again -- silently undoing a password rotation meant to lock
  // out everyone who had the old one. Blocked outright, not worked around.
  if (firm.demo_locked) {
    return errorPage(400, "Sign-in for this shared demo account works with the demo password only.", ssoContactLink(env));
  }

  // AuditLab ROLE-1, 2026-08-07: see SSO_NON_PRIMARY_MEMBER_MESSAGE's own
  // comment. Must fail closed before the identity is ever linked -- the
  // whole point is that a non-primary member's Google account should never
  // get as far as minting a firm session at all.
  if (memberForEmail.id !== firm.primary_member_id) {
    return errorPage(403, SSO_NON_PRIMARY_MEMBER_MESSAGE, ssoSigninLink(env));
  }

  const linked = await store.linkOauthIdentity(env.DB, {
    firmId: firm.id,
    provider: provider.id,
    providerSubject: claims.sub,
    providerEmail: claims.email,
  });
  if (!linked) {
    // The UNIQUE(provider, subject) constraint fired between our lookup
    // and this insert -- i.e. a concurrent callback linked it first. Fall
    // through by re-reading rather than treating it as an error.
    const raced = await store.findOauthIdentity(env.DB, provider.id, claims.sub);
    if (!raced) return errorPage(400, SSO_FAILED_MESSAGE, ssoSigninLink(env));
    // Fail closed if the concurrent winner bound this subject to a
    // DIFFERENT firm than the one we just validated -- reachable only if
    // the provider account's email changed mid-flight, but seating a
    // session on an unvalidated firm is not a thing to reason about at
    // 3am. Review finding 4f.
    if (raced.firm_id !== firm.id) return errorPage(400, SSO_FAILED_MESSAGE, ssoSigninLink(env));
    const { rawSessionToken } = await store.createSession(env.DB, raced.firm_id);
    return oauthSuccessResponse(env, rawSessionToken);
  }

  // AuditLab SSO-B, 2026-08-03: linking is a durable credential grant
  // (SSO-A) with no detection control, unlike a password change which
  // already emails the owner. Same best-effort/never-fail-the-request
  // pattern as buildFirmPasswordChangedEmail's send above -- a mail outage
  // must not block a legitimate sign-in.
  if (env.SENDGRID_API_KEY) {
    try {
      const underCap = await checkAndCountActionSend(env.DB, dailySendCap(env));
      if (underCap) {
        const built = buildFirmOauthLinkedEmail(firm.name, provider.displayName, claims.email, new Date().toISOString(), firm.admin_name);
        await sendViaSendGrid(env.SENDGRID_API_KEY, firm.admin_email, built, env.EMAIL_ALLOWLIST);
      }
    } catch {
      // Intentionally swallowed -- see above.
    }
  }

  const { rawSessionToken } = await store.createSession(env.DB, firm.id);
  return oauthSuccessResponse(env, rawSessionToken);
}


/**
 * GET /firm/oauth-identities -- what is currently linked to this firm.
 *
 * Existed as a store function with no route until security review pointed
 * out the consequence: a linked provider account could mint sessions
 * forever, and nobody could even SEE it, let alone remove it. Anyone who
 * controlled the admin mailbox for one window -- a departing office
 * manager, a briefly-compromised inbox -- had a permanent way in that
 * survived password rotation and session termination.
 */
async function handleOauthIdentitiesList(request: Request, env: Env): Promise<Response> {
  const session = await requireFirmSession(request, env);
  if (session instanceof Response) return session;
  const rows = await store.listOauthIdentitiesForFirm(env.DB, session.firmId);
  return jsonResponse(200, {
    identities: rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      provider_email: r.provider_email,
      created_at: r.created_at,
      last_login_at: r.last_login_at,
    })),
  });
}

/**
 * DELETE /firm/oauth-identities/:id -- unlink a provider account.
 *
 * Unconditionally safe: the emailed sign-in link always works for the
 * firm's admin address, so this cannot lock anyone out even if it removes
 * the only linked provider and no password is set.
 *
 * store.unlinkOauthIdentity() binds firm_id in its own WHERE clause, so a
 * session for firm A cannot unlink firm B's identity; a miss returns the
 * same generic 404 as a nonexistent id, matching this file's
 * no-oracle convention.
 *
 * AuditLab ROLE-2 (MEDIUM, 2026-08-07): Partner-only, not just any signed-
 * in role. firm_oauth_identities is firm-scoped, not member-scoped, and
 * ROLE-1's own fix means the only identity that can ever exist here
 * belongs to the firm's PRIMARY member -- before this fix, a Staff or
 * Office Manager session could delete the Partner's own linked sign-in
 * method. Not a lockout (password/magic-link always remain), but it's one
 * member mutating another member's auth configuration, exactly the class
 * of boundary requireFirmRole() exists to close everywhere else.
 */
async function handleOauthIdentityDelete(request: Request, env: Env, id: string): Promise<Response> {
  const session = await requireFirmRole(request, env, "partner");
  if (session instanceof Response) return session;

  // CSRF defense-in-depth (2026-08-05) -- see handleFirmLicenseCreate's own
  // comment. AuditLab CSRF-1 (2026-08-05): missed in the original rollout --
  // its sibling on the same DELETE branch (handleMobilityCompletionDelete)
  // got this check, this one didn't. Unlinking a firm's SSO identity is a
  // real state change with account-access consequences.
  if (!originAllowed(request, env)) {
    return jsonResponse(400, { error: "That request couldn't be completed. Please try again from the DeadlineRadar site." });
  }

  // Per-FIRM daily cap -- AuditLab S-3, 2026-08-03. Same reasoning as
  // RATE_LIMIT_OAUTH_START's own comment (bounds table growth from a
  // compromised/careless session), applied to the unlink side.
  const allowed = await checkRateLimit(env.DB, session.firmId, "oauth_identity_delete", RATE_LIMIT_OAUTH_IDENTITY_DELETE);
  if (!allowed) {
    return jsonResponse(429, { error: "Too many changes. Please try again later." });
  }

  const removed = await store.unlinkOauthIdentity(env.DB, session.firmId, id);
  if (!removed) return jsonResponse(404, { error: "Not found." });
  return jsonResponse(200, { ok: true });
}

/**
 * GET /firm/sessions -- roadmap #52, self-service active-session view.
 * Same shape as handleOauthIdentitiesList just above. is_current lets the
 * frontend mark/skip the caller's own session without a second round trip.
 */
async function handleFirmSessionsList(request: Request, env: Env): Promise<Response> {
  const session = await requireFirmSession(request, env);
  if (session instanceof Response) return session;
  // migration 0045: this member's own sessions only -- see
  // listSessionsForMember()'s own docstring.
  const rows = await store.listSessionsForMember(env.DB, session.memberId);
  return jsonResponse(200, {
    sessions: rows.map((r) => ({
      id: r.id,
      created_at: r.created_at,
      last_seen_at: r.last_seen_at,
      is_current: r.id === session.sessionId,
    })),
  });
}

/**
 * DELETE /firm/sessions/:id -- revoke one specific OTHER session. The
 * caller's own current session is deliberately excluded (400, not a
 * silent no-op) -- ending your own session mid-request is what the
 * existing Log out button already does explicitly; this route is only
 * for the "some other tab/device I don't recognize" case sign-out-other-
 * devices previously made all-or-nothing.
 */
async function handleFirmSessionRevoke(request: Request, env: Env, id: string): Promise<Response> {
  const session = await requireFirmSession(request, env);
  if (session instanceof Response) return session;

  if (!originAllowed(request, env)) {
    return jsonResponse(400, { error: "That request couldn't be completed. Please try again from the DeadlineRadar site." });
  }

  if (id === session.sessionId) {
    return jsonResponse(400, { error: "Use Log out to end your own current session." });
  }

  const allowed = await checkRateLimit(env.DB, session.firmId, "firm_session_revoke", RATE_LIMIT_FIRM_SESSION_REVOKE);
  if (!allowed) {
    return jsonResponse(429, { error: "Too many attempts. Please try again later." });
  }

  // migration 0045: this member's own sessions only.
  const removed = await store.deleteSessionByIdForMember(env.DB, session.memberId, id);
  if (!removed) return jsonResponse(404, { error: "Not found." });
  return jsonResponse(200, { ok: true });
}


/**
 * POST /firm/mobility/check -- run a determination.
 *
 * Body: { home_state_slug, target_state_slug, service_type,
 *         license_in_good_standing, substantially_equivalent }
 *
 * The two booleans are the practitioner's own attestations. We cannot
 * verify either, and the response wording never implies we did -- see
 * mobility.ts. They are inputs to the determination, not facts we assert.
 */
async function handleMobilityCheck(request: Request, env: Env, ip: string): Promise<Response> {
  // Keyed on the AUTHENTICATED FIRM, not the caller's IP. The stated threat
  // is "harvesting by a subscriber", which an IP key does not bound (rotate
  // IPs and it never binds) while it DOES punish a whole firm behind one
  // office NAT. Matches RATE_LIMIT_FIRM_LICENSE_CREATE's convention for
  // authenticated routes. Also moved after the entitlement check so an
  // unentitled session cannot burn a paying firm's budget.
  //
  // Entitlement BEFORE any work: a non-paying firm must not receive a
  // determination under any circumstances.
  const session = await requireFirmSessionAndPaidTier(request, env);
  if (session instanceof Response) return session;

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return jsonResponse(400, { error: "Something went wrong processing that request." });
  }
  if (raw.length === 0 || raw.length > MAX_BODY_BYTES) {
    return jsonResponse(400, { error: "Request too large or empty." });
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return jsonResponse(400, { error: "Something went wrong processing that request." });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonResponse(400, { error: "Something went wrong processing that request." });
  }

  const homeStateSlug = typeof body.home_state_slug === "string" ? body.home_state_slug : "";
  const targetStateSlug = typeof body.target_state_slug === "string" ? body.target_state_slug : "";
  const serviceTypeRaw = typeof body.service_type === "string" ? body.service_type : "";

  // AuditLab MAP-1 (2026-08-07): rate limit is AFTER the entitlement gate
  // (review finding: an unentitled session must not burn a paying firm's
  // budget on 403s) but scope-decided BEFORE the bucket is chosen -- a
  // query for a home state the firm actually has staff in is the firm
  // reviewing its own roster, structurally bounded by the seat cap, and
  // gets the high unmetered ceiling; a query for a state nobody on the
  // roster is in is the harvesting shape and gets the tighter, existing
  // bucket. See getFirmRosterStateSlugs()'s own docstring for why this
  // uses listFirmLicenses()'s exact "on the roster" definition.
  const rosterStates = await store.getFirmRosterStateSlugs(env.DB, session.firmId);
  const isOwnRoster = rosterStates.has(homeStateSlug);
  const allowed = isOwnRoster
    ? await checkRateLimit(env.DB, session.firmId, "mobility_check_unmetered", RATE_LIMIT_MOBILITY_CHECK_UNMETERED)
    : await checkRateLimit(env.DB, session.firmId, "mobility_check", RATE_LIMIT_MOBILITY_CHECK);
  if (!allowed) {
    return jsonResponse(429, { error: "Too many requests. Please try again later." });
  }

  // Slugs are validated against the real jurisdiction list, not merely
  // sanitised -- an unknown slug must be a 400, never a silent lookup miss
  // that renders as "not verified" and looks like a data gap.
  if (!stateNameForSlug(homeStateSlug) || !stateNameForSlug(targetStateSlug)) {
    return jsonResponse(400, { error: "Please choose both a home state and a target state." });
  }
  if (!isValidServiceType(serviceTypeRaw)) {
    return jsonResponse(400, { error: "Please choose a service type." });
  }

  const result = evaluateMobility(
    {
      homeStateSlug,
      targetStateSlug,
      serviceType: serviceTypeRaw,
      licenseInGoodStanding: body.license_in_good_standing === true,
      substantiallyEquivalent: body.substantially_equivalent === true,
    },
    MOBILITY_RULES_BY_SLUG[targetStateSlug] ?? null
  );

  return jsonResponse(200, {
    home_state: stateNameForSlug(homeStateSlug),
    target_state: stateNameForSlug(targetStateSlug),
    service_type: serviceTypeRaw,
    overall: result.overall,
    individual: result.individual,
    firm: result.firm,
    disclaimer: MOBILITY_DISCLAIMER,
  });
}

/**
 * POST /firm/mobility/check-batch (2026-08-03, dashboard Map redesign) --
 * one person against EVERY covered target state in a single call, for the
 * Map tab's per-staff reciprocity view. Reuses evaluateMobility() exactly
 * as handleMobilityCheck() does -- this is a thin fan-out wrapper, never a
 * second implementation of the determination logic itself. Duplicating
 * that logic (even faithfully) in client JS was considered and rejected:
 * mobility.ts's own docstring is explicit that a wrong answer here is real
 * legal exposure, and two copies of a legally load-bearing rule engine is
 * exactly the kind of drift risk this codebase avoids elsewhere (see
 * _mobility_covered_slugs()'s own comment on the same principle).
 *
 * Same pay gate as the single check. `license_in_good_standing` and
 * `substantially_equivalent` are still self-attestations, not data this
 * endpoint reads from the roster -- the caller (the Map tab) is expected to
 * default them to true and disclose that assumption in the UI, since the
 * roster does not store per-person attestations. This endpoint does not
 * bake that default in itself, so a future caller with real per-person
 * attestation data is not stuck with this one's assumption.
 */
async function handleMobilityCheckBatch(request: Request, env: Env): Promise<Response> {
  const session = await requireFirmSessionAndPaidTier(request, env);
  if (session instanceof Response) return session;

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return jsonResponse(400, { error: "Something went wrong processing that request." });
  }
  if (raw.length === 0 || raw.length > MAX_BODY_BYTES) {
    return jsonResponse(400, { error: "Request too large or empty." });
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return jsonResponse(400, { error: "Something went wrong processing that request." });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonResponse(400, { error: "Something went wrong processing that request." });
  }

  const homeStateSlug = typeof body.home_state_slug === "string" ? body.home_state_slug : "";
  const serviceTypeRaw = typeof body.service_type === "string" ? body.service_type : "";

  // AuditLab MAP-1 (2026-08-07): same scope-based bucket choice as
  // handleMobilityCheck() above -- see that handler's own comment.
  const rosterStates = await store.getFirmRosterStateSlugs(env.DB, session.firmId);
  const isOwnRoster = rosterStates.has(homeStateSlug);
  const allowed = isOwnRoster
    ? await checkRateLimit(env.DB, session.firmId, "mobility_check_unmetered", RATE_LIMIT_MOBILITY_CHECK_UNMETERED)
    : await checkRateLimit(env.DB, session.firmId, "mobility_check_batch", RATE_LIMIT_MOBILITY_CHECK_BATCH);
  if (!allowed) {
    return jsonResponse(429, { error: "Too many mobility checks this hour. Please try again within the hour." });
  }

  if (!stateNameForSlug(homeStateSlug)) {
    return jsonResponse(400, { error: "Please choose a home state." });
  }
  if (!isValidServiceType(serviceTypeRaw)) {
    return jsonResponse(400, { error: "Please choose a service type." });
  }

  const input = {
    homeStateSlug,
    serviceType: serviceTypeRaw,
    licenseInGoodStanding: body.license_in_good_standing === true,
    substantiallyEquivalent: body.substantially_equivalent === true,
  };

  const results = Object.values(MOBILITY_RULES_BY_SLUG).map((rule) => {
    const result = evaluateMobility({ ...input, targetStateSlug: rule.state_slug }, rule);
    return {
      target_state_slug: rule.state_slug,
      target_state: rule.state,
      overall: result.overall,
      individual: result.individual,
      firm: result.firm,
      // 2026-08-04, practice-privilege completion tracking (migration
      // 0016): lets the client compare a stored completion's
      // rule_verified_date snapshot against the CURRENT rule to notice the
      // underlying law has changed since something was marked complete.
      // Not consumed by the Map UI yet -- shipping the field now so that
      // staleness reconciliation is a display-layer follow-up, not another
      // server round-trip to add later.
      rule_verified_date: rule.verified_date,
    };
  });

  return jsonResponse(200, {
    home_state: stateNameForSlug(homeStateSlug),
    service_type: serviceTypeRaw,
    results,
    disclaimer: MOBILITY_DISCLAIMER,
  });
}

function toMobilityCompletionJson(row: store.MobilityCompletionRow): Record<string, unknown> {
  return {
    id: row.id,
    subscriber_id: row.subscriber_id,
    target_state_slug: row.target_state_slug,
    service_type: row.service_type,
    rule_verified_date: row.rule_verified_date,
    completed_at: row.completed_at,
  };
}

/** GET /firm/mobility/completions -- every non-deleted completion across the
 * firm's whole roster. The Map/Practice-Privilege-Check UI cross-references
 * this against each LIVE verdict client-side, same "fetch the firm's rows
 * once, join client-side" pattern GET /firm/cpe already established. */
async function handleMobilityCompletionsList(request: Request, env: Env): Promise<Response> {
  const session = await requireFirmSession(request, env);
  if (session instanceof Response) return session;
  const rows = await store.listMobilityCompletionsForFirm(env.DB, session.firmId);
  return jsonResponse(200, { completions: rows.map(toMobilityCompletionJson) });
}

/**
 * POST /firm/mobility/completions -- body: `subscriber_id`,
 * `target_state_slug`, `service_type`. Records ONLY that this firm marked
 * the combination complete and against what rule version -- see migration
 * 0016's own comment for why this is a deliberately separate signal from
 * evaluateMobility()'s own verdict, never an override of it. No entitlement
 * gate: recording a completion isn't itself a mobility determination (that
 * already happened, live, via the gated /check or /check-batch endpoints
 * this button only ever appears next to), and gating it too would let a
 * firm's pay status silently desync its roster's own completion records
 * from what the UI shows.
 */
async function handleMobilityCompletionCreate(request: Request, env: Env): Promise<Response> {
  // migration 0045 (roadmap #11/#13/#14): Staff stays read-only.
  const session = await requireFirmRole(request, env, "partner", "office_manager");
  if (session instanceof Response) return session;

  // CSRF defense-in-depth (2026-08-05) -- see handleFirmLicenseCreate's own comment.
  if (!originAllowed(request, env)) {
    return jsonResponse(400, { error: "That request couldn't be completed. Please try again from the DeadlineRadar site." });
  }

  const allowed = await checkRateLimit(env.DB, session.firmId, "mobility_completion_create", RATE_LIMIT_MOBILITY_COMPLETION_CREATE);
  if (!allowed) {
    return jsonResponse(429, { error: "Too many requests. Please try again later." });
  }

  const parsed = await readFirmLicenseJsonBody(request); // generic despite the name -- see that function's own signature
  if (parsed instanceof Response) return parsed;
  const form = stringFieldsOf(parsed);

  for (const value of Object.values(form)) {
    if (hasControlChars(value)) {
      return jsonResponse(400, { error: "Invalid characters in submission." });
    }
  }

  const subscriberId = (form.subscriber_id ?? "").trim();
  if (!subscriberId) {
    return jsonResponse(400, { error: "Missing subscriber_id." });
  }

  const targetStateSlug = (form.target_state_slug ?? "").trim();
  if (!stateNameForSlug(targetStateSlug)) {
    return jsonResponse(400, { error: "Please choose a target state." });
  }

  const serviceTypeRaw = (form.service_type ?? "").trim();
  if (!isValidServiceType(serviceTypeRaw)) {
    return jsonResponse(400, { error: "Please choose a service type." });
  }

  const rule = MOBILITY_RULES_BY_SLUG[targetStateSlug] ?? null;
  const created = await store.addMobilityCompletion(env.DB, {
    firmId: session.firmId,
    subscriberId,
    targetStateSlug,
    serviceType: serviceTypeRaw,
    ruleVerifiedDate: rule?.verified_date ?? null,
    completedByFirmSessionId: session.sessionId,
  });
  if (!created) return jsonResponse(404, { error: "Not found." });

  return jsonResponse(201, toMobilityCompletionJson(created));
}

/** DELETE /firm/mobility/completions/:id -- soft-delete (see migration
 * 0016's comment for why it's not a real DELETE), firm-scoped. Lets a firm
 * un-mark something they completed by mistake. */
async function handleMobilityCompletionDelete(request: Request, env: Env, id: string): Promise<Response> {
  // migration 0045 (roadmap #11/#13/#14): Staff stays read-only.
  const session = await requireFirmRole(request, env, "partner", "office_manager");
  if (session instanceof Response) return session;

  // CSRF defense-in-depth (2026-08-05) -- see handleFirmLicenseCreate's own comment.
  if (!originAllowed(request, env)) {
    return jsonResponse(400, { error: "That request couldn't be completed. Please try again from the DeadlineRadar site." });
  }

  const allowed = await checkRateLimit(env.DB, session.firmId, "mobility_completion_delete", RATE_LIMIT_MOBILITY_COMPLETION_DELETE);
  if (!allowed) {
    return jsonResponse(429, { error: "Too many requests. Please try again later." });
  }

  const removed = await store.removeMobilityCompletion(env.DB, session.firmId, id);
  if (!removed) return jsonResponse(404, { error: "Not found." });
  return jsonResponse(200, { id, status: "removed" });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // PREVIEW/STAGING CORS only (see corsHeaders()'s own comment) -- in
    // production env.STATIC_SITE_BASE_URL is unset, so this whole block is
    // skipped and routeRequest() runs exactly as it always has.
    if (env.STATIC_SITE_BASE_URL) {
      if (request.method === "OPTIONS") {
        return withSecurityHeaders(new Response(null, { status: 204, headers: corsHeaders(env) }));
      }
      const response = await routeRequest(request, env, ctx);
      return withSecurityHeaders(withCorsHeaders(response, env));
    }
    return withSecurityHeaders(await routeRequest(request, env, ctx));
  },

  /**
   * Daily reminder cron (Phase 3). Fires on the schedule in wrangler.toml's
   * [triggers]. Sends each confirmed subscriber the nearest newly-due
   * escalation reminder (60/30/14/7/3/1 days out). No-ops if sending isn't
   * configured (no SendGrid key) so an accidentally-unset key degrades to
   * "did nothing" rather than erroring. A StaleDataError (reference data too
   * old to schedule off) is caught and logged, not thrown, so a stale-data
   * pause doesn't surface as an unhandled cron failure -- but it DOES mean no
   * reminders go out until the data is re-verified, which is the intended
   * fail-safe (a wrong-date reminder is worse than none).
   */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Task #3 (2026-08-06): hard-deletes any firm past its 30-day
    // soft-delete grace period. Deliberately NOT inside the
    // SENDGRID_API_KEY gate below -- account deletion must keep working in
    // any environment, configured for email or not; these are unrelated
    // concerns that happened to share one cron trigger.
    ctx.waitUntil(
      (async () => {
        try {
          const deletedFirmIds = await store.hardDeleteExpiredFirms(env.DB, env.DOCUMENTS, new Date());
          if (deletedFirmIds.length > 0) {
            console.log(`[account-deletion-cron] hard-deleted ${deletedFirmIds.length} firm(s): ${deletedFirmIds.join(", ")}`);
          }
        } catch (err) {
          console.log(`[account-deletion-cron] error: ${String(err)}`);
        }
      })()
    );

    if (!env.SENDGRID_API_KEY) return;
    // Roadmap #70: skipped entirely on a recognized US federal holiday --
    // see holidays.ts's own docstring for why this never loses a reminder,
    // only delays that day's newly-due sends by up to 24h.
    if (isUsFederalHoliday(new Date())) {
      console.log(`[reminder-cron] skipped -- US federal holiday`);
      return;
    }
    ctx.waitUntil(
      (async () => {
        try {
          const summary = await runReminderPass(env);
          console.log(`[reminder-cron] ${JSON.stringify(summary)}`);
        } catch (err) {
          if (err instanceof SchedulerStaleDataError) {
            console.log(`[reminder-cron] paused -- stale reference data: ${err.message}`);
          } else {
            console.log(`[reminder-cron] error: ${String(err)}`);
          }
        }
      })()
    );

    // Roadmap #34 (2026-08-08): the drip course's own independent pass, same
    // trigger. Deliberately NOT inside the holiday-skip check above -- that
    // guard exists for deadline-urgency accuracy (a reminder's day-count
    // math), which doesn't apply to a fixed days-since-enrollment nurture
    // sequence; skipping it here would just be unnecessary complexity.
    ctx.waitUntil(
      (async () => {
        try {
          const summary = await runDripCoursePass(env);
          console.log(`[drip-course-cron] ${JSON.stringify(summary)}`);
        } catch (err) {
          console.log(`[drip-course-cron] error: ${String(err)}`);
        }
      })()
    );

    // Roadmap #9/#319 (2026-08-08): same independent-pass shape as the drip
    // course above -- not deadline-urgency-sensitive, so no holiday skip.
    ctx.waitUntil(
      (async () => {
        try {
          const summary = await runRuleChangeAlertPass(env);
          console.log(`[rule-change-alert-cron] ${JSON.stringify(summary)}`);
        } catch (err) {
          console.log(`[rule-change-alert-cron] error: ${String(err)}`);
        }
      })()
    );
  },
};
