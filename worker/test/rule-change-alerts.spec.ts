/**
 * Roadmap #9/#319 (2026-08-08): proactive rule-change email alerts, scoped
 * to a firm's own roster states. Modeled on the reminder pass's own test
 * shape (worker.spec.ts's "scheduler.ts runReminderPass -- one pass") for
 * the cron pass, plus a PATCH-route describe block matching the existing
 * "POST /firm/rule-change/notify" conventions.
 */
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as store from "../src/store";
import { runRuleChangeAlertPass } from "../src/scheduler";

const BASE = "https://deadline-radar.com";

async function testExecutionContext(): Promise<ExecutionContext> {
  return { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
}

async function workerFetch(request: Request, envOverrides: Record<string, unknown> = {}): Promise<Response> {
  const worker = (await import("../src/index")).default;
  return worker.fetch(request, { ...env, ...envOverrides } as never, await testExecutionContext());
}

async function newFirmWithRosterLicense(label: string, stateSlug: string): Promise<{ firmId: string; memberId: string; adminEmail: string }> {
  const adminEmail = `${label}-${Date.now()}-${Math.floor(performance.now())}@examplefirm.com`;
  const { id: firmId, memberId } = await store.createFirm(env.DB, { name: `${label} LLP`, adminEmail });
  await env.DB.prepare(
    `INSERT INTO subscribers (id, email, cooldown_key, state_slug, deadline_fields, status, confirm_token, unsubscribe_token, renewed_token, created_at, confirmed_at, firm_id)
     VALUES (?1, ?2, ?2, ?3, '{}', 'confirmed', ?4, ?5, ?6, datetime('now'), datetime('now'), ?7)`
  )
    .bind(store.newToken(), `staff-${label}-${Date.now()}@example.com`, stateSlug, store.newToken(), store.newToken(), store.newToken(), firmId)
    .run();
  return { firmId, memberId, adminEmail };
}

async function sessionCookieFor(firmId: string, memberId: string): Promise<string> {
  const { rawSessionToken } = await store.createSession(env.DB, firmId, memberId);
  return `dr_firm_session=${rawSessionToken}`;
}

const REAL_EVENT_ID = "colorado-mobility-2026-08-12";
const REAL_EVENT_STATE = "colorado";

describe("store.findFirmsEligibleForRuleChangeAlert()", () => {
  it("includes a firm with alerts enabled and an active roster license in the event's state", async () => {
    const { firmId } = await newFirmWithRosterLicense("eligible-basic", REAL_EVENT_STATE);
    const firms = await store.findFirmsEligibleForRuleChangeAlert(env.DB, REAL_EVENT_STATE, REAL_EVENT_ID + "-basic", 500);
    expect(firms.some((f) => f.id === firmId)).toBe(true);
  });

  it("excludes a firm with alerts disabled", async () => {
    const { firmId } = await newFirmWithRosterLicense("eligible-disabled", REAL_EVENT_STATE);
    await store.setFirmRuleChangeAlertsEnabled(env.DB, firmId, false);
    const firms = await store.findFirmsEligibleForRuleChangeAlert(env.DB, REAL_EVENT_STATE, REAL_EVENT_ID + "-disabled", 500);
    expect(firms.some((f) => f.id === firmId)).toBe(false);
  });

  it("excludes a firm with no roster license in the event's state", async () => {
    const { firmId } = await newFirmWithRosterLicense("eligible-wrong-state", "texas");
    const firms = await store.findFirmsEligibleForRuleChangeAlert(env.DB, REAL_EVENT_STATE, REAL_EVENT_ID + "-wrongstate", 500);
    expect(firms.some((f) => f.id === firmId)).toBe(false);
  });

  it("excludes a firm whose only license in that state is opted out", async () => {
    const { firmId } = await newFirmWithRosterLicense("eligible-opted-out", REAL_EVENT_STATE);
    const row = await env.DB.prepare("SELECT unsubscribe_token FROM subscribers WHERE firm_id = ?1").bind(firmId).first<{ unsubscribe_token: string }>();
    await store.stop(env.DB, row!.unsubscribe_token, "unsubscribed");
    const firms = await store.findFirmsEligibleForRuleChangeAlert(env.DB, REAL_EVENT_STATE, REAL_EVENT_ID + "-optedout", 500);
    expect(firms.some((f) => f.id === firmId)).toBe(false);
  });

  it("excludes a firm already notified about that exact event_id", async () => {
    const { firmId } = await newFirmWithRosterLicense("eligible-already-notified", REAL_EVENT_STATE);
    const eventId = REAL_EVENT_ID + "-alreadynotified";
    await store.claimRuleChangeNotification(env.DB, firmId, eventId);
    const firms = await store.findFirmsEligibleForRuleChangeAlert(env.DB, REAL_EVENT_STATE, eventId, 500);
    expect(firms.some((f) => f.id === firmId)).toBe(false);
  });

  it("a firm not yet notified about a DIFFERENT event stays eligible", async () => {
    const { firmId } = await newFirmWithRosterLicense("eligible-different-event", REAL_EVENT_STATE);
    await store.claimRuleChangeNotification(env.DB, firmId, REAL_EVENT_ID + "-eventA");
    const firms = await store.findFirmsEligibleForRuleChangeAlert(env.DB, REAL_EVENT_STATE, REAL_EVENT_ID + "-eventB", 500);
    expect(firms.some((f) => f.id === firmId)).toBe(true);
  });

  it("excludes a non-active (suspended) firm", async () => {
    const { firmId } = await newFirmWithRosterLicense("eligible-suspended", REAL_EVENT_STATE);
    await env.DB.prepare("UPDATE firms SET status = 'suspended' WHERE id = ?1").bind(firmId).run();
    const firms = await store.findFirmsEligibleForRuleChangeAlert(env.DB, REAL_EVENT_STATE, REAL_EVENT_ID + "-suspended", 500);
    expect(firms.some((f) => f.id === firmId)).toBe(false);
  });
});

describe("store.claimRuleChangeNotification() / unclaim", () => {
  it("claim/unclaim dedup prevents a double-send under a simulated concurrent pass", async () => {
    const { firmId } = await newFirmWithRosterLicense("claim-race", REAL_EVENT_STATE);
    const eventId = REAL_EVENT_ID + "-race";
    const claimA = await store.claimRuleChangeNotification(env.DB, firmId, eventId);
    const claimB = await store.claimRuleChangeNotification(env.DB, firmId, eventId);
    expect(claimA).toBe(true);
    expect(claimB).toBe(false);

    await store.unclaimRuleChangeNotification(env.DB, firmId, eventId);
    const row = await env.DB.prepare("SELECT * FROM firm_rule_change_notifications WHERE firm_id = ?1 AND event_id = ?2")
      .bind(firmId, eventId)
      .first();
    expect(row).toBeNull();
  });
});

describe("runRuleChangeAlertPass() -- end to end", () => {
  it("sends exactly one alert to the firm admin for a real live event, and claims it", async () => {
    const { firmId, adminEmail } = await newFirmWithRosterLicense("e2e-basic", REAL_EVENT_STATE);
    let capturedTo = "";
    let capturedSubject = "";
    const summary = await runRuleChangeAlertPass(env, {
      send: async (to, built) => {
        if (to === adminEmail) {
          capturedTo = to;
          capturedSubject = built.subject;
        }
        return true;
      },
    });
    expect(summary.sent).toBeGreaterThan(0);
    expect(capturedTo).toBe(adminEmail);
    expect(capturedSubject).toMatch(/rule change/i);

    const row = await env.DB.prepare("SELECT * FROM firm_rule_change_notifications WHERE firm_id = ?1 AND event_id = ?2")
      .bind(firmId, REAL_EVENT_ID)
      .first();
    expect(row).not.toBeNull();
  });

  it("does not re-send on a second pass for the same firm/event", async () => {
    const { adminEmail } = await newFirmWithRosterLicense("e2e-no-resend", REAL_EVENT_STATE);
    await runRuleChangeAlertPass(env, { send: async () => true });

    let sentAgain = false;
    await runRuleChangeAlertPass(env, {
      send: async (to) => {
        if (to === adminEmail) sentAgain = true;
        return true;
      },
    });
    expect(sentAgain).toBe(false);
  });

  it("a failed send() reverts the claim so it retries next pass", async () => {
    const { firmId, adminEmail } = await newFirmWithRosterLicense("e2e-failed-send", REAL_EVENT_STATE);
    const summary = await runRuleChangeAlertPass(env, { send: async () => false });
    expect(summary.sent).toBe(0);

    const row = await env.DB.prepare("SELECT * FROM firm_rule_change_notifications WHERE firm_id = ?1 AND event_id = ?2")
      .bind(firmId, REAL_EVENT_ID)
      .first();
    expect(row).toBeNull(); // reverted, not stuck claimed with nothing sent

    let sentOnRetry = false;
    await runRuleChangeAlertPass(env, {
      send: async (to) => {
        if (to === adminEmail) sentOnRetry = true;
        return true;
      },
    });
    expect(sentOnRetry).toBe(true);
  });

  it("a demo_locked firm is skipped entirely -- no send, no claim", async () => {
    const { firmId, adminEmail } = await newFirmWithRosterLicense("e2e-demo-locked", REAL_EVENT_STATE);
    await env.DB.prepare("UPDATE firms SET demo_locked = 1 WHERE id = ?1").bind(firmId).run();

    let sent = false;
    await runRuleChangeAlertPass(env, {
      send: async (to) => {
        if (to === adminEmail) sent = true;
        return true;
      },
    });
    expect(sent).toBe(false);

    const row = await env.DB.prepare("SELECT * FROM firm_rule_change_notifications WHERE firm_id = ?1 AND event_id = ?2")
      .bind(firmId, REAL_EVENT_ID)
      .first();
    expect(row).toBeNull();
  });

  it("the daily send cap halts the pass without erroring", async () => {
    await newFirmWithRosterLicense("e2e-cap-a", REAL_EVENT_STATE);
    await newFirmWithRosterLicense("e2e-cap-b", REAL_EVENT_STATE);
    const { checkAndCountRuleChangeAlertSend } = await import("../src/sender");
    await checkAndCountRuleChangeAlertSend(env.DB, 1); // consumes the only slot for today

    let sends = 0;
    const summary = await runRuleChangeAlertPass(
      { ...env, RULE_CHANGE_ALERT_DAILY_SEND_CAP: "1" },
      {
        send: async () => {
          sends += 1;
          return true;
        },
      }
    );
    expect(sends).toBe(0);
    expect(summary.errors.some((e) => e.error.includes("daily send cap"))).toBe(true);
  });
});

describe("PATCH /firm/rule-change-alerts", () => {
  it("a partner can disable and re-enable alerts", async () => {
    const { firmId, memberId } = await newFirmWithRosterLicense("patch-toggle", "texas");
    const cookie = await sessionCookieFor(firmId, memberId);

    const off = await SELF.fetch(`${BASE}/firm/rule-change-alerts`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.250", Cookie: cookie },
      body: JSON.stringify({ enabled: false }),
    });
    expect(off.status).toBe(200);
    const offJson = (await off.json()) as { rule_change_alerts_enabled: boolean };
    expect(offJson.rule_change_alerts_enabled).toBe(false);

    const row = await env.DB.prepare("SELECT rule_change_alerts_enabled FROM firms WHERE id = ?1").bind(firmId).first<{ rule_change_alerts_enabled: number }>();
    expect(row?.rule_change_alerts_enabled).toBe(0);

    const on = await SELF.fetch(`${BASE}/firm/rule-change-alerts`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.251", Cookie: cookie },
      body: JSON.stringify({ enabled: true }),
    });
    expect(on.status).toBe(200);
  });

  it("defaults to enabled for a brand-new firm", async () => {
    const { firmId } = await newFirmWithRosterLicense("patch-default", "texas");
    const row = await env.DB.prepare("SELECT rule_change_alerts_enabled FROM firms WHERE id = ?1").bind(firmId).first<{ rule_change_alerts_enabled: number }>();
    expect(row?.rule_change_alerts_enabled).toBe(1);
  });

  it("401s with no session", async () => {
    const resp = await SELF.fetch(`${BASE}/firm/rule-change-alerts`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.252" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(resp.status).toBe(401);
  });

  it("400s on a missing/invalid enabled value", async () => {
    const { firmId, memberId } = await newFirmWithRosterLicense("patch-invalid", "texas");
    const cookie = await sessionCookieFor(firmId, memberId);
    const resp = await SELF.fetch(`${BASE}/firm/rule-change-alerts`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.253", Cookie: cookie },
      body: JSON.stringify({}),
    });
    expect(resp.status).toBe(400);
  });

  it("a Staff-role member is refused (partner/office_manager only)", async () => {
    const { firmId, memberId: partnerId } = await newFirmWithRosterLicense("patch-role-gate", "texas");
    const staffEmail = `staffer-${Date.now()}@examplefirm.com`;
    const { id: staffMemberId } = await store.createFirmMember(env.DB, { firmId, email: staffEmail, name: "Staffer", role: "staff", alreadyJoined: true });
    const cookie = await sessionCookieFor(firmId, staffMemberId);
    const resp = await SELF.fetch(`${BASE}/firm/rule-change-alerts`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.254", Cookie: cookie },
      body: JSON.stringify({ enabled: false }),
    });
    expect(resp.status).toBe(403);
    void partnerId;
  });

  it("a cross-site POST (mismatched Origin) is refused", async () => {
    const { firmId, memberId } = await newFirmWithRosterLicense("patch-csrf", "texas");
    const cookie = await sessionCookieFor(firmId, memberId);
    const resp = await workerFetch(
      new Request(`${BASE}/firm/rule-change-alerts`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "203.0.113.255",
          Cookie: cookie,
          Origin: "https://evil.example",
        },
        body: JSON.stringify({ enabled: false }),
      })
    );
    expect(resp.status).toBe(400);
  });
});
