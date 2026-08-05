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

function testExecutionContext(): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
}

async function workerFetch(request: Request, envOverrides: Record<string, unknown> = {}): Promise<Response> {
  const worker = (await import("../src/index")).default;
  return worker.fetch(request, { ...env, ...envOverrides } as never, testExecutionContext());
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
      const resp = await workerFetch(
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

describe("AuditLab TS-1 revised recommendation: /firm/signup re-requires the token (writes a persistent row)", () => {
  it("a token-less POST /firm/signup is rejected, no firm row created, with Turnstile actually configured", async () => {
    const email = `ts1-signup-strict-${Date.now()}@example.com`;
    const resp = await workerFetch(
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
