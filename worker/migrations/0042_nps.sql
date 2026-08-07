-- Roadmap #144 (2026-08-07): 1-question NPS/CSAT micro-survey, fired after a
-- "Mark renewed" action (a genuine, positive-feeling moment in the product)
-- or quarterly if the firm hasn't been asked recently. nps_last_prompted_at
-- tracks the last time the prompt was SHOWN (answered or dismissed either
-- way) so it never nags more than once per quarter; the actual responses
-- live in their own table since a firm may reasonably answer more than once
-- over time and the history itself is the real signal, not just the latest
-- value.
ALTER TABLE firms ADD COLUMN nps_last_prompted_at TEXT;

CREATE TABLE IF NOT EXISTS firm_nps_responses (
    id TEXT PRIMARY KEY,
    firm_id TEXT NOT NULL REFERENCES firms(id),
    score INTEGER NOT NULL,
    submitted_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_firm_nps_responses_firm_id ON firm_nps_responses (firm_id);
