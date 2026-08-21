import { env, SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  checkDataFreshness,
  computeSubscriberDeadline,
  dataFreshnessInfo,
  nextAnnualMonthEnd,
  nextBirthMonthParityDate,
  nextFixedDateParity,
  StaleDataError,
  STALENESS_THRESHOLD_DAYS,
} from "../src/deadline";
import cpaDeadlinesData from "../src/cpa_deadlines.json";
import {
  hasControlChars,
  isValidEmail,
  RATE_LIMIT_FIRM_LICENSE_CREATE,
  sanitizeFirstName,
  strictParseInt,
  TERMS_VERSION,
} from "../src/validation";
import * as store from "../src/store";
import { isUsFederalHoliday as isUsFederalHolidayForTest } from "../src/holidays";
import { hashPassword, verifyPassword } from "../src/password";
import type { CpeEntryRow, FirmLeadRow, FirmRow, SubscriberRow } from "../src/store";

// Minimal ExecutionContext for direct worker.fetch() calls (2026-07-31):
// the Worker now defers best-effort email sends via ctx.waitUntil() so they
// stay off the response path (see handleSubscriberLoginRequest). The
// promises are collected rather than dropped so a test can await them.
function testExecutionContext(): ExecutionContext {
  const pending: Promise<unknown>[] = [];
  return {
    waitUntil(p: Promise<unknown>) { pending.push(p); },
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
}


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

  // AuditLab S-1, 2026-08-03 (MEDIUM): neither origin sent any of these 5
  // headers. GitHub Pages can't be fixed from this repo (needs a Cloudflare
  // Transform Rule), but every Worker response should carry them now.
  it("carries the 5 baseline security headers", async () => {
    const resp = await getAction("/health");
    expect(resp.headers.get("Strict-Transport-Security")).toContain("max-age=");
    expect(resp.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(resp.headers.get("X-Frame-Options")).toBe("DENY");
    expect(resp.headers.get("Referrer-Policy")).toBeTruthy();
    expect(resp.headers.get("Content-Security-Policy")).toBeTruthy();
  });

  // Orchestrator abuse-test finding (2026-08-05, LOW, latent): every
  // response is per-request/per-session and must never be cached by an
  // intermediary -- confirmed missing across 3 live probes.
  it("carries Cache-Control: private, no-store and Vary: Cookie on every response", async () => {
    const resp = await getAction("/health");
    expect(resp.headers.get("Cache-Control")).toBe("private, no-store");
    expect(resp.headers.get("Vary")).toBe("Cookie");
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

  it("2026-08-18: Kansas certificate-number signup only ever persists the parity, never the raw number (PII minimization)", async () => {
    const email = `ks-parity-${Date.now()}@example.com`;
    const resp = await postSubscribe({ email, state: "kansas", parity_number: "104583" }, "203.0.113.30");
    expect(resp.status).toBe(200);
    const row = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?1").bind(email).first<SubscriberRow>();
    expect(row?.state_slug).toBe("kansas");
    // 104583's last digit is 3 (odd) -- only "odd" is stored, "104583" itself
    // never appears anywhere in the persisted record.
    expect(JSON.parse(row?.deadline_fields ?? "{}")).toEqual({ parity: "odd" });
    expect(row?.deadline_fields).not.toContain("104583");
  });

  it("2026-08-18: Nebraska birth-year signup stores the INVERTED parity (born-even persists as odd)", async () => {
    const email = `ne-parity-${Date.now()}@example.com`;
    const resp = await postSubscribe({ email, state: "nebraska", parity_number: "1990" }, "203.0.113.31");
    expect(resp.status).toBe(200);
    const row = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?1").bind(email).first<SubscriberRow>();
    // 1990 is an even birth year -- Nebraska's own Board FAQ says born-even
    // renews in ODD years, so the persisted parity must be "odd", not "even".
    expect(JSON.parse(row?.deadline_fields ?? "{}")).toEqual({ parity: "odd" });
  });

  it("2026-08-18: Idaho birth-year signup persists the parity, non-inverted (unlike Nebraska), and never the raw birth year (PII minimization)", async () => {
    const email = `id-parity-${Date.now()}@example.com`;
    const resp = await postSubscribe({ email, state: "idaho", parity_number: "1985" }, "203.0.113.33");
    expect(resp.status).toBe(200);
    const row = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?1").bind(email).first<SubscriberRow>();
    expect(row?.state_slug).toBe("idaho");
    // 1985's last digit is 5 (odd) -- Idaho is NOT inverted (unlike Nebraska),
    // so an odd birth year persists as "odd" directly, matching DOPL's own
    // stated odd-birth-year -> odd-year renewal mapping.
    expect(JSON.parse(row?.deadline_fields ?? "{}")).toEqual({ parity: "odd" });
    expect(row?.deadline_fields).not.toContain("1985");
  });

  it("2026-08-18: rejects a non-numeric parity_number for the 4 new parity-lookup states", async () => {
    const resp = await postSubscribe(
      { email: `ky-badnum-${Date.now()}@example.com`, state: "kentucky", parity_number: "abc" },
      "203.0.113.32"
    );
    expect(resp.status).toBe(400);
  });

  it("2026-08-18: Oklahoma and New Mexico individual signups persist birth_month via the same path as Texas", async () => {
    const okEmail = `ok-birthmonth-${Date.now()}@example.com`;
    const okResp = await postSubscribe({ email: okEmail, state: "oklahoma", birth_month: "4" }, "203.0.113.34");
    expect(okResp.status).toBe(200);
    const okRow = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?1").bind(okEmail).first<SubscriberRow>();
    expect(okRow?.state_slug).toBe("oklahoma");
    expect(JSON.parse(okRow?.deadline_fields ?? "{}")).toEqual({ birth_month: "4" });

    const nmEmail = `nm-birthmonth-${Date.now()}@example.com`;
    const nmResp = await postSubscribe({ email: nmEmail, state: "new-mexico", birth_month: "11" }, "203.0.113.35");
    expect(nmResp.status).toBe(200);
    const nmRow = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?1").bind(nmEmail).first<SubscriberRow>();
    expect(nmRow?.state_slug).toBe("new-mexico");
    expect(JSON.parse(nmRow?.deadline_fields ?? "{}")).toEqual({ birth_month: "11" });
  });

  it("2026-08-18: rejects a missing/invalid birth_month for Oklahoma and New Mexico, with the correct state display name (not a raw hyphenated slug)", async () => {
    const okResp = await postSubscribe({ email: `ok-nomonth-${Date.now()}@example.com`, state: "oklahoma" }, "203.0.113.36");
    expect(okResp.status).toBe(400);
    expect(await okResp.text()).toContain("Oklahoma needs your birth month.");

    const nmResp = await postSubscribe(
      { email: `nm-badmonth-${Date.now()}@example.com`, state: "new-mexico", birth_month: "13" },
      "203.0.113.37"
    );
    expect(nmResp.status).toBe(400);
    // "New Mexico", not "New-mexico" -- the display name is hand-mapped, not
    // derived from the hyphenated state_slug.
    expect(await nmResp.text()).toContain("New Mexico needs a valid birth month.");
  });

  it("2026-08-18: Arizona signup persists only the derived parity (PII minimization, same as California) via the shared birth-month+year path", async () => {
    const email = `az-parity-${Date.now()}@example.com`;
    const resp = await postSubscribe({ email, state: "arizona", birth_month: "5", birth_year: "1991" }, "203.0.113.38");
    expect(resp.status).toBe(200);
    const row = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?1").bind(email).first<SubscriberRow>();
    expect(row?.state_slug).toBe("arizona");
    // 1991 is odd -- only "odd" is stored, the full birth year is discarded.
    expect(JSON.parse(row?.deadline_fields ?? "{}")).toEqual({ birth_month: "5", birth_year_parity: "odd" });
    expect(row?.deadline_fields).not.toContain("1991");
  });

  it("2026-08-18: rejects a missing birth year for Arizona with the correct state display name (not California's)", async () => {
    const resp = await postSubscribe({ email: `az-noyear-${Date.now()}@example.com`, state: "arizona", birth_month: "5" }, "203.0.113.39");
    expect(resp.status).toBe(400);
    expect(await resp.text()).toContain("Arizona needs your birth month and birth year.");
  });

  it("2026-08-18: New Hampshire and CNMI signups persist the anchor_date, a real PAST date not a future one", async () => {
    const nhEmail = `nh-anchor-${Date.now()}@example.com`;
    const nhResp = await postSubscribe({ email: nhEmail, state: "new-hampshire", anchor_date: "2024-09-15" }, "203.0.113.40");
    expect(nhResp.status).toBe(200);
    const nhRow = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?1").bind(nhEmail).first<SubscriberRow>();
    expect(nhRow?.state_slug).toBe("new-hampshire");
    expect(JSON.parse(nhRow?.deadline_fields ?? "{}")).toEqual({ anchor_date: "2024-09-15" });

    const cnmiEmail = `cnmi-anchor-${Date.now()}@example.com`;
    const cnmiResp = await postSubscribe(
      { email: cnmiEmail, state: "northern-mariana-islands", anchor_date: "2023-03-10" },
      "203.0.113.41"
    );
    expect(cnmiResp.status).toBe(200);
    const cnmiRow = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?1").bind(cnmiEmail).first<SubscriberRow>();
    expect(cnmiRow?.state_slug).toBe("northern-mariana-islands");
    expect(JSON.parse(cnmiRow?.deadline_fields ?? "{}")).toEqual({ anchor_date: "2023-03-10" });
  });

  it("2026-08-18: rejects a future anchor_date for New Hampshire (must be a PAST issuance/renewal date)", async () => {
    const farFuture = new Date();
    farFuture.setUTCFullYear(farFuture.getUTCFullYear() + 1);
    const resp = await postSubscribe(
      { email: `nh-future-${Date.now()}@example.com`, state: "new-hampshire", anchor_date: farFuture.toISOString().slice(0, 10) },
      "203.0.113.42"
    );
    expect(resp.status).toBe(400);
    expect(await resp.text()).toContain("needs a date that already happened");
  });

  it("2026-08-18: rejects a malformed anchor_date for CNMI with the correct state display name", async () => {
    const resp = await postSubscribe(
      { email: `cnmi-bad-${Date.now()}@example.com`, state: "northern-mariana-islands", anchor_date: "not-a-date" },
      "203.0.113.43"
    );
    expect(resp.status).toBe(400);
    expect(await resp.text()).toContain("Northern Mariana Islands needs a valid issuance or renewal date.");
  });

  it("2026-08-18: Washington and Puerto Rico signups persist only the anchor_year (mod-3 term, not a full date)", async () => {
    const waEmail = `wa-anchor-${Date.now()}@example.com`;
    const waResp = await postSubscribe({ email: waEmail, state: "washington", anchor_year: "2024" }, "203.0.113.44");
    expect(waResp.status).toBe(200);
    const waRow = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?1").bind(waEmail).first<SubscriberRow>();
    expect(waRow?.state_slug).toBe("washington");
    expect(JSON.parse(waRow?.deadline_fields ?? "{}")).toEqual({ anchor_year: "2024" });

    const prEmail = `pr-anchor-${Date.now()}@example.com`;
    const prResp = await postSubscribe({ email: prEmail, state: "puerto-rico", anchor_year: "2023" }, "203.0.113.45");
    expect(prResp.status).toBe(200);
    const prRow = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?1").bind(prEmail).first<SubscriberRow>();
    expect(prRow?.state_slug).toBe("puerto-rico");
    expect(JSON.parse(prRow?.deadline_fields ?? "{}")).toEqual({ anchor_year: "2023" });
  });

  it("2026-08-18: rejects a missing/invalid anchor_year for Washington and Puerto Rico, with the correct state display name", async () => {
    const waResp = await postSubscribe({ email: `wa-noyear-${Date.now()}@example.com`, state: "washington" }, "203.0.113.46");
    expect(waResp.status).toBe(400);
    expect(await waResp.text()).toContain("Washington needs a valid year.");

    const prResp = await postSubscribe(
      { email: `pr-badyear-${Date.now()}@example.com`, state: "puerto-rico", anchor_year: "not-a-year" },
      "203.0.113.47"
    );
    expect(prResp.status).toBe(400);
    expect(await prResp.text()).toContain("Puerto Rico needs a valid year.");
  });

  it("2026-08-19: Florida requires an explicit license_type_id choice (fixes the pre-existing individual-vs-firm mis-assignment bug)", async () => {
    const noChoiceResp = await postSubscribe({ email: `fl-nochoice-${Date.now()}@example.com`, state: "florida" }, "203.0.113.48");
    expect(noChoiceResp.status).toBe(400);
    expect(await noChoiceResp.text()).toContain("Florida needs to know which license you have -- individual or firm.");
  });

  it("2026-08-19: Florida firm signup persists only license_type_id, no anchor_date needed", async () => {
    const email = `fl-firm-${Date.now()}@example.com`;
    const resp = await postSubscribe({ email, state: "florida", license_type_id: "fl-firm" }, "203.0.113.49");
    expect(resp.status).toBe(200);
    const row = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?1").bind(email).first<SubscriberRow>();
    expect(row?.state_slug).toBe("florida");
    expect(JSON.parse(row?.deadline_fields ?? "{}")).toEqual({ license_type_id: "fl-firm" });
  });

  it("2026-08-19: Florida individual signup persists license_type_id and the certificate anchor_date", async () => {
    const email = `fl-individual-${Date.now()}@example.com`;
    const resp = await postSubscribe(
      { email, state: "florida", license_type_id: "fl-individual", anchor_date: "2020-03-15" },
      "203.0.113.50"
    );
    expect(resp.status).toBe(200);
    const row = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?1").bind(email).first<SubscriberRow>();
    expect(row?.state_slug).toBe("florida");
    expect(JSON.parse(row?.deadline_fields ?? "{}")).toEqual({ license_type_id: "fl-individual", anchor_date: "2020-03-15" });
  });

  it("2026-08-19: rejects a missing/future/malformed certificate date for Florida individual", async () => {
    const missingResp = await postSubscribe(
      { email: `fl-nodate-${Date.now()}@example.com`, state: "florida", license_type_id: "fl-individual" },
      "203.0.113.51"
    );
    expect(missingResp.status).toBe(400);
    expect(await missingResp.text()).toContain("Florida individual license needs your original certificate date");

    const farFuture = new Date();
    farFuture.setUTCFullYear(farFuture.getUTCFullYear() + 1);
    const futureResp = await postSubscribe(
      {
        email: `fl-future-${Date.now()}@example.com`,
        state: "florida",
        license_type_id: "fl-individual",
        anchor_date: farFuture.toISOString().slice(0, 10),
      },
      "203.0.113.52"
    );
    expect(futureResp.status).toBe(400);
    expect(await futureResp.text()).toContain("Florida needs a certificate date that already happened");
  });

  it("2026-08-19: Guam signup persists anchor_year and term_years, no license_type_id disambiguation needed", async () => {
    const email = `guam-${Date.now()}@example.com`;
    const resp = await postSubscribe({ email, state: "guam", anchor_year: "2024", term_years: "3" }, "203.0.113.53");
    expect(resp.status).toBe(200);
    const row = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?1").bind(email).first<SubscriberRow>();
    expect(row?.state_slug).toBe("guam");
    expect(JSON.parse(row?.deadline_fields ?? "{}")).toEqual({ anchor_year: "2024", term_years: "3" });
  });

  it("2026-08-19: rejects a missing/invalid year or term for Guam", async () => {
    const noYearResp = await postSubscribe({ email: `guam-noyear-${Date.now()}@example.com`, state: "guam", term_years: "2" }, "203.0.113.54");
    expect(noYearResp.status).toBe(400);
    expect(await noYearResp.text()).toContain("Guam needs a valid year.");

    const badTermResp = await postSubscribe(
      { email: `guam-badterm-${Date.now()}@example.com`, state: "guam", anchor_year: "2023", term_years: "4" },
      "203.0.113.55"
    );
    expect(badTermResp.status).toBe(400);
    expect(await badTermResp.text()).toContain("Guam needs a valid term length (1, 2, or 3 years).");
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
    expect(body.toLowerCase()).toContain("got it saved");
    // Orchestrator live-test finding (2026-08-05): this page used to say
    // self-serve signup wasn't open yet -- stale, since it already existed.
    // Now offers the real signup link unconditionally.
    expect(body).toContain("/firm-login/");
    expect(body.toLowerCase()).not.toContain("no account has been created yet");
    expect(body.toLowerCase()).not.toContain("the moment self-serve signup");

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

  it("orchestrator abuse-test finding (2026-08-05): the 429 page has Retry-After, a real title/<h1>, and a recovery link", async () => {
    const ip = "203.0.113.96";
    for (let i = 0; i < 5; i++) {
      await postFirmLead({ email: `firmlead-429ux-${i}-${Date.now()}@example.com`, firm_name: "Example Firm" }, ip);
    }
    const sixth = await postFirmLead({ email: `firmlead-429ux-6-${Date.now()}@example.com`, firm_name: "Example Firm" }, ip);
    expect(sixth.status).toBe(429);
    expect(sixth.headers.get("retry-after")).toBe("600");
    const body = await sixth.text();
    expect(body).toContain("<title>Slow down a little</title>");
    expect(body).toContain("<h1>Slow down a little</h1>");
    expect(body).toContain("/for-firms/");
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
// 2026-07-31 (login-CSRF fix): the POST now also requires the double-submit
// nonce that the GET render mints into both a hidden field and a cookie, so
// this helper performs the real two-step flow a human does -- render the
// confirm page, then submit its button. A POST missing either half is
// exactly the CSRF attack, and has its own tests.
async function postFirmLoginVerify(token: string | null, ip: string, newPassword?: string): Promise<Response> {
  let nonce = "";
  let cookie = "";
  if (token !== null) {
    const page = await getFirmLoginVerifyPage(token, ip);
    const html = await page.text();
    nonce = /name="action_csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
    cookie = (page.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
  }
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    "cf-connecting-ip": ip,
  };
  if (cookie) headers["Cookie"] = cookie;
  const fields: Record<string, string> =
    token !== null ? { token, action_csrf: nonce } : {};
  if (newPassword !== undefined) fields.new_password = newPassword;
  return SELF.fetch("https://deadline-radar.com/firm/login/verify", {
    method: "POST",
    headers,
    body: form(fields),
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
    expect(firm?.plan_tier).toBe("free");
    expect(firm?.status).toBe("active");
    // Roadmap #56: the real signup path records which Terms version was
    // live at signup time (validation.ts's TERMS_VERSION).
    expect(firm?.tos_accepted_version).toBe(TERMS_VERSION);

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
    // Roadmap #56: the ORIGINAL acceptance record, not re-stamped by the resend.
    expect(rows.results[0]?.tos_accepted_version).toBe(TERMS_VERSION);
  });

  it("Task #11: stores an optional admin_name when provided", async () => {
    const email = `firmsignup-adminname-${Date.now()}@example.com`;
    const resp = await postFirmSignup({ name: "Named Admin Firm", admin_email: email, admin_name: "  Jane Smith  " }, "203.0.113.170");
    expect(resp.status).toBe(200);
    const firm = await firmByAdminEmail(email);
    expect(firm?.admin_name).toBe("Jane Smith"); // trimmed
  });

  it("Task #11: admin_name is optional -- omitting it stores null, not an error", async () => {
    const email = `firmsignup-noadminname-${Date.now()}@example.com`;
    const resp = await postFirmSignup({ name: "No Admin Name Firm", admin_email: email }, "203.0.113.171");
    expect(resp.status).toBe(200);
    const firm = await firmByAdminEmail(email);
    expect(firm?.admin_name).toBeNull();
  });

  it("Task #11: a repeat signup does not overwrite an existing admin_name, even if resubmitted blank", async () => {
    const email = `firmsignup-adminname-noclobber-${Date.now()}@example.com`;
    await postFirmSignup({ name: "First", admin_email: email, admin_name: "Original Name" }, "203.0.113.172");
    await postFirmSignup({ name: "First Again", admin_email: email }, "203.0.113.173"); // no admin_name this time
    const firm = await firmByAdminEmail(email);
    expect(firm?.admin_name).toBe("Original Name");
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

  // AuditLab RL-7 (2026-08-06, MEDIUM): same per-recipient gap as RL-6 on
  // /firm/login, but this route always sends on every accepted submission
  // (repeat signups for an existing email just resend the login link) --
  // no anti-enumeration branch to hide behind, so the 6th request for the
  // SAME email returns 429 directly, even from a fresh IP each time.
  it("RL-7: blocks the 6th request for the SAME email even across different IPs (per-recipient bucket)", async () => {
    const email = `firmsignup-acct-rl7-${Date.now()}@example.com`;
    for (let i = 0; i < 5; i++) {
      const resp = await postFirmSignup({ name: "Account RL7 Firm", admin_email: email }, `203.0.113.${250 + i}`);
      expect(resp.status).not.toBe(429);
    }
    const sixth = await postFirmSignup({ name: "Account RL7 Firm", admin_email: email }, "203.0.113.255");
    expect(sixth.status).toBe(429);
  });

  // AuditLab F-4, 2026-08-02 (LOW): `firms.admin_email` had no UNIQUE
  // constraint. Two rows could hold the same email (reproduced via two
  // concurrent POST /firm/signup from the same IP -- the rate-limit bucket
  // doesn't serialize them), and findFirmByAdminEmail() is LIMIT 1 with no
  // ORDER BY, so exactly one is ever reachable by any auth path -- the
  // other's roster becomes permanently orphaned.
  it("migration 0015: a second firms row for the same (normalized) admin_email is REJECTED at the DB layer", async () => {
    const email = `unique-admin-email-${Date.now()}@example.com`;
    await store.createFirm(env.DB, { name: "First Firm", adminEmail: email });
    // Case AND whitespace variants -- the unique index is on
    // LOWER(TRIM(admin_email)), exactly mirroring findFirmByAdminEmail()'s
    // own lookup, not the raw column.
    await expect(
      store.createFirm(env.DB, { name: "Duplicate Firm", adminEmail: `  ${email.toUpperCase()}  ` })
    ).rejects.toThrow();

    const rows = await env.DB.prepare("SELECT id FROM firms WHERE LOWER(TRIM(admin_email)) = ?1")
      .bind(email.toLowerCase())
      .all();
    expect(rows.results?.length).toBe(1);
  });

  // handleFirmSignup()'s recovery from a losing concurrent insert (catch ->
  // re-read via findFirmByAdminEmail(), same posture as
  // handleOauthCallback()'s existing race handling) is verified by reading
  // the code, not exercised here: this test runtime is single-threaded per
  // request, so the actual TOCTOU window between the pre-check and the
  // INSERT cannot be forced open from outside. What IS directly proven
  // above is the thing that makes the race survivable at all -- the losing
  // insert now fails loudly instead of silently succeeding twice. Same
  // disclosed-gap posture as F-1's OAuth session-creation path.
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
    const resp = await worker.fetch(request, envWithAllowlist, testExecutionContext());
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
    const resp = await worker.fetch(request, envWithAllowlist, testExecutionContext());
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
        "INSERT INTO firms (id, name, admin_email, plan_tier, status, created_at) VALUES (?1, ?2, ?3, 'free', 'active', datetime('now'))"
      )
      .bind(firmId, "Preexisting Gmail Firm", email)
      .run();
    // migration 0045: a raw firms INSERT (bypassing store.createFirm())
    // has no matching firm_members row -- real firms always do, backfilled
    // by the migration itself, so a matching insert here is what makes
    // this accurately simulate "an existing account," not an artifact of
    // the test skipping real setup.
    const memberId = crypto.randomUUID();
    await env.DB
      .prepare(
        "INSERT INTO firm_members (id, firm_id, email, role, invited_at, joined_at, created_at) VALUES (?1, ?2, ?3, 'partner', datetime('now'), datetime('now'), datetime('now'))"
      )
      .bind(memberId, firmId, email)
      .run();
    await env.DB.prepare("UPDATE firms SET primary_member_id = ?1 WHERE id = ?2").bind(memberId, firmId).run();

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
        "INSERT INTO firms (id, name, admin_email, plan_tier, status, created_at) VALUES (?1, ?2, ?3, 'free', 'active', datetime('now'))"
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
        "INSERT INTO firms (id, name, admin_email, plan_tier, status, created_at) VALUES (?1, ?2, ?3, 'free', 'active', datetime('now'))"
      )
      .bind(firmId, "Preexisting Gmail Firm", email)
      .run();
    // migration 0045: see the identical comment on the sibling test above --
    // a real existing firm always has a matching firm_members row.
    const memberId = crypto.randomUUID();
    await env.DB
      .prepare(
        "INSERT INTO firm_members (id, firm_id, email, role, invited_at, joined_at, created_at) VALUES (?1, ?2, ?3, 'partner', datetime('now'), datetime('now'), datetime('now'))"
      )
      .bind(memberId, firmId, email)
      .run();
    await env.DB.prepare("UPDATE firms SET primary_member_id = ?1 WHERE id = ?2").bind(memberId, firmId).run();

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
    const bodyExisting = await (await worker.fetch(requestExisting, envPreview, testExecutionContext())).text();

    const requestNone = new Request("https://deadline-radar.com/firm/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.175" },
      body: form({ admin_email: `firmlogin-navlinks-preview-none-${Date.now()}@example.com` }),
    });
    const bodyNone = await (await worker.fetch(requestNone, envPreview, testExecutionContext())).text();

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

  // Adversarial-review M2 (2026-08-05): store.normalizeLoginTokenPurpose()
  // was widened to accept "email_change" for POST /firm/change-email's own
  // use -- but this route is UNAUTHENTICATED and pre-session. Before the
  // fix, submitting intent=email_change here minted a privileged-purpose
  // token (with pending_new_email left NULL, since this form has no such
  // field) for ANY existing firm's email, harmless today only because
  // handleFirmLoginVerify() also happens to check pendingNewEmail is
  // truthy -- one future edit away from being the only guard. This route
  // must only ever be able to produce "login" or "password_reset".
  it("M2 regression: intent=email_change from the unauthenticated form is downgraded to a plain login token, never minted as email_change", async () => {
    const email = `firmlogin-m2-${Date.now()}@example.com`;
    await postFirmSignup({ name: "M2 Firm", admin_email: email }, "203.0.113.292");
    const firm = await firmByAdminEmail(email);

    const resp = await postFirmLogin({ admin_email: email, intent: "email_change" }, "203.0.113.293");
    expect(resp.status).toBe(200);

    const rows = await env.DB
      .prepare("SELECT purpose FROM firm_login_tokens WHERE firm_id = ?1 ORDER BY created_at DESC LIMIT 1")
      .bind(firm?.id)
      .first<{ purpose: string }>();
    expect(rows?.purpose).not.toBe("email_change");
    expect(rows?.purpose).toBe("login");
  });

  // AuditLab re-verify follow-up, 2026-08-03: a suspended firm's login
  // TOKEN still correctly 403s on redemption (F-1), but this resend
  // endpoint issued and emailed a fresh one anyway -- spending a send from
  // the shared daily cap on an account that's been cut off. Fixed by
  // adding `existing.status === "active"` to the same condition, not a
  // separate branch -- response must stay byte-identical either way.
  it("for a SUSPENDED firm issues NO new token, but the response is still identical to a real send (no new enumeration oracle)", async () => {
    const email = `firmlogin-suspended-${Date.now()}@example.com`;
    await postFirmSignup({ name: "Suspended Resend Firm", admin_email: email }, "203.0.113.176");
    const firm = await firmByAdminEmail(email);
    await env.DB.prepare("UPDATE firms SET status = 'suspended' WHERE id = ?1").bind(firm?.id).run();

    const before = await env.DB
      .prepare("SELECT COUNT(*) as c FROM firm_login_tokens WHERE firm_id = ?1")
      .bind(firm?.id)
      .first<{ c: number }>();

    const suspendedResp = await postFirmLogin({ admin_email: email }, "203.0.113.177");
    const noneResp = await postFirmLogin(
      { admin_email: `firmlogin-suspended-none-${Date.now()}@example.com` },
      "203.0.113.178"
    );
    expect(suspendedResp.status).toBe(200);
    expect(await suspendedResp.text()).toBe(await noneResp.text());

    const after = await env.DB
      .prepare("SELECT COUNT(*) as c FROM firm_login_tokens WHERE firm_id = ?1")
      .bind(firm?.id)
      .first<{ c: number }>();
    expect(after?.c).toBe(before?.c ?? 0); // unchanged -- no token issued
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

  // AuditLab RL-6 (2026-08-06, HIGH): the IP bucket above cannot see a
  // distributed mail-bomb aimed at one recipient -- an attacker spread
  // across many IPs could exhaust a single firm admin's inbox. This asserts
  // the SEND itself (via the firm_login_tokens row count) stops once the
  // per-recipient bucket is exhausted, even though every response stays a
  // byte-identical 200 -- the response can never reveal the account bucket
  // tripped, only the token count proves it (same anti-enumeration posture
  // as the rest of this handler).
  it("RL-6: throttles the SEND per RECIPIENT even across different IPs, while every response stays 200 (anti-enumeration preserved)", async () => {
    const email = `firmlogin-acct-rl6-${Date.now()}@example.com`;
    await postFirmSignup({ name: "Account RL6 Firm", admin_email: email }, "203.0.113.230");
    const firm = await firmByAdminEmail(email);
    const before = await env.DB
      .prepare("SELECT COUNT(*) as c FROM firm_login_tokens WHERE firm_id = ?1")
      .bind(firm?.id)
      .first<{ c: number }>();

    // Signup's own send uses a SEPARATE bucket (firm_signup_account, RL-7) --
    // doesn't touch this one. The firm_login_account bucket allows 5
    // sends/hour; each of these 6 requests comes from a FRESH IP so only the
    // account-keyed bucket can possibly throttle them.
    for (let i = 0; i < 6; i++) {
      const resp = await postFirmLogin({ admin_email: email }, `203.0.113.${240 + i}`);
      expect(resp.status).toBe(200); // never 429 -- anti-enumeration response never changes
    }

    const after = await env.DB
      .prepare("SELECT COUNT(*) as c FROM firm_login_tokens WHERE firm_id = ?1")
      .bind(firm?.id)
      .first<{ c: number }>();
    // 6 login attempts, but only 5 sends allowed by the account bucket.
    expect(after?.c).toBe((before?.c ?? 0) + 5);
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
    // 2026-07-31 (login-CSRF fix): the render DOES now set the double-submit
    // nonce cookie -- that is the whole point of the render step. What it
    // must still never set is a SESSION.
    const rendered = resp.headers.get("Set-Cookie") ?? "";
    expect(rendered).toContain("dr_action_csrf=");
    expect(rendered).not.toContain("dr_firm_session");
    const body = await resp.text();
    expect(body.toLowerCase()).toContain("sign in");
    expect(body).toContain(`name="token" value="${rawToken}"`);
    expect(body).toContain('method="post"');
    expect(body).toContain('name="action_csrf" value=');

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

// 2026-08-02: the confirm page's optional "set a password" field, added
// because signup never asked for one and the dashboard's own account panel
// to set one afterward went undiscovered in practice.
describe("POST /firm/login/verify -- optional inline password-set", () => {
  it("a brand-new firm (no password) can set one as part of the same sign-in click", async () => {
    const email = `firmverify-setpw-${Date.now()}@example.com`;
    await postFirmSignup({ name: "New Password Firm", admin_email: email }, "203.0.113.190");
    const firm = await firmByAdminEmail(email);
    // migration 0045: a password is set on the founding partner's OWN
    // firm_members row now, not firms.password_hash directly (which stays
    // null unless store.setFirmPassword()'s own backward-compat mirror is
    // used -- see that function's docstring).
    const memberBefore = await store.findFirmMemberByEmail(env.DB, email);
    expect(memberBefore?.password_hash).toBeNull();
    const { rawToken } = await store.createLoginToken(env.DB, firm!.id);

    const resp = await postFirmLoginVerify(rawToken, "203.0.113.191", "a-genuinely-strong-password");
    expect(resp.status).toBe(302);
    expect(resp.headers.get("Location")).toBe("/firm-dashboard/");

    const after = await store.findFirmMemberByEmail(env.DB, email);
    expect(after?.password_hash).not.toBeNull();
    const ok = await verifyPassword(
      "a-genuinely-strong-password",
      {
        algo: after?.password_algo ?? undefined,
        salt: after?.password_salt ?? undefined,
        iterations: after?.password_iterations ?? undefined,
        rounds: after?.password_rounds ?? undefined,
        hash: after!.password_hash as string,
      }
    );
    expect(ok).toBe(true);
  });

  it("sign-in still succeeds, and no password is set, when the field is left blank", async () => {
    const email = `firmverify-nopw-${Date.now()}@example.com`;
    await postFirmSignup({ name: "No Password Firm", admin_email: email }, "203.0.113.192");
    const firm = await firmByAdminEmail(email);
    const { rawToken } = await store.createLoginToken(env.DB, firm!.id);

    const resp = await postFirmLoginVerify(rawToken, "203.0.113.193");
    expect(resp.status).toBe(302);

    const after = await firmByAdminEmail(email);
    expect(after?.password_hash).toBeNull();
  });

  it("sign-in still succeeds, and no password is set, when the supplied password is too weak", async () => {
    const email = `firmverify-weakpw-${Date.now()}@example.com`;
    await postFirmSignup({ name: "Weak Password Firm", admin_email: email }, "203.0.113.194");
    const firm = await firmByAdminEmail(email);
    const { rawToken } = await store.createLoginToken(env.DB, firm!.id);

    const resp = await postFirmLoginVerify(rawToken, "203.0.113.195", "short");
    expect(resp.status).toBe(302);

    const after = await firmByAdminEmail(email);
    expect(after?.password_hash).toBeNull();
  });

  it("does NOT overwrite an EXISTING password -- changing one must go through the current-password check or reset flow, never this field", async () => {
    const email = `firmverify-haspw-${Date.now()}@example.com`;
    await postFirmSignup({ name: "Has Password Firm", admin_email: email }, "203.0.113.196");
    const firm = await firmByAdminEmail(email);
    await store.setFirmPassword(env.DB, firm!.id, await hashPassword("the-original-password"));

    const { rawToken } = await store.createLoginToken(env.DB, firm!.id);
    const resp = await postFirmLoginVerify(rawToken, "203.0.113.197", "an-attempted-replacement-password");
    expect(resp.status).toBe(302);

    const after = await firmByAdminEmail(email);
    const stillOriginal = await verifyPassword(
      "the-original-password",
      {
        algo: after?.password_algo ?? undefined,
        salt: after?.password_salt ?? undefined,
        iterations: after?.password_iterations ?? undefined,
        rounds: after?.password_rounds ?? undefined,
        hash: after!.password_hash as string,
      }
    );
    expect(stillOriginal).toBe(true);
  });

  it("is ignored on a password-reset token -- that flow keeps its own dedicated /set-password/ page", async () => {
    const email = `firmverify-resetpw-${Date.now()}@example.com`;
    await postFirmSignup({ name: "Reset Password Firm", admin_email: email }, "203.0.113.198");
    const firm = await firmByAdminEmail(email);
    expect(firm?.password_hash).toBeNull();
    const { rawToken } = await store.createLoginToken(env.DB, firm!.id, "password_reset");

    const resp = await postFirmLoginVerify(rawToken, "203.0.113.199", "should-not-be-set-here");
    expect(resp.status).toBe(302);
    // Purpose-based destination is unaffected by the optional field.
    expect(resp.headers.get("Location")).toBe("/set-password/");

    const after = await firmByAdminEmail(email);
    expect(after?.password_hash).toBeNull();
  });

  // 2026-08-03, reported directly: the GET confirm page used to show this
  // field regardless of the token's purpose, so a firm resetting their
  // password would fill it in, submit, and land on /set-password/ anyway
  // with their input silently dropped -- looked like being asked to set a
  // password twice.
  it("the GET confirm page does NOT show the optional password field for a password-reset token", async () => {
    const email = `firmverify-resetpw-render-${Date.now()}@example.com`;
    await postFirmSignup({ name: "Reset Password Render Firm", admin_email: email }, "203.0.113.201");
    const firm = await firmByAdminEmail(email);
    const { rawToken } = await store.createLoginToken(env.DB, firm!.id, "password_reset");

    const resp = await getFirmLoginVerifyPage(rawToken, "203.0.113.201");
    expect(resp.status).toBe(200);
    const body = await resp.text();
    expect(body).not.toContain("dr-optional-password");
    expect(body).not.toContain("Optional: set a password now");
    expect(body).toContain("choose a new password on the next screen");
  });

  it("the GET confirm page DOES show the optional password field for a normal login token", async () => {
    const email = `firmverify-login-render-${Date.now()}@example.com`;
    await postFirmSignup({ name: "Login Render Firm", admin_email: email }, "203.0.113.202");
    const firm = await firmByAdminEmail(email);
    const { rawToken } = await store.createLoginToken(env.DB, firm!.id);

    const resp = await getFirmLoginVerifyPage(rawToken, "203.0.113.202");
    expect(resp.status).toBe(200);
    const body = await resp.text();
    expect(body).toContain("dr-optional-password");
    expect(body).toContain("Optional: set a password now");
  });
});

// 2026-08-03, reported directly off a screenshot: an already-used or
// expired sign-in link showed prose telling the reader to "request a new
// one," with no actual way to do that from the page -- a dead end.
describe("Reused/expired login-link error pages offer an actual next step", () => {
  it("firm /firm/login/verify: invalid token error links to /firm-login/", async () => {
    const resp = await postFirmLoginVerify("this-token-does-not-exist", "203.0.113.203");
    expect(resp.status).toBe(400);
    const body = await resp.text();
    expect(body).toContain('href="/firm-login/"');
  });

  it("subscriber /subscriber/login/verify: invalid token error links to /signin/", async () => {
    // CSRF nonce is generated at render time regardless of whether the token
    // itself turns out to be valid (actionConfirmPage() never looks the
    // token up) -- a real GET first is still required to get a matching
    // cookie + nonce pair past the CSRF check, so the POST reaches the
    // "invalid token" branch this test actually targets.
    const ip = "203.0.113.204";
    const getResp = await SELF.fetch(
      "https://deadline-radar.com/api/subscriber/login/verify?token=this-token-does-not-exist",
      { headers: { "cf-connecting-ip": ip } }
    );
    const getHtml = await getResp.text();
    const nonce = /name="action_csrf" value="([^"]+)"/.exec(getHtml)?.[1] ?? "";
    const cookie = (getResp.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";

    const resp = await SELF.fetch("https://deadline-radar.com/api/subscriber/login/verify", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "cf-connecting-ip": ip,
        Cookie: cookie,
      },
      body: form({ token: "this-token-does-not-exist", action_csrf: nonce }),
    });
    expect(resp.status).toBe(400);
    const body = await resp.text();
    expect(body).toContain('href="/signin/"');
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

  // AuditLab cookie/CSRF posture re-verify (2026-08-21): logout used to be
  // the only authenticated state-changing route in this file with no
  // originAllowed() call. Same three-case shape as the /firm/licenses CSRF
  // suite above: mismatched Origin rejected, absent Origin still succeeds
  // (real browsers don't always send Origin on a same-site request),
  // matching Origin still succeeds.
  it("SEC (logout CSRF consistency): rejected when the Origin header doesn't match any allowed origin, and the session survives", async () => {
    const email = `firmlogoutcsrf-${Date.now()}@example.com`;
    await postFirmSignup({ name: "Logout CSRF Firm", admin_email: email }, "203.0.113.184");
    const firm = await firmByAdminEmail(email);
    const { rawSessionToken } = await store.createSession(env.DB, firm!.id);

    const resp = await SELF.fetch("https://deadline-radar.com/firm/logout", {
      method: "POST",
      headers: { "cf-connecting-ip": "203.0.113.185", Cookie: `dr_firm_session=${rawSessionToken}`, Origin: "https://attacker.example" },
      redirect: "manual",
    });
    expect(resp.status).toBe(400);

    const after = await store.verifySession(env.DB, rawSessionToken);
    expect(after?.firmId).toBe(firm!.id); // NOT logged out -- the forged request was refused, not honored
  });

  it("SEC (logout CSRF consistency): still succeeds with a real, matching Origin header", async () => {
    const email = `firmlogoutorigin-${Date.now()}@example.com`;
    await postFirmSignup({ name: "Logout Origin Firm", admin_email: email }, "203.0.113.186");
    const firm = await firmByAdminEmail(email);
    const { rawSessionToken } = await store.createSession(env.DB, firm!.id);

    const resp = await SELF.fetch("https://deadline-radar.com/firm/logout", {
      method: "POST",
      headers: { "cf-connecting-ip": "203.0.113.187", Cookie: `dr_firm_session=${rawSessionToken}`, Origin: "https://deadline-radar.com" },
      redirect: "manual",
    });
    expect(resp.status).toBe(302);
    const after = await store.verifySession(env.DB, rawSessionToken);
    expect(after).toBeNull();
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

  // AuditLab F-1, 2026-08-02: firms.status was previously enforced on only
  // 2 of 12+ firm routes (the two mobility ones); every other route,
  // including the roster and CPE data, stayed fully readable/writable
  // regardless of suspension. This is the fix's central test -- everything
  // else (the individual routes below, the 3 session-creation entry
  // points) exists to prove this one property holds everywhere, not just
  // here in isolation.
  it("rejects an otherwise-valid session once the firm's status is not 'active'", async () => {
    const { requireFirmSession } = await import("../src/index");
    const firmId = (
      await store.createFirm(env.DB, { name: "Suspended Session Firm", adminEmail: `suspsess-${Date.now()}@example.com` })
    ).id;
    const { rawSessionToken } = await store.createSession(env.DB, firmId);
    await env.DB.prepare("UPDATE firms SET status = 'suspended' WHERE id = ?1").bind(firmId).run();

    const request = new Request("https://deadline-radar.com/firm-dashboard/", {
      headers: { Cookie: `dr_firm_session=${rawSessionToken}` },
    });
    const result = await requireFirmSession(request, env);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(403);
    const body = await (result as Response).text();
    expect(body).toContain("sort it out");
  });
});

describe("AuditLab F-1 -- firms.status is enforced on real routes, not just requireFirmSession() in isolation", () => {
  async function suspendedFirmSession(): Promise<{ firmId: string; cookie: string }> {
    const { firmId, cookie } = await createFirmWithSession(
      "Suspended Routes Firm",
      `suspended-routes-${Date.now()}@example.com`
    );
    await env.DB.prepare("UPDATE firms SET status = 'suspended' WHERE id = ?1").bind(firmId).run();
    return { firmId, cookie };
  }

  it("GET /firm/licenses -- was reachable while suspended (AuditLab evidence), now 403s", async () => {
    const { cookie } = await suspendedFirmSession();
    expect((await getFirmLicenses(cookie)).status).toBe(403);
  });

  it("POST /firm/licenses -- was reachable while suspended (AuditLab evidence), now 403s", async () => {
    const { cookie } = await suspendedFirmSession();
    const resp = await postFirmLicense(cookie, {
      email: `suspended-staff-${Date.now()}@example.com`,
      state_slug: "georgia",
      license_type_id: "ga-individual",
    });
    expect(resp.status).toBe(403);
  });

  it("POST /firm/cpe -- was reachable while suspended (AuditLab evidence), now 403s", async () => {
    const { cookie } = await suspendedFirmSession();
    const resp = await postCpeEntry(
      cookie,
      { subscriber_id: "does-not-matter", entry_date: "2026-06-01", hours: "1", category: "general" },
      "203.0.113.220"
    );
    expect(resp.status).toBe(403);
  });

  it("POST /firm/login/password -- a suspended firm cannot mint a NEW session even with the correct password", async () => {
    const email = `suspended-passwordlogin-${Date.now()}@example.com`;
    const firm = await firmWithPassword(email, STRONG_PASSWORD);
    await env.DB.prepare("UPDATE firms SET status = 'suspended' WHERE id = ?1").bind(firm.id).run();
    const resp = await postPasswordLogin(
      { admin_email: email, password: STRONG_PASSWORD },
      "203.0.113.221"
    );
    expect(resp.status).toBe(403);
    expect(resp.headers.get("Set-Cookie")).toBeNull();
  });

  it("POST /firm/login/verify (magic link) -- a suspended firm's login token is refused, and is still burned (single-use)", async () => {
    const firmId = (
      await store.createFirm(env.DB, { name: "Suspended Verify Firm", adminEmail: `suspended-verify-${Date.now()}@example.com` })
    ).id;
    await env.DB.prepare("UPDATE firms SET status = 'suspended' WHERE id = ?1").bind(firmId).run();
    const { rawToken } = await store.createLoginToken(env.DB, firmId);

    const resp = await postFirmLoginVerify(rawToken, "203.0.113.222");
    expect(resp.status).toBe(403);
    expect(resp.headers.get("Set-Cookie")).toBeNull();

    // Confirms the token is still single-use (not silently left valid for
    // reactivation-then-replay) -- the same guarantee every other login
    // token in this file already carries.
    const second = await postFirmLoginVerify(rawToken, "203.0.113.223");
    expect(second.status).toBe(400);
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

  it("orchestrator abuse-test finding (2026-08-05): the 401 body is real JSON, not a full HTML error page", async () => {
    const resp = await getFirmLicenses(null);
    expect(resp.status).toBe(401);
    expect(resp.headers.get("content-type")).toContain("application/json");
    const body = (await resp.json()) as { error: string };
    expect(typeof body.error).toBe("string");
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
    // renewed_at/last_edited_at (migration 0017, 2026-08-04): real facts now,
    // not fabricated -- null until the first PATCH or .../renew actually
    // touches this row, which a fresh admin-added record never has.
    expect(item?.renewed_at).toBeNull();
    expect(item?.last_edited_at).toBeNull();

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

  it("AuditLab ST-1: GET /firm/licenses discloses data_as_of/data_stale instead of silently rendering dates off reference data the write guards can refuse", async () => {
    const { cookie } = await createFirmWithSession("Freshness Firm", `freshness-${Date.now()}@example.com`);
    const body = (await (await getFirmLicenses(cookie)).json()) as { data_as_of: string; data_stale: boolean };
    expect(body.data_as_of).toBe(cpaDeadlinesData.as_of_date);
    // Real wall-clock date in this test run is not stale relative to the
    // bundled reference data -- if this ever flips true, the underlying
    // dataset itself needs re-verification, not this test.
    expect(body.data_stale).toBe(false);
  });

  it("GET /firm/licenses discloses seat_cap (dashboard-polish #1, 2026-08-05) so the client can show usage against the cap before a firm actually hits it -- 25 for a GRANDFATHERED (pre-roadmap-#151-cutover) firm", async () => {
    const { firmId, cookie } = await createFirmWithSession("Seat Cap Firm", `seatcap-${Date.now()}@example.com`);
    await env.DB.prepare("UPDATE firms SET created_at = '2020-01-01T00:00:00Z' WHERE id = ?1").bind(firmId).run();
    const body = (await (await getFirmLicenses(cookie)).json()) as { seat_cap: number };
    // Same constant POST /firm/licenses's own 402 enforcement reads
    // (SELF_SERVE_SEAT_CAP) -- asserting the literal value, not importing
    // it, so this test also catches the constant silently changing. A
    // firm that signs up AFTER the roadmap #151 cutover gets a different,
    // narrower cap instead -- see that feature's own dedicated describe
    // block for the new-signup case.
    expect(body.seat_cap).toBe(25);
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
      const resp = await worker.fetch(request, envWithKey, testExecutionContext());
      expect(resp.status).toBe(201);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [, sendGridCallInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const sentBody = JSON.parse(String(sendGridCallInit.body));
      expect(sentBody.subject).toContain("Bennett CPA Group added you to Deadline-Radar");
      const textContent = sentBody.content.find((c: { type: string }) => c.type === "text/plain").value as string;
      expect(textContent).toContain("Bennett CPA Group added you to Deadline-Radar");
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
    const { firmId, cookie } = await createFirmWithSession("Rate Limited Firm", `ratelimit-${Date.now()}@example.com`);
    // Delete each one straight after creating it (directly via store.ts, not
    // the HTTP route -- this test isn't about DELETE, only about keeping the
    // LIVE roster at 1 seat throughout so the BILL-1 seat cap (25) never
    // confounds it) -- the daily CREATE rate-limit bucket this test targets
    // counts create attempts regardless of later removal.
    for (let i = 0; i < RATE_LIMIT_FIRM_LICENSE_CREATE.max; i++) {
      const resp = await postFirmLicense(cookie, {
        email: `ratelimit-staff-${i}-${Date.now()}@example.com`,
        state_slug: "georgia",
        license_type_id: "ga-individual",
      });
      expect(resp.status).toBe(201);
      const { id } = (await resp.json()) as { id: string };
      await store.removeFirmLicense(env.DB, firmId, id);
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
    expect(originalRow?.last_edited_at).toBeNull();
    const labelPatch = await patchFirmLicense(cookie, createdBody.id, { staff_label: "New Label" });
    expect(labelPatch.status).toBe(200);
    const afterLabel = await env.DB.prepare("SELECT * FROM subscribers WHERE id = ?1").bind(createdBody.id).first<SubscriberRow>();
    expect(afterLabel?.staff_label).toBe("New Label");
    expect(afterLabel?.status).toBe(store.STATUS_CONFIRMED); // unchanged -- no email edit here
    // last_edited_at (migration 0017): a rename must be a real, distinct fact
    // in the audit trail, not silently indistinguishable from the original
    // "added to the roster" activity entry (reported directly, 2026-08-04).
    expect(afterLabel?.last_edited_at).toBeTruthy();
    expect(afterLabel?.created_at).toBe(originalRow?.created_at); // an edit must never touch created_at

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

  // AuditLab S-3, 2026-08-03 (LOW): these two had no bucket at all, unlike
  // PATCH (F-2) and POST (RATE_LIMIT_FIRM_LICENSE_CREATE). No send path
  // either way, but the rate-limit check runs before the id lookup, so a
  // nonexistent id still consumes the bucket -- exactly what makes this test
  // cheap to write.
  it("DELETE /firm/licenses/:id is rate-limited per firm (was completely unbounded)", async () => {
    const { cookie } = await createFirmWithSession("Delete Rate Firm", `delete-rate-${Date.now()}@example.com`);
    let sawA429 = false;
    for (let i = 0; i < 55; i++) {
      const resp = await deleteFirmLicense(cookie, "does-not-exist");
      if (resp.status === 429) {
        sawA429 = true;
        break;
      }
      expect(resp.status).toBe(404);
    }
    expect(sawA429, "expected a 429 within the RATE_LIMIT_FIRM_LICENSE_DELETE ceiling (50/day) -- got none in 55 requests").toBe(true);
  }, 20000);

  it("POST /firm/licenses/:id/renew is rate-limited per firm (was completely unbounded)", async () => {
    const { cookie } = await createFirmWithSession("Renew Rate Firm", `renew-rate-${Date.now()}@example.com`);
    let sawA429 = false;
    for (let i = 0; i < 55; i++) {
      const resp = await renewFirmLicense(cookie, "does-not-exist");
      if (resp.status === 429) {
        sawA429 = true;
        break;
      }
      expect(resp.status).toBe(404);
    }
    expect(sawA429, "expected a 429 within the RATE_LIMIT_FIRM_LICENSE_RENEW ceiling (50/day) -- got none in 55 requests").toBe(true);
  }, 20000);

  // AuditLab F-2, 2026-08-02 (HIGH): PATCH had NO rate limit at all -- PoC
  // sent 400 PATCHes to one row and got 400 accepted, 0 rejected. Each
  // email-changing PATCH fires a fresh confirmation email to the new
  // address, so this was an unbounded mail-bomb primitive from an
  // authenticated session, and could exhaust the GLOBAL daily send cap
  // shared with the real reminder cron.
  it("PATCH /firm/licenses/:id is rate-limited per firm (was completely unbounded)", async () => {
    const { cookie } = await createFirmWithSession("Patch Rate Firm", `patch-rate-${Date.now()}@example.com`);
    const created = await postFirmLicense(cookie, {
      email: `patch-rate-staff-${Date.now()}@example.com`,
      state_slug: "georgia",
      license_type_id: "ga-individual",
    });
    const { id } = (await created.json()) as { id: string };
    let sawA429 = false;
    for (let i = 0; i < 55; i++) {
      const resp = await patchFirmLicense(cookie, id, { staff_label: `Label ${i}` });
      if (resp.status === 429) {
        sawA429 = true;
        break;
      }
      expect(resp.status).toBe(200);
    }
    expect(sawA429, "expected a 429 within the RATE_LIMIT_FIRM_LICENSE_PATCH ceiling (50/day) -- got none in 55 requests").toBe(true);
  }, 20000);

  // AuditLab F-3, 2026-08-02 (MEDIUM): PATCH skipped the (email, state_slug)
  // dedupe POST already enforces, so a firm could PATCH a roster row onto
  // an email+state that already had a live record elsewhere -- including a
  // free-tier individual's -- producing two live rows for the same person.
  it("PATCH onto an (email, state_slug) that already has a live record elsewhere is refused 409, same as POST", async () => {
    const { cookie } = await createFirmWithSession("Patch Dedupe Firm", `patch-dedupe-${Date.now()}@example.com`);
    const victimEmail = `patch-dedupe-victim-${Date.now()}@example.com`;

    // The pre-existing record: a free-tier signup, confirmed.
    await postSubscribe({ email: victimEmail, state: "georgia", license_type_id: "ga-individual" }, "203.0.113.230");
    const victimRow = await env.DB
      .prepare("SELECT confirm_token FROM subscribers WHERE email = ?1")
      .bind(victimEmail)
      .first<{ confirm_token: string }>();
    await store.confirm(env.DB, victimRow!.confirm_token);

    // This firm's own unrelated roster row -- already in the SAME state as
    // the collision, so only the email needs to change (keeps this test
    // about the dedupe check, not state_slug's separate deadline-field
    // validation requirements).
    const created = await postFirmLicense(cookie, {
      email: `patch-dedupe-own-${Date.now()}@example.com`,
      state_slug: "georgia",
      license_type_id: "ga-individual",
    });
    const { id } = (await created.json()) as { id: string };

    const patchResp = await patchFirmLicense(cookie, id, { email: victimEmail });
    expect(patchResp.status).toBe(409);

    // Confirm no duplicate was actually created -- the row was NOT updated.
    const rows = await env.DB.prepare("SELECT id FROM subscribers WHERE email = ?1 AND state_slug = 'georgia'").bind(victimEmail).all();
    expect(rows.results?.length).toBe(1);
  });

  it("re-saving a PATCH with its OWN unchanged (email, state_slug) is NOT rejected as a false self-conflict", async () => {
    const { cookie } = await createFirmWithSession("Patch Selfsave Firm", `patch-selfsave-${Date.now()}@example.com`);
    const email = `patch-selfsave-staff-${Date.now()}@example.com`;
    const created = await postFirmLicense(cookie, { email, state_slug: "georgia", license_type_id: "ga-individual" });
    const { id } = (await created.json()) as { id: string };

    // Same email (state_slug omitted entirely -- unchanged), just a label
    // change -- must succeed, not 409 against itself.
    const resp = await patchFirmLicense(cookie, id, { email, staff_label: "Unchanged pair" });
    expect(resp.status).toBe(200);
  });
});

describe("POST /firm/licenses -- BILL-1 seat cap (25 staff, GRANDFATHERED firms only as of roadmap #151, 2026-08-10)", () => {
  // Roadmap #151 Phase 2 (2026-08-10): the free-tier seat cap is now 25
  // ONLY for a firm that signed up before VALUE_LINE_CUTOVER_DATE -- these
  // tests' own intent (the 25-cap boundary, the "over cap" freeze, seat
  // reuse) predates #151 and is about that BOUNDARY, not about which
  // number applies to which firm -- so each firm here is explicitly
  // backdated to keep testing the same boundary under its new,
  // grandfathered-only meaning. A parallel describe block below covers the
  // NEW default (cap 3) for a firm that signs up after the cutover.
  async function backdateFirm(firmId: string): Promise<void> {
    await env.DB.prepare("UPDATE firms SET created_at = '2020-01-01T00:00:00Z' WHERE id = ?1").bind(firmId).run();
  }

  // Fills a firm's roster directly via store.ts (bypassing the HTTP layer,
  // and the CREATE rate limit + email-send path with it) -- these tests are
  // about the seat-cap boundary condition, not about re-proving 25 ordinary
  // HTTP creates succeed (already covered by the other CRUD tests above).
  // Real fetch() calls are reserved for the actual assertion under test.
  async function fillRoster(firmId: string, n: number, labelPrefix: string): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const row = await store.addPending(env.DB, {
        email: `${labelPrefix}-${i}-${Date.now()}@example.com`,
        stateSlug: "georgia",
        deadlineFields: { license_type_id: "ga-individual" },
        firstName: null,
        deadlineSource: store.DEADLINE_SOURCE_COMPUTED,
        userDeadline: null,
        firmId,
        staffLabel: null,
        skipConfirmation: true,
      });
      ids.push(row.id);
    }
    return ids;
  }

  it("the 26th staff member is refused once 25 are already on the roster", async () => {
    const { firmId, cookie } = await createFirmWithSession("Seat Cap Firm", `seatcap-${Date.now()}@example.com`);
    await backdateFirm(firmId);
    await fillRoster(firmId, 25, "seatcap-fill");
    expect(await store.countFirmLicenses(env.DB, firmId)).toBe(25);

    const blocked = await postFirmLicense(cookie, {
      email: `seatcap-26th-${Date.now()}@example.com`,
      state_slug: "georgia",
      license_type_id: "ga-individual",
    });
    expect(blocked.status).toBe(402);
    const body = (await blocked.json()) as { error: string };
    expect(body.error).toContain("25");
    // Copy changed 2026-08-05 (paid tiers): a free/unrecognised-tier firm
    // now has a real upgrade path via Stripe checkout, so the seat-cap
    // message points there instead of "contact us".
    expect(body.error.toLowerCase()).toContain("upgrade");
  });

  it("a firm already over 25 (grandfathered) keeps its existing roster untouched but still can't add more", async () => {
    const { firmId, cookie } = await createFirmWithSession("Grandfathered Firm", `grandfather-${Date.now()}@example.com`);
    await backdateFirm(firmId);
    await fillRoster(firmId, 30, "grandfather-preexisting");

    const beforeCount = await store.countFirmLicenses(env.DB, firmId);
    expect(beforeCount).toBe(30);

    const blocked = await postFirmLicense(cookie, {
      email: `grandfather-newattempt-${Date.now()}@example.com`,
      state_slug: "georgia",
      license_type_id: "ga-individual",
    });
    expect(blocked.status).toBe(402);

    // Nothing about the pre-existing 30 was touched -- no forced removal,
    // no status change, count identical to before the blocked attempt.
    const afterCount = await store.countFirmLicenses(env.DB, firmId);
    expect(afterCount).toBe(30);
  });

  it("removing a staff member frees a seat -- the cap is a live count, not a lifetime total", async () => {
    const { firmId, cookie } = await createFirmWithSession("Seat Reuse Firm", `seatreuse-${Date.now()}@example.com`);
    await backdateFirm(firmId);
    const ids = await fillRoster(firmId, 25, "seatreuse-fill");

    const stillBlocked = await postFirmLicense(cookie, {
      email: `seatreuse-blocked-${Date.now()}@example.com`,
      state_slug: "georgia",
      license_type_id: "ga-individual",
    });
    expect(stillBlocked.status).toBe(402);

    // The one real DELETE call in this test -- exercising the actual HTTP
    // route matters here, since the property under test IS "the real delete
    // endpoint frees a real seat."
    const del = await SELF.fetch(`https://deadline-radar.com/firm/licenses/${ids[0]}`, {
      method: "DELETE",
      headers: { Cookie: cookie, "cf-connecting-ip": "203.0.113.200" },
    });
    expect(del.status).toBe(200);

    const nowAllowed = await postFirmLicense(cookie, {
      email: `seatreuse-allowed-${Date.now()}@example.com`,
      state_slug: "georgia",
      license_type_id: "ga-individual",
    });
    expect(nowAllowed.status).toBe(201);
  });
});

/**
 * Roadmap #151 Phase 2 (2026-08-10): a firm that signs up AFTER the
 * value-line cutover gets the new, narrower free-tier seat cap (3), not
 * the grandfathered 25 the describe block above still covers.
 * createFirmWithSession() stamps a real "now" created_at, which is always
 * after VALUE_LINE_CUTOVER_DATE by construction (a fixed past timestamp),
 * so these firms are post-cutover with no extra setup needed.
 */
describe("POST /firm/licenses -- roadmap #151 Phase 2: new-signup seat cap (3)", () => {
  it("the 4th staff member is refused once 3 are already on the roster", async () => {
    const { cookie } = await createFirmWithSession("New Signup Seat Cap Firm", `newsignupseatcap-${Date.now()}@example.com`);
    for (let i = 0; i < 3; i++) {
      const resp = await postFirmLicense(cookie, {
        email: `newsignupseatcap-${i}-${Date.now()}@example.com`,
        state_slug: "georgia",
        license_type_id: "ga-individual",
      });
      expect(resp.status).toBe(201);
    }
    const blocked = await postFirmLicense(cookie, {
      email: `newsignupseatcap-4th-${Date.now()}@example.com`,
      state_slug: "georgia",
      license_type_id: "ga-individual",
    });
    expect(blocked.status).toBe(402);
    const body = (await blocked.json()) as { error: string };
    expect(body.error).toContain("3");
  });

  it("GET /firm/licenses discloses the new seat_cap (3), not the grandfathered 25", async () => {
    const { cookie } = await createFirmWithSession("New Signup Disclosure Firm", `newsignupdisclose-${Date.now()}@example.com`);
    const body = (await (await getFirmLicenses(cookie)).json()) as { seat_cap: number };
    expect(body.seat_cap).toBe(3);
  });

  it("a paid tier's own seat cap is unaffected by signup date", async () => {
    const { firmId, cookie } = await createFirmWithSession("New Signup Paid Firm", `newsignuppaid-${Date.now()}@example.com`);
    await env.DB.prepare("UPDATE firms SET plan_tier = 'firm_starter' WHERE id = ?1").bind(firmId).run();
    const body = (await (await getFirmLicenses(cookie)).json()) as { seat_cap: number };
    expect(body.seat_cap).toBe(5);
  });
});

/**
 * Roadmap #151 Phase 4 (2026-08-10): GET /firm/licenses' dashboard_synthesis_
 * included field -- a UI-convenience gate, not a real access boundary (see
 * hasValueLineAccess()'s own docstring in entitlements.ts). No worker test
 * for the client-side render itself (generate.py, verified via a local
 * server + sample-mode toggle instead, same pattern as #150/#152/#153).
 */
describe("GET /firm/licenses -- roadmap #151 Phase 4: dashboard_synthesis_included", () => {
  it("false for a post-cutover free firm", async () => {
    const { cookie } = await createFirmWithSession("Synthesis Gated Firm", `synthesisgated-${Date.now()}@example.com`);
    const body = (await (await getFirmLicenses(cookie)).json()) as { dashboard_synthesis_included: boolean };
    expect(body.dashboard_synthesis_included).toBe(false);
  });

  it("true for a pre-cutover (grandfathered) free firm", async () => {
    const { firmId, cookie } = await createFirmWithSession("Synthesis Grandfathered Firm", `synthesisgrand-${Date.now()}@example.com`);
    await env.DB.prepare("UPDATE firms SET created_at = '2020-01-01T00:00:00Z' WHERE id = ?1").bind(firmId).run();
    const body = (await (await getFirmLicenses(cookie)).json()) as { dashboard_synthesis_included: boolean };
    expect(body.dashboard_synthesis_included).toBe(true);
  });

  it("true for a paid tier, regardless of signup date", async () => {
    const { firmId, cookie } = await createFirmWithSession("Synthesis Paid Firm", `synthesispaid-${Date.now()}@example.com`);
    await env.DB.prepare("UPDATE firms SET plan_tier = 'firm_starter' WHERE id = ?1").bind(firmId).run();
    const body = (await (await getFirmLicenses(cookie)).json()) as { dashboard_synthesis_included: boolean };
    expect(body.dashboard_synthesis_included).toBe(true);
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
        renewalFeeCents: null,
        carryoverHours: null,
        officeTag: null,
        internalNotes: null,
        licenseIssueDate: null,
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

  // AuditLab LC-1 (LOW, 2026-08-04): remove-then-re-add used to strand a
  // person's real CPE history on the now-inert removed row -- their new
  // roster entry (a fresh id, since findActiveOrPending() only matches
  // pending/confirmed status) started with no history, and the old hours
  // sat attributed to "Removed staff member," counting toward nobody.
  it("re-adding a removed staffer reattaches their orphaned CPE entries to the new roster row", async () => {
    const { cookie, firmId } = await createFirmWithSession("Rehire Firm", `rehire-${Date.now()}@example.com`);
    const email = `rehire-staff-${Date.now()}@example.com`;

    const created = await postFirmLicense(cookie, { email, state_slug: "georgia", license_type_id: "ga-individual" });
    const { id: originalId } = (await created.json()) as { id: string };

    const cpeResp = await postCpeEntry(cookie, { subscriber_id: originalId, entry_date: "2026-06-01", hours: "8", category: "ethics" });
    expect(cpeResp.status).toBe(201);

    expect((await deleteFirmLicense(cookie, originalId)).status).toBe(200);

    // Re-add the SAME person to the SAME state -- the realistic "removed
    // the wrong person, immediately fixed it" path, not a months-later
    // rehire.
    const readded = await postFirmLicense(cookie, { email, state_slug: "georgia", license_type_id: "ga-individual" });
    expect(readded.status).toBe(201);
    const { id: newId } = (await readded.json()) as { id: string };
    expect(newId).not.toBe(originalId);

    const entries = await env.DB
      .prepare("SELECT id, subscriber_id FROM cpe_entries WHERE firm_id = ?1")
      .bind(firmId)
      .all<{ id: string; subscriber_id: string }>();
    expect(entries.results.length).toBe(1);
    expect(entries.results[0]!.subscriber_id).toBe(newId);

    // Confirms via the real read path a firm admin actually uses, not just
    // a raw SQL check -- GET /firm/cpe should show the hours under the NEW
    // (active) row, not the removed one.
    const list = await getCpeEntries(cookie);
    const listBody = (await list.json()) as { entries: Array<{ subscriber_id: string; hours: number }> };
    expect(listBody.entries.length).toBe(1);
    expect(listBody.entries[0]!.subscriber_id).toBe(newId);
    expect(listBody.entries[0]!.hours).toBe(8);
  });

  it("re-adding to a DIFFERENT state does NOT reattach CPE entries from the removed state", async () => {
    const { cookie, firmId } = await createFirmWithSession("Cross State Rehire Firm", `crossstate-${Date.now()}@example.com`);
    const email = `crossstate-staff-${Date.now()}@example.com`;

    const created = await postFirmLicense(cookie, { email, state_slug: "georgia", license_type_id: "ga-individual" });
    const { id: originalId } = (await created.json()) as { id: string };
    await postCpeEntry(cookie, { subscriber_id: originalId, entry_date: "2026-06-01", hours: "8", category: "ethics" });
    await deleteFirmLicense(cookie, originalId);

    // Different state this time -- entries logged against Georgia must not
    // silently attach to an Illinois row.
    const readded = await postFirmLicense(cookie, { email, state_slug: "illinois", license_type_id: "il-individual" });
    expect(readded.status).toBe(201);
    const { id: newId } = (await readded.json()) as { id: string };

    const entries = await env.DB
      .prepare("SELECT subscriber_id FROM cpe_entries WHERE firm_id = ?1")
      .bind(firmId)
      .all<{ subscriber_id: string }>();
    expect(entries.results.length).toBe(1);
    expect(entries.results[0]!.subscriber_id).toBe(originalId); // unchanged, NOT migrated to newId
  });
});

describe("CSRF defense-in-depth (2026-08-05, orchestrator abuse-test finding): originAllowed() on mutating firm-session routes", () => {
  it("POST /firm/licenses is rejected when the Origin header doesn't match any allowed origin", async () => {
    const { cookie } = await createFirmWithSession("Origin Test Firm", `origintest-${Date.now()}@example.com`);
    const resp = await SELF.fetch("https://deadline-radar.com/firm/licenses", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.201", Cookie: cookie, Origin: "https://attacker.example" },
      body: JSON.stringify({ email: `csrf-${Date.now()}@example.com`, state_slug: "georgia", license_type_id: "ga-individual" }),
    });
    expect(resp.status).toBe(400);
  });

  it("POST /firm/licenses still succeeds with no Origin header at all (a same-site form post / most non-browser clients)", async () => {
    // originAllowed() returns true when Origin is absent entirely -- only a
    // PRESENT, mismatched Origin is rejected. Real browsers always send
    // Origin on a cross-site request but not necessarily on every same-site
    // one, so treating "absent" as an error would break legitimate traffic
    // this check was never meant to touch.
    const { cookie } = await createFirmWithSession("No Origin Test Firm", `noorigintest-${Date.now()}@example.com`);
    const resp = await postFirmLicense(cookie, { email: `csrf-noorigin-${Date.now()}@example.com`, state_slug: "georgia", license_type_id: "ga-individual" });
    expect(resp.status).toBe(201);
  });

  it("POST /firm/licenses still succeeds with a real, matching Origin header", async () => {
    const { cookie } = await createFirmWithSession("Matching Origin Test Firm", `matchorigintest-${Date.now()}@example.com`);
    const resp = await SELF.fetch("https://deadline-radar.com/firm/licenses", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.202", Cookie: cookie, Origin: "https://deadline-radar.com" },
      body: JSON.stringify({ email: `csrf-match-${Date.now()}@example.com`, state_slug: "georgia", license_type_id: "ga-individual" }),
    });
    expect(resp.status).toBe(201);
  });

  it("POST /firm/licenses is rejected when Content-Type isn't application/json, even from an allowed Origin", async () => {
    // The specific cross-site-form bypass this closes: <form
    // enctype="text/plain"> never triggers a CORS preflight, so a
    // Content-Type check is a real, independent second gate from
    // originAllowed() -- confirmed here with a MATCHING Origin so this
    // test proves the Content-Type check alone, not Origin rejection.
    const { cookie } = await createFirmWithSession("Bad Content-Type Firm", `badcontenttype-${Date.now()}@example.com`);
    const resp = await SELF.fetch("https://deadline-radar.com/firm/licenses", {
      method: "POST",
      headers: { "content-type": "text/plain", "cf-connecting-ip": "203.0.113.203", Cookie: cookie, Origin: "https://deadline-radar.com" },
      body: JSON.stringify({ email: `csrf-plaintext-${Date.now()}@example.com`, state_slug: "georgia", license_type_id: "ga-individual" }),
    });
    expect(resp.status).toBe(400);
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
    // renewed_at (migration 0017) -- the real "when was this last renewed"
    // fact the dashboard's activity feed was missing (reported directly,
    // 2026-08-04: "Mark renewed" gave zero visible feedback).
    expect(beforeRenew?.renewed_at).toBeNull();
    expect(after?.renewed_at).toBeTruthy();
    expect(body).toHaveProperty("renewed_at");
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

describe("emails.ts buildFirmStaffAddedEmail -- AuditLab EMAIL-1", () => {
  it("strips CR/LF from an attacker-influenceable firm name before it reaches the subject line", async () => {
    const { buildFirmStaffAddedEmail } = await import("../src/emails");
    const hostile = "Acme\r\nBcc: attacker@evil.example\r\nX-Injected: yes";
    const built = buildFirmStaffAddedEmail(hostile, "Texas", "https://deadline-radar.com/api/unsubscribe?token=abc");
    expect(built.subject).not.toMatch(/[\r\n]/);
    expect(built.subject).toBe("Acme Bcc: attacker@evil.example X-Injected: yes added you to Deadline-Radar");
    // The body text is unaffected -- this is a subject-line-specific
    // control (header-injection surface), not a general sanitizer; the
    // firm name still reads naturally in the message body.
    expect(built.textBody).toContain(hostile);
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

  it("Task #11: greets by name when an admin_name is available, and falls back generically when not", async () => {
    const { buildFirmLoginEmail } = await import("../src/emails");
    const named = buildFirmLoginEmail("https://deadline-radar.com/api/firm/login/verify?token=abc123", false, "Jane Smith");
    expect(named.textBody).toContain("Hi Jane Smith,");
    expect(named.htmlBody).toContain("Hi Jane Smith,");

    const anonymous = buildFirmLoginEmail("https://deadline-radar.com/api/firm/login/verify?token=abc123");
    expect(anonymous.textBody).toContain("Hi there,");
    expect(anonymous.htmlBody).toContain("Hi there,");
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

  it("orchestrator cross-flow finding (2026-08-05): a firm adding someone to its roster does not consume that person's individual-signup cooldown slot", async () => {
    const stamp = Date.now();
    const email = `cross-flow-${stamp}@example.com`;
    const firm = await store.createFirm(env.DB, { name: "Cross-Flow Test Firm", adminEmail: `admin-${stamp}@example.com` });
    // Mirrors handleFirmLicenseCreate()'s real call shape: firmId set,
    // skipConfirmation true -- the row IS in the subscribers table with a
    // recent created_at, same as the live scenario reported.
    await store.addPending(env.DB, {
      email,
      stateSlug: "georgia",
      deadlineFields: {},
      firstName: null,
      firmId: firm.id,
      staffLabel: "Cross Flow Staffer",
      skipConfirmation: true,
    });

    // A DIFFERENT state -- this is exactly the reported scenario: the firm
    // tracks them in Georgia, they separately try the free individual
    // product for a license in another state entirely.
    const resp = await postSubscribe({ email, state: "alabama", license_type_id: "al-all" }, "203.0.113.33");
    expect(resp.status).toBe(200);

    const row = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?1 AND state_slug = ?2")
      .bind(email, "alabama")
      .first<SubscriberRow>();
    expect(row).not.toBeNull(); // the individual signup must actually go through, not silently no-op
    expect(row?.firm_id).toBeNull();
  });

  it("the individual-signup cooldown itself is unaffected -- still blocks a second individual signup within the window", async () => {
    const email = `still-blocked-${Date.now()}@example.com`;
    const ip = "203.0.113.34";
    const first = await postSubscribe({ email, state: "georgia", license_type_id: "ga-individual" }, ip);
    expect(first.status).toBe(200);
    // A different state, same identity, no firm involved at all -- this is
    // the exact cross-state mail-bombing pattern the cooldown exists to
    // stop, and must still be blocked.
    const second = await postSubscribe({ email, state: "alabama", license_type_id: "al-all" }, ip);
    expect(second.status).toBe(200); // same no-oracle success page either way

    const row = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?1 AND state_slug = ?2")
      .bind(email, "alabama")
      .first();
    expect(row).toBeNull(); // but no row was actually created
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

  it("AuditLab DEADLINE-1: nextAnnualMonthEnd does not roll forward a year on the deadline's own due day", () => {
    // Texas, month=8, deadline is 2026-08-31. Probed with a real timestamp
    // (not bare midnight) at various points that day and the day around it.
    expect(nextAnnualMonthEnd(new Date("2026-08-30T23:59:00Z"), 8).getUTCFullYear()).toBe(2026);
    expect(nextAnnualMonthEnd(new Date("2026-08-31T00:00:00Z"), 8).toISOString().slice(0, 10)).toBe(
      "2026-08-31"
    );
    expect(nextAnnualMonthEnd(new Date("2026-08-31T01:00:00Z"), 8).toISOString().slice(0, 10)).toBe(
      "2026-08-31"
    );
    expect(nextAnnualMonthEnd(new Date("2026-08-31T23:59:59Z"), 8).toISOString().slice(0, 10)).toBe(
      "2026-08-31"
    );
    expect(nextAnnualMonthEnd(new Date("2026-09-01T00:00:00Z"), 8).getUTCFullYear()).toBe(2027);
  });

  it("AuditLab DEADLINE-1: nextBirthMonthParityDate does not roll forward a full cycle on the deadline's own due day", () => {
    // California, month=8/odd, deadline is 2027-08-31 (odd year).
    expect(
      nextBirthMonthParityDate(new Date("2027-08-31T00:00:00Z"), 8, "odd").toISOString().slice(0, 10)
    ).toBe("2027-08-31");
    expect(
      nextBirthMonthParityDate(new Date("2027-08-31T13:00:00Z"), 8, "odd").toISOString().slice(0, 10)
    ).toBe("2027-08-31");
    expect(nextBirthMonthParityDate(new Date("2027-09-01T00:00:00Z"), 8, "odd").getUTCFullYear()).toBe(
      2029
    );
  });

  it("computeSubscriberDeadline resolves Ohio cohort groups and rejects unknown ones", () => {
    const asOf = new Date("2026-07-03T00:00:00Z");
    expect(computeSubscriberDeadline("ohio", { cohort_group: "Group 1" }, asOf)).not.toBeNull();
    expect(computeSubscriberDeadline("ohio", { cohort_group: "Group 9" }, asOf)).toBeNull();
  });

  it("nextFixedDateParity returns the next matching-parity FIXED date (not month-end) after asOf", () => {
    // Kansas: July 1 of odd years. 2026-07-03 is already past July 1, 2026
    // (an even year, wrong parity anyway) -- next odd-year July 1 is 2027.
    const d = nextFixedDateParity(new Date("2026-07-03T00:00:00Z"), 7, 1, "odd");
    expect(d.toISOString().slice(0, 10)).toBe("2027-07-01");
  });

  it("AuditLab DEADLINE-1 (same rule, ported): nextFixedDateParity does not roll forward a full cycle on the deadline's own due day", () => {
    // Kentucky: August 1 of even years. Probed at various points on/around
    // 2028-08-01 (an even year) -- due-today must not read as already past.
    expect(nextFixedDateParity(new Date("2028-07-31T23:59:00Z"), 8, 1, "even").toISOString().slice(0, 10)).toBe(
      "2028-08-01"
    );
    expect(nextFixedDateParity(new Date("2028-08-01T00:00:00Z"), 8, 1, "even").toISOString().slice(0, 10)).toBe(
      "2028-08-01"
    );
    expect(nextFixedDateParity(new Date("2028-08-01T23:59:59Z"), 8, 1, "even").toISOString().slice(0, 10)).toBe(
      "2028-08-01"
    );
    expect(nextFixedDateParity(new Date("2028-08-02T00:00:00Z"), 8, 1, "even").getUTCFullYear()).toBe(2030);
  });

  it("computeSubscriberDeadline resolves the 4 parity-lookup states (Kansas/Kentucky/Oregon/Nebraska) on their own fixed month/day", () => {
    const asOf = new Date("2026-07-03T00:00:00Z");
    expect(computeSubscriberDeadline("kansas", { parity: "odd" }, asOf)?.toISOString().slice(0, 10)).toBe(
      "2027-07-01"
    );
    expect(computeSubscriberDeadline("kentucky", { parity: "even" }, asOf)?.toISOString().slice(0, 10)).toBe(
      "2026-08-01"
    );
    expect(computeSubscriberDeadline("oregon", { parity: "odd" }, asOf)?.toISOString().slice(0, 10)).toBe(
      "2027-06-30"
    );
    expect(computeSubscriberDeadline("nebraska", { parity: "even" }, asOf)?.toISOString().slice(0, 10)).toBe(
      "2028-06-30"
    );
    // No/invalid parity -> null, never a guess.
    expect(computeSubscriberDeadline("kansas", {}, asOf)).toBeNull();
    expect(computeSubscriberDeadline("kansas", { parity: "sideways" }, asOf)).toBeNull();
  });

  it("2026-08-18: computeSubscriberDeadline resolves Idaho (birth-year parity) matching DOPL's own stated current-cycle dates exactly", () => {
    const asOf = new Date("2026-07-03T00:00:00Z");
    // Odd-birth-year -> June 30, 2027; even-birth-year -> June 30, 2028 --
    // exactly what dopl.idaho.gov's 2026-04-20 press release states, not
    // just a formula extrapolation.
    expect(computeSubscriberDeadline("idaho", { parity: "odd" }, asOf)?.toISOString().slice(0, 10)).toBe(
      "2027-06-30"
    );
    expect(computeSubscriberDeadline("idaho", { parity: "even" }, asOf)?.toISOString().slice(0, 10)).toBe(
      "2028-06-30"
    );
    expect(computeSubscriberDeadline("idaho", {}, asOf)).toBeNull();
  });

  it("2026-08-18: computeSubscriberDeadline resolves Oklahoma/New Mexico individual (pure birth-month-annual, same shape as Texas)", () => {
    const asOf = new Date("2026-07-03T00:00:00Z");
    // A month already past its 2026 occurrence rolls to 2027; a month still
    // ahead in 2026 stays 2026 -- exactly the same next_annual_month_end()
    // math Texas already uses.
    expect(computeSubscriberDeadline("oklahoma", { birth_month: "3" }, asOf)?.toISOString().slice(0, 10)).toBe(
      "2027-03-31"
    );
    expect(computeSubscriberDeadline("new-mexico", { birth_month: "9" }, asOf)?.toISOString().slice(0, 10)).toBe(
      "2026-09-30"
    );
    expect(computeSubscriberDeadline("oklahoma", {}, asOf)).toBeNull();
  });

  it("2026-08-18: computeSubscriberDeadline resolves Arizona (birth-month + birth-year-parity, same mechanism as California)", () => {
    const asOf = new Date("2026-07-03T00:00:00Z");
    expect(computeSubscriberDeadline("arizona", { birth_month: "5", birth_year_parity: "odd" }, asOf)?.toISOString().slice(0, 10)).toBe(
      "2027-05-31"
    );
    expect(computeSubscriberDeadline("arizona", { birth_month: "5", birth_year_parity: "even" }, asOf)?.toISOString().slice(0, 10)).toBe(
      "2028-05-31"
    );
    expect(computeSubscriberDeadline("arizona", { birth_month: "5" }, asOf)).toBeNull();
  });

  it("2026-08-18: computeSubscriberDeadline resolves New Hampshire/CNMI (exact N years from your own anchor date, no fixed month/day)", () => {
    const asOf = new Date("2026-07-03T00:00:00Z");
    // NH: 2 years. Anchor 2024-09-15 rolls once to 2026-09-15 (still ahead of asOf).
    expect(
      computeSubscriberDeadline("new-hampshire", { anchor_date: "2024-09-15" }, asOf)?.toISOString().slice(0, 10)
    ).toBe("2026-09-15");
    // CNMI: 3 years. Anchor 2023-03-10 -> 2026-03-10 already passed asOf -> rolls again to 2029-03-10.
    expect(
      computeSubscriberDeadline("northern-mariana-islands", { anchor_date: "2023-03-10" }, asOf)?.toISOString().slice(0, 10)
    ).toBe("2029-03-10");
    expect(computeSubscriberDeadline("new-hampshire", {}, asOf)).toBeNull();
    expect(computeSubscriberDeadline("new-hampshire", { anchor_date: "not-a-date" }, asOf)).toBeNull();
  });

  it("2026-08-18: nextAnchorDatePlusTerm falls back Feb 29 to Feb 28 in a non-leap target year", () => {
    const asOfEarly = new Date("2026-01-01T00:00:00Z");
    expect(
      computeSubscriberDeadline("new-hampshire", { anchor_date: "2024-02-29" }, asOfEarly)?.toISOString().slice(0, 10)
    ).toBe("2026-02-28");
  });

  it("2026-08-18: computeSubscriberDeadline resolves Washington/Puerto Rico (fixed month/day, N-way anchor-YEAR term)", () => {
    const asOf = new Date("2026-07-03T00:00:00Z");
    // WA: June 30, mod 3. Anchor 2024 -> 2024-06-30 already passed asOf -> rolls to 2027-06-30.
    expect(
      computeSubscriberDeadline("washington", { anchor_year: "2024" }, asOf)?.toISOString().slice(0, 10)
    ).toBe("2027-06-30");
    // PR: Dec 1, mod 3. Anchor 2023 -> 2023-12-01 passed -> rolls to 2026-12-01 (still ahead of asOf).
    expect(
      computeSubscriberDeadline("puerto-rico", { anchor_year: "2023" }, asOf)?.toISOString().slice(0, 10)
    ).toBe("2026-12-01");
    expect(computeSubscriberDeadline("washington", {}, asOf)).toBeNull();
    expect(computeSubscriberDeadline("washington", { anchor_year: "not-a-year" }, asOf)).toBeNull();
  });

  it("2026-08-19: computeSubscriberDeadline resolves Florida individual (certificate date -> third-following-June-30 locates the cycle year, renewal is Dec 31 of that year, then 2yr rollover)", () => {
    // 2026-08-19 (AuditLab DATA-11, fixed same day): the original version of
    // this test asserted June 30 as the returned deadline -- that was the
    // bug. June 30 only locates which YEAR the CPE reestablishment period
    // ends in; the license renewal deadline actually due is December 31 of
    // that same year (61H1-33.003(1)(a) + DBPR's own renewal-cycle page).
    // The year-anchoring math below (third-following-June-30, 2yr rollover)
    // is unchanged and still correct -- only the emitted month/day moved
    // from (6, 30) to (12, 31) in the same year.
    const asOf = new Date("2026-07-03T00:00:00Z");
    // Cert date BEFORE June 30 in its own year -> first following June 30 is
    // the SAME year. 2020-03-15 -> first-following 2020, initial period-end
    // year 2020+2=2022, rolls (2yr, Dec 31) to 2026-12-31 by asOf.
    expect(
      computeSubscriberDeadline("florida", { license_type_id: "fl-individual", anchor_date: "2020-03-15" }, asOf)?.toISOString().slice(0, 10)
    ).toBe("2026-12-31");
    // Cert date ON June 30 itself -> not "following" its own date, so
    // first-following is the NEXT year. 2020-06-30 -> first-following 2021,
    // initial period-end year 2021+2=2023, rolls to 2027-12-31 by asOf.
    expect(
      computeSubscriberDeadline("florida", { license_type_id: "fl-individual", anchor_date: "2020-06-30" }, asOf)?.toISOString().slice(0, 10)
    ).toBe("2027-12-31");
    // Cert date AFTER June 30 in its own year -> first-following is next
    // year too. 2020-08-10 -> first-following 2021, initial period-end year
    // 2021+2=2023, rolls to 2027-12-31 by asOf (same as the exact-June-30
    // case above, confirming both branches converge correctly).
    expect(
      computeSubscriberDeadline("florida", { license_type_id: "fl-individual", anchor_date: "2020-08-10" }, asOf)?.toISOString().slice(0, 10)
    ).toBe("2027-12-31");
    // Recent certificate, still within its own initial period -- no
    // rollover needed. 2024-01-10 -> first-following 2024, initial
    // period-end year 2024+2=2026, so the renewal due is 2026-12-31, which
    // is >= a 2026-01-01 asOf.
    expect(
      computeSubscriberDeadline("florida", { license_type_id: "fl-individual", anchor_date: "2024-01-10" }, new Date("2026-01-01T00:00:00Z"))?.toISOString().slice(0, 10)
    ).toBe("2026-12-31");
    // Same anchor, asOf moved to just past that year's Dec 31 -> rolls a
    // full 2yr cycle forward. Proves the fix didn't just shift the bug --
    // the boundary is now genuinely Dec 31, not June 30.
    expect(
      computeSubscriberDeadline("florida", { license_type_id: "fl-individual", anchor_date: "2024-01-10" }, new Date("2027-01-01T00:00:00Z"))?.toISOString().slice(0, 10)
    ).toBe("2028-12-31");
    expect(computeSubscriberDeadline("florida", { license_type_id: "fl-individual" }, asOf)).toBeNull();
    expect(computeSubscriberDeadline("florida", {}, asOf)).toBeNull();
  });

  it("2026-08-19: computeSubscriberDeadline resolves Florida firm via its existing single computed date", () => {
    const asOf = new Date("2026-07-03T00:00:00Z");
    expect(
      computeSubscriberDeadline("florida", { license_type_id: "fl-firm" }, asOf)?.toISOString().slice(0, 10)
    ).toBe("2027-12-31");
  });

  it("2026-08-19: computeSubscriberDeadline resolves Guam individual/firm identically (fixed June 30, CHOSEN 1-3yr term, single-shot no rollover)", () => {
    const asOf = new Date("2026-07-03T00:00:00Z");
    // 2024 + 3yr term = 2027-06-30, still ahead of asOf.
    expect(
      computeSubscriberDeadline("guam", { anchor_year: "2024", term_years: "3" }, asOf)?.toISOString().slice(0, 10)
    ).toBe("2027-06-30");
    // The math doesn't care whether it's meant as an individual or firm
    // date -- same inputs, same answer, no license_type_id needed.
    expect(
      computeSubscriberDeadline("guam", { anchor_year: "2024", term_years: "3" }, asOf)?.toISOString().slice(0, 10)
    ).toBe("2027-06-30");
    // 2026 + 1yr term = 2027-06-30, still ahead.
    expect(
      computeSubscriberDeadline("guam", { anchor_year: "2026", term_years: "1" }, asOf)?.toISOString().slice(0, 10)
    ).toBe("2027-06-30");
    // 2020 + 3yr term = 2023-06-30, already passed -- no rollover assumed
    // (the next actual term is unknowable from here), returns null rather
    // than guessing.
    expect(computeSubscriberDeadline("guam", { anchor_year: "2020", term_years: "3" }, asOf)).toBeNull();
    expect(computeSubscriberDeadline("guam", { anchor_year: "2024" }, asOf)).toBeNull();
    expect(computeSubscriberDeadline("guam", { anchor_year: "2024", term_years: "4" }, asOf)).toBeNull();
  });

  it("checkDataFreshness throws StaleDataError once data is older than the threshold", () => {
    const farFuture = new Date("2030-01-01T00:00:00Z");
    expect(() => checkDataFreshness(farFuture)).toThrow(StaleDataError);
    expect(() => checkDataFreshness(new Date("2026-07-05T00:00:00Z"))).not.toThrow();
  });

  it("AuditLab ST-1: dataFreshnessInfo() reports the same as_of_date/staleness checkDataFreshness() gates on", () => {
    const fresh = dataFreshnessInfo(new Date("2026-07-05T00:00:00Z"));
    expect(fresh.as_of_date).toBe(cpaDeadlinesData.as_of_date);
    expect(fresh.stale).toBe(false);
    expect(Number.isFinite(fresh.age_days)).toBe(true);

    const stale = dataFreshnessInfo(new Date("2030-01-01T00:00:00Z"));
    expect(stale.stale).toBe(true);
    expect(() => checkDataFreshness(new Date("2030-01-01T00:00:00Z"))).toThrow(StaleDataError);
  });

  it("AuditLab STALE-5: the guard is anchored on the WORSE of as_of_date and the single oldest per-record last_verified, not as_of_date alone", () => {
    // Computed relative to the real dataset (not hardcoded dates) so this
    // stays correct regardless of what as_of_date/last_verified happen to
    // be on any given day -- same robustness pattern the existing
    // "Staleness guard -- real HTTP + cron code paths" describe block below
    // already uses for as_of_date itself.
    const oldestLastVerified = cpaDeadlinesData.records
      .map((r) => Date.parse(`${r.last_verified}T00:00:00Z`))
      .reduce((oldest, t) => Math.min(oldest, t), Infinity);
    const asOfTime = Date.parse(`${cpaDeadlinesData.as_of_date}T00:00:00Z`);

    // A "today" placed just past the 30-day threshold from the OLDEST
    // per-record last_verified, but still within 30 days of as_of_date
    // itself (as_of_date is required to be >= every last_verified, so this
    // window always exists when the two dates differ at all). If the guard
    // only checked as_of_date, this would incorrectly read as fresh.
    const justPastRecordThreshold = new Date(oldestLastVerified + (STALENESS_THRESHOLD_DAYS + 1) * 86_400_000);
    if (justPastRecordThreshold.getTime() - asOfTime <= STALENESS_THRESHOLD_DAYS * 86_400_000) {
      expect(dataFreshnessInfo(justPastRecordThreshold).stale).toBe(true);
      expect(() => checkDataFreshness(justPastRecordThreshold)).toThrow(StaleDataError);
    }

    // A "today" comfortably within 30 days of BOTH as_of_date and every
    // record's last_verified must still read fresh -- the tightened guard
    // must never fire early for genuinely fresh data.
    const bothFresh = new Date(Math.max(asOfTime, oldestLastVerified) + 1 * 86_400_000);
    expect(dataFreshnessInfo(bothFresh).stale).toBe(false);
    expect(() => checkDataFreshness(bothFresh)).not.toThrow();
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

describe("sender.ts checkAndCountActionSend -- separate budget from reminders (AuditLab TS-1, 2026-08-05)", () => {
  it("allows sends up to its own cap, then refuses further sends that UTC day", async () => {
    const { checkAndCountActionSend } = await import("../src/sender");
    const before = await env.DB
      .prepare("SELECT count FROM action_send_counters WHERE day = strftime('%Y-%m-%d','now')")
      .first<{ count: number }>();
    const alreadyUsed = before?.count ?? 0;
    const cap = alreadyUsed + 3;
    const results: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      results.push(await checkAndCountActionSend(env.DB, cap));
    }
    expect(results).toEqual([true, true, true, false, false]);
  });

  it("is a genuinely SEPARATE counter from checkAndCountSend() -- exhausting one cannot starve the other", async () => {
    // This is the actual defect TS-1 reported: before migration 0019, every
    // action email (confirmation, firm-signup login link, etc.) spent from
    // the SAME counter the reminder scheduler does, so a spam wave against
    // an ad-blocker-relaxed signup route could exhaust the shared cap and
    // silently stop real deadline reminders for the rest of the UTC day.
    const { checkAndCountSend, checkAndCountActionSend } = await import("../src/sender");

    const reminderBefore = await env.DB
      .prepare("SELECT count FROM send_counters WHERE day = strftime('%Y-%m-%d','now')")
      .first<{ count: number }>();
    const reminderUsed = reminderBefore?.count ?? 0;

    const actionBefore = await env.DB
      .prepare("SELECT count FROM action_send_counters WHERE day = strftime('%Y-%m-%d','now')")
      .first<{ count: number }>();
    const actionUsed = actionBefore?.count ?? 0;

    // Exhaust the ACTION budget completely (cap = current usage, so the very
    // next call is already refused).
    const actionCap = actionUsed;
    expect(await checkAndCountActionSend(env.DB, actionCap)).toBe(false);
    expect(await checkAndCountActionSend(env.DB, actionCap)).toBe(false);

    // The REMINDER counter must be completely unaffected -- still exactly
    // where it was, and a reminder send with room in ITS OWN cap still goes
    // through cleanly.
    const reminderAfterExhaustion = await env.DB
      .prepare("SELECT count FROM send_counters WHERE day = strftime('%Y-%m-%d','now')")
      .first<{ count: number }>();
    expect(reminderAfterExhaustion?.count ?? 0).toBe(reminderUsed);
    expect(await checkAndCountSend(env.DB, reminderUsed + 1)).toBe(true);
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

  it("AuditLab SCHED-E: at the real cron invocation time (18:00 UTC), daysRemaining is not understated by one", async () => {
    const { runReminderPass } = await import("../src/scheduler");
    const email = `sched-tx-schede-${Date.now()}@example.com`;
    const rec = await store.addPending(env.DB, {
      email,
      stateSlug: "texas",
      deadlineFields: { birth_month: "7" }, // TX deadline = end of July -> July 31 2026 UTC midnight
      firstName: "Tester",
    });
    await store.confirm(env.DB, rec.confirm_token);

    const sends: { to: string; subject: string }[] = [];
    // Pre-fix, Math.round(7 days - 18 hours) understated this to 6 -- wrangler.toml's
    // actual cron ("0 18 * * *") fires at exactly this hour every day in production.
    const summary = await runReminderPass(env, {
      asOf: new Date(Date.UTC(2026, 6, 24, 18, 0, 0)),
      send: async (to, built) => {
        sends.push({ to, subject: built.subject });
        return true;
      },
    });

    expect(summary.errors).toEqual([]);
    const mine = sends.find((s) => s.to === email);
    expect(mine).toBeTruthy();
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

  it("SCHED-A: two overlapping passes for the same tier send exactly once, not twice", async () => {
    const { runReminderPass } = await import("../src/scheduler");
    const email = `sched-race-${Date.now()}@example.com`;
    const rec = await store.addPending(env.DB, {
      email,
      stateSlug: "texas",
      deadlineFields: { birth_month: "7" },
      firstName: "Tester",
    });
    await store.confirm(env.DB, rec.confirm_token);

    const sends: string[] = [];
    const asOf = new Date(Date.UTC(2026, 6, 24)); // 7 days out -> tier 7
    // Both "passes" read subscribers (and therefore reminders_sent=[]) before
    // either sends -- exactly the SCHED-A race -- by starting them together
    // rather than awaiting one before starting the other.
    const [a, b] = await Promise.all([
      runReminderPass(env, { asOf, send: async (to) => { sends.push(to); return true; } }),
      runReminderPass(env, { asOf, send: async (to) => { sends.push(to); return true; } }),
    ]);

    expect(sends.filter((s) => s === email)).toHaveLength(1);
    expect(a.errors.length + b.errors.length).toBe(0);

    const row = await env.DB.prepare("SELECT reminders_sent FROM subscribers WHERE id = ?1").bind(rec.id).first<{ reminders_sent: string }>();
    expect(JSON.parse(row?.reminders_sent ?? "[]")).toEqual([7]);
  });

  it("SCHED-A: a failed send unclaims the threshold so the next pass retries it (no permanent miss)", async () => {
    const { runReminderPass } = await import("../src/scheduler");
    const email = `sched-unclaim-${Date.now()}@example.com`;
    const rec = await store.addPending(env.DB, {
      email,
      stateSlug: "texas",
      deadlineFields: { birth_month: "7" },
      firstName: "Tester",
    });
    await store.confirm(env.DB, rec.confirm_token);

    const asOf = new Date(Date.UTC(2026, 6, 24)); // 7 days out -> tier 7
    const failed = await runReminderPass(env, { asOf, send: async () => false });
    expect(failed.errors.some((e) => e.subscriber_id === rec.id && e.error === "send returned false")).toBe(true);

    const midRow = await env.DB.prepare("SELECT reminders_sent FROM subscribers WHERE id = ?1").bind(rec.id).first<{ reminders_sent: string }>();
    expect(JSON.parse(midRow?.reminders_sent ?? "[]")).toEqual([]); // claim reverted, not stuck

    const sends: string[] = [];
    await runReminderPass(env, { asOf, send: async (to) => { sends.push(to); return true; } });
    expect(sends).toContain(email); // retried and succeeded next pass
  });

  it("SCHED-B: a throw from one subscriber's send does not abort the rest of the pass", async () => {
    const { runReminderPass } = await import("../src/scheduler");
    const emailBad = `sched-throw-${Date.now()}@example.com`;
    const emailGood = `sched-ok-${Date.now()}@example.com`;
    const bad = await store.addPending(env.DB, { email: emailBad, stateSlug: "texas", deadlineFields: { birth_month: "7" }, firstName: "Bad" });
    await store.confirm(env.DB, bad.confirm_token);
    const good = await store.addPending(env.DB, { email: emailGood, stateSlug: "texas", deadlineFields: { birth_month: "7" }, firstName: "Good" });
    await store.confirm(env.DB, good.confirm_token);

    const sends: string[] = [];
    const summary = await runReminderPass(env, {
      asOf: new Date(Date.UTC(2026, 6, 24)), // 7 days out -> tier 7 for both
      send: async (to) => {
        if (to === emailBad) throw new Error("simulated SendGrid client throw");
        sends.push(to);
        return true;
      },
    });

    expect(sends).toContain(emailGood); // survivor still got its reminder
    expect(summary.errors.some((e) => e.subscriber_id === bad.id && e.error.includes("simulated SendGrid client throw"))).toBe(true);

    const badRow = await env.DB.prepare("SELECT reminders_sent FROM subscribers WHERE id = ?1").bind(bad.id).first<{ reminders_sent: string }>();
    expect(JSON.parse(badRow?.reminders_sent ?? "[]")).toEqual([]); // claim reverted on throw, not stuck
  });

  it("SCHED-C: hitting the daily cap halts the pass instead of one error per remaining subscriber", async () => {
    const { runReminderPass } = await import("../src/scheduler");
    for (let i = 0; i < 3; i++) {
      const e = `sched-cap-${Date.now()}-${i}@example.com`;
      const rec = await store.addPending(env.DB, { email: e, stateSlug: "texas", deadlineFields: { birth_month: "7" }, firstName: "Tester" });
      await store.confirm(env.DB, rec.confirm_token);
    }

    // send_counters' "today" row is real-wall-clock keyed and persists across
    // tests in this file (D1 storage isn't reset per-`it`), so read whatever
    // count is already there and cap exactly one more send above it, rather
    // than assuming an empty counter.
    const today = new Date().toISOString().slice(0, 10);
    const before = await env.DB.prepare("SELECT count FROM send_counters WHERE day = ?1").bind(today).first<{ count: number }>();
    const cap = (before?.count ?? 0) + 1;

    const cappedEnv = { ...env, REMINDERS_DAILY_SEND_CAP: String(cap) } as typeof env;
    const sends: string[] = [];
    const capped = await runReminderPass(cappedEnv, {
      asOf: new Date(Date.UTC(2026, 6, 24)), // 7 days out -> tier 7 for all 3
      send: async (to) => { sends.push(to); return true; },
    });
    expect(sends).toHaveLength(1); // only one send got through before the cap hit
    // exactly one "halting" error was recorded, not one per remaining subscriber
    const capErrors = capped.errors.filter((e) => e.error.includes("daily send cap reached"));
    expect(capErrors).toHaveLength(1);
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
  //
  // STALE_MOCK_DATE is computed from the REAL as_of_date + one day past the
  // threshold, not a hardcoded calendar date. A fixed date ("2026-09-01")
  // silently stopped being "stale" the moment as_of_date itself advanced past
  // (that date minus the threshold) -- exactly what happened here: written
  // when as_of_date was 2026-07-05 (58 days before the fixed mock date, well
  // past the 30-day threshold), it went quietly wrong again once as_of_date
  // reached 2026-08-02 (making the fixed mock date exactly 30 days out --
  // AT the threshold, not past it, since checkDataFreshness() uses strict
  // `>`). Deriving it keeps these tests correct forever regardless of how
  // often the data gets re-verified.
  // Roadmap #70 (2026-08-07): scheduled()'s holiday-skip check (isUsFederalHoliday())
  // now runs BEFORE runReminderPass() -- if a derived STALE_MOCK_DATE ever
  // happened to land exactly on one of the 11 recognized holidays, the
  // "scheduled() ... swallows the stale-data pause" test below would break
  // for a completely unrelated reason (the holiday check would return early
  // and runReminderPass() would never even be called). Nudged forward a day
  // at a time past any such collision, same "derive it, don't let it go
  // silently wrong later" reasoning as the rest of this comment block.
  function firstNonHolidayOnOrAfter(d: Date): Date {
    let candidate = d;
    while (isUsFederalHolidayForTest(candidate)) {
      candidate = new Date(candidate.getTime() + 86_400_000);
    }
    return candidate;
  }
  const STALE_MOCK_DATE = firstNonHolidayOnOrAfter(
    new Date(Date.parse(`${cpaDeadlinesData.as_of_date}T00:00:00Z`) + (STALENESS_THRESHOLD_DAYS + 1) * 86_400_000)
  );

  it("POST /subscribe returns 503 'temporarily paused' once as_of_date is more than 30 days old", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(STALE_MOCK_DATE);
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
      vi.setSystemTime(STALE_MOCK_DATE);
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
      vi.setSystemTime(STALE_MOCK_DATE);
      const { runReminderPass } = await import("../src/scheduler");
      await expect(runReminderPass(env)).rejects.toThrow(StaleDataError);
    } finally {
      vi.useRealTimers();
    }
  });

  it("scheduled() (the actual Worker cron entrypoint) swallows the stale-data pause and does not throw out of the handler", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(STALE_MOCK_DATE);
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

  it("AuditLab STALE-3: scheduled() sends exactly ONE operator alert per UTC day, no matter how many of the ~7 passes trip the guard or how many times scheduled() itself is called that day", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(STALE_MOCK_DATE);
      const day = STALE_MOCK_DATE.toISOString().slice(0, 10);
      // Clean slate for this specific day -- other tests in this suite may
      // share the same mocked day if STALENESS_THRESHOLD_DAYS/as_of_date
      // haven't changed between runs.
      await env.DB.prepare(`DELETE FROM stale_data_alert_log WHERE day = ?1`).bind(day).run();

      const worker = (await import("../src/index")).default;
      const waited1: Promise<unknown>[] = [];
      const ctx1 = { waitUntil: (p: Promise<unknown>) => waited1.push(p) } as unknown as ExecutionContext;
      const envWithKey = { ...env, SENDGRID_API_KEY: "test-key-not-real" };

      await worker.scheduled({} as ScheduledController, envWithKey, ctx1);
      await Promise.all(waited1);
      const afterFirst = await env.DB.prepare(`SELECT COUNT(*) AS n FROM stale_data_alert_log WHERE day = ?1`)
        .bind(day)
        .first<{ n: number }>();
      // At least one of the ~6 stale-data-throwing passes hit the guard in
      // this single scheduled() call, and every one of them called
      // notifyOperatorOfStaleData() -- the row count proves only one
      // actually won the claim.
      expect(afterFirst?.n).toBe(1);

      // Second scheduled() call, same mocked day -- must NOT insert a second
      // row (this is the "how many times scheduled() itself is called"
      // half of the guarantee).
      const waited2: Promise<unknown>[] = [];
      const ctx2 = { waitUntil: (p: Promise<unknown>) => waited2.push(p) } as unknown as ExecutionContext;
      await worker.scheduled({} as ScheduledController, envWithKey, ctx2);
      await Promise.all(waited2);
      const afterSecond = await env.DB.prepare(`SELECT COUNT(*) AS n FROM stale_data_alert_log WHERE day = ?1`)
        .bind(day)
        .first<{ n: number }>();
      expect(afterSecond?.n).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("AuditLab STALE-3: no alert (and no claim consumed) when SENDGRID_API_KEY is unset -- matches every other send in this file degrading to a no-op", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(STALE_MOCK_DATE);
      const day = STALE_MOCK_DATE.toISOString().slice(0, 10);
      await env.DB.prepare(`DELETE FROM stale_data_alert_log WHERE day = ?1`).bind(day).run();

      const worker = (await import("../src/index")).default;
      const waited: Promise<unknown>[] = [];
      const ctx = { waitUntil: (p: Promise<unknown>) => waited.push(p) } as unknown as ExecutionContext;
      // env (no SENDGRID_API_KEY override) -- same as the fixture used by
      // the "temporarily paused" tests above this block.
      await worker.scheduled({} as ScheduledController, env, ctx);
      await Promise.all(waited);
      const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM stale_data_alert_log WHERE day = ?1`)
        .bind(day)
        .first<{ n: number }>();
      expect(row?.n).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("store.claimStaleDataAlertForToday (AuditLab STALE-3)", () => {
  it("first claim for a given day wins (true), second claim same day loses (false)", async () => {
    const day = `2027-03-${Date.now() % 29 + 1}`.slice(0, 10); // unique-ish day per test run
    const first = await store.claimStaleDataAlertForToday(env.DB, day);
    const second = await store.claimStaleDataAlertForToday(env.DB, day);
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("a different day gets its own independent claim", async () => {
    const dayA = "2027-04-01";
    const dayB = "2027-04-02";
    await store.claimStaleDataAlertForToday(env.DB, dayA); // consume dayA
    const claimB = await store.claimStaleDataAlertForToday(env.DB, dayB);
    expect(claimB).toBe(true);
  });
});

describe("store.logSilentDrop / resolveSilentDrop (AuditLab SILENT-1)", () => {
  it("logs a fresh drop, keeps first_detected_at across repeated drops, then resolves", async () => {
    const id = `silent-drop-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await env.DB.prepare(`DELETE FROM silent_drop_log WHERE subscriber_id = ?1`).bind(id).run();

    await store.logSilentDrop(env.DB, id, "still-dropped@example.com", "florida", "no_computable_deadline");
    const first = await env.DB.prepare(`SELECT * FROM silent_drop_log WHERE subscriber_id = ?1`).bind(id).first<{
      first_detected_at: string;
      last_seen_at: string;
      resolved_at: string | null;
      reason: string;
    }>();
    expect(first?.reason).toBe("no_computable_deadline");
    expect(first?.resolved_at).toBeNull();
    expect(first?.first_detected_at).toBe(first?.last_seen_at);

    // A later run, still dropped -- first_detected_at must NOT move, even
    // though last_seen_at (and possibly the reason) can.
    await new Promise((r) => setTimeout(r, 5));
    await store.logSilentDrop(env.DB, id, "still-dropped@example.com", "florida", "unknown_state");
    const second = await env.DB.prepare(`SELECT * FROM silent_drop_log WHERE subscriber_id = ?1`).bind(id).first<{
      first_detected_at: string;
      last_seen_at: string;
      reason: string;
    }>();
    expect(second?.first_detected_at).toBe(first?.first_detected_at);
    expect(second?.reason).toBe("unknown_state");

    // Resolved: a clean deadline computation closes the row.
    await store.resolveSilentDrop(env.DB, id);
    const resolved = await env.DB.prepare(`SELECT resolved_at FROM silent_drop_log WHERE subscriber_id = ?1`)
      .bind(id)
      .first<{ resolved_at: string | null }>();
    expect(resolved?.resolved_at).not.toBeNull();

    // Resolving an already-resolved row a second time must not overwrite
    // the original resolved_at (the "when did this get fixed" question
    // should have one stable answer, not a moving one).
    const resolvedAt = resolved!.resolved_at;
    await new Promise((r) => setTimeout(r, 5));
    await store.resolveSilentDrop(env.DB, id);
    const resolvedAgain = await env.DB.prepare(`SELECT resolved_at FROM silent_drop_log WHERE subscriber_id = ?1`)
      .bind(id)
      .first<{ resolved_at: string | null }>();
    expect(resolvedAgain?.resolved_at).toBe(resolvedAt);

    // Re-dropped after being resolved: resolved_at clears again.
    await store.logSilentDrop(env.DB, id, "still-dropped@example.com", "florida", "no_computable_deadline");
    const reDropped = await env.DB.prepare(`SELECT resolved_at FROM silent_drop_log WHERE subscriber_id = ?1`)
      .bind(id)
      .first<{ resolved_at: string | null }>();
    expect(reDropped?.resolved_at).toBeNull();

    await env.DB.prepare(`DELETE FROM silent_drop_log WHERE subscriber_id = ?1`).bind(id).run();
  });

  it("resolving a subscriber with no drop row is a harmless no-op", async () => {
    await expect(store.resolveSilentDrop(env.DB, "never-was-dropped-xyz")).resolves.toBeUndefined();
  });

  it("runReminderPass actually calls logSilentDrop/resolveSilentDrop -- not just tested in isolation", async () => {
    // Guards against the exact trap this codebase has hit before: a helper
    // function fully unit-tested but never wired into the real pass that's
    // supposed to call it. This test exercises runReminderPass() itself,
    // not logSilentDrop()/resolveSilentDrop() directly.
    const { runReminderPass } = await import("../src/scheduler");
    const email = `sched-silent1-${Date.now()}@example.com`;
    // florida with no license_type_id is the exact real-world shape
    // SILENT-1 was filed against: computeSubscriberDeadline("florida", {})
    // returns null.
    const rec = await store.addPending(env.DB, {
      email,
      stateSlug: "florida",
      deadlineFields: {},
      firstName: "Tester",
      skipConfirmation: true,
    });

    const asOf = new Date(Date.UTC(2026, 6, 24));
    const summary1 = await runReminderPass(env, { asOf, send: async () => true });
    expect(summary1.skipped_no_deadline).toBeGreaterThan(0);

    const row1 = await env.DB.prepare(`SELECT * FROM silent_drop_log WHERE subscriber_id = ?1`).bind(rec.id).first<{
      reason: string;
      resolved_at: string | null;
    }>();
    expect(row1?.reason).toBe("no_computable_deadline");
    expect(row1?.resolved_at).toBeNull();

    // Fix the subscriber's fields (what a real re-subscribe / backfill
    // would do) and re-run -- the row should close.
    await env.DB.prepare(`UPDATE subscribers SET deadline_fields = ?1 WHERE id = ?2`)
      .bind(JSON.stringify({ license_type_id: "fl-firm" }), rec.id)
      .run();
    await runReminderPass(env, { asOf, send: async () => true });
    const row2 = await env.DB.prepare(`SELECT resolved_at FROM silent_drop_log WHERE subscriber_id = ?1`)
      .bind(rec.id)
      .first<{ resolved_at: string | null }>();
    expect(row2?.resolved_at).not.toBeNull();

    await env.DB.prepare(`DELETE FROM silent_drop_log WHERE subscriber_id = ?1`).bind(rec.id).run();
  });
});

describe("emails.ts buildStaleDataAlertEmail (AuditLab STALE-3)", () => {
  it("numeric ageDays: subject and body both name the actual age", async () => {
    const { buildStaleDataAlertEmail } = await import("../src/emails");
    const built = buildStaleDataAlertEmail(41, "REFUSING: reference data's as_of_date is 41 days old...");
    expect(built.subject).toContain("41 days old");
    expect(built.textBody).toContain("all outbound sends");
    expect(built.htmlBody).toContain("41 days old");
    expect(built.htmlBody).toContain("REFUSING");
  });

  it("null ageDays (unparseable as_of_date branch): subject/body don't claim a numeric age they don't have", async () => {
    const { buildStaleDataAlertEmail } = await import("../src/emails");
    const built = buildStaleDataAlertEmail(null, "REFUSING: reference data's as_of_date is unparseable...");
    expect(built.subject.toLowerCase()).toContain("unparseable");
    expect(built.subject).not.toMatch(/\d+ days old/);
  });

  it("fires at most once per day, stated in the copy itself", async () => {
    const { buildStaleDataAlertEmail } = await import("../src/emails");
    const built = buildStaleDataAlertEmail(35, "some guard message");
    expect(built.textBody.toLowerCase()).toContain("once per utc day");
  });

  it("AuditLab STALE-6: Infinity ageDays (a record's own last_verified is unparseable) doesn't render the literal string 'Infinity days old' in this function's OWN authored copy", async () => {
    const { buildStaleDataAlertEmail } = await import("../src/emails");
    const guardMessage =
      "REFUSING: reference data is Infinity days old (anchored on its single oldest record's last_verified date)...";
    const built = buildStaleDataAlertEmail(Infinity, guardMessage);
    expect(built.subject).not.toContain("Infinity");
    expect(built.subject.toLowerCase()).toContain("last_verified");
    expect(built.subject.toLowerCase()).toContain("unparseable");
    // The guard message is quoted verbatim (it's the raw thrown error text,
    // and DOES legitimately say "Infinity days old" -- that's the real
    // checkDataFreshness() output). The bug was this function's OWN authored
    // sentence -- the fix-instruction paragraph before the quoted guard
    // message -- rendering "Infinity days old" itself; assert only that part.
    const ownTextCopy = built.textBody.split("Guard message:")[0];
    const ownHtmlCopy = built.htmlBody.split("Guard message:")[0];
    expect(ownTextCopy).not.toContain("Infinity days old");
    expect(ownHtmlCopy).not.toContain("Infinity days old");
    expect(built.textBody).toContain("Guard message: " + guardMessage);
  });
});

describe("emails.ts buildFeatureIdeaShippedEmail (AuditLab UNSUB-4)", () => {
  it("carries a real per-recipient List-Unsubscribe target, not headers: {}", async () => {
    const { buildFeatureIdeaShippedEmail } = await import("../src/emails");
    const unsubscribeUrl = "https://deadline-radar.com/unsubscribe/feature-idea?token=abc123";
    const built = buildFeatureIdeaShippedEmail("SMS reminders", unsubscribeUrl);
    expect(built.headers["List-Unsubscribe"]).toBe(`<${unsubscribeUrl}>`);
    expect(built.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(built.textBody).toContain(unsubscribeUrl);
    expect(built.htmlBody).toContain(unsubscribeUrl);
    expect(built.subject).toContain("SMS reminders");
  });
});

describe("AuditLab NEWS-1 (MEDIUM, 2026-08-13): scheduled() actually invokes runComplianceNewsletterPass", () => {
  it("the compliance-newsletter cron pass runs on every scheduled() invocation, not just the other eight", async () => {
    const worker = (await import("../src/index")).default;
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((msg: unknown) => {
      logs.push(String(msg));
    });
    const waited: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => waited.push(p) } as unknown as ExecutionContext;
    const envWithKey = { ...env, SENDGRID_API_KEY: "test-key-not-real" };
    try {
      await expect(worker.scheduled({} as ScheduledController, envWithKey, ctx)).resolves.not.toThrow();
      await Promise.all(waited);
      // Before the fix, this line never appeared -- runComplianceNewsletterPass
      // was defined and fully tested in isolation (newsletter.spec.ts) but
      // never called from scheduled(), so real double-opted-in subscribers
      // would never receive anything and nothing would ever log an error
      // either. Presence of the log line, not its content, is what proves
      // the wiring -- the pass's own cadence-gating logic is
      // newsletter.spec.ts's job to verify.
      expect(logs.some((l) => l.startsWith("[compliance-newsletter-cron]"))).toBe(true);
    } finally {
      logSpy.mockRestore();
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

// 2026-07-30, new BUILD v2 phase (Devin-approved): CPE-hours tracker. Admin
// logs a staffer's completed hours; requirement matching itself happens
// client-side in the dashboard JS (from data/cpe_hours.json inlined at
// build time), so these tests only cover the worker's CRUD surface --
// cross-firm isolation, validation, and the soft-delete/rate-limit
// mechanics, same discipline as every other firm-scoped mutation.

async function getCpeEntries(cookie: string | null, ip = "203.0.113.210"): Promise<Response> {
  const headers: Record<string, string> = { "cf-connecting-ip": ip };
  if (cookie) headers["Cookie"] = cookie;
  return SELF.fetch("https://deadline-radar.com/firm/cpe", { headers });
}

async function postCpeEntry(
  cookie: string | null,
  body: Record<string, string>,
  ip = "203.0.113.210"
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json", "cf-connecting-ip": ip };
  if (cookie) headers["Cookie"] = cookie;
  return SELF.fetch("https://deadline-radar.com/firm/cpe", { method: "POST", headers, body: JSON.stringify(body) });
}

async function deleteCpeEntry(cookie: string | null, id: string, ip = "203.0.113.210"): Promise<Response> {
  const headers: Record<string, string> = { "cf-connecting-ip": ip };
  if (cookie) headers["Cookie"] = cookie;
  return SELF.fetch(`https://deadline-radar.com/firm/cpe/${encodeURIComponent(id)}`, { method: "DELETE", headers });
}

describe("GET/POST/DELETE /firm/cpe -- CPE-hours entry CRUD", () => {
  it("every route 401s without a session cookie", async () => {
    expect((await getCpeEntries(null)).status).toBe(401);
    expect((await postCpeEntry(null, { subscriber_id: "x", entry_date: "2026-01-01", hours: "1" })).status).toBe(401);
    expect((await deleteCpeEntry(null, "nonexistent")).status).toBe(401);
  });

  it("happy path: logs an entry against the firm's own roster record, returns it, and lists it back", async () => {
    const { cookie, firmId } = await createFirmWithSession("CPE Firm", `cpe-${Date.now()}@example.com`);
    const staffEmail = `cpe-staff-${Date.now()}@example.com`;
    const created = await postFirmLicense(cookie, { email: staffEmail, state_slug: "georgia", license_type_id: "ga-individual" });
    const { id: subscriberId } = (await created.json()) as { id: string };

    const resp = await postCpeEntry(cookie, {
      subscriber_id: subscriberId,
      entry_date: "2026-06-15",
      hours: "8.5",
      category: "ethics",
      description: "Annual ethics course",
    });
    expect(resp.status).toBe(201);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.subscriber_id).toBe(subscriberId);
    expect(body.hours).toBe(8.5);
    expect(body.category).toBe("ethics");
    expect(body.description).toBe("Annual ethics course");
    expect(body).not.toHaveProperty("firm_id"); // internal, never echoed to the client

    const row = await env.DB.prepare("SELECT * FROM cpe_entries WHERE id = ?1").bind(body.id).first<CpeEntryRow>();
    expect(row?.firm_id).toBe(firmId);
    expect(row?.entered_by_actor_type).toBe("admin");
    expect(row?.entered_by_firm_session_id).toBeTruthy(); // forward-compat field actually populated, not left null

    const list = await getCpeEntries(cookie);
    const listBody = (await list.json()) as { entries: Array<{ id: string }> };
    expect(listBody.entries.some((e) => e.id === body.id)).toBe(true);
  });

  it("cross-firm isolation: cannot log a CPE entry against ANOTHER firm's staff record (404, not 403 -- anti-enumeration)", async () => {
    const firmA = await createFirmWithSession("CPE Firm A", `cpe-a-${Date.now()}@example.com`);
    const firmB = await createFirmWithSession("CPE Firm B", `cpe-b-${Date.now()}@example.com`);
    const staffEmail = `cpe-cross-${Date.now()}@example.com`;
    const created = await postFirmLicense(firmA.cookie, { email: staffEmail, state_slug: "georgia", license_type_id: "ga-individual" });
    const { id: subscriberIdInFirmA } = (await created.json()) as { id: string };

    const resp = await postCpeEntry(firmB.cookie, {
      subscriber_id: subscriberIdInFirmA,
      entry_date: "2026-06-15",
      hours: "4",
      category: "general",
    });
    expect(resp.status).toBe(404);

    const count = await env.DB.prepare("SELECT COUNT(*) as c FROM cpe_entries WHERE subscriber_id = ?1").bind(subscriberIdInFirmA).first<{ c: number }>();
    expect(count?.c).toBe(0);
  });

  it("cross-firm isolation: GET /firm/cpe never returns another firm's entries", async () => {
    const firmA = await createFirmWithSession("CPE List Firm A", `cpe-list-a-${Date.now()}@example.com`);
    const firmB = await createFirmWithSession("CPE List Firm B", `cpe-list-b-${Date.now()}@example.com`);
    const createdA = await postFirmLicense(firmA.cookie, { email: `cpe-list-staff-${Date.now()}@example.com`, state_slug: "georgia", license_type_id: "ga-individual" });
    const { id: subA } = (await createdA.json()) as { id: string };
    const entryA = await postCpeEntry(firmA.cookie, { subscriber_id: subA, entry_date: "2026-06-01", hours: "3", category: "general" });
    const { id: entryAId } = (await entryA.json()) as { id: string };

    const listB = await getCpeEntries(firmB.cookie);
    const listBBody = (await listB.json()) as { entries: Array<{ id: string }> };
    expect(listBBody.entries.some((e) => e.id === entryAId)).toBe(false);
  });

  it("rejects a future entry_date (can't log CPE not yet completed)", async () => {
    const { cookie } = await createFirmWithSession("CPE Future Firm", `cpe-future-${Date.now()}@example.com`);
    const created = await postFirmLicense(cookie, { email: `cpe-future-staff-${Date.now()}@example.com`, state_slug: "georgia", license_type_id: "ga-individual" });
    const { id: subscriberId } = (await created.json()) as { id: string };
    const farFuture = "2099-01-01";
    const resp = await postCpeEntry(cookie, { subscriber_id: subscriberId, entry_date: farFuture, hours: "2", category: "general" });
    expect(resp.status).toBe(400);
  });

  it("accepts an entry_date of UTC-tomorrow (timezone grace window -- adversarial-review fix, 2026-07-30)", async () => {
    // A firm admin at a positive UTC offset (most of Europe/Africa/Asia/
    // Pacific) can have a local "today" that's already UTC's "tomorrow" for
    // part of the day -- a real bug an earlier version of this check had
    // (raw `entryDateParsed.getTime() > Date.now()`, no grace window) would
    // have wrongly rejected this as "in the future."
    const { cookie } = await createFirmWithSession("CPE Timezone Firm", `cpe-tz-${Date.now()}@example.com`);
    const created = await postFirmLicense(cookie, { email: `cpe-tz-staff-${Date.now()}@example.com`, state_slug: "georgia", license_type_id: "ga-individual" });
    const { id: subscriberId } = (await created.json()) as { id: string };
    const now = new Date();
    const utcTomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    const utcTomorrowIso = utcTomorrow.toISOString().slice(0, 10);
    const resp = await postCpeEntry(cookie, { subscriber_id: subscriberId, entry_date: utcTomorrowIso, hours: "2", category: "general" });
    expect(resp.status).toBe(201);

    // But the day AFTER that (genuinely in the future for everyone,
    // regardless of timezone) must still be rejected.
    const utcDayAfterTomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 2));
    const rejectResp = await postCpeEntry(cookie, {
      subscriber_id: subscriberId,
      entry_date: utcDayAfterTomorrow.toISOString().slice(0, 10),
      hours: "2",
      category: "general",
    });
    expect(rejectResp.status).toBe(400);
  });

  it("rejects invalid hours: zero, negative, non-numeric, and above the per-entry sanity cap", async () => {
    const { cookie } = await createFirmWithSession("CPE Hours Firm", `cpe-hours-${Date.now()}@example.com`);
    const created = await postFirmLicense(cookie, { email: `cpe-hours-staff-${Date.now()}@example.com`, state_slug: "georgia", license_type_id: "ga-individual" });
    const { id: subscriberId } = (await created.json()) as { id: string };
    for (const badHours of ["0", "-1", "abc", "1e10", "9999"]) {
      const resp = await postCpeEntry(cookie, { subscriber_id: subscriberId, entry_date: "2026-06-01", hours: badHours, category: "general" });
      expect(resp.status, `hours=${badHours} should be rejected`).toBe(400);
    }
  });

  it("rejects an invalid category", async () => {
    const { cookie } = await createFirmWithSession("CPE Category Firm", `cpe-cat-${Date.now()}@example.com`);
    const created = await postFirmLicense(cookie, { email: `cpe-cat-staff-${Date.now()}@example.com`, state_slug: "georgia", license_type_id: "ga-individual" });
    const { id: subscriberId } = (await created.json()) as { id: string };
    const resp = await postCpeEntry(cookie, { subscriber_id: subscriberId, entry_date: "2026-06-01", hours: "2", category: "not-a-real-category" });
    expect(resp.status).toBe(400);
  });

  it("rejects control characters in the description field", async () => {
    const { cookie } = await createFirmWithSession("CPE Control Firm", `cpe-control-${Date.now()}@example.com`);
    const created = await postFirmLicense(cookie, { email: `cpe-control-staff-${Date.now()}@example.com`, state_slug: "georgia", license_type_id: "ga-individual" });
    const { id: subscriberId } = (await created.json()) as { id: string };
    const resp = await postCpeEntry(cookie, {
      subscriber_id: subscriberId,
      entry_date: "2026-06-01",
      hours: "2",
      category: "general",
      description: "bad\r\ndescription",
    });
    expect(resp.status).toBe(400);
  });

  it("DELETE soft-deletes (deleted_at set, row still exists) and the entry disappears from GET /firm/cpe, firm-scoped", async () => {
    const firmA = await createFirmWithSession("CPE Delete Firm A", `cpe-del-a-${Date.now()}@example.com`);
    const firmB = await createFirmWithSession("CPE Delete Firm B", `cpe-del-b-${Date.now()}@example.com`);
    const created = await postFirmLicense(firmA.cookie, { email: `cpe-del-staff-${Date.now()}@example.com`, state_slug: "georgia", license_type_id: "ga-individual" });
    const { id: subscriberId } = (await created.json()) as { id: string };
    const entry = await postCpeEntry(firmA.cookie, { subscriber_id: subscriberId, entry_date: "2026-06-01", hours: "2", category: "general" });
    const { id: entryId } = (await entry.json()) as { id: string };

    // Firm B cannot delete firm A's entry.
    const crossDelete = await deleteCpeEntry(firmB.cookie, entryId);
    expect(crossDelete.status).toBe(404);
    const stillThere = await env.DB.prepare("SELECT deleted_at FROM cpe_entries WHERE id = ?1").bind(entryId).first<{ deleted_at: string | null }>();
    expect(stillThere?.deleted_at).toBeNull();

    const ownDelete = await deleteCpeEntry(firmA.cookie, entryId);
    expect(ownDelete.status).toBe(200);
    const afterDelete = await env.DB.prepare("SELECT deleted_at FROM cpe_entries WHERE id = ?1").bind(entryId).first<{ deleted_at: string | null }>();
    expect(afterDelete?.deleted_at).toBeTruthy(); // row preserved, not a real DELETE

    const list = await getCpeEntries(firmA.cookie);
    const listBody = (await list.json()) as { entries: Array<{ id: string }> };
    expect(listBody.entries.some((e) => e.id === entryId)).toBe(false);
  });

  it("blocks the 101st CPE entry from the same firm within the daily window (own rate-limit bucket)", async () => {
    // 100 real sequential DB-writing requests genuinely takes longer than
    // vitest's 5s default -- explicit timeout, not a sign anything's wrong.
    const { cookie } = await createFirmWithSession("CPE Rate Firm", `cpe-rate-${Date.now()}@example.com`);
    const created = await postFirmLicense(cookie, { email: `cpe-rate-staff-${Date.now()}@example.com`, state_slug: "georgia", license_type_id: "ga-individual" });
    const { id: subscriberId } = (await created.json()) as { id: string };
    for (let i = 0; i < 100; i++) {
      const resp = await postCpeEntry(cookie, { subscriber_id: subscriberId, entry_date: "2026-06-01", hours: "1", category: "general" }, `203.0.113.${210 + (i % 40)}`);
      expect(resp.status, `entry ${i} should succeed`).not.toBe(429);
    }
    const overCap = await postCpeEntry(cookie, { subscriber_id: subscriberId, entry_date: "2026-06-01", hours: "1", category: "general" }, "203.0.113.250");
    expect(overCap.status).toBe(429);
  }, 20000);

  // AuditLab S-3, 2026-08-03 (LOW): DELETE had no bucket at all, unlike POST
  // above. Rate limit runs before the id lookup, so a nonexistent id still
  // consumes the bucket.
  it("blocks the 101st CPE-entry DELETE from the same firm within the daily window", async () => {
    const { cookie } = await createFirmWithSession("CPE Delete Rate Firm", `cpe-delete-rate-${Date.now()}@example.com`);
    let sawA429 = false;
    for (let i = 0; i < 105; i++) {
      const resp = await deleteCpeEntry(cookie, "does-not-exist", `203.0.113.${210 + (i % 40)}`);
      if (resp.status === 429) {
        sawA429 = true;
        break;
      }
      expect(resp.status).toBe(404);
    }
    expect(sawA429, "expected a 429 within the RATE_LIMIT_CPE_ENTRY_DELETE ceiling (100/day) -- got none in 105 requests").toBe(true);
  }, 30000);
});

// ---------------------------------------------------------------------------
// Practice-privilege completion tracking (2026-08-04, migration 0016).
// ---------------------------------------------------------------------------

async function getMobilityCompletions(cookie: string | null, ip = "203.0.113.230"): Promise<Response> {
  const headers: Record<string, string> = { "cf-connecting-ip": ip };
  if (cookie) headers["Cookie"] = cookie;
  return SELF.fetch("https://deadline-radar.com/firm/mobility/completions", { headers });
}

async function postMobilityCompletion(
  cookie: string | null,
  body: Record<string, string>,
  ip = "203.0.113.230"
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json", "cf-connecting-ip": ip };
  if (cookie) headers["Cookie"] = cookie;
  return SELF.fetch("https://deadline-radar.com/firm/mobility/completions", { method: "POST", headers, body: JSON.stringify(body) });
}

async function deleteMobilityCompletion(cookie: string | null, id: string, ip = "203.0.113.230"): Promise<Response> {
  const headers: Record<string, string> = { "cf-connecting-ip": ip };
  if (cookie) headers["Cookie"] = cookie;
  return SELF.fetch(`https://deadline-radar.com/firm/mobility/completions/${encodeURIComponent(id)}`, { method: "DELETE", headers });
}

describe("GET/POST/DELETE /firm/mobility/completions -- practice-privilege completion tracking", () => {
  it("every route 401s without a session cookie", async () => {
    expect((await getMobilityCompletions(null)).status).toBe(401);
    expect((await postMobilityCompletion(null, { subscriber_id: "x", target_state_slug: "texas", service_type: "tax" })).status).toBe(401);
    expect((await deleteMobilityCompletion(null, "nonexistent")).status).toBe(401);
  });

  it("no entitlement gate -- a free-tier firm can still record a completion (recording isn't itself a determination)", async () => {
    const { cookie } = await createFirmWithSession("Mobility Completion Firm", `mob-comp-${Date.now()}@example.com`);
    const created = await postFirmLicense(cookie, { email: `mob-comp-staff-${Date.now()}@example.com`, state_slug: "georgia", license_type_id: "ga-individual" });
    const { id: subscriberId } = (await created.json()) as { id: string };

    const resp = await postMobilityCompletion(cookie, { subscriber_id: subscriberId, target_state_slug: "texas", service_type: "tax" });
    expect(resp.status).toBe(201);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.subscriber_id).toBe(subscriberId);
    expect(body.target_state_slug).toBe("texas");
    expect(body.service_type).toBe("tax");
    expect(body).toHaveProperty("rule_verified_date"); // present even if null -- schema-stable for the client
    expect(body).not.toHaveProperty("firm_id"); // internal, never echoed to the client

    const list = await getMobilityCompletions(cookie);
    const listBody = (await list.json()) as { completions: Array<{ id: string }> };
    expect(listBody.completions.some((c) => c.id === body.id)).toBe(true);
  });

  it("re-marking the SAME (subscriber, target state, service type) upserts rather than duplicating", async () => {
    const { cookie } = await createFirmWithSession("Mobility Upsert Firm", `mob-upsert-${Date.now()}@example.com`);
    const created = await postFirmLicense(cookie, { email: `mob-upsert-staff-${Date.now()}@example.com`, state_slug: "georgia", license_type_id: "ga-individual" });
    const { id: subscriberId } = (await created.json()) as { id: string };

    const first = await postMobilityCompletion(cookie, { subscriber_id: subscriberId, target_state_slug: "texas", service_type: "tax" });
    const { id: firstId } = (await first.json()) as { id: string };
    const second = await postMobilityCompletion(cookie, { subscriber_id: subscriberId, target_state_slug: "texas", service_type: "tax" });
    const { id: secondId } = (await second.json()) as { id: string };
    expect(secondId).toBe(firstId); // same row, refreshed -- not a duplicate

    const count = await env.DB.prepare(
      "SELECT COUNT(*) as c FROM mobility_completions WHERE subscriber_id = ?1 AND deleted_at IS NULL"
    ).bind(subscriberId).first<{ c: number }>();
    expect(count?.c).toBe(1);
  });

  it("a different service_type for the SAME person+state is a separate completion, not an upsert collision", async () => {
    const { cookie } = await createFirmWithSession("Mobility Service Type Firm", `mob-svc-${Date.now()}@example.com`);
    const created = await postFirmLicense(cookie, { email: `mob-svc-staff-${Date.now()}@example.com`, state_slug: "georgia", license_type_id: "ga-individual" });
    const { id: subscriberId } = (await created.json()) as { id: string };

    await postMobilityCompletion(cookie, { subscriber_id: subscriberId, target_state_slug: "texas", service_type: "tax" });
    await postMobilityCompletion(cookie, { subscriber_id: subscriberId, target_state_slug: "texas", service_type: "attest" });

    const count = await env.DB.prepare(
      "SELECT COUNT(*) as c FROM mobility_completions WHERE subscriber_id = ?1 AND deleted_at IS NULL"
    ).bind(subscriberId).first<{ c: number }>();
    expect(count?.c).toBe(2);
  });

  it("cross-firm isolation: cannot mark a completion against ANOTHER firm's staff record (404, not 403 -- anti-enumeration)", async () => {
    const firmA = await createFirmWithSession("Mobility Firm A", `mob-a-${Date.now()}@example.com`);
    const firmB = await createFirmWithSession("Mobility Firm B", `mob-b-${Date.now()}@example.com`);
    const created = await postFirmLicense(firmA.cookie, { email: `mob-cross-${Date.now()}@example.com`, state_slug: "georgia", license_type_id: "ga-individual" });
    const { id: subscriberIdInFirmA } = (await created.json()) as { id: string };

    const resp = await postMobilityCompletion(firmB.cookie, { subscriber_id: subscriberIdInFirmA, target_state_slug: "texas", service_type: "tax" });
    expect(resp.status).toBe(404);

    const count = await env.DB.prepare("SELECT COUNT(*) as c FROM mobility_completions WHERE subscriber_id = ?1").bind(subscriberIdInFirmA).first<{ c: number }>();
    expect(count?.c).toBe(0);
  });

  it("cross-firm isolation: GET never returns another firm's completions", async () => {
    const firmA = await createFirmWithSession("Mobility List Firm A", `mob-list-a-${Date.now()}@example.com`);
    const firmB = await createFirmWithSession("Mobility List Firm B", `mob-list-b-${Date.now()}@example.com`);
    const createdA = await postFirmLicense(firmA.cookie, { email: `mob-list-staff-${Date.now()}@example.com`, state_slug: "georgia", license_type_id: "ga-individual" });
    const { id: subA } = (await createdA.json()) as { id: string };
    const compA = await postMobilityCompletion(firmA.cookie, { subscriber_id: subA, target_state_slug: "texas", service_type: "tax" });
    const { id: compAId } = (await compA.json()) as { id: string };

    const listB = await getMobilityCompletions(firmB.cookie);
    const listBBody = (await listB.json()) as { completions: Array<{ id: string }> };
    expect(listBBody.completions.some((c) => c.id === compAId)).toBe(false);
  });

  it("rejects an unknown target_state_slug and an invalid service_type", async () => {
    const { cookie } = await createFirmWithSession("Mobility Validation Firm", `mob-valid-${Date.now()}@example.com`);
    const created = await postFirmLicense(cookie, { email: `mob-valid-staff-${Date.now()}@example.com`, state_slug: "georgia", license_type_id: "ga-individual" });
    const { id: subscriberId } = (await created.json()) as { id: string };

    expect((await postMobilityCompletion(cookie, { subscriber_id: subscriberId, target_state_slug: "atlantis", service_type: "tax" })).status).toBe(400);
    expect((await postMobilityCompletion(cookie, { subscriber_id: subscriberId, target_state_slug: "texas", service_type: "bogus" })).status).toBe(400);
  });

  it("records the rule's verified_date at completion time (staleness snapshot)", async () => {
    const { cookie } = await createFirmWithSession("Mobility Verified Date Firm", `mob-vd-${Date.now()}@example.com`);
    const created = await postFirmLicense(cookie, { email: `mob-vd-staff-${Date.now()}@example.com`, state_slug: "georgia", license_type_id: "ga-individual" });
    const { id: subscriberId } = (await created.json()) as { id: string };

    const resp = await postMobilityCompletion(cookie, { subscriber_id: subscriberId, target_state_slug: "texas", service_type: "tax" });
    const body = (await resp.json()) as { rule_verified_date: string | null };
    expect(body.rule_verified_date).toBeTruthy(); // texas is a real covered/cited mobility_rules.json record
  });

  it("DELETE soft-deletes (deleted_at set, row still exists) and it disappears from GET, firm-scoped", async () => {
    const firmA = await createFirmWithSession("Mobility Delete Firm A", `mob-del-a-${Date.now()}@example.com`);
    const firmB = await createFirmWithSession("Mobility Delete Firm B", `mob-del-b-${Date.now()}@example.com`);
    const created = await postFirmLicense(firmA.cookie, { email: `mob-del-staff-${Date.now()}@example.com`, state_slug: "georgia", license_type_id: "ga-individual" });
    const { id: subscriberId } = (await created.json()) as { id: string };
    const comp = await postMobilityCompletion(firmA.cookie, { subscriber_id: subscriberId, target_state_slug: "texas", service_type: "tax" });
    const { id: compId } = (await comp.json()) as { id: string };

    // Another firm cannot delete it.
    expect((await deleteMobilityCompletion(firmB.cookie, compId)).status).toBe(404);
    const stillThere = await env.DB.prepare("SELECT deleted_at FROM mobility_completions WHERE id = ?1").bind(compId).first<{ deleted_at: string | null }>();
    expect(stillThere?.deleted_at).toBeNull();

    const del = await deleteMobilityCompletion(firmA.cookie, compId);
    expect(del.status).toBe(200);
    const afterDelete = await env.DB.prepare("SELECT deleted_at FROM mobility_completions WHERE id = ?1").bind(compId).first<{ deleted_at: string | null }>();
    expect(afterDelete?.deleted_at).toBeTruthy(); // row still exists, soft-deleted

    const list = await getMobilityCompletions(firmA.cookie);
    const listBody = (await list.json()) as { completions: Array<{ id: string }> };
    expect(listBody.completions.some((c) => c.id === compId)).toBe(false);
  });

  it("blocks the 101st completion POST from the same firm within the daily window", async () => {
    const { cookie } = await createFirmWithSession("Mobility Rate Firm", `mob-rate-${Date.now()}@example.com`);
    const created = await postFirmLicense(cookie, { email: `mob-rate-staff-${Date.now()}@example.com`, state_slug: "georgia", license_type_id: "ga-individual" });
    const { id: subscriberId } = (await created.json()) as { id: string };
    let sawA429 = false;
    for (let i = 0; i < 105; i++) {
      const resp = await postMobilityCompletion(
        cookie,
        { subscriber_id: subscriberId, target_state_slug: "texas", service_type: "tax" },
        `203.0.113.${230 + (i % 20)}`
      );
      if (resp.status === 429) {
        sawA429 = true;
        break;
      }
      expect(resp.status).toBe(201); // same key upserts every time, so every call under the cap succeeds
    }
    expect(sawA429, "expected a 429 within the RATE_LIMIT_MOBILITY_COMPLETION_CREATE ceiling (100/day) -- got none in 105 requests").toBe(true);
  }, 60000); // each POST here does 2-3 D1 round trips (ownership check, existing-row lookup, insert/update) vs the CPE-delete rate-limit test's single UPDATE, so 30s wasn't enough headroom under full-suite contention
});

// ---------------------------------------------------------------------------
// Auth suite routes (2026-07-30): password login, password set/change, SSO.
// ---------------------------------------------------------------------------

async function postPasswordLogin(fields: Record<string, string>, ip: string): Promise<Response> {
  return SELF.fetch("https://deadline-radar.com/firm/login/password", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": ip },
    body: form(fields),
    redirect: "manual",
  });
}

async function postPasswordSet(
  body: Record<string, unknown>,
  cookie: string | null,
  ip: string
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json", "cf-connecting-ip": ip };
  if (cookie) headers["Cookie"] = cookie;
  return SELF.fetch("https://deadline-radar.com/firm/password", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

/** Creates a firm with a known password and returns it. */
async function firmWithPassword(email: string, password: string): Promise<FirmRow> {
  const { id } = await store.createFirm(env.DB, { name: "Password Test Firm", adminEmail: email });
  await store.setFirmPassword(env.DB, id, await hashPassword(password));
  const firm = await store.getFirmById(env.DB, id);
  return firm as FirmRow;
}

const STRONG_PASSWORD = "correct horse battery staple";

describe("POST /firm/login/password", () => {
  it("signs in with the right password: new session row + cookie + redirect to the dashboard", async () => {
    const email = `pwlogin-ok-${Date.now()}@examplefirm.com`;
    const firm = await firmWithPassword(email, STRONG_PASSWORD);

    const resp = await postPasswordLogin({ admin_email: email, password: STRONG_PASSWORD }, "203.0.113.190");
    expect(resp.status).toBe(302);
    expect(resp.headers.get("Location")).toBe("/firm-dashboard/");

    const setCookie = resp.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toContain("dr_firm_session=");
    expect(setCookie).toContain("HttpOnly");

    const sessions = await env.DB
      .prepare("SELECT COUNT(*) AS c FROM firm_sessions WHERE firm_id = ?1")
      .bind(firm.id)
      .first<{ c: number }>();
    expect(sessions?.c).toBe(1);
  });

  it("rejects the wrong password and creates NO session", async () => {
    const email = `pwlogin-wrong-${Date.now()}@examplefirm.com`;
    const firm = await firmWithPassword(email, STRONG_PASSWORD);

    const resp = await postPasswordLogin({ admin_email: email, password: "not the right password" }, "203.0.113.191");
    expect(resp.status).toBe(400);
    expect(resp.headers.get("Set-Cookie")).toBeNull();

    const sessions = await env.DB
      .prepare("SELECT COUNT(*) AS c FROM firm_sessions WHERE firm_id = ?1")
      .bind(firm.id)
      .first<{ c: number }>();
    expect(sessions?.c).toBe(0);
  });

  it("ANTI-ENUMERATION: a nonexistent email and a wrong password produce byte-identical responses", async () => {
    const email = `pwlogin-enum-${Date.now()}@examplefirm.com`;
    await firmWithPassword(email, STRONG_PASSWORD);

    const wrongPw = await postPasswordLogin({ admin_email: email, password: "wrong password here" }, "203.0.113.192");
    const noSuchFirm = await postPasswordLogin(
      { admin_email: `pwlogin-nobody-${Date.now()}@examplefirm.com`, password: "wrong password here" },
      "203.0.113.193"
    );

    expect(wrongPw.status).toBe(noSuchFirm.status);
    expect(await wrongPw.text()).toBe(await noSuchFirm.text());
  });

  it("ANTI-ENUMERATION: a firm that exists but has NO password is also indistinguishable", async () => {
    // SSO-only / magic-link-only firms must not be identifiable by probing
    // the password form.
    const email = `pwlogin-nopw-${Date.now()}@examplefirm.com`;
    await store.createFirm(env.DB, { name: "No Password Firm", adminEmail: email });

    const noPassword = await postPasswordLogin({ admin_email: email, password: STRONG_PASSWORD }, "203.0.113.194");
    const noSuchFirm = await postPasswordLogin(
      { admin_email: `pwlogin-ghost-${Date.now()}@examplefirm.com`, password: STRONG_PASSWORD },
      "203.0.113.195"
    );

    expect(noPassword.status).toBe(noSuchFirm.status);
    expect(await noPassword.text()).toBe(await noSuchFirm.text());
  });

  it("TIMING: an over-length or empty password does NOT short-circuit -- the oracle the reviews found", async () => {
    // Regression test for the real bug both 2026-07-30 reviews caught.
    // verifyPassword() used to return early (no derivation) for an empty
    // or over-length candidate, while the no-such-firm branch ran the full
    // dummy KDF. That INVERTED the timing signal this handler exists to
    // remove: a fast reply meant "this firm exists and has a password".
    //
    // Crucially, the pre-existing anti-enumeration tests still passed
    // while the hole was open, because they asserted equal BODIES. This
    // asserts equal WORK, which is the property that actually matters.
    const email = `pwlogin-timing-${Date.now()}@examplefirm.com`;
    await firmWithPassword(email, STRONG_PASSWORD);

    const timed = async (password: string, addr: string) => {
      const t0 = Date.now();
      const r = await postPasswordLogin({ admin_email: email, password }, addr);
      return { ms: Date.now() - t0, status: r.status };
    };

    // Baseline: a normal wrong password, which performs a full derivation.
    const baseline = await timed("a wrong but plausible password", "203.0.113.230");
    const overLength = await timed("a".repeat(400), "203.0.113.231");
    const empty = await timed("", "203.0.113.232");

    expect(baseline.status).toBe(400);
    expect(overLength.status).toBe(400);
    expect(empty.status).toBe(400);

    // Generous bound: this is asserting "still does real work", not
    // indistinguishability. Before the fix these returned in ~0ms against
    // a ~59ms baseline; a quarter of baseline cleanly separates the two
    // without being flaky on a loaded machine. Workers can freeze
    // Date.now() between I/O, so skip the assertion if nothing registered.
    if (baseline.ms > 10) {
      expect(overLength.ms).toBeGreaterThan(baseline.ms / 4);
      expect(empty.ms).toBeGreaterThan(baseline.ms / 4);
    }
  }, 30_000);

  it("is case-insensitive on the email but exact on the password", async () => {
    const email = `pwlogin-case-${Date.now()}@examplefirm.com`;
    await firmWithPassword(email, STRONG_PASSWORD);

    const upper = await postPasswordLogin(
      { admin_email: email.toUpperCase(), password: STRONG_PASSWORD },
      "203.0.113.196"
    );
    expect(upper.status).toBe(302);

    const wrongCasePw = await postPasswordLogin(
      { admin_email: email, password: STRONG_PASSWORD.toUpperCase() },
      "203.0.113.197"
    );
    expect(wrongCasePw.status).toBe(400);
  });

  it("silently fails on a filled honeypot without creating a session", async () => {
    const email = `pwlogin-hp-${Date.now()}@examplefirm.com`;
    const firm = await firmWithPassword(email, STRONG_PASSWORD);
    const resp = await postPasswordLogin(
      { admin_email: email, password: STRONG_PASSWORD, hp_website: "im-a-bot" },
      "203.0.113.198"
    );
    expect(resp.status).toBe(400);
    const sessions = await env.DB
      .prepare("SELECT COUNT(*) AS c FROM firm_sessions WHERE firm_id = ?1")
      .bind(firm.id)
      .first<{ c: number }>();
    expect(sessions?.c).toBe(0);
  });

  it("rate limits by IP", async () => {
    const ip = "203.0.113.199";
    for (let i = 0; i < 10; i++) {
      const r = await postPasswordLogin(
        { admin_email: `pwlogin-rl-${i}-${Date.now()}@examplefirm.com`, password: "x".repeat(20) },
        ip
      );
      expect(r.status).not.toBe(429);
    }
    const blocked = await postPasswordLogin(
      { admin_email: `pwlogin-rl-final-${Date.now()}@examplefirm.com`, password: "x".repeat(20) },
      ip
    );
    expect(blocked.status).toBe(429);
  }, 30_000);

  it("rate limits per ACCOUNT even when attempts come from different IPs (distributed guessing)", async () => {
    const email = `pwlogin-acct-rl-${Date.now()}@examplefirm.com`;
    await firmWithPassword(email, STRONG_PASSWORD);
    for (let i = 0; i < 10; i++) {
      const r = await postPasswordLogin({ admin_email: email, password: "wrong guess here" }, `198.51.100.${i}`);
      expect(r.status).not.toBe(429);
    }
    // Fresh IP, same account -> still throttled.
    const blocked = await postPasswordLogin({ admin_email: email, password: "wrong guess here" }, "198.51.100.200");
    expect(blocked.status).toBe(429);
  }, 30_000);
});

describe("POST /firm/password -- set and change", () => {
  it("requires a session", async () => {
    const resp = await postPasswordSet({ new_password: STRONG_PASSWORD }, null, "203.0.113.200");
    expect(resp.status).toBe(401);
  });

  it("sets a FIRST password with no current password required, then that password works for login", async () => {
    const email = `pwset-first-${Date.now()}@examplefirm.com`;
    const { id } = await store.createFirm(env.DB, { name: "Set First Firm", adminEmail: email });
    const { rawSessionToken } = await store.createSession(env.DB, id);

    const resp = await postPasswordSet(
      { new_password: STRONG_PASSWORD },
      `dr_firm_session=${rawSessionToken}`,
      "203.0.113.201"
    );
    expect(resp.status).toBe(200);

    const login = await postPasswordLogin({ admin_email: email, password: STRONG_PASSWORD }, "203.0.113.202");
    expect(login.status).toBe(302);
  });

  it("requires the CURRENT password to change an existing one -- a stolen cookie alone must not rotate the credential", async () => {
    const email = `pwset-change-${Date.now()}@examplefirm.com`;
    const firm = await firmWithPassword(email, STRONG_PASSWORD);
    const { rawSessionToken } = await store.createSession(env.DB, firm.id);

    const noCurrent = await postPasswordSet(
      { new_password: "a brand new password value" },
      `dr_firm_session=${rawSessionToken}`,
      "203.0.113.203"
    );
    expect(noCurrent.status).toBe(400);

    const wrongCurrent = await postPasswordSet(
      { new_password: "a brand new password value", current_password: "not the current one" },
      `dr_firm_session=${rawSessionToken}`,
      "203.0.113.204"
    );
    expect(wrongCurrent.status).toBe(400);

    // The original password must still work after those failed attempts.
    const stillWorks = await postPasswordLogin({ admin_email: email, password: STRONG_PASSWORD }, "203.0.113.205");
    expect(stillWorks.status).toBe(302);
  });

  it("changes the password with the correct current one, and the OLD password stops working", async () => {
    const email = `pwset-rotate-${Date.now()}@examplefirm.com`;
    const firm = await firmWithPassword(email, STRONG_PASSWORD);
    const { rawSessionToken } = await store.createSession(env.DB, firm.id);
    const newPassword = "an entirely different passphrase";

    const resp = await postPasswordSet(
      { new_password: newPassword, current_password: STRONG_PASSWORD },
      `dr_firm_session=${rawSessionToken}`,
      "203.0.113.206"
    );
    expect(resp.status).toBe(200);

    expect((await postPasswordLogin({ admin_email: email, password: newPassword }, "203.0.113.207")).status).toBe(302);
    expect((await postPasswordLogin({ admin_email: email, password: STRONG_PASSWORD }, "203.0.113.208")).status).toBe(
      400
    );
  });

  it("ends every OTHER session on change, but keeps the caller's own", async () => {
    // If the reason for the change is a stolen session, leaving it alive
    // makes the change cosmetic.
    const email = `pwset-sessions-${Date.now()}@examplefirm.com`;
    const firm = await firmWithPassword(email, STRONG_PASSWORD);
    const mine = await store.createSession(env.DB, firm.id);
    const otherA = await store.createSession(env.DB, firm.id);
    const otherB = await store.createSession(env.DB, firm.id);

    const resp = await postPasswordSet(
      { new_password: "yet another good passphrase", current_password: STRONG_PASSWORD },
      `dr_firm_session=${mine.rawSessionToken}`,
      "203.0.113.209"
    );
    expect(resp.status).toBe(200);
    expect((await resp.json<{ other_sessions_ended: number }>()).other_sessions_ended).toBe(2);

    expect(await store.verifySession(env.DB, mine.rawSessionToken)).not.toBeNull();
    expect(await store.verifySession(env.DB, otherA.rawSessionToken)).toBeNull();
    expect(await store.verifySession(env.DB, otherB.rawSessionToken)).toBeNull();
  });

  it("enforces the minimum length", async () => {
    const email = `pwset-weak-${Date.now()}@examplefirm.com`;
    const { id } = await store.createFirm(env.DB, { name: "Weak Firm", adminEmail: email });
    const { rawSessionToken } = await store.createSession(env.DB, id);
    const resp = await postPasswordSet(
      { new_password: "short" },
      `dr_firm_session=${rawSessionToken}`,
      "203.0.113.210"
    );
    expect(resp.status).toBe(400);
  });

  it("cannot set a password on ANOTHER firm -- the session decides the target, not the request body", async () => {
    const victim = await firmWithPassword(`pwset-victim-${Date.now()}@examplefirm.com`, STRONG_PASSWORD);
    const attackerEmail = `pwset-attacker-${Date.now()}@examplefirm.com`;
    const { id: attackerId } = await store.createFirm(env.DB, { name: "Attacker Firm", adminEmail: attackerEmail });
    const { rawSessionToken } = await store.createSession(env.DB, attackerId);

    // Even with the victim's id supplied in the body, the handler must act
    // only on the session's own firm.
    const resp = await postPasswordSet(
      { new_password: "attacker chosen password", firm_id: victim.id, id: victim.id },
      `dr_firm_session=${rawSessionToken}`,
      "203.0.113.211"
    );
    expect(resp.status).toBe(200);

    const victimAfter = await store.getFirmById(env.DB, victim.id);
    expect(victimAfter?.password_hash).toBe(victim.password_hash);
    const victimLogin = await postPasswordLogin(
      { admin_email: victim.admin_email, password: STRONG_PASSWORD },
      "203.0.113.212"
    );
    expect(victimLogin.status).toBe(302);
  });
});

// Task #18 (2026-08-05): explicit self-serve version of the same
// store.deleteOtherSessionsForFirm() sweep POST /firm/password already
// triggers as a side effect (see the "ends every OTHER session on change"
// test above) -- lets an admin end stray sessions WITHOUT changing their
// password first.
async function postSignOutOtherDevices(cookie: string | null, ip: string): Promise<Response> {
  const headers: Record<string, string> = { "cf-connecting-ip": ip };
  if (cookie) headers["Cookie"] = cookie;
  return SELF.fetch("https://deadline-radar.com/firm/sign-out-other-devices", { method: "POST", headers });
}

describe("POST /firm/sign-out-other-devices", () => {
  it("requires a session", async () => {
    const resp = await postSignOutOtherDevices(null, "203.0.113.220");
    expect(resp.status).toBe(401);
  });

  it("ends every OTHER session but keeps the caller's own, and reports the count", async () => {
    const email = `signout-${Date.now()}@examplefirm.com`;
    const { id: firmId } = await store.createFirm(env.DB, { name: "Sign Out Firm", adminEmail: email });
    const mine = await store.createSession(env.DB, firmId);
    const otherA = await store.createSession(env.DB, firmId);
    const otherB = await store.createSession(env.DB, firmId);

    const resp = await postSignOutOtherDevices(`dr_firm_session=${mine.rawSessionToken}`, "203.0.113.221");
    expect(resp.status).toBe(200);
    expect((await resp.json<{ ok: boolean; other_sessions_ended: number }>()).other_sessions_ended).toBe(2);

    expect(await store.verifySession(env.DB, mine.rawSessionToken)).not.toBeNull();
    expect(await store.verifySession(env.DB, otherA.rawSessionToken)).toBeNull();
    expect(await store.verifySession(env.DB, otherB.rawSessionToken)).toBeNull();
  });

  it("reports zero, not an error, when no other sessions exist", async () => {
    const email = `signout-solo-${Date.now()}@examplefirm.com`;
    const { id: firmId } = await store.createFirm(env.DB, { name: "Solo Firm", adminEmail: email });
    const mine = await store.createSession(env.DB, firmId);

    const resp = await postSignOutOtherDevices(`dr_firm_session=${mine.rawSessionToken}`, "203.0.113.222");
    expect(resp.status).toBe(200);
    expect((await resp.json<{ other_sessions_ended: number }>()).other_sessions_ended).toBe(0);
    expect(await store.verifySession(env.DB, mine.rawSessionToken)).not.toBeNull();
  });

  it("does not touch ANOTHER firm's sessions -- the session decides the target, not the request", async () => {
    const victimEmail = `signout-victim-${Date.now()}@examplefirm.com`;
    const { id: victimId } = await store.createFirm(env.DB, { name: "Victim Firm", adminEmail: victimEmail });
    const victimSession = await store.createSession(env.DB, victimId);

    const attackerEmail = `signout-attacker-${Date.now()}@examplefirm.com`;
    const { id: attackerId } = await store.createFirm(env.DB, { name: "Attacker Firm", adminEmail: attackerEmail });
    const attackerSession = await store.createSession(env.DB, attackerId);

    const resp = await postSignOutOtherDevices(`dr_firm_session=${attackerSession.rawSessionToken}`, "203.0.113.223");
    expect(resp.status).toBe(200);
    expect((await resp.json<{ other_sessions_ended: number }>()).other_sessions_ended).toBe(0);

    // The victim's unrelated session must be completely unaffected.
    expect(await store.verifySession(env.DB, victimSession.rawSessionToken)).not.toBeNull();
  });

  it("works for a free-tier (unpaid) firm -- this is a security action, not a paid feature", async () => {
    const email = `signout-free-${Date.now()}@examplefirm.com`;
    const { id: firmId } = await store.createFirm(env.DB, { name: "Free Tier Firm", adminEmail: email });
    const mine = await store.createSession(env.DB, firmId);
    const other = await store.createSession(env.DB, firmId);

    const resp = await postSignOutOtherDevices(`dr_firm_session=${mine.rawSessionToken}`, "203.0.113.224");
    expect(resp.status).toBe(200);
    expect(await store.verifySession(env.DB, other.rawSessionToken)).toBeNull();
  });

  it("400s when Origin doesn't match -- same CSRF defense-in-depth as every other mutating firm route", async () => {
    const email = `signout-csrf-${Date.now()}@examplefirm.com`;
    const { id: firmId } = await store.createFirm(env.DB, { name: "CSRF Firm", adminEmail: email });
    const mine = await store.createSession(env.DB, firmId);
    const other = await store.createSession(env.DB, firmId);

    const resp = await SELF.fetch("https://deadline-radar.com/firm/sign-out-other-devices", {
      method: "POST",
      headers: { "cf-connecting-ip": "203.0.113.225", Cookie: `dr_firm_session=${mine.rawSessionToken}`, Origin: "https://attacker.example" },
    });
    expect(resp.status).toBe(400);
    // Rejected before it touches anything -- the other session must still be alive.
    expect(await store.verifySession(env.DB, other.rawSessionToken)).not.toBeNull();
  });

  it("also invalidates any outstanding (unused) emailed login link -- a live link is a bearer credential too", async () => {
    const email = `signout-tokens-${Date.now()}@examplefirm.com`;
    const { id: firmId } = await store.createFirm(env.DB, { name: "Outstanding Link Firm", adminEmail: email });
    const mine = await store.createSession(env.DB, firmId);
    await store.createLoginToken(env.DB, firmId, "login");
    const other = await store.createSession(env.DB, firmId);
    void other;

    const resp = await postSignOutOtherDevices(`dr_firm_session=${mine.rawSessionToken}`, "203.0.113.226");
    expect(resp.status).toBe(200);

    const outstanding = await env.DB
      .prepare("SELECT COUNT(*) AS c FROM firm_login_tokens WHERE firm_id = ?1 AND used_at IS NULL")
      .bind(firmId)
      .first<{ c: number }>();
    expect(outstanding?.c).toBe(0);
  });

  it("does NOT invalidate outstanding login links when there was nothing to end (no other sessions)", async () => {
    // Guards the endedSessions > 0 gate itself: a solo session calling this
    // must not have a side effect on tokens it never touched.
    const email = `signout-tokens-solo-${Date.now()}@examplefirm.com`;
    const { id: firmId } = await store.createFirm(env.DB, { name: "Solo Link Firm", adminEmail: email });
    const mine = await store.createSession(env.DB, firmId);
    await store.createLoginToken(env.DB, firmId, "login");

    const resp = await postSignOutOtherDevices(`dr_firm_session=${mine.rawSessionToken}`, "203.0.113.227");
    expect(resp.status).toBe(200);

    const outstanding = await env.DB
      .prepare("SELECT COUNT(*) AS c FROM firm_login_tokens WHERE firm_id = ?1 AND used_at IS NULL")
      .bind(firmId)
      .first<{ c: number }>();
    expect(outstanding?.c).toBe(1);
  });

  it("rate-limits PER SESSION, not per firm -- one session's budget can't 429 a different session of the same firm", async () => {
    // Adversarial-review finding (2026-08-05): a per-firm key would let a
    // STOLEN session burn the whole firm's hourly budget across many IPs,
    // then 429 the real owner's own fresh session out of the exact remedy
    // this route exists to offer -- the attacker's session would still be
    // alive while its victim gets "too many attempts." Confirms the fix:
    // exhausting one session's budget leaves a DIFFERENT session's budget
    // untouched.
    const email = `signout-ratelimit-${Date.now()}@examplefirm.com`;
    const { id: firmId } = await store.createFirm(env.DB, { name: "Rate Limit Firm", adminEmail: email });
    const stolen = await store.createSession(env.DB, firmId);

    let sawA429 = false;
    for (let i = 0; i < 12; i++) {
      const resp = await postSignOutOtherDevices(`dr_firm_session=${stolen.rawSessionToken}`, `203.0.113.${230 + i}`);
      if (resp.status === 429) {
        sawA429 = true;
        break;
      }
      expect(resp.status).toBe(200);
    }
    expect(sawA429, "expected the STOLEN session's own budget (10/hour) to exhaust within 12 calls").toBe(true);

    // The owner signing back in AFTER the stolen session burned its own
    // budget gets a brand-new session id -- and therefore a clean budget,
    // never having made a call on it before.
    const owner = await store.createSession(env.DB, firmId);
    const ownerResp = await postSignOutOtherDevices(`dr_firm_session=${owner.rawSessionToken}`, "203.0.113.250");
    expect(ownerResp.status).toBe(200);
  });
});

// AuditLab (2026-08-05, findings/auditlab_20260805_signout_detection_email.spec.ts):
// no test above exercises the detection email itself -- same blind spot as
// the pre-existing, also-untested buildFirmPasswordChangedEmail() send, but
// the handler's own comment calls this email load-bearing ("the only
// signal the real admin ever gets" if the triggering click was a stolen
// session), so proving the try/catch-wrapped best-effort code actually
// does the right thing, rather than trusting it, is worth the permanent
// coverage. Folded into the shipped suite verbatim (env override + fetch
// spy, no new helpers needed -- workerFetch's envOverrides pattern already
// exists elsewhere in this file for the same reason).
describe("POST /firm/sign-out-other-devices -- detection email (AuditLab)", () => {
  async function workerFetchWithEnv(request: Request, envOverrides: Record<string, unknown>): Promise<Response> {
    const worker = (await import("../src/index")).default;
    return worker.fetch(request, { ...env, ...envOverrides } as never, testExecutionContext());
  }

  it("sends to the firm's OWN admin_email, not anywhere request-influenced, when a session is ended", async () => {
    const adminEmail = `signout-email-${Date.now()}@examplefirm.com`;
    const a = await createFirmWithSession("Detection Email Firm", adminEmail);
    await store.createSession(env.DB, a.firmId); // a second, "other" session to end

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({}), { status: 202 }));
    try {
      const resp = await workerFetchWithEnv(
        new Request("https://deadline-radar.com/firm/sign-out-other-devices", {
          method: "POST",
          headers: { Cookie: a.cookie, "cf-connecting-ip": "203.0.113.240" },
        }),
        { SENDGRID_API_KEY: "test-key-not-real" }
      );
      expect(resp.status).toBe(200);
      expect(((await resp.json()) as { other_sessions_ended: number }).other_sessions_ended).toBe(1);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [calledUrl, calledInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(calledUrl).toBe("https://api.sendgrid.com/v3/mail/send");
      const sentBody = JSON.parse((calledInit.body as string) ?? "{}");
      expect(sentBody.personalizations?.[0]?.to?.[0]?.email).toBe(adminEmail); // real admin address, from the DB row
      expect((sentBody.subject ?? "").toLowerCase()).toContain("signed out");
      const htmlContent = (sentBody.content ?? []).find((c: { type: string }) => c.type === "text/html")?.value ?? "";
      expect(htmlContent).toContain("If this was not you");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("does NOT send an email when there was nothing to end (endedSessions === 0 gate)", async () => {
    const adminEmail = `signout-noemail-${Date.now()}@examplefirm.com`;
    const a = await createFirmWithSession("No Email Firm", adminEmail);
    // No second session created -- this is the only one.

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({}), { status: 202 }));
    try {
      const resp = await workerFetchWithEnv(
        new Request("https://deadline-radar.com/firm/sign-out-other-devices", {
          method: "POST",
          headers: { Cookie: a.cookie, "cf-connecting-ip": "203.0.113.241" },
        }),
        { SENDGRID_API_KEY: "test-key-not-real" }
      );
      expect(resp.status).toBe(200);
      expect(((await resp.json()) as { other_sessions_ended: number }).other_sessions_ended).toBe(0);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("a SendGrid failure never fails the request -- the sweep already happened and must not be undone by an email error", async () => {
    const adminEmail = `signout-fail-${Date.now()}@examplefirm.com`;
    const a = await createFirmWithSession("Send Fail Firm", adminEmail);
    const other = await store.createSession(env.DB, a.firmId);

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    try {
      const resp = await workerFetchWithEnv(
        new Request("https://deadline-radar.com/firm/sign-out-other-devices", {
          method: "POST",
          headers: { Cookie: a.cookie, "cf-connecting-ip": "203.0.113.242" },
        }),
        { SENDGRID_API_KEY: "test-key-not-real" }
      );
      expect(resp.status).toBe(200);
      expect(((await resp.json()) as { other_sessions_ended: number }).other_sessions_ended).toBe(1);
      // The session sweep must have actually happened despite the email throwing.
      expect(await store.verifySession(env.DB, other.rawSessionToken)).toBeNull();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

// Task #29 (2026-08-05): self-serve admin-email change. Two-phase --
// POST /firm/change-email only REQUESTS the change (issues a token, emails
// the new address); POST /firm/login/verify (email_change purpose) is what
// actually APPLIES it, on redemption. Tested as two describe blocks
// matching that split.
async function postChangeEmail(cookie: string | null, newEmail: string, ip: string, currentPassword?: string): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json", "cf-connecting-ip": ip };
  if (cookie) headers["Cookie"] = cookie;
  const bodyObj: Record<string, string> = { new_email: newEmail };
  if (currentPassword !== undefined) bodyObj.current_password = currentPassword;
  return SELF.fetch("https://deadline-radar.com/firm/change-email", {
    method: "POST",
    headers,
    body: JSON.stringify(bodyObj),
  });
}

describe("POST /firm/change-email -- request phase", () => {
  it("requires a session", async () => {
    const resp = await postChangeEmail(null, "new@example.com", "203.0.113.260");
    expect(resp.status).toBe(401);
  });

  // AuditLab EMAILCHG-1 (2026-08-05, MEDIUM): a session cookie alone used to
  // be enough -- the admin_email is the account's recovery channel, so a
  // temporary session compromise could become a PERMANENT takeover via
  // email-change, unlike a password change (which correctly already
  // required the current password). Mirrors handleFirmPasswordSet's exact
  // gate; these tests mirror ITS "requires the CURRENT password" test.
  it("requires the CURRENT password to request a change, when the firm has one set", async () => {
    const email = `changeemail-stepup-${Date.now()}@example.com`;
    const firm = await firmWithPassword(email, STRONG_PASSWORD);
    const { rawSessionToken } = await store.createSession(env.DB, firm.id);
    const cookie = `dr_firm_session=${rawSessionToken}`;

    const noCurrent = await postChangeEmail(cookie, `changeemail-stepup-new-${Date.now()}@example.com`, "203.0.113.294");
    expect(noCurrent.status).toBe(400);

    const wrongCurrent = await postChangeEmail(cookie, `changeemail-stepup-new2-${Date.now()}@example.com`, "203.0.113.295", "not the current password");
    expect(wrongCurrent.status).toBe(400);

    // Neither failed attempt should have created a redeemable token.
    const rows = await env.DB
      .prepare("SELECT COUNT(*) AS c FROM firm_login_tokens WHERE firm_id = ?1 AND purpose = 'email_change'")
      .bind(firm.id)
      .first<{ c: number }>();
    expect(rows?.c).toBe(0);

    const correct = await postChangeEmail(cookie, `changeemail-stepup-new3-${Date.now()}@example.com`, "203.0.113.296", STRONG_PASSWORD);
    expect(correct.status).toBe(200);
  });

  it("does NOT require a password for a magic-link-only firm (no password set yet)", async () => {
    const email = `changeemail-nopw-${Date.now()}@example.com`;
    const { cookie } = await createFirmWithSession("Change Email No Password Firm", email);
    const resp = await postChangeEmail(cookie, `changeemail-nopw-new-${Date.now()}@example.com`, "203.0.113.297");
    expect(resp.status).toBe(200);
  });

  it("skips the current-password check when the session is passwordResetAuthorized (already proved control of the inbox via a fresh reset link)", async () => {
    const email = `changeemail-resetauth-${Date.now()}@example.com`;
    const firm = await firmWithPassword(email, STRONG_PASSWORD);
    const { rawToken } = await store.createLoginToken(env.DB, firm.id, "password_reset");
    const resetVerify = await postFirmLoginVerify(rawToken, "203.0.113.298");
    const cookie = `dr_firm_session=${cookieValue(resetVerify.headers.get("Set-Cookie") ?? "", "dr_firm_session")}`;

    const resp = await postChangeEmail(cookie, `changeemail-resetauth-new-${Date.now()}@example.com`, "203.0.113.299");
    expect(resp.status).toBe(200); // no current_password supplied, but the session itself authorizes it
  });

  it("400s when Origin doesn't match -- same CSRF defense-in-depth as every other mutating firm route", async () => {
    const { cookie } = await createFirmWithSession("Change Email CSRF Firm", `changeemail-csrf-${Date.now()}@example.com`);
    const resp = await SELF.fetch("https://deadline-radar.com/firm/change-email", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.261", Cookie: cookie, Origin: "https://attacker.example" },
      body: JSON.stringify({ new_email: "new@example.com" }),
    });
    expect(resp.status).toBe(400);
  });

  it("rejects an invalid email format", async () => {
    const { cookie } = await createFirmWithSession("Change Email Bad Firm", `changeemail-bad-${Date.now()}@example.com`);
    const resp = await postChangeEmail(cookie, "not-an-email", "203.0.113.262");
    expect(resp.status).toBe(400);
  });

  it("rejects a request to change to the SAME email already on file", async () => {
    const email = `changeemail-same-${Date.now()}@example.com`;
    const { cookie } = await createFirmWithSession("Change Email Same Firm", email);
    const resp = await postChangeEmail(cookie, email.toUpperCase(), "203.0.113.263"); // case-insensitive match
    expect(resp.status).toBe(400);
  });

  it("rejects a request to change to an email ANOTHER firm already uses", async () => {
    const takenEmail = `changeemail-taken-${Date.now()}@example.com`;
    await createFirmWithSession("Change Email Taken Firm", takenEmail);
    const { cookie } = await createFirmWithSession("Change Email Requester Firm", `changeemail-requester-${Date.now()}@example.com`);
    const resp = await postChangeEmail(cookie, takenEmail, "203.0.113.264");
    expect(resp.status).toBe(400);
  });

  it("on success, creates an email_change token carrying the exact requested address, and does NOT change admin_email yet", async () => {
    const email = `changeemail-req-${Date.now()}@example.com`;
    const newEmail = `changeemail-new-${Date.now()}@example.com`;
    const { firmId, cookie } = await createFirmWithSession("Change Email Request Firm", email);

    const resp = await postChangeEmail(cookie, newEmail, "203.0.113.265");
    expect(resp.status).toBe(200);

    const firm = await store.getFirmById(env.DB, firmId);
    expect(firm?.admin_email).toBe(email); // unchanged -- request phase only

    const row = await env.DB
      .prepare("SELECT purpose, pending_new_email, used_at FROM firm_login_tokens WHERE firm_id = ?1 AND purpose = 'email_change'")
      .bind(firmId)
      .first<{ purpose: string; pending_new_email: string; used_at: string | null }>();
    expect(row?.pending_new_email).toBe(newEmail);
    expect(row?.used_at).toBeNull();
  });

  it("sends TWO emails on success -- a confirm link to the NEW address, a notice to the OLD one", async () => {
    const oldEmail = `changeemail-old-${Date.now()}@example.com`;
    const newEmail = `changeemail-newdest-${Date.now()}@example.com`;
    const { cookie } = await createFirmWithSession("Change Email Send Firm", oldEmail);

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({}), { status: 202 }));
    try {
      const headers: Record<string, string> = { "content-type": "application/json", "cf-connecting-ip": "203.0.113.266", Cookie: cookie };
      const worker = (await import("../src/index")).default;
      const resp = await worker.fetch(
        new Request("https://deadline-radar.com/firm/change-email", { method: "POST", headers, body: JSON.stringify({ new_email: newEmail }) }),
        { ...env, SENDGRID_API_KEY: "test-key-not-real" } as never,
        testExecutionContext()
      );
      expect(resp.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      const recipients = fetchSpy.mock.calls.map((call) => {
        const init = call[1] as RequestInit;
        const body = JSON.parse((init.body as string) ?? "{}");
        return body.personalizations?.[0]?.to?.[0]?.email;
      });
      expect(recipients).toContain(newEmail);
      expect(recipients).toContain(oldEmail);
      // Adversarial-review M3 (2026-08-05): both sends draw from the same
      // shared daily budget -- the OLD-address detection notice must go
      // FIRST, so a budget that runs out mid-request drops the (harmless,
      // delayable) confirm email rather than silently suppressing the
      // (time-sensitive) warning to the real admin.
      expect(recipients[0]).toBe(oldEmail);
      expect(recipients[1]).toBe(newEmail);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("AuditLab SEC-3: a FAILED notice send (non-2xx from SendGrid) blocks the confirm from going out at all", async () => {
    const oldEmail = `changeemail-sec3-${Date.now()}@example.com`;
    const newEmail = `changeemail-sec3new-${Date.now()}@example.com`;
    const { cookie } = await createFirmWithSession("Change Email SEC-3 Firm", oldEmail);

    // The first call is the OLD-address (member's own) notice -- fails,
    // same as the ordinary "recipient on a bounce/suppression list" case
    // this finding is about.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("", { status: 500 }));
    try {
      const headers: Record<string, string> = { "content-type": "application/json", "cf-connecting-ip": "203.0.113.271", Cookie: cookie };
      const worker = (await import("../src/index")).default;
      const resp = await worker.fetch(
        new Request("https://deadline-radar.com/firm/change-email", { method: "POST", headers, body: JSON.stringify({ new_email: newEmail }) }),
        { ...env, SENDGRID_API_KEY: "test-key-not-real" } as never,
        testExecutionContext()
      );
      expect(resp.status).toBe(200); // request itself still succeeds -- token exists, just unconfirmed
      // Only the failed notice attempt -- the confirm to the attacker-
      // controlled new address must never go out once the warning failed.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("a second request invalidates the FIRST request's outstanding token -- only the latest address can be confirmed", async () => {
    const email = `changeemail-super-${Date.now()}@example.com`;
    const firstNewEmail = `changeemail-first-${Date.now()}@example.com`;
    const secondNewEmail = `changeemail-second-${Date.now()}@example.com`;
    const { firmId, cookie } = await createFirmWithSession("Change Email Supersede Firm", email);

    const firstResp = await postChangeEmail(cookie, firstNewEmail, "203.0.113.267");
    expect(firstResp.status).toBe(200);
    const secondResp = await postChangeEmail(cookie, secondNewEmail, "203.0.113.268");
    expect(secondResp.status).toBe(200);

    const rows = await env.DB
      .prepare("SELECT pending_new_email, used_at FROM firm_login_tokens WHERE firm_id = ?1 AND purpose = 'email_change' ORDER BY created_at ASC")
      .bind(firmId)
      .all<{ pending_new_email: string; used_at: string | null }>();
    expect(rows.results.length).toBe(2);
    expect(rows.results[0]!.pending_new_email).toBe(firstNewEmail);
    expect(rows.results[0]!.used_at).not.toBeNull(); // invalidated
    expect(rows.results[1]!.pending_new_email).toBe(secondNewEmail);
    expect(rows.results[1]!.used_at).toBeNull(); // still redeemable
  });

  it("does NOT invalidate an unrelated outstanding LOGIN token -- only email_change-purpose tokens are superseded", async () => {
    const email = `changeemail-scope-${Date.now()}@example.com`;
    const { firmId, cookie } = await createFirmWithSession("Change Email Scope Firm", email);
    const { rawToken: loginToken } = await store.createLoginToken(env.DB, firmId, "login");

    const resp = await postChangeEmail(cookie, `changeemail-scopenew-${Date.now()}@example.com`, "203.0.113.269");
    expect(resp.status).toBe(200);

    const loginTokenHash = await store.hashToken(loginToken);
    const row = await env.DB
      .prepare("SELECT used_at FROM firm_login_tokens WHERE token_hash = ?1")
      .bind(loginTokenHash)
      .first<{ used_at: string | null }>();
    expect(row?.used_at).toBeNull(); // untouched
  });

  it("rate-limits per firm (5/hour)", async () => {
    const email = `changeemail-rl-${Date.now()}@example.com`;
    const { cookie } = await createFirmWithSession("Change Email RL Firm", email);
    let sawA429 = false;
    for (let i = 0; i < 8; i++) {
      const resp = await postChangeEmail(cookie, `changeemail-rl-target-${i}-${Date.now()}@example.com`, `203.0.113.${270 + i}`);
      if (resp.status === 429) {
        sawA429 = true;
        break;
      }
      expect(resp.status).toBe(200);
    }
    expect(sawA429, "expected the 5/hour firm-keyed budget to exhaust within 8 calls").toBe(true);
  });
});

describe("POST /firm/login/verify -- email_change redemption", () => {
  // Adversarial-review M1 (2026-08-05): an email_change token satisfied the
  // OLD "!== password_reset" gate on the optional inline password-set
  // field, meaning a mistyped-address stranger who received the
  // confirmation email could ALSO set a password on the account in the
  // same click that confirmed the email swap -- a full takeover, not just
  // a wrong-address annoyance. Both index.ts gates (render in
  // actionConfirmPage, apply in handleFirmLoginVerify) were narrowed to
  // exactly "login". This proves the APPLY side; the GET-render side is
  // the same `tokenPurpose === "login"` condition, covered by inspection.
  it("M1 regression: an email_change token must NOT be able to also set a password", async () => {
    const oldEmail = `emailredeem-m1-old-${Date.now()}@example.com`;
    const newEmail = `emailredeem-m1-new-${Date.now()}@example.com`;
    const { id: firmId } = await store.createFirm(env.DB, { name: "M1 Firm", adminEmail: oldEmail });
    const { rawToken } = await store.createLoginToken(env.DB, firmId, "email_change", newEmail);

    const resp = await postFirmLoginVerify(rawToken, "203.0.113.290", "a-genuinely-strong-password");
    expect(resp.status).toBe(302); // the sign-in / email-change itself must still succeed

    const firm = await store.getFirmById(env.DB, firmId);
    expect(firm?.admin_email).toBe(newEmail); // the email change DID apply
    expect(firm?.password_hash).toBeNull(); // but no password was set
  });

  it("a token with a NULL pending_new_email (can't legitimately happen via the real request route, but must degrade safely) changes nothing and still signs in as a plain login", async () => {
    const oldEmail = `emailredeem-null-${Date.now()}@example.com`;
    const { id: firmId } = await store.createFirm(env.DB, { name: "Null Pending Firm", adminEmail: oldEmail });
    // Same shape M2's fix now prevents an unauthenticated caller from
    // reaching via /firm/login -- constructed directly here to prove the
    // REDEMPTION side degrades safely regardless, defense-in-depth.
    const { rawToken } = await store.createLoginToken(env.DB, firmId, "email_change", null);

    const resp = await postFirmLoginVerify(rawToken, "203.0.113.291");
    expect(resp.status).toBe(302);
    expect(resp.headers.get("Location")).toBe("/firm-dashboard/"); // NOT the email_changed destination
    const firm = await store.getFirmById(env.DB, firmId);
    expect(firm?.admin_email).toBe(oldEmail); // unchanged
  });

  it("applies the pending email, signs in, and redirects with #account?email_changed=1", async () => {
    const oldEmail = `emailredeem-old-${Date.now()}@example.com`;
    const newEmail = `emailredeem-new-${Date.now()}@example.com`;
    const { id: firmId } = await store.createFirm(env.DB, { name: "Redeem Firm", adminEmail: oldEmail });
    const { rawToken } = await store.createLoginToken(env.DB, firmId, "email_change", newEmail);

    const resp = await postFirmLoginVerify(rawToken, "203.0.113.280");
    expect(resp.status).toBe(302);
    expect(resp.headers.get("Location")).toBe("/firm-dashboard/#account?email_changed=1");
    const setCookie = resp.headers.get("Set-Cookie");
    expect(setCookie).toContain("dr_firm_session=");

    const firm = await store.getFirmById(env.DB, firmId);
    expect(firm?.admin_email).toBe(newEmail);

    // The OLD address must no longer resolve to this firm at all.
    expect(await store.findFirmByAdminEmail(env.DB, oldEmail)).toBeNull();
    expect((await store.findFirmByAdminEmail(env.DB, newEmail))?.id).toBe(firmId);
  });

  it("a conflict at redemption time (address claimed by someone else in between) still signs in, but does NOT apply the change", async () => {
    const oldEmail = `emailredeem-conflict-old-${Date.now()}@example.com`;
    const contestedEmail = `emailredeem-contested-${Date.now()}@example.com`;
    const { id: firmId } = await store.createFirm(env.DB, { name: "Conflict Firm", adminEmail: oldEmail });
    const { rawToken } = await store.createLoginToken(env.DB, firmId, "email_change", contestedEmail);

    // A DIFFERENT firm claims the contested address AFTER the token was
    // issued but BEFORE it's redeemed -- the exact race updateFirmAdminEmail()
    // exists to survive.
    await store.createFirm(env.DB, { name: "Other Firm", adminEmail: contestedEmail });

    const resp = await postFirmLoginVerify(rawToken, "203.0.113.281");
    expect(resp.status).toBe(302);
    expect(resp.headers.get("Location")).toBe("/firm-dashboard/#account?email_change_failed=conflict");
    expect(resp.headers.get("Set-Cookie")).toContain("dr_firm_session="); // still signed in

    const firm = await store.getFirmById(env.DB, firmId);
    expect(firm?.admin_email).toBe(oldEmail); // unchanged, not silently overwritten or duplicated
  });

  it("full request-then-redeem round trip via the real emailed link", async () => {
    const oldEmail = `emailflow-old-${Date.now()}@example.com`;
    const newEmail = `emailflow-new-${Date.now()}@example.com`;
    const { cookie } = await createFirmWithSession("Full Flow Firm", oldEmail);

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      return new Response(JSON.stringify({}), { status: 202 });
    });
    let capturedConfirmUrl: string | null = null;
    try {
      const worker = (await import("../src/index")).default;
      const changeResp = await worker.fetch(
        new Request("https://deadline-radar.com/firm/change-email", {
          method: "POST",
          headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.282", Cookie: cookie },
          body: JSON.stringify({ new_email: newEmail }),
        }),
        { ...env, SENDGRID_API_KEY: "test-key-not-real" } as never,
        testExecutionContext()
      );
      expect(changeResp.status).toBe(200);

      const confirmCall = fetchSpy.mock.calls.find((call) => {
        const init2 = call[1] as RequestInit;
        const body = JSON.parse((init2.body as string) ?? "{}");
        return body.personalizations?.[0]?.to?.[0]?.email === newEmail;
      });
      const confirmBody = JSON.parse(((confirmCall?.[1] as RequestInit).body as string) ?? "{}");
      const htmlContent = (confirmBody.content ?? []).find((c: { type: string }) => c.type === "text/html")?.value ?? "";
      const match = /href="([^"]*\/firm\/login\/verify\?token=[^"]+)"/.exec(htmlContent);
      expect(match).toBeTruthy();
      capturedConfirmUrl = match![1]!.replace(/&amp;/g, "&");
    } finally {
      fetchSpy.mockRestore();
    }

    const rawToken = new URL(capturedConfirmUrl!).searchParams.get("token");
    expect(rawToken).toBeTruthy();
    const redeemResp = await postFirmLoginVerify(rawToken, "203.0.113.283");
    expect(redeemResp.status).toBe(302);
    expect(redeemResp.headers.get("Location")).toBe("/firm-dashboard/#account?email_changed=1");

    // The real end-to-end effect: the old address no longer resolves to
    // this firm at all, the new one does.
    expect(await store.findFirmByAdminEmail(env.DB, oldEmail)).toBeNull();
    expect((await store.findFirmByAdminEmail(env.DB, newEmail))?.admin_email).toBe(newEmail);
  });
});

describe("SSO routes", () => {
  const ssoEnv = { GOOGLE_OAUTH_CLIENT_ID: "test-client-id", GOOGLE_OAUTH_CLIENT_SECRET: "test-client-secret" };

  it("404s /firm/auth/google/start when the provider is NOT configured", async () => {
    const worker = (await import("../src/index")).default;
    const req = new Request("https://deadline-radar.com/firm/auth/google/start", {
      headers: { "cf-connecting-ip": "203.0.113.213" },
    });
    const resp = await worker.fetch(req, env, testExecutionContext());
    expect(resp.status).toBe(404);
  });

  it("redirects to Google with state, nonce, and a PKCE S256 challenge when configured", async () => {
    const worker = (await import("../src/index")).default;
    const req = new Request("https://deadline-radar.com/firm/auth/google/start", {
      headers: { "cf-connecting-ip": "203.0.113.214" },
    });
    const resp = await worker.fetch(req, { ...env, ...ssoEnv }, testExecutionContext());
    expect(resp.status).toBe(302);

    const location = new URL(resp.headers.get("Location") as string);
    expect(location.origin + location.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("state")).toBeTruthy();
    expect(location.searchParams.get("nonce")).toBeTruthy();
    expect(location.searchParams.get("client_id")).toBe("test-client-id");
    // The secret must never reach the browser.
    expect(resp.headers.get("Location")).not.toContain("test-client-secret");
  });

  it("stores only a HASH of state, never the raw value", async () => {
    const worker = (await import("../src/index")).default;
    const req = new Request("https://deadline-radar.com/firm/auth/google/start", {
      headers: { "cf-connecting-ip": "203.0.113.215" },
    });
    const resp = await worker.fetch(req, { ...env, ...ssoEnv }, testExecutionContext());
    const rawState = new URL(resp.headers.get("Location") as string).searchParams.get("state") as string;

    const row = await env.DB
      .prepare("SELECT COUNT(*) AS c FROM firm_oauth_states WHERE state_hash = ?1")
      .bind(rawState)
      .first<{ c: number }>();
    expect(row?.c).toBe(0); // raw value is not what's stored
    const binding = cookieValue(resp.headers.get("Set-Cookie") ?? "", "dr_oauth_handshake");
    expect(await store.consumeOauthState(env.DB, rawState, binding)).not.toBeNull();
  });

  it("404s an unknown provider id rather than revealing route shape", async () => {
    const worker = (await import("../src/index")).default;
    for (const path of ["/firm/auth/microsoft/start", "/firm/auth/evil/start", "/firm/auth/okta/callback"]) {
      const resp = await worker.fetch(
        new Request(`https://deadline-radar.com${path}`, { headers: { "cf-connecting-ip": "203.0.113.216" } }),
        { ...env, ...ssoEnv },
        testExecutionContext()
      );
      expect(resp.status).toBe(404);
    }
  });

  it("rejects a callback with a missing, unknown, or already-used state", async () => {
    const worker = (await import("../src/index")).default;
    const call = (qs: string) =>
      worker.fetch(
        new Request(`https://deadline-radar.com/firm/auth/google/callback${qs}`, {
          headers: { "cf-connecting-ip": "203.0.113.217" },
        }),
        { ...env, ...ssoEnv },
        testExecutionContext()
      );

    expect((await call("")).status).toBe(400);
    expect((await call("?code=abc")).status).toBe(400);
    expect((await call("?code=abc&state=never-issued")).status).toBe(400);

    // A state that WAS issued but has already been consumed must not work
    // a second time -- this is what stops a captured callback URL being
    // replayed into a session.
    const { rawState, rawBrowserBinding } = await store.createOauthState(env.DB, "google");
    await store.consumeOauthState(env.DB, rawState, rawBrowserBinding);
    expect((await call(`?code=abc&state=${rawState}`)).status).toBe(400);
  });

  it("SECURITY: a valid state is useless without the matching handshake cookie (login CSRF / session swap)", async () => {
    // Both 2026-07-30 reviews flagged this: single-use state gives replay
    // protection, NOT CSRF protection, because an attacker can mint a
    // perfectly valid state by calling /start themselves. Without a
    // browser binding, an attacker could complete consent as themselves,
    // hand the victim the callback URL, and have the victim's browser
    // silently signed into the ATTACKER'S firm -- so the victim's client
    // data lands in the attacker's tenant.
    const worker = (await import("../src/index")).default;
    const { rawState, rawBrowserBinding } = await store.createOauthState(env.DB, "google");

    // Victim's browser: holds the attacker's state, but NOT the cookie.
    const noCookie = await worker.fetch(
      new Request(`https://deadline-radar.com/firm/auth/google/callback?code=abc&state=${rawState}`, {
        headers: { "cf-connecting-ip": "203.0.113.220" },
      }),
      { ...env, ...ssoEnv },
        testExecutionContext()
    );
    expect(noCookie.status).toBe(400);

    // A cookie from a DIFFERENT handshake must not work either.
    const other = await store.createOauthState(env.DB, "google");
    const wrongCookie = await worker.fetch(
      new Request(`https://deadline-radar.com/firm/auth/google/callback?code=abc&state=${rawState}`, {
        headers: { "cf-connecting-ip": "203.0.113.221", Cookie: `dr_oauth_handshake=${other.rawBrowserBinding}` },
      }),
      { ...env, ...ssoEnv },
        testExecutionContext()
    );
    expect(wrongCookie.status).toBe(400);

    // And the state must still be unconsumed after those failures, so a
    // rejected attempt can't be used to burn a legitimate handshake.
    expect(await store.consumeOauthState(env.DB, rawState, rawBrowserBinding)).not.toBeNull();
  });

  it("/start issues the handshake cookie: HttpOnly, Secure, SameSite=Lax", async () => {
    const worker = (await import("../src/index")).default;
    const resp = await worker.fetch(
      new Request("https://deadline-radar.com/firm/auth/google/start", {
        headers: { "cf-connecting-ip": "203.0.113.222" },
      }),
      { ...env, ...ssoEnv },
        testExecutionContext()
    );
    const setCookie = resp.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toContain("dr_oauth_handshake=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    // Lax specifically -- the callback is a cross-site top-level GET from
    // the provider, which Strict would block, breaking every SSO sign-in.
    expect(setCookie).toContain("SameSite=Lax");
  });

  it("rejects a pre-0011 state row that has no stored browser binding (fails closed, not grandfathered)", async () => {
    const worker = (await import("../src/index")).default;
    const { rawState, rawBrowserBinding } = await store.createOauthState(env.DB, "google");
    // Simulate a row written before migration 0011.
    await env.DB.prepare("UPDATE firm_oauth_states SET browser_binding_hash = NULL WHERE state_hash = ?1")
      .bind(await store.hashToken(rawState))
      .run();
    const resp = await worker.fetch(
      new Request(`https://deadline-radar.com/firm/auth/google/callback?code=abc&state=${rawState}`, {
        headers: { "cf-connecting-ip": "203.0.113.223", Cookie: `dr_oauth_handshake=${rawBrowserBinding}` },
      }),
      { ...env, ...ssoEnv },
        testExecutionContext()
    );
    expect(resp.status).toBe(400);
  });

  it("rejects a provider-side error without echoing the provider's text back to the browser", async () => {
    const worker = (await import("../src/index")).default;
    const resp = await worker.fetch(
      new Request(
        "https://deadline-radar.com/firm/auth/google/callback?error=access_denied&error_description=leaky-internal-detail",
        { headers: { "cf-connecting-ip": "203.0.113.218" } }
      ),
      { ...env, ...ssoEnv },
        testExecutionContext()
    );
    expect(resp.status).toBe(400);
    expect(await resp.text()).not.toContain("leaky-internal-detail");
  });

  it("does NOT accept a state issued for a different provider at this callback", async () => {
    const worker = (await import("../src/index")).default;
    const { rawState } = await store.createOauthState(env.DB, "someotherprovider");
    const resp = await worker.fetch(
      new Request(`https://deadline-radar.com/firm/auth/google/callback?code=abc&state=${rawState}`, {
        headers: { "cf-connecting-ip": "203.0.113.219" },
      }),
      { ...env, ...ssoEnv },
        testExecutionContext()
    );
    expect(resp.status).toBe(400);
  });

  // Everything above stops before a real code exchange -- no test previously
  // drove a SUCCESSFUL callback (AuditLab's SSO audit, 2026-08-03: "the
  // product suite has zero coverage of a successful callback or the linking
  // path"). These stub the token endpoint and exercise the real linking,
  // session-minting and SSO-A re-check branches end to end.
  function makeIdToken(payload: Record<string, unknown>): string {
    const b64url = (o: unknown) => {
      const bytes = new TextEncoder().encode(JSON.stringify(o));
      let bin = "";
      for (const b of bytes) bin += String.fromCharCode(b);
      return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    };
    return `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url(payload)}.fake-signature`;
  }

  function stubTokenEndpoint(idToken: string) {
    return vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ id_token: idToken }), { status: 200 }));
  }

  it("a full successful callback links a new identity and starts a real session", async () => {
    const worker = (await import("../src/index")).default;
    const email = `sso-happy-${Date.now()}@examplefirm.com`;
    await store.createFirm(env.DB, { name: "SSO Happy Firm", adminEmail: email });
    const { rawState, nonce, rawBrowserBinding } = await store.createOauthState(env.DB, "google");
    const idToken = makeIdToken({
      iss: "https://accounts.google.com",
      aud: "test-client-id",
      exp: Math.floor(Date.now() / 1000) + 3600,
      nonce,
      sub: `sso-happy-sub-${Date.now()}`,
      email,
      email_verified: true,
    });
    const fetchSpy = stubTokenEndpoint(idToken);
    try {
      const resp = await worker.fetch(
        new Request(`https://deadline-radar.com/firm/auth/google/callback?code=test-code&state=${rawState}`, {
          headers: { "cf-connecting-ip": "203.0.113.230", Cookie: `dr_oauth_handshake=${rawBrowserBinding}` },
        }),
        { ...env, ...ssoEnv },
        testExecutionContext()
      );
      expect(resp.status).toBe(302);
      expect(resp.headers.get("Location")).toContain("/firm-dashboard/");
      expect(resp.headers.get("Set-Cookie")).toContain("dr_firm_session=");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("SSO-B (2026-08-03): linking a new identity emails the firm owner, and a repeat login does NOT re-send", async () => {
    const worker = (await import("../src/index")).default;
    const email = `sso-b-${Date.now()}@examplefirm.com`;
    await store.createFirm(env.DB, { name: "SSO-B Firm", adminEmail: email });
    const sub = `sso-b-sub-${Date.now()}`;

    const linkState = await store.createOauthState(env.DB, "google");
    const linkToken = makeIdToken({
      iss: "https://accounts.google.com",
      aud: "test-client-id",
      exp: Math.floor(Date.now() / 1000) + 3600,
      nonce: linkState.nonce,
      sub,
      email,
      email_verified: true,
    });
    const fetchSpy = stubTokenEndpoint(linkToken);
    try {
      const linkResp = await worker.fetch(
        new Request(`https://deadline-radar.com/firm/auth/google/callback?code=test-code&state=${linkState.rawState}`, {
          headers: { "cf-connecting-ip": "203.0.113.236", Cookie: `dr_oauth_handshake=${linkState.rawBrowserBinding}` },
        }),
        { ...env, ...ssoEnv, SENDGRID_API_KEY: "test-key-not-real" },
        testExecutionContext()
      );
      expect(linkResp.status).toBe(302);
      // Call 0 is the token exchange (stubbed); call 1 is the notification.
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      const [sendGridUrl, sendGridInit] = fetchSpy.mock.calls[1] as [string, RequestInit];
      expect(String(sendGridUrl)).toContain("sendgrid");
      const sentBody = JSON.parse(String(sendGridInit.body));
      expect(sentBody.subject).toContain("Google sign-in method was connected");
      const textContent = sentBody.content.find((c: { type: string }) => c.type === "text/plain").value as string;
      expect(textContent).toContain(email);
      expect(textContent).toContain("Connected Sign-In Methods");
    } finally {
      fetchSpy.mockRestore();
    }

    // A REPEAT login with the same already-linked identity must not re-send.
    const loginState = await store.createOauthState(env.DB, "google");
    const loginToken = makeIdToken({
      iss: "https://accounts.google.com",
      aud: "test-client-id",
      exp: Math.floor(Date.now() / 1000) + 3600,
      nonce: loginState.nonce,
      sub,
      email,
      email_verified: true,
    });
    const fetchSpy2 = stubTokenEndpoint(loginToken);
    try {
      const loginResp = await worker.fetch(
        new Request(`https://deadline-radar.com/firm/auth/google/callback?code=test-code&state=${loginState.rawState}`, {
          headers: { "cf-connecting-ip": "203.0.113.237", Cookie: `dr_oauth_handshake=${loginState.rawBrowserBinding}` },
        }),
        { ...env, ...ssoEnv, SENDGRID_API_KEY: "test-key-not-real" },
        testExecutionContext()
      );
      expect(loginResp.status).toBe(302);
      // Only the token exchange -- no second send on a repeat login.
      expect(fetchSpy2).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy2.mockRestore();
    }
  });

  it("SSO-D (2026-08-03): a successful callback clears the handshake cookie, not just the session it mints", async () => {
    const worker = (await import("../src/index")).default;
    const email = `sso-d-${Date.now()}@examplefirm.com`;
    await store.createFirm(env.DB, { name: "SSO-D Firm", adminEmail: email });
    const { rawState, nonce, rawBrowserBinding } = await store.createOauthState(env.DB, "google");
    const idToken = makeIdToken({
      iss: "https://accounts.google.com",
      aud: "test-client-id",
      exp: Math.floor(Date.now() / 1000) + 3600,
      nonce,
      sub: `sso-d-sub-${Date.now()}`,
      email,
      email_verified: true,
    });
    const fetchSpy = stubTokenEndpoint(idToken);
    try {
      const resp = await worker.fetch(
        new Request(`https://deadline-radar.com/firm/auth/google/callback?code=test-code&state=${rawState}`, {
          headers: { "cf-connecting-ip": "203.0.113.235", Cookie: `dr_oauth_handshake=${rawBrowserBinding}` },
        }),
        { ...env, ...ssoEnv },
        testExecutionContext()
      );
      expect(resp.status).toBe(302);
      // Two distinct Set-Cookie headers get joined by Headers#get -- split
      // them back apart on a comma that precedes the next cookie's "name=".
      const setCookies: string[] = (resp.headers.get("Set-Cookie") ?? "").split(/,\s*(?=[^;]+=[^;]*;)/);
      expect(setCookies.some((c: string) => c.includes("dr_firm_session="))).toBe(true);
      const handshakeCookie = setCookies.find((c: string) => c.startsWith("dr_oauth_handshake="));
      expect(handshakeCookie).toBeTruthy();
      expect(handshakeCookie).toContain("Max-Age=0");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("a repeat login with the SAME admin_email still works (no false positive from the SSO-A re-check)", async () => {
    const worker = (await import("../src/index")).default;
    const email = `sso-repeat-${Date.now()}@examplefirm.com`;
    const { id: firmId } = await store.createFirm(env.DB, { name: "SSO Repeat Firm", adminEmail: email });
    const sub = `sso-repeat-sub-${Date.now()}`;
    await store.linkOauthIdentity(env.DB, { firmId, provider: "google", providerSubject: sub, providerEmail: email });

    const { rawState, nonce, rawBrowserBinding } = await store.createOauthState(env.DB, "google");
    const idToken = makeIdToken({
      iss: "https://accounts.google.com",
      aud: "test-client-id",
      exp: Math.floor(Date.now() / 1000) + 3600,
      nonce,
      sub,
      email,
      email_verified: true,
    });
    const fetchSpy = stubTokenEndpoint(idToken);
    try {
      const resp = await worker.fetch(
        new Request(`https://deadline-radar.com/firm/auth/google/callback?code=test-code&state=${rawState}`, {
          headers: { "cf-connecting-ip": "203.0.113.232", Cookie: `dr_oauth_handshake=${rawBrowserBinding}` },
        }),
        { ...env, ...ssoEnv },
        testExecutionContext()
      );
      expect(resp.status).toBe(302);
      expect(resp.headers.get("Set-Cookie")).toContain("dr_firm_session=");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("SSO-A (2026-08-03): a linked identity stops authenticating once the firm's admin_email is reassigned", async () => {
    const worker = (await import("../src/index")).default;
    const originalEmail = `sso-a-orig-${Date.now()}@examplefirm.com`;
    const { id: firmId } = await store.createFirm(env.DB, { name: "SSO-A Firm", adminEmail: originalEmail });
    const sub = `sso-a-sub-${Date.now()}`;
    await store.linkOauthIdentity(env.DB, { firmId, provider: "google", providerSubject: sub, providerEmail: originalEmail });

    // The firm reassigns its admin address to a new owner. No product route
    // does this yet, so simulate it directly, same convention as the
    // pre-0011-row test above.
    await env.DB
      .prepare("UPDATE firms SET admin_email = ?1 WHERE id = ?2")
      .bind(`sso-a-new-owner-${Date.now()}@examplefirm.com`, firmId)
      .run();

    const { rawState, nonce, rawBrowserBinding } = await store.createOauthState(env.DB, "google");
    // The Google account's OWN email never changed -- only the firm's
    // admin_email did. This is exactly the case `sub`-only resolution missed.
    const idToken = makeIdToken({
      iss: "https://accounts.google.com",
      aud: "test-client-id",
      exp: Math.floor(Date.now() / 1000) + 3600,
      nonce,
      sub,
      email: originalEmail,
      email_verified: true,
    });
    const fetchSpy = stubTokenEndpoint(idToken);
    try {
      const resp = await worker.fetch(
        new Request(`https://deadline-radar.com/firm/auth/google/callback?code=test-code&state=${rawState}`, {
          headers: { "cf-connecting-ip": "203.0.113.233", Cookie: `dr_oauth_handshake=${rawBrowserBinding}` },
        }),
        { ...env, ...ssoEnv },
        testExecutionContext()
      );
      expect(resp.status).toBe(403);
      expect(resp.headers.get("Set-Cookie")).toBeFalsy();
      expect(await resp.text()).toContain("different admin email");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("SSO-A: also refused when the SAME account's email comes back unverified (defense in depth, not just a mismatch check)", async () => {
    const worker = (await import("../src/index")).default;
    const email = `sso-a-unverified-${Date.now()}@examplefirm.com`;
    const { id: firmId } = await store.createFirm(env.DB, { name: "SSO-A Unverified Firm", adminEmail: email });
    const sub = `sso-a-unverified-sub-${Date.now()}`;
    await store.linkOauthIdentity(env.DB, { firmId, provider: "google", providerSubject: sub, providerEmail: email });

    const { rawState, nonce, rawBrowserBinding } = await store.createOauthState(env.DB, "google");
    const idToken = makeIdToken({
      iss: "https://accounts.google.com",
      aud: "test-client-id",
      exp: Math.floor(Date.now() / 1000) + 3600,
      nonce,
      sub,
      email,
      email_verified: false,
    });
    const fetchSpy = stubTokenEndpoint(idToken);
    try {
      const resp = await worker.fetch(
        new Request(`https://deadline-radar.com/firm/auth/google/callback?code=test-code&state=${rawState}`, {
          headers: { "cf-connecting-ip": "203.0.113.234", Cookie: `dr_oauth_handshake=${rawBrowserBinding}` },
        }),
        { ...env, ...ssoEnv },
        testExecutionContext()
      );
      expect(resp.status).toBe(403);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  // AuditLab ROLE-1 (MEDIUM, 2026-08-07): firm_oauth_identities has no
  // member_id column, so createSession() would silently default a
  // NON-primary member's brand-new Google link to the firm's PRIMARY
  // member -- a real privilege-escalation path now that requireFirmRole()
  // gates on role. Proves the fix from the real callback route, not just
  // by reading the code: a Staff member's own verified email must be
  // refused, and must NOT create a firm_oauth_identities row or a session.
  it("ROLE-1: refuses SSO for a non-primary member's own verified email (would otherwise mint a Partner-level session)", async () => {
    const worker = (await import("../src/index")).default;
    const ownerEmail = `role1-owner-${Date.now()}@examplefirm.com`;
    const staffEmail = `role1-staff-${Date.now()}@examplefirm.com`;
    const firm = await store.createFirm(env.DB, { name: "ROLE-1 Firm", adminEmail: ownerEmail });
    await store.createFirmMember(env.DB, { firmId: firm.id, email: staffEmail, role: "staff" });

    const { rawState, nonce, rawBrowserBinding } = await store.createOauthState(env.DB, "google");
    const idToken = makeIdToken({
      iss: "https://accounts.google.com",
      aud: "test-client-id",
      exp: Math.floor(Date.now() / 1000) + 3600,
      nonce,
      sub: `role1-staff-sub-${Date.now()}`,
      email: staffEmail,
      email_verified: true,
    });
    const fetchSpy = stubTokenEndpoint(idToken);
    try {
      const resp = await worker.fetch(
        new Request(`https://deadline-radar.com/firm/auth/google/callback?code=test-code&state=${rawState}`, {
          headers: { "cf-connecting-ip": "203.0.113.242", Cookie: `dr_oauth_handshake=${rawBrowserBinding}` },
        }),
        { ...env, ...ssoEnv },
        testExecutionContext()
      );
      expect(resp.status).toBe(403);
      expect(resp.headers.get("Set-Cookie")).toBeNull();
    } finally {
      fetchSpy.mockRestore();
    }

    // No identity was linked, and the staff member has no session -- the
    // refusal happened before either side effect, not after.
    const identities = await store.listOauthIdentitiesForFirm(env.DB, firm.id);
    expect(identities).toHaveLength(0);
  });

  it("ROLE-1: the firm's PRIMARY member's own verified email still links and signs in normally", async () => {
    const worker = (await import("../src/index")).default;
    const ownerEmail = `role1-primary-${Date.now()}@examplefirm.com`;
    await store.createFirm(env.DB, { name: "ROLE-1 Primary Firm", adminEmail: ownerEmail });

    const { rawState, nonce, rawBrowserBinding } = await store.createOauthState(env.DB, "google");
    const idToken = makeIdToken({
      iss: "https://accounts.google.com",
      aud: "test-client-id",
      exp: Math.floor(Date.now() / 1000) + 3600,
      nonce,
      sub: `role1-primary-sub-${Date.now()}`,
      email: ownerEmail,
      email_verified: true,
    });
    const fetchSpy = stubTokenEndpoint(idToken);
    try {
      const resp = await worker.fetch(
        new Request(`https://deadline-radar.com/firm/auth/google/callback?code=test-code&state=${rawState}`, {
          headers: { "cf-connecting-ip": "203.0.113.243", Cookie: `dr_oauth_handshake=${rawBrowserBinding}` },
        }),
        { ...env, ...ssoEnv },
        testExecutionContext()
      );
      expect(resp.status).toBe(302);
      expect(resp.headers.get("Set-Cookie")).toContain("dr_firm_session=");
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("GET/DELETE /firm/oauth-identities -- connected accounts", () => {
  async function callList(cookie: string | null): Promise<Response> {
    const headers: Record<string, string> = { "cf-connecting-ip": "203.0.113.240" };
    if (cookie) headers["Cookie"] = cookie;
    return SELF.fetch("https://deadline-radar.com/firm/oauth-identities", { headers });
  }
  async function callDelete(id: string, cookie: string | null): Promise<Response> {
    const headers: Record<string, string> = { "cf-connecting-ip": "203.0.113.241" };
    if (cookie) headers["Cookie"] = cookie;
    return SELF.fetch(`https://deadline-radar.com/firm/oauth-identities/${id}`, { method: "DELETE", headers });
  }

  it("requires a session", async () => {
    expect((await callList(null)).status).toBe(401);
    expect((await callDelete("anything", null)).status).toBe(401);
  });

  it("lists this firm's linked identities and unlinks one", async () => {
    const email = `ident-${Date.now()}@examplefirm.com`;
    const { id: firmId } = await store.createFirm(env.DB, { name: "Ident Firm", adminEmail: email });
    const linked = await store.linkOauthIdentity(env.DB, {
      firmId,
      provider: "google",
      providerSubject: `sub-${Date.now()}`,
      providerEmail: email,
    });
    const { rawSessionToken } = await store.createSession(env.DB, firmId);
    const cookie = `dr_firm_session=${rawSessionToken}`;

    const list = await callList(cookie);
    expect(list.status).toBe(200);
    const body = await list.json<{ identities: Array<{ id: string; provider: string }> }>();
    expect(body.identities).toHaveLength(1);
    expect(body.identities[0]!.provider).toBe("google");

    expect((await callDelete(linked!.id, cookie)).status).toBe(200);
    expect((await (await callList(cookie)).json<{ identities: unknown[] }>()).identities).toHaveLength(0);
  });

  // AuditLab ROLE-2 (MEDIUM, 2026-08-07): DELETE is Partner-only -- a Staff
  // or Office Manager session must not be able to unlink the firm's
  // (necessarily the Partner's, post-ROLE-1) linked Google account. GET
  // stays open to every role (read-only, same "transparency" posture as
  // the Team panel), only the mutating DELETE is restricted.
  it("ROLE-2: only a Partner can unlink a connected account -- Staff/Office Manager get 403, GET stays open to all", async () => {
    const email = `ident-role2-${Date.now()}@examplefirm.com`;
    const firm = await store.createFirm(env.DB, { name: "Ident Role2 Firm", adminEmail: email });
    const linked = await store.linkOauthIdentity(env.DB, {
      firmId: firm.id,
      provider: "google",
      providerSubject: `sub-role2-${Date.now()}`,
      providerEmail: email,
    });

    const staff = await store.createFirmMember(env.DB, {
      firmId: firm.id,
      email: `ident-role2-staff-${Date.now()}@example.com`,
      role: "staff",
    });
    const { rawSessionToken: staffToken } = await store.createSession(env.DB, firm.id, staff.id);
    const staffCookie = `dr_firm_session=${staffToken}`;

    const officeManager = await store.createFirmMember(env.DB, {
      firmId: firm.id,
      email: `ident-role2-om-${Date.now()}@example.com`,
      role: "office_manager",
    });
    const { rawSessionToken: omToken } = await store.createSession(env.DB, firm.id, officeManager.id);
    const omCookie = `dr_firm_session=${omToken}`;

    // Reads stay open to every role.
    expect((await callList(staffCookie)).status).toBe(200);
    expect((await callList(omCookie)).status).toBe(200);

    // The mutating unlink is Partner-only.
    expect((await callDelete(linked!.id, staffCookie)).status).toBe(403);
    expect((await callDelete(linked!.id, omCookie)).status).toBe(403);

    // Still linked -- neither refused request actually removed it.
    const stillListed = await (await callList(staffCookie)).json<{ identities: unknown[] }>();
    expect(stillListed.identities).toHaveLength(1);

    // The firm's own Partner (its founding/primary member) can.
    const { rawSessionToken: partnerToken } = await store.createSession(env.DB, firm.id);
    const partnerCookie = `dr_firm_session=${partnerToken}`;
    expect((await callDelete(linked!.id, partnerCookie)).status).toBe(200);
  });

  // AuditLab S-3, 2026-08-03 (LOW): DELETE had no bucket at all. Rate limit
  // runs before the id lookup, so a nonexistent id still consumes the bucket.
  it("DELETE /firm/oauth-identities/:id is rate-limited per firm (was completely unbounded)", async () => {
    const email = `ident-rate-${Date.now()}@examplefirm.com`;
    const { id: firmId } = await store.createFirm(env.DB, { name: "Ident Rate Firm", adminEmail: email });
    const { rawSessionToken } = await store.createSession(env.DB, firmId);
    const cookie = `dr_firm_session=${rawSessionToken}`;
    let sawA429 = false;
    for (let i = 0; i < 25; i++) {
      const resp = await callDelete("does-not-exist", cookie);
      if (resp.status === 429) {
        sawA429 = true;
        break;
      }
      expect(resp.status).toBe(404);
    }
    expect(sawA429, "expected a 429 within the RATE_LIMIT_OAUTH_IDENTITY_DELETE ceiling (20/day) -- got none in 25 requests").toBe(true);
  }, 20000);

  it("CROSS-FIRM: cannot see or unlink another firm's identity, and returns a generic 404 not a 403", async () => {
    const victimEmail = `ident-victim-${Date.now()}@examplefirm.com`;
    const { id: victimId } = await store.createFirm(env.DB, { name: "Victim", adminEmail: victimEmail });
    const victimIdentity = await store.linkOauthIdentity(env.DB, {
      firmId: victimId,
      provider: "google",
      providerSubject: `victim-sub-${Date.now()}`,
      providerEmail: victimEmail,
    });

    const { id: attackerId } = await store.createFirm(env.DB, {
      name: "Attacker",
      adminEmail: `ident-attacker-${Date.now()}@examplefirm.com`,
    });
    const { rawSessionToken } = await store.createSession(env.DB, attackerId);
    const cookie = `dr_firm_session=${rawSessionToken}`;

    // Not visible in the attacker's list...
    expect((await (await callList(cookie)).json<{ identities: unknown[] }>()).identities).toHaveLength(0);
    // ...and not deletable, with a 404 that doesn't confirm it exists.
    expect((await callDelete(victimIdentity!.id, cookie)).status).toBe(404);
    // Victim's identity survives.
    expect(await store.listOauthIdentitiesForFirm(env.DB, victimId)).toHaveLength(1);
  });

  it("AuditLab CSRF-1 (2026-08-05): DELETE is rejected when Origin doesn't match, same as its sibling routes", async () => {
    const email = `ident-csrf1-${Date.now()}@examplefirm.com`;
    const { id: firmId } = await store.createFirm(env.DB, { name: "CSRF-1 Firm", adminEmail: email });
    const linked = await store.linkOauthIdentity(env.DB, {
      firmId,
      provider: "google",
      providerSubject: `csrf1-sub-${Date.now()}`,
      providerEmail: email,
    });
    const { rawSessionToken } = await store.createSession(env.DB, firmId);
    const resp = await SELF.fetch(`https://deadline-radar.com/firm/oauth-identities/${linked!.id}`, {
      method: "DELETE",
      headers: { "cf-connecting-ip": "203.0.113.242", Cookie: `dr_firm_session=${rawSessionToken}`, Origin: "https://attacker.example" },
    });
    expect(resp.status).toBe(400);
    // The identity must survive -- the request was rejected, not processed.
    expect(await store.listOauthIdentitiesForFirm(env.DB, firmId)).toHaveLength(1);
  });

  it("unlinking is always allowed -- the emailed sign-in link means it cannot lock anyone out", async () => {
    // Deliberate design property, and the reason no "last sign-in method"
    // guard exists (an earlier comment wrongly claimed one did).
    const email = `ident-last-${Date.now()}@examplefirm.com`;
    const { id: firmId } = await store.createFirm(env.DB, { name: "Last Method Firm", adminEmail: email });
    const linked = await store.linkOauthIdentity(env.DB, {
      firmId,
      provider: "google",
      providerSubject: `last-sub-${Date.now()}`,
      providerEmail: email,
    });
    const { rawSessionToken } = await store.createSession(env.DB, firmId);
    // No password set, and this is the only linked provider.
    expect((await callDelete(linked!.id, `dr_firm_session=${rawSessionToken}`)).status).toBe(200);
    // The magic-link path still works, which is why the above is safe.
    const resp = await postFirmLogin({ admin_email: email }, "203.0.113.242");
    expect(resp.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Mobility / practice-privilege routes (2026-07-30) -- the first PAY-GATED
// feature. The gate and the never-assert-unverified property are what these
// tests attack; the determination logic itself is covered in mobility.spec.ts.
// ---------------------------------------------------------------------------

async function postMobilityCheck(
  body: Record<string, unknown>,
  cookie: string | null,
  ip = "203.0.113.250"
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json", "cf-connecting-ip": ip };
  if (cookie) headers["Cookie"] = cookie;
  return SELF.fetch("https://deadline-radar.com/firm/mobility/check", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function firmOnTier(tier: string, createdAt: string): Promise<{ firmId: string; cookie: string }> {
  const { id } = await store.createFirm(env.DB, {
    name: `Mobility ${tier} Firm`,
    adminEmail: `mobility-${tier}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@examplefirm.com`,
  });
  await env.DB.prepare("UPDATE firms SET plan_tier = ?1, created_at = ?2 WHERE id = ?3")
    .bind(tier, createdAt, id)
    .run();
  const { rawSessionToken } = await store.createSession(env.DB, id);
  return { firmId: id, cookie: `dr_firm_session=${rawSessionToken}` };
}

/** store.createFirm() always creates exactly one (founding-partner)
 * firm_member -- so a bare firmOnTier() firm is, by construction, a
 * genuinely solo account. Individual-tier-fold (2026-08-09) means a solo
 * FREE firm now legitimately gets paid-feature access (see
 * requireFirmSessionAndPaidTier()'s own solo-free exception in index.ts,
 * and individual-tier-fold.spec.ts for that behavior's own dedicated
 * tests). Tests below whose actual intent is "prove the FREE TIER ITSELF
 * is blocked" (not "prove solo status matters") need a genuinely
 * multi-person firm to still exercise that path -- this adds the second
 * member. */
async function addSecondMember(firmId: string): Promise<void> {
  await store.createFirmMember(env.DB, {
    firmId,
    email: `mobility-second-${Date.now()}-${Math.floor(Math.random() * 1e6)}@examplefirm.com`,
    role: "staff",
    alreadyJoined: true,
  });
}

const VALID_CHECK = {
  home_state_slug: "california",
  target_state_slug: "texas",
  service_type: "tax",
  license_in_good_standing: true,
  substantially_equivalent: true,
};

describe("POST /firm/mobility/check -- free and unmetered for every firm (2026-08-10)", () => {
  it("requires a session", async () => {
    expect((await postMobilityCheck(VALID_CHECK, null)).status).toBe(401);
  });

  it("a brand-new free-tier MULTI-PERSON firm's check succeeds, no trial fields in the response", async () => {
    // 2026-08-10 (Devin, via orchestrator, ValueLab's finding): individual
    // PPC dropped its paid-tier gate AND roadmap #153's trial budget
    // entirely -- matching NASBA's own CPAmobility.org giving the
    // identical lookup away free/unlimited. Superseded #153's own "3
    // lifetime queries" mechanic for this route specifically (check-batch
    // below is UNCHANGED, still has its own trial gate).
    const { firmId, cookie } = await firmOnTier("free", new Date().toISOString());
    await addSecondMember(firmId);
    const resp = await postMobilityCheck(VALID_CHECK, cookie);
    expect(resp.status).toBe(200);
    const body = await resp.json<Record<string, unknown>>();
    expect(body.mobility_access_basis).toBeUndefined();
    expect(body.mobility_trial_queries_used).toBeUndefined();
    expect(body.mobility_trial_queries_limit).toBeUndefined();
  });

  it("a multi-person free-tier firm is NEVER blocked, even after many calls -- no lifetime cap anymore", async () => {
    const { firmId, cookie } = await firmOnTier("free", new Date().toISOString());
    await addSecondMember(firmId);
    for (const target of ["texas", "alabama", "kansas", "florida", "ohio"]) {
      expect((await postMobilityCheck({ ...VALID_CHECK, target_state_slug: target }, cookie)).status).toBe(200);
    }
  });

  it("check-batch keeps its OWN separate gate, untouched by the individual check's change -- still gets a multi-person free firm in via the trial basis, and stays unmetered (mobility_trial_uses never moves, matching its own docstring)", async () => {
    const { firmId, cookie } = await firmOnTier("free", new Date().toISOString());
    await addSecondMember(firmId);
    const resp = await postMobilityCheckBatch(VALID_BATCH_CHECK, cookie, "203.0.113.249");
    expect(resp.status).toBe(200);
    const firm = await env.DB.prepare("SELECT mobility_trial_uses FROM firms WHERE id = ?1").bind(firmId).first<{ mobility_trial_uses: number }>();
    expect(firm?.mobility_trial_uses).toBe(0);
  });

  it("ALLOWS a genuinely solo (1-member) free-tier firm", async () => {
    const { cookie } = await firmOnTier("free", new Date().toISOString());
    const resp = await postMobilityCheck(VALID_CHECK, cookie);
    expect(resp.status).toBe(200);
  });

  it("allows a paid tier regardless of account age", async () => {
    const { cookie } = await firmOnTier("firm", "2020-01-01T00:00:00Z");
    expect((await postMobilityCheck(VALID_CHECK, cookie)).status).toBe(200);
  });

  it("ALLOWS an unrecognised tier too -- there is no tier check left on this route at all", async () => {
    const { cookie } = await firmOnTier("enterprise_typo", new Date().toISOString());
    const resp = await postMobilityCheck(VALID_CHECK, cookie);
    expect(resp.status).toBe(200);
  });

  it("BLOCKS an inactive firm even on a paid tier", async () => {
    const { firmId, cookie } = await firmOnTier("firm", new Date().toISOString());
    await env.DB.prepare("UPDATE firms SET status = 'suspended' WHERE id = ?1").bind(firmId).run();
    const resp = await postMobilityCheck(VALID_CHECK, cookie);
    // requireFirmSession() blocks a suspended firm before
    // requireFirmSessionAndPaidTier()'s own checkPaidFeatureAccess() call
    // ever runs (AuditLab F-1, 2026-08-02) -- every firm route enforces
    // this at the one shared auth check. The response comes from
    // requireFirmSession() itself, not a JSON body with a `reason` field;
    // requireFirmSession()'s own test suite covers that response shape
    // directly.
    expect(resp.status).toBe(403);
    const body = await resp.text();
    expect(body).toContain("sort it out");
  });

  it("COVERAGE is unmetered/unlocked for a multi-person free firm too (roadmap #153, part of 'read-only Map')", async () => {
    const { firmId, cookie } = await firmOnTier("free", new Date().toISOString());
    await addSecondMember(firmId);
    const resp = await SELF.fetch("https://deadline-radar.com/firm/mobility/coverage", {
      headers: { Cookie: cookie, "cf-connecting-ip": "203.0.113.251" },
    });
    expect(resp.status).toBe(200);
  });
});

describe("POST /firm/mobility/check -- never asserts what it hasn't verified", () => {
  // Stale as of the 2026-08-02 mobility merge (55 real jurisdictions landed;
  // this dataset has not been empty since) and stale again as of the
  // 2026-08-03 flux-severity fix -- Texas's real record is `rule_in_flux`
  // with a `rule_changes_on` of 2025-09-01, so it went from not_verified to
  // a real "clear" the moment that fix shipped. Rewritten to assert the
  // CURRENT real shape end to end through the actual route, not a stale
  // "the data doesn't exist yet" placeholder.
  it("returns a real CLEAR verdict for a settled-flux real state, with the recent-change caveat and a disclaimer", async () => {
    const { cookie } = await firmOnTier("firm", new Date().toISOString());
    const resp = await postMobilityCheck(VALID_CHECK, cookie);
    expect(resp.status).toBe(200);
    const body = await resp.json<{
      overall: string;
      disclaimer: string;
      individual: { verdict: string; disclaimer: string; requirements: string[] };
      firm: { verdict: string };
    }>();
    expect(body.overall).toBe("clear");
    expect(body.individual.verdict).toBe("clear");
    expect(body.individual.requirements.join(" ")).toMatch(/changed on 2025-09-01/i);
    expect(body.disclaimer).toMatch(/not legal advice/i);
    expect(body.individual.disclaimer).toMatch(/not legal advice/i);
  });

  it("still returns not_verified with a disclaimer for a state genuinely absent from the dataset", async () => {
    const { cookie } = await firmOnTier("firm", new Date().toISOString());
    const resp = await postMobilityCheck({ ...VALID_CHECK, target_state_slug: "guam" }, cookie);
    expect(resp.status).toBe(200);
    const body = await resp.json<{ overall: string; disclaimer: string; individual: { verdict: string } }>();
    // Guam has no rule_changes_on and no citation in the shipped dataset --
    // stays fully unverified regardless of the flux-severity split.
    expect(body.overall).toBe("not_verified");
    expect(body.disclaimer).toMatch(/not legal advice/i);
  });

  it("rejects an unknown state slug as a 400, NOT as a silent 'not verified' that looks like a data gap", async () => {
    const { cookie } = await firmOnTier("firm", new Date().toISOString());
    for (const bad of [
      { ...VALID_CHECK, target_state_slug: "atlantis" },
      { ...VALID_CHECK, home_state_slug: "" },
      { ...VALID_CHECK, target_state_slug: "__proto__" },
    ]) {
      expect((await postMobilityCheck(bad, cookie)).status).toBe(400);
    }
  });

  it("rejects an invalid service type", async () => {
    const { cookie } = await firmOnTier("firm", new Date().toISOString());
    for (const st of ["", "audit", "ATTEST", "constructor"]) {
      const resp = await postMobilityCheck({ ...VALID_CHECK, service_type: st }, cookie);
      expect(resp.status).toBe(400);
    }
  });

  it("treats a missing attestation as FALSE rather than assuming good standing", async () => {
    const { cookie } = await firmOnTier("firm", new Date().toISOString());
    const resp = await postMobilityCheck(
      { ...VALID_CHECK, license_in_good_standing: undefined, substantially_equivalent: undefined },
      cookie
    );
    expect(resp.status).toBe(200);
    const body = await resp.json<{ individual: { verdict: string } }>();
    expect(body.individual.verdict).toBe("action_required");
  });
});

// 2026-08-03, dashboard Map redesign: one person against every covered
// target state in a single call, for the Map's per-staff reciprocity view.
async function postMobilityCheckBatch(
  body: Record<string, unknown>,
  cookie: string | null,
  ip = "203.0.113.252"
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json", "cf-connecting-ip": ip };
  if (cookie) headers["Cookie"] = cookie;
  return SELF.fetch("https://deadline-radar.com/firm/mobility/check-batch", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

const VALID_BATCH_CHECK = {
  home_state_slug: "california",
  service_type: "tax",
  license_in_good_standing: true,
  substantially_equivalent: true,
};

describe("POST /firm/mobility/check-batch -- same gate, same engine, no target list required", () => {
  it("requires a session", async () => {
    expect((await postMobilityCheckBatch(VALID_BATCH_CHECK, null)).status).toBe(401);
  });

  it("is unmetered/unlocked for a multi-person free firm (roadmap #153) -- assumed attestation, that's why it's not budgeted", async () => {
    const { firmId, cookie } = await firmOnTier("free", new Date().toISOString());
    await addSecondMember(firmId);
    const resp = await postMobilityCheckBatch(VALID_BATCH_CHECK, cookie);
    expect(resp.status).toBe(200);
    const body = await resp.json<{ results: unknown[] }>();
    expect(body.results.length).toBeGreaterThan(0);
  });

  it("rejects an unknown home state or invalid service type as a 400", async () => {
    const { cookie } = await firmOnTier("firm", new Date().toISOString());
    expect((await postMobilityCheckBatch({ ...VALID_BATCH_CHECK, home_state_slug: "atlantis" }, cookie)).status).toBe(400);
    expect((await postMobilityCheckBatch({ ...VALID_BATCH_CHECK, service_type: "audit" }, cookie)).status).toBe(400);
  });

  it("returns one result per covered target state, each carrying its own citation/disclaimer shape", async () => {
    const { cookie } = await firmOnTier("firm", new Date().toISOString());
    const resp = await postMobilityCheckBatch(VALID_BATCH_CHECK, cookie);
    expect(resp.status).toBe(200);
    const body = await resp.json<{
      results: Array<{ target_state_slug: string; target_state: string; overall: string }>;
      disclaimer: string;
    }>();
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.disclaimer).toMatch(/not legal advice/i);
    const slugs = body.results.map((r) => r.target_state_slug);
    expect(new Set(slugs).size).toBe(slugs.length); // no duplicate target states
    expect(slugs).toContain("alabama"); // known-covered state, per worker/src/mobility_rules.json
  });

  it("agrees EXACTLY with the single-check endpoint for the same (home, target) pair -- no second implementation to drift", async () => {
    const { cookie } = await firmOnTier("firm", new Date().toISOString());
    const single = await postMobilityCheck({ ...VALID_CHECK, home_state_slug: "california", target_state_slug: "alabama" }, cookie);
    const singleBody = await single.json<{ overall: string; individual: { verdict: string; summary: string } }>();

    const batch = await postMobilityCheckBatch({ ...VALID_BATCH_CHECK, home_state_slug: "california" }, cookie, "203.0.113.253");
    const batchBody = await batch.json<{
      results: Array<{ target_state_slug: string; overall: string; individual: { verdict: string; summary: string } }>;
    }>();
    const alabama = batchBody.results.find((r) => r.target_state_slug === "alabama");
    expect(alabama).toBeTruthy();
    expect(alabama!.overall).toBe(singleBody.overall);
    expect(alabama!.individual.verdict).toBe(singleBody.individual.verdict);
    expect(alabama!.individual.summary).toBe(singleBody.individual.summary);
  });

  // AuditLab MAP-1 (2026-08-07): scope-based mobility rate limiting (a
  // firm's own roster states are unmetered) moved to its own file
  // (map1-mobility-scope.spec.ts) -- running late inside this already
  // very large (300+ test) single file triggered a vitest-pool-workers
  // internal "Maximum call stack size exceeded" (inside the harness's own
  // test-internal.mjs, not this codebase) that did not reproduce in
  // isolation or in a smaller file. Splitting out matches this session's
  // own established practice for new feature test suites (firm-roles.spec.ts,
  // firm-members-crud.spec.ts).
});

// Roadmap #153's own "multi-person free-tier trial" describe block lived
// here -- removed 2026-08-10 along with the /check route's trial gate
// itself (see the describe block above). check-batch's OWN trial mechanism
// is untouched and covered there now too.
