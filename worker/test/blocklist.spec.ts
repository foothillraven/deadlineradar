/**
 * Task #7 (2026-08-06): operator-managed email/domain blocklist. Covers
 * store.isEmailBlocklisted() directly plus its three call sites (public
 * /subscribe, /firm/signup, and authenticated firm staff-roster adds).
 */
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as store from "../src/store";

function form(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

async function postSubscribe(fields: Record<string, string>, ip = "203.0.113.50"): Promise<Response> {
  return SELF.fetch("https://deadline-radar.com/subscribe", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": ip },
    body: form({ hp_website: "", ...fields }),
  });
}

async function postFirmSignup(fields: Record<string, string>, ip = "203.0.113.51"): Promise<Response> {
  return SELF.fetch("https://deadline-radar.com/firm/signup", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": ip },
    body: form({ hp_website: "", ...fields }),
  });
}

async function createFirmWithSession(name: string, adminEmail: string): Promise<{ firmId: string; cookie: string }> {
  const firm = await store.createFirm(env.DB, { name, adminEmail });
  const { rawSessionToken } = await store.createSession(env.DB, firm.id);
  return { firmId: firm.id, cookie: `dr_firm_session=${rawSessionToken}` };
}

async function postFirmLicense(cookie: string, body: Record<string, string>): Promise<Response> {
  return SELF.fetch("https://deadline-radar.com/firm/licenses", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.52", Cookie: cookie },
    body: JSON.stringify(body),
  });
}

async function addBlocklistEntry(pattern: string, patternType: "email" | "domain"): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO signup_blocklist (id, pattern, pattern_type, note, created_at) VALUES (?1,?2,?3,?4,?5)`
  )
    .bind(crypto.randomUUID(), pattern, patternType, "test", new Date().toISOString())
    .run();
}

describe("store.isEmailBlocklisted", () => {
  it("matches an exact blocked email (case-insensitively)", async () => {
    const email = `exact-${Date.now()}@blocked-example.com`;
    await addBlocklistEntry(email.toLowerCase(), "email");
    expect(await store.isEmailBlocklisted(env.DB, email.toUpperCase())).toBe(true);
  });

  it("matches a blocked domain, and a real subdomain of it, but not an unrelated address", async () => {
    const domain = `abuse-${Date.now()}.example.com`;
    await addBlocklistEntry(domain, "domain");
    expect(await store.isEmailBlocklisted(env.DB, `person@${domain}`)).toBe(true);
    expect(await store.isEmailBlocklisted(env.DB, `person@mail.${domain}`)).toBe(true);
    expect(await store.isEmailBlocklisted(env.DB, `person@not-${domain}`)).toBe(false);
    expect(await store.isEmailBlocklisted(env.DB, `person@totally-unrelated.example`)).toBe(false);
  });

  it("returns false for an address with no blocklist entries", async () => {
    expect(await store.isEmailBlocklisted(env.DB, `clean-${Date.now()}@example.com`)).toBe(false);
  });
});

describe("blocklist enforcement across the three signup paths", () => {
  it("blocks POST /subscribe for a blocklisted exact email", async () => {
    const email = `sub-blocked-${Date.now()}@example.com`;
    await addBlocklistEntry(email, "email");
    const resp = await postSubscribe({ email, state: "georgia", license_type_id: "ga-individual" });
    expect(resp.status).toBe(400);
    const row = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?1").bind(email).first();
    expect(row).toBeNull();
  });

  it("blocks POST /subscribe for an address on a blocklisted domain", async () => {
    const domain = `sub-domain-${Date.now()}.example.com`;
    await addBlocklistEntry(domain, "domain");
    const resp = await postSubscribe({ email: `anyone@${domain}`, state: "georgia", license_type_id: "ga-individual" });
    expect(resp.status).toBe(400);
  });

  it("blocks POST /firm/signup for a blocklisted admin email", async () => {
    const email = `firmsignup-blocked-${Date.now()}@example.com`;
    await addBlocklistEntry(email, "email");
    const resp = await postFirmSignup({ admin_email: email, name: "Blocked Firm LLC" });
    expect(resp.status).toBe(400);
    const row = await env.DB.prepare("SELECT * FROM firms WHERE admin_email = ?1").bind(email).first();
    expect(row).toBeNull();
  });

  it("blocks a firm admin adding a blocklisted address to their own staff roster", async () => {
    const staffEmail = `staff-blocked-${Date.now()}@example.com`;
    await addBlocklistEntry(staffEmail, "email");
    const { cookie } = await createFirmWithSession("Roster Block Test LLC", `owner-${Date.now()}@example.com`);
    const resp = await postFirmLicense(cookie, {
      staff_label: "Blocked Staffer",
      email: staffEmail,
      state_slug: "georgia",
      license_type_id: "ga-individual",
    });
    expect(resp.status).toBe(400);
  });

  it("does not block an address that has no blocklist entry", async () => {
    const resp = await postSubscribe({
      email: `unblocked-${Date.now()}@example.com`,
      state: "georgia",
      license_type_id: "ga-individual",
    });
    expect(resp.status).toBe(200);
  });
});
