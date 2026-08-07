/**
 * "What changed since your last login" (2026-08-07, roadmap #66). No new
 * migration -- firm_sessions.created_at already records every login,
 * store.getPreviousLoginAt() just reads the most recent OTHER session's
 * created_at. Surfaced on GET /firm/licenses (previous_login_at), the one
 * call the dashboard already makes on every load.
 */
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as store from "../src/store";

const BASE = "https://deadline-radar.com";

describe("GET /firm/licenses -- previous_login_at", () => {
  it("is null on a firm's very first-ever session", async () => {
    const email = `prevlogin-first-${Date.now()}@examplefirm.com`;
    const { id: firmId } = await store.createFirm(env.DB, { name: "First Login Firm", adminEmail: email });
    const { rawSessionToken } = await store.createSession(env.DB, firmId);
    const resp = await SELF.fetch(`${BASE}/firm/licenses`, {
      headers: { Cookie: `dr_firm_session=${rawSessionToken}` },
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { previous_login_at: string | null };
    expect(body.previous_login_at).toBeNull();
  });

  it("reflects the most recent OTHER session once a second one exists", async () => {
    const email = `prevlogin-second-${Date.now()}@examplefirm.com`;
    const { id: firmId } = await store.createFirm(env.DB, { name: "Second Login Firm", adminEmail: email });
    const first = await store.createSession(env.DB, firmId);
    const firstVerified = await store.verifySession(env.DB, first.rawSessionToken);
    const second = await store.createSession(env.DB, firmId);

    const resp = await SELF.fetch(`${BASE}/firm/licenses`, {
      headers: { Cookie: `dr_firm_session=${second.rawSessionToken}` },
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { previous_login_at: string | null };
    // The session making the request is `second` -- previous_login_at
    // should be `first`'s created_at, not second's own.
    const firstRow = await env.DB.prepare(`SELECT created_at FROM firm_sessions WHERE id = ?1`).bind(firstVerified!.sessionId).first<{ created_at: string }>();
    expect(body.previous_login_at).toBe(firstRow!.created_at);
  });

  it("CROSS-FIRM: never reflects another firm's session", async () => {
    const emailA = `prevlogin-a-${Date.now()}@examplefirm.com`;
    const emailB = `prevlogin-b-${Date.now()}@examplefirm.com`;
    const { id: firmA } = await store.createFirm(env.DB, { name: "Firm A", adminEmail: emailA });
    const { id: firmB } = await store.createFirm(env.DB, { name: "Firm B", adminEmail: emailB });
    await store.createSession(env.DB, firmA);
    await store.createSession(env.DB, firmA);
    const { rawSessionToken } = await store.createSession(env.DB, firmB);

    const resp = await SELF.fetch(`${BASE}/firm/licenses`, {
      headers: { Cookie: `dr_firm_session=${rawSessionToken}` },
    });
    const body = (await resp.json()) as { previous_login_at: string | null };
    // Firm B has only ever had this one session -- Firm A's sessions must
    // never leak in as a false "previous login".
    expect(body.previous_login_at).toBeNull();
  });
});
