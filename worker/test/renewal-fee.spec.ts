/**
 * Self-reported per-license renewal fee (2026-08-07, roadmap #7, migration
 * 0034). Never a verified/sourced fact -- see that migration's own
 * docstring for why. The rollup itself is computed client-side from the
 * SAME GET /firm/licenses response every other roster stat already uses,
 * so there's no separate aggregate endpoint to test here.
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

describe("POST /firm/licenses with renewal_fee", () => {
  it("creates with no fee when omitted", async () => {
    const { cookie } = await createFirmWithSession("No Fee Firm", `nofee-${Date.now()}@example.com`);
    const resp = await SELF.fetch(`${BASE}/firm/licenses`, {
      method: "POST",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        staff_label: "No Fee Staff",
        email: `nofeestaff-${Date.now()}@example.com`,
        state_slug: "georgia",
        license_type_id: "ga-individual",
      }),
    });
    expect(resp.status).toBe(201);
    const body = (await resp.json()) as { renewal_fee_cents: number | null };
    expect(body.renewal_fee_cents).toBeNull();
  });

  it("creates with a valid fee, stored in cents", async () => {
    const { cookie } = await createFirmWithSession("Fee Firm", `fee-${Date.now()}@example.com`);
    const resp = await SELF.fetch(`${BASE}/firm/licenses`, {
      method: "POST",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        staff_label: "Fee Staff",
        email: `feestaff-${Date.now()}@example.com`,
        state_slug: "georgia",
        license_type_id: "ga-individual",
        renewal_fee: "199.50",
      }),
    });
    expect(resp.status).toBe(201);
    const body = (await resp.json()) as { renewal_fee_cents: number | null };
    expect(body.renewal_fee_cents).toBe(19950);
  });

  it("rejects a garbage fee value", async () => {
    const { cookie } = await createFirmWithSession("Bad Fee Firm", `badfee-${Date.now()}@example.com`);
    const resp = await SELF.fetch(`${BASE}/firm/licenses`, {
      method: "POST",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        staff_label: "Bad Fee Staff",
        email: `badfeestaff-${Date.now()}@example.com`,
        state_slug: "georgia",
        license_type_id: "ga-individual",
        renewal_fee: "not-a-fee",
      }),
    });
    expect(resp.status).toBe(400);
  });

  it("rejects a negative fee", async () => {
    const { cookie } = await createFirmWithSession("Negative Fee Firm", `negfee-${Date.now()}@example.com`);
    const resp = await SELF.fetch(`${BASE}/firm/licenses`, {
      method: "POST",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        staff_label: "Negative Fee Staff",
        email: `negfeestaff-${Date.now()}@example.com`,
        state_slug: "georgia",
        license_type_id: "ga-individual",
        renewal_fee: "-50",
      }),
    });
    expect(resp.status).toBe(400);
  });
});

describe("PATCH /firm/licenses/:id with renewal_fee", () => {
  async function addStaff(cookie: string): Promise<{ id: string }> {
    const resp = await SELF.fetch(`${BASE}/firm/licenses`, {
      method: "POST",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        staff_label: "Patch Fee Staff",
        email: `patchfeestaff-${Date.now()}@example.com`,
        state_slug: "georgia",
        license_type_id: "ga-individual",
      }),
    });
    return (await resp.json()) as { id: string };
  }

  it("sets a fee via PATCH", async () => {
    const { cookie } = await createFirmWithSession("Patch Fee Firm", `patchfee-${Date.now()}@example.com`);
    const staff = await addStaff(cookie);
    const resp = await SELF.fetch(`${BASE}/firm/licenses/${staff.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({ renewal_fee: "350" }),
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { renewal_fee_cents: number | null };
    expect(body.renewal_fee_cents).toBe(35000);
  });

  it("clears a fee via PATCH with an empty string", async () => {
    const { cookie } = await createFirmWithSession("Clear Fee Firm", `clearfee-${Date.now()}@example.com`);
    const staff = await addStaff(cookie);
    await SELF.fetch(`${BASE}/firm/licenses/${staff.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({ renewal_fee: "350" }),
    });
    const clearResp = await SELF.fetch(`${BASE}/firm/licenses/${staff.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({ renewal_fee: "" }),
    });
    expect(clearResp.status).toBe(200);
    const body = (await clearResp.json()) as { renewal_fee_cents: number | null };
    expect(body.renewal_fee_cents).toBeNull();
  });

  it("leaves the fee untouched when the field is omitted from the PATCH body", async () => {
    const { cookie } = await createFirmWithSession("Untouched Fee Firm", `untouchedfee-${Date.now()}@example.com`);
    const staff = await addStaff(cookie);
    await SELF.fetch(`${BASE}/firm/licenses/${staff.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({ renewal_fee: "350" }),
    });
    const unrelatedResp = await SELF.fetch(`${BASE}/firm/licenses/${staff.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({ staff_label: "Renamed, Fee Untouched" }),
    });
    expect(unrelatedResp.status).toBe(200);
    const body = (await unrelatedResp.json()) as { renewal_fee_cents: number | null; staff_label: string };
    expect(body.staff_label).toBe("Renamed, Fee Untouched");
    expect(body.renewal_fee_cents).toBe(35000);
  });
});
