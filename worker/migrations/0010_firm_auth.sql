-- Full auth suite (2026-07-30): email+password, Microsoft/Google SSO, and
-- the demotion of the emailed magic link to password-reset duty.
--
-- Until now a firm's ONLY credential was the emailed one-time link
-- (migration 0008's firm_login_tokens). That flow stays exactly as-is
-- mechanically -- this migration adds two NEW ways to authenticate
-- alongside it, and nothing here changes how an existing firm signs in
-- until it actually sets a password or links a provider. Every column
-- added to `firms` is NULLABLE precisely so every pre-existing row stays
-- valid and keeps working on the magic-link path.
--
-- WHY THE PASSWORD PARAMETERS ARE STORED PER-ROW rather than hardcoded:
-- Cloudflare Workers hard-caps a single PBKDF2 deriveBits() call at
-- 100,000 iterations (`NotSupportedError` above that), and the edge CPU
-- budget caps CHAINED rounds at ~200,000 effective iterations before
-- requests start failing with "error code: 1102 / Worker exceeded
-- resource limits". Both limits were measured against the real edge on
-- 2026-07-30 -- local workerd enforces NEITHER (it ran 600,000 happily),
-- so this is not a number that can be taken from a recommendation and
-- trusted. OWASP's 2023 guidance for PBKDF2-HMAC-SHA256 is 600,000; this
-- product can reliably reach 200,000. That gap is deliberate, known, and
-- documented rather than papered over -- and storing `password_algo` /
-- `password_iterations` / `password_rounds` PER ROW means the work factor
-- can be raised later (on a plan with more CPU headroom, or a future
-- native KDF) with a transparent re-hash on the user's next successful
-- login, and NO schema migration.

-- Nullable by design: a firm that only ever uses SSO, or that still uses
-- the magic link, has no password at all -- which is a valid, supported
-- state, not an incomplete record.
ALTER TABLE firms ADD COLUMN password_hash TEXT;
ALTER TABLE firms ADD COLUMN password_salt TEXT;
ALTER TABLE firms ADD COLUMN password_algo TEXT;
ALTER TABLE firms ADD COLUMN password_iterations INTEGER;
ALTER TABLE firms ADD COLUMN password_rounds INTEGER;
ALTER TABLE firms ADD COLUMN password_updated_at TEXT;

-- One row per (provider, provider account) linked to a firm.
--
-- provider_subject is the provider's STABLE opaque user id (the OIDC `sub`
-- claim) -- deliberately NOT the email. Emails get reassigned inside a
-- tenant (an employee leaves, the address is reused), and Microsoft/Google
-- both document `sub` as the only durable identifier. Matching on email
-- alone would mean whoever inherits an address inherits the firm account.
--
-- UNIQUE(provider, provider_subject) is the real anti-takeover constraint:
-- one provider account can be bound to at most one firm, so a second firm
-- cannot silently claim an already-linked identity.
CREATE TABLE IF NOT EXISTS firm_oauth_identities (
    id TEXT PRIMARY KEY,
    firm_id TEXT NOT NULL REFERENCES firms(id),
    provider TEXT NOT NULL,
    provider_subject TEXT NOT NULL,
    provider_email TEXT,
    created_at TEXT NOT NULL,
    last_login_at TEXT,
    UNIQUE (provider, provider_subject)
);

CREATE INDEX IF NOT EXISTS idx_firm_oauth_identities_firm_id ON firm_oauth_identities (firm_id);

-- In-flight OAuth handshakes. One row per /firm/auth/<provider>/start,
-- consumed (used_at) by the matching callback.
--
-- This table is what makes the callback safe, and each column earns its
-- place against a specific attack:
--   * state_hash    -- CSRF on the callback. The raw state goes to the
--                      provider and comes back in the URL; only its hash
--                      is stored, matching this codebase's existing
--                      "never persist a live bearer value" convention for
--                      login/session tokens (migration 0008).
--   * code_verifier -- PKCE (RFC 7636). Binds the authorization code to
--                      THIS handshake, so an intercepted code is useless
--                      without the verifier.
--   * nonce         -- replay defense on the ID token; echoed back as a
--                      claim and checked to match.
--   * expires_at    -- a handshake is short-lived; a stale state is
--                      rejected like an invalid one.
--   * used_at       -- single-use, so a captured callback URL cannot be
--                      replayed to mint a second session.
CREATE TABLE IF NOT EXISTS firm_oauth_states (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    state_hash TEXT NOT NULL UNIQUE,
    code_verifier TEXT NOT NULL,
    nonce TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_firm_oauth_states_expires_at ON firm_oauth_states (expires_at);
