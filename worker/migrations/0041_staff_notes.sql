-- Roadmap #68 (2026-08-07): internal-only custom notes field per staff member.
--
-- Same "cosmetic free text" shape as office_tag (migration 0037)/staff_label
-- (migration 0008) -- sanitized/capped via sanitizeFreeText(), never shown to
-- the subscriber themselves or anywhere outside the firm's own dashboard.
ALTER TABLE subscribers ADD COLUMN internal_notes TEXT;
