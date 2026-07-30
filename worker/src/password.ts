/**
 * Password hashing for firm admin accounts (2026-07-30, auth suite).
 *
 * PBKDF2-HMAC-SHA256 via native Workers Web Crypto. Deliberately NOT the
 * `hashToken()` SHA-256 in store.ts: that one hashes 256-bit CSPRNG values
 * (session/login tokens), where a single fast hash is correct because the
 * input is already unguessable. A human-chosen password is guessable, so it
 * needs a SLOW KDF with a per-user salt. Never route a password through
 * hashToken(), and never route a CSPRNG token through this.
 *
 * ## Why the work factor is 2 x 100,000 and not OWASP's 600,000
 *
 * Measured against the REAL Cloudflare edge on 2026-07-30 (local workerd
 * models neither limit -- it ran 600,000 iterations happily, which would
 * have thrown on every production login had it been trusted):
 *
 *   - A single deriveBits() call hard-caps at 100,000 iterations. Above
 *     that: `NotSupportedError: Pbkdf2 failed: iteration counts above
 *     100000 are not supported`.
 *   - Chaining rounds gets past that cap, but the edge CPU budget then
 *     binds: 100k and 200k effective were 15/15 reliable under paced load,
 *     300k was 2/15, and 600k was 0/15 -- the failures being Cloudflare
 *     "error code: 1102 / Worker exceeded resource limits".
 *
 * So 200,000 effective is the honest reliable ceiling here, one third of
 * OWASP's 600,000 recommendation for this algorithm. That gap is real and
 * is documented rather than hidden. It is mitigated by: SSO being the
 * primary path for this product's M365/Google-heavy audience (no stored
 * credential at all), Turnstile + per-IP rate limiting blunting online
 * guessing, and the parameters below being stored PER USER so the factor
 * can be raised with a transparent re-hash and no migration.
 *
 * bcrypt/argon2 would be preferable but need a WASM dependency this
 * codebase has deliberately avoided since migration 0008.
 *
 * ## Chaining is composition, not a homebrew construction
 *
 * Each round runs standard PBKDF2 and feeds its derived key in as the next
 * round's input keying material, with the same salt. An attacker must
 * still perform all N rounds sequentially to test one candidate password,
 * so the work factor is additive. It cannot be weaker than a single round,
 * because producing round 1's output is a prerequisite for round 2.
 */

const PBKDF2_HASH = "SHA-256";
const DERIVED_BITS = 256;

/** Per-round iterations. 100,000 is the hard per-call ceiling the Workers
 * runtime enforces -- not a tuning choice, a platform limit. */
export const PASSWORD_ITERATIONS_PER_ROUND = 100_000;

/** Chained rounds -> 2 x 100,000 = 200,000 effective iterations. Raising
 * this to 3 pushed real requests into CPU-limit failures (2/15 success),
 * so 2 is the measured ceiling, not a guess. */
export const PASSWORD_ROUNDS = 2;

/** Written into `firms.password_algo`. Versioned so a future change to the
 * scheme is detectable per-row rather than silently reinterpreting old
 * hashes under new rules. */
export const PASSWORD_ALGO = "PBKDF2-SHA256-chained-v1";

export const MIN_PASSWORD_LEN = 12;

/** Guards against a pathological input being carried around in memory.
 * PBKDF2's cost is independent of input length, so this is hygiene, not a
 * CPU defense. */
export const MAX_PASSWORD_LEN = 200;

export interface PasswordRecord {
  algo: string;
  salt: string;
  iterations: number;
  rounds: number;
  hash: string;
}

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

/**
 * NIST SP 800-63B posture: enforce LENGTH, not composition. No "must have
 * a symbol and a digit" rules -- those measurably push people toward
 * predictable patterns (`Password1!`) and are explicitly discouraged.
 * Control characters are rejected to match this codebase's existing
 * `hasControlChars()` input convention; every other printable character,
 * including spaces and unicode, is allowed so passphrases work.
 */
export function validatePasswordStrength(password: string): { ok: true } | { ok: false; error: string } {
  if (typeof password !== "string" || password.length === 0) {
    return { ok: false, error: "Please choose a password." };
  }
  if (password.length < MIN_PASSWORD_LEN) {
    return { ok: false, error: `Please use at least ${MIN_PASSWORD_LEN} characters.` };
  }
  if (password.length > MAX_PASSWORD_LEN) {
    return { ok: false, error: `Please use ${MAX_PASSWORD_LEN} characters or fewer.` };
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(password)) {
    return { ok: false, error: "That password contains characters we can't accept." };
  }
  return { ok: true };
}

async function deriveChained(
  password: string,
  salt: Uint8Array,
  iterations: number,
  rounds: number
): Promise<Uint8Array> {
  const enc = new TextEncoder();
  // Uint8Array (not the raw string) so the first round's input is treated
  // identically to every later round's, which is raw key material.
  let material: Uint8Array = enc.encode(password);
  for (let i = 0; i < rounds; i++) {
    const key = await crypto.subtle.importKey("raw", material as BufferSource, "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: PBKDF2_HASH },
      key,
      DERIVED_BITS
    );
    material = new Uint8Array(bits);
  }
  return material;
}

/** Hashes with a FRESH 16-byte CSPRNG salt. Returns everything needed to
 * verify later, so the caller persists parameters alongside the hash and
 * nothing about the scheme is implied by the storage format. */
export async function hashPassword(password: string): Promise<PasswordRecord> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const derived = await deriveChained(password, salt, PASSWORD_ITERATIONS_PER_ROUND, PASSWORD_ROUNDS);
  return {
    algo: PASSWORD_ALGO,
    salt: toBase64(salt),
    iterations: PASSWORD_ITERATIONS_PER_ROUND,
    rounds: PASSWORD_ROUNDS,
    hash: toBase64(derived),
  };
}

/**
 * Length-independent, value-independent comparison. `===` on the base64
 * strings would short-circuit at the first differing character and leak,
 * via timing, how much of a guessed hash prefix was correct.
 *
 * Length is folded into the result rather than early-returning on a length
 * mismatch, so even that much isn't signalled by timing.
 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

/**
 * Verifies against a stored record, re-deriving with THAT record's own
 * parameters (not the current defaults) -- which is what lets the work
 * factor be raised later without invalidating existing passwords.
 *
 * Returns false on any malformed/absent stored value rather than throwing:
 * a firm with no password set (SSO-only or magic-link-only) is a normal
 * state, and callers must not be able to distinguish "no password" from
 * "wrong password" by catching an exception.
 */
export async function verifyPassword(password: string, record: Partial<PasswordRecord> | null): Promise<boolean> {
  if (!record || !record.hash || !record.salt || !record.iterations || !record.rounds) return false;
  if (record.algo !== PASSWORD_ALGO) return false;
  if (typeof password !== "string" || password.length === 0 || password.length > MAX_PASSWORD_LEN) return false;

  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = fromBase64(record.salt);
    expected = fromBase64(record.hash);
  } catch {
    return false;
  }

  const derived = await deriveChained(password, salt, record.iterations, record.rounds);
  return constantTimeEqual(derived, expected);
}

/**
 * Burns comparable CPU to a real verification, for the "no such account"
 * branch of login.
 *
 * Without this, a wrong-email attempt returns fast (no KDF work) while a
 * right-email/wrong-password attempt takes ~120ms -- a trivially
 * measurable oracle that turns the login form into a firm-enumeration
 * tool, defeating the anti-enumeration posture the rest of this codebase
 * maintains. Must use the SAME parameters as a live hash so the timing
 * actually matches.
 */
export async function dummyVerifyForTiming(): Promise<void> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  await deriveChained("timing-equalization-placeholder", salt, PASSWORD_ITERATIONS_PER_ROUND, PASSWORD_ROUNDS);
}

/** True when a stored record predates the current scheme/work factor, so
 * the caller can transparently re-hash on a SUCCESSFUL login (the only
 * moment the plaintext is legitimately in hand). */
export function needsRehash(record: Partial<PasswordRecord> | null): boolean {
  if (!record || !record.hash) return false;
  return (
    record.algo !== PASSWORD_ALGO ||
    record.iterations !== PASSWORD_ITERATIONS_PER_ROUND ||
    record.rounds !== PASSWORD_ROUNDS
  );
}
