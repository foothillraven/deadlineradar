-- Daily send-counter storage backing the circuit breaker in ../src/sender.ts
-- (checkAndCountSend). One row per UTC day; a single UPSERT increments the
-- day's count and the caller refuses the send once it reaches the cap. This
-- is the D1 port of reminders/sender.py's CircuitBreakerSender daily cap --
-- see that class's docstring for why a hard daily cap protects sender
-- reputation (a bug or attack that tries to blow through thousands of sends
-- in a burst gets the whole domain flagged, killing deliverability for every
-- legitimate subscriber). SQLite's INSERT ... ON CONFLICT DO UPDATE is atomic
-- within the single D1 statement, so the read-modify-write can't race the way
-- the Python file needed an explicit process-wide lock to prevent.
--
-- New migration file rather than editing 0001-0003, per this repo's migration
-- discipline (never rewrite an already-numbered migration).

CREATE TABLE IF NOT EXISTS send_counters (
    day TEXT PRIMARY KEY, -- UTC date, ISO 'YYYY-MM-DD'
    count INTEGER NOT NULL DEFAULT 0
);
