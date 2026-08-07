-- Roadmap #28 (2026-08-06, roadmap_items table, IMMEDIATE RELEASE, "Guided
-- onboarding checklist for new firm signups"). Same shape as
-- feature_questionnaire_dismissed_at (migration 0029): NULL = still show
-- the checklist, set (explicit dismiss) = never show it again for this
-- firm. Unlike the questionnaire, this checklist doesn't auto-dismiss on
-- "completion" -- a firm that's checked off every item can still see it
-- (nothing left to hide urgently), it just also gets a manual dismiss
-- option, same one-column pattern either way.
ALTER TABLE firms ADD COLUMN onboarding_checklist_dismissed_at TEXT;
