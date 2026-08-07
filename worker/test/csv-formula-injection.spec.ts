/**
 * AuditLab CSV-1 (LOW, 2026-08-07): sanitizeFreeText() guards against
 * CSV-formula injection by prefixing a leading =/+/-/@ with a single quote,
 * closing the gap roadmap #18's real CSV export opened. Guarded at write
 * time (every sanitizeFreeText() caller), not just at export -- see that
 * function's own docstring for why.
 */
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as store from "../src/store";
import { sanitizeFreeText } from "../src/validation";

const BASE = "https://deadline-radar.com";

describe("sanitizeFreeText() CSV-formula-injection guard", () => {
  it("prefixes a leading equals sign", () => {
    expect(sanitizeFreeText("=cmd|'/c calc'!A1", 120)).toBe("'=cmd|'/c calc'!A1");
  });

  it("prefixes a leading plus sign", () => {
    expect(sanitizeFreeText("+1+1", 120)).toBe("'+1+1");
  });

  it("prefixes a leading minus sign", () => {
    expect(sanitizeFreeText("-1-1", 120)).toBe("'-1-1");
  });

  it("prefixes a leading at sign", () => {
    expect(sanitizeFreeText("@SUM(A1:A9)", 120)).toBe("'@SUM(A1:A9)");
  });

  it("leaves an ordinary value untouched", () => {
    expect(sanitizeFreeText("Jane D. -- Audit team", 120)).toBe("Jane D. -- Audit team");
  });

  it("does not guard a dangerous character that isn't leading", () => {
    expect(sanitizeFreeText("Team =A1", 120)).toBe("Team =A1");
  });

  it("still returns null for empty input", () => {
    expect(sanitizeFreeText("", 120)).toBeNull();
    expect(sanitizeFreeText(null, 120)).toBeNull();
  });
});

describe("staff_label / office_tag guarded end-to-end through the real API", () => {
  async function createFirmWithSession(name: string, adminEmail: string): Promise<{ firmId: string; cookie: string }> {
    const firm = await store.createFirm(env.DB, { name, adminEmail });
    const { rawSessionToken } = await store.createSession(env.DB, firm.id);
    return { firmId: firm.id, cookie: `dr_firm_session=${rawSessionToken}` };
  }

  it("guards a formula-injection staff_label set via POST /firm/licenses", async () => {
    const { cookie } = await createFirmWithSession("Injection Firm", `injection-${Date.now()}@example.com`);
    const resp = await SELF.fetch(`${BASE}/firm/licenses`, {
      method: "POST",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        staff_label: "=HYPERLINK(\"http://evil.example\")",
        email: `injectionstaff-${Date.now()}@example.com`,
        state_slug: "georgia",
        license_type_id: "ga-individual",
      }),
    });
    expect(resp.status).toBe(201);
    const body = (await resp.json()) as { staff_label: string };
    expect(body.staff_label.startsWith("'=")).toBe(true);
  });

  it("guards a formula-injection office_tag set via PATCH", async () => {
    const { cookie } = await createFirmWithSession("Injection Tag Firm", `injectiontag-${Date.now()}@example.com`);
    const addResp = await SELF.fetch(`${BASE}/firm/licenses`, {
      method: "POST",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        staff_label: "Injection Tag Staff",
        email: `injectiontagstaff-${Date.now()}@example.com`,
        state_slug: "georgia",
        license_type_id: "ga-individual",
      }),
    });
    const staff = (await addResp.json()) as { id: string };
    const patchResp = await SELF.fetch(`${BASE}/firm/licenses/${staff.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({ office_tag: "@SUM(1,1)" }),
    });
    expect(patchResp.status).toBe(200);
    const body = (await patchResp.json()) as { office_tag: string };
    expect(body.office_tag.startsWith("'@")).toBe(true);
  });
});
