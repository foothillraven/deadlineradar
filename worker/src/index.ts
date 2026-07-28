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
  RATE_LIMIT_ACTION,
  RATE_LIMIT_FIRM_LEAD,
  RATE_LIMIT_FIRM_LOGIN,
  RATE_LIMIT_FIRM_SIGNUP,
  RATE_LIMIT_SUBSCRIBE,
  checkRateLimit,
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
  SUPPORTED_STATE_SLUGS,
  USER_DEADLINE_MAX_DAYS,
  type DeadlineFields,
} from "./deadline";
import * as store from "./store";
import { buildConfirmationEmail, buildFirmLoginEmail, buildStopConfirmationEmail, fmtDate } from "./emails";
import { DEFAULT_DAILY_SEND_CAP, checkAndCountSend, sendViaSendGrid } from "./sender";
import { StaleDataError as SchedulerStaleDataError, runReminderPass } from "./scheduler";

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
    heading: "Stop these reminders",
    intro: "Renewed already? Click below to stop all further reminders for this deadline.",
    button: "Yes, stop these reminders",
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

function firmSessionSetCookieHeader(rawSessionToken: string): string {
  return (
    `${FIRM_SESSION_COOKIE_NAME}=${encodeURIComponent(rawSessionToken)}; HttpOnly; Secure; ` +
    `SameSite=Lax; Path=/; Max-Age=${FIRM_SESSION_COOKIE_MAX_AGE_SECONDS}`
  );
}

function firmSessionClearCookieHeader(): string {
  return `${FIRM_SESSION_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
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

  let deadlineFields: DeadlineFields = {};
  let deadlineSource: string = store.DEADLINE_SOURCE_COMPUTED;
  let userDeadline: string | null = null;
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
      deadlineFields = { birth_month: String(birthMonthInt), birth_year_parity: parity };
    } else if (stateSlug === "texas") {
      const birthMonth = form.birth_month;
      if (!birthMonth) return errorPage(400, "Texas needs your birth month.");
      const birthMonthInt = strictParseInt(birthMonth);
      if (birthMonthInt === null || birthMonthInt < 1 || birthMonthInt > 12) {
        return errorPage(400, "Texas needs a valid birth month.");
      }
      deadlineFields = { birth_month: String(birthMonthInt) };
    } else if (stateSlug === "ohio") {
      const cohortGroup = form.cohort_group;
      if (cohortGroup !== "Group 1" && cohortGroup !== "Group 2" && cohortGroup !== "Group 3") {
        return errorPage(400, "Ohio needs your cohort group.");
      }
      deadlineFields = { cohort_group: cohortGroup };
    } else if (form.license_type_id) {
      const licenseTypeId = form.license_type_id;
      if (licenseTypeId.length > MAX_FIELD_LEN) {
        return errorPage(400, "Invalid license type.");
      }
      deadlineFields = { license_type_id: licenseTypeId };
    }
  } else {
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
    deadlineSource = store.DEADLINE_SOURCE_USER;
    userDeadline = rawDate;
  }

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
  if (computable && computeSubscriberDeadline(stateSlug, deadlineFields, new Date()) === null) {
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
            const confirmUrl = `${ACTION_BASE_URL}/confirm?token=${encodeURIComponent(existing.confirm_token)}`;
            const unsubscribeUrl = `${ACTION_BASE_URL}/unsubscribe?token=${encodeURIComponent(existing.unsubscribe_token)}`;
            const built = buildConfirmationEmail(
              stateNameFromSlug(stateSlug),
              confirmUrl,
              unsubscribeUrl,
              existing.first_name,
              existing.user_deadline ? fmtDate(new Date(`${existing.user_deadline}T00:00:00Z`)) : null
            );
            await sendViaSendGrid(env.SENDGRID_API_KEY, existing.email, built);
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
        const confirmUrl = `${ACTION_BASE_URL}/confirm?token=${encodeURIComponent(record.confirm_token)}`;
        const unsubscribeUrl = `${ACTION_BASE_URL}/unsubscribe?token=${encodeURIComponent(record.unsubscribe_token)}`;
        const built = buildConfirmationEmail(
          stateNameFromSlug(stateSlug),
          confirmUrl,
          unsubscribeUrl,
          record.first_name,
          record.user_deadline ? fmtDate(new Date(`${record.user_deadline}T00:00:00Z`)) : null
        );
        await sendViaSendGrid(env.SENDGRID_API_KEY, record.email, built);
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
    const loginUrl = `${ACTION_BASE_URL}/firm/login/verify?token=${encodeURIComponent(rawToken)}`;
    const built = buildFirmLoginEmail(loginUrl);
    await sendViaSendGrid(env.SENDGRID_API_KEY, adminEmail, built);
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

  const turnstileOk = await verifyTurnstile(form["cf-turnstile-response"], env.TURNSTILE_SECRET_KEY);
  if (!turnstileOk) {
    return errorPage(400, "Verification failed -- please try again.");
  }

  const existing = await store.findFirmByAdminEmail(env.DB, email);
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
      Location: "/firm-dashboard/",
      "Set-Cookie": firmSessionSetCookieHeader(rawSessionToken),
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
      Location: "/",
      "Set-Cookie": firmSessionClearCookieHeader(),
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

  // Send a stop-confirmation email offering a one-click re-arm for next cycle.
  // Best-effort + isolated, same posture as the confirmation send: only when a
  // key is configured, guarded by the daily circuit breaker, and never allowed
  // to fail the stop itself (the stop already happened above and is what
  // matters). The re-arm link uses the unsubscribe_token, which is what
  // store.rearm() looks the subscriber up by.
  if (env.SENDGRID_API_KEY) {
    try {
      const underCap = await checkAndCountSend(env.DB, dailySendCap(env));
      if (underCap) {
        const rearmUrl = `${ACTION_BASE_URL}/rearm?token=${encodeURIComponent(subscriber.unsubscribe_token)}`;
        const unsubscribeUrl = `${ACTION_BASE_URL}/unsubscribe?token=${encodeURIComponent(subscriber.unsubscribe_token)}`;
        const built = buildStopConfirmationEmail(
          "renewed",
          stateNameFromSlug(subscriber.state_slug),
          rearmUrl,
          unsubscribeUrl,
          subscriber.first_name
        );
        await sendViaSendGrid(env.SENDGRID_API_KEY, subscriber.email, built);
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
      "<h1>Congrats on renewing</h1><p>All reminders for this deadline are stopped. We've emailed " +
        "you a confirmation &mdash; if you'd like a reminder again next cycle, there's a one-click " +
        "link in it to opt back in.</p>"
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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

    // GET on an action path renders a confirmation PAGE only -- it never
    // changes state. Email providers (Gmail, corporate filters) automatically
    // GET the links in a message to scan them; if the action fired on GET, a
    // scan could silently stop/unsubscribe/re-arm a subscriber, or consume a
    // one-time link before the human ever clicks it. The state change happens
    // only on the POST below (the button on this page), which scanners don't do.
    if (request.method === "GET") {
      if (ACTION_PATHS.has(url.pathname)) {
        const allowed = await checkRateLimit(env.DB, ip, "action", RATE_LIMIT_ACTION);
        if (!allowed) return errorPage(429, "Too many requests. Please try again later.");
        const token = url.searchParams.get("token");
        if (!token) return errorPage(400, "That link is missing its token.");
        return actionConfirmPage(url.pathname, token);
      }
      return errorPage(404, "Not found.");
    }

    if (request.method === "POST") {
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

      if (url.pathname === "/firm/logout") {
        try {
          return await handleFirmLogout(request, env);
        } catch {
          return errorPage(400, "Something went wrong processing that request.");
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
