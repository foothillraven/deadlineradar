-- AuditLab STALE-10 (LOW, 2026-08-21, orchestrator-approved): all 110
-- mobility_rules.json/firm_mobility_rules.json rows were verified inside
-- one ~17-day burst, so every row expires inside one ~17-day window
-- starting 2027-01-27 -- the feature would degrade to not_verified for
-- state after state with no warning beforehand. This is the dedup log for
-- the pre-expiry alert (fires once any row enters its TTL-30 warning
-- window): month-keyed, not day-keyed, since a 30-day warning window only
-- needs a periodic reminder, not a daily nag -- same INSERT-and-report-
-- whether-it-landed shape as stale_data_alert_log (0064), just coarser
-- granularity for a slower-moving signal.

CREATE TABLE IF NOT EXISTS mobility_staleness_alert_log (
    month TEXT PRIMARY KEY, -- UTC month, ISO 'YYYY-MM'
    sent_at TEXT NOT NULL
);
