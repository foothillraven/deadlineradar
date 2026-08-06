-- Task #26 (2026-08-06, Devin's decision: build a durable log).
--
-- drRenderActivity() previously derived its feed by iterating the LIVE
-- roster array (drLicenses) and reading each item's own timestamp columns.
-- Reported bug: edit a staffer (confirmed), then remove them -- reload the
-- page, Recent Activity shows neither event, just stale earlier ones. Root
-- cause: listFirmLicenses() deliberately excludes admin-removed rows (see
-- its own comment) so the removed row -- and by then, its edit too -- simply
-- never appears in the array drRenderActivity() reads from again. A durable
-- log independent of current roster membership is the only fix; a display
-- tweak can't work when the source data itself excludes the row.
--
-- staff_label/email are SNAPSHOTS at event time, not a live join back to
-- subscribers -- this row must keep reading correctly even after the
-- subscriber it describes is later removed (soft-deleted, in this schema)
-- or its label/email changes again. No FOREIGN KEY on subscriber_id for the
-- same reason: this table's whole purpose is to outlive changes to the row
-- it references, so a REFERENCES constraint would be actively wrong here,
-- not just unnecessary.
CREATE TABLE IF NOT EXISTS activity_log (
    id TEXT PRIMARY KEY,
    firm_id TEXT NOT NULL,
    subscriber_id TEXT NOT NULL,
    staff_label TEXT,
    email TEXT NOT NULL,
    event_type TEXT NOT NULL, -- 'added' | 'edited' | 'removed' | 'renewed' | 'opted_out'
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_log_firm ON activity_log(firm_id, created_at DESC);
