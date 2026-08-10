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
  /** Roadmap #31 (2026-08-09, referral program). A Stripe Coupon id --
   * eligibility (self-referral checks, one-time-only) is decided entirely
   * by the caller (index.ts's handleFirmBillingCheckout) before this is
   * ever passed in; this function never validates or infers eligibility
   * itself. Absent for every non-referred checkout, unchanged from today. */
  couponId?: string;
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
  if (params.couponId) {
    body.set("discounts[0][coupon]", params.couponId);
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

export interface StripeSubscriptionCancellation {
  /** Stripe's own current_period_end (Unix seconds) as an ISO string --
   * display-only, see the migration's own comment for why this never
   * drives an access decision. */
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
}

/**
 * POST /v1/subscriptions/{id} with cancel_at_period_end=true|false. This is
 * a SCHEDULING toggle, not `DELETE /v1/subscriptions/{id}` (which cancels
 * immediately) -- Devin's decision was "no refunds, access continues to the
 * current period's end," and cancel_at_period_end is exactly that: the
 * subscription (and this firm's plan_tier) stays untouched until Stripe's
 * own customer.subscription.deleted webhook fires at the real period end.
 * Setting it back to false (resume) is the same call with the opposite
 * value -- Stripe supports un-cancelling a still-active subscription this
 * way with no separate endpoint.
 */
export async function updateSubscriptionCancelAtPeriodEnd(
  secretKey: string,
  subscriptionId: string,
  cancelAtPeriodEnd: boolean
): Promise<StripeSubscriptionCancellation> {
  const body = new URLSearchParams();
  body.set("cancel_at_period_end", cancelAtPeriodEnd ? "true" : "false");

  const res = await fetch(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${secretKey}:`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  const json = (await res.json()) as {
    // Confirmed live, 2026-08-05, against a real test-mode subscription
    // (caught by an actual failed call, not read from docs): current_period_end
    // is NOT on the Subscription object at top level in this API version --
    // it now lives per subscription-item, since a subscription's items can
    // each have their own billing period. This Worker's checkout only ever
    // creates a single-item subscription (one price, quantity 1), so
    // items.data[0] is always the one that matters.
    cancel_at_period_end?: boolean;
    items?: { data?: Array<{ current_period_end?: number }> };
    error?: { message?: string };
  };
  const currentPeriodEndUnix = json.items?.data?.[0]?.current_period_end;
  if (!res.ok || typeof currentPeriodEndUnix !== "number" || typeof json.cancel_at_period_end !== "boolean") {
    throw new StripeApiError(json.error?.message ?? "Stripe subscription update failed.", res.status);
  }
  return {
    currentPeriodEnd: new Date(currentPeriodEndUnix * 1000).toISOString(),
    cancelAtPeriodEnd: json.cancel_at_period_end,
  };
}

/**
 * Roadmap #31 (2026-08-09, referral program). Applies a Coupon to an
 * EXISTING subscription -- the referrer's own reward, fired from
 * handleStripeWebhook()'s checkout.session.completed branch once the
 * REFERRED firm's payment actually clears (never at signup). Same
 * auth/error-handling shape as updateSubscriptionCancelAtPeriodEnd()
 * above, POSTing a different field to the same endpoint.
 *
 * CONFIRMED LIVE, 2026-08-09 (orchestrator escalation -- Devin's own read
 * on the referral math, "needs an empirical test, not more code reading"):
 * ran `discounts[0][coupon]=X` three times in a row against a real
 * test-mode subscription with the SAME coupon id, exactly what 3
 * successful referrals for the same referrer do. Result, checked via
 * `POST /v1/invoices/create_preview` (the current, non-deprecated way to
 * see the real computed charge): the discount object id was IDENTICAL
 * after all three calls, and the previewed invoice showed exactly ONE 10%
 * discount ($199 subtotal -> $17.910 off -> $179.10 total), not three
 * stacked 10%'s. **`discounts[0][coupon]` REPLACES the discount at that
 * slot -- it does not append or stack.** A referrer's 2nd/10th/50th
 * successful referral re-confirms the SAME flat 10% off, never more. This
 * matches what the dashboard panel's own copy has always said ("you both
 * get 10% off your next invoice" -- singular, never "additional" or "per
 * referral"), so this is confirmed-honest current behavior, not a bug to
 * fix: no risk of exceeding 100% off, and no gap between what's promised
 * and what's delivered. If a future redesign wants referrals to actually
 * COMPOUND, that would need real new logic here (e.g. a percent_off
 * computed server-side per referral count, or a different discount
 * mechanism entirely) -- this function as written can never do that no
 * matter how many times it's called.
 *
 * The OTHER risk this docstring used to flag -- `discounts[0][coupon]`
 * silently overwriting some OTHER, unrelated discount already on the
 * subscription (a manual/support-granted coupon, a future promo) -- is
 * now confirmed a real property of this replace-not-append semantics,
 * not just a plausible worry. Still a non-issue at ship time (no other
 * discount-granting mechanism exists in this codebase), but worth
 * re-reading before a second discount mechanism is ever added.
 */
export async function applyCouponToSubscription(secretKey: string, subscriptionId: string, couponId: string): Promise<void> {
  const body = new URLSearchParams();
  body.set("discounts[0][coupon]", couponId);

  const res = await fetch(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${secretKey}:`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new StripeApiError(json.error?.message ?? "Stripe coupon application failed.", res.status);
  }
}

/**
 * Roadmap #31 (2026-08-09, referral program). Reverses a referrer's
 * reward -- called from handleFirmAccountDelete() when a firm that
 * already earned its referrer a discount gets refunded on deletion (see
 * store.markReferrerRewardReversed()'s own docstring for the exploit this
 * closes: pay, trigger the referrer's reward, immediately self-serve-
 * delete-and-refund, repeat). Uses Stripe's OWN dedicated removal endpoint
 * (`DELETE .../discount`) rather than trying to reason about
 * applyCouponToSubscription()'s replace-vs-append ambiguity in reverse --
 * this is the one Stripe operation that unambiguously means "the
 * subscription has no discount now," regardless of how many discounts
 * were on it or how they got there. A 404 (subscription already
 * cancelled/gone, or already has no discount) is treated as success --
 * there's nothing left to remove, not a failure.
 */
export async function removeCouponFromSubscription(secretKey: string, subscriptionId: string): Promise<void> {
  const res = await fetch(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subscriptionId)}/discount`, {
    method: "DELETE",
    headers: { Authorization: `Basic ${btoa(`${secretKey}:`)}` },
  });
  if (!res.ok && res.status !== 404) {
    const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new StripeApiError(json.error?.message ?? "Stripe coupon removal failed.", res.status);
  }
}

/**
 * Referral v2 (2026-08-09). Prints the firm's freshly-minted referral link
 * directly on the Stripe invoice/receipt document via `custom_fields`, so
 * it's visible without the firm ever visiting the dashboard. Called only
 * from handleStripeWebhook's invoice.created branch, on a DRAFT invoice --
 * Stripe's own docs confirm a draft is fully editable and isn't attempted/
 * finalized until roughly an hour after invoice.created fires, so there's
 * no race with Stripe auto-finalizing the invoice out from under this call.
 * `custom_fields` is an array of up to 4 {name, value} entries (name <=40
 * chars, value <=140 chars, both confirmed against Stripe's own "Update an
 * invoice" API reference) and SETTING it REPLACES the whole list -- this
 * codebase sets no other custom_fields anywhere today, so there is nothing
 * to preserve, but a future second use of custom_fields on an invoice must
 * merge with this one rather than overwrite it.
 */
export async function setInvoiceReferralCustomField(secretKey: string, invoiceId: string, referralLink: string): Promise<void> {
  const body = new URLSearchParams();
  body.set("custom_fields[0][name]", "Refer a firm, get 10% off");
  body.set("custom_fields[0][value]", referralLink);

  const res = await fetch(`https://api.stripe.com/v1/invoices/${encodeURIComponent(invoiceId)}`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${secretKey}:`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new StripeApiError(json.error?.message ?? "Stripe invoice custom-field update failed.", res.status);
  }
}

export interface StripeInvoiceDetails {
  invoiceId: string;
  /** Smallest currency unit (cents for USD) -- what was ACTUALLY charged,
   * post any discount, not the price's list amount. */
  amountPaid: number;
  periodStart: string;
  periodEnd: string;
  /** Null when the invoice has no linked payment (e.g. a $0 invoice, or one
   * that hasn't actually been paid yet) -- callers must treat null as "no
   * refund is possible here," not retry or error. */
  paymentIntentId: string | null;
}

/**
 * Task #3 follow-up (2026-08-06, Devin's decision: a prorated refund on
 * account DELETION, distinct from plain cancellation which stays no-refund
 * -- see handleFirmAccountDelete's own comment). Two calls, not one:
 *
 *   1. GET /v1/subscriptions/{id}?expand[]=latest_invoice for the invoice
 *      id/amount_paid and the CURRENT period's real boundaries (item-level
 *      current_period_start/end -- same "confirmed live against a real
 *      subscription, not read from docs" finding
 *      updateSubscriptionCancelAtPeriodEnd() already made: current_period_end
 *      lives per subscription-item in this API version, not at the top
 *      level).
 *   2. GET /v1/invoices/{id}?expand[]=payments for the actual payment_intent
 *      id -- confirmed live (2026-08-06, against a real disposable test-mode
 *      subscription, not docs) that invoice.charge/invoice.payment_intent
 *      are BOTH absent in this API version; the real linkage is the
 *      `payments` expansion, `payments.data[0].payment.payment_intent`.
 *      (charges?customer=X also finds the charge, but with no reliable link
 *      back to THIS invoice specifically once a firm has more than one
 *      historical invoice -- payments is the version-correct path.)
 */
export async function getLatestInvoiceForSubscription(
  secretKey: string,
  subscriptionId: string
): Promise<StripeInvoiceDetails | null> {
  const subRes = await fetch(
    `https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subscriptionId)}?expand[]=latest_invoice`,
    { headers: { Authorization: `Basic ${btoa(`${secretKey}:`)}` } }
  );
  const subJson = (await subRes.json()) as {
    items?: { data?: Array<{ current_period_start?: number; current_period_end?: number }> };
    latest_invoice?: { id?: string; amount_paid?: number };
    error?: { message?: string };
  };
  if (!subRes.ok) {
    throw new StripeApiError(subJson.error?.message ?? "Stripe subscription lookup failed.", subRes.status);
  }
  const periodStartUnix = subJson.items?.data?.[0]?.current_period_start;
  const periodEndUnix = subJson.items?.data?.[0]?.current_period_end;
  const invoiceId = subJson.latest_invoice?.id;
  const amountPaid = subJson.latest_invoice?.amount_paid;
  if (
    typeof periodStartUnix !== "number" ||
    typeof periodEndUnix !== "number" ||
    typeof invoiceId !== "string" ||
    typeof amountPaid !== "number"
  ) {
    return null;
  }

  const invRes = await fetch(`https://api.stripe.com/v1/invoices/${encodeURIComponent(invoiceId)}?expand[]=payments`, {
    headers: { Authorization: `Basic ${btoa(`${secretKey}:`)}` },
  });
  const invJson = (await invRes.json()) as {
    payments?: { data?: Array<{ payment?: { payment_intent?: string; type?: string } }> };
    error?: { message?: string };
  };
  if (!invRes.ok) {
    throw new StripeApiError(invJson.error?.message ?? "Stripe invoice lookup failed.", invRes.status);
  }
  const paymentIntentId = invJson.payments?.data?.find((p) => p.payment?.type === "payment_intent")?.payment?.payment_intent ?? null;

  return {
    invoiceId,
    amountPaid,
    periodStart: new Date(periodStartUnix * 1000).toISOString(),
    periodEnd: new Date(periodEndUnix * 1000).toISOString(),
    paymentIntentId,
  };
}

/**
 * Whole-cents proration over the CURRENT period only -- if `asOf` is at or
 * past periodEnd (shouldn't happen for a still-active subscription, but not
 * this function's job to assume), 0 unused time means 0 refund, not a
 * negative or NaN amount. `Math.round`, not truncation -- a customer's
 * unused-time refund should round in their favor at the half-cent boundary,
 * matching this codebase's general "the safe direction favors the person
 * being charged" posture (e.g. checkDataFreshness()'s own fail-closed
 * choice elsewhere).
 */
export function computeProratedRefundCents(amountPaidCents: number, periodStartIso: string, periodEndIso: string, asOf: Date): number {
  const periodStartMs = new Date(periodStartIso).getTime();
  const periodEndMs = new Date(periodEndIso).getTime();
  const totalMs = periodEndMs - periodStartMs;
  if (totalMs <= 0) return 0;
  const remainingMs = Math.max(0, Math.min(periodEndMs - asOf.getTime(), totalMs));
  return Math.round((amountPaidCents * remainingMs) / totalMs);
}

/** POST /v1/refunds against a PaymentIntent -- refunding by payment_intent
 * (rather than an older `charge` id) works regardless of how many charge
 * attempts a PaymentIntent went through, and is what getLatestInvoiceForSubscription()
 * above already resolves down to. */
export async function refundPaymentIntent(secretKey: string, paymentIntentId: string, amountCents: number): Promise<{ refundId: string }> {
  const body = new URLSearchParams();
  body.set("payment_intent", paymentIntentId);
  body.set("amount", String(amountCents));
  body.set("reason", "requested_by_customer");

  const res = await fetch("https://api.stripe.com/v1/refunds", {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${secretKey}:`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  const json = (await res.json()) as { id?: string; error?: { message?: string } };
  if (!res.ok || !json.id) {
    throw new StripeApiError(json.error?.message ?? "Stripe refund failed.", res.status);
  }
  return { refundId: json.id };
}

/** DELETE /v1/subscriptions/{id} -- immediate cancellation, deliberately NOT
 * updateSubscriptionCancelAtPeriodEnd()'s scheduling toggle. Account
 * deletion cuts access right now (status='deleted'), so the subscription
 * itself should stop right now too, not linger to the period end with
 * nothing left for it to gate. Stripe's own customer.subscription.deleted
 * webhook (already handled, unchanged) fires from this the same as it does
 * at a natural period end. */
export async function cancelSubscriptionImmediately(secretKey: string, subscriptionId: string): Promise<void> {
  const res = await fetch(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    method: "DELETE",
    headers: { Authorization: `Basic ${btoa(`${secretKey}:`)}` },
  });
  const json = (await res.json()) as { status?: string; error?: { message?: string } };
  if (!res.ok || json.status !== "canceled") {
    throw new StripeApiError(json.error?.message ?? "Stripe subscription cancellation failed.", res.status);
  }
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

  // AuditLab BILL-2, 2026-08-05: during a Stripe webhook-secret ROTATION,
  // Stripe signs each event with EVERY active secret and sends multiple
  // `v1=` pairs in the same header (e.g. "t=...,v1=AAAA,v1=BBBB") -- one per
  // secret. A plain `Record<string,string>` keyed by field name silently
  // keeps only the LAST one, so if our configured secret produced the
  // FIRST (discarded) signature, every event fails verification for the
  // whole rotation window. That failure mode is exactly the wrong direction
  // for a webhook that flips a firm onto a paid plan: money taken,
  // `plan_tier` never updated, and nothing on our side would report it.
  // Collecting every `v1` and accepting any match (same as Stripe's own
  // official libraries do) closes this regardless of rotation state.
  const timestampParts: string[] = [];
  const v1s: string[] = [];
  for (const kv of sigHeader.split(",")) {
    const eq = kv.indexOf("=");
    if (eq === -1) continue;
    const name = kv.slice(0, eq).trim();
    const value = kv.slice(eq + 1).trim();
    if (name === "t") timestampParts.push(value);
    else if (name === "v1") v1s.push(value);
  }
  const timestampRaw = timestampParts[0];
  if (!timestampRaw || v1s.length === 0) return false;

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

  return v1s.some((v1) => timingSafeEqualHex(expectedHex, v1));
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
