/**
 * Which firms may use PAID features -- Map and Practice Privilege Check,
 * specifically (2026-08-06, Devin + orchestrator decision).
 *
 * ## What changed, and why this file is now much smaller
 *
 * Until this date, EVERY firm-scoped route (Roster, Calendar, CPE Hours,
 * Map, Practice Privilege Check -- everything) went through this same
 * check, and a firm within its 30-day "pilot" window passed it exactly like
 * a paying customer would. That was a deliberate choice at the time
 * (avoiding CE Broker's #1 review complaint about crippling a cheap tier to
 * force upgrades). Devin reversed it directly: Roster/Calendar/CPE Hours
 * are now a standing FREE tier with NO expiration, ever -- those routes no
 * longer call anything in this file at all, just requireFirmSession()
 * (active status, nothing about plan_tier). Map and Practice Privilege
 * Check are the only two features this file still gates, and they get NO
 * free-tier exception whatsoever -- not even temporarily during what used
 * to be the pilot window. (The public demo account, not a temporary trial
 * unlock, is the "see it before you pay" path for these two now.)
 *
 * `PILOT_DAYS`/`pilotDaysRemaining()` are gone with the pilot concept they
 * measured -- a firm's free tier no longer counts down toward anything, so
 * there is nothing left for that math to do. See migration 0028 for the
 * plan_tier rename ('pilot' -> 'free') this went along with.
 *
 * ## Structural, not FirmRow-specific
 *
 * `checkPaidFeatureAccess()` takes an `EntitlementSubject` (plan_tier/
 * status) rather than a `FirmRow`-literal pick, so both `firms` rows and
 * the `individual_accounts` rows (2026-08-05 paid-tiers migration) satisfy
 * it with zero body changes.
 *
 * ## Billing is real
 *
 * `firms.stripe_customer_id`/`stripe_subscription_id` (migration 0018) and
 * the `/stripe/webhook` handler in index.ts are what flip `plan_tier` --
 * `checkPaidFeatureAccess()` itself still only reads `plan_tier`/`status`
 * and knows nothing about Stripe, same separation of concerns as before.
 *
 * ## Fail closed
 *
 * An unrecognised plan_tier denies access. Adding a new paid tier means
 * adding it to PAID_PLAN_TIERS deliberately -- a typo in a tier name locks
 * a feature rather than unlocking it, which is the correct direction for a
 * gate.
 */

import type { FirmRow } from "./store";

/** Anything with these two fields can be checked -- `firms` rows and
 * `individual_accounts` rows both satisfy this structurally, no cast
 * needed. */
export type EntitlementSubject = Pick<FirmRow, "plan_tier" | "status">;

/** Tiers that unlock Map/Practice Privilege Check. `free` (the renamed
 * `pilot`) is deliberately NOT here -- the free tier never includes these
 * two features via THIS check, regardless of how long the firm has had an
 * account (see requireFirmSessionAndPaidTier() in index.ts for the one
 * additional, separate exception: a genuinely solo -- exactly one
 * firm_member -- free-tier firm, 2026-08-09). `firm`/`firm_annual`/
 * `premium` are the original manually-set tiers (still honored -- no
 * existing row is migrated off them); `firm_starter`/`firm_growth`/
 * `firm_standard`/`firm_scale` are the Stripe-backed tiers (2026-08-05, see
 * tiers.ts; `firm_scale` added in the 2026-08-09 seat-cliff re-tier). All
 * paid firm tiers carry the identical PAID feature set -- this set gates
 * access to Map/Practice Privilege Check specifically, not to the free
 * features at all.
 *
 * `"individual"` REMOVED 2026-08-09 (Devin's decision, orchestrator 14:25
 * block): the $39/yr Individual tier had no live checkout anywhere in this
 * Worker (confirmed: firmTierByPlanTier("individual") already returned
 * null, so the self-serve checkout path 400'd on it) and zero real rows
 * ever had this value (confirmed against prod D1 before removing). Folded
 * into the free tier instead of ever being built -- see the solo-free
 * exception above. */
const PAID_PLAN_TIERS = new Set([
  "firm",
  "firm_annual",
  "premium",
  "firm_starter",
  "firm_growth",
  "firm_standard",
  "firm_scale",
]);

export type PaidFeatureDenialReason = "firm_inactive" | "tier_not_paid";

export type PaidFeatureResult = { allowed: true } | { allowed: false; reason: PaidFeatureDenialReason };

/**
 * The single place that decides Map/Practice Privilege Check access. Every
 * route gating either of those two features must call this rather than
 * reimplementing the check, so there is one thing to audit and one thing to
 * change when a tier is added or removed.
 *
 * Order matters: an inactive firm is denied regardless of tier, because a
 * suspended account with a paid tier must not retain access.
 */
export function checkPaidFeatureAccess(firm: EntitlementSubject): PaidFeatureResult {
  if (firm.status !== "active") {
    return { allowed: false, reason: "firm_inactive" };
  }
  if (PAID_PLAN_TIERS.has(firm.plan_tier)) {
    return { allowed: true };
  }
  return { allowed: false, reason: "tier_not_paid" };
}

/** User-facing copy per denial reason. Deliberately never says "pay us" to
 * a firm whose account is suspended -- that would be both wrong and
 * irritating. */
export function paidFeatureDenialMessage(reason: PaidFeatureDenialReason): string {
  switch (reason) {
    case "firm_inactive":
      return "This account isn't active. Get in touch and we'll sort it out.";
    case "tier_not_paid":
      return "This feature is part of a paid firm plan. Pick a plan to continue.";
  }
}

/**
 * Roadmap #151 ("move the value line", 2026-08-10). Devin's own instruction,
 * relayed via orchestrator: the new, narrower free tier (seat cap 3,
 * document storage gated, multi-channel alerts gated, admin-dashboard
 * synthesis gated, firm-wide reminders gated) applies to NEW SIGNUPS ONLY --
 * "grandfather existing free accounts at their current entitlements."
 *
 * A firm's grandfather status is keyed on `created_at` vs. this ONE fixed
 * cutover, set once (the moment Phase 0 of #151 shipped) and never
 * redefined by any later phase -- so a firm's status can never depend on
 * which of the five gated features happened to ship first. This is a
 * THIRD, structurally simpler kind of free-tier exception alongside the
 * existing two in requireFirmSessionAndPaidTier() (solo-free member-count,
 * roadmap #153's query-budget trial): no extra DB query, since `created_at`
 * is already on every loaded FirmRow.
 *
 * Every one of the five #151 gates becomes the same shape:
 * `checkPaidFeatureAccess(firm).allowed || isPreCutoverSignup(firm.created_at)`.
 * Deliberately NOT folded into checkPaidFeatureAccess() itself -- same
 * "pure tier check stays pure, exceptions get bolted on at each call site"
 * principle this file's own docstring already establishes for the solo-free
 * exception.
 */
export const VALUE_LINE_CUTOVER_DATE = "2026-08-10T03:05:00Z";

export function isPreCutoverSignup(createdAt: string): boolean {
  return createdAt < VALUE_LINE_CUTOVER_DATE;
}

/** The shared OR every one of #151's five gates uses -- a real paid tier, OR
 * grandfathered by signup date. One function so every call site (document
 * handlers, Slack/Teams connect + send passes, the dashboard-synthesis
 * response flag, the seat-cap lookup) audits identically, matching this
 * file's own "one thing to change when the rule changes" principle. NOT
 * used by Map/Practice Privilege Check -- those keep their own, different
 * exceptions (solo-free member-count, roadmap #153's query-budget trial) in
 * requireFirmSessionAndPaidTier(), which this function has no relationship
 * to. */
export function hasValueLineAccess(firm: EntitlementSubject & { created_at: string }): boolean {
  return checkPaidFeatureAccess(firm).allowed || isPreCutoverSignup(firm.created_at);
}
