/**
 * AuditLab BILL-5 (HIGH, 2026-08-08): a failed refund used to silently skip
 * subscription cancellation (fixed in index.ts by reordering + separate
 * try/catch blocks -- no live-Stripe test infra exists in this codebase to
 * exercise that ordering end-to-end, see stripe.spec.ts's own scope, which
 * likewise only tests pure functions). This file covers the OTHER half of
 * BILL-5: the notification email's refundCents rendering, which is exactly
 * what AuditLab proved was broken -- a failed-refund state rendered
 * byte-identical to "nothing was owed", so the one signal meant to flag
 * "a human must reconcile this" was invisible.
 */
import { describe, it, expect } from "vitest";
import { buildAccountDeletionNotificationEmail } from "../src/emails";

function build(refundCents: number | null | "failed") {
  return buildAccountDeletionNotificationEmail({
    firmName: "Acme LLP",
    adminEmail: "admin@example.com",
    reason: "too expensive",
    detail: null,
    refundCents,
  });
}

describe("buildAccountDeletionNotificationEmail -- refundCents rendering", () => {
  it("renders '(none)' when genuinely nothing was owed", () => {
    const built = build(null);
    expect(built.textBody).toContain("Refund issued: (none)");
    expect(built.htmlBody).toContain("(none)");
  });

  it("renders the dollar amount when a refund succeeded", () => {
    const built = build(1234);
    expect(built.textBody).toContain("$12.34");
    expect(built.htmlBody).toContain("$12.34");
  });

  it("renders a DISTINCT 'REFUND FAILED' line when the attempt threw -- never '(none)'", () => {
    const built = build("failed");
    expect(built.textBody).toContain("REFUND FAILED");
    expect(built.textBody).toContain("reconcile manually");
    expect(built.htmlBody).toContain("REFUND FAILED");
    // The actual bug: this must never be indistinguishable from the
    // legitimate no-refund-owed case.
    expect(built.textBody).not.toContain("Refund issued: (none)");
  });

  it("the three states are pairwise distinguishable by substring", () => {
    const none = build(null).textBody;
    const some = build(500).textBody;
    const failed = build("failed").textBody;
    expect(none).not.toBe(some);
    expect(none).not.toBe(failed);
    expect(some).not.toBe(failed);
  });
});
