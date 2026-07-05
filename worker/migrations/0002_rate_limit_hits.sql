-- Per-IP rate limiting storage -- see ../src/ratelimit.ts for the query
-- shape this table serves. New migration file rather than editing
-- 0001_init_schema.sql, per normal migration discipline (never rewrite an
-- already-numbered migration once later ones may depend on running after
-- it) -- also true here even though neither migration has been applied to
-- any real D1 instance yet.
--
-- One row per (ip, bucket) rate-limit "hit" (a timestamp of a request that
-- counted against the window). Rows older than the relevant window are
-- deleted opportunistically by ratelimit.ts on every check for that
-- ip+bucket, so this table self-trims rather than growing forever.

CREATE TABLE IF NOT EXISTS rate_limit_hits (
    ip TEXT NOT NULL,
    bucket TEXT NOT NULL,
    ts INTEGER NOT NULL -- unix seconds
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_ip_bucket_ts ON rate_limit_hits (ip, bucket, ts);
