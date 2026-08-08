-- Roadmap #24 (2026-08-08): digest email option (weekly summary vs.
-- per-deadline pings). Per-subscriber delivery-cadence preference, same axis
-- reminder_thresholds already lives on -- digest mode changes WHEN a
-- claimed threshold's email goes out (batched vs. immediate), never the
-- escalation/claim machinery itself.

-- 'immediate' (today's only behavior) or 'digest'. Written across every row
-- sharing an email (same cross-row-write convention
-- setSubscriberReminderThresholds already uses), since this is a per-PERSON
-- preference, not a per-deadline one.
ALTER TABLE subscribers ADD COLUMN notification_mode TEXT NOT NULL DEFAULT 'immediate';

-- NULL until the first digest actually sends; a rolling window like
-- snoozed_until, not a fixed day-of-week -- advanced by +7 days only on an
-- actual send, so a quiet week never fires an empty "nothing to report"
-- email and a due item that arrives mid-window simply waits, unclaimed,
-- for the window to reopen.
ALTER TABLE subscribers ADD COLUMN digest_next_send_at TEXT;

-- Same shape as send_counters/action_send_counters/drip_course_send_counters/
-- rule_change_alert_send_counters -- a FIFTH independent daily circuit
-- breaker, same cron-vs-request-triggered isolation reasoning as the prior
-- four.
CREATE TABLE IF NOT EXISTS digest_send_counters (
    day TEXT PRIMARY KEY, -- UTC date, ISO 'YYYY-MM-DD'
    count INTEGER NOT NULL DEFAULT 0
);
