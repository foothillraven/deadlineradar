/**
 * Roadmap #20 (2026-08-08): Slack integration for deadline alerts. Modeled
 * on rule-change-alerts.spec.ts's own shape (closest structural precedent --
 * a firm-centric cron pass plus a role-gated settings route) and
 * digest-mode.spec.ts's own asOf-uniqueness discipline (runSlackAlertPass
 * iterates every Slack-connected firm, so two tests sharing a due date can
 * sweep each other's leftover rows into the same pass -- see freshAsOf()
 * below).
 *
 * The live Slack token exchange over the network is NOT mocked here -- this
 * codebase has no fetch-injection precedent for the Google OAuth exchange
 * either (oauth.spec.ts), so exchangeSlackCode()'s actual success path stays
 * a manual/live verification step. These tests cover every path that
 * doesn't require a real network round-trip to slack.com: auth/role gates,
 * state validation, and the full runSlackAlertPass() pass via its own
 * injectable `send`.
 */
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as store from "../src/store";
import { encryptSecretAesGcm } from "../src/totp";

const BASE = "https://deadline-radar.com";
const MS_PER_DAY = 86_400_000;

// AuditLab SLACK-1 (2026-08-09): slack_webhook_url is now AES-GCM
// encrypted at rest, same posture as TOTP_ENCRYPTION_KEY tests elsewhere
// (firm-2fa.spec.ts) -- this test env's wrangler.toml deliberately doesn't
// set the real secret, so it's supplied per-call via env override.
const KEY = randomKeyBase64();

function randomKeyBase64(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Encrypts webhookUrl (contextId = firmId, same AAD convention as
 * production) and seeds a connected Slack integration for tests that don't
 * exercise the real OAuth callback. */
async function seedSlackIntegration(
  firmId: string,
  webhookUrl: string,
  extra: Partial<Omit<store.SetFirmSlackIntegrationInput, "webhookUrlEncrypted" | "webhookUrlIv">> = {}
): Promise<void> {
  const enc = await encryptSecretAesGcm(webhookUrl, firmId, KEY);
  await store.setFirmSlackIntegration(env.DB, firmId, {
    webhookUrlEncrypted: enc.ciphertextBase64,
    webhookUrlIv: enc.ivBase64,
    accessTokenEncrypted: null,
    accessTokenIv: null,
    teamName: "Acme Co",
    channelName: "general",
    ...extra,
  });
}

async function newFirm(label: string): Promise<{ firmId: string; memberId: string }> {
  const adminEmail = `${label}-${Date.now()}-${Math.floor(performance.now())}@examplefirm.com`;
  const { id: firmId, memberId } = await store.createFirm(env.DB, { name: `${label} LLP`, adminEmail });
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

// Same reasoning as digest-mode.spec.ts's own freshAsOf(): runSlackAlertPass
// iterates EVERY Slack-connected firm in the table, so tests sharing a due
// date can sweep each other's leftover rows into the same pass. Each test
// below gets its own asOf far enough apart that no other test's due date can
// ever land on the same calendar day, within one run and across repeats.
const RUN_BASE_MS = Date.now();
function freshAsOf(saltDays: number): Date {
  const d = new Date(RUN_BASE_MS + saltDays * MS_PER_DAY);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

describe("GET /firm/integrations/slack/connect", () => {
  it("404s when Slack isn't configured (no client id/secret)", async () => {
    const { firmId, memberId } = await newFirm("slackconnect-unconfigured");
    const resp = await SELF.fetch(`${BASE}/firm/integrations/slack/connect`, {
      headers: { Cookie: await sessionCookieFor(firmId, memberId) },
      redirect: "manual",
    });
    expect(resp.status).toBe(404);
  });

  it("401s with no session, even when configured", async () => {
    const worker = (await import("../src/index")).default;
    const resp = await worker.fetch(
      new Request(`${BASE}/firm/integrations/slack/connect`),
      { ...env, SLACK_OAUTH_CLIENT_ID: "test-client-id", SLACK_OAUTH_CLIENT_SECRET: "test-secret" } as never,
      { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext
    );
    expect(resp.status).toBe(401);
  });

  it("redirects to Slack's authorize URL with the right scope and a handshake cookie, when configured", async () => {
    const { firmId, memberId } = await newFirm("slackconnect-ok");
    const worker = (await import("../src/index")).default;
    const resp = await worker.fetch(
      new Request(`${BASE}/firm/integrations/slack/connect`, {
        headers: { Cookie: await sessionCookieFor(firmId, memberId) },
      }),
      { ...env, SLACK_OAUTH_CLIENT_ID: "test-client-id", SLACK_OAUTH_CLIENT_SECRET: "test-secret" } as never,
      { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext
    );
    expect(resp.status).toBe(302);
    const location = resp.headers.get("Location") ?? "";
    expect(location).toContain("https://slack.com/oauth/v2/authorize");
    expect(location).toContain("scope=incoming-webhook");
    expect(location).toContain("client_id=test-client-id");
    expect(location).toContain(encodeURIComponent("/firm/integrations/slack/callback"));
    expect(resp.headers.get("Set-Cookie") ?? "").toContain("dr_oauth_handshake=");
  });
});

describe("GET /firm/integrations/slack/callback", () => {
  async function callbackFetch(qs: string, cookie: string | null): Promise<Response> {
    const worker = (await import("../src/index")).default;
    const headers: Record<string, string> = {};
    if (cookie) headers.Cookie = cookie;
    return worker.fetch(
      new Request(`${BASE}/firm/integrations/slack/callback${qs}`, { headers }),
      { ...env, SLACK_OAUTH_CLIENT_ID: "test-client-id", SLACK_OAUTH_CLIENT_SECRET: "test-secret" } as never,
      { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext
    );
  }

  it("404s when Slack isn't configured", async () => {
    const resp = await SELF.fetch(`${BASE}/firm/integrations/slack/callback?code=x&state=y`, { redirect: "manual" });
    expect(resp.status).toBe(404);
  });

  it("401s with no session", async () => {
    const resp = await callbackFetch("?code=x&state=y", null);
    expect(resp.status).toBe(401);
  });

  it("redirects with slack_connect_failed=declined when Slack reports an error", async () => {
    const { firmId, memberId } = await newFirm("slackcb-declined");
    const resp = await callbackFetch("?error=access_denied", await sessionCookieFor(firmId, memberId));
    expect(resp.status).toBe(302);
    expect(resp.headers.get("Location")).toContain("slack_connect_failed=declined");
  });

  it("redirects with slack_connect_failed=invalid when code or state is missing", async () => {
    const { firmId, memberId } = await newFirm("slackcb-missing");
    const cookie = await sessionCookieFor(firmId, memberId);
    const resp = await callbackFetch("?code=onlycode", cookie);
    expect(resp.status).toBe(302);
    expect(resp.headers.get("Location")).toContain("slack_connect_failed=invalid");
  });

  it("redirects with slack_connect_failed=invalid for an unrecognized state", async () => {
    const { firmId, memberId } = await newFirm("slackcb-badstate");
    const resp = await callbackFetch("?code=x&state=not-a-real-state", await sessionCookieFor(firmId, memberId));
    expect(resp.status).toBe(302);
    expect(resp.headers.get("Location")).toContain("slack_connect_failed=invalid");
  });

  it("redirects with slack_connect_failed=invalid when the state was opened for a different provider", async () => {
    const { firmId, memberId } = await newFirm("slackcb-wrongprovider");
    const { rawState } = await store.createOauthState(env.DB, "google");
    const resp = await callbackFetch(`?code=x&state=${encodeURIComponent(rawState)}`, await sessionCookieFor(firmId, memberId));
    expect(resp.status).toBe(302);
    expect(resp.headers.get("Location")).toContain("slack_connect_failed=invalid");
  });
});

describe("POST /firm/integrations/slack/disconnect", () => {
  it("401s with no session", async () => {
    const resp = await SELF.fetch(`${BASE}/firm/integrations/slack/disconnect`, { method: "POST" });
    expect(resp.status).toBe(401);
  });

  it("clears every slack_* column and reports disconnected", async () => {
    const { firmId, memberId } = await newFirm("slackdc-ok");
    await seedSlackIntegration(firmId, "https://hooks.slack.com/services/T000/B000/xxx");

    const resp = await SELF.fetch(`${BASE}/firm/integrations/slack/disconnect`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.10", Cookie: await sessionCookieFor(firmId, memberId) },
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { slack_connected: boolean };
    expect(body.slack_connected).toBe(false);

    const row = await env.DB
      .prepare(`SELECT slack_webhook_url, slack_access_token_encrypted, slack_team_name, slack_channel_name FROM firms WHERE id = ?1`)
      .bind(firmId)
      .first<{ slack_webhook_url: string | null; slack_access_token_encrypted: string | null; slack_team_name: string | null; slack_channel_name: string | null }>();
    expect(row?.slack_webhook_url).toBeNull();
    expect(row?.slack_access_token_encrypted).toBeNull();
    expect(row?.slack_team_name).toBeNull();
    expect(row?.slack_channel_name).toBeNull();
  });

  it("is a harmless no-op when nothing was connected", async () => {
    const { firmId, memberId } = await newFirm("slackdc-noop");
    const resp = await SELF.fetch(`${BASE}/firm/integrations/slack/disconnect`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.11", Cookie: await sessionCookieFor(firmId, memberId) },
    });
    expect(resp.status).toBe(200);
  });
});

describe("GET /firm/licenses bootstrap -- slack_connected fields", () => {
  it("reports connected status and display fields, never the webhook url or token", async () => {
    const { firmId, memberId } = await newFirm("slackboot-ok");
    await seedSlackIntegration(firmId, "https://hooks.slack.com/services/T000/B000/xxx", {
      accessTokenEncrypted: "ciphertext",
      accessTokenIv: "iv",
    });
    const resp = await SELF.fetch(`${BASE}/firm/licenses`, {
      headers: { Cookie: await sessionCookieFor(firmId, memberId) },
    });
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.slack_connected).toBe(true);
    expect(body.slack_team_name).toBe("Acme Co");
    expect(body.slack_channel_name).toBe("general");
    expect(JSON.stringify(body)).not.toContain("hooks.slack.com");
    expect(JSON.stringify(body)).not.toContain("ciphertext");
  });
});

describe("runSlackAlertPass", () => {
  it("bundles every newly-due item across a firm's roster into ONE message", async () => {
    const { runSlackAlertPass } = await import("../src/scheduler");
    const asOf = freshAsOf(1000);
    const { firmId } = await newFirm("slacke2e-bundle");
    await seedSlackIntegration(firmId, "https://hooks.slack.com/services/T000/B000/bundle", {
      teamName: "Bundle Co",
      channelName: "alerts",
    });
    const due = isoDaysFromUtcMidnight(asOf, 30);
    await addRosterSubscriber(firmId, "ohio", due);
    await addRosterSubscriber(firmId, "texas", due);

    const posted: { webhookUrl: string; text: string }[] = [];
    const summary = await runSlackAlertPass({ ...env, TOTP_ENCRYPTION_KEY: KEY }, {
      asOf,
      send: async (webhookUrl, text) => {
        posted.push({ webhookUrl, text });
        return true;
      },
    });

    expect(posted.length).toBe(1);
    expect(posted[0]!.webhookUrl).toBe("https://hooks.slack.com/services/T000/B000/bundle");
    expect(posted[0]!.text).toContain("Ohio");
    expect(posted[0]!.text).toContain("Texas");
    expect(posted[0]!.text).toContain("2 renewals");
    expect(summary.digestsSent).toBe(1);
    expect(summary.itemsClaimed).toBe(2);
  });

  it("a firm with no Slack connected is completely untouched", async () => {
    const { runSlackAlertPass } = await import("../src/scheduler");
    const asOf = freshAsOf(2000);
    const { firmId } = await newFirm("slacke2e-noconnect");
    await addRosterSubscriber(firmId, "ohio", isoDaysFromUtcMidnight(asOf, 30));

    let posts = 0;
    await runSlackAlertPass({ ...env, TOTP_ENCRYPTION_KEY: KEY }, { asOf, send: async () => { posts += 1; return true; } });
    // Not scoped to summary.firmsChecked === 0 -- other tests in this file
    // (or a shared test DB) may have connected other firms; this firm's own
    // roster item is what must never be posted, checked via `posts` above
    // combined with the unique-per-test asOf (freshAsOf()) that guarantees
    // no other firm's due date can land on 2026-scale-plus-2000-days today.
    expect(posts).toBe(0);
  });

  it("nothing newly due -- no message sent", async () => {
    const { runSlackAlertPass } = await import("../src/scheduler");
    const asOf = freshAsOf(3000);
    const { firmId } = await newFirm("slacke2e-quiet");
    await seedSlackIntegration(firmId, "https://hooks.slack.com/services/T000/B000/quiet", {
      teamName: "Quiet Co",
      channelName: "alerts",
    });
    await addRosterSubscriber(firmId, "ohio", isoDaysFromUtcMidnight(asOf, 90)); // outside every threshold

    let posts = 0;
    await runSlackAlertPass({ ...env, TOTP_ENCRYPTION_KEY: KEY }, { asOf, send: async () => { posts += 1; return true; } });
    expect(posts).toBe(0);
  });

  it("dedup: an item already claimed by a concurrent pass is excluded", async () => {
    const { runSlackAlertPass } = await import("../src/scheduler");
    const asOf = freshAsOf(4000);
    const { firmId } = await newFirm("slacke2e-race");
    await seedSlackIntegration(firmId, "https://hooks.slack.com/services/T000/B000/race", {
      teamName: "Race Co",
      channelName: "alerts",
    });
    const sub = await addRosterSubscriber(firmId, "ohio", isoDaysFromUtcMidnight(asOf, 30));
    const claimed = await store.claimSlackThresholdNotification(env.DB, sub.id, 30);
    expect(claimed).toBe(true);

    let posts = 0;
    const summary = await runSlackAlertPass({ ...env, TOTP_ENCRYPTION_KEY: KEY }, { asOf, send: async () => { posts += 1; return true; } });
    expect(posts).toBe(0);
    expect(summary.itemsClaimed).toBe(0);
  });

  it("a threshold already claimed for EMAIL (reminders_sent) is still independently eligible for Slack", async () => {
    const { runSlackAlertPass } = await import("../src/scheduler");
    const asOf = freshAsOf(5000);
    const { firmId } = await newFirm("slacke2e-independent");
    await seedSlackIntegration(firmId, "https://hooks.slack.com/services/T000/B000/indep", {
      teamName: "Indep Co",
      channelName: "alerts",
    });
    const sub = await addRosterSubscriber(firmId, "ohio", isoDaysFromUtcMidnight(asOf, 30));
    // Already claimed on the EMAIL side -- must not block the Slack side.
    const emailClaimed = await store.claimReminderThreshold(env.DB, sub.id, "[]", 30);
    expect(emailClaimed).toBe(true);

    let posts = 0;
    await runSlackAlertPass({ ...env, TOTP_ENCRYPTION_KEY: KEY }, { asOf, send: async () => { posts += 1; return true; } });
    expect(posts).toBe(1);
  });

  it("skips a demo-locked firm without claiming or posting", async () => {
    const { runSlackAlertPass } = await import("../src/scheduler");
    const asOf = freshAsOf(6000);
    const { firmId } = await newFirm("slacke2e-demo");
    await env.DB.prepare(`UPDATE firms SET demo_locked = 1 WHERE id = ?1`).bind(firmId).run();
    await seedSlackIntegration(firmId, "https://hooks.slack.com/services/T000/B000/demo", {
      teamName: "Demo Co",
      channelName: "alerts",
    });
    const sub = await addRosterSubscriber(firmId, "ohio", isoDaysFromUtcMidnight(asOf, 30));

    let posts = 0;
    const summary = await runSlackAlertPass({ ...env, TOTP_ENCRYPTION_KEY: KEY }, { asOf, send: async () => { posts += 1; return true; } });
    expect(posts).toBe(0);
    expect(summary.digestsSent).toBe(0);
    const row = await env.DB.prepare(`SELECT reminders_sent FROM subscribers WHERE id = ?1`).bind(sub.id).first<{ reminders_sent: string }>();
    // demo_locked check happens before claiming -- reminders_sent is a
    // different lifecycle, but firm_slack_notified_thresholds should be
    // untouched too.
    expect(row).toBeTruthy();
    const claimedAfter = await store.claimSlackThresholdNotification(env.DB, sub.id, 30);
    expect(claimedAfter).toBe(true); // still claimable -- proves the demo-locked pass never claimed it
  });

  it("respects the firm's own reminder_thresholds override", async () => {
    const { runSlackAlertPass } = await import("../src/scheduler");
    const asOf = freshAsOf(7000);
    const { firmId } = await newFirm("slacke2e-thresholds");
    await store.setReminderThresholds(env.DB, firmId, JSON.stringify([1])); // only the final-day tier
    await seedSlackIntegration(firmId, "https://hooks.slack.com/services/T000/B000/thresh", {
      teamName: "Thresh Co",
      channelName: "alerts",
    });
    // 7 days out would fire under the default cadence, but not under [1].
    await addRosterSubscriber(firmId, "ohio", isoDaysFromUtcMidnight(asOf, 7));

    let posts = 0;
    await runSlackAlertPass({ ...env, TOTP_ENCRYPTION_KEY: KEY }, { asOf, send: async () => { posts += 1; return true; } });
    expect(posts).toBe(0);
  });

  it("the daily send cap halts the pass without erroring, and unclaims what it took", async () => {
    const { runSlackAlertPass } = await import("../src/scheduler");
    const { checkAndCountSlackAlertSend } = await import("../src/sender");
    const asOf = freshAsOf(8000);
    await checkAndCountSlackAlertSend(env.DB, 1); // consumes the only slot for today

    const { firmId } = await newFirm("slacke2e-cap");
    await seedSlackIntegration(firmId, "https://hooks.slack.com/services/T000/B000/cap", {
      teamName: "Cap Co",
      channelName: "alerts",
    });
    const sub = await addRosterSubscriber(firmId, "ohio", isoDaysFromUtcMidnight(asOf, 30));

    let posts = 0;
    const summary = await runSlackAlertPass(
      { ...env, TOTP_ENCRYPTION_KEY: KEY, SLACK_ALERT_DAILY_SEND_CAP: "1" },
      { asOf, send: async () => { posts += 1; return true; } }
    );
    expect(posts).toBe(0);
    expect(summary.errors.some((e) => e.error.includes("daily send cap"))).toBe(true);

    const claimedAfter = await store.claimSlackThresholdNotification(env.DB, sub.id, 30);
    expect(claimedAfter).toBe(true); // claim was reverted, not left dangling
  });
});
