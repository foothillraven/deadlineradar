/**
 * Roadmap #12 (2026-08-07): the subscriber-level override of #23's
 * reminder-cadence feature. Same fixed-6-value validation
 * (parseReminderThresholds) as the firm-level PATCH -- see
 * reminder-cadence.spec.ts, which this file mirrors the structure of, one
 * level down (a PERSON'S own preference, not their firm's default).
 */
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as store from "../src/store";

const BASE = "https://deadline-radar.com";

async function seed(email: string, stateSlug: string, firmId: string | null = null, deadlineFields: Record<string, string> = {}) {
  return store.addPending(env.DB, {
    email,
    stateSlug,
    deadlineFields,
    firstName: null,
    firmId,
    skipConfirmation: true,
  });
}

async function subscriberCookie(email: string): Promise<string> {
  const { rawSessionToken } = await store.createSubscriberSession(env.DB, store.normalizeEmail(email));
  return `dr_sub_session=${rawSessionToken}`;
}

async function patchCadence(cookie: string | null, thresholds: number[] | null): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers["Cookie"] = cookie;
  return SELF.fetch(`${BASE}/subscriber/reminder-cadence`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ thresholds }),
  });
}

describe("PATCH /subscriber/reminder-cadence", () => {
  it("401s with no session", async () => {
    expect((await patchCadence(null, [30, 7, 1])).status).toBe(401);
  });

  it("sets a valid subset across every row sharing this email, and clears back to null", async () => {
    const email = `subcadence-${Date.now()}@example.com`;
    await seed(email, "ohio");
    await seed(email, "texas");
    const cookie = await subscriberCookie(email);

    const setResp = await patchCadence(cookie, [30, 7, 1]);
    expect(setResp.status).toBe(200);
    const setBody = (await setResp.json()) as { reminder_thresholds: number[] };
    expect(setBody.reminder_thresholds.sort((a, b) => a - b)).toEqual([1, 7, 30]);

    const rows = await store.listSubscriberLicenses(env.DB, email);
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(JSON.parse(row.reminder_thresholds ?? "[]").sort((a: number, b: number) => a - b)).toEqual([1, 7, 30]);
    }

    const clearResp = await patchCadence(cookie, null);
    expect(clearResp.status).toBe(200);
    const clearBody = (await clearResp.json()) as { reminder_thresholds: number[] | null };
    expect(clearBody.reminder_thresholds).toBeNull();
    for (const row of await store.listSubscriberLicenses(env.DB, email)) {
      expect(row.reminder_thresholds).toBeNull();
    }
  });

  it("rejects an arbitrary (non-fixed-set) value and an empty array", async () => {
    const email = `subcadence-bad-${Date.now()}@example.com`;
    await seed(email, "ohio");
    const cookie = await subscriberCookie(email);
    expect((await patchCadence(cookie, [45])).status).toBe(400);
    expect((await patchCadence(cookie, [])).status).toBe(400);
  });

  it("never touches another subscriber's rows", async () => {
    const mine = `subcadence-mine-${Date.now()}@example.com`;
    const theirs = `subcadence-theirs-${Date.now()}@example.com`;
    await seed(mine, "ohio");
    await seed(theirs, "texas");

    await patchCadence(await subscriberCookie(mine), [1]);

    const theirRow = (await store.listSubscriberLicenses(env.DB, theirs))[0];
    expect(theirRow?.reminder_thresholds).toBeNull();
  });
});

describe("scheduler.ts runReminderPass -- subscriber override wins over the firm's default (roadmap #12)", () => {
  it("a subscriber's own narrower cadence suppresses a tier their firm would otherwise send", async () => {
    const { runReminderPass } = await import("../src/scheduler");
    const { id: firmId } = await store.createFirm(env.DB, {
      name: "Sched Subscriber Override Firm",
      adminEmail: `schedsuboverride-${Date.now()}@example.com`,
    });
    // Firm uses the full default cadence (never narrowed) -- the 7-day
    // tier is very much still on for everyone else on this roster.
    const email = `schedsuboverride-tx-${Date.now()}@example.com`;
    await seed(email, "texas", firmId, { birth_month: "7" }); // TX deadline = end of July

    await SELF.fetch(`${BASE}/subscriber/reminder-cadence`, {
      method: "PATCH",
      headers: { "content-type": "application/json", Cookie: await subscriberCookie(email) },
      body: JSON.stringify({ thresholds: [1] }), // this ONE person only wants the final reminder
    });

    // 2026-07-24 is 7 days before the TX end-of-July deadline -- fires the
    // 7-day tier under the firm's (default, unchanged) cadence, but this
    // subscriber personally narrowed their own cadence to [1] only.
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

  it("a subscriber with no override still gets the firm's own cadence, unaffected by another subscriber's personal override", async () => {
    const { runReminderPass } = await import("../src/scheduler");
    const { id: firmId } = await store.createFirm(env.DB, {
      name: "Sched Unaffected Firm",
      adminEmail: `schedunaffected-${Date.now()}@example.com`,
    });
    const overridden = `schedunaffected-overridden-${Date.now()}@example.com`;
    const plain = `schedunaffected-plain-${Date.now()}@example.com`;
    await seed(overridden, "texas", firmId, { birth_month: "7" });
    await seed(plain, "texas", firmId, { birth_month: "7" });

    await SELF.fetch(`${BASE}/subscriber/reminder-cadence`, {
      method: "PATCH",
      headers: { "content-type": "application/json", Cookie: await subscriberCookie(overridden) },
      body: JSON.stringify({ thresholds: [1] }),
    });

    const sent: string[] = [];
    await runReminderPass(env, {
      asOf: new Date(Date.UTC(2026, 6, 24)), // 7 days out
      send: async (toEmail) => {
        sent.push(toEmail);
        return true;
      },
    });

    expect(sent).toContain(plain);
    expect(sent).not.toContain(overridden);
  });
});
