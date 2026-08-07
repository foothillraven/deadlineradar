/**
 * Self-reported CPE carryover hours (2026-08-07, roadmap #10, migration
 * 0036). Never a state-asserted fact -- see that migration's own docstring
 * for why. Edit-only (no create-time field), unlike renewal_fee -- see
 * store.ts's own comment on addPending().
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

async function addStaff(cookie: string): Promise<{ id: string }> {
  const resp = await SELF.fetch(`${BASE}/firm/licenses`, {
    method: "POST",
    headers: { "content-type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      staff_label: "Carryover Staff",
      email: `carryoverstaff-${Date.now()}-${Math.random()}@example.com`,
      state_slug: "georgia",
      license_type_id: "ga-individual",
    }),
  });
  return (await resp.json()) as { id: string };
}

describe("POST /firm/licenses (carryover_hours)", () => {
  it("creates with no carryover hours -- there is no create-time field for it", async () => {
    const { cookie } = await createFirmWithSession("No Carryover Firm", `nocarry-${Date.now()}@example.com`);
    const staff = await addStaff(cookie);
    const listResp = await SELF.fetch(`${BASE}/firm/licenses`, { headers: { Cookie: cookie } });
    const listBody = (await listResp.json()) as { licenses: { id: string; carryover_hours: number | null }[] };
    const row = listBody.licenses.find((i) => i.id === staff.id);
    expect(row?.carryover_hours).toBeNull();
  });
});

describe("PATCH /firm/licenses/:id (carryover_hours)", () => {
  it("sets carryover hours via PATCH", async () => {
    const { cookie } = await createFirmWithSession("Patch Carryover Firm", `patchcarry-${Date.now()}@example.com`);
    const staff = await addStaff(cookie);
    const resp = await SELF.fetch(`${BASE}/firm/licenses/${staff.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({ carryover_hours: "12.5" }),
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { carryover_hours: number | null };
    expect(body.carryover_hours).toBe(12.5);
  });

  it("clears carryover hours via PATCH with an empty string", async () => {
    const { cookie } = await createFirmWithSession("Clear Carryover Firm", `clearcarry-${Date.now()}@example.com`);
    const staff = await addStaff(cookie);
    await SELF.fetch(`${BASE}/firm/licenses/${staff.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({ carryover_hours: "12.5" }),
    });
    const clearResp = await SELF.fetch(`${BASE}/firm/licenses/${staff.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({ carryover_hours: "" }),
    });
    expect(clearResp.status).toBe(200);
    const body = (await clearResp.json()) as { carryover_hours: number | null };
    expect(body.carryover_hours).toBeNull();
  });

  it("leaves carryover hours untouched when the field is omitted from the PATCH body", async () => {
    const { cookie } = await createFirmWithSession("Untouched Carryover Firm", `untouchedcarry-${Date.now()}@example.com`);
    const staff = await addStaff(cookie);
    await SELF.fetch(`${BASE}/firm/licenses/${staff.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({ carryover_hours: "8" }),
    });
    const unrelatedResp = await SELF.fetch(`${BASE}/firm/licenses/${staff.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({ staff_label: "Renamed, Carryover Untouched" }),
    });
    expect(unrelatedResp.status).toBe(200);
    const body = (await unrelatedResp.json()) as { carryover_hours: number | null; staff_label: string };
    expect(body.staff_label).toBe("Renamed, Carryover Untouched");
    expect(body.carryover_hours).toBe(8);
  });

  it("rejects a garbage carryover value", async () => {
    const { cookie } = await createFirmWithSession("Bad Carryover Firm", `badcarry-${Date.now()}@example.com`);
    const staff = await addStaff(cookie);
    const resp = await SELF.fetch(`${BASE}/firm/licenses/${staff.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({ carryover_hours: "not-a-number" }),
    });
    expect(resp.status).toBe(400);
  });

  it("rejects a negative carryover value", async () => {
    const { cookie } = await createFirmWithSession("Negative Carryover Firm", `negcarry-${Date.now()}@example.com`);
    const staff = await addStaff(cookie);
    const resp = await SELF.fetch(`${BASE}/firm/licenses/${staff.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({ carryover_hours: "-5" }),
    });
    expect(resp.status).toBe(400);
  });

  it("rejects a carryover value above the sanity cap", async () => {
    const { cookie } = await createFirmWithSession("Too Big Carryover Firm", `bigcarry-${Date.now()}@example.com`);
    const staff = await addStaff(cookie);
    const resp = await SELF.fetch(`${BASE}/firm/licenses/${staff.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({ carryover_hours: "500" }),
    });
    expect(resp.status).toBe(400);
  });
});
