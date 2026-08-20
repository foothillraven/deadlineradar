-- AuditLab SILENT-1 (HIGH, 2026-08-19): a confirmed subscriber whose
-- deadline_fields no longer resolve to a computable deadline (a mandatory
-- signup field added after they subscribed, a state removed from support,
-- a data bug) gets no reminder, ever, with nothing on their end -- or ours,
-- until now -- to reveal it. runReminderPass()'s own summary already
-- counts these (`skipped_no_deadline`) every single cron run; the count
-- just evaporated into a console.log line nobody durably watches.
--
-- One row per currently-affected subscriber, upserted every cron run (see
-- store.ts's logSilentDrop()): first_detected_at never changes once set,
-- last_seen_at advances on every run that still can't compute a deadline,
-- resolved_at is set the run a subscriber's deadline becomes computable
-- again (so "how long has this been broken" and "did it ever get fixed"
-- are both answerable from this table alone, not just "is it broken right
-- now"). scripts/silent_dropped_subscribers_check.py reads this as the
-- historical half of its report, alongside its own live D1 check.
CREATE TABLE IF NOT EXISTS silent_drop_log (
    subscriber_id TEXT PRIMARY KEY,
    email TEXT NOT NULL, -- snapshot at detection time; subscribers.email may change or the row may later be deleted
    state_slug TEXT NOT NULL,
    reason TEXT NOT NULL, -- e.g. "no_computable_deadline", "unknown_state"
    first_detected_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    resolved_at TEXT -- NULL while still affected; set (and left set) once a run finds a computable deadline again
);
