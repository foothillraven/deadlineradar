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
  MAX_ADMIN_NAME_LEN,
  MAX_FIRM_NAME_LEN,
  MAX_STAFF_COUNT_HINT_LEN,
  MAX_STAFF_LABEL_LEN,
  MAX_OFFICE_TAG_LEN,
  MAX_INTERNAL_NOTES_LEN,
  sanitizeFirstName,
  sanitizeFreeText,
} from "./validation";
import { computeSubscriberDeadline } from "./deadline";

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

// Task #3 (2026-08-06): the firm deleted its own account -- distinguishes
// this from an admin removing one specific staffer. requestFirmDeletion()
// below is the only writer.
export const STOP_REASON_FIRM_DELETED = "firm_deleted";

export const FIRM_STATUS_DELETED = "deleted";

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
  // migration 0017. NULL until the first PATCH /firm/licenses/:id (an admin
  // edit) or POST .../renew (a marked-renewed) respectively -- these are the
  // real facts toFirmLicenseJson()'s old comment said didn't exist yet. Both
  // feed the dashboard's Recent Activity panel as their own distinct event
  // types, separate from 'added' (see generate.py's drRenderActivity()).
  last_edited_at: string | null;
  renewed_at: string | null;
  // migration 0034 (roadmap #7). Self-reported, in cents -- see that
  // migration's own docstring for why this is never a verified/sourced
  // fact. NULL means the admin hasn't entered a fee for this license.
  renewal_fee_cents: number | null;
  // migration 0036 (roadmap #10). Self-reported hours carried over from a
  // PRIOR CPE cycle -- see that migration's own docstring for why this is
  // never a state-asserted fact. NULL means the admin hasn't entered any.
  // Applied only to the TOTAL-hours progress calc, never ethics -- see
  // generate.py's drCpeProgressForSubscriber() comment for why.
  carryover_hours: number | null;
  // migration 0037 (roadmap #16). Admin's own office/department label --
  // same free-text, no-implied-structure posture as staff_label. NULL means
  // untagged.
  office_tag: string | null;
  // migration 0040 (roadmap #26). ISO YYYY-MM-DD or null. Self-service,
  // fixed 14-day snooze -- see that migration's own docstring. scheduler.ts
  // skips threshold evaluation entirely while this is today-or-later;
  // applyRenewAndRearm() always clears it back to null on any renewal path.
  snoozed_until: string | null;
  // migration 0041 (roadmap #68). Admin's own free-text note about this
  // staff member -- internal-only, never shown to the subscriber or in any
  // email. NULL means no note. Edit-only, same as carryover_hours (no
  // create-time field -- a brand-new roster entry has nothing to note yet).
  internal_notes: string | null;
  // migration 0046 (roadmap #12). Same JSON-array-subset shape as
  // firms.reminder_thresholds -- NULL means "inherit the firm's setting"
  // (or the full 6-value default for a free-tier row with no firm at
  // all). scheduler.ts's runReminderPass() reads this as an override
  // AFTER resolving the firm's own thresholds, never in place of it.
  reminder_thresholds: string | null;
  // migration 0051 (roadmap #24). "immediate" (default, today's only prior
  // behavior) or "digest" -- scheduler.ts's runReminderPass() skips any
  // "digest" row entirely; runDigestPass() is the only pass that acts on
  // it. See setSubscriberNotificationMode()'s own docstring for the
  // cross-row-write reach.
  notification_mode: string;
  // migration 0051. NULL until the first digest actually sends, then a
  // rolling +7-day window -- see advanceDigestWindow()'s own docstring.
  digest_next_send_at: string | null;
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
  // Orchestrator cross-flow finding (2026-08-05): this cooldown is the
  // free-individual /subscribe flow's own mail-bombing backstop (see
  // index.ts's comment at the one call site -- stops a burst of brand-new
  // confirmation emails across many states hitting one inbox). A firm
  // admin adding someone to their roster writes a subscribers row too, but
  // that path is authenticated, separately rate-limited, sends a DIFFERENT
  // email (buildFirmStaffAddedEmail(), under its own send budget), and
  // skips confirmation entirely -- it was never the abuse pattern this
  // cooldown defends against, so it must not consume the SAME person's
  // cooldown slot for the unrelated individual product. firm_id is set
  // only at INSERT time by the firm-add path (never backfilled onto an
  // existing row -- see AddPendingInput.firmId's own docstring), so
  // excluding it here is exact, not a heuristic.
  //
  // Deliberately NOT narrowed to (cooldown_key, state_slug) instead -- that
  // was considered and rejected: it would reopen the exact cross-state
  // mail-bombing pattern this cooldown exists to stop, since an attacker
  // could then just submit once per state per window.
  const row = await db
    .prepare("SELECT 1 FROM subscribers WHERE cooldown_key = ?1 AND created_at >= ?2 AND firm_id IS NULL LIMIT 1")
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
 * Reported directly, 2026-08-05: a firm can add/edit a roster row onto an
 * email ALREADY live elsewhere on their own roster (a different state, or a
 * genuine typo of someone already added), with no signal at all -- both
 * rows count toward the 25-staff cap and the roster reports them as
 * distinct people. NOT a hard block: (email, state_slug) is findActiveOrPending()'s
 * deliberate uniqueness key, not (email) alone, because one real CPA
 * licensed in multiple states is legitimately tracked as multiple rows
 * sharing an email -- a firm-wide email-uniqueness constraint would break
 * that intentional case. This is a same-firm, state-agnostic lookup used
 * ONLY to surface a non-blocking warning back to the admin ("this email is
 * already on your roster for X") so an honest typo gets caught without
 * disallowing the legitimate multi-state one.
 */
export async function findOtherFirmRowsByEmail(
  db: D1Database,
  firmId: string,
  email: string,
  excludeId: string
): Promise<SubscriberRow[]> {
  const key = cooldownKey(email);
  const result = await db
    .prepare(
      `SELECT * FROM subscribers
       WHERE cooldown_key = ?1 AND firm_id = ?2 AND status IN (?3, ?4) AND id != ?5`
    )
    .bind(key, firmId, STATUS_PENDING, STATUS_CONFIRMED, excludeId)
    .all<SubscriberRow>();
  return result.results ?? [];
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
  /** migration 0034 (roadmap #7). Self-reported, in cents. Omitted (-> null)
   * for the free-tier /subscribe path, same posture as firmId/staffLabel --
   * a fee rollup is a firm-dashboard concept, not something a free
   * individual reminder signup has any use for. */
  renewalFeeCents?: number | null;
  /** migration 0037 (roadmap #16). Optional office/department label, same
   * firm-dashboard-only posture as renewalFeeCents above. */
  officeTag?: string | null;
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
    last_edited_at: null,
    renewed_at: null,
    renewal_fee_cents: input.renewalFeeCents ?? null,
    // Roadmap #10: edit-only field (a new staffer never has carryover hours
    // to enter yet -- that only becomes a real fact once a prior cycle has
    // actually elapsed), so AddPendingInput has no corresponding field.
    carryover_hours: null,
    office_tag: sanitizeFreeText(input.officeTag, MAX_OFFICE_TAG_LEN),
    // Roadmap #26: a new staffer starts un-snoozed, same as every other
    // brand-new record.
    snoozed_until: null,
    // Roadmap #12: edit-only, same reasoning as carryover_hours/internal_notes
    // above -- a brand-new record has no self-service preference to inherit
    // yet, so it starts NULL ("use the firm's setting").
    reminder_thresholds: null,
    // Roadmap #68: edit-only, same reasoning as carryover_hours above --
    // not part of the INSERT column list either, same as that field.
    internal_notes: null,
    // Roadmap #24: a brand-new record always starts on the default
    // immediate delivery -- matches the column's own DB default, not part
    // of the INSERT column list either, same as reminder_thresholds/
    // internal_notes above.
    notification_mode: NOTIFICATION_MODE_IMMEDIATE,
    digest_next_send_at: null,
  };
  await db
    .prepare(
      `INSERT INTO subscribers
       (id, email, cooldown_key, state_slug, deadline_fields, first_name, status,
        confirm_token, unsubscribe_token, renewed_token, created_at, confirmed_at,
        stopped_at, stop_reason, reminders_sent, cycle, deadline_source, user_deadline,
        last_resend_at, resend_count, firm_id, staff_label, renewal_fee_cents, office_tag)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24)`
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
      record.staff_label,
      record.renewal_fee_cents,
      record.office_tag
    )
    .run();
  return record;
}

/**
 * AuditLab LC-1 (LOW, 2026-08-04): remove-then-re-add is a legitimate,
 * common admin action (undoing a mistaken removal, or a genuine rehire) and
 * addPending() correctly creates a fresh row for it rather than colliding
 * with the removed one (findActiveOrPending() only matches pending/confirmed
 * status, never stopped) -- but that fresh row starts with no CPE history,
 * and the person's real, previously-logged hours are left permanently
 * attached to the now-inert removed row, attributed to "Removed staff
 * member" and counting toward nobody's requirement.
 *
 * Deliberately reattaches cpe_entries rather than resurrecting the OLD
 * subscriber row itself (the alternative AuditLab also named) -- reusing
 * the old row would mean silently reusing its tokens/consent timestamps/
 * reminder-send history for what the admin experiences as a brand new add,
 * a much larger and more consent-sensitive change for a LOW-severity, safe-
 * direction (understates compliance, never overclaims) finding. Only
 * migrates entries from a PRIOR row for the exact same (firm, email, state)
 * -- CPE entries are state-scoped through their subscriber_id, so hours
 * logged against a different state's removed row must not follow here.
 */
export async function reattachOrphanedCpeEntries(
  db: D1Database,
  firmId: string,
  email: string,
  stateSlug: string,
  newSubscriberId: string
): Promise<number> {
  const key = cooldownKey(email);
  const { results: removedRows } = await db
    .prepare(
      `SELECT id FROM subscribers
       WHERE firm_id = ?1 AND cooldown_key = ?2 AND state_slug = ?3
         AND status = ?4 AND stop_reason = ?5 AND id != ?6`
    )
    .bind(firmId, key, stateSlug, STATUS_STOPPED, STOP_REASON_REMOVED_BY_ADMIN, newSubscriberId)
    .all<{ id: string }>();
  if (removedRows.length === 0) return 0;

  let migrated = 0;
  for (const row of removedRows) {
    const result = await db
      .prepare(`UPDATE cpe_entries SET subscriber_id = ?1 WHERE subscriber_id = ?2 AND firm_id = ?3`)
      .bind(newSubscriberId, row.id, firmId)
      .run();
    migrated += result.meta.changes ?? 0;
  }
  return migrated;
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

/**
 * store.py:244 `confirm()` -- idempotent, matches the Python original.
 * Thin wrapper over confirmIfPending() below; see that function for why the
 * transition flag exists.
 */
export async function confirm(db: D1Database, confirmToken: string): Promise<SubscriberRow | null> {
  const result = await confirmIfPending(db, confirmToken);
  return result ? result.subscriber : null;
}

/**
 * Same PENDING -> CONFIRMED transition as confirm() above, but also reports
 * whether THIS call is what performed it, vs. finding the subscriber
 * already confirmed (confirm() is deliberately idempotent, so a repeat hit
 * on the same link -- an email client prefetching it, a double-click --
 * returns the same row either way). index.ts's handleConfirm() needs this
 * distinction so it fires the internal signup-notification email (2026-08-05)
 * exactly once per real confirmation, not once per request that happens to
 * land on an already-confirmed token.
 */
export async function confirmIfPending(
  db: D1Database,
  confirmToken: string
): Promise<{ subscriber: SubscriberRow; wasNewlyConfirmed: boolean } | null> {
  const row = await db
    .prepare("SELECT * FROM subscribers WHERE confirm_token = ?1")
    .bind(confirmToken)
    .first<SubscriberRow>();
  if (!row) return null;
  const wasNewlyConfirmed = row.status === STATUS_PENDING;
  if (wasNewlyConfirmed) {
    const confirmedAt = nowIso();
    await db
      .prepare("UPDATE subscribers SET status = ?1, confirmed_at = ?2 WHERE id = ?3")
      .bind(STATUS_CONFIRMED, confirmedAt, row.id)
      .run();
    row.status = STATUS_CONFIRMED;
    row.confirmed_at = confirmedAt;
  }
  return { subscriber: row, wasNewlyConfirmed };
}

/**
 * store.py:260 `stop()`. Carries forward the double-opt-in-bypass fix
 * verbatim: reason="renewed" only ever applies to a subscriber who was
 * actually confirmed at some point (`confirmed_at IS NOT NULL`) -- a
 * still-pending record's own signup-time tokens must never be able to
 * reach STOPPED/renewed (and, via rearm() below, all the way to
 * STOPPED->CONFIRMED) without a real `/confirm` ever happening.
 * reason="unsubscribed" is honored regardless of confirmed_at.
 *
 * Idempotent as of AuditLab UNSUB-1 (2026-08-06, MEDIUM): unsubscribe_token
 * is a stable, never-rotated, never-expiring link by design (the SELECT
 * above matches it regardless of current status) -- so this function has
 * always been re-visitable indefinitely, and that was harmless right up
 * until Task #10 hung a real outbound email off every call. A repeat visit
 * (corporate email-security scanners routinely pre-fetch/re-scan
 * unsubscribe links, sometimes more than once) now SKIPS the write
 * entirely rather than re-stamping `stopped_at`/`stop_reason` to "now" --
 * both because there's nothing left to change, and because overwriting the
 * real original stop time on every scanner re-visit was its own silent
 * data-integrity bug AuditLab caught in passing. `alreadyStopped` on the
 * returned row is what callers use to skip a repeat-triggered notification
 * email without needing a second query.
 */
export async function stop(
  db: D1Database,
  token: string,
  reason: "unsubscribed" | "renewed"
): Promise<(SubscriberRow & { alreadyStopped: boolean }) | null> {
  const row = await db
    .prepare("SELECT * FROM subscribers WHERE unsubscribe_token = ?1 OR renewed_token = ?1")
    .bind(token)
    .first<SubscriberRow>();
  if (!row) return null;
  if (reason === "renewed" && !row.confirmed_at) return null;
  if (row.status === STATUS_STOPPED) {
    return { ...row, alreadyStopped: true };
  }
  const stoppedAt = nowIso();
  await db
    .prepare("UPDATE subscribers SET status = ?1, stopped_at = ?2, stop_reason = ?3 WHERE id = ?4")
    .bind(STATUS_STOPPED, stoppedAt, reason, row.id)
    .run();
  row.status = STATUS_STOPPED;
  row.stopped_at = stoppedAt;
  row.stop_reason = reason;
  return { ...row, alreadyStopped: false };
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
 * Atomically claims a reminder threshold for a subscriber BEFORE sending --
 * closes AuditLab SCHED-A (two overlapping runReminderPass() calls, e.g. a
 * cron retry or a redeploy mid-run, both reading reminders_sent=[] and both
 * sending the same tier). Optimistic concurrency: the UPDATE only applies if
 * reminders_sent still equals the exact JSON string the caller read earlier
 * in its own pass, so whichever call reaches this UPDATE first wins and the
 * loser's WHERE clause matches zero rows.
 *
 * Returns true if this call won the claim (caller should proceed to send);
 * false if the threshold was already present or another pass claimed it
 * first (caller should skip -- not its tier to send).
 */
export async function claimReminderThreshold(
  db: D1Database,
  subscriberId: string,
  previousRemindersSentJson: string,
  thresholdDays: number
): Promise<boolean> {
  const sent: number[] = JSON.parse(previousRemindersSentJson || "[]");
  if (sent.includes(thresholdDays)) return false;
  const next = JSON.stringify([...sent, thresholdDays]);
  const result = await db
    .prepare("UPDATE subscribers SET reminders_sent = ?1 WHERE id = ?2 AND reminders_sent = ?3")
    .bind(next, subscriberId, previousRemindersSentJson)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/**
 * Reverts a claimReminderThreshold() claim after a failed send (cap reached
 * or send() returned false), so the threshold is retried on the next pass
 * instead of being silently lost -- preserves the deliberate at-least-once
 * delivery semantics (a duplicate reminder beats a missed one) on failure,
 * while still preventing the double-send race claimReminderThreshold() closes
 * on success. Best-effort against whatever reminders_sent holds NOW rather
 * than the claim-time snapshot, since another tier may have been claimed for
 * the same subscriber in the interim.
 */
export async function unclaimReminderThreshold(db: D1Database, subscriberId: string, thresholdDays: number): Promise<void> {
  const row = await db
    .prepare("SELECT reminders_sent FROM subscribers WHERE id = ?1")
    .bind(subscriberId)
    .first<{ reminders_sent: string }>();
  if (!row) return;
  const sent: number[] = JSON.parse(row.reminders_sent);
  const next = sent.filter((t) => t !== thresholdDays);
  if (next.length !== sent.length) {
    await db
      .prepare("UPDATE subscribers SET reminders_sent = ?1 WHERE id = ?2")
      .bind(JSON.stringify(next), subscriberId)
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

// ---------------------------------------------------------------------------
// Drip course (2026-08-08, roadmap #34, migration 0049). A free renewal-
// reminder email course for confirmed free-tier subscribers who haven't
// converted to a paying firm account. Identity here is the EMAIL, not a
// `subscribers` row -- same reasoning individual_accounts/firm_leads already
// established for cross-cutting per-person concepts (one person can have
// several `subscribers` rows, one per state/license tracked).
// ---------------------------------------------------------------------------

export interface DripCourseEnrollmentRow {
  id: string;
  email_normalized: string;
  email: string;
  first_name: string | null;
  state_slug: string | null;
  started_at: string;
  steps_sent: string;
  opted_out_at: string | null;
  unsubscribe_token: string;
  created_at: string;
}

export interface DripCourseLead {
  email: string;
  first_name: string | null;
  state_slug: string;
}

/**
 * Eligible = confirmed, free-tier (firm_id IS NULL), not already enrolled,
 * not already running a firm (checked against BOTH firms.admin_email and
 * firm_members.email -- a person can convert as either), and not
 * permanently suppressed. `LIMIT` bounds each pass so a large backlog on
 * first deploy doesn't try to enroll everyone in one burst -- mirrors the
 * reminder pass's own per-pass bounding.
 *
 * `GROUP BY` collapses a person's multiple `subscribers` rows (one per
 * state/license tracked) to one lead -- state_slug is taken from whichever
 * row sorts first, which is an arbitrary but harmless choice (the drip
 * course's own personalization is a nice-to-have, not a correctness-
 * critical fact).
 */
export async function findEligibleDripCourseLeads(db: D1Database, limit: number): Promise<DripCourseLead[]> {
  const { results } = await db
    .prepare(
      `SELECT s.email AS email, s.first_name AS first_name, s.state_slug AS state_slug
       FROM subscribers s
       WHERE s.status = ?1
         AND s.firm_id IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM drip_course_enrollments d WHERE d.email_normalized = LOWER(TRIM(s.email))
         )
         AND NOT EXISTS (
           SELECT 1 FROM firms f WHERE LOWER(TRIM(f.admin_email)) = LOWER(TRIM(s.email))
         )
         AND NOT EXISTS (
           SELECT 1 FROM firm_members m WHERE LOWER(TRIM(m.email)) = LOWER(TRIM(s.email))
         )
       GROUP BY LOWER(TRIM(s.email))
       LIMIT ?2`
    )
    .bind(STATUS_CONFIRMED, limit)
    .all<DripCourseLead>();
  const leads: DripCourseLead[] = [];
  for (const r of results) {
    // isPermanentlySuppressed() isn't expressible as a single SQL predicate
    // (it compares timestamps across rows) -- checked per-candidate here,
    // same as every other caller of this function has to.
    if (!(await isPermanentlySuppressed(db, r.email))) leads.push(r);
  }
  return leads;
}

/** `INSERT ... ON CONFLICT DO NOTHING` -- idempotent, so a caller never has
 * to pre-check whether a lead is already enrolled (findEligibleDripCourseLeads()
 * already excludes existing enrollments, but this stays safe under a
 * concurrent pass too, same belt-and-suspenders posture as elsewhere). */
export async function enrollDripCourseLead(db: D1Database, lead: DripCourseLead): Promise<void> {
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO drip_course_enrollments
         (id, email_normalized, email, first_name, state_slug, started_at, steps_sent, opted_out_at, unsubscribe_token, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, '[]', NULL, ?7, ?6)
       ON CONFLICT (email_normalized) DO NOTHING`
    )
    .bind(newToken(), normalizeEmail(lead.email), lead.email, lead.first_name, lead.state_slug, now, newToken())
    .run();
}

export async function listActiveDripCourseEnrollments(db: D1Database): Promise<DripCourseEnrollmentRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM drip_course_enrollments WHERE opted_out_at IS NULL")
    .all<DripCourseEnrollmentRow>();
  return results;
}

/** Same optimistic-concurrency shape as claimReminderThreshold(): the
 * UPDATE only applies if steps_sent still equals the exact JSON string the
 * caller read earlier in its own pass, so two overlapping passes can't
 * double-send the same step. */
export async function claimDripCourseStep(
  db: D1Database,
  enrollmentId: string,
  previousStepsSentJson: string,
  step: number
): Promise<boolean> {
  const sent: number[] = JSON.parse(previousStepsSentJson || "[]");
  if (sent.includes(step)) return false;
  const next = JSON.stringify([...sent, step]);
  const result = await db
    .prepare("UPDATE drip_course_enrollments SET steps_sent = ?1 WHERE id = ?2 AND steps_sent = ?3")
    .bind(next, enrollmentId, previousStepsSentJson)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** Reverts a claimDripCourseStep() claim after a failed send, mirroring
 * unclaimReminderThreshold()'s own at-least-once-delivery reasoning. */
export async function unclaimDripCourseStep(db: D1Database, enrollmentId: string, step: number): Promise<void> {
  const row = await db
    .prepare("SELECT steps_sent FROM drip_course_enrollments WHERE id = ?1")
    .bind(enrollmentId)
    .first<{ steps_sent: string }>();
  if (!row) return;
  const sent: number[] = JSON.parse(row.steps_sent);
  const next = sent.filter((s) => s !== step);
  if (next.length !== sent.length) {
    await db.prepare("UPDATE drip_course_enrollments SET steps_sent = ?1 WHERE id = ?2").bind(JSON.stringify(next), enrollmentId).run();
  }
}

/** Idempotent, mirrors store.stop()'s own repeat-visit posture (a scanner
 * re-hitting the unsubscribe link must not error). */
export async function stopDripCourseByToken(db: D1Database, token: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT id, opted_out_at FROM drip_course_enrollments WHERE unsubscribe_token = ?1")
    .bind(token)
    .first<{ id: string; opted_out_at: string | null }>();
  if (!row) return false;
  if (row.opted_out_at) return true;
  await db.prepare("UPDATE drip_course_enrollments SET opted_out_at = ?1 WHERE id = ?2").bind(nowIso(), row.id).run();
  return true;
}

// ---------------------------------------------------------------------------
// Rule-change alerts (2026-08-08, roadmap #9/#319, migration 0050). Wires
// two systems that already existed independently: the reg_change_events.json
// feed /rule-changes/ and the dashboard calendar already publish, and the
// reminder engine's own email-sending machinery -- no new data collection.
// Proactively alerts the firm ADMIN (not staff directly) when a new rule
// change touches a state their roster is actually licensed in, preserving
// the existing human-in-the-loop "Notify staff in this state" button as the
// admin's own next step, not something this bypasses.
// ---------------------------------------------------------------------------

/**
 * Firms eligible for a proactive alert about ONE event: alerts enabled,
 * active firm status, at least one roster license in `stateSlug` that isn't
 * opted out (same "opted_out" definition index.ts's firmLicenseStatus()
 * uses: status='stopped' AND stop_reason='unsubscribed' -- pending/needs-
 * attention staff still count, mirroring the existing admin-triggered
 * notify flow's own reasoning that a rule change isn't about any one
 * staffer's deadline status), and not already notified about this exact
 * `eventId` (firm_rule_change_notifications).
 */
export async function findFirmsEligibleForRuleChangeAlert(db: D1Database, stateSlug: string, eventId: string, limit: number): Promise<FirmRow[]> {
  const { results } = await db
    .prepare(
      `SELECT f.* FROM firms f
       WHERE f.status = 'active'
         AND f.rule_change_alerts_enabled = 1
         AND EXISTS (
           SELECT 1 FROM subscribers s
           WHERE s.firm_id = f.id AND s.state_slug = ?1
             AND NOT (s.status = ?2 AND s.stop_reason = 'unsubscribed')
         )
         AND NOT EXISTS (
           SELECT 1 FROM firm_rule_change_notifications n WHERE n.firm_id = f.id AND n.event_id = ?3
         )
       LIMIT ?4`
    )
    .bind(stateSlug, STATUS_STOPPED, eventId, limit)
    .all<FirmRow>();
  return results;
}

/** Claim-before-send, same shape as claimReminderThreshold()/
 * claimDripCourseStep(): the UNIQUE(firm_id, event_id) constraint means a
 * concurrent pass's INSERT loses the race and this returns false, so the
 * event is not claimed twice. */
export async function claimRuleChangeNotification(db: D1Database, firmId: string, eventId: string): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO firm_rule_change_notifications (id, firm_id, event_id, notified_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (firm_id, event_id) DO NOTHING`
    )
    .bind(newToken(), firmId, eventId, nowIso())
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** Reverts a claimRuleChangeNotification() claim after a failed send, same
 * at-least-once-delivery reasoning as unclaimReminderThreshold()/
 * unclaimDripCourseStep(). */
export async function unclaimRuleChangeNotification(db: D1Database, firmId: string, eventId: string): Promise<void> {
  await db.prepare(`DELETE FROM firm_rule_change_notifications WHERE firm_id = ?1 AND event_id = ?2`).bind(firmId, eventId).run();
}

export async function setFirmRuleChangeAlertsEnabled(db: D1Database, firmId: string, enabled: boolean): Promise<void> {
  await db.prepare(`UPDATE firms SET rule_change_alerts_enabled = ?1 WHERE id = ?2`).bind(enabled ? 1 : 0, firmId).run();
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
  // migration 0020: optional, collected at signup, used only to personalize
  // outbound emails ("Hi Sarah" instead of a generic greeting) -- never
  // required, never validated as a real legal name.
  admin_name: string | null;
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
  // migration 0018 (paid tiers). Both nullable: a pilot firm that has never
  // reached checkout has neither.
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  // migration 0021 (self-serve cancellation). cancel_at_period_end is
  // display/UI state only -- plan_tier (and therefore real access) never
  // changes until Stripe's own customer.subscription.deleted webhook fires
  // at the actual period end. current_period_end is null until a cancel or
  // resume call has actually run at least once.
  cancel_at_period_end: number;
  current_period_end: string | null;
  // migration 0024 (Task #27): a shared public/sandbox account. See that
  // migration's own docstring -- blocks self-serve in-session password
  // changes and SSO linking, NOT the emailed password-reset path.
  demo_locked: number;
  // migration 0026 (Task #3). Null unless deletion has been requested; once
  // set, requestFirmDeletion() has already flipped status to
  // FIRM_STATUS_DELETED, so these three are otherwise inert (nothing reads
  // them to make an access decision -- status already did that).
  deletion_requested_at: string | null;
  deletion_survey_reason: string | null;
  deletion_survey_detail: string | null;
  // migration 0027 (Task #32). Both null when no refund applied.
  deletion_refund_cents: number | null;
  deletion_refund_id: string | null;
  // migration 0029 (Task #19). Null = still show the one-time post-signup
  // feature-request questionnaire; set (real submission or an explicit
  // skip) = never show it again for this firm.
  feature_questionnaire_dismissed_at: string | null;
  // migration 0030 (roadmap #28). Null = still show the guided onboarding
  // checklist; set (explicit dismiss) = never show it again for this firm.
  onboarding_checklist_dismissed_at: string | null;
  // migration 0031 (roadmap #30). Null = still auto-show the product tour on
  // next load; set (skip or finish) = never auto-show again. A voluntary
  // replay from the Account tab is client-side only and doesn't touch this.
  product_tour_dismissed_at: string | null;
  // migration 0033 (roadmap #6). Firm-level (not per-staff) -- the firm's
  // own next peer-review due date, admin-entered. Null = not tracked yet.
  peer_review_due_date: string | null;
  // migration 0038 (roadmap #19). Self-reported, optional -- routes a
  // recipient's reply to the firm instead of DeadlineRadar. Null = every
  // reminder email keeps its existing (no explicit Reply-To) behavior.
  reply_to_email: string | null;
  // migration 0039 (roadmap #23). JSON array of a SUBSET of
  // ESCALATION_THRESHOLDS_DAYS (scheduler.ts), or null for every threshold
  // (today's fixed behavior). Validated server-side on write -- see that
  // migration's own docstring for why this is a subset, not arbitrary values.
  reminder_thresholds: string | null;
  // migration 0042 (roadmap #144). Null = never prompted yet. Set whenever
  // the NPS prompt is SHOWN (answered or dismissed either way) -- see
  // shouldPromptNps()'s own docstring for the quarterly-cadence rule.
  nps_last_prompted_at: string | null;
  // migration 0044 (roadmap #56). The ISO date (validation.ts's
  // TERMS_VERSION) of the Terms text this firm accepted at signup. Null
  // for every firm created before this migration, or created via a path
  // that didn't pass it (e.g. a test helper) -- no fabricated backfill.
  tos_accepted_version: string | null;
  // migration 0045 (roadmap #11/#13/#14/#51). The firm's current primary/
  // billing contact -- a firm_members.id. Transferring ownership (#51)
  // updates this pointer; nothing about the member row itself changes.
  primary_member_id: string | null;
  // migration 0050 (roadmap #9/#319). Opt-out, defaults to 1 (enabled) --
  // see that migration's own docstring for why on-by-default is the
  // deliberate call here, not the usual "new email type defaults off."
  rule_change_alerts_enabled: number;
  // migration 0052 (roadmap #20). NULL slack_webhook_url = not connected --
  // the single source of truth read everywhere "is Slack on" matters.
  // access_token is encrypted at rest (totp.ts's encryptSecretAesGcm(),
  // contextId = firm id) since it's a live bearer credential, needed only
  // so disconnect can call Slack's auth.revoke -- posting itself only ever
  // uses slack_webhook_url. Never serialized to the client, same posture
  // as password_hash.
  slack_webhook_url: string | null;
  slack_access_token_encrypted: string | null;
  slack_access_token_iv: string | null;
  slack_team_name: string | null;
  slack_channel_name: string | null;
  // migration 0053 (roadmap #21). NULL = not connected, same posture as
  // slack_webhook_url -- no access-token/encryption columns needed at all,
  // since there's no OAuth flow here (see teams.ts's own docstring). Never
  // serialized to the client -- a Teams webhook URL is as much a bearer
  // secret as a Slack one, even though this one is firm-admin-supplied.
  teams_webhook_url: string | null;
}

export interface FirmLoginTokenRow {
  id: string;
  firm_id: string;
  token_hash: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  /** migration 0045; absent on rows written before it. Every token issued
   * going forward always sets this -- see createLoginToken()'s own
   * comment. */
  member_id?: string | null;
  /** migration 0013. Optional on the TYPE because rows written before that
   * migration predate the column; normalizeLoginTokenPurpose() turns any
   * absent/unrecognised value into the safe "login" default. */
  purpose?: string;
  /** migration 0022. Only ever set (and only ever meaningful) when
   * purpose === "email_change" -- see createLoginToken()'s own comment. */
  pending_new_email?: string | null;
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
  /** migration 0045. Nullable on the TYPE only for pre-0045 rows the
   * migration's own backfill already resolved -- every row read through
   * verifySession() is required to have one (see that function's INNER
   * JOIN on firm_members). */
  member_id?: string | null;
}

/**
 * migration 0045 (roadmap #11/#13/#14/#51): one row per person who can sign
 * into a firm, each with their own credentials and a role. See that
 * migration's own docstring for the full "why" -- firms.admin_email/
 * password_* stay in place for backward compatibility (billing/Stripe
 * correspondence, every existing outbound-email call site) but a session
 * is now attributed to a SPECIFIC member, not just a firm.
 */
export type FirmMemberRole = "partner" | "office_manager" | "staff";

export interface FirmMemberRow {
  id: string;
  firm_id: string;
  email: string;
  name: string | null;
  role: FirmMemberRole;
  password_hash: string | null;
  password_salt: string | null;
  password_algo: string | null;
  password_iterations: number | null;
  password_rounds: number | null;
  password_updated_at: string | null;
  invited_at: string;
  invited_by_member_id: string | null;
  joined_at: string | null;
  removed_at: string | null;
  created_at: string;
  // migration 0047 (roadmap #53). NULL = 2FA not enrolled. The secret is
  // ENCRYPTED, not hashed (unlike a password, TOTP needs the secret back
  // to compute the current code) -- see worker/src/totp.ts's own
  // docstring. totp_secret_iv is the per-row random AES-GCM IV, never
  // derived from the key alone.
  totp_secret_encrypted: string | null;
  totp_secret_iv: string | null;
  totp_enrolled_at: string | null;
  // migration 0048 (AuditLab 2FA-1, MEDIUM): the RFC 6238 Section 5.2
  // replay-prevention floor -- see setFirmMemberTotpLastUsedTimestep()'s
  // own docstring below.
  totp_last_used_timestep: number | null;
}

export interface CreateFirmMemberInput {
  firmId: string;
  email: string;
  name?: string | null;
  role: FirmMemberRole;
  invitedByMemberId?: string | null;
  /** Set only for the very first (backfilled/signup-created) partner, who
   * is active from the moment the firm exists -- every INVITED member
   * starts with joined_at unset (an outstanding invite) until they
   * actually sign in once. */
  alreadyJoined?: boolean;
}

/** Re-sanitizes name independently of the request-layer validation in
 * index.ts, same defense-in-depth posture as createFirm()'s own re-call of
 * sanitizeFreeText() above. */
export async function createFirmMember(db: D1Database, input: CreateFirmMemberInput): Promise<{ id: string }> {
  const id = newToken();
  const name = sanitizeFreeText(input.name ?? null, MAX_ADMIN_NAME_LEN);
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO firm_members (id, firm_id, email, name, role, invited_at, invited_by_member_id, joined_at, created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`
    )
    .bind(
      id,
      input.firmId,
      input.email.trim(),
      name,
      input.role,
      now,
      input.invitedByMemberId ?? null,
      input.alreadyJoined ? now : null,
      now
    )
    .run();
  return { id };
}

/** Mirrors findFirmByAdminEmail()'s own normalization/no-index reasoning --
 * firm_members is expected to stay just as small as firms itself. Excludes
 * soft-removed members, same as the migration's own partial unique index. */
export async function findFirmMemberByEmail(db: D1Database, email: string): Promise<FirmMemberRow | null> {
  const normalized = normalizeEmail(email);
  const row = await db
    .prepare(`SELECT * FROM firm_members WHERE LOWER(TRIM(email)) = ?1 AND removed_at IS NULL LIMIT 1`)
    .bind(normalized)
    .first<FirmMemberRow>();
  return row ?? null;
}

/** AuditLab MEMBER-1 (LOW, 2026-08-07): firmId is REQUIRED and bound into
 * the WHERE clause -- every current caller already has it in scope and
 * already double-checks `target.firm_id === session.firmId` itself, so
 * this was "not exploitable today," but it was the exact unguarded-
 * primitive shape that's decayed 5 times already in this codebase
 * (SEC-1/RETAIN-1/DEMO-4/DEMO-5) the moment a future caller forgets the
 * check. A mismatched firmId now returns null from the query itself,
 * not from an easy-to-omit caller-side comparison. */
export async function getFirmMemberById(db: D1Database, firmId: string, memberId: string): Promise<FirmMemberRow | null> {
  const row = await db
    .prepare(`SELECT * FROM firm_members WHERE id = ?1 AND firm_id = ?2 AND removed_at IS NULL`)
    .bind(memberId, firmId)
    .first<FirmMemberRow>();
  return row ?? null;
}

/** Active (non-removed) members for a firm's own "Team" panel, ordered so a
 * newly-invited member reads naturally at the bottom of the list. */
export async function listFirmMembers(db: D1Database, firmId: string): Promise<FirmMemberRow[]> {
  const { results } = await db
    .prepare(`SELECT * FROM firm_members WHERE firm_id = ?1 AND removed_at IS NULL ORDER BY created_at ASC`)
    .bind(firmId)
    .all<FirmMemberRow>();
  return results;
}

/** How many ACTIVE partners a firm has -- the guard every role-change/
 * removal call site uses to refuse leaving a firm with zero partners (the
 * same "can't lock yourself out" posture the single-admin model has always
 * had implicitly, made explicit now that a firm can have more than one
 * person and one of them could otherwise demote/remove the last one). */
export async function countActivePartners(db: D1Database, firmId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM firm_members WHERE firm_id = ?1 AND role = 'partner' AND removed_at IS NULL`)
    .bind(firmId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** AuditLab MEMBER-1: firmId bound into the WHERE clause, same reasoning
 * as getFirmMemberById() above. */
export async function updateFirmMemberRole(db: D1Database, firmId: string, memberId: string, role: FirmMemberRole): Promise<void> {
  await db.prepare(`UPDATE firm_members SET role = ?1 WHERE id = ?2 AND firm_id = ?3`).bind(role, memberId, firmId).run();
}

/** Soft-delete only -- keeps history for #51's "transfer keeps history"
 * requirement, matching this codebase's existing soft-delete convention
 * (cpe_entries.deleted_at etc.). Callers MUST check countActivePartners()
 * first if this could remove the firm's last partner; this function does
 * not re-check (same "caller validates, store executes" split as
 * setFirmPassword() above). AuditLab MEMBER-1: firmId bound into the WHERE
 * clause, same reasoning as getFirmMemberById() above. */
export async function removeFirmMember(db: D1Database, firmId: string, memberId: string): Promise<void> {
  await db.prepare(`UPDATE firm_members SET removed_at = ?1 WHERE id = ?2 AND firm_id = ?3`).bind(nowIso(), memberId, firmId).run();
}

export async function setFirmMemberEmail(db: D1Database, memberId: string, newEmail: string): Promise<boolean> {
  try {
    await db.prepare(`UPDATE firm_members SET email = ?1 WHERE id = ?2`).bind(newEmail.trim(), memberId).run();
    return true;
  } catch (err) {
    if (err instanceof Error && err.message.includes("idx_firm_members_email_unique")) {
      return false;
    }
    throw err;
  }
}

export async function setFirmMemberPassword(
  db: D1Database,
  memberId: string,
  record: { algo: string; salt: string; iterations: number; rounds: number; hash: string }
): Promise<void> {
  await db
    .prepare(
      `UPDATE firm_members
          SET password_hash = ?1, password_salt = ?2, password_algo = ?3,
              password_iterations = ?4, password_rounds = ?5, password_updated_at = ?6
        WHERE id = ?7`
    )
    .bind(record.hash, record.salt, record.algo, record.iterations, record.rounds, nowIso(), memberId)
    .run();
}

/** Marks a joined_at on first-ever successful login -- mirrors
 * hasAnyFirmSession()'s "first-ever session" signal, but per-member (an
 * invited member's FIRST successful sign-in is when the invite is
 * genuinely accepted, not just issued). No-op if already set. */
export async function markFirmMemberJoined(db: D1Database, memberId: string): Promise<void> {
  await db
    .prepare(`UPDATE firm_members SET joined_at = ?1 WHERE id = ?2 AND joined_at IS NULL`)
    .bind(nowIso(), memberId)
    .run();
}

// ---------------------------------------------------------------------------
// Two-factor authentication (2026-08-07, roadmap #53, migration 0047).
// Encryption/decryption of the secret itself lives in totp.ts (needs the
// TOTP_ENCRYPTION_KEY env secret, which store.ts functions deliberately
// never receive -- same separation password.ts's pepper-taking functions
// vs. store.ts's plain column reads/writes already established). These
// functions only ever handle the already-encrypted blob.
// ---------------------------------------------------------------------------

/** Persists an already-encrypted secret (see totp.ts's encryptTotpSecret())
 * and marks enrollment complete. Called only after the caller has already
 * verified a real code against this exact secret -- this function itself
 * does not verify anything, same "caller validates, store executes" split
 * as setFirmPassword(). `confirmedTimestep` (totp.ts's verifyTotp() return
 * value for the code that just proved enrollment) seeds
 * totp_last_used_timestep immediately -- AuditLab 2FA-1: without this, the
 * exact code that completed enrollment would still be replayable against
 * /firm/2fa/verify for the rest of its validity window. */
export async function setFirmMemberTotpSecret(
  db: D1Database,
  memberId: string,
  encryptedSecret: string,
  iv: string,
  confirmedTimestep: number
): Promise<void> {
  await db
    .prepare(
      `UPDATE firm_members SET totp_secret_encrypted = ?1, totp_secret_iv = ?2, totp_enrolled_at = ?3, totp_last_used_timestep = ?4 WHERE id = ?5`
    )
    .bind(encryptedSecret, iv, nowIso(), confirmedTimestep, memberId)
    .run();
}

/** Disables 2FA -- nulls all four columns. Callers should also delete
 * this member's backup codes (deleteFirmMemberBackupCodes() below); kept
 * as two calls rather than one, matching this codebase's existing
 * "removal is the caller's explicit sequence, not one hidden cascade"
 * posture elsewhere (e.g. hardDeleteExpiredFirms()'s own table-by-table
 * loop). */
export async function clearFirmMemberTotpSecret(db: D1Database, memberId: string): Promise<void> {
  await db
    .prepare(
      `UPDATE firm_members SET totp_secret_encrypted = NULL, totp_secret_iv = NULL, totp_enrolled_at = NULL, totp_last_used_timestep = NULL WHERE id = ?1`
    )
    .bind(memberId)
    .run();
}

/**
 * migration 0048 (AuditLab 2FA-1, MEDIUM, 2026-08-07): records the counter
 * (totp.ts's verifyTotp() return value) that was just accepted for this
 * member -- the RFC 6238 Section 5.2 replay-prevention floor. A caller
 * MUST reject any future code whose matched counter is `<=` this stored
 * value BEFORE calling this function again, or the whole point (the same
 * code cannot be accepted twice) is lost. This function only persists;
 * it does not itself check anything, same "caller validates, store
 * executes" split every other function in this section already uses.
 */
export async function setFirmMemberTotpLastUsedTimestep(db: D1Database, memberId: string, timestep: number): Promise<void> {
  await db.prepare(`UPDATE firm_members SET totp_last_used_timestep = ?1 WHERE id = ?2`).bind(timestep, memberId).run();
}

/** Bulk-inserts a freshly generated set of backup-code HASHES (never the
 * raw codes -- those are shown to the member exactly once, at enrollment,
 * and never stored). Deletes any PRIOR set first -- re-enrolling (or
 * regenerating codes) invalidates the old set outright rather than
 * accumulating across enrollments. */
export async function createFirmMemberBackupCodes(db: D1Database, memberId: string, codeHashes: string[]): Promise<void> {
  await db.prepare(`DELETE FROM firm_member_backup_codes WHERE member_id = ?1`).bind(memberId).run();
  const now = nowIso();
  for (const codeHash of codeHashes) {
    await db
      .prepare(`INSERT INTO firm_member_backup_codes (id, member_id, code_hash, used_at, created_at) VALUES (?1,?2,?3,NULL,?4)`)
      .bind(newToken(), memberId, codeHash, now)
      .run();
  }
}

export async function deleteFirmMemberBackupCodes(db: D1Database, memberId: string): Promise<void> {
  await db.prepare(`DELETE FROM firm_member_backup_codes WHERE member_id = ?1`).bind(memberId).run();
}

/** Redeems ONE unused backup code matching the given hash. Conditional
 * UPDATE (used_at IS NULL), same "two concurrent redemptions cannot both
 * succeed" pattern as verifyAndConsumeLoginToken() -- a backup code is a
 * genuine bearer credential once known, worth the same single-use
 * guarantee. Returns true only if a row was actually consumed. */
export async function consumeFirmMemberBackupCode(db: D1Database, memberId: string, codeHash: string): Promise<boolean> {
  const result = await db
    .prepare(`UPDATE firm_member_backup_codes SET used_at = ?1 WHERE member_id = ?2 AND code_hash = ?3 AND used_at IS NULL`)
    .bind(nowIso(), memberId, codeHash)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function countUnusedFirmMemberBackupCodes(db: D1Database, memberId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM firm_member_backup_codes WHERE member_id = ?1 AND used_at IS NULL`)
    .bind(memberId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

const FIRM_2FA_PENDING_TOKEN_TTL_MINUTES = 5;
const FIRM_2FA_PENDING_MAX_ATTEMPTS = 6;

export interface Firm2faPendingRow {
  id: string;
  member_id: string;
  firm_id: string;
  purpose: string;
  pending_new_email: string | null;
  attempts: number;
  expires_at: string;
  used_at: string | null;
}

/**
 * Mints the "credential proven, TOTP not yet entered" pending token.
 * Carries the ORIGINAL login-token's purpose/pendingNewEmail forward,
 * since that token is already consumed by the time this fires -- see
 * migration 0047's own docstring for why gating happens at the earliest
 * point (right after the original token/password check succeeds, before
 * any purpose-specific side effect) rather than only before
 * createSession().
 */
export async function createFirm2faPendingToken(
  db: D1Database,
  memberId: string,
  firmId: string,
  purpose: string,
  pendingNewEmail: string | null
): Promise<{ rawToken: string }> {
  const rawToken = newToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + FIRM_2FA_PENDING_TOKEN_TTL_MINUTES * 60_000).toISOString();
  await db
    .prepare(
      `INSERT INTO firm_2fa_pending_tokens (id, member_id, firm_id, token_hash, purpose, pending_new_email, attempts, created_at, expires_at, used_at)
       VALUES (?1,?2,?3,?4,?5,?6,0,?7,?8,NULL)`
    )
    .bind(newToken(), memberId, firmId, await hashToken(rawToken), purpose, pendingNewEmail, now.toISOString(), expiresAt)
    .run();
  return { rawToken };
}

/** Looks up a pending token WITHOUT consuming it -- the TOTP-verify step
 * needs to check attempts/expiry BEFORE spending the (comparatively
 * expensive) HMAC work of checking a code, and needs to know the outcome
 * to decide whether to increment attempts or consume outright. Unknown,
 * expired, already-used, and attempts-exhausted are all treated
 * identically by the caller (jsonResponse-level), same no-oracle posture
 * every other token lookup in this file uses -- this function itself just
 * reports the raw state. */
export async function peekFirm2faPendingToken(db: D1Database, rawToken: string): Promise<Firm2faPendingRow | null> {
  const tokenHash = await hashToken(rawToken);
  const row = await db.prepare(`SELECT * FROM firm_2fa_pending_tokens WHERE token_hash = ?1`).bind(tokenHash).first<Firm2faPendingRow>();
  if (!row) return null;
  if (row.used_at) return null;
  if (Date.parse(row.expires_at) <= Date.now()) return null;
  if (row.attempts >= FIRM_2FA_PENDING_MAX_ATTEMPTS) return null;
  return row;
}

/** Records one failed code attempt. Called after a submitted code fails
 * verification -- bounds brute-force guessing independent of the token's
 * own expiry (a long-enough-lived window alone doesn't stop a fast
 * guesser; this hard cap does, per FIRM_2FA_PENDING_MAX_ATTEMPTS above). */
export async function incrementFirm2faPendingAttempts(db: D1Database, id: string): Promise<void> {
  await db.prepare(`UPDATE firm_2fa_pending_tokens SET attempts = attempts + 1 WHERE id = ?1`).bind(id).run();
}

/** Marks a pending token consumed on a SUCCESSFUL code verification.
 * Conditional UPDATE (used_at IS NULL), same "two concurrent redemptions
 * cannot both succeed" pattern as verifyAndConsumeLoginToken(). Returns
 * false if it was already consumed (a race), true otherwise. */
export async function consumeFirm2faPendingToken(db: D1Database, id: string): Promise<boolean> {
  const result = await db
    .prepare(`UPDATE firm_2fa_pending_tokens SET used_at = ?1 WHERE id = ?2 AND used_at IS NULL`)
    .bind(nowIso(), id)
    .run();
  return (result.meta.changes ?? 0) > 0;
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
  // Optional, never required -- see FirmRow.admin_name's own comment.
  adminName?: string | null;
  // Roadmap #56 (2026-08-07): optional so every existing test call site
  // (and any future one that doesn't care) stays byte-identical -- only
  // the REAL signup handler passes validation.ts's TERMS_VERSION. Absent
  // or null means "no record of what version, if any, this firm saw,"
  // which is the honest state for a synthetic/test-created firm.
  tosAcceptedVersion?: string | null;
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
export async function createFirm(db: D1Database, input: CreateFirmInput): Promise<{ id: string; memberId: string }> {
  const id = newToken();
  const name = sanitizeFreeText(input.name, MAX_FIRM_NAME_LEN) ?? "";
  const adminName = sanitizeFreeText(input.adminName ?? null, MAX_ADMIN_NAME_LEN);
  await db
    .prepare(
      `INSERT INTO firms (id, name, admin_email, admin_name, plan_tier, status, created_at, tos_accepted_version)
       VALUES (?1,?2,?3,?4,'free','active',?5,?6)`
    )
    .bind(id, name, input.adminEmail, adminName, nowIso(), input.tosAcceptedVersion ?? null)
    .run();
  // migration 0045 (roadmap #11/#13/#14/#51): every firm now needs a
  // firm_members row from the moment it exists, not just from the next
  // migration's backfill -- this IS the "backfill" for every firm created
  // from here on. Deliberately joined_at = NULL (NOT alreadyJoined) even
  // though this is the founding partner -- hasAnyFirmSession()'s "first
  // login fires the internal signup notification" signal is being ported
  // to member.joined_at (see handleFirmLoginVerify()), and that has to
  // stay NULL until their actual first login or the notification would
  // never fire for a brand-new firm. primary_member_id is set in the SAME
  // call (not a separate UPDATE) so a firm can never exist, even
  // momentarily, without a resolvable primary contact.
  //
  // D1 has no cross-statement transaction here (three separate .run()
  // calls, not a .batch()) -- if the member insert fails (its own
  // idx_firm_members_email_unique conflict: this exact email is already
  // an active member of a DIFFERENT firm, a distinct race from the
  // firms.admin_email one the caller already handles), the firms row
  // above has already committed. Deleted here rather than left as an
  // orphan with no primary_member_id, which every downstream caller
  // assumes is always resolvable.
  let founderMemberId: string;
  try {
    founderMemberId = (
      await createFirmMember(db, { firmId: id, email: input.adminEmail, name: adminName, role: "partner" })
    ).id;
  } catch (err) {
    await db.prepare(`DELETE FROM firms WHERE id = ?1`).bind(id).run();
    throw err;
  }
  await db.prepare(`UPDATE firms SET primary_member_id = ?1 WHERE id = ?2`).bind(founderMemberId, id).run();
  return { id, memberId: founderMemberId };
}

/**
 * Roadmap #51 (2026-08-07, migration 0045): "transfer firm account" --
 * moves firm-level billing/email correspondence to a DIFFERENT existing
 * Partner. The OLD primary keeps their Partner role; this only moves the
 * pointer, it never removes anyone (removal is handleFirmMemberRemove()'s
 * own, separate action, which itself refuses to remove a firm's CURRENT
 * primary contact -- so a transfer is the one way to hand that role off
 * before an old primary can be removed at all). Mirrors firms.admin_email/
 * admin_name to the new primary's own values so every existing billing/
 * Stripe/outbound-email call site that still reads those columns directly
 * keeps working unchanged. Returns false (not a throw) if memberId isn't
 * an active member of this firm -- the caller 404s, same "ownership-scoped,
 * caller decides the status code" convention as deleteSessionByIdForFirm().
 */
export async function setPrimaryMember(db: D1Database, firmId: string, newPrimaryMemberId: string): Promise<boolean> {
  const member = await db
    .prepare(`SELECT email, name FROM firm_members WHERE id = ?1 AND firm_id = ?2 AND removed_at IS NULL`)
    .bind(newPrimaryMemberId, firmId)
    .first<{ email: string; name: string | null }>();
  if (!member) return false;
  await db.prepare(`UPDATE firms SET primary_member_id = ?1, admin_name = ?2 WHERE id = ?3`).bind(newPrimaryMemberId, member.name, firmId).run();
  await updateFirmAdminEmail(db, firmId, member.email);
  return true;
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
 * Task #3 (2026-08-06, Devin's decision: soft-deactivate immediately + a
 * 30-day hard-delete grace period). Two things happen atomically-in-effect
 * (D1 has no multi-statement transactions from the Workers binding, so this
 * is two sequential UPDATEs, not a real transaction -- accepted, since a
 * failure between them just leaves the firm deleted with an active-looking
 * roster for a moment, never the reverse, and the caller in index.ts wraps
 * both in an overall best-effort posture anyway):
 *
 *   1. The firm itself: status -> FIRM_STATUS_DELETED (blocks every future
 *      login/API call immediately -- requireFirmSession() already treats
 *      ANY non-'active' status as denied, so no other code needed to change
 *      for access to actually stop).
 *   2. Every one of its subscriber rows that's still ACTUALLY going to
 *      receive future reminders (confirmed or pending) gets stopped too --
 *      allConfirmedActive() (the reminder cron's own query) has no idea
 *      what a firm's status is, so without this step a "deleted" account's
 *      staff would keep getting emailed forever. Already-inert rows
 *      (opted-out, previously removed, etc.) are left alone -- nothing to
 *      do there.
 *
 * The survey fields are optional and skippable by design (Devin's original
 * task scope) -- both may be null.
 */
export async function requestFirmDeletion(
  db: D1Database,
  firmId: string,
  survey: { reason: string | null; detail: string | null }
): Promise<void> {
  const now = nowIso();
  await db
    .prepare(
      `UPDATE firms SET status = ?1, deletion_requested_at = ?2, deletion_survey_reason = ?3, deletion_survey_detail = ?4 WHERE id = ?5`
    )
    .bind(FIRM_STATUS_DELETED, now, survey.reason, survey.detail, firmId)
    .run();
  await db
    .prepare(
      `UPDATE subscribers SET status = ?1, stopped_at = ?2, stop_reason = ?3
       WHERE firm_id = ?4 AND status IN (?5, ?6)`
    )
    .bind(STATUS_STOPPED, now, STOP_REASON_FIRM_DELETED, firmId, STATUS_CONFIRMED, STATUS_PENDING)
    .run();
}

/** Task #32 (2026-08-06). Durable record of the prorated refund issued on
 * account deletion, alongside the best-effort internal notification email
 * -- real money moving deserves more than "we sent an email" as its only
 * trail. */
export async function recordFirmDeletionRefund(db: D1Database, firmId: string, refundCents: number, refundId: string): Promise<void> {
  await db
    .prepare(`UPDATE firms SET deletion_refund_cents = ?1, deletion_refund_id = ?2 WHERE id = ?3`)
    .bind(refundCents, refundId, firmId)
    .run();
}

/**
 * The other half of Task #3 -- the daily cron sweep (index.ts's own
 * scheduled() handler) that actually erases a firm's data once its 30-day
 * grace period has elapsed. No ON DELETE CASCADE exists on any firm_id
 * REFERENCES in this schema (see migration 0026's own comment for why:
 * D1/SQLite here doesn't enforce or cascade FKs, this codebase never
 * assumed it would), so every firm-scoped table is deleted explicitly,
 * children before the firms row itself. stripe_webhook_events is
 * DELIBERATELY left alone -- it's a raw idempotency/audit log of Stripe
 * events, not the firm's own data, and erasing it could let a
 * late-redelivered webhook for this firm_id be reprocessed as if new.
 *
 * Returns the ids actually deleted, so the caller can log a real count
 * instead of a silent no-op either way.
 */
/**
 * AuditLab RETAIN-1 (MEDIUM, 2026-08-07): every firm-scoped table with a
 * firm_id column MUST be listed here explicitly -- see this function's own
 * comment above for why (no ON DELETE CASCADE in this schema). Migrations
 * 0029/0032/0035/0042/0043 added five firm-scoped tables after this
 * function was last touched and none was added here, silently breaking the
 * "permanently erased" promise the Terms of Service and the delete-account
 * modal both make. scripts/preship_gate.py's check_retention_coverage()
 * asserts every firm_id table in worker/migrations/ appears in this list,
 * so a sixth omission fails the gate instead of decaying quietly like
 * these five did.
 */
export const FIRM_SCOPED_TABLES = [
  "firm_login_tokens",
  "firm_sessions",
  "cpe_entries",
  "firm_oauth_identities",
  "mobility_completions",
  "activity_log",
  "documents",
  "feature_questionnaire_responses",
  "reminder_log",
  "firm_nps_responses",
  "firm_testimonials",
  // migration 0050 (roadmap #9/#319): same "permanently erased" promise --
  // has its own firm_id column, no dependency on firm_members ordering.
  "firm_rule_change_notifications",
  // migration 0047 (roadmap #53): same "permanently erased" promise --
  // has its own firm_id column (unlike firm_member_backup_codes below,
  // which is member-scoped only and needs its own explicit cleanup step
  // in hardDeleteExpiredFirms(), since this loop's WHERE firm_id = ?1
  // can't reach it). Listed BEFORE firm_members: its own rows reference
  // firm_members(id) via member_id, so they must be gone before that
  // table's own DELETE runs, same circular-FK reasoning as
  // primary_member_id's own explicit clear below.
  "firm_2fa_pending_tokens",
  // migration 0045 (roadmap #11/#13/#14/#51): a firm's members are exactly
  // as firm-scoped as every table above -- AuditLab RETAIN-1's own
  // "permanently erased" promise applies here too, and this table's hard
  // gate (check_retention_coverage in preship_gate.py) would have caught
  // this omission at ship time regardless.
  "firm_members",
] as const;

export async function hardDeleteExpiredFirms(db: D1Database, bucket: R2Bucket, asOf: Date, graceDays = 30): Promise<string[]> {
  const cutoff = new Date(asOf.getTime() - graceDays * 86_400_000).toISOString();
  const { results } = await db
    .prepare(`SELECT id FROM firms WHERE status = ?1 AND deletion_requested_at IS NOT NULL AND deletion_requested_at <= ?2`)
    .bind(FIRM_STATUS_DELETED, cutoff)
    .all<{ id: string }>();

  const ids = results.map((r) => r.id);
  for (const firmId of ids) {
    // Delete the R2 objects BEFORE the D1 rows that name them -- if this
    // worker instance dies mid-loop, an orphaned documents row (pointing
    // at an R2 object not yet deleted) is recoverable on the next cron
    // pass; an orphaned R2 object with no row left to find it is not.
    // Queried without a deleted_at filter -- a soft-deleted row's object
    // should already be gone via removeDocument()'s own caller, but this
    // is the LAST chance to catch one that wasn't, and a redundant delete
    // on an already-gone key is a harmless no-op.
    const { results: docs } = await db
      .prepare(`SELECT r2_key FROM documents WHERE firm_id = ?1`)
      .bind(firmId)
      .all<{ r2_key: string }>();
    for (const doc of docs) {
      try {
        await bucket.delete(doc.r2_key);
      } catch {
        // Best-effort: an R2 delete failure must never abort the D1
        // cleanup for this firm (leaving them stuck un-deletable forever
        // is worse than one orphaned object) -- same posture as every
        // other best-effort side-effect in this codebase.
      }
    }
    // migration 0045: firms.primary_member_id is a foreign key INTO
    // firm_members, which is itself firm-scoped and about to be deleted
    // by the loop below (firm_members.firm_id -> firms.id, the other
    // direction) -- a genuine circular reference between the two tables.
    // Cleared here, before either delete, or the firm_members DELETE
    // below fails its FK constraint while firms.primary_member_id still
    // points at the row being removed.
    await db.prepare(`UPDATE firms SET primary_member_id = NULL WHERE id = ?1`).bind(firmId).run();
    // migration 0047 (roadmap #53): firm_member_backup_codes has no firm_id
    // column of its own (only member_id -> firm_members(id)), so it can't go
    // in FIRM_SCOPED_TABLES's flat WHERE firm_id = ?1 loop below -- it's also
    // invisible to preship_gate.py's RETAIN-1 scan for that same reason, so
    // this cleanup is on us to remember, not a gate we can lean on. Deleted
    // here, before the loop's own firm_members DELETE, for the same
    // circular-FK reasoning as primary_member_id above.
    await db
      .prepare(`DELETE FROM firm_member_backup_codes WHERE member_id IN (SELECT id FROM firm_members WHERE firm_id = ?1)`)
      .bind(firmId)
      .run();
    for (const table of FIRM_SCOPED_TABLES) {
      await db.prepare(`DELETE FROM ${table} WHERE firm_id = ?1`).bind(firmId).run();
    }
    await db.prepare(`DELETE FROM subscribers WHERE firm_id = ?1`).bind(firmId).run();
    await db.prepare(`DELETE FROM firms WHERE id = ?1`).bind(firmId).run();
  }
  return ids;
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
 * Task #29 (2026-08-05). Applied only at email-change TOKEN REDEMPTION time
 * (proven control of the new inbox), never at request time. Returns `false`
 * instead of throwing on a UNIQUE-constraint hit (migration 0015) -- the
 * target address can legitimately get claimed by a DIFFERENT firm in the
 * window between when this token was issued and when it's redeemed (e.g. two
 * firms both requesting the same address), and that is a real, expected
 * outcome for the caller to show a clean error for, not a crash.
 *
 * Adversarial-review L1 (2026-08-05): a bare catch-all here would mislabel
 * ANY D1 failure (a transient connectivity blip, a future schema change) as
 * "someone else claimed this email" -- confusing the admin AND burning the
 * single-use token for a failure that had nothing to do with a real
 * conflict. Matches on the specific error text confirmed live against this
 * table's real index (`D1_ERROR: UNIQUE constraint failed: index
 * 'idx_firms_admin_email_unique'...`) and re-throws anything else, so an
 * unrelated failure surfaces as the generic 500 every other route already
 * gets instead of a wrong, misleading "conflict" outcome.
 */
export async function updateFirmAdminEmail(db: D1Database, firmId: string, newEmail: string): Promise<boolean> {
  try {
    await db
      .prepare(`UPDATE firms SET admin_email = ?1 WHERE id = ?2`)
      .bind(newEmail.trim(), firmId)
      .run();
    return true;
  } catch (err) {
    if (err instanceof Error && err.message.includes("idx_firms_admin_email_unique")) {
      return false;
    }
    throw err;
  }
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
export type LoginTokenPurpose = "login" | "password_reset" | "email_change";

export function normalizeLoginTokenPurpose(raw: unknown): LoginTokenPurpose {
  if (raw === "password_reset" || raw === "email_change") return raw;
  return "login";
}

/**
 * `pendingNewEmail` (migration 0022, Task #29) is required for -- and only
 * meaningful for -- purpose "email_change": the specific address that was
 * proven reachable by emailing THIS token to it, applied at redemption and
 * never at the redeeming request's discretion (same "intent lives on the
 * token row" reasoning migration 0013 already established for
 * password_reset). Any other purpose leaves it unset/NULL.
 */
export async function createLoginToken(
  db: D1Database,
  firmId: string,
  purpose: LoginTokenPurpose = "login",
  pendingNewEmail: string | null = null,
  /** migration 0045. OPTIONAL and placed LAST (not inserted earlier in
   * this list) deliberately -- this function has dozens of existing
   * positional call sites across the test suite that pass `purpose`/
   * `pendingNewEmail` positionally (e.g. `createLoginToken(db, id,
   * "password_reset")`); inserting memberId any earlier would have
   * silently reinterpreted a purpose STRING as memberId and silently
   * defaulted purpose back to "login" everywhere -- a real, serious
   * near-miss caught by re-reading every call site before running
   * anything, not by a type error (both params are string-shaped).
   * Resolved to the firm's primary_member_id when omitted, same
   * reasoning as createSession()'s own memberId param. */
  memberId?: string
): Promise<{ rawToken: string }> {
  let resolvedMemberId = memberId;
  if (!resolvedMemberId) {
    const firm = await db.prepare(`SELECT primary_member_id FROM firms WHERE id = ?1`).bind(firmId).first<{
      primary_member_id: string | null;
    }>();
    if (!firm?.primary_member_id) {
      throw new Error(`createLoginToken: firm ${firmId} has no primary_member_id and no memberId was given`);
    }
    resolvedMemberId = firm.primary_member_id;
  }
  const rawToken = newToken();
  const tokenHash = await hashToken(rawToken);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LOGIN_TOKEN_TTL_MINUTES * 60_000).toISOString();
  await db
    .prepare(
      `INSERT INTO firm_login_tokens (id, firm_id, member_id, token_hash, created_at, expires_at, used_at, purpose, pending_new_email)
       VALUES (?1,?2,?3,?4,?5,?6,NULL,?7,?8)`
    )
    .bind(
      newToken(),
      firmId,
      resolvedMemberId,
      tokenHash,
      now.toISOString(),
      expiresAt,
      normalizeLoginTokenPurpose(purpose),
      purpose === "email_change" ? pendingNewEmail : null
    )
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

/** migration 0045: same intent as invalidateOutstandingLoginTokens() above,
 * scoped to ONE member instead of every member of the firm -- a firm can
 * now have more than one person, and invalidating the whole firm's
 * outstanding tokens on ONE member's email change would silently burn a
 * completely unrelated member's pending invite or password-reset link. */
export async function invalidateOutstandingLoginTokensForMember(db: D1Database, memberId: string): Promise<number> {
  const result = await db
    .prepare(`UPDATE firm_login_tokens SET used_at = ?1 WHERE member_id = ?2 AND used_at IS NULL`)
    .bind(nowIso(), memberId)
    .run();
  return result.meta.changes ?? 0;
}

/**
 * Task #29 (2026-08-05). Narrower than invalidateOutstandingLoginTokens() --
 * scoped to purpose = 'email_change' only, so requesting a second email
 * change doesn't also burn an unrelated outstanding login/password-reset
 * link the same firm might have pending. A firm that requests "change to A"
 * and then "change to B" should only ever be able to confirm B; the stale
 * link for A sitting in that old inbox must stop working.
 */
export async function invalidateOutstandingEmailChangeTokens(db: D1Database, firmId: string): Promise<number> {
  const result = await db
    .prepare(`UPDATE firm_login_tokens SET used_at = ?1 WHERE firm_id = ?2 AND purpose = 'email_change' AND used_at IS NULL`)
    .bind(nowIso(), firmId)
    .run();
  return result.meta.changes ?? 0;
}

/** migration 0045: scoped to ONE member instead of the whole firm -- same
 * "don't burn a completely unrelated member's pending request" reasoning
 * as invalidateOutstandingLoginTokensForMember() above. */
export async function invalidateOutstandingEmailChangeTokensForMember(db: D1Database, memberId: string): Promise<number> {
  const result = await db
    .prepare(`UPDATE firm_login_tokens SET used_at = ?1 WHERE member_id = ?2 AND purpose = 'email_change' AND used_at IS NULL`)
    .bind(nowIso(), memberId)
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
): Promise<{ firmId: string; memberId: string; purpose: LoginTokenPurpose; pendingNewEmail: string | null } | null> {
  const tokenHash = await hashToken(rawToken);
  const row = await db
    .prepare(`SELECT * FROM firm_login_tokens WHERE token_hash = ?1`)
    .bind(tokenHash)
    .first<FirmLoginTokenRow>();
  if (!row) return null;
  if (row.used_at) return null;
  if (Date.parse(row.expires_at) <= Date.now()) return null;
  // A pre-0045 token (member_id NULL) can genuinely still be outstanding
  // right at migration time (15-minute TTL) -- treat as invalid rather
  // than crash; it expires on its own within minutes either way.
  if (!row.member_id) return null;
  // Conditional on used_at IS NULL so two concurrent redemptions of one
  // emailed link cannot both succeed (the same shape as the subscriber
  // token; this route previously used an unconditional UPDATE).
  const result = await db
    .prepare(`UPDATE firm_login_tokens SET used_at = ?1 WHERE id = ?2 AND used_at IS NULL`)
    .bind(nowIso(), row.id)
    .run();
  if ((result.meta.changes ?? 0) === 0) return null;
  // The purpose (and, for email_change, the target address) are read from
  // the ROW -- never from anything the redeeming request supplied. See
  // migration 0013 and 0022.
  const purpose = normalizeLoginTokenPurpose(row.purpose);
  return {
    firmId: row.firm_id,
    memberId: row.member_id,
    purpose,
    pendingNewEmail: purpose === "email_change" ? row.pending_new_email ?? null : null,
  };
}

/**
 * Read-only lookup of a login token's purpose AND whether its firm already
 * has a password, for the GET render of /firm/login/verify ONLY (index.ts's
 * actionConfirmPage()) -- never marks the token used. Exists because that
 * page needs to know whether to show the "set a password now" optional
 * field: it's a no-op for a password_reset token (that flow always lands on
 * /set-password/ next) and a no-op for a firm that already has a password
 * (handleFirmLoginVerify() ignores the submitted value either way) --
 * showing the field in either case reads as asking for a password that gets
 * silently discarded (reported directly, 2026-08-03 for the purpose case,
 * VAL-2 2026-08-04 for the already-has-a-password case). Same expired/used-
 * then-treat-as-unknown posture as verifyAndConsumeLoginToken() -- a dead
 * link gets the generic invalid-link error on submit either way, so there is
 * nothing to gain from distinguishing purpose on a token that won't redeem.
 * One joined query, no extra round trip, token still unconsumed.
 */
export async function peekLoginTokenPasswordEligibility(
  db: D1Database,
  rawToken: string
): Promise<{ purpose: LoginTokenPurpose; firmHasPassword: boolean } | null> {
  const tokenHash = await hashToken(rawToken);
  // migration 0045: joined to firm_members (the specific member this token
  // is FOR), not firms -- "does this member already have a password" is
  // the question that actually matters now that more than one person can
  // exist per firm. Field name kept as firmHasPassword (not renamed to
  // memberHasPassword) since every caller of this function still reads it
  // that way; renaming is cosmetic churn with no behavior change.
  const row = await db
    .prepare(
      `SELECT t.used_at, t.expires_at, t.purpose, m.password_hash
       FROM firm_login_tokens t JOIN firm_members m ON m.id = t.member_id
       WHERE t.token_hash = ?1`
    )
    .bind(tokenHash)
    .first<{ used_at: string | null; expires_at: string; purpose: unknown; password_hash: string | null }>();
  if (!row) return null;
  if (row.used_at) return null;
  if (Date.parse(row.expires_at) <= Date.now()) return null;
  return { purpose: normalizeLoginTokenPurpose(row.purpose), firmHasPassword: row.password_hash !== null };
}

/**
 * Generates a raw CSPRNG session token, stores only its hash, and returns
 * the RAW value for the caller to set as the `dr_firm_session` cookie (see
 * index.ts). `expires_at` = now + SESSION_TTL_DAYS.
 */

/**
 * Whether this firm has ever had a session before (2026-08-05, signup
 * notification). Checked BEFORE createSession() inserts the new one, so
 * "true" here means "this login-verify is genuinely the first session this
 * firm has ever had" -- used to fire a one-time internal notification email
 * rather than one on every sign-in. Not race-proof against two truly
 * concurrent first logins (both could read zero before either inserts) --
 * accepted: the cost of a rare duplicate internal notification is far lower
 * than the complexity of locking this, and it is not a security boundary.
 */
/**
 * Task #7 (2026-08-06): operator-managed block, separate from validation.ts's
 * compiled-in DISPOSABLE_EMAIL_DOMAINS/COMPETITOR_EMAIL_DOMAINS (migration
 * 0023's own docstring explains the split). Domain matching reuses the exact
 * same "exact match or real subdomain" semantics as validation.ts's
 * matchesBlockedDomain() -- done in JS after a plain SELECT rather than a SQL
 * LIKE, since a domain containing `%`/`_` (SQL wildcard chars) could
 * otherwise match more than intended. The domain-pattern list is expected to
 * stay small (a curated, manually-managed blocklist), so fetching all of it
 * per check is cheap.
 */
export async function isEmailBlocklisted(db: D1Database, email: string): Promise<boolean> {
  const emailLower = email.toLowerCase();
  const domain = emailLower.slice(emailLower.lastIndexOf("@") + 1);

  const exactHit = await db
    .prepare(`SELECT 1 FROM signup_blocklist WHERE pattern_type = 'email' AND pattern = ?1 LIMIT 1`)
    .bind(emailLower)
    .first();
  if (exactHit) return true;
  if (!domain) return false;

  const { results } = await db
    .prepare(`SELECT pattern FROM signup_blocklist WHERE pattern_type = 'domain'`)
    .all<{ pattern: string }>();
  return (results ?? []).some((r) => domain === r.pattern || domain.endsWith(`.${r.pattern}`));
}

export async function hasAnyFirmSession(db: D1Database, firmId: string): Promise<boolean> {
  const row = await db.prepare(`SELECT 1 FROM firm_sessions WHERE firm_id = ?1 LIMIT 1`).bind(firmId).first();
  return row !== null;
}

export async function createSession(
  db: D1Database,
  firmId: string,
  /** migration 0045. WHICH person this session belongs to -- see
   * firm_members' own docstring. OPTIONAL and resolved to the firm's own
   * primary_member_id when omitted -- this is what keeps every existing
   * caller (production login handlers passed through their own resolved
   * member below, but the many test-suite helpers across this codebase
   * that call `createSession(env.DB, firm.id)` directly, bypassing the
   * real login handlers for setup speed) working unchanged: a freshly
   * createFirm()-ed test firm always has exactly one partner, so
   * resolving "the firm's primary member" is exactly correct for that
   * single-partner case, with zero call-site changes required. */
  memberId?: string,
  /** migration 0014. TRUE only when this session was minted by redeeming a
   * password-RESET token, which proves control of the account's email inbox
   * and is therefore allowed to set a password without knowing the old one.
   * Derived from the token row, never from anything a client sends. */
  passwordResetAuthorized = false
): Promise<{ rawSessionToken: string }> {
  let resolvedMemberId = memberId;
  if (!resolvedMemberId) {
    const firm = await db.prepare(`SELECT primary_member_id FROM firms WHERE id = ?1`).bind(firmId).first<{
      primary_member_id: string | null;
    }>();
    if (!firm?.primary_member_id) {
      throw new Error(`createSession: firm ${firmId} has no primary_member_id and no memberId was given`);
    }
    resolvedMemberId = firm.primary_member_id;
  }
  const rawSessionToken = newToken();
  const sessionTokenHash = await hashToken(rawSessionToken);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_DAYS * 86_400_000).toISOString();
  await db
    .prepare(
      `INSERT INTO firm_sessions (id, firm_id, member_id, session_token_hash, created_at, expires_at, last_seen_at, password_reset_authorized)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`
    )
    .bind(
      newToken(), firmId, resolvedMemberId, sessionTokenHash, now.toISOString(), expiresAt, now.toISOString(),
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
): Promise<
  | { firmId: string; sessionId: string; memberId: string; role: FirmMemberRole; passwordResetAuthorized: boolean; firmStatus: string }
  | null
> {
  const sessionTokenHash = await hashToken(rawSessionToken);
  // JOIN firms so the caller learns the firm's CURRENT status in the same
  // query, not a second round trip -- a suspended firm's session must stop
  // working the moment status changes, not just at its next re-authenticate.
  // (AuditLab F-1, 2026-08-02: `firms.status` was previously enforced on 2
  // of 12+ firm routes; requireFirmSession() is the one gate every one of
  // them already calls, so fixing it here fixes all of them at once.)
  //
  // migration 0045: INNER JOIN firm_members, requiring removed_at IS NULL
  // -- same posture as the firm_status check right above it. A member who
  // was removed from a firm must stop working the moment they're removed,
  // not just at their session's natural 30-day expiry; a plain JOIN (not
  // LEFT JOIN) makes a removed member's lingering session simply not
  // resolve, the same "fail closed" shape firm_status already uses.
  const row = await db
    .prepare(
      `SELECT s.*, f.status AS firm_status, m.role AS member_role
         FROM firm_sessions s
         JOIN firms f ON f.id = s.firm_id
         JOIN firm_members m ON m.id = s.member_id AND m.removed_at IS NULL
        WHERE s.session_token_hash = ?1`
    )
    .bind(sessionTokenHash)
    .first<FirmSessionRow & { firm_status: string; member_role: FirmMemberRole }>();
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
    memberId: row.member_id as string,
    role: row.member_role,
    // Strict truthiness on 1 -- a NULL from a pre-0014 row, or anything
    // unexpected, must read as NOT authorized. The permissive direction is
    // the dangerous one here.
    passwordResetAuthorized: (row as { password_reset_authorized?: unknown }).password_reset_authorized === 1,
    firmStatus: row.firm_status,
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

/** AuditLab MAP-1 (MEDIUM, 2026-08-07): the firm's own roster's distinct
 * home states, for scope-based mobility-check rate limiting -- a query
 * for a state the firm actually has staff in is the firm reviewing its
 * own data, not harvesting. Same "on the roster" definition as
 * listFirmLicenses() above (excludes admin-removed rows) so removing a
 * staffer doesn't retroactively meter a state the firm was legitimately
 * reviewing, per Devin's own spec for this fix. */
export async function getFirmRosterStateSlugs(db: D1Database, firmId: string): Promise<Set<string>> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT state_slug FROM subscribers
       WHERE firm_id = ?1 AND NOT (status = ?2 AND stop_reason = ?3)`
    )
    .bind(firmId, STATUS_STOPPED, STOP_REASON_REMOVED_BY_ADMIN)
    .all<{ state_slug: string }>();
  return new Set(results.map((r) => r.state_slug));
}

export interface ActivityLogRow {
  id: string;
  firm_id: string;
  subscriber_id: string;
  staff_label: string | null;
  email: string;
  event_type: string;
  created_at: string;
}

/** Task #26 (migration 0025). Best-effort by every call site (never allowed
 * to roll back the mutation it's logging) -- see this file's own convention
 * for the transparency emails right next to each call site. */
export async function logActivity(
  db: D1Database,
  input: { firmId: string; subscriberId: string; staffLabel: string | null; email: string; eventType: string }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO activity_log (id, firm_id, subscriber_id, staff_label, email, event_type, created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7)`
    )
    .bind(newToken(), input.firmId, input.subscriberId, input.staffLabel, input.email, input.eventType, nowIso())
    .run();
}

/** Newest-first, capped -- this is a "Recent Activity" panel, not a full
 * audit-export surface. */
export async function listRecentActivity(db: D1Database, firmId: string, limit: number): Promise<ActivityLogRow[]> {
  const { results } = await db
    .prepare(`SELECT * FROM activity_log WHERE firm_id = ?1 ORDER BY created_at DESC LIMIT ?2`)
    .bind(firmId, limit)
    .all<ActivityLogRow>();
  return results;
}

/** Roadmap #8 (2026-08-07): the "dates tracked" half of the audit-trail
 * export -- every roster event, uncapped (unlike listRecentActivity()'s
 * own small-panel cap above), oldest first (a chronological record reads
 * more naturally start-to-end than newest-first for an export). */
export async function listActivityLogForFirm(db: D1Database, firmId: string): Promise<ActivityLogRow[]> {
  const { results } = await db
    .prepare(`SELECT * FROM activity_log WHERE firm_id = ?1 ORDER BY created_at ASC`)
    .bind(firmId)
    .all<ActivityLogRow>();
  return results;
}

// ---------------------------------------------------------------------------
// Reminder-send log (2026-08-07, roadmap #8, migration 0035). The "dates
// reminded" half of the audit-trail export -- see that migration's own
// docstring for why this is a NEW table rather than a reshaping of
// subscribers.reminders_sent (which stays exactly as-is, still the atomic
// claim/dedupe mechanism reminder delivery depends on).
// ---------------------------------------------------------------------------

export interface ReminderLogRow {
  id: string;
  firm_id: string;
  subscriber_id: string;
  threshold_days: number;
  sent_at: string;
}

/** Called ONLY after a real, successful send (scheduler.ts, right where
 * `summary.sent += 1` already fires) -- never on a claimed-but-failed or
 * unclaimed attempt. Best-effort by the caller, same posture as every
 * other non-critical logging call in this codebase: a logging failure
 * must never affect whether the actual reminder delivery counts as sent. */
export async function logReminderSent(db: D1Database, firmId: string, subscriberId: string, thresholdDays: number): Promise<void> {
  await db
    .prepare(`INSERT INTO reminder_log (id, firm_id, subscriber_id, threshold_days, sent_at) VALUES (?1,?2,?3,?4,?5)`)
    .bind(newToken(), firmId, subscriberId, thresholdDays, nowIso())
    .run();
}

export async function listReminderLogForFirm(db: D1Database, firmId: string): Promise<ReminderLogRow[]> {
  const { results } = await db
    .prepare(`SELECT * FROM reminder_log WHERE firm_id = ?1 ORDER BY sent_at ASC`)
    .bind(firmId)
    .all<ReminderLogRow>();
  return results;
}

/**
 * Same "on the roster" definition as listFirmLicenses() (excludes only
 * admin-removed rows), but a COUNT instead of hydrating every row -- for the
 * BILL-1 seat-cap check, which runs on every staff-create request and only
 * needs the number.
 */
export async function countFirmLicenses(db: D1Database, firmId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM subscribers
       WHERE firm_id = ?1 AND NOT (status = ?2 AND stop_reason = ?3)`
    )
    .bind(firmId, STATUS_STOPPED, STOP_REASON_REMOVED_BY_ADMIN)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Stripe billing (2026-08-05, migration 0018).
// ---------------------------------------------------------------------------

/**
 * Flips a firm onto a paid tier and records its Stripe ids -- the ONLY place
 * `firms.plan_tier` is written by the billing path (handleStripeWebhook's
 * `checkout.session.completed` branch is the sole caller). Also used by the
 * `customer.subscription.deleted` branch to revert a firm to `pilot`, so
 * `stripeSubscriptionId` is nullable: a reverted-to-pilot firm keeps its
 * `stripe_customer_id` (so a future checkout reuses the same Customer) but
 * loses the now-cancelled subscription id.
 */
export async function updateFirmBilling(
  db: D1Database,
  firmId: string,
  fields: { planTier: string; stripeCustomerId: string; stripeSubscriptionId: string | null }
): Promise<void> {
  await db
    .prepare(
      `UPDATE firms SET plan_tier = ?1, stripe_customer_id = ?2, stripe_subscription_id = ?3 WHERE id = ?4`
    )
    .bind(fields.planTier, fields.stripeCustomerId, fields.stripeSubscriptionId, firmId)
    .run();
}

/** Self-serve cancel/resume (migration 0021) -- display/UI state only, see
 * that migration's own comment for why this never touches plan_tier. */
export async function updateFirmCancellation(
  db: D1Database,
  firmId: string,
  fields: { cancelAtPeriodEnd: boolean; currentPeriodEnd: string }
): Promise<void> {
  await db
    .prepare(`UPDATE firms SET cancel_at_period_end = ?1, current_period_end = ?2 WHERE id = ?3`)
    .bind(fields.cancelAtPeriodEnd ? 1 : 0, fields.currentPeriodEnd, firmId)
    .run();
}

/**
 * Looked up by `customer.subscription.deleted`/`invoice.payment_failed`
 * webhook branches -- those events carry only the Stripe subscription id,
 * not the original Checkout Session's `metadata.firm_id`, so this is the
 * only way back to the firm row for them.
 */
export async function findFirmByStripeSubscriptionId(
  db: D1Database,
  stripeSubscriptionId: string
): Promise<FirmRow | null> {
  const row = await db
    .prepare(`SELECT * FROM firms WHERE stripe_subscription_id = ?1 LIMIT 1`)
    .bind(stripeSubscriptionId)
    .first<FirmRow>();
  return row ?? null;
}

/**
 * Idempotency guard for /stripe/webhook (migration 0018's
 * `stripe_webhook_events` ledger). Stripe retries any delivery that doesn't
 * get a 2xx, and can redeliver even after a 2xx in rare cases -- this makes
 * a duplicate delivery a harmless no-op instead of double-applying a plan
 * change. Returns true the FIRST time a given Stripe event.id is seen (the
 * caller should process it), false on every subsequent delivery of the same
 * id (caller should skip processing and still return 200). Relies on `id`
 * being the PRIMARY KEY -- same "let a DB unique constraint be the race
 * guard" idiom handleFirmSignup() already uses, so two concurrent
 * deliveries of the same event can't both win.
 */
export async function recordWebhookEventIfNew(
  db: D1Database,
  eventId: string,
  eventType: string,
  firmId: string | null
): Promise<boolean> {
  try {
    await db
      .prepare(`INSERT INTO stripe_webhook_events (id, event_type, firm_id, received_at) VALUES (?1,?2,?3,?4)`)
      .bind(eventId, eventType, firmId, nowIso())
      .run();
    return true;
  } catch {
    // UNIQUE constraint violation on `id` -- already recorded, so already
    // processed (or concurrently being processed). Either way, not new.
    return false;
  }
}

export async function markWebhookEventProcessed(db: D1Database, eventId: string): Promise<void> {
  await db
    .prepare(`UPDATE stripe_webhook_events SET processed_at = ?1 WHERE id = ?2`)
    .bind(nowIso(), eventId)
    .run();
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
  /** migration 0034 (roadmap #7). Self-reported, in cents. index.ts always
   * passes a value here (the new one from the PATCH body, or the record's
   * existing one when the client didn't touch this field) -- true partial-
   * update semantics live at the HTTP layer, same as every other field on
   * this interface despite none of them being optional here. */
  renewalFeeCents: number | null;
  /** migration 0036 (roadmap #10). Self-reported carryover hours. Same
   * always-passed, HTTP-layer-partial-update convention as renewalFeeCents
   * above. */
  carryoverHours: number | null;
  /** migration 0037 (roadmap #16). Office/department tag. Same
   * always-passed, re-sanitized-here-independently convention as
   * staffLabel above. */
  officeTag: string | null;
  /** migration 0041 (roadmap #68). Internal-only note. Same always-passed,
   * re-sanitized-here-independently convention as officeTag above. */
  internalNotes: string | null;
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
  const newOfficeTag = sanitizeFreeText(input.officeTag, MAX_OFFICE_TAG_LEN);
  const newInternalNotes = sanitizeFreeText(input.internalNotes, MAX_INTERNAL_NOTES_LEN);

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

  const lastEditedAt = nowIso();

  await db
    .prepare(
      `UPDATE subscribers
       SET email = ?1, cooldown_key = ?2, staff_label = ?3, state_slug = ?4, deadline_fields = ?5,
           deadline_source = ?6, user_deadline = ?7, status = ?8, confirmed_at = ?9, confirm_token = ?10,
           stopped_at = ?11, stop_reason = ?12, reminders_sent = ?13, last_edited_at = ?14, renewal_fee_cents = ?15,
           carryover_hours = ?16, office_tag = ?17, internal_notes = ?18
       WHERE id = ?19 AND firm_id = ?20`
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
      lastEditedAt,
      input.renewalFeeCents,
      input.carryoverHours,
      newOfficeTag,
      newInternalNotes,
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
    last_edited_at: lastEditedAt,
    renewal_fee_cents: input.renewalFeeCents,
    carryover_hours: input.carryoverHours,
    office_tag: newOfficeTag,
    internal_notes: newInternalNotes,
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
  const renewedAt = nowIso();
  await db
    .prepare(
      `UPDATE subscribers
       SET status = ?1, stopped_at = NULL, stop_reason = NULL, reminders_sent = '[]',
           cycle = cycle + 1, unsubscribe_token = ?2, renewed_token = ?3, renewed_at = ?4,
           snoozed_until = NULL
       WHERE id = ?5`
    )
    .bind(STATUS_CONFIRMED, newUnsubscribeToken, newRenewedToken, renewedAt, row.id)
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
    renewed_at: renewedAt,
    // Roadmap #26: a snooze from the PRIOR cycle must never suppress the
    // NEW cycle's reminders -- see migration 0040's own docstring.
    snoozed_until: null,
  };
}

// AuditLab SNOOZE-1 (LOW, 2026-08-07): "no snooze on the final 1-day
// reminder" was previously enforced ONLY by buildReminderEmail() omitting
// the CTA from that specific email -- but every reminder tier's email
// reuses the SAME renewed_token (see the "shared token" comment on every
// action-link build site), so an OLDER 60/30/14-day email still sitting in
// an inbox has a snooze link that works exactly as well as a fresh one.
// Self-defeat, not a security issue (nothing cross-subscriber): someone
// could click a stale link 2 days before their real deadline and snooze
// 14 days past it. Fixed at the STORAGE layer instead of re-relying on
// which specific email happened to get clicked -- recomputes the
// subscriber's REAL current deadline the same way scheduler.ts does and
// refuses the snooze once they're inside the final-tier window, regardless
// of which email's link was used.
function daysUntilDeadlineForSnoozeCheck(row: SubscriberRow, now: Date): number | null {
  const deadline =
    row.deadline_source === DEADLINE_SOURCE_USER && row.user_deadline
      ? new Date(`${row.user_deadline}T00:00:00Z`)
      : computeSubscriberDeadline(row.state_slug, JSON.parse(row.deadline_fields || "{}"), now);
  if (!deadline) return null;
  const nowDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return Math.round((deadline.getTime() - nowDay.getTime()) / 86_400_000);
}

/** Roadmap #26 (migration 0040). Self-service, fixed-duration snooze via
 * the subscriber's existing renewed_token/unsubscribe_token -- same lookup
 * and eligibility posture as renewAndRearmByToken() above (must be
 * confirmed; a stopped subscription has nothing to snooze). Returns null
 * for an invalid token, an unconfirmed row, a stopped row, or (AuditLab
 * SNOOZE-1) a subscriber already inside the final-reminder window
 * regardless of which email's link was clicked -- the caller (handleSnooze)
 * gives a specific reason for each case since they're genuinely different
 * situations from "bad link." */
export async function snoozeByToken(db: D1Database, token: string, days: number): Promise<SubscriberRow | null> {
  const row = await db
    .prepare(`SELECT * FROM subscribers WHERE unsubscribe_token = ?1 OR renewed_token = ?1`)
    .bind(token)
    .first<SubscriberRow>();
  if (!row) return null;
  if (!row.confirmed_at) return null;
  if (row.status === STATUS_STOPPED) return null;
  const daysRemaining = daysUntilDeadlineForSnoozeCheck(row, new Date());
  if (daysRemaining !== null && daysRemaining <= 1) return null;
  const snoozedUntil = new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  await db.prepare(`UPDATE subscribers SET snoozed_until = ?1 WHERE id = ?2`).bind(snoozedUntil, row.id).run();
  return { ...row, snoozed_until: snoozedUntil };
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
  /** 'staff' (2026-08-05, self-service CPE entry) is the future login the
   * migration 0009 comment already anticipated -- the staffer THIS entry is
   * about, signed in via their own subscriber session, logging their own
   * hours. `enteredByFirmSessionId` is always null on a 'staff' entry (no
   * firm session exists in that flow); kept as a separate field rather than
   * inferring actor type FROM null-ness of the session id, so a future
   * caller can't accidentally mislabel one by leaving a field unset. */
  enteredByActorType: "admin" | "staff";
  /** Roadmap #1/#2 (2026-08-07): optional link to a supporting certificate
   * already uploaded for this same subscriber. The CALLER (handleCpeEntry
   * Create) is responsible for verifying the document actually belongs to
   * both this firm AND this subscriber before passing it in -- this
   * function trusts its input the same way it already trusts firmId/
   * subscriberId's OWN ownership check (the query below) to have been the
   * real gate. */
  certificateDocumentId: string | null;
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
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`
    )
    .bind(
      id,
      input.firmId,
      input.subscriberId,
      input.entryDate,
      input.hours,
      input.category,
      input.description,
      input.certificateDocumentId,
      input.enteredByActorType,
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
    certificate_document_id: input.certificateDocumentId,
    entered_by_actor_type: input.enteredByActorType,
    entered_by_firm_session_id: input.enteredByFirmSessionId,
    created_at: createdAt,
    deleted_at: null,
  };
}

/**
 * The subscriber-self-service counterpart to addCpeEntry() (2026-08-05).
 * Ownership is proven by EMAIL, not firm_id: a signed-in subscriber may log
 * hours only against a subscriber row that (a) matches their own
 * session.emailNormalized and (b) has a firm_id at all -- cpe_entries.firm_id
 * is NOT NULL by schema (migration 0009), so a free individual subscriber
 * (no firm_id) structurally cannot have CPE entries, matching this feature's
 * actual scope (firm staff logging their own hours, not the free tier).
 * Returns null (caller 404s) for a nonexistent id, someone else's row, or a
 * firm-less row -- identically, so a client can't distinguish "not yours"
 * from "doesn't exist" (same anti-enumeration posture as getFirmLicense()).
 */
export async function addCpeEntryForSubscriber(
  db: D1Database,
  emailNormalized: string,
  input: { subscriberId: string; entryDate: string; hours: number; category: CpeCategory; description: string | null }
): Promise<CpeEntryRow | null> {
  const owned = await db
    .prepare(`SELECT firm_id FROM subscribers WHERE id = ?1 AND LOWER(TRIM(email)) = ?2 AND firm_id IS NOT NULL`)
    .bind(input.subscriberId, emailNormalized)
    .first<{ firm_id: string }>();
  if (!owned) return null;

  return addCpeEntry(db, {
    firmId: owned.firm_id,
    subscriberId: input.subscriberId,
    entryDate: input.entryDate,
    hours: input.hours,
    category: input.category,
    description: input.description,
    // Self-service staff CPE entries have no upload UI yet -- attaching a
    // certificate stays an admin-side-only capability for this first pass.
    certificateDocumentId: null,
    enteredByFirmSessionId: null,
    enteredByActorType: "staff",
  });
}

/**
 * Every non-deleted CPE entry across every subscriber row this email owns
 * (2026-08-05) -- the self-service counterpart to listCpeEntriesForFirm().
 * Scoped by email through a subquery against `subscribers` (mirroring
 * listSubscriberLicenses()'s own email-match condition) rather than
 * requiring the caller to already know their subscriber_id(s), since a
 * signed-in subscriber's session only carries their email.
 */
export async function listCpeEntriesForSubscriberEmail(db: D1Database, emailNormalized: string): Promise<CpeEntryRow[]> {
  const { results } = await db
    .prepare(
      `SELECT ce.* FROM cpe_entries ce
        JOIN subscribers s ON s.id = ce.subscriber_id
       WHERE LOWER(TRIM(s.email)) = ?1 AND ce.deleted_at IS NULL
       ORDER BY ce.entry_date DESC`
    )
    .bind(emailNormalized)
    .all<CpeEntryRow>();
  return results ?? [];
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
// Document storage (2026-08-07, roadmap #1/#2, migration 0032). D1 holds
// only metadata; the R2 bucket (env.DOCUMENTS, see env.ts) holds the actual
// file bytes, keyed by r2_key. Same one-to-many-per-subscriber shape and
// firm_id-bound-in-every-query convention as cpe_entries just above.
// ---------------------------------------------------------------------------

export type DocumentKind = "license" | "cpe";
export const DOCUMENT_KINDS: DocumentKind[] = ["license", "cpe"];

// Deliberately narrow -- these are the only content types a real scanned/
// photographed certificate needs, and every entry here is something a
// browser can safely display as a plain download (never inline-rendered as
// HTML/script, see handleDocumentDownload's own Content-Disposition +
// X-Content-Type-Options headers for the second half of that guarantee).
export const DOCUMENT_ALLOWED_CONTENT_TYPES = ["application/pdf", "image/jpeg", "image/png"];

// 2MB -- comfortable headroom over a typical compressed scan/photo of a
// one-page certificate, well under D1's unrelated 2,000,000-byte column-
// value ceiling (moot here anyway, since the bytes never touch D1).
export const DOCUMENT_MAX_FILE_BYTES = 2 * 1024 * 1024;

// 50MB per firm -- generous for a free-tier feature at this product's
// actual scale (a firm with 25 staff, a handful of documents each, is
// nowhere close), while still being a real, enforced ceiling rather than
// no cap at all.
export const DOCUMENT_MAX_FIRM_TOTAL_BYTES = 50 * 1024 * 1024;

export interface DocumentRow {
  id: string;
  firm_id: string;
  subscriber_id: string;
  kind: DocumentKind;
  r2_key: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  uploaded_at: string;
  deleted_at: string | null;
}

/** Sum of size_bytes across every non-deleted document a firm has -- the
 * per-firm storage quota check reads this BEFORE an upload is accepted. */
export async function sumFirmDocumentBytes(db: D1Database, firmId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COALESCE(SUM(size_bytes), 0) as total FROM documents WHERE firm_id = ?1 AND deleted_at IS NULL`)
    .bind(firmId)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

/** Ownership-checks the subscriber belongs to firmId before inserting --
 * same guard addCpeEntry() already uses. Returns null (never throws) on a
 * failed ownership check so the caller can return a clean 404, matching
 * addCpeEntry()'s own contract. Does NOT enforce the size/quota caps itself
 * -- those are checked by the caller (handleDocumentUpload) before this is
 * ever called, using the SAME size_bytes value passed in here. */
export async function createDocument(
  db: D1Database,
  input: {
    firmId: string;
    subscriberId: string;
    kind: DocumentKind;
    r2Key: string;
    filename: string;
    contentType: string;
    sizeBytes: number;
  }
): Promise<DocumentRow | null> {
  const owns = await db
    .prepare(`SELECT id FROM subscribers WHERE id = ?1 AND firm_id = ?2`)
    .bind(input.subscriberId, input.firmId)
    .first<{ id: string }>();
  if (!owns) return null;

  const id = newToken();
  const uploadedAt = nowIso();
  await db
    .prepare(
      `INSERT INTO documents (id, firm_id, subscriber_id, kind, r2_key, filename, content_type, size_bytes, uploaded_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`
    )
    .bind(id, input.firmId, input.subscriberId, input.kind, input.r2Key, input.filename, input.contentType, input.sizeBytes, uploadedAt)
    .run();

  return {
    id,
    firm_id: input.firmId,
    subscriber_id: input.subscriberId,
    kind: input.kind,
    r2_key: input.r2Key,
    filename: input.filename,
    content_type: input.contentType,
    size_bytes: input.sizeBytes,
    uploaded_at: uploadedAt,
    deleted_at: null,
  };
}

export async function listDocumentsForSubscriber(db: D1Database, firmId: string, subscriberId: string): Promise<DocumentRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM documents WHERE firm_id = ?1 AND subscriber_id = ?2 AND deleted_at IS NULL ORDER BY uploaded_at DESC`
    )
    .bind(firmId, subscriberId)
    .all<DocumentRow>();
  return results;
}

/** firm_id-bound -- a document id alone is never enough to read it, same
 * defense-in-depth every other per-firm lookup in this file already uses.
 * Returns the full row (including r2_key) so the caller can fetch/delete
 * the matching R2 object without a second query. */
export async function getDocumentForFirm(db: D1Database, firmId: string, id: string): Promise<DocumentRow | null> {
  return db
    .prepare(`SELECT * FROM documents WHERE id = ?1 AND firm_id = ?2 AND deleted_at IS NULL`)
    .bind(id, firmId)
    .first<DocumentRow>();
}

/** Soft-delete only (deleted_at), same convention as removeCpeEntry() --
 * the caller is responsible for ALSO deleting the R2 object (this function
 * only returns the row so the caller has r2_key to do that with; it does
 * not touch R2 itself, keeping this file's own dependency surface D1-only
 * like every other function here). */
export async function removeDocument(db: D1Database, firmId: string, id: string): Promise<DocumentRow | null> {
  const row = await getDocumentForFirm(db, firmId, id);
  if (!row) return null;
  await db
    .prepare(`UPDATE documents SET deleted_at = ?1 WHERE id = ?2 AND firm_id = ?3 AND deleted_at IS NULL`)
    .bind(nowIso(), id, firmId)
    .run();
  return row;
}

// ---------------------------------------------------------------------------
// Practice-privilege completion tracking (2026-08-04, migration 0016). See
// that migration's own comment for the full rationale -- this records ONLY
// that a firm marked a person/state/service-type combination complete and
// against what rule version, never a claim that the underlying legal work
// was actually done correctly. The Map/Practice-Privilege-Check UI is what
// decides how to render that (a visually distinct "self-reported" state,
// deliberately never painted the same as the engine's own independently-
// verified "Clear" -- Devin's own call, asked directly).
// ---------------------------------------------------------------------------

export interface MobilityCompletionRow {
  id: string;
  firm_id: string;
  subscriber_id: string;
  target_state_slug: string;
  service_type: string;
  rule_verified_date: string | null;
  completed_at: string;
  completed_by_firm_session_id: string | null;
  deleted_at: string | null;
}

export interface AddMobilityCompletionInput {
  firmId: string;
  subscriberId: string;
  targetStateSlug: string;
  serviceType: string;
  ruleVerifiedDate: string | null;
  completedByFirmSessionId: string | null;
}

/**
 * Marks (subscriber, target state, service type) complete. Upserts against
 * whatever non-deleted row already exists for that exact key rather than
 * inserting a duplicate -- re-marking something (e.g. after the underlying
 * rule changed and rule_verified_date moved) refreshes the same record
 * instead of accumulating stale ones. Same "confirm subscriber_id actually
 * belongs to firmId before writing" discipline addCpeEntry() uses, so a
 * crafted subscriber_id belonging to a different firm can never get a
 * completion attached to it.
 */
export async function addMobilityCompletion(
  db: D1Database,
  input: AddMobilityCompletionInput
): Promise<MobilityCompletionRow | null> {
  const owns = await db
    .prepare(`SELECT id FROM subscribers WHERE id = ?1 AND firm_id = ?2`)
    .bind(input.subscriberId, input.firmId)
    .first<{ id: string }>();
  if (!owns) return null;

  const existing = await db
    .prepare(
      `SELECT id FROM mobility_completions
       WHERE firm_id = ?1 AND subscriber_id = ?2 AND target_state_slug = ?3 AND service_type = ?4
         AND deleted_at IS NULL`
    )
    .bind(input.firmId, input.subscriberId, input.targetStateSlug, input.serviceType)
    .first<{ id: string }>();

  const completedAt = nowIso();
  const id = existing?.id ?? newToken();

  if (existing) {
    await db
      .prepare(
        `UPDATE mobility_completions
         SET rule_verified_date = ?1, completed_at = ?2, completed_by_firm_session_id = ?3
         WHERE id = ?4 AND firm_id = ?5`
      )
      .bind(input.ruleVerifiedDate, completedAt, input.completedByFirmSessionId, id, input.firmId)
      .run();
  } else {
    await db
      .prepare(
        `INSERT INTO mobility_completions
         (id, firm_id, subscriber_id, target_state_slug, service_type, rule_verified_date,
          completed_at, completed_by_firm_session_id)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`
      )
      .bind(
        id,
        input.firmId,
        input.subscriberId,
        input.targetStateSlug,
        input.serviceType,
        input.ruleVerifiedDate,
        completedAt,
        input.completedByFirmSessionId
      )
      .run();
  }

  return {
    id,
    firm_id: input.firmId,
    subscriber_id: input.subscriberId,
    target_state_slug: input.targetStateSlug,
    service_type: input.serviceType,
    rule_verified_date: input.ruleVerifiedDate,
    completed_at: completedAt,
    completed_by_firm_session_id: input.completedByFirmSessionId,
    deleted_at: null,
  };
}

/** Every non-deleted completion across the whole firm's roster -- the Map
 * view cross-references this list against each live mobility verdict,
 * same "fetch the whole firm's rows once, filter/join client-side" pattern
 * listCpeEntriesForFirm()/listFirmLicenses() already established. */
export async function listMobilityCompletionsForFirm(db: D1Database, firmId: string): Promise<MobilityCompletionRow[]> {
  const { results } = await db
    .prepare(`SELECT * FROM mobility_completions WHERE firm_id = ?1 AND deleted_at IS NULL ORDER BY completed_at DESC`)
    .bind(firmId)
    .all<MobilityCompletionRow>();
  return results;
}

/** Soft-delete only, firm_id-bound in the UPDATE's own WHERE clause -- same
 * reasoning and same defense-in-depth as removeCpeEntry(). */
export async function removeMobilityCompletion(db: D1Database, firmId: string, id: string): Promise<boolean> {
  const result = await db
    .prepare(`UPDATE mobility_completions SET deleted_at = ?1 WHERE id = ?2 AND firm_id = ?3 AND deleted_at IS NULL`)
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
/** migration 0045: production code no longer reads firms.password_hash for
 * LOGIN purposes (every real login handler checks the signed-in/resolved
 * MEMBER's own password now -- see setFirmMemberPassword()) -- this
 * write is kept only so the column stays a truthful "does this firm have
 * a password at all" snapshot for any remaining incidental reader, and so
 * every existing test-suite call site (there are several, all setting up
 * a single-partner test firm's password the pre-0045 way) keeps working
 * unchanged: also resolves and writes the firm's PRIMARY member's own
 * password_* columns in the same call, which is what actually gets
 * checked at login now. Direct callers that already know the specific
 * memberId should prefer setFirmMemberPassword() instead. */
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
  const firm = await db.prepare(`SELECT primary_member_id FROM firms WHERE id = ?1`).bind(firmId).first<{
    primary_member_id: string | null;
  }>();
  if (firm?.primary_member_id) {
    await setFirmMemberPassword(db, firm.primary_member_id, record);
  }
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

/** migration 0045: scoped to ONE member instead of the whole firm -- a
 * firm can now have more than one person, and a password change is a
 * per-PERSON credential rotation. Ending every OTHER member's sessions
 * too (the firm-wide version above) would sign out people who did
 * nothing wrong and whose own credential was never touched. Used by
 * handleFirmPasswordSet(); deleteOtherSessionsForFirm() stays in use for
 * genuinely firm-wide actions (account deletion, suspension). */
export async function deleteOtherSessionsForMember(
  db: D1Database,
  memberId: string,
  keepSessionId: string
): Promise<number> {
  const result = await db
    .prepare(`DELETE FROM firm_sessions WHERE member_id = ?1 AND id != ?2`)
    .bind(memberId, keepSessionId)
    .run();
  return result.meta.changes ?? 0;
}

/** Task #3 (2026-08-06): account deletion ends EVERY session, including the
 * caller's own -- unlike deleteOtherSessionsForFirm() above, there's no
 * session worth preserving once the account itself is gone. */
export async function deleteAllSessionsForFirm(db: D1Database, firmId: string): Promise<number> {
  const result = await db.prepare(`DELETE FROM firm_sessions WHERE firm_id = ?1`).bind(firmId).run();
  return result.meta.changes ?? 0;
}

/** migration 0045: member-scoped counterpart to deleteAllSessionsForFirm()
 * above -- removing ONE member from a firm must end only THEIR sessions,
 * not every other member's (used by handleFirmMemberRemove()). */
export async function deleteAllSessionsForMember(db: D1Database, memberId: string): Promise<number> {
  const result = await db.prepare(`DELETE FROM firm_sessions WHERE member_id = ?1`).bind(memberId).run();
  return result.meta.changes ?? 0;
}

/**
 * Roadmap #66 (2026-08-07): "what changed since your last login" banner.
 * Reuses firm_sessions (no new column/migration needed) -- the most recent
 * OTHER session's created_at IS the previous login, by definition. Excludes
 * currentSessionId explicitly rather than assuming "most recent row" is the
 * current one, since a firm can have several concurrent sessions and the
 * one making this request isn't necessarily the newest of them. Returns
 * null for a firm's very first-ever session (nothing to compare against).
 */
export async function getPreviousLoginAt(db: D1Database, firmId: string, currentSessionId: string): Promise<string | null> {
  const row = await db
    .prepare(`SELECT created_at FROM firm_sessions WHERE firm_id = ?1 AND id != ?2 ORDER BY created_at DESC LIMIT 1`)
    .bind(firmId, currentSessionId)
    .first<{ created_at: string }>();
  return row?.created_at ?? null;
}

/** Subset of FirmSessionRow (above) returned to the client -- deliberately
 * excludes session_token_hash/password_reset_authorized. */
export interface FirmSessionListRow {
  id: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
}

/** Roadmap #52: self-service session listing. firm_sessions never captured
 * user-agent/IP (see migration 0008's own comment -- only timestamps), so
 * this can only show WHEN each session was created/last used, not device or
 * location -- an honest scope limit, not an oversight. */
export async function listSessionsForFirm(db: D1Database, firmId: string): Promise<FirmSessionListRow[]> {
  const result = await db
    .prepare(`SELECT id, created_at, last_seen_at, expires_at FROM firm_sessions WHERE firm_id = ?1 ORDER BY last_seen_at DESC`)
    .bind(firmId)
    .all<FirmSessionListRow>();
  return result.results ?? [];
}

/** migration 0045: a member's OWN sessions only -- the Account tab's
 * "where you're signed in" list is deliberately scoped per-person, not
 * firm-wide. A firm can now have more than one person, and showing a
 * Staff member (or anyone) every OTHER member's login activity/devices
 * would be a real, unrequested privacy exposure -- "you can always see
 * and manage your own sessions" is the baseline this ships instead,
 * regardless of role. listSessionsForFirm() above stays available for a
 * genuinely firm-wide security-audit view if that's ever built as its
 * own explicit, separately-considered feature -- not implied by this one. */
export async function listSessionsForMember(db: D1Database, memberId: string): Promise<FirmSessionListRow[]> {
  const result = await db
    .prepare(`SELECT id, created_at, last_seen_at, expires_at FROM firm_sessions WHERE member_id = ?1 ORDER BY last_seen_at DESC`)
    .bind(memberId)
    .all<FirmSessionListRow>();
  return result.results ?? [];
}

/** Ownership-scoped: only ever deletes a row that belongs to firmId, same
 * pattern as deleteOtherSessionsForFirm() above. Returns false if the id
 * didn't exist or belonged to a different firm, so the handler can 404. */
export async function deleteSessionByIdForFirm(db: D1Database, firmId: string, sessionId: string): Promise<boolean> {
  const result = await db
    .prepare(`DELETE FROM firm_sessions WHERE firm_id = ?1 AND id = ?2`)
    .bind(firmId, sessionId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** migration 0045: member-scoped counterpart to deleteSessionByIdForFirm()
 * above, same reasoning as listSessionsForMember(). */
export async function deleteSessionByIdForMember(db: D1Database, memberId: string, sessionId: string): Promise<boolean> {
  const result = await db
    .prepare(`DELETE FROM firm_sessions WHERE member_id = ?1 AND id = ?2`)
    .bind(memberId, sessionId)
    .run();
  return (result.meta.changes ?? 0) > 0;
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

/**
 * Roadmap #12 (2026-08-07). Same "carry INTENT on the token row" pattern
 * migrations 0013/0022 established for firm_login_tokens (see those
 * migrations' own docstrings) -- mirrored here for the subscriber-side
 * self-service email change. 'login' is the safe default: any caller that
 * forgets the argument, or any pre-migration row, degrades to the
 * ordinary sign-in, never the privileged branch.
 */
export type SubscriberLoginTokenPurpose = "login" | "email_change";

export function normalizeSubscriberLoginTokenPurpose(raw: unknown): SubscriberLoginTokenPurpose {
  if (raw === "email_change") return raw;
  return "login";
}

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
  email: string,
  purpose: SubscriberLoginTokenPurpose = "login",
  /** Roadmap #12: required for -- and only meaningful for -- purpose
   * "email_change". The specific new address that was proven reachable by
   * emailing THIS token to it, applied at redemption and never at the
   * redeeming request's discretion -- same "intent lives on the token"
   * rule migration 0022 already established for firm_login_tokens. */
  pendingNewEmail: string | null = null
): Promise<{ rawToken: string }> {
  const rawToken = newToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SUBSCRIBER_LOGIN_TOKEN_TTL_MINUTES * 60_000).toISOString();
  await db
    .prepare(
      `INSERT INTO subscriber_login_tokens (id, email_normalized, token_hash, created_at, expires_at, used_at, purpose, pending_new_email)
       VALUES (?1,?2,?3,?4,?5,NULL,?6,?7)`
    )
    .bind(
      newToken(),
      normalizeEmail(email),
      await hashToken(rawToken),
      now.toISOString(),
      expiresAt,
      normalizeSubscriberLoginTokenPurpose(purpose),
      purpose === "email_change" ? pendingNewEmail : null
    )
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
): Promise<{ emailNormalized: string; purpose: SubscriberLoginTokenPurpose; pendingNewEmail: string | null } | null> {
  const tokenHash = await hashToken(rawToken);
  const row = await db
    .prepare(`SELECT * FROM subscriber_login_tokens WHERE token_hash = ?1`)
    .bind(tokenHash)
    .first<{
      id: string;
      email_normalized: string;
      expires_at: string;
      used_at: string | null;
      purpose: string | null;
      pending_new_email: string | null;
    }>();
  if (!row) return null;
  if (row.used_at) return null;
  if (Date.parse(row.expires_at) <= Date.now()) return null;

  const result = await db
    .prepare(`UPDATE subscriber_login_tokens SET used_at = ?1 WHERE id = ?2 AND used_at IS NULL`)
    .bind(nowIso(), row.id)
    .run();
  if ((result.meta.changes ?? 0) === 0) return null;

  // Purpose (and, for email_change, the target address) are read from the
  // ROW -- never from anything the redeeming request supplied. Same rule
  // as verifyAndConsumeLoginToken()'s own comment.
  const purpose = normalizeSubscriberLoginTokenPurpose(row.purpose);
  return {
    emailNormalized: row.email_normalized,
    purpose,
    pendingNewEmail: purpose === "email_change" ? row.pending_new_email ?? null : null,
  };
}

/** Roadmap #12: invalidates every UNUSED email_change token for this
 * subscriber -- same reasoning as invalidateOutstandingEmailChangeTokensForMember()
 * for firm members: requesting a second email change must not leave a
 * stale link for the FIRST requested address still live. Scoped to
 * purpose = 'email_change' only, so an outstanding plain login link isn't
 * silently burned by requesting an email change. */
export async function invalidateOutstandingSubscriberEmailChangeTokens(db: D1Database, emailNormalized: string): Promise<number> {
  const result = await db
    .prepare(`UPDATE subscriber_login_tokens SET used_at = ?1 WHERE email_normalized = ?2 AND purpose = 'email_change' AND used_at IS NULL`)
    .bind(nowIso(), emailNormalized)
    .run();
  return result.meta.changes ?? 0;
}

/** Roadmap #12: does ANY subscribers row already use this email --
 * the conflict check a self-service email change needs, same "does an
 * account already exist for this address" role findFirmMemberByEmail()
 * plays for handleFirmChangeEmailRequest(). ASCII-only comparison, same
 * caveat as listSubscriberLicenses()'s own docstring: every write path
 * into subscribers.email is gated by isValidEmail() today, so LOWER()'s
 * ASCII-only behavior cannot diverge from normalizeEmail()'s full-Unicode
 * one -- if that validation is ever relaxed, this comparison needs to
 * change with it. */
export async function hasAnySubscriberRowForEmail(db: D1Database, email: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 FROM subscribers WHERE LOWER(TRIM(email)) = LOWER(TRIM(?1)) LIMIT 1`)
    .bind(email)
    .first();
  return row !== null;
}

/** Roadmap #12: applies a self-service email change across EVERY
 * subscribers row belonging to this person (their free-tier row and every
 * firm-tracked row alike -- identity is the shared email, not a single
 * account row, per migration 0012's own docstring). The caller must
 * already have confirmed via hasAnySubscriberRowForEmail() that the new
 * address isn't already someone else's before calling this -- this
 * function does not re-check, same "caller validates, store executes"
 * split as setFirmPassword(). */
export async function setSubscriberEmail(db: D1Database, oldEmailNormalized: string, newEmail: string): Promise<number> {
  const result = await db
    .prepare(`UPDATE subscribers SET email = ?1 WHERE LOWER(TRIM(email)) = ?2`)
    .bind(newEmail.trim(), oldEmailNormalized)
    .run();
  return result.meta.changes ?? 0;
}

/** Roadmap #12: the subscriber's own self-edited name, across every row
 * sharing their email -- same "identity is the email, not a row" reach as
 * setSubscriberEmail() above. Distinct from staff_label (the FIRM's own
 * organizational tag for a tracked row, e.g. "Jane D. -- Audit team"),
 * which this never touches -- first_name has always been the
 * subscriber-supplied, cosmetic-only field (migration 0001's own
 * comment), exactly the right one for self-edit. */
export async function setSubscriberFirstName(db: D1Database, emailNormalized: string, firstName: string | null): Promise<number> {
  const result = await db
    .prepare(`UPDATE subscribers SET first_name = ?1 WHERE LOWER(TRIM(email)) = ?2`)
    .bind(firstName, emailNormalized)
    .run();
  return result.meta.changes ?? 0;
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

// ---------------------------------------------------------------------------
// Feature requests: post-signup questionnaire (private, per-firm) + the
// public /roadmap/ voting page (Task #19, 2026-08-06, migration 0029). See
// that migration's own docstring for the full design reasoning.
// ---------------------------------------------------------------------------

export type FeatureIdeaStatus = "open" | "in_progress" | "shipped";
const FEATURE_IDEA_STATUSES: ReadonlySet<string> = new Set(["open", "in_progress", "shipped"]);

export interface FeatureIdeaRow {
  id: string;
  title: string;
  description: string | null;
  status: string;
  active: number;
  created_at: string;
}

export interface FeatureIdeaWithVotes extends FeatureIdeaRow {
  vote_count: number;
  voted_by_me: boolean;
}

/**
 * voterId is the caller's own anonymous cookie value (empty string if this
 * browser has never voted) -- passed straight into a LEFT JOIN's ON clause
 * rather than a second query per idea, so "did I already vote for this
 * one" comes back in the same round trip as the public counts.
 */
export async function listActiveFeatureIdeasWithVotes(db: D1Database, voterId: string): Promise<FeatureIdeaWithVotes[]> {
  const { results } = await db
    .prepare(
      `SELECT fi.*,
              COUNT(v.id) AS vote_count,
              MAX(CASE WHEN v.voter_id = ?1 THEN 1 ELSE 0 END) AS voted_by_me
         FROM feature_ideas fi
         LEFT JOIN feature_idea_votes v ON v.idea_id = fi.id
        WHERE fi.active = 1
        GROUP BY fi.id
        ORDER BY vote_count DESC, fi.created_at ASC`
    )
    .bind(voterId)
    .all<FeatureIdeaRow & { vote_count: number; voted_by_me: number }>();
  return (results ?? []).map((r) => ({ ...r, voted_by_me: r.voted_by_me === 1 }));
}

/**
 * Idempotent by design (UNIQUE(idea_id, voter_id), migration 0029) -- a
 * retried or double-fired click can never double-count. Returns whether
 * this call is what actually recorded the vote (false for an already-
 * voted repeat), purely for the caller's own response shape, not a
 * meaningful security signal on its own.
 */
export async function recordFeatureIdeaVote(db: D1Database, ideaId: string, voterId: string): Promise<boolean> {
  const result = await db
    .prepare(`INSERT OR IGNORE INTO feature_idea_votes (id, idea_id, voter_id, created_at) VALUES (?1,?2,?3,?4)`)
    .bind(newToken(), ideaId, voterId, nowIso())
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function ideaExists(db: D1Database, ideaId: string): Promise<boolean> {
  const row = await db.prepare(`SELECT 1 FROM feature_ideas WHERE id = ?1 AND active = 1`).bind(ideaId).first();
  return row !== null;
}

/**
 * Queues (or re-queues) a "notify me when this ships" signup -- NOT yet
 * confirmed. UNIQUE(idea_id, email) means a repeat request for the same
 * pair just rotates the token/timestamp rather than creating a duplicate
 * row, so a lost confirmation email can always be re-requested. Returns
 * null if this email/domain is already confirmed for this idea (nothing
 * to re-send, avoids burning a send on a no-op).
 */
export async function createFeatureIdeaNotifySignup(
  db: D1Database,
  ideaId: string,
  email: string
): Promise<{ rawToken: string } | null> {
  const normalized = normalizeEmail(email);
  const existing = await db
    .prepare(`SELECT confirmed_at FROM feature_idea_notify_signups WHERE idea_id = ?1 AND email = ?2`)
    .bind(ideaId, normalized)
    .first<{ confirmed_at: string | null }>();
  if (existing && existing.confirmed_at) return null;

  const rawToken = newToken();
  const tokenHash = await hashToken(rawToken);
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO feature_idea_notify_signups (id, idea_id, email, confirm_token, confirmed_at, notified_at, created_at)
       VALUES (?1,?2,?3,?4,NULL,NULL,?5)
       ON CONFLICT(idea_id, email) DO UPDATE SET confirm_token = excluded.confirm_token, created_at = excluded.created_at`
    )
    .bind(newToken(), ideaId, normalized, tokenHash, now)
    .run();
  return { rawToken };
}

/**
 * Same no-oracle posture as verifyAndConsumeSubscriberLoginToken() --
 * unknown, already-confirmed, and never-issued are indistinguishable to
 * the caller. confirm_token is cleared on success (not the row itself),
 * so notify-on-ship still has a live email address to send to later.
 */
export async function confirmFeatureIdeaNotifySignup(db: D1Database, rawToken: string): Promise<boolean> {
  const tokenHash = await hashToken(rawToken);
  const row = await db
    .prepare(`SELECT id FROM feature_idea_notify_signups WHERE confirm_token = ?1 AND confirmed_at IS NULL`)
    .bind(tokenHash)
    .first<{ id: string }>();
  if (!row) return false;
  const result = await db
    .prepare(`UPDATE feature_idea_notify_signups SET confirmed_at = ?1, confirm_token = NULL WHERE id = ?2 AND confirmed_at IS NULL`)
    .bind(nowIso(), row.id)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function submitFeatureQuestionnaire(
  db: D1Database,
  firmId: string,
  selectedFeatures: string[],
  otherText: string | null
): Promise<void> {
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO feature_questionnaire_responses (id, firm_id, selected_features, other_text, created_at)
       VALUES (?1,?2,?3,?4,?5)`
    )
    .bind(newToken(), firmId, JSON.stringify(selectedFeatures), otherText, now)
    .run();
  await db.prepare(`UPDATE firms SET feature_questionnaire_dismissed_at = ?1 WHERE id = ?2`).bind(now, firmId).run();
}

/**
 * Ops-only, no HTTP route (2026-08-06, Devin: "update it when starting a
 * new task") -- same "human judgment call, driven by whoever's operating
 * the fleet" reasoning as listConfirmedUnnotifiedSignupsForIdea() just
 * below. Call this the moment real work on an idea actually starts
 * (in_progress) and again the moment it ships -- not automatic, and not
 * gated on anything voting-related.
 */
export async function setFeatureIdeaStatus(db: D1Database, ideaId: string, status: FeatureIdeaStatus): Promise<boolean> {
  if (!FEATURE_IDEA_STATUSES.has(status)) return false;
  const result = await db.prepare(`UPDATE feature_ideas SET status = ?1 WHERE id = ?2`).bind(status, ideaId).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function dismissFeatureQuestionnaire(db: D1Database, firmId: string): Promise<void> {
  await db
    .prepare(`UPDATE firms SET feature_questionnaire_dismissed_at = ?1 WHERE id = ?2 AND feature_questionnaire_dismissed_at IS NULL`)
    .bind(nowIso(), firmId)
    .run();
}

/** Roadmap #28 (migration 0030). Same idempotent-dismiss shape as
 * dismissFeatureQuestionnaire() just above. */
export async function dismissOnboardingChecklist(db: D1Database, firmId: string): Promise<void> {
  await db
    .prepare(`UPDATE firms SET onboarding_checklist_dismissed_at = ?1 WHERE id = ?2 AND onboarding_checklist_dismissed_at IS NULL`)
    .bind(nowIso(), firmId)
    .run();
}

/** Roadmap #30 (migration 0031). Same idempotent-dismiss shape as
 * dismissOnboardingChecklist() just above. Called on "Skip tour" AND on
 * finishing the last step -- both mean "don't auto-show this again",
 * matching how the onboarding checklist's own single dismiss action works. */
export async function dismissProductTour(db: D1Database, firmId: string): Promise<void> {
  await db
    .prepare(`UPDATE firms SET product_tour_dismissed_at = ?1 WHERE id = ?2 AND product_tour_dismissed_at IS NULL`)
    .bind(nowIso(), firmId)
    .run();
}

/** Roadmap #6 (migration 0033). `dueDate` is `null` to clear (stop tracking)
 * or an ISO YYYY-MM-DD string -- validated by the CALLER (index.ts's own
 * strict-ISO-date parser, same one every per-staff deadline field already
 * uses) before this is ever called; this function trusts its input the same
 * way every other single-column setter in this file does. */
export async function setPeerReviewDueDate(db: D1Database, firmId: string, dueDate: string | null): Promise<void> {
  await db.prepare(`UPDATE firms SET peer_review_due_date = ?1 WHERE id = ?2`).bind(dueDate, firmId).run();
}

/** Roadmap #19 (migration 0038). `email` is `null` to clear or an address
 * validated by the CALLER (index.ts's own isValidEmail()) before this is
 * ever called -- same trust-the-caller posture as setPeerReviewDueDate()
 * above. */
export async function setReplyToEmail(db: D1Database, firmId: string, email: string | null): Promise<void> {
  await db.prepare(`UPDATE firms SET reply_to_email = ?1 WHERE id = ?2`).bind(email, firmId).run();
}

/** Roadmap #23 (migration 0039). `thresholdsJson` is `null` to clear (use
 * every default threshold) or an already-validated JSON array string --
 * validated by the CALLER (index.ts's own parseReminderThresholds()) before
 * this is ever called, same trust-the-caller posture as the setters above. */
export async function setReminderThresholds(db: D1Database, firmId: string, thresholdsJson: string | null): Promise<void> {
  await db.prepare(`UPDATE firms SET reminder_thresholds = ?1 WHERE id = ?2`).bind(thresholdsJson, firmId).run();
}

/** Roadmap #12 (migration 0046): the subscriber-level override of
 * setReminderThresholds() above -- same "validated by the caller before
 * this is ever called" trust posture. Applies across EVERY row sharing
 * this email, same "identity is the email, not a row" reach as
 * setSubscriberEmail()/setSubscriberFirstName(). */
export async function setSubscriberReminderThresholds(db: D1Database, emailNormalized: string, thresholdsJson: string | null): Promise<number> {
  const result = await db
    .prepare(`UPDATE subscribers SET reminder_thresholds = ?1 WHERE LOWER(TRIM(email)) = ?2`)
    .bind(thresholdsJson, emailNormalized)
    .run();
  return result.meta.changes ?? 0;
}

export const NOTIFICATION_MODE_IMMEDIATE = "immediate";
export const NOTIFICATION_MODE_DIGEST = "digest";

/** Roadmap #24 (migration 0051): "immediate" (today's only behavior, sent
 * per-threshold as each becomes due) or "digest" (batched into one weekly
 * email by scheduler.ts's runDigestPass()). Same cross-row-write reach as
 * setSubscriberReminderThresholds() above -- this is a per-PERSON delivery
 * preference, not a per-deadline one. */
export async function setSubscriberNotificationMode(db: D1Database, emailNormalized: string, mode: string): Promise<number> {
  const result = await db
    .prepare(`UPDATE subscribers SET notification_mode = ?1 WHERE LOWER(TRIM(email)) = ?2`)
    .bind(mode, emailNormalized)
    .run();
  return result.meta.changes ?? 0;
}

/** Roadmap #24: distinct emails whose digest window is open right now --
 * NULL digest_next_send_at (never sent one yet) or one that's reached its
 * +7-day rolling window (see runDigestPass()'s own docstring for why this
 * is a rolling window off the last SEND, not a fixed day-of-week). Status
 * filtered to confirmed here so a stopped/unconfirmed-only email never
 * shows up as "eligible" with nothing runDigestPass() could actually send
 * to -- the pass itself re-checks each row's own status via
 * listSubscriberLicenses() the same way allConfirmedActive() already does
 * for the immediate pass. */
export async function listDigestEligibleEmails(db: D1Database, todayIso: string, limit: number): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT LOWER(TRIM(email)) AS email_normalized
         FROM subscribers
        WHERE status = ?1
          AND notification_mode = ?2
          AND (digest_next_send_at IS NULL OR digest_next_send_at <= ?3)
        LIMIT ?4`
    )
    .bind(STATUS_CONFIRMED, NOTIFICATION_MODE_DIGEST, todayIso, limit)
    .all<{ email_normalized: string }>();
  return (results ?? []).map((r) => r.email_normalized);
}

/** Roadmap #24: advances the rolling window -- called ONLY after an actual
 * digest send, never speculatively, so a quiet week (nothing due) leaves
 * digest_next_send_at untouched and the next pass just checks again. Same
 * cross-row-write reach as setSubscriberNotificationMode() above -- every
 * row sharing this email advances together, since the digest bundles all
 * of them into one email. */
export async function advanceDigestWindow(db: D1Database, emailNormalized: string, nextSendAtIso: string): Promise<void> {
  await db
    .prepare(`UPDATE subscribers SET digest_next_send_at = ?1 WHERE LOWER(TRIM(email)) = ?2`)
    .bind(nextSendAtIso, emailNormalized)
    .run();
}

// Roadmap #144 (2026-08-07): 1-question NPS/CSAT micro-survey. Fired after a
// "Mark renewed" action (a genuine positive moment) or quarterly otherwise --
// never more than once per NPS_PROMPT_COOLDOWN_DAYS regardless of whether the
// firm answered or dismissed the previous prompt.
export const NPS_PROMPT_COOLDOWN_DAYS = 90;

export function shouldPromptNps(firm: Pick<FirmRow, "nps_last_prompted_at">, now: Date = new Date()): boolean {
  if (!firm.nps_last_prompted_at) return true;
  const elapsedMs = now.getTime() - Date.parse(firm.nps_last_prompted_at);
  return elapsedMs >= NPS_PROMPT_COOLDOWN_DAYS * 86_400_000;
}

/** Marks the prompt as shown (resets the cooldown) without recording a
 * score -- the firm dismissed it without answering. */
export async function recordNpsPromptDismissed(db: D1Database, firmId: string): Promise<void> {
  await db.prepare(`UPDATE firms SET nps_last_prompted_at = ?1 WHERE id = ?2`).bind(nowIso(), firmId).run();
}

/** Records a real response AND resets the cooldown -- an answered prompt
 * should never immediately re-prompt any more than a dismissed one should. */
export async function recordNpsResponse(db: D1Database, firmId: string, score: number): Promise<void> {
  const now = nowIso();
  await db
    .prepare(`INSERT INTO firm_nps_responses (id, firm_id, score, submitted_at) VALUES (?1,?2,?3,?4)`)
    .bind(newToken(), firmId, score, now)
    .run();
  await db.prepare(`UPDATE firms SET nps_last_prompted_at = ?1 WHERE id = ?2`).bind(now, firmId).run();
}

/** Roadmap #312 (2026-08-07): 1-click post-renewal review/testimonial
 * capture, chained off a promoter-tier NPS score rather than its own
 * cadence -- see migration 0043's own docstring. Never auto-published --
 * this is a private submission a human reviews before any public use. */
export async function recordTestimonial(db: D1Database, firmId: string, quoteText: string, canPublish: boolean): Promise<void> {
  await db
    .prepare(`INSERT INTO firm_testimonials (id, firm_id, quote_text, can_publish, submitted_at) VALUES (?1,?2,?3,?4,?5)`)
    .bind(newToken(), firmId, quoteText, canPublish ? 1 : 0, nowIso())
    .run();
}

/** Roadmap #19: one query for scheduler.ts's own per-subscriber loop to
 * build a { firm_id -> {name, reply_to_email} } lookup from, rather than a
 * per-subscriber firm fetch (N+1) inside a pass that can process a real
 * cohort of subscribers across every firm. Unfiltered -- this product's
 * `firms` table is small by design (unlike `subscribers`, which this
 * codebase is deliberately careful about NOT loading unbounded elsewhere),
 * so one full read is simpler and cheaper than a dynamic IN-clause. */
export interface FirmBasicInfo {
  id: string;
  name: string;
  reply_to_email: string | null;
  // Roadmap #23: JSON array string or null -- scheduler.ts parses this
  // itself (same "raw column value, caller decides" posture as every other
  // field here).
  reminder_thresholds: string | null;
  // AuditLab DEMO-5 (MEDIUM, 2026-08-07): the reminder cron sends via this
  // lookup and had no way to know a subscriber's firm was demo_locked --
  // same "gate the send, not the mutation" line DEMO-3/DEMO-4 already
  // drew, applied to the one send site those two missed (this file's
  // scope was index.ts's handle* functions; the cron lives in
  // scheduler.ts). 0/1 as returned by D1, coerced by the caller.
  demo_locked: number;
}

export async function listAllFirmsBasicInfo(db: D1Database): Promise<FirmBasicInfo[]> {
  const { results } = await db
    .prepare(`SELECT id, name, reply_to_email, reminder_thresholds, demo_locked FROM firms`)
    .all<FirmBasicInfo>();
  return results;
}

// ---------------------------------------------------------------------------
// Slack integration (2026-08-08, roadmap #20). "Add to Slack" (incoming-
// webhook scope) lets a firm admin connect a channel; scheduler.ts's
// runSlackAlertPass() posts one daily digest per firm of newly-due reminder
// thresholds. Firm-centric (not subscriber-centric like
// listAllFirmsBasicInfo() above) -- same shape as
// findFirmsEligibleForRuleChangeAlert(), since only a small subset of firms
// will ever have Slack connected, so filtering at the query is cheaper than
// fetching every firm and checking a null column in JS.
// ---------------------------------------------------------------------------

export interface FirmSlackConnectedInfo {
  id: string;
  name: string;
  slack_webhook_url: string;
  // JSON array string or null -- same "raw column value, caller decides"
  // posture as FirmBasicInfo.reminder_thresholds above. runSlackAlertPass()
  // reuses the SAME firm-then-subscriber threshold resolution
  // runReminderPass()/runDigestPass() already use -- no new threshold logic.
  reminder_thresholds: string | null;
  // Same AuditLab DEMO-5 reasoning as FirmBasicInfo.demo_locked above.
  demo_locked: number;
}

export async function listFirmsWithSlackConnected(db: D1Database): Promise<FirmSlackConnectedInfo[]> {
  const { results } = await db
    .prepare(
      `SELECT id, name, slack_webhook_url, reminder_thresholds, demo_locked
         FROM firms
        WHERE slack_webhook_url IS NOT NULL`
    )
    .all<FirmSlackConnectedInfo>();
  return results;
}

export interface SetFirmSlackIntegrationInput {
  webhookUrl: string;
  // Null when TOTP_ENCRYPTION_KEY isn't configured at connect time --
  // posting alerts only ever needs webhookUrl, so a missing encryption key
  // degrades ONLY the disconnect-time auth.revoke call (best-effort
  // regardless), never the core "receive alerts" feature.
  accessTokenEncrypted: string | null;
  accessTokenIv: string | null;
  teamName: string;
  channelName: string;
}

export async function setFirmSlackIntegration(db: D1Database, firmId: string, input: SetFirmSlackIntegrationInput): Promise<void> {
  await db
    .prepare(
      `UPDATE firms
          SET slack_webhook_url = ?1,
              slack_access_token_encrypted = ?2,
              slack_access_token_iv = ?3,
              slack_team_name = ?4,
              slack_channel_name = ?5
        WHERE id = ?6`
    )
    .bind(input.webhookUrl, input.accessTokenEncrypted, input.accessTokenIv, input.teamName, input.channelName, firmId)
    .run();
}

export async function clearFirmSlackIntegration(db: D1Database, firmId: string): Promise<void> {
  await db
    .prepare(
      `UPDATE firms
          SET slack_webhook_url = NULL,
              slack_access_token_encrypted = NULL,
              slack_access_token_iv = NULL,
              slack_team_name = NULL,
              slack_channel_name = NULL
        WHERE id = ?1`
    )
    .bind(firmId)
    .run();
}

/** Roadmap #20's own dedup, INDEPENDENT of claimReminderThreshold()/
 * reminders_sent (that claim belongs to the email lifecycle) -- see
 * migration 0052's own docstring for why the two channels must never
 * starve each other. Same INSERT-with-UNIQUE-conflict shape as
 * claimRuleChangeNotification(). */
export async function claimSlackThresholdNotification(db: D1Database, subscriberId: string, threshold: number): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO firm_slack_notified_thresholds (id, subscriber_id, threshold, notified_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (subscriber_id, threshold) DO NOTHING`
    )
    .bind(newToken(), subscriberId, threshold, nowIso())
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** Reverts a claimSlackThresholdNotification() claim after a failed send,
 * same at-least-once-delivery reasoning as unclaimReminderThreshold()/
 * unclaimRuleChangeNotification(). */
export async function unclaimSlackThresholdNotification(db: D1Database, subscriberId: string, threshold: number): Promise<void> {
  await db
    .prepare(`DELETE FROM firm_slack_notified_thresholds WHERE subscriber_id = ?1 AND threshold = ?2`)
    .bind(subscriberId, threshold)
    .run();
}

/**
 * Every threshold already notified via Slack for this subscriber -- the
 * Slack-side equivalent of parsing subscribers.reminders_sent, but from
 * firm_slack_notified_thresholds instead. runSlackAlertPass() uses this
 * (NOT reminders_sent) for nextDueThreshold()'s own escalation-ordering
 * logic, so a threshold already claimed by EMAIL never suppresses its
 * INDEPENDENT Slack notification -- see migration 0052's own docstring for
 * why the two channels must never starve each other.
 */
export async function listSlackNotifiedThresholds(db: D1Database, subscriberId: string): Promise<number[]> {
  const { results } = await db
    .prepare(`SELECT threshold FROM firm_slack_notified_thresholds WHERE subscriber_id = ?1`)
    .bind(subscriberId)
    .all<{ threshold: number }>();
  return results.map((r) => r.threshold);
}

// ---------------------------------------------------------------------------
// Microsoft Teams integration (2026-08-08, roadmap #21). Same shape as the
// Slack block above, minus anything OAuth-token-related -- see teams.ts's
// own docstring for why there's nothing to encrypt or revoke here.
// ---------------------------------------------------------------------------

export interface FirmTeamsConnectedInfo {
  id: string;
  name: string;
  teams_webhook_url: string;
  reminder_thresholds: string | null;
  demo_locked: number;
}

export async function listFirmsWithTeamsConnected(db: D1Database): Promise<FirmTeamsConnectedInfo[]> {
  const { results } = await db
    .prepare(
      `SELECT id, name, teams_webhook_url, reminder_thresholds, demo_locked
         FROM firms
        WHERE teams_webhook_url IS NOT NULL`
    )
    .all<FirmTeamsConnectedInfo>();
  return results;
}

export async function setFirmTeamsWebhook(db: D1Database, firmId: string, webhookUrl: string): Promise<void> {
  await db.prepare(`UPDATE firms SET teams_webhook_url = ?1 WHERE id = ?2`).bind(webhookUrl, firmId).run();
}

export async function clearFirmTeamsWebhook(db: D1Database, firmId: string): Promise<void> {
  await db.prepare(`UPDATE firms SET teams_webhook_url = NULL WHERE id = ?1`).bind(firmId).run();
}

/** Same INSERT-with-UNIQUE-conflict dedup shape as claimSlackThresholdNotification()
 * -- deliberately independent of reminders_sent AND firm_slack_notified_thresholds,
 * see migration 0053's own docstring. */
export async function claimTeamsThresholdNotification(db: D1Database, subscriberId: string, threshold: number): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO firm_teams_notified_thresholds (id, subscriber_id, threshold, notified_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (subscriber_id, threshold) DO NOTHING`
    )
    .bind(newToken(), subscriberId, threshold, nowIso())
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** Reverts a claimTeamsThresholdNotification() claim after a failed send,
 * same at-least-once-delivery reasoning as unclaimSlackThresholdNotification(). */
export async function unclaimTeamsThresholdNotification(db: D1Database, subscriberId: string, threshold: number): Promise<void> {
  await db
    .prepare(`DELETE FROM firm_teams_notified_thresholds WHERE subscriber_id = ?1 AND threshold = ?2`)
    .bind(subscriberId, threshold)
    .run();
}

/** Same Teams-side equivalent as listSlackNotifiedThresholds() -- used by
 * runTeamsAlertPass() for its own independent escalation-ordering, never
 * reminders_sent. */
export async function listTeamsNotifiedThresholds(db: D1Database, subscriberId: string): Promise<number[]> {
  const { results } = await db
    .prepare(`SELECT threshold FROM firm_teams_notified_thresholds WHERE subscriber_id = ?1`)
    .bind(subscriberId)
    .all<{ threshold: number }>();
  return results.map((r) => r.threshold);
}

/**
 * Ops-only, no HTTP route (2026-08-06) -- deliberately not wired up as an
 * endpoint yet. "An idea shipped" is a human judgment call with no
 * automatic trigger, made rarely, so this is meant to be driven by a
 * one-off script run by whoever's operating the fleet when the day
 * actually comes, using this + buildFeatureIdeaShippedEmail() +
 * sendViaSendGrid() directly -- not worth a whole admin-auth surface for
 * something invoked a handful of times a year. Returns every CONFIRMED,
 * not-yet-notified signup for the idea; the caller sends and then calls
 * markFeatureIdeaNotifySignupsNotified() with the ids that actually sent.
 */
export async function listConfirmedUnnotifiedSignupsForIdea(
  db: D1Database,
  ideaId: string
): Promise<{ id: string; email: string }[]> {
  const { results } = await db
    .prepare(
      `SELECT id, email FROM feature_idea_notify_signups
        WHERE idea_id = ?1 AND confirmed_at IS NOT NULL AND notified_at IS NULL`
    )
    .bind(ideaId)
    .all<{ id: string; email: string }>();
  return results ?? [];
}

export async function markFeatureIdeaNotifySignupsNotified(db: D1Database, ids: string[]): Promise<void> {
  const now = nowIso();
  for (const id of ids) {
    await db.prepare(`UPDATE feature_idea_notify_signups SET notified_at = ?1 WHERE id = ?2`).bind(now, id).run();
  }
}
