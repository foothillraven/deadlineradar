import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as store from "../src/store";

// Roadmap #52 (2026-08-07): self-service active-session view. Same
// list/delete + auth/CSRF/ownership/rate-limit test shape as the
// oauth-identities suite in worker.spec.ts, applied to firm_sessions.
//
// store.createSession() only ever returned rawSessionToken (the id it
// generates internally was historically discarded) -- verifySession()
// resolves the real row id from the token the same way requireFirmSession()
// itself does, so tests don't need a second, parallel way to mint a session.
async function sessionIdFor(rawSessionToken: string): Promise<string> {
  const verified = await store.verifySession(env.DB, rawSessionToken);
  if (!verified) throw new Error("session unexpectedly missing");
  return verified.sessionId;
}

describe("GET/DELETE /firm/sessions -- self-service session list", () => {
  async function callList(cookie: string | null): Promise<Response> {
    const headers: Record<string, string> = { "cf-connecting-ip": "203.0.113.250" };
    if (cookie) headers["Cookie"] = cookie;
    return SELF.fetch("https://deadline-radar.com/firm/sessions", { headers });
  }
  async function callDelete(id: string, cookie: string | null, origin?: string): Promise<Response> {
    const headers: Record<string, string> = { "cf-connecting-ip": "203.0.113.251" };
    if (cookie) headers["Cookie"] = cookie;
    if (origin) headers["Origin"] = origin;
    return SELF.fetch(`https://deadline-radar.com/firm/sessions/${id}`, { method: "DELETE", headers });
  }

  it("requires a session", async () => {
    expect((await callList(null)).status).toBe(401);
    expect((await callDelete("anything", null)).status).toBe(401);
  });

  it("lists this firm's own sessions with is_current set correctly, and revokes an other one", async () => {
    const email = `sess-${Date.now()}@examplefirm.com`;
    const { id: firmId } = await store.createFirm(env.DB, { name: "Session Firm", adminEmail: email });
    const first = await store.createSession(env.DB, firmId);
    const second = await store.createSession(env.DB, firmId);
    const cookie = `dr_firm_session=${first.rawSessionToken}`;
    const firstId = await sessionIdFor(first.rawSessionToken);
    const secondId = await sessionIdFor(second.rawSessionToken);

    const list = await callList(cookie);
    expect(list.status).toBe(200);
    const body = await list.json<{ sessions: Array<{ id: string; is_current: boolean }> }>();
    expect(body.sessions).toHaveLength(2);
    const currentRow = body.sessions.find((s) => s.id === firstId);
    const otherRow = body.sessions.find((s) => s.id === secondId);
    expect(currentRow?.is_current).toBe(true);
    expect(otherRow?.is_current).toBe(false);

    expect((await callDelete(secondId, cookie, "https://deadline-radar.com")).status).toBe(200);
    expect((await (await callList(cookie)).json<{ sessions: unknown[] }>()).sessions).toHaveLength(1);
  });

  it("refuses to revoke the caller's own current session (400, not silently ignored)", async () => {
    const email = `sess-self-${Date.now()}@examplefirm.com`;
    const { id: firmId } = await store.createFirm(env.DB, { name: "Session Self Firm", adminEmail: email });
    const { rawSessionToken } = await store.createSession(env.DB, firmId);
    const cookie = `dr_firm_session=${rawSessionToken}`;
    const ownId = await sessionIdFor(rawSessionToken);

    const resp = await callDelete(ownId, cookie, "https://deadline-radar.com");
    expect(resp.status).toBe(400);
    // Still logged in -- the session was not deleted.
    expect((await callList(cookie)).status).toBe(200);
  });

  it("CROSS-FIRM: cannot see or revoke another firm's session, and returns a generic 404 not a 403", async () => {
    const victimEmail = `sess-victim-${Date.now()}@examplefirm.com`;
    const { id: victimId } = await store.createFirm(env.DB, { name: "Session Victim", adminEmail: victimEmail });
    const victimSession = await store.createSession(env.DB, victimId);
    const victimSessionId = await sessionIdFor(victimSession.rawSessionToken);

    const { id: attackerId } = await store.createFirm(env.DB, {
      name: "Session Attacker",
      adminEmail: `sess-attacker-${Date.now()}@examplefirm.com`,
    });
    const { rawSessionToken } = await store.createSession(env.DB, attackerId);
    const cookie = `dr_firm_session=${rawSessionToken}`;

    expect((await (await callList(cookie)).json<{ sessions: Array<{ id: string }> }>()).sessions).toHaveLength(1);
    expect((await callDelete(victimSessionId, cookie, "https://deadline-radar.com")).status).toBe(404);
    expect(await store.listSessionsForFirm(env.DB, victimId)).toHaveLength(1);
  });

  it("DELETE is rejected when Origin doesn't match (CSRF defense-in-depth)", async () => {
    const email = `sess-csrf-${Date.now()}@examplefirm.com`;
    const { id: firmId } = await store.createFirm(env.DB, { name: "Session CSRF Firm", adminEmail: email });
    const first = await store.createSession(env.DB, firmId);
    const second = await store.createSession(env.DB, firmId);
    const cookie = `dr_firm_session=${first.rawSessionToken}`;
    const secondId = await sessionIdFor(second.rawSessionToken);

    const resp = await callDelete(secondId, cookie, "https://attacker.example");
    expect(resp.status).toBe(400);
    expect(await store.listSessionsForFirm(env.DB, firmId)).toHaveLength(2);
  });

  it("DELETE /firm/sessions/:id is rate-limited per firm", async () => {
    const email = `sess-rate-${Date.now()}@examplefirm.com`;
    const { id: firmId } = await store.createFirm(env.DB, { name: "Session Rate Firm", adminEmail: email });
    const { rawSessionToken } = await store.createSession(env.DB, firmId);
    const cookie = `dr_firm_session=${rawSessionToken}`;
    let sawA429 = false;
    for (let i = 0; i < 15; i++) {
      const resp = await callDelete("does-not-exist", cookie, "https://deadline-radar.com");
      if (resp.status === 429) {
        sawA429 = true;
        break;
      }
      expect(resp.status).toBe(404);
    }
    expect(sawA429, "expected a 429 within the RATE_LIMIT_FIRM_SESSION_REVOKE ceiling (10/hour) -- got none in 15 requests").toBe(true);
  }, 20000);
});
