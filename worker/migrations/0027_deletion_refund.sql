-- Task #32 (2026-08-06, Devin's decision): prorated refund on account
-- deletion, distinct from plain cancellation which stays no-refund/access-
-- continues-to-period-end. Stored durably on the firm row (not just
-- emailed as an internal notification) for the same reason the deletion
-- exit survey is -- this is real money moving, and "we sent an email"
-- is not an audit trail. deletion_refund_id is Stripe's own refund id
-- (re_...), the authoritative cross-reference into the Stripe dashboard.
-- Both null when no refund applied (no subscription, a $0 invoice, or the
-- unused-time proration rounded to $0).
ALTER TABLE firms ADD COLUMN deletion_refund_cents INTEGER;
ALTER TABLE firms ADD COLUMN deletion_refund_id TEXT;
