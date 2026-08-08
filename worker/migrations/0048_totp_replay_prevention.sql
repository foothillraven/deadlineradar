-- AuditLab 2FA-1 (MEDIUM, 2026-08-07): RFC 6238 Section 5.2 replay
-- prevention. See store.ts's setFirmMemberTotpLastUsedTimestep() for the
-- full reasoning -- without this, the same TOTP code accepted once could be
-- accepted again by a second, independent login attempt within its ~90s
-- validity window (a +/-1 step window means 3 codes are valid at any
-- instant), which is exactly what a real-time phishing proxy relies on.
ALTER TABLE firm_members ADD COLUMN totp_last_used_timestep INTEGER;
