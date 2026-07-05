/**
 * DeadlineRadar Worker -- email copy (Phase 2).
 *
 * Ported from reminders/emails.py. Only the confirmation email is ported here
 * (that is the one thing a /subscribe triggers). Reminder + stop-confirmation
 * emails belong to the Phase-3 scheduler and are intentionally NOT ported yet.
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
export const BRAND_NAME = "Ravenline";
export const SENDER_LINE = `${SITE_NAME} (a ${BRAND_NAME} project)`;

// CAN-SPAM requires a valid physical postal address in every commercial email.
// This is Ravenline's real mail-receiving address (Anytime Mailbox, Aurora CO).
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
    `${esc(SENDER_LINE)}<br>${esc(addr)}</p>`
  );
}

function textFooter(unsubscribeUrl: string, addr: string): string {
  return (
    `\n\n---\n` +
    `You're getting this because you asked ${SITE_NAME} to track a CPA license renewal deadline. ` +
    `We send only renewal reminders for that one deadline -- no marketing, ever.\n\n` +
    `Unsubscribe any time, instantly: ${unsubscribeUrl}\n\n` +
    `${SENDER_LINE}\n${addr}`
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

/** Port of reminders/emails.py `confirmation_email()`. */
export function buildConfirmationEmail(
  stateName: string,
  confirmUrl: string,
  unsubscribeUrl: string,
  firstName: string | null = null
): BuiltEmail {
  // Hard-fail FIRST, before composing anything -- so a half-built email with
  // a placeholder footer can never exist.
  const addr = mailingAddress();
  const subject = `Confirm your ${stateName} CPA renewal reminder`;

  const textBody =
    `${textGreeting(firstName)}\n\n` +
    `Someone (hopefully you) asked ${SITE_NAME} to send renewal reminders for a ${stateName} CPA ` +
    `license. Please confirm this is really your inbox before we send anything else:\n\n` +
    `${confirmUrl}\n\n` +
    `If you don't click that link, we will never email you again -- nothing else happens ` +
    `automatically.\n\n` +
    `Once confirmed, we'll email you as the renewal date approaches: 60, 30, 14, 7, 3, and 1 day ` +
    `before. That's the whole schedule -- no marketing, no third-party offers, ever.` +
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
          "1 day before. That's the whole schedule &mdash; no marketing, no third-party offers, ever.",
        13,
        LIGHT.muted
      ),
    htmlFooter(unsubscribeUrl, addr)
  );

  return { subject, textBody, htmlBody, headers: {} };
}
