-- Roadmap #31 (2026-08-09): referral program (firm refers firm, both get a
-- discount). Additive only. referral_code/referred_by_firm_id/
-- referral_reward_applied_at drive the reward flow (see index.ts's
-- handleFirmSignup/handleFirmBillingCheckout/handleStripeWebhook); signup_ip
-- is a self-referral fraud check, same "raw IP stored for exactly this kind
-- of fraud/dispute evidence" precedent as migration 0057's consent_ip.
--
-- referral_code is NULL for every pre-migration row on purpose -- lazily
-- generated on first dashboard touch (store.ts's getOrCreateReferralCode()),
-- not backfilled. NULL here is an expected state for an untouched old row,
-- not an error.
ALTER TABLE firms ADD COLUMN referral_code TEXT;
ALTER TABLE firms ADD COLUMN referred_by_firm_id TEXT REFERENCES firms(id);
ALTER TABLE firms ADD COLUMN referral_reward_applied_at TEXT;
ALTER TABLE firms ADD COLUMN signup_ip TEXT;
-- Adversarial review (2026-08-09): deliberately SEPARATE from
-- referral_reward_applied_at above. That column means "this firm's own
-- one-time referred-checkout discount was spent" and is set unconditionally
-- the moment this firm's first paid checkout completes, regardless of
-- whether the REFERRER turns out to be eligible for anything (free tier,
-- demo-locked, a failed Stripe call). referrer_rewarded_at means "the
-- REFERRER actually received a Stripe discount because of THIS firm's
-- conversion" -- set only on success, read by countRewardedReferrals() for
-- the dashboard's "N firms have earned you a reward" count, which would
-- otherwise overcount referrals that consumed their own discount but never
-- actually earned the referrer anything.
ALTER TABLE firms ADD COLUMN referrer_rewarded_at TEXT;

CREATE UNIQUE INDEX idx_firms_referral_code ON firms (referral_code);
CREATE INDEX idx_firms_referred_by_firm_id ON firms (referred_by_firm_id);
