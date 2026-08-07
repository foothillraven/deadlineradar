/**
 * Roadmap #19 (2026-08-07): white-label reminder emails, lightweight scope
 * (Devin's decision, asked directly) -- firm name shown in a firm-tracked
 * subscriber's reminder body, plus an optional firm-set reply-to. No sending-
 * domain/logo changes -- see migration 0038's own docstring for the full
 * scope boundary.
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

describe("buildReminderEmail() firm attribution", () => {
  it("includes a firm-attribution line when firmName is given", async () => {
    const { buildReminderEmail } = await import("../src/emails");
    const built = buildReminderEmail(
      "Georgia", "2027-01-01", 30, 30,
      "https://example.com/next", "https://example.com/stop", "https://example.com/unsub",
      "Alex", "Test Firm LLC"
    );
    expect(built.textBody).toContain("This reminder is sent by Test Firm LLC via DeadlineRadar.");
    expect(built.htmlBody).toContain("Test Firm LLC");
    expect(built.htmlBody).toContain("via DeadlineRadar");
  });

  it("omits the attribution line when firmName is null (free-tier, byte-identical to before)", async () => {
    const { buildReminderEmail } = await import("../src/emails");
    const built = buildReminderEmail(
      "Georgia", "2027-01-01", 30, 30,
      "https://example.com/next", "https://example.com/stop", "https://example.com/unsub",
      "Alex"
    );
    expect(built.textBody).not.toContain("sent by");
    expect(built.htmlBody).not.toContain("via DeadlineRadar");
  });
});

describe("PATCH /firm/reply-to", () => {
  it("401s with no session", async () => {
    const resp = await SELF.fetch(`${BASE}/firm/reply-to`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "foo@example.com" }),
    });
    expect(resp.status).toBe(401);
  });

  it("sets a reply-to address", async () => {
    const { cookie } = await createFirmWithSession("Reply To Firm", `replyto-${Date.now()}@example.com`);
    const resp = await SELF.fetch(`${BASE}/firm/reply-to`, {
      method: "PATCH",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({ email: "contact@testfirm.com" }),
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { reply_to_email: string | null };
    expect(body.reply_to_email).toBe("contact@testfirm.com");
  });

  it("clears a reply-to address with null", async () => {
    const { cookie } = await createFirmWithSession("Clear Reply To Firm", `clearreplyto-${Date.now()}@example.com`);
    await SELF.fetch(`${BASE}/firm/reply-to`, {
      method: "PATCH",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({ email: "contact@testfirm.com" }),
    });
    const resp = await SELF.fetch(`${BASE}/firm/reply-to`, {
      method: "PATCH",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({ email: null }),
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { reply_to_email: string | null };
    expect(body.reply_to_email).toBeNull();
  });

  it("rejects an invalid email", async () => {
    const { cookie } = await createFirmWithSession("Bad Reply To Firm", `badreplyto-${Date.now()}@example.com`);
    const resp = await SELF.fetch(`${BASE}/firm/reply-to`, {
      method: "PATCH",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({ email: "not-an-email" }),
    });
    expect(resp.status).toBe(400);
  });
});

describe("GET /firm/licenses reply_to_email", () => {
  it("returns null when never set, then the saved value after PATCH", async () => {
    const { cookie } = await createFirmWithSession("Reply To Read Firm", `replytoread-${Date.now()}@example.com`);
    const before = await SELF.fetch(`${BASE}/firm/licenses`, { headers: { Cookie: cookie } });
    const beforeBody = (await before.json()) as { reply_to_email: string | null };
    expect(beforeBody.reply_to_email).toBeNull();

    await SELF.fetch(`${BASE}/firm/reply-to`, {
      method: "PATCH",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({ email: "reply@testfirm.com" }),
    });
    const after = await SELF.fetch(`${BASE}/firm/licenses`, { headers: { Cookie: cookie } });
    const afterBody = (await after.json()) as { reply_to_email: string | null };
    expect(afterBody.reply_to_email).toBe("reply@testfirm.com");
  });
});

describe("scheduler.ts runReminderPass -- firm name + reply-to threaded through", () => {
  it("passes the firm's name and reply-to into a firm-tracked subscriber's send", async () => {
    const { runReminderPass } = await import("../src/scheduler");
    const { firmId, cookie } = await createFirmWithSession("Sched WL Firm", `schedwl-${Date.now()}@example.com`);
    await SELF.fetch(`${BASE}/firm/reply-to`, {
      method: "PATCH",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({ email: "reply@schedwlfirm.com" }),
    });
    const email = `schedwl-tx-${Date.now()}@example.com`;
    await store.addPending(env.DB, {
      email,
      stateSlug: "texas",
      deadlineFields: { birth_month: "7" }, // TX deadline = end of July
      firstName: "Tester",
      firmId,
      staffLabel: "Sched WL Staff",
      skipConfirmation: true,
    });

    let capturedReplyTo: string | undefined;
    let capturedBody = "";
    await runReminderPass(env, {
      asOf: new Date(Date.UTC(2026, 6, 24)),
      send: async (_to, built, replyTo) => {
        capturedReplyTo = replyTo;
        capturedBody = built.textBody;
        return true;
      },
    });

    expect(capturedReplyTo).toBe("reply@schedwlfirm.com");
    expect(capturedBody).toContain("This reminder is sent by Sched WL Firm via DeadlineRadar.");
  });

  it("passes no firm name or reply-to for a free-tier (non-firm) subscriber", async () => {
    const { runReminderPass } = await import("../src/scheduler");
    const email = `schedwl-free-tx-${Date.now()}@example.com`;
    await store.addPending(env.DB, {
      email,
      stateSlug: "texas",
      deadlineFields: { birth_month: "7" },
      firstName: "Tester",
    });
    await store.confirm(env.DB, (await store.findActiveOrPending(env.DB, email, "texas"))!.confirm_token);

    let capturedReplyTo: string | undefined = "unset";
    let capturedBody = "";
    await runReminderPass(env, {
      asOf: new Date(Date.UTC(2026, 6, 24)),
      send: async (_to, built, replyTo) => {
        capturedReplyTo = replyTo;
        capturedBody = built.textBody;
        return true;
      },
    });

    expect(capturedReplyTo).toBeUndefined();
    expect(capturedBody).not.toContain("sent by");
  });
});
