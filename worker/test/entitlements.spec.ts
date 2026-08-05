import { describe, it, expect } from "vitest";
import {
  checkPremiumAccess,
  pilotDaysRemaining,
  entitlementMessage,
  PILOT_DAYS,
} from "../src/entitlements";

const NOW = new Date("2026-07-30T12:00:00Z");

function firm(over: Partial<{ plan_tier: string; status: string; created_at: string }> = {}) {
  return {
    plan_tier: "pilot",
    status: "active",
    created_at: "2026-07-20T12:00:00Z", // 10 days in
    ...over,
  };
}

describe("premium entitlement -- fails closed", () => {
  it("denies an unrecognised plan tier rather than defaulting open", () => {
    // A typo in a tier name must lock the feature, not unlock it.
    for (const tier of ["", "Firm", "FIRM", "enterprise", "free", "trial", "premuim"]) {
      const res = checkPremiumAccess(firm({ plan_tier: tier }), NOW);
      expect(res.allowed, `tier "${tier}" must not grant access`).toBe(false);
    }
  });

  it("denies an inactive firm EVEN ON A PAID TIER", () => {
    // A suspended account with a paid tier must not retain access.
    const res = checkPremiumAccess(firm({ plan_tier: "firm", status: "suspended" }), NOW);
    expect(res.allowed).toBe(false);
    if (!res.allowed) expect(res.reason).toBe("firm_inactive");
  });

  it("denies when created_at is missing or unparseable, rather than granting an unbounded pilot", () => {
    for (const created of ["", "not-a-date", "0000-13-45"]) {
      const res = checkPremiumAccess(firm({ created_at: created }), NOW);
      expect(res.allowed, `created_at "${created}" must not grant access`).toBe(false);
    }
  });
});

describe("paid tiers", () => {
  it("allows the recognised premium tiers", () => {
    for (const tier of [
      "firm",
      "firm_annual",
      "premium",
      // 2026-08-05, Stripe-backed paid tiers -- see tiers.ts. All four carry
      // the identical feature set as the original three; only the seat cap
      // (checked separately, in tiers.spec.ts) differs between them.
      "firm_starter",
      "firm_growth",
      "firm_standard",
      "individual",
    ]) {
      const res = checkPremiumAccess(firm({ plan_tier: tier }), NOW);
      expect(res.allowed, `tier "${tier}" should grant access`).toBe(true);
      if (res.allowed) expect(res.via).toBe("paid_tier");
    }
  });

  it("an individual_accounts-shaped row (not a FirmRow) satisfies checkPremiumAccess structurally", () => {
    // No `id`/`admin_email`/password fields -- proves the parameter type is
    // genuinely structural, not accidentally still FirmRow-specific.
    const individualAccount = { plan_tier: "individual", status: "active", created_at: "2026-07-25T12:00:00Z" };
    const res = checkPremiumAccess(individualAccount, NOW);
    expect(res.allowed).toBe(true);
  });

  it("a paid tier is not time-bounded -- an old account still has access", () => {
    const res = checkPremiumAccess(
      firm({ plan_tier: "firm", created_at: "2020-01-01T00:00:00Z" }),
      NOW
    );
    expect(res.allowed).toBe(true);
  });
});

describe("the free pilot window", () => {
  it("allows a pilot inside the window", () => {
    const res = checkPremiumAccess(firm({ created_at: "2026-07-25T12:00:00Z" }), NOW);
    expect(res.allowed).toBe(true);
    if (res.allowed) {
      expect(res.via).toBe("active_pilot");
      expect(res.pilotDaysRemaining).toBe(PILOT_DAYS - 5);
    }
  });

  it("denies a pilot past the window", () => {
    const res = checkPremiumAccess(firm({ created_at: "2026-05-01T12:00:00Z" }), NOW);
    expect(res.allowed).toBe(false);
    if (!res.allowed) expect(res.reason).toBe("pilot_expired");
  });

  it("boundary: day 29 allowed, day 30 and beyond denied", () => {
    // PILOT_DAYS - elapsed > 0, so elapsed 29 -> 1 remaining (allowed),
    // elapsed 30 -> 0 remaining (denied). Asserted explicitly because an
    // off-by-one here either robs a customer of a day or gives a free one.
    const day29 = new Date(Date.parse("2026-07-20T12:00:00Z") + 29 * 86_400_000);
    const day30 = new Date(Date.parse("2026-07-20T12:00:00Z") + 30 * 86_400_000);
    expect(checkPremiumAccess(firm(), day29).allowed).toBe(true);
    expect(checkPremiumAccess(firm(), day30).allowed).toBe(false);
  });

  it("reports days remaining for the UI", () => {
    expect(pilotDaysRemaining({ created_at: "2026-07-20T12:00:00Z" }, NOW)).toBe(PILOT_DAYS - 10);
    expect(pilotDaysRemaining({ created_at: "" }, NOW)).toBeNull();
  });
});

describe("denial messaging", () => {
  it("does not tell a suspended account to pay us", () => {
    expect(entitlementMessage("firm_inactive")).not.toMatch(/plan|pay|upgrade/i);
  });

  it("explains the pilot ended, and that mobility is a paid feature", () => {
    expect(entitlementMessage("pilot_expired")).toMatch(/pilot/i);
    expect(entitlementMessage("pilot_expired")).toMatch(/paid firm plan/i);
    expect(entitlementMessage("tier_not_premium")).toMatch(/paid firm plan/i);
  });
});
