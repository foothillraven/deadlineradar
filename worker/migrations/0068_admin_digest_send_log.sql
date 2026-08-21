-- Orchestrator directive (2026-08-21, Devin: "we need to fix this"), filed
-- during the DEAD-2 investigation: the incident's own evidence --
-- firm_admin_digest_notified_thresholds -- turned out to be the WRONG
-- table for the question "who did we actually email, and when" (see
-- AuditLab DEAD-3, same date). That table is a per-(subscriber, threshold)
-- dedup key with no firm_id and no outcome column; it can tell you a send
-- was CLAIMED, never who received it or whether it succeeded.
--
-- This is the durable, append-only answer, modeled on activity_log
-- (migration 0025) rather than extending the dedup table's own semantics --
-- one row per actual send ATTEMPT (the `send(firm.admin_email, built)` call
-- site in runAdminDigestAlertPass()), not per staff-threshold item, so
-- staff_count is what actually resolves DEAD-3's "1 to 6 emails" ambiguity
-- going forward. admin_email is a SNAPSHOT (no FK, same reasoning as
-- activity_log's own snapshot columns) -- this table must keep reading
-- correctly even after a firm's admin_email changes later. outcome is
-- 'sent' or 'failed'; a failed attempt is logged too, since "we tried to
-- email this firm and it didn't go out" is exactly the kind of gap this
-- table exists to close.
--
-- Independent of whether the admin digest ever gets un-paused (see the
-- 2026-08-18 incident note in worker/src/index.ts) -- this ships as
-- hardening regardless, per the directive.
CREATE TABLE IF NOT EXISTS admin_digest_send_log (
    id TEXT PRIMARY KEY,
    firm_id TEXT NOT NULL,
    admin_email TEXT NOT NULL,
    thresholds TEXT NOT NULL,     -- JSON array of the threshold-days values covered by this send, e.g. "[7,30]"
    staff_count INTEGER NOT NULL, -- how many staff-threshold items this send covered
    outcome TEXT NOT NULL,        -- 'sent' | 'failed'
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_digest_send_log_firm ON admin_digest_send_log(firm_id, created_at DESC);
