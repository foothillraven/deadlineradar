-- AuditLab SLACK-1 (MEDIUM, 2026-08-09): slack_webhook_url and
-- teams_webhook_url were stored plaintext while the Slack access token sits
-- beside it AES-GCM encrypted -- but a webhook URL IS itself a live bearer
-- credential (possession alone posts to that channel, no token required),
-- so the encryption protected the credential used only on disconnect and
-- left the one used on every single post in the clear. See
-- encryptSecretAesGcm()/decryptSecretAesGcm() (totp.ts) for the primitive
-- both columns now use, same as slack_access_token_encrypted already does.
--
-- No data migration here: encryption requires Workers crypto (AES-GCM),
-- not expressible in SQL. Any pre-existing plaintext slack_webhook_url/
-- teams_webhook_url is left as-is by this migration -- store.ts's read path
-- now expects ciphertext there, so an old plaintext value will fail to
-- decrypt (fails closed -- see decryptSecretAesGcm's own "never throws,
-- returns null" contract) rather than being sent somewhere as garbage.
-- Both integrations shipped this session with no production OAuth/webhook
-- secrets configured yet, so no real firm has a live connection to lose;
-- worst case is a one-time reconnect.
ALTER TABLE firms ADD COLUMN slack_webhook_url_iv TEXT;
ALTER TABLE firms ADD COLUMN teams_webhook_url_iv TEXT;
