-- AuditLab STALE-3 (MEDIUM, 2026-08-09/2026-08-13): checkDataFreshness()'s
-- guard correctly pauses signups and every outbound-send cron pass once
-- data/cpa_deadlines.json's as_of_date is >30 days old, but the only signal
-- an operator had was a console.log nobody watches. Same shape as
-- send_counters (0004): one row per UTC day, a single atomic UPSERT decides
-- who "wins" the alert for that day. Up to ~7 independent cron passes can
-- all hit the same StaleDataError in the same tick (and again every tick
-- after, for as long as the pause lasts) -- this table is what limits a
-- real, ongoing pause to exactly one email per day instead of one per pass
-- per tick.

CREATE TABLE IF NOT EXISTS stale_data_alert_log (
    day TEXT PRIMARY KEY, -- UTC date, ISO 'YYYY-MM-DD'
    sent_at TEXT NOT NULL
);
