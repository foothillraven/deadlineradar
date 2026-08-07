/**
 * AuditLab SEC-1 (2026-08-07, MEDIUM -> expanded to 7 endpoints): the new
 * /security/ page claims "Every write endpoint is rate-limited per
 * account," but 7 write endpoints had no checkRateLimit call at all --
 * handleDocumentDelete, handleFirmQuestionnaireSubmit/Dismiss,
 * handleOnboardingChecklistDismiss, handleProductTourDismiss,
 * handleFirmLogout, handleSubscriberLogout. This file proves each of the
 * 7 now actually enforces a limit, rather than just asserting the code
 * change looks right.
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

async function hammer(fn: () => Promise<Response>, tries: number): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    const resp = await fn();
    if (resp.status === 429) return true;
  }
  return false;
}

describe("SEC-1: previously-unlimited write endpoints now rate-limit", () => {
  it("POST /firm/questionnaire/dismiss", async () => {
    const { cookie } = await createFirmWithSession("SEC1 Q Dismiss Firm", `sec1-qd-${Date.now()}@example.com`);
    const hit429 = await hammer(
      () =>
        SELF.fetch(`${BASE}/firm/questionnaire/dismiss`, {
          method: "POST",
          headers: { Cookie: cookie, Origin: "https://deadline-radar.com", "cf-connecting-ip": "203.0.113.40" },
        }),
      35
    );
    expect(hit429).toBe(true);
  });

  it("POST /firm/onboarding-checklist/dismiss", async () => {
    const { cookie } = await createFirmWithSession("SEC1 Onboarding Firm", `sec1-onb-${Date.now()}@example.com`);
    const hit429 = await hammer(
      () =>
        SELF.fetch(`${BASE}/firm/onboarding-checklist/dismiss`, {
          method: "POST",
          headers: { Cookie: cookie, Origin: "https://deadline-radar.com", "cf-connecting-ip": "203.0.113.41" },
        }),
      35
    );
    expect(hit429).toBe(true);
  });

  it("POST /firm/product-tour/dismiss", async () => {
    const { cookie } = await createFirmWithSession("SEC1 Tour Firm", `sec1-tour-${Date.now()}@example.com`);
    const hit429 = await hammer(
      () =>
        SELF.fetch(`${BASE}/firm/product-tour/dismiss`, {
          method: "POST",
          headers: { Cookie: cookie, Origin: "https://deadline-radar.com", "cf-connecting-ip": "203.0.113.42" },
        }),
      35
    );
    expect(hit429).toBe(true);
  });

  it("POST /firm/questionnaire (submit)", async () => {
    const { cookie } = await createFirmWithSession("SEC1 Q Submit Firm", `sec1-qs-${Date.now()}@example.com`);
    const hit429 = await hammer(
      () =>
        SELF.fetch(`${BASE}/firm/questionnaire`, {
          method: "POST",
          headers: { "content-type": "application/json", Cookie: cookie, Origin: "https://deadline-radar.com", "cf-connecting-ip": "203.0.113.43" },
          body: JSON.stringify({ selected_features: [] }),
        }),
      35
    );
    expect(hit429).toBe(true);
  });

  it("DELETE /firm/documents/:id (nonexistent id still consumes the bucket)", async () => {
    const { cookie } = await createFirmWithSession("SEC1 Doc Firm", `sec1-doc-${Date.now()}@example.com`);
    const hit429 = await hammer(
      () =>
        SELF.fetch(`${BASE}/firm/documents/does-not-exist`, {
          method: "DELETE",
          headers: { Cookie: cookie, Origin: "https://deadline-radar.com", "cf-connecting-ip": "203.0.113.44" },
        }),
      35
    );
    expect(hit429).toBe(true);
  }, 20000);

  // handleFirmLogout/handleSubscriberLogout deliberately ALWAYS return 302 +
  // a cookie-clear header, rate-limited or not -- "logout always succeeds
  // from the caller's perspective" is pre-existing, intentional design
  // (see the docstring on each), and the client-side cookie clear is
  // harmless to always do. What SEC-1's fix actually bounds is the SERVER-
  // SIDE row deletion, so the real assertion is "a fresh session's row
  // stops getting deleted once the IP has exceeded the bucket," not a
  // status code -- proven by minting a brand-new session before each call
  // (so there's always something real to delete) and checking the last one
  // survives.
  it("/firm/logout: IP-keyed bucket eventually stops deleting fresh sessions", async () => {
    const { id: firmId } = await store.createFirm(env.DB, { name: "SEC1 Logout Firm", adminEmail: `sec1-logout-${Date.now()}@example.com` });
    let lastRawToken = "";
    for (let i = 0; i < 35; i++) {
      const { rawSessionToken } = await store.createSession(env.DB, firmId);
      lastRawToken = rawSessionToken;
      await SELF.fetch(`${BASE}/firm/logout`, {
        method: "POST",
        headers: { Cookie: `dr_firm_session=${rawSessionToken}`, "cf-connecting-ip": "203.0.113.45" },
      });
    }
    const stillLive = await store.verifySession(env.DB, lastRawToken);
    expect(stillLive, "expected the bucket to have blocked the row deletion by the 35th attempt -- it didn't").not.toBeNull();
  }, 20000);

  it("/subscriber/logout: IP-keyed bucket eventually stops deleting fresh sessions", async () => {
    const email = `sec1-sublogout-${Date.now()}@example.com`;
    let lastRawToken = "";
    for (let i = 0; i < 35; i++) {
      const { rawSessionToken } = await store.createSubscriberSession(env.DB, email);
      lastRawToken = rawSessionToken;
      await SELF.fetch(`${BASE}/subscriber/logout`, {
        method: "POST",
        headers: { Cookie: `dr_sub_session=${rawSessionToken}`, "cf-connecting-ip": "203.0.113.46" },
      });
    }
    const stillLive = await store.verifySubscriberSession(env.DB, lastRawToken);
    expect(stillLive, "expected the bucket to have blocked the row deletion by the 35th attempt -- it didn't").not.toBeNull();
  }, 20000);

  it("a legitimate single dismiss still succeeds (the fix didn't break normal use)", async () => {
    const { firmId, cookie } = await createFirmWithSession("SEC1 Normal Firm", `sec1-normal-${Date.now()}@example.com`);
    const resp = await SELF.fetch(`${BASE}/firm/product-tour/dismiss`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: "https://deadline-radar.com", "cf-connecting-ip": "203.0.113.47" },
    });
    expect(resp.status).toBe(200);
    const firm = await store.getFirmById(env.DB, firmId);
    expect(firm?.product_tour_dismissed_at).not.toBeNull();
  });
});
