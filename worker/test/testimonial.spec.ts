/**
 * Post-renewal review/testimonial capture (2026-08-07, roadmap #312,
 * migration 0043). Chained client-side off a promoter-tier NPS score, but
 * the endpoint itself doesn't re-check that server-side (no abuse vector in
 * submitting a private quote) -- see handleTestimonialSubmit()'s own
 * docstring. Never auto-published.
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

async function postTestimonial(cookie: string, quoteText: unknown, canPublish?: unknown, origin = "https://deadline-radar.com"): Promise<Response> {
  return SELF.fetch(`${BASE}/firm/testimonial`, {
    method: "POST",
    headers: { "content-type": "application/json", Cookie: cookie, Origin: origin, "cf-connecting-ip": "203.0.113.30" },
    body: JSON.stringify({ quote_text: quoteText, can_publish: canPublish }),
  });
}

describe("POST /firm/testimonial", () => {
  it("requires a session", async () => {
    expect((await postTestimonial("", "Great product")).status).toBe(401);
  });

  it("records a quote with can_publish true", async () => {
    const { firmId, cookie } = await createFirmWithSession("Testimonial Firm", `testimonial-${Date.now()}@example.com`);
    const resp = await postTestimonial(cookie, "DeadlineRadar saved us from a missed renewal.", true);
    expect(resp.status).toBe(200);
    const row = await env.DB
      .prepare(`SELECT quote_text, can_publish FROM firm_testimonials WHERE firm_id = ?1`)
      .bind(firmId)
      .first<{ quote_text: string; can_publish: number }>();
    expect(row?.quote_text).toBe("DeadlineRadar saved us from a missed renewal.");
    expect(row?.can_publish).toBe(1);
  });

  it("defaults can_publish to false when omitted or not literally true", async () => {
    const { firmId, cookie } = await createFirmWithSession("Testimonial No-Publish Firm", `testimonial-nopub-${Date.now()}@example.com`);
    await postTestimonial(cookie, "Nice tool, keep it private though.");
    const row = await env.DB
      .prepare(`SELECT can_publish FROM firm_testimonials WHERE firm_id = ?1`)
      .bind(firmId)
      .first<{ can_publish: number }>();
    expect(row?.can_publish).toBe(0);
  });

  it("rejects an empty quote", async () => {
    const { cookie } = await createFirmWithSession("Testimonial Empty Firm", `testimonial-empty-${Date.now()}@example.com`);
    expect((await postTestimonial(cookie, "")).status).toBe(400);
    expect((await postTestimonial(cookie, "   ")).status).toBe(400);
  });

  it("rejects a missing quote field", async () => {
    const { cookie } = await createFirmWithSession("Testimonial Missing Firm", `testimonial-missing-${Date.now()}@example.com`);
    expect((await postTestimonial(cookie, undefined)).status).toBe(400);
  });

  it("truncates a quote longer than the length cap rather than rejecting it", async () => {
    const { firmId, cookie } = await createFirmWithSession("Testimonial Long Firm", `testimonial-long-${Date.now()}@example.com`);
    const longQuote = "x".repeat(700);
    const resp = await postTestimonial(cookie, longQuote, true);
    expect(resp.status).toBe(200);
    const row = await env.DB
      .prepare(`SELECT quote_text FROM firm_testimonials WHERE firm_id = ?1`)
      .bind(firmId)
      .first<{ quote_text: string }>();
    expect(row?.quote_text).toHaveLength(500);
  });

  it("allows multiple submissions from the same firm over time (history, not overwrite)", async () => {
    const { firmId, cookie } = await createFirmWithSession("Testimonial Multi Firm", `testimonial-multi-${Date.now()}@example.com`);
    await postTestimonial(cookie, "First quote", true);
    await postTestimonial(cookie, "Second quote", false);
    const row = await env.DB
      .prepare(`SELECT COUNT(*) as c FROM firm_testimonials WHERE firm_id = ?1`)
      .bind(firmId)
      .first<{ c: number }>();
    expect(row?.c).toBe(2);
  });

  it("is rejected when Origin doesn't match (CSRF defense-in-depth)", async () => {
    const { firmId, cookie } = await createFirmWithSession("Testimonial CSRF Firm", `testimonial-csrf-${Date.now()}@example.com`);
    const resp = await postTestimonial(cookie, "Should not land", true, "https://attacker.example");
    expect(resp.status).toBe(400);
    const row = await env.DB
      .prepare(`SELECT COUNT(*) as c FROM firm_testimonials WHERE firm_id = ?1`)
      .bind(firmId)
      .first<{ c: number }>();
    expect(row?.c).toBe(0);
  });

  it("DELETE /firm/testimonial doesn't exist (POST only, no accidental method confusion)", async () => {
    const { cookie } = await createFirmWithSession("Testimonial Method Firm", `testimonial-method-${Date.now()}@example.com`);
    const resp = await SELF.fetch(`${BASE}/firm/testimonial`, { method: "DELETE", headers: { Cookie: cookie, "cf-connecting-ip": "203.0.113.31" } });
    expect(resp.status).toBe(404);
  });
});
