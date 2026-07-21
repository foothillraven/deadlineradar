-- DeadlineRadar Pro -- accounts, sessions, and CPE-hour tracking.
--
-- Per PRO_TIER_SPEC.md's MVP recommendation: the anchor feature is CPE-hour
-- tracking (log hours against the state's data/cpe_hours.json requirement),
-- gated behind basic email/password accounts. Billing (Stripe) is
-- deliberately NOT part of this migration -- .secrets/stripe.env holds
-- live-mode keys, not test-mode, so no billing table/column is added until
-- real test-mode keys exist and billing wiring is explicitly greenlit.
--
-- This migration has NOT been applied to any real (non-local) D1 instance.
-- Local application only: `wrangler d1 migrations apply deadlineradar --local`.

CREATE TABLE IF NOT EXISTS accounts (
    -- Same token convention as subscribers.id (migration 0001): a
    -- `newToken()` (32 bytes url-safe CSPRNG), not an autoincrement int.
    id TEXT PRIMARY KEY,

    -- Stored as typed (lowercase+trim via store.ts's normalizeEmail), NOT
    -- the cooldown_key folding subscribers uses -- an account email is the
    -- literal login identifier, not a spam-dedupe key, so Gmail dot/+tag
    -- folding would be wrong here (it would let two logically-different
    -- addresses collide on login). UNIQUE enforces one account per address.
    email TEXT NOT NULL UNIQUE,

    -- PBKDF2-SHA256 derived key, base64. Workers' native Web Crypto
    -- (crypto.subtle) supports PBKDF2 directly with no external dependency,
    -- unlike bcrypt/scrypt which need a WASM or pure-JS library -- chosen
    -- for that reason, not because it's the only sound option. A per-user
    -- random salt (password_salt) means two identical passwords never
    -- produce the same hash.
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    -- PBKDF2 iteration count used AT THE TIME this hash was created --
    -- stored per-row (not a single global constant) specifically so the
    -- iteration count CAN be raised later without invalidating already-
    -- hashed passwords. RE-QA note (2026-07-20): login does NOT currently
    -- re-hash on a below-current-constant iteration count -- that upgrade
    -- path is not implemented yet, only the schema support for it exists.
    -- If PBKDF2_ITERATIONS is ever raised, existing rows keep verifying
    -- correctly (verifyPassword always uses the row's own stored count),
    -- they just won't get bumped to the new count until that upgrade path
    -- is built.
    password_iterations INTEGER NOT NULL,

    created_at TEXT NOT NULL,

    -- Email verification, reusing the exact confirm-token pattern
    -- subscribers already uses (migration 0001's confirm_token): NULL
    -- verified_at means the account can log in (password-gated) but
    -- verification_token still needs confirming before any Pro feature
    -- that depends on a trusted email (renewal reminders, receipts) is
    -- fully active. UNIQUE so a token can only ever belong to one account.
    verified_at TEXT,
    verification_token TEXT NOT NULL UNIQUE,

    -- Password-reset flow, same token shape, nullable (only set while a
    -- reset is in flight) and re-generated fresh on every request rather
    -- than reused, so a stale emailed link can't be replayed after a
    -- successful reset.
    password_reset_token TEXT UNIQUE,
    password_reset_requested_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_accounts_email ON accounts (email);

CREATE TABLE IF NOT EXISTS sessions (
    -- The session token itself IS the primary key -- this is the value
    -- that goes in the session cookie, looked up directly on every
    -- authenticated request. Same 32-byte CSPRNG token shape as everywhere
    -- else in this codebase, not a JWT -- keeps revocation trivial (DELETE
    -- the row) which a signed-but-stateless JWT would not give us for free.
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts (id),
    created_at TEXT NOT NULL,
    -- IDLE-timeout expiry, not an absolute one: application code slides
    -- expires_at forward by SESSION_LIFETIME_SECONDS on every authenticated
    -- request (pro_store.ts resolveSession()), so a session in continuous
    -- use never expires -- there is no separate cap tied to created_at.
    -- Expired rows are lazily deleted on lookup, no separate cron needed
    -- given expected volume at MVP scale.
    expires_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_account_id ON sessions (account_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS cpe_hour_entries (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts (id),

    -- Which state's requirement this entry counts against -- matches
    -- data/cpe_hours.json's state_slug convention exactly, so the app can
    -- join a user's logged hours against the same sourced requirement
    -- record the public CPE pages already display. Not a foreign key to a
    -- D1 table (cpe_hours.json is a build-time JSON file, not a runtime
    -- table) -- validated at the application layer against the known slug
    -- set instead.
    state_slug TEXT NOT NULL,

    hours REAL NOT NULL,
    -- 0/1, not a separate ethics_hours split column: a single entry is
    -- either an ethics-qualifying course or it isn't, matching how the
    -- CPE requirement data itself models "ethics hours" as a subset count
    -- within the total, not a separately-logged activity type.
    is_ethics INTEGER NOT NULL DEFAULT 0 CHECK (is_ethics IN (0, 1)),

    course_name TEXT NOT NULL,
    -- The date the course/activity was actually completed (user-entered),
    -- distinct from created_at (when the log entry was made in the app) --
    -- a user might log a course a week after taking it.
    completed_date TEXT NOT NULL,

    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cpe_hour_entries_account_id ON cpe_hour_entries (account_id);
