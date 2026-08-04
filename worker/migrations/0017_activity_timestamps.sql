-- Adds the two real facts the dashboard's Recent Activity feed was missing:
-- when a roster row was last edited, and when it was last marked renewed.
-- Both were previously absent from the schema entirely (see toFirmLicenseJson's
-- old comment in index.ts) -- PATCH and the renew route stamp these going
-- forward; existing rows stay NULL, which correctly means "never."
ALTER TABLE subscribers ADD COLUMN last_edited_at TEXT;
ALTER TABLE subscribers ADD COLUMN renewed_at TEXT;
