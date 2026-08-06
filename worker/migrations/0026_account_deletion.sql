-- Task #3 (2026-08-06, Devin's decision): self-serve account deletion.
--
-- Soft-deactivate immediately (status='deleted' -- requireFirmSession()
-- already treats ANY non-'active' status as denied, so this alone blocks
-- every future login/API call with zero other code changes), then a real
-- hard delete after a 30-day grace period (see the daily cron's
-- hardDeleteExpiredFirms() sweep). deletion_requested_at is what that sweep
-- compares against. deletion_survey_reason/detail are the optional,
-- skippable exit-survey fields -- kept in the DB (not just emailed) so the
-- feedback survives even if the notification email fails or Devin doesn't
-- see it right away.
ALTER TABLE firms ADD COLUMN deletion_requested_at TEXT;
ALTER TABLE firms ADD COLUMN deletion_survey_reason TEXT;
ALTER TABLE firms ADD COLUMN deletion_survey_detail TEXT;
