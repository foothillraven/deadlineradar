/**
 * Roadmap #23 (2026-08-07): customizable reminder cadence, scoped to
 * choosing a SUBSET of the 6 fixed escalation points (60/30/14/7/3/1 days),
 * not arbitrary day-offsets -- see migration 0039's own docstring for why.
 */
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as store from "../src/store";
import { parseReminderThresholds } from "../src/validation";
import { nextDueThreshold, ESCALATION_THRESHOLDS_DAYS } from "../src/scheduler";

const BASE = "https://deadline-radar.com";

async function createFirmWithSession(name: string, adminEmail: string): Promise<{ firmId: string; cookie: string }> {
  const firm = await store.createFirm(env.DB, { name, adminEmail });
  const { rawSessionToken } = await store.createSession(env.DB, firm.id);
  return { firmId: firm.id, cookie: `dr_firm_session=${rawSessionToken}` };
}

describe("parseReminderThresholds()", () => {
  it("accepts a valid subset", () => {
    expect(parseReminderThresholds([30, 7, 1])).toEqual([30, 7, 1]);
  });

  it("dedupes", () => {
    expect(parseReminderThresholds([30, 30, 7])?.sort((a, b) => a - b)).toEqual([7, 30]);
  });

  it("rejects an empty array", () => {
    expect(parseReminderThresholds([])).toBeNull();
  });

  it("rejects a value outside the fixed set", () => {
    expect(parseReminderThresholds([30, 45])).toBeNull();
  });

  it("rejects non-array input", () => {
    expect(parseReminderThresholds("30")).toBeNull();
    expect(parseReminderThresholds(null)).toBeNull();
  });

  it("rejects non-number entries", () => {
    expect(parseReminderThresholds([30, "7"])).toBeNull();
  });
});

describe("nextDueThreshold() with a custom subset", () => {
  it("only returns thresholds from the given subset", () => {
    // 8 days remaining: the DEFAULT full set fires the 14-day tier (8<=14,
    // 8>7). With 14 and 7 excluded from this firm's subset, 8 no longer
    // qualifies for anything smaller than 30 -- falls through to that tier
    // instead of the 14 a default-configured firm would get.
    expect(nextDueThreshold(8, [], ESCALATION_THRESHOLDS_DAYS)).toBe(14);
    expect(nextDueThreshold(8, [], [30, 7, 1])).toBe(30);
  });

  it("still behaves exactly like before when no subset is given (default param)", () => {
    expect(nextDueThreshold(25, [])).toBe(nextDueThreshold(25, [], ESCALATION_THRESHOLDS_DAYS));
  });

  // Noted alongside SEND-1 (AuditLab, 2026-08-20): reminders_sent/steps_sent
  // is only guarded for JSON parse failure, not for parsing to something
  // that isn't an array of numbers. A stray non-numeric entry makes
  // Math.min(...alreadySent) NaN, and `threshold >= NaN` is always false --
  // the "never go less urgent than what's already sent" guard would be
  // silently defeated rather than holding. Positive control: without the
  // fix this returns a threshold (the bug); with it, null (holds).
  it("holds rather than defeat the already-sent guard when alreadySent contains a non-numeric value", () => {
    const corrupt = [7, "not-a-number"] as unknown as number[];
    expect(nextDueThreshold(5, corrupt)).toBe(null);
  });
});

describe("PATCH /firm/reminder-cadence", () => {
  it("401s with no session", async () => {
    const resp = await SELF.fetch(`${BASE}/firm/reminder-cadence`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ thresholds: [30, 7, 1] }),
    });
    expect(resp.status).toBe(401);
  });

  it("sets a valid subset", async () => {
    const { cookie } = await createFirmWithSession("Cadence Firm", `cadence-${Date.now()}@example.com`);
    const resp = await SELF.fetch(`${BASE}/firm/reminder-cadence`, {
      method: "PATCH",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({ thresholds: [30, 7, 1] }),
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { reminder_thresholds: number[] };
    expect(body.reminder_thresholds.sort((a, b) => a - b)).toEqual([1, 7, 30]);
  });

  it("clears back to null (every default threshold)", async () => {
    const { cookie } = await createFirmWithSession("Clear Cadence Firm", `clearcadence-${Date.now()}@example.com`);
    await SELF.fetch(`${BASE}/firm/reminder-cadence`, {
      method: "PATCH",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({ thresholds: [30, 7, 1] }),
    });
    const resp = await SELF.fetch(`${BASE}/firm/reminder-cadence`, {
      method: "PATCH",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({ thresholds: null }),
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { reminder_thresholds: number[] | null };
    expect(body.reminder_thresholds).toBeNull();
  });

  it("rejects an arbitrary (non-fixed-set) value", async () => {
    const { cookie } = await createFirmWithSession("Bad Cadence Firm", `badcadence-${Date.now()}@example.com`);
    const resp = await SELF.fetch(`${BASE}/firm/reminder-cadence`, {
      method: "PATCH",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({ thresholds: [45] }),
    });
    expect(resp.status).toBe(400);
  });

  it("rejects an empty array", async () => {
    const { cookie } = await createFirmWithSession("Empty Cadence Firm", `emptycadence-${Date.now()}@example.com`);
    const resp = await SELF.fetch(`${BASE}/firm/reminder-cadence`, {
      method: "PATCH",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({ thresholds: [] }),
    });
    expect(resp.status).toBe(400);
  });
});

describe("GET /firm/licenses reminder_thresholds", () => {
  it("returns null when never set, then the saved value after PATCH", async () => {
    const { cookie } = await createFirmWithSession("Cadence Read Firm", `cadenceread-${Date.now()}@example.com`);
    const before = await SELF.fetch(`${BASE}/firm/licenses`, { headers: { Cookie: cookie } });
    const beforeBody = (await before.json()) as { reminder_thresholds: number[] | null };
    expect(beforeBody.reminder_thresholds).toBeNull();

    await SELF.fetch(`${BASE}/firm/reminder-cadence`, {
      method: "PATCH",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({ thresholds: [60, 1] }),
    });
    const after = await SELF.fetch(`${BASE}/firm/licenses`, { headers: { Cookie: cookie } });
    const afterBody = (await after.json()) as { reminder_thresholds: number[] | null };
    expect(afterBody.reminder_thresholds?.sort((a, b) => a - b)).toEqual([1, 60]);
  });
});

describe("scheduler.ts runReminderPass -- custom cadence respected end-to-end", () => {
  it("skips a subscriber whose only currently-due tier is disabled by the firm", async () => {
    const { runReminderPass } = await import("../src/scheduler");
    const { firmId, cookie } = await createFirmWithSession("Sched Cadence Firm", `schedcadence-${Date.now()}@example.com`);
    // Firm only wants the 1-day final reminder -- 30 and 7 are turned off.
    await SELF.fetch(`${BASE}/firm/reminder-cadence`, {
      method: "PATCH",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({ thresholds: [1] }),
    });
    const email = `schedcadence-tx-${Date.now()}@example.com`;
    await store.addPending(env.DB, {
      email,
      stateSlug: "texas",
      deadlineFields: { birth_month: "7" }, // TX deadline = end of July
      firstName: "Tester",
      firmId,
      staffLabel: "Sched Cadence Staff",
      skipConfirmation: true,
    });

    // 2026-07-24 is 7 days before the TX end-of-July deadline -- would fire
    // the 7-day tier under the default set, but that tier is disabled here.
    let sendCalled = false;
    await runReminderPass(env, {
      asOf: new Date(Date.UTC(2026, 6, 24)),
      send: async () => {
        sendCalled = true;
        return true;
      },
    });

    expect(sendCalled).toBe(false);
  });
});
