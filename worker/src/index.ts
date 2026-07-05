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
 *   5. Cooldown + dedupe (store.ts) -- one signup accepted per address per
 *      SIGNUP_COOLDOWN_HOURS, never more than one active record per
 *      email+state.
 *   6. Deadline computability validated on a throwaway probe BEFORE
 *      store.addPending() ever runs.
 * Every one of these fails toward the SAME generic success response, so
 * none of them creates an oracle an attacker could use to enumerate which
 * addresses are already subscribed.
 */

import type { Env } from "./env";
import {
  HONEYPOT_FIELD_NAME,
  MAX_BODY_BYTES,
  MAX_FIELD_LEN,
  RATE_LIMIT_ACTION,
  RATE_LIMIT_SUBSCRIBE,
  SUPPORTED_STATE_SLUGS,
  checkRateLimit,
  escapeHtml,
  hasControlChars,
  isValidEmail,
  strictParseInt,
  verifyTurnstile,
} from "./validation";
import { StaleDataError, checkDataFreshness, computeSubscriberDeadline, type DeadlineFields } from "./deadline";
import * as store from "./store";
import { buildConfirmationEmail, buildStopConfirmationEmail } from "./emails";
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

// Every /subscribe path (real signup, honeypot no-op, cooldown/dedupe no-op)
// returns this SAME response, so none of them is an oracle an attacker could
// use to enumerate already-subscribed addresses -- including that only the
// real path actually sends a confirmation email; the copy is deliberately
// generic ("check your email") so a no-op path returning it reveals nothing.
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

  if (computeSubscriberDeadline(stateSlug, deadlineFields, new Date()) === null) {
    return errorPage(400, "Couldn't compute a deadline from what you gave us -- please check your inputs.");
  }

  // Cooldown + dedupe -- BOTH checked before creating anything. Either one
  // silently succeeds with the exact same response a real new signup gets.
  const cooldownHit = await store.withinSignupCooldown(env.DB, email);
  const duplicate = cooldownHit ? null : await store.findActiveOrPending(env.DB, email, stateSlug);
  if (cooldownHit || duplicate) {
    return htmlResponse(200, SUBSCRIBE_SUCCESS_PAGE);
  }

  const record = await store.addPending(env.DB, { email, stateSlug, deadlineFields, firstName });

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
          record.first_name
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
