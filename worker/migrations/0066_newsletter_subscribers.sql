-- Roadmap #124 (2026-08-13, Devin: "Good to build 2"): compliance-news
-- email newsletter, a NEW public opt-in list -- deliberately its own table,
-- not a repurposed row on `subscribers` (which is a per-state/per-deadline
-- reminder record, a different consent surface with different semantics;
-- the fleet's own established rule this session -- "don't reuse the wrong
-- token" -- applies here at the table level too). Same double-opt-in shape
-- as the individual reminder flow (subscribers table, migration 0001):
-- pending_confirmation -> confirmed -> unsubscribed, its own confirm_token/
-- unsubscribe_token pair, never the reminder flow's tokens.

CREATE TABLE IF NOT EXISTS newsletter_subscribers (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    -- Same folding as store.ts cooldownKey() -- dedupe/lookup key only,
    -- never the delivery address.
    cooldown_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending_confirmation',
    confirm_token TEXT NOT NULL UNIQUE,
    unsubscribe_token TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    confirmed_at TEXT,
    unsubscribed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_newsletter_subscribers_cooldown_key
    ON newsletter_subscribers(cooldown_key);
CREATE INDEX IF NOT EXISTS idx_newsletter_subscribers_status
    ON newsletter_subscribers(status);

-- Same per-purpose daily circuit-breaker shape as send_counters/
-- action_send_counters/drip_course_send_counters/etc (sender.ts) -- a bug
-- or attack against this NEW send path must never be able to compete with
-- reminder/action email budget, even indirectly.
CREATE TABLE IF NOT EXISTS newsletter_send_counters (
    day TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0
);

-- Singleton row (id is always 1) tracking the digest's own send cadence and
-- content dedupe -- a monthly SHARED send (one piece of content to every
-- confirmed subscriber at once), not a per-subscriber cadence like the
-- weekly roster digest, so one row is the right shape, not one row per
-- subscriber. last_included_event_ids is a JSON array of reg_change_events
-- event_id values already covered by a prior send, so a quiet month never
-- silently repeats the same content, and a content-free month never forces
-- an empty "nothing changed" send (see scheduler.ts runComplianceNewsletterPass
-- docstring for the full cadence rule).
CREATE TABLE IF NOT EXISTS newsletter_digest_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_sent_at TEXT,
    last_included_event_ids TEXT NOT NULL DEFAULT '[]'
);
