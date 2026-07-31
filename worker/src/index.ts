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
  MAX_FIELD_LEN,
  MAX_FIRM_NAME_LEN,
  MAX_STAFF_COUNT_HINT_LEN,
  MAX_STAFF_LABEL_LEN,
  RATE_LIMIT_ACTION,
  RATE_LIMIT_FIRM_LEAD,
  RATE_LIMIT_MOBILITY_CHECK,
  RATE_LIMIT_FIRM_LICENSE_CREATE,
  RATE_LIMIT_DEBUG_REMINDER_PASS,
  RATE_LIMIT_FIRM_LOGIN,
  RATE_LIMIT_FIRM_SIGNUP,
  RATE_LIMIT_SUBSCRIBE,
  checkRateLimit,
  checkSignupDomainGate,
  escapeHtml,
  getCookie,
  hasControlChars,
  isValidEmail,
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
  buildFirmStaffAddedEmail,
  buildStopConfirmationEmail,
  fmtDate,
} from "./emails";
import { DEFAULT_DAILY_SEND_CAP, checkAndCountSend, isEmailAllowlisted, sendViaSendGrid } from "./sender";
import { StaleDataError as SchedulerStaleDataError, runReminderPass } from "./scheduler";
import mobilityRulesData from "./mobility_rules.json";
import {
  MOBILITY_DISCLAIMER,
  evaluateMobility,
  isValidServiceType,
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
};

const ACTION_PATHS = new Set(Object.keys(ACTION_PAGES));

function actionConfirmPage(pathname: string, token: string): Response {
  const meta = ACTION_PAGES[pathname];
  if (!meta) return errorPage(404, "Not found.");
  const action = `/api${pathname}`; // the Worker is bound to /api/*
  const body =
    `<h1>${escapeHtml(meta.heading)}</h1>` +
    `<p>${escapeHtml(meta.intro)}</p>` +
    `<form method="post" action="${escapeHtml(action)}" style="margin-top:1.5rem;">` +
    `<input type="hidden" name="token" value="${escapeHtml(token)}">` +
    `<button type="submit" style="font-size:16px;padding:12px 24px;border:0;border-radius:8px;` +
    `background:#1f5fbf;color:#fff;font-weight:700;cursor:pointer;">${escapeHtml(meta.button)}</button>` +
    `</form>`;
  return htmlResponse(200, htmlPage(meta.heading, body));
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
const FIRM_LOGIN_SENT_PAGE = htmlPage(
  "Check your email",
  "<h1>Check your email</h1><p>If that email has (or can have) a DeadlineRadar firm account, we've " +
    "just sent a sign-in link. It expires in 15 minutes and works once &mdash; if it's expired by " +
    "the time you click it, just request a new one.</p>"
);

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
async function issueAndSendFirmLoginLink(env: Env, firmId: string, adminEmail: string): Promise<void> {
  const { rawToken } = await store.createLoginToken(env.DB, firmId);
  if (!env.SENDGRID_API_KEY) return;
  try {
    const underCap = await checkAndCountSend(env.DB, dailySendCap(env));
    if (!underCap) return;
    const loginUrl = `${actionBaseUrl(env)}/firm/login/verify?token=${encodeURIComponent(rawToken)}`;
    const built = buildFirmLoginEmail(loginUrl);
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
 * identical response either way (FIRM_LOGIN_SENT_PAGE), matching this
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
    return htmlResponse(200, FIRM_LOGIN_SENT_PAGE);
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
      return errorPage(
        400,
        "Please sign up with your firm's business email address. We don't offer trial accounts on " +
          "free personal email providers or to other compliance-software vendors."
      );
    }
  }

  const turnstileOk = await verifyTurnstile(form["cf-turnstile-response"], env.TURNSTILE_SECRET_KEY);
  if (!turnstileOk) {
    return errorPage(400, "Verification failed -- please try again.");
  }

  const firmId = existing ? existing.id : (await store.createFirm(env.DB, { name: nameRaw, adminEmail: email })).id;

  await issueAndSendFirmLoginLink(env, firmId, email);

  return htmlResponse(200, FIRM_LOGIN_SENT_PAGE);
}

/**
 * POST /firm/login -- body: `admin_email` only. If a firm exists for that
 * email, issues + emails a fresh login link. If NOT, this is a silent no-op
 * -- but the response is IDENTICAL either way (FIRM_LOGIN_SENT_PAGE): never
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
    return htmlResponse(200, FIRM_LOGIN_SENT_PAGE);
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

  const existing = await store.findFirmByAdminEmail(env.DB, email);
  if (existing) {
    await issueAndSendFirmLoginLink(env, existing.id, email);
  }
  // No firm for this email: fall through to the SAME response, sending
  // nothing -- this is the anti-enumeration branch this handler exists for.

  return htmlResponse(200, FIRM_LOGIN_SENT_PAGE);
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
 */
async function handleFirmLoginVerify(env: Env, token: string | null): Promise<Response> {
  if (!token) return errorPage(400, "Missing sign-in link.");
  const result = await store.verifyAndConsumeLoginToken(env.DB, token);
  if (!result) {
    return errorPage(
      400,
      "That sign-in link is invalid, expired, or already used. Please request a new one and try again."
    );
  }
  const { rawSessionToken } = await store.createSession(env.DB, result.firmId);
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${env.STATIC_SITE_BASE_URL || ""}/firm-dashboard/`,
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
export async function requireFirmSession(request: Request, env: Env): Promise<{ firmId: string } | Response> {
  const raw = getCookie(request, FIRM_SESSION_COOKIE_NAME);
  if (!raw) {
    return errorPage(401, "You need to sign in to view this.");
  }
  const result = await store.verifySession(env.DB, raw);
  if (!result) {
    return errorPage(401, "Your session has expired or is invalid. Please sign in again.");
  }
  return result;
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

async function routeRequest(request: Request, env: Env): Promise<Response> {
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

    // GET on an action path renders a confirmation PAGE only -- it never
    // changes state. Email providers (Gmail, corporate filters) automatically
    // GET the links in a message to scan them; if the action fired on GET, a
    // scan could silently stop/unsubscribe/re-arm a subscriber, or consume a
    // one-time link before the human ever clicks it. The state change happens
    // only on the POST below (the button on this page), which scanners don't do.
    if (request.method === "GET") {
      if (url.pathname === "/firm/licenses") {
        try {
          return await handleFirmLicensesList(request, env);
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

      if (ACTION_PATHS.has(url.pathname)) {
        const allowed = await checkRateLimit(env.DB, ip, "action", RATE_LIMIT_ACTION);
        if (!allowed) return errorPage(429, "Too many requests. Please try again later.");
        const token = url.searchParams.get("token");
        if (!token) return errorPage(400, "That link is missing its token.");
        return actionConfirmPage(url.pathname, token);
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
      if (firmLicenseIdMatch) {
        try {
          return await handleFirmLicenseDelete(request, env, firmLicenseIdMatch[1] as string);
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
        let token = url.searchParams.get("token");
        try {
          const raw = await request.text();
          if (raw.length > 0 && raw.length <= MAX_BODY_BYTES) {
            token = new URLSearchParams(raw).get("token") ?? token;
          }
        } catch {
          // keep whatever the query gave us
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
              return await handleFirmLoginVerify(env, token);
          }
        } catch {
          return errorPage(400, "Something went wrong processing that request.");
        }
      }
    }

    return errorPage(404, "Not found.");
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
for (const row of (mobilityRulesData.records ?? []) as MobilityRuleRow[]) {
  if (row && typeof row.state_slug === "string") MOBILITY_RULES_BY_SLUG[row.state_slug] = row;
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

  const allowed = await checkRateLimit(env.DB, ip, "mobility_check", RATE_LIMIT_MOBILITY_CHECK);
  if (!allowed) {
    return jsonResponse(429, { error: "Too many requests. Please try again later." });
  }

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
  async fetch(request: Request, env: Env): Promise<Response> {
    // PREVIEW/STAGING CORS only (see corsHeaders()'s own comment) -- in
    // production env.STATIC_SITE_BASE_URL is unset, so this whole block is
    // skipped and routeRequest() runs exactly as it always has.
    if (env.STATIC_SITE_BASE_URL) {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders(env) });
      }
      const response = await routeRequest(request, env);
      return withCorsHeaders(response, env);
    }
    return routeRequest(request, env);
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
