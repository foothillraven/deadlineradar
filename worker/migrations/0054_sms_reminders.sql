-- Roadmap #22 (2026-08-09): SMS/text reminders, opt-in ADDITIONAL channel
-- on top of email (not a replacement), sent at the same reminder_thresholds
-- a subscriber already has configured. Real TCPA compliance surface --
-- see sms.ts's own docstring for the quiet-hours/consent reasoning this
-- schema exists to support.

-- Cross-row-write reach, same as notification_mode/reminder_thresholds --
-- a phone number belongs to the PERSON, not one deadline.
ALTER TABLE subscribers ADD COLUMN phone_number TEXT; -- E.164, e.g. +15551234567
ALTER TABLE subscribers ADD COLUMN sms_opted_in INTEGER NOT NULL DEFAULT 0;
-- TCPA consent timestamp. Deliberately KEPT even after an opt-out (STOP) --
-- see store.clearSubscriberSmsOptIn()'s own docstring for why this is a
-- compliance audit trail, not just current-state.
ALTER TABLE subscribers ADD COLUMN sms_opted_in_at TEXT;

-- Double opt-in for a NEW channel, same rigor email's own confirm_token
-- flow already has -- a phone number is real PII with real per-message
-- cost and real TCPA exposure if we ever text a wrong/mistyped/reassigned
-- number. 6-digit code, hashed (store.hashToken(), same as OAuth state --
-- never store a live bearer/secret value in the clear), short TTL.
-- Scoped by email (cross-row), not one subscriber id -- same reach as the
-- opt-in columns above.
CREATE TABLE IF NOT EXISTS subscriber_phone_verifications (
    id TEXT PRIMARY KEY,
    subscriber_email_normalized TEXT NOT NULL,
    phone_number TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_subscriber_phone_verifications_email
    ON subscriber_phone_verifications (subscriber_email_normalized);

-- Roadmap #22's own dedup, independent of reminders_sent/
-- firm_slack_notified_thresholds/firm_teams_notified_thresholds -- every
-- channel stays independent, none can starve another.
CREATE TABLE IF NOT EXISTS sms_notified_thresholds (
    id TEXT PRIMARY KEY,
    subscriber_id TEXT NOT NULL REFERENCES subscribers(id),
    threshold INTEGER NOT NULL,
    notified_at TEXT NOT NULL,
    UNIQUE(subscriber_id, threshold)
);
CREATE INDEX IF NOT EXISTS idx_sms_notified_thresholds_subscriber
    ON sms_notified_thresholds (subscriber_id, threshold);

-- Eighth independent daily circuit breaker, same shape as the seven
-- before it -- kept especially tight here given SMS has a real per-
-- message cost, unlike every prior channel.
CREATE TABLE IF NOT EXISTS sms_send_counters (
    day TEXT PRIMARY KEY, -- UTC date, ISO 'YYYY-MM-DD'
    count INTEGER NOT NULL DEFAULT 0
);
