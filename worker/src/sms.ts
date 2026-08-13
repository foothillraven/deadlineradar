/**
 * Roadmap #22 (2026-08-09): SMS/text reminders, opt-in ADDITIONAL channel
 * on top of email. Real TCPA compliance surface, not just UX:
 *
 *   - Prior express consent, never bundled with the email opt-in (see
 *     migration 0054's own docstring for the double opt-in flow).
 *   - Quiet hours: no message outside 8am-9pm recipient LOCAL time. The
 *     only geographic signal this product has is a subscriber's licensing
 *     STATE (state_slug) -- close enough for a conservative approximation,
 *     never exact for someone physically outside their licensing state,
 *     but that's the best signal available and erring toward NOT sending
 *     is always the safe direction.
 *   - STOP/HELP keyword handling via Twilio's inbound webhook (index.ts's
 *     handleSmsInbound()), validated via Twilio's own request-signature
 *     scheme so an unauthenticated caller can't forge an opt-out on
 *     someone else's number.
 */

const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01";
const SEND_TIMEOUT_MS = 10_000;

/** Basic Auth POST to Twilio's Messages resource. Same timeout/2xx-only/
 * never-throws contract as sendToSlack()/sendToTeams(), so it drops into
 * runSmsAlertPass()'s injectable `send` option the same way. */
export async function sendSms(accountSid: string, authToken: string, from: string, to: string, body: string): Promise<boolean> {
  const url = `${TWILIO_API_BASE}/Accounts/${encodeURIComponent(accountSid)}/Messages.json`;
  const formBody = new URLSearchParams({ To: to, From: from, Body: body });
  const authHeader = `Basic ${btoa(`${accountSid}:${authToken}`)}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: formBody.toString(),
      signal: controller.signal,
    });
    return resp.status >= 200 && resp.status < 300;
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Crypto-secure 6-digit code -- never Math.random(), same discipline as
 * every other secret-ish value generated in this codebase. */
export function generateVerificationCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  const n = new DataView(bytes.buffer).getUint32(0) % 1_000_000;
  return n.toString().padStart(6, "0");
}

/**
 * Approximate PREDOMINANT standard-time (non-DST-adjusted) UTC offset per
 * licensing state -- close enough for a fixed-time daily cron, given a
 * subscriber's licensing state is the only geographic signal this product
 * has at all. AuditLab SYNC-2 (2026-08-09, addendum 2026-08-13): an earlier
 * version of this docstring claimed "3+ hours of margin on both sides" for
 * the 18:00 UTC cron -- false by measurement (Hawaii sits exactly ON the
 * 8am boundary, 0h of margin; Alaska has 1h). It's correct today only
 * because isWithinSmsQuietHours()'s >= comparison is inclusive of 8:00 and
 * Hawaii doesn't observe DST, not because of any real safety margin -- so
 * don't trust a "there's room" intuition when touching the cron schedule;
 * trust CRON_HOUR_UTC below and computeSmsUnavailableStateSlugs()'s actual
 * output instead. A jurisdiction genuinely incompatible with a single fixed
 * daily cron time (Guam/CNMI, UTC+10 -- the cron fires at ~4am their next
 * local day) is listed with its REAL offset rather than omitted, so the
 * check below correctly and consistently computes "outside quiet hours,
 * skip" for it every day, rather than hardcoding an exclusion. A
 * jurisdiction NOT listed here fails closed (isWithinSmsQuietHours returns
 * false) -- never guessed.
 */
export const STATE_TIMEZONE_UTC_OFFSET: Record<string, number> = {
  // Eastern (UTC-5)
  connecticut: -5, delaware: -5, dc: -5, florida: -5, georgia: -5, indiana: -5,
  kentucky: -5, maine: -5, maryland: -5, massachusetts: -5, michigan: -5,
  "new-hampshire": -5, "new-jersey": -5, "new-york": -5, "north-carolina": -5,
  ohio: -5, pennsylvania: -5, "rhode-island": -5, "south-carolina": -5,
  vermont: -5, virginia: -5, "west-virginia": -5,
  // Central (UTC-6)
  alabama: -6, arkansas: -6, illinois: -6, iowa: -6, kansas: -6, louisiana: -6,
  minnesota: -6, mississippi: -6, missouri: -6, nebraska: -6, "north-dakota": -6,
  oklahoma: -6, "south-dakota": -6, tennessee: -6, texas: -6, wisconsin: -6,
  // Mountain (UTC-7)
  arizona: -7, colorado: -7, idaho: -7, montana: -7, "new-mexico": -7, utah: -7, wyoming: -7,
  // Pacific (UTC-8)
  california: -8, nevada: -8, oregon: -8, washington: -8,
  // Alaska (UTC-9), Hawaii (UTC-10, no DST)
  alaska: -9, hawaii: -10,
  // Atlantic (UTC-4, no DST observed)
  "puerto-rico": -4, "us-virgin-islands": -4,
  // Chamorro Standard Time (UTC+10) -- see the docstring above for why
  // this is listed with its real offset, not omitted.
  guam: 10, "northern-mariana-islands": 10,
};

const QUIET_HOURS_START = 8; // 8am local, inclusive
const QUIET_HOURS_END = 21; // 9pm local, exclusive

/** The Worker's single daily SMS-pass cron hour, UTC -- MUST match the
 * "0 18 * * *" cron trigger in BOTH worker/wrangler.toml and
 * worker/wrangler.preview.toml (asserted equal to both by
 * scripts/preship_gate.py's check_sms_cron_hour_matches_wrangler(),
 * AuditLab SYNC-2). Existing as a named constant instead of being inlined
 * is what makes that check possible -- a preship assertion can grep for
 * this one number and compare it against the real schedule instead of
 * trusting SMS_UNAVAILABLE_STATE_SLUGS to have been hand-updated whenever
 * the cron moves. */
export const CRON_HOUR_UTC = 18;

/** AuditLab SYNC-2 (2026-08-09, fixed 2026-08-13): SMS_UNAVAILABLE_STATE_SLUGS
 * used to be a hand-maintained literal -- correct at the 18:00 UTC cron by a
 * two-hour margin on each side (quantified: 16:00 undercounts to 4 states
 * including Alaska/Hawaii, 22:00 overcounts to 0), so any future cron-time
 * change would silently desynchronize it. A cron move EARLIER makes this
 * set under-report, which is the dangerous direction -- a subscriber in a
 * newly-outside-quiet-hours state completes opt-in, gets a working
 * verification code (that send is on-demand, not cron-gated), and then
 * never receives an alert, exactly the harm SMS-1 exists to prevent.
 * Computed here instead, so it can never drift from CRON_HOUR_UTC/
 * QUIET_HOURS_START/QUIET_HOURS_END -- the only way it becomes wrong is if
 * CRON_HOUR_UTC itself falls out of sync with the real cron schedule, which
 * the preship check above catches. */
function computeSmsUnavailableStateSlugs(cronHourUtc: number): Set<string> {
  const unavailable = new Set<string>();
  for (const [slug, offset] of Object.entries(STATE_TIMEZONE_UTC_OFFSET)) {
    const localHour = (((cronHourUtc + offset) % 24) + 24) % 24;
    if (!(localHour >= QUIET_HOURS_START && localHour < QUIET_HOURS_END)) {
      unavailable.add(slug);
    }
  }
  return unavailable;
}

/** The jurisdictions whose local hour at the daily cron falls OUTSIDE the
 * 8am-9pm quiet-hours window every single day -- runSmsAlertPass()
 * correctly never sends to them, but nothing told the subscriber that
 * before they completed opt-in. Someone whose ONLY licensed state(s) are
 * in this set could tick consent, receive a working verification code,
 * get sms_opted_in=1, and then receive nothing ever -- worse than never
 * offering the channel, since they have every reason to believe it's on
 * and may rely on a text that never comes. Used by
 * handleSubscriberPhoneStartVerification() to refuse opt-in upfront with
 * an honest message, rather than silently accepting a confirmation that
 * can never be honored. */
export const SMS_UNAVAILABLE_STATE_SLUGS = computeSmsUnavailableStateSlugs(CRON_HOUR_UTC);

/** AuditLab SMS-3 (MEDIUM, 2026-08-09): identifies WHICH disclosure text a
 * consent record refers to -- bump this (and the matching string literal
 * generate.py's /my/ SMS panel sends) any time the consent checkbox's
 * disclosure copy changes, so a stored consent record always says what the
 * subscriber actually saw. Not enforced two-sided the way FIELD_COMPUTED_STATES
 * is (SYNC-1) -- the server records whatever version string arrives rather
 * than validating it against a known-current value, since the record IS
 * the deliverable regardless of which version is current at read time. */
export const SMS_CONSENT_VERSION = "sms-consent-2026-08-09";

/** true only when it is currently safe (8am-9pm local) to send an SMS to
 * this state's subscribers. Fails closed (false) for any unlisted
 * jurisdiction -- never guessed, same posture as every other "we don't
 * know" branch in this codebase. */
export function isWithinSmsQuietHours(stateSlug: string, now: Date): boolean {
  const offset = STATE_TIMEZONE_UTC_OFFSET[stateSlug];
  if (offset === undefined) return false;
  const localMs = now.getTime() + offset * 60 * 60 * 1000;
  const localHour = new Date(localMs).getUTCHours();
  return localHour >= QUIET_HOURS_START && localHour < QUIET_HOURS_END;
}

/**
 * Validates Twilio's X-Twilio-Signature header (RFC: base64(HMAC-SHA1(
 * authToken, url + sorted-concatenated-POST-params))) -- the standard
 * Twilio webhook-authenticity scheme. Without this, POST /sms/inbound
 * would be a public, unauthenticated endpoint that anyone could call to
 * forge an opt-out (or a false opt-in) on an arbitrary phone number.
 * Never throws; a malformed signature or params object fails closed
 * (returns false).
 */
export async function isValidTwilioSignature(
  authToken: string,
  signatureHeader: string | null,
  fullUrl: string,
  params: Record<string, string>
): Promise<boolean> {
  if (!signatureHeader) return false;
  try {
    const sortedKeys = Object.keys(params).sort();
    let data = fullUrl;
    for (const key of sortedKeys) data += key + params[key];

    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(authToken), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
    const computed = btoa(String.fromCharCode(...new Uint8Array(sig)));

    // Constant-time-ish compare -- lengths must match first (btoa output
    // is fixed-length for a fixed-length HMAC-SHA1 digest, so an early
    // return here doesn't leak meaningful timing information beyond what
    // the length check itself already reveals).
    if (computed.length !== signatureHeader.length) return false;
    let diff = 0;
    for (let i = 0; i < computed.length; i++) diff |= computed.charCodeAt(i) ^ signatureHeader.charCodeAt(i);
    return diff === 0;
  } catch {
    return false;
  }
}
