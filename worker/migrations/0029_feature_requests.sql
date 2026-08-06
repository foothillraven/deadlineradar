-- Task #19 (2026-08-06, Devin's decision after a scope walk-through):
-- post-signup feature-request questionnaire (private, per-firm) + a
-- PUBLIC /roadmap/ page to vote on what to build next.
--
-- Design settled across several rounds with Devin:
--   - Voting is anonymous, no email required -- a signed first-party
--     cookie (a random voter_id) is the dedup key, not an account.
--     Friction-free, matching the site's existing "no account needed"
--     ethos for free reminders. Real anti-abuse is layered ELSEWHERE (IP
--     rate limit + Turnstile + the existing email-blocklist reused for
--     the notify-signup path below), not on this table.
--   - "Notify me when this ships" is a SEPARATE, optional opt-in shown
--     after voting, not a gate on the vote itself. That one DOES require
--     a confirm-click (same magic-link-token pattern as every other
--     email-confirmation flow in this codebase) before it's added to the
--     notify list -- a spam target needs verification even if a vote
--     doesn't.
--   - feature_ideas stays operator-curated (seeded below, grown by hand),
--     not freely creatable by voters -- keeps this a genuine signal
--     instead of an unmoderated wishlist, with zero new moderation
--     surface to build.
--
-- No FK constraints, matching activity_log's own precedent (this
-- codebase's established D1 schema convention).
-- status (2026-08-06, Devin: "update it when starting a new task") tracks
-- an idea through its real lifecycle -- 'open' | 'in_progress' | 'shipped'
-- -- so the roadmap reflects reality instead of just a vote count that
-- never changes once work actually starts. Set by whoever's operating the
-- fleet (store.setFeatureIdeaStatus()), not automatically -- same "human
-- judgment call, no auto-detection" reasoning as the notify-on-ship email
-- itself (this migration's own header comment). Moving to 'shipped' is
-- also the trigger point for that email batch -- see
-- store.markFeatureIdeaShipped(), which sets status AND returns the
-- confirmed signups to notify in one call.
CREATE TABLE IF NOT EXISTS feature_ideas (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    active INTEGER NOT NULL DEFAULT 1, -- retired ideas keep their vote history, just stop listing
    created_at TEXT NOT NULL
);

-- voter_id is a random token minted into a first-party cookie on first
-- vote (see index.ts's handleRoadmapVote) -- UNIQUE(idea_id, voter_id)
-- makes one-vote-per-browser-per-idea a schema guarantee, not just an
-- application check.
CREATE TABLE IF NOT EXISTS feature_idea_votes (
    id TEXT PRIMARY KEY,
    idea_id TEXT NOT NULL,
    voter_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(idea_id, voter_id)
);
CREATE INDEX IF NOT EXISTS idx_feature_idea_votes_idea ON feature_idea_votes(idea_id);

-- confirmed_at NULL = a confirmation email was sent but never clicked
-- (excluded from the real notify list, same "unconfirmed rows don't
-- count" convention the rest of this codebase already uses for
-- pending-confirmation subscribers). confirm_token is single-use --
-- cleared (not deleted, so a re-click of an old email link 404s cleanly
-- instead of behaving like an invalid/expired one) once redeemed.
CREATE TABLE IF NOT EXISTS feature_idea_notify_signups (
    id TEXT PRIMARY KEY,
    idea_id TEXT NOT NULL,
    email TEXT NOT NULL,
    confirm_token TEXT,
    confirmed_at TEXT,
    notified_at TEXT, -- set once the idea actually ships and the "it's live" email goes out
    created_at TEXT NOT NULL,
    UNIQUE(idea_id, email)
);
CREATE INDEX IF NOT EXISTS idx_feature_idea_notify_idea ON feature_idea_notify_signups(idea_id);

-- One row per firm that actually submitted the post-signup questionnaire
-- (skipping is NOT a row here -- just firms.feature_questionnaire_dismissed_at
-- below, since there's nothing to store for a skip).
CREATE TABLE IF NOT EXISTS feature_questionnaire_responses (
    id TEXT PRIMARY KEY,
    firm_id TEXT NOT NULL,
    selected_features TEXT NOT NULL, -- JSON array of strings
    other_text TEXT,
    created_at TEXT NOT NULL
);

-- NULL means "still show the one-time post-signup prompt"; set (whether
-- by a real submission or an explicit skip) means "never show it again
-- for this firm." A timestamp, not a boolean, so a future admin view can
-- also answer "when."
ALTER TABLE firms ADD COLUMN feature_questionnaire_dismissed_at TEXT;

-- Seed ideas (2026-08-06) -- a starting list worth actually voting on
-- today, not a placeholder. Grown by hand from real questionnaire
-- "other" text and roadmap feedback over time, not auto-populated.
INSERT INTO feature_ideas (id, title, description, active, created_at) VALUES
    ('idea-sms-reminders', 'SMS reminders', 'Text message alerts alongside email for deadlines coming due.', 1, '2026-08-06T00:00:00.000Z'),
    ('idea-practice-mgmt-integration', 'Practice-management integration', 'Sync your roster with QuickBooks, Karbon, Canopy, or similar instead of maintaining it separately here.', 1, '2026-08-06T00:00:00.000Z'),
    ('idea-batch-mobility-check', 'Batch Practice Privilege Check', 'Run one check across your whole roster at once instead of one staffer/state pair at a time.', 1, '2026-08-06T00:00:00.000Z'),
    ('idea-white-label', 'White-label / custom branding', 'Your firm''s logo and colors on the dashboard and reminder emails.', 1, '2026-08-06T00:00:00.000Z'),
    ('idea-api-access', 'API access', 'Pull your roster and deadline data into your own systems programmatically.', 1, '2026-08-06T00:00:00.000Z'),
    ('idea-cpe-certificate-upload', 'CPE certificate upload', 'Attach the actual completion certificate to a logged CPE entry, not just the hours.', 1, '2026-08-06T00:00:00.000Z'),
    ('idea-slack-teams-notify', 'Slack / Teams notifications', 'Post deadline alerts and rule changes to a channel instead of (or alongside) email.', 1, '2026-08-06T00:00:00.000Z'),
    ('idea-custom-reminder-schedule', 'Custom reminder schedule', 'Choose your own lead times instead of the fixed 60/30/14/7/3/1-day schedule.', 1, '2026-08-06T00:00:00.000Z');
