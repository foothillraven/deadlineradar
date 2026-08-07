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
import { hashPassword } from "../src/password";

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

  // AuditLab DELETE-1 (HIGH, 2026-08-06): a session cookie alone used to be
  // sufficient to delete the account -- no proof of credential possession
  // required. Mirrors handleFirmPasswordSet's own step-up gate.
  it("400s a firm WITH a password when current_password is missing or wrong", async () => {
    const email = `deletepwwrong-${Date.now()}@example.com`;
    const { id: firmId } = await store.createFirm(env.DB, { name: "Delete Password Firm", adminEmail: email });
    await store.setFirmPassword(env.DB, firmId, await hashPassword("the-real-password"));
    const { rawSessionToken } = await store.createSession(env.DB, firmId);
    const cookie = `dr_firm_session=${rawSessionToken}`;

    const missing = await deleteAccount(cookie);
    expect(missing.status).toBe(400);
    const wrong = await deleteAccount(cookie, { current_password: "definitely-not-it" });
    expect(wrong.status).toBe(400);

    const firm = await store.getFirmById(env.DB, firmId);
    expect(firm?.status).not.toBe(store.FIRM_STATUS_DELETED);
  });

  it("deletes successfully for a firm WITH a password when current_password is correct", async () => {
    const email = `deletepwright-${Date.now()}@example.com`;
    const { id: firmId } = await store.createFirm(env.DB, { name: "Delete Password Right Firm", adminEmail: email });
    await store.setFirmPassword(env.DB, firmId, await hashPassword("the-real-password"));
    const { rawSessionToken } = await store.createSession(env.DB, firmId);
    const cookie = `dr_firm_session=${rawSessionToken}`;

    const resp = await deleteAccount(cookie, { current_password: "the-real-password" });
    expect(resp.status).toBe(200);
    const firm = await store.getFirmById(env.DB, firmId);
    expect(firm?.status).toBe(store.FIRM_STATUS_DELETED);
  });

  it("skips the step-up check for a magic-link-only firm with no password set", async () => {
    // Every OTHER test in this file already exercises this path implicitly
    // (createFirmWithSession() never sets a password) -- this one just
    // says so explicitly, so the exemption itself has a named test rather
    // than being an accidental side effect of every other test's setup.
    const { firmId, cookie } = await createFirmWithSession("No Password Delete LLC", `nopassworddelete-${Date.now()}@example.com`);
    const resp = await deleteAccount(cookie);
    expect(resp.status).toBe(200);
    const firm = await store.getFirmById(env.DB, firmId);
    expect(firm?.status).toBe(store.FIRM_STATUS_DELETED);
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

  /** Task #32 (2026-08-06): a real deletion touches Stripe 4 times in
   * sequence -- GET subscription (latest_invoice), GET invoice (payments),
   * POST refund, DELETE subscription. Routes each mocked response by
   * method + URL shape rather than call order, since call order is an
   * implementation detail this test shouldn't be coupled to. */
  function mockStripeSequence(opts: {
    periodStartUnix: number;
    periodEndUnix: number;
    amountPaid: number;
    paymentIntentId: string | null;
  }) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const method = typeof input === "string" ? (init?.method ?? "GET") : (input as Request).method;
      if (url.includes("/v1/subscriptions/") && url.includes("latest_invoice") && method !== "DELETE") {
        return new Response(
          JSON.stringify({
            items: { data: [{ current_period_start: opts.periodStartUnix, current_period_end: opts.periodEndUnix }] },
            latest_invoice: { id: "in_test123", amount_paid: opts.amountPaid },
          }),
          { status: 200 }
        );
      }
      if (url.includes("/v1/invoices/")) {
        return new Response(
          JSON.stringify({
            payments: {
              data: opts.paymentIntentId
                ? [{ payment: { type: "payment_intent", payment_intent: opts.paymentIntentId } }]
                : [],
            },
          }),
          { status: 200 }
        );
      }
      if (url.includes("/v1/refunds")) {
        return new Response(JSON.stringify({ id: "re_test123" }), { status: 200 });
      }
      if (url.includes("/v1/subscriptions/") && method === "DELETE") {
        return new Response(JSON.stringify({ status: "canceled" }), { status: 200 });
      }
      throw new Error(`Unexpected Stripe call: ${method} ${url}`);
    });
  }

  it("refunds the prorated unused portion and cancels immediately, for a firm mid-period", async () => {
    const { firmId, cookie } = await createFirmWithSession("Paid Delete LLC", `paiddelete-${Date.now()}@example.com`);
    await env.DB.prepare("UPDATE firms SET plan_tier = 'firm_growth', stripe_subscription_id = ?1 WHERE id = ?2")
      .bind("sub_delete_test", firmId)
      .run();
    const nowUnix = Math.floor(Date.now() / 1000);
    // 10 days used out of a 100-day period -> 90% of $349.00 (34900 cents) unused
    const fetchSpy = mockStripeSequence({
      periodStartUnix: nowUnix - 10 * 86400,
      periodEndUnix: nowUnix + 90 * 86400,
      amountPaid: 34900,
      paymentIntentId: "pi_test123",
    });
    try {
      const resp = await workerFetch(
        new Request(`${BASE}/firm/account/delete`, { method: "POST", headers: { Cookie: cookie } }),
        { STRIPE_SECRET_KEY: "sk_test_x" }
      );
      expect(resp.status).toBe(200);

      const refundCall = fetchSpy.mock.calls.find((c) => (typeof c[0] === "string" ? c[0] : (c[0] as Request).url).includes("/v1/refunds"));
      expect(refundCall).toBeTruthy();
      const [, refundInit] = refundCall as [string, RequestInit];
      expect((refundInit.body as string) ?? "").toContain("payment_intent=pi_test123");
      expect((refundInit.body as string) ?? "").toContain("amount=31410"); // 90% of 34900, rounded

      const deleteCall = fetchSpy.mock.calls.find((c) => {
        const url = typeof c[0] === "string" ? c[0] : (c[0] as Request).url;
        const init = c[1] as RequestInit | undefined;
        return url.includes("/v1/subscriptions/") && init?.method === "DELETE";
      });
      expect(deleteCall).toBeTruthy();

      const firm = await store.getFirmById(env.DB, firmId);
      expect(firm?.status).toBe(store.FIRM_STATUS_DELETED);
      expect(firm?.deletion_refund_cents).toBe(31410);
      expect(firm?.deletion_refund_id).toBe("re_test123");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("still cancels, but issues no refund, when the invoice has no linked payment", async () => {
    const { firmId, cookie } = await createFirmWithSession("No Payment Delete LLC", `nopayment-${Date.now()}@example.com`);
    await env.DB.prepare("UPDATE firms SET stripe_subscription_id = ?1 WHERE id = ?2").bind("sub_nopay_test", firmId).run();
    const nowUnix = Math.floor(Date.now() / 1000);
    const fetchSpy = mockStripeSequence({
      periodStartUnix: nowUnix - 5 * 86400,
      periodEndUnix: nowUnix + 25 * 86400,
      amountPaid: 19900,
      paymentIntentId: null,
    });
    try {
      const resp = await workerFetch(
        new Request(`${BASE}/firm/account/delete`, { method: "POST", headers: { Cookie: cookie } }),
        { STRIPE_SECRET_KEY: "sk_test_x" }
      );
      expect(resp.status).toBe(200);
      const refundCall = fetchSpy.mock.calls.find((c) => (typeof c[0] === "string" ? c[0] : (c[0] as Request).url).includes("/v1/refunds"));
      expect(refundCall).toBeUndefined();

      const firm = await store.getFirmById(env.DB, firmId);
      expect(firm?.deletion_refund_cents).toBeNull();
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
    const deleted = await store.hardDeleteExpiredFirms(env.DB, env.DOCUMENTS, new Date());
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

    const deleted = await store.hardDeleteExpiredFirms(env.DB, env.DOCUMENTS, new Date());
    expect(deleted).toContain(firmId);

    expect(await store.getFirmById(env.DB, firmId)).toBeNull();
    const staffRow = await env.DB.prepare("SELECT 1 FROM subscribers WHERE id = ?1").bind(staffId).first();
    expect(staffRow).toBeNull();
    const activityRows = await env.DB.prepare("SELECT 1 FROM activity_log WHERE firm_id = ?1").bind(firmId).first();
    expect(activityRows).toBeNull();
  });

  // AuditLab RETAIN-1 (MEDIUM, 2026-08-07): 5 firm-scoped tables added
  // after this function was last touched (documents,
  // feature_questionnaire_responses, reminder_log, firm_nps_responses,
  // firm_testimonials) were never added to the deletion loop, and no R2
  // object was ever deleted -- a deleted firm's uploaded license/CPE
  // certificates persisted in R2 forever, contradicting the "permanently
  // erased" promise. This proves all five tables AND the R2 object are
  // actually gone, not just that the function runs without error.
  it("hard-deletes all 5 previously-missing tables and the R2 object behind a document row", async () => {
    const firmId = await deletedFirm(31);
    const { id: staffId } = await store.addPending(env.DB, {
      email: `retain1-staff-${Date.now()}@example.com`,
      stateSlug: "georgia",
      deadlineFields: {},
      firstName: null,
      deadlineSource: store.DEADLINE_SOURCE_USER,
      userDeadline: "2027-01-01",
      firmId,
      staffLabel: "Retain1 Staffer",
      skipConfirmation: true,
    });

    const r2Key = `retain1-test/${firmId}/${Date.now()}.pdf`;
    await env.DOCUMENTS.put(r2Key, new Uint8Array([1, 2, 3]));
    await store.createDocument(env.DB, {
      firmId,
      subscriberId: staffId,
      kind: "license",
      r2Key,
      filename: "license.pdf",
      contentType: "application/pdf",
      sizeBytes: 3,
    });
    await store.submitFeatureQuestionnaire(env.DB, firmId, ["API access"], "please");
    await store.logReminderSent(env.DB, firmId, staffId, 30);
    await store.recordNpsResponse(env.DB, firmId, 9);
    await store.recordTestimonial(env.DB, firmId, "Great product", true);

    // Sanity: everything actually landed before deletion runs, so a false
    // PASS below can't be explained by the rows never existing.
    expect(await env.DOCUMENTS.get(r2Key)).not.toBeNull();
    for (const [table] of [
      ["documents"],
      ["feature_questionnaire_responses"],
      ["reminder_log"],
      ["firm_nps_responses"],
      ["firm_testimonials"],
    ] as const) {
      const row = await env.DB.prepare(`SELECT 1 FROM ${table} WHERE firm_id = ?1`).bind(firmId).first();
      expect(row, `expected a ${table} row to exist before deletion`).not.toBeNull();
    }

    await store.hardDeleteExpiredFirms(env.DB, env.DOCUMENTS, new Date());

    expect(await env.DOCUMENTS.get(r2Key)).toBeNull();
    for (const [table] of [
      ["documents"],
      ["feature_questionnaire_responses"],
      ["reminder_log"],
      ["firm_nps_responses"],
      ["firm_testimonials"],
    ] as const) {
      const row = await env.DB.prepare(`SELECT 1 FROM ${table} WHERE firm_id = ?1`).bind(firmId).first();
      expect(row, `expected ${table} to be empty after deletion`).toBeNull();
    }
  });

  it("never touches a firm that hasn't been deleted at all", async () => {
    const { id: firmId } = await store.createFirm(env.DB, { name: "Untouched LLC", adminEmail: `untouched-${Date.now()}@example.com` });
    const deleted = await store.hardDeleteExpiredFirms(env.DB, env.DOCUMENTS, new Date());
    expect(deleted).not.toContain(firmId);
    expect(await store.getFirmById(env.DB, firmId)).not.toBeNull();
  });
});
