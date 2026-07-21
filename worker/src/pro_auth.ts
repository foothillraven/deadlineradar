/**
 * DeadlineRadar Pro -- password hashing + session helpers.
 *
 * PBKDF2-SHA256 via Web Crypto (crypto.subtle) -- chosen because it's
 * natively available in the Workers runtime with zero external dependency,
 * unlike bcrypt/scrypt which need a WASM or pure-JS library. Not "the only
 * sound choice," but a real, standard, NIST-recommended KDF with no new
 * supply-chain surface for this codebase.
 */

// OWASP's current (2023+) minimum recommendation for PBKDF2-SHA256 is
// 600,000 iterations. Stored per-row in accounts.password_iterations (see
// migration 0007) specifically so this constant can be raised later without
// invalidating already-hashed passwords -- verifyPassword always re-derives
// using the iteration count THAT ROW was hashed with, never this constant.
export const PBKDF2_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const DERIVED_KEY_BITS = 256;

function toBase64(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const b of arr) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const arr = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
  return arr;
}

async function deriveBits(password: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  return crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    keyMaterial,
    DERIVED_KEY_BITS
  );
}

export interface HashedPassword {
  hash: string; // base64
  salt: string; // base64
  iterations: number;
}

export async function hashPassword(password: string): Promise<HashedPassword> {
  const saltBytes = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(saltBytes);
  const derived = await deriveBits(password, saltBytes, PBKDF2_ITERATIONS);
  return {
    hash: toBase64(derived),
    salt: toBase64(saltBytes),
    iterations: PBKDF2_ITERATIONS,
  };
}

/**
 * Constant-time-ish comparison isn't strictly necessary here (the derived
 * output is compared as full base64 strings after an expensive KDF already
 * dominates timing), but we still avoid short-circuiting `===` on raw bytes
 * by comparing the base64 strings directly -- matches how this codebase's
 * token lookups already work (a DB index equality check, not a manual byte
 * loop), same reasoning: the D1 query is the actual secret-comparison
 * surface, this function only checks the KDF output.
 */
export async function verifyPassword(
  password: string,
  storedHashB64: string,
  storedSaltB64: string,
  iterations: number
): Promise<boolean> {
  const saltBytes = fromBase64(storedSaltB64);
  const derived = await deriveBits(password, saltBytes, iterations);
  return toBase64(derived) === storedHashB64;
}

// Same minimums as a real signup form would want -- not configurable per
// caller, deliberately, so there's exactly one password policy in this
// codebase to reason about.
export const MIN_PASSWORD_LEN = 10;
export const MAX_PASSWORD_LEN = 256; // generous ceiling, prevents a pathological-length KDF input

export function isValidPassword(password: string): boolean {
  return password.length >= MIN_PASSWORD_LEN && password.length <= MAX_PASSWORD_LEN;
}

// Session lifetime: a 14-day IDLE timeout, NOT an absolute cap from
// created_at -- pro_store.ts's resolveSession() slides expires_at forward by
// this same amount on every authenticated request, so a session in
// continuous use never expires. This matches the migration comment's own
// "no separate cron needed at MVP scale" framing (an idle-only design), but
// note for anyone extending this: there is currently no ceiling on total
// session lifetime, only on time since last use. If an absolute cap is
// wanted later, it needs a separate created_at check in resolveSession(),
// not a change here (this constant only sets the idle window's length).
export const SESSION_LIFETIME_SECONDS = 60 * 60 * 24 * 14; // 14 days from last activity

export function sessionCookieValue(sessionId: string): string {
  // HttpOnly (JS can't read it -- closes an XSS-exfiltration path even if a
  // future page has an XSS bug elsewhere), Secure (HTTPS-only, this site has
  // no HTTP origin anyway), SameSite=Lax (blocks cross-site POST/CSRF while
  // still allowing normal top-level navigation, e.g. an emailed verify link).
  const maxAge = SESSION_LIFETIME_SECONDS;
  return `dr_session=${sessionId}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

export function clearSessionCookie(): string {
  return `dr_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export function parseSessionCookie(request: Request): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName === "dr_session") return rawValue.join("=") || null;
  }
  return null;
}
