/**
 * AuditLab DEMO-5 (MEDIUM, 2026-08-07): the reminder cron (scheduler.ts)
 * bypassed DEMO-4's fix entirely -- a demo visitor's Add Staff row (real
 * email, "bring your own date" deadline landing on a threshold day) reached
 * the cron's own send site with no demo_locked check at all, since DEMO-4's
 * guard only ever looked at index.ts's handle* functions. Same
 * send-to-a-stranger-from-our-infrastructure primitive DEMO-4 closed,
 * reached by a path DEMO-4 didn't touch.
 *
 * Fixed by adding demo_locked to store.listAllFirmsBasicInfo()'s SELECT and
 * checking it early in scheduler.ts's per-subscriber loop, WITHOUT claiming
 * the threshold -- claiming would mark it as sent when nothing was, which
 * would silently break the demo's own "try the reminder feature" story for
 * the next visitor. This file proves the actual `send` callback never fires
 * for a demo-locked firm's subscriber, not just that a flag is checked --
 * same "spy on the real call, not the intent" posture demo4-email-lockdown
 * .spec.ts already established for the synchronous handlers.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as store from "../src/store";

async function createFirm(name: string, adminEmail: string, demoLocked: boolean): Promise<string> {
  const firm = await store.createFirm(env.DB, { name, adminEmail });
  if (demoLocked) {
    await env.DB.prepare(`UPDATE firms SET demo_locked = 1 WHERE id = ?1`).bind(firm.id).run();
  }
  return firm.id;
}

describe("DEMO-5: the reminder cron never emails a demo-locked firm's roster", () => {
  it("skips the send (and does not claim the threshold) for a demo-locked firm's subscriber", async () => {
    const { runReminderPass } = await import("../src/scheduler");
    const firmId = await createFirm("DEMO5 Cron Demo", `demo5-cron-demo-${Date.now()}@example.com`, true);
    const email = `demo5-cron-target-${Date.now()}@stranger.example.com`;
    await store.addPending(env.DB, {
      email,
      stateSlug: "texas",
      deadlineFields: { birth_month: "7" }, // TX deadline = end of July
      firstName: "Tester",
      firmId,
      staffLabel: "Attacker-Set Staff",
      skipConfirmation: true,
    });

    let sendCalled = false;
    const summary = await runReminderPass(env, {
      asOf: new Date(Date.UTC(2026, 6, 24)), // 7 days before end-of-July -- a real threshold day
      send: async () => {
        sendCalled = true;
        return true;
      },
    });

    expect(sendCalled).toBe(false);
    expect(summary.errors.some((e) => e.error.includes("demo_locked"))).toBe(true);

    // Re-run: the subscriber must still be eligible next pass (not
    // permanently marked as reminded) -- proves the threshold was never
    // claimed, matching the "treat it as a non-send" requirement.
    const stillPending = await store.listSubscriberLicenses(env.DB, store.normalizeEmail(email));
    const row = stillPending.find((r) => r.email === email);
    expect(row).toBeTruthy();
    const alreadySent = JSON.parse(row!.reminders_sent || "[]");
    expect(alreadySent).toEqual([]);
  });

  it("still sends for the identical setup when the firm is NOT demo-locked", async () => {
    const { runReminderPass } = await import("../src/scheduler");
    const firmId = await createFirm("DEMO5 Cron Real", `demo5-cron-real-${Date.now()}@example.com`, false);
    const email = `demo5-cron-real-target-${Date.now()}@example.com`;
    await store.addPending(env.DB, {
      email,
      stateSlug: "texas",
      deadlineFields: { birth_month: "7" },
      firstName: "Tester",
      firmId,
      staffLabel: "Real Staff",
      skipConfirmation: true,
    });

    let sendCalled = false;
    await runReminderPass(env, {
      asOf: new Date(Date.UTC(2026, 6, 24)),
      send: async () => {
        sendCalled = true;
        return true;
      },
    });

    expect(sendCalled).toBe(true);
  });
});
