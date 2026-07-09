/**
 * D1-backed subscriber storage -- ported field-for-field from
 * reminders/store.py. Read that file's own docstrings first; every
 * abuse-hardening comment there (the Gmail dot/+tag cooldown-key folding,
 * the double-opt-in-bypass fix in `stop()`, the permanent-suppression
 * "unless a later confirm happened" rule) applies unchanged here -- this
 * file only changes WHERE the data lives (D1 instead of a flat JSON file),
 * never the lifecycle rules themselves.
 */

import { sanitizeFirstName } from "./validation";

export const STATUS_PENDING = "pending_confirmation";
export const STATUS_CONFIRMED = "confirmed";
export const STATUS_STOPPED = "stopped";

export const SIGNUP_COOLDOWN_HOURS = 24; // store.py:44

// migration 0006. A repeat /subscribe for an email+state that already has a
// pending record now triggers a real resend (index.ts) instead of a silent
// no-op -- these are the resend's OWN two throttles, separate from
// SIGNUP_COOLDOWN_HOURS (which this path deliberately bypasses -- see
// index.ts): a minimum gap between resends, AND a hard cap on how many a
// single record can ever receive, so a lost-email retry stays fast while a
// sustained resend-spam attempt against one record still gets refused.
export const RESEND_COOLDOWN_MINUTES = 15;
export const RESEND_MAX_ATTEMPTS = 3;

export const DEADLINE_SOURCE_COMPUTED = "computed";
export const DEADLINE_SOURCE_USER = "user";

export interface SubscriberRow {
  id: string;
  email: string;
  cooldown_key: string;
  state_slug: string;
  deadline_fields: string;
  first_name: string | null;
  status: string;
  confirm_token: string;
  unsubscribe_token: string;
  renewed_token: string;
  created_at: string;
  confirmed_at: string | null;
  stopped_at: string | null;
  stop_reason: string | null;
  reminders_sent: string;
  cycle: number;
  // migration 0005 -- see that file's own comment for the full rationale.
  // 'computed' (the only value that existed before "bring your own date")
  // or 'user'. user_deadline (ISO 'YYYY-MM-DD') is set only when 'user'.
  deadline_source: string;
  user_deadline: string | null;
  // migration 0006 -- null until the first resend, then the ISO timestamp of
  // the most recent one. See RESEND_COOLDOWN_MINUTES / resendEligible().
  last_resend_at: string | null;
  // migration 0006 -- total resends this record has ever received, capped at
  // RESEND_MAX_ATTEMPTS by resendEligible().
  resend_count: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** store.py:63 `_new_token()` -- 32 bytes CSPRNG, url-safe base64. */
function newToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** store.py:83 `_normalize_email()`. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * store.py:92 `_cooldown_key()` -- deliberately MORE aggressive than
 * `normalizeEmail()`, used ONLY for cooldown/dedupe/suppression-adjacent
 * comparisons, never as the stored/sent-to address. Folds Gmail-style
 * '+tag' sub-addressing and dot-insensitivity in the local part. See
 * store.py's own docstring for the exact attack this closes.
 */
export function cooldownKey(email: string): string {
  const normalized = normalizeEmail(email);
  const at = normalized.indexOf("@");
  const local = normalized.slice(0, at === -1 ? normalized.length : at);
  const domain = at === -1 ? "" : normalized.slice(at + 1);
  const folded = (local.split("+")[0] ?? "").replaceAll(".", "");
  return `${folded}@${domain}`;
}

/** store.py:116 `within_signup_cooldown()`. */
export async function withinSignupCooldown(
  db: D1Database,
  email: string,
  cooldownHours: number = SIGNUP_COOLDOWN_HOURS
): Promise<boolean> {
  const key = cooldownKey(email);
  const cutoff = new Date(Date.now() - cooldownHours * 3_600_000).toISOString();
  const row = await db
    .prepare("SELECT 1 FROM subscribers WHERE cooldown_key = ?1 AND created_at >= ?2 LIMIT 1")
    .bind(key, cutoff)
    .first();
  return row !== null;
}

/** store.py:133 `find_active_or_pending()`. */
export async function findActiveOrPending(
  db: D1Database,
  email: string,
  stateSlug: string
): Promise<SubscriberRow | null> {
  const key = cooldownKey(email);
  const row = await db
    .prepare(
      `SELECT * FROM subscribers
       WHERE cooldown_key = ?1 AND state_slug = ?2 AND status IN (?3, ?4)
       LIMIT 1`
    )
    .bind(key, stateSlug, STATUS_PENDING, STATUS_CONFIRMED)
    .first<SubscriberRow>();
  return row ?? null;
}

/**
 * store.py:149 `is_permanently_suppressed()`.
 *
 * Filtered in SQL by `LOWER(TRIM(email)) = ?1` -- the same normalization
 * `normalizeEmail()` does in JS, pushed into the query itself -- backed by
 * the expression index `idx_subscribers_email_normalized` (migration 0003).
 * An earlier version of this function ran `SELECT ... FROM subscribers` with
 * no WHERE clause at all and filtered by normalized email in JavaScript
 * afterward: a full-table scan on every call. Caught in adversarial review
 * (real, but dead-code at the time -- this function isn't called from any
 * Phase-1 route yet) before Phase 2 wires the scheduler to it against a
 * non-trivial subscriber table. See migration 0003's own comment and
 * `test/worker.spec.ts`'s "does not fall back to a full table scan" test,
 * which asserts the query plan actually uses the index.
 */
export async function isPermanentlySuppressed(db: D1Database, email: string): Promise<boolean> {
  const normalized = normalizeEmail(email);
  const { results } = await db
    .prepare(
      `SELECT stop_reason, stopped_at, confirmed_at, email FROM subscribers
       WHERE LOWER(TRIM(email)) = ?1`
    )
    .bind(normalized)
    .all<Pick<SubscriberRow, "stop_reason" | "stopped_at" | "confirmed_at" | "email">>();
  const records = results;
  const unsubStops = records.filter((r) => r.stop_reason === "unsubscribed" && r.stopped_at);
  if (unsubStops.length === 0) return false;
  const mostRecentUnsubAt = Math.max(...unsubStops.map((r) => Date.parse(r.stopped_at as string)));
  for (const r of records) {
    if (r.confirmed_at && Date.parse(r.confirmed_at) > mostRecentUnsubAt) {
      return false; // a real, later confirm -- the subscriber re-initiated consent
    }
  }
  return true;
}

export interface AddPendingInput {
  email: string;
  stateSlug: string;
  deadlineFields: Record<string, string>;
  firstName: string | null;
  /** migration 0005. Defaults to 'computed' when omitted -- every call site
   * that predates "bring your own date" doesn't need to change. */
  deadlineSource?: string;
  /** Only meaningful when deadlineSource is 'user'; null otherwise. */
  userDeadline?: string | null;
}

/**
 * store.py:186 `add_pending()`. Does not send anything -- pure storage.
 * `sanitizeFirstName()` is called again here even though index.ts's
 * `handleSubscribe()` already trims/caps `first_name` before calling this --
 * store.py:206 does the exact same independent re-sanitization (never trust
 * a caller's validation blindly, see store.py's own `_sanitize_first_name()`
 * docstring) so a future caller of `addPending()` that forgets to validate
 * still can't smuggle an oversized or non-printable name into storage.
 */
export async function addPending(db: D1Database, input: AddPendingInput): Promise<SubscriberRow> {
  const record: SubscriberRow = {
    id: newToken(),
    email: input.email,
    cooldown_key: cooldownKey(input.email),
    state_slug: input.stateSlug,
    deadline_fields: JSON.stringify(input.deadlineFields ?? {}),
    first_name: sanitizeFirstName(input.firstName),
    status: STATUS_PENDING,
    confirm_token: newToken(),
    unsubscribe_token: newToken(),
    renewed_token: newToken(),
    created_at: nowIso(),
    confirmed_at: null,
    stopped_at: null,
    stop_reason: null,
    reminders_sent: "[]",
    cycle: 1,
    deadline_source: input.deadlineSource ?? DEADLINE_SOURCE_COMPUTED,
    user_deadline: input.userDeadline ?? null,
    last_resend_at: null,
    resend_count: 0,
  };
  await db
    .prepare(
      `INSERT INTO subscribers
       (id, email, cooldown_key, state_slug, deadline_fields, first_name, status,
        confirm_token, unsubscribe_token, renewed_token, created_at, confirmed_at,
        stopped_at, stop_reason, reminders_sent, cycle, deadline_source, user_deadline,
        last_resend_at, resend_count)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20)`
    )
    .bind(
      record.id,
      record.email,
      record.cooldown_key,
      record.state_slug,
      record.deadline_fields,
      record.first_name,
      record.status,
      record.confirm_token,
      record.unsubscribe_token,
      record.renewed_token,
      record.created_at,
      record.confirmed_at,
      record.stopped_at,
      record.stop_reason,
      record.reminders_sent,
      record.cycle,
      record.deadline_source,
      record.user_deadline,
      record.last_resend_at,
      record.resend_count
    )
    .run();
  return record;
}

/**
 * Pure (no I/O) so it's trivially unit-testable: true only if this record is
 * both under RESEND_MAX_ATTEMPTS total AND (never resent, or its last resend
 * is older than RESEND_COOLDOWN_MINUTES). Both checks matter -- the count cap
 * alone would still allow 3 resends back-to-back in the same minute, and the
 * time throttle alone would allow unlimited resends spread out over time
 * (see migration 0006's comment for why that's a real, distinct abuse
 * vector, not just belt-and-suspenders). Deliberately does NOT check
 * record.status -- callers (index.ts) only call this after already
 * confirming the record is still pending_confirmation.
 */
export function resendEligible(
  row: Pick<SubscriberRow, "last_resend_at" | "resend_count">,
  now: Date,
  cooldownMinutes: number = RESEND_COOLDOWN_MINUTES,
  maxAttempts: number = RESEND_MAX_ATTEMPTS
): boolean {
  if (row.resend_count >= maxAttempts) return false;
  if (!row.last_resend_at) return true;
  const cutoff = now.getTime() - cooldownMinutes * 60_000;
  return Date.parse(row.last_resend_at) <= cutoff;
}

/** Records that a resend just happened, for resendEligible()'s next check. */
export async function recordResend(db: D1Database, id: string): Promise<void> {
  await db
    .prepare("UPDATE subscribers SET last_resend_at = ?1, resend_count = resend_count + 1 WHERE id = ?2")
    .bind(nowIso(), id)
    .run();
}

/** store.py:244 `confirm()` -- idempotent, matches the Python original. */
export async function confirm(db: D1Database, confirmToken: string): Promise<SubscriberRow | null> {
  const row = await db
    .prepare("SELECT * FROM subscribers WHERE confirm_token = ?1")
    .bind(confirmToken)
    .first<SubscriberRow>();
  if (!row) return null;
  if (row.status === STATUS_PENDING) {
    const confirmedAt = nowIso();
    await db
      .prepare("UPDATE subscribers SET status = ?1, confirmed_at = ?2 WHERE id = ?3")
      .bind(STATUS_CONFIRMED, confirmedAt, row.id)
      .run();
    row.status = STATUS_CONFIRMED;
    row.confirmed_at = confirmedAt;
  }
  return row;
}

/**
 * store.py:260 `stop()`. Carries forward the double-opt-in-bypass fix
 * verbatim: reason="renewed" only ever applies to a subscriber who was
 * actually confirmed at some point (`confirmed_at IS NOT NULL`) -- a
 * still-pending record's own signup-time tokens must never be able to
 * reach STOPPED/renewed (and, via rearm() below, all the way to
 * STOPPED->CONFIRMED) without a real `/confirm` ever happening.
 * reason="unsubscribed" is honored regardless of confirmed_at.
 */
export async function stop(
  db: D1Database,
  token: string,
  reason: "unsubscribed" | "renewed"
): Promise<SubscriberRow | null> {
  const row = await db
    .prepare("SELECT * FROM subscribers WHERE unsubscribe_token = ?1 OR renewed_token = ?1")
    .bind(token)
    .first<SubscriberRow>();
  if (!row) return null;
  if (reason === "renewed" && !row.confirmed_at) return null;
  const stoppedAt = nowIso();
  await db
    .prepare("UPDATE subscribers SET status = ?1, stopped_at = ?2, stop_reason = ?3 WHERE id = ?4")
    .bind(STATUS_STOPPED, stoppedAt, reason, row.id)
    .run();
  row.status = STATUS_STOPPED;
  row.stopped_at = stoppedAt;
  row.stop_reason = reason;
  return row;
}

/**
 * store.py:298 `rearm()`. Belt-and-suspenders with `stop()`'s own fix:
 * requires `confirmed_at IS NOT NULL` even though only `stop()` should ever
 * be able to reach STOPPED/renewed in the first place -- so even a future
 * regression in `stop()` can't let an unconfirmed record re-arm into
 * CONFIRMED here.
 */
export async function rearm(db: D1Database, unsubscribeToken: string): Promise<SubscriberRow | null> {
  const row = await db
    .prepare(
      `SELECT * FROM subscribers
       WHERE unsubscribe_token = ?1 AND status = ?2 AND stop_reason = ?3 AND confirmed_at IS NOT NULL`
    )
    .bind(unsubscribeToken, STATUS_STOPPED, "renewed")
    .first<SubscriberRow>();
  if (!row) return null;
  // "Bring your own date" (migration 0005): a user-provided date is now in
  // the past with no way for us to derive their NEXT one automatically (a
  // computed-state subscriber doesn't have this problem -- their state's
  // rule naturally yields the next occurrence with no stored value needing
  // to change). Refuse rather than silently reactivate against a stale
  // date -- see index.ts's handleRearm(), which gives this its own tailored
  // message via isUserDateRearmBlocked() below, distinct from "link
  // invalid/already used".
  if (row.deadline_source === DEADLINE_SOURCE_USER) return null;
  const newUnsubscribeToken = newToken();
  const newRenewedToken = newToken();
  await db
    .prepare(
      `UPDATE subscribers
       SET status = ?1, stopped_at = NULL, stop_reason = NULL, reminders_sent = '[]',
           cycle = cycle + 1, unsubscribe_token = ?2, renewed_token = ?3
       WHERE id = ?4`
    )
    .bind(STATUS_CONFIRMED, newUnsubscribeToken, newRenewedToken, row.id)
    .run();
  row.status = STATUS_CONFIRMED;
  row.stopped_at = null;
  row.stop_reason = null;
  row.reminders_sent = "[]";
  row.cycle = (row.cycle ?? 1) + 1;
  row.unsubscribe_token = newUnsubscribeToken;
  row.renewed_token = newRenewedToken;
  return row;
}

/**
 * Distinguishes WHY rearm() returned null, for handleRearm()'s error copy:
 * a genuinely invalid/already-used link vs. a real, otherwise-eligible
 * record that was refused specifically because it's a "bring your own
 * date" subscriber (migration 0005). Re-runs rearm()'s own eligibility
 * query without the deadline_source restriction rather than threading a
 * discriminated result back through rearm() itself, so rearm()'s contract
 * (SubscriberRow | null) stays exactly what every existing caller expects.
 */
export async function isUserDateRearmBlocked(db: D1Database, unsubscribeToken: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT deadline_source FROM subscribers
       WHERE unsubscribe_token = ?1 AND status = ?2 AND stop_reason = ?3 AND confirmed_at IS NOT NULL`
    )
    .bind(unsubscribeToken, STATUS_STOPPED, "renewed")
    .first<Pick<SubscriberRow, "deadline_source">>();
  return row?.deadline_source === DEADLINE_SOURCE_USER;
}

/**
 * store.py:329 `mark_reminder_sent()`. Not called from any Phase-1 route --
 * Phase 1 has no scheduler and sends no reminders -- ported now so Phase 2's
 * scheduler port (reminders/scheduler.py's `run_once()`) is a drop-in, not
 * new storage logic.
 */
export async function markReminderSent(db: D1Database, subscriberId: string, thresholdDays: number): Promise<void> {
  const row = await db
    .prepare("SELECT reminders_sent FROM subscribers WHERE id = ?1")
    .bind(subscriberId)
    .first<{ reminders_sent: string }>();
  if (!row) return;
  const sent: number[] = JSON.parse(row.reminders_sent);
  if (!sent.includes(thresholdDays)) {
    sent.push(thresholdDays);
    await db
      .prepare("UPDATE subscribers SET reminders_sent = ?1 WHERE id = ?2")
      .bind(JSON.stringify(sent), subscriberId)
      .run();
  }
}

/**
 * store.py:339 `all_confirmed_active()` -- subscribers eligible for
 * reminder scheduling: confirmed, not stopped. Not called from any Phase-1
 * route (no scheduler exists yet) -- ported for the same Phase-2
 * drop-in-readiness reason as `markReminderSent()` above.
 */
export async function allConfirmedActive(db: D1Database): Promise<SubscriberRow[]> {
  const { results } = await db.prepare("SELECT * FROM subscribers WHERE status = ?1").bind(STATUS_CONFIRMED).all<SubscriberRow>();
  return results;
}
