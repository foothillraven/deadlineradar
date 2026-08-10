-- Roadmap #151 Phase 5 ("move the value line", 2026-08-10, the last phase):
-- a firm-wide/admin-directed reminder email -- unlike every existing
-- reminder/digest (subscriber's own address only), this bundles newly-due
-- items across the WHOLE roster into one periodic email to firm.admin_email,
-- so the partner who carries the regulatory risk doesn't have to rely on
-- Slack/Teams (roadmap #20/#21, also #151-gated) or checking the dashboard.
-- Gated the same way as #151's other four phases (hasValueLineAccess()) --
-- see runAdminDigestAlertPass()'s own docstring in scheduler.ts.

-- Opt-out, on by default for an ELIGIBLE firm -- same "the whole point is
-- not making an admin remember to check" reasoning migration 0050's
-- rule_change_alerts_enabled already used for the closest existing
-- precedent (the only other pass that emails firm.admin_email about
-- roster-wide state).
ALTER TABLE firms ADD COLUMN admin_digest_enabled INTEGER NOT NULL DEFAULT 1;

-- "Already included in an admin digest" dedup -- per-subscriber-per-
-- threshold, same granularity and same INDEPENDENT-of-every-other-channel
-- reasoning firm_slack_notified_thresholds/firm_teams_notified_thresholds
-- already established (migration 0052/0053's own docstrings): a threshold
-- already claimed by email/Slack/Teams must never silently suppress its own
-- separate admin-digest inclusion, or vice versa.
CREATE TABLE IF NOT EXISTS firm_admin_digest_notified_thresholds (
    id TEXT PRIMARY KEY,
    subscriber_id TEXT NOT NULL REFERENCES subscribers(id),
    threshold INTEGER NOT NULL,
    notified_at TEXT NOT NULL,
    UNIQUE(subscriber_id, threshold)
);
CREATE INDEX IF NOT EXISTS idx_firm_admin_digest_notified_thresholds_subscriber
    ON firm_admin_digest_notified_thresholds (subscriber_id, threshold);

-- Same shape as rule_change_alert_send_counters/slack_alert_send_counters --
-- an independent daily circuit breaker for this specific send channel, so a
-- volume spike on one channel can never compete with another for budget.
CREATE TABLE IF NOT EXISTS admin_digest_send_counters (
    day TEXT PRIMARY KEY, -- UTC date, ISO 'YYYY-MM-DD'
    count INTEGER NOT NULL DEFAULT 0
);
