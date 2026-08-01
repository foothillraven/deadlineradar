import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as store from "../src/store";
import { hashPassword } from "../src/password";

/**
 * The "Forgot password" dead end (2026-07-31): the link signed you in and
 * dropped you on the dashboard, with nothing offering to set a password.
 *
 * The fix carries the reset INTENT on the login-token row. These tests are
 * mostly about the constraint that came with it: the intent must be
 * unforgeable at redemption time, because a redirect a third party can choose
 * is a way to steer someone else's browser into an account screen.
 */

const BASE = "https://deadline-radar.com";

function form(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

async function newFirm(label: string) {
  const adminEmail = `${label}-${Date.now()}-${Math.floor(performance.now())}@examplefirm.com`;
  const { id } = await store.createFirm(env.DB, { name: "Reset Test LLP", adminEmail });
  return { id, adminEmail };
}

/** Full browser flow: render the confirm page for its nonce, then POST it. */
async function redeem(rawToken: string, ip: string): Promise<Response> {
  const page = await SELF.fetch(`${BASE}/firm/login/verify?token=${encodeURIComponent(rawToken)}`, {
    headers: { "cf-connecting-ip": ip },
    redirect: "manual",
  });
  const html = await page.text();
  const nonce = /name="action_csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
  const cookie = (page.headers.get("Set-Cookie") ?? "").split(";")[0] as string;
  return SELF.fetch(`${BASE}/firm/login/verify`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "cf-connecting-ip": ip,
      Cookie: cookie,
    },
    body: form({ token: rawToken, action_csrf: nonce }),
    redirect: "manual",
  });
}

describe("reset intent survives the round trip through the email", () => {
  it("a password_reset token lands on /set-password/, not the dashboard", async () => {
    const { id } = await newFirm("reset-lands");
    const { rawToken } = await store.createLoginToken(env.DB, id, "password_reset");
    const resp = await redeem(rawToken, "203.0.113.170");
    expect(resp.status).toBe(302);
    expect(resp.headers.get("Location")).toBe("/set-password/");
    expect(resp.headers.get("Set-Cookie") ?? "").toContain("dr_firm_session=");
  });

  it("an ordinary login token still lands on the dashboard", async () => {
    const { id } = await newFirm("reset-plain");
    const { rawToken } = await store.createLoginToken(env.DB, id, "login");
    const resp = await redeem(rawToken, "203.0.113.171");
    expect(resp.headers.get("Location")).toBe("/firm-dashboard/");
  });

  it("defaults to plain login when no purpose is given", async () => {
    const { id } = await newFirm("reset-default");
    const { rawToken } = await store.createLoginToken(env.DB, id);
    const resp = await redeem(rawToken, "203.0.113.172");
    expect(resp.headers.get("Location")).toBe("/firm-dashboard/");
  });

  it("POST /firm/login with intent=password_reset issues a reset token", async () => {
    const { id, adminEmail } = await newFirm("reset-issue");
    await SELF.fetch(`${BASE}/firm/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.173" },
      body: form({ hp_website: "", admin_email: adminEmail, intent: "password_reset" }),
    });
    const row = await env.DB
      .prepare("SELECT purpose FROM firm_login_tokens WHERE firm_id = ?1 ORDER BY created_at DESC LIMIT 1")
      .bind(id)
      .first<{ purpose: string }>();
    expect(row?.purpose).toBe("password_reset");
  });

  it("still returns the SAME neutral response whether or not the email has an account", async () => {
    // The reset path must not become an enumeration oracle.
    const { adminEmail } = await newFirm("reset-enum");
    const a = await SELF.fetch(`${BASE}/firm/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.174" },
      body: form({ hp_website: "", admin_email: adminEmail, intent: "password_reset" }),
    });
    const b = await SELF.fetch(`${BASE}/firm/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.175" },
      body: form({ hp_website: "", admin_email: `nobody-${Date.now()}@examplefirm.com`, intent: "password_reset" }),
    });
    expect(a.status).toBe(b.status);
    expect(await a.text()).toBe(await b.text());
  });
});

describe("the intent must be UNFORGEABLE at redemption time", () => {
  it("a query parameter cannot turn a plain login into a password reset", async () => {
    // If the destination were driven by the URL, anyone could hand a victim a
    // link that drops them on an account screen.
    const { id } = await newFirm("reset-forge-query");
    const { rawToken } = await store.createLoginToken(env.DB, id, "login");
    const page = await SELF.fetch(
      `${BASE}/firm/login/verify?token=${encodeURIComponent(rawToken)}&intent=password_reset&purpose=password_reset`,
      { headers: { "cf-connecting-ip": "203.0.113.176" }, redirect: "manual" }
    );
    const html = await page.text();
    const nonce = /name="action_csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
    const cookie = (page.headers.get("Set-Cookie") ?? "").split(";")[0] as string;
    const resp = await SELF.fetch(`${BASE}/firm/login/verify?intent=password_reset`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "cf-connecting-ip": "203.0.113.176",
        Cookie: cookie,
      },
      body: form({ token: rawToken, action_csrf: nonce, intent: "password_reset", purpose: "password_reset" }),
      redirect: "manual",
    });
    expect(resp.headers.get("Location")).toBe("/firm-dashboard/");
  });

  it("an unrecognised purpose in the DB degrades to plain login, never to the privileged branch", async () => {
    const { id } = await newFirm("reset-garbage");
    const { rawToken } = await store.createLoginToken(env.DB, id, "login");
    await env.DB
      .prepare("UPDATE firm_login_tokens SET purpose = ?1 WHERE firm_id = ?2")
      .bind("PASSWORD_RESET; DROP--", id)
      .run();
    const resp = await redeem(rawToken, "203.0.113.177");
    expect(resp.headers.get("Location")).toBe("/firm-dashboard/");
  });

  it("normalizeLoginTokenPurpose fails safe on every odd input", () => {
    for (const v of [null, undefined, "", "Password_Reset", "PASSWORD_RESET", 1, {}, [], "login"]) {
      expect(store.normalizeLoginTokenPurpose(v)).toBe("login");
    }
    expect(store.normalizeLoginTokenPurpose("password_reset")).toBe("password_reset");
  });
});

describe("finishing a reset invalidates what came before", () => {
  it("setting a password cancels every OTHER outstanding login link", async () => {
    const { id } = await newFirm("reset-invalidate");
    // three links in flight, as happens when someone clicks "email me" twice
    const a = await store.createLoginToken(env.DB, id, "password_reset");
    const b = await store.createLoginToken(env.DB, id, "login");
    const used = await store.createLoginToken(env.DB, id, "password_reset");

    const redeemed = await redeem(used.rawToken, "203.0.113.178");
    const cookie = (redeemed.headers.get("Set-Cookie") ?? "").split(";")[0] as string;

    const setResp = await SELF.fetch(`${BASE}/firm/password`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.178", Cookie: cookie },
      body: JSON.stringify({ new_password: "a much longer passphrase here" }),
    });
    expect(setResp.status).toBe(200);

    // the other two links are now dead
    expect(await store.verifyAndConsumeLoginToken(env.DB, a.rawToken)).toBeNull();
    expect(await store.verifyAndConsumeLoginToken(env.DB, b.rawToken)).toBeNull();
  });

  it("does not touch another firm's outstanding links", async () => {
    const mine = await newFirm("reset-scope-mine");
    const theirs = await newFirm("reset-scope-theirs");
    const theirToken = await store.createLoginToken(env.DB, theirs.id, "login");

    await store.invalidateOutstandingLoginTokens(env.DB, mine.id);

    expect(await store.verifyAndConsumeLoginToken(env.DB, theirToken.rawToken)).not.toBeNull();
  });

  it("the new password actually works for signing in afterwards", async () => {
    const { id, adminEmail } = await newFirm("reset-endtoend");
    const { rawToken } = await store.createLoginToken(env.DB, id, "password_reset");
    const redeemed = await redeem(rawToken, "203.0.113.179");
    const cookie = (redeemed.headers.get("Set-Cookie") ?? "").split(";")[0] as string;

    const newPassword = "another long passphrase 42";
    const setResp = await SELF.fetch(`${BASE}/firm/password`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.179", Cookie: cookie },
      body: JSON.stringify({ new_password: newPassword }),
    });
    expect(setResp.status).toBe(200);

    const login = await SELF.fetch(`${BASE}/firm/login/password`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "cf-connecting-ip": "203.0.113.180",
        Origin: BASE,
      },
      body: form({ hp_website: "", admin_email: adminEmail, password: newPassword }),
      redirect: "manual",
    });
    expect(login.status).toBe(302);
    expect(login.headers.get("Set-Cookie") ?? "").toContain("dr_firm_session=");
  });

  it("the FIRST-TIME case works: a firm that never had a password can set one", async () => {
    // Every firm predating migration 0010 is in this state, including the
    // real production firm -- so this path must not require a current password.
    const { id } = await newFirm("reset-firsttime");
    const firmBefore = await store.getFirmById(env.DB, id);
    expect((firmBefore as unknown as { password_hash: string | null }).password_hash).toBeNull();

    const { rawToken } = await store.createLoginToken(env.DB, id, "password_reset");
    const redeemed = await redeem(rawToken, "203.0.113.181");
    const cookie = (redeemed.headers.get("Set-Cookie") ?? "").split(";")[0] as string;

    const resp = await SELF.fetch(`${BASE}/firm/password`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.181", Cookie: cookie },
      body: JSON.stringify({ new_password: "first password for this firm" }),
    });
    expect(resp.status).toBe(200);
  });

  it("THE POINT OF THE WHOLE FLOW: someone who FORGOT their password can replace it", async () => {
    // I originally wrote this test asserting a 400 -- i.e. that a firm with
    // an existing password must still prove it. That is correct for an
    // ordinary signed-in change, and completely wrong here: the person
    // clicking "Forgot password" is by definition the one who cannot supply
    // it. Asserting the old behaviour would have locked in a politer version
    // of the very dead end this change fixes. See migration 0014.
    const { id } = await newFirm("reset-forgotten");
    await store.setFirmPassword(env.DB, id, await hashPassword("the passphrase they forgot"));
    const { rawToken } = await store.createLoginToken(env.DB, id, "password_reset");
    const redeemed = await redeem(rawToken, "203.0.113.182");
    const cookie = (redeemed.headers.get("Set-Cookie") ?? "").split(";")[0] as string;

    const resp = await SELF.fetch(`${BASE}/firm/password`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.182", Cookie: cookie },
      body: JSON.stringify({ new_password: "a brand new passphrase" }),
    });
    expect(resp.status).toBe(200);
  });

  it("an ORDINARY session still must prove the current password", async () => {
    // The exemption is scoped to reset-minted sessions only. A plain login
    // session -- or a stolen cookie -- must not be able to mint a permanent
    // credential, which is what the original rule was protecting.
    const { id } = await newFirm("reset-ordinary");
    await store.setFirmPassword(env.DB, id, await hashPassword("the current passphrase"));
    const { rawToken } = await store.createLoginToken(env.DB, id, "login");
    const redeemed = await redeem(rawToken, "203.0.113.183");
    const cookie = (redeemed.headers.get("Set-Cookie") ?? "").split(";")[0] as string;

    const resp = await SELF.fetch(`${BASE}/firm/password`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.183", Cookie: cookie },
      body: JSON.stringify({ new_password: "a brand new passphrase" }),
    });
    expect(resp.status).toBe(400);
  });

  it("the reset authority is ONE-SHOT -- a second change needs the old password", async () => {
    // Otherwise a single emailed link would leave a 30-day session able to
    // rewrite the password at will without ever knowing it.
    const { id } = await newFirm("reset-oneshot");
    await store.setFirmPassword(env.DB, id, await hashPassword("the forgotten passphrase"));
    const { rawToken } = await store.createLoginToken(env.DB, id, "password_reset");
    const redeemed = await redeem(rawToken, "203.0.113.184");
    const cookie = (redeemed.headers.get("Set-Cookie") ?? "").split(";")[0] as string;

    const first = await SELF.fetch(`${BASE}/firm/password`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.184", Cookie: cookie },
      body: JSON.stringify({ new_password: "the first new passphrase" }),
    });
    expect(first.status).toBe(200);

    const second = await SELF.fetch(`${BASE}/firm/password`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.184", Cookie: cookie },
      body: JSON.stringify({ new_password: "a second new passphrase" }),
    });
    expect(second.status).toBe(400);
  });
});
