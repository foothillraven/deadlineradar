/**
 * Roadmap #124 (2026-08-13, Devin: "Good to build 2"): compliance-news
 * newsletter, a NEW public opt-in list. Same test shape as
 * rule-change-alerts.spec.ts/drip-course.spec.ts for the cron pass (env,
 * SELF from cloudflare:test; runComplianceNewsletterPass with an injected
 * send()), plus a route-level describe block matching worker.spec.ts's own
 * "POST /subscribe" / "GET /api/confirm" conventions for the HTTP surface.
 */
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as store from "../src/store";
import { runComplianceNewsletterPass } from "../src/scheduler";
import { buildNewsletterDigestEmail } from "../src/emails";

function form(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

async function postNewsletterSubscribe(email: string, ip: string): Promise<Response> {
  return SELF.fetch("https://deadline-radar.com/newsletter/subscribe", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": ip },
    body: form({ email, hp_website: "" }),
  });
}

interface NewsletterRow {
  id: string;
  email: string;
  status: string;
  confirm_token: string;
  unsubscribe_token: string;
}

describe("POST /newsletter/subscribe -- happy path", () => {
  it("stores a pending_confirmation row and returns the check-your-email success page", async () => {
    const email = `newsletter-happy-${Date.now()}@example.com`;
    const resp = await postNewsletterSubscribe(email, "203.0.113.201");
    expect(resp.status).toBe(200);
    const body = await resp.text();
    expect(body.toLowerCase()).toContain("check your email");

    const row = await env.DB.prepare("SELECT * FROM newsletter_subscribers WHERE email = ?1")
      .bind(email)
      .first<NewsletterRow>();
    expect(row).not.toBeNull();
    expect(row?.status).toBe("pending_confirmation");
    expect(row?.confirm_token).toBeTruthy();
    expect(row?.unsubscribe_token).toBeTruthy();
  });

  it("rejects an invalid email", async () => {
    const resp = await postNewsletterSubscribe("not-an-email", "203.0.113.202");
    expect(resp.status).toBe(400);
  });

  it("silently no-ops when the honeypot field is non-empty (same success page a real signup gets)", async () => {
    const email = `newsletter-honeypot-${Date.now()}@example.com`;
    const resp = await SELF.fetch("https://deadline-radar.com/newsletter/subscribe", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.203" },
      body: form({ email, hp_website: "definitely-a-bot" }),
    });
    expect(resp.status).toBe(200);
    const row = await env.DB.prepare("SELECT * FROM newsletter_subscribers WHERE email = ?1").bind(email).first();
    expect(row).toBeNull();
  });

  it("a duplicate signup for an already-pending email returns the identical response, no second row (no-enumeration-oracle)", async () => {
    const email = `newsletter-dupe-${Date.now()}@example.com`;
    await postNewsletterSubscribe(email, "203.0.113.204");
    const secondResp = await postNewsletterSubscribe(email, "203.0.113.205");
    expect(secondResp.status).toBe(200);
    const rows = await env.DB.prepare("SELECT * FROM newsletter_subscribers WHERE email = ?1").bind(email).all();
    expect(rows.results.length).toBe(1);
  });
});

describe("GET/POST /api/newsletter/confirm -- prefetch-safe double opt-in", () => {
  it("GET renders a page WITHOUT changing state; POST actually confirms", async () => {
    const email = `newsletter-confirm-${Date.now()}@example.com`;
    await postNewsletterSubscribe(email, "203.0.113.206");
    const row = await env.DB.prepare("SELECT * FROM newsletter_subscribers WHERE email = ?1")
      .bind(email)
      .first<NewsletterRow>();

    const getResp = await SELF.fetch(`https://deadline-radar.com/api/newsletter/confirm?token=${row?.confirm_token}`, {
      headers: { "cf-connecting-ip": "203.0.113.207" },
    });
    expect(getResp.status).toBe(200);
    expect(await getResp.text()).toContain("Confirm my email");
    const afterGet = await env.DB.prepare("SELECT * FROM newsletter_subscribers WHERE id = ?1").bind(row?.id).first<NewsletterRow>();
    expect(afterGet?.status).toBe("pending_confirmation");

    const postResp = await SELF.fetch("https://deadline-radar.com/api/newsletter/confirm", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.207" },
      body: form({ token: row?.confirm_token ?? "" }),
    });
    expect(postResp.status).toBe(200);
    const afterPost = await env.DB.prepare("SELECT * FROM newsletter_subscribers WHERE id = ?1").bind(row?.id).first<NewsletterRow>();
    expect(afterPost?.status).toBe("confirmed");
  });

  it("an invalid token returns 404, not a crash", async () => {
    const resp = await SELF.fetch("https://deadline-radar.com/api/newsletter/confirm", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.208" },
      body: form({ token: "not-a-real-token" }),
    });
    expect(resp.status).toBe(404);
  });
});

describe("GET/POST /api/newsletter/unsubscribe -- one-click, idempotent", () => {
  it("unsubscribes a confirmed subscriber, and a repeat visit doesn't error", async () => {
    const email = `newsletter-unsub-${Date.now()}@example.com`;
    await postNewsletterSubscribe(email, "203.0.113.209");
    const row = await env.DB.prepare("SELECT * FROM newsletter_subscribers WHERE email = ?1")
      .bind(email)
      .first<NewsletterRow>();
    await store.confirmNewsletterSubscriberIfPending(env.DB, row!.confirm_token);

    const postResp = await SELF.fetch("https://deadline-radar.com/api/newsletter/unsubscribe", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.210" },
      body: form({ token: row!.unsubscribe_token }),
    });
    expect(postResp.status).toBe(200);
    const afterFirst = await env.DB.prepare("SELECT * FROM newsletter_subscribers WHERE id = ?1").bind(row?.id).first<NewsletterRow>();
    expect(afterFirst?.status).toBe("unsubscribed");

    // RFC 8058 one-click POST shape -- token in the query, body is the
    // fixed "List-Unsubscribe=One-Click" string, same as a mail client's
    // real one-click unsubscribe request.
    const secondResp = await SELF.fetch(
      `https://deadline-radar.com/api/newsletter/unsubscribe?token=${row!.unsubscribe_token}`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.210" },
        body: "List-Unsubscribe=One-Click",
      }
    );
    expect(secondResp.status).toBe(200);
  });
});

describe("buildNewsletterDigestEmail() -- refuses to build empty content", () => {
  it("throws when given zero items, never sends a filler issue", () => {
    expect(() => buildNewsletterDigestEmail([], "https://deadline-radar.com/api/newsletter/unsubscribe?token=x")).toThrow();
  });

  it("renders real content, dark-mode-safe link classes, and a working List-Unsubscribe header for a non-empty digest", () => {
    const built = buildNewsletterDigestEmail(
      [
        {
          jurisdiction: "Colorado",
          topic: "practice privilege (mobility)",
          summary: "Test summary of a real, sourced change.",
          effectiveDate: "2026-08-01",
          citation: "Colo. Rev. Stat. 12-100-000",
          citationUrl: "https://example.gov/statute",
          detailUrl: "https://deadline-radar.com/rule-changes/",
        },
      ],
      "https://deadline-radar.com/api/newsletter/unsubscribe?token=abc"
    );
    expect(built.htmlBody).toContain("Colorado");
    expect(built.htmlBody).toContain("dr-accent");
    expect(built.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(built.headers["List-Unsubscribe"]).toContain("/api/newsletter/unsubscribe?token=abc");
  });
});

// newsletter_digest_state is a SINGLETON row (id=1) -- every test below that
// depends on its exact value seeds it explicitly first rather than assuming
// a fresh/untouched table, since other tests in this same file (and this
// same describe block) share the one row.
async function seedDigestState(lastSentDaysAgo: number | null, includedEventIds: string[] = []): Promise<void> {
  const lastSentAt = lastSentDaysAgo === null ? null : new Date(Date.now() - lastSentDaysAgo * 86_400_000).toISOString();
  await env.DB.prepare(
    `INSERT INTO newsletter_digest_state (id, last_sent_at, last_included_event_ids) VALUES (1, ?1, ?2)
     ON CONFLICT(id) DO UPDATE SET last_sent_at = ?1, last_included_event_ids = ?2`
  )
    .bind(lastSentAt, JSON.stringify(includedEventIds))
    .run();
}

describe("runComplianceNewsletterPass() -- cadence + content-safety gating", () => {
  it("skips (not due) when the digest was sent recently", async () => {
    await seedDigestState(1); // sent 1 day ago, well under the 27-day interval
    const summary = await runComplianceNewsletterPass(env, { send: async () => true });
    expect(summary.dueForSend).toBe(false);
    expect(summary.sent).toBe(0);
  });

  // SEND-1 (AuditLab, 2026-08-20): the throttle's ordering guard used to
  // fail OPEN on an unparseable last_sent_at (`NaN < 27` is false, so the
  // skip is never taken) -- the opposite of every sibling date guard in
  // this codebase, and the failure mode is outbound mail to every
  // subscriber. Positive control: seed a genuinely unparseable value
  // directly (bypassing seedDigestState()'s always-valid ISO computation)
  // and assert the pass HOLDS rather than sends.
  it("holds (does not send) rather than fail open when last_sent_at is unparseable", async () => {
    await env.DB.prepare(
      `INSERT INTO newsletter_digest_state (id, last_sent_at, last_included_event_ids) VALUES (1, ?1, ?2)
       ON CONFLICT(id) DO UPDATE SET last_sent_at = ?1, last_included_event_ids = ?2`
    )
      .bind("not-a-real-timestamp", JSON.stringify([]))
      .run();
    const summary = await runComplianceNewsletterPass(env, { send: async () => true });
    expect(summary.dueForSend).toBe(false);
    expect(summary.sent).toBe(0);
    expect(summary.skippedReason).toMatch(/unparseable/);
  });

  it("is due but sends nothing when there are no new emailable events (never manufactures filler)", async () => {
    // Every real event already "included" forces the candidate pool to
    // empty without needing to fabricate a scenario with zero real events.
    const allEventIds = (await import("../src/reg_change_events.json")).default.events.map(
      (e: { event_id: string }) => e.event_id
    );
    await seedDigestState(40, allEventIds); // due (>27d), but every real event already "sent"

    const summary = await runComplianceNewsletterPass(env, { send: async () => true });
    expect(summary.dueForSend).toBe(true);
    expect(summary.sent).toBe(0);
    expect(summary.skippedReason).toMatch(/no new emailable events/);
  });

  it("sends the real digest to confirmed subscribers only, and records the sent event ids", async () => {
    const confirmedEmail = `newsletter-pass-confirmed-${Date.now()}@example.com`;
    const pendingEmail = `newsletter-pass-pending-${Date.now()}@example.com`;
    await postNewsletterSubscribe(confirmedEmail, "203.0.113.211");
    await postNewsletterSubscribe(pendingEmail, "203.0.113.212");
    const confirmedRow = await env.DB.prepare("SELECT * FROM newsletter_subscribers WHERE email = ?1")
      .bind(confirmedEmail)
      .first<NewsletterRow>();
    await store.confirmNewsletterSubscriberIfPending(env.DB, confirmedRow!.confirm_token);
    await seedDigestState(40, []); // due (>27d), no events excluded yet

    const sentTo: string[] = [];
    const summary = await runComplianceNewsletterPass(env, {
      send: async (to) => {
        sentTo.push(to);
        return true;
      },
    });
    expect(summary.dueForSend).toBe(true);
    expect(summary.itemsIncluded).toBeGreaterThan(0);
    expect(sentTo).toContain(confirmedEmail);
    expect(sentTo).not.toContain(pendingEmail);

    const state = await store.getNewsletterDigestState(env.DB);
    expect(state.last_sent_at).not.toBeNull();
    const included = JSON.parse(state.last_included_event_ids);
    expect(included.length).toBeGreaterThan(0);
  });

  it("a send failure for every recipient does NOT advance newsletter_digest_state (retries the same content next pass)", async () => {
    const email = `newsletter-pass-failed-${Date.now()}@example.com`;
    await postNewsletterSubscribe(email, "203.0.113.213");
    const row = await env.DB.prepare("SELECT * FROM newsletter_subscribers WHERE email = ?1").bind(email).first<NewsletterRow>();
    await store.confirmNewsletterSubscriberIfPending(env.DB, row!.confirm_token);
    await seedDigestState(40, []); // due, real candidate events available

    const before = await store.getNewsletterDigestState(env.DB);
    const summary = await runComplianceNewsletterPass(env, { send: async () => false });
    expect(summary.sent).toBe(0);
    const after = await store.getNewsletterDigestState(env.DB);
    expect(after.last_sent_at).toBe(before.last_sent_at);
  });
});
