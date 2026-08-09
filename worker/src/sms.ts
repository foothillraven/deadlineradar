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
 * licensing state -- close enough for a fixed-time daily cron that's
 * already deeply centered in the 8am-9pm window (18:00 UTC = 1pm ET/
 * 12pm CT/11am MT/10am PT, 3+ hours of margin on both sides even before
 * accounting for a state's own internal timezone spread or seasonal DST
 * drift). A jurisdiction genuinely incompatible with a single fixed daily
 * cron time (Guam/CNMI, UTC+10 -- the cron fires at ~4am their next local
 * day) is listed with its REAL offset rather than omitted, so the check
 * below correctly and consistently computes "outside quiet hours, skip"
 * for it every day, rather than hardcoding an exclusion. A jurisdiction
 * NOT listed here fails closed (isWithinSmsQuietHours returns false) --
 * never guessed.
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

/** AuditLab SMS-1 (MEDIUM, 2026-08-09): the two jurisdictions whose real
 * UTC+10 offset (see STATE_TIMEZONE_UTC_OFFSET's own docstring) puts them
 * OUTSIDE the 8am-9pm quiet-hours window every single day against the
 * fixed 18:00 UTC cron -- runSmsAlertPass() correctly never sends to them,
 * but nothing told the subscriber that before they completed opt-in.
 * Someone whose ONLY licensed state(s) are in this set could tick consent,
 * receive a working verification code (that send is on-demand, not
 * cron-gated, so it DOES arrive), get sms_opted_in=1, and then receive
 * nothing ever -- worse than never offering the channel, since they have
 * every reason to believe it's on and may rely on a text that never comes.
 * Used by handleSubscriberPhoneStartVerification() to refuse opt-in
 * upfront with an honest message, rather than silently accepting a
 * confirmation that can never be honored. */
export const SMS_UNAVAILABLE_STATE_SLUGS = new Set(["guam", "northern-mariana-islands"]);

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
