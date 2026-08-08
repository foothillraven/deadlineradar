-- Roadmap #9 / #319 (2026-08-08): proactive rule-change email alerts, scoped
-- to a firm's own roster states. Two systems that already exist (the
-- reg_change_events.json feed /rule-changes/ and the dashboard calendar
-- already publish, and the reminder engine's own email-sending machinery)
-- get wired together -- no new data collection, per #319's own framing.

-- Opt-out, on by default (Devin's own call): a firm that never touches this
-- setting still gets alerted, since the whole point is "stop making an
-- admin remember to check the calendar."
ALTER TABLE firms ADD COLUMN rule_change_alerts_enabled INTEGER NOT NULL DEFAULT 1;

-- "Already alerted about event X" dedup -- nothing tracked this before
-- (the existing admin-triggered notify button is fire-and-forget, bounded
-- only by a firm-wide daily click cap, not per-event). UNIQUE(firm_id,
-- event_id) is the actual dedup; the id/notified_at columns are for
-- observability, not the constraint itself.
CREATE TABLE IF NOT EXISTS firm_rule_change_notifications (
    id TEXT PRIMARY KEY,
    firm_id TEXT NOT NULL REFERENCES firms(id),
    event_id TEXT NOT NULL,
    notified_at TEXT NOT NULL,
    UNIQUE(firm_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_firm_rule_change_notifications_firm_event
    ON firm_rule_change_notifications (firm_id, event_id);

-- Same shape as send_counters/action_send_counters/drip_course_send_counters
-- -- a FOURTH independent daily circuit breaker. This is cron-triggered
-- (not user-request-triggered), same isolation reasoning the reminder and
-- drip-course passes already established for themselves: a cron-driven
-- send volume spike must never compete with request-triggered transactional
-- sends for budget.
CREATE TABLE IF NOT EXISTS rule_change_alert_send_counters (
    day TEXT PRIMARY KEY, -- UTC date, ISO 'YYYY-MM-DD'
    count INTEGER NOT NULL DEFAULT 0
);
