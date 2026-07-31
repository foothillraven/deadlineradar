-- CPE-hours tracker, v1 (2026-07-30, BUILD v2 new phase, Devin-approved).
--
-- Lightweight INTERNAL firm visibility only -- per the directive's own hard lane constraint,
-- this is explicitly NOT an official state-reporting integration (CE Broker is the mandated
-- official reporter in several states, e.g. Florida -- we do not compete there), NOT a CPE
-- course marketplace, and NOT a provider integration. It is: an admin (v1) logs a staffer's
-- completed hours, we show progress against the requirement data this project already
-- verifies and publishes (data/cpe_hours.json), and flag who's behind with lead time.
--
-- Forward-compat design (per the orchestrator's addendum, Devin's product direction: a future
-- individual staffer should be able to log their OWN hours, not just an admin) -- two columns
-- exist specifically so that future actor type doesn't need a schema change:
--   entered_by_actor_type: 'admin' (the only value v1 ever writes) | future 'staff'.
--   entered_by_firm_session_id: which admin session created this entry. Nullable because a
--     future 'staff' actor type would authenticate via a different session table entirely (not
--     yet built), not this one -- the column is deliberately NOT NOT NULL, so adding that
--     actor type later is additive, not a migration that has to backfill or relax a constraint.
-- Every entry is still bound to firm_id AND subscriber_id (matching every existing table's
-- "always bind firm_id into the WHERE clause" convention) regardless of who logged it -- an
-- individual self-log later would still write into a roster record that belongs to exactly one
-- firm, the same invariant this table already enforces for the admin-only v1 path.
--
-- Soft-delete via deleted_at (not a real DELETE), same convention as subscribers.stopped_at /
-- STOP_REASON_REMOVED_BY_ADMIN -- an admin correcting a mis-logged entry should not destroy the
-- audit trail of what was actually submitted and when.
CREATE TABLE IF NOT EXISTS cpe_entries (
    id TEXT PRIMARY KEY,
    firm_id TEXT NOT NULL REFERENCES firms(id),
    subscriber_id TEXT NOT NULL REFERENCES subscribers(id),
    entry_date TEXT NOT NULL,        -- ISO YYYY-MM-DD, the date the CPE was actually completed
    hours REAL NOT NULL,             -- validated server-side: > 0 and <= a sane per-entry cap
    category TEXT NOT NULL DEFAULT 'general',  -- 'general' | 'ethics' | 'other' -- see store.ts
    description TEXT,                -- optional short free text (provider/course name), sanitized
                                      -- + length-capped the same way staff_label/firm_name are
    certificate_document_id TEXT,    -- nullable; wires to BUILD v2 Phase G (document storage)
                                      -- once it lands -- additive, no schema change needed then
    entered_by_actor_type TEXT NOT NULL DEFAULT 'admin',
    entered_by_firm_session_id TEXT,
    created_at TEXT NOT NULL,
    deleted_at TEXT
);

-- The two real query directions this table needs: "every entry for firm X" (the dashboard's CPE
-- tab, rolled up per staffer) and "every entry for staffer Y" (per-person detail / progress
-- calc) -- both firm_id-bound at the SQL layer in every store.ts function that reads this table,
-- never "fetch by subscriber_id alone then check the firm in application code."
CREATE INDEX IF NOT EXISTS idx_cpe_entries_firm_id ON cpe_entries (firm_id);
CREATE INDEX IF NOT EXISTS idx_cpe_entries_subscriber_id ON cpe_entries (subscriber_id);
