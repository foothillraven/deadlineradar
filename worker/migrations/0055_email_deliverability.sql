-- Roadmap #55 (2026-08-09): email deliverability monitoring (bounce/
-- complaint tracking). SendGrid's Event Webhook reports what happened to
-- an email AFTER it was accepted for sending -- a hard bounce or spam
-- complaint hurts sender reputation for every subsequent send if the
-- address keeps getting mailed. See sendgrid_webhook.ts's own docstring
-- for the ECDSA signature verification this schema exists to support.

-- Idempotent log, keyed by SendGrid's own event id -- SendGrid retries a
-- webhook on any non-2xx response and does not guarantee exactly-once
-- delivery, so a redelivered event must never double-count or (more
-- importantly) double-process a suppression action.
CREATE TABLE IF NOT EXISTS email_deliverability_events (
    id TEXT PRIMARY KEY,
    sg_event_id TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL,
    event_type TEXT NOT NULL, -- 'bounce' | 'blocked' | 'spamreport' | other SendGrid event types
    reason TEXT, -- SMTP reason string, when present
    received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_deliverability_events_email ON email_deliverability_events (email);

-- No subscribers-table schema change -- stop_reason is already a free-text
-- column (no CHECK constraint), so a bounce/complaint reuses the EXACT
-- stop()/isPermanentlySuppressed() mechanism unsubscribe already uses,
-- with two new reason values ('hard_bounced', 'spam_complaint') alongside
-- the existing 'unsubscribed'/'renewed'.
