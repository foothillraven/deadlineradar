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

// ICS-1 (AuditLab, 2026-08-20): RFC 5545 SS3.1 requires content lines to be
// <=75 octets (excluding the terminating CRLF), folded onto continuation
// lines (CRLF + a single leading space) otherwise. Two things a real
// parser needs to hold, checked directly rather than trusting the function
// looks right: (1) every physical line respects the limit, (2) unfolding
// (stripping "\r\n " continuations) reconstructs the original content
// exactly, byte for byte.
function assertAllLinesWithinOctetLimit(ics: string): void {
  for (const physicalLine of ics.split("\r\n")) {
    if (physicalLine.length === 0) continue; // trailing blank line from the final \r\n
    expect(new TextEncoder().encode(physicalLine).length).toBeLessThanOrEqual(75);
  }
}

function unfoldIcs(ics: string): string {
  return ics.replace(/\r\n /g, "");
}

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

  it("does not fold a short SUMMARY (stays on one physical line)", () => {
    const ics = buildIcs([{ uid: "abc", summary: "j.smith@acme.com — Ohio license renewal", dateIso: "2026-09-30" }], new Date("2026-08-06T00:00:00Z"));
    assertAllLinesWithinOctetLimit(ics);
    expect(ics).toContain("SUMMARY:j.smith@acme.com — Ohio license renewal\r\n");
  });

  it("folds a SUMMARY line that exceeds 75 octets, and unfolding reconstructs it exactly", () => {
    // AuditLab's own reported breach: an ordinary staff email + California.
    const summary = "jennifer.rodriguez@bakertillyadvisors.com — California license renewal";
    expect(new TextEncoder().encode(`SUMMARY:${summary}`).length).toBeGreaterThan(75); // control: confirm this case actually breaches
    const ics = buildIcs([{ uid: "abc", summary, dateIso: "2026-09-30" }], new Date("2026-08-06T00:00:00Z"));
    assertAllLinesWithinOctetLimit(ics);
    // The physical line must actually be split (a continuation exists).
    expect(ics).toMatch(/SUMMARY:[^\r\n]*\r\n [^\r\n]*/);
    expect(unfoldIcs(ics)).toContain(`SUMMARY:${summary}`);
  });

  it("folds without splitting a multi-byte UTF-8 character (em-dash lands near the boundary)", () => {
    // Deliberately places a 3-octet em-dash right around the 75-octet cut
    // point -- the exact failure shape a naive character-count fold would
    // corrupt into a replacement character or a broken string.
    const summary = "A".repeat(70) + " — Northern Mariana Islands license renewal";
    const ics = buildIcs([{ uid: "abc", summary, dateIso: "2026-09-30" }], new Date("2026-08-06T00:00:00Z"));
    assertAllLinesWithinOctetLimit(ics);
    const unfolded = unfoldIcs(ics);
    expect(unfolded).toContain(`SUMMARY:${summary}`);
    expect(unfolded).not.toContain("�"); // the Unicode replacement character -- a split multi-byte sequence would produce this
  });

  it("folds a summary long enough to need more than two physical lines", () => {
    const summary = "Accounts Payable Team — " + "x".repeat(120) + " — Pennsylvania license renewal";
    const ics = buildIcs([{ uid: "abc", summary, dateIso: "2026-09-30" }], new Date("2026-08-06T00:00:00Z"));
    assertAllLinesWithinOctetLimit(ics);
    const summaryLines = ics.split("\r\n").filter((l) => l.startsWith("SUMMARY:") || l.startsWith(" "));
    expect(summaryLines.length).toBeGreaterThan(2);
    expect(unfoldIcs(ics)).toContain(`SUMMARY:${summary}`);
  });
});

describe("GET /firm/calendar.ics", () => {
  it("401s with no session", async () => {
    expect((await getFirmCalendarIcs(null)).status).toBe(401);
  });

  it("200s for a long-standing free-tier firm -- Calendar export has no entitlement gate, matching GET /firm/licenses (2026-08-06)", async () => {
    const { firmId, cookie } = await createFirmWithSession("Ics Firm A", `icsa-${Date.now()}@example.com`);
    await setFirmTierAndAge(firmId, "free", daysAgoIso(500));
    expect((await getFirmCalendarIcs(cookie)).status).toBe(200);
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
