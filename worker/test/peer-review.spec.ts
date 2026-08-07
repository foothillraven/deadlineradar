/**
 * Firm-level peer-review deadline tracking (2026-08-07, roadmap #6,
 * migration 0033). A single admin-entered date, firm-level not per-staff.
 */
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as store from "../src/store";

const BASE = "https://deadline-radar.com";

async function createFirmWithSession(name: string, adminEmail: string): Promise<{ firmId: string; cookie: string }> {
  const firm = await store.createFirm(env.DB, { name, adminEmail });
  const { rawSessionToken } = await store.createSession(env.DB, firm.id);
  return { firmId: firm.id, cookie: `dr_firm_session=${rawSessionToken}` };
}

describe("PATCH /firm/peer-review", () => {
  it("401s with no session", async () => {
    const resp = await SELF.fetch(`${BASE}/firm/peer-review`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ due_date: "2027-06-30" }),
    });
    expect(resp.status).toBe(401);
  });

  it("GET /firm/licenses reports peer_review_due_date:null for a brand-new firm", async () => {
    const { cookie } = await createFirmWithSession("Peer Review Firm", `peerreview-${Date.now()}@example.com`);
    const resp = await SELF.fetch(`${BASE}/firm/licenses`, { headers: { Cookie: cookie } });
    const body = (await resp.json()) as { peer_review_due_date: string | null };
    expect(body.peer_review_due_date).toBeNull();
  });

  it("sets a valid date and it round-trips through GET /firm/licenses", async () => {
    const { cookie } = await createFirmWithSession("Set Date Firm", `setdate-${Date.now()}@example.com`);
    const patchResp = await SELF.fetch(`${BASE}/firm/peer-review`, {
      method: "PATCH",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({ due_date: "2027-06-30" }),
    });
    expect(patchResp.status).toBe(200);
    const patchBody = (await patchResp.json()) as { peer_review_due_date: string };
    expect(patchBody.peer_review_due_date).toBe("2027-06-30");

    const getResp = await SELF.fetch(`${BASE}/firm/licenses`, { headers: { Cookie: cookie } });
    const getBody = (await getResp.json()) as { peer_review_due_date: string | null };
    expect(getBody.peer_review_due_date).toBe("2027-06-30");
  });

  it("clears a previously-set date with due_date:null", async () => {
    const { cookie } = await createFirmWithSession("Clear Date Firm", `cleardate-${Date.now()}@example.com`);
    await SELF.fetch(`${BASE}/firm/peer-review`, {
      method: "PATCH",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({ due_date: "2027-06-30" }),
    });
    const clearResp = await SELF.fetch(`${BASE}/firm/peer-review`, {
      method: "PATCH",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({ due_date: null }),
    });
    expect(clearResp.status).toBe(200);
    const getResp = await SELF.fetch(`${BASE}/firm/licenses`, { headers: { Cookie: cookie } });
    const getBody = (await getResp.json()) as { peer_review_due_date: string | null };
    expect(getBody.peer_review_due_date).toBeNull();
  });

  it("rejects an unparseable date", async () => {
    const { cookie } = await createFirmWithSession("Bad Date Firm", `baddate-${Date.now()}@example.com`);
    const resp = await SELF.fetch(`${BASE}/firm/peer-review`, {
      method: "PATCH",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({ due_date: "not-a-date" }),
    });
    expect(resp.status).toBe(400);
  });

  it("does not touch another firm's peer-review date", async () => {
    const { cookie: cookieA } = await createFirmWithSession("Isolation Peer A", `peera-${Date.now()}@example.com`);
    const { firmId: firmIdB } = await createFirmWithSession("Isolation Peer B", `peerb-${Date.now()}@example.com`);
    await SELF.fetch(`${BASE}/firm/peer-review`, {
      method: "PATCH",
      headers: { "content-type": "application/json", Cookie: cookieA },
      body: JSON.stringify({ due_date: "2027-01-01" }),
    });
    const firmB = await store.getFirmById(env.DB, firmIdB);
    expect(firmB?.peer_review_due_date).toBeNull();
  });
});
