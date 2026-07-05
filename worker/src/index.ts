/**
 * DeadlineRadar Worker -- Phase 1 (capture + D1 storage ONLY).
 *
 * Endpoints, same route dispatch as reminders/server.py: POST /subscribe,
 * GET /confirm, GET /unsubscribe, GET /renewed, GET /rearm, GET /health.
 *
 * PHASE 1 HAS NO EMAIL SENDING OF ANY KIND. There is no SendGrid import, no
 * `EmailSender` interface, no outbound call to any email provider anywhere
 * in this file or anything it imports. A successful /subscribe stores a
 * `pending_confirmation` row and returns a success page -- nothing else
 * happens. Two deliberate, disclosed divergences from the Python reference
 * follow from that: the "mailing address configured" gate (server.py:395,
 * a pre-send CAN-SPAM check) is omitted since there is no send to gate; and
 * the success-page copy below is reworded so it never claims an email was
 * sent (the Python original's copy says "we sent a confirmation email,"
 * which would be false here).
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

function htmlPage(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>body{font-family:-apple-system,sans-serif;max-width:520px;margin:3rem auto;padding:0 1.25rem;line-height:1.5;}</style>
</head><body>${bodyHtml}</body></html>`;
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

// Phase 1 note: this copy is deliberately NOT identical to
// reminders/server.py's `_SUBSCRIBE_SUCCESS_PAGE` -- the Python original
// says "we sent a confirmation email," which would be false here (Phase 1
// never sends one). It still preserves the property that matters for
// abuse-hardening: every path (real signup, honeypot no-op, cooldown/
// dedupe no-op) returns this SAME response, so none of them is an oracle
// an attacker could use to enumerate already-subscribed addresses.
const SUBSCRIBE_SUCCESS_PAGE = htmlPage(
  "Got it",
  "<h1>Got it</h1><p>Your signup has been recorded. This is an early rollout &mdash; automated " +
    "confirmation and reminder emails aren't switched on yet, so you won't receive anything from " +
    "this signup until they are.</p>"
);

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

  // NO EMAIL IS EVER SENT IN PHASE 1 -- there is no sender module, no
  // SendGrid call path, nothing reachable from this handler that could
  // deliver an email. The record is stored as pending_confirmation and
  // that is the entire effect of a successful Phase-1 signup.
  await store.addPending(env.DB, { email, stateSlug, deadlineFields, firstName });

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
      "<h1>You're all set</h1><p>You're marked confirmed. Automated reminder emails aren't " +
        "switched on yet in this rollout phase &mdash; that's a later, separately-approved step.</p>"
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
  return htmlResponse(
    200,
    htmlPage(
      "Nice work",
      "<h1>Congrats on renewing</h1><p>All reminders for this deadline are stopped. Re-arming " +
        "for next cycle by email isn't enabled yet in this rollout phase.</p>"
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

    if (url.pathname === "/health") {
      return jsonResponse(200, { status: "ok" });
    }

    const ip = clientIp(request);

    if (request.method === "GET") {
      const allowed = await checkRateLimit(env.DB, ip, "action", RATE_LIMIT_ACTION);
      if (!allowed) return errorPage(429, "Too many requests. Please try again later.");

      const token = url.searchParams.get("token");
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
          default:
            return errorPage(404, "Not found.");
        }
      } catch {
        return errorPage(400, "Something went wrong processing that request.");
      }
    }

    if (request.method === "POST" && url.pathname === "/subscribe") {
      try {
        return await handleSubscribe(request, env, ip);
      } catch {
        return errorPage(400, "Something went wrong processing that request.");
      }
    }

    return errorPage(404, "Not found.");
  },
};
