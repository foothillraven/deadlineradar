/**
 * .ics export (2026-08-06) -- see ics.ts's own docstring for scope (static,
 * one-time, not a live webcal:// feed).
 */
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as store from "../src/store";
import { buildIcs, escapeIcsText } from "../src/ics";

function testExecutionContext(): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
}

async function createFirmWithSession(name: string, adminEmail: string): Promise<{ firmId: string; cookie: string }> {
  const firm = await store.createFirm(env.DB, { name, adminEmail });
  const { rawSessionToken } = await store.createSession(env.DB, firm.id);
  return { firmId: firm.id, cookie: `dr_firm_session=${rawSessionToken}` };
}

async function setFirmTierAndAge(firmId: string, planTier: string, createdAt: string, status = "active"): Promise<void> {
  await env.DB.prepare("UPDATE firms SET plan_tier = ?1, created_at = ?2, status = ?3 WHERE id = ?4")
    .bind(planTier, createdAt, status, firmId)
    .run();
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

async function postFirmLicense(cookie: string, body: Record<string, string>): Promise<Response> {
  return SELF.fetch("https://deadline-radar.com/firm/licenses", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.201", Cookie: cookie },
    body: JSON.stringify(body),
  });
}

async function getFirmCalendarIcs(cookie: string | null): Promise<Response> {
  return SELF.fetch("https://deadline-radar.com/firm/calendar.ics", {
    headers: cookie ? { Cookie: cookie } : {},
  });
}

describe("escapeIcsText", () => {
  it("escapes backslash, comma, semicolon, and line breaks per RFC 5545", () => {
    expect(escapeIcsText("a\\b,c;d\ne\r\nf")).toBe("a\\\\b\\,c\\;d\\ne\\nf");
  });
});

describe("buildIcs", () => {
  it("emits a valid all-day VEVENT with DTEND one day after DTSTART", () => {
    const asOf = new Date("2026-08-06T12:00:00Z");
    const ics = buildIcs([{ uid: "abc123", summary: "Jane Doe — Georgia license renewal", dateIso: "2026-09-30" }], asOf);
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("END:VCALENDAR");
    expect(ics).toContain("UID:abc123@deadline-radar.com");
    expect(ics).toContain("DTSTAMP:20260806T120000Z");
    expect(ics).toContain("DTSTART;VALUE=DATE:20260930");
    expect(ics).toContain("DTEND;VALUE=DATE:20261001");
    expect(ics).toContain("SUMMARY:Jane Doe — Georgia license renewal");
  });

  it("handles a month/year rollover on DTEND correctly", () => {
    const ics = buildIcs([{ uid: "x", summary: "y", dateIso: "2026-12-31" }], new Date("2026-08-06T00:00:00Z"));
    expect(ics).toContain("DTSTART;VALUE=DATE:20261231");
    expect(ics).toContain("DTEND;VALUE=DATE:20270101");
  });

  it("emits zero VEVENTs for an empty roster without erroring", () => {
    const ics = buildIcs([], new Date("2026-08-06T00:00:00Z"));
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).not.toContain("BEGIN:VEVENT");
  });
});

describe("GET /firm/calendar.ics", () => {
  it("401s with no session", async () => {
    expect((await getFirmCalendarIcs(null)).status).toBe(401);
  });

  it("403s for a lapsed/expired pilot firm -- same read-gate as GET /firm/licenses", async () => {
    const { firmId, cookie } = await createFirmWithSession("Ics Firm A", `icsa-${Date.now()}@example.com`);
    await setFirmTierAndAge(firmId, "pilot", daysAgoIso(40));
    expect((await getFirmCalendarIcs(cookie)).status).toBe(403);
  });

  it("returns a downloadable .ics with one event per roster member with a resolvable deadline, excluding opted-out staff", async () => {
    const { firmId, cookie } = await createFirmWithSession("Ics Firm B", `icsb-${Date.now()}@example.com`);

    const first = await postFirmLicense(cookie, {
      staff_label: "Included Staffer",
      email: `included-${Date.now()}@example.com`,
      state_slug: "georgia",
      license_type_id: "ga-individual",
    });
    expect(first.status).toBe(201);
    const excluded = await postFirmLicense(cookie, {
      staff_label: "Opted Out Staffer",
      email: `excluded-${Date.now()}@example.com`,
      state_slug: "georgia",
      license_type_id: "ga-individual",
    });
    expect(excluded.status).toBe(201);
    const excludedBody = (await excluded.json()) as { id: string };
    await env.DB.prepare("UPDATE subscribers SET status = 'stopped', stop_reason = 'unsubscribed' WHERE id = ?1")
      .bind(excludedBody.id)
      .run();

    const resp = await getFirmCalendarIcs(cookie);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toContain("text/calendar");
    expect(resp.headers.get("content-disposition")).toContain("deadlineradar-ics-firm-b.ics");

    const body = await resp.text();
    expect(body).toContain("BEGIN:VCALENDAR");
    expect((body.match(/BEGIN:VEVENT/g) || []).length).toBe(1);
    expect(body).toContain("Included Staffer");
    expect(body).not.toContain("Opted Out Staffer");
  });

  it("is scoped to the caller's own firm only", async () => {
    const a = await createFirmWithSession("Ics Firm C", `icsc-${Date.now()}@example.com`);
    const b = await createFirmWithSession("Ics Firm D", `icsd-${Date.now()}@example.com`);
    await postFirmLicense(a.cookie, {
      staff_label: "Firm C Staffer",
      email: `firmc-${Date.now()}@example.com`,
      state_slug: "georgia",
      license_type_id: "ga-individual",
    });

    const resp = await getFirmCalendarIcs(b.cookie);
    expect(resp.status).toBe(200);
    const body = await resp.text();
    expect(body).not.toContain("Firm C Staffer");
  });
});
