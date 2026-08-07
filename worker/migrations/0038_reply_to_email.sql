-- Roadmap #19 (2026-08-07): white-label reminder emails, lightweight scope (Devin's decision,
-- asked directly -- see that decision's own rationale). Two things this feature actually does:
-- (1) the firm's own name (firms.name, already exists) is now shown in the reminder email body for
-- firm-tracked subscribers, (2) an optional admin-set reply-to address routes a recipient's reply to
-- the firm instead of DeadlineRadar. Deliberately NOT full white-label -- no per-firm sending-domain
-- verification (SPF/DKIM), no logo upload, DeadlineRadar's own required footer/unsubscribe/physical
-- address stays exactly as-is. The email is still SENT from noreply@deadline-radar.com; only the
-- Reply-To header and body content change.
ALTER TABLE firms ADD COLUMN reply_to_email TEXT;
