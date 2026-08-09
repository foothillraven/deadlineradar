-- AuditLab SMS-3 (MEDIUM, 2026-08-09): TCPA requires PRIOR EXPRESS WRITTEN
-- consent, and the burden of proof is on the sender. Before this, the only
-- consent check was a client-side checkbox -- never transmitted to the
-- server, never recorded. sms_opted_in_at is a real, useful timestamp, but
-- it records when phone verification COMPLETED, not that consent was
-- asserted or which disclosure text was shown at the time. In a dispute,
-- "our JavaScript required a checkbox" is materially weaker than a stored
-- consent record (timestamp + IP + disclosure version).
--
-- consent_version/consent_ip land on subscriber_phone_verifications FIRST
-- (consent is asserted at START-verification time) and are carried onto
-- the subscriber row's sms_consent_version/sms_consent_ip by
-- setSubscriberSmsOptedIn() only once CONFIRM-verification succeeds --
-- same "record survives to the row that matters" shape phone_number
-- already has.
ALTER TABLE subscribers ADD COLUMN sms_consent_version TEXT;
ALTER TABLE subscribers ADD COLUMN sms_consent_ip TEXT;
ALTER TABLE subscriber_phone_verifications ADD COLUMN consent_version TEXT;
ALTER TABLE subscriber_phone_verifications ADD COLUMN consent_ip TEXT;
