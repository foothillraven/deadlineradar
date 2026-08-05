import { describe, it, expect } from "vitest";
import {
  FIRM_TIERS,
  firmTierByPlanTier,
  firmTierForSeatCount,
  seatCapForFirmTier,
  stripePriceIdForTier,
} from "../src/tiers";
import { SELF_SERVE_SEAT_CAP } from "../src/validation";

describe("seatCapForFirmTier -- unchanged behavior for pilot/unrecognised", () => {
  it("falls back to today's SELF_SERVE_SEAT_CAP for pilot", () => {
    expect(seatCapForFirmTier("pilot")).toBe(SELF_SERVE_SEAT_CAP);
  });

  it("falls back to SELF_SERVE_SEAT_CAP for an unrecognised tier", () => {
    expect(seatCapForFirmTier("nonsense")).toBe(SELF_SERVE_SEAT_CAP);
  });

  it("returns each named tier's own cap", () => {
    expect(seatCapForFirmTier("firm_starter")).toBe(5);
    expect(seatCapForFirmTier("firm_growth")).toBe(15);
    expect(seatCapForFirmTier("firm_standard")).toBe(25);
  });
});

describe("firmTierForSeatCount -- the cheapest tier that covers a headcount", () => {
  it("picks Starter for a small firm", () => {
    expect(firmTierForSeatCount(1)?.planTier).toBe("firm_starter");
    expect(firmTierForSeatCount(5)?.planTier).toBe("firm_starter");
  });

  it("boundary: 6 staff needs Growth, not Starter", () => {
    expect(firmTierForSeatCount(6)?.planTier).toBe("firm_growth");
    expect(firmTierForSeatCount(15)?.planTier).toBe("firm_growth");
  });

  it("boundary: 16 staff needs Standard", () => {
    expect(firmTierForSeatCount(16)?.planTier).toBe("firm_standard");
    expect(firmTierForSeatCount(25)?.planTier).toBe("firm_standard");
  });

  it("returns null above 25 -- unchanged 'contact us', no defined formula", () => {
    expect(firmTierForSeatCount(26)).toBeNull();
    expect(firmTierForSeatCount(100)).toBeNull();
  });

  it("every tier is reachable and priced ascending with seat cap", () => {
    expect(FIRM_TIERS.map((t) => t.planTier)).toEqual(["firm_starter", "firm_growth", "firm_standard"]);
    for (let i = 1; i < FIRM_TIERS.length; i++) {
      expect(FIRM_TIERS[i]!.priceUsd).toBeGreaterThan(FIRM_TIERS[i - 1]!.priceUsd);
      expect(FIRM_TIERS[i]!.seatCap).toBeGreaterThan(FIRM_TIERS[i - 1]!.seatCap);
    }
  });
});

describe("firmTierByPlanTier", () => {
  it("resolves a known tier", () => {
    expect(firmTierByPlanTier("firm_growth")?.priceUsd).toBe(349);
  });

  it("returns null for pilot/individual/unrecognised -- not firm-tier lookups", () => {
    expect(firmTierByPlanTier("pilot")).toBeNull();
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
      STRIPE_PRICE_INDIVIDUAL: "price_individual_test",
    } as any;
    expect(stripePriceIdForTier(env, "firm_starter")).toBe("price_starter_test");
    expect(stripePriceIdForTier(env, "firm_growth")).toBe("price_growth_test");
    expect(stripePriceIdForTier(env, "firm_standard")).toBe("price_standard_test");
    expect(stripePriceIdForTier(env, "individual")).toBe("price_individual_test");
  });

  it("returns null when the env var isn't set (not configured) or the tier is unrecognised", () => {
    expect(stripePriceIdForTier({} as any, "firm_starter")).toBeNull();
    expect(stripePriceIdForTier({} as any, "pilot")).toBeNull();
  });
});
