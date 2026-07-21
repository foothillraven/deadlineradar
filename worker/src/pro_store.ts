/**
 * DeadlineRadar Pro -- D1 data access for accounts, sessions, and CPE-hour
 * entries. Same conventions as store.ts (SubscriberRow-style typed rows,
 * functions taking `db: D1Database` directly, ISO-8601 TEXT timestamps via
 * `nowIso()`).
 */
import { newToken } from "./store";
import { hashPassword, verifyPassword, SESSION_LIFETIME_SECONDS } from "./pro_auth";

function nowIso(): string {
  return new Date().toISOString();
}

export interface AccountRow {
  id: string;
  email: string;
  password_hash: string;
  password_salt: string;
  password_iterations: number;
  created_at: string;
  verified_at: string | null;
  verification_token: string;
  password_reset_token: string | null;
  password_reset_requested_at: string | null;
}

export async function findAccountByEmail(db: D1Database, email: string): Promise<AccountRow | null> {
  const row = await db.prepare("SELECT * FROM accounts WHERE email = ?1").bind(email).first<AccountRow>();
  return row ?? null;
}

export async function findAccountById(db: D1Database, id: string): Promise<AccountRow | null> {
  const row = await db.prepare("SELECT * FROM accounts WHERE id = ?1").bind(id).first<AccountRow>();
  return row ?? null;
}

export async function findAccountByVerificationToken(db: D1Database, token: string): Promise<AccountRow | null> {
  const row = await db
    .prepare("SELECT * FROM accounts WHERE verification_token = ?1")
    .bind(token)
    .first<AccountRow>();
  return row ?? null;
}

export async function findAccountByResetToken(db: D1Database, token: string): Promise<AccountRow | null> {
  const row = await db
    .prepare("SELECT * FROM accounts WHERE password_reset_token = ?1")
    .bind(token)
    .first<AccountRow>();
  return row ?? null;
}

/** Returns null if an account with this email already exists (caller's job
 * to turn that into a user-facing "that email is already registered" —
 * kept out of this function so it stays a pure insert-or-null, no
 * find-then-insert TOCTOU: the UNIQUE constraint on accounts.email is the
 * actual race-safe guard, this just catches the resulting D1 error. */
export async function createAccount(db: D1Database, email: string, password: string): Promise<AccountRow | null> {
  const { hash, salt, iterations } = await hashPassword(password);
  const id = newToken();
  const verificationToken = newToken();
  const createdAt = nowIso();
  try {
    await db
      .prepare(
        `INSERT INTO accounts (id, email, password_hash, password_salt, password_iterations, created_at, verified_at, verification_token)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7)`
      )
      .bind(id, email, hash, salt, iterations, createdAt, verificationToken)
      .run();
  } catch {
    // UNIQUE constraint violation (email already registered) or any other
    // insert failure -- either way, no account was created; caller checks
    // for null rather than this function guessing which case it was.
    return null;
  }
  return findAccountById(db, id);
}

export async function verifyAccountEmail(db: D1Database, token: string): Promise<AccountRow | null> {
  const account = await findAccountByVerificationToken(db, token);
  if (!account) return null;
  if (account.verified_at) return account; // already verified -- idempotent, not an error
  const verifiedAt = nowIso();
  await db.prepare("UPDATE accounts SET verified_at = ?1 WHERE id = ?2").bind(verifiedAt, account.id).run();
  return findAccountById(db, account.id);
}

export async function requestPasswordReset(db: D1Database, email: string): Promise<string | null> {
  const account = await findAccountByEmail(db, email);
  if (!account) return null; // caller must NOT reveal whether the email exists either way
  const resetToken = newToken();
  await db
    .prepare("UPDATE accounts SET password_reset_token = ?1, password_reset_requested_at = ?2 WHERE id = ?3")
    .bind(resetToken, nowIso(), account.id)
    .run();
  return resetToken;
}

// A reset link older than this is treated as expired even if the token
// still matches a row -- checked in application code (pro.ts), not a
// database CHECK constraint, since "now" isn't available to SQLite's own
// constraint evaluation in a portable way.
export const PASSWORD_RESET_MAX_AGE_SECONDS = 60 * 60; // 1 hour

export async function confirmPasswordReset(
  db: D1Database,
  token: string,
  newPassword: string
): Promise<AccountRow | null> {
  const account = await findAccountByResetToken(db, token);
  if (!account || !account.password_reset_requested_at) return null;
  const requestedAt = Date.parse(account.password_reset_requested_at);
  if (Number.isNaN(requestedAt) || Date.now() - requestedAt > PASSWORD_RESET_MAX_AGE_SECONDS * 1000) {
    return null; // expired -- do not consume the token, but also don't allow the reset
  }
  const { hash, salt, iterations } = await hashPassword(newPassword);
  await db
    .prepare(
      `UPDATE accounts
       SET password_hash = ?1, password_salt = ?2, password_iterations = ?3,
           password_reset_token = NULL, password_reset_requested_at = NULL
       WHERE id = ?4`
    )
    .bind(hash, salt, iterations, account.id)
    .run();
  // Log out every existing session on password reset -- a stolen/forgotten
  // password is exactly the scenario a reset is meant to recover from, so
  // any session that might belong to an attacker gets invalidated too.
  await db.prepare("DELETE FROM sessions WHERE account_id = ?1").bind(account.id).run();
  return findAccountById(db, account.id);
}

export async function verifyAccountPassword(account: AccountRow, password: string): Promise<boolean> {
  return verifyPassword(password, account.password_hash, account.password_salt, account.password_iterations);
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface SessionRow {
  id: string;
  account_id: string;
  created_at: string;
  expires_at: string;
  last_seen_at: string;
}

export async function createSession(db: D1Database, accountId: string): Promise<string> {
  const id = newToken();
  const now = nowIso();
  const expiresAt = new Date(Date.now() + SESSION_LIFETIME_SECONDS * 1000).toISOString();
  await db
    .prepare("INSERT INTO sessions (id, account_id, created_at, expires_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?3)")
    .bind(id, accountId, now, expiresAt)
    .run();
  return id;
}

/** Returns the account this session belongs to, or null if the session
 * doesn't exist or has expired (an expired row is deleted here, lazily --
 * see migration 0007's comment on why no separate cron is needed at MVP
 * scale). Also slides expires_at forward on every successful lookup, up to
 * the same SESSION_LIFETIME_SECONDS ceiling from now -- an active user's
 * session doesn't expire mid-use, an abandoned one does. */
export async function resolveSession(db: D1Database, sessionId: string): Promise<AccountRow | null> {
  const session = await db.prepare("SELECT * FROM sessions WHERE id = ?1").bind(sessionId).first<SessionRow>();
  if (!session) return null;
  const now = Date.now();
  if (Date.parse(session.expires_at) <= now) {
    await db.prepare("DELETE FROM sessions WHERE id = ?1").bind(sessionId).run();
    return null;
  }
  const nowIsoStr = new Date(now).toISOString();
  const newExpiresAt = new Date(now + SESSION_LIFETIME_SECONDS * 1000).toISOString();
  await db
    .prepare("UPDATE sessions SET last_seen_at = ?1, expires_at = ?2 WHERE id = ?3")
    .bind(nowIsoStr, newExpiresAt, sessionId)
    .run();
  return findAccountById(db, session.account_id);
}

export async function deleteSession(db: D1Database, sessionId: string): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE id = ?1").bind(sessionId).run();
}

// ---------------------------------------------------------------------------
// CPE hour entries
// ---------------------------------------------------------------------------

export interface CpeHourEntryRow {
  id: string;
  account_id: string;
  state_slug: string;
  hours: number;
  is_ethics: number; // 0 | 1
  course_name: string;
  completed_date: string;
  created_at: string;
}

export interface NewCpeHourEntry {
  stateSlug: string;
  hours: number;
  isEthics: boolean;
  courseName: string;
  completedDate: string; // YYYY-MM-DD, caller validates via parseStrictIsoDate
}

export async function createCpeHourEntry(
  db: D1Database,
  accountId: string,
  entry: NewCpeHourEntry
): Promise<CpeHourEntryRow> {
  const id = newToken();
  const createdAt = nowIso();
  await db
    .prepare(
      `INSERT INTO cpe_hour_entries (id, account_id, state_slug, hours, is_ethics, course_name, completed_date, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
    )
    .bind(id, accountId, entry.stateSlug, entry.hours, entry.isEthics ? 1 : 0, entry.courseName, entry.completedDate, createdAt)
    .run();
  const row = await db.prepare("SELECT * FROM cpe_hour_entries WHERE id = ?1").bind(id).first<CpeHourEntryRow>();
  if (!row) throw new Error("createCpeHourEntry: insert succeeded but row not found");
  return row;
}

export async function listCpeHourEntries(db: D1Database, accountId: string, stateSlug?: string): Promise<CpeHourEntryRow[]> {
  const result = stateSlug
    ? await db
        .prepare("SELECT * FROM cpe_hour_entries WHERE account_id = ?1 AND state_slug = ?2 ORDER BY completed_date DESC")
        .bind(accountId, stateSlug)
        .all<CpeHourEntryRow>()
    : await db
        .prepare("SELECT * FROM cpe_hour_entries WHERE account_id = ?1 ORDER BY completed_date DESC")
        .bind(accountId)
        .all<CpeHourEntryRow>();
  return result.results ?? [];
}

/** Deletes an entry ONLY if it belongs to the given account -- the WHERE
 * clause includes account_id, not just id, so one account can never delete
 * (or probe the existence of) another account's entry by guessing an id.
 * Returns true if a row was actually deleted. */
export async function deleteCpeHourEntry(db: D1Database, accountId: string, entryId: string): Promise<boolean> {
  const result = await db
    .prepare("DELETE FROM cpe_hour_entries WHERE id = ?1 AND account_id = ?2")
    .bind(entryId, accountId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}
