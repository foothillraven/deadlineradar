/**
 * Date math + deadline-computability probe -- ported from generate.py's
 * `next_birth_month_parity_date()` / `next_annual_month_end()` and
 * reminders/scheduler.py's `compute_subscriber_deadline()` /
 * `check_data_freshness()`.
 *
 * Phase 1 uses this ONLY as a "can we compute a deadline at all" probe
 * before persisting a signup (server.py's "probe before persist" hardening
 * -- a malformed-but-form-valid submission must never create an orphaned,
 * never-confirmable pending record). Phase 1 does not need `fmt_date()` or
 * the full scheduler -- no email is ever built or sent in this Worker, so
 * there is nothing to format a date string INTO yet.
 *
 * All dates are handled as UTC midnight `Date` objects (`Date.UTC(...)`) to
 * keep this deterministic regardless of the Worker's runtime timezone --
 * Python's `date` objects are naive (no timezone), which in practice meant
 * whatever the host machine's local date was; a Workers deployment always
 * runs in UTC, so anchoring here to UTC is the closest faithful port, not a
 * behavior change for the deployed environment.
 */

import cpaData from "./cpa_deadlines.json";

export const STALENESS_THRESHOLD_DAYS = 30; // generate.py:701

// "Bring your own date" upper bound: ~3.5 years, comfortably covering the
// longest real renewal cycle in this dataset (triennial, 3 years) plus
// slack -- orchestrator-approved 2026-07-05 design plan.
export const USER_DEADLINE_MAX_DAYS = 1280;

interface CpaRecord {
  id: string;
  state: string;
  state_slug: string;
  next_deadline_computed: string | null;
  cohort_groups?: { group: string; years: number[]; next_deadline: string }[];
  last_verified: string;
}

interface CpaData {
  as_of_date: string;
  records: CpaRecord[];
}

const DATA = cpaData as unknown as CpaData;

const MONTH_LAST_DAY = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function monthLastDay(year: number, month: number): number {
  if (month === 2 && isLeapYear(year)) return 29;
  const days = MONTH_LAST_DAY[month - 1];
  if (days === undefined) throw new Error(`invalid month ${month}`);
  return days;
}

function utcDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

/** Start of `asOf`'s own UTC calendar day. AuditLab DEADLINE-1: comparing a
 * candidate date (always UTC midnight) against a real timestamped `asOf`
 * directly made a deadline falling ON the current day read as "already
 * passed" for the whole day from 00:00:00.001 UTC onward -- inverting this
 * codebase's own "a date due today has not passed" principle (generate.py
 * ~9916) for exactly the two dynamically-computed states. Truncating `asOf`
 * to its own midnight before comparing makes "today" compare equal, not
 * greater-than, regardless of what time of day the check runs. */
function startOfUtcDay(d: Date): Date {
  return utcDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** generate.py:92 `next_birth_month_parity_date()`. */
export function nextBirthMonthParityDate(asOf: Date, month: number, parity: "odd" | "even"): Date {
  const today = startOfUtcDay(asOf);
  let y = asOf.getUTCFullYear();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const yearIsTargetParity = parity === "odd" ? y % 2 === 1 : y % 2 === 0;
    if (yearIsTargetParity) {
      const d = utcDate(y, month, monthLastDay(y, month));
      if (d.getTime() >= today.getTime()) return d;
    }
    y += 1;
  }
}

/** generate.py's `next_fixed_date_parity()` -- Kansas/Kentucky/Oregon/
 * Nebraska's ONE fixed month/day (not month-end) gated by a parity-
 * determining number, added 2026-08-18. */
export function nextFixedDateParity(asOf: Date, month: number, day: number, parity: "odd" | "even"): Date {
  const today = startOfUtcDay(asOf);
  let y = asOf.getUTCFullYear();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const yearIsTargetParity = parity === "odd" ? y % 2 === 1 : y % 2 === 0;
    if (yearIsTargetParity) {
      const d = utcDate(y, month, day);
      if (d.getTime() >= today.getTime()) return d;
    }
    y += 1;
  }
}

/** generate.py:105 `next_annual_month_end()`. */
export function nextAnnualMonthEnd(asOf: Date, month: number): Date {
  const today = startOfUtcDay(asOf);
  const y = asOf.getUTCFullYear();
  let d = utcDate(y, month, monthLastDay(y, month));
  if (d.getTime() < today.getTime()) {
    d = utcDate(y + 1, month, monthLastDay(y + 1, month));
  }
  return d;
}

export class StaleDataError extends Error {}

function ageDaysFromAsOf(realToday: Date): number {
  const asOf = new Date(`${DATA.as_of_date}T00:00:00Z`);
  return Math.round((realToday.getTime() - asOf.getTime()) / 86_400_000);
}

/** AuditLab STALE-5: `as_of_date` is a single whole-file stamp, but nothing
 * ever forced it to move in lockstep with the per-record `last_verified`
 * fields the public "N of 88 citations re-verified" stat is built from --
 * a file touch that bumps `as_of_date` without actually re-verifying every
 * record makes the guard read fresher than the data underneath it actually
 * is. Fix: the guard is anchored on the WORSE (older) of `as_of_date`'s own
 * age and the single oldest `last_verified` across every record, so it can
 * only ever get tighter than `as_of_date` alone, never looser. Same
 * fail-toward-refusing posture as `ageDaysFromAsOf`'s own unparseable case
 * -- a record with a missing/unparseable `last_verified` counts as
 * infinitely old rather than being silently skipped. */
function worstRecordAgeDays(realToday: Date): number {
  let worst = -Infinity;
  for (const r of DATA.records) {
    const verified = new Date(`${r.last_verified}T00:00:00Z`);
    const age = Number.isNaN(verified.getTime())
      ? Infinity
      : Math.round((realToday.getTime() - verified.getTime()) / 86_400_000);
    if (age > worst) worst = age;
  }
  return worst;
}

function combinedAgeDays(realToday: Date): number {
  return Math.max(ageDaysFromAsOf(realToday), worstRecordAgeDays(realToday));
}

/** scheduler.py:68 `check_data_freshness()`. AuditLab ST-3: an unparseable
 * `as_of_date` used to produce `NaN` age, and `NaN > threshold` is `false` --
 * failing OPEN (signups allowed off data of unknown freshness) instead of
 * closed. Reachability is low (generate.py's `date.fromisoformat()` plus
 * preship_gate.py's two-copy check both reject malformed input before it
 * reaches the bundled JSON), but this is the one runtime control a
 * data-integrity product has for this, so it must fail toward refusing, not
 * toward silently trusting unknown data. */
export function checkDataFreshness(realToday: Date): void {
  const asOfAgeDays = ageDaysFromAsOf(realToday);
  if (Number.isNaN(asOfAgeDays)) {
    throw new StaleDataError(
      `REFUSING: reference data's as_of_date ("${DATA.as_of_date}") is unparseable -- treating as ` +
        `stale rather than trusting data of unknown freshness. Every pass that depends on this data ` +
        `(signups and all outbound sends) is paused until it is re-verified.`
    );
  }
  const ageDays = combinedAgeDays(realToday);
  if (ageDays > STALENESS_THRESHOLD_DAYS) {
    const which = ageDays === asOfAgeDays ? "as_of_date" : "its single oldest record's last_verified date";
    throw new StaleDataError(
      `REFUSING: reference data is ${ageDays} days old (anchored on ${which}), past the ` +
        `${STALENESS_THRESHOLD_DAYS}-day freshness threshold. Every pass that depends on this data ` +
        `(signups and all outbound sends) is paused until it is re-verified.`
    );
  }
}

/** AuditLab ST-1: the write guard above pauses signups and roster-adds once
 * data is stale (checkDataFreshness()'s three call sites -- POST /subscribe,
 * POST /firm/licenses, PATCH /firm/licenses/:id -- NOT the renew route,
 * which stays unguarded on purpose since it doesn't persist a computed
 * deadline), but every READ path (GET /firm/licenses, the roster list) kept
 * serving dates derived from that same data with no disclosure -- a customer
 * could be refused a new staff member while the dashboard confidently showed
 * 40 existing ones. Exposes the same age/threshold computation as a
 * non-throwing read so API responses can carry a `data_as_of`/`data_stale`
 * signal instead of staying silent. */
export function dataFreshnessInfo(realToday: Date): { as_of_date: string; age_days: number; stale: boolean } {
  const asOfAgeDays = ageDaysFromAsOf(realToday);
  const unparseable = Number.isNaN(asOfAgeDays);
  const ageDays = unparseable ? asOfAgeDays : combinedAgeDays(realToday);
  return {
    as_of_date: DATA.as_of_date,
    age_days: unparseable ? -1 : ageDays,
    stale: unparseable || ageDays > STALENESS_THRESHOLD_DAYS,
  };
}

/** The canonical display name for a state slug ("north-carolina" -> "North
 * Carolina"), read from the same reference data the site uses. Null if the
 * slug isn't in the data. Used by the reminder scheduler to name the state in
 * the email. */
export function stateNameForSlug(slug: string): string | null {
  const r = DATA.records.find((rec) => rec.state_slug === slug);
  return r ? r.state : null;
}

/**
 * Every state slug present in the reference data -- computed from the data
 * itself, not a hand-maintained list. Discovered 2026-07-05 while building
 * "bring your own date": this used to be a hardcoded 9-entry set in
 * validation.ts (the original wave-1/2/3 states only), silently rejecting
 * /subscribe for all 20 batch-2/3 states regardless of computability --
 * confirmed via the test suite having zero coverage of any batch-2/3 state
 * at all. Moved here and computed from DATA so it can never drift out of
 * sync with the site again. New York is now INCLUDED: it was previously
 * excluded because it has no computable rule, but "bring your own date"
 * means every state -- computable or not -- can accept a signup now.
 */
export const SUPPORTED_STATE_SLUGS: ReadonlySet<string> = new Set(DATA.records.map((r) => r.state_slug));

// Mirrors generate.py's `_state_signup_supported()` -- same rule, same
// underlying cpa_deadlines.json for the DATA-derived half of that function
// (the `any(next_deadline_computed)` fallback below IS drift-proof, since
// both sides read the same JSON). This hardcoded literal is NOT -- AuditLab
// SYNC-1 (2026-08-09): an earlier version of this comment claimed the two
// could "never drift out of sync", which was false; nothing enforced it.
// preship_gate.py's check_field_computed_states_sync() is the actual
// enforcement -- it parses this literal and generate.py's
// _WORKER_FIELD_COMPUTED_STATES and fails the build on any difference.
// Add a state to BOTH sets together, or the page and the worker disagree
// on which fields to show/require and signup 400s in that state.
const FIELD_COMPUTED_STATES = new Set([
  "california", "texas", "ohio", "kansas", "kentucky", "oregon", "nebraska", "idaho",
  "oklahoma", "new-mexico", "arizona",
]);

/** Whether the worker can EVER derive a deadline for this state from state
 * rules alone (via computeSubscriberDeadline below), with no user input
 * beyond the per-state fields it already asks for. False means the state
 * needs "bring your own date" instead -- see index.ts's handleSubscribe(). */
export function isStateComputable(stateSlug: string): boolean {
  if (FIELD_COMPUTED_STATES.has(stateSlug)) return true;
  return DATA.records.some((r) => r.state_slug === stateSlug && r.next_deadline_computed);
}

export type DeadlineFields = Record<string, string>;

/**
 * scheduler.py:83 `compute_subscriber_deadline()`, narrowed to Phase 1's
 * one actual use: a computability PROBE (returns a Date or null), never
 * raises on bad input -- a malformed record should fail the probe, not
 * crash the request.
 */
export function computeSubscriberDeadline(
  stateSlug: string,
  deadlineFields: DeadlineFields,
  asOf: Date
): Date | null {
  const stateRecords = DATA.records.filter((r) => r.state_slug === stateSlug);
  if (stateRecords.length === 0) return null;

  if (stateSlug === "california" || stateSlug === "arizona") {
    // Arizona added 2026-08-18 (AuditLab DNC sweep) -- same birth-month +
    // birth-year-parity mechanism as California, see
    // BIRTH_MONTH_YEAR_PARITY_STATES' comment in generate.py.
    const month = deadlineFields.birth_month;
    const parity = deadlineFields.birth_year_parity;
    if (!month || (parity !== "odd" && parity !== "even")) return null;
    const monthInt = Number.parseInt(month, 10);
    if (!Number.isInteger(monthInt)) return null;
    return nextBirthMonthParityDate(asOf, monthInt, parity);
  }

  if (stateSlug === "texas" || stateSlug === "oklahoma" || stateSlug === "new-mexico") {
    // Same pure birth-month-annual mechanism as Texas -- see
    // BIRTH_MONTH_ANNUAL_STATES' comment in generate.py for why Oklahoma
    // and New Mexico individual are the same shape (2026-08-18 AuditLab
    // DNC sweep).
    const month = deadlineFields.birth_month;
    if (!month) return null;
    const monthInt = Number.parseInt(month, 10);
    if (!Number.isInteger(monthInt)) return null;
    return nextAnnualMonthEnd(asOf, monthInt);
  }

  if (stateSlug === "ohio") {
    const group = deadlineFields.cohort_group;
    const record = stateRecords[0];
    const match = record?.cohort_groups?.find((g) => g.group === group);
    return match ? new Date(`${match.next_deadline}T00:00:00Z`) : null;
  }

  // 2026-08-18: Kansas/Kentucky/Oregon/Nebraska's ONE fixed month/day gated
  // by a parity-determining number -- see nextFixedDateParity's own
  // comment. `deadlineFields.parity` is already reduced to "odd"/"even" by
  // the time it reaches here (server.py/index.ts strip the raw number
  // before persisting, same PII-minimization as California's birth_year).
  const PARITY_STATE_MONTH_DAY: Record<string, [number, number]> = {
    kansas: [7, 1],
    kentucky: [8, 1],
    oregon: [6, 30],
    nebraska: [6, 30],
    idaho: [6, 30],
  };
  if (stateSlug in PARITY_STATE_MONTH_DAY) {
    const parity = deadlineFields.parity;
    if (parity !== "odd" && parity !== "even") return null;
    const [month, day] = PARITY_STATE_MONTH_DAY[stateSlug] as [number, number];
    return nextFixedDateParity(asOf, month, day, parity);
  }

  // Fixed-calendar states, possibly with multiple records (e.g. Florida's
  // odd/even cohort, Georgia's individual-vs-firm) -- the subscriber picks
  // which record applies to them at signup (license_type_id).
  const licenseTypeId = deadlineFields.license_type_id;
  if (licenseTypeId) {
    const r = stateRecords.find((rec) => rec.id === licenseTypeId && rec.next_deadline_computed);
    return r?.next_deadline_computed ? new Date(`${r.next_deadline_computed}T00:00:00Z`) : null;
  }

  // Single-record states (no license_type_id needed).
  const computed = stateRecords.filter((r) => r.next_deadline_computed);
  if (computed.length === 1 && computed[0]?.next_deadline_computed) {
    return new Date(`${computed[0].next_deadline_computed}T00:00:00Z`);
  }
  return null;
}
