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

// Roadmap #151 (2026-08-10): backdated so the DELETE /firm/documents/:id
// rate-limit test below still reaches that handler's actual code (past the
// new value-line gate) rather than getting redirected into testing the gate
// instead of the rate limit -- this file's own tests are about rate-limit
// enforcement, not entitlement.
async function createFirmWithSession(name: string, adminEmail: string): Promise<{ firmId: string; cookie: string }> {
  const firm = await store.createFirm(env.DB, { name, adminEmail });
  await env.DB.prepare("UPDATE firms SET created_at = '2020-01-01T00:00:00Z' WHERE id = ?1").bind(firm.id).run();
  const { rawSessionToken } = await store.createSession(env.DB, firm.id);
  return { firmId: firm.id, cookie: `dr_firm_session=${rawSessionToken}` };
}

// 2026-08-07 flake fix (observed same-day, under full-parallel suite runs
// only): the first version asserted "a 429 appears within 35 tries" -- but
// under whole-suite contention an individual request can fail with a D1
// subrequest error, which the route wrapper converts to a 400 that never
// consumes the bucket, so 35 tries could complete without EITHER 30
// successes or a 429. The real security invariant is stronger and
// contention-immune: the number of SUCCESSFUL (2xx) writes can never
// exceed the bucket's max, no matter how many attempts are made. Interleaved
// transient 400s can't break that assertion; a genuinely missing rate limit
// still fails it loudly (40 attempts -> 40 successes > 30).
const DISMISS_BUCKET_MAX = 30; // RATE_LIMIT_FIRM_DISMISS.max
async function hammerAndCountSuccesses(fn: () => Promise<Response>, tries: number): Promise<number> {
  let successes = 0;
  for (let i = 0; i < tries; i++) {
    const resp = await fn();
    if (resp.ok) successes++;
  }
  return successes;
}

describe("SEC-1: previously-unlimited write endpoints now rate-limit", () => {
  it("POST /firm/questionnaire/dismiss", async () => {
    const { cookie } = await createFirmWithSession("SEC1 Q Dismiss Firm", `sec1-qd-${Date.now()}@example.com`);
    const successes = await hammerAndCountSuccesses(
      () =>
        SELF.fetch(`${BASE}/firm/questionnaire/dismiss`, {
          method: "POST",
          headers: { Cookie: cookie, Origin: "https://deadline-radar.com", "cf-connecting-ip": "203.0.113.40" },
        }),
      40
    );
    expect(successes).toBeLessThanOrEqual(DISMISS_BUCKET_MAX);
  }, 20000);

  it("POST /firm/onboarding-checklist/dismiss", async () => {
    const { cookie } = await createFirmWithSession("SEC1 Onboarding Firm", `sec1-onb-${Date.now()}@example.com`);
    const successes = await hammerAndCountSuccesses(
      () =>
        SELF.fetch(`${BASE}/firm/onboarding-checklist/dismiss`, {
          method: "POST",
          headers: { Cookie: cookie, Origin: "https://deadline-radar.com", "cf-connecting-ip": "203.0.113.41" },
        }),
      40
    );
    expect(successes).toBeLessThanOrEqual(DISMISS_BUCKET_MAX);
  }, 20000);

  it("POST /firm/product-tour/dismiss", async () => {
    const { cookie } = await createFirmWithSession("SEC1 Tour Firm", `sec1-tour-${Date.now()}@example.com`);
    const successes = await hammerAndCountSuccesses(
      () =>
        SELF.fetch(`${BASE}/firm/product-tour/dismiss`, {
          method: "POST",
          headers: { Cookie: cookie, Origin: "https://deadline-radar.com", "cf-connecting-ip": "203.0.113.42" },
        }),
      40
    );
    expect(successes).toBeLessThanOrEqual(DISMISS_BUCKET_MAX);
  }, 20000);

  it("POST /firm/questionnaire (submit)", async () => {
    const { cookie } = await createFirmWithSession("SEC1 Q Submit Firm", `sec1-qs-${Date.now()}@example.com`);
    const successes = await hammerAndCountSuccesses(
      () =>
        SELF.fetch(`${BASE}/firm/questionnaire`, {
          method: "POST",
          headers: { "content-type": "application/json", Cookie: cookie, Origin: "https://deadline-radar.com", "cf-connecting-ip": "203.0.113.43" },
          body: JSON.stringify({ selected_features: [] }),
        }),
      40
    );
    expect(successes).toBeLessThanOrEqual(DISMISS_BUCKET_MAX);
  }, 20000);

  it("DELETE /firm/documents/:id -- a nonexistent id still consumes the bucket", async () => {
    const { cookie } = await createFirmWithSession("SEC1 Doc Firm", `sec1-doc-${Date.now()}@example.com`);
    // This endpoint 404s (not 2xx) on the nonexistent id -- a 404 means the
    // request got PAST the rate limit (and consumed the bucket), so 404s
    // are this test's "successes". Transient contention 400s neither
    // consume nor count, exactly like the 2xx-counting tests above.
    let past = 0;
    for (let i = 0; i < 40; i++) {
      const resp = await SELF.fetch(`${BASE}/firm/documents/does-not-exist`, {
        method: "DELETE",
        headers: { Cookie: cookie, Origin: "https://deadline-radar.com", "cf-connecting-ip": "203.0.113.44" },
      });
      if (resp.status === 404) past++;
    }
    expect(past).toBeLessThanOrEqual(DISMISS_BUCKET_MAX);
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
