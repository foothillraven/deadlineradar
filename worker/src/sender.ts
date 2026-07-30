/**
 * DeadlineRadar Worker -- email sending (Phase 2).
 *
 * Ported from reminders/sender.py (SendGridSender + CircuitBreakerSender).
 * Two responsibilities:
 *   1. sendViaSendGrid() -- one transactional send through SendGrid's v3
 *      mail-send API. Click + open tracking are disabled on every send (these
 *      are transactional, not marketing -- click tracking rewrites action
 *      links into long tracking-domain URLs, the v1 self-test's #1 problem).
 *   2. checkAndCountSend() -- a hard DAILY send cap (circuit breaker) backed by
 *      the send_counters table (migration 0004). Protects the free-tier quota
 *      and, more importantly, sender reputation: a bug or attack that tries to
 *      blow through a burst of sends gets refused once the cap is hit for the
 *      UTC day, instead of getting the whole domain flagged as a spammer.
 *
 * The SendGrid API key is read from env.SENDGRID_API_KEY -- a wrangler secret,
 * never hardcoded, never committed. If it is unset, sendConfirmation() below
 * is never reached (index.ts only calls it when the key is present).
 */

import type { BuiltEmail } from "./emails";

const SENDGRID_API_URL = "https://api.sendgrid.com/v3/mail/send";
const FROM_EMAIL = "noreply@deadline-radar.com";
const FROM_NAME = "DeadlineRadar";
const SEND_TIMEOUT_MS = 10_000;

export const DEFAULT_DAILY_SEND_CAP = 300;

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'
}

/**
 * Atomic daily circuit breaker. Increments today's counter and returns true
 * only if the send is still under the cap. The whole check-increment is a
 * single D1 UPSERT that (a) inserts the day at count=1 or (b) increments it
 * ONLY while it is still below the cap; the statement then reports whether a
 * row was written. Because it is one statement, it cannot race the way the
 * Python CircuitBreakerSender needed an explicit process-wide lock to prevent.
 *
 * Returns true = under cap, send may proceed. false = cap reached, refuse.
 */
export async function checkAndCountSend(db: D1Database, cap: number): Promise<boolean> {
  const day = todayUtc();
  // INSERT the day at 1, or (on conflict) bump the count only if still under
  // the cap. The conditional WHERE on the UPDATE arm means once count == cap,
  // no further row is written and meta.changes is 0.
  const result = await db
    .prepare(
      `INSERT INTO send_counters (day, count) VALUES (?1, 1)
       ON CONFLICT(day) DO UPDATE SET count = count + 1 WHERE count < ?2`
    )
    .bind(day, cap)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/**
 * Case-insensitive, trimmed membership check against a comma-separated
 * allowlist string (env.EMAIL_ALLOWLIST). Returns null when `raw` is
 * unset/empty -- meaning "no allowlist configured, gate is off" -- as
 * distinct from an empty array, so callers can tell "not configured" apart
 * from "configured but empty" if that distinction ever matters.
 */
function parseAllowlist(raw: string | undefined): string[] | null {
  if (!raw) return null;
  const parsed = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  return parsed.length > 0 ? parsed : null;
}

/**
 * Exported for callers OTHER than sendViaSendGrid that need the same
 * "is this a known preview/staging test address" membership check (2026-07-30
 * addition: the firm-signup trial gate exempts EMAIL_ALLOWLIST addresses so a
 * tester can still sign up a preview firm with their own real personal
 * address -- EMAIL_ALLOWLIST is never set in production, so this exemption
 * is structurally a no-op there, same as every other EMAIL_ALLOWLIST-gated
 * behavior in this file).
 */
export function isEmailAllowlisted(raw: string | undefined, email: string): boolean {
  const allowlist = parseAllowlist(raw);
  if (!allowlist) return false;
  return allowlist.includes(email.trim().toLowerCase());
}

/**
 * One transactional send via SendGrid. Returns true on 2xx, false otherwise
 * (a failed send must never throw up into /subscribe -- a subscriber's record
 * is already stored; a transient email failure should not 500 their request).
 *
 * `emailAllowlist` is the raw env.EMAIL_ALLOWLIST value (see env.ts) -- a
 * PREVIEW/STAGING-ONLY safety gate. When it parses to a non-empty list and
 * `toEmail` (trimmed, case-insensitive) is not on it, this function returns
 * false immediately and never calls fetch() -- the recipient is never
 * contacted. When `emailAllowlist` is undefined/empty (the production
 * default), this check is skipped entirely and behavior is byte-identical to
 * before this gate existed.
 */
export async function sendViaSendGrid(
  apiKey: string,
  toEmail: string,
  email: BuiltEmail,
  emailAllowlist?: string
): Promise<boolean> {
  const allowlist = parseAllowlist(emailAllowlist);
  // Preview/staging visibility (2026-07-28): whenever the allowlist gate is
  // active at all, log the full built email -- readable live via
  // `wrangler tail --config wrangler.preview.toml`. This is what makes the
  // preview usable even before/without a real SENDGRID_API_KEY: a tester can
  // grab a magic-link URL (or a reminder email's renew-and-rearm link)
  // straight out of the log stream. Only fires when emailAllowlist is set,
  // which is never true in production -- this line does not exist there.
  if (allowlist) {
    console.log(`[preview-email] to=${toEmail} subject=${JSON.stringify(email.subject)}\n${email.textBody}`);
  }
  if (allowlist && !allowlist.includes(toEmail.trim().toLowerCase())) {
    return false;
  }
  const personalization: Record<string, unknown> = { to: [{ email: toEmail }] };
  if (email.headers && Object.keys(email.headers).length > 0) {
    // SendGrid attaches custom transport headers per personalization, values
    // must be strings (emails.py builds them as strings; stringify defensively).
    const h: Record<string, string> = {};
    for (const [k, v] of Object.entries(email.headers)) h[String(k)] = String(v);
    personalization.headers = h;
  }
  const payload = {
    personalizations: [personalization],
    from: { email: FROM_EMAIL, name: FROM_NAME },
    subject: email.subject,
    content: [
      { type: "text/plain", value: email.textBody },
      { type: "text/html", value: email.htmlBody },
    ],
    // Transactional, not marketing -- tracking has no analytics value here and
    // click tracking actively mangles action links into long redirect URLs.
    tracking_settings: {
      click_tracking: { enable: false, enable_text: false },
      open_tracking: { enable: false },
    },
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const resp = await fetch(SENDGRID_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return resp.status >= 200 && resp.status < 300;
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}
