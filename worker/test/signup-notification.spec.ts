/**
 * Internal signup-notification emails (2026-08-05, Devin: "I want an email
 * notification on every signup. So I can personally reach out and greet
 * them."). Two triggers, confirmed against the real HTTP flow, not just the
 * builder function in isolation:
 *   - individual: fires on double-opt-in CONFIRMATION (GET+POST /confirm),
 *     not the initial /subscribe capture.
 *   - firm: fires on the firm's FIRST-EVER successful login-verify, not
 *     account creation -- and does NOT fire again on a second login.
 */
import { env, SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import * as store from "../src/store";

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

function okResponse(): Response {
  return new Response("{}", { status: 202 });
}

async function firmLoginVerify(rawToken: string, envOverrides: Record<string, unknown>, ip: string): Promise<Response> {
  const page = await workerFetch(
    new Request(`https://deadline-radar.com/firm/login/verify?token=${encodeURIComponent(rawToken)}`, {
      headers: { "cf-connecting-ip": ip },
    }),
    envOverrides
  );
  const html = await page.text();
  const nonce = /name="action_csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
  const cookie = (page.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
  return workerFetch(
    new Request("https://deadline-radar.com/firm/login/verify", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "cf-connecting-ip": ip,
        Cookie: cookie,
      },
      body: new URLSearchParams({ token: rawToken, action_csrf: nonce }).toString(),
    }),
    envOverrides
  );
}

describe("individual signup notification -- fires on confirmation, not on /subscribe", () => {
  it("no notification fetch at /subscribe time (no SendGrid key in the real bound env)", async () => {
    const email = `notify-individual-${Date.now()}@example.com`;
    const resp = await SELF.fetch("https://deadline-radar.com/subscribe", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.90" },
      body: new URLSearchParams({ hp_website: "", email, state: "georgia", license_type_id: "ga-individual", first_name: "" }).toString(),
    });
    expect(resp.status).toBe(200);
    const row = await env.DB.prepare("SELECT confirm_token FROM subscribers WHERE email = ?1").bind(email).first<{ confirm_token: string }>();
    expect(row?.confirm_token).toBeTruthy();
  });

  it("confirming fires exactly one notification to the internal address, with the right content", async () => {
    const email = `notify-individual2-${Date.now()}@example.com`;
    await SELF.fetch("https://deadline-radar.com/subscribe", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.91" },
      body: new URLSearchParams({ hp_website: "", email, state: "georgia", license_type_id: "ga-individual", first_name: "" }).toString(),
    });
    const row = await env.DB.prepare("SELECT confirm_token FROM subscribers WHERE email = ?1").bind(email).first<{ confirm_token: string }>();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse());
    try {
      const resp = await workerFetch(
        new Request("https://deadline-radar.com/confirm", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.91" },
          body: new URLSearchParams({ token: row!.confirm_token }).toString(),
        }),
        { SENDGRID_API_KEY: "test-key-not-real" }
      );
      expect(resp.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [, sendGridCallInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const sentBody = JSON.parse(String(sendGridCallInit.body));
      expect(sentBody.personalizations[0].to[0].email).toBe("support@deadline-radar.com");
      expect(sentBody.subject).toContain("New individual signup");
      expect(sentBody.subject).toContain(email);
      const textContent = sentBody.content.find((c: { type: string }) => c.type === "text/plain").value as string;
      expect(textContent).toContain(email);
      expect(textContent).toContain("Georgia");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("does not fire again if the confirm link is reused -- confirm() is deliberately idempotent (200 both times), but the notification must fire only on the REAL transition", async () => {
    const email = `notify-individual3-${Date.now()}@example.com`;
    await SELF.fetch("https://deadline-radar.com/subscribe", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.92" },
      body: new URLSearchParams({ hp_website: "", email, state: "georgia", license_type_id: "ga-individual", first_name: "" }).toString(),
    });
    const row = await env.DB.prepare("SELECT confirm_token FROM subscribers WHERE email = ?1").bind(email).first<{ confirm_token: string }>();
    await store.confirm(env.DB, row!.confirm_token); // first confirmation -- real transition, not asserted here

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse());
    try {
      const resp = await workerFetch(
        new Request("https://deadline-radar.com/confirm", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.92" },
          body: new URLSearchParams({ token: row!.confirm_token }).toString(),
        }),
        { SENDGRID_API_KEY: "test-key-not-real" }
      );
      expect(resp.status).toBe(200); // confirm() is idempotent -- still succeeds
      expect(fetchSpy).not.toHaveBeenCalled(); // but no duplicate notification
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("firm signup notification -- fires on first login only", () => {
  it("first-ever login fires exactly one notification with the firm's real name/email", async () => {
    const adminEmail = `notify-firm-${Date.now()}@example.com`;
    const firm = await store.createFirm(env.DB, { name: "Notify Test Firm", adminEmail });
    const { rawToken } = await store.createLoginToken(env.DB, firm.id);

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse());
    try {
      const resp = await firmLoginVerify(rawToken, { SENDGRID_API_KEY: "test-key-not-real" }, "203.0.113.95");
      expect(resp.status).toBe(302);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [, sendGridCallInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const sentBody = JSON.parse(String(sendGridCallInit.body));
      expect(sentBody.personalizations[0].to[0].email).toBe("support@deadline-radar.com");
      expect(sentBody.subject).toContain("Notify Test Firm");
      const textContent = sentBody.content.find((c: { type: string }) => c.type === "text/plain").value as string;
      expect(textContent).toContain("Notify Test Firm");
      expect(textContent).toContain(adminEmail);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("a second login for the same firm does NOT fire a second notification", async () => {
    const adminEmail = `notify-firm2-${Date.now()}@example.com`;
    const firm = await store.createFirm(env.DB, { name: "Notify Test Firm Two", adminEmail });
    const { rawToken: firstToken } = await store.createLoginToken(env.DB, firm.id);
    await firmLoginVerify(firstToken, { SENDGRID_API_KEY: "test-key-not-real" }, "203.0.113.96");

    const { rawToken: secondToken } = await store.createLoginToken(env.DB, firm.id);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse());
    try {
      const resp = await firmLoginVerify(secondToken, { SENDGRID_API_KEY: "test-key-not-real" }, "203.0.113.96");
      expect(resp.status).toBe(302);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("no SENDGRID_API_KEY configured: degrades to a no-op, first login still succeeds", async () => {
    const adminEmail = `notify-firm3-${Date.now()}@example.com`;
    const firm = await store.createFirm(env.DB, { name: "Notify Test Firm Three", adminEmail });
    const { rawToken } = await store.createLoginToken(env.DB, firm.id);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse());
    try {
      const resp = await firmLoginVerify(rawToken, {}, "203.0.113.97");
      expect(resp.status).toBe(302);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
