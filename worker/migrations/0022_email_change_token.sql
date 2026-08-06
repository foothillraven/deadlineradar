-- Task #29 (2026-08-05): self-serve admin-email change.
--
-- Same "carry INTENT on the token row" pattern migration 0013 established for
-- password_reset -- but email-change also needs to carry the actual TARGET
-- VALUE, not just an intent flag, since redemption must apply exactly the
-- address that was verified as reachable (the one the link was emailed to),
-- never whatever the redeeming request happens to submit. Nullable: every
-- other purpose leaves this NULL and unused.
ALTER TABLE firm_login_tokens ADD COLUMN pending_new_email TEXT;
