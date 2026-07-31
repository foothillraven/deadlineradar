import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as store from "../src/store";
import { hashPassword } from "../src/password";
import { RATE_LIMIT_SUBSCRIBER_LOGIN_ACCOUNT } from "../src/validation";

/**
 * Regression suite for the login-CSRF / session-fixation class (2026-07-31).
 *
 * Two independent reviews found this class on three different routes. The
 * attack is always the same shape: an attacker gets the victim's browser to
 * complete a sign-in as the ATTACKER, so the victim then reads the
 * attacker's renewal deadlines on our own domain -- which, for a product
 * whose entire job is telling someone the right date, is a real harm even
 * though no victim data leaks.
 *
 * Two defences, because the routes differ:
 *   * magic-link routes have a GET render, so they carry a double-submit
 *     nonce bound to the path;
 *   * POST /firm/login/password has no render step, so it checks Origin.
 */

const BASE = "https://deadline-radar.com";
const EVIL = "https://evil.example";

function form(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

async function renderVerify(path: string, token: string, ip: string) {
  const page = await SELF.fetch(`${BASE}${path}?token=${encodeURIComponent(token)}`, {
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

async function postVerify(
  path: string,
  body: string,
  ip: string,
  cookie?: string
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    "cf-connecting-ip": ip,
    Origin: EVIL,
  };
  if (cookie) headers["Cookie"] = cookie;
  return SELF.fetch(`${BASE}${path}`, { method: "POST", headers, body, redirect: "manual" });
}

describe("magic-link login CSRF -- the attack, in every shape tried against it", () => {
  it("a cross-site POST with a valid token and NO nonce is refused, and does not burn the token", async () => {
    const email = `csrfx-bare-${Date.now()}@examplefirm.com`;
    const { rawToken } = await store.createSubscriberLoginToken(env.DB, email);

    const resp = await postVerify("/subscriber/login/verify", form({ token: rawToken }), "203.0.113.150");
    expect(resp.status).toBe(400);
    expect(resp.headers.get("Set-Cookie")).toBeNull();

    // the victim's own link must still work afterwards
    const good = await renderVerify("/subscriber/login/verify", rawToken, "203.0.113.150");
    const ok = await postVerify(
      "/subscriber/login/verify",
      form({ token: rawToken, action_csrf: good.nonce }),
      "203.0.113.150",
      good.cookie
    );
    expect(ok.status).toBe(302);
  });

  it("EMPTY STRING in both halves is refused -- absent must never equal absent", async () => {
    const { rawToken } = await store.createSubscriberLoginToken(env.DB, `csrfx-empty-${Date.now()}@examplefirm.com`);
    const resp = await postVerify(
      "/subscriber/login/verify",
      form({ token: rawToken, action_csrf: "" }),
      "203.0.113.151",
      "dr_action_csrf="
    );
    expect(resp.status).toBe(400);
  });

  it("an attacker-chosen matching pair does not work, because the value is path-bound", async () => {
    const { rawToken } = await store.createSubscriberLoginToken(env.DB, `csrfx-chosen-${Date.now()}@examplefirm.com`);
    const resp = await postVerify(
      "/subscriber/login/verify",
      form({ token: rawToken, action_csrf: "chosen" }),
      "203.0.113.152",
      "dr_action_csrf=chosen"
    );
    expect(resp.status).toBe(400);
  });

  it("a nonce minted on the FIRM route is refused on the SUBSCRIBER route", async () => {
    // Path binding: without it, one login route hands out a nonce the other
    // will accept.
    const { id } = await store.createFirm(env.DB, {
      name: "Path Binding LLP",
      adminEmail: `pathbind-${Date.now()}@examplefirm.com`,
    });
    const firmToken = (await store.createLoginToken(env.DB, id)).rawToken;
    const firmSide = await renderVerify("/firm/login/verify", firmToken, "203.0.113.153");
    expect(firmSide.nonce).not.toBe("");

    const subToken = (await store.createSubscriberLoginToken(env.DB, `csrfx-path-${Date.now()}@examplefirm.com`))
      .rawToken;
    const resp = await postVerify(
      "/subscriber/login/verify",
      form({ token: subToken, action_csrf: firmSide.nonce }),
      "203.0.113.153",
      firmSide.cookie
    );
    expect(resp.status).toBe(400);
  });

  it("the token is refused in the QUERY STRING even alongside a valid nonce pair", async () => {
    // The query fallback exists only for RFC 8058 one-click unsubscribe. On
    // a route that grants a session it makes the attack a bare URL.
    const email = `csrfx-query-${Date.now()}@examplefirm.com`;
    const { rawToken } = await store.createSubscriberLoginToken(env.DB, email);
    const rendered = await renderVerify("/subscriber/login/verify", rawToken, "203.0.113.154");

    const resp = await SELF.fetch(
      `${BASE}/subscriber/login/verify?token=${encodeURIComponent(rawToken)}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "cf-connecting-ip": "203.0.113.154",
          Cookie: rendered.cookie,
        },
        body: form({ action_csrf: rendered.nonce }),
        redirect: "manual",
      }
    );
    expect(resp.status).toBe(400);

    const row = await env.DB
      .prepare("SELECT used_at FROM subscriber_login_tokens WHERE email_normalized = ?1")
      .bind(email.toLowerCase())
      .first<{ used_at: string | null }>();
    expect(row?.used_at).toBeNull();
  });

  it("the confirm page refuses to be framed and is not cached", async () => {
    const { rawToken } = await store.createSubscriberLoginToken(env.DB, `csrfx-frame-${Date.now()}@examplefirm.com`);
    const { page } = await renderVerify("/subscriber/login/verify", rawToken, "203.0.113.155");
    expect(page.headers.get("X-Frame-Options")).toBe("DENY");
    expect(page.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(page.headers.get("Cache-Control")).toContain("no-store");
    expect(page.headers.get("Referrer-Policy")).toBe("no-referrer");
  });
});

describe("POST /firm/login/password -- same attack, no render step, so Origin is the defence", () => {
  async function firmWithPassword(password: string) {
    const adminEmail = `pwcsrf-${Date.now()}-${Math.floor(performance.now())}@examplefirm.com`;
    const { id } = await store.createFirm(env.DB, { name: "Origin Check LLP", adminEmail });
    const rec = await hashPassword(password);
    await store.setFirmPassword(env.DB, id, rec);
    return { id, adminEmail };
  }

  it("REFUSES a cross-site form POST -- the paid tier's revenue path", async () => {
    const password = "correct horse battery staple";
    const { adminEmail } = await firmWithPassword(password);

    const resp = await SELF.fetch(`${BASE}/firm/login/password`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "cf-connecting-ip": "203.0.113.160",
        Origin: EVIL,
      },
      body: form({ hp_website: "", admin_email: adminEmail, password }),
      redirect: "manual",
    });

    expect(resp.status).toBe(400);
    expect(resp.headers.get("Set-Cookie")).toBeNull();
  });

  it("ALLOWS the honest same-origin POST", async () => {
    const password = "correct horse battery staple";
    const { adminEmail } = await firmWithPassword(password);

    const resp = await SELF.fetch(`${BASE}/firm/login/password`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "cf-connecting-ip": "203.0.113.161",
        Origin: BASE,
      },
      body: form({ hp_website: "", admin_email: adminEmail, password }),
      redirect: "manual",
    });

    expect(resp.status).toBe(302);
    expect(resp.headers.get("Set-Cookie") ?? "").toContain("dr_firm_session=");
  });

  it("ALLOWS a POST with no Origin header at all (non-browser clients)", async () => {
    const password = "correct horse battery staple";
    const { adminEmail } = await firmWithPassword(password);

    const resp = await SELF.fetch(`${BASE}/firm/login/password`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.162" },
      body: form({ hp_website: "", admin_email: adminEmail, password }),
      redirect: "manual",
    });

    expect(resp.status).toBe(302);
  });

  it("a refused cross-site attempt does NOT consume the victim's rate-limit budget", async () => {
    // The Origin check runs before the rate limit for exactly this reason:
    // otherwise the CSRF fix would hand an attacker a lockout instead.
    const password = "correct horse battery staple";
    const { adminEmail } = await firmWithPassword(password);
    const ip = "203.0.113.163";

    for (let i = 0; i < 12; i++) {
      await SELF.fetch(`${BASE}/firm/login/password`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "cf-connecting-ip": ip,
          Origin: EVIL,
        },
        body: form({ hp_website: "", admin_email: adminEmail, password }),
      });
    }

    const honest = await SELF.fetch(`${BASE}/firm/login/password`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "cf-connecting-ip": ip,
        Origin: BASE,
      },
      body: form({ hp_website: "", admin_email: adminEmail, password }),
      redirect: "manual",
    });
    expect(honest.status).toBe(302);
  });
});

describe("the mail-bomb cap must not become a silent lockout", () => {
  it("an attacker cannot exhaust a NON-subscriber's budget, because nothing is charged", async () => {
    const victim = `lockout-new-${Date.now()}@examplefirm.com`;

    // attacker burns requests at an address with no account
    for (let i = 0; i < 8; i++) {
      await SELF.fetch(`${BASE}/subscriber/login`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": `198.18.1.${i + 1}` },
        body: form({ hp_website: "", email: victim }),
      });
    }

    // the victim then signs up for real, and their own request must work
    await store.addPending(env.DB, {
      email: victim,
      stateSlug: "texas",
      deadlineFields: {},
      firstName: null,
      skipConfirmation: true,
    });
    await SELF.fetch(`${BASE}/subscriber/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "198.18.9.9" },
      body: form({ hp_website: "", email: victim }),
    });

    let count = 0;
    for (let i = 0; i < 40 && count === 0; i++) {
      const row = await env.DB
        .prepare("SELECT COUNT(*) AS c FROM subscriber_login_tokens WHERE email_normalized = ?1")
        .bind(victim.toLowerCase())
        .first<{ c: number }>();
      count = row?.c ?? 0;
      if (count === 0) await new Promise((r) => setTimeout(r, 25));
    }
    expect(count).toBe(1);
  });

  it("still caps a real subscriber at the configured hourly maximum", async () => {
    const victim = `lockout-real-${Date.now()}@examplefirm.com`;
    await store.addPending(env.DB, {
      email: victim,
      stateSlug: "ohio",
      deadlineFields: {},
      firstName: null,
      skipConfirmation: true,
    });

    for (let i = 0; i < 12; i++) {
      await SELF.fetch(`${BASE}/subscriber/login`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": `198.18.2.${i + 1}` },
        body: form({ hp_website: "", email: victim }),
      });
    }
    await new Promise((r) => setTimeout(r, 250));

    const row = await env.DB
      .prepare("SELECT COUNT(*) AS c FROM subscriber_login_tokens WHERE email_normalized = ?1")
      .bind(victim.toLowerCase())
      .first<{ c: number }>();
    expect(row?.c ?? 0).toBeGreaterThan(0);
    expect(row?.c ?? 0).toBeLessThanOrEqual(RATE_LIMIT_SUBSCRIBER_LOGIN_ACCOUNT.max);
  });
});
