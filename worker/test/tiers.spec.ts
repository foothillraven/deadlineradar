import { describe, it, expect } from "vitest";
import {
  FIRM_TIERS,
  firmTierByPlanTier,
  firmTierForSeatCount,
  seatCapForFirmTier,
  stripePriceIdForTier,
} from "../src/tiers";
import { SELF_SERVE_SEAT_CAP } from "../src/validation";

describe("seatCapForFirmTier -- unchanged behavior for free/unrecognised", () => {
  it("falls back to today's SELF_SERVE_SEAT_CAP for the free tier", () => {
    expect(seatCapForFirmTier("free")).toBe(SELF_SERVE_SEAT_CAP);
  });

  it("falls back to SELF_SERVE_SEAT_CAP for an unrecognised tier", () => {
    expect(seatCapForFirmTier("nonsense")).toBe(SELF_SERVE_SEAT_CAP);
  });

  it("returns each named tier's own cap", () => {
    expect(seatCapForFirmTier("firm_starter")).toBe(5);
    expect(seatCapForFirmTier("firm_growth")).toBe(10);
    expect(seatCapForFirmTier("firm_standard")).toBe(20);
    expect(seatCapForFirmTier("firm_scale")).toBe(35);
  });
});

describe("firmTierForSeatCount -- the cheapest tier that covers a headcount (2026-08-09 4-band re-tier)", () => {
  it("picks Starter for a small firm", () => {
    expect(firmTierForSeatCount(1)?.planTier).toBe("firm_starter");
    expect(firmTierForSeatCount(5)?.planTier).toBe("firm_starter");
  });

  it("boundary: 6 staff needs Growth, not Starter", () => {
    expect(firmTierForSeatCount(6)?.planTier).toBe("firm_growth");
    expect(firmTierForSeatCount(10)?.planTier).toBe("firm_growth");
  });

  it("boundary: 11 staff needs Standard (Professional)", () => {
    expect(firmTierForSeatCount(11)?.planTier).toBe("firm_standard");
    expect(firmTierForSeatCount(20)?.planTier).toBe("firm_standard");
  });

  it("boundary: 21 staff needs Scale (Enterprise)", () => {
    expect(firmTierForSeatCount(21)?.planTier).toBe("firm_scale");
    expect(firmTierForSeatCount(35)?.planTier).toBe("firm_scale");
  });

  it("returns null above 35 -- unchanged 'contact us', no defined formula", () => {
    expect(firmTierForSeatCount(36)).toBeNull();
    expect(firmTierForSeatCount(100)).toBeNull();
  });

  it("every tier is reachable and priced ascending with seat cap", () => {
    expect(FIRM_TIERS.map((t) => t.planTier)).toEqual(["firm_starter", "firm_growth", "firm_standard", "firm_scale"]);
    for (let i = 1; i < FIRM_TIERS.length; i++) {
      expect(FIRM_TIERS[i]!.priceUsd).toBeGreaterThan(FIRM_TIERS[i - 1]!.priceUsd);
      expect(FIRM_TIERS[i]!.seatCap).toBeGreaterThan(FIRM_TIERS[i - 1]!.seatCap);
    }
  });

  it("no single-hire jump exceeds the old worst case (+75%) -- proves the 'no cliffs' goal, not just new numbers", () => {
    for (let i = 1; i < FIRM_TIERS.length; i++) {
      const jumpRatio = FIRM_TIERS[i]!.priceUsd / FIRM_TIERS[i - 1]!.priceUsd;
      expect(jumpRatio).toBeLessThan(1.75);
    }
  });
});

describe("firmTierByPlanTier", () => {
  it("resolves a known tier", () => {
    expect(firmTierByPlanTier("firm_growth")?.priceUsd).toBe(299);
    expect(firmTierByPlanTier("firm_scale")?.priceUsd).toBe(549);
  });

  it("returns null for free/individual/unrecognised -- not firm-tier lookups", () => {
    expect(firmTierByPlanTier("free")).toBeNull();
    expect(firmTierByPlanTier("individual")).toBeNull();
    expect(firmTierByPlanTier("bogus")).toBeNull();
  });
});

describe("stripePriceIdForTier", () => {
  it("reads the tier-specific env var, not a hardcoded id", () => {
    const env = {
      STRIPE_PRICE_FIRM_STARTER: "price_starter_test",
      STRIPE_PRICE_FIRM_GROWTH: "price_growth_test",
      STRIPE_PRICE_FIRM_STANDARD: "price_standard_test",
      STRIPE_PRICE_FIRM_SCALE: "price_scale_test",
    } as any;
    expect(stripePriceIdForTier(env, "firm_starter")).toBe("price_starter_test");
    expect(stripePriceIdForTier(env, "firm_growth")).toBe("price_growth_test");
    expect(stripePriceIdForTier(env, "firm_standard")).toBe("price_standard_test");
    expect(stripePriceIdForTier(env, "firm_scale")).toBe("price_scale_test");
  });

  it("returns null when the env var isn't set (not configured) or the tier is unrecognised", () => {
    expect(stripePriceIdForTier({} as any, "firm_starter")).toBeNull();
    expect(stripePriceIdForTier({} as any, "firm_scale")).toBeNull();
    expect(stripePriceIdForTier({} as any, "free")).toBeNull();
  });

  it("individual is no longer a recognised tier -- folded into free 2026-08-09", () => {
    expect(stripePriceIdForTier({ STRIPE_PRICE_FIRM_STARTER: "x" } as any, "individual")).toBeNull();
  });
});
