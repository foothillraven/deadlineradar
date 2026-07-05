/**
 * Input validation -- ported field-for-field from reminders/server.py's
 * module-level constants and helper functions. Read that file's own module
 * docstring for the full abuse-hardening rationale; this file only carries
 * the logic forward, not the reasoning already documented there.
 */

// Must match the hidden field name generate.py renders in every signup form
// (../reminders/server.py:87 HONEYPOT_FIELD_NAME).
export const HONEYPOT_FIELD_NAME = "hp_website";

// RFC 5321 5.3.1.3 upper bound -- server.py:161 MAX_EMAIL_LEN.
export const MAX_EMAIL_LEN = 254;

// Generous for a birth month/year/cohort/license id; not free-text --
// server.py:169 MAX_FIELD_LEN.
export const MAX_FIELD_LEN = 120;

// Cap the request body size -- server.py:175 MAX_BODY_BYTES. In the Python
// http.server original this bounded how much the server would read off the
// wire BEFORE parsing; in a Workers fetch handler there is no equivalent
// manual read loop to bound in advance (see index.ts's handleSubscribe for
// exactly where this is enforced instead: on the decoded body string length,
// after `request.text()` -- Workers/the underlying HTTP layer, not our own
// code, is what would reject a wildly-oversized request before it ever
// reaches this Worker in the first place).
export const MAX_BODY_BYTES = 8192;

export const MAX_FIRST_NAME_LEN = 60;

// Deliberately stricter than "contains an @ and a dot" -- rejects
// whitespace, control characters, multiple @ signs, and malformed domains
// outright. Byte-for-byte the same pattern as server.py:160's `_EMAIL_RE`.
const EMAIL_RE =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

// Any ASCII control character, including CR/LF -- server.py:167
// `_CONTROL_CHAR_RE`. Closes the door on header-injection-style and
// stored-XSS-style payloads regardless of which field they're smuggled in.
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

// server.py:75 SUPPORTED_STATE_SLUGS. New York is deliberately absent --
// its rule needs a fact (first registration date) this dataset doesn't have.
export const SUPPORTED_STATE_SLUGS: ReadonlySet<string> = new Set([
  "florida",
  "illinois",
  "pennsylvania",
  "georgia",
  "north-carolina",
  "michigan",
  "ohio",
  "california",
  "texas",
]);

export function hasControlChars(value: string): boolean {
  return CONTROL_CHAR_RE.test(value);
}

export function isValidEmail(email: string): boolean {
  return (
    email.length > 0 &&
    email.length <= MAX_EMAIL_LEN &&
    !hasControlChars(email) &&
    EMAIL_RE.test(email)
  );
}

// Whole-string optional-sign-then-digits, after trimming ASCII whitespace --
// matches Python's `int(str)` constructor semantics, which is what
// server.py's California/Texas birth-month validation actually relies on
// (`int(birth_month)` raising ValueError on garbage) BEFORE this port
// existed. Deliberately NOT `Number.parseInt()` + `Number.isInteger()`:
// `Number.parseInt("5abc", 10) === 5` (it stops at the first non-digit and
// happily returns a "valid" integer), where Python's `int("5abc")` raises.
// Using bare `Number.parseInt` here would silently accept
// birth_month="5<script>" as month 5 instead of the 400 the Python
// reference gives for the same input -- found during this port's own
// adversarial review; see index.ts's California/Texas branches for the
// call sites this closes the gap for.
const STRICT_INT_RE = /^[+-]?\d+$/;

export function strictParseInt(value: string): number | null {
  const trimmed = value.trim();
  if (!STRICT_INT_RE.test(trimmed)) return null;
  return Number.parseInt(trimmed, 10);
}

/**
 * server.py:52 `_sanitize_first_name()` / store.py's own independent copy
 * of the same function -- collapsed to one shared implementation here
 * (both Python copies did the identical thing; TS gains nothing by
 * duplicating it) but still called at BOTH the request-validation layer
 * (index.ts) and the storage layer (store.ts) independently, preserving the
 * original's defense-in-depth intent: a future caller that forgets to
 * validate still can't smuggle an oversized or non-printable name into
 * storage.
 */
export function sanitizeFirstName(firstName: string | null | undefined): string | null {
  if (!firstName) return null;
  const trimmed = firstName.trim();
  let out = "";
  for (const ch of trimmed) {
    if (isPrintableChar(ch)) out += ch;
    if (out.length >= MAX_FIRST_NAME_LEN) break;
  }
  const capped = out.slice(0, MAX_FIRST_NAME_LEN);
  return capped.length > 0 ? capped : null;
}

// Approximates Python's str.isprintable() closely enough for this
// defense-in-depth pass: excludes C0 controls, DEL, and C1 controls
// (zero-width/format characters like U+200B are NOT excluded here, same as
// Python's isprintable(), which treats most zero-width characters as
// "printable" too -- server.py already rejects true control chars earlier
// for every field; this is a second, independent, narrower check).
function isPrintableChar(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  if (code < 0x20 || code === 0x7f) return false;
  if (code >= 0x80 && code <= 0x9f) return false;
  return true;
}

export function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

// ---------------------------------------------------------------------------
// Per-IP rate limiting -- ported from reminders/server.py's
// `_check_rate_limit()`, backed by D1 instead of an in-memory dict.
// server.py's own docstring (and HOSTING_PROPOSAL.md) already flagged WHY the
// in-memory version can't carry over as-is: Workers instances don't share
// process memory across instances/requests. D1 gives a shared, durable
// counter instead.
//
// This Worker deliberately does NOT use Cloudflare's newer Workers Rate
// Limiting binding: its exact binding API shape is a recent addition this
// port's training data cannot confidently commit to sight-unseen, and
// getting a security control subtly wrong is worse than a table this
// Worker's own D1 binding (already required, already in wrangler.toml)
// guarantees will work. A D1-backed sliding window is slightly more I/O per
// request but needs no new binding, no new capability, and is fully
// covered by this repo's own test suite (see test/worker.spec.ts).
//
// Same two buckets, same limits as the Python original (server.py:134-135).
//
// Atomicity note: the check-then-insert below is a SINGLE SQL statement (an
// `INSERT ... SELECT ... WHERE (subquery count) < limit`), not a
// read-then-write pair in application code -- there is no TOCTOU window for
// two concurrent requests to both read "under the limit" and both insert.
// ---------------------------------------------------------------------------

export interface RateLimit {
  max: number;
  windowSeconds: number;
}

// server.py:134-135, unchanged.
export const RATE_LIMIT_SUBSCRIBE: RateLimit = { max: 5, windowSeconds: 600 };
export const RATE_LIMIT_ACTION: RateLimit = { max: 30, windowSeconds: 600 };

/** Returns true if this request is ALLOWED, false if it should be blocked. */
export async function checkRateLimit(
  db: D1Database,
  ip: string,
  bucket: string,
  limit: RateLimit
): Promise<boolean> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const cutoff = nowSeconds - limit.windowSeconds;

  // Trim expired hits for this ip+bucket before counting -- keeps the table
  // from growing unboundedly; scoped by the same indexed (ip, bucket) prefix
  // the count/insert below use, so this is cheap.
  await db.prepare("DELETE FROM rate_limit_hits WHERE ip = ?1 AND bucket = ?2 AND ts < ?3").bind(ip, bucket, cutoff).run();

  const result = await db
    .prepare(
      `INSERT INTO rate_limit_hits (ip, bucket, ts)
       SELECT ?1, ?2, ?3
       WHERE (SELECT COUNT(*) FROM rate_limit_hits WHERE ip = ?1 AND bucket = ?2 AND ts >= ?4) < ?5`
    )
    .bind(ip, bucket, nowSeconds, cutoff, limit.max)
    .run();

  // D1's run() result reports rows written as `meta.changes` -- 1 if the
  // conditional INSERT fired (allowed), 0 if the WHERE clause suppressed it
  // (limit already reached).
  return (result.meta.changes ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Cloudflare Turnstile hook -- ported from reminders/server.py's
// `_verify_turnstile()`. Inert (returns true / "verified") until a real
// secret key is configured via the `TURNSTILE_SECRET_KEY` Worker secret --
// same gating pattern as the Python original, and same posture as this
// repo's SendGrid key: never hardcoded, never committed, unset in Phase 1.
// The fetch() call below is therefore UNREACHABLE in the current
// (TURNSTILE_SECRET_KEY-unset) deployment -- it is also the ONLY fetch() in
// this entire Worker to anything other than D1.
// ---------------------------------------------------------------------------

const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TURNSTILE_TIMEOUT_MS = 5000; // server.py:113 `timeout=5`

export async function verifyTurnstile(token: string | undefined, secret: string | undefined): Promise<boolean> {
  if (!secret) return true; // not configured yet -- see module docstring above
  if (!token) return false;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TURNSTILE_TIMEOUT_MS);
  try {
    const body = new URLSearchParams({ secret, response: token });
    const resp = await fetch(TURNSTILE_VERIFY_URL, { method: "POST", body, signal: controller.signal });
    const result = (await resp.json()) as { success?: boolean };
    return Boolean(result.success);
  } catch {
    // Fail CLOSED -- if Turnstile's API is unreachable (or times out),
    // treat it as an unverified request rather than silently letting it
    // through. Matches server.py:116-119's except clause.
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}
