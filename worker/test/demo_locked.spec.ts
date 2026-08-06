/**
 * Task #27 (2026-08-06): demo_locked firms (migration 0024). Covers the
 * self-serve password-set gate end to end -- see index.ts's own comment on
 * handleFirmPasswordSet for why the password-RESET path stays open while
 * the "I know the current password" path is blocked.
 *
 * The SSO-linking half of this feature (handleOauthCallback) is NOT
 * covered here: exercising a real successful callback needs a validly
 * signed id_token against a live provider JWKS, which nothing else in this
 * suite mocks either (oauth.spec.ts only unit-tests token validation in
 * isolation). The guard added there is the same one-line pattern as the
 * adjacent, already-tested `firm.status !== "active"` check one line above
 * it -- verified by code review, not a synthetic end-to-end test.
 */
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as store from "../src/store";

const BASE = "https://deadline-radar.com";

function form(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

async function newFirmWithPassword(label: string, password: string): Promise<{ id: string; adminEmail: string; cookie: string }> {
  const adminEmail = `${label}-${Date.now()}-${Math.floor(performance.now())}@examplefirm.com`;
  const { id } = await store.createFirm(env.DB, { name: "Demo Lock Test LLC", adminEmail });
  const { hashPassword } = await import("../src/password");
  const hashed = await hashPassword(password);
  await env.DB.prepare(
    `UPDATE firms SET password_hash=?1, password_salt=?2, password_algo=?3, password_iterations=?4, password_rounds=?5 WHERE id=?6`
  )
    .bind(hashed.hash, hashed.salt, hashed.algo, hashed.iterations, hashed.rounds, id)
    .run();
  const { rawSessionToken } = await store.createSession(env.DB, id);
  return { id, adminEmail, cookie: `dr_firm_session=${rawSessionToken}` };
}

async function setDemoLocked(id: string, locked: boolean): Promise<void> {
  await env.DB.prepare(`UPDATE firms SET demo_locked = ?1 WHERE id = ?2`).bind(locked ? 1 : 0, id).run();
}

/** Full browser flow, same as password-reset.spec.ts's own redeem() helper. */
async function redeemResetLink(rawToken: string, ip: string): Promise<string> {
  const page = await SELF.fetch(`${BASE}/firm/login/verify?token=${encodeURIComponent(rawToken)}`, {
    headers: { "cf-connecting-ip": ip },
    redirect: "manual",
  });
  const html = await page.text();
  const nonce = /name="action_csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
  const pageCookie = (page.headers.get("Set-Cookie") ?? "").split(";")[0] as string;
  const redeemed = await SELF.fetch(`${BASE}/firm/login/verify`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": ip, Cookie: pageCookie },
    body: form({ token: rawToken, action_csrf: nonce }),
    redirect: "manual",
  });
  return (redeemed.headers.get("Set-Cookie") ?? "").split(";")[0] as string;
}

describe("demo_locked firms -- self-serve password change", () => {
  it("refuses even with the correct current password", async () => {
    const { id, cookie } = await newFirmWithPassword("demo-refuse", "the current passphrase 1");
    await setDemoLocked(id, true);

    const resp = await SELF.fetch(`${BASE}/firm/password`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.220", Cookie: cookie },
      body: JSON.stringify({ current_password: "the current passphrase 1", new_password: "a brand new passphrase 2" }),
    });
    expect(resp.status).toBe(403);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toMatch(/demo account/i);
  });

  it("a non-demo firm is unaffected -- same request succeeds normally", async () => {
    const { cookie } = await newFirmWithPassword("demo-control", "the current passphrase 3");
    const resp = await SELF.fetch(`${BASE}/firm/password`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.221", Cookie: cookie },
      body: JSON.stringify({ current_password: "the current passphrase 3", new_password: "a brand new passphrase 4" }),
    });
    expect(resp.status).toBe(200);
  });

  it("the emailed password-RESET path still works on a demo_locked firm, and ends other sessions", async () => {
    const { id, cookie: staleCookie } = await newFirmWithPassword("demo-reset-ok", "the original passphrase 5");
    await setDemoLocked(id, true);

    const { rawToken } = await store.createLoginToken(env.DB, id, "password_reset");
    const resetCookie = await redeemResetLink(rawToken, "203.0.113.222");
    expect(resetCookie).toContain("dr_firm_session=");

    const setResp = await SELF.fetch(`${BASE}/firm/password`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.222", Cookie: resetCookie },
      body: JSON.stringify({ new_password: "a rotated passphrase 6" }),
    });
    expect(setResp.status).toBe(200);

    // the pre-rotation session (the "stale" credential everyone else was
    // using) is now dead -- this is the actual lockout Devin asked for.
    const staleCheck = await SELF.fetch(`${BASE}/firm/licenses`, { headers: { Cookie: staleCookie } });
    expect(staleCheck.status).toBe(401);
  });
});
