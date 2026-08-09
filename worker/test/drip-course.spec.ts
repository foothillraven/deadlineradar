/**
 * Roadmap #34 (2026-08-08): free renewal-reminder drip email course for
 * undecided leads. Modeled on snooze.spec.ts's own shape -- pure-function
 * unit tests, store-level tests, then end-to-end through the real
 * runDripCoursePass() with an injected send() and direct-SQL time control
 * instead of waiting on the wall clock.
 */
import { env, SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import * as store from "../src/store";
import { nextDueDripStep, dripCourseCycleFact, DRIP_COURSE_STEP_DAYS, runDripCoursePass } from "../src/scheduler";
import { checkAndCountDripCourseSend } from "../src/sender";
import { StaleDataError, STALENESS_THRESHOLD_DAYS } from "../src/deadline";
import cpaDeadlinesData from "../src/cpa_deadlines.json";

const BASE = "https://deadline-radar.com";

async function newConfirmedFreeSubscriber(label: string, stateSlug = "texas"): Promise<{ email: string; id: string }> {
  const email = `${label}-${Date.now()}-${Math.floor(performance.now())}@example.com`;
  const rec = await store.addPending(env.DB, { email, stateSlug, deadlineFields: { birth_month: "7" }, firstName: "Tester" });
  await store.confirm(env.DB, rec.confirm_token);
  return { email, id: rec.id };
}

async function postAction(pathAndQuery: string, ip = "203.0.113.1"): Promise<Response> {
  const u = new URL(`${BASE}${pathAndQuery}`);
  const token = u.searchParams.get("token") ?? "";
  return SELF.fetch(`${BASE}${u.pathname}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": ip },
    body: new URLSearchParams({ token }).toString(),
  });
}

describe("nextDueDripStep() -- pure function", () => {
  it("returns null before day 0's own threshold", () => {
    expect(nextDueDripStep(-1, [])).toBeNull();
  });

  it("returns step 0 once enrolled (day 0)", () => {
    expect(nextDueDripStep(0, [])).toBe(0);
  });

  it("never re-sends a step already in alreadySent", () => {
    expect(nextDueDripStep(0, [0])).toBeNull();
  });

  it("advances to the next step once its day arrives", () => {
    expect(nextDueDripStep(7, [0])).toBe(7);
    expect(nextDueDripStep(6, [0])).toBeNull();
  });

  it("never regresses to an earlier step than the most recent one sent", () => {
    // Simulates a clock/data oddity where step 14 was somehow sent before
    // step 7 was recorded -- step 7 must never fire after a later step has.
    expect(nextDueDripStep(21, [14])).toBe(21);
  });

  it("bounded catch-up: a long-delayed pass returns the EARLIEST unsent due step, not the latest", () => {
    // 30 days since enrollment, nothing sent yet -- should return 0, not 21,
    // so catch-up happens one step per pass rather than skipping ahead.
    expect(nextDueDripStep(30, [])).toBe(0);
  });

  it("returns null once every step has been sent", () => {
    expect(nextDueDripStep(100, [...DRIP_COURSE_STEP_DAYS])).toBeNull();
  });
});

describe("dripCourseCycleFact()", () => {
  it("returns a real, non-empty excerpt for a known state", () => {
    const fact = dripCourseCycleFact("texas");
    expect(fact.length).toBeGreaterThan(10);
    expect(fact).not.toMatch(/renewal cycles vary by state/); // the generic fallback string
  });

  it("returns the generic fallback for an unknown/null state, never fabricating one", () => {
    expect(dripCourseCycleFact(null)).toMatch(/renewal cycles vary by state/);
    expect(dripCourseCycleFact("not-a-real-state-slug")).toMatch(/renewal cycles vary by state/);
  });

  it("never exceeds the length cap", () => {
    const fact = dripCourseCycleFact("texas");
    expect(fact.length).toBeLessThanOrEqual(230);
  });

  it("AuditLab DRIP-1: a record with data_gap_note never gets excerpted, even though cycle_description exists -- falls back to the generic sentence", () => {
    // Michigan: the public state page itself deliberately publishes no
    // computed date and shows a sourcing caveat (data_gap_note) instead --
    // the drip email must never be MORE assertive than the product's own
    // page for this exact record.
    const fact = dripCourseCycleFact("michigan");
    expect(fact).toMatch(/renewal cycles vary by state/);
  });

  it("AuditLab DRIP-1: a cycle_description longer than the cap (no data_gap_note) falls back to the generic sentence rather than truncating mid-caveat", () => {
    // Pennsylvania: no data_gap_note, but cycle_description is well over
    // 220 chars -- isolates the SECOND guard (length-only) from the first
    // (data_gap_note), proving the fallback fires on length alone too.
    // These fields are routinely claim-first, caveat-second -- a
    // mid-sentence cut can land exactly between them, so the fix removes
    // truncation as a failure mode entirely instead of finding a smarter
    // cut point.
    const fact = dripCourseCycleFact("pennsylvania");
    expect(fact).toMatch(/renewal cycles vary by state/);
    expect(fact).not.toContain("...");
  });
});

describe("store.findEligibleDripCourseLeads()", () => {
  it("includes a confirmed, free-tier, not-yet-enrolled subscriber", async () => {
    const { email } = await newConfirmedFreeSubscriber("eligible-basic");
    const leads = await store.findEligibleDripCourseLeads(env.DB, 500);
    expect(leads.some((l) => l.email === email)).toBe(true);
  });

  it("excludes a subscriber already enrolled", async () => {
    const { email } = await newConfirmedFreeSubscriber("eligible-already-enrolled");
    await store.enrollDripCourseLead(env.DB, { email, first_name: "Tester", state_slug: "texas" });
    const leads = await store.findEligibleDripCourseLeads(env.DB, 500);
    expect(leads.some((l) => l.email === email)).toBe(false);
  });

  it("excludes a subscriber whose email already runs a firm (firms.admin_email match)", async () => {
    const { email } = await newConfirmedFreeSubscriber("eligible-firm-admin");
    await store.createFirm(env.DB, { name: "Already Converted LLP", adminEmail: email });
    const leads = await store.findEligibleDripCourseLeads(env.DB, 500);
    expect(leads.some((l) => l.email === email)).toBe(false);
  });

  it("excludes a subscriber whose email is a non-primary firm_members row", async () => {
    const { email } = await newConfirmedFreeSubscriber("eligible-firm-member");
    const { id: firmId } = await store.createFirm(env.DB, { name: "Another Firm LLP", adminEmail: `admin-${Date.now()}@example.com` });
    await store.createFirmMember(env.DB, { firmId, email, name: "Staffer", role: "staff" });
    const leads = await store.findEligibleDripCourseLeads(env.DB, 500);
    expect(leads.some((l) => l.email === email)).toBe(false);
  });

  it("excludes a firm-tracked (non-free-tier) subscriber row", async () => {
    const { id: firmId } = await store.createFirm(env.DB, { name: "Roster Firm LLP", adminEmail: `admin2-${Date.now()}@example.com` });
    const email = `roster-${Date.now()}@example.com`;
    await env.DB.prepare(
      `INSERT INTO subscribers (id, email, cooldown_key, state_slug, deadline_fields, status, confirm_token, unsubscribe_token, renewed_token, created_at, confirmed_at, firm_id)
       VALUES (?1, ?2, ?2, 'texas', '{}', 'confirmed', ?3, ?4, ?5, datetime('now'), datetime('now'), ?6)`
    )
      .bind(store.newToken(), email, store.newToken(), store.newToken(), store.newToken(), firmId)
      .run();
    const leads = await store.findEligibleDripCourseLeads(env.DB, 500);
    expect(leads.some((l) => l.email === email)).toBe(false);
  });

  it("excludes a permanently-suppressed (unsubscribed) email", async () => {
    const { email, id } = await newConfirmedFreeSubscriber("eligible-suppressed");
    const row = await env.DB.prepare("SELECT unsubscribe_token FROM subscribers WHERE id = ?1").bind(id).first<{ unsubscribe_token: string }>();
    await store.stop(env.DB, row!.unsubscribe_token, "unsubscribed");
    const leads = await store.findEligibleDripCourseLeads(env.DB, 500);
    expect(leads.some((l) => l.email === email)).toBe(false);
  });
});

describe("store.enrollDripCourseLead() idempotency", () => {
  it("a second enroll call for the same email is a no-op, not a duplicate row", async () => {
    const email = `enroll-idem-${Date.now()}@example.com`;
    await store.enrollDripCourseLead(env.DB, { email, first_name: "A", state_slug: "texas" });
    await store.enrollDripCourseLead(env.DB, { email, first_name: "B", state_slug: "florida" });
    const { results } = await env.DB.prepare("SELECT * FROM drip_course_enrollments WHERE email_normalized = ?1")
      .bind(store.normalizeEmail(email))
      .all();
    expect(results.length).toBe(1);
    expect((results[0] as { first_name: string }).first_name).toBe("A"); // first write wins
  });
});

describe("store.stopDripCourseByToken()", () => {
  it("stops future sends and is idempotent", async () => {
    const email = `stop-token-${Date.now()}@example.com`;
    await store.enrollDripCourseLead(env.DB, { email, first_name: null, state_slug: "texas" });
    const row = await env.DB.prepare("SELECT unsubscribe_token FROM drip_course_enrollments WHERE email_normalized = ?1")
      .bind(store.normalizeEmail(email))
      .first<{ unsubscribe_token: string }>();
    expect(await store.stopDripCourseByToken(env.DB, row!.unsubscribe_token)).toBe(true);
    expect(await store.stopDripCourseByToken(env.DB, row!.unsubscribe_token)).toBe(true); // idempotent repeat
    expect(await store.stopDripCourseByToken(env.DB, "not-a-real-token")).toBe(false);

    const leads = await store.listActiveDripCourseEnrollments(env.DB);
    expect(leads.some((l) => l.email === email)).toBe(false);
  });
});

describe("runDripCoursePass() -- end to end", () => {
  it("enrolls a newly-eligible subscriber and sends step 0 (day 0) in the same pass", async () => {
    const { email } = await newConfirmedFreeSubscriber("e2e-step0", "texas");
    let capturedTo = "";
    let capturedSubject = "";
    const summary = await runDripCoursePass(env, {
      send: async (to, built) => {
        if (to === email) {
          capturedTo = to;
          capturedSubject = built.subject;
        }
        return true;
      },
    });
    expect(summary.enrolled).toBeGreaterThan(0);
    expect(capturedTo).toBe(email);
    expect(capturedSubject).toMatch(/renew/i);

    const row = await env.DB.prepare("SELECT steps_sent FROM drip_course_enrollments WHERE email_normalized = ?1")
      .bind(store.normalizeEmail(email))
      .first<{ steps_sent: string }>();
    expect(JSON.parse(row!.steps_sent)).toEqual([0]);
  });

  it("does not re-send step 0 on a second pass the same day, and does not send step 7 before day 7", async () => {
    const { email } = await newConfirmedFreeSubscriber("e2e-no-early-step7", "texas");
    const first = await runDripCoursePass(env, { send: async () => true });
    expect(first.sent).toBeGreaterThan(0);

    let sentAgain = false;
    await runDripCoursePass(env, {
      send: async (to) => {
        if (to === email) sentAgain = true;
        return true;
      },
    });
    expect(sentAgain).toBe(false);
  });

  it("sends step 7 once 7 days have passed, with the never-regress-checked steps_sent array", async () => {
    const { email } = await newConfirmedFreeSubscriber("e2e-step7", "texas");
    await runDripCoursePass(env, { send: async () => true }); // enrolls + sends step 0

    // Back-date started_at to simulate 7 days having passed, same
    // direct-SQL time-travel technique snooze.spec.ts uses.
    await env.DB.prepare("UPDATE drip_course_enrollments SET started_at = ?1 WHERE email_normalized = ?2")
      .bind(new Date(Date.now() - 7 * 86_400_000).toISOString(), store.normalizeEmail(email))
      .run();

    let capturedSubject = "";
    await runDripCoursePass(env, {
      send: async (to, built) => {
        if (to === email) capturedSubject = built.subject;
        return true;
      },
    });
    expect(capturedSubject).toMatch(/CPE/i);

    const row = await env.DB.prepare("SELECT steps_sent FROM drip_course_enrollments WHERE email_normalized = ?1")
      .bind(store.normalizeEmail(email))
      .first<{ steps_sent: string }>();
    expect(JSON.parse(row!.steps_sent)).toEqual([0, 7]);
  });

  it("AuditLab DRIP-2: unsubscribing from reminders (permanent suppression) stops the drip too, not just steps_sent", async () => {
    const { email } = await newConfirmedFreeSubscriber("e2e-drip2-suppressed", "texas");
    await runDripCoursePass(env, { send: async () => true }); // enrolls + sends step 0

    // The reminder-side unsubscribe, NOT the drip's own opted_out_at column
    // -- this is exactly the "stop the course, keep my renewal reminders"
    // token being a DIFFERENT mechanism than "stop emailing me entirely".
    const subRow = await env.DB.prepare("SELECT unsubscribe_token FROM subscribers WHERE LOWER(TRIM(email)) = ?1")
      .bind(store.normalizeEmail(email))
      .first<{ unsubscribe_token: string }>();
    await store.stop(env.DB, subRow!.unsubscribe_token, "unsubscribed");
    expect(await store.isPermanentlySuppressed(env.DB, email)).toBe(true);

    // The drip's own column is untouched -- suppression is a SEPARATE,
    // cross-cutting check, not something that flows through opted_out_at.
    const enrBefore = await env.DB.prepare("SELECT opted_out_at FROM drip_course_enrollments WHERE email_normalized = ?1")
      .bind(store.normalizeEmail(email))
      .first<{ opted_out_at: string | null }>();
    expect(enrBefore!.opted_out_at).toBeNull();

    await env.DB.prepare("UPDATE drip_course_enrollments SET started_at = ?1 WHERE email_normalized = ?2")
      .bind(new Date(Date.now() - 7 * 86_400_000).toISOString(), store.normalizeEmail(email))
      .run();

    let sentAfterSuppression = false;
    await runDripCoursePass(env, {
      send: async (to) => {
        if (to === email) sentAfterSuppression = true;
        return true;
      },
    });
    expect(sentAfterSuppression).toBe(false);

    // Not claimed either -- a skipped-for-suppression send must not burn
    // the step (per the fix's own docstring in scheduler.ts).
    const row = await env.DB.prepare("SELECT steps_sent FROM drip_course_enrollments WHERE email_normalized = ?1")
      .bind(store.normalizeEmail(email))
      .first<{ steps_sent: string }>();
    expect(JSON.parse(row!.steps_sent)).toEqual([0]);
  });

  it("claim/unclaim prevents a double-send when two passes race on the same due step", async () => {
    const email = `e2e-race-${Date.now()}@example.com`;
    await store.enrollDripCourseLead(env.DB, { email, first_name: null, state_slug: "texas" });
    const enr = await env.DB.prepare("SELECT * FROM drip_course_enrollments WHERE email_normalized = ?1")
      .bind(store.normalizeEmail(email))
      .first<{ id: string; steps_sent: string }>();

    const claimA = await store.claimDripCourseStep(env.DB, enr!.id, enr!.steps_sent, 0);
    const claimB = await store.claimDripCourseStep(env.DB, enr!.id, enr!.steps_sent, 0);
    expect(claimA).toBe(true);
    expect(claimB).toBe(false); // lost the race -- steps_sent already moved

    await store.unclaimDripCourseStep(env.DB, enr!.id, 0);
    const row = await env.DB.prepare("SELECT steps_sent FROM drip_course_enrollments WHERE id = ?1").bind(enr!.id).first<{ steps_sent: string }>();
    expect(JSON.parse(row!.steps_sent)).toEqual([]);
  });

  it("a failed send() reverts the claim so the step is retried next pass, not lost", async () => {
    const { email } = await newConfirmedFreeSubscriber("e2e-failed-send", "texas");
    const summary = await runDripCoursePass(env, { send: async () => false });
    expect(summary.sent).toBe(0);
    expect(summary.errors.length).toBeGreaterThan(0);

    const row = await env.DB.prepare("SELECT steps_sent FROM drip_course_enrollments WHERE email_normalized = ?1")
      .bind(store.normalizeEmail(email))
      .first<{ steps_sent: string }>();
    expect(JSON.parse(row!.steps_sent)).toEqual([]); // reverted, not stuck at [0] with nothing actually sent

    let sentOnRetry = false;
    await runDripCoursePass(env, {
      send: async (to) => {
        if (to === email) sentOnRetry = true;
        return true;
      },
    });
    expect(sentOnRetry).toBe(true);
  });

  it("the daily send cap halts the whole pass without erroring", async () => {
    const a = await newConfirmedFreeSubscriber("e2e-cap-a", "texas");
    const b = await newConfirmedFreeSubscriber("e2e-cap-b", "florida");
    let sends = 0;
    // Drain the cap to zero remaining first (cap of 1, one prior send already
    // recorded), then run the real pass with that SAME cap overridden via
    // env (the default DEFAULT_DAILY_DRIP_COURSE_SEND_CAP=100 would never
    // trip for just two leads) and confirm no MORE gets through despite two
    // eligible leads being due.
    await checkAndCountDripCourseSend(env.DB, 1); // consumes the only slot for today
    const summary = await runDripCoursePass(
      { ...env, DRIP_COURSE_DAILY_SEND_CAP: "1" },
      {
        send: async () => {
          sends += 1;
          return true;
        },
      }
    );
    expect(sends).toBe(0);
    expect(summary.errors.some((e) => e.error.includes("daily send cap"))).toBe(true);
    void a;
    void b;
  });

  it("an unsubscribed enrollment is excluded from the send pass entirely", async () => {
    const email = `e2e-unsub-${Date.now()}@example.com`;
    await store.enrollDripCourseLead(env.DB, { email, first_name: null, state_slug: "texas" });
    const row = await env.DB.prepare("SELECT unsubscribe_token FROM drip_course_enrollments WHERE email_normalized = ?1")
      .bind(store.normalizeEmail(email))
      .first<{ unsubscribe_token: string }>();
    await store.stopDripCourseByToken(env.DB, row!.unsubscribe_token);

    let sent = false;
    await runDripCoursePass(env, {
      send: async (to) => {
        if (to === email) sent = true;
        return true;
      },
    });
    expect(sent).toBe(false);
  });

  it("AuditLab DRIP-3: throws StaleDataError (not a silent send) once cpa_deadlines.json's as_of_date ages out, same guard runReminderPass() has", async () => {
    // checkDataFreshness() judges freshness against the REAL wall clock
    // even when a caller supplies a simulated `asOf` -- proving the guard
    // actually fires requires moving the system clock, not passing a
    // parameter. Derived from the real as_of_date + one day past the
    // threshold, same "never lets this go silently wrong later" reasoning
    // as worker.spec.ts's own STALE_MOCK_DATE.
    const staleMockDate = new Date(
      Date.parse(`${cpaDeadlinesData.as_of_date}T00:00:00Z`) + (STALENESS_THRESHOLD_DAYS + 1) * 86_400_000
    );
    vi.useFakeTimers();
    try {
      vi.setSystemTime(staleMockDate);
      await expect(runDripCoursePass(env)).rejects.toThrow(StaleDataError);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("GET/POST /drip-course/unsubscribe", () => {
  it("GET renders a confirm page WITHOUT changing state (prefetch-safe)", async () => {
    const email = `route-render-${Date.now()}@example.com`;
    await store.enrollDripCourseLead(env.DB, { email, first_name: null, state_slug: "texas" });
    const row = await env.DB.prepare("SELECT unsubscribe_token FROM drip_course_enrollments WHERE email_normalized = ?1")
      .bind(store.normalizeEmail(email))
      .first<{ unsubscribe_token: string }>();

    const getResp = await SELF.fetch(`${BASE}/drip-course/unsubscribe?token=${row!.unsubscribe_token}`, {
      headers: { "cf-connecting-ip": "203.0.113.240" },
    });
    expect(getResp.status).toBe(200);
    expect(await getResp.text()).toContain("this series");

    const leads = await store.listActiveDripCourseEnrollments(env.DB);
    expect(leads.some((l) => l.email === email)).toBe(true); // still active -- GET changed nothing
  });

  it("POST actually stops the series", async () => {
    const email = `route-post-${Date.now()}@example.com`;
    await store.enrollDripCourseLead(env.DB, { email, first_name: null, state_slug: "texas" });
    const row = await env.DB.prepare("SELECT unsubscribe_token FROM drip_course_enrollments WHERE email_normalized = ?1")
      .bind(store.normalizeEmail(email))
      .first<{ unsubscribe_token: string }>();

    const resp = await postAction(`/drip-course/unsubscribe?token=${row!.unsubscribe_token}`, "203.0.113.241");
    expect(resp.status).toBe(200);
    expect((await resp.text()).toLowerCase()).toContain("unsubscribed");

    const leads = await store.listActiveDripCourseEnrollments(env.DB);
    expect(leads.some((l) => l.email === email)).toBe(false);
  });

  it("does NOT touch the subscriber's own real deadline-reminder unsubscribe state", async () => {
    const { email, id } = await newConfirmedFreeSubscriber("route-cross-check", "texas");
    await store.enrollDripCourseLead(env.DB, { email, first_name: null, state_slug: "texas" });
    const dripRow = await env.DB.prepare("SELECT unsubscribe_token FROM drip_course_enrollments WHERE email_normalized = ?1")
      .bind(store.normalizeEmail(email))
      .first<{ unsubscribe_token: string }>();

    await postAction(`/drip-course/unsubscribe?token=${dripRow!.unsubscribe_token}`, "203.0.113.242");

    const subRow = await env.DB.prepare("SELECT status FROM subscribers WHERE id = ?1").bind(id).first<{ status: string }>();
    expect(subRow?.status).toBe("confirmed"); // unaffected by the drip-course unsubscribe
  });

  it("404s on a stale/bogus token", async () => {
    const resp = await postAction("/drip-course/unsubscribe?token=totally-bogus-token", "203.0.113.243");
    expect(resp.status).toBe(404);
  });
});
