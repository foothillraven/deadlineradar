/**
 * AuditLab DEMO-4 (MEDIUM, 2026-08-07): a demo visitor could make our
 * servers email an ARBITRARY third-party address -- the sharpest path
 * (Add Staff, one step, skipConfirmation:true) needed no PATCH at all.
 * Fixed by gating the SEND (not the mutation) for a demo_locked firm in
 * all 4 handlers that email a roster-controlled address. This file proves
 * the actual outbound fetch to SendGrid never fires for a demo firm, not
 * just that a flag is checked -- spies on globalThis.fetch and asserts
 * zero calls to SendGrid's API for a demo_locked firm, at least one for a
 * real firm doing the identical action. SENDGRID_API_KEY is passed as a
 * per-request env override (workerFetch()), same pattern
 * staff-cpe-selfservice.spec.ts already uses -- SELF.fetch alone runs
 * against the ambient test env, which has no key set, so a send would be
 * (correctly) skipped for a reason unrelated to demo_locked.
 */
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as store from "../src/store";

const BASE = "https://deadline-radar.com";
const SENDGRID_URL = "https://api.sendgrid.com/v3/mail/send";

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

function mockSendGridOk() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    if (url === SENDGRID_URL) {
      return new Response(null, { status: 202 });
    }
    throw new Error(`unexpected fetch in DEMO-4 test: ${url}`);
  });
}

function sendGridCallCount(spy: ReturnType<typeof mockSendGridOk>): number {
  return spy.mock.calls.filter((c: Parameters<typeof fetch>) => {
    const url = typeof c[0] === "string" ? c[0] : (c[0] as Request).url;
    return url === SENDGRID_URL;
  }).length;
}

async function createFirmWithSession(name: string, adminEmail: string, demoLocked: boolean): Promise<{ firmId: string; cookie: string }> {
  const firm = await store.createFirm(env.DB, { name, adminEmail });
  if (demoLocked) {
    await env.DB.prepare(`UPDATE firms SET demo_locked = 1 WHERE id = ?1`).bind(firm.id).run();
  }
  const { rawSessionToken } = await store.createSession(env.DB, firm.id);
  return { firmId: firm.id, cookie: `dr_firm_session=${rawSessionToken}` };
}

async function addStaff(cookie: string, ip: string, email: string): Promise<{ id: string }> {
  const resp = await workerFetch(
    new Request(`${BASE}/firm/licenses`, {
      method: "POST",
      headers: { "content-type": "application/json", Cookie: cookie, Origin: BASE, "cf-connecting-ip": ip },
      body: JSON.stringify({ staff_label: "Target", email, state_slug: "georgia", license_type_id: "ga-individual" }),
    }),
    { SENDGRID_API_KEY: "test-key-not-real" }
  );
  return resp.json();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DEMO-4: no outbound email ever reaches SendGrid for a demo-locked firm", () => {
  it("Add Staff (handleFirmLicenseCreate) -- the sharpest path, one step, no PATCH", async () => {
    const fetchSpy = mockSendGridOk();
    const { cookie: demoCookie } = await createFirmWithSession("DEMO4 Add Demo", `d4-add-demo-${Date.now()}@example.com`, true);
    const demoResp = await workerFetch(
      new Request(`${BASE}/firm/licenses`, {
        method: "POST",
        headers: { "content-type": "application/json", Cookie: demoCookie, Origin: BASE, "cf-connecting-ip": "203.0.113.70" },
        body: JSON.stringify({ staff_label: "Whoever", email: `attacker-target-${Date.now()}@stranger.example.com`, state_slug: "georgia", license_type_id: "ga-individual" }),
      }),
      { SENDGRID_API_KEY: "test-key-not-real" }
    );
    expect(demoResp.status).toBe(201); // the roster add itself still succeeds
    expect(sendGridCallCount(fetchSpy)).toBe(0);

    const { cookie: realCookie } = await createFirmWithSession("DEMO4 Add Real", `d4-add-real-${Date.now()}@example.com`, false);
    const realResp = await workerFetch(
      new Request(`${BASE}/firm/licenses`, {
        method: "POST",
        headers: { "content-type": "application/json", Cookie: realCookie, Origin: BASE, "cf-connecting-ip": "203.0.113.71" },
        body: JSON.stringify({ staff_label: "Real Staffer", email: `real-target-${Date.now()}@example.com`, state_slug: "georgia", license_type_id: "ga-individual" }),
      }),
      { SENDGRID_API_KEY: "test-key-not-real" }
    );
    expect(realResp.status).toBe(201);
    expect(sendGridCallCount(fetchSpy)).toBe(1);
  });

  it("Edit staff email (handleFirmLicensePatch) -- PATCH still succeeds, only the confirm email is skipped", async () => {
    const { cookie } = await createFirmWithSession("DEMO4 Patch Demo", `d4-patch-demo-${Date.now()}@example.com`, true);
    const created = await addStaff(cookie, "203.0.113.72", `d4-patch-orig-${Date.now()}@example.com`);

    const fetchSpy = mockSendGridOk();
    const patchResp = await workerFetch(
      new Request(`${BASE}/firm/licenses/${created.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", Cookie: cookie, Origin: BASE, "cf-connecting-ip": "203.0.113.73" },
        body: JSON.stringify({ email: `attacker-repointed-${Date.now()}@stranger.example.com` }),
      }),
      { SENDGRID_API_KEY: "test-key-not-real" }
    );
    expect(patchResp.status).toBe(200); // the email change itself still succeeds
    expect(sendGridCallCount(fetchSpy)).toBe(0);
  });

  it("CPE reminder (handleFirmStaffCpeReminder) -- mints a real login token but never mails it", async () => {
    const { cookie } = await createFirmWithSession("DEMO4 Reminder Demo", `d4-remind-demo-${Date.now()}@example.com`, true);
    const created = await addStaff(cookie, "203.0.113.74", `d4-remind-target-${Date.now()}@stranger.example.com`);

    const fetchSpy = mockSendGridOk();
    const reminderResp = await workerFetch(
      new Request(`${BASE}/firm/staff-cpe-reminder`, {
        method: "POST",
        headers: { "content-type": "application/json", Cookie: cookie, Origin: BASE, "cf-connecting-ip": "203.0.113.75" },
        body: JSON.stringify({ subscriber_id: created.id }),
      }),
      { SENDGRID_API_KEY: "test-key-not-real" }
    );
    expect(reminderResp.status).toBe(200);
    const body = (await reminderResp.json()) as { sent: boolean; reason: string | null };
    expect(body.sent).toBe(false);
    expect(body.reason).toMatch(/shared demo account/i);
    expect(sendGridCallCount(fetchSpy)).toBe(0);
  });

  it("Rule-change notify (handleFirmRuleChangeNotify) -- fans out to N staff, all skipped for a demo firm", async () => {
    const { cookie } = await createFirmWithSession("DEMO4 Notify Demo", `d4-notify-demo-${Date.now()}@example.com`, true);
    await addStaff(cookie, "203.0.113.76", `d4-notify-target-${Date.now()}@stranger.example.com`);

    const fetchSpy = mockSendGridOk();
    const notifyResp = await workerFetch(
      new Request(`${BASE}/firm/rule-change/notify`, {
        method: "POST",
        headers: { "content-type": "application/json", Cookie: cookie, Origin: BASE, "cf-connecting-ip": "203.0.113.77" },
        body: JSON.stringify({
          state_slug: "georgia",
          jurisdiction: "Georgia",
          summary: "A rule changed.",
          effective_date_label: "January 1, 2027",
          citation_url: "",
        }),
      }),
      { SENDGRID_API_KEY: "test-key-not-real" }
    );
    expect(notifyResp.status).toBe(200);
    const body = (await notifyResp.json()) as { sent: number; skipped: number; reason: string | null };
    expect(body.sent).toBe(0);
    expect(body.reason).toMatch(/shared demo account/i);
    expect(sendGridCallCount(fetchSpy)).toBe(0);
  });
});
