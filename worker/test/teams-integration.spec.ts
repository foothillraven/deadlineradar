/**
 * Roadmap #21 (2026-08-08): Microsoft Teams integration for deadline
 * alerts. Modeled on slack-integration.spec.ts's own shape, minus the
 * OAuth-route tests -- there is no OAuth flow here (see teams.ts's own
 * docstring for why Office 365 Connectors' retirement forced the
 * paste-a-webhook-URL design instead of Slack's "Add to Slack" button).
 * Same freshAsOf()-per-test discipline as slack-integration.spec.ts/
 * digest-mode.spec.ts to avoid cross-test date collisions, since
 * runTeamsAlertPass() iterates every Teams-connected firm in the table.
 */
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as store from "../src/store";
import { isTeamsWebhookUrl } from "../src/teams";
import { encryptSecretAesGcm } from "../src/totp";

const BASE = "https://deadline-radar.com";
const MS_PER_DAY = 86_400_000;
const REAL_WEBHOOK_URL = "https://contoso.webhook.office.com/webhookb2/abc-123";

// AuditLab SLACK-1 (extends to Teams, 2026-08-09): teams_webhook_url is now
// AES-GCM encrypted at rest -- same per-call env override as
// slack-integration.spec.ts's own KEY, since this test env's wrangler.toml
// deliberately doesn't set the real TOTP_ENCRYPTION_KEY secret.
const KEY = randomKeyBase64();

function randomKeyBase64(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function seedTeamsWebhook(firmId: string, webhookUrl: string = REAL_WEBHOOK_URL): Promise<void> {
  const enc = await encryptSecretAesGcm(webhookUrl, firmId, KEY);
  await store.setFirmTeamsWebhook(env.DB, firmId, enc.ciphertextBase64, enc.ivBase64);
}

function testExecutionContext(): ExecutionContext {
  return { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
}

/** Direct worker.fetch() with env overrides, not SELF.fetch() -- needed for
 * PATCH /firm/integrations/teams' success path since TOTP_ENCRYPTION_KEY is
 * a real deploy secret this test env's wrangler.toml doesn't set. Same
 * pattern as billing.spec.ts's own workerFetch() for STRIPE_SECRET_KEY. */
async function workerFetch(request: Request, envOverrides: Record<string, unknown> = {}): Promise<Response> {
  const worker = (await import("../src/index")).default;
  return worker.fetch(request, { ...env, ...envOverrides } as never, testExecutionContext());
}

// Roadmap #151 Phase 3 (2026-08-10): backdated so this file's existing
// tests keep testing webhook mechanics/alert-pass logic, not the new
// value-line gate -- that gets its own dedicated describe block below.
async function newFirm(label: string): Promise<{ firmId: string; memberId: string }> {
  const adminEmail = `${label}-${Date.now()}-${Math.floor(performance.now())}@examplefirm.com`;
  const { id: firmId, memberId } = await store.createFirm(env.DB, { name: `${label} LLP`, adminEmail });
  await env.DB.prepare("UPDATE firms SET created_at = '2020-01-01T00:00:00Z' WHERE id = ?1").bind(firmId).run();
  return { firmId, memberId };
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

describe("isTeamsWebhookUrl", () => {
  it("accepts a real workflow webhook URL", () => {
    expect(isTeamsWebhookUrl(REAL_WEBHOOK_URL)).toBe(true);
    expect(isTeamsWebhookUrl("https://contoso.logic.azure.com/workflows/abc")).toBe(true);
  });

  it("rejects http:// (non-https)", () => {
    expect(isTeamsWebhookUrl("http://contoso.webhook.office.com/webhookb2/abc")).toBe(false);
  });

  it("rejects an arbitrary, non-Microsoft host -- the actual SSRF guard", () => {
    expect(isTeamsWebhookUrl("https://evil.example.com/webhookb2/abc")).toBe(false);
    expect(isTeamsWebhookUrl("https://webhook.office.com.evil.example.com/x")).toBe(false);
  });

  it("rejects a private/internal host", () => {
    expect(isTeamsWebhookUrl("https://169.254.169.254/latest/meta-data")).toBe(false);
    expect(isTeamsWebhookUrl("https://localhost/x")).toBe(false);
    expect(isTeamsWebhookUrl("https://internal-service/x")).toBe(false);
  });

  it("rejects a malformed URL", () => {
    expect(isTeamsWebhookUrl("not a url")).toBe(false);
    expect(isTeamsWebhookUrl("")).toBe(false);
  });
});

describe("PATCH /firm/integrations/teams", () => {
  it("401s with no session", async () => {
    const resp = await SELF.fetch(`${BASE}/firm/integrations/teams`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ webhook_url: REAL_WEBHOOK_URL }),
    });
    expect(resp.status).toBe(401);
  });

  it("sets a valid webhook URL, encrypted at rest, and reports connected", async () => {
    const { firmId, memberId } = await newFirm("teamspatch-ok");
    const resp = await workerFetch(
      new Request(`${BASE}/firm/integrations/teams`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.20", Cookie: await sessionCookieFor(firmId, memberId) },
        body: JSON.stringify({ webhook_url: REAL_WEBHOOK_URL }),
      }),
      { TOTP_ENCRYPTION_KEY: KEY }
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { teams_connected: boolean };
    expect(body.teams_connected).toBe(true);

    // AuditLab SLACK-1: ciphertext at rest, not the plaintext URL -- and it
    // decrypts back to exactly what was sent.
    const row = await env.DB
      .prepare(`SELECT teams_webhook_url, teams_webhook_url_iv FROM firms WHERE id = ?1`)
      .bind(firmId)
      .first<{ teams_webhook_url: string | null; teams_webhook_url_iv: string | null }>();
    expect(row?.teams_webhook_url).not.toBe(REAL_WEBHOOK_URL);
    expect(row?.teams_webhook_url_iv).toBeTruthy();
    const { decryptSecretAesGcm } = await import("../src/totp");
    const decrypted = await decryptSecretAesGcm(row!.teams_webhook_url!, row!.teams_webhook_url_iv!, firmId, KEY);
    expect(decrypted).toBe(REAL_WEBHOOK_URL);
  });

  it("503s (fails closed) when TOTP_ENCRYPTION_KEY isn't configured -- never stores plaintext", async () => {
    const { firmId, memberId } = await newFirm("teamspatch-nokey");
    const resp = await workerFetch(
      new Request(`${BASE}/firm/integrations/teams`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.23", Cookie: await sessionCookieFor(firmId, memberId) },
        body: JSON.stringify({ webhook_url: REAL_WEBHOOK_URL }),
      }),
      { TOTP_ENCRYPTION_KEY: undefined }
    );
    expect(resp.status).toBe(503);
    const row = await env.DB.prepare(`SELECT teams_webhook_url FROM firms WHERE id = ?1`).bind(firmId).first<{ teams_webhook_url: string | null }>();
    expect(row?.teams_webhook_url).toBeNull();
  });

  it("400s on an invalid/non-Microsoft URL and stores nothing", async () => {
    const { firmId, memberId } = await newFirm("teamspatch-bad");
    const resp = await SELF.fetch(`${BASE}/firm/integrations/teams`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.21", Cookie: await sessionCookieFor(firmId, memberId) },
      body: JSON.stringify({ webhook_url: "https://evil.example.com/x" }),
    });
    expect(resp.status).toBe(400);
    const row = await env.DB.prepare(`SELECT teams_webhook_url FROM firms WHERE id = ?1`).bind(firmId).first<{ teams_webhook_url: string | null }>();
    expect(row?.teams_webhook_url).toBeNull();
  });

  it("clears via webhook_url: null", async () => {
    const { firmId, memberId } = await newFirm("teamspatch-clear");
    await seedTeamsWebhook(firmId);
    const resp = await SELF.fetch(`${BASE}/firm/integrations/teams`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.22", Cookie: await sessionCookieFor(firmId, memberId) },
      body: JSON.stringify({ webhook_url: null }),
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { teams_connected: boolean };
    expect(body.teams_connected).toBe(false);
    const row = await env.DB.prepare(`SELECT teams_webhook_url FROM firms WHERE id = ?1`).bind(firmId).first<{ teams_webhook_url: string | null }>();
    expect(row?.teams_webhook_url).toBeNull();
  });
});

describe("GET /firm/licenses bootstrap -- teams_connected field", () => {
  it("reports connected status, never the webhook url itself", async () => {
    const { firmId, memberId } = await newFirm("teamsboot-ok");
    await seedTeamsWebhook(firmId);
    const resp = await SELF.fetch(`${BASE}/firm/licenses`, {
      headers: { Cookie: await sessionCookieFor(firmId, memberId) },
    });
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.teams_connected).toBe(true);
    expect(JSON.stringify(body)).not.toContain("webhook.office.com");
  });
});

describe("runTeamsAlertPass", () => {
  it("bundles every newly-due item across a firm's roster into ONE message", async () => {
    const { runTeamsAlertPass } = await import("../src/scheduler");
    const asOf = freshAsOf(1000);
    const { firmId } = await newFirm("teamse2e-bundle");
    await seedTeamsWebhook(firmId);
    const due = isoDaysFromUtcMidnight(asOf, 30);
    await addRosterSubscriber(firmId, "ohio", due);
    await addRosterSubscriber(firmId, "texas", due);

    const posted: { webhookUrl: string; text: string }[] = [];
    const summary = await runTeamsAlertPass({ ...env, TOTP_ENCRYPTION_KEY: KEY }, {
      asOf,
      send: async (webhookUrl, text) => {
        posted.push({ webhookUrl, text });
        return true;
      },
    });

    expect(posted.length).toBe(1);
    expect(posted[0]!.webhookUrl).toBe(REAL_WEBHOOK_URL);
    expect(posted[0]!.text).toContain("Ohio");
    expect(posted[0]!.text).toContain("Texas");
    expect(posted[0]!.text).toContain("2 renewals");
    expect(summary.digestsSent).toBe(1);
    expect(summary.itemsClaimed).toBe(2);
  });

  it("a firm with no Teams connected is completely untouched", async () => {
    const { runTeamsAlertPass } = await import("../src/scheduler");
    const asOf = freshAsOf(2000);
    const { firmId } = await newFirm("teamse2e-noconnect");
    await addRosterSubscriber(firmId, "ohio", isoDaysFromUtcMidnight(asOf, 30));

    let posts = 0;
    await runTeamsAlertPass({ ...env, TOTP_ENCRYPTION_KEY: KEY }, { asOf, send: async () => { posts += 1; return true; } });
    expect(posts).toBe(0);
  });

  it("nothing newly due -- no message sent", async () => {
    const { runTeamsAlertPass } = await import("../src/scheduler");
    const asOf = freshAsOf(3000);
    const { firmId } = await newFirm("teamse2e-quiet");
    await seedTeamsWebhook(firmId);
    await addRosterSubscriber(firmId, "ohio", isoDaysFromUtcMidnight(asOf, 90));

    let posts = 0;
    await runTeamsAlertPass({ ...env, TOTP_ENCRYPTION_KEY: KEY }, { asOf, send: async () => { posts += 1; return true; } });
    expect(posts).toBe(0);
  });

  it("dedup: an item already claimed by a concurrent pass is excluded", async () => {
    const { runTeamsAlertPass } = await import("../src/scheduler");
    const asOf = freshAsOf(4000);
    const { firmId } = await newFirm("teamse2e-race");
    await seedTeamsWebhook(firmId);
    const sub = await addRosterSubscriber(firmId, "ohio", isoDaysFromUtcMidnight(asOf, 30));
    const claimed = await store.claimTeamsThresholdNotification(env.DB, sub.id, 30);
    expect(claimed).toBe(true);

    let posts = 0;
    const summary = await runTeamsAlertPass({ ...env, TOTP_ENCRYPTION_KEY: KEY }, { asOf, send: async () => { posts += 1; return true; } });
    expect(posts).toBe(0);
    expect(summary.itemsClaimed).toBe(0);
  });

  it("independent of BOTH email (reminders_sent) and Slack's own dedup table", async () => {
    const { runTeamsAlertPass } = await import("../src/scheduler");
    const asOf = freshAsOf(5000);
    const { firmId } = await newFirm("teamse2e-independent");
    await seedTeamsWebhook(firmId);
    const sub = await addRosterSubscriber(firmId, "ohio", isoDaysFromUtcMidnight(asOf, 30));
    const emailClaimed = await store.claimReminderThreshold(env.DB, sub.id, "[]", 30);
    expect(emailClaimed).toBe(true);
    const slackClaimed = await store.claimSlackThresholdNotification(env.DB, sub.id, 30);
    expect(slackClaimed).toBe(true);

    let posts = 0;
    await runTeamsAlertPass({ ...env, TOTP_ENCRYPTION_KEY: KEY }, { asOf, send: async () => { posts += 1; return true; } });
    expect(posts).toBe(1);
  });

  it("skips a demo-locked firm without claiming or posting", async () => {
    const { runTeamsAlertPass } = await import("../src/scheduler");
    const asOf = freshAsOf(6000);
    const { firmId } = await newFirm("teamse2e-demo");
    await env.DB.prepare(`UPDATE firms SET demo_locked = 1 WHERE id = ?1`).bind(firmId).run();
    await seedTeamsWebhook(firmId);
    const sub = await addRosterSubscriber(firmId, "ohio", isoDaysFromUtcMidnight(asOf, 30));

    let posts = 0;
    const summary = await runTeamsAlertPass({ ...env, TOTP_ENCRYPTION_KEY: KEY }, { asOf, send: async () => { posts += 1; return true; } });
    expect(posts).toBe(0);
    expect(summary.digestsSent).toBe(0);
    const claimedAfter = await store.claimTeamsThresholdNotification(env.DB, sub.id, 30);
    expect(claimedAfter).toBe(true); // still claimable -- proves the demo-locked pass never claimed it
  });

  it("respects the firm's own reminder_thresholds override", async () => {
    const { runTeamsAlertPass } = await import("../src/scheduler");
    const asOf = freshAsOf(7000);
    const { firmId } = await newFirm("teamse2e-thresholds");
    await store.setReminderThresholds(env.DB, firmId, JSON.stringify([1]));
    await seedTeamsWebhook(firmId);
    await addRosterSubscriber(firmId, "ohio", isoDaysFromUtcMidnight(asOf, 7));

    let posts = 0;
    await runTeamsAlertPass({ ...env, TOTP_ENCRYPTION_KEY: KEY }, { asOf, send: async () => { posts += 1; return true; } });
    expect(posts).toBe(0);
  });

  it("the daily send cap halts the pass without erroring, and unclaims what it took", async () => {
    const { runTeamsAlertPass } = await import("../src/scheduler");
    const { checkAndCountTeamsAlertSend } = await import("../src/sender");
    const asOf = freshAsOf(8000);
    await checkAndCountTeamsAlertSend(env.DB, 1);

    const { firmId } = await newFirm("teamse2e-cap");
    await seedTeamsWebhook(firmId);
    const sub = await addRosterSubscriber(firmId, "ohio", isoDaysFromUtcMidnight(asOf, 30));

    let posts = 0;
    const summary = await runTeamsAlertPass(
      { ...env, TEAMS_ALERT_DAILY_SEND_CAP: "1" },
      { asOf, send: async () => { posts += 1; return true; } }
    );
    expect(posts).toBe(0);
    expect(summary.errors.some((e) => e.error.includes("daily send cap"))).toBe(true);

    const claimedAfter = await store.claimTeamsThresholdNotification(env.DB, sub.id, 30);
    expect(claimedAfter).toBe(true);
  });
});

/**
 * Roadmap #151 Phase 3 (2026-08-10): same shape as slack-integration.spec.ts's
 * own "roadmap #151 value-line gate" describe block -- connect-time (SETTING
 * a webhook, not clearing one) plus the send-time downgrade-after-connect
 * closure.
 */
describe("Teams -- roadmap #151 value-line gate", () => {
  async function postCutoverFreeFirm(label: string): Promise<{ firmId: string; memberId: string }> {
    const adminEmail = `${label}-${Date.now()}-${Math.floor(performance.now())}@examplefirm.com`;
    const { id: firmId, memberId } = await store.createFirm(env.DB, { name: `${label} LLP`, adminEmail });
    return { firmId, memberId }; // real "now" created_at -- genuinely post-cutover
  }

  it("a post-cutover free firm is refused when SETTING a webhook", async () => {
    const { firmId, memberId } = await postCutoverFreeFirm("teamsgate-connect");
    const resp = await workerFetch(
      new Request(`${BASE}/firm/integrations/teams`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.21", Cookie: await sessionCookieFor(firmId, memberId) },
        body: JSON.stringify({ webhook_url: REAL_WEBHOOK_URL }),
      }),
      { TOTP_ENCRYPTION_KEY: KEY }
    );
    expect(resp.status).toBe(403);
  });

  it("clearing a webhook (webhook_url: null) is NEVER gated, even for a post-cutover free firm", async () => {
    const { firmId, memberId } = await postCutoverFreeFirm("teamsgate-clear");
    const resp = await workerFetch(
      new Request(`${BASE}/firm/integrations/teams`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.22", Cookie: await sessionCookieFor(firmId, memberId) },
        body: JSON.stringify({ webhook_url: null }),
      }),
      { TOTP_ENCRYPTION_KEY: KEY }
    );
    expect(resp.status).toBe(200);
  });

  it("a pre-cutover (grandfathered) free firm can still set a webhook", async () => {
    const { firmId, memberId } = await newFirm("teamsgate-grandfathered");
    const resp = await workerFetch(
      new Request(`${BASE}/firm/integrations/teams`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.23", Cookie: await sessionCookieFor(firmId, memberId) },
        body: JSON.stringify({ webhook_url: REAL_WEBHOOK_URL }),
      }),
      { TOTP_ENCRYPTION_KEY: KEY }
    );
    expect(resp.status).toBe(200);
  });

  it("send-time gate closes the downgrade-after-connect gap", async () => {
    const asOf = freshAsOf(8100);
    const { firmId } = await newFirm("teamsgate-downgrade"); // pre-cutover by construction
    await env.DB.prepare("UPDATE firms SET plan_tier = 'firm_starter' WHERE id = ?1").bind(firmId).run();
    await seedTeamsWebhook(firmId);
    const future = new Date(Date.now() + 86_400_000).toISOString();
    await env.DB.prepare("UPDATE firms SET plan_tier = 'free', created_at = ?1 WHERE id = ?2").bind(future, firmId).run();

    await addRosterSubscriber(firmId, "ohio", isoDaysFromUtcMidnight(asOf, 30));

    const { runTeamsAlertPass } = await import("../src/scheduler");
    let posts = 0;
    const summary = await runTeamsAlertPass(
      { ...env, TOTP_ENCRYPTION_KEY: KEY },
      { asOf, send: async () => { posts += 1; return true; } }
    );
    expect(posts).toBe(0);
    expect(summary.errors.some((e) => e.error.includes("value-line access"))).toBe(true);
  });
});
