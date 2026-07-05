import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  checkDataFreshness,
  computeSubscriberDeadline,
  nextAnnualMonthEnd,
  nextBirthMonthParityDate,
  StaleDataError,
} from "../src/deadline";
import { hasControlChars, isValidEmail, sanitizeFirstName, strictParseInt } from "../src/validation";
import * as store from "../src/store";
import type { SubscriberRow } from "../src/store";

function form(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

async function postSubscribe(fields: Record<string, string>, ip = "203.0.113.1"): Promise<Response> {
  return SELF.fetch("https://deadline-radar.com/subscribe", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": ip },
    body: form({ hp_website: "", ...fields }),
  });
}

async function getAction(pathAndQuery: string, ip = "203.0.113.1"): Promise<Response> {
  return SELF.fetch(`https://deadline-radar.com${pathAndQuery}`, {
    headers: { "cf-connecting-ip": ip },
  });
}

async function allSubscribers(): Promise<SubscriberRow[]> {
  const { results } = await env.DB.prepare("SELECT * FROM subscribers").all<SubscriberRow>();
  return results;
}

// Note: the structural claim "no SendGrid/email-provider code path exists
// anywhere in src/" is NOT re-verified here as a grep-based test -- the
// Workers runtime this suite executes in (Miniflare/workerd) has no
// `node:fs` host filesystem access, so a source-scanning test can't run
// inside this same pool. That check was instead run directly against the
// shipped source as part of this build's own review (see the outbox
// report / PHASE1_NOTES.md) -- a plain repo-wide grep for "sendgrid",
// "smtp", "mailgun", "postmark", and "mail/send" across worker/src/
// returned zero matches.

describe("GET /health", () => {
  it("responds ok and bypasses rate limiting", async () => {
    const resp = await getAction("/health");
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ status: "ok" });
  });
});

describe("/api prefix stripping (Workers Route binding)", () => {
  // REGRESSION: this Worker is bound to the deadline-radar.com/api/* Route,
  // so every real request arrives with an /api prefix Cloudflare does NOT
  // strip before invoking the Worker -- unlike the bare-path requests every
  // other test in this file makes directly against SELF.fetch(). Without
  // the strip in index.ts's fetch(), every real request through the actual
  // deployed Route would 404, and this suite's own bare-path tests would
  // never have caught it since they never go through /api at all. Found
  // during this build's own review of what a real deploy actually sees.
  it("GET /api/health behaves identically to /health", async () => {
    const resp = await SELF.fetch("https://deadline-radar.com/api/health", {
      headers: { "cf-connecting-ip": "203.0.113.70" },
    });
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ status: "ok" });
  });

  it("POST /api/subscribe stores a row exactly like POST /subscribe", async () => {
    const email = `api-prefix-${Date.now()}@example.com`;
    const resp = await SELF.fetch("https://deadline-radar.com/api/subscribe", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.71" },
      body: form({ email, state: "georgia", license_type_id: "ga-individual", hp_website: "" }),
    });
    expect(resp.status).toBe(200);
    const row = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?1").bind(email).first<SubscriberRow>();
    expect(row).not.toBeNull();
    expect(row?.status).toBe(store.STATUS_PENDING);
  });

  it("GET /api/confirm?token=... reaches the same handler as /confirm", async () => {
    const email = `api-prefix-confirm-${Date.now()}@example.com`;
    await SELF.fetch("https://deadline-radar.com/api/subscribe", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.72" },
      body: form({ email, state: "georgia", license_type_id: "ga-individual", hp_website: "" }),
    });
    const row = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?1").bind(email).first<SubscriberRow>();
    const resp = await SELF.fetch(`https://deadline-radar.com/api/confirm?token=${row?.confirm_token}`, {
      headers: { "cf-connecting-ip": "203.0.113.73" },
    });
    expect(resp.status).toBe(200);
    const updated = await env.DB.prepare("SELECT * FROM subscribers WHERE id = ?1").bind(row?.id).first<SubscriberRow>();
    expect(updated?.status).toBe(store.STATUS_CONFIRMED);
  });
});

describe("POST /subscribe -- happy path (Phase 1 acceptance: capture without sending email)", () => {
  it("stores a pending_confirmation row and returns the no-email-sent success page", async () => {
    const email = `acceptance-${Date.now()}@example.com`;
    const resp = await postSubscribe(
      { email, state: "florida", license_type_id: "fl-individual-odd" },
      "203.0.113.10"
    );
    expect(resp.status).toBe(200);
    const body = await resp.text();
    expect(body).toContain("Got it");
    expect(body.toLowerCase()).not.toContain("we sent"); // must not claim an email went out

    const row = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?1").bind(email).first<SubscriberRow>();
    expect(row).not.toBeNull();
    expect(row?.status).toBe(store.STATUS_PENDING);
    expect(row?.state_slug).toBe("florida");
    expect(JSON.parse(row?.deadline_fields ?? "{}")).toEqual({ license_type_id: "fl-individual-odd" });
    expect(row?.confirm_token).toBeTruthy();
  });
});

describe("POST /subscribe -- validation", () => {
  it("rejects an invalid email", async () => {
    const resp = await postSubscribe({ email: "not-an-email", state: "florida", license_type_id: "fl-individual-odd" }, "203.0.113.11");
    expect(resp.status).toBe(400);
  });

  it("rejects an unsupported state", async () => {
    const resp = await postSubscribe({ email: "a@example.com", state: "new-york" }, "203.0.113.12");
    expect(resp.status).toBe(400);
  });

  it("rejects control characters in any field", async () => {
    const resp = await SELF.fetch("https://deadline-radar.com/subscribe", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.13" },
      body: `email=a%40example.com&state=florida&license_type_id=fl-individual-odd&hp_website=&first_name=bad%0d%0aname`,
    });
    expect(resp.status).toBe(400);
  });

  it("rejects a license_type_id that can't compute a deadline (probe-before-persist)", async () => {
    const email = `probe-${Date.now()}@example.com`;
    const resp = await postSubscribe({ email, state: "florida", license_type_id: "not-a-real-id" }, "203.0.113.14");
    expect(resp.status).toBe(400);
    const row = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?1").bind(email).first();
    expect(row).toBeNull(); // no orphaned record left behind
  });

  it("rejects a birth_month with trailing garbage instead of silently truncating it (Number.parseInt-leniency regression)", async () => {
    // Found during this port's own adversarial review: Number.parseInt("5abc", 10)
    // === 5, unlike Python's int("5abc") which raises ValueError. Using bare
    // parseInt here would have silently accepted this as month 5 instead of
    // rejecting it the way the Python reference does -- see validation.ts's
    // strictParseInt().
    const resp = await postSubscribe(
      { email: `strictint-${Date.now()}@example.com`, state: "texas", birth_month: "5abc" },
      "203.0.113.16"
    );
    expect(resp.status).toBe(400);
  });

  it("rejects a California birth_month with trailing garbage the same way", async () => {
    const resp = await postSubscribe(
      { email: `strictint-ca-${Date.now()}@example.com`, state: "california", birth_month: "3.5", birth_year: "1990" },
      "203.0.113.17"
    );
    expect(resp.status).toBe(400);
  });

  it("rejects an empty body", async () => {
    const resp = await SELF.fetch("https://deadline-radar.com/subscribe", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.15" },
      body: "",
    });
    expect(resp.status).toBe(400);
  });
});

describe("POST /subscribe -- honeypot", () => {
  it("silently no-ops when the honeypot field is non-empty", async () => {
    const email = `honeypot-${Date.now()}@example.com`;
    const resp = await SELF.fetch("https://deadline-radar.com/subscribe", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.20" },
      body: form({ email, state: "florida", license_type_id: "fl-individual-odd", hp_website: "im-a-bot" }),
    });
    expect(resp.status).toBe(200); // looks like success to the bot
    const row = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?1").bind(email).first();
    expect(row).toBeNull(); // but nothing was actually created
  });

  it("also treats a whitespace-only honeypot value as a bot (regression: abuse-hardening audit finding)", async () => {
    const email = `honeypot-ws-${Date.now()}@example.com`;
    const resp = await SELF.fetch("https://deadline-radar.com/subscribe", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.21" },
      body: form({ email, state: "florida", license_type_id: "fl-individual-odd", hp_website: " " }),
    });
    expect(resp.status).toBe(200);
    const row = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?1").bind(email).first();
    expect(row).toBeNull();
  });
});

describe("POST /subscribe -- cooldown + dedupe", () => {
  it("a second submission for the same email+state within the cooldown window creates no second row", async () => {
    const email = `dedupe-${Date.now()}@example.com`;
    const ip = "203.0.113.30";
    const first = await postSubscribe({ email, state: "georgia", license_type_id: "ga-individual" }, ip);
    expect(first.status).toBe(200);
    const second = await postSubscribe({ email, state: "georgia", license_type_id: "ga-individual" }, ip);
    expect(second.status).toBe(200);

    const rows = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?1").bind(email).all<SubscriberRow>();
    expect(rows.results.length).toBe(1);
  });

  it("Gmail dot/+tag sub-addressing shares a cooldown key (regression: abuse-hardening audit finding)", async () => {
    const stamp = Date.now();
    const base = `victim.name.${stamp}@gmail.com`;
    const tagged = `victimname${stamp}+promo@gmail.com`;
    const ip = "203.0.113.31";
    const first = await postSubscribe({ email: base, state: "pennsylvania", license_type_id: "pa-individual" }, ip);
    expect(first.status).toBe(200);
    const second = await postSubscribe({ email: tagged, state: "pennsylvania", license_type_id: "pa-individual" }, ip);
    expect(second.status).toBe(200);

    // Both submissions resolve to the SAME cooldown_key, so the second must
    // not have created its own separate row.
    const rows = await env.DB.prepare("SELECT * FROM subscribers WHERE cooldown_key = ?1")
      .bind(store.cooldownKey(base))
      .all<SubscriberRow>();
    expect(rows.results.length).toBe(1);
  });
});

describe("Confirm / unsubscribe / renewed / rearm lifecycle", () => {
  async function signUpAndGetRow(ip: string): Promise<SubscriberRow> {
    const email = `lifecycle-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    const resp = await postSubscribe({ email, state: "michigan", license_type_id: "mi-individual" }, ip);
    expect(resp.status).toBe(200);
    const row = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?1").bind(email).first<SubscriberRow>();
    if (!row) throw new Error("test setup failed: no row after signup");
    return row;
  }

  it("confirm moves pending -> confirmed and is idempotent", async () => {
    const row = await signUpAndGetRow("203.0.113.40");
    const resp1 = await getAction(`/confirm?token=${row.confirm_token}`, "203.0.113.41");
    expect(resp1.status).toBe(200);
    const resp2 = await getAction(`/confirm?token=${row.confirm_token}`, "203.0.113.42");
    expect(resp2.status).toBe(200); // clicking twice is a no-op, not an error

    const updated = await env.DB.prepare("SELECT * FROM subscribers WHERE id = ?1").bind(row.id).first<SubscriberRow>();
    expect(updated?.status).toBe(store.STATUS_CONFIRMED);
    expect(updated?.confirmed_at).toBeTruthy();
  });

  it("REGRESSION: a never-confirmed subscriber's renewed_token cannot reach /renewed (double-opt-in bypass)", async () => {
    const row = await signUpAndGetRow("203.0.113.43");
    // row is still pending_confirmation -- confirm_token was never used.
    const resp = await getAction(`/renewed?token=${row.renewed_token}`, "203.0.113.44");
    expect(resp.status).toBe(404);
    const updated = await env.DB.prepare("SELECT * FROM subscribers WHERE id = ?1").bind(row.id).first<SubscriberRow>();
    expect(updated?.status).toBe(store.STATUS_PENDING); // unchanged
  });

  it("unsubscribe on a still-pending record is honored (kills the pending signup)", async () => {
    const row = await signUpAndGetRow("203.0.113.45");
    const resp = await getAction(`/unsubscribe?token=${row.unsubscribe_token}`, "203.0.113.46");
    expect(resp.status).toBe(200);
    const updated = await env.DB.prepare("SELECT * FROM subscribers WHERE id = ?1").bind(row.id).first<SubscriberRow>();
    expect(updated?.status).toBe(store.STATUS_STOPPED);
    expect(updated?.stop_reason).toBe("unsubscribed");
  });

  it("full confirm -> renewed -> rearm -> renewed-again cycle", async () => {
    const row = await signUpAndGetRow("203.0.113.47");
    await getAction(`/confirm?token=${row.confirm_token}`, "203.0.113.48");

    const renewedResp = await getAction(`/renewed?token=${row.renewed_token}`, "203.0.113.49");
    expect(renewedResp.status).toBe(200);
    let updated = await env.DB.prepare("SELECT * FROM subscribers WHERE id = ?1").bind(row.id).first<SubscriberRow>();
    expect(updated?.status).toBe(store.STATUS_STOPPED);
    expect(updated?.stop_reason).toBe("renewed");

    const rearmResp = await getAction(`/rearm?token=${updated?.unsubscribe_token}`, "203.0.113.50");
    expect(rearmResp.status).toBe(200);
    updated = await env.DB.prepare("SELECT * FROM subscribers WHERE id = ?1").bind(row.id).first<SubscriberRow>();
    expect(updated?.status).toBe(store.STATUS_CONFIRMED);
    expect(updated?.cycle).toBe(2);

    // Old unsubscribe token is now stale (rotated on rearm) -- a repeat
    // /rearm with it must fail, not silently re-arm again.
    const staleRearm = await getAction(`/rearm?token=${row.unsubscribe_token}`, "203.0.113.51");
    expect(staleRearm.status).toBe(404);
  });
});

describe("Permanent suppression (store.isPermanentlySuppressed) -- Phase 2 readiness, unit-tested directly", () => {
  // Not wired into any Phase-1 route (the Python original only calls this
  // from scheduler.py's send loop, which Phase 1 does not deploy) --
  // ported now so Phase 2's scheduler port is a drop-in, not new logic.
  it("suppresses after an unsubscribe with no later confirm", async () => {
    const email = `suppress-${Date.now()}@example.com`;
    await store.addPending(env.DB, { email, stateSlug: "illinois", deadlineFields: { license_type_id: "il-individual" }, firstName: null });
    const row = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?1").bind(email).first<SubscriberRow>();
    await store.confirm(env.DB, row!.confirm_token);
    await store.stop(env.DB, row!.unsubscribe_token, "unsubscribed");
    expect(await store.isPermanentlySuppressed(env.DB, email)).toBe(true);
  });

  it("lifts suppression after a genuine later re-confirm (regression: over-broad suppression bug)", async () => {
    const email = `unsuppress-${Date.now()}@example.com`;
    await store.addPending(env.DB, { email, stateSlug: "illinois", deadlineFields: { license_type_id: "il-individual" }, firstName: null });
    let row = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?1").bind(email).first<SubscriberRow>();
    await store.confirm(env.DB, row!.confirm_token);
    await store.stop(env.DB, row!.unsubscribe_token, "unsubscribed");
    expect(await store.isPermanentlySuppressed(env.DB, email)).toBe(true);

    // A fresh signup + a REAL confirm click is the subscriber re-initiating
    // consent -- must lift the suppression.
    await store.addPending(env.DB, { email, stateSlug: "pennsylvania", deadlineFields: { license_type_id: "pa-individual" }, firstName: null });
    row = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?1 AND state_slug = ?2").bind(email, "pennsylvania").first<SubscriberRow>();
    await store.confirm(env.DB, row!.confirm_token);
    expect(await store.isPermanentlySuppressed(env.DB, email)).toBe(false);
  });

  // Regression test for an adversarial-review finding: an earlier version of
  // isPermanentlySuppressed() ran `SELECT ... FROM subscribers` with NO
  // WHERE clause at all, then filtered by normalized email in JavaScript --
  // a full-table scan on every call. It was dead code at review time (no
  // Phase-1 route calls it), but would not have scaled once Phase 2 wires
  // the scheduler to it. This asserts the actual SQLite query plan uses the
  // idx_subscribers_email_normalized expression index (migration 0003)
  // instead of scanning every row.
  it("looks up by an indexed expression, not a full table scan (regression: full-table-scan finding)", async () => {
    const { results } = await env.DB
      .prepare(
        `EXPLAIN QUERY PLAN SELECT stop_reason, stopped_at, confirmed_at, email FROM subscribers
         WHERE LOWER(TRIM(email)) = ?1`
      )
      .bind("plan-check@example.com")
      .all<{ detail: string }>();
    const plan = results.map((r) => r.detail).join(" | ");
    expect(plan).toMatch(/USING INDEX idx_subscribers_email_normalized/);
    expect(plan).not.toMatch(/SCAN subscribers(?!.*USING INDEX)/);
  });

  // The old JS-side filter compared via normalizeEmail() on both sides, so
  // casing/whitespace differences between signup-time and lookup-time email
  // never mattered. Pushing the filter into SQL (LOWER(TRIM(email)) = ?1,
  // binding the JS-normalized value) must preserve that -- this guards the
  // refactor itself, not just the original bug.
  it("still matches case-insensitively now that filtering happens in SQL, not JS", async () => {
    const storedEmail = `CaseTest-${Date.now()}@Example.COM`;
    await store.addPending(env.DB, {
      email: storedEmail,
      stateSlug: "illinois",
      deadlineFields: { license_type_id: "il-individual" },
      firstName: null,
    });
    const row = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?1").bind(storedEmail).first<SubscriberRow>();
    await store.confirm(env.DB, row!.confirm_token);
    await store.stop(env.DB, row!.unsubscribe_token, "unsubscribed");
    expect(await store.isPermanentlySuppressed(env.DB, storedEmail.toLowerCase())).toBe(true);
    expect(await store.isPermanentlySuppressed(env.DB, `  ${storedEmail.toUpperCase()}  `)).toBe(true);
  });
});

describe("markReminderSent / allConfirmedActive (Phase 2 drop-in readiness)", () => {
  it("markReminderSent appends a threshold once and is idempotent", async () => {
    const email = `markremind-${Date.now()}@example.com`;
    await store.addPending(env.DB, { email, stateSlug: "illinois", deadlineFields: { license_type_id: "il-individual" }, firstName: null });
    const row = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?1").bind(email).first<SubscriberRow>();
    await store.markReminderSent(env.DB, row!.id, 30);
    await store.markReminderSent(env.DB, row!.id, 30); // repeat -- must not duplicate
    await store.markReminderSent(env.DB, row!.id, 14);
    const updated = await env.DB.prepare("SELECT * FROM subscribers WHERE id = ?1").bind(row!.id).first<SubscriberRow>();
    expect(JSON.parse(updated!.reminders_sent)).toEqual([30, 14]);
  });

  it("allConfirmedActive returns only status=confirmed subscribers", async () => {
    const email = `allactive-${Date.now()}@example.com`;
    await store.addPending(env.DB, { email, stateSlug: "illinois", deadlineFields: { license_type_id: "il-individual" }, firstName: null });
    const pendingRow = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?1").bind(email).first<SubscriberRow>();
    let active = await store.allConfirmedActive(env.DB);
    expect(active.some((r) => r.id === pendingRow!.id)).toBe(false); // still pending -- excluded

    await store.confirm(env.DB, pendingRow!.confirm_token);
    active = await store.allConfirmedActive(env.DB);
    expect(active.some((r) => r.id === pendingRow!.id)).toBe(true);
  });
});

describe("addPending re-sanitizes first_name independently (defense-in-depth, store.py parity)", () => {
  it("caps an oversized first_name even if the caller forgot to", async () => {
    const email = `firstname-${Date.now()}@example.com`;
    const oversized = "A".repeat(200);
    await store.addPending(env.DB, { email, stateSlug: "illinois", deadlineFields: { license_type_id: "il-individual" }, firstName: oversized });
    const row = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?1").bind(email).first<SubscriberRow>();
    expect(row?.first_name?.length).toBe(60);
  });
});

describe("Rate limiting (D1-backed, atomic insert-if-under-limit)", () => {
  it("blocks the 6th /subscribe from the same IP within the window", async () => {
    const ip = "203.0.113.60";
    for (let i = 0; i < 5; i++) {
      const resp = await postSubscribe({ email: `ratelimit-${i}-${Date.now()}@example.com`, state: "georgia", license_type_id: "ga-individual" }, ip);
      expect(resp.status).not.toBe(429);
    }
    const sixth = await postSubscribe({ email: `ratelimit-6-${Date.now()}@example.com`, state: "georgia", license_type_id: "ga-individual" }, ip);
    expect(sixth.status).toBe(429);
  });

  it("blocks the 31st GET action from the same IP within the window", async () => {
    const ip = "203.0.113.61";
    for (let i = 0; i < 30; i++) {
      const resp = await getAction("/confirm?token=nonexistent", ip);
      expect(resp.status).not.toBe(429);
    }
    const thirtyFirst = await getAction("/confirm?token=nonexistent", ip);
    expect(thirtyFirst.status).toBe(429);
  });
});

// ---------------------------------------------------------------------------
// Pure-function unit tests -- no D1/HTTP involved.
// ---------------------------------------------------------------------------
describe("validation.ts", () => {
  it("isValidEmail rejects control characters and malformed addresses", () => {
    expect(isValidEmail("a@b.com")).toBe(true);
    expect(isValidEmail("not-an-email")).toBe(false);
    expect(isValidEmail("a@b.com\r\nBcc: evil@x.com")).toBe(false);
    expect(hasControlChars("a\x00b")).toBe(true);
  });

  it("sanitizeFirstName strips control/non-printable chars and caps length", () => {
    expect(sanitizeFirstName("  David  ")).toBe("David");
    expect(sanitizeFirstName("")).toBeNull();
    expect(sanitizeFirstName("A".repeat(100))?.length).toBe(60);
  });

  it("strictParseInt matches Python int() semantics, unlike Number.parseInt", () => {
    expect(strictParseInt("5")).toBe(5);
    expect(strictParseInt(" 5 ")).toBe(5);
    expect(strictParseInt("-3")).toBe(-3);
    expect(strictParseInt("5abc")).toBeNull(); // Number.parseInt("5abc", 10) would be 5
    expect(strictParseInt("5.5")).toBeNull();
    expect(strictParseInt("")).toBeNull();
    expect(strictParseInt("0x10")).toBeNull();
  });
});

describe("deadlines.ts", () => {
  it("nextBirthMonthParityDate returns the next matching-parity month-end after asOf", () => {
    const asOf = new Date("2026-07-03T00:00:00Z");
    const d = nextBirthMonthParityDate(asOf, 3, "odd");
    expect(d.getUTCFullYear() % 2).toBe(1);
    expect(d.getUTCMonth()).toBe(2); // March, 0-indexed
    expect(d.getTime()).toBeGreaterThan(asOf.getTime());
  });

  it("nextAnnualMonthEnd rolls to next year once this year's date has passed", () => {
    const asOf = new Date("2026-07-03T00:00:00Z");
    const d = nextAnnualMonthEnd(asOf, 1); // January -- already passed this year
    expect(d.getUTCFullYear()).toBe(2027);
  });

  it("computeSubscriberDeadline resolves Ohio cohort groups and rejects unknown ones", () => {
    const asOf = new Date("2026-07-03T00:00:00Z");
    expect(computeSubscriberDeadline("ohio", { cohort_group: "Group 1" }, asOf)).not.toBeNull();
    expect(computeSubscriberDeadline("ohio", { cohort_group: "Group 9" }, asOf)).toBeNull();
  });

  it("checkDataFreshness throws StaleDataError once data is older than the threshold", () => {
    const farFuture = new Date("2030-01-01T00:00:00Z");
    expect(() => checkDataFreshness(farFuture)).toThrow(StaleDataError);
    expect(() => checkDataFreshness(new Date("2026-07-05T00:00:00Z"))).not.toThrow();
  });
});

describe("store.ts cooldownKey", () => {
  it("folds Gmail dot and +tag sub-addressing to the same key", () => {
    expect(store.cooldownKey("Victim.Name+promo@Gmail.com")).toBe(store.cooldownKey("victimname@gmail.com"));
  });
  it("does not fold across different domains", () => {
    expect(store.cooldownKey("a.b@gmail.com")).not.toBe(store.cooldownKey("a.b@other.com"));
  });
});
