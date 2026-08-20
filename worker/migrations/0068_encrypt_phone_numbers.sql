-- AuditLab SMS-2, restated (2026-08-20): phone_number was stored plaintext
-- in both subscribers and subscriber_phone_verifications, the one
-- recoverable-PII field in this codebase that never got the AES-GCM
-- at-rest treatment already established for slack_access_token_encrypted
-- and the TOTP secret (see totp.ts's encryptSecretAesGcm()).
--
-- Additive only -- this migration does NOT touch the existing plaintext
-- phone_number columns or backfill them. That is deliberate: a live data
-- migration re-encrypting real subscriber PII is its own gated step (see
-- HANDOFF.md), run once via a dedicated backfill path after this schema
-- change ships, not embedded in a SQL migration that can't call
-- crypto.subtle. Until the backfill runs and the code cutover lands,
-- phone_number keeps meaning "plaintext"; after, it means "AES-GCM
-- ciphertext" -- same column-name-reuse convention SLACK-1 already used
-- for slack_webhook_url, so no rename ripples through every read site.
--
-- subscribers.phone_number_hash is a deterministic HMAC-SHA256 blind
-- index (see totp.ts's hmacBlindIndex()) -- the Twilio inbound STOP
-- webhook identifies the sender ONLY by phone number, with no other key
-- to look the row up by, and AES-GCM's random IV makes ciphertext
-- unusable for an equality WHERE clause. The hash lets that lookup keep
-- working without ever decrypting a row to compare it.
ALTER TABLE subscribers ADD COLUMN phone_number_iv TEXT;
ALTER TABLE subscribers ADD COLUMN phone_number_hash TEXT;

ALTER TABLE subscriber_phone_verifications ADD COLUMN phone_number_iv TEXT;
