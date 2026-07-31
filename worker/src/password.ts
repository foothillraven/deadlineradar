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
 * OWASP's 600,000 recommendation for this algorithm.
 *
 * bcrypt/argon2 would be preferable but need a WASM dependency this
 * codebase has deliberately avoided since migration 0008. Web Crypto in
 * Workers offers only PBKDF2 and HKDF for this purpose, and HKDF is an
 * extract-and-expand KDF explicitly NOT intended for passwords.
 *
 * ## Why chaining is sound (argument corrected after security review)
 *
 * Let F(x) = PBKDF2-HMAC-SHA256(P=x, S=salt, c=100000, dkLen=32). We store
 * F(F(pw)). The security argument is NOT merely "round 2 needs round 1's
 * output" -- sequential dependency alone would not establish that no
 * entropy is lost. The decisive point is:
 *
 *   PBKDF2-HMAC-SHA256's own internal state is ALREADY exactly 256 bits.
 *   Standard PBKDF2 computes U_i = HMAC(K, U_{i-1}) with each U_i 32 bytes,
 *   so a single 200,000-iteration call passes through 200,000 successive
 *   256-bit states. Chaining passes through the same size of state at the
 *   round boundary, adding no bottleneck the reference construction does
 *   not already have. The "composition through a 256-bit value" objection
 *   would equally condemn stock PBKDF2.
 *
 * Reusing the salt across rounds is harmless because in PBKDF2 the
 * PASSWORD is the HMAC key and salt||INT(i) is the message: the two rounds
 * MAC the same message under DIFFERENT keys, which is not a weakness. No
 * length-extension concern arises because nothing computes raw
 * SHA256(secret||data); PBKDF2 only ever calls HMAC.
 *
 * Chaining N rounds is therefore equivalent in security to a single
 * PBKDF2 at N x 100,000 iterations, up to negligible (~2^-256) terms.
 *
 * ## The pepper closes the 200k-vs-600k gap for the threat that matters
 *
 * Iterations only matter against an attacker doing OFFLINE guessing after
 * stealing the database. A pepper -- an HMAC key held as a Worker secret,
 * never in D1 -- means a stolen D1 snapshot alone is not attackable at any
 * work factor, because the attacker also needs a secret from a different
 * trust domain. That converts the shortfall from a real deficit into an
 * irrelevant one, for the cost of one extra HMAC (microseconds).
 *
 * Pepper is OPTIONAL: if PASSWORD_PEPPER is unset we write v1 and nothing
 * changes. This is what makes it safe to adopt without a flag day.
 *
 * ## Algorithm versioning is real, not decorative
 *
 * An earlier version stored `password_algo` per row and claimed a
 * transparent-upgrade story, but verifyPassword() rejected ANY record
 * whose algo differed from the current one BEFORE needsRehash() could
 * fire. That made the upgrade branch unreachable: bumping the algo would
 * have turned every correct password into "invalid credentials" with no
 * migration path. Security review caught it. Verification now DISPATCHES
 * on the stored algo (see ALGOS), so old records keep verifying and get
 * re-hashed to the current algo on their next successful login.
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

/** Original scheme: chained PBKDF2, no normalization, no pepper. Still
 * verifiable forever -- rows written before v2 must keep working. */
export const PASSWORD_ALGO_V1 = "PBKDF2-SHA256-chained-v1";

/** Adds NFKC normalization of the input and an HMAC pepper over the
 * derived output. Only writable when a pepper is configured. */
export const PASSWORD_ALGO_V2 = "PBKDF2-SHA256-chained-v2-nfkc-pepper";

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
  if (/[\x00-\x1f\x7f]/.test(password)) {
    return { ok: false, error: "That password contains characters we can't accept." };
  }
  return { ok: true };
}

async function deriveChained(
  material0: Uint8Array,
  salt: Uint8Array,
  iterations: number,
  rounds: number
): Promise<Uint8Array> {
  let material: Uint8Array = material0;
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

async function applyPepper(derived: Uint8Array, pepper: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pepper) as BufferSource,
    { name: "HMAC", hash: PBKDF2_HASH },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, derived as BufferSource);
  return new Uint8Array(sig);
}

/**
 * One entry per algorithm we can still VERIFY. Adding a new scheme means
 * adding an entry and pointing `currentAlgo()` at it -- never removing an
 * old one, or every account still on it is locked out.
 *
 * `needsPepper` records whether the scheme cannot be computed without the
 * secret, so verification can fail cleanly (rather than silently deriving
 * something different) if the pepper is ever missing.
 */
const ALGOS: Record<
  string,
  { needsPepper: boolean; derive: (pw: string, salt: Uint8Array, it: number, rounds: number, pepper?: string) => Promise<Uint8Array> }
> = {
  [PASSWORD_ALGO_V1]: {
    needsPepper: false,
    derive: async (pw, salt, it, rounds) => deriveChained(new TextEncoder().encode(pw), salt, it, rounds),
  },
  [PASSWORD_ALGO_V2]: {
    needsPepper: true,
    // NFKC first: the SAME passphrase typed on macOS (NFD) and Windows
    // (NFC) is different bytes otherwise, and would fail to verify across
    // devices. NIST SP 800-63B 5.1.1.2 says verifiers SHOULD normalize.
    derive: async (pw, salt, it, rounds, pepper) => {
      const derived = await deriveChained(new TextEncoder().encode(pw.normalize("NFKC")), salt, it, rounds);
      return applyPepper(derived, pepper as string);
    },
  },
};

/** The algorithm new hashes are written with. v2 only when a pepper is
 * configured -- otherwise v2 could not be verified later, which would be a
 * far worse failure than simply not having a pepper. */
export function currentAlgo(pepper?: string): string {
  return pepper ? PASSWORD_ALGO_V2 : PASSWORD_ALGO_V1;
}

/** Hashes with a FRESH 16-byte CSPRNG salt. Returns everything needed to
 * verify later, so the caller persists parameters alongside the hash and
 * nothing about the scheme is implied by the storage format. */
export async function hashPassword(password: string, pepper?: string): Promise<PasswordRecord> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const algo = currentAlgo(pepper);
  const spec = ALGOS[algo] as (typeof ALGOS)[string];
  const derived = await spec.derive(password, salt, PASSWORD_ITERATIONS_PER_ROUND, PASSWORD_ROUNDS, pepper);
  return {
    algo,
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
 * algorithm and parameters -- which is what lets the scheme be upgraded
 * without invalidating existing passwords.
 *
 * Returns false on any malformed/absent stored value rather than throwing:
 * a firm with no password set (SSO-only or magic-link-only) is a normal
 * state, and callers must not be able to distinguish "no password" from
 * "wrong password" by catching an exception.
 *
 * IMPORTANT: callers must reject out-of-range candidate lengths BEFORE
 * reaching this function, uniformly for every account. An earlier version
 * short-circuited here on length, which inverted the login handler's
 * timing and turned it into a firm-enumeration oracle (found by security
 * review, reproduced end to end). There is deliberately no length guard in
 * this function's fast path for that reason -- see
 * handleFirmPasswordLogin().
 */
export async function verifyPassword(
  password: string,
  record: Partial<PasswordRecord> | null,
  pepper?: string
): Promise<boolean> {
  if (!record || !record.hash || !record.salt || !record.iterations || !record.rounds || !record.algo) return false;
  if (typeof password !== "string") return false;

  const spec = ALGOS[record.algo];
  if (!spec) return false;
  // A v2 record cannot be checked without the secret it was peppered with.
  if (spec.needsPepper && !pepper) return false;

  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = fromBase64(record.salt);
    expected = fromBase64(record.hash);
  } catch {
    return false;
  }

  // Clamp stored parameters. Only reachable via a corrupted/compromised
  // DB, but an absurd iteration count would otherwise CPU-limit every
  // login attempt for that one account.
  if (record.iterations > PASSWORD_ITERATIONS_PER_ROUND || record.rounds > 8) return false;

  const derived = await spec.derive(password, salt, record.iterations, record.rounds, pepper);
  return constantTimeEqual(derived, expected);
}

/**
 * Burns comparable CPU to a real verification, for the "no such account"
 * branch of login.
 *
 * Without this, a wrong-email attempt returns fast (no KDF work) while a
 * right-email/wrong-password attempt takes ~120ms -- a trivially
 * measurable oracle that turns the login form into a firm-enumeration
 * tool. Uses the CURRENT algorithm's parameters, which match what any live
 * record uses (iterations/rounds are fixed; the pepper HMAC is
 * microseconds and does not shift the timing).
 */
export async function dummyVerifyForTiming(pepper?: string): Promise<void> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const algo = currentAlgo(pepper);
  const spec = ALGOS[algo] as (typeof ALGOS)[string];
  await spec.derive(
    "timing-equalization-placeholder",
    salt,
    PASSWORD_ITERATIONS_PER_ROUND,
    PASSWORD_ROUNDS,
    pepper
  );
}

/** True when a stored record predates the current scheme or work factor,
 * so the caller can transparently re-hash on a SUCCESSFUL login (the only
 * moment the plaintext is legitimately in hand). Now genuinely reachable
 * for an algorithm change, which it was not before -- see this module's
 * header. */
export function needsRehash(record: Partial<PasswordRecord> | null, pepper?: string): boolean {
  if (!record || !record.hash) return false;
  return (
    record.algo !== currentAlgo(pepper) ||
    record.iterations !== PASSWORD_ITERATIONS_PER_ROUND ||
    record.rounds !== PASSWORD_ROUNDS
  );
}
