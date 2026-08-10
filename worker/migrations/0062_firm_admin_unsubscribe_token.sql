-- AuditLab UNSUB-2 (2026-08-10, HIGH): buildRuleChangeAdminAlertEmail and
-- buildAdminDigestEmail are the only two email builders left with no
-- List-Unsubscribe header at all (listUnsubHeaders() -- emails.ts -- is
-- already used by 6+ other builders). Both are addressed to
-- firm.admin_email, not a subscribers row, so there was no existing
-- per-firm token to build a one-click unsubscribe URL from --
-- subscribers.unsubscribe_token is per-STAFF-ROW, not per-firm, and
-- firm_login_tokens/firm_2fa_pending_tokens are auth tokens, not
-- unsubscribe tokens.
--
-- One persistent, never-rotating token per firm -- same shape and same
-- "never expires or rotates BY DESIGN" reasoning as subscribers.
-- unsubscribe_token (see handleUnsubscribe()'s own AuditLab UNSUB-1
-- comment in index.ts): a List-Unsubscribe header must keep working for
-- the life of every email it was ever stamped on, including ones already
-- delivered and sitting in an inbox.
ALTER TABLE firms ADD COLUMN admin_unsubscribe_token TEXT;

-- Backfill for every firm that already exists. lower(hex(randomblob(16)))
-- is the same SQL-native random-token generator migration 0045 already
-- used to backfill firm_members.id for pre-migration firms -- createFirm()
-- itself uses the stronger JS newToken() (32 random bytes) for every firm
-- created from here on; only this one-time backfill needs a SQL-native
-- generator, same asymmetry 0045 already established.
UPDATE firms SET admin_unsubscribe_token = lower(hex(randomblob(16))) WHERE admin_unsubscribe_token IS NULL;

-- Looked up by token on every hit of the new unauthenticated GET
-- /firm-admin-unsubscribe route -- same reasoning as subscribers'
-- existing unsubscribe_token index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_firms_admin_unsubscribe_token ON firms (admin_unsubscribe_token);
