/**
 * Which firms/individuals may use premium features (2026-07-30, mobility
 * phase; generalized 2026-08-05 for Stripe-backed paid tiers).
 *
 * This is the FIRST entitlement logic in the codebase -- until now every
 * firm-scoped route was available to any authenticated firm. Mobility is
 * the first pay-gated feature, per its directive ("Behind the pay gate --
 * part of the premium firm tier, not the free public pages").
 *
 * ## Structural, not FirmRow-specific
 *
 * `checkPremiumAccess()` takes an `EntitlementSubject` (plan_tier/status/
 * created_at) rather than a `FirmRow`-literal pick, so both `firms` rows and
 * the new `individual_accounts` rows (2026-08-05 paid-tiers migration)
 * satisfy it with zero body changes -- an individual's $39/yr tier reuses
 * the exact same pilot math as a firm's, on purpose (see tiers.ts for what
 * each tier actually includes/costs).
 *
 * ## Billing is real now
 *
 * `firms.stripe_customer_id`/`stripe_subscription_id` (migration 0018) and
 * the `/stripe/webhook` handler in index.ts are what flip `plan_tier` today
 * -- `checkPremiumAccess()` itself still only reads `plan_tier`/`status`/
 * `created_at` and knows nothing about Stripe, same separation of concerns
 * as before.
 *
 * ## Fail closed
 *
 * An unrecognised plan_tier denies access. Adding a new tier means adding
 * it to PREMIUM_PLAN_TIERS deliberately -- a typo in a tier name locks a
 * feature rather than unlocking it, which is the correct direction for a
 * gate.
 */

import type { FirmRow } from "./store";

/** The free pilot. Matches the public promise on /for-firms/ ("a 30-day
 * pilot, no card required") -- if that copy changes, this must too. */
export const PILOT_DAYS = 30;

/** Anything with these three fields can be checked -- `firms` rows and
 * `individual_accounts` rows both satisfy this structurally, no cast
 * needed. */
export type EntitlementSubject = Pick<FirmRow, "plan_tier" | "status" | "created_at">;

/** Tiers that include premium features. `pilot` is NOT here: pilot access
 * is time-bounded and handled separately below, so an expired pilot cannot
 * pass by tier name alone. `firm`/`firm_annual`/`premium` are the original
 * manually-set tiers (still honored -- no existing row is migrated off
 * them); `firm_starter`/`firm_growth`/`firm_standard`/`individual` are the
 * Stripe-backed tiers (2026-08-05, see tiers.ts). All four paid firm tiers
 * carry the IDENTICAL feature set -- this set gates access, not capability. */
const PREMIUM_PLAN_TIERS = new Set([
  "firm",
  "firm_annual",
  "premium",
  "firm_starter",
  "firm_growth",
  "firm_standard",
  "individual",
]);

export type EntitlementDenialReason =
  | "firm_inactive"
  | "pilot_expired"
  | "tier_not_premium";

export type EntitlementResult =
  | { allowed: true; via: "paid_tier" | "active_pilot"; pilotDaysRemaining: number | null }
  | { allowed: false; reason: EntitlementDenialReason; pilotDaysRemaining: number | null };

/** Whole days remaining in the pilot, or null if the created_at timestamp
 * is missing/unparseable (which denies rather than grants -- see below). */
export function pilotDaysRemaining(firm: Pick<EntitlementSubject, "created_at">, now: Date): number | null {
  if (!firm.created_at) return null;
  const created = Date.parse(firm.created_at);
  if (Number.isNaN(created)) return null;
  const elapsedDays = Math.floor((now.getTime() - created) / 86_400_000);
  const remaining = PILOT_DAYS - elapsedDays;
  // A FUTURE created_at would otherwise yield more than a full pilot --
  // e.g. a 2030 date evaluated today returned 1281 days, contradicting
  // this module's own claim that a corrupt timestamp cannot grant an
  // unbounded pilot. Not user-reachable today (no UPDATE firms exists in
  // production code) but the invariant was claimed and not held.
  if (remaining > PILOT_DAYS) return null;
  return remaining;
}

/**
 * The single place that decides premium access. Every pay-gated route must
 * call this rather than reimplementing the check, so there is one thing to
 * audit and one thing to change when billing lands.
 *
 * Order matters: an inactive firm is denied regardless of tier, because a
 * suspended account with a paid tier must not retain access.
 */
export function checkPremiumAccess(
  firm: EntitlementSubject,
  now: Date = new Date()
): EntitlementResult {
  const remaining = pilotDaysRemaining(firm, now);

  if (firm.status !== "active") {
    return { allowed: false, reason: "firm_inactive", pilotDaysRemaining: remaining };
  }

  if (PREMIUM_PLAN_TIERS.has(firm.plan_tier)) {
    return { allowed: true, via: "paid_tier", pilotDaysRemaining: remaining };
  }

  if (firm.plan_tier === "pilot") {
    // An unparseable/missing created_at yields null, which denies. A
    // corrupt timestamp must not grant an unbounded free pilot.
    if (remaining !== null && remaining > 0) {
      return { allowed: true, via: "active_pilot", pilotDaysRemaining: remaining };
    }
    return { allowed: false, reason: "pilot_expired", pilotDaysRemaining: remaining };
  }

  // Unrecognised tier -> denied. Fail closed.
  return { allowed: false, reason: "tier_not_premium", pilotDaysRemaining: remaining };
}

/** User-facing copy per denial reason. Deliberately never says "pay us" to
 * a firm whose account is suspended -- that would be both wrong and
 * irritating. */
export function entitlementMessage(reason: EntitlementDenialReason): string {
  switch (reason) {
    case "firm_inactive":
      return "This account isn't active. Get in touch and we'll sort it out.";
    case "pilot_expired":
      return "Your 30-day pilot has ended. Mobility checks are part of the paid firm plan -- get in touch to continue.";
    case "tier_not_premium":
      return "Mobility checks are part of the paid firm plan. Get in touch and we'll set you up.";
  }
}
