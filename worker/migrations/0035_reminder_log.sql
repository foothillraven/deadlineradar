-- Roadmap #8 (2026-08-07, roadmap_items table, IMMEDIATE RELEASE): "'Reasonable
-- process' audit trail export (dates tracked, dates reminded)".
--
-- Confirmed with Devin (2026-08-07): reminders_sent (subscribers) only ever
-- stored WHICH escalation thresholds fired (e.g. [60,30,14]), never WHEN --
-- no real date existed to export for "dates reminded" before this table. A
-- NEW durable log, not a reshaping of reminders_sent itself: that column's
-- whole job is the atomic claim/dedupe compare-and-swap
-- (claimReminderThreshold/unclaimReminderThreshold in store.ts) that the
-- at-least-once reminder-delivery guarantee depends on -- touching its
-- shape risks that critical path for a feature that only needs to ADD
-- data, never read what reminders_sent already tracks. Same "durable log
-- independent of live operational state" precedent as activity_log
-- (migration 0025) -- see that migration's own docstring.
--
-- firm_id NOT NULL: only firm-tracked subscribers get logged here (an
-- audit trail is a firm-dashboard concept; free-tier individual reminders
-- have no dashboard to show one in), same posture activity_log already
-- takes. No FOREIGN KEY on subscriber_id, same reasoning as activity_log:
-- this table must keep reading correctly after the subscriber it
-- describes is later removed.
CREATE TABLE IF NOT EXISTS reminder_log (
    id TEXT PRIMARY KEY,
    firm_id TEXT NOT NULL,
    subscriber_id TEXT NOT NULL,
    threshold_days INTEGER NOT NULL,
    sent_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reminder_log_firm ON reminder_log(firm_id, sent_at DESC);
