import { env, SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  checkDataFreshness,
  computeSubscriberDeadline,
  nextAnnualMonthEnd,
  nextBirthMonthParityDate,
  StaleDataError,
} from "../src/deadline";
import {
  hasControlChars,
  isValidEmail,
  RATE_LIMIT_FIRM_LICENSE_CREATE,
  sanitizeFirstName,
  strictParseInt,
} from "../src/validation";
import * as store from "../src/store";
import type { FirmLeadRow, FirmRow, SubscriberRow } from "../src/store";

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

async function postFirmLead(fields: Record<string, string>, ip = "203.0.113.1"): Promise<Response> {
  return SELF.fetch("https://deadline-radar.com/firm/lead", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": ip },
    body: form({ hp_website: "", ...fields }),
  });
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

describe("POST /firm/lead -- firm-tier early-access capture", () => {
  it("happy path: stores a firm_leads row and returns a generic success page", async () => {
    const email = `firmlead-${Date.now()}@example.com`;
    const resp = await postFirmLead(
      { email, firm_name: "Example Firm, LLC", staff_count_hint: "8" },
      "203.0.113.90"
    );
    expect(resp.status).toBe(200);
    const body = await resp.text();
    expect(body.toLowerCase()).toContain("on the list");

    const row = await env.DB.prepare("SELECT * FROM firm_leads WHERE email = ?1").bind(email).first<FirmLeadRow>();
    expect(row).not.toBeNull();
    expect(row?.firm_name).toBe("Example Firm, LLC");
    expect(row?.staff_count_hint).toBe("8");
    expect(row?.created_at).toBeTruthy();
    expect(row?.converted_at).toBeNull();
  });

  it("accepts a submission with no firm name or staff count hint (both optional)", async () => {
    const email = `firmlead-minimal-${Date.now()}@example.com`;
    const resp = await postFirmLead({ email }, "203.0.113.95");
    expect(resp.status).toBe(200);
    const row = await env.DB.prepare("SELECT * FROM firm_leads WHERE email = ?1").bind(email).first<FirmLeadRow>();
    expect(row).not.toBeNull();
    expect(row?.firm_name).toBeNull();
    expect(row?.staff_count_hint).toBeNull();
  });

  it("silently no-ops when the honeypot field is non-empty (same anti-enumeration posture as /subscribe)", async () => {
    const email = `firmlead-hp-${Date.now()}@example.com`;
    const resp = await SELF.fetch("https://deadline-radar.com/firm/lead", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.91" },
      body: form({ email, firm_name: "Bot Firm", hp_website: "im-a-bot" }),
    });
    expect(resp.status).toBe(200); // looks like success to the bot
    const row = await env.DB.prepare("SELECT * FROM firm_leads WHERE email = ?1").bind(email).first();
    expect(row).toBeNull(); // but nothing was actually created
  });

  it("rejects a malformed email", async () => {
    const resp = await postFirmLead({ email: "not-an-email", firm_name: "Example Firm" }, "203.0.113.92");
    expect(resp.status).toBe(400);
    const row = await env.DB.prepare("SELECT * FROM firm_leads WHERE firm_name = ?1").bind("Example Firm").first();
    expect(row).toBeNull();
  });

  it("rejects control characters in any field", async () => {
    const resp = await SELF.fetch("https://deadline-radar.com/firm/lead", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.93" },
      body: `email=a%40example.com&firm_name=bad%0d%0aname&hp_website=`,
    });
    expect(resp.status).toBe(400);
  });

  it("rejects an empty body", async () => {
    const resp = await SELF.fetch("https://deadline-radar.com/firm/lead", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.96" },
      body: "",
    });
    expect(resp.status).toBe(400);
  });

  it("blocks the 6th /firm/lead from the same IP within the window (own rate-limit bucket, separate from /subscribe's)", async () => {
    const ip = "203.0.113.94";
    for (let i = 0; i < 5; i++) {
      const resp = await postFirmLead(
        { email: `firmlead-rl-${i}-${Date.now()}@example.com`, firm_name: "Example Firm" },
        ip
      );
      expect(resp.status).not.toBe(429);
    }
    const sixth = await postFirmLead(
      { email: `firmlead-rl-6-${Date.now()}@example.com`, firm_name: "Example Firm" },
      ip
    );
    expect(sixth.status).toBe(429);
  });
});

// migration 0008 -- firm accounts + login/session auth. This is the repo's
// FIRST real login system; every helper/test below follows this file's own
// existing conventions (explicit per-test IP so the shared rate-limit
// buckets never collide across unrelated tests, generic-response
// anti-enumeration assertions matching the /subscribe and /firm/lead
// suites above).
async function postFirmSignup(fields: Record<string, string>, ip: string): Promise<Response> {
  return SELF.fetch("https://deadline-radar.com/firm/signup", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": ip },
    body: form({ hp_website: "", ...fields }),
  });
}

async function postFirmLogin(fields: Record<string, string>, ip: string): Promise<Response> {
  return SELF.fetch("https://deadline-radar.com/firm/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": ip },
    body: form({ hp_website: "", ...fields }),
  });
}

async function getFirmLoginVerifyPage(token: string | null, ip: string): Promise<Response> {
  const query = token !== null ? `?token=${encodeURIComponent(token)}` : "";
  return SELF.fetch(`https://deadline-radar.com/firm/login/verify${query}`, {
    headers: { "cf-connecting-ip": ip },
    redirect: "manual",
  });
}

// The GET only renders the confirm page (render-only, prefetch-safe -- see
// handleFirmLoginVerify()'s docstring); this POSTs the token from the form
// body, same as the confirm-page button would, which is what actually
// verifies+consumes the token and creates the session.
async function postFirmLoginVerify(token: string | null, ip: string): Promise<Response> {
  return SELF.fetch("https://deadline-radar.com/firm/login/verify", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": ip },
    body: form(token !== null ? { token } : {}),
    redirect: "manual",
  });
}

async function postFirmLogout(cookie: string | null, ip: string): Promise<Response> {
  const headers: Record<string, string> = { "cf-connecting-ip": ip };
  if (cookie) headers["Cookie"] = cookie;
  return SELF.fetch("https://deadline-radar.com/firm/logout", { method: "POST", headers, redirect: "manual" });
}

function cookieValue(setCookieHeader: string | null, name: string): string | null {
  if (!setCookieHeader) return null;
  const match = new RegExp(`${name}=([^;]*)`).exec(setCookieHeader);
  return match ? decodeURIComponent(match[1] as string) : null;
}

async function firmByAdminEmail(email: string): Promise<FirmRow | null> {
  return (await env.DB.prepare("SELECT * FROM firms WHERE admin_email = ?1").bind(email).first<FirmRow>()) ?? null;
}

describe("POST /firm/signup -- firm account creation + login-link send", () => {
  it("happy path: creates a firm, creates an unused login token, and returns the generic 'check your email' page", async () => {
    const email = `firmsignup-${Date.now()}@example.com`;
    const resp = await postFirmSignup({ name: "Example CPA Firm", admin_email: email }, "203.0.113.150");
    expect(resp.status).toBe(200);
    const body = await resp.text();
    expect(body.toLowerCase()).toContain("check your email");

    const firm = await firmByAdminEmail(email);
    expect(firm).not.toBeNull();
    expect(firm?.name).toBe("Example CPA Firm");
    expect(firm?.plan_tier).toBe("pilot");
    expect(firm?.status).toBe("active");

    const tokenRow = await env.DB
      .prepare("SELECT * FROM firm_login_tokens WHERE firm_id = ?1")
      .bind(firm?.id)
      .first<{ used_at: string | null; expires_at: string }>();
    expect(tokenRow).not.toBeNull();
    expect(tokenRow?.used_at).toBeNull();
  });

  it("a repeat signup for an email that already has a firm does NOT create a second firm (anti-enumeration)", async () => {
    const email = `firmsignup-dup-${Date.now()}@example.com`;
    const first = await postFirmSignup({ name: "First Name", admin_email: email }, "203.0.113.151");
    expect(first.status).toBe(200);
    const firstBody = await first.text();

    const second = await postFirmSignup({ name: "Second Name Attempt", admin_email: email }, "203.0.113.152");
    expect(second.status).toBe(200);
    const secondBody = await second.text();
    expect(secondBody).toBe(firstBody); // byte-identical response -- no enumeration oracle

    const rows = await env.DB.prepare("SELECT * FROM firms WHERE admin_email = ?1").bind(email).all<FirmRow>();
    expect(rows.results.length).toBe(1);
    expect(rows.results[0]?.name).toBe("First Name"); // unchanged by the second attempt
  });

  it("rejects an empty/whitespace-only firm name", async () => {
    const resp = await postFirmSignup(
      { name: "   ", admin_email: `firmsignup-noname-${Date.now()}@example.com` },
      "203.0.113.153"
    );
    expect(resp.status).toBe(400);
  });

  it("silently no-ops when the honeypot field is non-empty", async () => {
    const email = `firmsignup-hp-${Date.now()}@example.com`;
    const resp = await SELF.fetch("https://deadline-radar.com/firm/signup", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.154" },
      body: form({ name: "Bot Firm", admin_email: email, hp_website: "im-a-bot" }),
    });
    expect(resp.status).toBe(200);
    expect(await firmByAdminEmail(email)).toBeNull();
  });

  it("rejects control characters in any field", async () => {
    const resp = await SELF.fetch("https://deadline-radar.com/firm/signup", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.155" },
      body: "name=bad%0d%0aname&admin_email=a%40example.com&hp_website=",
    });
    expect(resp.status).toBe(400);
  });

  it("rejects a malformed email", async () => {
    const resp = await postFirmSignup({ name: "Example Firm", admin_email: "not-an-email" }, "203.0.113.156");
    expect(resp.status).toBe(400);
  });

  it("blocks the 6th request from the same IP within the window (own rate-limit bucket)", async () => {
    const ip = "203.0.113.157";
    for (let i = 0; i < 5; i++) {
      const resp = await postFirmSignup(
        { name: "Example Firm", admin_email: `firmsignup-rl-${i}-${Date.now()}@example.com` },
        ip
      );
      expect(resp.status).not.toBe(429);
    }
    const sixth = await postFirmSignup(
      { name: "Example Firm", admin_email: `firmsignup-rl-6-${Date.now()}@example.com` },
      ip
    );
    expect(sixth.status).toBe(429);
  });
});

// Trial gate. POLICY CHANGED 2026-07-30: free consumer-email providers are
// now ALLOWED; only disposable/temp-mail domains and named competitors are
// refused. Competitive research across 14 products found every free-email
// block in this market sits on a sales-routing form, and the AICPA itself --
// selling self-serve to individual CPAs -- blocks only disposable domains.
// Accounting is full of solo practitioners with no custom domain, so the old
// list was turning away real buyers to protect a sales step we don't have.
describe("POST /firm/signup -- trial gate (disposable + competitor domains)", () => {
  it("ALLOWS a Gmail signup -- solo practitioners are real customers (policy reversed 2026-07-30)", async () => {
    const email = `trialgate-gmail-${Date.now()}@gmail.com`;
    const resp = await postFirmSignup({ name: "Solo CPA", admin_email: email }, "203.0.113.170");
    expect(resp.status).toBe(200);
    expect(await firmByAdminEmail(email)).not.toBeNull();
  });

  it("ALLOWS every consumer-email provider the old list blocked, including Microsoft's", async () => {
    // outlook/hotmail/live were blocked while the product strategy targeted
    // an "M365-heavy" audience -- turning away Microsoft-identity users at
    // the door.
    const domains = ["gmail.com", "Yahoo.com", "OUTLOOK.COM", "icloud.com", "aol.com", "hotmail.com"];
    for (const [i, domain] of domains.entries()) {
      const email = `trialgate-consumer-${i}-${Date.now()}@${domain}`;
      const resp = await postFirmSignup(
        { name: "Some Firm", admin_email: email },
        `203.0.113.${180 + i}`
      );
      expect(resp.status).toBe(200);
    }
  });

  it("rejects a disposable/temp-mail domain -- it cannot receive the reminders this product exists to send", async () => {
    const email = `trialgate-disposable-${Date.now()}@mailinator.com`;
    const resp = await postFirmSignup({ name: "Throwaway", admin_email: email }, "203.0.113.176");
    expect(resp.status).toBe(400);
    expect(await firmByAdminEmail(email)).toBeNull();
  });

  it("rejects the two disposable domains the AICPA itself blocks, case-insensitively", async () => {
    const domains = ["gufum.com", "YOPMAIL.COM"];
    for (const [i, domain] of domains.entries()) {
      const email = `trialgate-disp-${i}-${Date.now()}@${domain}`;
      const resp = await postFirmSignup({ name: "Some Firm", admin_email: email }, `203.0.113.${200 + i}`);
      expect(resp.status).toBe(400);
    }
  });

  it("rejects a named competitor domain and creates no firm", async () => {
    const email = `trialgate-competitor-${Date.now()}@certemy.com`;
    const resp = await postFirmSignup({ name: "Certemy Employee", admin_email: email }, "203.0.113.171");
    expect(resp.status).toBe(400);
    expect(await firmByAdminEmail(email)).toBeNull();
  });

  it("rejects every named competitor domain (cpaqualitypro/certemy/harborcompliance/copliancy)", async () => {
    const domains = ["cpaqualitypro.com", "certemy.com", "harborcompliance.com", "copliancy.com"];
    for (const [i, domain] of domains.entries()) {
      const email = `trialgate-comp-${i}-${Date.now()}@${domain}`;
      const resp = await postFirmSignup(
        { name: "Some Firm", admin_email: email },
        `203.0.113.${190 + i}`
      );
      expect(resp.status).toBe(400);
    }
  });

  it("blocks a real subdomain of a blocked domain (subdomain bypass attempt)", async () => {
    const email = `trialgate-subdomain-${Date.now()}@mail.mailinator.com`;
    const resp = await postFirmSignup({ name: "Some Firm", admin_email: email }, "203.0.113.172");
    expect(resp.status).toBe(400);
    expect(await firmByAdminEmail(email)).toBeNull();
  });

  it("does NOT block a legitimate business domain that merely contains a blocked name as a prefix (false-positive check)", async () => {
    const email = `trialgate-notdisp-${Date.now()}@mailinator.com.someconsultancy.com`;
    const resp = await postFirmSignup({ name: "Some Consultancy LLC", admin_email: email }, "203.0.113.173");
    expect(resp.status).toBe(200);
    expect(await firmByAdminEmail(email)).not.toBeNull();
  });

  it("allows a normal business domain through to the existing happy path", async () => {
    const email = `trialgate-legit-${Date.now()}@example-cpa-firm.com`;
    const resp = await postFirmSignup({ name: "Legit CPA Firm", admin_email: email }, "203.0.113.174");
    expect(resp.status).toBe(200);
    const body = await resp.text();
    expect(body.toLowerCase()).toContain("check your email");
    expect(await firmByAdminEmail(email)).not.toBeNull();
  });

  it("exempts an address on env.EMAIL_ALLOWLIST from the blocked-domain gate (preview/staging tester convenience)", async () => {
    const worker = (await import("../src/index")).default;
    const email = `trialgate-allowlisted-tester-${Date.now()}@gmail.com`;
    const envWithAllowlist = { ...env, EMAIL_ALLOWLIST: `${email}, someone-else@example.com` };
    const request = new Request("https://deadline-radar.com/firm/signup", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.176" },
      body: new URLSearchParams({ name: "Allowlisted Tester Firm", admin_email: email, hp_website: "" }).toString(),
    });
    const resp = await worker.fetch(request, envWithAllowlist);
    expect(resp.status).toBe(200);
    expect(await firmByAdminEmail(email)).not.toBeNull();
  });

  it("an allowlisted domain gate exemption does NOT also exempt a DIFFERENT blocked-domain email not on the list", async () => {
    const worker = (await import("../src/index")).default;
    const allowlistedEmail = `trialgate-allowlisted-other-${Date.now()}@mailinator.com`;
    const notAllowlistedEmail = `trialgate-not-allowlisted-${Date.now()}@mailinator.com`;
    const envWithAllowlist = { ...env, EMAIL_ALLOWLIST: allowlistedEmail };
    const request = new Request("https://deadline-radar.com/firm/signup", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.177" },
      body: new URLSearchParams({ name: "Some Firm", admin_email: notAllowlistedEmail, hp_website: "" }).toString(),
    });
    const resp = await worker.fetch(request, envWithAllowlist);
    expect(resp.status).toBe(400);
    expect(await firmByAdminEmail(notAllowlistedEmail)).toBeNull();
  });

  it("does NOT block a repeat /firm/signup submission for an email that already has a firm, even on a blocked domain", async () => {
    // Adversarial-RE-QA-driven case: the gate must not regress this
    // codebase's existing "repeat signup for an existing email just resends
    // the login link" behavior -- including for an account that happens to
    // sit on a now-blocked domain (e.g. a solo practitioner whose only
    // email is on a now-blocked domain, or any account that predates this
    // gate). Insert a firm directly under a blocked domain, then hit
    // /firm/signup again for that exact email and confirm it succeeds with
    // the normal generic response, not a 400.
    const email = `trialgate-existing-signup-${Date.now()}@gmail.com`;
    const firmId = crypto.randomUUID();
    await env.DB
      .prepare(
        "INSERT INTO firms (id, name, admin_email, plan_tier, status, created_at) VALUES (?1, ?2, ?3, 'pilot', 'active', datetime('now'))"
      )
      .bind(firmId, "Preexisting Gmail Firm", email)
      .run();

    const resp = await postFirmSignup({ name: "Preexisting Gmail Firm", admin_email: email }, "203.0.113.178");
    expect(resp.status).toBe(200);
    const body = await resp.text();
    expect(body.toLowerCase()).toContain("check your email");

    // Confirms it's really the SAME firm row reused, not blocked-then-
    // silently-recreated under a different id.
    const rows = await env.DB.prepare("SELECT * FROM firms WHERE admin_email = ?1").bind(email).all<FirmRow>();
    expect(rows.results.length).toBe(1);
    expect(rows.results[0]?.id).toBe(firmId);
  });

  it("a genuinely NEW signup attempt on a blocked domain is still rejected even after an unrelated firm already exists on that same domain", async () => {
    // Guards against a sloppy "any firm on this domain" check instead of the
    // correct per-EMAIL existing-account check -- two different people at the
    // same free-email provider must not let one's account exempt the other.
    const existingEmail = `trialgate-domain-a-${Date.now()}@mailinator.com`;
    await env.DB
      .prepare(
        "INSERT INTO firms (id, name, admin_email, plan_tier, status, created_at) VALUES (?1, ?2, ?3, 'pilot', 'active', datetime('now'))"
      )
      .bind(crypto.randomUUID(), "Someone Else's Firm", existingEmail)
      .run();

    const newEmail = `trialgate-domain-b-${Date.now()}@mailinator.com`;
    const resp = await postFirmSignup({ name: "A Different New Firm", admin_email: newEmail }, "203.0.113.179");
    expect(resp.status).toBe(400);
    expect(await firmByAdminEmail(newEmail)).toBeNull();
  });

  it("is NOT applied to /firm/login -- an existing account on a blocked domain can still sign back in", async () => {
    // Insert a firm directly (simulating a pre-gate account, or any edge case
    // where a firm already exists under a domain now on the blocklist) and
    // confirm /firm/login still works for it -- the gate only protects new
    // trial creation via /firm/signup, never blocks existing access.
    const email = `trialgate-preexisting-${Date.now()}@gmail.com`;
    const firmId = crypto.randomUUID();
    await env.DB
      .prepare(
        "INSERT INTO firms (id, name, admin_email, plan_tier, status, created_at) VALUES (?1, ?2, ?3, 'pilot', 'active', datetime('now'))"
      )
      .bind(firmId, "Preexisting Gmail Firm", email)
      .run();

    const before = await env.DB
      .prepare("SELECT COUNT(*) as c FROM firm_login_tokens WHERE firm_id = ?1")
      .bind(firmId)
      .first<{ c: number }>();
    const resp = await postFirmLogin({ admin_email: email }, "203.0.113.175");
    expect(resp.status).toBe(200);
    const after = await env.DB
      .prepare("SELECT COUNT(*) as c FROM firm_login_tokens WHERE firm_id = ?1")
      .bind(firmId)
      .first<{ c: number }>();
    expect((after?.c ?? 0)).toBeGreaterThan(before?.c ?? 0); // a fresh login token WAS issued
  });
});

describe("POST /firm/login -- login-link resend for an existing firm", () => {
  it("for a nonexistent email returns the SAME generic response as a real firm, and creates nothing", async () => {
    const email = `firmlogin-none-${Date.now()}@example.com`;
    const resp = await postFirmLogin({ admin_email: email }, "203.0.113.160");
    expect(resp.status).toBe(200);
    const body = await resp.text();
    expect(body.toLowerCase()).toContain("check your email");
    expect(await firmByAdminEmail(email)).toBeNull();
  });

  it("2026-07-30 UX fix: body is BYTE-IDENTICAL for an existing firm vs. a nonexistent email -- the new nav links must not become a new enumeration oracle", async () => {
    const existingEmail = `firmlogin-identical-existing-${Date.now()}@example.com`;
    await postFirmSignup({ name: "Identical Body Firm", admin_email: existingEmail }, "203.0.113.166");

    const respExisting = await postFirmLogin({ admin_email: existingEmail }, "203.0.113.167");
    const respNone = await postFirmLogin({ admin_email: `firmlogin-identical-none-${Date.now()}@example.com` }, "203.0.113.168");

    expect(respExisting.status).toBe(200);
    expect(respNone.status).toBe(200);
    expect(await respExisting.text()).toBe(await respNone.text());
  });

  it("2026-07-30 UX fix: includes a link to the create-account form and a way back to the homepage (relative, production default)", async () => {
    const email = `firmlogin-navlinks-${Date.now()}@example.com`;
    const resp = await postFirmLogin({ admin_email: email }, "203.0.113.171");
    const body = await resp.text();
    expect(body).toContain('href="/firm-login/"');
    expect(body).toContain('href="/"');
  });

  it("2026-07-30 UX fix: nav links are absolute to STATIC_SITE_BASE_URL when set (preview), for BOTH an existing firm and a nonexistent email", async () => {
    const worker = (await import("../src/index")).default;
    const envPreview = { ...env, STATIC_SITE_BASE_URL: "https://deadlineradar-preview.pages.dev" };

    const existingEmail = `firmlogin-navlinks-preview-existing-${Date.now()}@example.com`;
    await postFirmSignup({ name: "Preview Navlinks Firm", admin_email: existingEmail }, "203.0.113.173");
    const requestExisting = new Request("https://deadline-radar.com/firm/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.174" },
      body: form({ admin_email: existingEmail }),
    });
    const bodyExisting = await (await worker.fetch(requestExisting, envPreview)).text();

    const requestNone = new Request("https://deadline-radar.com/firm/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.175" },
      body: form({ admin_email: `firmlogin-navlinks-preview-none-${Date.now()}@example.com` }),
    });
    const bodyNone = await (await worker.fetch(requestNone, envPreview)).text();

    for (const body of [bodyExisting, bodyNone]) {
      expect(body).toContain('href="https://deadlineradar-preview.pages.dev/firm-login/"');
      expect(body).toContain('href="https://deadlineradar-preview.pages.dev/"');
    }
    expect(bodyExisting).toBe(bodyNone);
  });

  it("for an existing firm issues a fresh login token (on top of the one signup already created)", async () => {
    const email = `firmlogin-existing-${Date.now()}@example.com`;
    await postFirmSignup({ name: "Existing Firm", admin_email: email }, "203.0.113.161");
    const firm = await firmByAdminEmail(email);
    const before = await env.DB
      .prepare("SELECT COUNT(*) as c FROM firm_login_tokens WHERE firm_id = ?1")
      .bind(firm?.id)
      .first<{ c: number }>();

    const resp = await postFirmLogin({ admin_email: email }, "203.0.113.162");
    expect(resp.status).toBe(200);

    const after = await env.DB
      .prepare("SELECT COUNT(*) as c FROM firm_login_tokens WHERE firm_id = ?1")
      .bind(firm?.id)
      .first<{ c: number }>();
    expect(after?.c).toBe((before?.c ?? 0) + 1);
  });

  it("silently no-ops when the honeypot field is non-empty", async () => {
    const email = `firmlogin-hp-${Date.now()}@example.com`;
    const resp = await SELF.fetch("https://deadline-radar.com/firm/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.163" },
      body: form({ admin_email: email, hp_website: "im-a-bot" }),
    });
    expect(resp.status).toBe(200);
  });

  it("rejects a malformed email", async () => {
    const resp = await postFirmLogin({ admin_email: "not-an-email" }, "203.0.113.164");
    expect(resp.status).toBe(400);
  });

  it("blocks the 6th request from the same IP within the window (own rate-limit bucket, separate from signup's)", async () => {
    const ip = "203.0.113.165";
    for (let i = 0; i < 5; i++) {
      const resp = await postFirmLogin({ admin_email: `firmlogin-rl-${i}-${Date.now()}@example.com` }, ip);
      expect(resp.status).not.toBe(429);
    }
    const sixth = await postFirmLogin({ admin_email: `firmlogin-rl-6-${Date.now()}@example.com` }, ip);
    expect(sixth.status).toBe(429);
  });
});

describe("GET /firm/login/verify -- render-only confirm page, prefetch-safe", () => {
  it("renders a confirm page with a POST form and does NOT consume the token or set a cookie", async () => {
    const email = `firmverify-render-${Date.now()}@example.com`;
    await postFirmSignup({ name: "Render Firm", admin_email: email }, "203.0.113.169");
    const firm = await firmByAdminEmail(email);
    const { rawToken } = await store.createLoginToken(env.DB, firm!.id);

    const resp = await getFirmLoginVerifyPage(rawToken, "203.0.113.169");
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Set-Cookie")).toBeNull();
    const body = await resp.text();
    expect(body.toLowerCase()).toContain("sign in");
    expect(body).toContain(`name="token" value="${rawToken}"`);
    expect(body).toContain('method="post"');

    // Token must still be unused -- rendering the page must not consume it.
    const sameTokenPostLater = await postFirmLoginVerify(rawToken, "203.0.113.169");
    expect(sameTokenPostLater.status).toBe(302); // still valid, consumed here for the first time
  });
});

describe("POST /firm/login/verify -- consumes the login token, creates a session, sets the cookie", () => {
  it("a valid raw login token creates a session, sets the dr_firm_session cookie, and redirects to /firm-dashboard/", async () => {
    const email = `firmverify-${Date.now()}@example.com`;
    await postFirmSignup({ name: "Verify Firm", admin_email: email }, "203.0.113.170");
    const firm = await firmByAdminEmail(email);
    const { rawToken } = await store.createLoginToken(env.DB, firm!.id);

    const resp = await postFirmLoginVerify(rawToken, "203.0.113.171");
    expect(resp.status).toBe(302);
    expect(resp.headers.get("Location")).toBe("/firm-dashboard/");
    const setCookie = resp.headers.get("Set-Cookie");
    expect(setCookie).toBeTruthy();
    expect(setCookie).toContain("dr_firm_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Max-Age=2592000"); // 30 days in seconds

    const rawSession = cookieValue(setCookie, "dr_firm_session");
    expect(rawSession).toBeTruthy();
    const sessionCheck = await store.verifySession(env.DB, rawSession as string);
    expect(sessionCheck?.firmId).toBe(firm!.id);
  });

  it("the SAME raw token cannot be used twice (single-use)", async () => {
    const email = `firmverify-reuse-${Date.now()}@example.com`;
    await postFirmSignup({ name: "Reuse Firm", admin_email: email }, "203.0.113.172");
    const firm = await firmByAdminEmail(email);
    const { rawToken } = await store.createLoginToken(env.DB, firm!.id);

    const first = await postFirmLoginVerify(rawToken, "203.0.113.173");
    expect(first.status).toBe(302);

    const second = await postFirmLoginVerify(rawToken, "203.0.113.174");
    expect(second.status).toBe(400);
    const body = await second.text();
    expect(body.toLowerCase()).toContain("invalid");
  });

  it("an expired token is rejected", async () => {
    const email = `firmverify-expired-${Date.now()}@example.com`;
    await postFirmSignup({ name: "Expired Firm", admin_email: email }, "203.0.113.175");
    const firm = await firmByAdminEmail(email);
    const { rawToken } = await store.createLoginToken(env.DB, firm!.id);
    const tokenHash = await store.hashToken(rawToken);
    // Force it into the past -- simulates 15+ minutes elapsed without waiting.
    await env.DB
      .prepare("UPDATE firm_login_tokens SET expires_at = ?1 WHERE token_hash = ?2")
      .bind(new Date(Date.now() - 1000).toISOString(), tokenHash)
      .run();

    const resp = await postFirmLoginVerify(rawToken, "203.0.113.176");
    expect(resp.status).toBe(400);
    const body = await resp.text();
    expect(body.toLowerCase()).toContain("expired");
  });

  it("a malformed/unknown token is rejected", async () => {
    const resp = await postFirmLoginVerify("this-token-does-not-exist", "203.0.113.177");
    expect(resp.status).toBe(400);
  });

  it("a missing token returns 400", async () => {
    const resp = await postFirmLoginVerify(null, "203.0.113.178");
    expect(resp.status).toBe(400);
  });
});

describe("POST /firm/logout -- deletes the session and clears the cookie", () => {
  it("deletes the session row and clears the cookie; the old raw token no longer authenticates", async () => {
    const email = `firmlogout-${Date.now()}@example.com`;
    await postFirmSignup({ name: "Logout Firm", admin_email: email }, "203.0.113.180");
    const firm = await firmByAdminEmail(email);
    const { rawSessionToken } = await store.createSession(env.DB, firm!.id);

    const before = await store.verifySession(env.DB, rawSessionToken);
    expect(before?.firmId).toBe(firm!.id);

    const resp = await postFirmLogout(`dr_firm_session=${rawSessionToken}`, "203.0.113.181");
    expect(resp.status).toBe(302);
    const setCookie = resp.headers.get("Set-Cookie");
    expect(setCookie).toContain("Max-Age=0");

    const after = await store.verifySession(env.DB, rawSessionToken);
    expect(after).toBeNull();
  });

  it("is a safe no-op when there's no session cookie at all", async () => {
    const resp = await postFirmLogout(null, "203.0.113.182");
    expect(resp.status).toBe(302);
  });
});

describe("requireFirmSession -- the single auth gate every future firm-scoped route must call first", () => {
  it("rejects a request with no session cookie", async () => {
    const { requireFirmSession } = await import("../src/index");
    const request = new Request("https://deadline-radar.com/firm-dashboard/");
    const result = await requireFirmSession(request, env);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(401);
  });

  it("rejects a request with a garbage/unknown session cookie", async () => {
    const { requireFirmSession } = await import("../src/index");
    const request = new Request("https://deadline-radar.com/firm-dashboard/", {
      headers: { Cookie: "dr_firm_session=not-a-real-token" },
    });
    const result = await requireFirmSession(request, env);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(401);
  });

  it("rejects an expired session cookie", async () => {
    const { requireFirmSession } = await import("../src/index");
    const firmId = (
      await store.createFirm(env.DB, { name: "Expired Session Firm", adminEmail: `expsess-${Date.now()}@example.com` })
    ).id;
    const { rawSessionToken } = await store.createSession(env.DB, firmId);
    const tokenHash = await store.hashToken(rawSessionToken);
    await env.DB
      .prepare("UPDATE firm_sessions SET expires_at = ?1 WHERE session_token_hash = ?2")
      .bind(new Date(Date.now() - 1000).toISOString(), tokenHash)
      .run();

    const request = new Request("https://deadline-radar.com/firm-dashboard/", {
      headers: { Cookie: `dr_firm_session=${rawSessionToken}` },
    });
    const result = await requireFirmSession(request, env);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(401);
  });

  it("accepts a valid, current session cookie and resolves the correct firmId", async () => {
    const { requireFirmSession } = await import("../src/index");
    const firmId = (
      await store.createFirm(env.DB, { name: "Valid Session Firm", adminEmail: `validsess-${Date.now()}@example.com` })
    ).id;
    const { rawSessionToken } = await store.createSession(env.DB, firmId);

    const request = new Request("https://deadline-radar.com/firm-dashboard/", {
      headers: { Cookie: `dr_firm_session=${rawSessionToken}` },
    });
    const result = await requireFirmSession(request, env);
    expect(result).not.toBeInstanceOf(Response);
    expect((result as { firmId: string }).firmId).toBe(firmId);
  });

  it("picks the session cookie out from among other unrelated cookies on the request", async () => {
    const { requireFirmSession } = await import("../src/index");
    const firmId = (
      await store.createFirm(env.DB, { name: "Multi Cookie Firm", adminEmail: `multicookie-${Date.now()}@example.com` })
    ).id;
    const { rawSessionToken } = await store.createSession(env.DB, firmId);

    const request = new Request("https://deadline-radar.com/firm-dashboard/", {
      headers: { Cookie: `some_other_cookie=xyz; dr_firm_session=${rawSessionToken}; another=1` },
    });
    const result = await requireFirmSession(request, env);
    expect(result).not.toBeInstanceOf(Response);
    expect((result as { firmId: string }).firmId).toBe(firmId);
  });
});

describe("store.ts hashToken -- login/session token hashing", () => {
  it("is deterministic and never contains the raw value it hashed", async () => {
    const raw = "some-raw-token-value";
    const h1 = await store.hashToken(raw);
    const h2 = await store.hashToken(raw);
    expect(h1).toBe(h2);
    expect(h1).not.toContain(raw);
    expect(h1).toMatch(/^[0-9a-f]{64}$/); // hex-encoded SHA-256
  });

  it("different inputs hash differently", async () => {
    const h1 = await store.hashToken("token-a");
    const h2 = await store.hashToken("token-b");
    expect(h1).not.toBe(h2);
  });
});

// ---------------------------------------------------------------------------
// Firm-dashboard MVP (2026-07-28, step 2/3) -- staff license CRUD,
// /firm/licenses*. Helpers below create a real firm + a real logged-in
// session (bypassing the login-link email flow, same shortcut the
// requireFirmSession() describe block above already takes) so every test
// exercises the ACTUAL HTTP routes end-to-end, not just store.ts functions.
// ---------------------------------------------------------------------------

async function createFirmWithSession(name: string, adminEmail: string): Promise<{ firmId: string; cookie: string }> {
  const firm = await store.createFirm(env.DB, { name, adminEmail });
  const { rawSessionToken } = await store.createSession(env.DB, firm.id);
  return { firmId: firm.id, cookie: `dr_firm_session=${rawSessionToken}` };
}

async function getFirmLicenses(cookie: string | null, ip = "203.0.113.200"): Promise<Response> {
  const headers: Record<string, string> = { "cf-connecting-ip": ip };
  if (cookie) headers["Cookie"] = cookie;
  return SELF.fetch("https://deadline-radar.com/firm/licenses", { headers });
}

async function postFirmLicense(
  cookie: string | null,
  body: Record<string, string>,
  ip = "203.0.113.200"
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json", "cf-connecting-ip": ip };
  if (cookie) headers["Cookie"] = cookie;
  return SELF.fetch("https://deadline-radar.com/firm/licenses", { method: "POST", headers, body: JSON.stringify(body) });
}

async function patchFirmLicense(
  cookie: string | null,
  id: string,
  body: Record<string, string>,
  ip = "203.0.113.200"
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json", "cf-connecting-ip": ip };
  if (cookie) headers["Cookie"] = cookie;
  return SELF.fetch(`https://deadline-radar.com/firm/licenses/${id}`, { method: "PATCH", headers, body: JSON.stringify(body) });
}

async function deleteFirmLicense(cookie: string | null, id: string, ip = "203.0.113.200"): Promise<Response> {
  const headers: Record<string, string> = { "cf-connecting-ip": ip };
  if (cookie) headers["Cookie"] = cookie;
  return SELF.fetch(`https://deadline-radar.com/firm/licenses/${id}`, { method: "DELETE", headers });
}

async function renewFirmLicense(cookie: string | null, id: string, ip = "203.0.113.200"): Promise<Response> {
  const headers: Record<string, string> = { "cf-connecting-ip": ip };
  if (cookie) headers["Cookie"] = cookie;
  return SELF.fetch(`https://deadline-radar.com/firm/licenses/${id}/renew`, { method: "POST", headers });
}

describe("GET/POST/PATCH/DELETE /firm/licenses -- staff license CRUD (firm-dashboard MVP)", () => {
  it("every route 401s without a session cookie", async () => {
    expect((await getFirmLicenses(null)).status).toBe(401);
    expect((await postFirmLicense(null, { email: "a@example.com", state_slug: "georgia" })).status).toBe(401);
    expect((await patchFirmLicense(null, "nonexistent", { staff_label: "x" })).status).toBe(401);
    expect((await deleteFirmLicense(null, "nonexistent")).status).toBe(401);
    expect((await renewFirmLicense(null, "nonexistent")).status).toBe(401);
  });

  it("happy path (HYBRID consent model, 2026-07-28): POST creates an ACTIVE staff license immediately -- no pending-confirmation gate on the firm path -- and sends the transparent first-contact email with a one-click opt-out instead of a confirm link", async () => {
    const { cookie } = await createFirmWithSession("Roster Firm", `roster-${Date.now()}@example.com`);
    const staffEmail = `staff-${Date.now()}@example.com`;
    const resp = await postFirmLicense(cookie, {
      staff_label: "Jane D. -- Audit team",
      email: staffEmail,
      state_slug: "georgia",
      license_type_id: "ga-individual",
    });
    expect(resp.status).toBe(201);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.staff_label).toBe("Jane D. -- Audit team");
    expect(body.status).toBe("active");

    const row = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?1").bind(staffEmail).first<SubscriberRow>();
    expect(row).not.toBeNull();
    expect(row?.firm_id).not.toBeNull();
    expect(row?.staff_label).toBe("Jane D. -- Audit team");
    expect(row?.status).toBe(store.STATUS_CONFIRMED); // ACTIVE immediately, not pending
    expect(row?.confirmed_at).toBeTruthy();
    expect(row?.confirm_token).toBeTruthy(); // still generated (schema requires it), just never emailed
    // No first_name was supplied by the admin -- this is the ADMIN's label
    // for the person, deliberately distinct from first_name.
    expect(row?.first_name).toBeNull();
  });

  it("GET /firm/licenses exposes created_at/confirmed_at/stopped_at/stop_reason for the dashboard's activity panel (2026-07-30, BUILD v2 Phase B), scoped to the caller's own firm only", async () => {
    const { cookie: cookieA } = await createFirmWithSession("Timestamps Firm A", `ts-firm-a-${Date.now()}@example.com`);
    const { cookie: cookieB } = await createFirmWithSession("Timestamps Firm B", `ts-firm-b-${Date.now()}@example.com`);
    const staffEmail = `staff-ts-${Date.now()}@example.com`;
    const created = await postFirmLicense(cookieA, {
      staff_label: "Timestamp Test",
      email: staffEmail,
      state_slug: "georgia",
      license_type_id: "ga-individual",
    });
    expect(created.status).toBe(201);

    const listA = (await (await getFirmLicenses(cookieA)).json()) as { licenses: Array<Record<string, unknown>> };
    const item = listA.licenses.find((l) => l.email === staffEmail);
    expect(item).toBeTruthy();
    expect(typeof item?.created_at).toBe("string");
    expect(item?.created_at).toBeTruthy();
    expect(typeof item?.confirmed_at).toBe("string"); // HYBRID model: confirmed immediately
    expect(item?.stopped_at).toBeNull();
    expect(item?.stop_reason).toBeNull();
    // No fabricated "renewed_at" -- this schema has no such fact yet (see
    // toFirmLicenseJson()'s own comment), so the field must not exist at all
    // rather than exist as an invented/null placeholder that could later be
    // mistaken for real data.
    expect(item).not.toHaveProperty("renewed_at");

    // Firm B's roster must never see firm A's staff or their timestamps.
    const listB = (await (await getFirmLicenses(cookieB)).json()) as { licenses: Array<Record<string, unknown>> };
    expect(listB.licenses.find((l) => l.email === staffEmail)).toBeUndefined();
  });

  it("stopped_at/stop_reason are populated once a staffer opts out, and stay scoped to the owning firm only (adversarial-review-driven, 2026-07-30)", async () => {
    // The prior test only proved the new fields exist on a fresh, never-
    // stopped row -- an independent adversarial review correctly flagged
    // that as the weaker case: the activity panel's whole point is showing
    // an opt-out event, so that's the state that actually needs a cross-firm
    // proof, not just the happy path.
    const { cookie: cookieA } = await createFirmWithSession("Optout Firm A", `optout-a-${Date.now()}@example.com`);
    const { cookie: cookieB } = await createFirmWithSession("Optout Firm B", `optout-b-${Date.now()}@example.com`);
    const staffEmail = `staff-optout-${Date.now()}@example.com`;
    const created = await postFirmLicense(cookieA, {
      staff_label: "Opts Out",
      email: staffEmail,
      state_slug: "georgia",
      license_type_id: "ga-individual",
    });
    const { id } = (await created.json()) as { id: string };
    const row = await env.DB.prepare("SELECT * FROM subscribers WHERE id = ?1").bind(id).first<SubscriberRow>();
    // The transparent first-contact email's one-click opt-out uses the same
    // unsubscribe_token + store.stop() path every other opt-out in this repo
    // uses -- exercising that real path rather than hand-writing stop_reason
    // directly, so this proves the actual transition, not just the schema.
    await store.stop(env.DB, row!.unsubscribe_token, "unsubscribed");

    const listA = (await (await getFirmLicenses(cookieA)).json()) as { licenses: Array<Record<string, unknown>> };
    const itemA = listA.licenses.find((l) => l.email === staffEmail);
    expect(itemA?.status).toBe("opted_out");
    expect(typeof itemA?.stopped_at).toBe("string");
    expect(itemA?.stopped_at).toBeTruthy();
    expect(itemA?.stop_reason).toBe("unsubscribed");

    // Firm B must never see firm A's opted-out staffer or their stop timestamp.
    const listB = (await (await getFirmLicenses(cookieB)).json()) as { licenses: Array<Record<string, unknown>> };
    expect(listB.licenses.find((l) => l.email === staffEmail)).toBeUndefined();
  });

  it("GET /firm/licenses returns firm_name for the dashboard sidebar, correctly scoped to the caller's OWN firm (2026-07-30, BUILD v2 Phase B)", async () => {
    const { cookie: cookieA } = await createFirmWithSession("Sidebar Firm A", `sidebar-a-${Date.now()}@example.com`);
    const { cookie: cookieB } = await createFirmWithSession("Sidebar Firm B", `sidebar-b-${Date.now()}@example.com`);
    const bodyA = (await (await getFirmLicenses(cookieA)).json()) as { firm_name: string };
    const bodyB = (await (await getFirmLicenses(cookieB)).json()) as { firm_name: string };
    expect(bodyA.firm_name).toBe("Sidebar Firm A");
    expect(bodyB.firm_name).toBe("Sidebar Firm B");
  });

  it("HYBRID consent model: the transparent first-contact email fires (not the confirm email), names the firm, and its link is the unsubscribe token (not the confirm token)", async () => {
    const worker = (await import("../src/index")).default;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 202 }));
    try {
      const { cookie } = await createFirmWithSession("Bennett CPA Group", `bennett-${Date.now()}@example.com`);
      const staffEmail = `staff-transparency-${Date.now()}@example.com`;
      const envWithKey = { ...env, SENDGRID_API_KEY: "test-key-not-real" };
      const request = new Request("https://deadline-radar.com/firm/licenses", {
        method: "POST",
        headers: { "content-type": "application/json", Cookie: cookie },
        body: JSON.stringify({
          staff_label: "New Hire",
          email: staffEmail,
          state_slug: "georgia",
          license_type_id: "ga-individual",
        }),
      });
      const resp = await worker.fetch(request, envWithKey);
      expect(resp.status).toBe(201);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [, sendGridCallInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const sentBody = JSON.parse(String(sendGridCallInit.body));
      expect(sentBody.subject).toContain("Bennett CPA Group added you to DeadlineRadar");
      const textContent = sentBody.content.find((c: { type: string }) => c.type === "text/plain").value as string;
      expect(textContent).toContain("Bennett CPA Group added you to DeadlineRadar");
      expect(textContent).toContain("/api/unsubscribe?token=");
      expect(textContent).not.toContain("/api/confirm?token=");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("rejects an unsupported state, an invalid email, and control characters, same as /subscribe's validation", async () => {
    const { cookie } = await createFirmWithSession("Validation Firm", `validation-${Date.now()}@example.com`);
    const badState = await postFirmLicense(cookie, { email: "a@example.com", state_slug: "not-a-real-state" });
    expect(badState.status).toBe(400);

    const badEmail = await postFirmLicense(cookie, { email: "not-an-email", state_slug: "georgia", license_type_id: "ga-individual" });
    expect(badEmail.status).toBe(400);

    const controlChars = await postFirmLicense(cookie, {
      email: "a@example.com",
      state_slug: "georgia",
      license_type_id: "ga-individual",
      staff_label: "bad\r\nlabel",
    });
    expect(controlChars.status).toBe(400);
  });

  it("does NOT require the honeypot/Turnstile fields the public form needs (an authenticated session is proof enough)", async () => {
    const { cookie } = await createFirmWithSession("No Honeypot Firm", `nohp-${Date.now()}@example.com`);
    // Deliberately omits hp_website/cf-turnstile-response entirely -- unlike
    // postSubscribe()'s helper, which always includes hp_website: "".
    const resp = await postFirmLicense(cookie, {
      email: `nohp-staff-${Date.now()}@example.com`,
      state_slug: "georgia",
      license_type_id: "ga-individual",
    });
    expect(resp.status).toBe(201);
  });

  it("refuses a duplicate email+state that already has an active/pending record (409, no silent double row)", async () => {
    const { cookie } = await createFirmWithSession("Dup Firm", `dup-${Date.now()}@example.com`);
    const email = `dup-staff-${Date.now()}@example.com`;
    const first = await postFirmLicense(cookie, { email, state_slug: "georgia", license_type_id: "ga-individual" });
    expect(first.status).toBe(201);
    const second = await postFirmLicense(cookie, { email, state_slug: "georgia", license_type_id: "ga-individual" });
    expect(second.status).toBe(409);
    const rows = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?1").bind(email).all<SubscriberRow>();
    expect(rows.results.length).toBe(1);
  });

  it("blocks the 51st staff-add for the SAME firm within the window (own per-firm bucket, distinct from per-IP buckets)", async () => {
    const { cookie } = await createFirmWithSession("Rate Limited Firm", `ratelimit-${Date.now()}@example.com`);
    for (let i = 0; i < RATE_LIMIT_FIRM_LICENSE_CREATE.max; i++) {
      const resp = await postFirmLicense(cookie, {
        email: `ratelimit-staff-${i}-${Date.now()}@example.com`,
        state_slug: "georgia",
        license_type_id: "ga-individual",
      });
      expect(resp.status).toBe(201);
    }
    const overCap = await postFirmLicense(cookie, {
      email: `ratelimit-staff-over-${Date.now()}@example.com`,
      state_slug: "georgia",
      license_type_id: "ga-individual",
    });
    expect(overCap.status).toBe(429);
  }, 20_000);

  it("GET lists only this firm's roster, sorted soonest-deadline-first", async () => {
    const { cookie } = await createFirmWithSession("List Firm", `list-${Date.now()}@example.com`);
    // Texas (birth_month 7) and Ohio (Group 1) resolve to different, both
    // computable, deadlines -- sort order is asserted below, not assumed.
    await postFirmLicense(cookie, { email: `list-tx-${Date.now()}@example.com`, state_slug: "texas", birth_month: "7", staff_label: "TX Person" });
    await postFirmLicense(cookie, { email: `list-oh-${Date.now()}@example.com`, state_slug: "ohio", cohort_group: "Group 1", staff_label: "OH Person" });

    const resp = await getFirmLicenses(cookie);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { licenses: { staff_label: string; next_deadline: string | null }[] };
    expect(body.licenses.length).toBe(2);
    // Every entry has a computed next_deadline (both states are computable).
    for (const item of body.licenses) expect(item.next_deadline).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Sorted ascending.
    const dates = body.licenses.map((l) => l.next_deadline as string);
    expect([...dates].sort()).toEqual(dates);
  });

  it("PATCH updates staff_label/state without requiring every field, and re-triggers confirmation when the email changes", async () => {
    const { cookie } = await createFirmWithSession("Patch Firm", `patch-${Date.now()}@example.com`);
    const created = await postFirmLicense(cookie, {
      email: `patch-staff-${Date.now()}@example.com`,
      state_slug: "georgia",
      license_type_id: "ga-individual",
      staff_label: "Original Label",
    });
    const createdBody = (await created.json()) as { id: string };
    const originalRow = await env.DB.prepare("SELECT * FROM subscribers WHERE id = ?1").bind(createdBody.id).first<SubscriberRow>();
    await store.confirm(env.DB, originalRow!.confirm_token);

    // Label-only edit: does not touch state/email/confirmation status.
    const labelPatch = await patchFirmLicense(cookie, createdBody.id, { staff_label: "New Label" });
    expect(labelPatch.status).toBe(200);
    const afterLabel = await env.DB.prepare("SELECT * FROM subscribers WHERE id = ?1").bind(createdBody.id).first<SubscriberRow>();
    expect(afterLabel?.staff_label).toBe("New Label");
    expect(afterLabel?.status).toBe(store.STATUS_CONFIRMED); // unchanged -- no email edit here

    // Email edit: must force back through pending_confirmation (see
    // UpdateFirmLicenseInput.resetConfirmation's own doc for why) -- editing
    // the delivery address is re-consenting a DIFFERENT inbox, which has
    // never clicked anything.
    const newEmail = `patch-newemail-${Date.now()}@example.com`;
    const emailPatch = await patchFirmLicense(cookie, createdBody.id, { email: newEmail });
    expect(emailPatch.status).toBe(200);
    const afterEmail = await env.DB.prepare("SELECT * FROM subscribers WHERE id = ?1").bind(createdBody.id).first<SubscriberRow>();
    expect(afterEmail?.email).toBe(newEmail);
    expect(afterEmail?.status).toBe(store.STATUS_PENDING);
    expect(afterEmail?.confirmed_at).toBeNull();
  });

  it("returns 404 for a nonexistent id on PATCH/DELETE/renew (not a 500 or a 200)", async () => {
    const { cookie } = await createFirmWithSession("Missing Id Firm", `missing-${Date.now()}@example.com`);
    expect((await patchFirmLicense(cookie, "does-not-exist", { staff_label: "x" })).status).toBe(404);
    expect((await deleteFirmLicense(cookie, "does-not-exist")).status).toBe(404);
    expect((await renewFirmLicense(cookie, "does-not-exist")).status).toBe(404);
  });
});

describe("Cross-firm ownership -- the single most important test in this build", () => {
  // Firm A must NEVER be able to read, edit, delete, or renew Firm B's
  // license via GET/PATCH/DELETE/POST .../renew, and the failure mode for
  // PATCH/DELETE/renew must be 404 (not 403 -- a 403 would CONFIRM the
  // record exists under another firm, the exact enumeration oracle this
  // codebase's every other route already avoids). This test is written to
  // fail loudly (a wrong status code, or -- far worse -- a mutated row) if
  // this check is ever weakened.
  it("firm A cannot read, edit, delete, or renew firm B's license", async () => {
    const firmA = await createFirmWithSession("Firm A", `firma-${Date.now()}@example.com`);
    const firmB = await createFirmWithSession("Firm B", `firmb-${Date.now()}@example.com`);

    const staffEmail = `firmb-staff-${Date.now()}@example.com`;
    const created = await postFirmLicense(firmB.cookie, {
      email: staffEmail,
      state_slug: "georgia",
      license_type_id: "ga-individual",
      staff_label: "Firm B's Staffer",
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const originalRow = await env.DB.prepare("SELECT * FROM subscribers WHERE id = ?1").bind(id).first<SubscriberRow>();
    await store.confirm(env.DB, originalRow!.confirm_token);
    const confirmedRow = await env.DB.prepare("SELECT * FROM subscribers WHERE id = ?1").bind(id).first<SubscriberRow>();

    // GET (list) -- firm B's record must never appear in firm A's roster.
    const listA = await getFirmLicenses(firmA.cookie);
    expect(listA.status).toBe(200);
    const listABody = (await listA.json()) as { licenses: { id: string }[] };
    expect(listABody.licenses.find((l) => l.id === id)).toBeUndefined();

    // PATCH -- 404, not 403, and the row must be completely untouched.
    const patchAttempt = await patchFirmLicense(firmA.cookie, id, { staff_label: "Hijacked by Firm A" });
    expect(patchAttempt.status).toBe(404);

    // DELETE -- 404, and the row must still be active (not removed).
    const deleteAttempt = await deleteFirmLicense(firmA.cookie, id);
    expect(deleteAttempt.status).toBe(404);

    // POST .../renew -- 404, and the row's cycle/tokens must be untouched.
    const renewAttempt = await renewFirmLicense(firmA.cookie, id);
    expect(renewAttempt.status).toBe(404);

    const afterAllAttempts = await env.DB.prepare("SELECT * FROM subscribers WHERE id = ?1").bind(id).first<SubscriberRow>();
    expect(afterAllAttempts?.staff_label).toBe("Firm B's Staffer"); // NOT "Hijacked by Firm A"
    expect(afterAllAttempts?.status).toBe(store.STATUS_CONFIRMED); // NOT removed/stopped
    expect(afterAllAttempts?.stop_reason).toBeNull();
    expect(afterAllAttempts?.cycle).toBe(confirmedRow?.cycle); // unchanged
    expect(afterAllAttempts?.unsubscribe_token).toBe(confirmedRow?.unsubscribe_token); // unchanged
    expect(afterAllAttempts?.renewed_token).toBe(confirmedRow?.renewed_token); // unchanged
    expect(afterAllAttempts?.firm_id).toBe(firmB.firmId); // still firm B's, never reassigned

    // Sanity check: firm B itself CAN do every one of these -- proves the
    // 404s above are an ownership refusal, not a route/bug that 404s for
    // everyone.
    expect((await getFirmLicenses(firmB.cookie)).status).toBe(200);
    const bList = (await (await getFirmLicenses(firmB.cookie)).json()) as { licenses: { id: string }[] };
    expect(bList.licenses.find((l) => l.id === id)).toBeTruthy();
    expect((await patchFirmLicense(firmB.cookie, id, { staff_label: "Firm B edits its own" })).status).toBe(200);
    expect((await renewFirmLicense(firmB.cookie, id)).status).toBe(200);
    expect((await deleteFirmLicense(firmB.cookie, id)).status).toBe(200);
  });

  it("store.getFirmLicense()/updateFirmLicense()/removeFirmLicense()/renewAndRearm() all return null for a real id under the WRONG firmId, at the storage layer directly", async () => {
    const firmA = (await store.createFirm(env.DB, { name: "Storage Firm A", adminEmail: `storagea-${Date.now()}@example.com` })).id;
    const firmB = (await store.createFirm(env.DB, { name: "Storage Firm B", adminEmail: `storageb-${Date.now()}@example.com` })).id;
    const rec = await store.addPending(env.DB, {
      email: `storage-staff-${Date.now()}@example.com`,
      stateSlug: "georgia",
      deadlineFields: { license_type_id: "ga-individual" },
      firstName: null,
      firmId: firmB,
      staffLabel: "Storage Test",
    });
    await store.confirm(env.DB, rec.confirm_token);

    expect(await store.getFirmLicense(env.DB, firmA, rec.id)).toBeNull();
    expect(
      await store.updateFirmLicense(env.DB, firmA, rec.id, {
        email: rec.email,
        staffLabel: "hijacked",
        stateSlug: rec.state_slug,
        deadlineFields: {},
        deadlineSource: store.DEADLINE_SOURCE_COMPUTED,
        userDeadline: null,
        resetConfirmation: false,
      })
    ).toBeNull();
    expect(await store.removeFirmLicense(env.DB, firmA, rec.id)).toBeNull();
    expect(await store.renewAndRearm(env.DB, firmA, rec.id)).toBeNull();

    // The row itself is untouched by any of the four wrong-firm attempts above.
    const stillIntact = await store.getFirmLicense(env.DB, firmB, rec.id);
    expect(stillIntact?.staff_label).toBe("Storage Test");
    expect(stillIntact?.status).toBe(store.STATUS_CONFIRMED);
  });
});

describe("DELETE /firm/licenses/:id -- removes from roster and stops further reminders", () => {
  it("marks stop_reason = removed_by_admin, disappears from GET /firm/licenses, and is excluded from allConfirmedActive() (no more reminders will ever be sent)", async () => {
    const { cookie } = await createFirmWithSession("Removal Firm", `removal-${Date.now()}@example.com`);
    const email = `removal-staff-${Date.now()}@example.com`;
    const created = await postFirmLicense(cookie, { email, state_slug: "georgia", license_type_id: "ga-individual" });
    const { id } = (await created.json()) as { id: string };
    const row = await env.DB.prepare("SELECT * FROM subscribers WHERE id = ?1").bind(id).first<SubscriberRow>();
    await store.confirm(env.DB, row!.confirm_token);

    // Confirmed -- would appear in allConfirmedActive() (what the reminder
    // cron actually sends off of) before removal.
    let active = await store.allConfirmedActive(env.DB);
    expect(active.some((r) => r.id === id)).toBe(true);

    const del = await deleteFirmLicense(cookie, id);
    expect(del.status).toBe(200);

    const removedRow = await env.DB.prepare("SELECT * FROM subscribers WHERE id = ?1").bind(id).first<SubscriberRow>();
    expect(removedRow?.status).toBe(store.STATUS_STOPPED);
    expect(removedRow?.stop_reason).toBe(store.STOP_REASON_REMOVED_BY_ADMIN);

    // Gone from the dashboard roster...
    const list = await getFirmLicenses(cookie);
    const listBody = (await list.json()) as { licenses: { id: string }[] };
    expect(listBody.licenses.find((l) => l.id === id)).toBeUndefined();

    // ...and gone from the reminder cron's own send-eligibility query --
    // this is what "stops any pending reminder sends" actually means at the
    // send-pipeline layer, not just the dashboard's own display.
    active = await store.allConfirmedActive(env.DB);
    expect(active.some((r) => r.id === id)).toBe(false);
  });

  it("a removed license cannot be resurrected via POST .../renew (renew must not undo an admin removal)", async () => {
    const { cookie } = await createFirmWithSession("No Resurrect Firm", `noresurrect-${Date.now()}@example.com`);
    const email = `noresurrect-staff-${Date.now()}@example.com`;
    const created = await postFirmLicense(cookie, { email, state_slug: "georgia", license_type_id: "ga-individual" });
    const { id } = (await created.json()) as { id: string };
    const row = await env.DB.prepare("SELECT * FROM subscribers WHERE id = ?1").bind(id).first<SubscriberRow>();
    await store.confirm(env.DB, row!.confirm_token);
    await deleteFirmLicense(cookie, id);

    const renewAttempt = await renewFirmLicense(cookie, id);
    expect(renewAttempt.status).toBe(400);
    const stillRemoved = await env.DB.prepare("SELECT * FROM subscribers WHERE id = ?1").bind(id).first<SubscriberRow>();
    expect(stillRemoved?.status).toBe(store.STATUS_STOPPED);
    expect(stillRemoved?.stop_reason).toBe(store.STOP_REASON_REMOVED_BY_ADMIN);
  });
});

describe("POST /firm/licenses/:id/renew -- atomic renew-and-rearm (Part A #5)", () => {
  it("stops this cycle AND re-arms for next cycle in one call: cycle+1, reminders_sent cleared, stop fields cleared, tokens rotated", async () => {
    const { cookie } = await createFirmWithSession("Renew Firm", `renew-${Date.now()}@example.com`);
    const email = `renew-staff-${Date.now()}@example.com`;
    const created = await postFirmLicense(cookie, { email, state_slug: "texas", birth_month: "7" });
    const { id } = (await created.json()) as { id: string };
    const original = await env.DB.prepare("SELECT * FROM subscribers WHERE id = ?1").bind(id).first<SubscriberRow>();
    await store.confirm(env.DB, original!.confirm_token);
    await store.markReminderSent(env.DB, id, 30); // pretend a reminder already fired this cycle
    const beforeRenew = await env.DB.prepare("SELECT * FROM subscribers WHERE id = ?1").bind(id).first<SubscriberRow>();
    expect(beforeRenew?.cycle).toBe(1);
    expect(JSON.parse(beforeRenew?.reminders_sent ?? "[]")).toEqual([30]);

    const resp = await renewFirmLicense(cookie, id);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { status: string; cycle: number };
    expect(body.status).toBe("active"); // HYBRID consent model (2026-07-28) status label
    expect(body.cycle).toBe(2);

    // Verify directly against the DB row, not just the HTTP response.
    const after = await env.DB.prepare("SELECT * FROM subscribers WHERE id = ?1").bind(id).first<SubscriberRow>();
    expect(after?.status).toBe(store.STATUS_CONFIRMED);
    expect(after?.cycle).toBe(2);
    expect(after?.stopped_at).toBeNull();
    expect(after?.stop_reason).toBeNull();
    expect(JSON.parse(after?.reminders_sent ?? "[]")).toEqual([]);
    // Tokens rotated, same posture as rearm() -- an old copy of either
    // token (e.g. from a previously sent, now-stale reminder email) must not
    // remain valid.
    expect(after?.unsubscribe_token).not.toBe(beforeRenew?.unsubscribe_token);
    expect(after?.renewed_token).not.toBe(beforeRenew?.renewed_token);
  });

  it("refuses a record that never confirmed (nothing to renew) -- defense-in-depth: since the HYBRID consent model (2026-07-28), the real POST /firm/licenses route always creates an ACTIVE record (skipConfirmation), so a firm-scoped pending row is no longer reachable through the normal add-staff path. Constructs one directly at the store layer to prove renewAndRearm's own guard still holds regardless of how such a row exists (a legacy record, or a future call site that forgets to skip confirmation).", async () => {
    const { cookie, firmId } = await createFirmWithSession("Unconfirmed Firm", `unconfirmed-${Date.now()}@example.com`);
    const pendingRow = await store.addPending(env.DB, {
      email: `unconfirmed-staff-${Date.now()}@example.com`,
      stateSlug: "georgia",
      deadlineFields: { license_type_id: "ga-individual" },
      firstName: null,
      firmId,
      staffLabel: "Still Pending",
    });
    const id = pendingRow.id;
    // Deliberately never confirmed (skipConfirmation omitted above -> defaults to pending).
    const resp = await renewFirmLicense(cookie, id);
    expect(resp.status).toBe(400);
    const row = await env.DB.prepare("SELECT * FROM subscribers WHERE id = ?1").bind(id).first<SubscriberRow>();
    expect(row?.status).toBe(store.STATUS_PENDING); // unchanged
  });

  it("refuses to auto-rearm a bring-your-own-date record, with a tailored message (same rule as the free-tier rearm())", async () => {
    const { firmId, cookie } = await createFirmWithSession("BYOD Firm", `byodfirm-${Date.now()}@example.com`);
    const email = `byod-firm-staff-${Date.now()}@example.com`;
    const rec = await store.addPending(env.DB, {
      email,
      stateSlug: "new-jersey", // uncomputable -- BYOD
      deadlineFields: {},
      firstName: null,
      deadlineSource: "user",
      userDeadline: "2026-08-15",
      firmId,
      staffLabel: "BYOD Staffer",
    });
    await store.confirm(env.DB, rec.confirm_token);

    const resp = await renewFirmLicense(cookie, rec.id);
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string };
    expect(body.error.toLowerCase()).toContain("can't auto-compute");

    const row = await env.DB.prepare("SELECT * FROM subscribers WHERE id = ?1").bind(rec.id).first<SubscriberRow>();
    expect(row?.status).toBe(store.STATUS_CONFIRMED); // never stopped, never touched
    expect(row?.cycle).toBe(1);
  });
});

describe("emails.ts buildFirmLoginEmail", () => {
  it("includes the login link, the 15-minute expiry copy, and a real mailing address", async () => {
    const { buildFirmLoginEmail, MAILING_ADDRESS } = await import("../src/emails");
    const built = buildFirmLoginEmail("https://deadline-radar.com/api/firm/login/verify?token=abc123");
    expect(built.subject.toLowerCase()).toContain("sign-in link");
    expect(built.textBody).toContain("https://deadline-radar.com/api/firm/login/verify?token=abc123");
    expect(built.htmlBody).toContain("https://deadline-radar.com/api/firm/login/verify?token=abc123");
    expect(built.textBody).toContain("15 minutes");
    expect(built.htmlBody).toContain("15 minutes");
    expect(built.htmlBody).toContain(MAILING_ADDRESS);
    expect(built.textBody).toContain(MAILING_ADDRESS);
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
    // checkAndCountSend() shares ONE real send_counters row per UTC day across
    // every test in this file (it has no day-override parameter to isolate
    // against) -- other tests that go through a real send path (e.g. the
    // HYBRID-consent transparency-email test above) increment the same
    // counter. Read today's actual current count first and set the cap
    // relative to it, so this test asserts "N more sends allowed, then
    // refused" regardless of how many sends happened earlier in this run,
    // instead of assuming the counter starts at zero.
    const before = await env.DB
      .prepare("SELECT count FROM send_counters WHERE day = strftime('%Y-%m-%d','now')")
      .first<{ count: number }>();
    const alreadyUsed = before?.count ?? 0;
    const cap = alreadyUsed + 3;
    const results: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      results.push(await checkAndCountSend(env.DB, cap));
    }
    // First 3 (relative to today's existing count) allowed, everything after
    // refused -- protects sender reputation from a burst blowing past the
    // daily cap.
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

describe("Reminder email's two co-equal CTAs (2026-07-28) -- end-to-end via the real cron pass", () => {
  it("the actual scheduler-built reminder email contains BOTH CTAs, and the new one's link/token works end-to-end via POST /renewed-next-cycle", async () => {
    const { runReminderPass } = await import("../src/scheduler");
    const email = `tworcta-${Date.now()}@example.com`;
    const rec = await store.addPending(env.DB, {
      email,
      stateSlug: "texas",
      deadlineFields: { birth_month: "7" }, // TX deadline = end of July
      firstName: "Tester",
    });
    await store.confirm(env.DB, rec.confirm_token);

    let capturedHtml = "";
    let capturedText = "";
    const summary = await runReminderPass(env, {
      asOf: new Date(Date.UTC(2026, 6, 24)), // 7 days out -> tier 7
      send: async (to, built) => {
        if (to === email) {
          capturedHtml = built.htmlBody;
          capturedText = built.textBody;
        }
        return true;
      },
    });
    expect(summary.errors).toEqual([]);
    expect(capturedHtml).toBeTruthy();

    // Both CTAs present, co-equal (both rendered as buttons), plus the
    // unchanged footer Unsubscribe link. escapeHtml() turns the apostrophe
    // into &#39; in the HTML body (not the text body), so the HTML
    // assertion matches the escaped form.
    expect(capturedHtml).toContain("I&#39;ve renewed -- remind me next cycle");
    expect(capturedText).toContain("Already renewed?");
    expect(capturedHtml).toContain("Stop reminders entirely");
    expect(capturedHtml).toMatch(/\/api\/renewed-next-cycle\?token=/);
    expect(capturedHtml).toMatch(/\/api\/renewed\?token=/);
    expect(capturedText).toContain("/api/renewed-next-cycle?token=");
    expect(capturedText).toContain("/api/renewed?token=");

    // Pull the renewed-next-cycle token out of the actual built email (not a
    // hand-constructed URL) and click through it for real.
    const match = /renewed-next-cycle\?token=([^"&\s]+)/.exec(capturedHtml);
    expect(match).toBeTruthy();
    const token = decodeURIComponent(match![1] as string);

    const before = await env.DB.prepare("SELECT * FROM subscribers WHERE id = ?1").bind(rec.id).first<SubscriberRow>();
    expect(before?.cycle).toBe(1);

    const resp = await postAction(`/renewed-next-cycle?token=${encodeURIComponent(token)}`, "203.0.113.220");
    expect(resp.status).toBe(200);
    expect((await resp.text()).toLowerCase()).toContain("all set");

    const after = await env.DB.prepare("SELECT * FROM subscribers WHERE id = ?1").bind(rec.id).first<SubscriberRow>();
    expect(after?.status).toBe(store.STATUS_CONFIRMED);
    expect(after?.cycle).toBe(2);
    expect(after?.stop_reason).toBeNull();
    expect(JSON.parse(after?.reminders_sent ?? "[]")).toEqual([]);
  });

  it("GET /api/renewed-next-cycle renders a confirm page WITHOUT changing state (prefetch-safe); a stale token 404s on POST", async () => {
    const email = `rncrender-${Date.now()}@example.com`;
    const rec = await store.addPending(env.DB, { email, stateSlug: "texas", deadlineFields: { birth_month: "7" }, firstName: null });
    await store.confirm(env.DB, rec.confirm_token);

    const getResp = await SELF.fetch(`https://deadline-radar.com/api/renewed-next-cycle?token=${rec.renewed_token}`, {
      headers: { "cf-connecting-ip": "203.0.113.221" },
    });
    expect(getResp.status).toBe(200);
    // escapeHtml() turns the apostrophe into &#39; in the rendered page.
    expect(await getResp.text()).toContain("I&#39;ve renewed -- remind me next cycle"); // the button, not a done page

    const unchanged = await env.DB.prepare("SELECT * FROM subscribers WHERE id = ?1").bind(rec.id).first<SubscriberRow>();
    expect(unchanged?.cycle).toBe(1);
    expect(unchanged?.status).toBe(store.STATUS_CONFIRMED);

    // A never-confirmed subscriber's token must not work either (same
    // double-opt-in-bypass guard as /renewed).
    const email2 = `rncunconfirmed-${Date.now()}@example.com`;
    const rec2 = await store.addPending(env.DB, { email: email2, stateSlug: "texas", deadlineFields: { birth_month: "7" }, firstName: null });
    const blocked = await postAction(`/renewed-next-cycle?token=${rec2.renewed_token}`, "203.0.113.222");
    expect(blocked.status).toBe(404);
  });

  it("refuses to auto-rearm a bring-your-own-date subscriber via the token-based route, with the tailored message", async () => {
    const email = `rncbyod-${Date.now()}@example.com`;
    const rec = await store.addPending(env.DB, {
      email,
      stateSlug: "new-jersey",
      deadlineFields: {},
      firstName: null,
      deadlineSource: "user",
      userDeadline: "2026-08-20",
    });
    await store.confirm(env.DB, rec.confirm_token);

    const resp = await postAction(`/renewed-next-cycle?token=${rec.renewed_token}`, "203.0.113.223");
    expect(resp.status).toBe(400);
    const body = await resp.text();
    expect(body.toLowerCase()).toContain("sign up again");

    const row = await env.DB.prepare("SELECT * FROM subscribers WHERE id = ?1").bind(rec.id).first<SubscriberRow>();
    expect(row?.status).toBe(store.STATUS_CONFIRMED); // untouched
    expect(row?.cycle).toBe(1);
  });
});

describe("prefetch-safe actions + List-Unsubscribe", () => {
  it("emails carry RFC 8058 one-click List-Unsubscribe headers", async () => {
    const { buildConfirmationEmail, buildReminderEmail } = await import("../src/emails");
    const conf = buildConfirmationEmail("California", "https://deadline-radar.com/api/confirm?token=c", "https://deadline-radar.com/api/unsubscribe?token=u");
    expect(conf.headers["List-Unsubscribe"]).toBe("<https://deadline-radar.com/api/unsubscribe?token=u>");
    expect(conf.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    const rem = buildReminderEmail(
      "California",
      "July 31, 2026",
      30,
      30,
      "https://deadline-radar.com/api/renewed-next-cycle?token=r",
      "https://deadline-radar.com/api/renewed?token=r",
      "https://deadline-radar.com/api/unsubscribe?token=u"
    );
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
