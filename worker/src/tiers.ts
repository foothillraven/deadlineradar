/**
 * Tier metadata for paid firm plans (2026-08-05). Kept separate from the
 * allow/deny logic in entitlements.ts, mirroring how mobility.ts stays
 * separate from index.ts -- one module owns "what a tier IS", the other owns
 * "does this session get through the gate".
 *
 * Every firm tier gets the IDENTICAL feature set (Roster, Calendar, Map, CPE
 * Hours, Practice Privilege Check) -- gated by staff-count capacity only,
 * never by capability. This is a deliberate reaction to CE Broker's #1
 * review complaint (crippling their cheap tier's features to force
 * upgrades); do not add a capability difference between these tiers.
 */

import type { Env } from "./env";
import { SELF_SERVE_SEAT_CAP } from "./validation";

export interface FirmTierDef {
  planTier: string;
  label: string;
  priceUsd: number;
  seatCap: number;
}

// Ordered ascending by seat cap -- firmTierForSeatCount() below depends on
// that order to find the cheapest tier a given headcount qualifies for.
// Labels renamed 2026-08-06 (Devin's pick) -- planTier slugs (firm_starter/
// firm_growth/firm_standard) are internal identifiers, stored in D1 and read
// by stripePriceIdForTier()'s switch below; they stay as-is, only `label`
// (the customer-facing name) changed.
export const FIRM_TIERS: FirmTierDef[] = [
  { planTier: "firm_starter", label: "Essentials", priceUsd: 199, seatCap: 5 },
  { planTier: "firm_growth", label: "Professional", priceUsd: 349, seatCap: 15 },
  { planTier: "firm_standard", label: "Enterprise", priceUsd: 500, seatCap: 25 },
];

export const INDIVIDUAL_TIER = { planTier: "individual", label: "Individual", priceUsd: 39 } as const;

const FIRM_TIER_SEAT_CAPS: Record<string, number> = Object.fromEntries(
  FIRM_TIERS.map((t) => [t.planTier, t.seatCap])
);

/** Today's pilot ceiling (SELF_SERVE_SEAT_CAP) is the fallback for `pilot`
 * and any unrecognised tier -- unchanged behavior for every firm that hasn't
 * converted to a named paid tier yet. */
export function seatCapForFirmTier(planTier: string): number {
  return FIRM_TIER_SEAT_CAPS[planTier] ?? SELF_SERVE_SEAT_CAP;
}

/** The cheapest firm tier whose seat cap covers `seatCount`, or null if no
 * defined tier covers it (25+ staff -- unchanged "contact us", no formula,
 * Devin's explicit call). Checkout must never let a firm buy a tier smaller
 * than this for its current roster. */
export function firmTierForSeatCount(seatCount: number): FirmTierDef | null {
  return FIRM_TIERS.find((t) => seatCount <= t.seatCap) ?? null;
}

export function firmTierByPlanTier(planTier: string): FirmTierDef | null {
  return FIRM_TIERS.find((t) => t.planTier === planTier) ?? null;
}

/** Which Env secret holds this tier's Stripe Price id. Test-mode and
 * live-mode prices are different ids on the same Stripe account, so this
 * indirection (rather than a hardcoded id) is what makes the Gate 1 -> Gate 2
 * swap a pure secret rotation. Returns null for an unrecognised tier. */
export function stripePriceIdForTier(env: Env, planTier: string): string | null {
  switch (planTier) {
    case "firm_starter":
      return env.STRIPE_PRICE_FIRM_STARTER ?? null;
    case "firm_growth":
      return env.STRIPE_PRICE_FIRM_GROWTH ?? null;
    case "firm_standard":
      return env.STRIPE_PRICE_FIRM_STANDARD ?? null;
    case "individual":
      return env.STRIPE_PRICE_INDIVIDUAL ?? null;
    default:
      return null;
  }
}
