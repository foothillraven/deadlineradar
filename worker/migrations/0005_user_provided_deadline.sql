-- "Bring your own date" -- lets a subscriber in a state the worker can't
-- auto-compute a deadline for (deadline.ts's isStateComputable() returns
-- false) supply their own renewal date instead, so every state can collect
-- signups rather than hiding the form entirely.
--
-- Purely additive: two new nullable-or-defaulted columns, no drops, no
-- rewrites of existing rows. Every row that already exists gets
-- deadline_source='computed' (today's only behavior) and user_deadline=NULL,
-- i.e. this migration changes nothing about any existing subscriber.
--
-- deadline_source: 'computed' (state-rule-derived, the only value that has
-- ever existed) or 'user' (the literal date the subscriber typed in).
-- Left as free TEXT with an application-level CHECK rather than a SQL CHECK
-- constraint, matching this schema's existing convention for `status`
-- (see 0001_init_schema.sql's own comment on that column).
--
-- user_deadline: ISO 'YYYY-MM-DD', set only when deadline_source='user'.
-- scheduler.ts reads this directly instead of calling
-- computeSubscriberDeadline() when deadline_source='user' -- see that file's
-- runReminderPass() for the one-line conditional this enables.

ALTER TABLE subscribers ADD COLUMN deadline_source TEXT NOT NULL DEFAULT 'computed';
ALTER TABLE subscribers ADD COLUMN user_deadline TEXT;
