-- Roadmap #16 (2026-08-07): bulk staff tagging/grouping (by office or department).
--
-- A single free-text label per roster row, same "cosmetic-only free text" shape as
-- subscribers.staff_label (migration 0008) -- sanitized/capped via the same sanitizeFreeText()
-- helper, not a foreign-keyed office/department table. This product has no concept of a firm's
-- real office structure (no address book, no org chart) -- a plain string an admin fills in
-- themselves ("Downtown office", "Audit team", "Tax dept") is honest about that; a normalized
-- table would imply structure this product doesn't actually track or enforce.
ALTER TABLE subscribers ADD COLUMN office_tag TEXT;
