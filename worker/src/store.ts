/**
 * D1-backed subscriber storage -- ported field-for-field from
 * reminders/store.py. Read that file's own docstrings first; every
 * abuse-hardening comment there (the Gmail dot/+tag cooldown-key folding,
 * the double-opt-in-bypass fix in `stop()`, the permanent-suppression
 * "unless a later confirm happened" rule) applies unchanged here -- this
 * file only changes WHERE the data lives (D1 instead of a flat JSON file),
 * never the lifecycle rules themselves.
 */

import {
  MAX_FIRM_NAME_LEN,
  MAX_STAFF_COUNT_HINT_LEN,
  MAX_STAFF_LABEL_LEN,
  sanitizeFirstName,
  sanitizeFreeText,
} from "./validation";

export const STATUS_PENDING = "pending_confirmation";
export const STATUS_CONFIRMED = "confirmed";
export const STATUS_STOPPED = "stopped";

// Firm-dashboard MVP (2026-07-28). `stop_reason` has always been free TEXT
// with no SQL CHECK constraint (see migration 0001_init_schema.sql's own
// comment on that column) specifically so a new value could be added
// without a migration -- this is that new value. Distinguishes a firm
// admin's deliberate DELETE /firm/licenses/:id ("this person left the firm,
// take them off the roster") from the two existing self-serve reasons
// ("unsubscribed" -- the subscriber themselves opted out; "renewed" -- the
// subscriber said "I renewed," normally now only ever a fleeting
// intermediate state since renewAndRearm() below never leaves a row sitting
// in it). Without this third value, GET /firm/licenses would have no way to
// tell "this staff member left the firm, stop showing them" apart from
// "this staff member is mid-cycle after renewing and just hasn't re-armed
// yet" -- exactly the ambiguity Part A #1 of this build called out.
// listFirmLicenses() below is the one place that filters this value out.
export const STOP_REASON_REMOVED_BY_ADMIN = "removed_by_admin";

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
  // migration 0008. NULL means "free individual subscriber, not
  // firm-tracked" -- every row before this build. Non-NULL means this row is
  // a staff member on a firm admin's roster (added via POST /firm/licenses,
  // index.ts) -- every query that lists/mutates a firm's roster MUST filter
  // by this column (see listFirmLicenses/getFirmLicense/updateFirmLicense/
  // removeFirmLicense/renewAndRearm below -- the ownership check this
  // build's own review singled out as the highest-priority thing to get
  // right).
  firm_id: string | null;
  // migration 0008. The firm admin's OWN label for this person (e.g. "Jane
  // D. -- Audit team"), deliberately separate from first_name (see that
  // migration's own comment). NULL for every free-tier row.
  staff_label: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** store.py:63 `_new_token()` -- 32 bytes CSPRNG, url-safe base64. */
export function newToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * migration 0008. Hashes a raw CSPRNG token (a login link or a session
 * token) to hex-encoded SHA-256, via the Web Crypto API the Workers runtime
 * provides natively -- no bcrypt/argon2 dependency (neither is available in
 * a Workers isolate without a WASM add-on). This is a defensible choice
 * specifically BECAUSE the input is always a 32-byte CSPRNG value from
 * `newToken()`, never a human-guessable password: there is no offline
 * dictionary/brute-force risk a slow, salted KDF exists to mitigate, only
 * the risk of the raw value leaking from wherever it's stored -- which a
 * single fast hash already fully defeats (an attacker who steals the DB
 * gets `token_hash`, not anything they can present back as a valid token
 * without already knowing the 256 bits of the original). Deliberately NOT
 * used for subscribers' confirm_token/unsubscribe_token/renewed_token --
 * those are stored plaintext, an accepted existing pattern for this
 * codebase's single-purpose action links (see this migration's own
 * docstring for why login/session tokens are different: standing account
 * access, not a one-shot action).
 */
export async function hashToken(raw: string): Promise<string> {
  const data = new TextEncoder().encode(raw);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
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
  /** migration 0008. Set only by the firm-dashboard staff-add route
   * (index.ts's handleFirmLicenseCreate()) -- omitted (-> null) for every
   * free-tier /subscribe signup, exactly like every call site that predates
   * firm accounts. */
  firmId?: string | null;
  /** migration 0008. Only meaningful alongside firmId; null otherwise. */
  staffLabel?: string | null;
  /**
   * HYBRID consent model (2026-07-28, firm-tier only): when true, the row is
   * created already `confirmed` (reminders active immediately) instead of
   * `pending_confirmation` -- no confirm_token flow is used at all for this
   * person. Set ONLY by handleFirmLicenseCreate() for admin-added staff; the
   * free-tier `/subscribe` path never passes this (always double opt-in,
   * unchanged). This is what makes an admin-added staffer "vouched for" by
   * their firm rather than self-attesting their own email -- the tradeoff
   * Devin explicitly chose over a silent "pending" gap in firm coverage, kept
   * CAN-SPAM-clean by the caller always sending buildFirmStaffAddedEmail()
   * (transparent first-contact + one-click opt-out) right after this returns.
   */
  skipConfirmation?: boolean;
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
  const now = nowIso();
  const record: SubscriberRow = {
    id: newToken(),
    email: input.email,
    cooldown_key: cooldownKey(input.email),
    state_slug: input.stateSlug,
    deadline_fields: JSON.stringify(input.deadlineFields ?? {}),
    first_name: sanitizeFirstName(input.firstName),
    status: input.skipConfirmation ? STATUS_CONFIRMED : STATUS_PENDING,
    // Still generated even when skipped -- the column is NOT NULL UNIQUE and
    // nothing else in this codebase special-cases a null confirm_token; an
    // unused-but-valid token is simpler than widening the schema for one
    // call path. It's just never emailed to anyone for a skip-confirmation
    // row (handleFirmLicenseCreate() sends buildFirmStaffAddedEmail()
    // instead of buildConfirmationEmail(), which is the only place a
    // confirm_token ever reaches an email).
    confirm_token: newToken(),
    unsubscribe_token: newToken(),
    renewed_token: newToken(),
    created_at: now,
    confirmed_at: input.skipConfirmation ? now : null,
    stopped_at: null,
    stop_reason: null,
    reminders_sent: "[]",
    cycle: 1,
    deadline_source: input.deadlineSource ?? DEADLINE_SOURCE_COMPUTED,
    user_deadline: input.userDeadline ?? null,
    last_resend_at: null,
    resend_count: 0,
    firm_id: input.firmId ?? null,
    // Re-sanitized here independently of index.ts's own request-layer
    // validation, same defense-in-depth rationale as sanitizeFirstName()
    // above.
    staff_label: sanitizeFreeText(input.staffLabel, MAX_STAFF_LABEL_LEN),
  };
  await db
    .prepare(
      `INSERT INTO subscribers
       (id, email, cooldown_key, state_slug, deadline_fields, first_name, status,
        confirm_token, unsubscribe_token, renewed_token, created_at, confirmed_at,
        stopped_at, stop_reason, reminders_sent, cycle, deadline_source, user_deadline,
        last_resend_at, resend_count, firm_id, staff_label)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22)`
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
      record.resend_count,
      record.firm_id,
      record.staff_label
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

/**
 * migration 0007. A firm_leads row -- NOT a subscriber. This table has no
 * confirm/unsubscribe/renewed lifecycle at all: it just records that someone
 * expressed interest in the firm dashboard's early-access list via the
 * /for-firms/ page's POST /api/firm/lead form (index.ts's handleFirmLead()).
 */
export interface FirmLeadRow {
  id: string;
  email: string;
  firm_name: string | null;
  staff_count_hint: string | null;
  created_at: string;
  converted_at: string | null;
}

export interface AddFirmLeadInput {
  email: string;
  firmName: string | null;
  staffCountHint: string | null;
}

/**
 * Inserts a firm_leads row. Deliberately no dedupe/cooldown/resend logic --
 * unlike addPending() (the subscribers table this deliberately does NOT
 * reuse), a lead isn't a consent record and sends nobody anything, so there
 * is no mail-bombing vector a repeat submission from the same email could
 * open; the caller's rate limiter (index.ts's handleFirmLead(), same
 * checkRateLimit() bucket pattern as handleSubscribe()) is what actually
 * bounds submission volume. sanitizeFreeText() is called here independently
 * of index.ts's own validation, same defense-in-depth rationale as
 * addPending()'s re-call of sanitizeFirstName() above -- a future caller
 * that forgets to validate still can't smuggle an oversized or
 * non-printable value into storage.
 */
export async function addFirmLead(db: D1Database, input: AddFirmLeadInput): Promise<FirmLeadRow> {
  const record: FirmLeadRow = {
    id: newToken(),
    email: input.email,
    firm_name: sanitizeFreeText(input.firmName, MAX_FIRM_NAME_LEN),
    staff_count_hint: sanitizeFreeText(input.staffCountHint, MAX_STAFF_COUNT_HINT_LEN),
    created_at: nowIso(),
    converted_at: null,
  };
  await db
    .prepare(
      `INSERT INTO firm_leads (id, email, firm_name, staff_count_hint, created_at, converted_at)
       VALUES (?1,?2,?3,?4,?5,?6)`
    )
    .bind(
      record.id,
      record.email,
      record.firm_name,
      record.staff_count_hint,
      record.created_at,
      record.converted_at
    )
    .run();
  return record;
}

// ---------------------------------------------------------------------------
// migration 0008 -- firm accounts + login/session auth. This is the repo's
// FIRST real login system (everything above this line is capability-URL
// tokens, never a login) -- see index.ts's requireFirmSession() for the one
// place every firm-scoped route MUST call to enforce firm_id ownership, and
// this migration's own SQL file for the hashing-convention rationale.
// ---------------------------------------------------------------------------

export interface FirmRow {
  id: string;
  name: string;
  admin_email: string;
  plan_tier: string;
  status: string;
  created_at: string;
  // migration 0010 (auth suite). ALL nullable: a firm that signs in only
  // via the emailed link, or only via SSO, legitimately has no password.
  // Callers must treat null as "no password set", never as an error.
  password_hash: string | null;
  password_salt: string | null;
  password_algo: string | null;
  password_iterations: number | null;
  password_rounds: number | null;
  password_updated_at: string | null;
}

export interface FirmLoginTokenRow {
  id: string;
  firm_id: string;
  token_hash: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  /** migration 0013. Optional on the TYPE because rows written before that
   * migration predate the column; normalizeLoginTokenPurpose() turns any
   * absent/unrecognised value into the safe "login" default. */
  purpose?: string;
}

export interface FirmSessionRow {
  /** migration 0014; absent on rows written before it. */
  password_reset_authorized?: number | null;
  id: string;
  firm_id: string;
  session_token_hash: string;
  created_at: string;
  expires_at: string;
  last_seen_at: string;
}

// A login link is a one-shot bearer credential emailed in plaintext -- kept
// short-lived so a delayed-open/forwarded/logged copy of the email has a
// narrow window to matter. 15 minutes matches this codebase's existing
// "short-lived one-time link" precedent (see RESEND_COOLDOWN_MINUTES's
// neighborhood) and is generous enough for "click the email you just got."
export const LOGIN_TOKEN_TTL_MINUTES = 15;

// A firm admin dashboard session, not a one-time action link -- 30 days is
// a reasonable "stay signed in" duration for a low-frequency B2B admin tool
// (an office manager checking renewal status, not a consumer app opened
// hourly). Deliberate MVP simplification, noted again on verifySession()
// below: this is a HARD 30-day lifetime from creation, never extended by
// activity (no "sliding" expiry) -- simpler to reason about and to test,
// and a firm admin who's still active well past 30 days just gets a fresh
// login-link email, which costs them one click.
export const SESSION_TTL_DAYS = 30;

export interface CreateFirmInput {
  name: string;
  adminEmail: string;
}

/**
 * Inserts a new `firms` row. Re-sanitizes `name` independently of the
 * request-layer validation in index.ts's handleFirmSignup() -- same
 * defense-in-depth rationale as `addPending()`'s re-call of
 * `sanitizeFirstName()` and `addFirmLead()`'s re-call of `sanitizeFreeText()`
 * above: a future caller that forgets to validate still can't smuggle an
 * oversized or non-printable name into storage. Falls back to an empty
 * string (never null -- `firms.name` is NOT NULL, unlike firm_leads.firm_name)
 * in the pathological case where sanitization strips a name down to
 * nothing; index.ts's own validation should never let that input through in
 * the first place.
 */
export async function createFirm(db: D1Database, input: CreateFirmInput): Promise<{ id: string }> {
  const id = newToken();
  const name = sanitizeFreeText(input.name, MAX_FIRM_NAME_LEN) ?? "";
  await db
    .prepare(
      `INSERT INTO firms (id, name, admin_email, plan_tier, status, created_at)
       VALUES (?1,?2,?3,'pilot','active',?4)`
    )
    .bind(id, name, input.adminEmail, nowIso())
    .run();
  return { id };
}

/**
 * By id (the session-scoped id every firm-scoped route already trusts, via
 * requireFirmSession()) -- used where the firm's own NAME is needed, e.g. the
 * hybrid-consent first-contact email (buildFirmStaffAddedEmail()) naming
 * which firm added a staff member.
 */
export async function getFirmById(db: D1Database, firmId: string): Promise<FirmRow | null> {
  const row = await db.prepare(`SELECT * FROM firms WHERE id = ?1`).bind(firmId).first<FirmRow>();
  return row ?? null;
}

/**
 * Case/whitespace-insensitive match on admin_email, mirroring
 * `isPermanentlySuppressed()`'s `LOWER(TRIM(email))` convention above (the
 * same normalization `normalizeEmail()` does in JS, pushed into the query).
 * No expression index backs this one (unlike
 * `idx_subscribers_email_normalized`, migration 0003) -- deliberately: the
 * `firms` table is expected to stay small (one row per paying/pilot firm,
 * not per end-user) for a long time, so a full-table scan here is cheap and
 * not worth a migration until real growth says otherwise, unlike
 * `subscribers` (see migration 0008's own comment on `idx_subscribers_firm_id`
 * for why THAT table gets an index up front instead of waiting).
 */
export async function findFirmByAdminEmail(db: D1Database, email: string): Promise<FirmRow | null> {
  const normalized = normalizeEmail(email);
  const row = await db
    .prepare(`SELECT * FROM firms WHERE LOWER(TRIM(admin_email)) = ?1 LIMIT 1`)
    .bind(normalized)
    .first<FirmRow>();
  return row ?? null;
}

/**
 * Generates a raw CSPRNG login token, stores only its hash (see
 * `hashToken()`'s own docstring), and returns the RAW value for the caller
 * to email -- this function is the only place the raw value ever exists
 * outside the recipient's inbox; it is never logged, never stored anywhere
 * else. `expires_at` = now + LOGIN_TOKEN_TTL_MINUTES.
 */
/**
 * What a login token is FOR (migration 0013). Set at issue time from which
 * form the user submitted; read at redemption to decide where they land.
 *
 * Deliberately a closed set with a safe default: anything unrecognised
 * normalises to "login", so a typo or a future caller that forgets the
 * argument degrades to the ORDINARY sign-in rather than the privileged
 * password-set branch.
 */
export type LoginTokenPurpose = "login" | "password_reset";

export function normalizeLoginTokenPurpose(raw: unknown): LoginTokenPurpose {
  return raw === "password_reset" ? "password_reset" : "login";
}

export async function createLoginToken(
  db: D1Database,
  firmId: string,
  purpose: LoginTokenPurpose = "login"
): Promise<{ rawToken: string }> {
  const rawToken = newToken();
  const tokenHash = await hashToken(rawToken);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LOGIN_TOKEN_TTL_MINUTES * 60_000).toISOString();
  await db
    .prepare(
      `INSERT INTO firm_login_tokens (id, firm_id, token_hash, created_at, expires_at, used_at, purpose)
       VALUES (?1,?2,?3,?4,?5,NULL,?6)`
    )
    .bind(newToken(), firmId, tokenHash, now.toISOString(), expiresAt, normalizeLoginTokenPurpose(purpose))
    .run();
  return { rawToken };
}

/**
 * Invalidates every UNUSED login token for a firm.
 *
 * Called after a password is successfully set: any other reset link sitting
 * in an inbox (or in a mail archive, or in a forwarded thread) is a live
 * bearer credential for this account, and the whole point of finishing a
 * reset is that the previous ones stop mattering. Only unused rows are
 * touched, so this can never resurrect or alter an already-consumed token.
 */
export async function invalidateOutstandingLoginTokens(db: D1Database, firmId: string): Promise<number> {
  const result = await db
    .prepare(`UPDATE firm_login_tokens SET used_at = ?1 WHERE firm_id = ?2 AND used_at IS NULL`)
    .bind(nowIso(), firmId)
    .run();
  return result.meta.changes ?? 0;
}

/**
 * Hashes the incoming raw token and looks it up by `token_hash` -- the raw
 * value itself is never compared or stored. Single-use (`used_at`) and
 * time-bound (`expires_at`): either an already-used or an expired token is
 * rejected exactly like an invalid one (same "no oracle" posture as every
 * other token check in this file -- store.confirm()/store.stop() also just
 * return null on any of several distinct failure reasons). On success,
 * marks `used_at` so a second attempt with the same raw token -- e.g. an
 * email link opened twice, or a forwarded/leaked copy -- can never succeed
 * again.
 */
export async function verifyAndConsumeLoginToken(
  db: D1Database,
  rawToken: string
): Promise<{ firmId: string; purpose: LoginTokenPurpose } | null> {
  const tokenHash = await hashToken(rawToken);
  const row = await db
    .prepare(`SELECT * FROM firm_login_tokens WHERE token_hash = ?1`)
    .bind(tokenHash)
    .first<FirmLoginTokenRow>();
  if (!row) return null;
  if (row.used_at) return null;
  if (Date.parse(row.expires_at) <= Date.now()) return null;
  // Conditional on used_at IS NULL so two concurrent redemptions of one
  // emailed link cannot both succeed (the same shape as the subscriber
  // token; this route previously used an unconditional UPDATE).
  const result = await db
    .prepare(`UPDATE firm_login_tokens SET used_at = ?1 WHERE id = ?2 AND used_at IS NULL`)
    .bind(nowIso(), row.id)
    .run();
  if ((result.meta.changes ?? 0) === 0) return null;
  // The purpose is read from the ROW -- never from anything the redeeming
  // request supplied. See migration 0013.
  return { firmId: row.firm_id, purpose: normalizeLoginTokenPurpose((row as { purpose?: unknown }).purpose) };
}

/**
 * Generates a raw CSPRNG session token, stores only its hash, and returns
 * the RAW value for the caller to set as the `dr_firm_session` cookie (see
 * index.ts). `expires_at` = now + SESSION_TTL_DAYS.
 */
export async function createSession(
  db: D1Database,
  firmId: string,
  /** migration 0014. TRUE only when this session was minted by redeeming a
   * password-RESET token, which proves control of the account's email inbox
   * and is therefore allowed to set a password without knowing the old one.
   * Derived from the token row, never from anything a client sends. */
  passwordResetAuthorized = false
): Promise<{ rawSessionToken: string }> {
  const rawSessionToken = newToken();
  const sessionTokenHash = await hashToken(rawSessionToken);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_DAYS * 86_400_000).toISOString();
  await db
    .prepare(
      `INSERT INTO firm_sessions (id, firm_id, session_token_hash, created_at, expires_at, last_seen_at, password_reset_authorized)
       VALUES (?1,?2,?3,?4,?5,?6,?7)`
    )
    .bind(
      newToken(), firmId, sessionTokenHash, now.toISOString(), expiresAt, now.toISOString(),
      passwordResetAuthorized ? 1 : 0
    )
    .run();
  return { rawSessionToken };
}

/**
 * Spends the one-shot reset authority.
 *
 * Called immediately after a successful password set, so one emailed link
 * authorises exactly ONE password change. Without this the flag would sit on
 * a 30-day session and let anyone holding that cookie rewrite the password
 * repeatedly without ever knowing the old one -- which is the very thing the
 * prove-the-current-password rule exists to prevent.
 */
export async function clearSessionResetAuthorization(db: D1Database, sessionId: string): Promise<void> {
  await db
    .prepare(`UPDATE firm_sessions SET password_reset_authorized = 0 WHERE id = ?1`)
    .bind(sessionId)
    .run();
}

/**
 * Hashes the incoming raw session token and looks it up by
 * `session_token_hash`. Rejects an expired session. On success, updates
 * `last_seen_at` to now -- deliberately does NOT extend `expires_at` (no
 * sliding-window renewal): a hard 30-day session lifetime from creation is
 * simpler to reason about and test, and is a deliberate MVP simplification
 * -- a real product might want sliding renewal so an active user is never
 * logged out mid-use, but that's a real design decision for a later pass,
 * not something to sneak in un-discussed here.
 */
export async function verifySession(
  db: D1Database,
  rawSessionToken: string
): Promise<{ firmId: string; sessionId: string; passwordResetAuthorized: boolean } | null> {
  const sessionTokenHash = await hashToken(rawSessionToken);
  const row = await db
    .prepare(`SELECT * FROM firm_sessions WHERE session_token_hash = ?1`)
    .bind(sessionTokenHash)
    .first<FirmSessionRow>();
  if (!row) return null;
  if (Date.parse(row.expires_at) <= Date.now()) return null;
  await db.prepare(`UPDATE firm_sessions SET last_seen_at = ?1 WHERE id = ?2`).bind(nowIso(), row.id).run();
  // sessionId (2026-07-30, CPE-hours tracker): the session row's own id was
  // already fetched above -- returning it too (previously discarded) costs
  // nothing extra and lets cpe_entries.entered_by_firm_session_id record
  // WHICH session logged an entry, not just which firm.
  return {
    firmId: row.firm_id,
    sessionId: row.id,
    // Strict truthiness on 1 -- a NULL from a pre-0014 row, or anything
    // unexpected, must read as NOT authorized. The permissive direction is
    // the dangerous one here.
    passwordResetAuthorized: (row as { password_reset_authorized?: unknown }).password_reset_authorized === 1,
  };
}

/** Logout: hash + delete the matching session row. Idempotent -- deleting a
 * session that doesn't exist (already logged out, already expired and
 * reaped, or a garbage cookie value) is a silent no-op, not an error;
 * index.ts's handleFirmLogout() always returns the same success response
 * regardless. */
export async function deleteSession(db: D1Database, rawSessionToken: string): Promise<void> {
  const sessionTokenHash = await hashToken(rawSessionToken);
  await db.prepare(`DELETE FROM firm_sessions WHERE session_token_hash = ?1`).bind(sessionTokenHash).run();
}

// ---------------------------------------------------------------------------
// Firm-dashboard MVP (2026-07-28, step 2/3) -- staff license CRUD. Every
// function below that reads or writes a specific subscriber row takes
// `firmId` and filters/binds it directly in its OWN SQL statement (not "the
// caller already checked, so I don't need to") -- the same defense-in-depth
// posture this file already applies to input sanitization
// (sanitizeFirstName()/sanitizeFreeText() re-called here even though
// index.ts's request layer already validated). A future route that forgets
// to re-check ownership still cannot cross firm A/firm B here, because the
// WHERE clause itself enforces it.
// ---------------------------------------------------------------------------

/**
 * Every row on firm `firmId`'s roster EXCEPT ones an admin has explicitly
 * removed (stop_reason = STOP_REASON_REMOVED_BY_ADMIN) -- see that
 * constant's own comment for why "removed" needed a distinct value from the
 * existing "renewed"/"unsubscribed" reasons. A row stopped for any OTHER
 * reason (the subscriber renewed via their own email link and hasn't been
 * re-armed, or unsubscribed themselves) still appears -- index.ts's
 * toFirmLicenseJson() maps that to a "needs-attention" status so the admin
 * notices it, rather than silently disappearing the way a truly-removed
 * person does.
 */
export async function listFirmLicenses(db: D1Database, firmId: string): Promise<SubscriberRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM subscribers
       WHERE firm_id = ?1 AND NOT (status = ?2 AND stop_reason = ?3)`
    )
    .bind(firmId, STATUS_STOPPED, STOP_REASON_REMOVED_BY_ADMIN)
    .all<SubscriberRow>();
  return results;
}

/**
 * The ownership-scoped single-record lookup every PATCH/DELETE/renew route
 * uses to decide 404-vs-proceed BEFORE doing anything else -- returns null
 * for a nonexistent id AND for an id that belongs to a different firm,
 * identically, so index.ts can return the same 404 either way (never a 403
 * that would confirm the record exists under another firm -- the exact
 * anti-enumeration posture this whole codebase already uses everywhere
 * else).
 */
export async function getFirmLicense(db: D1Database, firmId: string, id: string): Promise<SubscriberRow | null> {
  const row = await db
    .prepare(`SELECT * FROM subscribers WHERE id = ?1 AND firm_id = ?2`)
    .bind(id, firmId)
    .first<SubscriberRow>();
  return row ?? null;
}

export interface UpdateFirmLicenseInput {
  email: string;
  staffLabel: string | null;
  stateSlug: string;
  deadlineFields: Record<string, string>;
  deadlineSource: string;
  userDeadline: string | null;
  /**
   * True when index.ts detected the (normalized) email actually changed.
   * Editing the delivery address is, in effect, re-consenting a DIFFERENT
   * inbox -- the person who now owns that address has never clicked a
   * confirm link. Forcing the record back through pending_confirmation
   * mirrors this codebase's existing double-opt-in-bypass posture in
   * stop()/rearm() (an address only ever reaches CONFIRMED by actually
   * clicking a confirm link, never by an admin edit alone) -- without this,
   * a firm admin could redirect someone else's reminders to an address that
   * never agreed to receive them.
   */
  resetConfirmation: boolean;
}

/**
 * PATCH /firm/licenses/:id's storage layer. Ownership-scoped (own SELECT AND
 * own UPDATE...WHERE, both filtered on firm_id, not just the caller's prior
 * check) -- returns null if `id` doesn't exist or isn't on this firm's
 * roster. See UpdateFirmLicenseInput.resetConfirmation's own doc for the
 * email-change re-consent rule.
 */
export async function updateFirmLicense(
  db: D1Database,
  firmId: string,
  id: string,
  input: UpdateFirmLicenseInput
): Promise<SubscriberRow | null> {
  const existing = await db
    .prepare(`SELECT * FROM subscribers WHERE id = ?1 AND firm_id = ?2`)
    .bind(id, firmId)
    .first<SubscriberRow>();
  if (!existing) return null;

  const newCooldownKey = cooldownKey(input.email);
  const newStaffLabel = sanitizeFreeText(input.staffLabel, MAX_STAFF_LABEL_LEN);

  let status = existing.status;
  let confirmedAt = existing.confirmed_at;
  let confirmToken = existing.confirm_token;
  let stoppedAt = existing.stopped_at;
  let stopReason = existing.stop_reason;
  let remindersSent = existing.reminders_sent;

  if (input.resetConfirmation) {
    status = STATUS_PENDING;
    confirmedAt = null;
    confirmToken = newToken();
    stoppedAt = null;
    stopReason = null;
    remindersSent = "[]";
  }

  await db
    .prepare(
      `UPDATE subscribers
       SET email = ?1, cooldown_key = ?2, staff_label = ?3, state_slug = ?4, deadline_fields = ?5,
           deadline_source = ?6, user_deadline = ?7, status = ?8, confirmed_at = ?9, confirm_token = ?10,
           stopped_at = ?11, stop_reason = ?12, reminders_sent = ?13
       WHERE id = ?14 AND firm_id = ?15`
    )
    .bind(
      input.email,
      newCooldownKey,
      newStaffLabel,
      input.stateSlug,
      JSON.stringify(input.deadlineFields ?? {}),
      input.deadlineSource,
      input.userDeadline,
      status,
      confirmedAt,
      confirmToken,
      stoppedAt,
      stopReason,
      remindersSent,
      id,
      firmId
    )
    .run();

  return {
    ...existing,
    email: input.email,
    cooldown_key: newCooldownKey,
    staff_label: newStaffLabel,
    state_slug: input.stateSlug,
    deadline_fields: JSON.stringify(input.deadlineFields ?? {}),
    deadline_source: input.deadlineSource,
    user_deadline: input.userDeadline,
    status,
    confirmed_at: confirmedAt,
    confirm_token: confirmToken,
    stopped_at: stoppedAt,
    stop_reason: stopReason,
    reminders_sent: remindersSent,
  };
}

/**
 * DELETE /firm/licenses/:id's storage layer -- "remove from roster," NOT a
 * SQL DELETE (see STOP_REASON_REMOVED_BY_ADMIN's own comment for why this is
 * a status/stop_reason value rather than a row deletion: it reuses the
 * exact same STATUS_STOPPED gate scheduler.ts's allConfirmedActive() already
 * filters on, so a removed staff member stops receiving reminders for the
 * same reason an unsubscribed one does -- no separate "is this person still
 * on the roster" check needed anywhere else in the send pipeline). Ownership
 * -scoped in both the SELECT and the UPDATE's WHERE clause.
 */
export async function removeFirmLicense(db: D1Database, firmId: string, id: string): Promise<SubscriberRow | null> {
  const existing = await db
    .prepare(`SELECT * FROM subscribers WHERE id = ?1 AND firm_id = ?2`)
    .bind(id, firmId)
    .first<SubscriberRow>();
  if (!existing) return null;
  const stoppedAt = nowIso();
  await db
    .prepare(`UPDATE subscribers SET status = ?1, stopped_at = ?2, stop_reason = ?3 WHERE id = ?4 AND firm_id = ?5`)
    .bind(STATUS_STOPPED, stoppedAt, STOP_REASON_REMOVED_BY_ADMIN, id, firmId)
    .run();
  return { ...existing, status: STATUS_STOPPED, stopped_at: stoppedAt, stop_reason: STOP_REASON_REMOVED_BY_ADMIN };
}

/**
 * The actual atomic write shared by BOTH renew entry points below
 * (renewAndRearm -- firm-dashboard, ownership-authorized; renewAndRearmByToken
 * -- free-tier email CTA, token-authorized): stop this cycle's reminders AND
 * immediately re-arm for next cycle, as a SINGLE UPDATE statement rather than
 * calling stop() then rearm() as two sequential prepared statements.
 *
 * Why one statement is enough (no explicit D1 BEGIN/COMMIT transaction
 * needed): a D1/SQLite UPDATE is already atomic with respect to every other
 * statement touching the same row -- there is no partial-write state another
 * request could observe mid-way through ONE statement. The old two-hop UX
 * this replaces (stop() now, a human clicks a second link minutes/days
 * later, rearm() then) genuinely needed two statements because a real person
 * was in between them; doing both halves of THIS action in direct response
 * to one click has no such gap, so collapsing them into the same single
 * UPDATE rearm() itself already uses (status/stopped_at/stop_reason/
 * reminders_sent/cycle/token-rotation, all in one SET clause) removes the
 * intermediate STOPPED state entirely rather than just making it brief -- a
 * concurrent GET /firm/licenses, or the reminder cron's
 * allConfirmedActive() (status='confirmed' only), can never observe this
 * subscriber sitting in STOPPED between the two halves, because that state
 * never exists on disk in the first place.
 */
async function applyRenewAndRearm(db: D1Database, row: SubscriberRow): Promise<SubscriberRow> {
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
  return {
    ...row,
    status: STATUS_CONFIRMED,
    stopped_at: null,
    stop_reason: null,
    reminders_sent: "[]",
    cycle: (row.cycle ?? 1) + 1,
    unsubscribe_token: newUnsubscribeToken,
    renewed_token: newRenewedToken,
  };
}

/**
 * POST /firm/licenses/:id/renew's storage layer -- the dashboard's "Mark
 * renewed" action. Ownership-scoped (own SELECT filtered on firm_id, same
 * posture as every other mutation in this section) and guarded by the same
 * three eligibility rules as the free-tier path below, applied consistently:
 *   - never-confirmed (confirmed_at IS NULL) -- same double-opt-in-bypass
 *     guard stop()/rearm() already enforce; there's nothing to "renew" for
 *     someone who never confirmed in the first place.
 *   - already removed from the roster (stop_reason = STOP_REASON_REMOVED_BY_ADMIN)
 *     -- renewing must never resurrect someone the admin explicitly took off
 *     the roster; re-adding them is a deliberate separate action
 *     (POST /firm/licenses), not a side effect of this one.
 *   - "bring your own date" (deadline_source = DEADLINE_SOURCE_USER) --
 *     same refusal as rearm() (there is no rule to auto-derive their NEXT
 *     date); index.ts's route gives this its own tailored error copy.
 * Returns null on any of the three refusals OR a firm-ownership mismatch,
 * all indistinguishable at this layer -- index.ts's handleFirmLicenseRenew()
 * re-reads the row via getFirmLicense() first to tell them apart for the
 * error message.
 */
export async function renewAndRearm(db: D1Database, firmId: string, id: string): Promise<SubscriberRow | null> {
  const row = await db
    .prepare(`SELECT * FROM subscribers WHERE id = ?1 AND firm_id = ?2`)
    .bind(id, firmId)
    .first<SubscriberRow>();
  if (!row) return null;
  if (!row.confirmed_at) return null;
  if (row.stop_reason === STOP_REASON_REMOVED_BY_ADMIN) return null;
  if (row.deadline_source === DEADLINE_SOURCE_USER) return null;
  return applyRenewAndRearm(db, row);
}

/**
 * The free-tier reminder email's new co-equal "I've renewed -- remind me
 * next cycle" CTA (Part B, index.ts's handleRenewedNextCycle()). Looks the
 * row up by EITHER existing token (renewed_token or unsubscribe_token --
 * same lookup stop() already does; no new token type minted), same
 * double-opt-in-bypass guard as stop()/rearm(), and the same "bring your own
 * date can't auto-rearm" refusal as rearm(). Also refuses a row an admin has
 * removed from a firm's roster (STOP_REASON_REMOVED_BY_ADMIN) -- otherwise a
 * removed staff member's OLD reminder email (sent before they were removed)
 * would let them re-arm their own roster entry, silently undoing the
 * admin's removal.
 */
export async function renewAndRearmByToken(db: D1Database, token: string): Promise<SubscriberRow | null> {
  const row = await db
    .prepare(`SELECT * FROM subscribers WHERE unsubscribe_token = ?1 OR renewed_token = ?1`)
    .bind(token)
    .first<SubscriberRow>();
  if (!row) return null;
  if (!row.confirmed_at) return null;
  if (row.stop_reason === STOP_REASON_REMOVED_BY_ADMIN) return null;
  if (row.deadline_source === DEADLINE_SOURCE_USER) return null;
  return applyRenewAndRearm(db, row);
}

/**
 * Distinguishes WHY renewAndRearmByToken() returned null, for
 * handleRenewedNextCycle()'s error copy -- mirrors isUserDateRearmBlocked()'s
 * own docstring exactly, just against this action's different eligibility
 * pre-state (that function requires status=stopped/reason=renewed already;
 * this one runs against whatever state the row is ALREADY in, since this
 * action stops-and-rearms in one step rather than acting on an
 * already-stopped row).
 */
export async function isUserDateRenewBlocked(db: D1Database, token: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT deadline_source, confirmed_at FROM subscribers WHERE unsubscribe_token = ?1 OR renewed_token = ?1`
    )
    .bind(token)
    .first<Pick<SubscriberRow, "deadline_source" | "confirmed_at">>();
  return row !== null && row.confirmed_at !== null && row.deadline_source === DEADLINE_SOURCE_USER;
}

// ---------------------------------------------------------------------------
// CPE-hours tracker (migration 0009, 2026-07-30). See that migration's own
// comment for the forward-compat rationale behind entered_by_actor_type/
// entered_by_firm_session_id -- v1 only ever writes 'admin', but the columns
// exist so a future individual staff login doesn't need a schema change.
// ---------------------------------------------------------------------------

export type CpeCategory = "general" | "ethics" | "other";

export interface CpeEntryRow {
  id: string;
  firm_id: string;
  subscriber_id: string;
  entry_date: string;
  hours: number;
  category: string;
  description: string | null;
  certificate_document_id: string | null;
  entered_by_actor_type: string;
  entered_by_firm_session_id: string | null;
  created_at: string;
  deleted_at: string | null;
}

export interface AddCpeEntryInput {
  firmId: string;
  subscriberId: string;
  entryDate: string;
  hours: number;
  category: CpeCategory;
  description: string | null;
  enteredByFirmSessionId: string | null;
}

/**
 * Confirms `subscriberId` actually belongs to `firmId` BEFORE writing a CPE
 * entry against it -- same "look the parent up scoped to the firm first"
 * discipline getFirmLicense() already uses, so a crafted subscriber_id
 * belonging to a DIFFERENT firm can never get a CPE entry attached to it.
 * Returns null (the caller 404s) rather than throwing, matching this file's
 * existing anti-enumeration convention.
 */
export async function addCpeEntry(db: D1Database, input: AddCpeEntryInput): Promise<CpeEntryRow | null> {
  const owns = await db
    .prepare(`SELECT id FROM subscribers WHERE id = ?1 AND firm_id = ?2`)
    .bind(input.subscriberId, input.firmId)
    .first<{ id: string }>();
  if (!owns) return null;

  const id = newToken();
  const createdAt = nowIso();
  await db
    .prepare(
      `INSERT INTO cpe_entries
       (id, firm_id, subscriber_id, entry_date, hours, category, description,
        certificate_document_id, entered_by_actor_type, entered_by_firm_session_id, created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,NULL,'admin',?8,?9)`
    )
    .bind(
      id,
      input.firmId,
      input.subscriberId,
      input.entryDate,
      input.hours,
      input.category,
      input.description,
      input.enteredByFirmSessionId,
      createdAt
    )
    .run();

  return {
    id,
    firm_id: input.firmId,
    subscriber_id: input.subscriberId,
    entry_date: input.entryDate,
    hours: input.hours,
    category: input.category,
    description: input.description,
    certificate_document_id: null,
    entered_by_actor_type: "admin",
    entered_by_firm_session_id: input.enteredByFirmSessionId,
    created_at: createdAt,
    deleted_at: null,
  };
}

/** Every non-deleted CPE entry across the WHOLE firm's roster -- the
 * dashboard's CPE tab rolls this up per staffer client-side, same pattern
 * listFirmLicenses() already established for the roster itself. */
export async function listCpeEntriesForFirm(db: D1Database, firmId: string): Promise<CpeEntryRow[]> {
  const { results } = await db
    .prepare(`SELECT * FROM cpe_entries WHERE firm_id = ?1 AND deleted_at IS NULL ORDER BY entry_date DESC`)
    .bind(firmId)
    .all<CpeEntryRow>();
  return results;
}

/** Soft-delete only (deleted_at, never a real DELETE) -- see migration
 * 0009's own comment for why: preserves the audit trail of what was
 * actually logged, matching subscribers.stopped_at's existing convention.
 * firm_id-bound in the UPDATE's own WHERE clause, not just the earlier
 * lookup -- defense-in-depth, same as every other mutating query here. */
export async function removeCpeEntry(db: D1Database, firmId: string, id: string): Promise<boolean> {
  const result = await db
    .prepare(`UPDATE cpe_entries SET deleted_at = ?1 WHERE id = ?2 AND firm_id = ?3 AND deleted_at IS NULL`)
    .bind(nowIso(), id, firmId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Auth suite (2026-07-30, migration 0010) -- password storage + OAuth/SSO
// identity linking and handshake state.
//
// Same defense-in-depth posture as the firm-license CRUD above: every
// function that resolves a firm from an external identity binds the
// matching value directly in its OWN WHERE clause rather than trusting a
// caller's prior check.
// ---------------------------------------------------------------------------

/** Persists a password hash + the exact parameters it was derived with, so
 * verification never has to assume the current defaults were in force when
 * this row was written (see password.ts's needsRehash()). Overwrites any
 * existing password. Callers MUST have validated strength first -- this
 * function deliberately does not, because it is also the target of the
 * transparent re-hash path, where the plaintext already passed validation
 * at set time. */
export async function setFirmPassword(
  db: D1Database,
  firmId: string,
  record: { algo: string; salt: string; iterations: number; rounds: number; hash: string }
): Promise<void> {
  await db
    .prepare(
      `UPDATE firms
          SET password_hash = ?1, password_salt = ?2, password_algo = ?3,
              password_iterations = ?4, password_rounds = ?5, password_updated_at = ?6
        WHERE id = ?7`
    )
    .bind(record.hash, record.salt, record.algo, record.iterations, record.rounds, nowIso(), firmId)
    .run();
}

/** Clears a firm's password entirely (e.g. an admin who wants to go
 * SSO-only). Leaves the account reachable via SSO and the emailed reset
 * link -- it does NOT lock anyone out, because those paths never consult
 * these columns. */
export async function clearFirmPassword(db: D1Database, firmId: string): Promise<void> {
  await db
    .prepare(
      `UPDATE firms
          SET password_hash = NULL, password_salt = NULL, password_algo = NULL,
              password_iterations = NULL, password_rounds = NULL, password_updated_at = ?1
        WHERE id = ?2`
    )
    .bind(nowIso(), firmId)
    .run();
}

export interface FirmOauthIdentityRow {
  id: string;
  firm_id: string;
  provider: string;
  provider_subject: string;
  provider_email: string | null;
  created_at: string;
  last_login_at: string | null;
}

/**
 * Looks up a linked identity by the provider's STABLE subject claim.
 *
 * Deliberately keyed on (provider, provider_subject) and never on email.
 * A provider's `sub` is documented as immutable for the life of the
 * account; an email address is not -- it can be renamed or reassigned to a
 * different human inside the same tenant. Resolving a login by email would
 * therefore hand the firm account to whoever inherits the address.
 */
export async function findOauthIdentity(
  db: D1Database,
  provider: string,
  providerSubject: string
): Promise<FirmOauthIdentityRow | null> {
  const row = await db
    .prepare(`SELECT * FROM firm_oauth_identities WHERE provider = ?1 AND provider_subject = ?2 LIMIT 1`)
    .bind(provider, providerSubject)
    .first<FirmOauthIdentityRow>();
  return row ?? null;
}

/** Every provider identity currently linked to a firm -- powers the
 * "connected accounts" view.
 *
 * An earlier version of this comment claimed it also backed a check
 * stopping an admin from unlinking their LAST way to sign in. No such
 * check existed, and security review rightly flagged the comment as
 * misleading. It is also unnecessary: the emailed sign-in link is ALWAYS
 * available to the firm's admin address, so removing every password and
 * every linked provider still cannot lock anyone out. Unlinking is
 * therefore safe unconditionally -- that is a property of the design, not
 * an oversight. */
export async function listOauthIdentitiesForFirm(db: D1Database, firmId: string): Promise<FirmOauthIdentityRow[]> {
  const { results } = await db
    .prepare(`SELECT * FROM firm_oauth_identities WHERE firm_id = ?1 ORDER BY created_at ASC`)
    .bind(firmId)
    .all<FirmOauthIdentityRow>();
  return results ?? [];
}

/**
 * Binds a provider account to a firm.
 *
 * Returns null when the (provider, subject) pair is ALREADY linked -- the
 * UNIQUE constraint from migration 0010 is what enforces this, and the
 * insert is allowed to fail rather than being preceded by a check-then-act
 * that could race two concurrent callbacks into a double link. The caller
 * treats null as "already linked" and re-reads, instead of assuming
 * success.
 */
export async function linkOauthIdentity(
  db: D1Database,
  input: { firmId: string; provider: string; providerSubject: string; providerEmail: string | null }
): Promise<FirmOauthIdentityRow | null> {
  const id = newToken();
  const now = nowIso();
  try {
    await db
      .prepare(
        `INSERT INTO firm_oauth_identities
           (id, firm_id, provider, provider_subject, provider_email, created_at, last_login_at)
         VALUES (?1,?2,?3,?4,?5,?6,?6)`
      )
      .bind(id, input.firmId, input.provider, input.providerSubject, input.providerEmail, now)
      .run();
  } catch {
    return null;
  }
  return {
    id,
    firm_id: input.firmId,
    provider: input.provider,
    provider_subject: input.providerSubject,
    provider_email: input.providerEmail,
    created_at: now,
    last_login_at: now,
  };
}

/** Records a successful SSO sign-in. Also refreshes the cached
 * provider_email purely for display -- it is never used to resolve a
 * login. */
export async function touchOauthIdentityLogin(
  db: D1Database,
  id: string,
  firmId: string,
  providerEmail: string | null
): Promise<void> {
  // firm_id bound here too. It is not reachable today (the id comes from a
  // row just read), but this was the ONE new mutating query that broke the
  // convention this section's own header promises, and review flagged it
  // as the shape a future caller would copy somewhere it does matter.
  await db
    .prepare(`UPDATE firm_oauth_identities SET last_login_at = ?1, provider_email = ?2 WHERE id = ?3 AND firm_id = ?4`)
    .bind(nowIso(), providerEmail, id, firmId)
    .run();
}

/** Unlinks a provider from a firm. firm_id is bound in the WHERE clause so
 * one firm can never unlink another's identity even if a route forgets to
 * check ownership. */
export async function unlinkOauthIdentity(db: D1Database, firmId: string, id: string): Promise<boolean> {
  const result = await db
    .prepare(`DELETE FROM firm_oauth_identities WHERE id = ?1 AND firm_id = ?2`)
    .bind(id, firmId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** An in-flight OAuth handshake is short-lived by design: it exists only
 * between the redirect out and the callback back. 10 minutes is generous
 * for a human completing a provider consent screen, and short enough that
 * a captured `state` is stale almost immediately. */
export const OAUTH_STATE_TTL_MINUTES = 10;

export interface CreateOauthStateResult {
  rawState: string;
  codeVerifier: string;
  nonce: string;
  /** Raw value for the short-lived handshake COOKIE. Only its hash is
   * persisted; this is the copy that goes to the browser. */
  rawBrowserBinding: string;
}

/**
 * Opens a handshake: mints the CSRF `state`, the PKCE code_verifier, and
 * the OIDC `nonce`, persisting only the HASH of state (same
 * never-store-a-live-bearer-value rule as login/session tokens).
 *
 * code_verifier and nonce are stored in the clear because they must be
 * replayed to the provider / compared against a returned claim, and
 * neither is presented back to us by the browser as proof of anything --
 * only `state` is, which is why only `state` is hashed.
 */
export async function createOauthState(db: D1Database, provider: string): Promise<CreateOauthStateResult> {
  const rawState = newToken();
  const codeVerifier = newToken();
  const nonce = newToken();
  // migration 0011: the browser binding. `state` travels through the
  // provider and back via the URL, so anyone can hold a valid one; THIS
  // value only ever exists in the initiating browser's cookie jar, which
  // is what actually proves same-browser and stops login CSRF.
  const rawBrowserBinding = newToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + OAUTH_STATE_TTL_MINUTES * 60_000).toISOString();
  await db
    .prepare(
      `INSERT INTO firm_oauth_states
         (id, provider, state_hash, code_verifier, nonce, created_at, expires_at, used_at, browser_binding_hash)
       VALUES (?1,?2,?3,?4,?5,?6,?7,NULL,?8)`
    )
    .bind(
      newToken(),
      provider,
      await hashToken(rawState),
      codeVerifier,
      nonce,
      now.toISOString(),
      expiresAt,
      await hashToken(rawBrowserBinding)
    )
    .run();
  return { rawState, codeVerifier, nonce, rawBrowserBinding };
}

/**
 * Validates and CONSUMES a handshake. Returns null for unknown, expired,
 * or already-used state -- all three indistinguishable to the caller, the
 * same no-oracle posture as verifyAndConsumeLoginToken().
 *
 * Marking used_at is what makes a captured callback URL non-replayable:
 * the second attempt to redeem the same state finds used_at set and fails,
 * so an attacker who records a full callback URL still cannot mint a
 * session with it.
 *
 * The provider is returned (not accepted as a parameter) so the caller can
 * assert it matches the route it arrived on -- a state opened for Google
 * must not be redeemable at the Microsoft callback.
 */
export async function consumeOauthState(
  db: D1Database,
  rawState: string,
  rawBrowserBinding: string | null
): Promise<{ provider: string; codeVerifier: string; nonce: string } | null> {
  const stateHash = await hashToken(rawState);
  const row = await db
    .prepare(`SELECT * FROM firm_oauth_states WHERE state_hash = ?1`)
    .bind(stateHash)
    .first<{
      id: string;
      provider: string;
      code_verifier: string;
      nonce: string;
      expires_at: string;
      used_at: string | null;
      browser_binding_hash: string | null;
    }>();
  if (!row) return null;
  if (row.used_at) return null;
  if (Date.parse(row.expires_at) <= Date.now()) return null;

  // migration 0011. Fails CLOSED on a missing cookie, a missing stored
  // binding (a pre-0011 row), or a mismatch -- all indistinguishable to
  // the caller, same no-oracle posture as every other check here. This is
  // what makes a callback URL captured by someone else useless in a
  // victim's browser: they hold the state, but not this cookie.
  if (!rawBrowserBinding || !row.browser_binding_hash) return null;
  if ((await hashToken(rawBrowserBinding)) !== row.browser_binding_hash) return null;

  // Conditional UPDATE (not a bare one): `used_at IS NULL` in the WHERE
  // clause makes redemption atomic, so two concurrent callbacks carrying
  // the same state cannot both observe used_at as null above and both
  // proceed. Exactly one gets changes=1; the loser is rejected.
  const result = await db
    .prepare(`UPDATE firm_oauth_states SET used_at = ?1 WHERE id = ?2 AND used_at IS NULL`)
    .bind(nowIso(), row.id)
    .run();
  if ((result.meta.changes ?? 0) === 0) return null;

  return { provider: row.provider, codeVerifier: row.code_verifier, nonce: row.nonce };
}

/** Housekeeping: drop handshakes that were opened and never completed.
 * Called opportunistically from the OAuth start route so the table cannot
 * grow without bound from abandoned sign-in attempts. */
export async function deleteExpiredOauthStates(db: D1Database): Promise<void> {
  await db.prepare(`DELETE FROM firm_oauth_states WHERE expires_at <= ?1`).bind(nowIso()).run();
}

/**
 * Deletes every session for a firm EXCEPT the one making the request.
 *
 * Called after a successful password change. If someone else's stolen
 * session is what prompted the change, leaving that session alive would
 * make the password change pointless -- the attacker simply keeps using
 * the cookie they already have. The caller's own session is preserved so
 * changing a password doesn't log you out of the tab you're in.
 */
export async function deleteOtherSessionsForFirm(
  db: D1Database,
  firmId: string,
  keepSessionId: string
): Promise<number> {
  const result = await db
    .prepare(`DELETE FROM firm_sessions WHERE firm_id = ?1 AND id != ?2`)
    .bind(firmId, keepSessionId)
    .run();
  return result.meta.changes ?? 0;
}

// ---------------------------------------------------------------------------
// Free-tier individual sign-in (2026-07-31, migration 0012).
//
// Deliberately parallel to the firm auth functions above rather than shared
// with them. An individual principal and a firm principal must never be
// interchangeable, and the cheapest way to guarantee that is for them to
// live in different tables read by different functions -- so a bug in one
// cannot produce a principal of the other kind.
// ---------------------------------------------------------------------------

/** Same 15-minute contract as the firm login link, for the same reason:
 * it is a one-shot bearer credential sitting in an inbox. */
export const SUBSCRIBER_LOGIN_TOKEN_TTL_MINUTES = 15;

/** Shorter than the firm's 30 days. A firm dashboard is a work tool; this
 * is a check-in-occasionally view, so a shorter window costs the user
 * little and reduces what a stolen cookie is worth. */
export const SUBSCRIBER_SESSION_TTL_DAYS = 14;

/**
 * Identity for an individual is their EMAIL, normalised with
 * `normalizeEmail()` (trim + lowercase) -- NOT `cooldownKey()`.
 *
 * That distinction is load-bearing: cooldownKey folds Gmail dots and
 * +tags together, which is right for abuse throttling and WRONG for
 * identity. Using it here would let first.last@gmail.com sign in and see
 * firstlast@gmail.com's licences, which may belong to a different person.
 */
export async function createSubscriberLoginToken(
  db: D1Database,
  email: string
): Promise<{ rawToken: string }> {
  const rawToken = newToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SUBSCRIBER_LOGIN_TOKEN_TTL_MINUTES * 60_000).toISOString();
  await db
    .prepare(
      `INSERT INTO subscriber_login_tokens (id, email_normalized, token_hash, created_at, expires_at, used_at)
       VALUES (?1,?2,?3,?4,?5,NULL)`
    )
    .bind(newToken(), normalizeEmail(email), await hashToken(rawToken), now.toISOString(), expiresAt)
    .run();
  return { rawToken };
}

/**
 * Validates and CONSUMES a sign-in link. Unknown, expired and
 * already-used are indistinguishable to the caller -- the same no-oracle
 * posture as verifyAndConsumeLoginToken().
 *
 * Redemption is a CONDITIONAL update (`used_at IS NULL`) rather than
 * check-then-act, so two concurrent clicks on the same emailed link cannot
 * both succeed. Exactly one gets changes=1.
 */
export async function verifyAndConsumeSubscriberLoginToken(
  db: D1Database,
  rawToken: string
): Promise<{ emailNormalized: string } | null> {
  const tokenHash = await hashToken(rawToken);
  const row = await db
    .prepare(`SELECT * FROM subscriber_login_tokens WHERE token_hash = ?1`)
    .bind(tokenHash)
    .first<{ id: string; email_normalized: string; expires_at: string; used_at: string | null }>();
  if (!row) return null;
  if (row.used_at) return null;
  if (Date.parse(row.expires_at) <= Date.now()) return null;

  const result = await db
    .prepare(`UPDATE subscriber_login_tokens SET used_at = ?1 WHERE id = ?2 AND used_at IS NULL`)
    .bind(nowIso(), row.id)
    .run();
  if ((result.meta.changes ?? 0) === 0) return null;

  return { emailNormalized: row.email_normalized };
}

export async function createSubscriberSession(
  db: D1Database,
  emailNormalized: string
): Promise<{ rawSessionToken: string; sessionId: string }> {
  const rawSessionToken = newToken();
  const sessionId = newToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SUBSCRIBER_SESSION_TTL_DAYS * 86_400_000).toISOString();
  await db
    .prepare(
      `INSERT INTO subscriber_sessions (id, email_normalized, session_token_hash, created_at, expires_at, last_seen_at)
       VALUES (?1,?2,?3,?4,?5,?6)`
    )
    .bind(sessionId, emailNormalized, await hashToken(rawSessionToken), now.toISOString(), expiresAt, now.toISOString())
    .run();
  return { rawSessionToken, sessionId };
}

/**
 * Revokes every OTHER session for this email (2026-07-31, from the security
 * review). Called on each successful sign-in, which makes requesting a fresh
 * link the universal "sign me out everywhere" -- the only recovery an
 * individual has, since this tier has no account screen and no session list.
 *
 * It matters because a magic link is a bearer credential that lands in an
 * inbox: opened on a hotel PC, or archived by a corporate mail system that
 * later replays it, it yields a 14-day session the real owner cannot see.
 * Without this, requesting a new link would leave that session untouched.
 *
 * Mirrors deleteOtherSessionsForFirm() above, keyed on the email instead of
 * a firm id.
 */
export async function deleteOtherSubscriberSessions(
  db: D1Database,
  emailNormalized: string,
  keepSessionId: string
): Promise<number> {
  const result = await db
    .prepare(`DELETE FROM subscriber_sessions WHERE email_normalized = ?1 AND id != ?2`)
    .bind(emailNormalized, keepSessionId)
    .run();
  return result.meta.changes ?? 0;
}

export async function verifySubscriberSession(
  db: D1Database,
  rawSessionToken: string
): Promise<{ emailNormalized: string; sessionId: string } | null> {
  const sessionTokenHash = await hashToken(rawSessionToken);
  const row = await db
    .prepare(`SELECT * FROM subscriber_sessions WHERE session_token_hash = ?1`)
    .bind(sessionTokenHash)
    .first<{ id: string; email_normalized: string; expires_at: string }>();
  if (!row) return null;
  if (Date.parse(row.expires_at) <= Date.now()) return null;
  await db.prepare(`UPDATE subscriber_sessions SET last_seen_at = ?1 WHERE id = ?2`).bind(nowIso(), row.id).run();
  return { emailNormalized: row.email_normalized, sessionId: row.id };
}

export async function deleteSubscriberSession(db: D1Database, rawSessionToken: string): Promise<void> {
  await db
    .prepare(`DELETE FROM subscriber_sessions WHERE session_token_hash = ?1`)
    .bind(await hashToken(rawSessionToken))
    .run();
}

/**
 * Every licence belonging to this email.
 *
 * Scoped by `LOWER(TRIM(email))` bound directly in this statement -- the
 * same defence-in-depth rule the firm CRUD follows: the WHERE clause
 * enforces ownership, so a future route that forgets to check still cannot
 * cross between people.
 *
 * FIRM-MANAGED ROWS ARE INCLUDED, deliberately, and the caller must render
 * them read-only. A staffer added by their firm has a real licence being
 * tracked and already receives those reminder emails, so hiding it would
 * show them an incomplete and confusing picture of their own deadlines.
 * But they must not be able to edit or remove it: those rows belong to the
 * firm's roster, and letting an individual mutate one would silently break
 * the firm's coverage. `firm_id` is returned so the UI can enforce that
 * distinction, and the one action they DO retain is the unsubscribe already
 * present in every email, which is a legal requirement rather than ours to
 * withhold.
 *
 * Removed-by-admin rows are excluded, matching listFirmLicenses().
 *
 * DEPENDS ON EMAIL_RE BEING ASCII-ONLY (2026-07-31, security review).
 * SQLite's LOWER() is ASCII-only; JavaScript's toLowerCase() (inside
 * normalizeEmail) is full-Unicode, so the two are NOT the same function --
 * e.g. U+212A KELVIN SIGN lowercases to "k" in JS and not at all in SQLite,
 * and SQLite's TRIM strips only spaces where JS trim() strips all Unicode
 * whitespace. Today that divergence is unreachable because every write path
 * into `subscribers.email` is gated by isValidEmail(), whose EMAIL_RE
 * rejects non-ASCII and whitespace outright, so no stored address can
 * differ between the two. If that regex is ever relaxed to accept
 * internationalised addresses, THIS COMPARISON BECOMES A SECURITY BUG in
 * both directions: over-matching (one person's normalised form colliding
 * with another's stored row) and under-matching (an owner locked out of
 * their own rows). Change the regex and this query together, or store a
 * single normalised column and compare that.
 */
export async function listSubscriberLicenses(
  db: D1Database,
  emailNormalized: string
): Promise<SubscriberRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM subscribers
        WHERE LOWER(TRIM(email)) = ?1
          AND NOT (status = ?2 AND stop_reason = ?3)
        ORDER BY state_slug ASC`
    )
    .bind(emailNormalized, STATUS_STOPPED, STOP_REASON_REMOVED_BY_ADMIN)
    .all<SubscriberRow>();
  return results ?? [];
}
