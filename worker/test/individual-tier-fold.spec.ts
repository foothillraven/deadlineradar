/**
 * Individual tier folded into free (2026-08-09, Devin's decision, orchestrator
 * 14:25 block). Two independent things to prove:
 *  1. A genuinely solo (exactly one firm_member) free-tier firm gets the SAME
 *     Map/Practice Privilege Check access a paid tier would -- the new
 *     exception in requireFirmSessionAndPaidTier() (index.ts), not
 *     entitlements.ts's own pure checkPaidFeatureAccess() (see
 *     entitlements.spec.ts for that half).
 *  2. The Stripe webhook's checkout.session.completed branch now rejects an
 *     unrecognised target_plan_tier instead of writing it straight to
 *     firms.plan_tier -- the one real, if narrow, path that could ever have
 *     written "individual" (or any other garbage string) onto a real row.
 */
import { env, SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import * as store from "../src/store";

const BASE = "https://deadline-radar.com";

async function soloFreeFirm(label: string): Promise<{ firmId: string; cookie: string }> {
  const { id } = await store.createFirm(env.DB, {
    name: `${label} Solo LLP`,
    adminEmail: `${label}-solo-${Date.now()}-${Math.floor(Math.random() * 1e6)}@examplefirm.com`,
  });
  const { rawSessionToken } = await store.createSession(env.DB, id);
  return { firmId: id, cookie: `dr_firm_session=${rawSessionToken}` };
}

describe("solo-free exception for paid-gated routes (Map / Practice Privilege Check)", () => {
  it("a genuinely solo (1 firm_member) free-tier firm gets access", async () => {
    const { cookie } = await soloFreeFirm("solo-access");
    const resp = await SELF.fetch(`${BASE}/firm/mobility/coverage`, { headers: { Cookie: cookie } });
    expect(resp.status).toBe(200);
  });

  it("a free-tier firm with a SECOND member does NOT get the SOLO-free exception -- but now passes via the roadmap #153 trial instead (coverage is unmetered for it), not a 403", async () => {
    // Superseded 2026-08-09 (roadmap #153, "usage-boxed trial"): coverage
    // used to 403 a multi-person free firm outright; it's now deliberately
    // unmetered/unlocked for one (part of "read-only Map"), via a SEPARATE
    // opt-in path from the solo-free exception this describe block is
    // otherwise about -- see requireFirmSessionAndPaidTier()'s own
    // docstring. The solo-free branch specifically still does not apply
    // here (memberCount !== 1), which is the property this test still
    // proves; it just no longer means an outright block.
    const { firmId, cookie } = await soloFreeFirm("multi-trial");
    await store.createFirmMember(env.DB, {
      firmId,
      email: `multi-trial-second-${Date.now()}@examplefirm.com`,
      role: "staff",
      alreadyJoined: true,
    });
    const resp = await SELF.fetch(`${BASE}/firm/mobility/coverage`, { headers: { Cookie: cookie } });
    expect(resp.status).toBe(200);
  });

  it("a suspended solo firm still gets refused -- requireFirmSession() itself blocks it before the solo-free exception is ever reached", async () => {
    // Same posture as the individual mobility check's own suspended-firm
    // test (worker.spec.ts): requireFirmSession() 403s a suspended firm
    // before requireFirmSessionAndPaidTier()'s own checkPaidFeatureAccess()
    // call -- and therefore before the solo-free exception -- ever runs.
    // The response is requireFirmSession()'s own plain-text error, not a
    // JSON body with a `reason` field.
    const { firmId, cookie } = await soloFreeFirm("solo-suspended");
    await env.DB.prepare("UPDATE firms SET status = 'suspended' WHERE id = ?1").bind(firmId).run();
    const resp = await SELF.fetch(`${BASE}/firm/mobility/coverage`, { headers: { Cookie: cookie } });
    expect(resp.status).toBe(403);
    const body = await resp.text();
    expect(body).toContain("sort it out");
  });

  it("a solo firm on an actual PAID tier still gets access via the normal path, not the exception", async () => {
    const { firmId, cookie } = await soloFreeFirm("solo-paid");
    await env.DB.prepare("UPDATE firms SET plan_tier = 'firm_starter' WHERE id = ?1").bind(firmId).run();
    const resp = await SELF.fetch(`${BASE}/firm/mobility/coverage`, { headers: { Cookie: cookie } });
    expect(resp.status).toBe(200);
  });

  it("the firm-level (roadmap #318) coverage endpoint gets the same solo-free exception -- same gate wrapper", async () => {
    const { cookie } = await soloFreeFirm("solo-firm-mobility");
    const resp = await SELF.fetch(`${BASE}/firm/mobility/firm-coverage`, { headers: { Cookie: cookie } });
    expect(resp.status).toBe(200);
  });
});

describe("POST /stripe/webhook -- checkout.session.completed rejects an unrecognised target_plan_tier", () => {
  const SECRET = "whsec_individualfold_test_secret";
  const STRIPE_ENV = { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: SECRET };

  async function signPayload(secret: string, timestampSeconds: number, payload: string): Promise<string> {
    const signedPayload = `${timestampSeconds}.${payload}`;
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sigBuffer = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload));
    const hex = [...new Uint8Array(sigBuffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
    return `t=${timestampSeconds},v1=${hex}`;
  }

  async function postWebhook(payload: string, sigHeader: string): Promise<Response> {
    const worker = (await import("../src/index")).default;
    return worker.fetch(
      new Request(`${BASE}/stripe/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json", "Stripe-Signature": sigHeader },
        body: payload,
      }),
      { ...env, ...STRIPE_ENV } as never,
      { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext
    );
  }

  it("a garbage target_plan_tier is rejected -- plan_tier is left untouched, webhook still 200s", async () => {
    const { id: firmId } = await store.createFirm(env.DB, {
      name: "Webhook Allowlist Firm",
      adminEmail: `webhook-allowlist-${Date.now()}@examplefirm.com`,
    });
    const beforeFirm = await store.getFirmById(env.DB, firmId);
    expect(beforeFirm?.plan_tier).toBe("free");

    const eventId = `evt_allowlist_${firmId}`;
    const payload = JSON.stringify({
      id: eventId,
      type: "checkout.session.completed",
      data: {
        object: {
          customer: `cus_${eventId}`,
          subscription: `sub_${eventId}`,
          metadata: { firm_id: firmId, target_plan_tier: "not_a_real_tier" },
          payment_status: "paid",
        },
      },
    });
    const t = Math.floor(Date.now() / 1000);
    const sig = await signPayload(SECRET, t, payload);
    const resp = await postWebhook(payload, sig);
    expect(resp.status).toBe(200);

    const afterFirm = await store.getFirmById(env.DB, firmId);
    expect(afterFirm?.plan_tier).toBe("free"); // untouched -- never flipped by the garbage tier
    expect(afterFirm?.stripe_subscription_id).toBeNull(); // the whole block no-opped, not just the tier field
  });

  it("specifically rejects the just-removed 'individual' tier -- the exact case this fold-in closes", async () => {
    const { id: firmId } = await store.createFirm(env.DB, {
      name: "Individual Rejection Firm",
      adminEmail: `individual-rejection-${Date.now()}@examplefirm.com`,
    });
    const eventId = `evt_individual_${firmId}`;
    const payload = JSON.stringify({
      id: eventId,
      type: "checkout.session.completed",
      data: {
        object: {
          customer: `cus_${eventId}`,
          subscription: `sub_${eventId}`,
          metadata: { firm_id: firmId, target_plan_tier: "individual" },
          payment_status: "paid",
        },
      },
    });
    const t = Math.floor(Date.now() / 1000);
    const sig = await signPayload(SECRET, t, payload);
    const resp = await postWebhook(payload, sig);
    expect(resp.status).toBe(200);

    const afterFirm = await store.getFirmById(env.DB, firmId);
    expect(afterFirm?.plan_tier).toBe("free");
  });

  it("a REAL, recognised tier still flips plan_tier exactly as before -- the allowlist isn't over-broad", async () => {
    const { id: firmId } = await store.createFirm(env.DB, {
      name: "Real Tier Firm",
      adminEmail: `real-tier-${Date.now()}@examplefirm.com`,
    });
    const eventId = `evt_realtier_${firmId}`;
    const payload = JSON.stringify({
      id: eventId,
      type: "checkout.session.completed",
      data: {
        object: {
          customer: `cus_${eventId}`,
          subscription: `sub_${eventId}`,
          metadata: { firm_id: firmId, target_plan_tier: "firm_starter" },
          payment_status: "paid",
        },
      },
    });
    const t = Math.floor(Date.now() / 1000);
    const sig = await signPayload(SECRET, t, payload);
    const resp = await postWebhook(payload, sig);
    expect(resp.status).toBe(200);

    const afterFirm = await store.getFirmById(env.DB, firmId);
    expect(afterFirm?.plan_tier).toBe("firm_starter");
  });
});
