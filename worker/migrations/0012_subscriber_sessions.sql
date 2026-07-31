-- Free-tier individual sign-in (2026-07-31).
--
-- Individuals ALREADY have a working free product: they sign up on a state
-- page and get escalating renewal reminders (60/30/14/7/3/1 days), in any
-- of 55 jurisdictions, with an optional bring-your-own date, and dedupe is
-- on (email, state) so one person can track several licences. What they
-- have never had is a way to SEE any of it -- no login, no dashboard, no
-- single view. This migration adds only the missing sign-in.
--
-- ## Why a separate table instead of reusing firm_sessions
--
-- A firm session is keyed to a `firms` row. An individual is not a firm and
-- must never be resolvable to one -- adding a nullable firm_id to
-- firm_sessions would have created a table where "which kind of principal
-- is this?" depends on which column is null, and every firm-scoped query in
-- the codebase would have needed re-auditing to prove it still can't be
-- reached by an individual session. A separate table means the existing
-- firm authz surface is untouched by construction: `verifySession()` cannot
-- return an individual, because individuals are not in the table it reads.
--
-- ## Identity is the EMAIL, not a row
--
-- A person owns every subscriber row sharing their email, so the session
-- stores the normalised email rather than a subscriber id. `cooldown_key`
-- is deliberately NOT used for this: it folds Gmail dots and +tags
-- together, which is correct for abuse-throttling but wrong for identity --
-- it would let first.last@gmail.com sign in and see firstlast@gmail.com's
-- licences, which are potentially a different human.
--
-- Same hashing discipline as migrations 0008/0011: only a SHA-256 hash of
-- each live bearer value is ever persisted. The raw token exists solely in
-- the emailed link or the browser cookie.

-- One row per emailed sign-in link. Single-use (used_at) and short-lived
-- (expires_at), matching firm_login_tokens' 15-minute contract.
CREATE TABLE IF NOT EXISTS subscriber_login_tokens (
    id TEXT PRIMARY KEY,
    email_normalized TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_sub_login_tokens_email ON subscriber_login_tokens (email_normalized);

-- One row per signed-in browser. Shorter-lived than a firm session (30
-- days): a firm dashboard is a work tool someone lives in, whereas this is
-- a check-in-occasionally view, so a shorter window costs the user almost
-- nothing and shrinks the value of a stolen cookie.
CREATE TABLE IF NOT EXISTS subscriber_sessions (
    id TEXT PRIMARY KEY,
    email_normalized TEXT NOT NULL,
    session_token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sub_sessions_email ON subscriber_sessions (email_normalized);
