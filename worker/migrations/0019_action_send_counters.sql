-- AuditLab TS-1 (HIGH, 2026-08-05): the ad-blocker Turnstile fallback
-- (allowMissingToken) let token-less submissions to 5 routes reach a real
-- SendGrid send, and every one of those sends was charged against the SAME
-- global `send_counters` day-row the reminder SCHEDULER also spends from
-- (scheduler.ts:239, same checkAndCountSend()/DEFAULT_DAILY_SEND_CAP=300).
-- Each relaxed route's own per-IP rate limit is a SEPARATE bucket, so one IP
-- could burn up to 25 token-less sends per 10-minute window -- exhausting
-- the shared 300/day budget in hours, at which point `if (!underCap) return`
-- silently skips every REAL deadline reminder for the rest of the UTC day.
-- For a product whose entire promise is "we email you before your renewal
-- is due", that is the core function failing silently.
--
-- Fix: give action/signup emails (confirmation, firm-lead, firm-signup
-- login link, firm-login magic link, subscriber-login magic link) their OWN
-- counter, structurally identical to send_counters but a separate table --
-- not a shared `bucket` column on the existing one, because SQLite can't
-- ALTER a PRIMARY KEY in place and this avoids touching the scheduler's
-- already-proven counter at all. Now the worst a token-less spam wave can
-- do is exhaust the ACTION-email budget (degraded signup/login-link
-- delivery for the rest of the day) -- annoying, but never the reminder
-- promise itself.
CREATE TABLE IF NOT EXISTS action_send_counters (
    day TEXT PRIMARY KEY, -- UTC date, ISO 'YYYY-MM-DD'
    count INTEGER NOT NULL DEFAULT 0
);
