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
// firm_growth/firm_standard/firm_scale) are internal identifiers, stored in
// D1 and read by stripePriceIdForTier()'s switch below; they stay as-is,
// only `label` (the customer-facing name) changes.
//
// Re-tiered 2026-08-09 (Devin's own proposal, via orchestrator): the old
// 3-band flat-fee structure (199/5, 349/15, 500/25) had real cliffs -- one
// hire past a boundary jumped the WHOLE invoice (5->6 staff was +75%). This
// 4-band structure smooths that: the worst single-hire jump is now +50%
// (5->6), +33% (10->11), +38% (20->21). firm_starter/firm_growth/
// firm_standard REUSE their existing slugs with new price/cap (no real
// paying customers existed on any paid tier at the time of this change, so
// no migration concern) -- firm_scale is the one genuinely NEW slug, for
// the new top band. Labels shifted up one level to match: "Enterprise" now
// means the real top tier (35 seats), not the old 25-seat one.
export const FIRM_TIERS: FirmTierDef[] = [
  { planTier: "firm_starter", label: "Essentials", priceUsd: 199, seatCap: 5 },
  { planTier: "firm_growth", label: "Growth", priceUsd: 299, seatCap: 10 },
  { planTier: "firm_standard", label: "Professional", priceUsd: 399, seatCap: 20 },
  { planTier: "firm_scale", label: "Enterprise", priceUsd: 549, seatCap: 35 },
];

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
 * defined tier covers it (35+ staff as of the 2026-08-09 re-tier -- unchanged
 * "contact us", no formula, Devin's explicit call). Checkout must never let
 * a firm buy a tier smaller than this for its current roster. */
export function firmTierForSeatCount(seatCount: number): FirmTierDef | null {
  return FIRM_TIERS.find((t) => seatCount <= t.seatCap) ?? null;
}

export function firmTierByPlanTier(planTier: string): FirmTierDef | null {
  return FIRM_TIERS.find((t) => t.planTier === planTier) ?? null;
}

/** Which Env secret holds this tier's Stripe Price id. Test-mode and
 * live-mode prices are different ids on the same Stripe account, so this
 * indirection (rather than a hardcoded id) is what makes the Gate 1 -> Gate 2
 * swap a pure secret rotation. Returns null for an unrecognised tier.
 *
 * `INDIVIDUAL_TIER`/`"individual"` REMOVED 2026-08-09 (Devin's decision):
 * the $39/yr Individual tier never had a real checkout path (this switch's
 * own "individual" case was unreachable from handleFirmBillingCheckout(),
 * which resolves tiers via firmTierByPlanTier() -- FIRM_TIERS only, never
 * included INDIVIDUAL_TIER) and zero real rows ever held plan_tier=
 * 'individual' (confirmed against prod D1 before removing). Folded into
 * the free tier -- see entitlements.ts's own solo-free exception. */
export function stripePriceIdForTier(env: Env, planTier: string): string | null {
  switch (planTier) {
    case "firm_starter":
      return env.STRIPE_PRICE_FIRM_STARTER ?? null;
    case "firm_growth":
      return env.STRIPE_PRICE_FIRM_GROWTH ?? null;
    case "firm_standard":
      return env.STRIPE_PRICE_FIRM_STANDARD ?? null;
    case "firm_scale":
      return env.STRIPE_PRICE_FIRM_SCALE ?? null;
    default:
      return null;
  }
}
