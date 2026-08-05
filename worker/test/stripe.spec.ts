import { describe, it, expect } from "vitest";
import { verifyWebhookSignature } from "../src/stripe";

const SECRET = "whsec_test_secret_value";

/** Builds a Stripe-Signature header the same way Stripe itself does, so
 * these tests exercise verifyWebhookSignature() against a signature it did
 * NOT generate -- an independent construction, not the function checking
 * its own output. */
async function signPayload(secret: string, timestampSeconds: number, payload: string): Promise<string> {
  const signedPayload = `${timestampSeconds}.${payload}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload));
  const hex = [...new Uint8Array(sigBuffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `t=${timestampSeconds},v1=${hex}`;
}

describe("verifyWebhookSignature", () => {
  it("accepts a validly-signed, fresh payload", async () => {
    const payload = JSON.stringify({ id: "evt_1", type: "checkout.session.completed" });
    const nowMs = 1_700_000_000_000;
    const header = await signPayload(SECRET, Math.floor(nowMs / 1000), payload);
    expect(await verifyWebhookSignature(payload, header, SECRET, nowMs)).toBe(true);
  });

  it("rejects a tampered payload (signature no longer matches)", async () => {
    const payload = JSON.stringify({ id: "evt_1", type: "checkout.session.completed" });
    const nowMs = 1_700_000_000_000;
    const header = await signPayload(SECRET, Math.floor(nowMs / 1000), payload);
    const tamperedPayload = JSON.stringify({ id: "evt_1", type: "customer.subscription.deleted" });
    expect(await verifyWebhookSignature(tamperedPayload, header, SECRET, nowMs)).toBe(false);
  });

  it("rejects a signature made with the wrong secret", async () => {
    const payload = JSON.stringify({ id: "evt_1", type: "checkout.session.completed" });
    const nowMs = 1_700_000_000_000;
    const header = await signPayload("whsec_wrong_secret", Math.floor(nowMs / 1000), payload);
    expect(await verifyWebhookSignature(payload, header, SECRET, nowMs)).toBe(false);
  });

  it("rejects a replayed/stale signature outside the tolerance window", async () => {
    const payload = JSON.stringify({ id: "evt_1", type: "checkout.session.completed" });
    const signedAtMs = 1_700_000_000_000;
    const header = await signPayload(SECRET, Math.floor(signedAtMs / 1000), payload);
    const tenMinutesLaterMs = signedAtMs + 10 * 60 * 1000;
    expect(await verifyWebhookSignature(payload, header, SECRET, tenMinutesLaterMs)).toBe(false);
  });

  it("accepts a signature still inside the tolerance window", async () => {
    const payload = JSON.stringify({ id: "evt_1", type: "checkout.session.completed" });
    const signedAtMs = 1_700_000_000_000;
    const header = await signPayload(SECRET, Math.floor(signedAtMs / 1000), payload);
    const twoMinutesLaterMs = signedAtMs + 2 * 60 * 1000;
    expect(await verifyWebhookSignature(payload, header, SECRET, twoMinutesLaterMs)).toBe(true);
  });

  it("rejects a missing header", async () => {
    expect(await verifyWebhookSignature("{}", null, SECRET)).toBe(false);
  });

  it("rejects a malformed header (missing v1 or t)", async () => {
    expect(await verifyWebhookSignature("{}", "t=12345", SECRET)).toBe(false);
    expect(await verifyWebhookSignature("{}", "v1=deadbeef", SECRET)).toBe(false);
    expect(await verifyWebhookSignature("{}", "garbage", SECRET)).toBe(false);
  });

  it("rejects when no webhook secret is configured", async () => {
    const payload = "{}";
    const header = await signPayload(SECRET, Math.floor(Date.now() / 1000), payload);
    expect(await verifyWebhookSignature(payload, header, "")).toBe(false);
  });

  describe("AuditLab BILL-2: multiple v1 signatures during a webhook-secret rotation", () => {
    async function signatureHex(secret: string, timestampSeconds: number, payload: string): Promise<string> {
      const signedPayload = `${timestampSeconds}.${payload}`;
      const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
      );
      const sigBuffer = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload));
      return [...new Uint8Array(sigBuffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
    }

    it("accepts a match on the FIRST v1 when a second (different-secret) v1 follows it -- the exact bug: a naive last-write-wins parse would keep only the second and reject this", async () => {
      const payload = JSON.stringify({ id: "evt_rotation_1" });
      const nowMs = 1_700_000_000_000;
      const t = Math.floor(nowMs / 1000);
      const ourSigFirst = await signatureHex(SECRET, t, payload);
      const otherSigSecond = await signatureHex("whsec_the_other_active_secret", t, payload);
      const header = `t=${t},v1=${ourSigFirst},v1=${otherSigSecond}`;
      expect(await verifyWebhookSignature(payload, header, SECRET, nowMs)).toBe(true);
    });

    it("accepts a match on the SECOND v1 when the first is a different secret", async () => {
      const payload = JSON.stringify({ id: "evt_rotation_2" });
      const nowMs = 1_700_000_000_000;
      const t = Math.floor(nowMs / 1000);
      const otherSigFirst = await signatureHex("whsec_the_other_active_secret", t, payload);
      const ourSigSecond = await signatureHex(SECRET, t, payload);
      const header = `t=${t},v1=${otherSigFirst},v1=${ourSigSecond}`;
      expect(await verifyWebhookSignature(payload, header, SECRET, nowMs)).toBe(true);
    });

    it("rejects when NEITHER v1 matches our configured secret", async () => {
      const payload = JSON.stringify({ id: "evt_rotation_3" });
      const nowMs = 1_700_000_000_000;
      const t = Math.floor(nowMs / 1000);
      const sigA = await signatureHex("whsec_secret_a", t, payload);
      const sigB = await signatureHex("whsec_secret_b", t, payload);
      const header = `t=${t},v1=${sigA},v1=${sigB}`;
      expect(await verifyWebhookSignature(payload, header, SECRET, nowMs)).toBe(false);
    });
  });
});
