/**
 * Hand-written Stripe client (2026-08-05, paid tiers). No `stripe` npm
 * package -- this Worker has zero runtime dependencies today and every
 * existing third-party integration (SendGrid in sender.ts, Turnstile in
 * validation.ts) is a hand-written `fetch()` call using Env-sourced
 * secrets. This follows the same convention rather than introducing the
 * first dependency.
 *
 * Covers exactly what index.ts's checkout/webhook routes need: creating a
 * Checkout Session and verifying a webhook's signature. Nothing more.
 */

export class StripeApiError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = "StripeApiError";
  }
}

interface StripeCheckoutSessionParams {
  priceId: string;
  successUrl: string;
  cancelUrl: string;
  metadata: Record<string, string>;
  /** Existing Stripe customer id, if this firm has one already (repeat
   * checkout after a lapsed subscription, etc). */
  customerId?: string;
  /** Only used when customerId is absent -- lets Stripe create/attach a
   * customer by email on first checkout. */
  customerEmail?: string;
}

export interface StripeCheckoutSession {
  id: string;
  url: string;
}

/**
 * POST /v1/checkout/sessions in `mode=subscription`. Stripe's REST API is
 * form-encoded, including bracket-notation for nested fields
 * (`line_items[0][price]`, `metadata[firm_id]`) -- URLSearchParams handles
 * the encoding, the bracket keys are just literal strings Stripe parses.
 */
export async function createCheckoutSession(
  secretKey: string,
  params: StripeCheckoutSessionParams
): Promise<StripeCheckoutSession> {
  const body = new URLSearchParams();
  body.set("mode", "subscription");
  body.set("line_items[0][price]", params.priceId);
  body.set("line_items[0][quantity]", "1");
  body.set("success_url", params.successUrl);
  body.set("cancel_url", params.cancelUrl);
  for (const [key, value] of Object.entries(params.metadata)) {
    body.set(`metadata[${key}]`, value);
  }
  if (params.customerId) {
    body.set("customer", params.customerId);
  } else if (params.customerEmail) {
    body.set("customer_email", params.customerEmail);
  }

  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${secretKey}:`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  const json = (await res.json()) as {
    id?: string;
    url?: string;
    error?: { message?: string };
  };
  if (!res.ok || !json.id || !json.url) {
    throw new StripeApiError(json.error?.message ?? "Stripe checkout session creation failed.", res.status);
  }
  return { id: json.id, url: json.url };
}

/**
 * Verifies a Stripe `Stripe-Signature` header against the RAW (unparsed)
 * request body, per Stripe's documented scheme:
 *   signed_payload = "{timestamp}.{raw_body}"
 *   expected = hex(HMAC_SHA256(webhook_secret, signed_payload))
 * compared against the header's `v1=` value.
 *
 * `nowMs`/`toleranceSeconds` are parameters (not `Date.now()` inline) so
 * tests can assert both a fresh signature verifies AND a stale/replayed one
 * (older than the tolerance window) is rejected, without depending on wall
 * clock time.
 *
 * Returns false -- never throws -- on any malformed header, missing
 * timestamp/signature, or mismatch. The caller (handleStripeWebhook) treats
 * `false` as "reject with 400 before trusting the body at all."
 */
export async function verifyWebhookSignature(
  rawBody: string,
  sigHeader: string | null,
  webhookSecret: string,
  nowMs: number = Date.now(),
  toleranceSeconds = 300
): Promise<boolean> {
  if (!sigHeader || !webhookSecret) return false;

  const parts: Record<string, string> = {};
  for (const kv of sigHeader.split(",")) {
    const eq = kv.indexOf("=");
    if (eq === -1) continue;
    parts[kv.slice(0, eq).trim()] = kv.slice(eq + 1).trim();
  }
  const timestampRaw = parts["t"];
  const v1 = parts["v1"];
  if (!timestampRaw || !v1) return false;

  const timestamp = Number(timestampRaw);
  if (!Number.isFinite(timestamp)) return false;
  if (Math.abs(nowMs / 1000 - timestamp) > toleranceSeconds) return false;

  const signedPayload = `${timestampRaw}.${rawBody}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(webhookSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload));
  const expectedHex = [...new Uint8Array(sigBuffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

  return timingSafeEqualHex(expectedHex, v1);
}

/** Constant-time comparison over equal-length hex strings -- a signature
 * check must not leak timing information about how many leading characters
 * matched. Unequal lengths short-circuit (that alone doesn't leak the
 * secret) before the constant-time loop. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Minimal shape of the Stripe event types index.ts's webhook handler
 * branches on. Deliberately not a full Stripe type -- only the fields those
 * branches actually read. */
export interface StripeWebhookEvent {
  id: string;
  type: string;
  data: {
    object: Record<string, unknown>;
  };
}
