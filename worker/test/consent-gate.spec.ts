/**
 * Standing consent-gate directive (Devin, 2026-08-21, filed during the
 * DEAD-2 investigation): "NOTHING is sent without my consent." Tests the
 * reusable mechanism a future new send pass calls at its own entry point --
 * see requireSendApproval()'s own docstring in scheduler.ts for the full
 * reasoning. This is infrastructure for the NEXT new pass, not a retroactive
 * gate on the 8 passes already wired before this directive existed.
 */
import { describe, expect, it } from "vitest";
import { requireSendApproval } from "../src/scheduler";
import type { Env } from "../src/env";

function envWith(sendApprovedPasses: string | undefined): Env {
  return { SEND_APPROVED_PASSES: sendApprovedPasses } as Env;
}

describe("requireSendApproval -- fails closed by default", () => {
  it("SEND_APPROVED_PASSES unset -> held (false) for any pass name", () => {
    expect(requireSendApproval(envWith(undefined), "reminder")).toBe(false);
    expect(requireSendApproval(envWith(undefined), "adminDigest")).toBe(false);
  });

  it("SEND_APPROVED_PASSES empty string -> held (false)", () => {
    expect(requireSendApproval(envWith(""), "reminder")).toBe(false);
  });

  it("SEND_APPROVED_PASSES whitespace/comma-only -> held (false), not a crash", () => {
    expect(requireSendApproval(envWith(" , , "), "reminder")).toBe(false);
    expect(requireSendApproval(envWith(","), "reminder")).toBe(false);
  });

  it("a pass NOT named in the list -> held (false), even when other passes are approved", () => {
    expect(requireSendApproval(envWith("reminder,dripCourse"), "adminDigest")).toBe(false);
  });
});

describe("requireSendApproval -- unlocks only the named pass", () => {
  it("a pass named exactly in the list -> approved (true)", () => {
    expect(requireSendApproval(envWith("adminDigest"), "adminDigest")).toBe(true);
  });

  it("multiple comma-separated names, trimmed -- each resolves independently", () => {
    const env = envWith(" reminder , adminDigest ,dripCourse");
    expect(requireSendApproval(env, "reminder")).toBe(true);
    expect(requireSendApproval(env, "adminDigest")).toBe(true);
    expect(requireSendApproval(env, "dripCourse")).toBe(true);
    expect(requireSendApproval(env, "ruleChangeAlert")).toBe(false);
  });

  it("is an exact, case-sensitive match -- not a substring or prefix check", () => {
    const env = envWith("adminDigest");
    expect(requireSendApproval(env, "admindigest")).toBe(false);
    expect(requireSendApproval(env, "AdminDigest")).toBe(false);
    expect(requireSendApproval(env, "admin")).toBe(false);
    expect(requireSendApproval(env, "adminDigestV2")).toBe(false);
  });
});
