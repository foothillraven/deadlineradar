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

/** generate.py:92 `next_birth_month_parity_date()`. */
export function nextBirthMonthParityDate(asOf: Date, month: number, parity: "odd" | "even"): Date {
  let y = asOf.getUTCFullYear();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const yearIsTargetParity = parity === "odd" ? y % 2 === 1 : y % 2 === 0;
    if (yearIsTargetParity) {
      const d = utcDate(y, month, monthLastDay(y, month));
      if (d.getTime() > asOf.getTime()) return d;
    }
    y += 1;
  }
}

/** generate.py:105 `next_annual_month_end()`. */
export function nextAnnualMonthEnd(asOf: Date, month: number): Date {
  const y = asOf.getUTCFullYear();
  let d = utcDate(y, month, monthLastDay(y, month));
  if (d.getTime() <= asOf.getTime()) {
    d = utcDate(y + 1, month, monthLastDay(y + 1, month));
  }
  return d;
}

export class StaleDataError extends Error {}

/** scheduler.py:68 `check_data_freshness()`. */
export function checkDataFreshness(realToday: Date): void {
  const asOf = new Date(`${DATA.as_of_date}T00:00:00Z`);
  const ageDays = Math.round((realToday.getTime() - asOf.getTime()) / 86_400_000);
  if (ageDays > STALENESS_THRESHOLD_DAYS) {
    throw new StaleDataError(
      `REFUSING: reference data's as_of_date is ${ageDays} days old, past the ` +
        `${STALENESS_THRESHOLD_DAYS}-day freshness threshold. Re-verify the data before allowing signups.`
    );
  }
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

// Mirrors generate.py's `_state_signup_supported()` exactly -- same rule,
// same underlying cpa_deadlines.json, so the site (which decides whether to
// show the auto-compute fields vs. the "bring your own date" field) and the
// worker (which decides whether to require/accept a user-provided date)
// can never drift out of sync with each other.
const FIELD_COMPUTED_STATES = new Set(["california", "texas", "ohio"]);

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

  if (stateSlug === "california") {
    const month = deadlineFields.birth_month;
    const parity = deadlineFields.birth_year_parity;
    if (!month || (parity !== "odd" && parity !== "even")) return null;
    const monthInt = Number.parseInt(month, 10);
    if (!Number.isInteger(monthInt)) return null;
    return nextBirthMonthParityDate(asOf, monthInt, parity);
  }

  if (stateSlug === "texas") {
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
