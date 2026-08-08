/**
 * Two-factor authentication (2026-08-07, roadmap #53).
 *
 * RFC 6238 TOTP (HMAC-SHA1, 30s step, 6 digits, +/-1 step window) + RFC 4648
 * base32 codec, hand-rolled -- matching this codebase's existing "no npm
 * crypto package, Workers-native crypto.subtle only" convention
 * (password.ts/stripe.ts already use HMAC via crypto.subtle for their own
 * purposes). No base32 codec existed anywhere in this codebase before this.
 *
 * HMAC-SHA1, not SHA256: RFC 6238's own default, and the one virtually
 * every real-world authenticator app (Google Authenticator, Authy,
 * 1Password, Microsoft Authenticator) assumes unless told otherwise via
 * the otpauth:// URI's algorithm param -- fighting that would trade away
 * compatibility for a security property TOTP's real protection (a
 * time-boxed, attempt-limited code, single-use in practice) doesn't
 * actually depend on.
 *
 * Also holds the secret-at-rest encryption (AES-GCM, keyed by the
 * TOTP_ENCRYPTION_KEY env secret, mirroring how PASSWORD_PEPPER hardens
 * password.ts) -- unlike a password, TOTP needs the secret back to
 * compute the current code, so hashing it (like a password) doesn't work;
 * it must be reversibly encrypted instead.
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 6;

// RFC 6238's own "network delay and clock drift" allowance -- checking
// counter-1, counter, counter+1 covers roughly +/-30-60s of clock skew
// without materially widening the brute-force window (still only 3
// valid codes at any instant, not a continuously-open range).
const TOTP_WINDOW_STEPS = 1;

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** A fresh random 20-byte (160-bit) secret -- RFC 4226's own recommended
 * HOTP/TOTP secret length -- base32-encoded for display/otpauth://
 * embedding. */
export function generateTotpSecretBase32(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return base32Encode(bytes);
}

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export function base32Decode(input: string): Uint8Array {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(output);
}

async function hmacSha1(keyBytes: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", keyBytes as BufferSource, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, message as BufferSource);
  return new Uint8Array(signature);
}

/** RFC 4226 Section 5.3 dynamic truncation, at a given 30-second-window
 * counter (RFC 6238's own layer on top of RFC 4226 HOTP: counter = time
 * since epoch, not an incrementing value). */
async function totpAtCounter(secretBase32: string, counter: number): Promise<string> {
  const keyBytes = base32Decode(secretBase32);
  const counterBytes = new Uint8Array(8);
  // Big-endian 64-bit counter -- only the low 32 bits are ever non-zero
  // for any counter this product will see this millennium (32 bits of
  // 30-second steps doesn't roll over until the year ~6429).
  const view = new DataView(counterBytes.buffer);
  view.setUint32(4, counter, false);
  const hmac = await hmacSha1(keyBytes, counterBytes);
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binaryCode =
    ((hmac[offset]! & 0x7f) << 24) | ((hmac[offset + 1]! & 0xff) << 16) | ((hmac[offset + 2]! & 0xff) << 8) | (hmac[offset + 3]! & 0xff);
  const code = binaryCode % 10 ** TOTP_DIGITS;
  return String(code).padStart(TOTP_DIGITS, "0");
}

/** The current 6-digit code for a secret, at a given instant (defaults to
 * now) -- what an authenticator app would be showing. Used only by
 * enrollment-confirm (proving the app was set up correctly) and tests --
 * never by verifyTotp() below, which recomputes its own candidates. */
export async function generateTotp(secretBase32: string, at: Date = new Date()): Promise<string> {
  const counter = Math.floor(at.getTime() / 1000 / TOTP_STEP_SECONDS);
  return totpAtCounter(secretBase32, counter);
}

/**
 * Verifies a submitted code against a +/-1 step window. Checks every
 * candidate (no early return on the first match) so response timing
 * can't leak which step, if any, matched.
 */
export async function verifyTotp(secretBase32: string, submittedCode: string, at: Date = new Date()): Promise<boolean> {
  const normalized = submittedCode.trim();
  if (!/^\d{6}$/.test(normalized)) return false;
  const counter = Math.floor(at.getTime() / 1000 / TOTP_STEP_SECONDS);
  const steps: number[] = [];
  for (let i = -TOTP_WINDOW_STEPS; i <= TOTP_WINDOW_STEPS; i++) steps.push(counter + i);
  const candidates = await Promise.all(steps.map((c) => totpAtCounter(secretBase32, c)));
  let matched = false;
  for (const candidate of candidates) {
    if (candidate === normalized) matched = true;
  }
  return matched;
}

/**
 * otpauth:// URI for "enter code manually" enrollment -- v1 deliberately
 * ships with NO QR code image: generating one correctly means vendoring a
 * real third-party QR-encoding algorithm (a genuine amount of new,
 * security-adjacent code to audit), and every mainstream authenticator
 * app already supports manual entry as an equal fallback. issuer/account
 * are both percent-encoded per the de facto Google Authenticator
 * key-URI format every mainstream app follows.
 */
export function buildOtpauthUri(secretBase32: string, accountLabel: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${accountLabel}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Secret-at-rest encryption (AES-GCM). Unlike a password, a TOTP secret
// must be recoverable -- verifying a code means re-deriving it from the
// secret, not comparing hashes -- so it's encrypted, not hashed.
// ---------------------------------------------------------------------------

const AES_GCM_IV_BYTES = 12;

async function importAesKey(rawKeyBase64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", fromBase64(rawKeyBase64) as BufferSource, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/**
 * Encrypts a base32 TOTP secret for storage. `memberId` is bound as AES-GCM
 * additional authenticated data -- a raw-SQL row-swap between two members'
 * encrypted secrets (or any tampering with which row this ciphertext is
 * attached to) fails decryption instead of silently succeeding. A fresh
 * random IV is generated per call, never derived from the key alone --
 * reusing an IV under the same key is a real AES-GCM confidentiality
 * break, not just a style preference.
 */
export async function encryptTotpSecret(
  secretBase32: string,
  memberId: string,
  encryptionKeyBase64: string
): Promise<{ ciphertextBase64: string; ivBase64: string }> {
  const key = await importAesKey(encryptionKeyBase64);
  const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
  const plaintext = new TextEncoder().encode(secretBase32);
  const aad = new TextEncoder().encode(memberId);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource, additionalData: aad as BufferSource }, key, plaintext as BufferSource);
  return { ciphertextBase64: toBase64(new Uint8Array(ciphertext)), ivBase64: toBase64(iv) };
}

/** Decrypts a stored secret. Returns null (never throws) on any failure --
 * wrong key, tampered ciphertext, or a memberId that doesn't match the
 * AAD it was encrypted with -- so a caller can fail closed the same way
 * every other "verify" function in this codebase does. */
export async function decryptTotpSecret(
  ciphertextBase64: string,
  ivBase64: string,
  memberId: string,
  encryptionKeyBase64: string
): Promise<string | null> {
  try {
    const key = await importAesKey(encryptionKeyBase64);
    const iv = fromBase64(ivBase64);
    const aad = new TextEncoder().encode(memberId);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as BufferSource, additionalData: aad as BufferSource },
      key,
      fromBase64(ciphertextBase64) as BufferSource
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Backup codes -- 8 single-use recovery codes generated at enrollment,
// shown once, hashed like every other single-use secret in this codebase
// (firm_login_tokens' own shape).
// ---------------------------------------------------------------------------

export const BACKUP_CODE_COUNT = 8;

/** Human-typeable: 10 chars from an unambiguous alphabet (no 0/O/1/I/L),
 * grouped for readability (XXXXX-XXXXX handled by the caller/UI, this
 * just returns the raw 10 chars). */
const BACKUP_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function generateBackupCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let code = "";
  for (const b of bytes) code += BACKUP_CODE_ALPHABET[b % BACKUP_CODE_ALPHABET.length];
  return code;
}

export function generateBackupCodes(count: number = BACKUP_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => generateBackupCode());
}

/** Same unsalted-SHA-256 rationale as store.ts's hashToken(): the input is
 * always a CSPRNG-generated value with real entropy (10 chars from a
 * 32-symbol alphabet = 50 bits), never a human-guessable secret, so a
 * single fast hash is the correct (not merely convenient) choice -- same
 * reasoning hashToken()'s own docstring gives for login/session tokens. */
export async function hashBackupCode(code: string): Promise<string> {
  const data = new TextEncoder().encode(code.toUpperCase().trim());
  const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}
