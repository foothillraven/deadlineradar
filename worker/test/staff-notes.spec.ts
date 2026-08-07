/**
 * Internal-only staff notes (2026-08-07, roadmap #68, migration 0041). Same
 * "plain free text, no implied structure" posture as office_tag (migration
 * 0037) -- see that file's own docstring. Edit-only, same as carryover_hours
 * -- no create-time field, so no POST /firm/licenses coverage here.
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

describe("PATCH /firm/licenses/:id with internal_notes", () => {
  async function addStaff(cookie: string): Promise<{ id: string }> {
    const resp = await SELF.fetch(`${BASE}/firm/licenses`, {
      method: "POST",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        staff_label: "Notes Staff",
        email: `notesstaff-${Date.now()}-${Math.random()}@example.com`,
        state_slug: "georgia",
        license_type_id: "ga-individual",
      }),
    });
    return (await resp.json()) as { id: string };
  }

  it("a new roster entry has no note", async () => {
    const { cookie } = await createFirmWithSession("Fresh Notes Firm", `freshnotes-${Date.now()}@example.com`);
    const staff = await addStaff(cookie);
    const listResp = await SELF.fetch(`${BASE}/firm/licenses`, { headers: { Cookie: cookie } });
    const listBody = (await listResp.json()) as { licenses: { id: string; internal_notes: string | null }[] };
    expect(listBody.licenses.find((r) => r.id === staff.id)?.internal_notes).toBeNull();
  });

  it("sets a note via PATCH", async () => {
    const { cookie } = await createFirmWithSession("Set Notes Firm", `setnotes-${Date.now()}@example.com`);
    const staff = await addStaff(cookie);
    const resp = await SELF.fetch(`${BASE}/firm/licenses/${staff.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({ internal_notes: "Out on leave through March" }),
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { internal_notes: string | null };
    expect(body.internal_notes).toBe("Out on leave through March");
  });

  it("clears a note via PATCH with an empty string", async () => {
    const { cookie } = await createFirmWithSession("Clear Notes Firm", `clearnotes-${Date.now()}@example.com`);
    const staff = await addStaff(cookie);
    await SELF.fetch(`${BASE}/firm/licenses/${staff.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({ internal_notes: "Temporary note" }),
    });
    const clearResp = await SELF.fetch(`${BASE}/firm/licenses/${staff.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({ internal_notes: "" }),
    });
    expect(clearResp.status).toBe(200);
    const body = (await clearResp.json()) as { internal_notes: string | null };
    expect(body.internal_notes).toBeNull();
  });

  it("leaves the note untouched when the field is omitted from the PATCH body", async () => {
    const { cookie } = await createFirmWithSession("Untouched Notes Firm", `untouchednotes-${Date.now()}@example.com`);
    const staff = await addStaff(cookie);
    await SELF.fetch(`${BASE}/firm/licenses/${staff.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({ internal_notes: "Handles the audit clients" }),
    });
    const unrelatedResp = await SELF.fetch(`${BASE}/firm/licenses/${staff.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({ staff_label: "Renamed, Notes Untouched" }),
    });
    expect(unrelatedResp.status).toBe(200);
    const body = (await unrelatedResp.json()) as { internal_notes: string | null; staff_label: string };
    expect(body.staff_label).toBe("Renamed, Notes Untouched");
    expect(body.internal_notes).toBe("Handles the audit clients");
  });

  it("truncates a note longer than the length cap rather than rejecting it", async () => {
    const { cookie } = await createFirmWithSession("Long Notes Firm", `longnotes-${Date.now()}@example.com`);
    const staff = await addStaff(cookie);
    const longNote = "x".repeat(700);
    const resp = await SELF.fetch(`${BASE}/firm/licenses/${staff.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({ internal_notes: longNote }),
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { internal_notes: string | null };
    expect(body.internal_notes).toHaveLength(500);
  });

  it("CROSS-FIRM: cannot set another firm's staff note", async () => {
    const victim = await createFirmWithSession("Notes Victim Firm", `notesvictim-${Date.now()}@example.com`);
    const staff = await addStaff(victim.cookie);
    const attacker = await createFirmWithSession("Notes Attacker Firm", `notesattacker-${Date.now()}@example.com`);
    const resp = await SELF.fetch(`${BASE}/firm/licenses/${staff.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", Cookie: attacker.cookie },
      body: JSON.stringify({ internal_notes: "hijacked note" }),
    });
    expect(resp.status).toBe(404);
    const survivor = await store.getFirmLicense(env.DB, victim.firmId, staff.id);
    expect(survivor?.internal_notes).toBeNull();
  });
});
