-- Roadmap #53 (2026-08-07): two-factor authentication, opt-in per firm member.
--
-- Deliberately scoped out of the multi-user-firm-accounts build (migration
-- 0045) as its own follow-up -- see that migration's own docstring. Layers
-- on top of firm_members' existing per-member credential columns
-- (password_hash/salt/algo/iterations/rounds): 2FA is a property of the
-- MEMBER, not the firm, same as a password.
--
-- Secret encrypted at rest via AES-GCM (worker/src/totp.ts), key derived
-- from a NEW env secret (TOTP_ENCRYPTION_KEY, set via `wrangler secret put`
-- -- a one-time manual deploy step, not captured in this migration).
-- member_id is bound as AES-GCM additional authenticated data, so a raw-SQL
-- row-swap between two members' encrypted secrets fails decryption instead
-- of silently succeeding. A fresh random IV is stored per row (never
-- derived from the key alone).
ALTER TABLE firm_members ADD COLUMN totp_secret_encrypted TEXT;
ALTER TABLE firm_members ADD COLUMN totp_secret_iv TEXT;
ALTER TABLE firm_members ADD COLUMN totp_enrolled_at TEXT;

-- 8 single-use recovery codes generated at enrollment, shown once, hashed
-- like every other single-use secret in this codebase (firm_login_tokens'
-- own shape: raw value shown/emailed once, only the hash stored, used_at
-- marks consumption). A SET of codes per member doesn't fit a single-row
-- ALTER -- needs its own table.
CREATE TABLE IF NOT EXISTS firm_member_backup_codes (
    id TEXT PRIMARY KEY,
    member_id TEXT NOT NULL REFERENCES firm_members(id),
    code_hash TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_firm_member_backup_codes_member_id ON firm_member_backup_codes (member_id);

-- The "password/magic-link proven, TOTP not yet entered" gap -- nothing
-- like this exists anywhere in this codebase today (every existing session
-- is fully authenticated the instant it's created). A genuinely separate,
-- short-TTL (2-5 min), single-use, hash-stored token, mirroring
-- firm_login_tokens' own shape rather than diluting either firm_sessions'
-- ("this row is a real, complete session") or firm_login_tokens' ("this
-- row proves inbox control") invariants.
--
-- purpose/pending_new_email carry the ORIGINAL login-token's own intent
-- forward, since that token is already consumed by the time 2FA gates the
-- request -- the deferred continuation (email apply, password-set,
-- destination routing, createSession) replays those exact same
-- purpose-specific side effects only once TOTP succeeds. Gating at the
-- EARLIEST point (right after the original token is verified, before ANY
-- side effect) rather than only before createSession() -- see totp.ts's
-- own docstring for the real gap that ordering closes (a stolen/live
-- session could otherwise request an email change and complete the
-- takeover via the confirm click alone, no TOTP required).
--
-- attempts bounds brute-force guessing of the 6-digit code independent of
-- the token's own expiry -- a long-enough-lived window alone doesn't stop
-- a fast guesser; a hard attempt cap does.
CREATE TABLE IF NOT EXISTS firm_2fa_pending_tokens (
    id TEXT PRIMARY KEY,
    member_id TEXT NOT NULL REFERENCES firm_members(id),
    firm_id TEXT NOT NULL REFERENCES firms(id),
    token_hash TEXT NOT NULL UNIQUE,
    purpose TEXT NOT NULL,
    pending_new_email TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_firm_2fa_pending_tokens_member_id ON firm_2fa_pending_tokens (member_id);
