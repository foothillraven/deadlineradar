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
 * breaker (sender.checkAndCountSend) is the last-resort cap on total sends.
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
  MAX_BODY_BYTES,
  MAX_CPE_DESCRIPTION_LEN,
  MAX_CPE_HOURS_PER_ENTRY,
  MAX_FIELD_LEN,
  MAX_FIRM_NAME_LEN,
  MAX_STAFF_COUNT_HINT_LEN,
  MAX_STAFF_LABEL_LEN,
  RATE_LIMIT_ACTION,
  RATE_LIMIT_FIRM_PASSWORD_LOGIN,
  RATE_LIMIT_FIRM_PASSWORD_SET,
  RATE_LIMIT_OAUTH_START,
  RATE_LIMIT_CPE_ENTRY_CREATE,
  RATE_LIMIT_FIRM_LEAD,
  RATE_LIMIT_MOBILITY_CHECK,
  RATE_LIMIT_FIRM_LICENSE_CREATE,
  RATE_LIMIT_FIRM_LICENSE_PATCH,
  RATE_LIMIT_DEBUG_REMINDER_PASS,
  RATE_LIMIT_FIRM_LOGIN,
  RATE_LIMIT_SUBSCRIBER_LOGIN_ACCOUNT,
  RATE_LIMIT_FIRM_SIGNUP,
  RATE_LIMIT_SUBSCRIBE,
  checkRateLimit,
  checkSignupDomainGate,
  escapeHtml,
  getCookie,
  hasControlChars,
  isValidCpeCategory,
  isValidEmail,
  parseStrictCpeHours,
  sanitizeFreeText,
  strictParseInt,
  parseStrictIsoDate,
  verifyTurnstile,
} from "./validation";
import {
  StaleDataError,
  checkDataFreshness,
  computeSubscriberDeadline,
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
  buildSubscriberLoginEmail,
  buildFirmPasswordChangedEmail,
  buildFirmStaffAddedEmail,
  buildStopConfirmationEmail,
  fmtDate,
} from "./emails";
import { DEFAULT_DAILY_SEND_CAP, checkAndCountSend, isEmailAllowlisted, sendViaSendGrid } from "./sender";
import { StaleDataError as SchedulerStaleDataError, runReminderPass } from "./scheduler";
import {
  MAX_PASSWORD_LEN,
  hashPassword,
  verifyPassword,
  validatePasswordStrength,
  needsRehash,
  dummyVerifyForTiming,
} from "./password";
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
import { checkPremiumAccess, entitlementMessage } from "./entitlements";

function htmlPage(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{font-family:-apple-system,sans-serif;max-width:520px;margin:3rem auto;padding:0 1.25rem;line-height:1.5;}</style>
</head><body>${bodyHtml}</body></html>`;
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

function actionConfirmPage(pathname: string, token: string, env: Env): Response {
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
  const passwordFieldHtml =
    pathname === "/firm/login/verify"
      ? `<div style="margin:1rem 0;text-align:left;">` +
        `<label for="dr-optional-password" style="display:block;font-size:13px;margin-bottom:0.3rem;">` +
        `Optional: set a password now, so you can skip this email next time</label>` +
        `<input type="password" id="dr-optional-password" name="new_password" minlength="12" ` +
        `autocomplete="new-password" placeholder="At least 12 characters" ` +
        `style="width:100%;box-sizing:border-box;font-size:16px;padding:10px 12px;` +
        `border:1px solid #ccc;border-radius:6px;">` +
        `</div>`
      : "";
  const body =
    `<h1>${escapeHtml(meta.heading)}</h1>` +
    `<p>${escapeHtml(meta.intro)}</p>` +
    `<form method="post" action="${escapeHtml(action)}" style="margin-top:1.5rem;">` +
    `<input type="hidden" name="token" value="${escapeHtml(token)}">` +
    csrfFieldHtml +
    passwordFieldHtml +
    `<button type="submit" style="font-size:16px;padding:12px 24px;border:0;border-radius:8px;` +
    `background:#1f5fbf;color:#fff;font-weight:700;cursor:pointer;">${escapeHtml(meta.button)}</button>` +
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

function errorPage(status: number, message: string): Response {
  return htmlResponse(status, htmlPage("Error", `<p>${escapeHtml(message)}</p>`));
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
    return errorPage(429, "Too many signups from this address. Please try again later.");
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
  if (!SUPPORTED_STATE_SLUGS.has(stateSlug)) {
    return errorPage(400, "Unsupported or missing state.");
  }

  const turnstileOk = await verifyTurnstile(form["cf-turnstile-response"], env.TURNSTILE_SECRET_KEY);
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
          const underCap = await checkAndCountSend(env.DB, dailySendCap(env));
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
  //   - Guarded by the daily circuit breaker (checkAndCountSend) so a burst
  //     can never blow past the cap and torch sender reputation.
  //   - Wrapped so ANY failure (SendGrid down, cap hit, build error) never
  //     turns an already-stored signup into an error response. The record is
  //     persisted regardless; the user sees the same success page either way,
  //     which also preserves the no-enumeration-oracle property.
  if (env.SENDGRID_API_KEY) {
    try {
      const underCap = await checkAndCountSend(env.DB, dailySendCap(env));
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
const FIRM_LEAD_SUCCESS_PAGE = htmlPage(
  "You're on the list",
  "<h1>You're on the list</h1><p>We'll email you the moment self-serve signup for the firm dashboard " +
    "opens. No account has been created yet &mdash; this just reserves your spot.</p>"
);

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
    return errorPage(429, "Too many submissions from this address. Please try again later.");
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
    return htmlResponse(200, FIRM_LEAD_SUCCESS_PAGE);
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

  const turnstileOk = await verifyTurnstile(form["cf-turnstile-response"], env.TURNSTILE_SECRET_KEY);
  if (!turnstileOk) {
    return errorPage(400, "Verification failed -- please try again.");
  }

  const firmNameRaw = (form.firm_name ?? "").trim().slice(0, MAX_FIRM_NAME_LEN);
  const firmName = firmNameRaw.length > 0 ? firmNameRaw : null;
  const staffCountHintRaw = (form.staff_count_hint ?? "").trim().slice(0, MAX_STAFF_COUNT_HINT_LEN);
  const staffCountHint = staffCountHintRaw.length > 0 ? staffCountHintRaw : null;

  await store.addFirmLead(env.DB, { email, firmName, staffCountHint });

  return htmlResponse(200, FIRM_LEAD_SUCCESS_PAGE);
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

/** Cleared as soon as the handshake is consumed, so a completed sign-in
 * leaves nothing reusable behind. */
function oauthHandshakeClearCookieHeader(): string {
  return `${OAUTH_HANDSHAKE_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
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
  purpose: store.LoginTokenPurpose = "login"
): Promise<void> {
  const { rawToken } = await store.createLoginToken(env.DB, firmId, purpose);
  if (!env.SENDGRID_API_KEY) return;
  try {
    const underCap = await checkAndCountSend(env.DB, dailySendCap(env));
    if (!underCap) return;
    const loginUrl = `${actionBaseUrl(env)}/firm/login/verify?token=${encodeURIComponent(rawToken)}`;
    // COPY HONESTY (2026-07-31): a link issued from "Forgot password" must
    // say it leads to setting a password. An email promising a plain sign-in
    // and then landing on a password screen is the same class of mismatch as
    // the bug this fixes, just pointed the other way.
    const built = buildFirmLoginEmail(loginUrl, purpose === "password_reset");
    await sendViaSendGrid(env.SENDGRID_API_KEY, adminEmail, built, env.EMAIL_ALLOWLIST);
  } catch {
    // Swallow -- same reasoning as every other best-effort send in this
    // file: the caller's response must never depend on whether this
    // succeeded.
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
  const nameRaw = (form.name ?? "").trim().slice(0, MAX_FIRM_NAME_LEN);
  if (nameRaw.length === 0) {
    return errorPage(400, "Please enter your firm's name.");
  }

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
  const existing = await store.findFirmByAdminEmail(env.DB, email);
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

  const turnstileOk = await verifyTurnstile(form["cf-turnstile-response"], env.TURNSTILE_SECRET_KEY);
  if (!turnstileOk) {
    return errorPage(400, "Verification failed -- please try again.");
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
  if (existing) {
    firmId = existing.id;
  } else {
    try {
      firmId = (await store.createFirm(env.DB, { name: nameRaw, adminEmail: email })).id;
    } catch {
      const raced = await store.findFirmByAdminEmail(env.DB, email);
      if (!raced) throw new Error("firm signup: insert failed and no concurrent winner found");
      firmId = raced.id;
    }
  }

  await issueAndSendFirmLoginLink(env, firmId, email);

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

  const turnstileOk = await verifyTurnstile(form["cf-turnstile-response"], env.TURNSTILE_SECRET_KEY);
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
  const purpose = store.normalizeLoginTokenPurpose(form.intent);

  const existing = await store.findFirmByAdminEmail(env.DB, email);
  // AuditLab re-verify follow-up, 2026-08-03: a suspended firm's magic link
  // still redeems to a 403 (requireFirmSession()/handleFirmLoginVerify()
  // both check status), so this was never an access gap -- but sending the
  // email at all spends one send from the GLOBAL daily cap shared with the
  // real reminder cron, and mails an account that's been cut off for a
  // reason. `existing.status === "active"` added to the SAME condition
  // (not a separate branch) -- the response stays byte-identical to "no
  // firm for this email" either way, so this does not introduce a new
  // enumeration signal.
  if (existing && existing.status === "active") {
    await issueAndSendFirmLoginLink(env, existing.id, email, purpose);
  }
  // No firm for this email, or an inactive one: fall through to the SAME
  // response, sending nothing -- this is the anti-enumeration branch this
  // handler exists for.

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
      "That sign-in link is invalid, expired, or already used. Please request a new one and try again."
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
  if (
    result.purpose !== "password_reset" &&
    typeof optionalNewPassword === "string" &&
    optionalNewPassword.length > 0 &&
    validatePasswordStrength(optionalNewPassword).ok &&
    !firm.password_hash
  ) {
    try {
      await store.setFirmPassword(env.DB, firm.id, await hashPassword(optionalNewPassword, env.PASSWORD_PEPPER));
    } catch {
      // Never let a failed opportunistic password-set fail the sign-in
      // itself -- same posture as handleFirmPasswordLogin's rehash step.
    }
  }
  const { rawSessionToken } = await store.createSession(
    env.DB,
    result.firmId,
    result.purpose === "password_reset"
  );
  // The destination comes from the TOKEN's stored purpose, never from the
  // request. A password-reset link lands directly on "Choose a password"
  // instead of the dashboard -- the whole point of the fix, since the old
  // flow signed you in and then silently forgot you had asked to reset.
  const destination = result.purpose === "password_reset" ? "/set-password/" : "/firm-dashboard/";
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${env.STATIC_SITE_BASE_URL || ""}${destination}`,
      "Set-Cookie": firmSessionSetCookieHeader(rawSessionToken, env),
    },
  });
}

/** POST /firm/logout -- reads the session cookie (if any), deletes the
 * matching session row (a no-op if there wasn't one), and clears the
 * cookie. Always succeeds from the caller's perspective -- there is no
 * meaningful "logout failed" state to report. */
async function handleFirmLogout(request: Request, env: Env): Promise<Response> {
  const raw = getCookie(request, FIRM_SESSION_COOKIE_NAME);
  if (raw) {
    await store.deleteSession(env.DB, raw);
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
): Promise<{ firmId: string; sessionId: string; passwordResetAuthorized: boolean } | Response> {
  const raw = getCookie(request, FIRM_SESSION_COOKIE_NAME);
  if (!raw) {
    return errorPage(401, "You need to sign in to view this.");
  }
  const result = await store.verifySession(env.DB, raw);
  if (!result) {
    return errorPage(401, "Your session has expired or is invalid. Please sign in again.");
  }
  // A suspended/inactive firm must not keep working just because its
  // session predates the suspension (AuditLab F-1, 2026-08-02: this was
  // previously checked on 2 of 12+ firm routes -- the two mobility ones --
  // leaving every other route, including the roster and CPE data, fully
  // readable/writable regardless of status). This is the ONE place that
  // check now needs to live, since it's the one gate every firm route
  // already calls first.
  if (result.firmStatus !== "active") {
    return errorPage(403, "This account isn't active. Get in touch and we'll sort it out.");
  }
  return result;
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
    const underCap = await checkAndCountSend(env.DB, dailySendCap(env));
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

  const turnstileOk = await verifyTurnstile(form["cf-turnstile-response"], env.TURNSTILE_SECRET_KEY);
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
      "That sign-in link is invalid, expired, or already used. Please request a new one and try again."
    );
  }
  const { rawSessionToken, sessionId } = await store.createSubscriberSession(env.DB, result.emailNormalized);
  // Signing in revokes every other session for this email -- see
  // deleteOtherSubscriberSessions()'s own docstring. This tier has no
  // account screen, so "request a fresh link" IS the sign-out-everywhere
  // control, and it only works if it actually revokes.
  await store.deleteOtherSubscriberSessions(env.DB, result.emailNormalized, sessionId);
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${env.STATIC_SITE_BASE_URL || ""}/my/`,
      "Set-Cookie": subscriberSessionSetCookieHeader(rawSessionToken, env),
    },
  });
}

/** POST /subscriber/logout -- deletes the session row (no-op if there wasn't
 * one) and clears the cookie. Never reports failure; there is no useful
 * "logout failed" state. */
async function handleSubscriberLogout(request: Request, env: Env): Promise<Response> {
  const raw = getCookie(request, SUBSCRIBER_SESSION_COOKIE_NAME);
  if (raw) {
    await store.deleteSubscriberSession(env.DB, raw);
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
  const raw = getCookie(request, SUBSCRIBER_SESSION_COOKIE_NAME);
  if (!raw) {
    return errorPage(401, "You need to sign in to view this.");
  }
  const result = await store.verifySubscriberSession(env.DB, raw);
  if (!result) {
    return errorPage(401, "Your session has expired or is invalid. Please sign in again.");
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
  return jsonResponse(200, { email: session.emailNormalized, licenses: items });
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
    // "recent activity" panel. Deliberately does NOT add a "renewed_at":
    // renewAndRearm() (this file, POST /firm/licenses/:id/renew) only bumps
    // `cycle`, never a timestamp -- there is no real "when was this last
    // renewed" fact in this schema yet, so the dashboard doesn't claim one.
    created_at: row.created_at,
    confirmed_at: row.confirmed_at,
    stopped_at: row.stopped_at,
    stop_reason: row.stop_reason,
  };
}

/** GET /firm/licenses -- every roster row for the session's firm, sorted by
 * soonest deadline first (a null/uncomputable deadline sorts last -- there's
 * nothing more urgent to show for it). */
async function handleFirmLicensesList(request: Request, env: Env): Promise<Response> {
  const session = await requireFirmSession(request, env);
  if (session instanceof Response) return session;

  const rows = await store.listFirmLicenses(env.DB, session.firmId);
  const asOf = new Date();
  const items = rows.map((r) => toFirmLicenseJson(r, asOf));
  items.sort((a, b) => {
    const ad = a.next_deadline as string | null;
    const bd = b.next_deadline as string | null;
    if (ad === null && bd === null) return 0;
    if (ad === null) return 1;
    if (bd === null) return -1;
    return ad < bd ? -1 : ad > bd ? 1 : 0;
  });
  // firm_name (2026-07-30, BUILD v2 Phase B): the dashboard's sidebar shows
  // which firm the signed-in admin is looking at -- looked up by
  // session.firmId (never client-supplied), so this can't be used to probe
  // another firm's name. `?? null` only covers "no firm row found" (should
  // be unreachable given a valid session already resolved this same
  // firmId) -- it does NOT guard against getFirmById() itself throwing (a
  // real D1 outage would still fail this whole request, same as every other
  // unguarded D1 call in this handler; not a new resilience gap this
  // endpoint introduces, just not one it fixes either).
  const firm = await store.getFirmById(env.DB, session.firmId);
  return jsonResponse(200, { licenses: items, firm_name: firm?.name ?? null });
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
  const session = await requireFirmSession(request, env);
  if (session instanceof Response) return session;

  // Per-FIRM daily cap (not per-IP) -- see RATE_LIMIT_FIRM_LICENSE_CREATE's
  // own comment for why checkRateLimit()'s `ip` parameter is deliberately
  // reused here as "the bucket's identity key," bound to the authenticated
  // firm id rather than the caller's network address.
  const allowed = await checkRateLimit(env.DB, session.firmId, "firm_license_create", RATE_LIMIT_FIRM_LICENSE_CREATE);
  if (!allowed) {
    return jsonResponse(429, { error: "Too many staff added today for this firm. Please try again tomorrow." });
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

  const stateSlug = (form.state_slug ?? "").trim();
  if (!SUPPORTED_STATE_SLUGS.has(stateSlug)) {
    return jsonResponse(400, { error: "Unsupported or missing state." });
  }

  const staffLabelRaw = (form.staff_label ?? "").trim();
  const staffLabel = staffLabelRaw.length > 0 ? staffLabelRaw.slice(0, MAX_STAFF_LABEL_LEN) : null;

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
  });

  if (env.SENDGRID_API_KEY) {
    try {
      const underCap = await checkAndCountSend(env.DB, dailySendCap(env));
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

  return jsonResponse(201, toFirmLicenseJson(record, new Date()));
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
  const session = await requireFirmSession(request, env);
  if (session instanceof Response) return session;

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
    email = trimmed;
  }

  let staffLabel = existing.staff_label;
  if (typeof parsed.staff_label === "string") {
    const trimmed = parsed.staff_label.trim();
    staffLabel = trimmed.length > 0 ? trimmed.slice(0, MAX_STAFF_LABEL_LEN) : null;
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

  const updated = await store.updateFirmLicense(env.DB, session.firmId, id, {
    email,
    staffLabel,
    stateSlug,
    deadlineFields,
    deadlineSource,
    userDeadline,
    resetConfirmation: emailChanged,
  });
  if (!updated) return jsonResponse(404, { error: "Not found." });

  // Editing the delivery address is, in effect, re-consenting a DIFFERENT
  // inbox -- see UpdateFirmLicenseInput.resetConfirmation's own doc. Send
  // that new address its own fresh confirm email, same best-effort posture
  // as every other send in this file.
  if (emailChanged && env.SENDGRID_API_KEY) {
    try {
      const underCap = await checkAndCountSend(env.DB, dailySendCap(env));
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

  return jsonResponse(200, toFirmLicenseJson(updated, new Date()));
}

/** DELETE /firm/licenses/:id -- removes a staff member from the roster (see
 * store.STOP_REASON_REMOVED_BY_ADMIN's own comment for why this is a
 * status/stop_reason change, not a SQL row delete, and why that alone is
 * sufficient to also stop any further reminder sends for this record: the
 * reminder cron's allConfirmedActive() only ever reads status='confirmed'
 * rows). */
async function handleFirmLicenseDelete(request: Request, env: Env, id: string): Promise<Response> {
  const session = await requireFirmSession(request, env);
  if (session instanceof Response) return session;
  const result = await store.removeFirmLicense(env.DB, session.firmId, id);
  if (!result) return jsonResponse(404, { error: "Not found." });
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
  const session = await requireFirmSession(request, env);
  if (session instanceof Response) return session;

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
  };
}

/** GET /firm/cpe -- every non-deleted CPE entry across the firm's whole
 * roster. The dashboard rolls this up per staffer client-side (same
 * pattern as GET /firm/licenses's roster-wide fetch). */
async function handleCpeEntriesList(request: Request, env: Env): Promise<Response> {
  const session = await requireFirmSession(request, env);
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
  const session = await requireFirmSession(request, env);
  if (session instanceof Response) return session;

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

  const created = await store.addCpeEntry(env.DB, {
    firmId: session.firmId,
    subscriberId,
    entryDate: entryDateIso,
    hours,
    category: categoryRaw,
    description,
    enteredByFirmSessionId: session.sessionId,
  });
  if (!created) return jsonResponse(404, { error: "Not found." });

  return jsonResponse(201, toCpeEntryJson(created));
}

/** DELETE /firm/cpe/:id -- soft-delete (see migration 0009's comment for
 * why it's not a real DELETE), firm-scoped. */
async function handleCpeEntryDelete(request: Request, env: Env, id: string): Promise<Response> {
  const session = await requireFirmSession(request, env);
  if (session instanceof Response) return session;
  const removed = await store.removeCpeEntry(env.DB, session.firmId, id);
  if (!removed) return jsonResponse(404, { error: "Not found." });
  return jsonResponse(200, { id, status: "removed" });
}

async function handleConfirm(env: Env, token: string | null): Promise<Response> {
  if (!token) return errorPage(400, "Missing confirmation link.");
  const subscriber = await store.confirm(env.DB, token);
  if (!subscriber) return errorPage(404, "That confirmation link is invalid or already used.");
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
  // No stop-confirmation email in Phase 1 (no sender exists) -- the
  // underlying stop still happens instantly regardless, same priority as
  // reminders/server.py: honoring a stop is never conditioned on whether a
  // notification email can be sent.
  return htmlResponse(
    200,
    htmlPage("Unsubscribed", "<h1>Done</h1><p>You're unsubscribed, instantly and permanently.</p>")
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
  if (env.SENDGRID_API_KEY) {
    try {
      const underCap = await checkAndCountSend(env.DB, dailySendCap(env));
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

    // GET on an action path renders a confirmation PAGE only -- it never
    // changes state. Email providers (Gmail, corporate filters) automatically
    // GET the links in a message to scan them; if the action fired on GET, a
    // scan could silently stop/unsubscribe/re-arm a subscriber, or consume a
    // one-time link before the human ever clicks it. The state change happens
    // only on the POST below (the button on this page), which scanners don't do.
    if (request.method === "GET") {
      if (url.pathname === "/subscriber/licenses") {
        try {
          return await handleSubscriberLicensesList(request, env);
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
      if (url.pathname === "/firm/oauth-identities") {
        try {
          return await handleOauthIdentitiesList(request, env);
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
        return actionConfirmPage(url.pathname, token, env);
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

      if (url.pathname === "/firm/password") {
        try {
          return await handleFirmPasswordSet(request, env, ip);
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

      if (url.pathname === "/firm/logout") {
        try {
          return await handleFirmLogout(request, env);
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
          return await handleSubscriberLogout(request, env);
        } catch {
          return errorPage(400, "Something went wrong processing that request.");
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
            case "/renewed":
              return await handleRenewed(env, token);
            case "/renewed-next-cycle":
              return await handleRenewedNextCycle(env, token);
            case "/rearm":
              return await handleRearm(env, token);
            case "/firm/login/verify":
              return await handleFirmLoginVerify(env, token, optionalNewPassword);
            case "/subscriber/login/verify":
              return await handleSubscriberLoginVerify(env, token);
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

  const turnstileOk = await verifyTurnstile(form["cf-turnstile-response"], env.TURNSTILE_SECRET_KEY);
  if (!turnstileOk) {
    return errorPage(400, "Verification failed -- please try again.");
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

  const firm = await store.findFirmByAdminEmail(env.DB, email);

  if (!firm || !firm.password_hash) {
    // No account, or an account that has never set a password (SSO-only or
    // magic-link-only). Burn comparable work so this branch is not
    // distinguishable by timing, then fail identically.
    await dummyVerifyForTiming(env.PASSWORD_PEPPER);
    return errorPage(400, INVALID_CREDENTIALS_MESSAGE);
  }

  const ok = await verifyPassword(
    password,
    {
      algo: firm.password_algo ?? undefined,
      salt: firm.password_salt ?? undefined,
      iterations: firm.password_iterations ?? undefined,
      rounds: firm.password_rounds ?? undefined,
      hash: firm.password_hash,
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
  if (firm.status !== "active") {
    return errorPage(403, "This account isn't active. Get in touch and we'll sort it out.");
  }

  // Successful login is the only moment the plaintext is legitimately in
  // hand, so it is the only moment an outdated work factor can be upgraded
  // without asking the user to do anything.
  if (
    needsRehash(
      {
        algo: firm.password_algo ?? undefined,
        iterations: firm.password_iterations ?? undefined,
        rounds: firm.password_rounds ?? undefined,
        hash: firm.password_hash,
      },
      env.PASSWORD_PEPPER
    )
  ) {
    try {
      await store.setFirmPassword(env.DB, firm.id, await hashPassword(password, env.PASSWORD_PEPPER));
    } catch {
      // A failed opportunistic upgrade must never fail the login itself.
    }
  }

  // A brand-new session row per login (never reusing or accepting a
  // caller-supplied identifier) is what makes session fixation impossible
  // here: there is no way to pre-plant a session id and have it become
  // authenticated.
  const { rawSessionToken } = await store.createSession(env.DB, firm.id);
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
  const session = await requireFirmSession(request, env);
  if (session instanceof Response) return session;

  const firm = await store.getFirmById(env.DB, session.firmId);
  if (!firm) return jsonResponse(404, { error: "Not found." });

  const access = checkPremiumAccess(firm);
  if (!access.allowed) {
    return jsonResponse(403, {
      error: entitlementMessage(access.reason),
      reason: access.reason,
      pilot_days_remaining: access.pilotDaysRemaining,
    });
  }

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
    pilot_days_remaining: access.pilotDaysRemaining,
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

  const allowed = await checkRateLimit(env.DB, ip, "firm_password_set", RATE_LIMIT_FIRM_PASSWORD_SET);
  if (!allowed) {
    return jsonResponse(429, { error: "Too many attempts. Please try again later." });
  }

  // Size-capped like every other JSON route in this file (the others go
  // through readFirmLicenseJsonBody). Flagged in review as the one
  // deviation from that convention.
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

  // A session minted by redeeming a password-RESET link is exempt from
  // proving the old password (migration 0014). It has to be: the person who
  // clicked "Forgot password" is by definition the person who cannot supply
  // it, so requiring it would leave the reset flow refusing the only user it
  // exists for. The exemption is safe because that session proves control of
  // the account's own inbox -- stronger evidence than the cookie the
  // prove-the-old-password rule guards against -- and it is spent below, so
  // one emailed link authorises exactly one password set.
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

  await store.setFirmPassword(env.DB, firm.id, await hashPassword(newPassword, env.PASSWORD_PEPPER));

  // Changing a password must end every OTHER session. If the reason for
  // the change is that a session was stolen, leaving that session alive
  // makes the change cosmetic -- the attacker just keeps using the cookie
  // they already hold. The caller's own session survives so they aren't
  // logged out of the tab they're sitting in.
  const endedSessions = await store.deleteOtherSessionsForFirm(env.DB, firm.id, session.sessionId);

  // ...and every UNUSED sign-in / reset link (2026-07-31). Same reasoning one
  // step earlier in the chain: an outstanding emailed link is a live bearer
  // credential for this account, so finishing a reset while leaving older
  // links redeemable would make the reset only half-true. Cheap, and it also
  // tidies up the duplicates people generate by clicking "email me a link"
  // several times when the first is slow to arrive.
  await store.invalidateOutstandingLoginTokens(env.DB, firm.id);

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
      const underCap = await checkAndCountSend(env.DB, dailySendCap(env));
      if (underCap) {
        const built = buildFirmPasswordChangedEmail(firm.name, new Date().toISOString());
        await sendViaSendGrid(env.SENDGRID_API_KEY, firm.admin_email, built, env.EMAIL_ALLOWLIST);
      }
    } catch {
      // Intentionally swallowed -- see above.
    }
  }

  return jsonResponse(200, { ok: true, other_sessions_ended: endedSessions });
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
  if (!allowed) return errorPage(429, "Too many requests. Please try again later.");

  const url = new URL(request.url);

  // The user declined consent, or the provider rejected the request. Not
  // an error to surface verbatim -- provider error text echoes request
  // parameters back and would leak configuration into the browser.
  if (url.searchParams.get("error")) {
    return errorPage(400, SSO_FAILED_MESSAGE);
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return errorPage(400, SSO_FAILED_MESSAGE);

  const browserBinding = getCookie(request, OAUTH_HANDSHAKE_COOKIE_NAME);
  const consumed = await store.consumeOauthState(env.DB, state, browserBinding);
  if (!consumed) return errorPage(400, SSO_FAILED_MESSAGE);

  // A handshake opened for one provider must not be redeemable at
  // another's callback.
  if (consumed.provider !== provider.id) return errorPage(400, SSO_FAILED_MESSAGE);

  const redirectUri = buildRedirectUri(actionBaseUrl(env), provider.id);
  const tokens = await exchangeCodeForTokens({
    provider,
    code,
    redirectUri,
    codeVerifier: consumed.codeVerifier,
  });
  if (!tokens || !tokens.id_token) return errorPage(400, SSO_FAILED_MESSAGE);

  const claims = parseAndValidateIdToken({
    idToken: tokens.id_token,
    provider,
    expectedNonce: consumed.nonce,
  });
  if (!claims) return errorPage(400, SSO_FAILED_MESSAGE);

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
      return errorPage(403, "This account isn't active. Get in touch and we'll sort it out.");
    }
    await store.touchOauthIdentityLogin(env.DB, existingIdentity.id, existingIdentity.firm_id, claims.email);
    const { rawSessionToken } = await store.createSession(env.DB, existingIdentity.firm_id);
    return new Response(null, {
      status: 302,
      headers: {
        Location: `${env.STATIC_SITE_BASE_URL || ""}/firm-dashboard/`,
        "Set-Cookie": firmSessionSetCookieHeader(rawSessionToken, env),
      },
    });
  }

  // First time this provider account has been seen. Linking it to an
  // existing firm requires a VERIFIED email: an unverified address proves
  // nothing, and honouring it would let anyone who can create an account
  // at a provider with an arbitrary unverified email claim a firm.
  if (!claims.email || !claims.emailVerified) {
    return errorPage(400, SSO_UNVERIFIED_EMAIL_MESSAGE);
  }

  const firm = await store.findFirmByAdminEmail(env.DB, claims.email);
  if (!firm) {
    // Deliberately NOT auto-creating a firm here. Signup runs a domain
    // gate (checkSignupDomainGate: disposable domains and competitor
    // domains are refused a trial), and minting an account through the
    // SSO callback would route straight around it. SSO connects to an
    // account that already exists; it is not a second signup door.
    return errorPage(400, SSO_NO_ACCOUNT_MESSAGE);
  }
  // AuditLab F-1, 2026-08-02: a suspended firm must not be able to LINK a
  // new provider identity to itself, any more than it can log in any other
  // way. `firm` here is fresh (fetched moments ago in this same request),
  // so it covers both branches below (new link, and the concurrent-link
  // race, which re-validates against this same firm.id).
  if (firm.status !== "active") {
    return errorPage(403, "This account isn't active. Get in touch and we'll sort it out.");
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
    if (!raced) return errorPage(400, SSO_FAILED_MESSAGE);
    // Fail closed if the concurrent winner bound this subject to a
    // DIFFERENT firm than the one we just validated -- reachable only if
    // the provider account's email changed mid-flight, but seating a
    // session on an unvalidated firm is not a thing to reason about at
    // 3am. Review finding 4f.
    if (raced.firm_id !== firm.id) return errorPage(400, SSO_FAILED_MESSAGE);
    const { rawSessionToken } = await store.createSession(env.DB, raced.firm_id);
    return new Response(null, {
      status: 302,
      headers: {
        Location: `${env.STATIC_SITE_BASE_URL || ""}/firm-dashboard/`,
        "Set-Cookie": firmSessionSetCookieHeader(rawSessionToken, env),
      },
    });
  }

  const { rawSessionToken } = await store.createSession(env.DB, firm.id);
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${env.STATIC_SITE_BASE_URL || ""}/firm-dashboard/`,
      "Set-Cookie": firmSessionSetCookieHeader(rawSessionToken, env),
    },
  });
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
 */
async function handleOauthIdentityDelete(request: Request, env: Env, id: string): Promise<Response> {
  const session = await requireFirmSession(request, env);
  if (session instanceof Response) return session;
  const removed = await store.unlinkOauthIdentity(env.DB, session.firmId, id);
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
  const session = await requireFirmSession(request, env);
  if (session instanceof Response) return session;

  // Keyed on the AUTHENTICATED FIRM, not the caller's IP. The stated threat
  // is "harvesting by a subscriber", which an IP key does not bound (rotate
  // IPs and it never binds) while it DOES punish a whole firm behind one
  // office NAT. Matches RATE_LIMIT_FIRM_LICENSE_CREATE's convention for
  // authenticated routes. Also moved after the entitlement check so an
  // unentitled session cannot burn a paying firm's budget.
  const firm = await store.getFirmById(env.DB, session.firmId);
  if (!firm) return jsonResponse(404, { error: "Not found." });

  // Entitlement BEFORE any work: a non-paying firm must not receive a
  // determination under any circumstances.
  const access = checkPremiumAccess(firm);
  if (!access.allowed) {
    return jsonResponse(403, {
      error: entitlementMessage(access.reason),
      reason: access.reason,
      pilot_days_remaining: access.pilotDaysRemaining,
    });
  }

  // Rate limit AFTER the gate. Review finding: with it first, an
  // authenticated-but-unentitled session could exhaust the firm's budget
  // purely on 403s.
  const allowed = await checkRateLimit(env.DB, session.firmId, "mobility_check", RATE_LIMIT_MOBILITY_CHECK);
  if (!allowed) {
    return jsonResponse(429, { error: "Too many requests. Please try again later." });
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

  const homeStateSlug = typeof body.home_state_slug === "string" ? body.home_state_slug : "";
  const targetStateSlug = typeof body.target_state_slug === "string" ? body.target_state_slug : "";
  const serviceTypeRaw = typeof body.service_type === "string" ? body.service_type : "";

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
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // PREVIEW/STAGING CORS only (see corsHeaders()'s own comment) -- in
    // production env.STATIC_SITE_BASE_URL is unset, so this whole block is
    // skipped and routeRequest() runs exactly as it always has.
    if (env.STATIC_SITE_BASE_URL) {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders(env) });
      }
      const response = await routeRequest(request, env, ctx);
      return withCorsHeaders(response, env);
    }
    return routeRequest(request, env, ctx);
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
    if (!env.SENDGRID_API_KEY) return;
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
  },
};
