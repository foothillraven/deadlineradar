/**
 * Roadmap #151 Phase 5 (2026-08-10, "move the value line" -- the last of
 * five phases): firm-wide/admin-directed reminder digest. Modeled on
 * slack-integration.spec.ts's own "roadmap #151 value-line gate" shape for
 * the entitlement tests, and rule-change-alerts.spec.ts's PATCH-route/
 * email-injection shape for the delivery tests -- this pass combines
 * runSlackAlertPass()'s roster-scan/threshold-bundling logic with
 * runRuleChangeAlertPass()'s email-to-admin delivery mechanism.
 *
 * HELD: this feature ships in code (this test file proves it works) but the
 * worker deploy carrying it is deliberately held pending Devin's review of
 * buildAdminDigestEmail()'s actual copy (emails.ts) before its first real
 * send -- see runAdminDigestAlertPass()'s own comment at its cron call site
 * in index.ts's scheduled().
 */
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as store from "../src/store";

const BASE = "https://deadline-radar.com";
const MS_PER_DAY = 86_400_000;

async function testExecutionContext(): Promise<ExecutionContext> {
  return { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
}

async function workerFetch(request: Request, envOverrides: Record<string, unknown> = {}): Promise<Response> {
  const worker = (await import("../src/index")).default;
  return worker.fetch(request, { ...env, ...envOverrides } as never, await testExecutionContext());
}

// Roadmap #151 (2026-08-10): backdated so this file's non-#151 tests
// (PATCH-route mechanics, roster bundling, dedup, cap) keep exercising a
// firm with value-line access, not the new gate -- that gets its own
// dedicated describe block below, using a real "now" firm instead.
async function newFirm(label: string): Promise<{ firmId: string; memberId: string; adminEmail: string }> {
  const adminEmail = `${label}-${Date.now()}-${Math.floor(performance.now())}@examplefirm.com`;
  const { id: firmId, memberId } = await store.createFirm(env.DB, { name: `${label} LLP`, adminEmail });
  await env.DB.prepare("UPDATE firms SET created_at = '2020-01-01T00:00:00Z' WHERE id = ?1").bind(firmId).run();
  return { firmId, memberId, adminEmail };
}

async function sessionCookieFor(firmId: string, memberId: string): Promise<string> {
  const { rawSessionToken } = await store.createSession(env.DB, firmId, memberId);
  return `dr_firm_session=${rawSessionToken}`;
}

async function addRosterSubscriber(firmId: string, stateSlug: string, userDeadline: string) {
  return store.addPending(env.DB, {
    email: `staff-${Date.now()}-${Math.floor(performance.now())}@example.com`,
    stateSlug,
    deadlineFields: {},
    deadlineSource: store.DEADLINE_SOURCE_USER,
    userDeadline,
    firstName: null,
    firmId,
    skipConfirmation: true,
  });
}

function isoDaysFromUtcMidnight(base: Date, days: number): string {
  return new Date(base.getTime() + days * MS_PER_DAY).toISOString().slice(0, 10);
}

const RUN_BASE_MS = Date.now();
function freshAsOf(saltDays: number): Date {
  const d = new Date(RUN_BASE_MS + saltDays * MS_PER_DAY);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

describe("PATCH /firm/admin-digest", () => {
  it("401s with no session", async () => {
    const resp = await SELF.fetch(`${BASE}/firm/admin-digest`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(resp.status).toBe(401);
  });

  it("defaults to enabled for a brand-new firm", async () => {
    const { cookie } = await (async () => {
      const { firmId, memberId } = await newFirm("digest-default");
      return { cookie: await sessionCookieFor(firmId, memberId) };
    })();
    const resp = await SELF.fetch(`${BASE}/firm/licenses`, { headers: { Cookie: cookie } });
    const body = (await resp.json()) as { admin_digest_enabled: boolean };
    expect(body.admin_digest_enabled).toBe(true);
  });

  it("disables and re-enables, round-tripping through GET /firm/licenses", async () => {
    const { firmId, memberId } = await newFirm("digest-toggle");
    const cookie = await sessionCookieFor(firmId, memberId);

    const off = await SELF.fetch(`${BASE}/firm/admin-digest`, {
      method: "PATCH",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({ enabled: false }),
    });
    expect(off.status).toBe(200);
    const offBody = (await off.json()) as { admin_digest_enabled: boolean };
    expect(offBody.admin_digest_enabled).toBe(false);

    const check = await SELF.fetch(`${BASE}/firm/licenses`, { headers: { Cookie: cookie } });
    const checkBody = (await check.json()) as { admin_digest_enabled: boolean };
    expect(checkBody.admin_digest_enabled).toBe(false);

    const on = await SELF.fetch(`${BASE}/firm/admin-digest`, {
      method: "PATCH",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({ enabled: true }),
    });
    const onBody = (await on.json()) as { admin_digest_enabled: boolean };
    expect(onBody.admin_digest_enabled).toBe(true);
  });

  it("400s on a missing/invalid enabled value", async () => {
    const { firmId, memberId } = await newFirm("digest-invalid");
    const cookie = await sessionCookieFor(firmId, memberId);
    const resp = await SELF.fetch(`${BASE}/firm/admin-digest`, {
      method: "PATCH",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({ enabled: "yes" }),
    });
    expect(resp.status).toBe(400);
  });
});

describe("runAdminDigestAlertPass", () => {
  it("bundles every newly-due item across a firm's roster into ONE email, with staff names (not just states)", async () => {
    const { runAdminDigestAlertPass } = await import("../src/scheduler");
    const asOf = freshAsOf(10000);
    const { firmId, adminEmail } = await newFirm("digeste2e-bundle");
    await addRosterSubscriber(firmId, "ohio", isoDaysFromUtcMidnight(asOf, 30));
    await addRosterSubscriber(firmId, "texas", isoDaysFromUtcMidnight(asOf, 10));

    const sent: { to: string; subject: string; text: string }[] = [];
    const summary = await runAdminDigestAlertPass(env, {
      asOf,
      send: async (to, built) => {
        sent.push({ to, subject: built.subject, text: built.textBody });
        return true;
      },
    });

    expect(sent.length).toBe(1);
    expect(sent[0]!.to).toBe(adminEmail);
    expect(sent[0]!.subject).toContain("2 renewals");
    expect(sent[0]!.text).toContain("Ohio");
    expect(sent[0]!.text).toContain("Texas");
    expect(summary.digestsSent).toBe(1);
    expect(summary.itemsClaimed).toBe(2);
  });

  it("AuditLab LINK-1 (2026-08-10): the account-settings link is an absolute URL even with STATIC_SITE_BASE_URL unset (real production shape)", async () => {
    const { runAdminDigestAlertPass } = await import("../src/scheduler");
    const asOf = freshAsOf(10500);
    const { firmId, adminEmail } = await newFirm("digeste2e-link1-absolute");
    await addRosterSubscriber(firmId, "ohio", isoDaysFromUtcMidnight(asOf, 30));

    let targetHtml = "";
    await runAdminDigestAlertPass(env, {
      asOf,
      send: async (to, built) => {
        if (to === adminEmail) targetHtml = built.htmlBody;
        return true;
      },
    });

    expect(targetHtml).not.toBe("");
    const hrefs = [...targetHtml.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      expect(href).toMatch(/^https:\/\//);
    }
  });

  it("a firm with nothing newly due gets no email at all", async () => {
    const { runAdminDigestAlertPass } = await import("../src/scheduler");
    const asOf = freshAsOf(11000);
    const { firmId } = await newFirm("digeste2e-nothing");
    await addRosterSubscriber(firmId, "ohio", isoDaysFromUtcMidnight(asOf, 200)); // far out, not due

    let sends = 0;
    await runAdminDigestAlertPass(env, { asOf, send: async () => { sends += 1; return true; } });
    expect(sends).toBe(0);
  });

  it("dedup is independent of reminders_sent AND both chat channels' own dedup tables", async () => {
    const { runAdminDigestAlertPass } = await import("../src/scheduler");
    const asOf = freshAsOf(12000);
    const { firmId } = await newFirm("digeste2e-independent");
    const sub = await addRosterSubscriber(firmId, "ohio", isoDaysFromUtcMidnight(asOf, 30));
    await store.claimReminderThreshold(env.DB, sub.id, "[]", 30);
    await store.claimSlackThresholdNotification(env.DB, sub.id, 30);
    await store.claimTeamsThresholdNotification(env.DB, sub.id, 30);

    let sends = 0;
    await runAdminDigestAlertPass(env, { asOf, send: async () => { sends += 1; return true; } });
    expect(sends).toBe(1);
  });

  it("dedup: a threshold already claimed by this pass itself is excluded from a later pass", async () => {
    const { runAdminDigestAlertPass } = await import("../src/scheduler");
    const asOf = freshAsOf(13000);
    const { firmId } = await newFirm("digeste2e-race");
    const sub = await addRosterSubscriber(firmId, "ohio", isoDaysFromUtcMidnight(asOf, 30));
    await store.claimAdminDigestThresholdNotification(env.DB, sub.id, 30);

    let sends = 0;
    const summary = await runAdminDigestAlertPass(env, { asOf, send: async () => { sends += 1; return true; } });
    expect(sends).toBe(0);
    expect(summary.itemsClaimed).toBe(0);
  });

  it("skips a demo-locked firm without claiming or sending", async () => {
    const { runAdminDigestAlertPass } = await import("../src/scheduler");
    const asOf = freshAsOf(14000);
    const { firmId } = await newFirm("digeste2e-demo");
    await env.DB.prepare("UPDATE firms SET demo_locked = 1 WHERE id = ?1").bind(firmId).run();
    const sub = await addRosterSubscriber(firmId, "ohio", isoDaysFromUtcMidnight(asOf, 30));

    let sends = 0;
    await runAdminDigestAlertPass(env, { asOf, send: async () => { sends += 1; return true; } });
    expect(sends).toBe(0);
    const claimedAfter = await store.claimAdminDigestThresholdNotification(env.DB, sub.id, 30);
    expect(claimedAfter).toBe(true); // still claimable -- proves the demo-locked pass never claimed it
  });

  it("refuses a permanently-suppressed admin_email, same as runRuleChangeAlertPass()", async () => {
    const { runAdminDigestAlertPass } = await import("../src/scheduler");
    const asOf = freshAsOf(15000);
    const { firmId, adminEmail } = await newFirm("digeste2e-suppressed");
    // Suppress via the subscriber mechanism isPermanentlySuppressed() reads
    // -- same pattern rule-change-alerts.spec.ts's own equivalent test uses.
    await env.DB
      .prepare(
        `INSERT INTO subscribers (id, email, cooldown_key, state_slug, deadline_fields, status, stop_reason, stopped_at, confirm_token, unsubscribe_token, renewed_token, created_at)
         VALUES (?1, ?2, ?2, 'ohio', '{}', 'stopped', 'unsubscribed', datetime('now'), ?3, ?4, ?5, datetime('now'))`
      )
      .bind(store.newToken(), adminEmail, store.newToken(), store.newToken(), store.newToken())
      .run();
    await addRosterSubscriber(firmId, "ohio", isoDaysFromUtcMidnight(asOf, 30));

    let sends = 0;
    const summary = await runAdminDigestAlertPass(env, { asOf, send: async () => { sends += 1; return true; } });
    expect(sends).toBe(0);
    expect(summary.errors.some((e) => e.error.includes("permanently suppressed"))).toBe(true);
  });

  it("respects the firm's own reminder_thresholds override", async () => {
    const { runAdminDigestAlertPass } = await import("../src/scheduler");
    const asOf = freshAsOf(16000);
    const { firmId } = await newFirm("digeste2e-thresholds");
    await store.setReminderThresholds(env.DB, firmId, JSON.stringify([5]));
    await addRosterSubscriber(firmId, "ohio", isoDaysFromUtcMidnight(asOf, 30)); // not one of [5], no send

    let sends = 0;
    await runAdminDigestAlertPass(env, { asOf, send: async () => { sends += 1; return true; } });
    expect(sends).toBe(0);
  });

  it("the daily send cap halts the pass without erroring, and unclaims what it took", async () => {
    const { runAdminDigestAlertPass } = await import("../src/scheduler");
    const { checkAndCountAdminDigestSend } = await import("../src/sender");
    const asOf = freshAsOf(17000);
    await checkAndCountAdminDigestSend(env.DB, 1);

    const { firmId } = await newFirm("digeste2e-cap");
    const sub = await addRosterSubscriber(firmId, "ohio", isoDaysFromUtcMidnight(asOf, 30));

    let sends = 0;
    const summary = await runAdminDigestAlertPass(
      { ...env, ADMIN_DIGEST_DAILY_SEND_CAP: "1" },
      { asOf, send: async () => { sends += 1; return true; } }
    );
    expect(sends).toBe(0);
    expect(summary.errors.some((e) => e.error.includes("daily send cap"))).toBe(true);
    const claimedAfter = await store.claimAdminDigestThresholdNotification(env.DB, sub.id, 30);
    expect(claimedAfter).toBe(true); // claim was reverted, not left dangling
  });

  it("an opted-out firm (admin_digest_enabled=false) is skipped without claiming", async () => {
    const { runAdminDigestAlertPass } = await import("../src/scheduler");
    const asOf = freshAsOf(18000);
    const { firmId } = await newFirm("digeste2e-optout");
    await store.setFirmAdminDigestEnabled(env.DB, firmId, false);
    const sub = await addRosterSubscriber(firmId, "ohio", isoDaysFromUtcMidnight(asOf, 30));

    let sends = 0;
    await runAdminDigestAlertPass(env, { asOf, send: async () => { sends += 1; return true; } });
    expect(sends).toBe(0);
    const claimedAfter = await store.claimAdminDigestThresholdNotification(env.DB, sub.id, 30);
    expect(claimedAfter).toBe(true);
  });
});

/**
 * Roadmap #151 Phase 5's own gate -- same shape as slack-integration.spec.ts's
 * "roadmap #151 value-line gate" describe block, adapted for a send-time-only
 * gate (there's no connect step for this channel).
 */
describe("runAdminDigestAlertPass -- roadmap #151 value-line gate", () => {
  async function postCutoverFreeFirm(label: string): Promise<{ firmId: string; adminEmail: string }> {
    const adminEmail = `${label}-${Date.now()}-${Math.floor(performance.now())}@examplefirm.com`;
    const { id: firmId } = await store.createFirm(env.DB, { name: `${label} LLP`, adminEmail });
    return { firmId, adminEmail }; // real "now" created_at -- genuinely post-cutover
  }

  it("a post-cutover free firm is skipped", async () => {
    const { runAdminDigestAlertPass } = await import("../src/scheduler");
    const asOf = freshAsOf(19000);
    const { firmId } = await postCutoverFreeFirm("digestgate-blocked");
    await addRosterSubscriber(firmId, "ohio", isoDaysFromUtcMidnight(asOf, 30));

    let sends = 0;
    const summary = await runAdminDigestAlertPass(env, { asOf, send: async () => { sends += 1; return true; } });
    expect(sends).toBe(0);
    expect(summary.errors.some((e) => e.error.includes("value-line access"))).toBe(true);
  });

  it("a pre-cutover (grandfathered) free firm still gets the digest", async () => {
    const { runAdminDigestAlertPass } = await import("../src/scheduler");
    const asOf = freshAsOf(20000);
    const { firmId, adminEmail } = await newFirm("digestgate-grandfathered");
    await addRosterSubscriber(firmId, "ohio", isoDaysFromUtcMidnight(asOf, 30));

    const sent: string[] = [];
    await runAdminDigestAlertPass(env, { asOf, send: async (to) => { sent.push(to); return true; } });
    expect(sent).toEqual([adminEmail]);
  });

  it("a paid tier gets the digest, regardless of signup date", async () => {
    const { runAdminDigestAlertPass } = await import("../src/scheduler");
    const asOf = freshAsOf(21000);
    const { firmId, adminEmail } = await postCutoverFreeFirm("digestgate-paid");
    await env.DB.prepare("UPDATE firms SET plan_tier = 'firm_starter' WHERE id = ?1").bind(firmId).run();
    await addRosterSubscriber(firmId, "ohio", isoDaysFromUtcMidnight(asOf, 30));

    const sent: string[] = [];
    await runAdminDigestAlertPass(env, { asOf, send: async (to) => { sent.push(to); return true; } });
    expect(sent).toEqual([adminEmail]);
  });
});
