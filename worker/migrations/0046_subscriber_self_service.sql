-- Roadmap #12 (2026-08-07): staff self-service profile management.
--
-- Devin's approved scope: subscribers may self-edit their own display name
-- (first_name, already subscriber-supplied at signup), their own contact
-- email, and their own communication preferences -- never the compliance
-- data (state, license type, deadline), which stays firm-admin-only. See
-- the approved plan (hazy-cooking-codd.md) for the full reasoning, in
-- particular why email self-change is safe even for firm-tracked rows
-- (it moves where THEIR reminders land; it never removes them from a
-- firm's coverage) while first_name/staff_label stay on the existing split
-- the schema already drew.

-- Same "carry INTENT + TARGET VALUE on the token row" pattern migrations
-- 0013/0022 established for firm_login_tokens -- a subscriber email change
-- must apply exactly the address that was verified as reachable (the one
-- the link was emailed to), never whatever the redeeming request submits.
-- 'login' default matches 0013's own reasoning: every pre-existing row and
-- any future caller that forgets the argument degrades to the ordinary
-- sign-in, never the privileged branch.
ALTER TABLE subscriber_login_tokens ADD COLUMN purpose TEXT NOT NULL DEFAULT 'login';
ALTER TABLE subscriber_login_tokens ADD COLUMN pending_new_email TEXT;

-- Same shape as firms.reminder_thresholds (migration 0039) -- a JSON array
-- subset of the 6 fixed escalation points. NULL means "inherit the firm's
-- setting" (or the full 6-value default for a free-tier row with no firm
-- at all) -- scheduler.ts's runReminderPass() reads this as an override
-- step AFTER resolving the firm's own thresholds, never in place of it.
ALTER TABLE subscribers ADD COLUMN reminder_thresholds TEXT;
