-- Roadmap #30 (2026-08-07, roadmap_items table, IMMEDIATE RELEASE, "In-app
-- product tour / tooltips for first-time users"). Same idempotent-dismiss
-- shape as feature_questionnaire_dismissed_at (0029) and
-- onboarding_checklist_dismissed_at (0030): NULL = still show the tour on
-- next load, set (skip or finish) = never auto-show again. A firm can still
-- replay it voluntarily from the Account tab -- that's a client-side-only
-- action and doesn't touch this column.
ALTER TABLE firms ADD COLUMN product_tour_dismissed_at TEXT;
