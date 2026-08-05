-- Devin (2026-08-05): "Do we ever ask for the Admin's name... to make the
-- email more personal when I email them." Nothing did -- signup only ever
-- collected the firm's name and the admin's email. Optional, nullable: a
-- firm that signed up before this column existed (and anyone who skips the
-- field going forward) has admin_name = NULL, and every reader of this
-- column already treats a missing personal name as "fall back to generic
-- copy" rather than an error.
ALTER TABLE firms ADD COLUMN admin_name TEXT;
