import { describe, it, expect, vi } from "vitest";
import { verifyTurnstile } from "../src/validation";

function okResponse(success: boolean): Response {
  return new Response(JSON.stringify({ success }), { status: 200 });
}

describe("verifyTurnstile -- allowMissingToken (2026-08-05, ad-blocker graceful degradation)", () => {
  it("no secret configured: always passes regardless of token or the flag", async () => {
    expect(await verifyTurnstile(undefined, undefined)).toBe(true);
    expect(await verifyTurnstile("some-token", undefined)).toBe(true);
    expect(await verifyTurnstile(undefined, undefined, true)).toBe(true);
  });

  it("secret configured, no token, flag defaulted (false): fails closed -- unchanged behavior", async () => {
    expect(await verifyTurnstile(undefined, "secret")).toBe(false);
    expect(await verifyTurnstile("", "secret", false)).toBe(false);
  });

  it("secret configured, no token, allowMissingToken=true: passes -- the ad-blocker case", async () => {
    expect(await verifyTurnstile(undefined, "secret", true)).toBe(true);
    expect(await verifyTurnstile("", "secret", true)).toBe(true);
  });

  it("a token that WAS provided still goes through real verification even with allowMissingToken=true -- this only forgives an absent token, never a bad one", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse(false));
    try {
      expect(await verifyTurnstile("a-real-but-invalid-token", "secret", true)).toBe(false);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("a valid provided token still passes with allowMissingToken=true", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse(true));
    try {
      expect(await verifyTurnstile("a-real-valid-token", "secret", true)).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
