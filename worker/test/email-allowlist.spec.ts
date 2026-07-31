/**
 * Tests for the preview/staging EMAIL_ALLOWLIST safety gate (env.ts,
 * sender.ts). This is a safety-critical feature: a Cloudflare Workers
 * PREVIEW deploy of this Worker must be structurally incapable of emailing a
 * real outside person, even if a tester types a real-looking address into a
 * form. See AssetLab's orchestrator requirement: "ZERO chance a real outside
 * person is emailed (test allowlist or dry-run mode -- verify it)."
 *
 * Two layers are tested:
 *   1. Unit tests directly against sendViaSendGrid() -- prove the gate
 *      refuses a non-allowlisted recipient BEFORE any network call (not just
 *      that it returns false -- an attacker-controlled address that happened
 *      to also fail some other way would look "safe" if only the return
 *      value were checked), prove a case-insensitive allowlisted recipient
 *      still sends, and prove an unset allowlist leaves behavior unchanged.
 *   2. An integration test through the real POST /subscribe confirmation-
 *      email call site (index.ts, one of the 7 sendViaSendGrid() callers),
 *      proving the gate is actually wired up end-to-end and not just
 *      correct in isolation.
 */
import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { sendViaSendGrid } from "../src/sender";
import type { BuiltEmail } from "../src/emails";
import * as store from "../src/store";

// Minimal ExecutionContext for direct worker.fetch() calls (2026-07-31): the
// Worker now defers best-effort email sends via ctx.waitUntil() so they stay
// off the response path (see handleSubscriberLoginRequest).
function testExecutionContext(): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
}

// 2026-07-31 (login-CSRF fix): /firm/login/verify's POST now requires the
// double-submit nonce minted by its GET render, so these tests perform the
// same two-step flow a browser does. What each one asserts (redirect target,
// cookie SameSite) is unchanged. `worker` is imported per-test in this file,
// so this helper imports it too rather than closing over one.
async function firmLoginVerifyPost(
  rawToken: string,
  targetEnv: unknown,
  ip: string
): Promise<Response> {
  const worker = (await import("../src/index")).default;
  const page = await worker.fetch(
    new Request(`https://deadline-radar.com/firm/login/verify?token=${encodeURIComponent(rawToken)}`, {
      headers: { "cf-connecting-ip": ip },
    }),
    targetEnv as never,
    testExecutionContext()
  );
  const html = await page.text();
  const nonce = /name="action_csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
  const cookie = (page.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
  return worker.fetch(
    new Request("https://deadline-radar.com/firm/login/verify", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "cf-connecting-ip": ip,
        Cookie: cookie,
      },
      body: form({ token: rawToken, action_csrf: nonce }),
    }),
    targetEnv as never,
    testExecutionContext()
  );
}


const SENDGRID_URL = "https://api.sendgrid.com/v3/mail/send";

function form(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

function fakeEmail(): BuiltEmail {
  return {
    subject: "Test subject",
    textBody: "Test text body",
    htmlBody: "<p>Test html body</p>",
    headers: {},
  };
}

function okResponse(): Response {
  return new Response("{}", { status: 202 });
}

describe("sendViaSendGrid() -- EMAIL_ALLOWLIST gate (unit)", () => {
  it("a non-allowlisted recipient is refused BEFORE any network call: fetch is never invoked", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse());
    try {
      const result = await sendViaSendGrid(
        "fake-api-key",
        "real-outside-person@somestranger.com",
        fakeEmail(),
        "dlhall86@gmail.com,dlhall86+test@gmail.com"
      );
      expect(result).toBe(false);
      // The load-bearing assertion: not just "returned false", but that the
      // gate short-circuited before fetch() -- SendGrid's API was never
      // contacted, so there is no network path by which this recipient
      // could have been emailed.
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("an allowlisted recipient still sends normally, case-insensitively and trimmed", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse());
    try {
      const result = await sendViaSendGrid(
        "fake-api-key",
        "  Test@Example.com  ", // untrimmed, mixed-case -- must still match "test@example.com"
        fakeEmail(),
        "someone-else@example.com, test@example.com "
      );
      expect(result).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy).toHaveBeenCalledWith(
        SENDGRID_URL,
        expect.objectContaining({ method: "POST" })
      );
      // Confirm the actual recipient placed on the wire is the (untrimmed,
      // original-case) address passed in -- the allowlist only gates
      // whether the send happens, it must not silently rewrite the To:.
      const call = fetchSpy.mock.calls[0];
      const body = JSON.parse(String((call?.[1] as RequestInit).body));
      expect(body.personalizations[0].to[0].email).toBe("  Test@Example.com  ");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("with NO allowlist argument (undefined) -- the production default -- behavior is unchanged: fetch IS called for any recipient", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse());
    try {
      const result = await sendViaSendGrid(
        "fake-api-key",
        "anybody-at-all@example.com",
        fakeEmail()
        // no 4th argument -- exactly how every call site behaved before this change
      );
      expect(result).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("an empty-string allowlist behaves exactly like an unset one (fetch still called, gate off)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse());
    try {
      const result = await sendViaSendGrid("fake-api-key", "anybody@example.com", fakeEmail(), "");
      expect(result).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("a whitespace-only allowlist (e.g. \",,\") also behaves like unset -- gate off, not a fail-open-to-nobody trap", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse());
    try {
      const result = await sendViaSendGrid("fake-api-key", "anybody@example.com", fakeEmail(), " , , ");
      expect(result).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("EMAIL_ALLOWLIST gate -- wired up end-to-end through a real call site (POST /subscribe confirmation email)", () => {
  it("preview-style env (SENDGRID_API_KEY + EMAIL_ALLOWLIST set): a real-looking, non-allowlisted signup email never reaches fetch(), but the subscriber row is still stored", async () => {
    const worker = (await import("../src/index")).default;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse());
    try {
      const envWithGate = {
        ...env,
        SENDGRID_API_KEY: "test-key-not-real",
        EMAIL_ALLOWLIST: "dlhall86@gmail.com,dlhall86+test@gmail.com",
      };
      const outsideEmail = `real-outside-person-${Date.now()}@somestranger.com`;
      const body = new URLSearchParams({
        email: outsideEmail,
        state: "georgia",
        license_type_id: "ga-individual",
        hp_website: "",
      }).toString();
      const request = new Request("https://deadline-radar.com/subscribe", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.201" },
        body,
      });
      const resp = await worker.fetch(request, envWithGate, testExecutionContext());
      expect(resp.status).toBe(200);
      // The signup itself must still succeed (email failure is best-effort
      // and must never fail the caller's request) --
      expect(fetchSpy).not.toHaveBeenCalled();

      const row = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?1").bind(outsideEmail).first();
      expect(row).not.toBeNull();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("preview-style env: a signup with an allowlisted email DOES reach fetch() (the gate lets through addresses Devin controls)", async () => {
    const worker = (await import("../src/index")).default;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse());
    try {
      const allowlistedEmail = "dlhall86+test@gmail.com";
      const envWithGate = {
        ...env,
        SENDGRID_API_KEY: "test-key-not-real",
        EMAIL_ALLOWLIST: "dlhall86@gmail.com,dlhall86+test@gmail.com",
      };
      const body = new URLSearchParams({
        email: allowlistedEmail,
        state: "georgia",
        license_type_id: "ga-individual",
        hp_website: "",
      }).toString();
      const request = new Request("https://deadline-radar.com/subscribe", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.202" },
        body,
      });
      const resp = await worker.fetch(request, envWithGate, testExecutionContext());
      expect(resp.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy).toHaveBeenCalledWith(SENDGRID_URL, expect.objectContaining({ method: "POST" }));
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("production-style env (no EMAIL_ALLOWLIST set, real key present): behavior is unchanged -- send is attempted for any recipient", async () => {
    const worker = (await import("../src/index")).default;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse());
    try {
      const envNoGate = { ...env, SENDGRID_API_KEY: "test-key-not-real" }; // no EMAIL_ALLOWLIST at all
      const anyEmail = `prod-unchanged-${Date.now()}@example.com`;
      const body = new URLSearchParams({
        email: anyEmail,
        state: "georgia",
        license_type_id: "ga-individual",
        hp_website: "",
      }).toString();
      const request = new Request("https://deadline-radar.com/subscribe", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.203" },
        body,
      });
      const resp = await worker.fetch(request, envNoGate, testExecutionContext());
      expect(resp.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy).toHaveBeenCalledWith(SENDGRID_URL, expect.objectContaining({ method: "POST" }));
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("POST /debug/run-reminder-pass -- preview-only manual cron trigger", () => {
  it("404s in a production-style env (no EMAIL_ALLOWLIST set at all)", async () => {
    const worker = (await import("../src/index")).default;
    const envNoGate = { ...env, SENDGRID_API_KEY: "test-key-not-real" };
    const request = new Request("https://deadline-radar.com/debug/run-reminder-pass", {
      method: "POST",
      headers: { "cf-connecting-ip": "203.0.113.210" },
    });
    const resp = await worker.fetch(request, envNoGate, testExecutionContext());
    expect(resp.status).toBe(404);
  });

  it("runs the reminder pass and returns a JSON summary in a preview-style env (EMAIL_ALLOWLIST set)", async () => {
    const worker = (await import("../src/index")).default;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse());
    try {
      const envWithGate = {
        ...env,
        SENDGRID_API_KEY: "test-key-not-real",
        EMAIL_ALLOWLIST: "dlhall86@gmail.com,dlhall86+test@gmail.com",
      };
      const request = new Request("https://deadline-radar.com/debug/run-reminder-pass", {
        method: "POST",
        headers: { "cf-connecting-ip": "203.0.113.211" },
      });
      const resp = await worker.fetch(request, envWithGate, testExecutionContext());
      expect(resp.status).toBe(200);
      const body = await resp.json();
      expect(typeof body).toBe("object");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("blocks the 6th request from the same IP within the window (own rate-limit bucket)", async () => {
    const worker = (await import("../src/index")).default;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse());
    const envWithGate = {
      ...env,
      SENDGRID_API_KEY: "test-key-not-real",
      EMAIL_ALLOWLIST: "dlhall86@gmail.com",
    };
    const ip = "203.0.113.212";
    for (let i = 0; i < 5; i++) {
      const resp = await worker.fetch(
        new Request("https://deadline-radar.com/debug/run-reminder-pass", {
          method: "POST",
          headers: { "cf-connecting-ip": ip },
        }),
        envWithGate,
        testExecutionContext()
      );
      expect(resp.status).not.toBe(429);
    }
    const sixth = await worker.fetch(
      new Request("https://deadline-radar.com/debug/run-reminder-pass", {
        method: "POST",
        headers: { "cf-connecting-ip": ip },
      }),
      envWithGate,
        testExecutionContext()
    );
    expect(sixth.status).toBe(429);
    vi.restoreAllMocks();
  });
});

describe("ACTION_BASE_URL override -- preview/staging action links point at the preview Worker, not production", () => {
  it("a firm login-link email points at env.ACTION_BASE_URL when set, not the hardcoded production domain", async () => {
    const worker = (await import("../src/index")).default;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse());
    try {
      const envPreview = {
        ...env,
        SENDGRID_API_KEY: "test-key-not-real",
        EMAIL_ALLOWLIST: "dlhall86@gmail.com",
        ACTION_BASE_URL: "https://deadlineradar-api-preview.example.workers.dev/api",
      };
      const request = new Request("https://deadline-radar.com/firm/signup", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.220" },
        body: new URLSearchParams({ name: "Preview Test Firm", admin_email: "dlhall86@gmail.com", hp_website: "" }).toString(),
      });
      const resp = await worker.fetch(request, envPreview, testExecutionContext());
      expect(resp.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [, sendGridCallInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const sentBody = JSON.parse(String(sendGridCallInit.body));
      const textContent = sentBody.content.find((c: { type: string }) => c.type === "text/plain").value as string;
      expect(textContent).toContain("https://deadlineradar-api-preview.example.workers.dev/api/firm/login/verify?token=");
      expect(textContent).not.toContain("deadline-radar.com");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("with ACTION_BASE_URL unset (production default), action links still use the hardcoded deadline-radar.com domain", async () => {
    const worker = (await import("../src/index")).default;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse());
    try {
      const envProd = { ...env, SENDGRID_API_KEY: "test-key-not-real" }; // no ACTION_BASE_URL, no EMAIL_ALLOWLIST
      const anyEmail = `prod-actionurl-${Date.now()}@example.com`;
      const request = new Request("https://deadline-radar.com/subscribe", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.221" },
        body: new URLSearchParams({
          email: anyEmail,
          state: "georgia",
          license_type_id: "ga-individual",
          hp_website: "",
        }).toString(),
      });
      const resp = await worker.fetch(request, envProd, testExecutionContext());
      expect(resp.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [, sendGridCallInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const sentBody = JSON.parse(String(sendGridCallInit.body));
      const textContent = sentBody.content.find((c: { type: string }) => c.type === "text/plain").value as string;
      expect(textContent).toContain("https://deadline-radar.com/api/confirm?token=");
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("STATIC_SITE_BASE_URL override -- login/logout redirects cross back to the preview static site, not the Worker's own origin", () => {
  it("login-verify redirects to STATIC_SITE_BASE_URL + /firm-dashboard/ when set", async () => {
    const worker = (await import("../src/index")).default;
    const firmId = (
      await store.createFirm(env.DB, { name: "Redirect Test Firm A", adminEmail: `redirect-a-${Date.now()}@example.com` })
    ).id;
    const { rawToken } = await store.createLoginToken(env.DB, firmId);
    const envPreview = { ...env, STATIC_SITE_BASE_URL: "https://deadlineradar-preview.pages.dev" };
    const resp = await firmLoginVerifyPost(rawToken, envPreview, "203.0.113.230");
    expect(resp.status).toBe(302);
    expect(resp.headers.get("Location")).toBe("https://deadlineradar-preview.pages.dev/firm-dashboard/");
  });

  it("with STATIC_SITE_BASE_URL unset (production default), login-verify redirects to the relative path", async () => {
    const worker = (await import("../src/index")).default;
    const firmId = (
      await store.createFirm(env.DB, { name: "Redirect Test Firm B", adminEmail: `redirect-b-${Date.now()}@example.com` })
    ).id;
    const { rawToken } = await store.createLoginToken(env.DB, firmId);
    const resp = await firmLoginVerifyPost(rawToken, env, "203.0.113.231"); // no STATIC_SITE_BASE_URL at all
    expect(resp.status).toBe(302);
    expect(resp.headers.get("Location")).toBe("/firm-dashboard/");
  });

  it("logout redirects to STATIC_SITE_BASE_URL + / when set", async () => {
    const worker = (await import("../src/index")).default;
    const envPreview = { ...env, STATIC_SITE_BASE_URL: "https://deadlineradar-preview.pages.dev" };
    const request = new Request("https://deadline-radar.com/firm/logout", {
      method: "POST",
      headers: { "cf-connecting-ip": "203.0.113.232" },
    });
    const resp = await worker.fetch(request, envPreview, testExecutionContext());
    expect(resp.status).toBe(302);
    expect(resp.headers.get("Location")).toBe("https://deadlineradar-preview.pages.dev/");
  });
});

describe("Preview cross-origin fix: SameSite=None + CORS when STATIC_SITE_BASE_URL is set, unchanged in production", () => {
  const previewOrigin = "https://deadlineradar-preview.pages.dev";

  it("login-verify sets SameSite=None (not Lax) when STATIC_SITE_BASE_URL is set", async () => {
    const worker = (await import("../src/index")).default;
    const firmId = (
      await store.createFirm(env.DB, { name: "CORS Test Firm", adminEmail: `cors-${Date.now()}@example.com` })
    ).id;
    const { rawToken } = await store.createLoginToken(env.DB, firmId);
    const envPreview = { ...env, STATIC_SITE_BASE_URL: previewOrigin };
    const resp = await firmLoginVerifyPost(rawToken, envPreview, "203.0.113.240");
    const setCookie = resp.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toContain("SameSite=None");
    expect(setCookie).not.toContain("SameSite=Lax");
  });

  it("with STATIC_SITE_BASE_URL unset, login-verify still sets SameSite=Lax (production unchanged)", async () => {
    const worker = (await import("../src/index")).default;
    const firmId = (
      await store.createFirm(env.DB, { name: "Prod Cookie Firm", adminEmail: `prodcookie-${Date.now()}@example.com` })
    ).id;
    const { rawToken } = await store.createLoginToken(env.DB, firmId);
    const resp = await firmLoginVerifyPost(rawToken, env, "203.0.113.241");
    const setCookie = resp.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).not.toContain("SameSite=None");
  });

  it("OPTIONS preflight on a firm route returns 204 with the exact preview origin + credentials allowed, when STATIC_SITE_BASE_URL is set", async () => {
    const worker = (await import("../src/index")).default;
    const envPreview = { ...env, STATIC_SITE_BASE_URL: previewOrigin };
    const request = new Request("https://deadline-radar.com/api/firm/licenses", {
      method: "OPTIONS",
      headers: { Origin: previewOrigin },
    });
    const resp = await worker.fetch(request, envPreview, testExecutionContext());
    expect(resp.status).toBe(204);
    expect(resp.headers.get("Access-Control-Allow-Origin")).toBe(previewOrigin);
    expect(resp.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    expect(resp.headers.get("Access-Control-Allow-Methods")).toContain("PATCH");
  });

  it("a normal GET /firm/licenses response carries CORS headers when STATIC_SITE_BASE_URL is set", async () => {
    const worker = (await import("../src/index")).default;
    const envPreview = { ...env, STATIC_SITE_BASE_URL: previewOrigin };
    const request = new Request("https://deadline-radar.com/api/firm/licenses", {
      headers: { Origin: previewOrigin },
    });
    const resp = await worker.fetch(request, envPreview, testExecutionContext());
    expect(resp.status).toBe(401); // no session cookie -- the point is the CORS headers are present regardless
    expect(resp.headers.get("Access-Control-Allow-Origin")).toBe(previewOrigin);
    expect(resp.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  });

  it("with STATIC_SITE_BASE_URL unset, no CORS headers are added and OPTIONS is not specially handled (production unchanged)", async () => {
    const worker = (await import("../src/index")).default;
    const request = new Request("https://deadline-radar.com/api/firm/licenses", { method: "OPTIONS" });
    const resp = await worker.fetch(request, env, testExecutionContext());
    expect(resp.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(resp.status).not.toBe(204);
  });
});
