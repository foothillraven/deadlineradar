/**
 * Roadmap #70 (2026-08-07): holiday-aware reminder scheduling. Skips the
 * daily reminder cron entirely on 11 recognized US federal holidays --
 * scheduler.ts's nextDueThreshold() compares `daysRemaining <= threshold`,
 * not an exact match, so a skipped day is always caught up on the NEXT
 * day's run, never silently lost; this only delays that day's newly-due
 * sends by up to 24h. Computed from calendar rules, not a hardcoded date
 * list, so it never needs annual maintenance. Deliberately does NOT touch
 * account-deletion's own cron logic in index.ts's scheduled() -- that's an
 * unrelated 30-day clock with no reason to slip for a holiday.
 */

function nthWeekdayOfMonth(year: number, month: number, weekday: number, n: number): Date {
  // month: 0-11, weekday: 0=Sun..6=Sat, n: 1-based occurrence within the month.
  const first = new Date(Date.UTC(year, month, 1));
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  return new Date(Date.UTC(year, month, 1 + offset + (n - 1) * 7));
}

function lastWeekdayOfMonth(year: number, month: number, weekday: number): Date {
  const lastDayOfMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const last = new Date(Date.UTC(year, month, lastDayOfMonth));
  const back = (last.getUTCDay() - weekday + 7) % 7;
  return new Date(Date.UTC(year, month, lastDayOfMonth - back));
}

function isSameUtcDate(a: Date, b: Date): boolean {
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate();
}

export function usFederalHolidaysForYear(year: number): Date[] {
  return [
    new Date(Date.UTC(year, 0, 1)), // New Year's Day
    nthWeekdayOfMonth(year, 0, 1, 3), // MLK Day -- 3rd Monday of January
    nthWeekdayOfMonth(year, 1, 1, 3), // Presidents Day -- 3rd Monday of February
    lastWeekdayOfMonth(year, 4, 1), // Memorial Day -- last Monday of May
    new Date(Date.UTC(year, 5, 19)), // Juneteenth
    new Date(Date.UTC(year, 6, 4)), // Independence Day
    nthWeekdayOfMonth(year, 8, 1, 1), // Labor Day -- 1st Monday of September
    nthWeekdayOfMonth(year, 9, 1, 2), // Columbus Day -- 2nd Monday of October
    new Date(Date.UTC(year, 10, 11)), // Veterans Day
    nthWeekdayOfMonth(year, 10, 4, 4), // Thanksgiving -- 4th Thursday of November
    new Date(Date.UTC(year, 11, 25)), // Christmas Day
  ];
}

export function isUsFederalHoliday(date: Date): boolean {
  return usFederalHolidaysForYear(date.getUTCFullYear()).some((h) => isSameUtcDate(h, date));
}
