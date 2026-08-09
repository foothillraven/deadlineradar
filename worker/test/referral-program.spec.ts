/**
 * Roadmap #31 (2026-08-09): referral program (firm refers firm, both get a
 * discount). Modeled on billing.spec.ts's own shape for the checkout/
 * webhook tests (Stripe mocked via vi.spyOn(globalThis, "fetch"), real
 * signatures via signPayload()), and worker.spec.ts's postFirmSignup()
 * pattern for the signup-capture tests.
 *
 * Stripe's own network calls are never made live -- every test either mocks
 * fetch or configures no Stripe secrets at all, same discipline
 * billing.spec.ts already uses.
 */
import { env, SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import * as store from "../src/store";

function testExecutionContext(): ExecutionContext {
  return { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
}

async function workerFetch(request: Request, envOverrides: Record<string, unknown> = {}): Promise<Response> {
  const worker = (await import("../src/index")).default;
  return worker.fetch(request, { ...env, ...envOverrides } as never, testExecutionContext());
}

function form(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

async function postFirmSignup(fields: Record<string, string>, ip: string): Promise<Response> {
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

async function signPayload(secret: string, timestampSeconds: number, payload: string): Promise<string> {
  const signedPayload = `${timestampSeconds}.${payload}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sigBuffer = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload));
  const hex = [...new Uint8Array(sigBuffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `t=${timestampSeconds},v1=${hex}`;
}

async function postWebhook(payload: string, sigHeader: string | null, envOverrides: Record<string, unknown>): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (sigHeader) headers["Stripe-Signature"] = sigHeader;
  return workerFetch(new Request("https://deadline-radar.com/stripe/webhook", { method: "POST", headers, body: payload }), envOverrides);
}

async function checkoutCompletedPayload(eventId: string, firmId: string, opts: { paymentStatus?: string; targetPlanTier?: string } = {}): Promise<string> {
  return JSON.stringify({
    id: eventId,
    type: "checkout.session.completed",
    data: {
      object: {
        customer: `cus_${eventId}`,
        subscription: `sub_${eventId}`,
        metadata: { firm_id: firmId, target_plan_tier: opts.targetPlanTier ?? "firm_starter" },
        payment_status: opts.paymentStatus ?? "paid",
      },
    },
  });
}

const SECRET = "whsec_referral_test_secret";
const STRIPE_ENV = { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: SECRET, STRIPE_COUPON_REFERRAL: "coupon_referral_test" };

// ---------------------------------------------------------------------------
// Signup capture
// ---------------------------------------------------------------------------

describe("POST /firm/signup -- referral code capture", () => {
  it("a valid referral_code sets referred_by_firm_id on the NEW firm", async () => {
    const referrer = await store.createFirm(env.DB, { name: "Referrer LLP", adminEmail: `ref-a-${Date.now()}@example.com` });
    const referrerCode = await store.getOrCreateReferralCode(env.DB, referrer.id);

    const newEmail = `referred-a-${Date.now()}@example.com`;
    const resp = await postFirmSignup({ name: "Referred Firm A", admin_email: newEmail, referral_code: referrerCode }, "203.0.113.1");
    expect(resp.status).toBe(200);

    const member = await store.findFirmMemberByEmail(env.DB, newEmail);
    expect(member).not.toBeNull();
    const referred = await store.getFirmById(env.DB, member!.firm_id);
    expect(referred?.referred_by_firm_id).toBe(referrer.id);
  });

  it("an unresolvable/garbage referral_code never fails the signup -- referred_by_firm_id just stays null", async () => {
    const newEmail = `referred-garbage-${Date.now()}@example.com`;
    const resp = await postFirmSignup({ name: "Referred Firm B", admin_email: newEmail, referral_code: "NOTREAL1" }, "203.0.113.2");
    expect(resp.status).toBe(200);

    const member = await store.findFirmMemberByEmail(env.DB, newEmail);
    const referred = await store.getFirmById(env.DB, member!.firm_id);
    expect(referred?.referred_by_firm_id).toBeNull();
  });

  it("a malformed-format code (wrong length/alphabet) never fails the signup, never even reaches a DB lookup", async () => {
    const newEmail = `referred-malformed-${Date.now()}@example.com`;
    const resp = await postFirmSignup({ name: "Referred Firm C", admin_email: newEmail, referral_code: "short" }, "203.0.113.3");
    expect(resp.status).toBe(200);
    const member = await store.findFirmMemberByEmail(env.DB, newEmail);
    const referred = await store.getFirmById(env.DB, member!.firm_id);
    expect(referred?.referred_by_firm_id).toBeNull();
  });

  it("no referral_code field at all -- signup unaffected, referred_by_firm_id null", async () => {
    const newEmail = `referred-none-${Date.now()}@example.com`;
    const resp = await postFirmSignup({ name: "Referred Firm D", admin_email: newEmail }, "203.0.113.4");
    expect(resp.status).toBe(200);
    const member = await store.findFirmMemberByEmail(env.DB, newEmail);
    const referred = await store.getFirmById(env.DB, member!.firm_id);
    expect(referred?.referred_by_firm_id).toBeNull();
  });

  it("ADVERSARIAL-REVIEW FIX: self-referral blocked by Gmail +tag/dot aliasing, not just an exact string match", async () => {
    // cooldownKey() folds BOTH forms to the identical "refgmailowner<base>"
    // key: dots are stripped, and everything from "+" onward in the local
    // part is dropped -- Gmail treats both as the same inbox.
    const base = Date.now();
    const referrerEmail = `ref.gmail.owner.${base}@gmail.com`;
    const referrerResp = await postFirmSignup({ name: "Gmail Referrer LLP", admin_email: referrerEmail }, "203.0.113.40");
    expect(referrerResp.status).toBe(200);
    const referrerMember = await store.findFirmMemberByEmail(env.DB, referrerEmail);
    const referrerCode = await store.getOrCreateReferralCode(env.DB, referrerMember!.firm_id);
    expect(store.cooldownKey(referrerEmail)).toBe(`refgmailowner${base}@gmail.com`); // sanity-check the fold itself

    // Same human, different-LOOKING address: a +tag added. Different
    // signup IP so this test isolates the EMAIL check from the IP check
    // covered separately above/below.
    const aliasEmail = `refgmailowner${base}+work@gmail.com`;
    expect(store.cooldownKey(aliasEmail)).toBe(store.cooldownKey(referrerEmail)); // sanity-check they fold identically
    const aliasResp = await postFirmSignup({ name: "Gmail Alias Firm", admin_email: aliasEmail, referral_code: referrerCode }, "203.0.113.41");
    expect(aliasResp.status).toBe(200);
    const aliasMember = await store.findFirmMemberByEmail(env.DB, aliasEmail);
    const aliasFirm = await store.getFirmById(env.DB, aliasMember!.firm_id);
    expect(aliasFirm?.referred_by_firm_id).toBeNull();
  });

  it("self-referral blocked by IP: a different email, but the SAME signup IP as the referrer -- referred_by_firm_id stays null", async () => {
    const sharedIp = "203.0.113.50";
    const referrerEmail = `refip-referrer-${Date.now()}@example.com`;
    const referrerResp = await postFirmSignup({ name: "IP Referrer LLP", admin_email: referrerEmail }, sharedIp);
    expect(referrerResp.status).toBe(200);
    const referrerMember = await store.findFirmMemberByEmail(env.DB, referrerEmail);
    const referrerCode = await store.getOrCreateReferralCode(env.DB, referrerMember!.firm_id);

    const secondEmail = `refip-second-${Date.now()}@example.com`;
    const secondResp = await postFirmSignup({ name: "IP Second Firm", admin_email: secondEmail, referral_code: referrerCode }, sharedIp);
    expect(secondResp.status).toBe(200);
    const secondMember = await store.findFirmMemberByEmail(env.DB, secondEmail);
    const secondFirm = await store.getFirmById(env.DB, secondMember!.firm_id);
    expect(secondFirm?.referred_by_firm_id).toBeNull();
  });

  it("a DIFFERENT signup IP is not blocked -- proves the IP check isn't over-broad", async () => {
    const referrerEmail = `refipdiff-referrer-${Date.now()}@example.com`;
    const referrerResp = await postFirmSignup({ name: "Diff IP Referrer LLP", admin_email: referrerEmail }, "203.0.113.60");
    expect(referrerResp.status).toBe(200);
    const referrerMember = await store.findFirmMemberByEmail(env.DB, referrerEmail);
    const referrerCode = await store.getOrCreateReferralCode(env.DB, referrerMember!.firm_id);

    const secondEmail = `refipdiff-second-${Date.now()}@example.com`;
    const secondResp = await postFirmSignup({ name: "Diff IP Second Firm", admin_email: secondEmail, referral_code: referrerCode }, "203.0.113.61");
    expect(secondResp.status).toBe(200);
    const secondMember = await store.findFirmMemberByEmail(env.DB, secondEmail);
    const secondFirm = await store.getFirmById(env.DB, secondMember!.firm_id);
    expect(secondFirm?.referred_by_firm_id).toBe(referrerMember!.firm_id);
  });
});

// ---------------------------------------------------------------------------
// store.getOrCreateReferralCode / findFirmByReferralCode
// ---------------------------------------------------------------------------

describe("store: referral code lifecycle", () => {
  it("getOrCreateReferralCode is lazy, stable, and unique per call", async () => {
    const { firmId } = await createFirmWithSession("Lazy Code Firm", `lazycode-${Date.now()}@example.com`);
    const first = await store.getOrCreateReferralCode(env.DB, firmId);
    expect(first).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
    const second = await store.getOrCreateReferralCode(env.DB, firmId);
    expect(second).toBe(first); // stable, not regenerated on a second call
  });

  it("findFirmByReferralCode resolves a real code and returns null for an unresolvable one", async () => {
    const { firmId } = await createFirmWithSession("Findable Firm", `findable-${Date.now()}@example.com`);
    const code = await store.getOrCreateReferralCode(env.DB, firmId);
    const found = await store.findFirmByReferralCode(env.DB, code);
    expect(found?.id).toBe(firmId);
    expect(await store.findFirmByReferralCode(env.DB, "ZZZZZZZZ")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// POST /firm/billing/checkout -- referred firm's own discount
// ---------------------------------------------------------------------------

describe("POST /firm/billing/checkout -- referral coupon eligibility", () => {
  it("an eligible referred firm's checkout session requests the coupon", async () => {
    const referrer = await store.createFirm(env.DB, { name: "Coupon Referrer", adminEmail: `couponref-a-${Date.now()}@example.com` });
    const referred = await store.createFirm(env.DB, {
      name: "Coupon Referred",
      adminEmail: `couponreferred-a-${Date.now()}@example.com`,
      referredByFirmId: referrer.id,
    });
    const { rawSessionToken } = await store.createSession(env.DB, referred.id);
    const cookie = `dr_firm_session=${rawSessionToken}`;

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "cs_ref_1", url: "https://checkout.stripe.com/pay/cs_ref_1" }), { status: 200 })
    );
    try {
      const resp = await workerFetch(
        new Request("https://deadline-radar.com/firm/billing/checkout", {
          method: "POST",
          headers: { "content-type": "application/json", Cookie: cookie },
          body: JSON.stringify({ tier: "firm_starter" }),
        }),
        { ...STRIPE_ENV, STRIPE_PRICE_FIRM_STARTER: "price_x" }
      );
      expect(resp.status).toBe(200);
      const sentBody = (fetchSpy.mock.calls[0]![1] as RequestInit).body as string;
      expect(sentBody).toContain(`discounts%5B0%5D%5Bcoupon%5D=${STRIPE_ENV.STRIPE_COUPON_REFERRAL}`);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("a NON-referred firm's checkout session does NOT request any coupon", async () => {
    const { cookie } = await createFirmWithSession("Non Referred Firm", `nonreferred-${Date.now()}@example.com`);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "cs_noref_1", url: "https://checkout.stripe.com/pay/cs_noref_1" }), { status: 200 })
    );
    try {
      await workerFetch(
        new Request("https://deadline-radar.com/firm/billing/checkout", {
          method: "POST",
          headers: { "content-type": "application/json", Cookie: cookie },
          body: JSON.stringify({ tier: "firm_starter" }),
        }),
        { ...STRIPE_ENV, STRIPE_PRICE_FIRM_STARTER: "price_x" }
      );
      const sentBody = (fetchSpy.mock.calls[0]![1] as RequestInit).body as string;
      expect(sentBody).not.toContain("discounts%5B0%5D");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("a referred firm that has ALREADY had its reward applied does not request the coupon again (no double-discount on a later tier upgrade)", async () => {
    const referrer = await store.createFirm(env.DB, { name: "Already Rewarded Referrer", adminEmail: `alreadyref-a-${Date.now()}@example.com` });
    const referred = await store.createFirm(env.DB, {
      name: "Already Rewarded Referred",
      adminEmail: `alreadyreferred-${Date.now()}@example.com`,
      referredByFirmId: referrer.id,
    });
    await store.claimReferralReward(env.DB, referred.id);
    const { rawSessionToken } = await store.createSession(env.DB, referred.id);
    const cookie = `dr_firm_session=${rawSessionToken}`;

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "cs_already_1", url: "https://checkout.stripe.com/pay/cs_already_1" }), { status: 200 })
    );
    try {
      await workerFetch(
        new Request("https://deadline-radar.com/firm/billing/checkout", {
          method: "POST",
          headers: { "content-type": "application/json", Cookie: cookie },
          body: JSON.stringify({ tier: "firm_starter" }),
        }),
        { ...STRIPE_ENV, STRIPE_PRICE_FIRM_STARTER: "price_x" }
      );
      const sentBody = (fetchSpy.mock.calls[0]![1] as RequestInit).body as string;
      expect(sentBody).not.toContain("discounts%5B0%5D");
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// POST /stripe/webhook -- referrer's own reward
// ---------------------------------------------------------------------------

describe("POST /stripe/webhook -- referral reward (referrer side)", () => {
  async function setupReferralPair(label: string): Promise<{ referrerId: string; referredId: string }> {
    const referrer = await store.createFirm(env.DB, { name: `${label} Referrer`, adminEmail: `${label}-referrer-${Date.now()}@example.com` });
    await env.DB.prepare("UPDATE firms SET stripe_subscription_id = ?1 WHERE id = ?2").bind(`sub_${label}_referrer`, referrer.id).run();
    const referred = await store.createFirm(env.DB, {
      name: `${label} Referred`,
      adminEmail: `${label}-referred-${Date.now()}@example.com`,
      referredByFirmId: referrer.id,
    });
    return { referrerId: referrer.id, referredId: referred.id };
  }

  it("does NOT fire on mere signup -- referrer's subscription is untouched until a real checkout completes", async () => {
    const { referrerId } = await setupReferralPair("nosignupfire");
    const before = await store.getFirmById(env.DB, referrerId);
    expect(before?.referral_reward_applied_at).toBeNull();
    // No webhook posted at all -- this test's whole point is proving
    // nothing fires without one.
  });

  it("fires on checkout.session.completed with payment_status=paid for an eligible referred firm", async () => {
    const { referrerId, referredId } = await setupReferralPair("fires");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    try {
      const eventId = `evt_fires_${referredId}`;
      const payload = await checkoutCompletedPayload(eventId, referredId);
      const t = Math.floor(Date.now() / 1000);
      const sig = await signPayload(SECRET, t, payload);
      const resp = await postWebhook(payload, sig, STRIPE_ENV);
      expect(resp.status).toBe(200);

      // Plan-tier flip still happens (unaffected by the referral logic).
      const referred = await store.getFirmById(env.DB, referredId);
      expect(referred?.plan_tier).toBe("firm_starter");
      expect(referred?.referral_reward_applied_at).not.toBeNull();

      // The referrer's subscription got the coupon call.
      const couponCall = fetchSpy.mock.calls.find((c) => (c[0] as string).includes(`/subscriptions/sub_fires_referrer`));
      expect(couponCall).toBeTruthy();
      const couponBody = (couponCall![1] as RequestInit).body as string;
      expect(couponBody).toContain(`discounts%5B0%5D%5Bcoupon%5D=${STRIPE_ENV.STRIPE_COUPON_REFERRAL}`);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("payment_status gate: pending/omitted payment_status does NOT trigger the referrer's reward, but the plan-tier flip still happens", async () => {
    const { referrerId, referredId } = await setupReferralPair("pending");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    try {
      const eventId = `evt_pending_${referredId}`;
      const payload = await checkoutCompletedPayload(eventId, referredId, { paymentStatus: "unpaid" });
      const t = Math.floor(Date.now() / 1000);
      const sig = await signPayload(SECRET, t, payload);
      const resp = await postWebhook(payload, sig, STRIPE_ENV);
      expect(resp.status).toBe(200);

      const referred = await store.getFirmById(env.DB, referredId);
      expect(referred?.plan_tier).toBe("firm_starter"); // unaffected
      expect(referred?.referral_reward_applied_at).toBeNull();

      const couponCall = fetchSpy.mock.calls.find((c) => (c[0] as string).includes("/subscriptions/"));
      expect(couponCall).toBeUndefined();
      void referrerId;
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("idempotency: a redelivered event.id (same event) does not re-apply the reward", async () => {
    const { referredId } = await setupReferralPair("redeliver");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    try {
      const eventId = `evt_redeliver_${referredId}`;
      const payload = await checkoutCompletedPayload(eventId, referredId);
      const t = Math.floor(Date.now() / 1000);
      const sig = await signPayload(SECRET, t, payload);

      const first = await postWebhook(payload, sig, STRIPE_ENV);
      expect(first.status).toBe(200);
      const second = await postWebhook(payload, sig, STRIPE_ENV);
      expect(second.status).toBe(200);

      const couponCalls = fetchSpy.mock.calls.filter((c) => (c[0] as string).includes("/subscriptions/sub_redeliver_referrer"));
      expect(couponCalls.length).toBe(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("concurrency: two genuinely distinct events for the SAME referred firm racing the atomic claim -- only one wins, proving the claim (not a read-then-write) is what closes this", async () => {
    const { referredId } = await setupReferralPair("race");
    // Directly exercises the atomic claim two competing invocations would
    // both otherwise pass a plain "is it null" read-check on.
    const [a, b] = await Promise.all([store.claimReferralReward(env.DB, referredId), store.claimReferralReward(env.DB, referredId)]);
    expect([a, b].filter(Boolean).length).toBe(1); // exactly one claim wins
  });

  it("ADVERSARIAL-REVIEW FIX: a failed Stripe coupon call is logged for reconciliation, but the REFERRED firm's own claim is NOT reverted -- it must never re-request the discount", async () => {
    // This is the exact bug an adversarial review caught (2026-08-09):
    // unclaiming on Stripe failure re-opened the referred firm's own
    // one-time-discount eligibility, not just the referrer's reward --
    // meaning a firm could keep re-triggering (and Stripe re-failing, or
    // succeeding later) the "one-time" discount indefinitely.
    const { referredId } = await setupReferralPair("failnorevert");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500 }));
    try {
      const eventId = `evt_failnorevert_${referredId}`;
      const payload = await checkoutCompletedPayload(eventId, referredId);
      const t = Math.floor(Date.now() / 1000);
      const sig = await signPayload(SECRET, t, payload);
      const resp = await postWebhook(payload, sig, STRIPE_ENV);
      // The webhook itself still 200s (best-effort, never blocks the
      // primary state transition) even though the referrer-reward attempt failed.
      expect(resp.status).toBe(200);

      const referred = await store.getFirmById(env.DB, referredId);
      expect(referred?.plan_tier).toBe("firm_starter"); // plan-tier flip unaffected
      expect(referred?.referral_reward_applied_at).not.toBeNull(); // NOT reverted -- own discount stays spent
      expect(referred?.referrer_rewarded_at).toBeNull(); // but the referrer genuinely never got anything
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("referrer with no active Stripe subscription -- referred firm's own claim is still consumed (one-time, regardless), referrer_rewarded_at stays null, webhook 200s, plan-tier flip still happens", async () => {
    const referrer = await store.createFirm(env.DB, { name: "No Sub Referrer", adminEmail: `nosub-referrer-${Date.now()}@example.com` });
    // Deliberately NOT setting stripe_subscription_id -- a referrer who's
    // never subscribed (e.g. still on the free tier) or has since cancelled.
    const referred = await store.createFirm(env.DB, {
      name: "No Sub Referred",
      adminEmail: `nosub-referred-${Date.now()}@example.com`,
      referredByFirmId: referrer.id,
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    try {
      const eventId = `evt_nosub_${referred.id}`;
      const payload = await checkoutCompletedPayload(eventId, referred.id);
      const t = Math.floor(Date.now() / 1000);
      const sig = await signPayload(SECRET, t, payload);
      const resp = await postWebhook(payload, sig, STRIPE_ENV);
      expect(resp.status).toBe(200);

      const referredAfter = await store.getFirmById(env.DB, referred.id);
      expect(referredAfter?.plan_tier).toBe("firm_starter");
      // ADVERSARIAL-REVIEW FIX: claimed unconditionally -- a referred firm
      // whose referrer is ineligible must NOT stay eligible to request the
      // coupon on every future checkout forever.
      expect(referredAfter?.referral_reward_applied_at).not.toBeNull();
      expect(referredAfter?.referrer_rewarded_at).toBeNull(); // nothing to reward the referrer with

      const couponCall = fetchSpy.mock.calls.find((c) => (c[0] as string).includes("/subscriptions/"));
      expect(couponCall).toBeUndefined();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("AuditLab DEMO-4/5-style check: a demo_locked referrer never gets a real Stripe discount applied, but the referred firm's own claim still consumes normally", async () => {
    const referrer = await store.createFirm(env.DB, { name: "Demo Referrer", adminEmail: `demo-referrer-${Date.now()}@example.com` });
    await env.DB.prepare("UPDATE firms SET stripe_subscription_id = ?1, demo_locked = 1 WHERE id = ?2").bind("sub_demo_referrer", referrer.id).run();
    const referred = await store.createFirm(env.DB, {
      name: "Demo Referred",
      adminEmail: `demo-referred-${Date.now()}@example.com`,
      referredByFirmId: referrer.id,
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    try {
      const eventId = `evt_demo_${referred.id}`;
      const payload = await checkoutCompletedPayload(eventId, referred.id);
      const t = Math.floor(Date.now() / 1000);
      const sig = await signPayload(SECRET, t, payload);
      const resp = await postWebhook(payload, sig, STRIPE_ENV);
      expect(resp.status).toBe(200);

      const couponCall = fetchSpy.mock.calls.find((c) => (c[0] as string).includes("/subscriptions/sub_demo_referrer"));
      expect(couponCall).toBeUndefined();
      const referredAfter = await store.getFirmById(env.DB, referred.id);
      expect(referredAfter?.referral_reward_applied_at).not.toBeNull(); // still claimed, one-time
      expect(referredAfter?.referrer_rewarded_at).toBeNull(); // demo never actually rewarded
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("STRIPE_COUPON_REFERRAL unset -- referrer step no-ops, but the referred firm's own one-time claim still fires (never infinitely re-requestable just because the coupon isn't configured yet)", async () => {
    const { referredId } = await setupReferralPair("nocoupon");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    try {
      const eventId = `evt_nocoupon_${referredId}`;
      const payload = await checkoutCompletedPayload(eventId, referredId);
      const t = Math.floor(Date.now() / 1000);
      const sig = await signPayload(SECRET, t, payload);
      const resp = await postWebhook(payload, sig, { STRIPE_SECRET_KEY: STRIPE_ENV.STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET: STRIPE_ENV.STRIPE_WEBHOOK_SECRET, STRIPE_COUPON_REFERRAL: undefined });
      expect(resp.status).toBe(200);
      const referred = await store.getFirmById(env.DB, referredId);
      expect(referred?.plan_tier).toBe("firm_starter");
      expect(referred?.referral_reward_applied_at).not.toBeNull();
      expect(referred?.referrer_rewarded_at).toBeNull();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("ADVERSARIAL-REVIEW FIX: countRewardedReferrals only counts referrer_rewarded_at, never overcounting a referral where the referred firm consumed its discount but the referrer never got anything", async () => {
    const { referrerId, referredId } = await setupReferralPair("countfix");
    // Claim the referred side (as a real webhook would for ANY referred
    // firm's first paid checkout) but never actually reward the referrer
    // -- simulates exactly the free-tier/demo/failed-Stripe-call cases
    // above without needing a full webhook round trip.
    await store.claimReferralReward(env.DB, referredId);
    expect(await store.countRewardedReferrals(env.DB, referrerId)).toBe(0);
    await store.markReferrerRewarded(env.DB, referredId);
    expect(await store.countRewardedReferrals(env.DB, referrerId)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Reward reversal on refund (the profitable self-referral loop an
// adversarial review surfaced, 2026-08-09): pay, trigger the referrer's
// reward, immediately self-serve delete-and-refund, repeat.
// ---------------------------------------------------------------------------

describe("POST /firm/account/delete -- referral reward reversal on refund", () => {
  async function deleteFirm(cookie: string, envOverrides: Record<string, unknown>): Promise<Response> {
    return workerFetch(
      new Request("https://deadline-radar.com/firm/account/delete", {
        method: "POST",
        headers: { "content-type": "application/json", Cookie: cookie },
        body: JSON.stringify({}),
      }),
      envOverrides
    );
  }

  // Same verified-shape mock account_deletion.spec.ts's own
  // mockStripeSequence() uses -- a real deletion touches Stripe 4 times
  // (GET subscription/latest_invoice, GET invoice/payments, POST refund,
  // DELETE subscription), routed by method + URL shape.
  function mockStripeSequence(opts: { periodStartUnix: number; periodEndUnix: number; amountPaid: number; paymentIntentId: string | null }) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const method = typeof input === "string" ? (init?.method ?? "GET") : (input as Request).method;
      if (url.includes("/v1/subscriptions/") && url.includes("latest_invoice") && method !== "DELETE") {
        return new Response(
          JSON.stringify({
            items: { data: [{ current_period_start: opts.periodStartUnix, current_period_end: opts.periodEndUnix }] },
            latest_invoice: { id: "in_reversal_test", amount_paid: opts.amountPaid },
          }),
          { status: 200 }
        );
      }
      if (url.includes("/v1/invoices/")) {
        return new Response(
          JSON.stringify({ payments: { data: opts.paymentIntentId ? [{ payment: { type: "payment_intent", payment_intent: opts.paymentIntentId } }] : [] } }),
          { status: 200 }
        );
      }
      if (url.includes("/v1/refunds")) {
        return new Response(JSON.stringify({ id: "re_reversal_test" }), { status: 200 });
      }
      if (url.includes("/discount") && method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      if (url.includes("/v1/subscriptions/") && method === "DELETE") {
        return new Response(JSON.stringify({ status: "canceled" }), { status: 200 });
      }
      throw new Error(`Unexpected Stripe call: ${method} ${url}`);
    });
  }

  it("a referred firm that gets a REAL refund on deletion has its referrer's reward reversed", async () => {
    const referrer = await store.createFirm(env.DB, { name: "Reversal Referrer", adminEmail: `reversal-referrer-${Date.now()}@example.com` });
    await env.DB.prepare("UPDATE firms SET stripe_subscription_id = ?1 WHERE id = ?2").bind("sub_reversal_referrer", referrer.id).run();
    const referred = await store.createFirm(env.DB, {
      name: "Reversal Referred",
      adminEmail: `reversal-referred-${Date.now()}@example.com`,
      referredByFirmId: referrer.id,
    });
    // Simulate the state after a successful checkout + referrer reward
    // (webhook flow tested separately above) -- both markers set, plus a
    // real stripe_subscription_id on the REFERRED firm so the deletion
    // path's own refund logic has something to refund.
    await store.claimReferralReward(env.DB, referred.id);
    await store.markReferrerRewarded(env.DB, referred.id);
    await env.DB.prepare("UPDATE firms SET stripe_subscription_id = ?1 WHERE id = ?2").bind("sub_reversal_referred", referred.id).run();

    const { rawSessionToken } = await store.createSession(env.DB, referred.id);
    const cookie = `dr_firm_session=${rawSessionToken}`;
    const nowUnix = Math.floor(Date.now() / 1000);
    const fetchSpy = mockStripeSequence({
      periodStartUnix: nowUnix - 10 * 86400,
      periodEndUnix: nowUnix + 90 * 86400,
      amountPaid: 17910,
      paymentIntentId: "pi_reversal_test",
    });
    try {
      const resp = await deleteFirm(cookie, STRIPE_ENV);
      expect(resp.status).toBe(200);

      // The marker lives on the REFERRED (deleted) firm's own row -- that's
      // where claimReferralReward()/markReferrerRewarded() wrote it in the
      // first place (see claimReferralReward()'s own docstring for why
      // it's keyed by the referred firm, not the referrer).
      const referredAfter = await store.getFirmById(env.DB, referred.id);
      expect(referredAfter?.referrer_rewarded_at?.startsWith("reversed:")).toBe(true);

      const discountDeleteCall = fetchSpy.mock.calls.find((c) => {
        const url = typeof c[0] === "string" ? c[0] : (c[0] as Request).url;
        const init = c[1] as RequestInit | undefined;
        return url.includes("/subscriptions/sub_reversal_referrer/discount") && init?.method === "DELETE";
      });
      expect(discountDeleteCall).toBeTruthy();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("a referred firm with NOTHING to refund (never paid -- no stripe_subscription_id) does not attempt any reversal", async () => {
    const referrer = await store.createFirm(env.DB, { name: "No Refund Referrer", adminEmail: `norefund-referrer-${Date.now()}@example.com` });
    await env.DB.prepare("UPDATE firms SET stripe_subscription_id = ?1 WHERE id = ?2").bind("sub_norefund_referrer", referrer.id).run();
    const referred = await store.createFirm(env.DB, {
      name: "No Refund Referred",
      adminEmail: `norefund-referred-${Date.now()}@example.com`,
      referredByFirmId: referrer.id,
    });
    await store.claimReferralReward(env.DB, referred.id);
    await store.markReferrerRewarded(env.DB, referred.id);
    // Deliberately NOT setting the referred firm's own stripe_subscription_id
    // -- the deletion path's refund logic has nothing to look up, so
    // refundCents stays null ("nothing owed"), never a real refund.

    const { rawSessionToken } = await store.createSession(env.DB, referred.id);
    const cookie = `dr_firm_session=${rawSessionToken}`;
    // No stripe_subscription_id on the referred firm means the deletion
    // path's own Stripe block never runs at all -- any fetch call here
    // would be a real bug, not something to mock a happy response for.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("unexpected live fetch call -- no Stripe call should happen when stripe_subscription_id is unset");
    });
    try {
      const resp = await deleteFirm(cookie, STRIPE_ENV);
      expect(resp.status).toBe(200);
      const referredAfter = await store.getFirmById(env.DB, referred.id);
      // Untouched -- no real refund happened, so nothing to claw back.
      expect(referredAfter?.referrer_rewarded_at).not.toBeNull();
      expect(referredAfter?.referrer_rewarded_at?.startsWith("reversed:")).toBe(false);
      const discountDeleteCall = fetchSpy.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "DELETE");
      expect(discountDeleteCall).toBeUndefined();
      void referrer;
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Dashboard payload
// ---------------------------------------------------------------------------

describe("GET /firm/licenses -- referral fields", () => {
  it("returns a lazily-generated referral_link and a reward count reflecting only REWARDED referrals", async () => {
    const { firmId, cookie } = await createFirmWithSession("Dashboard Referral Firm", `dashref-${Date.now()}@example.com`);
    const referredNotRewarded = await store.createFirm(env.DB, {
      name: "Not Rewarded Yet",
      adminEmail: `dashref-notyet-${Date.now()}@example.com`,
      referredByFirmId: firmId,
    });
    const referredRewarded = await store.createFirm(env.DB, {
      name: "Rewarded",
      adminEmail: `dashref-rewarded-${Date.now()}@example.com`,
      referredByFirmId: firmId,
    });
    await store.claimReferralReward(env.DB, referredRewarded.id);
    await store.markReferrerRewarded(env.DB, referredRewarded.id);

    const resp = await SELF.fetch("https://deadline-radar.com/firm/licenses", { headers: { Cookie: cookie } });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { referral_link: string; referral_reward_count: number };
    expect(body.referral_link).toContain("/for-firms/?ref=");
    expect(body.referral_reward_count).toBe(1); // only the rewarded one counts
    void referredNotRewarded;
  });
});
