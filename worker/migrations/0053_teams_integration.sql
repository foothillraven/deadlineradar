-- Roadmap #21 (2026-08-08): Microsoft Teams integration for deadline
-- alerts. Unlike Slack (#20), there is no OAuth "Add to Teams" flow --
-- Office 365 Connectors are retired, and the current Workflows-based
-- mechanism requires a firm admin to manually create a Workflow inside
-- their own Teams client and paste the resulting webhook URL here. See
-- teams.ts's own docstring for the confirmed (2026-08) payload format and
-- the SSRF-guard hostname allowlist this raw user-supplied URL requires
-- that Slack's own OAuth-issued webhook URL never needed.

-- NULL = not connected, the single source of truth everywhere this is
-- read (same posture as slack_webhook_url). No access-token/encryption
-- columns needed at all -- there is no OAuth token here to revoke.
ALTER TABLE firms ADD COLUMN teams_webhook_url TEXT;

-- Roadmap #21's own dedup, independent of BOTH subscribers.reminders_sent
-- (the email lifecycle) AND firm_slack_notified_thresholds (migration
-- 0052) -- email, Slack, and Teams must never starve each other.
CREATE TABLE IF NOT EXISTS firm_teams_notified_thresholds (
    id TEXT PRIMARY KEY,
    subscriber_id TEXT NOT NULL REFERENCES subscribers(id),
    threshold INTEGER NOT NULL,
    notified_at TEXT NOT NULL,
    UNIQUE(subscriber_id, threshold)
);
CREATE INDEX IF NOT EXISTS idx_firm_teams_notified_thresholds_subscriber
    ON firm_teams_notified_thresholds (subscriber_id, threshold);

-- Seventh independent daily circuit breaker, same shape and cron-vs-
-- request-triggered isolation reasoning as the six before it.
CREATE TABLE IF NOT EXISTS teams_alert_send_counters (
    day TEXT PRIMARY KEY, -- UTC date, ISO 'YYYY-MM-DD'
    count INTEGER NOT NULL DEFAULT 0
);
