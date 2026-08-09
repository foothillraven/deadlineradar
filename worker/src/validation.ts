/**
 * Input validation -- ported field-for-field from reminders/server.py's
 * module-level constants and helper functions. Read that file's own module
 * docstring for the full abuse-hardening rationale; this file only carries
 * the logic forward, not the reasoning already documented there.
 */

// Roadmap #56 (2026-08-07): the ISO date of the Terms of Service text a
// newly-created firm accepted at signup (worker/src/store.ts's
// createFirm() writes this into firms.tos_accepted_version). MUST match
// generate.py's TERMS_LAST_CHANGED exactly -- enforced by
// preship_gate.py's check_terms_version_sync(), a hard gate, since a
// silent drift here would mean firms.tos_accepted_version records a date
// that doesn't match what the live /terms/ page actually claims was last
// changed. Bump BY HAND, at the same time as TERMS_LAST_CHANGED, the day
// the Terms wording actually changes.
export const TERMS_VERSION = "2026-08-05";

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
// Matches handleSubscribe()'s existing first_name cap (index.ts) -- a
// personal name, not free-form prose.
export const MAX_ADMIN_NAME_LEN = 60;

// Firm-dashboard staff license fields (2026-07-28 firm-dashboard MVP) --
// staff_label is the admin's own short display name for a roster entry
// (subscribers.staff_label, migration 0008), same "short, optional,
// cosmetic-only free text" category as the two constants above.
export const MAX_STAFF_LABEL_LEN = 120;

// Roadmap #16 (2026-08-07): office/department tag, same shape and same
// sanitizeFreeText() treatment as MAX_STAFF_LABEL_LEN above -- see migration
// 0037's own docstring for why this is a plain string, not a normalized table.
export const MAX_OFFICE_TAG_LEN = 60;

// Roadmap #68 (2026-08-07): internal-only notes per staff member -- longer
// than a tag since it's meant for a genuine sentence or two ("out on leave
// through March", "handles the audit clients"), same cap as the deletion
// survey's own free-text field (MAX_DELETION_SURVEY_DETAIL_LEN) for the
// same "generous enough for real prose, not a support-ticket body" reason.
export const MAX_INTERNAL_NOTES_LEN = 500;

// BILL-1 (2026-08-04, Devin's decision): the advertised self-serve plan is
// "$500/year flat, up to 25 staff -- more than 25? Contact us"
// (generate.py's /for-firms/ and homepage pricing copy). Must match that
// number exactly -- it's the one place both the sales page and the
// enforcement mechanism read from, so a copy change and a limit change can
// never drift apart silently.
export const SELF_SERVE_SEAT_CAP = 25;

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

// Task #3 (2026-08-06): the account-deletion exit survey's optional
// free-text field. Same "cosmetic-only free text" category as
// MAX_STAFF_LABEL_LEN/MAX_CPE_DESCRIPTION_LEN above -- generous enough for
// a genuine sentence or two of feedback, not a support-ticket body.
export const MAX_DELETION_SURVEY_DETAIL_LEN = 500;

// A fixed set, not free text -- keeps the reason field analyzable (Devin
// can actually see "3 people picked 'too expensive' this month") instead of
// N slightly-different free-text phrasings of the same reason. "other" is
// the escape hatch; the free-text detail field is where nuance goes.
export const DELETION_SURVEY_REASONS = new Set([
  "too_expensive",
  "missing_feature",
  "switching_tools",
  "no_longer_needed",
  "other",
]);

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

// Roadmap #7 (2026-08-07): a self-reported renewal fee, entered as plain
// dollars-and-cents ("199" or "199.99"), stored as an integer cents value
// (see migration 0034's own docstring for why cents, not a float). No sign,
// no more than 2 decimal places -- a negative or three-decimal "fee" is
// certainly a typo, not a real value to store as-is.
const STRICT_MONEY_RE = /^\d+(\.\d{1,2})?$/;
export const MAX_RENEWAL_FEE_CENTS = 100_000_00; // $100,000 -- generous headroom over any real renewal fee, still a real ceiling

export function parseStrictDollarsToCents(value: string): number | null {
  const trimmed = value.trim();
  if (!STRICT_MONEY_RE.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return null;
  const cents = Math.round(n * 100);
  if (cents < 0 || cents > MAX_RENEWAL_FEE_CENTS) return null;
  return cents;
}

// Roadmap #10 (2026-08-07): self-reported CPE carryover hours (see migration
// 0036's own docstring for why this is self-reported rather than a
// state-asserted structured fact). Same "step=0.1" precision as a CPE entry's
// own hours field, deliberately NOT the same regex as STRICT_MONEY_RE despite
// looking similar -- this allows any number of decimal digits at the input
// layer (Math.round below normalizes to tenths), matching parseStrictCpeHours'
// own precision handling rather than money's fixed 2-decimal-place rule.
export const MAX_CARRYOVER_HOURS = 100; // generous headroom over any real state's carryover cap (Maryland's own 80h, the highest found in data/cpe_hours.json, is well under this)

export function parseStrictCarryoverHours(value: string): number | null {
  const trimmed = value.trim();
  if (!STRICT_DECIMAL_RE.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return null;
  if (n < 0 || n > MAX_CARRYOVER_HOURS) return null;
  return Math.round(n * 10) / 10;
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
// AuditLab CSV-1 (LOW, 2026-08-07, filed the moment roadmap #18 -- a real
// CSV export -- started, since that's the exact trigger that flips this from
// theoretical to live): the standard CSV-formula-injection prefix set. A
// value starting with any of these opens as a formula, not text, in
// Excel/Sheets/etc. if it ever lands in an exported .csv a firm opens.
// Guarded HERE (write time, every sanitizeFreeText() caller -- currently
// staff_label and office_tag, both of which now flow into #18's export) so
// a future export surface never has to remember to re-guard on the way out
// -- same "guard at the point data enters, not just where it's used"
// posture http_href() already documents for data-file-sourced links. A
// leading tab is the fourth standard prefix in this list, but is already
// unreachable here: isPrintableChar() strips every C0 control character
// (tab included) before this check ever runs, so it can never survive as
// the first character of `capped`.
const CSV_FORMULA_INJECTION_PREFIXES = new Set(["=", "+", "-", "@"]);

export function sanitizeFreeText(value: string | null | undefined, maxLen: number): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  let out = "";
  for (const ch of trimmed) {
    if (isPrintableChar(ch)) out += ch;
    if (out.length >= maxLen) break;
  }
  let capped = out.slice(0, maxLen);
  if (CSV_FORMULA_INJECTION_PREFIXES.has(capped.charAt(0))) {
    capped = "'" + capped;
  }
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

// AuditLab RL-6/RL-7 (2026-08-06): POST /firm/login and POST /firm/signup
// both fire the identical issueAndSendFirmLoginLink() primitive with the
// same relaxed-Turnstile (login) or strict-but-real-token (signup) gate as
// /api/subscriber/login, but had no per-recipient bucket -- an attacker
// spread across many IPs could mail-bomb a single firm admin's inbox
// unthrottled. Same shape/rationale as RATE_LIMIT_SUBSCRIBER_LOGIN_ACCOUNT;
// separate constants (not shared) for the same "a burst on one endpoint
// can't consume the other's allowance" reason RATE_LIMIT_FIRM_SIGNUP and
// RATE_LIMIT_FIRM_LOGIN are already separate.
export const RATE_LIMIT_FIRM_LOGIN_ACCOUNT: RateLimit = { max: 5, windowSeconds: 3600 };
export const RATE_LIMIT_FIRM_SIGNUP_ACCOUNT: RateLimit = { max: 5, windowSeconds: 3600 };

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

// POST /firm/licenses/:id/documents (upload a certificate, roadmap #1/#2,
// 2026-08-07) -- keyed on firm id, same reasoning as RATE_LIMIT_CPE_ENTRY_
// CREATE above. Tighter than that one (uploads are bigger writes -- an R2
// PUT plus a D1 insert, not just a D1 insert) but still generous enough for
// a firm uploading a full roster's worth of certificates in one sitting.
export const RATE_LIMIT_FIRM_DOCUMENT_UPLOAD: RateLimit = { max: 60, windowSeconds: 86400 };

// PATCH /firm/peer-review (roadmap #6, 2026-08-07) -- a single admin-entered
// firm-level date field, same modest cap as other low-risk single-field
// setters on this list (not a mail primitive, not a bulk-write path).
export const RATE_LIMIT_FIRM_PEER_REVIEW_SET: RateLimit = { max: 30, windowSeconds: 86400 };

// PATCH /firm/reply-to (roadmap #19, 2026-08-07) -- same shape and same
// modest cap as RATE_LIMIT_FIRM_PEER_REVIEW_SET above.
export const RATE_LIMIT_FIRM_REPLY_TO_SET: RateLimit = { max: 30, windowSeconds: 86400 };

// PATCH /firm/reminder-cadence (roadmap #23, 2026-08-07) -- same shape and
// same modest cap as the two above.
export const RATE_LIMIT_FIRM_REMINDER_CADENCE_SET: RateLimit = { max: 30, windowSeconds: 86400 };

// PATCH /firm/rule-change-alerts (roadmap #9/#319, 2026-08-08) -- same
// shape and same modest cap as the three above.
export const RATE_LIMIT_FIRM_RULE_CHANGE_ALERTS_SET: RateLimit = { max: 30, windowSeconds: 86400 };

// GET /firm/integrations/slack/connect and POST .../disconnect (roadmap
// #20, 2026-08-08) -- same modest cap as the settings routes above; connect
// additionally mints an OAuth state row per request, so this also bounds
// how many abandoned handshakes one firm can churn through.
export const RATE_LIMIT_FIRM_SLACK_CONNECT: RateLimit = { max: 30, windowSeconds: 86400 };
export const RATE_LIMIT_FIRM_SLACK_DISCONNECT: RateLimit = { max: 30, windowSeconds: 86400 };

// PATCH /firm/integrations/teams (roadmap #21, 2026-08-08) -- same modest
// cap as the settings routes above.
export const RATE_LIMIT_FIRM_TEAMS_SET: RateLimit = { max: 30, windowSeconds: 86400 };

// POST /subscriber/phone/start-verification (roadmap #22, 2026-08-09) --
// deliberately tighter than the settings caps above: each call sends a
// REAL SMS at REAL per-message cost, unlike every other rate-limited
// action in this file. Same "circuit breaker before the send" posture as
// RESEND_COOLDOWN_MINUTES/RESEND_MAX_ATTEMPTS (store.ts) for email resends.
export const RATE_LIMIT_SUBSCRIBER_PHONE_VERIFICATION_START: RateLimit = { max: 5, windowSeconds: 86400 };
// POST /subscriber/phone/confirm-verification -- a 6-digit code's real
// brute-force resistance comes from attempt throttling, not the code's
// own keyspace. Tighter than the start cap: several guesses per SENT
// code, not several codes per day.
export const RATE_LIMIT_SUBSCRIBER_PHONE_VERIFICATION_CONFIRM: RateLimit = { max: 10, windowSeconds: 3600 };
export const RATE_LIMIT_SUBSCRIBER_PHONE_OPT_OUT: RateLimit = { max: 30, windowSeconds: 86400 };

// Roadmap #23: the ONLY values a firm may pick from -- see migration 0039's
// own docstring for why this is a subset of the existing 6 escalation
// points, not arbitrary day-offsets (each has bespoke, reviewed urgency
// copy in emails.ts; an unreviewed value would either need invented copy
// or hit buildReminderEmail()'s own throw). Duplicated here (not imported
// from scheduler.ts) deliberately: worker/src/validation.ts has no existing
// dependency on scheduler.ts, and this is a small, stable, rarely-changing
// constant -- not worth introducing a new cross-module import for.
export const ALLOWED_REMINDER_THRESHOLDS = new Set([60, 30, 14, 7, 3, 1]);

/** Roadmap #23: `raw` is the PARSED JSON.parse() result of a request body's
 * `thresholds` field (the caller does the JSON.parse -- this only validates
 * shape/values). Returns the validated array (deduped, no particular order
 * required -- nextDueThreshold() sorts internally) or null if anything
 * about it is wrong, letting the caller 400 rather than store a bad value. */
export function parseReminderThresholds(raw: unknown): number[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const deduped = new Set<number>();
  for (const v of raw) {
    if (typeof v !== "number" || !ALLOWED_REMINDER_THRESHOLDS.has(v)) return null;
    deduped.add(v);
  }
  return Array.from(deduped);
}

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

// POST /subscriber/cpe (2026-08-05, staff self-service CPE entry) -- keyed
// on the subscriber's own emailNormalized, not IP: the risk this bounds is a
// compromised/careless subscriber session logging junk entries against
// their own record, not an anonymous caller (they can only ever touch rows
// matching their own email -- see store.addCpeEntryForSubscriber()). Same
// generous-but-bounded shape as RATE_LIMIT_CPE_ENTRY_CREATE, just a smaller
// ceiling since one person logging their own hours is inherently
// lower-volume than a firm admin bulk-logging a whole roster.
export const RATE_LIMIT_SUBSCRIBER_CPE_CREATE: RateLimit = { max: 20, windowSeconds: 86400 };

// POST /subscriber/change-email (roadmap #12, 2026-08-07) -- same shape
// and same reasoning as RATE_LIMIT_FIRM_CHANGE_EMAIL above: this sends
// real email to an address of the caller's choosing, not the account's
// own address, so it needs its own per-account throttle on top of the
// global daily send cap.
export const RATE_LIMIT_SUBSCRIBER_CHANGE_EMAIL: RateLimit = { max: 5, windowSeconds: 3600 };

// POST /subscriber/profile (roadmap #12) -- sets only first_name, no
// email involved -- not a mail primitive, same modest authenticated-write
// cap as the firm-side single-field setters (RATE_LIMIT_FIRM_REPLY_TO_SET
// and siblings).
export const RATE_LIMIT_SUBSCRIBER_PROFILE_UPDATE: RateLimit = { max: 30, windowSeconds: 86400 };

// PATCH /subscriber/reminder-cadence (roadmap #12) -- same shape as
// RATE_LIMIT_SUBSCRIBER_PROFILE_UPDATE above.
export const RATE_LIMIT_SUBSCRIBER_REMINDER_CADENCE: RateLimit = { max: 30, windowSeconds: 86400 };

// PATCH /subscriber/notification-mode (roadmap #24) -- same shape again.
export const RATE_LIMIT_SUBSCRIBER_NOTIFICATION_MODE: RateLimit = { max: 30, windowSeconds: 86400 };

// POST /firm/staff-cpe-reminder (2026-08-05) -- an admin-triggered nudge
// email to one staff member. Keyed on firm_id like RATE_LIMIT_FIRM_LICENSE_CREATE,
// bounding a compromised/careless firm session from mail-bombing its own
// staff roster with reminder emails, not sized for "one per staff member per
// day" (a firm reasonably re-sending after someone missed the first one).
export const RATE_LIMIT_FIRM_STAFF_CPE_REMINDER: RateLimit = { max: 50, windowSeconds: 86400 };

// POST /firm/rule-change/notify (2026-08-06) -- one click can email every
// roster staffer in a single state at once (unlike the per-staff CPE
// reminder above), so this bounds CLICKS, not individual emails sent. Real
// rule changes are rare -- a handful a year, at most -- so 20/day per firm
// is generous headroom for legitimate re-sends while still bounding a
// compromised session from mail-bombing the whole roster repeatedly.
export const RATE_LIMIT_FIRM_RULE_CHANGE_NOTIFY: RateLimit = { max: 20, windowSeconds: 86400 };

// POST /roadmap/vote (Task #19, 2026-08-06) -- anonymous, no session, keyed
// on IP. The real dedup guarantee is UNIQUE(idea_id, voter_id) at the DB
// layer (see migration 0029) -- this exists to blunt a scripted loop
// generating fresh voter-id cookies per request, not as the primary
// defense. 8 ideas exist today; 20/hour per IP comfortably covers one real
// visitor voting on all of them more than once, with room to grow the idea
// list, while still bounding a single source hammering the endpoint.
export const RATE_LIMIT_ROADMAP_VOTE: RateLimit = { max: 20, windowSeconds: 3600 };

// POST /roadmap/notify-signup (Task #19, 2026-08-06) -- sends a real email,
// so tighter than the vote limit above and keyed on IP the same way.
// Mirrors RATE_LIMIT_SUBSCRIBE's own shape (a public, anonymous,
// email-sending endpoint) rather than inventing a new ratio.
export const RATE_LIMIT_ROADMAP_NOTIFY_SIGNUP: RateLimit = { max: 5, windowSeconds: 600 };

// POST/DELETE /firm/mobility/completions (2026-08-04) -- same reasoning and
// same 100/day ceiling as RATE_LIMIT_CPE_ENTRY_CREATE/DELETE: an
// already-authenticated, firm-scoped mutation, bounded against a
// compromised/careless session rather than an anonymous caller.
export const RATE_LIMIT_MOBILITY_COMPLETION_CREATE: RateLimit = { max: 100, windowSeconds: 86400 };
export const RATE_LIMIT_MOBILITY_COMPLETION_DELETE: RateLimit = { max: 100, windowSeconds: 86400 };

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

// POST /firm/demo-login (2026-08-09, adversarial review: /firm/demo-login
// replaces the old password-prefill demo flow, which required BOTH
// Turnstile and this same 10/600s cap keyed on the demo account's own
// email -- a real, GLOBAL-across-every-IP throttle on how fast that one
// shared session can be re-minted. The new route has no credential to
// check and so no natural place for that account-keyed bucket to hang off
// of; this is that same cap, applied directly, keyed on a fixed string
// since there is exactly one demo account. Distinct from the generic
// RATE_LIMIT_ACTION bucket every other action-confirm path shares (30/600s
// per IP only) -- that alone would let a distributed abuser mint far more
// sessions per window than the credentialed flow ever allowed.
export const RATE_LIMIT_FIRM_DEMO_LOGIN_GLOBAL: RateLimit = { max: 10, windowSeconds: 600 };

// POST /firm/2fa/verify (roadmap #53, 2026-08-07) -- same dual-bucket shape
// as RATE_LIMIT_FIRM_PASSWORD_LOGIN (per-IP here, per-member below): a
// 6-digit code with a +/-1 step window is ~3-in-1,000,000 per guess, but
// only if attempts are actually bounded -- this bucket plus the pending
// token's own DB-level attempts cap (FIRM_2FA_PENDING_MAX_ATTEMPTS,
// store.ts) are the two independent layers.
export const RATE_LIMIT_FIRM_2FA_VERIFY: RateLimit = { max: 10, windowSeconds: 600 };
// Tighter per-member bucket, same "per-IP alone does nothing against a
// distributed attack aimed at one account" reasoning every other
// account-keyed bucket in this file already uses.
export const RATE_LIMIT_FIRM_2FA_VERIFY_ACCOUNT: RateLimit = { max: 8, windowSeconds: 600 };

/** POST /firm/2fa/enroll and /firm/2fa/enroll/confirm -- already
 * session-authenticated (same "stops a compromised session burning CPU/
 * D1 writes" reasoning as RATE_LIMIT_FIRM_PASSWORD_SET), keyed on
 * session.memberId rather than IP -- an office sharing one outbound IP
 * must not throttle a different member's own enrollment attempt. Tighter
 * than password-set's 10/hr: confirm is also where a code gets brute-forced
 * against a client-supplied secret (see handleFirm2faEnrollConfirm's own
 * comment), so this doubles as that route's guessing-rate bound too. */
export const RATE_LIMIT_FIRM_2FA_ENROLL: RateLimit = { max: 8, windowSeconds: 3600 };

/** POST /firm/2fa/disable -- requires a fresh code (see the route's own
 * comment for why proof-of-possession, not the password, is the right
 * step-up here), so this bucket is what actually bounds guessing it. Same
 * per-member keying and count as RATE_LIMIT_FIRM_2FA_VERIFY_ACCOUNT. */
export const RATE_LIMIT_FIRM_2FA_DISABLE: RateLimit = { max: 8, windowSeconds: 600 };

/** Setting/changing a password is authenticated already; this only stops a
 * compromised session being used to burn CPU. */
export const RATE_LIMIT_FIRM_PASSWORD_SET: RateLimit = { max: 10, windowSeconds: 3600 };

/** Cancel/resume are authenticated + rate-limited the same as password set
 * -- no legitimate admin needs more than a handful of toggles a day. */
export const RATE_LIMIT_FIRM_BILLING_CANCEL: RateLimit = { max: 10, windowSeconds: 3600 };

/** Task #3 (2026-08-06): a firm only ever legitimately deletes its own
 * account once. Tighter than the toggles above on purpose -- this is
 * irreversible-in-effect (immediate deactivation), not a reversible
 * setting flip. */
export const RATE_LIMIT_FIRM_ACCOUNT_DELETE: RateLimit = { max: 3, windowSeconds: 3600 };

/** AuditLab RL-5 (2026-08-06): checkout had no bucket at all, unlike its
 * sibling cancel/resume above -- each call is a live Stripe API request
 * under the one shared secret key, so an unbounded client (compromised
 * session, retry-looping bug) risks Stripe-side throttling of that key for
 * every firm, not just the abusive one. Same shape as the cancel bucket. */
export const RATE_LIMIT_FIRM_BILLING_CHECKOUT: RateLimit = { max: 10, windowSeconds: 3600 };

/** Task #18 (2026-08-05): same reasoning as RATE_LIMIT_FIRM_PASSWORD_SET --
 * already authenticated, this only stops a compromised session being reused
 * to hammer the D1 write. */
export const RATE_LIMIT_FIRM_SIGNOUT_OTHER: RateLimit = { max: 10, windowSeconds: 3600 };

/** Roadmap #52: revoking one specific session, same shape/reasoning as
 * RATE_LIMIT_FIRM_SIGNOUT_OTHER just above -- listing itself (GET) isn't
 * separately rate-limited, matching every other read-only /firm/* route. */
export const RATE_LIMIT_FIRM_SESSION_REVOKE: RateLimit = { max: 10, windowSeconds: 3600 };

// POST /firm/members/invite (migration 0045, roadmap #11/#13/#14) -- sends
// an email to an address the inviting session supplies (any address a
// Partner/Office Manager wants to add), same "authenticated session, keyed
// on firm id" reasoning as RATE_LIMIT_FIRM_LICENSE_CREATE. Modest cap --
// inviting a firm's whole team is a rare, bursty, but bounded event.
export const RATE_LIMIT_FIRM_MEMBER_INVITE: RateLimit = { max: 30, windowSeconds: 86400 };

// PATCH /firm/members/:id (role change, migration 0045) -- same shape as
// RATE_LIMIT_FIRM_PEER_REVIEW_SET/RATE_LIMIT_FIRM_REPLY_TO_SET above; not a
// mail primitive, just a bounded authenticated-write cap.
export const RATE_LIMIT_FIRM_MEMBER_ROLE_CHANGE: RateLimit = { max: 50, windowSeconds: 86400 };

// DELETE /firm/members/:id (remove, migration 0045) -- same shape as
// RATE_LIMIT_FIRM_LICENSE_DELETE above.
export const RATE_LIMIT_FIRM_MEMBER_REMOVE: RateLimit = { max: 50, windowSeconds: 86400 };

// POST /firm/members/:id/make-primary (roadmap #51, migration 0045) --
// firm-account-transfer is a rare, deliberate action, same modest cap as
// RATE_LIMIT_FIRM_PEER_REVIEW_SET/RATE_LIMIT_FIRM_REPLY_TO_SET above.
export const RATE_LIMIT_FIRM_MEMBER_MAKE_PRIMARY: RateLimit = { max: 20, windowSeconds: 86400 };

/** Roadmap #144: submitting or dismissing the NPS prompt. Low-frequency by
 * design (the quarterly cooldown itself bounds real usage), same
 * defense-in-depth reasoning as every other authenticated-write bucket. */
export const RATE_LIMIT_FIRM_NPS: RateLimit = { max: 10, windowSeconds: 3600 };

/** Roadmap #312: submitting a testimonial, same shape as RATE_LIMIT_FIRM_NPS. */
export const RATE_LIMIT_FIRM_TESTIMONIAL: RateLimit = { max: 10, windowSeconds: 3600 };

/** AuditLab SEC-1 (2026-08-07): every write endpoint should be rate-limited
 * per the /security/ page's own claim -- these 7 shipped without one.
 * Generous, since none of the seven have a meaningful abuse profile beyond
 * bounded DB write noise (a dismiss-once flag, deleting the caller's own
 * document, or the caller's own session) -- this closes the literal gap,
 * not a tight abuse-specific bound the way login/signup buckets are.
 * Dismiss/delete endpoints are already session-gated (per-firm); the two
 * logout endpoints have no verified session yet at the point they'd need
 * to rate-limit (they only ever act on whatever session the cookie names,
 * valid or not), so those are keyed on IP instead, same as every other
 * pre-session bucket in this file. */
export const RATE_LIMIT_FIRM_DISMISS: RateLimit = { max: 30, windowSeconds: 3600 };
export const RATE_LIMIT_LOGOUT: RateLimit = { max: 30, windowSeconds: 3600 };

/** Roadmap #312: a real quote, generous enough for a genuine sentence or
 * two -- same "cosmetic-only free text" cap category as
 * MAX_DELETION_SURVEY_DETAIL_LEN/MAX_INTERNAL_NOTES_LEN above. */
export const MAX_TESTIMONIAL_LEN = 500;

/** Task #29 (2026-08-05). Keyed per-firm like the others above, but this
 * route is a DIFFERENT risk shape than a password/session action: each call
 * sends real email to an address of the CALLER'S choosing, not to the
 * account's own address -- an unthrottled version is a spam-relay lever
 * against arbitrary strangers' inboxes, not just a D1-hammering nuisance.
 * checkAndCountActionSend()'s global daily send cap is the second, larger
 * layer against that; this is the per-account first layer. */
export const RATE_LIMIT_FIRM_CHANGE_EMAIL: RateLimit = { max: 5, windowSeconds: 3600 };

/** Opening an SSO handshake is cheap, but each one writes a
 * firm_oauth_states row -- throttled so an abandoned-handshake flood can't
 * grow the table. */
export const RATE_LIMIT_OAUTH_START: RateLimit = { max: 20, windowSeconds: 600 };

export const RATE_LIMIT_DEBUG_REMINDER_PASS: RateLimit = { max: 5, windowSeconds: 600 };

/** Mobility checks are the premium feature; this bounds automated
 * harvesting of the rules dataset by a subscriber. Keyed on the
 * authenticated FIRM ID rather than IP -- see handleMobilityCheck. */
export const RATE_LIMIT_MOBILITY_CHECK: RateLimit = { max: 120, windowSeconds: 3600 };

/** Roadmap #318 (2026-08-09, firm-level registration check) -- own bucket,
 * not shared with RATE_LIMIT_MOBILITY_CHECK: a genuinely different query
 * shape (one firm-home-state/target-state/office pair, not per-staff), so
 * mixing them would let firm-level harvesting silently eat an individual
 * check's budget or vice versa. Same "premium feature, bound automated
 * harvesting, key on the authenticated FIRM" reasoning. */
export const RATE_LIMIT_FIRM_MOBILITY_CHECK: RateLimit = { max: 120, windowSeconds: 3600 };

/** POST /firm/mobility/check-batch (2026-08-03, dashboard Map redesign) --
 * one call does the work of up to ~50 single checks (every covered target
 * state for one person), so it gets its own, tighter bucket rather than
 * sharing RATE_LIMIT_MOBILITY_CHECK's 120/hour: unbounded at that rate it
 * would let one firm run ~6,000 individual determinations/hour through a
 * side door.
 *
 * Raised 20 -> 40 (reported directly, 2026-08-04): the client caches results
 * per home STATE, not per staffer, so this was meant to cover "select each
 * of a firm's staff once or twice an hour" cheaply -- but a firm whose
 * roster spans close to (or more than) 20 distinct home states hits this
 * reviewing their OWN roster once, exactly the walkthrough a new firm does
 * when deciding whether to trust the product. 40 keeps the same order-of-
 * magnitude protection against the ~6,000/hour side-door scenario above
 * (40 * ~50 = 2,000/hour, still well under it) while giving real headroom
 * for a single-sitting full-roster review.
 *
 * AuditLab MAP-1 (MEDIUM, 2026-08-07): 40 was live-hitting a real paying
 * Enterprise-tier firm (25 seats -> 25 batch calls per roster review) on
 * nothing more than reviewing their own Map twice in an hour -- the
 * in-memory client cache doesn't survive a page reload, so "review twice"
 * is a completely ordinary usage pattern, not abuse. Raised to 120 as an
 * immediate stop-the-bleeding fix (120 * ~50 = 6,000/hour -- back at the
 * original side-door ceiling this constant was sized against, not a
 * loosened bound), then the real fix landed same-day: scope-based limiting
 * (handleMobilityCheck/handleMobilityCheckBatch now serve a firm's OWN
 * roster home-states unmetered -- see RATE_LIMIT_MOBILITY_CHECK_UNMETERED
 * below -- and only meter queries for states nobody on the roster is in).
 * This bucket is now specifically the OFF-ROSTER/harvesting-shape ceiling,
 * not the everyday-use ceiling anymore -- see
 * auditlab_20260807_MAP1_scope_based_mobility_limit_spec.md /
 * auditlab_20260807_MAP1_BUILD_DIRECTIVE.md for the full spec. */
export const RATE_LIMIT_MOBILITY_CHECK_BATCH: RateLimit = { max: 120, windowSeconds: 3600 };

/** AuditLab MAP-1: the unmetered path for a firm querying its OWN roster's
 * home states (see getFirmRosterStateSlugs()) -- structurally bounded by
 * the seat cap (<=25 distinct states even at the largest tier today), so
 * this ceiling exists only as a safety net against a compromised session
 * or a client bug looping, never expected to be reached by a real human
 * workflow. Deliberately high and shared by both /check and /check-batch. */
export const RATE_LIMIT_MOBILITY_CHECK_UNMETERED: RateLimit = { max: 500, windowSeconds: 3600 };

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

/**
 * `allowMissingToken` (2026-08-05, live Gate-1 testing): Devin's own browser
 * has an ad blocker, and confirmed live that it silently prevents
 * `challenges.cloudflare.com` from ever loading -- the widget never renders,
 * `data-callback` never fires, and the hidden `cf-turnstile-response` field
 * stays empty forever. That is indistinguishable, from this function's
 * point of view, from a legitimate visitor running uBlock/Brave
 * Shields/Firefox Enhanced Tracking Protection, which covers a real,
 * non-trivial share of traffic -- silently dead-ending every one of them at
 * the top of the signup funnel is worse than the bot risk this parameter
 * accepts.
 *
 * Scoped narrowly: an EMPTY token (never provided at all) passes when this
 * is true; a token that WAS provided but fails verification still fails
 * closed exactly as before -- this only forgives "the widget could never
 * load," never "the widget loaded and rejected this." Callers only pass
 * `true` on routes where the only thing a token-less submission can do is
 * cause a confirmation/magic-link EMAIL to be sent -- the account/action
 * stays inert until that link is actually clicked, which is a real inbox
 * the caller must control, and the existing rate-limit/honeypot/control-char
 * checks still run first on every one of those routes. Never set on a route that
 * grants access directly (e.g. password sign-in) with no such secondary
 * gate.
 */
export async function verifyTurnstile(
  token: string | undefined,
  secret: string | undefined,
  allowMissingToken = false
): Promise<boolean> {
  if (!secret) return true; // fallback for an environment without the secret set (not current prod)
  if (!token) return allowMissingToken;
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
