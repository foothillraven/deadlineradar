-- Paid tiers + Stripe billing (2026-08-05).
--
-- Additive only -- no existing column touched, no existing row rewritten.
-- All 6 production `firms` rows are plan_tier='pilot' today (verified before
-- writing this migration), so there is no billing history to migrate and no
-- existing plan_tier value collides with the new tier names this introduces
-- (firm_starter / firm_growth / firm_standard, see entitlements.ts).

ALTER TABLE firms ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE firms ADD COLUMN stripe_subscription_id TEXT;

CREATE INDEX idx_firms_stripe_subscription_id ON firms (stripe_subscription_id);

-- Idempotency ledger for /stripe/webhook -- Stripe's own event.id as the
-- primary key, so a redelivered event (Stripe retries on anything but a 2xx)
-- is a harmless INSERT OR IGNORE no-op rather than double-applying a plan
-- change. Mirrors the "let a DB unique constraint be the race guard" idiom
-- handleFirmSignup() already uses.
CREATE TABLE stripe_webhook_events (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    firm_id TEXT REFERENCES firms(id),
    received_at TEXT NOT NULL,
    processed_at TEXT
);

-- The $39/yr Individual tier. Keyed on email_normalized, not a surrogate id
-- -- matching subscriber_sessions' (migration 0012) own reasoning that
-- identity here is the email, not a row: one email can own many `subscribers`
-- rows (one per state), so there is no single existing row to hang billing
-- state on. Created lazily (plan_tier='pilot') the first time an individual
-- reaches a premium surface -- see store.ts's getOrCreateIndividualAccount().
CREATE TABLE individual_accounts (
    email_normalized TEXT PRIMARY KEY,
    plan_tier TEXT NOT NULL DEFAULT 'pilot',
    status TEXT NOT NULL DEFAULT 'active',
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX idx_individual_accounts_stripe_subscription_id
    ON individual_accounts (stripe_subscription_id);

-- Individual's own CPE/mobility data lives in parallel tables, not a
-- nullable firm_id retrofit on cpe_entries/mobility_completions (migrations
-- 0009/0016): D1/SQLite can't drop a NOT NULL constraint in place, a
-- nullable firm_id would force every existing firm-scoped query to
-- defensively guard against matching an individual's row, and it keeps the
-- "every read/write scopes on firm_id" invariant those tables' own
-- docstrings assert. Shapes intentionally mirror the firm-scoped originals.
CREATE TABLE individual_cpe_entries (
    id TEXT PRIMARY KEY,
    email_normalized TEXT NOT NULL REFERENCES individual_accounts(email_normalized),
    state_slug TEXT NOT NULL,
    hours REAL NOT NULL,
    category TEXT,
    completed_on TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX idx_individual_cpe_entries_email ON individual_cpe_entries (email_normalized);

CREATE TABLE individual_mobility_completions (
    id TEXT PRIMARY KEY,
    email_normalized TEXT NOT NULL REFERENCES individual_accounts(email_normalized),
    home_state_slug TEXT NOT NULL,
    target_state_slug TEXT NOT NULL,
    completed_on TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX idx_individual_mobility_completions_email
    ON individual_mobility_completions (email_normalized);
