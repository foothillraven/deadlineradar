/**
 * AuditLab DEMO-3 (LOW, 2026-08-06): one demo visitor's dismiss/submit must
 * never persist to the SHARED demo firm's row. All four onboarding-prompt
 * endpoints (questionnaire submit/dismiss, checklist dismiss, tour dismiss)
 * plus the same-class NPS/testimonial endpoints (2026-08-07) now return
 * ok:true WITHOUT writing for a demo_locked firm -- the visitor's own modal
 * closes normally, the shared state never changes, and no fake
 * feedback/testimonial data is recorded.
 */
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as store from "../src/store";

const BASE = "https://deadline-radar.com";

async function createDemoFirmWithSession(name: string, adminEmail: string): Promise<{ firmId: string; cookie: string }> {
  const firm = await store.createFirm(env.DB, { name, adminEmail });
  await env.DB.prepare(`UPDATE firms SET demo_locked = 1 WHERE id = ?1`).bind(firm.id).run();
  const { rawSessionToken } = await store.createSession(env.DB, firm.id);
  return { firmId: firm.id, cookie: `dr_firm_session=${rawSessionToken}` };
}

function post(path: string, cookie: string, body?: unknown): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Cookie: cookie,
      Origin: "https://deadline-radar.com",
      "cf-connecting-ip": "203.0.113.60",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("DEMO-3: onboarding/feedback writes are silent no-ops on a demo-locked firm", () => {
  it("questionnaire dismiss returns ok but never persists", async () => {
    const { firmId, cookie } = await createDemoFirmWithSession("Demo QD Firm", `demo-qd-${Date.now()}@example.com`);
    expect((await post("/firm/questionnaire/dismiss", cookie)).status).toBe(200);
    const firm = await store.getFirmById(env.DB, firmId);
    expect(firm?.feature_questionnaire_dismissed_at).toBeNull();
  });

  it("questionnaire submit returns ok but never persists", async () => {
    const { firmId, cookie } = await createDemoFirmWithSession("Demo QS Firm", `demo-qs-${Date.now()}@example.com`);
    expect((await post("/firm/questionnaire", cookie, { selected_features: ["API access"] })).status).toBe(200);
    const firm = await store.getFirmById(env.DB, firmId);
    expect(firm?.feature_questionnaire_dismissed_at).toBeNull();
  });

  it("onboarding-checklist dismiss returns ok but never persists", async () => {
    const { firmId, cookie } = await createDemoFirmWithSession("Demo OC Firm", `demo-oc-${Date.now()}@example.com`);
    expect((await post("/firm/onboarding-checklist/dismiss", cookie)).status).toBe(200);
    const firm = await store.getFirmById(env.DB, firmId);
    expect(firm?.onboarding_checklist_dismissed_at).toBeNull();
  });

  it("product-tour dismiss returns ok but never persists", async () => {
    const { firmId, cookie } = await createDemoFirmWithSession("Demo PT Firm", `demo-pt-${Date.now()}@example.com`);
    expect((await post("/firm/product-tour/dismiss", cookie)).status).toBe(200);
    const firm = await store.getFirmById(env.DB, firmId);
    expect(firm?.product_tour_dismissed_at).toBeNull();
  });

  it("NPS response returns ok but records nothing (score AND cooldown untouched)", async () => {
    const { firmId, cookie } = await createDemoFirmWithSession("Demo NPS Firm", `demo-nps-${Date.now()}@example.com`);
    expect((await post("/firm/nps", cookie, { score: 10 })).status).toBe(200);
    const row = await env.DB.prepare(`SELECT COUNT(*) as c FROM firm_nps_responses WHERE firm_id = ?1`).bind(firmId).first<{ c: number }>();
    expect(row?.c).toBe(0);
    const firm = await store.getFirmById(env.DB, firmId);
    expect(firm?.nps_last_prompted_at).toBeNull();
  });

  it("NPS dismiss returns ok but the cooldown is untouched", async () => {
    const { firmId, cookie } = await createDemoFirmWithSession("Demo NPSD Firm", `demo-npsd-${Date.now()}@example.com`);
    expect((await post("/firm/nps/dismiss", cookie)).status).toBe(200);
    const firm = await store.getFirmById(env.DB, firmId);
    expect(firm?.nps_last_prompted_at).toBeNull();
  });

  it("testimonial submit returns ok but records nothing", async () => {
    const { firmId, cookie } = await createDemoFirmWithSession("Demo Testi Firm", `demo-testi-${Date.now()}@example.com`);
    expect((await post("/firm/testimonial", cookie, { quote_text: "Fake demo quote", can_publish: true })).status).toBe(200);
    const row = await env.DB.prepare(`SELECT COUNT(*) as c FROM firm_testimonials WHERE firm_id = ?1`).bind(firmId).first<{ c: number }>();
    expect(row?.c).toBe(0);
  });

  it("a NON-demo firm's dismiss still persists normally (the gate didn't overreach)", async () => {
    const firm = await store.createFirm(env.DB, { name: "Real Firm", adminEmail: `real-${Date.now()}@example.com` });
    const { rawSessionToken } = await store.createSession(env.DB, firm.id);
    const cookie = `dr_firm_session=${rawSessionToken}`;
    expect((await post("/firm/product-tour/dismiss", cookie)).status).toBe(200);
    const after = await store.getFirmById(env.DB, firm.id);
    expect(after?.product_tour_dismissed_at).not.toBeNull();
  });
});
