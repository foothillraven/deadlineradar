/**
 * Orchestrator escalation (2026-08-09): the old /firm-login/?demo=1 flow
 * pre-filled the demo password into a real password field, and Chrome's
 * saved-credential autofill silently overwrote it with a saved credential
 * on click -- reproduced live, a real bug for any visitor with ANY saved
 * password on this domain. POST /firm/demo-login replaces it: no password,
 * no email round-trip, just a direct session mint for the one shared
 * demo_locked=1 firm.
 *
 * It still hands out a session, so it needs the SAME login-CSRF defence as
 * /firm/login/verify and /subscriber/login/verify -- see login-csrf.spec.ts
 * for the fuller regression suite this mirrors the shape of.
 */
import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import * as store from "../src/store";

const BASE = "https://deadline-radar.com";

// getDemoFirm() is a bare `WHERE demo_locked = 1 AND status = 'active'
// LIMIT 1` with no other filter -- storage persists across tests WITHIN
// this file (only isolated per FILE, not per test), so without resetting
// this between tests, an earlier test's demo firm would silently satisfy a
// later test's "no demo firm exists" assertion, or a later test's own
// makeDemoFirm() call would compete with an earlier one for which row
// LIMIT 1 actually returns. Every test that wants a demo firm calls
// makeDemoFirm() itself, explicitly.
beforeEach(async () => {
  await env.DB.prepare(`UPDATE firms SET demo_locked = 0 WHERE demo_locked = 1`).run();
  // Same reasoning: RATE_LIMIT_FIRM_DEMO_LOGIN_GLOBAL is keyed on a fixed
  // string (there is only one demo account), not per-IP -- an earlier
  // test's successful redeems would otherwise silently eat into a later
  // test's budget within this same file's shared storage.
  await env.DB.prepare(`DELETE FROM rate_limit_hits WHERE bucket = 'firm_demo_login_global'`).run();
  // AuditLab DEMO-6: same cross-test-pollution risk for the new per-IP
  // bucket -- a test that reuses an IP another test already POSTed with
  // would otherwise inherit that earlier hit count.
  await env.DB.prepare(`DELETE FROM rate_limit_hits WHERE bucket = 'firm_demo_login_per_ip'`).run();
});

function form(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

async function renderDemoLogin(ip: string) {
  const page = await SELF.fetch(`${BASE}/firm/demo-login`, {
    headers: { "cf-connecting-ip": ip },
    redirect: "manual",
  });
  const html = await page.text();
  return {
    page,
    html,
    nonce: /name="action_csrf" value="([^"]+)"/.exec(html)?.[1] ?? "",
    cookie: (page.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "",
  };
}

async function makeDemoFirm(label: string): Promise<string> {
  const { id } = await store.createFirm(env.DB, {
    name: "Demo Login Test LLC",
    adminEmail: `${label}-${Date.now()}-${Math.floor(performance.now())}@examplefirm.com`,
  });
  await env.DB.prepare(`UPDATE firms SET demo_locked = 1 WHERE id = ?1`).bind(id).run();
  return id;
}

describe("GET /firm/demo-login -- render", () => {
  it("renders a confirm page with a path-bound nonce, no session cookie yet, no token field required", async () => {
    await makeDemoFirm("render");
    const { page, html, nonce, cookie } = await renderDemoLogin("203.0.113.200");
    expect(page.status).toBe(200);
    expect(nonce).not.toBe("");
    expect(cookie).toContain("dr_action_csrf=");
    expect(page.headers.get("Set-Cookie") ?? "").not.toContain("dr_firm_session=");
    expect(html).toContain("View the demo");
  });

  it("the confirm page refuses to be framed and is not cached, same as every other login-CSRF page", async () => {
    await makeDemoFirm("frame");
    const { page } = await renderDemoLogin("203.0.113.201");
    expect(page.headers.get("X-Frame-Options")).toBe("DENY");
    expect(page.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(page.headers.get("Cache-Control")).toContain("no-store");
  });
});

describe("POST /firm/demo-login -- redeem", () => {
  it("mints a real session for the demo_locked firm and redirects to the dashboard", async () => {
    const demoFirmId = await makeDemoFirm("mint");
    const rendered = await renderDemoLogin("203.0.113.202");

    const resp = await SELF.fetch(`${BASE}/firm/demo-login`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "cf-connecting-ip": "203.0.113.202",
        Cookie: rendered.cookie,
      },
      body: form({ action_csrf: rendered.nonce }),
      redirect: "manual",
    });

    expect(resp.status).toBe(302);
    expect(resp.headers.get("Location") ?? "").toContain("/firm-dashboard/");
    const sessionCookie = (resp.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
    expect(sessionCookie).toContain("dr_firm_session=");

    // Confirms the minted session genuinely belongs to the demo firm, not
    // just that SOME session was created -- same "count rows for this
    // firm_id" verification worker.spec.ts's own session tests use, rather
    // than re-deriving the token hash here.
    const row = await env.DB.prepare(`SELECT COUNT(*) AS c FROM firm_sessions WHERE firm_id = ?1`).bind(demoFirmId).first<{ c: number }>();
    expect(row?.c ?? 0).toBe(1);

    // And the cookie actually works end to end against an authenticated route.
    const dashboardResp = await SELF.fetch(`${BASE}/firm/licenses`, { headers: { Cookie: sessionCookie } });
    expect(dashboardResp.status).toBe(200);
  });

  it("a bare cross-site POST with no nonce is refused, no session granted", async () => {
    await makeDemoFirm("bare");
    const resp = await SELF.fetch(`${BASE}/firm/demo-login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.203" },
      body: form({}),
      redirect: "manual",
    });
    expect(resp.status).toBe(400);
    expect(resp.headers.get("Set-Cookie")).toBeNull();
  });

  it("EMPTY STRING in both halves is refused -- absent must never equal absent", async () => {
    await makeDemoFirm("empty");
    const resp = await SELF.fetch(`${BASE}/firm/demo-login`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "cf-connecting-ip": "203.0.113.204",
        Cookie: "dr_action_csrf=",
      },
      body: form({ action_csrf: "" }),
      redirect: "manual",
    });
    expect(resp.status).toBe(400);
  });

  it("a nonce minted on a DIFFERENT action path (subscriber login) is refused here -- path binding", async () => {
    await makeDemoFirm("pathbind");
    const subEmail = `demo-pathbind-${Date.now()}@examplefirm.com`;
    const { rawToken } = await store.createSubscriberLoginToken(env.DB, subEmail);
    const subPage = await SELF.fetch(`${BASE}/subscriber/login/verify?token=${encodeURIComponent(rawToken)}`, {
      headers: { "cf-connecting-ip": "203.0.113.205" },
      redirect: "manual",
    });
    const subHtml = await subPage.text();
    const subNonce = /name="action_csrf" value="([^"]+)"/.exec(subHtml)?.[1] ?? "";
    const subCookie = (subPage.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";

    const resp = await SELF.fetch(`${BASE}/firm/demo-login`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "cf-connecting-ip": "203.0.113.205",
        Cookie: subCookie,
      },
      body: form({ action_csrf: subNonce }),
      redirect: "manual",
    });
    expect(resp.status).toBe(400);
    expect(resp.headers.get("Set-Cookie")).toBeNull();
  });

  it("when no demo firm exists, returns 404 rather than crashing or granting any session", async () => {
    // No makeDemoFirm() call -- this test's own isolated D1 snapshot has no
    // demo_locked=1 row at all (per-test storage isolation, same as every
    // other test file in this suite relies on for its own fresh state).
    const rendered = await renderDemoLogin("203.0.113.206");
    const resp = await SELF.fetch(`${BASE}/firm/demo-login`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "cf-connecting-ip": "203.0.113.206",
        Cookie: rendered.cookie,
      },
      body: form({ action_csrf: rendered.nonce }),
      redirect: "manual",
    });
    expect(resp.status).toBe(404);
    expect(resp.headers.get("Set-Cookie")).toBeNull();
  });

  it("does not resolve a demo_locked firm whose status is not active", async () => {
    const id = await makeDemoFirm("inactive");
    await env.DB.prepare(`UPDATE firms SET status = 'deleted' WHERE id = ?1`).bind(id).run();
    const rendered = await renderDemoLogin("203.0.113.207");
    const resp = await SELF.fetch(`${BASE}/firm/demo-login`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "cf-connecting-ip": "203.0.113.207",
        Cookie: rendered.cookie,
      },
      body: form({ action_csrf: rendered.nonce }),
      redirect: "manual",
    });
    expect(resp.status).toBe(404);
  });
});

/** Full render+redeem round trip from a given IP -- for the global
 * rate-limit test below, where many DIFFERENT IPs must still share one
 * budget (proving the cap is account-wide, not per-IP like the shared
 * generic RATE_LIMIT_ACTION bucket every other action path uses). */
async function fullDemoLogin(ip: string): Promise<Response> {
  const rendered = await renderDemoLogin(ip);
  return SELF.fetch(`${BASE}/firm/demo-login`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "cf-connecting-ip": ip,
      Cookie: rendered.cookie,
    },
    body: form({ action_csrf: rendered.nonce }),
    redirect: "manual",
  });
}

describe("POST /firm/demo-login -- global rate limit (adversarial-review fix)", () => {
  it("allows up to the cap across MANY DIFFERENT IPs, then 429s -- proving this is account-wide, not per-IP", async () => {
    await makeDemoFirm("ratecap");
    const results: number[] = [];
    for (let i = 0; i < 11; i++) {
      const resp = await fullDemoLogin(`203.0.114.${i + 1}`);
      results.push(resp.status);
    }
    expect(results.slice(0, 10).every((s) => s === 302)).toBe(true);
    expect(results[10]).toBe(429);
  });
});

describe("POST /firm/demo-login -- per-IP rate limit (AuditLab DEMO-6)", () => {
  it("blocks a single IP at 3 requests, well before it could exhaust the 10-request global bucket -- and a DIFFERENT IP is unaffected", async () => {
    await makeDemoFirm("percap");
    const sameIp = "203.0.115.50";
    const results: number[] = [];
    for (let i = 0; i < 4; i++) {
      const resp = await fullDemoLogin(sameIp);
      results.push(resp.status);
    }
    // First 3 from this one IP succeed, the 4th is blocked by the per-IP
    // bucket -- NOT the global one, which still has 6 of its 10 left.
    expect(results.slice(0, 3).every((s) => s === 302)).toBe(true);
    expect(results[3]).toBe(429);

    // A different IP, arriving right after, is completely unaffected --
    // this is what makes it a per-IP bucket rather than a second global one.
    const otherIpResp = await fullDemoLogin("203.0.115.51");
    expect(otherIpResp.status).toBe(302);
  });
});

describe("store.getDemoFirm", () => {
  it("resolves the demo_locked=1, active firm directly", async () => {
    const id = await makeDemoFirm("store-direct");
    const firm = await store.getDemoFirm(env.DB);
    expect(firm?.id).toBe(id);
  });

  it("returns null when no demo firm exists", async () => {
    const firm = await store.getDemoFirm(env.DB);
    expect(firm).toBeNull();
  });
});
