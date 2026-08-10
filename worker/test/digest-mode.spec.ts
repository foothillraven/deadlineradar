/**
 * Roadmap #24 (2026-08-08): digest email option (weekly summary vs.
 * per-deadline pings). A per-subscriber delivery-cadence preference, same
 * axis reminder_thresholds already lives on (see
 * subscriber-reminder-cadence.spec.ts, which this file mirrors the
 * structure of) -- digest mode changes WHEN a claimed threshold's email
 * goes out (batched vs. immediate), never the escalation/claim machinery
 * itself.
 */
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as store from "../src/store";

const BASE = "https://deadline-radar.com";
const MS_PER_DAY = 86_400_000;

async function seedUserDate(
  email: string,
  stateSlug: string,
  userDeadline: string,
  firmId: string | null = null
) {
  return store.addPending(env.DB, {
    email,
    stateSlug,
    deadlineFields: {},
    deadlineSource: store.DEADLINE_SOURCE_USER,
    userDeadline,
    firstName: null,
    firmId,
    skipConfirmation: true,
  });
}

async function subscriberCookie(email: string): Promise<string> {
  const { rawSessionToken } = await store.createSubscriberSession(env.DB, store.normalizeEmail(email));
  return `dr_sub_session=${rawSessionToken}`;
}

async function patchMode(cookie: string | null, mode: string | null): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers["Cookie"] = cookie;
  return SELF.fetch(`${BASE}/subscriber/notification-mode`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ mode }),
  });
}

function isoDaysFromUtcMidnight(base: Date, days: number): string {
  return new Date(base.getTime() + days * MS_PER_DAY).toISOString().slice(0, 10);
}

// runDigestPass()/runReminderPass() evaluate EVERY confirmed subscriber in
// the table, not just one test's own rows -- so two tests sharing the same
// `asOf` (and therefore the same computed due date) can sweep each other's
// leftover rows into the same pass. Each runDigestPass test below gets its
// own `asOf` far enough apart (1000+ days) that no other test's due date can
// ever land on the same calendar day, both within one run and across
// repeated runs (RUN_BASE_MS varies with real wall-clock time).
const RUN_BASE_MS = Date.now();
function freshAsOf(saltDays: number): Date {
  const d = new Date(RUN_BASE_MS + saltDays * MS_PER_DAY);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// ---------------------------------------------------------------------------
// store.ts
// ---------------------------------------------------------------------------

describe("store.setSubscriberNotificationMode / listDigestEligibleEmails / advanceDigestWindow", () => {
  it("setSubscriberNotificationMode writes across every row sharing the email, and only that email", async () => {
    const mine = `digeststore-mine-${Date.now()}@example.com`;
    const theirs = `digeststore-theirs-${Date.now()}@example.com`;
    await seedUserDate(mine, "ohio", "2027-01-01");
    await seedUserDate(mine, "texas", "2027-02-01");
    await seedUserDate(theirs, "ohio", "2027-01-01");

    const changed = await store.setSubscriberNotificationMode(env.DB, store.normalizeEmail(mine), store.NOTIFICATION_MODE_DIGEST);
    expect(changed).toBe(2);

    for (const row of await store.listSubscriberLicenses(env.DB, mine)) {
      expect(row.notification_mode).toBe(store.NOTIFICATION_MODE_DIGEST);
    }
    const theirRow = (await store.listSubscriberLicenses(env.DB, theirs))[0];
    expect(theirRow?.notification_mode).toBe(store.NOTIFICATION_MODE_IMMEDIATE);
  });

  it("listDigestEligibleEmails: every confirmed digest-mode email, regardless of window state (AuditLab DIGEST-1)", async () => {
    const today = new Date(Date.UTC(2027, 0, 15));

    const neverSent = `digestelig-never-${Date.now()}@example.com`;
    const windowOpen = `digestelig-open-${Date.now()}@example.com`;
    const windowFuture = `digestelig-future-${Date.now()}@example.com`;
    const immediateMode = `digestelig-immediate-${Date.now()}@example.com`;

    await seedUserDate(neverSent, "ohio", "2027-06-01");
    await seedUserDate(windowOpen, "ohio", "2027-06-01");
    await seedUserDate(windowFuture, "ohio", "2027-06-01");
    await seedUserDate(immediateMode, "ohio", "2027-06-01");

    await store.setSubscriberNotificationMode(env.DB, store.normalizeEmail(neverSent), store.NOTIFICATION_MODE_DIGEST);
    await store.setSubscriberNotificationMode(env.DB, store.normalizeEmail(windowOpen), store.NOTIFICATION_MODE_DIGEST);
    await store.setSubscriberNotificationMode(env.DB, store.normalizeEmail(windowFuture), store.NOTIFICATION_MODE_DIGEST);
    // immediateMode stays at the default -- never opted into digest.

    await store.advanceDigestWindow(env.DB, store.normalizeEmail(windowOpen), isoDaysFromUtcMidnight(today, -1));
    // Deliberately in the FUTURE -- this must still come back. The window
    // no longer gates membership; runDigestPass() itself decides whether
    // an item can bypass a still-closed window for urgency.
    await store.advanceDigestWindow(env.DB, store.normalizeEmail(windowFuture), isoDaysFromUtcMidnight(today, 3));

    const eligible = await store.listDigestEligibleEmails(env.DB, 200);
    expect(eligible).toContain(store.normalizeEmail(neverSent));
    expect(eligible).toContain(store.normalizeEmail(windowOpen));
    expect(eligible).toContain(store.normalizeEmail(windowFuture));
    expect(eligible).not.toContain(store.normalizeEmail(immediateMode));
  });

  it("advanceDigestWindow writes across every row sharing the email", async () => {
    const email = `digestadvance-${Date.now()}@example.com`;
    await seedUserDate(email, "ohio", "2027-01-01");
    await seedUserDate(email, "texas", "2027-02-01");
    await store.advanceDigestWindow(env.DB, store.normalizeEmail(email), "2027-03-01");
    for (const row of await store.listSubscriberLicenses(env.DB, email)) {
      expect(row.digest_next_send_at).toBe("2027-03-01");
    }
  });
});

// ---------------------------------------------------------------------------
// PATCH /subscriber/notification-mode
// ---------------------------------------------------------------------------

describe("PATCH /subscriber/notification-mode", () => {
  it("401s with no session", async () => {
    expect((await patchMode(null, "digest")).status).toBe(401);
  });

  it("sets digest mode across every row sharing this email, and back to immediate", async () => {
    const email = `digestpatch-${Date.now()}@example.com`;
    await seedUserDate(email, "ohio", "2027-01-01");
    await seedUserDate(email, "texas", "2027-02-01");
    const cookie = await subscriberCookie(email);

    const setResp = await patchMode(cookie, "digest");
    expect(setResp.status).toBe(200);
    const setBody = (await setResp.json()) as { notification_mode: string };
    expect(setBody.notification_mode).toBe("digest");
    for (const row of await store.listSubscriberLicenses(env.DB, email)) {
      expect(row.notification_mode).toBe("digest");
    }

    const clearResp = await patchMode(cookie, "immediate");
    expect(clearResp.status).toBe(200);
    for (const row of await store.listSubscriberLicenses(env.DB, email)) {
      expect(row.notification_mode).toBe("immediate");
    }
  });

  it("rejects an invalid mode value", async () => {
    const email = `digestpatch-bad-${Date.now()}@example.com`;
    await seedUserDate(email, "ohio", "2027-01-01");
    const cookie = await subscriberCookie(email);
    expect((await patchMode(cookie, "weekly"))).toMatchObject({ status: 400 });
    expect((await patchMode(cookie, null))).toMatchObject({ status: 400 });
  });

  it("never touches another subscriber's rows", async () => {
    const mine = `digestpatch-mine-${Date.now()}@example.com`;
    const theirs = `digestpatch-theirs-${Date.now()}@example.com`;
    await seedUserDate(mine, "ohio", "2027-01-01");
    await seedUserDate(theirs, "texas", "2027-02-01");

    await patchMode(await subscriberCookie(mine), "digest");

    const theirRow = (await store.listSubscriberLicenses(env.DB, theirs))[0];
    expect(theirRow?.notification_mode).toBe("immediate");
  });
});

// ---------------------------------------------------------------------------
// scheduler.ts runDigestPass / runReminderPass exclusion
// ---------------------------------------------------------------------------

describe("runDigestPass", () => {
  it("bundles every currently-due item across a person's rows into ONE email, and advances the window", async () => {
    const { runDigestPass } = await import("../src/scheduler");
    const asOf = freshAsOf(1000);
    const email = `digeste2e-bundle-${Date.now()}@example.com`;
    // Both due exactly 30 days out from asOf -- same threshold, two states.
    const due = isoDaysFromUtcMidnight(asOf, 30);
    await seedUserDate(email, "ohio", due);
    await seedUserDate(email, "texas", due);
    await store.setSubscriberNotificationMode(env.DB, store.normalizeEmail(email), store.NOTIFICATION_MODE_DIGEST);

    const target = store.normalizeEmail(email);
    const sentTo: string[] = [];
    let targetBody = "";
    await runDigestPass(env, {
      asOf,
      send: async (toEmail, built) => {
        sentTo.push(toEmail);
        if (toEmail === target) targetBody = built.textBody;
        return true;
      },
    });

    // Sent exactly once to this email (not once per row).
    expect(sentTo.filter((e) => e === target).length).toBe(1);
    // Both state names appear in that ONE bundled email.
    expect((targetBody.match(/Ohio|Texas/g) || []).length).toBe(2);

    for (const row of await store.listSubscriberLicenses(env.DB, email)) {
      expect(JSON.parse(row.reminders_sent)).toContain(30);
      expect(row.digest_next_send_at).toBe(isoDaysFromUtcMidnight(asOf, 7));
    }
  });

  it("AuditLab LINK-1 (2026-08-10): the manage-notifications link is an absolute URL even with STATIC_SITE_BASE_URL unset (real production shape)", async () => {
    const { runDigestPass } = await import("../src/scheduler");
    const asOf = freshAsOf(1500);
    const email = `digeste2e-link1-absolute-${Date.now()}@example.com`;
    await seedUserDate(email, "ohio", isoDaysFromUtcMidnight(asOf, 30));
    await store.setSubscriberNotificationMode(env.DB, store.normalizeEmail(email), store.NOTIFICATION_MODE_DIGEST);

    const target = store.normalizeEmail(email);
    let targetHtml = "";
    await runDigestPass(env, {
      asOf,
      send: async (toEmail, built) => {
        if (toEmail === target) targetHtml = built.htmlBody;
        return true;
      },
    });

    expect(targetHtml).not.toBe("");
    const hrefs = [...targetHtml.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      expect(href).toMatch(/^https:\/\//);
    }
  });

  it("a digest subscriber with nothing due yet gets nothing, and digest_next_send_at stays untouched", async () => {
    const { runDigestPass } = await import("../src/scheduler");
    const asOf = freshAsOf(2000);
    const email = `digeste2e-quiet-${Date.now()}@example.com`;
    // 90 days out -- outside every fixed threshold, nothing due.
    await seedUserDate(email, "ohio", isoDaysFromUtcMidnight(asOf, 90));
    await store.setSubscriberNotificationMode(env.DB, store.normalizeEmail(email), store.NOTIFICATION_MODE_DIGEST);

    const target = store.normalizeEmail(email);
    const sentTo: string[] = [];
    await runDigestPass(env, { asOf, send: async (toEmail) => { sentTo.push(toEmail); return true; } });

    expect(sentTo).not.toContain(target);
    const row = (await store.listSubscriberLicenses(env.DB, email))[0];
    expect(row?.digest_next_send_at).toBeNull();
  });

  it("a due item arriving mid-window waits, unclaimed, and bundles into the NEXT digest once the window reopens", async () => {
    const { runDigestPass } = await import("../src/scheduler");
    const asOf = freshAsOf(3000);
    const email = `digeste2e-wait-${Date.now()}@example.com`;
    const due = isoDaysFromUtcMidnight(asOf, 30);
    await seedUserDate(email, "ohio", due);
    await store.setSubscriberNotificationMode(env.DB, store.normalizeEmail(email), store.NOTIFICATION_MODE_DIGEST);
    // Window doesn't reopen for 3 more days -- today's due item must wait.
    await store.advanceDigestWindow(env.DB, store.normalizeEmail(email), isoDaysFromUtcMidnight(asOf, 3));

    const target = store.normalizeEmail(email);
    const firstSentTo: string[] = [];
    await runDigestPass(env, { asOf, send: async (toEmail) => { firstSentTo.push(toEmail); return true; } });
    expect(firstSentTo).not.toContain(target);
    let row = (await store.listSubscriberLicenses(env.DB, email))[0];
    expect(row?.reminders_sent).toBe("[]"); // not claimed -- still pending

    // Window reopens.
    const laterAsOf = new Date(asOf.getTime() + 3 * MS_PER_DAY);
    let targetBody = "";
    await runDigestPass(env, {
      asOf: laterAsOf,
      send: async (toEmail, built) => {
        if (toEmail === target) targetBody = built.textBody;
        return true;
      },
    });
    expect(targetBody).toContain("Ohio");
    row = (await store.listSubscriberLicenses(env.DB, email))[0];
    expect(JSON.parse(row!.reminders_sent)).toContain(30);
  });

  it("AuditLab DIGEST-1: an URGENT threshold arriving mid-window is not delayed past its own deadline", async () => {
    const { runDigestPass } = await import("../src/scheduler");
    const asOf = freshAsOf(3500);
    const email = `digest-urgent-${Date.now()}@example.com`;
    // Deadline TOMORROW -- the 1-day threshold is the most urgent tier.
    await seedUserDate(email, "ohio", isoDaysFromUtcMidnight(asOf, 1));
    await store.setSubscriberNotificationMode(env.DB, store.normalizeEmail(email), store.NOTIFICATION_MODE_DIGEST);
    // Window doesn't reopen for 6 more days -- if the window still gated
    // eligibility, this item would wait until after its own deadline.
    await store.advanceDigestWindow(env.DB, store.normalizeEmail(email), isoDaysFromUtcMidnight(asOf, 6));

    const target = store.normalizeEmail(email);
    const sentTo: string[] = [];
    await runDigestPass(env, { asOf, send: async (toEmail) => { sentTo.push(toEmail); return true; } });
    expect(sentTo).toContain(target);
    const row = (await store.listSubscriberLicenses(env.DB, email))[0];
    expect(JSON.parse(row!.reminders_sent)).toContain(1);
  });

  it("a non-urgent (7-day) threshold still waits for a closed window, even though the query now returns the email", async () => {
    const { runDigestPass } = await import("../src/scheduler");
    const asOf = freshAsOf(3600);
    const email = `digest-nonurgent-${Date.now()}@example.com`;
    await seedUserDate(email, "ohio", isoDaysFromUtcMidnight(asOf, 7));
    await store.setSubscriberNotificationMode(env.DB, store.normalizeEmail(email), store.NOTIFICATION_MODE_DIGEST);
    await store.advanceDigestWindow(env.DB, store.normalizeEmail(email), isoDaysFromUtcMidnight(asOf, 6));

    const target = store.normalizeEmail(email);
    const sentTo: string[] = [];
    await runDigestPass(env, { asOf, send: async (toEmail) => { sentTo.push(toEmail); return true; } });
    expect(sentTo).not.toContain(target);
    const row = (await store.listSubscriberLicenses(env.DB, email))[0];
    expect(row?.reminders_sent).toBe("[]"); // released, not stranded claimed-but-unsent
  });

  it("a non-digest subscriber is unaffected by runDigestPass and still handled by runReminderPass", async () => {
    const { runDigestPass, runReminderPass } = await import("../src/scheduler");
    const asOf = freshAsOf(4000);
    const email = `digeste2e-immediate-${Date.now()}@example.com`;
    const due = isoDaysFromUtcMidnight(asOf, 30);
    await seedUserDate(email, "ohio", due); // notification_mode stays 'immediate' (default)

    const target = store.normalizeEmail(email);
    const digestSentTo: string[] = [];
    await runDigestPass(env, { asOf, send: async (toEmail) => { digestSentTo.push(toEmail); return true; } });
    expect(digestSentTo).not.toContain(target);

    const immediateSentTo: string[] = [];
    await runReminderPass(env, { asOf, send: async (toEmail) => { immediateSentTo.push(toEmail); return true; } });
    expect(immediateSentTo).toContain(target);
  });

  it("a digest-mode subscriber is skipped entirely by runReminderPass", async () => {
    const { runReminderPass } = await import("../src/scheduler");
    const asOf = freshAsOf(5000);
    const email = `digeste2e-excluded-${Date.now()}@example.com`;
    const due = isoDaysFromUtcMidnight(asOf, 30);
    await seedUserDate(email, "ohio", due);
    await store.setSubscriberNotificationMode(env.DB, store.normalizeEmail(email), store.NOTIFICATION_MODE_DIGEST);

    const target = store.normalizeEmail(email);
    const sentTo: string[] = [];
    await runReminderPass(env, { asOf, send: async (toEmail) => { sentTo.push(toEmail); return true; } });
    expect(sentTo).not.toContain(target);
    const row = (await store.listSubscriberLicenses(env.DB, email))[0];
    expect(row?.reminders_sent).toBe("[]"); // untouched -- runDigestPass owns this row
  });

  it("skips a demo-locked firm's roster without claiming or sending", async () => {
    const { runDigestPass } = await import("../src/scheduler");
    const asOf = freshAsOf(6000);
    const { id: firmId } = await store.createFirm(env.DB, {
      name: "Digest Demo Firm",
      adminEmail: `digestdemo-${Date.now()}@example.com`,
    });
    await env.DB.prepare(`UPDATE firms SET demo_locked = 1 WHERE id = ?1`).bind(firmId).run();
    const email = `digestdemo-target-${Date.now()}@stranger.example.com`;
    const due = isoDaysFromUtcMidnight(asOf, 30);
    await seedUserDate(email, "ohio", due, firmId);
    await store.setSubscriberNotificationMode(env.DB, store.normalizeEmail(email), store.NOTIFICATION_MODE_DIGEST);

    const target = store.normalizeEmail(email);
    const sentTo: string[] = [];
    await runDigestPass(env, { asOf, send: async (toEmail) => { sentTo.push(toEmail); return true; } });
    expect(sentTo).not.toContain(target);
    const row = (await store.listSubscriberLicenses(env.DB, email))[0];
    expect(row?.reminders_sent).toBe("[]");
  });

  it("a threshold already claimed by a concurrent pass is excluded from the digest", async () => {
    const { runDigestPass } = await import("../src/scheduler");
    const asOf = freshAsOf(7000);
    const email = `digeste2e-race-${Date.now()}@example.com`;
    const due = isoDaysFromUtcMidnight(asOf, 30);
    const row = await seedUserDate(email, "ohio", due);
    await store.setSubscriberNotificationMode(env.DB, store.normalizeEmail(email), store.NOTIFICATION_MODE_DIGEST);

    // Simulate another overlapping pass winning the claim first.
    const claimed = await store.claimReminderThreshold(env.DB, row.id, "[]", 30);
    expect(claimed).toBe(true);

    const target = store.normalizeEmail(email);
    const sentTo: string[] = [];
    await runDigestPass(env, { asOf, send: async (toEmail) => { sentTo.push(toEmail); return true; } });
    expect(sentTo).not.toContain(target);
  });

  it("the daily send cap halts the pass without erroring, and unclaims what it took", async () => {
    const { runDigestPass } = await import("../src/scheduler");
    const { checkAndCountDigestSend } = await import("../src/sender");
    const asOf = freshAsOf(8000);
    await checkAndCountDigestSend(env.DB, 1); // consumes the only slot for today

    const email = `digeste2e-cap-${Date.now()}@example.com`;
    const due = isoDaysFromUtcMidnight(asOf, 30);
    await seedUserDate(email, "ohio", due);
    await store.setSubscriberNotificationMode(env.DB, store.normalizeEmail(email), store.NOTIFICATION_MODE_DIGEST);

    const target = store.normalizeEmail(email);
    const sentTo: string[] = [];
    const summary = await runDigestPass(
      { ...env, DIGEST_DAILY_SEND_CAP: "1" },
      { asOf, send: async (toEmail) => { sentTo.push(toEmail); return true; } }
    );
    expect(sentTo).not.toContain(target);
    expect(summary.errors.some((e) => e.error.includes("daily send cap"))).toBe(true);

    const row = (await store.listSubscriberLicenses(env.DB, email))[0];
    expect(row?.reminders_sent).toBe("[]"); // claim was reverted, not left dangling
  });
});
