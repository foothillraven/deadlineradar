/**
 * Roadmap #22 (2026-08-09): SMS/text reminders. Modeled on
 * slack-integration.spec.ts/teams-integration.spec.ts's shape for the
 * pass tests, plus digest-mode.spec.ts's own asOf-uniqueness discipline
 * (runSmsAlertPass iterates every SMS-opted-in subscriber in the table).
 * Twilio credentials are FAKE throughout -- sendSms()/the real Twilio API
 * are never exercised live; every test injects its own `send`.
 */
import { env, SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import * as store from "../src/store";
import { isWithinSmsQuietHours, isValidTwilioSignature } from "../src/sms";

const BASE = "https://deadline-radar.com";
const MS_PER_DAY = 86_400_000;
const FAKE_AUTH_TOKEN = "fake-twilio-auth-token-for-tests";

async function seedConfirmedSubscriber(stateSlug: string, userDeadline: string, email?: string) {
  const addr = email ?? `smstest-${Date.now()}-${Math.floor(performance.now())}@example.com`;
  return store.addPending(env.DB, {
    email: addr,
    stateSlug,
    deadlineFields: {},
    deadlineSource: store.DEADLINE_SOURCE_USER,
    userDeadline,
    firstName: null,
    firmId: null,
    skipConfirmation: true,
  });
}

async function subscriberCookie(email: string): Promise<string> {
  const { rawSessionToken } = await store.createSubscriberSession(env.DB, store.normalizeEmail(email));
  return `dr_sub_session=${rawSessionToken}`;
}

function isoDaysFromUtcMidnight(base: Date, days: number): string {
  return new Date(base.getTime() + days * MS_PER_DAY).toISOString().slice(0, 10);
}

const RUN_BASE_MS = Date.now();
function freshAsOf(saltDays: number): Date {
  const d = new Date(RUN_BASE_MS + saltDays * MS_PER_DAY);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

describe("isWithinSmsQuietHours", () => {
  it("is true mid-day for Eastern (Ohio)", () => {
    // 18:00 UTC -> 1pm ET
    const now = new Date(Date.UTC(2027, 5, 15, 18, 0, 0));
    expect(isWithinSmsQuietHours("ohio", now)).toBe(true);
  });

  it("is false before 8am local (Pacific, 18:00 UTC would be 10am -- test an earlier UTC hour)", () => {
    // 12:00 UTC -> 4am PT -- well before 8am.
    const now = new Date(Date.UTC(2027, 5, 15, 12, 0, 0));
    expect(isWithinSmsQuietHours("california", now)).toBe(false);
  });

  it("is false after 9pm local", () => {
    // 06:00 UTC -> 1am ET the same UTC-date's early morning -- well after
    // 9pm the PRIOR local day, i.e. outside the window either way.
    const now = new Date(Date.UTC(2027, 5, 15, 6, 0, 0));
    expect(isWithinSmsQuietHours("ohio", now)).toBe(false);
  });

  it("fails closed for an unlisted/incompatible jurisdiction (Guam, given the current fixed cron time)", () => {
    const now = new Date(Date.UTC(2027, 5, 15, 18, 0, 0));
    // Real offset (+10) -- 18:00 UTC is ~4am Chamorro time, correctly
    // outside the window, not a guess.
    expect(isWithinSmsQuietHours("guam", now)).toBe(false);
  });

  it("fails closed for a genuinely unknown state slug", () => {
    const now = new Date(Date.UTC(2027, 5, 15, 18, 0, 0));
    expect(isWithinSmsQuietHours("atlantis", now)).toBe(false);
  });
});

describe("isValidTwilioSignature", () => {
  async function computeRealSignature(authToken: string, url: string, params: Record<string, string>): Promise<string> {
    const sortedKeys = Object.keys(params).sort();
    let data = url;
    for (const key of sortedKeys) data += key + params[key];
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(authToken), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
    return btoa(String.fromCharCode(...new Uint8Array(sig)));
  }

  it("accepts a correctly-computed signature", async () => {
    const url = "https://deadline-radar.com/api/sms/inbound";
    const params = { From: "+15551234567", Body: "STOP" };
    const sig = await computeRealSignature(FAKE_AUTH_TOKEN, url, params);
    expect(await isValidTwilioSignature(FAKE_AUTH_TOKEN, sig, url, params)).toBe(true);
  });

  it("rejects a wrong signature", async () => {
    const url = "https://deadline-radar.com/api/sms/inbound";
    const params = { From: "+15551234567", Body: "STOP" };
    expect(await isValidTwilioSignature(FAKE_AUTH_TOKEN, "clearly-wrong-signature==", url, params)).toBe(false);
  });

  it("rejects a missing signature", async () => {
    const url = "https://deadline-radar.com/api/sms/inbound";
    expect(await isValidTwilioSignature(FAKE_AUTH_TOKEN, null, url, { From: "+1", Body: "STOP" })).toBe(false);
  });

  it("rejects a signature computed with the wrong auth token", async () => {
    const url = "https://deadline-radar.com/api/sms/inbound";
    const params = { From: "+15551234567", Body: "STOP" };
    const sig = await computeRealSignature("a-different-token", url, params);
    expect(await isValidTwilioSignature(FAKE_AUTH_TOKEN, sig, url, params)).toBe(false);
  });

  it("rejects when the params are tampered with after signing", async () => {
    const url = "https://deadline-radar.com/api/sms/inbound";
    const sig = await computeRealSignature(FAKE_AUTH_TOKEN, url, { From: "+15551234567", Body: "STOP" });
    expect(await isValidTwilioSignature(FAKE_AUTH_TOKEN, sig, url, { From: "+15551234567", Body: "START" })).toBe(false);
  });
});

describe("phone verification flow", () => {
  it("401s start-verification with no session", async () => {
    const resp = await SELF.fetch(`${BASE}/subscriber/phone/start-verification`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone_number: "+15551234567" }),
    });
    expect(resp.status).toBe(401);
  });

  it("503s when Twilio isn't configured", async () => {
    const email = `smsverif-unconfigured-${Date.now()}@example.com`;
    await seedConfirmedSubscriber("ohio", "2027-01-01", email);
    const resp = await SELF.fetch(`${BASE}/subscriber/phone/start-verification`, {
      method: "POST",
      headers: { "content-type": "application/json", Cookie: await subscriberCookie(email) },
      body: JSON.stringify({ phone_number: "+15551234567" }),
    });
    expect(resp.status).toBe(503);
  });

  it("400s an invalid (non-US) phone number even when configured", async () => {
    const email = `smsverif-badphone-${Date.now()}@example.com`;
    await seedConfirmedSubscriber("ohio", "2027-01-01", email);
    const worker = (await import("../src/index")).default;
    const resp = await worker.fetch(
      new Request(`${BASE}/subscriber/phone/start-verification`, {
        method: "POST",
        headers: { "content-type": "application/json", Cookie: await subscriberCookie(email) },
        body: JSON.stringify({ phone_number: "not-a-phone" }),
      }),
      { ...env, TWILIO_ACCOUNT_SID: "AC_fake", TWILIO_AUTH_TOKEN: FAKE_AUTH_TOKEN, TWILIO_FROM_NUMBER: "+15559999999" } as never,
      { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext
    );
    expect(resp.status).toBe(400);
  });

  it("AuditLab SMS-1: refuses opt-in for a subscriber whose ONLY licensed state is Guam -- never accepts an opt-in that can never be honored", async () => {
    const email = `smsverif-guamonly-${Date.now()}@example.com`;
    await seedConfirmedSubscriber("guam", "2027-01-01", email);
    const worker = (await import("../src/index")).default;
    const resp = await worker.fetch(
      new Request(`${BASE}/subscriber/phone/start-verification`, {
        method: "POST",
        headers: { "content-type": "application/json", Cookie: await subscriberCookie(email) },
        body: JSON.stringify({ phone_number: "+15551234567", consent: true, consent_version: "sms-consent-2026-08-09" }),
      }),
      { ...env, TWILIO_ACCOUNT_SID: "AC_fake", TWILIO_AUTH_TOKEN: FAKE_AUTH_TOKEN, TWILIO_FROM_NUMBER: "+15559999999" } as never,
      { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext
    );
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toMatch(/timezone/i);
    // No verification row created -- refused before any code was sent.
    const row = await env.DB.prepare("SELECT * FROM subscriber_phone_verifications WHERE subscriber_email_normalized = ?1")
      .bind(store.normalizeEmail(email))
      .first();
    expect(row).toBeNull();
  });

  it("AuditLab SMS-1: a subscriber with a Guam row AND another state can still opt in -- SMS still sends for the other state's deadlines", async () => {
    const email = `smsverif-guamplus-${Date.now()}@example.com`;
    await seedConfirmedSubscriber("guam", "2027-01-01", email);
    await seedConfirmedSubscriber("ohio", "2027-06-01", email);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ sid: "SM_fake" }), { status: 201 }));
    try {
      const worker = (await import("../src/index")).default;
      const resp = await worker.fetch(
        new Request(`${BASE}/subscriber/phone/start-verification`, {
          method: "POST",
          headers: { "content-type": "application/json", Cookie: await subscriberCookie(email) },
          body: JSON.stringify({ phone_number: "+15551234567", consent: true, consent_version: "sms-consent-2026-08-09" }),
        }),
        { ...env, TWILIO_ACCOUNT_SID: "AC_fake", TWILIO_AUTH_TOKEN: FAKE_AUTH_TOKEN, TWILIO_FROM_NUMBER: "+15559999999" } as never,
        { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext
      );
      // Not blocked by the timezone check -- reaches the real send path
      // (mocked here), proving the mixed-state case is unaffected.
      expect(resp.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("AuditLab SMS-3: refuses start-verification without consent, server-side -- even if the client's own JS check were bypassed", async () => {
    const worker = (await import("../src/index")).default;
    const envOverride = { ...env, TWILIO_ACCOUNT_SID: "AC_fake", TWILIO_AUTH_TOKEN: FAKE_AUTH_TOKEN, TWILIO_FROM_NUMBER: "+15559999999" } as never;
    const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

    async function attempt(email: string, extra: Record<string, unknown>): Promise<Response> {
      await seedConfirmedSubscriber("ohio", "2027-01-01", email);
      return worker.fetch(
        new Request(`${BASE}/subscriber/phone/start-verification`, {
          method: "POST",
          headers: { "content-type": "application/json", Cookie: await subscriberCookie(email) },
          body: JSON.stringify({ phone_number: "+15551234567", ...extra }),
        }),
        envOverride,
        ctx
      );
    }

    const noConsentEmail = `sms3-noconsent-${Date.now()}@example.com`;
    const noConsentField = await attempt(noConsentEmail, {});
    expect(noConsentField.status).toBe(400);

    const consentFalseEmail = `sms3-false-${Date.now()}@example.com`;
    const consentFalse = await attempt(consentFalseEmail, { consent: false, consent_version: "sms-consent-2026-08-09" });
    expect(consentFalse.status).toBe(400);

    const noVersionEmail = `sms3-noversion-${Date.now()}@example.com`;
    const noVersion = await attempt(noVersionEmail, { consent: true });
    expect(noVersion.status).toBe(400);

    // None of the above created a verification row -- refused before any
    // code was generated or sent. Scoped by EMAIL, not phone_number --
    // other tests in this shared-DB suite reuse the same literal phone
    // number for their own (legitimately created) verification rows.
    for (const email of [noConsentEmail, consentFalseEmail, noVersionEmail]) {
      const row = await env.DB.prepare("SELECT * FROM subscriber_phone_verifications WHERE subscriber_email_normalized = ?1")
        .bind(store.normalizeEmail(email))
        .first();
      expect(row).toBeNull();
    }
  });

  it("full round trip: start -> confirm -> opted in, then opt-out clears it", async () => {
    const email = `smsverif-roundtrip-${Date.now()}@example.com`;
    await seedConfirmedSubscriber("ohio", "2027-01-01", email);
    const cookie = await subscriberCookie(email);

    // Directly seed a verification (bypassing the real Twilio send, same
    // as store-level testing elsewhere in this codebase) to get a known
    // code, since sendSms() itself is never exercised live in tests.
    const code = "123456";
    await store.createPhoneVerification(env.DB, store.normalizeEmail(email), "+15551234567", await store.hashToken(code), "sms-consent-2026-08-09", "203.0.113.99");

    const confirmResp = await SELF.fetch(`${BASE}/subscriber/phone/confirm-verification`, {
      method: "POST",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({ code }),
    });
    expect(confirmResp.status).toBe(200);
    const confirmBody = (await confirmResp.json()) as { sms_opted_in: boolean; phone_last4: string };
    expect(confirmBody.sms_opted_in).toBe(true);
    expect(confirmBody.phone_last4).toBe("4567");

    const row = await store.listSubscriberLicenses(env.DB, email);
    expect(row[0]?.sms_opted_in).toBe(1);
    expect(row[0]?.phone_number).toBe("+15551234567");
    // AuditLab SMS-3: the actual TCPA consent record -- captured at
    // start-verification time, carried through confirm.
    expect(row[0]?.sms_consent_version).toBe("sms-consent-2026-08-09");
    expect(row[0]?.sms_consent_ip).toBe("203.0.113.99");

    const optOutResp = await SELF.fetch(`${BASE}/subscriber/phone/opt-out`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.30", Cookie: cookie },
    });
    expect(optOutResp.status).toBe(200);
    const rowAfter = await store.listSubscriberLicenses(env.DB, email);
    expect(rowAfter[0]?.sms_opted_in).toBe(0);
    // Phone number and consent timestamp are KEPT -- compliance audit
    // trail, not erased on opt-out (store.clearSubscriberSmsOptIn()'s own
    // docstring).
    expect(rowAfter[0]?.phone_number).toBe("+15551234567");
    expect(rowAfter[0]?.sms_opted_in_at).not.toBeNull();
    // Consent record survives opt-out too -- same audit-trail reasoning.
    expect(rowAfter[0]?.sms_consent_version).toBe("sms-consent-2026-08-09");
  });

  it("rejects a wrong code and an expired code", async () => {
    const email = `smsverif-wrongcode-${Date.now()}@example.com`;
    await seedConfirmedSubscriber("ohio", "2027-01-01", email);
    const cookie = await subscriberCookie(email);
    await store.createPhoneVerification(env.DB, store.normalizeEmail(email), "+15551234567", await store.hashToken("111111"), "sms-consent-2026-08-09", "203.0.113.99");

    const wrongResp = await SELF.fetch(`${BASE}/subscriber/phone/confirm-verification`, {
      method: "POST",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({ code: "999999" }),
    });
    expect(wrongResp.status).toBe(400);

    // Directly exercise the expiry path at the store level (no clock
    // injection on the HTTP route) -- same store-level testing convention
    // used elsewhere for time-boundary cases in this codebase.
    const expiredEmail = `smsverif-expired-${Date.now()}@example.com`;
    await env.DB
      .prepare(
        `INSERT INTO subscriber_phone_verifications (id, subscriber_email_normalized, phone_number, code_hash, created_at, expires_at, used_at)
         VALUES (?1,?2,?3,?4,?5,?6,NULL)`
      )
      .bind(
        store.newToken(),
        store.normalizeEmail(expiredEmail),
        "+15551234567",
        await store.hashToken("222222"),
        new Date(Date.now() - 20 * 60_000).toISOString(),
        new Date(Date.now() - 10 * 60_000).toISOString() // expired 10 minutes ago
      )
      .run();
    const consumed = await store.consumePhoneVerification(env.DB, store.normalizeEmail(expiredEmail), "222222");
    expect(consumed).toBeNull();
  });
});

describe("POST /sms/inbound", () => {
  async function computeRealSignature(authToken: string, url: string, params: Record<string, string>): Promise<string> {
    const sortedKeys = Object.keys(params).sort();
    let data = url;
    for (const key of sortedKeys) data += key + params[key];
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(authToken), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
    return btoa(String.fromCharCode(...new Uint8Array(sig)));
  }

  it("STOP with a valid signature clears sms_opted_in for every row sharing that phone number", async () => {
    const email = `smsinbound-stop-${Date.now()}@example.com`;
    await seedConfirmedSubscriber("ohio", "2027-01-01", email);
    await store.setSubscriberSmsOptedIn(env.DB, store.normalizeEmail(email), "+15557654321", "sms-consent-2026-08-09", "203.0.113.99");

    const url = `${BASE}/api/sms/inbound`;
    const params = { From: "+15557654321", Body: "STOP" };
    const sig = await computeRealSignature(FAKE_AUTH_TOKEN, url, params);

    const worker = (await import("../src/index")).default;
    const resp = await worker.fetch(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "X-Twilio-Signature": sig },
        body: new URLSearchParams(params).toString(),
      }),
      { ...env, TWILIO_AUTH_TOKEN: FAKE_AUTH_TOKEN } as never,
      { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext
    );
    expect(resp.status).toBe(200);
    const row = await store.listSubscriberLicenses(env.DB, email);
    expect(row[0]?.sms_opted_in).toBe(0);
  });

  it("an invalid signature does NOT clear opt-in", async () => {
    const email = `smsinbound-badsig-${Date.now()}@example.com`;
    await seedConfirmedSubscriber("ohio", "2027-01-01", email);
    await store.setSubscriberSmsOptedIn(env.DB, store.normalizeEmail(email), "+15557654322", "sms-consent-2026-08-09", "203.0.113.99");

    const url = `${BASE}/api/sms/inbound`;
    const params = { From: "+15557654322", Body: "STOP" };

    const worker = (await import("../src/index")).default;
    const resp = await worker.fetch(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "X-Twilio-Signature": "forged-signature" },
        body: new URLSearchParams(params).toString(),
      }),
      { ...env, TWILIO_AUTH_TOKEN: FAKE_AUTH_TOKEN } as never,
      { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext
    );
    expect(resp.status).toBe(200); // always 200 TwiML, but the mutation must not have happened
    const row = await store.listSubscriberLicenses(env.DB, email);
    expect(row[0]?.sms_opted_in).toBe(1);
  });

  it("a non-STOP keyword (e.g. an ordinary reply) does not clear opt-in", async () => {
    const email = `smsinbound-noop-${Date.now()}@example.com`;
    await seedConfirmedSubscriber("ohio", "2027-01-01", email);
    await store.setSubscriberSmsOptedIn(env.DB, store.normalizeEmail(email), "+15557654323", "sms-consent-2026-08-09", "203.0.113.99");

    const url = `${BASE}/api/sms/inbound`;
    const params = { From: "+15557654323", Body: "thanks!" };
    const sig = await computeRealSignature(FAKE_AUTH_TOKEN, url, params);

    const worker = (await import("../src/index")).default;
    await worker.fetch(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "X-Twilio-Signature": sig },
        body: new URLSearchParams(params).toString(),
      }),
      { ...env, TWILIO_AUTH_TOKEN: FAKE_AUTH_TOKEN } as never,
      { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext
    );
    const row = await store.listSubscriberLicenses(env.DB, email);
    expect(row[0]?.sms_opted_in).toBe(1);
  });
});

describe("runSmsAlertPass", () => {
  it("sends ONE text per newly-due threshold (not batched)", async () => {
    const { runSmsAlertPass } = await import("../src/scheduler");
    const asOf = freshAsOf(1000);
    // Noon UTC on a mid-year date puts Ohio (Eastern) at 7am -- adjust to
    // an hour that's safely within quiet hours for the test.
    const safeAsOf = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate(), 18, 0, 0));
    const email = `smse2e-basic-${Date.now()}@example.com`;
    const sub = await seedConfirmedSubscriber("ohio", isoDaysFromUtcMidnight(safeAsOf, 30), email);
    await store.setSubscriberSmsOptedIn(env.DB, store.normalizeEmail(email), "+15551110001", "sms-consent-2026-08-09", "203.0.113.99");

    const sent: { to: string; body: string }[] = [];
    const summary = await runSmsAlertPass(env, {
      asOf: safeAsOf,
      send: async (to, body) => {
        sent.push({ to, body });
        return true;
      },
    });

    expect(sent.length).toBe(1);
    expect(sent[0]!.to).toBe("+15551110001");
    expect(sent[0]!.body).toContain("Ohio");
    expect(summary.sent).toBe(1);
    expect(summary.itemsClaimed).toBe(1);
    void sub;
  });

  it("a subscriber outside quiet hours is skipped entirely, not just delayed within the pass", async () => {
    const { runSmsAlertPass } = await import("../src/scheduler");
    const asOf = freshAsOf(2000);
    const unsafeAsOf = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate(), 12, 0, 0)); // 4am PT
    const email = `smse2e-quiethours-${Date.now()}@example.com`;
    await seedConfirmedSubscriber("california", isoDaysFromUtcMidnight(unsafeAsOf, 30), email);
    await store.setSubscriberSmsOptedIn(env.DB, store.normalizeEmail(email), "+15551110002", "sms-consent-2026-08-09", "203.0.113.99");

    let sends = 0;
    const summary = await runSmsAlertPass(env, { asOf: unsafeAsOf, send: async () => { sends += 1; return true; } });
    expect(sends).toBe(0);
    expect(summary.skippedQuietHours).toBeGreaterThan(0);
  });

  it("independent of email/Slack/Teams' own dedup tables", async () => {
    const { runSmsAlertPass } = await import("../src/scheduler");
    const asOf = freshAsOf(3000);
    const safeAsOf = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate(), 18, 0, 0));
    const email = `smse2e-independent-${Date.now()}@example.com`;
    const sub = await seedConfirmedSubscriber("ohio", isoDaysFromUtcMidnight(safeAsOf, 30), email);
    await store.setSubscriberSmsOptedIn(env.DB, store.normalizeEmail(email), "+15551110003", "sms-consent-2026-08-09", "203.0.113.99");
    await store.claimReminderThreshold(env.DB, sub.id, "[]", 30);
    await store.claimSlackThresholdNotification(env.DB, sub.id, 30);
    await store.claimTeamsThresholdNotification(env.DB, sub.id, 30);

    let sends = 0;
    await runSmsAlertPass(env, { asOf: safeAsOf, send: async () => { sends += 1; return true; } });
    expect(sends).toBe(1);
  });

  it("dedup: a threshold already claimed by SMS itself is excluded from a later pass", async () => {
    const { runSmsAlertPass } = await import("../src/scheduler");
    const asOf = freshAsOf(4000);
    const safeAsOf = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate(), 18, 0, 0));
    const email = `smse2e-race-${Date.now()}@example.com`;
    const sub = await seedConfirmedSubscriber("ohio", isoDaysFromUtcMidnight(safeAsOf, 30), email);
    await store.setSubscriberSmsOptedIn(env.DB, store.normalizeEmail(email), "+15551110004", "sms-consent-2026-08-09", "203.0.113.99");
    await store.claimSmsThresholdNotification(env.DB, sub.id, 30);

    let sends = 0;
    const summary = await runSmsAlertPass(env, { asOf: safeAsOf, send: async () => { sends += 1; return true; } });
    expect(sends).toBe(0);
    expect(summary.itemsClaimed).toBe(0);
  });

  it("skips a demo-locked firm's roster without claiming or sending", async () => {
    const { runSmsAlertPass } = await import("../src/scheduler");
    const asOf = freshAsOf(5000);
    const safeAsOf = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate(), 18, 0, 0));
    const { id: firmId } = await store.createFirm(env.DB, { name: "SMS Demo Firm", adminEmail: `smsdemo-${Date.now()}@example.com` });
    await env.DB.prepare(`UPDATE firms SET demo_locked = 1 WHERE id = ?1`).bind(firmId).run();
    const email = `smsdemo-target-${Date.now()}@stranger.example.com`;
    const sub = await store.addPending(env.DB, {
      email,
      stateSlug: "ohio",
      deadlineFields: {},
      deadlineSource: store.DEADLINE_SOURCE_USER,
      userDeadline: isoDaysFromUtcMidnight(safeAsOf, 30),
      firstName: null,
      firmId,
      skipConfirmation: true,
    });
    await store.setSubscriberSmsOptedIn(env.DB, store.normalizeEmail(email), "+15551110005", "sms-consent-2026-08-09", "203.0.113.99");

    let sends = 0;
    const summary = await runSmsAlertPass(env, { asOf: safeAsOf, send: async () => { sends += 1; return true; } });
    expect(sends).toBe(0);
    expect(summary.sent).toBe(0);
    const claimedAfter = await store.claimSmsThresholdNotification(env.DB, sub.id, 30);
    expect(claimedAfter).toBe(true); // still claimable -- proves the demo-locked pass never claimed it
  });

  it("the daily send cap halts the pass without erroring, and unclaims what it took", async () => {
    const { runSmsAlertPass } = await import("../src/scheduler");
    const { checkAndCountSmsSend } = await import("../src/sender");
    const asOf = freshAsOf(6000);
    const safeAsOf = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate(), 18, 0, 0));
    await checkAndCountSmsSend(env.DB, 1);

    const email = `smse2e-cap-${Date.now()}@example.com`;
    const sub = await seedConfirmedSubscriber("ohio", isoDaysFromUtcMidnight(safeAsOf, 30), email);
    await store.setSubscriberSmsOptedIn(env.DB, store.normalizeEmail(email), "+15551110006", "sms-consent-2026-08-09", "203.0.113.99");

    let sends = 0;
    const summary = await runSmsAlertPass(
      { ...env, SMS_DAILY_SEND_CAP: "1" },
      { asOf: safeAsOf, send: async () => { sends += 1; return true; } }
    );
    expect(sends).toBe(0);
    expect(summary.errors.some((e) => e.error.includes("daily send cap"))).toBe(true);
    const claimedAfter = await store.claimSmsThresholdNotification(env.DB, sub.id, 30);
    expect(claimedAfter).toBe(true);
  });

  it("a subscriber who never opted in is completely untouched", async () => {
    const { runSmsAlertPass } = await import("../src/scheduler");
    const asOf = freshAsOf(7000);
    const safeAsOf = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate(), 18, 0, 0));
    const email = `smse2e-noopt-${Date.now()}@example.com`;
    await seedConfirmedSubscriber("ohio", isoDaysFromUtcMidnight(safeAsOf, 30), email);
    // No setSubscriberSmsOptedIn() call.

    let sends = 0;
    await runSmsAlertPass(env, { asOf: safeAsOf, send: async () => { sends += 1; return true; } });
    expect(sends).toBe(0);
  });
});
