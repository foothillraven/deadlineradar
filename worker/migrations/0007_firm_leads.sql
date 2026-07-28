-- Firm-tier lead capture (2026-07-28 firm-landing rewrite).
--
-- The /for-firms/ page's CTA used to be a mailto: link. It's now a real form
-- (POST /api/firm/lead, see index.ts's handleFirmLead()) that records a
-- firm's interest in early access to the self-serve firm dashboard -- a
-- SEPARATE build, not this one, that doesn't exist yet. This table is
-- deliberately NOT the subscribers table: a lead here has not agreed to
-- receive reminder emails, has not confirmed anything, and gets no tokens
-- (confirm/unsubscribe/renewed) at all -- it's just "someone typed their
-- email into this form," recorded so we can email the list once self-serve
-- signup opens. No double opt-in, no reminder lifecycle -- see store.py's
-- subscriber lifecycle docstring (add_pending -> confirm -> stop/rearm) for
-- what this table deliberately does NOT do.
--
-- Timestamps follow the same convention as subscribers.created_at
-- (migration 0001): ISO-8601 UTC TEXT, matching store.ts's `nowIso()`.
--
-- converted_at is nullable and unused by any Phase-1 code path -- reserved
-- for whenever the self-serve dashboard ships, so a later migration/backfill
-- can stamp it when a lead actually creates a real firm account, without
-- needing a schema change at that point.

CREATE TABLE IF NOT EXISTS firm_leads (
    -- Same shape as subscribers.id (migration 0001): a CSPRNG token, not an
    -- autoincrement int -- store.ts's newToken() is reused for this, too.
    id TEXT PRIMARY KEY,

    -- The email the firm admin typed into the form. Not normalized/folded
    -- here (same posture as subscribers.email) -- this table has no
    -- cooldown/dedupe logic that would need a folded comparison key.
    email TEXT NOT NULL,

    -- Free-text firm name as typed into the form. Nullable: the form marks
    -- it required client-side, but server-side validation only rejects
    -- control characters and an oversized value (validation.ts), not an
    -- empty string -- matching how first_name is handled on subscribers.
    firm_name TEXT,

    -- Free-text "approx. staff count" hint from the form (e.g. "8" or
    -- "10-15"). Deliberately TEXT, not INTEGER: the form field accepts
    -- either a number or a loose range, and this is a marketing-intent
    -- hint for outreach, not a value any code path computes against.
    staff_count_hint TEXT,

    created_at TEXT NOT NULL,

    -- NULL until (if ever) this lead converts into a real firm-dashboard
    -- account. Nothing in Phase 1 sets this -- see the file-level comment
    -- above.
    converted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_firm_leads_email ON firm_leads (email);
