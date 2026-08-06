-- Task #33 (2026-08-06, Devin + orchestrator decision): "pilot" is no
-- longer a time-boxed trial -- Roster/Calendar/CPE Hours are a standing
-- FREE tier with no expiration, and Map/Practice Privilege Check always
-- require an actual paid tier (never unlocked by pilot/free status, not
-- even temporarily). The 30-day pilot concept did no gating work left to
-- do, so the name is retired everywhere: this renames the value on every
-- existing row, and createFirm()/the Stripe webhook's cancellation-revert
-- branch now both write 'free' for every new/reverted firm going forward.
UPDATE firms SET plan_tier = 'free' WHERE plan_tier = 'pilot';
