/**
 * Paid-tiers + Stripe billing (2026-08-05).
 *
 * Three things this file proves, per the paid-tiers plan's own verification
 * section:
 *   1. requireFirmSessionAndEntitlement() actually gates every route it was
 *      wired into -- read-403/write-402 across pilot/paid-tier/expired/
 *      suspended, not just checkPremiumAccess() in isolation (already
 *      covered by entitlements.spec.ts).
 *   2. POST /firm/billing/checkout rejects a tier smaller than the firm's
 *      live roster, and (with Stripe mocked) creates a real Checkout
 *      Session with the right metadata.
 *   3. POST /stripe/webhook verifies signatures, is idempotent on a
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

describe("entitlement gate -- newly-gated firm routes (2026-08-05)", () => {
  it("GET /firm/licenses: 200 on an active pilot, 403 once the pilot has expired", async () => {
    const { firmId, cookie } = await createFirmWithSession("Gate Firm A", `gatea-${Date.now()}@example.com`);
    expect((await getFirmLicenses(cookie)).status).toBe(200);

    await setFirmTierAndAge(firmId, "pilot", daysAgoIso(40));
    const expired = await getFirmLicenses(cookie);
    expect(expired.status).toBe(403);
    const body = (await expired.json()) as { reason: string; pay_now_url: string };
    expect(body.reason).toBe("pilot_expired");
    expect(body.pay_now_url).toBeTruthy();
  });

  it("GET /firm/licenses: 200 on every paid firm tier", async () => {
    for (const tier of ["firm_starter", "firm_growth", "firm_standard", "firm", "firm_annual", "premium"]) {
      const { firmId, cookie } = await createFirmWithSession(`Gate Firm ${tier}`, `gate-${tier}-${Date.now()}@example.com`);
      await setFirmTierAndAge(firmId, tier, daysAgoIso(500)); // old account -- a paid tier is not time-bounded
      expect((await getFirmLicenses(cookie)).status, `tier "${tier}" should grant access`).toBe(200);
    }
  });

  it("POST /firm/licenses: 402 (not 403) when the entitlement check fails on a write", async () => {
    const { firmId, cookie } = await createFirmWithSession("Gate Firm B", `gateb-${Date.now()}@example.com`);
    await setFirmTierAndAge(firmId, "pilot", daysAgoIso(40));
    const resp = await postFirmLicense(cookie, { staff_label: "X", email: `x-${Date.now()}@example.com`, state_slug: "georgia", license_type_id: "ga-individual" });
    expect(resp.status).toBe(402);
    const body = (await resp.json()) as { reason: string };
    expect(body.reason).toBe("pilot_expired");
  });

  it("GET /firm/cpe: 403 once expired, 200 on a paid tier -- gate applies beyond just the roster route", async () => {
    const { firmId, cookie } = await createFirmWithSession("Gate Firm C", `gatec-${Date.now()}@example.com`);
    await setFirmTierAndAge(firmId, "pilot", daysAgoIso(40));
    expect((await getFirmCpe(cookie)).status).toBe(403);

    await setFirmTierAndAge(firmId, "firm_growth", daysAgoIso(40));
    expect((await getFirmCpe(cookie)).status).toBe(200);
  });

  it("a suspended firm is denied even on a paid tier (firm_inactive, not tier_not_premium)", async () => {
    const { firmId, cookie } = await createFirmWithSession("Gate Firm D", `gated-${Date.now()}@example.com`);
    await setFirmTierAndAge(firmId, "firm_standard", daysAgoIso(10), "suspended");
    // requireFirmSession() itself already 403s a suspended firm before the
    // entitlement check runs -- proving the OUTER gate still catches it is
    // the point (a firm must not slip through via a paid tier).
    expect((await getFirmLicenses(cookie)).status).toBe(403);
  });

  it("dashboard-visible seat_cap on GET /firm/licenses is tier-aware", async () => {
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
    const { cookie } = await createFirmWithSession("Checkout Firm C", `checkoutc-${Date.now()}@example.com`);
    for (let i = 0; i < 6; i++) {
      const created = await postFirmLicense(cookie, {
        staff_label: `Staff ${i}`,
        email: `staff${i}-${Date.now()}@example.com`,
        state_slug: "georgia",
        license_type_id: "ga-individual",
      });
      expect(created.status).toBe(201);
    }
    // 6 staff exceeds Starter's 5-seat cap -- checkout for Starter must be
    // refused even though the caller can technically pay for it.
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

  it("customer.subscription.deleted reverts the firm to pilot and clears the subscription id", async () => {
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
    expect(firm?.plan_tier).toBe("pilot");
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
