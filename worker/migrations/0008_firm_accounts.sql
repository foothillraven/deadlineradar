-- Firm accounts + login/session auth (2026-07-28 firm-dashboard MVP, step 1/3).
--
-- Today there is ZERO auth anywhere in this codebase -- every existing
-- action (confirm/unsubscribe/renewed/rearm) is a single-purpose,
-- plaintext-stored capability-URL token, never a login. A firm admin
-- dashboard needs a real, repeatable login: this migration adds the
-- account (firms), the one-time emailed sign-in link (firm_login_tokens),
-- and the resulting browser session (firm_sessions), plus the two columns
-- on subscribers that let a subscriber row be "claimed" by a firm.
--
-- Hashing convention (deliberately DIFFERENT from every existing token in
-- this schema): confirm_token/unsubscribe_token/renewed_token on
-- subscribers are stored PLAINTEXT because each is single-purpose (one
-- action, then largely inert) -- an accepted existing pattern here. A login
-- link and a session are higher-value (a compromised copy grants standing
-- access to a firm's whole staff roster, not one action), so only a
-- SHA-256 hash of each raw token is ever persisted (token_hash /
-- session_token_hash below) -- see store.ts's `hashToken()` for the exact
-- algorithm and rationale (Web Crypto SHA-256; no bcrypt/argon2 available
-- in a Workers isolate without a WASM dependency, and a single hash of a
-- random 256-bit CSPRNG value -- not a human-guessable password -- is a
-- defensible, simple choice). The raw value is only ever in the emailed
-- URL or the session cookie, never persisted anywhere.
--
-- This migration has NOT been applied to any real (non-local) D1 instance.
-- Local application only: `wrangler d1 migrations apply deadlineradar --local`.

CREATE TABLE IF NOT EXISTS firms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    admin_email TEXT NOT NULL,
    plan_tier TEXT NOT NULL DEFAULT 'pilot',
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL
);

-- One row per emailed magic sign-in link. Single-use (used_at) and
-- short-lived (expires_at, store.LOGIN_TOKEN_TTL_MINUTES = 15) -- see
-- store.ts's verifyAndConsumeLoginToken() for the exact rejection rules.
CREATE TABLE IF NOT EXISTS firm_login_tokens (
    id TEXT PRIMARY KEY,
    firm_id TEXT NOT NULL REFERENCES firms(id),
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT
);

-- One row per active browser session. Long-lived (store.SESSION_TTL_DAYS =
-- 30) relative to a login token -- this is the dashboard session, not the
-- one-time link that created it. See store.ts's verifySession() /
-- deleteSession().
CREATE TABLE IF NOT EXISTS firm_sessions (
    id TEXT PRIMARY KEY,
    firm_id TEXT NOT NULL REFERENCES firms(id),
    session_token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
);

-- token_hash / session_token_hash already have an implicit UNIQUE index
-- (the lookup path store.ts actually uses -- verifyAndConsumeLoginToken()
-- and verifySession() both look up BY HASH, never by firm_id). firm_id
-- indexes below are for the OTHER real lookup direction this schema
-- anticipates (e.g. "does this firm have an outstanding login token" /
-- future admin tooling listing a firm's sessions) -- small tables, so this
-- is cheap insurance, not over-indexing.
CREATE INDEX IF NOT EXISTS idx_firm_login_tokens_firm_id ON firm_login_tokens (firm_id);
CREATE INDEX IF NOT EXISTS idx_firm_sessions_firm_id ON firm_sessions (firm_id);

-- subscribers.firm_id: NULL means "free individual subscriber, not
-- firm-tracked" -- matching every existing row (this column is purely
-- additive; no backfill, no existing row changes meaning). Non-NULL means
-- this subscriber is a staff member on a firm admin's roster. The next
-- builder's staff-CRUD/dashboard routes are the ones that actually read/
-- write this column -- this migration and requireFirmSession() (index.ts)
-- only lay the column + the auth check it must be paired with down.
--
-- staff_label: the firm admin's OWN display name for this person (e.g.
-- "Jane D. -- Audit team"), deliberately separate from first_name (the
-- subscriber's own self-entered name from the public signup form) -- a
-- firm admin tracking someone else's license may not know, or want to
-- overwrite, that person's own self-entered name.
ALTER TABLE subscribers ADD COLUMN firm_id TEXT REFERENCES firms(id);
ALTER TABLE subscribers ADD COLUMN staff_label TEXT;

-- Indexed for the same reason idx_subscribers_email/idx_subscribers_status
-- (migration 0001) are: the obvious next query is "list every subscriber
-- row belonging to firm X" (the dashboard's whole reason to exist), and
-- unlike firms/firm_login_tokens/firm_sessions, subscribers is NOT a small
-- table by design (it is the one table this project expects real growth
-- in) -- so this one earns its index up front rather than waiting for a
-- slow-query finding the way idx_subscribers_email_normalized (migration
-- 0003) did.
CREATE INDEX IF NOT EXISTS idx_subscribers_firm_id ON subscribers (firm_id);
