/**
 * Task #26 (2026-08-06): durable Recent Activity log (migration 0025).
 * Reproduces the exact reported bug (edit then remove a staffer -> both
 * events used to vanish) and proves it's fixed by the durable table, not
 * just patched around.
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

async function postFirmLicense(cookie: string, body: Record<string, string>): Promise<Response> {
  return SELF.fetch(`${BASE}/firm/licenses`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.60", Cookie: cookie },
    body: JSON.stringify(body),
  });
}

async function patchFirmLicense(cookie: string, id: string, body: Record<string, string>): Promise<Response> {
  return SELF.fetch(`${BASE}/firm/licenses/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.60", Cookie: cookie },
    body: JSON.stringify(body),
  });
}

async function deleteFirmLicense(cookie: string, id: string): Promise<Response> {
  return SELF.fetch(`${BASE}/firm/licenses/${id}`, {
    method: "DELETE",
    headers: { "cf-connecting-ip": "203.0.113.60", Cookie: cookie },
  });
}

async function renewFirmLicense(cookie: string, id: string): Promise<Response> {
  return SELF.fetch(`${BASE}/firm/licenses/${id}/renew`, {
    method: "POST",
    headers: { "cf-connecting-ip": "203.0.113.60", Cookie: cookie },
  });
}

async function getActivity(cookie: string | null): Promise<Response> {
  return SELF.fetch(`${BASE}/firm/activity`, { headers: cookie ? { Cookie: cookie } : {} });
}

describe("GET /firm/activity", () => {
  it("401s with no session", async () => {
    expect((await getActivity(null)).status).toBe(401);
  });

  it("reproduces and fixes the reported bug: edit then remove both survive in the log after the row leaves the roster", async () => {
    const { cookie } = await createFirmWithSession("Activity Bug Repro LLC", `activitybug-${Date.now()}@example.com`);
    const created = await postFirmLicense(cookie, {
      staff_label: "Robert Hayes",
      email: `robert-${Date.now()}@example.com`,
      state_slug: "georgia",
      license_type_id: "ga-individual",
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    const patched = await patchFirmLicense(cookie, id, { staff_label: "Robert J. Hayes" });
    expect(patched.status).toBe(200);

    const deleted = await deleteFirmLicense(cookie, id);
    expect(deleted.status).toBe(200);

    // Confirm the OLD bug's precondition still holds: the row is genuinely
    // gone from the live roster GET, same as before this fix.
    const rosterResp = await SELF.fetch(`${BASE}/firm/licenses`, { headers: { Cookie: cookie } });
    const roster = (await rosterResp.json()) as { licenses: { id: string }[] };
    expect(roster.licenses.some((l) => l.id === id)).toBe(false);

    // The durable log still has all three events, independent of that.
    const activityResp = await getActivity(cookie);
    expect(activityResp.status).toBe(200);
    const activity = (await activityResp.json()) as { events: { event_type: string; staff_label: string | null }[] };
    const types = activity.events.filter((e) => e.staff_label?.includes("Hayes")).map((e) => e.event_type);
    expect(types).toContain("added");
    expect(types).toContain("edited");
    expect(types).toContain("removed");
  });

  it("logs a renew event", async () => {
    const { cookie } = await createFirmWithSession("Activity Renew LLC", `activityrenew-${Date.now()}@example.com`);
    const created = await postFirmLicense(cookie, {
      staff_label: "Renew Tester",
      email: `renewtest-${Date.now()}@example.com`,
      state_slug: "georgia",
      license_type_id: "ga-individual",
    });
    const { id } = (await created.json()) as { id: string };

    const renewed = await renewFirmLicense(cookie, id);
    expect(renewed.status).toBe(200);

    const activityResp = await getActivity(cookie);
    const activity = (await activityResp.json()) as { events: { event_type: string }[] };
    expect(activity.events.some((e) => e.event_type === "renewed")).toBe(true);
  });

  it("is scoped to the caller's own firm only", async () => {
    const a = await createFirmWithSession("Activity Scope A LLC", `activitya-${Date.now()}@example.com`);
    const b = await createFirmWithSession("Activity Scope B LLC", `activityb-${Date.now()}@example.com`);
    await postFirmLicense(a.cookie, {
      staff_label: "Firm A Only",
      email: `firma-${Date.now()}@example.com`,
      state_slug: "georgia",
      license_type_id: "ga-individual",
    });

    const activityResp = await getActivity(b.cookie);
    const activity = (await activityResp.json()) as { events: { staff_label: string | null }[] };
    expect(activity.events.some((e) => e.staff_label === "Firm A Only")).toBe(false);
  });

  it("logs an opted_out event when a firm-added staffer unsubscribes", async () => {
    const { cookie } = await createFirmWithSession("Activity Optout LLC", `activityoptout-${Date.now()}@example.com`);
    const created = await postFirmLicense(cookie, {
      staff_label: "Opts Out",
      email: `optsout-${Date.now()}@example.com`,
      state_slug: "georgia",
      license_type_id: "ga-individual",
    });
    const { id } = (await created.json()) as { id: string };
    const row = await env.DB.prepare("SELECT unsubscribe_token FROM subscribers WHERE id = ?1").bind(id).first<{ unsubscribe_token: string }>();
    const rawToken = row!.unsubscribe_token;

    // GET only renders a confirmation page (never changes state, so an email
    // scanner can't silently trigger it) -- the actual stop happens on the
    // POST below, same pattern password-reset.spec.ts's own redeem() uses.
    const page = await SELF.fetch(`${BASE}/unsubscribe?token=${encodeURIComponent(rawToken)}`);
    const html = await page.text();
    const nonce = /name="action_csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
    const unsubResp = await SELF.fetch(`${BASE}/unsubscribe`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: rawToken, action_csrf: nonce }).toString(),
    });
    expect(unsubResp.status).toBe(200);

    const activityResp = await getActivity(cookie);
    const activity = (await activityResp.json()) as { events: { event_type: string; staff_label: string | null }[] };
    expect(activity.events.some((e) => e.event_type === "opted_out" && e.staff_label === "Opts Out")).toBe(true);
  });
});
