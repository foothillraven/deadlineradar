import { describe, expect, it } from "vitest";
import { isUsFederalHoliday, usFederalHolidaysForYear } from "../src/holidays";

describe("isUsFederalHoliday", () => {
  it("recognizes fixed-date holidays", () => {
    expect(isUsFederalHoliday(new Date(Date.UTC(2026, 0, 1)))).toBe(true); // New Year's
    expect(isUsFederalHoliday(new Date(Date.UTC(2026, 5, 19)))).toBe(true); // Juneteenth
    expect(isUsFederalHoliday(new Date(Date.UTC(2026, 6, 4)))).toBe(true); // Independence Day
    expect(isUsFederalHoliday(new Date(Date.UTC(2026, 10, 11)))).toBe(true); // Veterans Day
    expect(isUsFederalHoliday(new Date(Date.UTC(2026, 11, 25)))).toBe(true); // Christmas
  });

  it("computes 2026's floating holidays correctly (independently verified against the calendar)", () => {
    expect(isUsFederalHoliday(new Date(Date.UTC(2026, 0, 19)))).toBe(true); // MLK Day: Mon Jan 19, 2026
    expect(isUsFederalHoliday(new Date(Date.UTC(2026, 1, 16)))).toBe(true); // Presidents Day: Mon Feb 16, 2026
    expect(isUsFederalHoliday(new Date(Date.UTC(2026, 4, 25)))).toBe(true); // Memorial Day: Mon May 25, 2026
    expect(isUsFederalHoliday(new Date(Date.UTC(2026, 8, 7)))).toBe(true); // Labor Day: Mon Sep 7, 2026
    expect(isUsFederalHoliday(new Date(Date.UTC(2026, 9, 12)))).toBe(true); // Columbus Day: Mon Oct 12, 2026
    expect(isUsFederalHoliday(new Date(Date.UTC(2026, 10, 26)))).toBe(true); // Thanksgiving: Thu Nov 26, 2026
  });

  it("returns false for an ordinary weekday", () => {
    expect(isUsFederalHoliday(new Date(Date.UTC(2026, 7, 12)))).toBe(false); // Wed Aug 12, 2026
  });

  it("returns false for a near-miss date adjacent to a real holiday", () => {
    expect(isUsFederalHoliday(new Date(Date.UTC(2026, 11, 24)))).toBe(false);
    expect(isUsFederalHoliday(new Date(Date.UTC(2026, 11, 26)))).toBe(false);
  });

  it("produces exactly 11 holidays for any given year, all within that year", () => {
    const holidays = usFederalHolidaysForYear(2027);
    expect(holidays).toHaveLength(11);
    holidays.forEach((h) => expect(h.getUTCFullYear()).toBe(2027));
  });

  it("Thanksgiving is always a Thursday and Labor/Memorial/Columbus/MLK/Presidents Day are always Mondays", () => {
    for (const year of [2026, 2027, 2028, 2030]) {
      const [, mlk, presidents, memorial, , , labor, columbus, , thanksgiving] = usFederalHolidaysForYear(year);
      [mlk, presidents, memorial, labor, columbus].forEach((d) => expect(d!.getUTCDay()).toBe(1));
      expect(thanksgiving!.getUTCDay()).toBe(4);
    }
  });
});
