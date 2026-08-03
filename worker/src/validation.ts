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

// Firm-lead capture (POST /api/firm/lead) free-text field caps -- generous
// for a real firm name / a short staff-count hint like "8" or "10-15", not
// free-form prose.
export const MAX_FIRM_NAME_LEN = 200;
export const MAX_STAFF_COUNT_HINT_LEN = 20;

// Firm-dashboard staff license fields (2026-07-28 firm-dashboard MVP) --
// staff_label is the admin's own short display name for a roster entry
// (subscribers.staff_label, migration 0008), same "short, optional,
// cosmetic-only free text" category as the two constants above.
export const MAX_STAFF_LABEL_LEN = 120;

// CPE-hours tracker (migration 0009, 2026-07-30) -- same "short, optional,
// cosmetic-only free text" category as MAX_STAFF_LABEL_LEN above, this time
// for a CPE entry's provider/course description.
export const MAX_CPE_DESCRIPTION_LEN = 200;

// A per-entry sanity cap, not a real regulatory limit -- generous enough for
// a legitimate multi-day conference (e.g. a 40-hour week-long course) while
// still catching a fat-fingered or malicious value (a bare "800" typed where
// "8.0" was meant, or a deliberately absurd number meant to fake progress).
// This is NOT the state's own total_hours requirement (data/cpe_hours.json)
// -- that's compared separately, client-side, against the sum of real
// entries; this cap only bounds a single entry's plausibility.
export const MAX_CPE_HOURS_PER_ENTRY = 100;

const CPE_CATEGORIES = new Set(["general", "ethics", "other"]);

export function isValidCpeCategory(value: string): value is "general" | "ethics" | "other" {
  return CPE_CATEGORIES.has(value);
}

/** Whole-string decimal (one optional leading sign, digits, optional
 * .digits) -- deliberately stricter than `Number(value)`, which accepts
 * garbage like "" (0), "  12  " (12, silently trims), "0x10" (16, hex), and
 * "Infinity" -- none of which should ever count as a valid hours value.
 * Same "closes a gap Number()/parseFloat() leaves open" rationale as
 * strictParseInt()'s own docstring above. */
const STRICT_DECIMAL_RE = /^[+-]?\d+(\.\d+)?$/;

export function parseStrictCpeHours(value: string): number | null {
  const trimmed = value.trim();
  if (!STRICT_DECIMAL_RE.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return null;
  if (n <= 0 || n > MAX_CPE_HOURS_PER_ENTRY) return null;
  return n;
}

// Deliberately stricter than "contains an @ and a dot" -- rejects
// whitespace, control characters, multiple @ signs, and malformed domains
// outright. Byte-for-byte the same pattern as server.py:160's `_EMAIL_RE`.
const EMAIL_RE =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

// Any ASCII control character, including CR/LF -- server.py:167
// `_CONTROL_CHAR_RE`. Closes the door on header-injection-style and
// stored-XSS-style payloads regardless of which field they're smuggled in.
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

// SUPPORTED_STATE_SLUGS moved to deadline.ts (2026-07-05, "bring your own
// date" build) -- it's computed from the same reference data deadline.ts
// already imports, rather than a second hand-maintained copy here.

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

// ---------------------------------------------------------------------------
// Firm-signup trial gate (2026-07-30 BUILD v2, Phase A) -- competitor-intel
// protection per the directive: gate POST /firm/signup against disposable
// (temp-mail) domains and named incumbent competitors opening a free-pilot
// trial account. Free consumer-email providers are deliberately ALLOWED --
// see the DISPOSABLE_EMAIL_DOMAINS comment below for the evidence that
// reversed the original policy. Deliberately
// NOT applied to /firm/login (an existing account, whatever domain it was
// created under, must always be able to sign back in -- this gates NEW trial
// creation, not existing access).
// ---------------------------------------------------------------------------

// FREE-EMAIL BLOCKING WAS REMOVED 2026-07-30, replaced by disposable-only.
//
// The original list blocked gmail/yahoo/outlook/icloud/aol and friends, to
// stop free-pilot trials from non-business addresses. Competitive research
// across 14 products in this market found that policy has no support here
// and real cost:
//
//   * The AICPA -- the buyer's OWN governing body, selling CPE self-serve to
//     individual CPAs at $385-569 -- blocks ONLY disposable domains. Their
//     live site config lists exactly `gufum.com,yopmail.com`, both temp-mail
//     services, with no free provider anywhere on their registration pages.
//   * Of 14 products checked, every single free-email block sat on a
//     SALES-ROUTING form (demo requests via HubSpot/ChiliPiper/Calendly).
//     Zero blocked free email on genuinely self-serve signup. The pattern is
//     lead qualification for a human sales team -- which this product does
//     not have, so the block was filtering buyers to protect a step that
//     does not exist in our funnel.
//   * Accounting is full of solo and micro firms with no custom domain at
//     all. At $500/yr for up to 25 staff, a sole practitioner is squarely a
//     target customer, and the old list turned every one of them away.
//   * It also blocked outlook.com/hotmail.com/live.com while the product
//     strategy explicitly targets an "M365-heavy" audience -- turning away
//     Microsoft-identity users at the door.
//
// Disposable/temp-mail domains are still refused: those are throwaway by
// construction, so an account behind one cannot receive the renewal
// reminders this product exists to send, and the address is unreachable the
// moment the trial matters. Unlike the free-email list, being non-exhaustive
// here costs almost nothing -- a missed disposable domain just means one
// junk trial, whereas a missed real buyer was a lost customer.
const DISPOSABLE_EMAIL_DOMAINS: readonly string[] = [
  // The two the AICPA itself blocks.
  "gufum.com",
  "yopmail.com",
  // Long-standing, widely-used temp-mail services.
  "mailinator.com",
  "guerrillamail.com",
  "sharklasers.com",
  "10minutemail.com",
  "temp-mail.org",
  "tempmail.com",
  "throwawaymail.com",
  "trashmail.com",
  "dispostable.com",
  "maildrop.cc",
  "getnada.com",
  "fakeinbox.com",
  "moakt.com",
  "mailnesia.com",
  "spam4.me",
];

// Named incumbents from the directive's own competitor scan (CPA QualityPro,
// Certemy, Harbor Compliance, Copliancy). Not exhaustive -- a "light check"
// per the directive, not a maintained industry-wide blocklist.
//
// This half of the gate SURVIVED the 2026-07-30 policy change: it is
// targeted, cheap, and cannot turn away a real buyer, unlike the free-email
// list it used to sit beside.
const COMPETITOR_EMAIL_DOMAINS: readonly string[] = [
  "cpaqualitypro.com",
  "certemy.com",
  "harborcompliance.com",
  "copliancy.com",
];

function emailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  return at === -1 ? "" : email.slice(at + 1).toLowerCase();
}

// Exact match OR a real subdomain of a blocked domain (foo.mailinator.com) --
// deliberately NOT a substring/`.includes()` test, which would false-positive
// on a legitimate business domain that merely CONTAINS a blocked name as a
// prefix (e.g. "mailinator.com.someconsultancy.com" is not mailinator.com and
// must not be blocked; "mail.mailinator.com" IS a subdomain of it and should
// be).
function matchesBlockedDomain(domain: string, blocklist: readonly string[]): boolean {
  return blocklist.some((blocked) => domain === blocked || domain.endsWith(`.${blocked}`));
}

export type SignupDomainGateResult =
  | { blocked: false }
  | { blocked: true; reason: "disposable" | "competitor" };

/**
 * `email` must already have passed `isValidEmail()` -- this does no format
 * validation of its own, only the domain-allowlist/blocklist decision.
 */
export function checkSignupDomainGate(email: string): SignupDomainGateResult {
  const domain = emailDomain(email);
  if (domain.length === 0) return { blocked: false };
  if (matchesBlockedDomain(domain, DISPOSABLE_EMAIL_DOMAINS)) return { blocked: true, reason: "disposable" };
  if (matchesBlockedDomain(domain, COMPETITOR_EMAIL_DOMAINS)) return { blocked: true, reason: "competitor" };
  return { blocked: false };
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

// Whole-string YYYY-MM-DD only -- what a native <input type="date"> actually
// submits, and strict on purpose: rejects anything Date.parse() would
// otherwise leniently accept (e.g. "2027-6-1", "June 1 2027", a
// datetime-with-time string) so a malformed or hand-crafted "bring your own
// date" submission fails validation instead of silently round-tripping
// through an unexpected format. Also rejects calendar-invalid dates (e.g.
// "2027-02-30") by round-tripping through Date.UTC() and checking the parts
// come back unchanged, the same defense-in-depth pattern this file already
// uses for control characters and email format.
const STRICT_ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseStrictIsoDate(value: string): Date | null {
  const trimmed = value.trim();
  const match = STRICT_ISO_DATE_RE.exec(trimmed);
  if (!match) return null;
  const year = Number.parseInt(match[1] as string, 10);
  const month = Number.parseInt(match[2] as string, 10);
  const day = Number.parseInt(match[3] as string, 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null; // calendar-invalid (e.g. Feb 30) -- Date.UTC() silently rolled it over
  }
  return d;
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

/**
 * Generic sibling of sanitizeFirstName() for other short, optional,
 * cosmetic-only free-text fields (currently: firm_leads.firm_name and
 * .staff_count_hint) that need the same defense-in-depth treatment --
 * trimmed, non-printable characters stripped, hard-capped at `maxLen` --
 * without hardcoding MAX_FIRST_NAME_LEN's specific limit. Same "called again
 * independently at the storage layer even though the request layer already
 * validated" rationale as sanitizeFirstName()'s own docstring.
 */
export function sanitizeFreeText(value: string | null | undefined, maxLen: number): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  let out = "";
  for (const ch of trimmed) {
    if (isPrintableChar(ch)) out += ch;
    if (out.length >= maxLen) break;
  }
  const capped = out.slice(0, maxLen);
  return capped.length > 0 ? capped : null;
}

/**
 * migration 0008 -- reads a single named cookie off the request's `Cookie`
 * header (the browser sends every cookie for the origin in one
 * semicolon-delimited header; there is no per-cookie header). Returns null
 * if the header is absent or the named cookie isn't present. Used by
 * index.ts's requireFirmSession() to read `dr_firm_session` -- deliberately
 * generic (any cookie name) rather than hardcoded to that one name, so it's
 * reusable if a later feature needs a second cookie.
 */
export function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (key !== name) continue;
    const value = part.slice(idx + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value; // malformed percent-encoding -- return the raw value rather than throwing
    }
  }
  return null;
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

// POST /api/firm/lead (2026-07-28) -- its own bucket, same shape/limit as
// RATE_LIMIT_SUBSCRIBE. A separate bucket (not a shared one) so a burst
// against one endpoint can't consume the other's allowance.
export const RATE_LIMIT_FIRM_LEAD: RateLimit = { max: 5, windowSeconds: 600 };

// POST /api/firm/signup and POST /api/firm/login (migration 0008, firm
// accounts) -- each its own bucket, same shape/limit as RATE_LIMIT_FIRM_LEAD
// and same "separate, not shared" rationale: signup and login both trigger
// a login-link email send, so without independent buckets an attacker could
// hammer /firm/login (free of any firm-creation cost) to exhaust an
// allowance that would otherwise also throttle /firm/signup, or vice versa.
export const RATE_LIMIT_FIRM_SIGNUP: RateLimit = { max: 5, windowSeconds: 600 };
export const RATE_LIMIT_FIRM_LOGIN: RateLimit = { max: 5, windowSeconds: 600 };

// POST /api/subscriber/login, keyed on the RECIPIENT rather than the caller
// (2026-07-31, free-tier security review). The per-IP bucket above cannot
// see a distributed mail-bomb aimed at one person -- the review confirmed 12
// sends to a single victim from 12 IPs. Tighter than the per-IP limits
// because the legitimate need is genuinely small: a person signing in asks
// for one link, maybe two if the first is slow to arrive. Anything past that
// in an hour is not a user having trouble, it is someone else's traffic.
// Raised 3 -> 5 (2026-07-31 verification pass). This tier has NO password
// and NO SSO, so exhausting this bucket is total loss of dashboard access
// with no fallback and no error message. 5/hour still bounds a mail-bomb to
// a trickle while leaving room for the ordinary "it hasn't arrived yet, let
// me click again" behaviour on slow mail. The caller only charges the
// bucket when a send would actually fire, so an attacker aiming at a
// non-subscriber cannot spend it at all.
export const RATE_LIMIT_SUBSCRIBER_LOGIN_ACCOUNT: RateLimit = { max: 5, windowSeconds: 3600 };

// POST /firm/licenses (add a staff license, firm-dashboard MVP) -- deliberately
// keyed on the AUTHENTICATED FIRM ID, not the caller's IP, when this is
// checked (see index.ts's handleFirmLicenseCreate()): the requester already
// proved firm ownership via requireFirmSession(), so the risk this bounds is
// a compromised or careless ADMIN SESSION spam-adding rows onto its OWN
// firm's roster, not an anonymous IP hitting a public form the way every
// other RATE_LIMIT_* bucket above does. checkRateLimit()'s `ip` parameter is
// really just "the bucket's identity key" -- passing a firm id there is a
// deliberate reuse, not a type mismatch. 50/day is generous enough for a
// large firm onboarding its whole staff roster in one sitting, while still
// bounding a runaway script or a compromised session.
export const RATE_LIMIT_FIRM_LICENSE_CREATE: RateLimit = { max: 50, windowSeconds: 86400 };

// PATCH /firm/licenses/:id (edit a roster row, incl. its email) -- AuditLab
// F-2, 2026-08-02: this route had NO bucket at all (PoC: 400/400 accepted,
// no 429), while POST above was correctly capped. Every email CHANGE fires
// a fresh confirmation email to the new address -- with no per-firm limit,
// one authenticated session can loop a single row through unlimited
// addresses, a mail-bomb primitive pointed at any third party. Same
// per-firm-id keying and same reasoning as RATE_LIMIT_FIRM_LICENSE_CREATE;
// same 50/day ceiling since a legitimate PATCH burst (bulk-correcting a
// roster after an import) looks the same shape as a legitimate CREATE burst.
export const RATE_LIMIT_FIRM_LICENSE_PATCH: RateLimit = { max: 50, windowSeconds: 86400 };

// POST /firm/cpe (log a CPE entry, 2026-07-30) -- same "keyed on the
// authenticated firm id, not IP" reasoning as RATE_LIMIT_FIRM_LICENSE_CREATE
// above: the risk this bounds is a compromised/careless admin session
// spamming entries, not an anonymous caller. Generous enough for a firm
// bulk-logging a whole roster's worth of CPE at once (e.g. right after a
// conference), tight enough to bound a runaway script.
export const RATE_LIMIT_CPE_ENTRY_CREATE: RateLimit = { max: 100, windowSeconds: 86400 };

// AuditLab S-3, 2026-08-03: these four authenticated state-changing routes
// had no bucket at all -- not a mail primitive like F-2/RATE_LIMIT_FIRM_LICENSE_PATCH
// (none of them sends email), but still unbounded D1 write amplification from
// an already-authenticated, firm-scoped session. Same per-firm-id keying and
// same 50-100/day ceilings as their sibling CREATE/PATCH buckets above -- a
// legitimate bulk operation (deleting/renewing a departing cohort, unlinking
// stale SSO identities) looks the same shape as those.
export const RATE_LIMIT_FIRM_LICENSE_DELETE: RateLimit = { max: 50, windowSeconds: 86400 };
export const RATE_LIMIT_FIRM_LICENSE_RENEW: RateLimit = { max: 50, windowSeconds: 86400 };
export const RATE_LIMIT_CPE_ENTRY_DELETE: RateLimit = { max: 100, windowSeconds: 86400 };
export const RATE_LIMIT_OAUTH_IDENTITY_DELETE: RateLimit = { max: 20, windowSeconds: 86400 };

// POST /debug/run-reminder-pass -- PREVIEW/STAGING ONLY, see index.ts's own
// gate (the route 404s outright unless env.EMAIL_ALLOWLIST is set, which is
// never true in production). Lets a human tester fire the daily reminder
// cron on demand instead of waiting for the real 18:00 UTC trigger. A tight
// cap since this is a manual test aid, not a real feature.
/**
 * Auth suite (2026-07-30). Password login is rate limited on TWO buckets --
 * per-IP AND per-account (see handleFirmPasswordLogin) -- because per-IP
 * alone does nothing against a distributed attack on one high-value firm,
 * and per-account alone lets one IP spray many accounts.
 *
 * These limits also protect AVAILABILITY, not just the credential: each
 * attempt costs ~120ms of PBKDF2 CPU, and the Workers CPU budget starts
 * returning "error code: 1102" under sustained concurrent hashing (measured
 * 2026-07-30). An unthrottled login endpoint is therefore a self-DoS lever
 * as well as a guessing oracle.
 */
export const RATE_LIMIT_FIRM_PASSWORD_LOGIN: RateLimit = { max: 10, windowSeconds: 600 };

/** Setting/changing a password is authenticated already; this only stops a
 * compromised session being used to burn CPU. */
export const RATE_LIMIT_FIRM_PASSWORD_SET: RateLimit = { max: 10, windowSeconds: 3600 };

/** Opening an SSO handshake is cheap, but each one writes a
 * firm_oauth_states row -- throttled so an abandoned-handshake flood can't
 * grow the table. */
export const RATE_LIMIT_OAUTH_START: RateLimit = { max: 20, windowSeconds: 600 };

export const RATE_LIMIT_DEBUG_REMINDER_PASS: RateLimit = { max: 5, windowSeconds: 600 };

/** Mobility checks are the premium feature; this bounds automated
 * harvesting of the rules dataset by a subscriber. Keyed on the
 * authenticated FIRM ID rather than IP -- see handleMobilityCheck. */
export const RATE_LIMIT_MOBILITY_CHECK: RateLimit = { max: 120, windowSeconds: 3600 };

/** POST /firm/mobility/check-batch (2026-08-03, dashboard Map redesign) --
 * one call does the work of up to ~50 single checks (every covered target
 * state for one person), so it gets its own, tighter bucket rather than
 * sharing RATE_LIMIT_MOBILITY_CHECK's 120/hour: unbounded at that rate it
 * would let one firm run ~6,000 individual determinations/hour through a
 * side door. Selecting each of a firm's staff once or twice an hour from
 * the Map tab fits easily inside 20. */
export const RATE_LIMIT_MOBILITY_CHECK_BATCH: RateLimit = { max: 20, windowSeconds: 3600 };

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
// `_verify_turnstile()`. `TURNSTILE_SECRET_KEY` IS configured on the deployed
// Worker (confirmed via `wrangler secret list`, 2026-07-15) -- verification
// below is live and enforced, not a no-op. The `if (!secret) return true`
// fallback exists for local dev / a future environment without the secret
// set, not the current production posture. The fetch() call below is the
// ONLY fetch() in this entire Worker to anything other than D1.
// ---------------------------------------------------------------------------

const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TURNSTILE_TIMEOUT_MS = 5000; // server.py:113 `timeout=5`

export async function verifyTurnstile(token: string | undefined, secret: string | undefined): Promise<boolean> {
  if (!secret) return true; // fallback for an environment without the secret set (not current prod)
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
