/**
 * DeadlineRadar Worker -- email copy (Phase 2).
 *
 * Ported from reminders/emails.py: the confirmation email (/subscribe), the
 * escalating reminder email (Phase-3 scheduler), and the stop-confirmation
 * email (/renewed, offering an optional re-arm for next cycle).
 *
 * Every email carries, per CAN-SPAM and this project's own rules:
 *   - Sender identification in plain language (SENDER_LINE).
 *   - A REAL physical postal address (MAILING_ADDRESS below). Unlike the
 *     Python original, which reads the address from an env var and hard-fails
 *     if unset, the Worker keeps it as a checked module constant: buildConfirmationEmail()
 *     still refuses to build (throws) if it is ever blanked out, so a
 *     placeholder can never reach a real recipient.
 *   - A one-click unsubscribe link, honored instantly by store.stop().
 *
 * Built as BOTH plain-text and HTML (multipart). The HTML uses styled anchor
 * "buttons" and the same color values as generate.py's PAGE_CSS so the email
 * reads as the same product as the site. Table-based layout + inline styles
 * for email-client compatibility; the <style> block adds dark-mode + small
 * responsive tweaks on top.
 */

import { escapeHtml } from "./validation";

export const SITE_URL = "https://deadline-radar.com";
export const SITE_NAME = "DeadlineRadar";
export const BRAND_NAME = "Moose & Raven LLC";
export const SENDER_LINE = `${SITE_NAME} (a ${BRAND_NAME} project)`;

// CAN-SPAM requires a valid physical postal address in every commercial email.
// This is Moose & Raven LLC's real mail-receiving address (Anytime Mailbox, Aurora CO).
// Kept as a constant, not fabricated -- buildConfirmationEmail() asserts it is
// still a real, non-empty address before composing anything (see below), so a
// blanked-out value fails closed rather than shipping an empty footer.
export const MAILING_ADDRESS = "18121 E Hampden Ave, Unit C #1324, Aurora, CO 80013";

// Same minimum-length guard as reminders/emails.py's MIN_MAILING_ADDRESS_LEN:
// a real physical address is never this short. Catches the constant being
// accidentally blanked or truncated to something useless.
const MIN_MAILING_ADDRESS_LEN = 10;

const MAX_FIRST_NAME_LEN = 60;

const LIGHT = {
  bg: "#f3f5f7",
  card: "#ffffff",
  fg: "#1a2129",
  muted: "#5b6572",
  border: "#d8dee5",
  accent: "#1f5fbf",
};
const DARK = {
  bg: "#0d1013",
  card: "#1a1f26",
  fg: "#e7ebf0",
  muted: "#9aa5b1",
  border: "#2a323c",
  accent: "#7fb0ff",
};

function esc(s: string): string {
  return escapeHtml(String(s));
}

/**
 * Defense-in-depth only -- index.ts already trims/caps first_name and rejects
 * control characters on every field before this runs. Re-sanitize anyway
 * (drop non-printable, re-cap length), mirroring emails.py's _safe_first_name.
 */
function safeFirstName(firstName: string | null | undefined): string | null {
  if (!firstName) return null;
  // Drop ASCII control chars and cap length. (EMAIL_RE / hasControlChars
  // upstream already block CR/LF etc.; this is the belt to that suspenders.)
  const cleaned = Array.from(firstName.trim())
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f;
    })
    .join("")
    .slice(0, MAX_FIRST_NAME_LEN);
  return cleaned.length > 0 ? cleaned : null;
}

function textGreeting(firstName: string | null): string {
  const name = safeFirstName(firstName);
  return name ? `Hi ${name},` : "Hi there,";
}

function htmlGreeting(firstName: string | null): string {
  const name = safeFirstName(firstName);
  return name ? `Hi ${esc(name)},` : "Hi there,";
}

function mailingAddress(): string {
  const cleaned = MAILING_ADDRESS.trim();
  if (cleaned.length < MIN_MAILING_ADDRESS_LEN) {
    throw new Error(
      "REFUSING TO BUILD EMAIL: no real mailing address configured. CAN-SPAM requires a real " +
        "physical postal address in every commercial email -- it cannot be fabricated."
    );
  }
  return cleaned;
}

function button(url: string, label: string): string {
  return (
    `<a href="${esc(url)}" class="dr-btn" ` +
    `style="display:inline-block;background:${LIGHT.accent};color:#ffffff;` +
    `text-decoration:none;font-weight:700;font-size:15px;line-height:1;` +
    `padding:13px 24px;border-radius:8px;">${esc(label)}</a>`
  );
}

function textLink(url: string, label: string): string {
  return (
    `<a href="${esc(url)}" class="dr-accent" ` +
    `style="color:${LIGHT.accent};text-decoration:underline;font-size:13px;">${esc(label)}</a>`
  );
}

function htmlFooter(unsubscribeUrl: string, addr: string): string {
  return (
    `<p class="dr-muted" style="font-size:12px;color:${LIGHT.muted};line-height:1.6;margin:0 0 10px;">` +
    `You're getting this because you asked ${esc(SITE_NAME)} to track a CPA license renewal ` +
    `deadline. We send only renewal reminders for that one deadline &mdash; no marketing, ever.` +
    `</p>` +
    `<p style="font-size:13px;margin:0 0 10px;">${textLink(unsubscribeUrl, "Unsubscribe")}</p>` +
    `<p class="dr-muted" style="font-size:11px;color:${LIGHT.muted};line-height:1.5;margin:0;">` +
    `${esc(SENDER_LINE)}<br>${esc(addr)}</p>` +
    `<p class="dr-muted" style="font-size:11px;color:${LIGHT.muted};line-height:1.5;margin:8px 0 0;">` +
    `${esc(SITE_NAME)} is an independent reminder service operated by ${esc(BRAND_NAME)}. It is not ` +
    `affiliated with, endorsed by, or connected to NASBA, the AICPA, or any state board of ` +
    `accountancy. Renewal dates are compiled from public sources for informational purposes only ` +
    `&mdash; not legal, tax, or professional advice. Always confirm your exact renewal date with ` +
    `your state board or on your license.</p>`
  );
}

function textFooter(unsubscribeUrl: string, addr: string): string {
  return (
    `\n\n---\n` +
    `You're getting this because you asked ${SITE_NAME} to track a CPA license renewal deadline. ` +
    `We send only renewal reminders for that one deadline -- no marketing, ever.\n\n` +
    `Unsubscribe any time, instantly: ${unsubscribeUrl}\n\n` +
    `${SENDER_LINE}\n${addr}\n\n` +
    `${SITE_NAME} is an independent reminder service operated by ${BRAND_NAME}. It is not ` +
    `affiliated with, endorsed by, or connected to NASBA, the AICPA, or any state board of ` +
    `accountancy. Renewal dates are compiled from public sources for informational purposes only ` +
    `-- not legal, tax, or professional advice. Always confirm your exact renewal date with your ` +
    `state board or on your license.`
  );
}

function htmlShell(preheader: string, bodyHtml: string, footerHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(SITE_NAME)}</title>
<style>
  body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
  body { margin: 0; padding: 0; }
  img { border: 0; line-height: 100%; outline: none; text-decoration: none; }
  @media (prefers-color-scheme: dark) {
    .dr-bg { background: ${DARK.bg} !important; }
    .dr-card { background: ${DARK.card} !important; border-color: ${DARK.border} !important; }
    .dr-fg { color: ${DARK.fg} !important; }
    .dr-muted { color: ${DARK.muted} !important; }
    .dr-accent { color: ${DARK.accent} !important; }
    .dr-btn { background: ${DARK.accent} !important; color: #0d1013 !important; }
  }
  @media (max-width: 600px) {
    .dr-container { width: 100% !important; }
    .dr-pad { padding: 22px !important; }
  }
</style>
</head>
<body class="dr-bg" style="margin:0;padding:0;background:${LIGHT.bg};">
<span style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${esc(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="dr-bg" style="background:${LIGHT.bg};">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" class="dr-container" style="width:560px;max-width:100%;">
<tr><td class="dr-pad" style="padding-bottom:20px;">
  <a href="${esc(SITE_URL)}" style="text-decoration:none;">
    <span class="dr-fg" style="font-size:20px;font-weight:800;letter-spacing:-0.02em;color:${LIGHT.fg};">${esc(SITE_NAME)}</span>
  </a>
</td></tr>
<tr><td class="dr-card dr-pad" style="background:${LIGHT.card};border:1px solid ${LIGHT.border};border-radius:12px;padding:32px;">
${bodyHtml}
</td></tr>
<tr><td class="dr-pad" style="padding-top:20px;">
${footerHtml}
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

function p(text: string, size = 15, color: string | null = null): string {
  const c = color ?? LIGHT.fg;
  return `<p class="dr-fg" style="margin:0 0 16px;font-size:${size}px;line-height:1.6;color:${c};">${text}</p>`;
}

export interface BuiltEmail {
  subject: string;
  textBody: string;
  htmlBody: string;
  headers: Record<string, string>;
}

/**
 * RFC 8058 one-click List-Unsubscribe headers. Lets Gmail/Apple Mail show a
 * native "Unsubscribe" that POSTs `List-Unsubscribe=One-Click` to the URL (the
 * POST /unsubscribe handler reads the token from the URL query) -- a real
 * one-click stop that also improves deliverability. The URL is a GET-safe
 * landing page too, so a scanner GETting it changes nothing.
 */
function listUnsubHeaders(unsubscribeUrl: string): Record<string, string> {
  return {
    "List-Unsubscribe": `<${unsubscribeUrl}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Port of generate.py `fmt_date()` -- "July 4, 2026". UTC fields, matching
 * deadline.ts's UTC-midnight Date convention. */
export function fmtDate(d: Date): string {
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

// High-importance transport headers -- attached ONLY to the final (1-day)
// reminder tier by buildReminderEmail below. Flagging every email
// high-priority is a cry-wolf signal that hurts deliverability, so it's
// reserved for when it's genuinely warranted. Mirrors emails.py.
export const HIGH_IMPORTANCE_HEADERS: Record<string, string> = {
  Importance: "High",
  "X-Priority": "1",
  "X-MSMail-Priority": "High",
};

// `threshold` picks the urgency LEAD phrase only; the TRUE remaining day count
// (actualDaysRemaining) is what the subject/body display, kept separate so the
// two can never contradict (emails.py's own adversarial-review fix).
const URGENCY_LEAD: Record<number, string> = {
  60: "Nothing urgent yet, just flagging it early",
  30: "A good time to start gathering what you'll need",
  14: "Two weeks out, worth doing this now rather than later",
  7: "One week to go",
  3: "Just a few days left",
  1: "This is your final reminder for this deadline",
};

function daysPhrase(actual: number): string {
  if (actual > 0) return `in ${actual} day${actual !== 1 ? "s" : ""}`;
  if (actual === 0) return "today";
  return `${-actual} day${actual !== -1 ? "s" : ""} ago`;
}

/** Port of emails.py `_reminder_subject()` -- built from the TRUE remaining
 * count, never the threshold (so a scheduler gap can't produce a subject that
 * contradicts the body). */
function reminderSubject(stateName: string, threshold: number, actual: number, deadlineStr: string): string {
  if (threshold === 1) {
    let lead: string;
    if (actual === 1) lead = "Tomorrow";
    else if (actual === 0) lead = "Today";
    else if (actual < 0) lead = "Overdue";
    else {
      const ph = daysPhrase(actual);
      lead = ph.charAt(0).toUpperCase() + ph.slice(1);
    }
    return `${lead}: your ${stateName} CPA license renewal is due`;
  }
  const dp = daysPhrase(actual);
  if (threshold === 60) return `Your ${stateName} CPA license expires ${dp} (${deadlineStr})`;
  if (threshold === 30 || threshold === 14 || threshold === 7) {
    return `Your ${stateName} CPA license renewal is due ${dp} (${deadlineStr}) — a good time to start`;
  }
  return `Your ${stateName} CPA license renewal is due ${dp} (${deadlineStr})`;
}

/** Port of reminders/emails.py `reminder_email()`. */
export function buildReminderEmail(
  stateName: string,
  deadlineDateStr: string,
  threshold: number,
  actualDaysRemaining: number,
  renewedUrl: string,
  unsubscribeUrl: string,
  firstName: string | null = null
): BuiltEmail {
  const lead = URGENCY_LEAD[threshold];
  if (lead === undefined) {
    throw new Error(`threshold must be one of ${Object.keys(URGENCY_LEAD).join(",")}, got ${threshold}`);
  }
  const addr = mailingAddress();
  const subject = reminderSubject(stateName, threshold, actualDaysRemaining, deadlineDateStr);
  // High-importance headers ONLY on the final (1-day) tier; List-Unsubscribe on
  // every reminder.
  const headers: Record<string, string> = {
    ...(threshold === 1 ? HIGH_IMPORTANCE_HEADERS : {}),
    ...listUnsubHeaders(unsubscribeUrl),
  };

  let whenPhrase: string;
  if (actualDaysRemaining > 0) {
    whenPhrase = `${actualDaysRemaining} day${actualDaysRemaining !== 1 ? "s" : ""} from now`;
  } else if (actualDaysRemaining === 0) {
    whenPhrase = "today";
  } else {
    whenPhrase = `${-actualDaysRemaining} day${actualDaysRemaining !== -1 ? "s" : ""} ago`;
  }

  const textBody =
    `${textGreeting(firstName)}\n\n` +
    `${lead} -- your ${stateName} CPA license renewal is due ${deadlineDateStr} (${whenPhrase}).\n\n` +
    `Already renewed? One click stops every further reminder for this deadline:\n` +
    `${renewedUrl}\n\n` +
    `Nothing to do yet? We'll remind you again as it gets closer, right up through the day before.` +
    `${textFooter(unsubscribeUrl, addr)}`;

  const htmlBody = htmlShell(
    `${lead}: ${stateName} CPA renewal due ${deadlineDateStr}`,
    `<h1 class="dr-fg" style="margin:0 0 16px;font-size:19px;font-weight:700;color:${LIGHT.fg};">` +
      `${esc(lead)}</h1>` +
      p(
        `${htmlGreeting(firstName)}<br><br>` +
          `Your ${esc(stateName)} CPA license renewal is due <strong>${esc(deadlineDateStr)}</strong> ` +
          `(${esc(whenPhrase)}).`
      ) +
      `<p style="margin:0 0 20px;">${button(renewedUrl, "Stop these reminders")}</p>` +
      p("Already renewed? The button above stops every further reminder for this deadline.", 13, LIGHT.muted) +
      p(
        "Nothing to do yet? We'll remind you again as it gets closer, right up through the day before.",
        13,
        LIGHT.muted
      ),
    htmlFooter(unsubscribeUrl, addr)
  );

  return { subject, textBody, htmlBody, headers };
}

/**
 * Port of reminders/emails.py `stop_confirmation_email()`. Sent after a
 * subscriber stops reminders. For reason="renewed" it congratulates them and
 * (if a rearmUrl is given) offers a one-click re-arm for next cycle. For
 * reason="unsubscribed" it's a plain goodbye. Normal priority.
 */
export function buildStopConfirmationEmail(
  reason: "renewed" | "unsubscribed",
  stateName: string,
  rearmUrl: string | null,
  unsubscribeUrl: string,
  firstName: string | null = null
): BuiltEmail {
  const addr = mailingAddress();
  const greetingText = textGreeting(firstName);
  const greetingHtml = htmlGreeting(firstName);

  let subject: string;
  let textBody: string;
  let htmlInner: string;

  if (reason === "renewed") {
    subject = `No more reminders for this ${stateName} renewal`;
    textBody =
      `${greetingText}\n\n` +
      `Nice work -- we've stopped every reminder for this ${stateName} CPA renewal cycle. ` +
      `You won't hear from us again about this deadline.\n\n`;
    let htmlExtra: string;
    if (rearmUrl) {
      textBody +=
        `Want a reminder next cycle too? One click re-arms it, nothing else changes:\n` +
        `${rearmUrl}\n\n` +
        `If you don't click that, we simply won't email you again about this.`;
      htmlExtra =
        `<p style="margin:0 0 20px;">${button(rearmUrl, "Remind me next time")}</p>` +
        p(
          "Nothing else changes if you don't click it -- we simply won't email you again about this.",
          13,
          LIGHT.muted
        );
    } else {
      textBody += "Want reminders again someday? You're welcome to sign up fresh any time.";
      htmlExtra = p("Want reminders again someday? You're welcome to sign up fresh any time.", 13, LIGHT.muted);
    }
    htmlInner =
      `<h1 class="dr-fg" style="margin:0 0 16px;font-size:19px;font-weight:700;color:${LIGHT.fg};">Nice work</h1>` +
      p(
        `${greetingHtml}<br><br>` +
          `We've stopped every reminder for this ${esc(stateName)} CPA renewal cycle. You won't ` +
          `hear from us again about this deadline.`
      ) +
      htmlExtra;
  } else {
    subject = `You're unsubscribed from ${stateName} renewal reminders`;
    textBody =
      `${greetingText}\n\n` +
      `You're unsubscribed. We've stopped every reminder for this ${stateName} CPA renewal ` +
      `immediately and permanently -- you won't hear from us again unless you sign up again ` +
      `yourself.\n\n` +
      `Sorry to see you go, and thanks for trying ${SITE_NAME}.`;
    htmlInner =
      `<h1 class="dr-fg" style="margin:0 0 16px;font-size:19px;font-weight:700;color:${LIGHT.fg};">` +
      `You're unsubscribed</h1>` +
      p(
        `${greetingHtml}<br><br>` +
          `We've stopped every reminder for this ${esc(stateName)} CPA renewal immediately and ` +
          `permanently &mdash; you won't hear from us again unless you sign up again yourself.`
      ) +
      p(`Sorry to see you go, and thanks for trying ${esc(SITE_NAME)}.`, 13, LIGHT.muted);
  }

  textBody += textFooter(unsubscribeUrl, addr);
  const htmlBody = htmlShell(subject, htmlInner, htmlFooter(unsubscribeUrl, addr));
  return { subject, textBody, htmlBody, headers: listUnsubHeaders(unsubscribeUrl) };
}

/** Port of reminders/emails.py `confirmation_email()`. */
export function buildConfirmationEmail(
  stateName: string,
  confirmUrl: string,
  unsubscribeUrl: string,
  firstName: string | null = null,
  // "Bring your own date" (2026-07-05): only ever non-null on the
  // user-provided-date path -- a computed-state signup still doesn't know a
  // specific date at confirm-request time (computing it requires calling
  // computeSubscriberDeadline(), which the scheduler does fresh on its own
  // schedule, not here), same as before this feature existed.
  deadlineDateStr: string | null = null
): BuiltEmail {
  // Hard-fail FIRST, before composing anything -- so a half-built email with
  // a placeholder footer can never exist.
  const addr = mailingAddress();
  const subject = `Confirm your ${stateName} CPA renewal reminder`;
  const dateSentenceText = deadlineDateStr ? ` We'll remind you before ${deadlineDateStr}.` : "";
  const dateSentenceHtml = deadlineDateStr ? ` We'll remind you before ${esc(deadlineDateStr)}.` : "";

  const textBody =
    `${textGreeting(firstName)}\n\n` +
    `Someone (hopefully you) asked ${SITE_NAME} to send renewal reminders for a ${stateName} CPA ` +
    `license. Please confirm this is really your inbox before we send anything else:\n\n` +
    `${confirmUrl}\n\n` +
    `If you don't click that link, we will never email you again -- nothing else happens ` +
    `automatically.\n\n` +
    `Once confirmed, we'll email you as the renewal date approaches: 60, 30, 14, 7, 3, and 1 day ` +
    `before. That's the whole schedule -- no marketing, no third-party offers, ever.${dateSentenceText}` +
    `${textFooter(unsubscribeUrl, addr)}`;

  const htmlBody = htmlShell(
    `Confirm your ${stateName} CPA renewal reminder`,
    `<h1 class="dr-fg" style="margin:0 0 16px;font-size:19px;font-weight:700;color:${LIGHT.fg};">` +
      `Confirm your reminder</h1>` +
      p(
        `${htmlGreeting(firstName)}<br><br>` +
          `Someone (hopefully you) asked ${esc(SITE_NAME)} to send renewal reminders for a ` +
          `${esc(stateName)} CPA license. Please confirm this is really your inbox before we ` +
          `send anything else.`
      ) +
      `<p style="margin:0 0 20px;">${button(confirmUrl, "Confirm my email")}</p>` +
      p(
        "If you don't click that button, we will never email you again &mdash; nothing else " +
          "happens automatically.",
        13,
        LIGHT.muted
      ) +
      p(
        "Once confirmed, we'll email you as the renewal date approaches: 60, 30, 14, 7, 3, and " +
          `1 day before. That's the whole schedule &mdash; no marketing, no third-party offers, ever.${dateSentenceHtml}`,
        13,
        LIGHT.muted
      ),
    htmlFooter(unsubscribeUrl, addr)
  );

  return { subject, textBody, htmlBody, headers: listUnsubHeaders(unsubscribeUrl) };
}
