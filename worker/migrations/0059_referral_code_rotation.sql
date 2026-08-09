-- Referral program v2 (2026-08-09): referral_code (migration 0058) is now
-- MUTABLE -- rotated on every paid invoice (see handleStripeWebhook's
-- invoice.created branch in index.ts), not permanent. referral_code_uses
-- resets to 0 every time a new code is minted (store.ts's
-- mintReferralCode()); the old code string is simply overwritten and
-- orphaned -- nothing else ever stores it, so the old code stops resolving
-- immediately, matching the "old code dies the instant a new one mints"
-- requirement.
ALTER TABLE firms ADD COLUMN referral_code_uses INTEGER NOT NULL DEFAULT 0;
