import { describe, it, expect } from "vitest";
import {
  hashPassword,
  verifyPassword,
  constantTimeEqual,
  validatePasswordStrength,
  needsRehash,
  dummyVerifyForTiming,
  PASSWORD_ALGO,
  PASSWORD_ROUNDS,
  PASSWORD_ITERATIONS_PER_ROUND,
  MIN_PASSWORD_LEN,
  MAX_PASSWORD_LEN,
} from "../src/password";

const GOOD = "correct horse battery staple";

describe("password hashing -- platform limits (these guard a REAL production failure mode)", () => {
  it("never exceeds the Workers per-call PBKDF2 ceiling of 100,000 iterations", () => {
    // Above 100k the edge throws NotSupportedError on EVERY login. Local
    // workerd does NOT enforce this, so only an explicit assertion catches
    // a future 'let's follow OWASP and bump to 600k' change.
    expect(PASSWORD_ITERATIONS_PER_ROUND).toBeLessThanOrEqual(100_000);
  });

  it("keeps total effective iterations within the measured CPU-reliable ceiling of 200,000", () => {
    // 300k measured 2/15 success under paced load (Cloudflare error 1102,
    // CPU exceeded); 200k measured 15/15. Raising ROUNDS without re-probing
    // the edge would reintroduce intermittent login failures.
    expect(PASSWORD_ROUNDS * PASSWORD_ITERATIONS_PER_ROUND).toBeLessThanOrEqual(200_000);
  });

  it("actually derives successfully at the configured work factor in the worker runtime", async () => {
    const rec = await hashPassword(GOOD);
    expect(rec.hash.length).toBeGreaterThan(0);
    expect(rec.iterations).toBe(PASSWORD_ITERATIONS_PER_ROUND);
    expect(rec.rounds).toBe(PASSWORD_ROUNDS);
  });
});

describe("password hashing -- core correctness", () => {
  it("verifies a correct password", async () => {
    const rec = await hashPassword(GOOD);
    expect(await verifyPassword(GOOD, rec)).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const rec = await hashPassword(GOOD);
    expect(await verifyPassword("correct horse battery stapl", rec)).toBe(false);
    expect(await verifyPassword(GOOD + "x", rec)).toBe(false);
    expect(await verifyPassword("", rec)).toBe(false);
  });

  it("uses a fresh random salt per hash, so identical passwords never collide", async () => {
    const a = await hashPassword(GOOD);
    const b = await hashPassword(GOOD);
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
    // ...and each still verifies against its own salt
    expect(await verifyPassword(GOOD, a)).toBe(true);
    expect(await verifyPassword(GOOD, b)).toBe(true);
  });

  it("is case- and whitespace-sensitive (no silent normalization of secrets)", async () => {
    const rec = await hashPassword(GOOD);
    expect(await verifyPassword(GOOD.toUpperCase(), rec)).toBe(false);
    expect(await verifyPassword(" " + GOOD, rec)).toBe(false);
    expect(await verifyPassword(GOOD + " ", rec)).toBe(false);
  });

  it("supports unicode passphrases round-trip", async () => {
    const pw = "correcto caballo batería grapa ✓✓";
    const rec = await hashPassword(pw);
    expect(await verifyPassword(pw, rec)).toBe(true);
    expect(await verifyPassword("correcto caballo bateria grapa ✓✓", rec)).toBe(false);
  });
});

describe("password verification -- must never throw or leak on malformed input", () => {
  it("returns false (not a throw) for a firm with NO password set -- SSO-only/magic-link-only is a normal state", async () => {
    expect(await verifyPassword(GOOD, null)).toBe(false);
    expect(await verifyPassword(GOOD, {})).toBe(false);
    expect(await verifyPassword(GOOD, { hash: "x" })).toBe(false);
  });

  it("returns false for a corrupt/non-base64 stored value rather than throwing", async () => {
    const rec = await hashPassword(GOOD);
    expect(await verifyPassword(GOOD, { ...rec, hash: "!!!not base64!!!" })).toBe(false);
    expect(await verifyPassword(GOOD, { ...rec, salt: "!!!not base64!!!" })).toBe(false);
  });

  it("refuses a record whose algo is not the current scheme, instead of reinterpreting it", async () => {
    const rec = await hashPassword(GOOD);
    expect(await verifyPassword(GOOD, { ...rec, algo: "PBKDF2-SHA256-chained-v0" })).toBe(false);
    expect(await verifyPassword(GOOD, { ...rec, algo: "bcrypt" })).toBe(false);
  });

  it("rejects an over-long candidate without attempting derivation", async () => {
    const rec = await hashPassword(GOOD);
    expect(await verifyPassword("a".repeat(MAX_PASSWORD_LEN + 1), rec)).toBe(false);
  });

  it("does NOT accept a different password that shares the stored salt (salt is not the secret)", async () => {
    const rec = await hashPassword(GOOD);
    expect(await verifyPassword("entirely different password!", rec)).toBe(false);
  });
});

describe("constantTimeEqual", () => {
  it("is true only for identical byte arrays", () => {
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
  });

  it("is false for differing lengths, including prefix relationships", () => {
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2]))).toBe(false);
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
    expect(constantTimeEqual(new Uint8Array([]), new Uint8Array([0]))).toBe(false);
  });

  it("is true for two empty arrays", () => {
    expect(constantTimeEqual(new Uint8Array([]), new Uint8Array([]))).toBe(true);
  });

  it("detects a difference in the FINAL byte (i.e. it does not stop early)", () => {
    const a = new Uint8Array(32).fill(7);
    const b = new Uint8Array(32).fill(7);
    b[31] = 8;
    expect(constantTimeEqual(a, b)).toBe(false);
  });
});

describe("validatePasswordStrength", () => {
  it("accepts a long passphrase with no composition requirements (NIST SP 800-63B posture)", () => {
    expect(validatePasswordStrength("all lowercase words no digits").ok).toBe(true);
  });

  it(`rejects anything shorter than ${MIN_PASSWORD_LEN}`, () => {
    expect(validatePasswordStrength("a".repeat(MIN_PASSWORD_LEN - 1)).ok).toBe(false);
    expect(validatePasswordStrength("a".repeat(MIN_PASSWORD_LEN)).ok).toBe(true);
  });

  it(`rejects anything longer than ${MAX_PASSWORD_LEN}`, () => {
    expect(validatePasswordStrength("a".repeat(MAX_PASSWORD_LEN)).ok).toBe(true);
    expect(validatePasswordStrength("a".repeat(MAX_PASSWORD_LEN + 1)).ok).toBe(false);
  });

  it("rejects an empty password", () => {
    expect(validatePasswordStrength("").ok).toBe(false);
  });

  it("rejects control characters (NUL, newline, DEL) but allows spaces", () => {
    expect(validatePasswordStrength("abcdefghijkl\x00mno").ok).toBe(false);
    expect(validatePasswordStrength("abcdefghijkl\nmno").ok).toBe(false);
    expect(validatePasswordStrength("abcdefghijkl\x7fmno").ok).toBe(false);
    expect(validatePasswordStrength("has spaces in it").ok).toBe(true);
  });
});

describe("needsRehash -- transparent work-factor upgrades", () => {
  it("is false for a record written by the current scheme", async () => {
    const rec = await hashPassword(GOOD);
    expect(needsRehash(rec)).toBe(false);
  });

  it("is true when algo, iterations, or rounds drift from current settings", async () => {
    const rec = await hashPassword(GOOD);
    expect(needsRehash({ ...rec, algo: "old-scheme" })).toBe(true);
    expect(needsRehash({ ...rec, iterations: 1000 })).toBe(true);
    expect(needsRehash({ ...rec, rounds: 1 })).toBe(true);
  });

  it("is false when there is no password at all (nothing to upgrade)", () => {
    expect(needsRehash(null)).toBe(false);
    expect(needsRehash({})).toBe(false);
  });
});

describe("dummyVerifyForTiming -- anti-enumeration on the login form", () => {
  it("completes without throwing, so the no-such-account branch can always call it", async () => {
    await expect(dummyVerifyForTiming()).resolves.toBeUndefined();
  });

  it("costs the same order of work as a real verification (the point of it)", async () => {
    const rec = await hashPassword(GOOD);

    const t0 = Date.now();
    await verifyPassword(GOOD, rec);
    const realMs = Date.now() - t0;

    const t1 = Date.now();
    await dummyVerifyForTiming();
    const dummyMs = Date.now() - t1;

    // Loose bound on purpose: this asserts the dummy is not trivially
    // cheap (which would restore the enumeration oracle), not that the two
    // are indistinguishable to a precise attacker. Workers also freezes
    // Date.now() between I/O, so both can legitimately read 0 -- in which
    // case there is no measurable difference to assert on either.
    if (realMs > 0 || dummyMs > 0) {
      expect(dummyMs).toBeGreaterThanOrEqual(realMs / 4);
    }
  });
});
