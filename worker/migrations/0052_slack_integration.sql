-- Roadmap #20 (2026-08-08): Slack integration for deadline alerts. A firm
-- admin connects a channel via "Add to Slack" (incoming-webhook scope);
-- DeadlineRadar posts one daily digest per firm of newly-due reminder
-- thresholds -- same "batch, never flood" shape as roadmap #24's email
-- digest mode, at the firm level instead of the person level.

-- Nullable; NULL slack_webhook_url = not connected, the single source of
-- truth for "is Slack on" everywhere this is read. access_token is stored
-- encrypted (AES-GCM, reusing TOTP_ENCRYPTION_KEY -- see totp.ts) since it's
-- a live bearer credential, needed only so disconnect can call Slack's
-- auth.revoke; posting itself only ever uses the webhook URL.
ALTER TABLE firms ADD COLUMN slack_webhook_url TEXT;
ALTER TABLE firms ADD COLUMN slack_access_token_encrypted TEXT;
ALTER TABLE firms ADD COLUMN slack_access_token_iv TEXT;
ALTER TABLE firms ADD COLUMN slack_team_name TEXT;
ALTER TABLE firms ADD COLUMN slack_channel_name TEXT;

-- Roadmap #20's own dedup, deliberately independent of subscribers.reminders_sent
-- -- that column belongs to the EMAIL claim lifecycle, and a threshold
-- already claimed/sent by email must still be independently eligible for
-- its own Slack notification (the two channels must never starve each
-- other). UNIQUE(subscriber_id, threshold) is the actual dedup; id/notified_at
-- are for observability only.
CREATE TABLE IF NOT EXISTS firm_slack_notified_thresholds (
    id TEXT PRIMARY KEY,
    subscriber_id TEXT NOT NULL REFERENCES subscribers(id),
    threshold INTEGER NOT NULL,
    notified_at TEXT NOT NULL,
    UNIQUE(subscriber_id, threshold)
);
CREATE INDEX IF NOT EXISTS idx_firm_slack_notified_thresholds_subscriber
    ON firm_slack_notified_thresholds (subscriber_id, threshold);

-- Sixth independent daily circuit breaker, same shape and cron-vs-request-
-- triggered isolation reasoning as the five before it (send_counters,
-- action_send_counters, drip_course_send_counters, rule_change_alert_send_counters,
-- digest_send_counters).
CREATE TABLE IF NOT EXISTS slack_alert_send_counters (
    day TEXT PRIMARY KEY, -- UTC date, ISO 'YYYY-MM-DD'
    count INTEGER NOT NULL DEFAULT 0
);
