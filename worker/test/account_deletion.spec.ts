/**
 * Task #3 (2026-08-06): self-serve account deletion (migration 0026).
 * Soft-deactivate immediately (Devin's decision) -- status flips to
 * 'deleted' (requireFirmSession() already denies any non-'active' status,
 * so login/API access stops with no other code change), every still-live
 * subscriber row on the roster is stopped too (so the reminder cron's
 * allConfirmedActive() -- which has no idea what a firm's status is --
 * stops emailing them), and a hard delete follows automatically 30 days
 * later via the daily cron sweep.
 */
import { env, SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import * as store from "../src/store";

const BASE = "https://deadline-radar.com";

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

async function createFirmWithSession(name: string, adminEmail: string): Promise<{ firmId: string; cookie: string }> {
  const firm = await store.createFirm(env.DB, { name, adminEmail });
  const { rawSessionToken } = await store.createSession(env.DB, firm.id);
  return { firmId: firm.id, cookie: `dr_firm_session=${rawSessionToken}` };
}

async function postFirmLicense(cookie: string, body: Record<string, string>): Promise<Response> {
  return SELF.fetch(`${BASE}/firm/licenses`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.70", Cookie: cookie },
    body: JSON.stringify(body),
  });
}

async function deleteAccount(cookie: string | null, body: Record<string, unknown> = {}): Promise<Response> {
  return SELF.fetch(`${BASE}/firm/account/delete`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.71", Cookie: cookie ?? "" },
    body: JSON.stringify(body),
  });
}

describe("POST /firm/account/delete", () => {
  it("401s with no session", async () => {
    expect((await deleteAccount(null)).status).toBe(401);
  });

  it("deactivates immediately: status flips, session dies, staff stop receiving reminders", async () => {
    const { firmId, cookie } = await createFirmWithSession("Delete Me LLC", `deleteme-${Date.now()}@example.com`);
    const staff = await postFirmLicense(cookie, {
      staff_label: "Soon Deleted Staffer",
      email: `soondeleted-${Date.now()}@example.com`,
      state_slug: "georgia",
      license_type_id: "ga-individual",
    });
    const { id: staffId } = (await staff.json()) as { id: string };

    const resp = await deleteAccount(cookie, { reason: "no_longer_needed", detail: "Firm closed." });
    expect(resp.status).toBe(200);

    const firm = await store.getFirmById(env.DB, firmId);
    expect(firm?.status).toBe(store.FIRM_STATUS_DELETED);
    expect(firm?.deletion_requested_at).toBeTruthy();
    expect(firm?.deletion_survey_reason).toBe("no_longer_needed");
    expect(firm?.deletion_survey_detail).toBe("Firm closed.");

    // the exact reminder-cron query -- confirms the staffer really is
    // excluded from future sends, not just "looks stopped" in the API shape
    const stillGetsReminders = (await store.allConfirmedActive(env.DB)).some((s) => s.id === staffId);
    expect(stillGetsReminders).toBe(false);

    // the session used to delete the account is itself dead now
    const afterDelete = await SELF.fetch(`${BASE}/firm/licenses`, { headers: { Cookie: cookie } });
    expect(afterDelete.status).toBe(401);
  });

  it("a retried delete after the account is already gone gets a clean 403, not a 500 -- the generic inactive-firm gate already handles it", async () => {
    const { firmId, cookie } = await createFirmWithSession("Double Delete LLC", `doubledelete-${Date.now()}@example.com`);
    const first = await deleteAccount(cookie);
    expect(first.status).toBe(200);

    // requireFirmSession() denies ANY non-'active' firm status before this
    // handler's own body ever runs -- a fresh session on an already-deleted
    // firm hits that generic gate, same as any other route would. The
    // handler's own "already status===deleted" branch exists for the
    // narrower concurrent-request race (two deletes landing close enough
    // together that requireFirmSession() passed both before either write
    // committed), not this sequential case.
    const { rawSessionToken } = await store.createSession(env.DB, firmId);
    const second = await deleteAccount(`dr_firm_session=${rawSessionToken}`);
    expect(second.status).toBe(403);
  });

  it("an unrecognised survey reason is silently dropped to null, not a 400", async () => {
    const { firmId, cookie } = await createFirmWithSession("Bad Reason LLC", `badreason-${Date.now()}@example.com`);
    const resp = await deleteAccount(cookie, { reason: "not_a_real_reason_at_all" });
    expect(resp.status).toBe(200);
    const firm = await store.getFirmById(env.DB, firmId);
    expect(firm?.deletion_survey_reason).toBeNull();
  });

  it("the survey is entirely optional -- an empty body still deletes cleanly", async () => {
    const { firmId, cookie } = await createFirmWithSession("No Survey LLC", `nosurvey-${Date.now()}@example.com`);
    const resp = await deleteAccount(cookie);
    expect(resp.status).toBe(200);
    const firm = await store.getFirmById(env.DB, firmId);
    expect(firm?.status).toBe(store.FIRM_STATUS_DELETED);
    expect(firm?.deletion_survey_reason).toBeNull();
    expect(firm?.deletion_survey_detail).toBeNull();
  });

  it("cancels a live Stripe subscription (cancel_at_period_end) as part of deletion", async () => {
    const { firmId, cookie } = await createFirmWithSession("Paid Delete LLC", `paiddelete-${Date.now()}@example.com`);
    await env.DB.prepare("UPDATE firms SET plan_tier = 'firm_growth', stripe_subscription_id = ?1 WHERE id = ?2")
      .bind("sub_delete_test", firmId)
      .run();
    const periodEndUnix = Math.floor(Date.now() / 1000) + 20 * 86400;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ id: "sub_delete_test", cancel_at_period_end: true, items: { data: [{ current_period_end: periodEndUnix }] } }),
        { status: 200 }
      )
    );
    try {
      const resp = await workerFetch(
        new Request(`${BASE}/firm/account/delete`, { method: "POST", headers: { Cookie: cookie } }),
        { STRIPE_SECRET_KEY: "sk_test_x" }
      );
      expect(resp.status).toBe(200);
      const [, calledInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect((calledInit.body as string) ?? "").toContain("cancel_at_period_end=true");

      const firm = await store.getFirmById(env.DB, firmId);
      expect(firm?.cancel_at_period_end).toBe(1);
      expect(firm?.status).toBe(store.FIRM_STATUS_DELETED);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("a Stripe outage during deletion still lets the deletion itself succeed", async () => {
    const { firmId, cookie } = await createFirmWithSession("Stripe Down Delete LLC", `stripedown-${Date.now()}@example.com`);
    await env.DB.prepare("UPDATE firms SET stripe_subscription_id = ?1 WHERE id = ?2").bind("sub_down_test", firmId).run();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    try {
      const resp = await workerFetch(
        new Request(`${BASE}/firm/account/delete`, { method: "POST", headers: { Cookie: cookie } }),
        { STRIPE_SECRET_KEY: "sk_test_x" }
      );
      expect(resp.status).toBe(200);
      const firm = await store.getFirmById(env.DB, firmId);
      expect(firm?.status).toBe(store.FIRM_STATUS_DELETED);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("store.hardDeleteExpiredFirms", () => {
  async function deletedFirm(daysAgo: number): Promise<string> {
    const firm = await store.createFirm(env.DB, { name: "Hard Delete Test LLC", adminEmail: `harddelete-${Date.now()}-${Math.random()}@example.com` });
    await env.DB.prepare("UPDATE firms SET status = ?1, deletion_requested_at = ?2 WHERE id = ?3")
      .bind(store.FIRM_STATUS_DELETED, new Date(Date.now() - daysAgo * 86_400_000).toISOString(), firm.id)
      .run();
    return firm.id;
  }

  it("leaves a firm inside its grace period alone", async () => {
    const firmId = await deletedFirm(10);
    const deleted = await store.hardDeleteExpiredFirms(env.DB, new Date());
    expect(deleted).not.toContain(firmId);
    expect(await store.getFirmById(env.DB, firmId)).not.toBeNull();
  });

  it("hard-deletes a firm past its 30-day grace period, and every related row with it", async () => {
    const firmId = await deletedFirm(31);
    const { id: staffId } = await store.addPending(env.DB, {
      email: `harddeletestaff-${Date.now()}@example.com`,
      stateSlug: "georgia",
      deadlineFields: {},
      firstName: null,
      deadlineSource: store.DEADLINE_SOURCE_USER,
      userDeadline: "2027-01-01",
      firmId,
      staffLabel: "Doomed Staffer",
      skipConfirmation: true,
    });
    await store.logActivity(env.DB, { firmId, subscriberId: staffId, staffLabel: "Doomed Staffer", email: "x@example.com", eventType: "added" });

    const deleted = await store.hardDeleteExpiredFirms(env.DB, new Date());
    expect(deleted).toContain(firmId);

    expect(await store.getFirmById(env.DB, firmId)).toBeNull();
    const staffRow = await env.DB.prepare("SELECT 1 FROM subscribers WHERE id = ?1").bind(staffId).first();
    expect(staffRow).toBeNull();
    const activityRows = await env.DB.prepare("SELECT 1 FROM activity_log WHERE firm_id = ?1").bind(firmId).first();
    expect(activityRows).toBeNull();
  });

  it("never touches a firm that hasn't been deleted at all", async () => {
    const { id: firmId } = await store.createFirm(env.DB, { name: "Untouched LLC", adminEmail: `untouched-${Date.now()}@example.com` });
    const deleted = await store.hardDeleteExpiredFirms(env.DB, new Date());
    expect(deleted).not.toContain(firmId);
    expect(await store.getFirmById(env.DB, firmId)).not.toBeNull();
  });
});
