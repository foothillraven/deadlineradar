/**
 * Office/department tag (2026-08-07, roadmap #16, migration 0037). Plain
 * free text, same posture as staff_label -- see that migration's own
 * docstring for why this is not a normalized office/department table.
 * "Bulk" tagging is deliberately NOT a new endpoint -- the frontend applies
 * a tag to N selected staff by issuing N of these same PATCH calls, so
 * there's no separate bulk route to test here.
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

describe("POST /firm/licenses with office_tag", () => {
  it("creates with no tag when omitted", async () => {
    const { cookie } = await createFirmWithSession("No Tag Firm", `notag-${Date.now()}@example.com`);
    const resp = await SELF.fetch(`${BASE}/firm/licenses`, {
      method: "POST",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        staff_label: "No Tag Staff",
        email: `notagstaff-${Date.now()}@example.com`,
        state_slug: "georgia",
        license_type_id: "ga-individual",
      }),
    });
    expect(resp.status).toBe(201);
    const body = (await resp.json()) as { office_tag: string | null };
    expect(body.office_tag).toBeNull();
  });

  it("creates with a tag", async () => {
    const { cookie } = await createFirmWithSession("Tag Firm", `tag-${Date.now()}@example.com`);
    const resp = await SELF.fetch(`${BASE}/firm/licenses`, {
      method: "POST",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        staff_label: "Tag Staff",
        email: `tagstaff-${Date.now()}@example.com`,
        state_slug: "georgia",
        license_type_id: "ga-individual",
        office_tag: "Downtown office",
      }),
    });
    expect(resp.status).toBe(201);
    const body = (await resp.json()) as { office_tag: string | null };
    expect(body.office_tag).toBe("Downtown office");
  });
});

describe("PATCH /firm/licenses/:id with office_tag", () => {
  async function addStaff(cookie: string): Promise<{ id: string }> {
    const resp = await SELF.fetch(`${BASE}/firm/licenses`, {
      method: "POST",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        staff_label: "Patch Tag Staff",
        email: `patchtagstaff-${Date.now()}-${Math.random()}@example.com`,
        state_slug: "georgia",
        license_type_id: "ga-individual",
      }),
    });
    return (await resp.json()) as { id: string };
  }

  it("sets a tag via PATCH", async () => {
    const { cookie } = await createFirmWithSession("Patch Tag Firm", `patchtag-${Date.now()}@example.com`);
    const staff = await addStaff(cookie);
    const resp = await SELF.fetch(`${BASE}/firm/licenses/${staff.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({ office_tag: "Audit team" }),
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { office_tag: string | null };
    expect(body.office_tag).toBe("Audit team");
  });

  it("clears a tag via PATCH with an empty string", async () => {
    const { cookie } = await createFirmWithSession("Clear Tag Firm", `cleartag-${Date.now()}@example.com`);
    const staff = await addStaff(cookie);
    await SELF.fetch(`${BASE}/firm/licenses/${staff.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({ office_tag: "Audit team" }),
    });
    const clearResp = await SELF.fetch(`${BASE}/firm/licenses/${staff.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({ office_tag: "" }),
    });
    expect(clearResp.status).toBe(200);
    const body = (await clearResp.json()) as { office_tag: string | null };
    expect(body.office_tag).toBeNull();
  });

  it("leaves the tag untouched when the field is omitted from the PATCH body", async () => {
    const { cookie } = await createFirmWithSession("Untouched Tag Firm", `untouchedtag-${Date.now()}@example.com`);
    const staff = await addStaff(cookie);
    await SELF.fetch(`${BASE}/firm/licenses/${staff.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({ office_tag: "Tax dept" }),
    });
    const unrelatedResp = await SELF.fetch(`${BASE}/firm/licenses/${staff.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({ staff_label: "Renamed, Tag Untouched" }),
    });
    expect(unrelatedResp.status).toBe(200);
    const body = (await unrelatedResp.json()) as { office_tag: string | null; staff_label: string };
    expect(body.staff_label).toBe("Renamed, Tag Untouched");
    expect(body.office_tag).toBe("Tax dept");
  });

  it("bulk-applies a tag to multiple staff via sequential PATCH calls, without touching other fields", async () => {
    const { cookie } = await createFirmWithSession("Bulk Tag Firm", `bulktag-${Date.now()}@example.com`);
    const staffA = await addStaff(cookie);
    const staffB = await addStaff(cookie);
    for (const s of [staffA, staffB]) {
      const resp = await SELF.fetch(`${BASE}/firm/licenses/${s.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", Cookie: cookie },
        body: JSON.stringify({ office_tag: "West region" }),
      });
      expect(resp.status).toBe(200);
    }
    const listResp = await SELF.fetch(`${BASE}/firm/licenses`, { headers: { Cookie: cookie } });
    const listBody = (await listResp.json()) as { licenses: { id: string; office_tag: string | null; staff_label: string }[] };
    const tagged = listBody.licenses.filter((r) => r.id === staffA.id || r.id === staffB.id);
    expect(tagged).toHaveLength(2);
    tagged.forEach((r) => {
      expect(r.office_tag).toBe("West region");
      expect(r.staff_label).toBe("Patch Tag Staff");
    });
  });

  it("truncates a tag longer than the length cap rather than rejecting it", async () => {
    const { cookie } = await createFirmWithSession("Long Tag Firm", `longtag-${Date.now()}@example.com`);
    const staff = await addStaff(cookie);
    const longTag = "x".repeat(200);
    const resp = await SELF.fetch(`${BASE}/firm/licenses/${staff.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({ office_tag: longTag }),
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { office_tag: string | null };
    expect(body.office_tag).toHaveLength(60);
  });
});
