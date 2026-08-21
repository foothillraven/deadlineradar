/**
 * Roadmap #26 (2026-08-07): reminder snooze / self-service "remind me
 * again in X days". Fixed 14-day snooze (SNOOZE_DAYS) via the subscriber's
 * existing renewed_token -- see migration 0040's own docstring for why not
 * an arbitrary day-count picker.
 */
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as store from "../src/store";
import { SNOOZE_DAYS } from "../src/emails";
import type { SubscriberRow } from "../src/store";

const BASE = "https://deadline-radar.com";

async function postAction(pathAndQuery: string, ip = "203.0.113.1"): Promise<Response> {
  const u = new URL(`${BASE}${pathAndQuery}`);
  const token = u.searchParams.get("token") ?? "";
  return SELF.fetch(`${BASE}${u.pathname}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": ip },
    body: new URLSearchParams({ token }).toString(),
  });
}

describe("buildReminderEmail() snooze CTA", () => {
  it("includes the snooze CTA on a non-final tier", async () => {
    const { buildReminderEmail } = await import("../src/emails");
    const built = buildReminderEmail(
      "Georgia", "2027-01-01", 30, 30,
      "https://example.com/next", "https://example.com/stop", "https://example.com/unsub",
      "Alex", null, "https://example.com/snooze"
    );
    expect(built.textBody).toContain("https://example.com/snooze");
    expect(built.htmlBody).toContain("https://example.com/snooze");
    expect(built.textBody).toContain(`${SNOOZE_DAYS} days`);
  });

  it("withholds the snooze CTA on the final (1-day) tier", async () => {
    const { buildReminderEmail } = await import("../src/emails");
    const built = buildReminderEmail(
      "Georgia", "2027-01-01", 1, 1,
      "https://example.com/next", "https://example.com/stop", "https://example.com/unsub",
      "Alex", null, "https://example.com/snooze"
    );
    expect(built.textBody).not.toContain("https://example.com/snooze");
    expect(built.htmlBody).not.toContain("https://example.com/snooze");
  });

  it("omits the CTA entirely when no snoozeUrl is given (backward compatible)", async () => {
    const { buildReminderEmail } = await import("../src/emails");
    const built = buildReminderEmail(
      "Georgia", "2027-01-01", 30, 30,
      "https://example.com/next", "https://example.com/stop", "https://example.com/unsub",
      "Alex"
    );
    expect(built.textBody).not.toContain("Remind me again");
  });
});

describe("store.snoozeByToken()", () => {
  it("sets snoozed_until to today + days", async () => {
    const email = `snoozestore-${Date.now()}@example.com`;
    const rec = await store.addPending(env.DB, { email, stateSlug: "texas", deadlineFields: { birth_month: "7" }, firstName: null });
    await store.confirm(env.DB, rec.confirm_token);
    const confirmed = (await store.findActiveOrPending(env.DB, email, "texas"))!;

    const updated = await store.snoozeByToken(env.DB, confirmed.renewed_token, 14);
    expect(updated).not.toBeNull();
    const expected = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
    expect(updated?.snoozed_until).toBe(expected);
  });

  it("returns null for an invalid token", async () => {
    expect(await store.snoozeByToken(env.DB, "not-a-real-token", 14)).toBeNull();
  });

  it("returns null for an unconfirmed subscriber", async () => {
    const email = `snoozeunconfirmed-${Date.now()}@example.com`;
    const rec = await store.addPending(env.DB, { email, stateSlug: "texas", deadlineFields: { birth_month: "7" }, firstName: null });
    expect(await store.snoozeByToken(env.DB, rec.renewed_token, 14)).toBeNull();
  });

  it("returns null for an already-stopped subscriber", async () => {
    const email = `snoozestopped-${Date.now()}@example.com`;
    const rec = await store.addPending(env.DB, { email, stateSlug: "texas", deadlineFields: { birth_month: "7" }, firstName: null });
    await store.confirm(env.DB, rec.confirm_token);
    const confirmed = (await store.findActiveOrPending(env.DB, email, "texas"))!;
    await store.stop(env.DB, confirmed.renewed_token, "renewed");
    expect(await store.snoozeByToken(env.DB, confirmed.renewed_token, 14)).toBeNull();
  });

  // AuditLab SNOOZE-1 (LOW, 2026-08-07): the "no snooze on the final 1-day
  // reminder" rule was previously enforced only by the email template
  // omitting the CTA -- an OLDER 60/30/14-day email's snooze link still
  // worked right up until the real deadline, since every tier's email
  // reuses the same renewed_token. Fixed at the storage layer: refuse
  // regardless of which email's link was used, based on the subscriber's
  // REAL current deadline, not which specific email happened to be clicked.
  it("returns null once the real deadline is 1 day away or less -- even via an old link", async () => {
    const email = `snoozeclose-${Date.now()}@example.com`;
    const rec = await store.addPending(env.DB, { email, stateSlug: "texas", deadlineFields: { birth_month: "7" }, firstName: null });
    await store.confirm(env.DB, rec.confirm_token);
    // "Bring your own date" lets this test control the real deadline
    // directly (real wall-clock tomorrow) rather than depend on where TX's
    // computed birth-month deadline happens to fall relative to whenever
    // this test actually runs.
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    await env.DB.prepare("UPDATE subscribers SET deadline_source = 'user', user_deadline = ?1 WHERE id = ?2")
      .bind(tomorrow, rec.id)
      .run();
    expect(await store.snoozeByToken(env.DB, rec.renewed_token, 14)).toBeNull();
  });

  it("still allows a snooze when the real deadline is comfortably far away", async () => {
    const email = `snoozefar-${Date.now()}@example.com`;
    const rec = await store.addPending(env.DB, { email, stateSlug: "texas", deadlineFields: { birth_month: "7" }, firstName: null });
    await store.confirm(env.DB, rec.confirm_token);
    const farOut = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
    await env.DB.prepare("UPDATE subscribers SET deadline_source = 'user', user_deadline = ?1 WHERE id = ?2")
      .bind(farOut, rec.id)
      .run();
    expect(await store.snoozeByToken(env.DB, rec.renewed_token, 14)).not.toBeNull();
  });

  it("404s over HTTP with the same tailored message when too close to the deadline", async () => {
    const email = `snoozeclosehttp-${Date.now()}@example.com`;
    const rec = await store.addPending(env.DB, { email, stateSlug: "texas", deadlineFields: { birth_month: "7" }, firstName: null });
    await store.confirm(env.DB, rec.confirm_token);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    await env.DB.prepare("UPDATE subscribers SET deadline_source = 'user', user_deadline = ?1 WHERE id = ?2")
      .bind(tomorrow, rec.id)
      .run();
    const resp = await postAction(`/snooze?token=${rec.renewed_token}`, "203.0.113.233");
    expect(resp.status).toBe(404);
    expect(await resp.text()).toContain("too close to the actual deadline");
  });
});

describe("applyRenewAndRearm clears a stale snooze", () => {
  it("renewAndRearmByToken() resets snoozed_until to null", async () => {
    const email = `snoozerearm-${Date.now()}@example.com`;
    const rec = await store.addPending(env.DB, { email, stateSlug: "texas", deadlineFields: { birth_month: "7" }, firstName: null });
    await store.confirm(env.DB, rec.confirm_token);
    const confirmed = (await store.findActiveOrPending(env.DB, email, "texas"))!;
    await store.snoozeByToken(env.DB, confirmed.renewed_token, 14);

    const rearmed = await store.renewAndRearmByToken(env.DB, confirmed.renewed_token);
    expect(rearmed?.snoozed_until).toBeNull();
    const row = await env.DB.prepare("SELECT * FROM subscribers WHERE id = ?1").bind(rec.id).first<SubscriberRow>();
    expect(row?.snoozed_until).toBeNull();
  });
});

// SNOOZE-1 (AuditLab, 2026-08-21, orchestrator-approved, MEDIUM): the
// sibling path -- rearm() had the same cycle-bumping shape as
// applyRenewAndRearm above (status/stopped_at/stop_reason/reminders_sent/
// cycle/token-rotation) but omitted the one line clearing snoozed_until,
// so the exact first-party-UI sequence a real subscriber can trigger
// (snooze a reminder, click "I've renewed" -- which does not touch
// snoozed_until -- then realize it was premature and click re-arm)
// silently suppressed the new cycle's reminders for up to SNOOZE_DAYS
// while handleRearm()'s own copy told them the opposite ("We'll remind
// you again as your next deadline approaches").
describe("rearm clears a stale snooze (SNOOZE-1)", () => {
  it("snooze -> stop('renewed') -> rearm resets snoozed_until to null, not just the fields rearm already touched", async () => {
    const email = `snoozestoprearm-${Date.now()}@example.com`;
    const rec = await store.addPending(env.DB, { email, stateSlug: "texas", deadlineFields: { birth_month: "7" }, firstName: null });
    await store.confirm(env.DB, rec.confirm_token);
    const confirmed = (await store.findActiveOrPending(env.DB, email, "texas"))!;

    await store.snoozeByToken(env.DB, confirmed.renewed_token, 14);
    const snoozed = await env.DB.prepare("SELECT * FROM subscribers WHERE id = ?1").bind(rec.id).first<SubscriberRow>();
    expect(snoozed?.snoozed_until).not.toBeNull(); // sanity: the snooze actually landed

    const stopped = await store.stop(env.DB, confirmed.unsubscribe_token, "renewed");
    expect(stopped?.status).toBe(store.STATUS_STOPPED);
    const afterStop = await env.DB.prepare("SELECT * FROM subscribers WHERE id = ?1").bind(rec.id).first<SubscriberRow>();
    expect(afterStop?.snoozed_until).not.toBeNull(); // stop() correctly doesn't touch it -- this is the pre-existing state the bug depends on

    const rearmed = await store.rearm(env.DB, stopped!.unsubscribe_token);
    expect(rearmed?.status).toBe(store.STATUS_CONFIRMED);
    expect(rearmed?.snoozed_until).toBeNull();
    const row = await env.DB.prepare("SELECT * FROM subscribers WHERE id = ?1").bind(rec.id).first<SubscriberRow>();
    expect(row?.snoozed_until).toBeNull();
  });
});

describe("GET/POST /snooze -- end-to-end via the real cron pass", () => {
  it("the actual scheduler-built reminder email contains the snooze link, and clicking it stops sends until it expires", async () => {
    const { runReminderPass } = await import("../src/scheduler");
    const email = `snoozecta-${Date.now()}@example.com`;
    const rec = await store.addPending(env.DB, { email, stateSlug: "texas", deadlineFields: { birth_month: "7" }, firstName: "Tester" });
    await store.confirm(env.DB, rec.confirm_token);

    // Deadline is July 31 (TX, birth_month=7). Snoozing at the 30-day tier
    // (not a tighter one) leaves enough pre-deadline runway to verify
    // "resumes after the snooze expires" without also wandering into
    // grace-period territory -- a real constraint this test hit and fixed:
    // snoozing at the 7-day tier and checking 15 days later lands PAST the
    // deadline by then, a different code path than what this test means to
    // cover.
    let capturedHtml = "";
    await runReminderPass(env, {
      asOf: new Date(Date.UTC(2026, 6, 1)), // 30 days out -> tier 30
      send: async (to, built) => {
        if (to === email) capturedHtml = built.htmlBody;
        return true;
      },
    });
    expect(capturedHtml).toMatch(/\/api\/snooze\?token=/);

    const match = /snooze\?token=([^"&\s]+)/.exec(capturedHtml);
    const token = decodeURIComponent(match![1] as string);

    const resp = await postAction(`/snooze?token=${encodeURIComponent(token)}`, "203.0.113.230");
    expect(resp.status).toBe(200);
    expect((await resp.text()).toLowerCase()).toContain("paused");

    // A second pass the same day must NOT send -- the subscriber is snoozed.
    let sentAgain = false;
    const summary = await runReminderPass(env, {
      asOf: new Date(Date.UTC(2026, 6, 1)),
      send: async (to) => {
        if (to === email) sentAgain = true;
        return true;
      },
    });
    expect(sentAgain).toBe(false);
    expect(summary.skipped_snoozed).toBeGreaterThan(0);

    // store.snoozeByToken() correctly anchors to the REAL wall clock
    // (Date.now()) -- right for an actual user click, but that means the
    // POST above set snoozed_until relative to whatever today really is,
    // not to this test's simulated July-2026 calendar. Simulating "16
    // simulated days later, still real-world before that real snooze
    // date" would test nothing meaningful; instead, directly back-date the
    // stored value to simulate "the snooze has already expired" on the
    // scheduler's own simulated timeline, then confirm it reads/respects
    // that correctly.
    await env.DB.prepare("UPDATE subscribers SET snoozed_until = ?1 WHERE id = ?2")
      .bind("2026-07-01", rec.id)
      .run();
    let sentAfterExpiry = false;
    await runReminderPass(env, {
      asOf: new Date(Date.UTC(2026, 6, 1 + 16)), // 14 days remaining -> tier 14
      send: async (to) => {
        if (to === email) sentAfterExpiry = true;
        return true;
      },
    });
    expect(sentAfterExpiry).toBe(true);
  });

  it("GET /api/snooze renders a confirm page WITHOUT changing state (prefetch-safe)", async () => {
    const email = `snoozerender-${Date.now()}@example.com`;
    const rec = await store.addPending(env.DB, { email, stateSlug: "texas", deadlineFields: { birth_month: "7" }, firstName: null });
    await store.confirm(env.DB, rec.confirm_token);
    const confirmed = (await store.findActiveOrPending(env.DB, email, "texas"))!;

    const getResp = await SELF.fetch(`${BASE}/api/snooze?token=${confirmed.renewed_token}`, {
      headers: { "cf-connecting-ip": "203.0.113.231" },
    });
    expect(getResp.status).toBe(200);
    expect(await getResp.text()).toContain(`Remind me again in ${SNOOZE_DAYS} days`);

    const row = await env.DB.prepare("SELECT * FROM subscribers WHERE id = ?1").bind(rec.id).first<SubscriberRow>();
    expect(row?.snoozed_until).toBeNull();
  });

  it("404s on a stale/reused token", async () => {
    const resp = await postAction("/snooze?token=totally-bogus-token", "203.0.113.232");
    expect(resp.status).toBe(404);
  });
});
