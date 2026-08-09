/**
 * Roadmap #55 (2026-08-09): SendGrid Event Webhook (bounce/complaint
 * tracking). Two layers tested independently, same split as
 * sendgrid_webhook.ts itself:
 *   1. derSignatureToRaw() / verifySendGridEventSignature() -- pure crypto,
 *      no D1/HTTP involved. There's no real SendGrid-signed sample to test
 *      against, so these tests sign with Web Crypto's own RAW-format
 *      ECDSA output, hand-DER-encode it (the inverse of the function under
 *      test), and confirm the round-trip verifies -- proving the DER
 *      parsing is correct without needing an external fixture.
 *   2. POST /email/events -- the route, using workerFetch() to override
 *      env.SENDGRID_WEBHOOK_PUBLIC_KEY per-test (same pattern
 *      billing.spec.ts uses for STRIPE_WEBHOOK_SECRET), signing real
 *      request bodies with the matching private key.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as store from "../src/store";
import { derSignatureToRaw, verifySendGridEventSignature } from "../src/sendgrid_webhook";

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

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// Inverse of derSignatureToRaw() -- test-only, encodes a raw 64-byte r||s
// signature back into DER so these tests can exercise the real parser
// against a real Web Crypto-produced signature.
function rawSignatureToDer(raw: Uint8Array): Uint8Array {
  const encodeInteger = (coord: Uint8Array): number[] => {
    let bytes = [...coord];
    while (bytes.length > 1 && bytes[0] === 0x00 && ((bytes[1] ?? 0) & 0x80) === 0) bytes.shift();
    if ((bytes[0] ?? 0) & 0x80) bytes = [0x00, ...bytes]; // sign-padding
    return [0x02, bytes.length, ...bytes];
  };
  const r = encodeInteger(raw.slice(0, 32));
  const s = encodeInteger(raw.slice(32, 64));
  const body = [...r, ...s];
  return new Uint8Array([0x30, body.length, ...body]);
}

async function generateKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as Promise<CryptoKeyPair>;
}

async function publicKeyBase64(keyPair: CryptoKeyPair): Promise<string> {
  const spki = (await crypto.subtle.exportKey("spki", keyPair.publicKey)) as ArrayBuffer;
  return toBase64(new Uint8Array(spki));
}

async function signEventPayload(keyPair: CryptoKeyPair, timestamp: string, body: string): Promise<string> {
  const signed = new TextEncoder().encode(timestamp + body);
  const rawSig = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keyPair.privateKey, signed as BufferSource)
  );
  return toBase64(rawSignatureToDer(rawSig));
}

// ---------------------------------------------------------------------------
// derSignatureToRaw() / verifySendGridEventSignature() -- pure crypto
// ---------------------------------------------------------------------------

describe("verifySendGridEventSignature", () => {
  it("verifies a genuine signature round-tripped through DER encode -> derSignatureToRaw() -> Web Crypto verify()", async () => {
    const keyPair = await generateKeyPair();
    const pubKeyB64 = await publicKeyBase64(keyPair);
    const timestamp = "1723190400";
    const body = JSON.stringify([{ email: "a@example.com", event: "bounce", sg_event_id: "evt-1" }]);
    const sigB64 = await signEventPayload(keyPair, timestamp, body);

    expect(await verifySendGridEventSignature(pubKeyB64, sigB64, timestamp, body)).toBe(true);
  });

  it("holds across many random signatures -- exercises both DER sign-padding cases", async () => {
    const keyPair = await generateKeyPair();
    const pubKeyB64 = await publicKeyBase64(keyPair);
    for (let i = 0; i < 15; i++) {
      const timestamp = String(1700000000 + i);
      const body = JSON.stringify([{ email: `x${i}@example.com`, event: "delivered", sg_event_id: `evt-${i}` }]);
      const sigB64 = await signEventPayload(keyPair, timestamp, body);
      expect(await verifySendGridEventSignature(pubKeyB64, sigB64, timestamp, body)).toBe(true);
    }
  });

  it("rejects a tampered body", async () => {
    const keyPair = await generateKeyPair();
    const pubKeyB64 = await publicKeyBase64(keyPair);
    const timestamp = "1723190400";
    const body = JSON.stringify([{ email: "a@example.com", event: "bounce", sg_event_id: "evt-1" }]);
    const sigB64 = await signEventPayload(keyPair, timestamp, body);

    const tampered = body.replace("bounce", "delivered");
    expect(await verifySendGridEventSignature(pubKeyB64, sigB64, timestamp, tampered)).toBe(false);
  });

  it("rejects a wrong timestamp", async () => {
    const keyPair = await generateKeyPair();
    const pubKeyB64 = await publicKeyBase64(keyPair);
    const timestamp = "1723190400";
    const body = JSON.stringify([{ email: "a@example.com", event: "bounce", sg_event_id: "evt-1" }]);
    const sigB64 = await signEventPayload(keyPair, timestamp, body);

    expect(await verifySendGridEventSignature(pubKeyB64, sigB64, "1723190401", body)).toBe(false);
  });

  it("rejects a signature from a different key", async () => {
    const keyPair = await generateKeyPair();
    const otherKeyPair = await generateKeyPair();
    const otherPubKeyB64 = await publicKeyBase64(otherKeyPair);
    const timestamp = "1723190400";
    const body = JSON.stringify([{ email: "a@example.com", event: "bounce", sg_event_id: "evt-1" }]);
    const sigB64 = await signEventPayload(keyPair, timestamp, body);

    expect(await verifySendGridEventSignature(otherPubKeyB64, sigB64, timestamp, body)).toBe(false);
  });

  it("fails closed on malformed inputs -- never throws", async () => {
    const keyPair = await generateKeyPair();
    const pubKeyB64 = await publicKeyBase64(keyPair);
    expect(await verifySendGridEventSignature(pubKeyB64, null, "123", "{}")).toBe(false);
    expect(await verifySendGridEventSignature(pubKeyB64, "not-base64!!", "123", "{}")).toBe(false);
    expect(await verifySendGridEventSignature(pubKeyB64, "AAAA", null, "{}")).toBe(false);
    expect(await verifySendGridEventSignature("not-a-valid-key", "AAAA", "123", "{}")).toBe(false);
  });

  it("derSignatureToRaw returns null on malformed DER rather than throwing", () => {
    expect(derSignatureToRaw(new Uint8Array([0x00, 0x01, 0x02]))).toBeNull();
    expect(derSignatureToRaw(new Uint8Array([0x30, 0x05, 0x02, 0x01, 0x01]))).toBeNull(); // truncated
    expect(derSignatureToRaw(new Uint8Array([]))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// POST /email/events
// ---------------------------------------------------------------------------

async function postEvents(
  keyPair: CryptoKeyPair | null,
  events: unknown[],
  envOverrides: Record<string, unknown>,
  timestampOverride?: string
): Promise<Response> {
  const body = JSON.stringify(events);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (keyPair) {
    const timestamp = timestampOverride ?? "1723190400";
    const sigB64 = await signEventPayload(keyPair, timestamp, body);
    headers["X-Twilio-Email-Event-Webhook-Signature"] = sigB64;
    headers["X-Twilio-Email-Event-Webhook-Timestamp"] = timestamp;
  }
  return workerFetch(
    new Request("https://deadline-radar.com/email/events", { method: "POST", headers, body }),
    envOverrides
  );
}

async function seedConfirmedSubscriber(email: string): Promise<void> {
  await store.addPending(env.DB, {
    email,
    stateSlug: "ohio",
    deadlineFields: {},
    deadlineSource: store.DEADLINE_SOURCE_USER,
    userDeadline: "2030-01-01",
    firstName: null,
    firmId: null,
    skipConfirmation: true,
  });
}

describe("POST /email/events", () => {
  it("503s when SENDGRID_WEBHOOK_PUBLIC_KEY is unset -- same unconfigured-rejects posture as /stripe/webhook", async () => {
    const resp = await postEvents(null, [{ email: "a@example.com", event: "bounce", sg_event_id: "evt-x" }], {
      SENDGRID_WEBHOOK_PUBLIC_KEY: undefined,
    });
    expect(resp.status).toBe(503);
  });

  it("400s on a missing/invalid signature and mutates nothing", async () => {
    const keyPair = await generateKeyPair();
    const pubKeyB64 = await publicKeyBase64(keyPair);
    const email = `sgevt-badsig-${Date.now()}@example.com`;
    await seedConfirmedSubscriber(email);

    const resp = await postEvents(null, [{ email, event: "bounce", sg_event_id: "evt-badsig" }], {
      SENDGRID_WEBHOOK_PUBLIC_KEY: pubKeyB64,
    });
    expect(resp.status).toBe(400);
    expect(await store.isPermanentlySuppressed(env.DB, email)).toBe(false);
  });

  it("a bounce event suppresses every row sharing that email", async () => {
    const keyPair = await generateKeyPair();
    const pubKeyB64 = await publicKeyBase64(keyPair);
    const email = `sgevt-bounce-${Date.now()}@example.com`;
    await seedConfirmedSubscriber(email);
    await store.addPending(env.DB, {
      email,
      stateSlug: "texas",
      deadlineFields: {},
      deadlineSource: store.DEADLINE_SOURCE_USER,
      userDeadline: "2030-02-01",
      firstName: null,
      firmId: null,
      skipConfirmation: true,
    });

    const resp = await postEvents(keyPair, [{ email, event: "bounce", sg_event_id: `evt-bounce-${Date.now()}`, reason: "550 5.1.1 no such user" }], {
      SENDGRID_WEBHOOK_PUBLIC_KEY: pubKeyB64,
    });
    expect(resp.status).toBe(200);
    expect(await store.isPermanentlySuppressed(env.DB, email)).toBe(true);
    for (const row of await store.listSubscriberLicenses(env.DB, email)) {
      expect(row.status).toBe(store.STATUS_STOPPED);
      expect(row.stop_reason).toBe("hard_bounced");
    }
  });

  it("a spamreport event suppresses too", async () => {
    const keyPair = await generateKeyPair();
    const pubKeyB64 = await publicKeyBase64(keyPair);
    const email = `sgevt-spam-${Date.now()}@example.com`;
    await seedConfirmedSubscriber(email);

    const resp = await postEvents(keyPair, [{ email, event: "spamreport", sg_event_id: `evt-spam-${Date.now()}` }], {
      SENDGRID_WEBHOOK_PUBLIC_KEY: pubKeyB64,
    });
    expect(resp.status).toBe(200);
    expect(await store.isPermanentlySuppressed(env.DB, email)).toBe(true);
  });

  it("a blocked event is logged but does NOT suppress", async () => {
    const keyPair = await generateKeyPair();
    const pubKeyB64 = await publicKeyBase64(keyPair);
    const email = `sgevt-blocked-${Date.now()}@example.com`;
    const sgEventId = `evt-blocked-${Date.now()}`;
    await seedConfirmedSubscriber(email);

    const resp = await postEvents(keyPair, [{ email, event: "blocked", sg_event_id: sgEventId, reason: "greylisted" }], {
      SENDGRID_WEBHOOK_PUBLIC_KEY: pubKeyB64,
    });
    expect(resp.status).toBe(200);
    expect(await store.isPermanentlySuppressed(env.DB, email)).toBe(false);
    const row = await env.DB.prepare("SELECT * FROM email_deliverability_events WHERE sg_event_id = ?1").bind(sgEventId).first();
    expect(row).toBeTruthy();
    expect((row as { event_type: string }).event_type).toBe("blocked");
  });

  it("a redelivered event (same sg_event_id) doesn't double-log or re-suppress destructively", async () => {
    const keyPair = await generateKeyPair();
    const pubKeyB64 = await publicKeyBase64(keyPair);
    const email = `sgevt-redeliver-${Date.now()}@example.com`;
    const sgEventId = `evt-redeliver-${Date.now()}`;
    await seedConfirmedSubscriber(email);
    const overrides = { SENDGRID_WEBHOOK_PUBLIC_KEY: pubKeyB64 };

    const first = await postEvents(keyPair, [{ email, event: "bounce", sg_event_id: sgEventId }], overrides, "1723190500");
    expect(first.status).toBe(200);
    const second = await postEvents(keyPair, [{ email, event: "bounce", sg_event_id: sgEventId }], overrides, "1723190600");
    expect(second.status).toBe(200);

    const { results } = await env.DB.prepare("SELECT * FROM email_deliverability_events WHERE sg_event_id = ?1").bind(sgEventId).all();
    expect(results?.length).toBe(1);
  });

  it("a batch with one malformed event among valid ones still processes the valid ones", async () => {
    const keyPair = await generateKeyPair();
    const pubKeyB64 = await publicKeyBase64(keyPair);
    const email = `sgevt-batch-${Date.now()}@example.com`;
    await seedConfirmedSubscriber(email);

    const resp = await postEvents(
      keyPair,
      [
        { event: "bounce", sg_event_id: "evt-missing-email" }, // malformed -- no email
        { email, event: "bounce", sg_event_id: `evt-batch-valid-${Date.now()}` },
      ],
      { SENDGRID_WEBHOOK_PUBLIC_KEY: pubKeyB64 }
    );
    expect(resp.status).toBe(200);
    expect(await store.isPermanentlySuppressed(env.DB, email)).toBe(true);
  });
});
