/**
 * AuditLab TS-1 (revised MEDIUM, 2026-08-05): a token-less submission to a
 * relaxed route used to spend from the SAME daily counter the reminder
 * scheduler does, so a spam wave could exhaust the shared budget and
 * silently stop real deadline reminders for the rest of the UTC day. Fixed
 * with a separate action_send_counters table (migration 0019) +
 * checkAndCountActionSend() -- AuditLab's own correction pass confirmed the
 * separation actually holds: exhausting the action budget cannot touch a
 * single reminder send.
 *
 * Uses /firm/login (not /firm/signup) as the relaxed route under test --
 * AuditLab's revised recommendation was to re-require the token specifically
 * on /firm/signup (the one relaxed route that also writes a persistent row),
 * so that route no longer accepts a missing token at all. /firm/login stays
 * relaxed: a token-less request there can only cause an email to be sent to
 * an ALREADY-existing firm's admin address, with an identical response
 * whether or not the firm exists (no enumeration oracle either way).
 *
 * This file proves the fix end-to-end through the REAL HTTP path, not just
 * unit-testing the counter function in isolation (already covered in
 * worker.spec.ts).
 */
import { env, SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import * as store from "../src/store";

function okResponse(): Response {
  return new Response("{}", { status: 202 });
}

// AuditLab TIMING-1 (2026-08-17): handleFirmLogin now defers its send via
// ctx.waitUntil (same fix as handleSubscriberLoginRequest already had) --
// a no-op waitUntil() drops that promise entirely, so this file's own
// send-completed assertion below raced the real fetch() and lost. Real
// Cloudflare Workers run waitUntil-registered promises to completion (just
// off the response path); this stub now does the same so tests can await
// that completion explicitly instead of relying on incidental scheduling.
function testExecutionContext(): ExecutionContext & { drain: () => Promise<void> } {
  const pending: Promise<unknown>[] = [];
  return {
    waitUntil(promise: Promise<unknown>) {
      pending.push(promise);
    },
    passThroughOnException() {},
    props: {},
    async drain() {
      await Promise.allSettled(pending);
    },
  } as unknown as ExecutionContext & { drain: () => Promise<void> };
}

async function workerFetch(
  request: Request,
  envOverrides: Record<string, unknown> = {}
): Promise<{ response: Response; drain: () => Promise<void> }> {
  const worker = (await import("../src/index")).default;
  const ctx = testExecutionContext();
  const response = await worker.fetch(request, { ...env, ...envOverrides } as never, ctx);
  return { response, drain: ctx.drain };
}

async function todayCounts(): Promise<{ reminder: number; action: number }> {
  const reminder = await env.DB
    .prepare("SELECT count FROM send_counters WHERE day = strftime('%Y-%m-%d','now')")
    .first<{ count: number }>();
  const action = await env.DB
    .prepare("SELECT count FROM action_send_counters WHERE day = strftime('%Y-%m-%d','now')")
    .first<{ count: number }>();
  return { reminder: reminder?.count ?? 0, action: action?.count ?? 0 };
}

describe("a real token-less magic-link request spends the ACTION budget, never the reminder budget", () => {
  it("POST /firm/login with no cf-turnstile-response field, real SendGrid key configured", async () => {
    const adminEmail = `ts1-verify-${Date.now()}@example.com`;
    await store.createFirm(env.DB, { name: "TS-1 Verify Firm", adminEmail });

    const before = await todayCounts();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse());
    try {
      const { response: resp, drain } = await workerFetch(
        new Request("https://deadline-radar.com/firm/login", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.240" },
          body: new URLSearchParams({ hp_website: "", admin_email: adminEmail }).toString(),
        }),
        // TURNSTILE_SECRET_KEY set (unlike the default test env, which has
        // none) so this actually exercises allowMissingToken -- with no
        // secret configured, verifyTurnstile() would pass regardless of
        // token presence and this test would prove nothing.
        { SENDGRID_API_KEY: "test-key-not-real", TURNSTILE_SECRET_KEY: "test-secret-not-real" }
      );
      expect(resp.status).toBe(200);
      // handleFirmLogin defers the send via ctx.waitUntil (TIMING-1) -- wait
      // for it to actually finish before checking it happened.
      await drain();
      // The magic-link send itself happened (fetch to SendGrid was called) --
      // proving allowMissingToken actually let this token-less request
      // through to the send path, not just to a generic success page.
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      const after = await todayCounts();
      expect(after.action).toBe(before.action + 1);
      expect(after.reminder).toBe(before.reminder);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

// AuditLab CAP-2 (MEDIUM, 2026-08-21, orchestrator-approved): the action-
// email circuit breaker used to read REMINDERS_DAILY_SEND_CAP -- the SAME
// knob as the reminder channel -- so CAP-1's own documented kill switch
// (setting a cap to 0 mid-incident) also silently killed every login
// link, signup/email-change confirmation, and the operator stale-data
// alert. Now decoupled via its own ACTION_DAILY_SEND_CAP.
describe("CAP-2: action email has its own independent daily-cap kill switch", () => {
  it("REMINDERS_DAILY_SEND_CAP=0 (CAP-1's kill switch for reminders) does NOT block a login-link send", async () => {
    const adminEmail = `cap2-decoupled-${Date.now()}@example.com`;
    await store.createFirm(env.DB, { name: "CAP-2 Decoupled Firm", adminEmail });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse());
    try {
      const { response: resp, drain } = await workerFetch(
        new Request("https://deadline-radar.com/firm/login", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.244" },
          body: new URLSearchParams({ hp_website: "", admin_email: adminEmail }).toString(),
        }),
        { SENDGRID_API_KEY: "test-key-not-real", REMINDERS_DAILY_SEND_CAP: "0" }
      );
      expect(resp.status).toBe(200);
      await drain();
      expect(fetchSpy).toHaveBeenCalledTimes(1); // the login-link email still went out
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("ACTION_DAILY_SEND_CAP=0 DOES block a login-link send -- the action channel's own independent kill switch works", async () => {
    const adminEmail = `cap2-killswitch-${Date.now()}@example.com`;
    await store.createFirm(env.DB, { name: "CAP-2 Killswitch Firm", adminEmail });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse());
    try {
      const { response: resp, drain } = await workerFetch(
        new Request("https://deadline-radar.com/firm/login", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.245" },
          body: new URLSearchParams({ hp_website: "", admin_email: adminEmail }).toString(),
        }),
        { SENDGRID_API_KEY: "test-key-not-real", ACTION_DAILY_SEND_CAP: "0" }
      );
      expect(resp.status).toBe(200); // still a generic success response -- no enumeration oracle
      await drain();
      expect(fetchSpy).not.toHaveBeenCalled(); // but the send itself was refused by the cap
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("AuditLab TS-1 revised recommendation: /firm/signup re-requires the token (writes a persistent row)", () => {
  it("a token-less POST /firm/signup is rejected, no firm row created, with Turnstile actually configured", async () => {
    const email = `ts1-signup-strict-${Date.now()}@example.com`;
    const { response: resp } = await workerFetch(
      new Request("https://deadline-radar.com/firm/signup", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.242" },
        body: new URLSearchParams({ hp_website: "", name: "Should Not Be Created", admin_email: email }).toString(),
      }),
      { TURNSTILE_SECRET_KEY: "test-secret-not-real" }
    );
    expect(resp.status).toBe(400);
    const row = await env.DB.prepare("SELECT id FROM firms WHERE admin_email = ?1").bind(email).first();
    expect(row).toBeNull();
  });

  it("with no Turnstile configured at all (the real default env), signup still works normally -- degrade-safely unaffected by TS-1's fix", async () => {
    const email = `ts1-signup-noturnstile-${Date.now()}@example.com`;
    const resp = await SELF.fetch("https://deadline-radar.com/firm/signup", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.243" },
      body: new URLSearchParams({ hp_website: "", name: "Should Be Created", admin_email: email }).toString(),
    });
    expect(resp.status).toBe(200);
    const row = await env.DB.prepare("SELECT id FROM firms WHERE admin_email = ?1").bind(email).first();
    expect(row).not.toBeNull();
  });
});
