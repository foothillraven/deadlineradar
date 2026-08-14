/**
 * Staff self-service CPE-hours entry (2026-08-05, Devin: "an email... but
 * only option is to input hours"). Two new capabilities:
 *   - a signed-in SUBSCRIBER can list/log CPE entries against their own
 *     subscriber row(s), proven by email match, never anything client-
 *     supplied (GET/POST /subscriber/cpe).
 *   - a firm admin can nudge one specific staffer with a reminder email
 *     reusing the same magic-link mechanism (POST /firm/staff-cpe-reminder).
 */
import { env, SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import * as store from "../src/store";

function testExecutionContext(): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
}

async function workerFetch(request: Request, envOverrides: Record<string, unknown> = {}): Promise<Response> {
  const worker = (await import("../src/index")).default;
  return worker.fetch(request, { ...env, ...envOverrides } as never, testExecutionContext());
}

function okResponse(): Response {
  return new Response("{}", { status: 202 });
}

async function createFirmWithSession(name: string, adminEmail: string): Promise<{ firmId: string; cookie: string }> {
  const firm = await store.createFirm(env.DB, { name, adminEmail });
  const { rawSessionToken } = await store.createSession(env.DB, firm.id);
  return { firmId: firm.id, cookie: `dr_firm_session=${rawSessionToken}` };
}

async function addStaff(cookie: string, fields: Record<string, string>): Promise<{ id: string; email: string }> {
  const resp = await SELF.fetch("https://deadline-radar.com/firm/licenses", {
    method: "POST",
    headers: { "content-type": "application/json", Cookie: cookie },
    body: JSON.stringify(fields),
  });
  expect(resp.status).toBe(201);
  return (await resp.json()) as { id: string; email: string };
}

async function subscriberSessionFor(email: string): Promise<string> {
  const { rawSessionToken } = await store.createSubscriberSession(env.DB, email.trim().toLowerCase());
  return `dr_sub_session=${rawSessionToken}`;
}

describe("GET /subscriber/cpe", () => {
  it("401s with no session", async () => {
    const resp = await SELF.fetch("https://deadline-radar.com/subscriber/cpe");
    expect(resp.status).toBe(401);
  });

  it("empty list for a free individual (no firm_id -- cpe_entries structurally can't exist for them)", async () => {
    const email = `cpe-free-${Date.now()}@example.com`;
    await SELF.fetch("https://deadline-radar.com/subscribe", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.250" },
      body: new URLSearchParams({ hp_website: "", email, state: "georgia", license_type_id: "ga-individual" }).toString(),
    });
    const row = await env.DB.prepare("SELECT confirm_token FROM subscribers WHERE email = ?1").bind(email).first<{ confirm_token: string }>();
    await store.confirm(env.DB, row!.confirm_token);

    const cookie = await subscriberSessionFor(email);
    const resp = await SELF.fetch("https://deadline-radar.com/subscriber/cpe", { headers: { Cookie: cookie } });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { entries: unknown[] };
    expect(body.entries).toEqual([]);
  });

  it("returns entries only for the signed-in email's own subscriber rows", async () => {
    const { cookie: firmCookie } = await createFirmWithSession("CPE List Firm", `cpelist-${Date.now()}@example.com`);
    const staffEmail = `cpelist-staff-${Date.now()}@example.com`;
    const staff = await addStaff(firmCookie, {
      staff_label: "CPE List Staff",
      email: staffEmail,
      state_slug: "georgia",
      license_type_id: "ga-individual",
    });

    await workerFetch(
      new Request("https://deadline-radar.com/subscriber/cpe", {
        method: "POST",
        headers: { "content-type": "application/json", Cookie: await subscriberSessionFor(staffEmail) },
        body: JSON.stringify({ subscriber_id: staff.id, entry_date: "2026-01-15", hours: "2", category: "general" }),
      })
    );

    const resp = await SELF.fetch("https://deadline-radar.com/subscriber/cpe", {
      headers: { Cookie: await subscriberSessionFor(staffEmail) },
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { entries: { subscriber_id: string; hours: number }[] };
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]!.subscriber_id).toBe(staff.id);
    expect(body.entries[0]!.hours).toBe(2);
  });
});

describe("POST /subscriber/cpe", () => {
  it("401s with no session", async () => {
    const resp = await SELF.fetch("https://deadline-radar.com/subscriber/cpe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subscriber_id: "x", entry_date: "2026-01-01", hours: "1" }),
    });
    expect(resp.status).toBe(401);
  });

  it("succeeds for the signed-in email's own firm-tracked subscriber row", async () => {
    const { cookie: firmCookie } = await createFirmWithSession("CPE Create Firm", `cpecreate-${Date.now()}@example.com`);
    const staffEmail = `cpecreate-staff-${Date.now()}@example.com`;
    const staff = await addStaff(firmCookie, {
      staff_label: "CPE Create Staff",
      email: staffEmail,
      state_slug: "georgia",
      license_type_id: "ga-individual",
    });

    const resp = await workerFetch(
      new Request("https://deadline-radar.com/subscriber/cpe", {
        method: "POST",
        headers: { "content-type": "application/json", Cookie: await subscriberSessionFor(staffEmail) },
        body: JSON.stringify({ subscriber_id: staff.id, entry_date: "2026-02-01", hours: "3.5", category: "ethics", description: "Conference" }),
      })
    );
    expect(resp.status).toBe(201);
    const body = (await resp.json()) as { entered_by_actor_type: string; category: string };
    expect(body.entered_by_actor_type).toBe("staff");
    expect(body.category).toBe("ethics");
  });

  it("404s for someone else's subscriber_id -- cannot log hours against another person's license", async () => {
    const { cookie: firmCookie } = await createFirmWithSession("CPE Cross Firm", `cpecross-${Date.now()}@example.com`);
    const victimEmail = `cpecross-victim-${Date.now()}@example.com`;
    const victim = await addStaff(firmCookie, {
      staff_label: "Victim",
      email: victimEmail,
      state_slug: "georgia",
      license_type_id: "ga-individual",
    });
    const attackerEmail = `cpecross-attacker-${Date.now()}@example.com`;

    const resp = await workerFetch(
      new Request("https://deadline-radar.com/subscriber/cpe", {
        method: "POST",
        headers: { "content-type": "application/json", Cookie: await subscriberSessionFor(attackerEmail) },
        body: JSON.stringify({ subscriber_id: victim.id, entry_date: "2026-02-01", hours: "1", category: "general" }),
      })
    );
    expect(resp.status).toBe(404);

    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM cpe_entries WHERE subscriber_id = ?1").bind(victim.id).first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  it("404s for a free individual's own subscriber_id (no firm_id)", async () => {
    const email = `cpecreate-free-${Date.now()}@example.com`;
    await SELF.fetch("https://deadline-radar.com/subscribe", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.251" },
      body: new URLSearchParams({ hp_website: "", email, state: "georgia", license_type_id: "ga-individual" }).toString(),
    });
    const row = await env.DB.prepare("SELECT id, confirm_token FROM subscribers WHERE email = ?1").bind(email).first<{ id: string; confirm_token: string }>();
    await store.confirm(env.DB, row!.confirm_token);

    const resp = await workerFetch(
      new Request("https://deadline-radar.com/subscriber/cpe", {
        method: "POST",
        headers: { "content-type": "application/json", Cookie: await subscriberSessionFor(email) },
        body: JSON.stringify({ subscriber_id: row!.id, entry_date: "2026-02-01", hours: "1", category: "general" }),
      })
    );
    expect(resp.status).toBe(404);
  });

  it("rejects a future completion date, invalid hours, and invalid category the same way the firm-admin route does", async () => {
    const { cookie: firmCookie } = await createFirmWithSession("CPE Validate Firm", `cpevalidate-${Date.now()}@example.com`);
    const staffEmail = `cpevalidate-staff-${Date.now()}@example.com`;
    const staff = await addStaff(firmCookie, {
      staff_label: "Validate Staff",
      email: staffEmail,
      state_slug: "georgia",
      license_type_id: "ga-individual",
    });
    const cookie = await subscriberSessionFor(staffEmail);

    const future = await workerFetch(
      new Request("https://deadline-radar.com/subscriber/cpe", {
        method: "POST",
        headers: { "content-type": "application/json", Cookie: cookie },
        body: JSON.stringify({ subscriber_id: staff.id, entry_date: "2099-01-01", hours: "1", category: "general" }),
      })
    );
    expect(future.status).toBe(400);

    const badHours = await workerFetch(
      new Request("https://deadline-radar.com/subscriber/cpe", {
        method: "POST",
        headers: { "content-type": "application/json", Cookie: cookie },
        body: JSON.stringify({ subscriber_id: staff.id, entry_date: "2026-01-01", hours: "not-a-number", category: "general" }),
      })
    );
    expect(badHours.status).toBe(400);

    const badCategory = await workerFetch(
      new Request("https://deadline-radar.com/subscriber/cpe", {
        method: "POST",
        headers: { "content-type": "application/json", Cookie: cookie },
        body: JSON.stringify({ subscriber_id: staff.id, entry_date: "2026-01-01", hours: "1", category: "bogus" }),
      })
    );
    expect(badCategory.status).toBe(400);
  });
});

describe("POST /firm/staff-cpe-reminder", () => {
  it("401s with no firm session", async () => {
    const resp = await SELF.fetch("https://deadline-radar.com/firm/staff-cpe-reminder", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subscriber_id: "x" }),
    });
    expect(resp.status).toBe(401);
  });

  it("sends a real email and reports sent:true, with SendGrid configured", async () => {
    const { cookie } = await createFirmWithSession("Reminder Firm", `reminder-${Date.now()}@example.com`);
    const staffEmail = `reminder-staff-${Date.now()}@example.com`;
    const staff = await addStaff(cookie, {
      staff_label: "Reminder Staff",
      email: staffEmail,
      state_slug: "georgia",
      license_type_id: "ga-individual",
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse());
    try {
      const resp = await workerFetch(
        new Request("https://deadline-radar.com/firm/staff-cpe-reminder", {
          method: "POST",
          headers: { "content-type": "application/json", Cookie: cookie },
          body: JSON.stringify({ subscriber_id: staff.id }),
        }),
        { SENDGRID_API_KEY: "test-key-not-real" }
      );
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as { sent: boolean };
      expect(body.sent).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [, sendGridCallInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const sentBody = JSON.parse(String(sendGridCallInit.body));
      expect(sentBody.personalizations[0].to[0].email).toBe(staffEmail);
      expect(sentBody.subject).toContain("Reminder Firm");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("404s for a subscriber_id belonging to a DIFFERENT firm", async () => {
    const { cookie: firmACookie } = await createFirmWithSession("Reminder Firm A", `reminder-a-${Date.now()}@example.com`);
    const { cookie: firmBCookie } = await createFirmWithSession("Reminder Firm B", `reminder-b-${Date.now()}@example.com`);
    const staffB = await addStaff(firmBCookie, {
      staff_label: "Staff B",
      email: `reminder-staffb-${Date.now()}@example.com`,
      state_slug: "georgia",
      license_type_id: "ga-individual",
    });

    const resp = await workerFetch(
      new Request("https://deadline-radar.com/firm/staff-cpe-reminder", {
        method: "POST",
        headers: { "content-type": "application/json", Cookie: firmACookie },
        body: JSON.stringify({ subscriber_id: staffB.id }),
      }),
      { SENDGRID_API_KEY: "test-key-not-real" }
    );
    expect(resp.status).toBe(404);
  });

  it("reports sent:false with a reason when the staffer has unsubscribed from everything", async () => {
    const { cookie } = await createFirmWithSession("Reminder Suppressed Firm", `remindersup-${Date.now()}@example.com`);
    const staffEmail = `remindersup-staff-${Date.now()}@example.com`;
    const staff = await addStaff(cookie, {
      staff_label: "Suppressed Staff",
      email: staffEmail,
      state_slug: "georgia",
      license_type_id: "ga-individual",
    });
    // isPermanentlySuppressed() has no dedicated table -- it's computed from
    // subscribers.stop_reason/stopped_at (see its own docstring in store.ts),
    // so simulate a real unsubscribe through store.stop() the same way the
    // real /unsubscribe route does, rather than guessing at column shapes.
    const tokenRow = await env.DB.prepare("SELECT unsubscribe_token FROM subscribers WHERE id = ?1").bind(staff.id).first<{ unsubscribe_token: string }>();
    await store.stop(env.DB, tokenRow!.unsubscribe_token, "unsubscribed");

    const resp = await workerFetch(
      new Request("https://deadline-radar.com/firm/staff-cpe-reminder", {
        method: "POST",
        headers: { "content-type": "application/json", Cookie: cookie },
        body: JSON.stringify({ subscriber_id: staff.id }),
      }),
      { SENDGRID_API_KEY: "test-key-not-real" }
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { sent: boolean; reason: string | null };
    expect(body.sent).toBe(false);
    expect(body.reason).toMatch(/unsubscribed/i);
  });
});

// POST /firm/rule-change/notify (2026-08-06, live request off the
// Calendar's rule-change badges: "notify staff in that state"). Content
// comes from the client (the same DR_RULE_CHANGE_EVENTS data already
// rendered publicly in the modal), not a server-side lookup -- see that
// handler's own docstring for why.
describe("POST /firm/rule-change/notify", () => {
  const validBody = {
    state_slug: "georgia",
    jurisdiction: "Georgia",
    summary: "Georgia's CPA mobility rule is changing to state-level substantial equivalence.",
    effective_date_label: "October 1, 2026",
    citation_url: "https://rules.sos.ga.gov/gac/20-11",
  };

  it("401s with no firm session", async () => {
    const resp = await SELF.fetch("https://deadline-radar.com/firm/rule-change/notify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(resp.status).toBe(401);
  });

  it("400s when required fields are missing", async () => {
    const { cookie } = await createFirmWithSession("Notify Missing Firm", `notifymissing-${Date.now()}@example.com`);
    const resp = await workerFetch(
      new Request("https://deadline-radar.com/firm/rule-change/notify", {
        method: "POST",
        headers: { "content-type": "application/json", Cookie: cookie },
        body: JSON.stringify({ state_slug: "georgia" }),
      }),
      { SENDGRID_API_KEY: "test-key-not-real" }
    );
    expect(resp.status).toBe(400);
  });

  it("emails every roster staffer in that state and nobody else", async () => {
    const { cookie } = await createFirmWithSession("Notify Firm", `notify-${Date.now()}@example.com`);
    const gaEmail = `notify-ga-${Date.now()}@example.com`;
    const alEmail = `notify-al-${Date.now()}@example.com`;
    await addStaff(cookie, { staff_label: "GA Staffer", email: gaEmail, state_slug: "georgia", license_type_id: "ga-individual" });
    await addStaff(cookie, { staff_label: "AL Staffer", email: alEmail, state_slug: "alabama", license_type_id: "al-all" });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse());
    try {
      const resp = await workerFetch(
        new Request("https://deadline-radar.com/firm/rule-change/notify", {
          method: "POST",
          headers: { "content-type": "application/json", Cookie: cookie },
          body: JSON.stringify(validBody),
        }),
        { SENDGRID_API_KEY: "test-key-not-real" }
      );
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as { sent: number; skipped: number; total: number };
      expect(body.total).toBe(1);
      expect(body.sent).toBe(1);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [, sendGridCallInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const sentBody = JSON.parse(String(sendGridCallInit.body));
      expect(sentBody.personalizations[0].to[0].email).toBe(gaEmail);
      expect(sentBody.subject).toContain("Georgia");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("AuditLab UNSUB-3 (2026-08-13): carries a real one-click List-Unsubscribe header keyed to the recipient's OWN token, and the link actually stops their notifications", async () => {
    const { cookie } = await createFirmWithSession("Notify Unsub Firm", `notifyunsub-${Date.now()}@example.com`);
    const gaEmail = `notify-unsub-ga-${Date.now()}@example.com`;
    const staff = await addStaff(cookie, { staff_label: "GA Staffer", email: gaEmail, state_slug: "georgia", license_type_id: "ga-individual" });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse());
    try {
      const resp = await workerFetch(
        new Request("https://deadline-radar.com/firm/rule-change/notify", {
          method: "POST",
          headers: { "content-type": "application/json", Cookie: cookie },
          body: JSON.stringify(validBody),
        }),
        { SENDGRID_API_KEY: "test-key-not-real" }
      );
      expect(resp.status).toBe(200);
      const [, sendGridCallInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const sentBody = JSON.parse(String(sendGridCallInit.body));
      const sentHeaders = sentBody.personalizations[0].headers as Record<string, string>;
      expect(sentHeaders["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
      const match = /<(https:\/\/[^>]+)>/.exec(sentHeaders["List-Unsubscribe"] ?? "");
      expect(match).not.toBeNull();
      const unsubUrl = match![1]!;

      const tokenRow = await env.DB.prepare("SELECT unsubscribe_token FROM subscribers WHERE id = ?1").bind(staff.id).first<{ unsubscribe_token: string }>();
      expect(unsubUrl).toContain(`token=${encodeURIComponent(tokenRow!.unsubscribe_token)}`);
    } finally {
      fetchSpy.mockRestore();
    }

    const tokenRow2 = await env.DB.prepare("SELECT unsubscribe_token FROM subscribers WHERE id = ?1").bind(staff.id).first<{ unsubscribe_token: string }>();
    const unsubResp = await SELF.fetch(
      `https://deadline-radar.com/unsubscribe?token=${encodeURIComponent(tokenRow2!.unsubscribe_token)}`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "List-Unsubscribe=One-Click",
      }
    );
    expect(unsubResp.status).toBe(200);
    const row = await env.DB.prepare("SELECT status, stop_reason FROM subscribers WHERE id = ?1").bind(staff.id).first<{ status: string; stop_reason: string }>();
    expect(row?.stop_reason).toBe("unsubscribed");
  });

  it("skips a staffer who has opted out, and reports total:0 for a state with no staff", async () => {
    const { cookie } = await createFirmWithSession("Notify Opt Firm", `notifyopt-${Date.now()}@example.com`);
    const staff = await addStaff(cookie, {
      staff_label: "Opted Out Staffer",
      email: `notifyopt-${Date.now()}@example.com`,
      state_slug: "georgia",
      license_type_id: "ga-individual",
    });
    const tokenRow = await env.DB.prepare("SELECT unsubscribe_token FROM subscribers WHERE id = ?1").bind(staff.id).first<{ unsubscribe_token: string }>();
    await store.stop(env.DB, tokenRow!.unsubscribe_token, "unsubscribed");

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse());
    try {
      const resp = await workerFetch(
        new Request("https://deadline-radar.com/firm/rule-change/notify", {
          method: "POST",
          headers: { "content-type": "application/json", Cookie: cookie },
          body: JSON.stringify(validBody),
        }),
        { SENDGRID_API_KEY: "test-key-not-real" }
      );
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as { sent: number; total: number };
      expect(body.total).toBe(0);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
