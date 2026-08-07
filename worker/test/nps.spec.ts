/**
 * NPS/CSAT micro-survey (2026-08-07, roadmap #144, migration 0042). One
 * score 0-10, fired after "Mark renewed" or quarterly, never more than
 * once per store.NPS_PROMPT_COOLDOWN_DAYS regardless of answer/dismiss.
 */
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as store from "../src/store";

const BASE = "https://deadline-radar.com";

async function createFirmWithSession(name: string, adminEmail: string): Promise<{ firmId: string; cookie: string }> {
  const firm = await store.createFirm(env.DB, { name, adminEmail });
  const { rawSessionToken } = await store.createSession(env.DB, firm.id);
  return { firmId: firm.id, cookie: `dr_firm_session=${rawSessionToken}` };
}

async function getLicenses(cookie: string): Promise<Response> {
  return SELF.fetch(`${BASE}/firm/licenses`, { headers: { Cookie: cookie, "cf-connecting-ip": "203.0.113.20" } });
}

describe("store.shouldPromptNps", () => {
  it("is true for a firm never prompted", () => {
    expect(store.shouldPromptNps({ nps_last_prompted_at: null })).toBe(true);
  });

  it("is false right after a prompt was shown", () => {
    const now = new Date("2026-08-07T00:00:00Z");
    expect(store.shouldPromptNps({ nps_last_prompted_at: now.toISOString() }, now)).toBe(false);
  });

  it("is true again once the cooldown has fully elapsed", () => {
    const shownAt = new Date("2026-05-01T00:00:00Z");
    const later = new Date(shownAt.getTime() + (store.NPS_PROMPT_COOLDOWN_DAYS + 1) * 86_400_000);
    expect(store.shouldPromptNps({ nps_last_prompted_at: shownAt.toISOString() }, later)).toBe(true);
  });

  it("is still false just short of the cooldown", () => {
    const shownAt = new Date("2026-05-01T00:00:00Z");
    const almost = new Date(shownAt.getTime() + (store.NPS_PROMPT_COOLDOWN_DAYS - 1) * 86_400_000);
    expect(store.shouldPromptNps({ nps_last_prompted_at: shownAt.toISOString() }, almost)).toBe(false);
  });
});

describe("GET /firm/licenses -- nps_prompt_due", () => {
  it("is true for a brand-new firm", async () => {
    const { cookie } = await createFirmWithSession("NPS New Firm", `nps-new-${Date.now()}@example.com`);
    const body = (await (await getLicenses(cookie)).json()) as { nps_prompt_due: boolean };
    expect(body.nps_prompt_due).toBe(true);
  });

  it("is false immediately after a response is recorded", async () => {
    const { firmId, cookie } = await createFirmWithSession("NPS Answered Firm", `nps-answered-${Date.now()}@example.com`);
    await store.recordNpsResponse(env.DB, firmId, 9);
    const body = (await (await getLicenses(cookie)).json()) as { nps_prompt_due: boolean };
    expect(body.nps_prompt_due).toBe(false);
  });

  it("is false immediately after a dismissal, same as an answer", async () => {
    const { firmId, cookie } = await createFirmWithSession("NPS Dismissed Firm", `nps-dismissed-${Date.now()}@example.com`);
    await store.recordNpsPromptDismissed(env.DB, firmId);
    const body = (await (await getLicenses(cookie)).json()) as { nps_prompt_due: boolean };
    expect(body.nps_prompt_due).toBe(false);
  });

  it("is false for a demo-locked firm even when never prompted (caught live: demo visitors would pollute real NPS data)", async () => {
    const { firmId, cookie } = await createFirmWithSession("NPS Demo Firm", `nps-demo-${Date.now()}@example.com`);
    await env.DB.prepare(`UPDATE firms SET demo_locked = 1 WHERE id = ?1`).bind(firmId).run();
    const body = (await (await getLicenses(cookie)).json()) as { nps_prompt_due: boolean };
    expect(body.nps_prompt_due).toBe(false);
  });
});

describe("POST /firm/nps", () => {
  async function postNps(cookie: string, score: unknown, origin = "https://deadline-radar.com"): Promise<Response> {
    return SELF.fetch(`${BASE}/firm/nps`, {
      method: "POST",
      headers: { "content-type": "application/json", Cookie: cookie, Origin: origin, "cf-connecting-ip": "203.0.113.21" },
      body: JSON.stringify({ score }),
    });
  }

  it("requires a session", async () => {
    expect((await postNps("", 9)).status).toBe(401);
  });

  it("accepts a valid score and records it", async () => {
    const { firmId, cookie } = await createFirmWithSession("NPS Valid Firm", `nps-valid-${Date.now()}@example.com`);
    const resp = await postNps(cookie, 8);
    expect(resp.status).toBe(200);
    const row = await env.DB.prepare(`SELECT score FROM firm_nps_responses WHERE firm_id = ?1`).bind(firmId).first<{ score: number }>();
    expect(row?.score).toBe(8);
  });

  it("accepts the boundary values 0 and 10", async () => {
    const { cookie: cookie0 } = await createFirmWithSession("NPS Zero Firm", `nps-zero-${Date.now()}@example.com`);
    expect((await postNps(cookie0, 0)).status).toBe(200);
    const { cookie: cookie10 } = await createFirmWithSession("NPS Ten Firm", `nps-ten-${Date.now()}@example.com`);
    expect((await postNps(cookie10, 10)).status).toBe(200);
  });

  it("rejects an out-of-range score", async () => {
    const { cookie } = await createFirmWithSession("NPS OOR Firm", `nps-oor-${Date.now()}@example.com`);
    expect((await postNps(cookie, 11)).status).toBe(400);
    expect((await postNps(cookie, -1)).status).toBe(400);
  });

  it("rejects a non-integer score", async () => {
    const { cookie } = await createFirmWithSession("NPS Float Firm", `nps-float-${Date.now()}@example.com`);
    expect((await postNps(cookie, 7.5)).status).toBe(400);
  });

  it("rejects a missing/non-numeric score", async () => {
    const { cookie } = await createFirmWithSession("NPS Missing Firm", `nps-missing-${Date.now()}@example.com`);
    expect((await postNps(cookie, "nine")).status).toBe(400);
    expect((await postNps(cookie, undefined)).status).toBe(400);
  });

  it("is rejected when Origin doesn't match (CSRF defense-in-depth)", async () => {
    const { firmId, cookie } = await createFirmWithSession("NPS CSRF Firm", `nps-csrf-${Date.now()}@example.com`);
    const resp = await postNps(cookie, 5, "https://attacker.example");
    expect(resp.status).toBe(400);
    const row = await env.DB.prepare(`SELECT COUNT(*) as c FROM firm_nps_responses WHERE firm_id = ?1`).bind(firmId).first<{ c: number }>();
    expect(row?.c).toBe(0);
  });
});

describe("POST /firm/nps/dismiss", () => {
  it("requires a session", async () => {
    const resp = await SELF.fetch(`${BASE}/firm/nps/dismiss`, { method: "POST", headers: { "cf-connecting-ip": "203.0.113.22" } });
    expect(resp.status).toBe(401);
  });

  it("resets the prompt cooldown without recording a score", async () => {
    const { firmId, cookie } = await createFirmWithSession("NPS Dismiss Firm", `nps-dismiss-${Date.now()}@example.com`);
    const resp = await SELF.fetch(`${BASE}/firm/nps/dismiss`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: "https://deadline-radar.com", "cf-connecting-ip": "203.0.113.23" },
    });
    expect(resp.status).toBe(200);
    const firm = await store.getFirmById(env.DB, firmId);
    expect(firm?.nps_last_prompted_at).not.toBeNull();
    const row = await env.DB.prepare(`SELECT COUNT(*) as c FROM firm_nps_responses WHERE firm_id = ?1`).bind(firmId).first<{ c: number }>();
    expect(row?.c).toBe(0);
  });
});
