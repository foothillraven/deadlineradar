-- Roadmap #11/#13/#14/#51 (2026-08-07): multi-user firm accounts with roles.
--
-- Every firm account has been strictly single-admin since migration 0008 --
-- exactly one admin_email/admin_name/password_* set directly on the `firms`
-- row, DB-enforced unique (idx_firms_admin_email_unique, migration 0015).
-- `firm_sessions` is keyed only on firm_id -- nothing distinguishes WHICH
-- human is behind a given session. This migration adds a real membership
-- model: `firm_members`, one row per person who can sign into a firm, each
-- with their own credentials and a role (partner / office_manager / staff).
--
-- Backward compatible by construction: `firms.admin_email`/`admin_name`/
-- `password_*` are left in place (still read by billing/Stripe
-- correspondence and every existing outbound-email call site) rather than
-- dropped -- this migration is purely additive. The backfill below gives
-- every EXISTING firm exactly one 'partner' firm_members row, copying its
-- current admin identity/credentials verbatim, so today's single-admin
-- firms see zero behavior change.
CREATE TABLE IF NOT EXISTS firm_members (
    id TEXT PRIMARY KEY,
    firm_id TEXT NOT NULL REFERENCES firms(id),
    email TEXT NOT NULL,
    name TEXT,
    role TEXT NOT NULL CHECK (role IN ('partner', 'office_manager', 'staff')),
    -- Same PBKDF2 column shape firms.password_* already has (migration
    -- 0010) -- password.ts's hashing code is reused as-is, just pointed at
    -- this table instead. Nullable for the same reason: a member who only
    -- ever uses the magic link has no password, which is valid.
    password_hash TEXT,
    password_salt TEXT,
    password_algo TEXT,
    password_iterations INTEGER,
    password_rounds INTEGER,
    password_updated_at TEXT,
    invited_at TEXT NOT NULL,
    invited_by_member_id TEXT REFERENCES firm_members(id),
    -- NULL until the member has actually signed in once (an outstanding
    -- invite, not yet accepted).
    joined_at TEXT,
    -- Soft-delete, not a real DELETE -- keeps history for #51's "transfer
    -- keeps history" requirement and matches this codebase's existing
    -- soft-delete convention elsewhere (cpe_entries.deleted_at, etc.).
    removed_at TEXT,
    created_at TEXT NOT NULL
);

-- One active (non-removed) member per email, matching
-- idx_firms_admin_email_unique's own case/whitespace-insensitive shape.
-- Partial index (WHERE removed_at IS NULL) so a removed member's email can
-- be re-invited later without a stale row blocking it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_firm_members_email_unique
    ON firm_members (LOWER(TRIM(email))) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_firm_members_firm_id ON firm_members (firm_id);

-- The firm's current primary/billing contact -- the answer to #51 (account
-- transfer): transferring ownership updates this pointer to a different
-- existing Partner. Nothing is deleted; the old primary just becomes a
-- regular Partner. Nullable (not backfilled until the INSERT below runs)
-- and NOT a foreign key with ON DELETE behavior -- firm_members rows are
-- soft-deleted, never actually removed, so there is no delete to cascade.
ALTER TABLE firms ADD COLUMN primary_member_id TEXT REFERENCES firm_members(id);

-- Which member is behind a given session -- the actual fix for "nothing
-- distinguishes which human is signed in" above. Nullable for the same
-- backward-compatibility reason as every other additive column in this
-- migration; backfilled below for every EXISTING session.
ALTER TABLE firm_sessions ADD COLUMN member_id TEXT REFERENCES firm_members(id);

-- Every future emailed login/invite link is scoped to a specific member,
-- not just a firm -- reuses the existing firm_login_tokens table/issue/
-- consume code path (store.ts's createLoginToken()/
-- verifyAndConsumeLoginToken()) rather than a parallel token table.
ALTER TABLE firm_login_tokens ADD COLUMN member_id TEXT REFERENCES firm_members(id);

-- Backfill: one 'partner' firm_members row per existing firm, copying its
-- current admin identity/credentials verbatim. lower(hex(randomblob(16)))
-- is a 128-bit random hex id -- this is an internal foreign-key id, not a
-- bearer credential, so SQLite's own RNG (sufficient for a one-time
-- backfill, not reused anywhere else in this codebase's real token
-- generation) is an appropriate, simple choice here.
INSERT INTO firm_members (
    id, firm_id, email, name, role,
    password_hash, password_salt, password_algo, password_iterations, password_rounds, password_updated_at,
    invited_at, joined_at, created_at
)
SELECT
    lower(hex(randomblob(16))), id, admin_email, admin_name, 'partner',
    password_hash, password_salt, password_algo, password_iterations, password_rounds, password_updated_at,
    created_at, created_at, created_at
FROM firms;

-- Point every existing firm at its newly-backfilled partner as the primary
-- contact.
UPDATE firms
SET primary_member_id = (
    SELECT firm_members.id FROM firm_members WHERE firm_members.firm_id = firms.id
)
WHERE primary_member_id IS NULL;

-- Attribute every existing session to that same backfilled partner -- a
-- session created before this migration ran was, by definition, the
-- firm's one admin.
UPDATE firm_sessions
SET member_id = (
    SELECT firm_members.id FROM firm_members WHERE firm_members.firm_id = firm_sessions.firm_id
)
WHERE member_id IS NULL;
