-- Task #7 (2026-08-06): admin-controlled block for abusive emails/domains.
--
-- Distinct from validation.ts's DISPOSABLE_EMAIL_DOMAINS / COMPETITOR_EMAIL_
-- DOMAINS (compiled-in, curated once, redeploy to change) -- this is an
-- operator-managed list (add/remove without a redeploy) for abuse cases that
-- show up live: a specific address or domain sending junk signups, not a
-- known temp-mail/competitor pattern. `pattern` stores either a full lower-
-- cased email address (pattern_type='email') or a bare domain with no `@`
-- (pattern_type='domain', matched the same way matchesBlockedDomain() in
-- validation.ts already does -- exact match or real subdomain).
CREATE TABLE IF NOT EXISTS signup_blocklist (
    id TEXT PRIMARY KEY,
    pattern TEXT NOT NULL UNIQUE,
    pattern_type TEXT NOT NULL, -- 'email' | 'domain'
    note TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_signup_blocklist_pattern ON signup_blocklist(pattern);
