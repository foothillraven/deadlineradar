/**
 * Roadmap #53 (2026-08-07): TOTP/base32/AES-GCM module, tested against
 * PUBLISHED external test vectors (RFC 6238 Appendix B, RFC 4648 Section
 * 10) wherever possible -- a pure round-trip-with-itself test would pass
 * even if the whole implementation shared one consistent bug (e.g. wrong
 * endianness, wrong truncation offset) that happened to cancel out
 * between encode/decode or generate/verify.
 */
import { describe, expect, it } from "vitest";
import {
  base32Encode,
  base32Decode,
  generateTotp,
  verifyTotp,
  generateTotpSecretBase32,
  buildOtpauthUri,
  encryptTotpSecret,
  decryptTotpSecret,
  generateBackupCode,
  generateBackupCodes,
  hashBackupCode,
  BACKUP_CODE_COUNT,
} from "../src/totp";

describe("base32 codec -- RFC 4648 Section 10 published test vectors", () => {
  const vectors: Array<[string, string]> = [
    ["", ""],
    ["f", "MY"],
    ["fo", "MZXQ"],
    ["foo", "MZXW6"],
    ["foob", "MZXW6YQ"],
    ["fooba", "MZXW6YTB"],
    ["foobar", "MZXW6YTBOI"],
  ];

  it("encodes exactly matching the RFC's own vectors (unpadded)", () => {
    for (const [input, expected] of vectors) {
      expect(base32Encode(new TextEncoder().encode(input))).toBe(expected);
    }
  });

  it("decodes the RFC's own vectors back to the original bytes", () => {
    for (const [input, encoded] of vectors) {
      expect(new TextDecoder().decode(base32Decode(encoded))).toBe(input);
    }
  });

  it("round-trips random byte sequences of every length 1-40", () => {
    for (let len = 1; len <= 40; len++) {
      const bytes = crypto.getRandomValues(new Uint8Array(len));
      const decoded = base32Decode(base32Encode(bytes));
      expect(Array.from(decoded)).toEqual(Array.from(bytes));
    }
  });

  it("is case-insensitive and ignores non-alphabet characters on decode (a real person retyping a secret)", () => {
    const encoded = base32Encode(new TextEncoder().encode("foobar"));
    const messy = encoded.toLowerCase().split("").join(" ") + "="; // spaces + padding + lowercase
    expect(new TextDecoder().decode(base32Decode(messy))).toBe("foobar");
  });
});

describe("TOTP generation -- RFC 6238 Appendix B published test vectors (SHA1, truncated to 6 digits)", () => {
  // RFC 6238's own seed, ASCII "12345678901234567890" (20 bytes), base32
  // encoded independently (via `python3 -c "import base64;
  // print(base64.b32encode(b'12345678901234567890').decode())"`) rather
  // than through this module's own base32Encode -- using the function
  // under test to prepare its own input would let a shared bug cancel out.
  const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

  // The RFC publishes 8-digit codes; (X mod 10^8) mod 10^6 = X mod 10^6,
  // so a 6-digit TOTP is exactly the last 6 digits of the RFC's own
  // 8-digit vector at the same instant -- not a coincidence, a property
  // of the modulo truncation both share.
  const vectors: Array<[number, string]> = [
    [59, "287082"],
    [1111111109, "081804"],
    [1111111111, "050471"],
    [1234567890, "005924"],
    [2000000000, "279037"],
  ];

  it("matches the RFC's own published codes at the RFC's own published instants", async () => {
    for (const [unixSeconds, expected] of vectors) {
      const code = await generateTotp(SECRET, new Date(unixSeconds * 1000));
      expect(code).toBe(expected);
    }
  });

  it("verifyTotp accepts the exact RFC vector as a submitted code", async () => {
    for (const [unixSeconds, expected] of vectors) {
      expect(await verifyTotp(SECRET, expected, new Date(unixSeconds * 1000))).not.toBeNull();
    }
  });
});

describe("verifyTotp -- window and input handling", () => {
  it("accepts the current code, and one step before/after (clock skew tolerance)", async () => {
    const secret = generateTotpSecretBase32();
    const now = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
    const before = new Date(now.getTime() - 30_000);
    const after = new Date(now.getTime() + 30_000);
    const code = await generateTotp(secret, now);
    expect(await verifyTotp(secret, code, now)).not.toBeNull();
    expect(await verifyTotp(secret, code, before)).not.toBeNull();
    expect(await verifyTotp(secret, code, after)).not.toBeNull();
  });

  it("rejects a code two or more steps away", async () => {
    const secret = generateTotpSecretBase32();
    const now = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
    const farAway = new Date(now.getTime() - 90_000);
    const code = await generateTotp(secret, farAway);
    expect(await verifyTotp(secret, code, now)).toBeNull();
  });

  it("rejects malformed input without throwing", async () => {
    const secret = generateTotpSecretBase32();
    expect(await verifyTotp(secret, "")).toBeNull();
    expect(await verifyTotp(secret, "12345")).toBeNull(); // too short
    expect(await verifyTotp(secret, "1234567")).toBeNull(); // too long
    expect(await verifyTotp(secret, "abcdef")).toBeNull(); // not digits
    expect(await verifyTotp(secret, "12 345")).toBeNull();
  });

  it("a code from a DIFFERENT secret never verifies", async () => {
    const secretA = generateTotpSecretBase32();
    const secretB = generateTotpSecretBase32();
    const now = new Date();
    const codeA = await generateTotp(secretA, now);
    expect(await verifyTotp(secretB, codeA, now)).toBeNull();
  });

  it("returns the actual matched 30-second-step counter, not just a boolean -- callers need this for replay prevention (AuditLab 2FA-1)", async () => {
    const secret = generateTotpSecretBase32();
    const now = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
    const expectedCounter = Math.floor(now.getTime() / 1000 / 30);
    const code = await generateTotp(secret, now);
    expect(await verifyTotp(secret, code, now)).toBe(expectedCounter);
  });
});

describe("buildOtpauthUri", () => {
  it("produces a well-formed otpauth:// URI carrying the secret, issuer, and fixed params", () => {
    const secret = generateTotpSecretBase32();
    const uri = buildOtpauthUri(secret, "owner@example.com", "DeadlineRadar");
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    const parsed = new URL(uri);
    expect(parsed.searchParams.get("secret")).toBe(secret);
    expect(parsed.searchParams.get("issuer")).toBe("DeadlineRadar");
    expect(parsed.searchParams.get("algorithm")).toBe("SHA1");
    expect(parsed.searchParams.get("digits")).toBe("6");
    expect(parsed.searchParams.get("period")).toBe("30");
  });
});

function randomKeyBase64(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

describe("AES-GCM secret-at-rest encryption", () => {
  const KEY = randomKeyBase64();

  it("round-trips: decrypting with the same member id and key recovers the exact secret", async () => {
    const secret = generateTotpSecretBase32();
    const { ciphertextBase64, ivBase64 } = await encryptTotpSecret(secret, "member-1", KEY);
    const decrypted = await decryptTotpSecret(ciphertextBase64, ivBase64, "member-1", KEY);
    expect(decrypted).toBe(secret);
  });

  it("a DIFFERENT member id (AAD mismatch) fails to decrypt -- a raw-SQL row-swap between two members fails closed", async () => {
    const secret = generateTotpSecretBase32();
    const { ciphertextBase64, ivBase64 } = await encryptTotpSecret(secret, "member-1", KEY);
    const decrypted = await decryptTotpSecret(ciphertextBase64, ivBase64, "member-2", KEY);
    expect(decrypted).toBeNull();
  });

  it("the wrong key fails to decrypt", async () => {
    const secret = generateTotpSecretBase32();
    const { ciphertextBase64, ivBase64 } = await encryptTotpSecret(secret, "member-1", KEY);
    const wrongKey = randomKeyBase64();
    const decrypted = await decryptTotpSecret(ciphertextBase64, ivBase64, "member-1", wrongKey);
    expect(decrypted).toBeNull();
  });

  it("tampered ciphertext fails closed rather than throwing", async () => {
    const secret = generateTotpSecretBase32();
    const { ciphertextBase64, ivBase64 } = await encryptTotpSecret(secret, "member-1", KEY);
    const tampered = ciphertextBase64.slice(0, -4) + (ciphertextBase64.slice(-4) === "AAAA" ? "BBBB" : "AAAA");
    const decrypted = await decryptTotpSecret(tampered, ivBase64, "member-1", KEY);
    expect(decrypted).toBeNull();
  });

  it("two encryptions of the same secret use different IVs (never reused)", async () => {
    const secret = generateTotpSecretBase32();
    const a = await encryptTotpSecret(secret, "member-1", KEY);
    const b = await encryptTotpSecret(secret, "member-1", KEY);
    expect(a.ivBase64).not.toBe(b.ivBase64);
    expect(a.ciphertextBase64).not.toBe(b.ciphertextBase64);
  });
});

describe("backup codes", () => {
  it("generates the expected count, all unique, from the unambiguous alphabet only", () => {
    const codes = generateBackupCodes();
    expect(codes.length).toBe(BACKUP_CODE_COUNT);
    expect(new Set(codes).size).toBe(BACKUP_CODE_COUNT);
    for (const code of codes) {
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{10}$/); // no 0/O/1/I/L
    }
  });

  it("hashBackupCode is deterministic and case/whitespace-insensitive", async () => {
    const code = generateBackupCode();
    const h1 = await hashBackupCode(code);
    const h2 = await hashBackupCode(` ${code.toLowerCase()} `);
    expect(h1).toBe(h2);
  });

  it("different codes hash to different values", async () => {
    const [a, b] = generateBackupCodes(2) as [string, string];
    expect(await hashBackupCode(a)).not.toBe(await hashBackupCode(b));
  });
});
