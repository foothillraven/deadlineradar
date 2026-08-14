/**
 * Paid-tiers + Stripe billing (2026-08-05; entitlement model rewritten
 * 2026-08-06 -- see entitlements.ts's own docstring). Two things this file
 * proves, per the paid-tiers plan's own verification section:
 *   1. POST /firm/billing/checkout rejects a tier smaller than the firm's
 *      live roster, and (with Stripe mocked) creates a real Checkout
 *      Session with the right metadata.
 *   2. POST /stripe/webhook verifies signatures, is idempotent on a
 *      redelivered event.id, and each of the three v1 event branches
 *      (checkout.session.completed / customer.subscription.deleted /
 *      invoice.payment_failed) does what it's supposed to.
 *
 * Stripe's own network calls are never made from tests -- `globalThis.fetch`
 * is mocked for the checkout-happy-path test, same `vi.spyOn` pattern
 * email-allowlist.spec.ts already uses for SendGrid. Webhook tests construct
 * their own valid signature independently (see signPayload() below, same
 * approach as stripe.spec.ts) rather than calling verifyWebhookSignature()
 * to sign its own test data.
 */
import { env, SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import * as store from "../src/store";
import type { FirmRow } from "../src/store";

function testExecutionContext(): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
}

async function workerFetch(request: Request, envOverrides: Record<string, unknown> = {}): Promise<Response> {
  const worker = (await import("../src/index")).default;
  return worker.fetch(request, { ...env, ...envOverrides } as never, testExecutionContext());
}

async function createFirmWithSession(name: string, adminEmail: string): Promise<{ firmId: string; cookie: string }> {
  const firm = await store.createFirm(env.DB, { name, adminEmail });
  const { rawSessionToken } = await store.createSession(env.DB, firm.id);
  return { firmId: firm.id, cookie: `dr_firm_session=${rawSessionToken}` };
}

async function setFirmTierAndAge(firmId: string, planTier: string, createdAt: string, status = "active"): Promise<void> {
  await env.DB.prepare("UPDATE firms SET plan_tier = ?1, created_at = ?2, status = ?3 WHERE id = ?4")
    .bind(planTier, createdAt, status, firmId)
    .run();
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

async function getFirmLicenses(cookie: string): Promise<Response> {
  return SELF.fetch("https://deadline-radar.com/firm/licenses", { headers: { Cookie: cookie } });
}

async function postFirmLicense(cookie: string, body: Record<string, string>): Promise<Response> {
  return SELF.fetch("https://deadline-radar.com/firm/licenses", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.200", Cookie: cookie },
    body: JSON.stringify(body),
  });
}

async function getFirmCpe(cookie: string): Promise<Response> {
  return SELF.fetch("https://deadline-radar.com/firm/cpe", { headers: { Cookie: cookie } });
}

async function signPayload(secret: string, timestampSeconds: number, payload: string): Promise<string> {
  const signedPayload = `${timestampSeconds}.${payload}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload));
  const hex = [...new Uint8Array(sigBuffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `t=${timestampSeconds},v1=${hex}`;
}

async function postWebhook(payload: string, sigHeader: string | null, envOverrides: Record<string, unknown>): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (sigHeader) headers["Stripe-Signature"] = sigHeader;
  return workerFetch(
    new Request("https://deadline-radar.com/stripe/webhook", { method: "POST", headers, body: payload }),
    envOverrides
  );
}

describe("Roster/CPE Hours are a standing free tier -- no expiration, no entitlement gate (2026-08-06)", () => {
  it("GET /firm/licenses: 200 whether the firm is free or on an old (500-day) free-tier account -- no expiration exists to hit", async () => {
    const { firmId, cookie } = await createFirmWithSession("Gate Firm A", `gatea-${Date.now()}@example.com`);
    expect((await getFirmLicenses(cookie)).status).toBe(200);

    await setFirmTierAndAge(firmId, "free", daysAgoIso(500));
    expect((await getFirmLicenses(cookie)).status).toBe(200);
  });

  it("GET /firm/licenses: 200 on every paid firm tier too -- paid tiers grant Map/Practice Privilege Check on top, never take away the free features", async () => {
    for (const tier of ["firm_starter", "firm_growth", "firm_standard", "firm_scale", "firm", "firm_annual", "premium"]) {
      const { firmId, cookie } = await createFirmWithSession(`Gate Firm ${tier}`, `gate-${tier}-${Date.now()}@example.com`);
      await setFirmTierAndAge(firmId, tier, daysAgoIso(500));
      expect((await getFirmLicenses(cookie)).status, `tier "${tier}" should grant access`).toBe(200);
    }
  });

  it("POST /firm/licenses: 201 on a long-standing free-tier firm -- no 402 paywall on roster writes anymore", async () => {
    const { firmId, cookie } = await createFirmWithSession("Gate Firm B", `gateb-${Date.now()}@example.com`);
    await setFirmTierAndAge(firmId, "free", daysAgoIso(500));
    const resp = await postFirmLicense(cookie, { staff_label: "X", email: `x-${Date.now()}@example.com`, state_slug: "georgia", license_type_id: "ga-individual" });
    expect(resp.status).toBe(201);
  });

  it("GET /firm/cpe: 200 on a long-standing free-tier firm and on a paid tier alike", async () => {
    const { firmId, cookie } = await createFirmWithSession("Gate Firm C", `gatec-${Date.now()}@example.com`);
    await setFirmTierAndAge(firmId, "free", daysAgoIso(500));
    expect((await getFirmCpe(cookie)).status).toBe(200);

    await setFirmTierAndAge(firmId, "firm_growth", daysAgoIso(500));
    expect((await getFirmCpe(cookie)).status).toBe(200);
  });

  it("a suspended firm is still denied, free tier or paid -- requireFirmSession() catches this on its own, unrelated to plan_tier", async () => {
    const { firmId, cookie } = await createFirmWithSession("Gate Firm D", `gated-${Date.now()}@example.com`);
    await setFirmTierAndAge(firmId, "firm_standard", daysAgoIso(10), "suspended");
    expect((await getFirmLicenses(cookie)).status).toBe(403);
  });

  it("dashboard-visible seat_cap on GET /firm/licenses is still tier-aware", async () => {
    const { firmId, cookie } = await createFirmWithSession("Gate Firm E", `gatee-${Date.now()}@example.com`);
    await setFirmTierAndAge(firmId, "firm_starter", daysAgoIso(1));
    const resp = await getFirmLicenses(cookie);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { seat_cap: number };
    expect(body.seat_cap).toBe(5);
  });
});

describe("POST /firm/billing/checkout", () => {
  it("401s with no session", async () => {
    const resp = await SELF.fetch("https://deadline-radar.com/firm/billing/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tier: "firm_starter" }),
    });
    expect(resp.status).toBe(401);
  });

  it("503s when Stripe isn't configured (the real state of this test env by default)", async () => {
    const { cookie } = await createFirmWithSession("Checkout Firm A", `checkouta-${Date.now()}@example.com`);
    const resp = await SELF.fetch("https://deadline-radar.com/firm/billing/checkout", {
      method: "POST",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({ tier: "firm_starter" }),
    });
    expect(resp.status).toBe(503);
  });

  it("400s on an unrecognised tier", async () => {
    const { cookie } = await createFirmWithSession("Checkout Firm B", `checkoutb-${Date.now()}@example.com`);
    const resp = await workerFetch(
      new Request("https://deadline-radar.com/firm/billing/checkout", {
        method: "POST",
        headers: { "content-type": "application/json", Cookie: cookie },
        body: JSON.stringify({ tier: "enterprise" }),
      }),
      { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_PRICE_FIRM_STARTER: "price_x" }
    );
    expect(resp.status).toBe(400);
  });

  it("a firm can never buy a tier smaller than its live roster requires", async () => {
    const { firmId, cookie } = await createFirmWithSession("Checkout Firm C", `checkoutc-${Date.now()}@example.com`);
    // Roadmap #151 (2026-08-10): a firm signing up today gets a 3-seat free
    // cap, which would block this test's own setup (6 staff) before it
    // ever reaches the checkout-validation property under test. Backdated
    // to the grandfathered 25-seat cap so setup behaves like it always
    // did -- this test is about checkout tier-vs-roster validation, not
    // about the free-tier seat cap itself.
    await env.DB.prepare("UPDATE firms SET created_at = '2020-01-01T00:00:00Z' WHERE id = ?1").bind(firmId).run();
    for (let i = 0; i < 6; i++) {
      const created = await postFirmLicense(cookie, {
        staff_label: `Staff ${i}`,
        email: `staff${i}-${Date.now()}@example.com`,
        state_slug: "georgia",
        license_type_id: "ga-individual",
      });
      expect(created.status).toBe(201);
    }
    // 6 staff exceeds Essentials' 5-seat cap -- checkout for Essentials must
    // be refused even though the caller can technically pay for it. Under
    // the 2026-08-09 4-band re-tier, 6 staff's minimum tier is Growth
    // (10-seat cap), not Professional (was Growth's own label pre-retier).
    const resp = await workerFetch(
      new Request("https://deadline-radar.com/firm/billing/checkout", {
        method: "POST",
        headers: { "content-type": "application/json", Cookie: cookie },
        body: JSON.stringify({ tier: "firm_starter" }),
      }),
      { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_PRICE_FIRM_STARTER: "price_x" }
    );
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toMatch(/growth/i);
  });

  it("happy path: creates a real Checkout Session (Stripe mocked) with firm_id/target_plan_tier metadata", async () => {
    const { firmId, cookie } = await createFirmWithSession("Checkout Firm D", `checkoutd-${Date.now()}@example.com`);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "cs_test_123", url: "https://checkout.stripe.com/pay/cs_test_123" }), { status: 200 })
    );
    try {
      const resp = await workerFetch(
        new Request("https://deadline-radar.com/firm/billing/checkout", {
          method: "POST",
          headers: { "content-type": "application/json", Cookie: cookie },
          body: JSON.stringify({ tier: "firm_starter" }),
        }),
        { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_PRICE_FIRM_STARTER: "price_starter_x" }
      );
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as { checkout_url: string };
      expect(body.checkout_url).toBe("https://checkout.stripe.com/pay/cs_test_123");

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [calledUrl, calledInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(calledUrl).toBe("https://api.stripe.com/v1/checkout/sessions");
      const sentBody = (calledInit.body as string) ?? "";
      expect(sentBody).toContain(`metadata%5Bfirm_id%5D=${firmId}`);
      expect(sentBody).toContain("metadata%5Btarget_plan_tier%5D=firm_starter");
      expect(sentBody).toContain("price_starter_x");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  // AuditLab BILL-8 (LOW-MEDIUM, 2026-08-14): checkout never checked whether
  // the firm already had a subscription -- Stripe permits multiple active
  // subscriptions per customer, and the webhook's single-valued
  // stripe_subscription_id column would silently overwrite the first,
  // orphaning it while it kept billing. Not reachable through the dashboard
  // UI (it only renders checkout buttons for a firm with no known paid
  // tier), but nothing server-side stopped a stale second tab.
  it("BILL-8: refuses checkout for a firm that already has a subscription on record, no Stripe call made", async () => {
    const { firmId, cookie } = await createFirmWithSession("Checkout Firm E", `checkoute-${Date.now()}@example.com`);
    await env.DB.prepare("UPDATE firms SET stripe_subscription_id = ?1 WHERE id = ?2").bind("sub_existing_123", firmId).run();

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "cs_should_not_happen", url: "https://checkout.stripe.com/pay/cs_should_not_happen" }), { status: 200 })
    );
    try {
      const resp = await workerFetch(
        new Request("https://deadline-radar.com/firm/billing/checkout", {
          method: "POST",
          headers: { "content-type": "application/json", Cookie: cookie },
          body: JSON.stringify({ tier: "firm_starter" }),
        }),
        { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_PRICE_FIRM_STARTER: "price_x" }
      );
      expect(resp.status).toBe(400);
      const body = (await resp.json()) as { error: string };
      expect(body.error).toMatch(/already have an active subscription/i);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  // AuditLab RL-5 (2026-08-06, MEDIUM): this route had ZERO checkRateLimit
  // calls -- unlike its sibling cancel/resume below, an unbounded client
  // (compromised session, retry-looping bug) could hit Stripe under the one
  // shared secret key with no limit. Body is an unrecognised tier (400
  // before the fix, if the request ever got that far) so no Stripe call is
  // ever made -- the rate-limit check now sits before body parsing entirely.
  it("RL-5: rate-limited per firm (was completely unbounded)", async () => {
    const { cookie } = await createFirmWithSession("Checkout RL Firm", `checkout-rl-${Date.now()}@example.com`);
    let sawA429 = false;
    for (let i = 0; i < 15; i++) {
      const resp = await workerFetch(
        new Request("https://deadline-radar.com/firm/billing/checkout", {
          method: "POST",
          headers: { "content-type": "application/json", Cookie: cookie },
          body: JSON.stringify({ tier: "enterprise" }),
        }),
        { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_PRICE_FIRM_STARTER: "price_x" }
      );
      if (resp.status === 429) {
        sawA429 = true;
        break;
      }
      expect(resp.status).toBe(400);
    }
    expect(sawA429, "expected a 429 within the RATE_LIMIT_FIRM_BILLING_CHECKOUT ceiling (10/hour) -- got none in 15 requests").toBe(true);
  });
});

describe("POST /firm/billing/cancel and /firm/billing/resume (2026-08-05, self-serve cancellation)", () => {
  it("401s with no session", async () => {
    expect((await SELF.fetch("https://deadline-radar.com/firm/billing/cancel", { method: "POST" })).status).toBe(401);
    expect((await SELF.fetch("https://deadline-radar.com/firm/billing/resume", { method: "POST" })).status).toBe(401);
  });

  it("400s for a long-standing free-tier firm with nothing to cancel -- billing management has no entitlement gate anymore (2026-08-06)", async () => {
    // Billing self-management (cancel/resume) is one of the routes that
    // moved off requireFirmSessionAndEntitlement() entirely -- it's not a
    // paid FEATURE, it's account management, and a free-tier firm must be
    // able to reach it (if only to discover it has nothing to cancel).
    const { firmId, cookie } = await createFirmWithSession("Cancel Free Firm", `cancelfree-${Date.now()}@example.com`);
    await setFirmTierAndAge(firmId, "free", daysAgoIso(500));
    const resp = await workerFetch(
      new Request("https://deadline-radar.com/firm/billing/cancel", { method: "POST", headers: { Cookie: cookie } }),
      { STRIPE_SECRET_KEY: "sk_test_x" }
    );
    expect(resp.status).toBe(400);
  });

  it("400s when Origin doesn't match -- same CSRF defense-in-depth as every other mutating firm route", async () => {
    const { firmId, cookie } = await createFirmWithSession("Cancel CSRF Firm", `cancelcsrf-${Date.now()}@example.com`);
    await setFirmTierAndAge(firmId, "firm_starter", daysAgoIso(10));
    await env.DB.prepare("UPDATE firms SET stripe_subscription_id = ?1 WHERE id = ?2").bind("sub_csrf_test", firmId).run();
    const resp = await SELF.fetch("https://deadline-radar.com/firm/billing/cancel", {
      method: "POST",
      headers: { Cookie: cookie, Origin: "https://attacker.example" },
    });
    expect(resp.status).toBe(400);
  });

  it("503s when Stripe isn't configured", async () => {
    const { firmId, cookie } = await createFirmWithSession("Cancel No Stripe Firm", `cancelnostripe-${Date.now()}@example.com`);
    await setFirmTierAndAge(firmId, "firm_starter", daysAgoIso(10));
    const resp = await SELF.fetch("https://deadline-radar.com/firm/billing/cancel", { method: "POST", headers: { Cookie: cookie } });
    expect(resp.status).toBe(503);
  });

  it("400s a paid firm with no stripe_subscription_id on record", async () => {
    const { firmId, cookie } = await createFirmWithSession("Cancel No Sub Firm", `cancelnosub-${Date.now()}@example.com`);
    await setFirmTierAndAge(firmId, "firm_starter", daysAgoIso(10));
    const resp = await workerFetch(
      new Request("https://deadline-radar.com/firm/billing/cancel", { method: "POST", headers: { Cookie: cookie } }),
      { STRIPE_SECRET_KEY: "sk_test_x" }
    );
    expect(resp.status).toBe(400);
  });

  it("happy path: cancel sets cancel_at_period_end (Stripe mocked), plan_tier is UNCHANGED", async () => {
    const { firmId, cookie } = await createFirmWithSession("Cancel Happy Firm", `cancelhappy-${Date.now()}@example.com`);
    await setFirmTierAndAge(firmId, "firm_starter", daysAgoIso(10));
    await env.DB.prepare("UPDATE firms SET stripe_subscription_id = ?1 WHERE id = ?2").bind("sub_happy_test", firmId).run();
    const periodEndUnix = Math.floor(Date.now() / 1000) + 20 * 86400; // ~20 days out
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      // Real Stripe response shape (2026-08-05, confirmed against a live
      // test-mode call): current_period_end lives per subscription-item,
      // not at the top level.
      new Response(
        JSON.stringify({ id: "sub_happy_test", cancel_at_period_end: true, items: { data: [{ current_period_end: periodEndUnix }] } }),
        { status: 200 }
      )
    );
    try {
      const resp = await workerFetch(
        new Request("https://deadline-radar.com/firm/billing/cancel", { method: "POST", headers: { Cookie: cookie } }),
        { STRIPE_SECRET_KEY: "sk_test_x" }
      );
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as { cancel_at_period_end: boolean; current_period_end: string };
      expect(body.cancel_at_period_end).toBe(true);
      expect(body.current_period_end).toBe(new Date(periodEndUnix * 1000).toISOString());

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [calledUrl, calledInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(calledUrl).toBe("https://api.stripe.com/v1/subscriptions/sub_happy_test");
      expect((calledInit.body as string) ?? "").toContain("cancel_at_period_end=true");

      // plan_tier must NOT have moved -- access continues to period end,
      // only Stripe's own customer.subscription.deleted webhook (at the
      // real period end) is allowed to touch plan_tier.
      const firm = await store.getFirmById(env.DB, firmId);
      expect(firm?.plan_tier).toBe("firm_starter");
      expect(firm?.cancel_at_period_end).toBe(1);
      expect(firm?.current_period_end).toBe(new Date(periodEndUnix * 1000).toISOString());
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("resume: same toggle with cancel_at_period_end=false, clears the local flag", async () => {
    const { firmId, cookie } = await createFirmWithSession("Resume Happy Firm", `resumehappy-${Date.now()}@example.com`);
    await setFirmTierAndAge(firmId, "firm_growth", daysAgoIso(10));
    await env.DB.prepare("UPDATE firms SET stripe_subscription_id = ?1, cancel_at_period_end = 1, current_period_end = ?2 WHERE id = ?3")
      .bind("sub_resume_test", new Date().toISOString(), firmId)
      .run();
    const periodEndUnix = Math.floor(Date.now() / 1000) + 25 * 86400;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ id: "sub_resume_test", cancel_at_period_end: false, items: { data: [{ current_period_end: periodEndUnix }] } }),
        { status: 200 }
      )
    );
    try {
      const resp = await workerFetch(
        new Request("https://deadline-radar.com/firm/billing/resume", { method: "POST", headers: { Cookie: cookie } }),
        { STRIPE_SECRET_KEY: "sk_test_x" }
      );
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as { cancel_at_period_end: boolean };
      expect(body.cancel_at_period_end).toBe(false);

      const [, calledInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect((calledInit.body as string) ?? "").toContain("cancel_at_period_end=false");

      const firm = await store.getFirmById(env.DB, firmId);
      expect(firm?.plan_tier).toBe("firm_growth"); // untouched throughout
      expect(firm?.cancel_at_period_end).toBe(0);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("a Stripe API error surfaces as 502, not a raw 500", async () => {
    const { firmId, cookie } = await createFirmWithSession("Cancel Stripe Error Firm", `cancelerr-${Date.now()}@example.com`);
    await setFirmTierAndAge(firmId, "firm_starter", daysAgoIso(10));
    await env.DB.prepare("UPDATE firms SET stripe_subscription_id = ?1 WHERE id = ?2").bind("sub_err_test", firmId).run();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "No such subscription" } }), { status: 404 })
    );
    try {
      const resp = await workerFetch(
        new Request("https://deadline-radar.com/firm/billing/cancel", { method: "POST", headers: { Cookie: cookie } }),
        { STRIPE_SECRET_KEY: "sk_test_x" }
      );
      expect(resp.status).toBe(502);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("is rate-limited per firm", async () => {
    const { firmId, cookie } = await createFirmWithSession("Cancel Rate Limit Firm", `cancelrl-${Date.now()}@example.com`);
    await setFirmTierAndAge(firmId, "firm_starter", daysAgoIso(10));
    await env.DB.prepare("UPDATE firms SET stripe_subscription_id = ?1 WHERE id = ?2").bind("sub_rl_test", firmId).run();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ id: "sub_rl_test", cancel_at_period_end: true, items: { data: [{ current_period_end: Math.floor(Date.now() / 1000) }] } }),
        { status: 200 }
      )
    );
    try {
      let sawA429 = false;
      for (let i = 0; i < 15; i++) {
        const resp = await workerFetch(
          new Request("https://deadline-radar.com/firm/billing/cancel", { method: "POST", headers: { Cookie: cookie } }),
          { STRIPE_SECRET_KEY: "sk_test_x" }
        );
        if (resp.status === 429) {
          sawA429 = true;
          break;
        }
      }
      expect(sawA429, "expected a 429 within RATE_LIMIT_FIRM_BILLING_CANCEL's ceiling (10/hour)").toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("POST /stripe/webhook", () => {
  const SECRET = "whsec_test_secret";

  it("400s on a missing/invalid signature -- body is never trusted", async () => {
    const payload = JSON.stringify({ id: "evt_bad", type: "checkout.session.completed", data: { object: {} } });
    const resp = await postWebhook(payload, null, { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: SECRET });
    expect(resp.status).toBe(400);
  });

  it("checkout.session.completed flips the firm onto the paid tier and stores Stripe ids", async () => {
    const { firmId } = await createFirmWithSession("Webhook Firm A", `webhooka-${Date.now()}@example.com`);
    const payload = JSON.stringify({
      id: `evt_checkout_${firmId}`,
      type: "checkout.session.completed",
      data: {
        object: {
          customer: "cus_test_1",
          subscription: "sub_test_1",
          metadata: { firm_id: firmId, target_plan_tier: "firm_growth" },
        },
      },
    });
    const t = Math.floor(Date.now() / 1000);
    const sig = await signPayload(SECRET, t, payload);
    const resp = await postWebhook(payload, sig, { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: SECRET });
    expect(resp.status).toBe(200);

    const firm = await store.getFirmById(env.DB, firmId);
    expect(firm?.plan_tier).toBe("firm_growth");
    expect(firm?.stripe_customer_id).toBe("cus_test_1");
    expect(firm?.stripe_subscription_id).toBe("sub_test_1");
  });

  it("is idempotent: a redelivered event.id does not re-process (ledger row stays processed once)", async () => {
    const { firmId } = await createFirmWithSession("Webhook Firm B", `webhookb-${Date.now()}@example.com`);
    const eventId = `evt_dup_${firmId}`;
    const payload = JSON.stringify({
      id: eventId,
      type: "checkout.session.completed",
      data: {
        object: {
          customer: "cus_test_2",
          subscription: "sub_test_2",
          metadata: { firm_id: firmId, target_plan_tier: "firm_standard" },
        },
      },
    });
    const t = Math.floor(Date.now() / 1000);
    const sig = await signPayload(SECRET, t, payload);
    const envOverrides = { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: SECRET };

    const first = await postWebhook(payload, sig, envOverrides);
    expect(first.status).toBe(200);
    const second = await postWebhook(payload, sig, envOverrides);
    expect(second.status).toBe(200);

    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM stripe_webhook_events WHERE id = ?1").bind(eventId).first<{ n: number }>();
    expect(rows?.n).toBe(1);

    const firm = await store.getFirmById(env.DB, firmId);
    expect(firm?.plan_tier).toBe("firm_standard");
  });

  it("customer.subscription.deleted reverts the firm to the free tier and clears the subscription id", async () => {
    const { firmId } = await createFirmWithSession("Webhook Firm C", `webhookc-${Date.now()}@example.com`);
    await env.DB.prepare("UPDATE firms SET plan_tier = 'firm_starter', stripe_customer_id = 'cus_test_3', stripe_subscription_id = 'sub_test_3' WHERE id = ?1")
      .bind(firmId)
      .run();

    const payload = JSON.stringify({
      id: `evt_cancel_${firmId}`,
      type: "customer.subscription.deleted",
      data: { object: { id: "sub_test_3" } },
    });
    const t = Math.floor(Date.now() / 1000);
    const sig = await signPayload(SECRET, t, payload);
    const resp = await postWebhook(payload, sig, { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: SECRET });
    expect(resp.status).toBe(200);

    const firm = await store.getFirmById(env.DB, firmId);
    expect(firm?.plan_tier).toBe("free");
    expect(firm?.stripe_subscription_id).toBeNull();
    // Customer id is retained -- a future checkout should reuse the same
    // Stripe Customer rather than creating a duplicate.
    expect(firm?.stripe_customer_id).toBe("cus_test_3");
  });

  it("invoice.payment_failed is acknowledged without touching plan_tier -- Stripe's own dunning cycle owns the grace period", async () => {
    const { firmId } = await createFirmWithSession("Webhook Firm D", `webhookd-${Date.now()}@example.com`);
    await env.DB.prepare("UPDATE firms SET plan_tier = 'firm_standard' WHERE id = ?1").bind(firmId).run();

    const payload = JSON.stringify({
      id: `evt_failed_${firmId}`,
      type: "invoice.payment_failed",
      data: { object: { id: "in_test_1" } },
    });
    const t = Math.floor(Date.now() / 1000);
    const sig = await signPayload(SECRET, t, payload);
    const resp = await postWebhook(payload, sig, { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: SECRET });
    expect(resp.status).toBe(200);

    const firm = await store.getFirmById(env.DB, firmId);
    expect(firm?.plan_tier).toBe("firm_standard");
  });

  it("503s when webhook secret isn't configured", async () => {
    const payload = JSON.stringify({ id: "evt_noconfig", type: "checkout.session.completed", data: { object: {} } });
    const resp = await postWebhook(payload, "t=1,v1=deadbeef", { STRIPE_SECRET_KEY: "sk_test_x" });
    expect(resp.status).toBe(503);
  });
});
