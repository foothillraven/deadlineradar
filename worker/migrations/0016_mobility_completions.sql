-- Practice-privilege completion tracking (2026-08-04, Devin-requested live).
--
-- The Map view's "Action required" verdict was purely LIVE/ephemeral -- evaluateMobility()
-- re-runs on every dropdown change against mobility_rules.json's current text, with nothing
-- persisted anywhere. There was no way for a firm to record "we did the paperwork for this
-- person/state" and have the map reflect it; it would show orange forever regardless of what
-- the firm actually did, since the engine has no memory and self-attested facts
-- (license_in_good_standing/substantially_equivalent) aren't stored per staff member either.
--
-- Deliberately a SEPARATE signal from the engine's own verdict, not a way to override it:
-- Devin's own call (asked directly) was that a self-reported completion must render visually
-- DISTINCT from an independently rule-verified "Clear" on the map -- same "never let a UI claim
-- more certainty than what's actually verified" discipline this whole session's AuditLab-driven
-- data fixes (DATA-1 through DATA-4) have been enforcing on the citation/provenance side. The
-- worker only records THAT a firm marked something complete and WHEN against what rule version;
-- it never asserts the underlying legal work was actually done correctly.
--
-- Same modeling convention as migration 0009's cpe_entries: firm_id + subscriber_id both bound
-- (every store.ts read/write scopes on firm_id, never subscriber_id alone), soft-delete via
-- deleted_at so un-marking something doesn't destroy the record of who marked it and when.
--
-- rule_verified_date snapshots mobility_rules.json's verified_date for target_state_slug AT
-- completion time (nullable -- the row is written from generate.py's build-time data, not always
-- guaranteed present at the exact moment of a request). Comparing this snapshot against the
-- CURRENT rule's verified_date is how the app can tell "this completion was recorded against a
-- rule that has since changed" and prompt a re-check, rather than trusting an attestation forever
-- once the underlying law has moved -- the same staleness posture MOBILITY_VERIFICATION_TTL_DAYS
-- already enforces on the engine's own live verdicts (mobility.ts's isRuleStale()).
--
-- One active completion per (subscriber, target state, service type) is enforced in store.ts
-- (an upsert against the not-deleted row, if any) rather than a DB-level partial unique index --
-- no existing migration in this repo uses a partial index yet, and the invariant is no different
-- in kind from every other "look up the live row, then act" pattern store.ts already uses
-- (renewAndRearm, markReminderSent, etc.).
CREATE TABLE IF NOT EXISTS mobility_completions (
    id TEXT PRIMARY KEY,
    firm_id TEXT NOT NULL REFERENCES firms(id),
    subscriber_id TEXT NOT NULL REFERENCES subscribers(id),
    target_state_slug TEXT NOT NULL,
    service_type TEXT NOT NULL,       -- 'tax' | 'attest' | 'other_non_attest' -- mirrors mobility.ts's ServiceType
    rule_verified_date TEXT,          -- snapshot of mobility_rules.json's verified_date at completion time, nullable
    completed_at TEXT NOT NULL,
    completed_by_firm_session_id TEXT,
    deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_mobility_completions_firm_id ON mobility_completions (firm_id);
CREATE INDEX IF NOT EXISTS idx_mobility_completions_subscriber_id ON mobility_completions (subscriber_id);
