-- Self-serve subscription cancellation (2026-08-05, Devin's decision: build
-- self-serve cancel now, no refunds -- access continues to the current
-- period's end). Cancel sets cancel_at_period_end=true on the Stripe
-- subscription (NOT an immediate delete), so plan_tier does not change here
-- -- the firm keeps full access until Stripe's own customer.subscription.
-- deleted webhook fires at the real period end (already handled, reverts to
-- 'pilot'). current_period_end is display-only (a real ISO timestamp from
-- Stripe's own subscription object), never used for any access decision --
-- checkPremiumAccess() still owns that entirely, unchanged.
ALTER TABLE firms ADD COLUMN cancel_at_period_end INTEGER NOT NULL DEFAULT 0;
ALTER TABLE firms ADD COLUMN current_period_end TEXT;
