-- Roadmap #1/#2 (2026-08-07, roadmap_items table, IMMEDIATE RELEASE):
-- "Documents: upload/store license certificates per staff member" and
-- "Documents: upload/store CPE completion certificates" -- the same
-- underlying capability (a per-subscriber file attachment), split only by
-- `kind`. Free-tier feature (Devin's explicit call, same "Compliance Depth"
-- reasoning that already applies to CPE-hour tracking).
--
-- D1 holds only METADATA -- the actual file bytes live in R2 (bucket
-- `deadlineradar-documents`, binding DOCUMENTS in wrangler.toml), keyed by
-- `r2_key`. This was a deliberate wait: R2 was not enabled on this
-- Cloudflare account until Devin did a one-time manual Dashboard step
-- (2026-08-07) -- see that decision's own record in HANDOFF.md. Storing
-- file bytes directly as a D1 BLOB was considered and rejected: D1 caps a
-- single value at 2MB, but the interaction between that cap and D1's
-- 100,000-byte-per-SQL-statement limit for BOUND PARAMETERS is not
-- documented anywhere in Cloudflare's own docs -- not something to build a
-- real feature around.
--
-- Same one-to-many-per-subscriber shape as cpe_entries (migration 0009):
-- firm_id AND subscriber_id both bound into every store.ts query on this
-- table (never "fetch by id alone then check firm_id in application
-- code"), soft-delete via deleted_at rather than a real DELETE.
CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    firm_id TEXT NOT NULL REFERENCES firms(id),
    subscriber_id TEXT NOT NULL REFERENCES subscribers(id),
    kind TEXT NOT NULL,               -- 'license' | 'cpe' -- see store.ts DOCUMENT_KINDS
    r2_key TEXT NOT NULL,             -- object key in the DOCUMENTS R2 bucket; bytes live there, not here
    filename TEXT NOT NULL,           -- original filename, sanitized + length-capped server-side
    content_type TEXT NOT NULL,       -- one of the server-side allowlist -- see store.ts DOCUMENT_ALLOWED_CONTENT_TYPES
    size_bytes INTEGER NOT NULL,
    uploaded_at TEXT NOT NULL,
    deleted_at TEXT
);

-- cpe_entries.certificate_document_id (migration 0009) is the intended
-- link from a logged CPE entry to its supporting certificate -- no schema
-- change needed there, exactly as that column's own comment anticipated.
CREATE INDEX IF NOT EXISTS idx_documents_firm_id ON documents (firm_id);
CREATE INDEX IF NOT EXISTS idx_documents_subscriber_id ON documents (subscriber_id);
