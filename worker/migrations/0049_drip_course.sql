-- Roadmap #34 (2026-08-08): free renewal-reminder drip email course for
-- undecided leads (confirmed free-tier subscribers, firm_id IS NULL, who
-- haven't converted to a paying firm account).
--
-- Identity here is the EMAIL, not a `subscribers` row -- same reasoning
-- individual_accounts (migration 0018) and firm_leads (migration 0007)
-- already established for cross-cutting per-person concepts: one person
-- can have several `subscribers` rows (one per state/license tracked), so
-- new columns on `subscribers` would double-send or need de-duping logic
-- this table sidesteps entirely.
CREATE TABLE IF NOT EXISTS drip_course_enrollments (
    id TEXT PRIMARY KEY,
    email_normalized TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL,
    first_name TEXT,
    state_slug TEXT,
    started_at TEXT NOT NULL,
    -- JSON array of step numbers already sent, e.g. "[0,7]" -- same shape
    -- as subscribers.reminders_sent, same claim-before-send optimistic-
    -- concurrency use (see store.ts's claimDripCourseStep()).
    steps_sent TEXT NOT NULL DEFAULT '[]',
    opted_out_at TEXT,
    unsubscribe_token TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_drip_course_enrollments_email_normalized
    ON drip_course_enrollments (email_normalized);

-- Same shape as send_counters (migration 0004) / action_send_counters
-- (migration 0019) -- a THIRD, fully independent daily circuit breaker, so
-- this marketing sequence can never compete with real deadline reminders
-- or transactional sends for budget, even indirectly.
CREATE TABLE IF NOT EXISTS drip_course_send_counters (
    day TEXT PRIMARY KEY, -- UTC date, ISO 'YYYY-MM-DD'
    count INTEGER NOT NULL DEFAULT 0
);
