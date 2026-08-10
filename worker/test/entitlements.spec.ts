import { describe, it, expect } from "vitest";
import { checkPaidFeatureAccess, paidFeatureDenialMessage } from "../src/entitlements";

function firm(over: Partial<{ plan_tier: string; status: string }> = {}) {
  return {
    plan_tier: "free",
    status: "active",
    ...over,
  };
}

describe("paid-feature access (Map / Practice Privilege Check) -- fails closed", () => {
  it("denies an unrecognised plan tier rather than defaulting open", () => {
    // A typo in a tier name must lock the feature, not unlock it.
    for (const tier of ["", "Firm", "FIRM", "enterprise", "pilot", "trial", "premuim"]) {
      const res = checkPaidFeatureAccess(firm({ plan_tier: tier }));
      expect(res.allowed, `tier "${tier}" must not grant access`).toBe(false);
    }
  });

  it("the FREE tier (the renamed pilot) does NOT unlock paid features, no exception", () => {
    const res = checkPaidFeatureAccess(firm({ plan_tier: "free" }));
    expect(res.allowed).toBe(false);
    if (!res.allowed) expect(res.reason).toBe("tier_not_paid");
  });

  it("denies an inactive firm EVEN ON A PAID TIER", () => {
    // A suspended account with a paid tier must not retain access.
    const res = checkPaidFeatureAccess(firm({ plan_tier: "firm", status: "suspended" }));
    expect(res.allowed).toBe(false);
    if (!res.allowed) expect(res.reason).toBe("firm_inactive");
  });
});

describe("paid tiers", () => {
  it("allows every recognised paid tier", () => {
    for (const tier of [
      "firm",
      "firm_annual",
      "premium",
      // 2026-08-05, Stripe-backed paid tiers -- see tiers.ts. All carry the
      // identical PAID feature set; only the seat cap (checked separately,
      // in tiers.spec.ts) differs between them.
      "firm_starter",
      "firm_growth",
      "firm_standard",
      "firm_scale",
    ]) {
      const res = checkPaidFeatureAccess(firm({ plan_tier: tier }));
      expect(res.allowed, `tier "${tier}" should grant access`).toBe(true);
    }
  });

  it("individual is no longer a recognised paid tier -- folded into free 2026-08-09 (see worker.spec.ts for the solo-free exception, which lives in index.ts's gate wrapper, not here)", () => {
    const res = checkPaidFeatureAccess(firm({ plan_tier: "individual" }));
    expect(res.allowed).toBe(false);
  });

  it("a structurally FirmRow-shaped-but-not-literal row still satisfies checkPaidFeatureAccess (the parameter type is structural, not FirmRow-specific)", () => {
    // No `id`/`admin_email`/password fields -- proves the parameter type
    // genuinely only needs plan_tier/status, not a real FirmRow.
    const minimalSubject = { plan_tier: "firm", status: "active" };
    expect(checkPaidFeatureAccess(minimalSubject).allowed).toBe(true);
  });

  it("a paid tier is not time-bounded -- there is no expiration to check at all anymore", () => {
    expect(checkPaidFeatureAccess(firm({ plan_tier: "firm" })).allowed).toBe(true);
  });
});

describe("denial messaging", () => {
  it("does not tell a suspended account to pay us", () => {
    expect(paidFeatureDenialMessage("firm_inactive")).not.toMatch(/plan|pay|upgrade/i);
  });

  it("points a free-tier firm at picking a plan -- feature-agnostic wording (shared by Map and Practice Privilege Check, must not name either specifically)", () => {
    expect(paidFeatureDenialMessage("tier_not_paid")).toMatch(/paid firm plan/i);
    expect(paidFeatureDenialMessage("tier_not_paid")).not.toMatch(/mobility|map/i);
  });
});
