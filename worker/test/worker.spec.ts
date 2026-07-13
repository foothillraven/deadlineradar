import { env, SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  checkDataFreshness,
  computeSubscriberDeadline,
  nextAnnualMonthEnd,
  nextBirthMonthParityDate,
  StaleDataError,
} from "../src/deadline";
import { hasControlChars, isValidEmail, sanitizeFirstName, strictParseInt } from "../src/validation";
import * as store from "../src/store";
import type { SubscriberRow } from "../src/store";

function form(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

async function postSubscribe(fields: Record<string, string>, ip = "203.0.113.1"): Promise<Response> {
  return SELF.fetch("https://deadline-radar.com/subscribe", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": ip },
    body: form({ hp_website: "", ...fields }),
  });
}

async function getAction(pathAndQuery: string, ip = "203.0.113.1"): Promise<Response> {
  return SELF.fetch(`https://deadline-radar.com${pathAndQuery}`, {
    headers: { "cf-connecting-ip": ip },
  });
}

// Actions are now two-step: GET renders a confirmation page (no state change,
// prefetch-safe), and only this POST performs the action. Takes the same
// `/path?token=XXX` form as getAction and moves the token into the POST body.
async function postAction(pathAndQuery: string, ip = "203.0.113.1"): Promise<Response> {
  const u = new URL(`https://deadline-radar.com${pathAndQuery}`);
  const token = u.searchParams.get("token") ?? "";
  return SELF.fetch(`https://deadline-radar.com${u.pathname}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": ip },
    body: new URLSearchParams({ token }).toString(),
  });
}

async function allSubscribers(): Promise<SubscriberRow[]> {
  const { results } = await env.DB.prepare("SELECT * FROM subscribers").all<SubscriberRow>();
  return results;
}

// Note: the structural claim "no SendGrid/email-provider code path exists
// anywhere in src/" is NOT re-verified here as a grep-based test -- the
// Workers runtime this suite executes in (Miniflare/workerd) has no
// `node:fs` host filesystem access, so a source-scanning test can't run
// inside this same pool. That check was instead run directly against the
// shipped source as part of this build's own review (see the outbox
// report / PHASE1_NOTES.md) -- a plain repo-wide grep for "sendgrid",
// "smtp", "mailgun", "postmark", and "mail/send" across worker/src/
// returned zero matches.

describe("GET /health", () => {
  it("responds ok and bypasses rate limiting", async () => {
    const resp = await getAction("/health");
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ status: "ok" });
  });
});

describe("/api prefix stripping (Workers Route binding)", () => {
  // REGRESSION: this Worker is bound to the deadline-radar.com/api/* Route,
  // so every real request arrives with an /api prefix Cloudflare does NOT
  // strip before invoking the Worker -- unlike the bare-path requests every
  // other test in this file makes directly against SELF.fetch(). Without
  // the strip in index.ts's fetch(), every real request through the actual
  // deployed Route would 404, and this suite's own bare-path tests would
  // never have caught it since they never go through /api at all. Found
  // during this build's own review of what a real deploy actually sees.
  it("GET /api/health behaves identically to /health", async () => {
    const resp = await SELF.fetch("https://deadline-radar.com/api/health", {
      headers: { "cf-connecting-ip": "203.0.113.70" },
    });
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ status: "ok" });
  });

  it("POST /api/subscribe stores a row exactly like POST /subscribe", async () => {
    const email = `api-prefix-${Date.now()}@example.com`;
    const resp = await SELF.fetch("https://deadline-radar.com/api/subscribe", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.71" },
      body: form({ email, state: "georgia", license_type_id: "ga-individual", hp_website: "" }),
    });
    expect(resp.status).toBe(200);
    const row = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?1").bind(email).first<SubscriberRow>();
    expect(row).not.toBeNull();
    expect(row?.status).toBe(store.STATUS_PENDING);
  });

  it("GET /api/confirm renders a page WITHOUT changing state (prefetch-safe); POST confirms", async () => {
    const email = `api-prefix-confirm-${Date.now()}@example.com`;
    await SELF.fetch("https://deadline-radar.com/api/subscribe", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.72" },
      body: form({ email, state: "georgia", license_type_id: "ga-individual", hp_website: "" }),
    });
    const row = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?1").bind(email).first<SubscriberRow>();

    // A GET (what an email link scanner does) must render a page but NOT confirm.
    const getResp = await SELF.fetch(`https://deadline-radar.com/api/confirm?token=${row?.confirm_token}`, {
      headers: { "cf-connecting-ip": "203.0.113.73" },
    });
    expect(getResp.status).toBe(200);
    expect(await getResp.text()).toContain("Confirm my email"); // the button, not a done page
    const afterGet = await env.DB.prepare("SELECT * FROM subscribers WHERE id = ?1").bind(row?.id).first<SubscriberRow>();
    expect(afterGet?.status).toBe(store.STATUS_PENDING); // unchanged by the GET

    // The POST (the human clicking the button) actually confirms.
    const postResp = await SELF.fetch("https://deadline-radar.com/api/confirm", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.73" },
      body: new URLSearchParams({ token: row?.confirm_token ?? "" }).toString(),
    });
    expect(postResp.status).toBe(200);
    const afterPost = await env.DB.prepare("SELECT * FROM subscribers WHERE id = ?1").bind(row?.id).first<SubscriberRow>();
    expect(afterPost?.status).toBe(store.STATUS_CONFIRMED);
  });
});

describe("POST /subscribe -- happy path (capture + confirmation-email path)", () => {
  it("stores a pending_confirmation row and returns the check-your-email success page", async () => {
    const email = `acceptance-${Date.now()}@example.com`;
    const resp = await postSubscribe(
      // Georgia, not Florida -- Florida's individual records were downgraded to
      // an unconfirmed data gap by the 2026-07-05 correctness audit (no longer
      // a computable deadline), so it can no longer stand in as a "happy path,
      // real computed deadline" fixture. Georgia still has a KEEP-verdict date.
      { email, state: "georgia", license_type_id: "ga-individual" },
      "203.0.113.10"
    );
    expect(resp.status).toBe(200);
    const body = await resp.text();
    // The generic, path-uniform success copy (same for real signup, honeypot,
    // cooldown, and dedupe -- so no path is an enumeration oracle). The test
    // env has no SENDGRID_API_KEY, so no email is actually sent here; the copy
    // is deliberately not a literal "we sent it" claim.
    expect(body.toLowerCase()).toContain("check your email");

    const row = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?1").bind(email).first<SubscriberRow>();
    expect(row).not.toBeNull();
    expect(row?.status).toBe(store.STATUS_PENDING);
    expect(row?.state_slug).toBe("georgia");
    expect(JSON.parse(row?.deadline_fields ?? "{}")).toEqual({ license_type_id: "ga-individual" });
    expect(row?.confirm_token).toBeTruthy();
  });
});

describe("POST /subscribe -- validation", () => {
  it("rejects an invalid email", async () => {
    const resp = await postSubscribe({ email: "not-an-email", state: "florida", license_type_id: "fl-individual-odd" }, "203.0.113.11");
    expect(resp.status).toBe(400);
  });

  it("rejects a genuinely unsupported state slug", async () => {
    const resp = await postSubscribe({ email: "a@example.com", state: "atlantis" }, "203.0.113.12");
    expect(resp.status).toBe(400);
  });

  it("rejects control characters in any field", async () => {
    const resp = await SELF.fetch("https://deadline-radar.com/subscribe", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.13" },
      body: `email=a%40example.com&state=florida&license_type_id=fl-individual-odd&hp_website=&first_name=bad%0d%0aname`,
    });
    expect(resp.status).toBe(400);
  });

  it("rejects a license_type_id that can't compute a deadline (probe-before-persist)", async () => {
    const email = `probe-${Date.now()}@example.com`;
    const resp = await postSubscribe({ email, state: "florida", license_type_id: "not-a-real-id" }, "203.0.113.14");
    expect(resp.status).toBe(400);
    const row = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?1").bind(email).first();
    expect(row).toBeNull(); // no orphaned record left behind
  });

  it("rejects a birth_month with trailing garbage instead of silently truncating it (Number.parseInt-leniency regression)", async () => {
    // Found during this port's own adversarial review: Number.parseInt("5abc", 10)
    // === 5, unlike Python's int("5abc") which raises ValueError. Using bare
    // parseInt here would have silently accepted this as month 5 instead of
    // rejecting it the way the Python reference does -- see validation.ts's
    // strictParseInt().
    const resp = await postSubscribe(
      { email: `strictint-${Date.now()}@example.com`, state: "texas", birth_month: "5abc" },
      "203.0.113.16"
    );
    expect(resp.status).toBe(400);
  });

  it("rejects a California birth_month with trailing garbage the same way", async () => {
    const resp = await postSubscribe(
      { email: `strictint-ca-${Date.now()}@example.com`, state: "california", birth_month: "3.5", birth_year: "1990" },
      "203.0.113.17"
    );
    expect(resp.status).toBe(400);
  });

  it("rejects an empty body", async () => {
    const resp = await SELF.fetch("https://deadline-radar.com/subscribe", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.15" },
      body: "",
    });
    expect(resp.status).toBe(400);
  });
});

describe("POST /subscribe -- \"bring your own date\" (uncomputable states)", () => {
  function futureIsoDate(daysFromNow: number): string {
    const d = new Date(Date.now() + daysFromNow * 86_400_000);
    return d.toISOString().slice(0, 10);
  }

  it("rejects an uncomputable state with no date supplied", async () => {
    const resp = await postSubscribe({ email: `byod-nodate-${Date.now()}@example.com`, state: "new-york" }, "203.0.113.40");
    expect(resp.status).toBe(400);
  });

  it("accepts a valid future date for an uncomputable state and stores deadline_source='user'", async () => {
    const email = `byod-valid-${Date.now()}@example.com`;
    const targetDate = futureIsoDate(200);
    const resp = await postSubscribe(
      { email, state: "new-jersey", license_expiration_date: targetDate },
      "203.0.113.41"
    );
    expect(resp.status).toBe(200);
    const row = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?1").bind(email).first<SubscriberRow>();
    expect(row).not.toBeNull();
    expect(row?.deadline_source).toBe("user");
    expect(row?.user_deadline).toBe(targetDate);
  });

  it("rejects a past date", async () => {
    const email = `byod-past-${Date.now()}@example.com`;
    const resp = await postSubscribe(
      { email, state: "new-jersey", license_expiration_date: "2020-01-01" },
      "203.0.113.42"
    );
    expect(resp.status).toBe(400);
    const row = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?1").bind(email).first();
    expect(row).toBeNull();
  });

  it("rejects today's date (must be strictly in the future)", async () => {
    const email = `byod-today-${Date.now()}@example.com`;
    const today = new Date().toISOString().slice(0, 10);
    const resp = await postSubscribe(
      { email, state: "new-jersey", license_expiration_date: today },
      "203.0.113.43"
    );
    expect(resp.status).toBe(400);
  });

  it("rejects a date more than ~3.5 years out", async () => {
    const email = `byod-toofar-${Date.now()}@example.com`;
    const resp = await postSubscribe(
      { email, state: "new-jersey", license_expiration_date: futureIsoDate(1400) },
      "203.0.113.44"
    );
    expect(resp.status).toBe(400);
  });

  it("rejects a malformed date string instead of leniently parsing it", async () => {
    const email = `byod-malformed-${Date.now()}@example.com`;
    const resp = await postSubscribe(
      { email, state: "new-jersey", license_expiration_date: "not-a-date" },
      "203.0.113.45"
    );
    expect(resp.status).toBe(400);
  });

  it("rejects a calendar-invalid date (Feb 30) instead of silently rolling it over", async () => {
    const email = `byod-invalid-cal-${Date.now()}@example.com`;
    const resp = await postSubscribe(
      { email, state: "new-jersey", license_expiration_date: "2027-02-30" },
      "203.0.113.46"
    );
    expect(resp.status).toBe(400);
  });

  it("a computable state ignores a submitted license_expiration_date -- deadline_source stays 'computed'", async () => {
    const email = `byod-ignored-${Date.now()}@example.com`;
    const resp = await postSubscribe(
      { email, state: "georgia", license_type_id: "ga-individual", license_expiration_date: futureIsoDate(100) },
      "203.0.113.47"
    );
    expect(resp.status).toBe(200);
    const row = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?1").bind(email).first<SubscriberRow>();
    expect(row?.deadline_source).toBe("computed");
    expect(row?.user_deadline).toBeNull();
  });
});

describe("POST /subscribe -- honeypot", () => {
  it("silently no-ops when the honeypot field is non-empty", async () => {
    const email = `honeypot-${Date.now()}@example.com`;
    const resp = await SELF.fetch("https://deadline-radar.com/subscribe", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.20" },
      body: form({ email, state: "florida", license_type_id: "fl-individual-odd", hp_website: "im-a-bot" }),
    });
    expect(resp.status).toBe(200); // looks like success to the bot
    const row = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?1").bind(email).first();
    expect(row).toBeNull(); // but nothing was actually created
  });

  it("also treats a whitespace-only honeypot value as a bot (regression: abuse-hardening audit finding)", async () => {
    const email = `honeypot-ws-${Date.now()}@example.com`;
    const resp = await SELF.fetch("https://deadline-radar.com/subscribe", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.21" },
      body: form({ email, state: "florida", license_type_id: "fl-individual-odd", hp_website: " " }),
    });
    expect(resp.status).toBe(200);
    const row = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?1").bind(email).first();
    expect(row).toBeNull();
  });
});

describe("POST /subscribe -- cooldown + dedupe", () => {
  it("a second submission for the same email+state within the cooldown window creates no second row", async () => {
    const email = `dedupe-${Date.now()}@example.com`;
    const ip = "203.0.113.30";
    const first = await postSubscribe({ email, state: "georgia", license_type_id: "ga-individual" }, ip);
    expect(first.status).toBe(200);
    const second = await postSubscribe({ email, state: "georgia", license_type_id: "ga-individual" }, ip);
    expect(second.status).toBe(200);

    const rows = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?1").bind(email).all<SubscriberRow>();
    expect(rows.results.length).toBe(1);
  });

  it("Gmail dot/+tag sub-addressing shares a cooldown key (regression: abuse-hardening audit finding)", async () => {
    const stamp = Date.now();
    const base = `victim.name.${stamp}@gmail.com`;
    const tagged = `victimname${stamp}+promo@gmail.com`;
    const ip = "203.0.113.31";
    // Georgia, not Pennsylvania -- Pennsylvania's source_url 404'd and its date
    // was downgraded to a data gap by the 2026-07-05 correctness audit.
    const first = await postSubscribe({ email: base, state: "georgia", license_type_id: "ga-individual" }, ip);
    expect(first.status).toBe(200);
    const second = await postSubscribe({ email: tagged, state: "georgia", license_type_id: "ga-individual" }, ip);
    expect(second.status).toBe(200);

    // Both submissions resolve to the SAME cooldown_key, so the second must
    // not have created its own separate row.
    const rows = await env.DB.prepare("SELECT * FROM subscribers WHERE cooldown_key = ?1")
      .bind(store.cooldownKey(base))
      .all<SubscriberRow>();
    expect(rows.results.length).toBe(1);
  });

  it("a repeat submission for an existing PENDING email+state still creates no second row, even long after the 24h cooldown window", async () => {
    // Regression for the "lost the first email" gap this migration fixes:
    // findActiveOrPending() has no time bound, so a genuine retry days later
    // must still be recognized as the same pending signup, not slip through
    // and create a duplicate row once the blanket 24h cooldown has expired.
    const email = `stale-pending-${Date.now()}@example.com`;
    const ip = "203.0.113.32";
    const first = await postSubscribe({ email, state: "georgia", license_type_id: "ga-individual" }, ip);
    expect(first.status).toBe(200);
    const firstRow = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?1").bind(email).first<SubscriberRow>();
    expect(firstRow).not.toBeNull();

    // Backdate created_at well past SIGNUP_COOLDOWN_HOURS so the blanket
    // per-identity cooldown alone would no longer block a fresh signup.
    const longAgo = new Date(Date.now() - 72 * 3_600_000).toISOString();
    await env.DB.prepare("UPDATE subscribers SET created_at = ?1 WHERE id = ?2").bind(longAgo, firstRow!.id).run();

    const second = await postSubscribe({ email, state: "georgia", license_type_id: "ga-individual" }, "203.0.113.33");
    expect(second.status).toBe(200);
    const rows = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?1").bind(email).all<SubscriberRow>();
    expect(rows.results.length).toBe(1); // still just the one pending record, not a fresh duplicate
  });

  it("a repeat submission for an existing CONFIRMED email+state creates no second row and needs no resend", async () => {
    const email = `stale-confirmed-${Date.now()}@example.com`;
    const ip = "203.0.113.34";
    const first = await postSubscribe({ email, state: "georgia", license_type_id: "ga-individual" }, ip);
    expect(first.status).toBe(200);
    const row = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?1").bind(email).first<SubscriberRow>();
    await store.confirm(env.DB, row!.confirm_token);

    const second = await postSubscribe({ email, state: "georgia", license_type_id: "ga-individual" }, "203.0.113.35");
    expect(second.status).toBe(200);
    const rows = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?1").bind(email).all<SubscriberRow>();
    expect(rows.results.length).toBe(1);
    expect(rows.results[0]!.status).toBe(store.STATUS_CONFIRMED);
    expect(rows.results[0]!.last_resend_at).toBeNull(); // no resend needed for an already-active subscriber
  });
});

describe("Confirm / unsubscribe / renewed / rearm lifecycle", () => {
  async function signUpAndGetRow(ip: string): Promise<SubscriberRow> {
    const email = `lifecycle-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    // Georgia, not Michigan -- Michigan's date was downgraded to a data gap by
    // the 2026-07-05 correctness audit (conflicting official sources on the
    // renewal month/day), so it can no longer stand in as a computable fixture.
    const resp = await postSubscribe({ email, state: "georgia", license_type_id: "ga-individual" }, ip);
    expect(resp.status).toBe(200);
    const row = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?1").bind(email).first<SubscriberRow>();
    if (!row) throw new Error("test setup failed: no row after signup");
    return row;
  }

  it("confirm moves pending -> confirmed and is idempotent", async () => {
    const row = await signUpAndGetRow("203.0.113.40");
    const resp1 = await postAction(`/confirm?token=${row.confirm_token}`, "203.0.113.41");
    expect(resp1.status).toBe(200);
    const resp2 = await postAction(`/confirm?token=${row.confirm_token}`, "203.0.113.42");
    expect(resp2.status).toBe(200); // clicking twice is a no-op, not an error

    const updated = await env.DB.prepare("SELECT * FROM subscribers WHERE id = ?1").bind(row.id).first<SubscriberRow>();
    expect(updated?.status).toBe(store.STATUS_CONFIRMED);
    expect(updated?.confirmed_at).toBeTruthy();
  });

  it("REGRESSION: a never-confirmed subscriber's renewed_token cannot reach /renewed (double-opt-in bypass)", async () => {
    const row = await signUpAndGetRow("203.0.113.43");
    // row is still pending_confirmation -- confirm_token was never used.
    const resp = await postAction(`/renewed?token=${row.renewed_token}`, "203.0.113.44");
    expect(resp.status).toBe(404);
    const updated = await env.DB.prepare("SELECT * FROM subscribers WHERE id = ?1").bind(row.id).first<SubscriberRow>();
    expect(updated?.status).toBe(store.STATUS_PENDING); // unchanged
  });

  it("unsubscribe on a still-pending record is honored (kills the pending signup)", async () => {
    const row = await signUpAndGetRow("203.0.113.45");
    const resp = await postAction(`/unsubscribe?token=${row.unsubscribe_token}`, "203.0.113.46");
    expect(resp.status).toBe(200);
    const updated = await env.DB.prepare("SELECT * FROM subscribers WHERE id = ?1").bind(row.id).first<SubscriberRow>();
    expect(updated?.status).toBe(store.STATUS_STOPPED);
    expect(updated?.stop_reason).toBe("unsubscribed");
  });

  it("full confirm -> renewed -> rearm -> renewed-again cycle", async () => {
    const row = await signUpAndGetRow("203.0.113.47");
    await postAction(`/confirm?token=${row.confirm_token}`, "203.0.113.48");

    const renewedResp = await postAction(`/renewed?token=${row.renewed_token}`, "203.0.113.49");
    expect(renewedResp.status).toBe(200);
    let updated = await env.DB.prepare("SELECT * FROM subscribers WHERE id = ?1").bind(row.id).first<SubscriberRow>();
    expect(updated?.status).toBe(store.STATUS_STOPPED);
    expect(updated?.stop_reason).toBe("renewed");

    const rearmResp = await postAction(`/rearm?token=${updated?.unsubscribe_token}`, "203.0.113.50");
    expect(rearmResp.status).toBe(200);
    updated = await env.DB.prepare("SELECT * FROM subscribers WHERE id = ?1").bind(row.id).first<SubscriberRow>();
    expect(updated?.status).toBe(store.STATUS_CONFIRMED);
    expect(updated?.cycle).toBe(2);

    // Old unsubscribe token is now stale (rotated on rearm) -- a repeat
    // /rearm with it must fail, not silently re-arm again.
    const staleRearm = await postAction(`/rearm?token=${row.unsubscribe_token}`, "203.0.113.51");
    expect(staleRearm.status).toBe(404);
  });

  it("BYOD: refuses to re-arm a user-provided-date subscriber rather than reactivating a stale date", async () => {
    const email = `byod-rearm-${Date.now()}@example.com`;
    const rec = await store.addPending(env.DB, {
      email,
      stateSlug: "new-jersey",
      deadlineFields: {},
      firstName: null,
      deadlineSource: "user",
      userDeadline: "2026-07-31",
    });
    await postAction(`/confirm?token=${rec.confirm_token}`, "203.0.113.52");

    const renewedResp = await postAction(`/renewed?token=${rec.renewed_token}`, "203.0.113.53");
    expect(renewedResp.status).toBe(200);
    const stopped = await env.DB.prepare("SELECT * FROM subscribers WHERE id = ?1").bind(rec.id).first<SubscriberRow>();
    expect(stopped?.status).toBe(store.STATUS_STOPPED);
    expect(stopped?.stop_reason).toBe("renewed");

    // Same otherwise-eligible link a computed-state subscriber's rearm would
    // succeed with -- this one must be refused specifically because
    // deadline_source='user', with a tailored 400 (not the generic 404
    // "invalid or already used").
    const rearmResp = await postAction(`/rearm?token=${stopped?.unsubscribe_token}`, "203.0.113.54");
    expect(rearmResp.status).toBe(400);
    const rearmBody = await rearmResp.text();
    expect(rearmBody.toLowerCase()).toContain("sign up again");

    const afterRearmAttempt = await env.DB.prepare("SELECT * FROM subscribers WHERE id = ?1").bind(rec.id).first<SubscriberRow>();
    expect(afterRearmAttempt?.status).toBe(store.STATUS_STOPPED); // never reactivated
    expect(afterRearmAttempt?.cycle).toBe(1); // never incremented
  });
});

describe("Permanent suppression (store.isPermanentlySuppressed) -- Phase 2 readiness, unit-tested directly", () => {
  // Not wired into any Phase-1 route (the Python original only calls this
  // from scheduler.py's send loop, which Phase 1 does not deploy) --
  // ported now so Phase 2's scheduler port is a drop-in, not new logic.
  it("suppresses after an unsubscribe with no later confirm", async () => {
    const email = `suppress-${Date.now()}@example.com`;
    await store.addPending(env.DB, { email, stateSlug: "illinois", deadlineFields: { license_type_id: "il-individual" }, firstName: null });
    const row = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?1").bind(email).first<SubscriberRow>();
    await store.confirm(env.DB, row!.confirm_token);
    await store.stop(env.DB, row!.unsubscribe_token, "unsubscribed");
    expect(await store.isPermanentlySuppressed(env.DB, email)).toBe(true);
  });

  it("lifts suppression after a genuine later re-confirm (regression: over-broad suppression bug)", async () => {
    const email = `unsuppress-${Date.now()}@example.com`;
    await store.addPending(env.DB, { email, stateSlug: "illinois", deadlineFields: { license_type_id: "il-individual" }, firstName: null });
    let row = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?1").bind(email).first<SubscriberRow>();
    await store.confirm(env.DB, row!.confirm_token);
    await store.stop(env.DB, row!.unsubscribe_token, "unsubscribed");
    expect(await store.isPermanentlySuppressed(env.DB, email)).toBe(true);

    // A fresh signup + a REAL confirm click is the subscriber re-initiating
    // consent -- must lift the suppression.
    await store.addPending(env.DB, { email, stateSlug: "pennsylvania", deadlineFields: { license_type_id: "pa-individual" }, firstName: null });
    row = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?1 AND state_slug = ?2").bind(email, "pennsylvania").first<SubscriberRow>();
    await store.confirm(env.DB, row!.confirm_token);
    expect(await store.isPermanentlySuppressed(env.DB, email)).toBe(false);
  });

  // Regression test for an adversarial-review finding: an earlier version of
  // isPermanentlySuppressed() ran `SELECT ... FROM subscribers` with NO
  // WHERE clause at all, then filtered by normalized email in JavaScript --
  // a full-table scan on every call. It was dead code at review time (no
  // Phase-1 route calls it), but would not have scaled once Phase 2 wires
  // the scheduler to it. This asserts the actual SQLite query plan uses the
  // idx_subscribers_email_normalized expression index (migration 0003)
  // instead of scanning every row.
  it("looks up by an indexed expression, not a full table scan (regression: full-table-scan finding)", async () => {
    const { results } = await env.DB
      .prepare(
        `EXPLAIN QUERY PLAN SELECT stop_reason, stopped_at, confirmed_at, email FROM subscribers
         WHERE LOWER(TRIM(email)) = ?1`
      )
      .bind("plan-check@example.com")
      .all<{ detail: string }>();
    const plan = results.map((r) => r.detail).join(" | ");
    expect(plan).toMatch(/USING INDEX idx_subscribers_email_normalized/);
    expect(plan).not.toMatch(/SCAN subscribers(?!.*USING INDEX)/);
  });

  // The old JS-side filter compared via normalizeEmail() on both sides, so
  // casing/whitespace differences between signup-time and lookup-time email
  // never mattered. Pushing the filter into SQL (LOWER(TRIM(email)) = ?1,
  // binding the JS-normalized value) must preserve that -- this guards the
  // refactor itself, not just the original bug.
  it("still matches case-insensitively now that filtering happens in SQL, not JS", async () => {
    const storedEmail = `CaseTest-${Date.now()}@Example.COM`;
    await store.addPending(env.DB, {
      email: storedEmail,
      stateSlug: "illinois",
      deadlineFields: { license_type_id: "il-individual" },
      firstName: null,
    });
    const row = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?1").bind(storedEmail).first<SubscriberRow>();
    await store.confirm(env.DB, row!.confirm_token);
    await store.stop(env.DB, row!.unsubscribe_token, "unsubscribed");
    expect(await store.isPermanentlySuppressed(env.DB, storedEmail.toLowerCase())).toBe(true);
    expect(await store.isPermanentlySuppressed(env.DB, `  ${storedEmail.toUpperCase()}  `)).toBe(true);
  });
});

describe("markReminderSent / allConfirmedActive (Phase 2 drop-in readiness)", () => {
  it("markReminderSent appends a threshold once and is idempotent", async () => {
    const email = `markremind-${Date.now()}@example.com`;
    await store.addPending(env.DB, { email, stateSlug: "illinois", deadlineFields: { license_type_id: "il-individual" }, firstName: null });
    const row = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?1").bind(email).first<SubscriberRow>();
    await store.markReminderSent(env.DB, row!.id, 30);
    await store.markReminderSent(env.DB, row!.id, 30); // repeat -- must not duplicate
    await store.markReminderSent(env.DB, row!.id, 14);
    const updated = await env.DB.prepare("SELECT * FROM subscribers WHERE id = ?1").bind(row!.id).first<SubscriberRow>();
    expect(JSON.parse(updated!.reminders_sent)).toEqual([30, 14]);
  });

  it("allConfirmedActive returns only status=confirmed subscribers", async () => {
    const email = `allactive-${Date.now()}@example.com`;
    await store.addPending(env.DB, { email, stateSlug: "illinois", deadlineFields: { license_type_id: "il-individual" }, firstName: null });
    const pendingRow = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?1").bind(email).first<SubscriberRow>();
    let active = await store.allConfirmedActive(env.DB);
    expect(active.some((r) => r.id === pendingRow!.id)).toBe(false); // still pending -- excluded

    await store.confirm(env.DB, pendingRow!.confirm_token);
    active = await store.allConfirmedActive(env.DB);
    expect(active.some((r) => r.id === pendingRow!.id)).toBe(true);
  });
});

describe("addPending re-sanitizes first_name independently (defense-in-depth, store.py parity)", () => {
  it("caps an oversized first_name even if the caller forgot to", async () => {
    const email = `firstname-${Date.now()}@example.com`;
    const oversized = "A".repeat(200);
    await store.addPending(env.DB, { email, stateSlug: "illinois", deadlineFields: { license_type_id: "il-individual" }, firstName: oversized });
    const row = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?1").bind(email).first<SubscriberRow>();
    expect(row?.first_name?.length).toBe(60);
  });
});

describe("Rate limiting (D1-backed, atomic insert-if-under-limit)", () => {
  it("blocks the 6th /subscribe from the same IP within the window", async () => {
    const ip = "203.0.113.60";
    for (let i = 0; i < 5; i++) {
      const resp = await postSubscribe({ email: `ratelimit-${i}-${Date.now()}@example.com`, state: "georgia", license_type_id: "ga-individual" }, ip);
      expect(resp.status).not.toBe(429);
    }
    const sixth = await postSubscribe({ email: `ratelimit-6-${Date.now()}@example.com`, state: "georgia", license_type_id: "ga-individual" }, ip);
    expect(sixth.status).toBe(429);
  });

  it("blocks the 31st GET action from the same IP within the window", async () => {
    const ip = "203.0.113.61";
    for (let i = 0; i < 30; i++) {
      const resp = await getAction("/confirm?token=nonexistent", ip);
      expect(resp.status).not.toBe(429);
    }
    const thirtyFirst = await getAction("/confirm?token=nonexistent", ip);
    expect(thirtyFirst.status).toBe(429);
  });
});

// ---------------------------------------------------------------------------
// Pure-function unit tests -- no D1/HTTP involved.
// ---------------------------------------------------------------------------
describe("validation.ts", () => {
  it("isValidEmail rejects control characters and malformed addresses", () => {
    expect(isValidEmail("a@b.com")).toBe(true);
    expect(isValidEmail("not-an-email")).toBe(false);
    expect(isValidEmail("a@b.com\r\nBcc: evil@x.com")).toBe(false);
    expect(hasControlChars("a\x00b")).toBe(true);
  });

  it("sanitizeFirstName strips control/non-printable chars and caps length", () => {
    expect(sanitizeFirstName("  David  ")).toBe("David");
    expect(sanitizeFirstName("")).toBeNull();
    expect(sanitizeFirstName("A".repeat(100))?.length).toBe(60);
  });

  it("strictParseInt matches Python int() semantics, unlike Number.parseInt", () => {
    expect(strictParseInt("5")).toBe(5);
    expect(strictParseInt(" 5 ")).toBe(5);
    expect(strictParseInt("-3")).toBe(-3);
    expect(strictParseInt("5abc")).toBeNull(); // Number.parseInt("5abc", 10) would be 5
    expect(strictParseInt("5.5")).toBeNull();
    expect(strictParseInt("")).toBeNull();
    expect(strictParseInt("0x10")).toBeNull();
  });
});

describe("deadlines.ts", () => {
  it("nextBirthMonthParityDate returns the next matching-parity month-end after asOf", () => {
    const asOf = new Date("2026-07-03T00:00:00Z");
    const d = nextBirthMonthParityDate(asOf, 3, "odd");
    expect(d.getUTCFullYear() % 2).toBe(1);
    expect(d.getUTCMonth()).toBe(2); // March, 0-indexed
    expect(d.getTime()).toBeGreaterThan(asOf.getTime());
  });

  it("nextAnnualMonthEnd rolls to next year once this year's date has passed", () => {
    const asOf = new Date("2026-07-03T00:00:00Z");
    const d = nextAnnualMonthEnd(asOf, 1); // January -- already passed this year
    expect(d.getUTCFullYear()).toBe(2027);
  });

  it("computeSubscriberDeadline resolves Ohio cohort groups and rejects unknown ones", () => {
    const asOf = new Date("2026-07-03T00:00:00Z");
    expect(computeSubscriberDeadline("ohio", { cohort_group: "Group 1" }, asOf)).not.toBeNull();
    expect(computeSubscriberDeadline("ohio", { cohort_group: "Group 9" }, asOf)).toBeNull();
  });

  it("checkDataFreshness throws StaleDataError once data is older than the threshold", () => {
    const farFuture = new Date("2030-01-01T00:00:00Z");
    expect(() => checkDataFreshness(farFuture)).toThrow(StaleDataError);
    expect(() => checkDataFreshness(new Date("2026-07-05T00:00:00Z"))).not.toThrow();
  });
});

describe("store.ts cooldownKey", () => {
  it("folds Gmail dot and +tag sub-addressing to the same key", () => {
    expect(store.cooldownKey("Victim.Name+promo@Gmail.com")).toBe(store.cooldownKey("victimname@gmail.com"));
  });
  it("does not fold across different domains", () => {
    expect(store.cooldownKey("a.b@gmail.com")).not.toBe(store.cooldownKey("a.b@other.com"));
  });
});

describe("store.ts resendEligible / recordResend", () => {
  it("is eligible when never resent and count is 0", () => {
    expect(store.resendEligible({ last_resend_at: null, resend_count: 0 }, new Date())).toBe(true);
  });

  it("refuses a resend within RESEND_COOLDOWN_MINUTES of the last one", () => {
    const now = new Date();
    const fiveMinAgo = new Date(now.getTime() - 5 * 60_000).toISOString();
    expect(store.resendEligible({ last_resend_at: fiveMinAgo, resend_count: 1 }, now)).toBe(false);
  });

  it("is eligible again once RESEND_COOLDOWN_MINUTES has fully elapsed, under the count cap", () => {
    const now = new Date();
    const twentyMinAgo = new Date(now.getTime() - 20 * 60_000).toISOString();
    expect(store.resendEligible({ last_resend_at: twentyMinAgo, resend_count: 1 }, now)).toBe(true);
  });

  it("is refused exactly at the boundary and eligible just past it", () => {
    const now = new Date();
    const exactlyAtCooldown = new Date(now.getTime() - store.RESEND_COOLDOWN_MINUTES * 60_000).toISOString();
    expect(store.resendEligible({ last_resend_at: exactlyAtCooldown, resend_count: 1 }, now)).toBe(true);
    const oneMsShy = new Date(now.getTime() - store.RESEND_COOLDOWN_MINUTES * 60_000 + 1).toISOString();
    expect(store.resendEligible({ last_resend_at: oneMsShy, resend_count: 1 }, now)).toBe(false);
  });

  it("refuses once resend_count reaches RESEND_MAX_ATTEMPTS, even long after the time cooldown", () => {
    // The abuse case this guards against: without a total cap, an attacker
    // who already has a victim's pending record could keep requesting
    // resends every RESEND_COOLDOWN_MINUTES forever -- this path never
    // re-triggers the broader per-identity SIGNUP_COOLDOWN_HOURS check (see
    // index.ts), so the time throttle alone would be an unbounded-over-time
    // mail-bombing vector, unlike a brand-new signup.
    const now = new Date();
    const longAgo = new Date(now.getTime() - 30 * 24 * 3_600_000).toISOString(); // 30 days
    expect(store.resendEligible({ last_resend_at: longAgo, resend_count: store.RESEND_MAX_ATTEMPTS }, now)).toBe(
      false
    );
    expect(
      store.resendEligible({ last_resend_at: longAgo, resend_count: store.RESEND_MAX_ATTEMPTS - 1 }, now)
    ).toBe(true);
  });

  it("recordResend sets last_resend_at and increments resend_count on the real row", async () => {
    const row = await store.addPending(env.DB, {
      email: `resend-record-${Date.now()}@example.com`,
      stateSlug: "georgia",
      deadlineFields: { license_type_id: "ga-individual" },
      firstName: null,
    });
    expect(row.last_resend_at).toBeNull();
    expect(row.resend_count).toBe(0);
    await store.recordResend(env.DB, row.id);
    await store.recordResend(env.DB, row.id);
    const updated = await env.DB.prepare("SELECT * FROM subscribers WHERE id = ?1").bind(row.id).first<SubscriberRow>();
    expect(updated?.last_resend_at).toBeTruthy();
    expect(updated?.resend_count).toBe(2);
  });
});

describe("sender.ts checkAndCountSend -- daily circuit breaker", () => {
  it("allows sends up to the cap, then refuses every further send that UTC day", async () => {
    const { checkAndCountSend } = await import("../src/sender");
    const cap = 3;
    const results: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      results.push(await checkAndCountSend(env.DB, cap));
    }
    // First `cap` allowed, everything after refused -- protects sender
    // reputation from a burst blowing past the daily cap.
    expect(results).toEqual([true, true, true, false, false]);
  });
});

describe("emails.ts buildConfirmationEmail", () => {
  it("builds a subject, both bodies, the confirm link, and a real CAN-SPAM address", async () => {
    const { buildConfirmationEmail, MAILING_ADDRESS } = await import("../src/emails");
    const built = buildConfirmationEmail(
      "California",
      "https://deadline-radar.com/api/confirm?token=abc",
      "https://deadline-radar.com/api/unsubscribe?token=xyz",
      "Devin"
    );
    expect(built.subject).toContain("California");
    expect(built.htmlBody).toContain("https://deadline-radar.com/api/confirm?token=abc");
    expect(built.textBody).toContain("https://deadline-radar.com/api/unsubscribe?token=xyz");
    expect(built.htmlBody).toContain(MAILING_ADDRESS);
    expect(built.htmlBody).toContain("Hi Devin,");
    // No marketing claim, and the unsubscribe promise is present.
    expect(built.textBody.toLowerCase()).toContain("unsubscribe");
  });

  it("BYOD: echoes the user's chosen date when provided, omits it when not", async () => {
    const { buildConfirmationEmail } = await import("../src/emails");
    const withDate = buildConfirmationEmail(
      "New Jersey",
      "https://deadline-radar.com/api/confirm?token=abc",
      "https://deadline-radar.com/api/unsubscribe?token=xyz",
      null,
      "January 21, 2027"
    );
    expect(withDate.textBody).toContain("We'll remind you before January 21, 2027.");
    expect(withDate.htmlBody).toContain("We'll remind you before January 21, 2027.");

    const withoutDate = buildConfirmationEmail(
      "New Jersey",
      "https://deadline-radar.com/api/confirm?token=abc",
      "https://deadline-radar.com/api/unsubscribe?token=xyz"
    );
    expect(withoutDate.textBody).not.toContain("We'll remind you before");
  });
});

describe("scheduler.ts nextDueThreshold -- escalation logic", () => {
  it("returns the nearest newly-due threshold", async () => {
    const { nextDueThreshold } = await import("../src/scheduler");
    expect(nextDueThreshold(45, [])).toBe(60); // 45<=60, nearest not-yet-sent
    expect(nextDueThreshold(10, [60, 30])).toBe(14);
    expect(nextDueThreshold(2, [60, 30, 14, 7])).toBe(3);
    expect(nextDueThreshold(100, [])).toBeNull(); // nothing due yet
  });
  it("never regresses to a less-urgent tier after a more-urgent one fired", async () => {
    const { nextDueThreshold } = await import("../src/scheduler");
    // 1-day already sent; a scheduler gap now evaluates at 3 days remaining.
    // Must NOT send the 3-day tier after the 1-day already went out.
    expect(nextDueThreshold(3, [1])).toBeNull();
    expect(nextDueThreshold(6, [7])).toBeNull(); // 7 sent -> never send 14/30/60 after
  });
});

describe("scheduler.ts runReminderPass -- one pass", () => {
  it("sends exactly one reminder to a confirmed subscriber whose deadline is newly due", async () => {
    const { runReminderPass } = await import("../src/scheduler");
    const email = `sched-tx-${Date.now()}@example.com`;
    const rec = await store.addPending(env.DB, {
      email,
      stateSlug: "texas",
      deadlineFields: { birth_month: "7" }, // TX deadline = end of July
      firstName: "Tester",
    });
    await store.confirm(env.DB, rec.confirm_token);

    const sends: { to: string; subject: string }[] = [];
    // asOf = July 24 2026 -> TX deadline July 31 2026 -> 7 days remaining -> tier 7.
    const summary = await runReminderPass(env, {
      asOf: new Date(Date.UTC(2026, 6, 24)),
      send: async (to, built) => {
        sends.push({ to, subject: built.subject });
        return true;
      },
    });

    expect(summary.errors).toEqual([]);
    const mine = sends.find((s) => s.to === email);
    expect(mine).toBeTruthy();
    expect(mine?.subject).toContain("Texas");
    expect(mine?.subject).toContain("7 days");

    const row = await env.DB.prepare("SELECT reminders_sent FROM subscribers WHERE id = ?1").bind(rec.id).first<{ reminders_sent: string }>();
    expect(JSON.parse(row?.reminders_sent ?? "[]")).toContain(7);
  });

  it("does not re-send a threshold already recorded", async () => {
    const { runReminderPass } = await import("../src/scheduler");
    const email = `sched-tx2-${Date.now()}@example.com`;
    const rec = await store.addPending(env.DB, {
      email,
      stateSlug: "texas",
      deadlineFields: { birth_month: "7" },
      firstName: "Tester",
    });
    await store.confirm(env.DB, rec.confirm_token);
    await store.markReminderSent(env.DB, rec.id, 7); // pretend the 7-day already went

    const sends: string[] = [];
    await runReminderPass(env, {
      asOf: new Date(Date.UTC(2026, 6, 24)), // still 7 days out
      send: async (to) => {
        sends.push(to);
        return true;
      },
    });
    // 7 already sent, and no more-urgent tier is due yet (7 days out) -> no send.
    expect(sends).not.toContain(email);
  });

  it("fires a reminder off a user-provided deadline, skipping computeSubscriberDeadline entirely (BYOD)", async () => {
    const { runReminderPass } = await import("../src/scheduler");
    const email = `sched-byod-${Date.now()}@example.com`;
    // new-jersey is UNCOMPUTABLE -- computeSubscriberDeadline(state_slug, ...)
    // would return null for it. If the scheduler still fires the correct
    // tier below, that proves it used the stored user_deadline directly and
    // never fell through to the (would-be-null) computed path.
    const rec = await store.addPending(env.DB, {
      email,
      stateSlug: "new-jersey",
      deadlineFields: {},
      firstName: "Tester",
      deadlineSource: "user",
      userDeadline: "2026-07-31",
    });
    await store.confirm(env.DB, rec.confirm_token);

    const sends: { to: string; subject: string }[] = [];
    // asOf = July 24 2026 -> stored user_deadline July 31 2026 -> 7 days remaining -> tier 7.
    const summary = await runReminderPass(env, {
      asOf: new Date(Date.UTC(2026, 6, 24)),
      send: async (to, built) => {
        sends.push({ to, subject: built.subject });
        return true;
      },
    });

    expect(summary.errors).toEqual([]);
    // The strong proof this test exists for: new-jersey is uncomputable, so
    // if the scheduler had fallen through to computeSubscriberDeadline()
    // instead of using the stored user_deadline, THIS subscriber specifically
    // would have been skipped_no_deadline and never sent -- it wasn't.
    const mine = sends.find((s) => s.to === email);
    expect(mine).toBeTruthy();
    expect(mine?.subject).toContain("7 days");

    const row = await env.DB.prepare("SELECT reminders_sent FROM subscribers WHERE id = ?1").bind(rec.id).first<{ reminders_sent: string }>();
    expect(JSON.parse(row?.reminders_sent ?? "[]")).toContain(7);
  });
});

describe("Staleness guard -- real HTTP + cron code paths, not just checkDataFreshness() in isolation", () => {
  // checkDataFreshness() deliberately judges freshness against the REAL wall
  // clock even when a caller supplies a simulated `asOf` (scheduler.ts:88-92)
  // -- a caller can never talk its way past the guard. That's the right
  // security property, but it means proving the guard actually PAUSES the
  // live signup endpoint and the live cron handler (not just that the pure
  // function throws in isolation, which worker.spec.ts already covered above)
  // requires actually moving the system clock, not passing a parameter.
  it("POST /subscribe returns 503 'temporarily paused' once as_of_date is more than 30 days old", async () => {
    vi.useFakeTimers();
    try {
      // data/cpa_deadlines.json's as_of_date is 2026-07-05 at the time of this
      // audit; 2026-09-01 is 58 days later, well past the 30-day threshold.
      vi.setSystemTime(new Date("2026-09-01T00:00:00Z"));
      const resp = await postSubscribe(
        { email: `stale-guard-${Date.now()}@example.com`, state: "texas", birth_month: "7" },
        "203.0.113.90"
      );
      expect(resp.status).toBe(503);
      const body = await resp.text();
      expect(body).toContain("temporarily paused");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not persist a subscriber row when the staleness guard refuses the signup", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-01T00:00:00Z"));
      const email = `stale-guard-nowrite-${Date.now()}@example.com`;
      await postSubscribe({ email, state: "texas", birth_month: "7" }, "203.0.113.91");
      const row = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?1").bind(email).first();
      expect(row).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("the reminder cron's runReminderPass() throws StaleDataError (not a silent send) once as_of_date ages out", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-01T00:00:00Z"));
      const { runReminderPass } = await import("../src/scheduler");
      await expect(runReminderPass(env)).rejects.toThrow(StaleDataError);
    } finally {
      vi.useRealTimers();
    }
  });

  it("scheduled() (the actual Worker cron entrypoint) swallows the stale-data pause and does not throw out of the handler", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-01T00:00:00Z"));
      const worker = (await import("../src/index")).default;
      const logs: string[] = [];
      const logSpy = vi.spyOn(console, "log").mockImplementation((msg: unknown) => {
        logs.push(String(msg));
      });
      const waited: Promise<unknown>[] = [];
      const ctx = { waitUntil: (p: Promise<unknown>) => waited.push(p) } as unknown as ExecutionContext;
      const envWithKey = { ...env, SENDGRID_API_KEY: "test-key-not-real" };
      await expect(
        worker.scheduled({} as ScheduledController, envWithKey, ctx)
      ).resolves.not.toThrow();
      await Promise.all(waited);
      logSpy.mockRestore();
      expect(logs.some((l) => l.includes("[reminder-cron] paused") && l.includes("stale reference data"))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("emails.ts buildStopConfirmationEmail", () => {
  it("renewed: includes the re-arm button + link and a real address", async () => {
    const { buildStopConfirmationEmail, MAILING_ADDRESS } = await import("../src/emails");
    const built = buildStopConfirmationEmail(
      "renewed",
      "California",
      "https://deadline-radar.com/api/rearm?token=abc",
      "https://deadline-radar.com/api/unsubscribe?token=xyz",
      "Devin"
    );
    expect(built.subject.toLowerCase()).toContain("no more reminders");
    expect(built.htmlBody).toContain("Remind me next time");
    expect(built.htmlBody).toContain("https://deadline-radar.com/api/rearm?token=abc");
    expect(built.textBody).toContain("https://deadline-radar.com/api/rearm?token=abc");
    expect(built.htmlBody).toContain(MAILING_ADDRESS);
    expect(built.htmlBody).toContain("Hi Devin,");
  });
  it("unsubscribed: goodbye, no re-arm button", async () => {
    const { buildStopConfirmationEmail } = await import("../src/emails");
    const built = buildStopConfirmationEmail("unsubscribed", "Texas", null, "https://deadline-radar.com/api/unsubscribe?token=xyz");
    expect(built.subject.toLowerCase()).toContain("unsubscribed");
    expect(built.htmlBody).not.toContain("Remind me next time");
  });
});

describe("prefetch-safe actions + List-Unsubscribe", () => {
  it("emails carry RFC 8058 one-click List-Unsubscribe headers", async () => {
    const { buildConfirmationEmail, buildReminderEmail } = await import("../src/emails");
    const conf = buildConfirmationEmail("California", "https://deadline-radar.com/api/confirm?token=c", "https://deadline-radar.com/api/unsubscribe?token=u");
    expect(conf.headers["List-Unsubscribe"]).toBe("<https://deadline-radar.com/api/unsubscribe?token=u>");
    expect(conf.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    const rem = buildReminderEmail("California", "July 31, 2026", 30, 30, "https://deadline-radar.com/api/renewed?token=r", "https://deadline-radar.com/api/unsubscribe?token=u");
    expect(rem.headers["List-Unsubscribe"]).toContain("token=u");
  });

  it("one-click unsubscribe: POST with token in the URL query (List-Unsubscribe=One-Click body) unsubscribes", async () => {
    const email = `oneclick-${Date.now()}@example.com`;
    await SELF.fetch("https://deadline-radar.com/api/subscribe", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.90" },
      body: form({ email, state: "georgia", license_type_id: "ga-individual", hp_website: "" }),
    });
    const row = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?1").bind(email).first<SubscriberRow>();
    const resp = await SELF.fetch(`https://deadline-radar.com/api/unsubscribe?token=${row?.unsubscribe_token}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.91" },
      body: "List-Unsubscribe=One-Click",
    });
    expect(resp.status).toBe(200);
    const updated = await env.DB.prepare("SELECT * FROM subscribers WHERE id = ?1").bind(row?.id).first<SubscriberRow>();
    expect(updated?.status).toBe(store.STATUS_STOPPED);
    expect(updated?.stop_reason).toBe("unsubscribed");
  });
});
