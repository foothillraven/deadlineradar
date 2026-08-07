/**
 * Reminder-send date logging (2026-08-07, roadmap #8, migration 0035) and
 * its export, GET /firm/audit-trail. See migration 0035's own docstring
 * for why this is a new table rather than a reshaping of
 * subscribers.reminders_sent.
 */
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as store from "../src/store";

const BASE = "https://deadline-radar.com";

async function createFirmWithSession(name: string, adminEmail: string): Promise<{ firmId: string; cookie: string }> {
  const firm = await store.createFirm(env.DB, { name, adminEmail });
  const { rawSessionToken } = await store.createSession(env.DB, firm.id);
  return { firmId: firm.id, cookie: `dr_firm_session=${rawSessionToken}` };
}

describe("scheduler.ts runReminderPass -- reminder_log", () => {
  it("logs a real send for a FIRM-tracked subscriber", async () => {
    const { runReminderPass } = await import("../src/scheduler");
    const { firmId } = await createFirmWithSession("Reminder Log Firm", `reminderlogfirm-${Date.now()}@example.com`);
    const email = `reminderlog-tx-${Date.now()}@example.com`;
    const rec = await store.addPending(env.DB, {
      email,
      stateSlug: "texas",
      deadlineFields: { birth_month: "7" }, // TX deadline = end of July
      firstName: "Tester",
      firmId,
      staffLabel: "Reminder Log Staff",
      skipConfirmation: true,
    });

    await runReminderPass(env, {
      asOf: new Date(Date.UTC(2026, 6, 24)),
      send: async () => true,
    });

    const log = await store.listReminderLogForFirm(env.DB, firmId);
    expect(log.length).toBe(1);
    expect(log[0]?.subscriber_id).toBe(rec.id);
    expect(log[0]?.threshold_days).toBe(7);
    expect(log[0]?.sent_at).toBeTruthy();
  });

  it("does NOT log a send for a free-tier (non-firm) subscriber", async () => {
    const { runReminderPass } = await import("../src/scheduler");
    const email = `reminderlog-free-tx-${Date.now()}@example.com`;
    await store.addPending(env.DB, {
      email,
      stateSlug: "texas",
      deadlineFields: { birth_month: "7" },
      firstName: "Tester",
    });
    await store.confirm(env.DB, (await store.findActiveOrPending(env.DB, email, "texas"))!.confirm_token);

    const before = await env.DB.prepare("SELECT COUNT(*) as n FROM reminder_log").first<{ n: number }>();
    await runReminderPass(env, {
      asOf: new Date(Date.UTC(2026, 6, 24)),
      send: async () => true,
    });
    const after = await env.DB.prepare("SELECT COUNT(*) as n FROM reminder_log").first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
  });

  it("does NOT log a send that fails (send() returns false)", async () => {
    const { runReminderPass } = await import("../src/scheduler");
    const { firmId } = await createFirmWithSession("Failed Send Firm", `failedsendfirm-${Date.now()}@example.com`);
    const email = `reminderlog-failed-tx-${Date.now()}@example.com`;
    await store.addPending(env.DB, {
      email,
      stateSlug: "texas",
      deadlineFields: { birth_month: "7" },
      firstName: "Tester",
      firmId,
      staffLabel: "Failed Send Staff",
      skipConfirmation: true,
    });

    await runReminderPass(env, {
      asOf: new Date(Date.UTC(2026, 6, 24)),
      send: async () => false,
    });

    const log = await store.listReminderLogForFirm(env.DB, firmId);
    expect(log.length).toBe(0);
  });
});

describe("GET /firm/audit-trail", () => {
  it("401s with no session", async () => {
    const resp = await SELF.fetch(`${BASE}/firm/audit-trail`);
    expect(resp.status).toBe(401);
  });

  it("returns both activity and reminder entries for the firm", async () => {
    const { cookie, firmId } = await createFirmWithSession("Audit Trail Firm", `audittrailfirm-${Date.now()}@example.com`);
    const staffResp = await SELF.fetch(`${BASE}/firm/licenses`, {
      method: "POST",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        staff_label: "Audit Trail Staff",
        email: `audittrailstaff-${Date.now()}@example.com`,
        state_slug: "georgia",
        license_type_id: "ga-individual",
      }),
    });
    const staff = (await staffResp.json()) as { id: string };
    await store.logReminderSent(env.DB, firmId, staff.id, 30);

    const resp = await SELF.fetch(`${BASE}/firm/audit-trail`, { headers: { Cookie: cookie } });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      activity: { event_type: string; staff_label: string | null }[];
      reminders: { threshold_days: number; staff_label: string }[];
    };
    expect(body.activity.some((e) => e.event_type === "added")).toBe(true);
    expect(body.reminders.length).toBe(1);
    expect(body.reminders[0]?.threshold_days).toBe(30);
    expect(body.reminders[0]?.staff_label).toBe("Audit Trail Staff");
  });

  it("falls back to a generic label for a reminder tied to a removed staffer", async () => {
    const { cookie, firmId } = await createFirmWithSession("Removed Staff Audit Firm", `removedaudit-${Date.now()}@example.com`);
    const staffResp = await SELF.fetch(`${BASE}/firm/licenses`, {
      method: "POST",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        staff_label: "Soon Removed",
        email: `soonremoved-${Date.now()}@example.com`,
        state_slug: "georgia",
        license_type_id: "ga-individual",
      }),
    });
    const staff = (await staffResp.json()) as { id: string };
    await store.logReminderSent(env.DB, firmId, staff.id, 14);
    await SELF.fetch(`${BASE}/firm/licenses/${staff.id}`, { method: "DELETE", headers: { Cookie: cookie } });

    const resp = await SELF.fetch(`${BASE}/firm/audit-trail`, { headers: { Cookie: cookie } });
    const body = (await resp.json()) as { reminders: { staff_label: string }[] };
    expect(body.reminders[0]?.staff_label).toBe("Removed staff member");
  });

  it("does not leak another firm's audit trail", async () => {
    const { cookie: cookieA, firmId: firmIdA } = await createFirmWithSession("Isolation Audit A", `isoaudita-${Date.now()}@example.com`);
    const { cookie: cookieB } = await createFirmWithSession("Isolation Audit B", `isoauditb-${Date.now()}@example.com`);
    const staffResp = await SELF.fetch(`${BASE}/firm/licenses`, {
      method: "POST",
      headers: { "content-type": "application/json", Cookie: cookieA },
      body: JSON.stringify({
        staff_label: "Firm A Staff",
        email: `firmastaff-${Date.now()}@example.com`,
        state_slug: "georgia",
        license_type_id: "ga-individual",
      }),
    });
    const staff = (await staffResp.json()) as { id: string };
    await store.logReminderSent(env.DB, firmIdA, staff.id, 60);

    const respB = await SELF.fetch(`${BASE}/firm/audit-trail`, { headers: { Cookie: cookieB } });
    const bodyB = (await respB.json()) as { activity: unknown[]; reminders: unknown[] };
    expect(bodyB.activity.length).toBe(0);
    expect(bodyB.reminders.length).toBe(0);
  });
});
