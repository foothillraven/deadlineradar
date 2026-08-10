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

// Roadmap #26 (migration 0040): the one fixed self-service snooze
// duration -- see that migration's own docstring for why this isn't a
// configurable day-count. Defined here (not scheduler.ts) since
// buildReminderEmail() below needs it for its own copy, and scheduler.ts
// already imports from this module -- keeping the dependency one-directional.
export const SNOOZE_DAYS = 14;

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

/**
 * Port of reminders/emails.py `reminder_email()`, with TWO co-equal one-click
 * CTAs (2026-07-28 firm-dashboard MVP -- previously there was only one,
 * "Stop these reminders," and getting to "I renewed, remind me next cycle"
 * took a second follow-up email with its own buried re-arm link -- three hops
 * total. Now it's one):
 *   - renewedNextCycleUrl: "I've renewed -- remind me next cycle" -- the new
 *     atomic stop-this-cycle-AND-rearm-for-next-cycle action
 *     (store.renewAndRearmByToken(), index.ts's handleRenewedNextCycle()).
 *     One click, nothing else to do.
 *   - renewedUrl: "Stop reminders entirely" -- today's plain stop
 *     (store.stop(token,'renewed'), index.ts's handleRenewed()), mechanically
 *     UNCHANGED; only its label here changed (it used to be the only button).
 * The footer's separate Unsubscribe link (unsubscribeUrl) is untouched by
 * this change -- it was never one of the two CTAs above; it's the same
 * always-present, permanent, no-follow-up opt-out it always was.
 */
export function buildReminderEmail(
  stateName: string,
  deadlineDateStr: string,
  threshold: number,
  actualDaysRemaining: number,
  renewedNextCycleUrl: string,
  renewedUrl: string,
  unsubscribeUrl: string,
  firstName: string | null = null,
  // Roadmap #19 (2026-08-07): lightweight white-label. Non-null only for a
  // firm-tracked subscriber whose firm exists (scheduler.ts looks this up) --
  // a free-tier individual's reminder is byte-identical to before this
  // parameter existed. Shown as a plain attribution line, never replacing
  // DeadlineRadar's own identity/footer (that stays exactly as-is below).
  firmName: string | null = null,
  // Roadmap #26 (2026-08-07): self-service snooze link. Optional/defaulted
  // like firmName above -- every existing caller that doesn't pass one
  // renders byte-identical to before this parameter existed (no snooze CTA
  // shown). scheduler.ts always passes a real value.
  snoozeUrl: string | null = null
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

  // Roadmap #26: withheld on the final (1-day) tier specifically -- that
  // reminder IS the safety net for someone who hasn't renewed yet, and a
  // 14-day snooze from there would push well past most real deadlines.
  // Every earlier tier still gets another escalation before the 1-day one,
  // so snoozing there is a genuine "not yet, ask me later" rather than
  // walking away from the deadline entirely.
  const showSnooze = snoozeUrl !== null && threshold !== 1;

  const firmAttribution = firmName ? `This reminder is sent by ${firmName} via DeadlineRadar.\n\n` : "";
  const snoozeTextCta = showSnooze
    ? `Not ready to deal with this yet? Remind me again in ${SNOOZE_DAYS} days instead:\n${snoozeUrl}\n\n`
    : "";
  const textBody =
    `${textGreeting(firstName)}\n\n` +
    firmAttribution +
    `${lead} -- your ${stateName} CPA license renewal is due ${deadlineDateStr} (${whenPhrase}).\n\n` +
    `Already renewed? One click confirms it and keeps your reminders going for next cycle:\n` +
    `${renewedNextCycleUrl}\n\n` +
    `Renewed and don't want any more reminders for this deadline at all? Stop them entirely instead:\n` +
    `${renewedUrl}\n\n` +
    snoozeTextCta +
    `Nothing to do yet? We'll remind you again as it gets closer, right up through the day before.` +
    `${textFooter(unsubscribeUrl, addr)}`;

  const htmlBody = htmlShell(
    `${lead}: ${stateName} CPA renewal due ${deadlineDateStr}`,
    `<h1 class="dr-fg" style="margin:0 0 16px;font-size:19px;font-weight:700;color:${LIGHT.fg};">` +
      `${esc(lead)}</h1>` +
      p(
        `${htmlGreeting(firstName)}<br><br>` +
          (firmName ? `This reminder is sent by <strong>${esc(firmName)}</strong> via DeadlineRadar.<br><br>` : "") +
          `Your ${esc(stateName)} CPA license renewal is due <strong>${esc(deadlineDateStr)}</strong> ` +
          `(${esc(whenPhrase)}).`
      ) +
      `<p style="margin:0 0 12px;">${button(renewedNextCycleUrl, "I've renewed -- remind me next cycle")}</p>` +
      p(
        "One click: confirms you've renewed and keeps reminders going for your next renewal cycle.",
        13,
        LIGHT.muted
      ) +
      `<p style="margin:0 0 12px;">${button(renewedUrl, "Stop reminders entirely")}</p>` +
      p("Use this instead if you don't want any more reminders for this deadline at all.", 13, LIGHT.muted) +
      (showSnooze
        ? p(
            `Not ready yet? <a href="${esc(snoozeUrl)}" style="color:${LIGHT.accent};">Remind me again in ${SNOOZE_DAYS} days</a> instead.`,
            13,
            LIGHT.muted
          )
        : "") +
      p(
        "Nothing to do yet? We'll remind you again as it gets closer, right up through the day before.",
        13,
        LIGHT.muted
      ),
    htmlFooter(unsubscribeUrl, addr)
  );

  return { subject, textBody, htmlBody, headers };
}

export interface DigestItem {
  stateName: string;
  deadlineDateStr: string;
  threshold: number;
  daysRemaining: number;
  // The row's own real unsubscribe_token URL -- "stop this one" per item,
  // same real token every other email in this file already uses, no new
  // token type invented for the digest.
  rowUnsubscribeUrl: string;
}

/**
 * Roadmap #24 (2026-08-08): the digest-mode alternative to buildReminderEmail()
 * above -- ONE email bundling every currently-due item for a person who opted
 * into weekly delivery, instead of one email per threshold. Sent only when
 * `items` is non-empty (runDigestPass() never calls this with an empty list --
 * no "nothing to report" filler email exists). Deliberately does NOT reuse
 * htmlFooter()/textFooter() above -- their copy says "that one deadline,"
 * which is wrong once more than one item is listed. `manageUrl` is the
 * sign-in-required "/my/" hub (same posture as buildRuleChangeAdminAlertEmail's
 * accountSettingsUrl -- a real destination, not a token, since changing the
 * delivery-mode PREFERENCE itself is a session-gated action, same as every
 * other self-service preference on that page) where a recipient can switch
 * back to immediate delivery or manage anything else. Each item additionally
 * carries its own instant "stop this one" link using that row's real token --
 * no single link could mean "unsubscribe from everything in one click" here
 * the way buildReminderEmail's list-unsubscribe header can for a single
 * deadline, so no List-Unsubscribe header is attached; the per-item links
 * plus the manage-everything hub are the compliant opt-out path instead.
 */
export function buildDigestEmail(items: DigestItem[], manageUrl: string, firstName: string | null = null): BuiltEmail {
  if (items.length === 0) {
    throw new Error("buildDigestEmail: items must be non-empty -- a digest is never sent with nothing to report");
  }
  const addr = mailingAddress();
  const count = items.length;
  const subject =
    count === 1
      ? `Your weekly summary: 1 renewal needs attention`
      : `Your weekly summary: ${count} renewals need attention`;

  const textItems = items
    .map((it) => {
      const dp = daysPhrase(it.daysRemaining);
      return (
        `- ${it.stateName}: due ${it.deadlineDateStr} (${dp})\n` +
        `  Stop reminders for this one: ${it.rowUnsubscribeUrl}`
      );
    })
    .join("\n\n");

  const textBody =
    `${textGreeting(firstName)}\n\n` +
    `Here's this week's bundled summary from ${SITE_NAME} -- ${count === 1 ? "one renewal" : `${count} renewals`} ` +
    `currently need your attention:\n\n` +
    `${textItems}\n\n` +
    `Want these one at a time instead, as each becomes due? Switch back to immediate reminders any time:\n` +
    `${manageUrl}\n\n` +
    `Nothing to do for anything not listed above -- we'll include it here once it's actually due.` +
    `\n\n---\n` +
    `You're getting this because you asked ${SITE_NAME} to track CPA license renewal deadlines, and chose ` +
    `weekly digest delivery instead of individual reminders. Manage or change this any time: ${manageUrl}\n\n` +
    `${SENDER_LINE}\n${addr}\n\n` +
    `${SITE_NAME} is an independent reminder service operated by ${BRAND_NAME}. It is not affiliated with, ` +
    `endorsed by, or connected to NASBA, the AICPA, or any state board of accountancy. Renewal dates are ` +
    `compiled from public sources for informational purposes only -- not legal, tax, or professional advice. ` +
    `Always confirm your exact renewal date with your state board or on your license.`;

  const htmlItems = items
    .map((it) => {
      const dp = daysPhrase(it.daysRemaining);
      return (
        `<div style="margin:0 0 16px;padding:0 0 16px;border-bottom:1px solid ${LIGHT.border};">` +
        `<p class="dr-fg" style="margin:0 0 6px;font-size:15px;font-weight:700;color:${LIGHT.fg};">` +
        `${esc(it.stateName)}</p>` +
        `<p class="dr-fg" style="margin:0 0 8px;font-size:14px;color:${LIGHT.fg};">Due ${esc(it.deadlineDateStr)} (${esc(dp)})</p>` +
        `<p style="margin:0;font-size:13px;">${textLink(it.rowUnsubscribeUrl, "Stop reminders for this one")}</p>` +
        `</div>`
      );
    })
    .join("");

  const htmlBody = htmlShell(
    `Your weekly DeadlineRadar summary -- ${count} ${count === 1 ? "renewal" : "renewals"} due`,
    `<h1 class="dr-fg" style="margin:0 0 16px;font-size:19px;font-weight:700;color:${LIGHT.fg};">` +
      `Your weekly summary</h1>` +
      p(
        `${htmlGreeting(firstName)}<br><br>` +
          `${esc(count === 1 ? "One renewal" : `${count} renewals`)} currently need your attention:`
      ) +
      htmlItems +
      p(
        `Want these one at a time instead, as each becomes due? ` +
          `<a href="${esc(manageUrl)}" style="color:${LIGHT.accent};">Switch back to immediate reminders</a> any time.`,
        13,
        LIGHT.muted
      ) +
      p("Nothing to do for anything not listed above -- we'll include it here once it's actually due.", 13, LIGHT.muted),
    `<p class="dr-muted" style="font-size:12px;color:${LIGHT.muted};line-height:1.6;margin:0 0 10px;">` +
      `You're getting this because you asked ${esc(SITE_NAME)} to track CPA license renewal deadlines, and ` +
      `chose weekly digest delivery instead of individual reminders.</p>` +
      `<p style="font-size:13px;margin:0 0 10px;">${textLink(manageUrl, "Manage my notifications")}</p>` +
      `<p class="dr-muted" style="font-size:11px;color:${LIGHT.muted};line-height:1.5;margin:0;">` +
      `${esc(SENDER_LINE)}<br>${esc(addr)}</p>` +
      `<p class="dr-muted" style="font-size:11px;color:${LIGHT.muted};line-height:1.5;margin:8px 0 0;">` +
      `${esc(SITE_NAME)} is an independent reminder service operated by ${esc(BRAND_NAME)}. It is not ` +
      `affiliated with, endorsed by, or connected to NASBA, the AICPA, or any state board of accountancy. ` +
      `Renewal dates are compiled from public sources for informational purposes only &mdash; not legal, tax, ` +
      `or professional advice. Always confirm your exact renewal date with your state board or on your license.</p>`
  );

  return { subject, textBody, htmlBody, headers: {} };
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

/**
 * migration 0008 -- the firm admin sign-in (magic link) email, sent by
 * POST /firm/signup and POST /firm/login (index.ts) whenever a login token
 * is actually issued. Deliberately its own minimal footer, NOT
 * `htmlFooter()`/`textFooter()` above -- those are hardcoded to the
 * subscriber reminder-consent copy ("you asked us to track a CPA license
 * renewal deadline... unsubscribe any time") which doesn't apply to a firm
 * admin's own account sign-in link. Still asserts a real mailing address
 * (CAN-SPAM) via `mailingAddress()` and still identifies the sender, just
 * without the reminder-specific consent/unsubscribe language.
 */
export function buildFirmLoginEmail(loginUrl: string, isPasswordReset = false, adminName: string | null = null): BuiltEmail {
  const addr = mailingAddress();
  // COPY HONESTY (2026-07-31): the same token machinery serves both "sign me
  // in" and "let me set a password", and the email must say which one the
  // recipient asked for. A reset link that arrives calling itself a plain
  // sign-in link is how the original dead end felt from the user's side.
  const subject = isPasswordReset
    ? `Set your ${SITE_NAME} password`
    : `Your ${SITE_NAME} sign-in link`;
  const lead = isPasswordReset
    ? "You asked to set a new password. Click below and we'll take you straight to a page where you can choose one."
    : "Here's your sign-in link. Click below to access your firm dashboard.";
  const cta = isPasswordReset ? "Set my password" : `Sign in to ${SITE_NAME}`;

  const textBody =
    `${textGreeting(adminName)}\n\n` +
    `Here's your ${SITE_NAME} sign-in link:\n\n` +
    `${loginUrl}\n\n` +
    `This link expires in 15 minutes and can only be used once. If it's expired by the time you ` +
    `click it, just request a new one from the sign-in page.\n\n` +
    `If you didn't request this, you can safely ignore this email -- nobody can sign in to your ` +
    `account without clicking the link above.\n\n` +
    `---\n${SENDER_LINE}\n${addr}`;

  const htmlBody = htmlShell(
    subject,
    `<h1 class="dr-fg" style="margin:0 0 16px;font-size:19px;font-weight:700;color:${LIGHT.fg};">` +
      `${esc(isPasswordReset ? "Set your password" : `Sign in to ${SITE_NAME}`)}</h1>` +
      p(htmlGreeting(adminName)) +
      p(lead) +
      `<p style="margin:0 0 20px;">${button(loginUrl, cta)}</p>` +
      p(
        "This link expires in 15 minutes and can only be used once. If it's expired by the time " +
          "you click it, just request a new one from the sign-in page.",
        13,
        LIGHT.muted
      ) +
      p(
        "If you didn't request this, you can safely ignore this email &mdash; nobody can sign in " +
          "to your account without clicking the link above.",
        13,
        LIGHT.muted
      ),
    `<p class="dr-muted" style="font-size:11px;color:${LIGHT.muted};line-height:1.5;margin:0;">` +
      `${esc(SENDER_LINE)}<br>${esc(addr)}</p>`
  );

  return { subject, textBody, htmlBody, headers: {} };
}

/**
 * migration 0045 (roadmap #11/#13/#14): sent when a Partner/Office Manager
 * invites a new person into the firm. Distinct from buildFirmLoginEmail()
 * above -- the recipient here has never had an account, so a bare "sign
 * in" link with no context would read as confusing or phishy; this names
 * who invited them, into what firm, and as what role before the same
 * underlying 15-minute single-use link (the invite IS a login token under
 * the hood -- see issueAndSendFirmMemberInviteEmail() in index.ts).
 */
export function buildFirmMemberInviteEmail(
  loginUrl: string,
  firmName: string,
  roleLabel: string,
  inviterName: string | null
): BuiltEmail {
  const addr = mailingAddress();
  // Same CRLF defense-in-depth as buildFirmStaffAddedEmail()'s own comment
  // -- firmName is attacker-influenceable text with no control-char
  // stripping of its own at this layer.
  const cleanFirmName = firmName.replace(/[\r\n]+/g, " ");
  const inviter = inviterName && inviterName.trim().length > 0 ? inviterName.trim() : `Someone at ${cleanFirmName}`;
  const subject = `${cleanFirmName} invited you to ${SITE_NAME}`;

  const textBody =
    `Hi there,\n\n` +
    `${inviter} invited you to join ${cleanFirmName} on ${SITE_NAME} as ${roleLabel}. Click below to ` +
    `accept and sign in:\n\n` +
    `${loginUrl}\n\n` +
    `This link expires in 15 minutes and can only be used once. If it's expired by the time you ` +
    `click it, ask ${cleanFirmName} to send you a fresh invite.\n\n` +
    `If you weren't expecting this, you can safely ignore this email -- nobody can sign in to this ` +
    `account without clicking the link above.\n\n` +
    `---\n${SENDER_LINE}\n${addr}`;

  const htmlBody = htmlShell(
    subject,
    `<h1 class="dr-fg" style="margin:0 0 16px;font-size:19px;font-weight:700;color:${LIGHT.fg};">` +
      `${esc(`Join ${cleanFirmName} on ${SITE_NAME}`)}</h1>` +
      p(`${esc(inviter)} invited you to join ${esc(cleanFirmName)} on ${SITE_NAME} as ${esc(roleLabel)}.`) +
      p("Click below to accept and sign in.") +
      `<p style="margin:0 0 20px;">${button(loginUrl, "Accept invite")}</p>` +
      p(
        "This link expires in 15 minutes and can only be used once. If it's expired by the time " +
          "you click it, ask them to send you a fresh invite.",
        13,
        LIGHT.muted
      ) +
      p(
        "If you weren't expecting this, you can safely ignore this email &mdash; nobody can sign in " +
          "to this account without clicking the link above.",
        13,
        LIGHT.muted
      ),
    `<p class="dr-muted" style="font-size:11px;color:${LIGHT.muted};line-height:1.5;margin:0;">` +
      `${esc(SENDER_LINE)}<br>${esc(addr)}</p>`
  );

  return { subject, textBody, htmlBody, headers: {} };
}

/**
 * Task #29 (2026-08-05), self-serve admin-email change. Sent to the NEW
 * address only -- this email's existence in that inbox IS the proof of
 * control the change relies on, so it deliberately does not go anywhere
 * else. Modeled on buildFirmLoginEmail() (same 15-minute single-use link
 * mechanics) but the copy is unambiguous about what clicking it DOES:
 * changes the sign-in address on an existing account, not "sign in."
 */
export function buildFirmEmailChangeConfirmEmail(confirmUrl: string, adminName: string | null = null): BuiltEmail {
  const addr = mailingAddress();
  const subject = `Confirm your new ${SITE_NAME} email address`;

  const textBody =
    `${textGreeting(adminName)}\n\n` +
    `Someone requested to change the sign-in email on a ${SITE_NAME} firm account to this address. ` +
    `Click below to confirm and finish the change:\n\n` +
    `${confirmUrl}\n\n` +
    `This link expires in 15 minutes and can only be used once. Clicking it will also sign you in.\n\n` +
    `If you didn't request this -- or don't recognize the account -- you can safely ignore this ` +
    `email. Nothing changes unless you click the link above.\n\n` +
    `---\n${SENDER_LINE}\n${addr}`;

  const htmlBody = htmlShell(
    subject,
    `<h1 class="dr-fg" style="margin:0 0 16px;font-size:19px;font-weight:700;color:${LIGHT.fg};">` +
      `Confirm your new email address</h1>` +
      p(htmlGreeting(adminName)) +
      p(
        `Someone requested to change the sign-in email on a ${esc(SITE_NAME)} firm account to this ` +
          `address. Click below to confirm and finish the change.`
      ) +
      `<p style="margin:0 0 20px;">${button(confirmUrl, "Confirm this email address")}</p>` +
      p(
        "This link expires in 15 minutes and can only be used once. Clicking it will also sign you in.",
        13,
        LIGHT.muted
      ) +
      p(
        "If you didn't request this -- or don't recognize the account -- you can safely ignore this " +
          "email. Nothing changes unless you click the link above.",
        13,
        LIGHT.muted
      ),
    `<p class="dr-muted" style="font-size:11px;color:${LIGHT.muted};line-height:1.5;margin:0;">` +
      `${esc(SENDER_LINE)}<br>${esc(addr)}</p>`
  );

  return { subject, textBody, htmlBody, headers: {} };
}

/**
 * Task #29 companion to buildFirmEmailChangeConfirmEmail() -- sent to the
 * OLD (current) address at REQUEST time, not at confirmation time. Same
 * detection-control reasoning as buildFirmSessionsEndedEmail() (Task #18)
 * and buildFirmPasswordChangedEmail(): if the request came from a stolen
 * session rather than the real admin, this is the only signal the real
 * admin gets, and it has to arrive BEFORE the new address could be
 * confirmed, not after -- there is no "undo" once someone else's inbox has
 * proven control and signed in as this firm. Never claims the change is
 * final (it is not, until the new address confirms) and gives no way to
 * cancel from the email itself -- the account's own Account tab, reached
 * by a real sign-in, is the only place with the authority to act.
 */
export function buildFirmEmailChangeRequestedNoticeEmail(
  firmName: string,
  requestedNewEmail: string,
  whenIso: string,
  adminName: string | null = null
): BuiltEmail {
  const addr = mailingAddress();
  const subject = `An email change was requested on your ${SITE_NAME} account`;

  const textBody =
    `${textGreeting(adminName)}\n\n` +
    `A request was just made to change the sign-in email for ${firmName} on ${SITE_NAME} to ` +
    `${requestedNewEmail} (${whenIso}). Nothing has changed yet -- the new address still has to be ` +
    `confirmed before this takes effect.\n\n` +
    `If this was you, no action is needed.\n\n` +
    `IF THIS WAS NOT YOU, sign in with your current email and change your password from the ` +
    `Account tab as soon as possible.\n\n` +
    `---\n${SENDER_LINE}\n${addr}`;

  const htmlBody = htmlShell(
    subject,
    `<h1 class="dr-fg" style="margin:0 0 16px;font-size:19px;font-weight:700;color:${LIGHT.fg};">` +
      `An email change was requested</h1>` +
      p(htmlGreeting(adminName)) +
      p(
        `A request was just made to change the sign-in email for ${esc(firmName)} on ${esc(SITE_NAME)} ` +
          `to <strong>${esc(requestedNewEmail)}</strong> (${esc(whenIso)}). Nothing has changed yet -- ` +
          `the new address still has to be confirmed before this takes effect.`
      ) +
      p("If this was you, no action is needed.", 13, LIGHT.muted) +
      p(
        "<strong>If this was not you</strong>, sign in with your current email and change your " +
          "password from the Account tab as soon as possible.",
        13,
        LIGHT.muted
      ),
    `<p class="dr-muted" style="font-size:11px;color:${LIGHT.muted};line-height:1.5;margin:0;">` +
      `${esc(SENDER_LINE)}<br>${esc(addr)}</p>`
  );

  return { subject, textBody, htmlBody, headers: {} };
}

/**
 * The FREE-TIER individual's sign-in link (2026-07-31, migration 0012).
 *
 * Separate from buildFirmLoginEmail() rather than parameterised, because the
 * two say different things: a firm admin signs in to a work tool they
 * already pay for, whereas this person may not remember signing up for
 * anything at all -- they entered an email on a state page months ago and
 * have since only ever seen reminder emails. So this one re-establishes
 * WHAT the account is ("the reminders you're already getting") before asking
 * them to click.
 *
 * Like the firm version, it carries its own minimal footer instead of
 * `htmlFooter()`/`textFooter()`: those assert the reminder-consent copy
 * ("unsubscribe any time" wired to a specific subscriber row's token), and
 * this email is not a reminder for any one row -- it's account access
 * spanning all of them. Unsubscribing from an individual deadline still
 * happens where it always has, in that deadline's own reminder emails.
 */
export function buildSubscriberLoginEmail(loginUrl: string): BuiltEmail {
  const addr = mailingAddress();
  const subject = `Your ${SITE_NAME} sign-in link`;

  const textBody =
    `Here's your ${SITE_NAME} sign-in link:\n\n` +
    `${loginUrl}\n\n` +
    `Signing in shows you every renewal deadline we're tracking for this email address, all in ` +
    `one place. It's the same free reminders you're already getting -- just somewhere you can ` +
    `see them.\n\n` +
    `This link expires in 15 minutes and can only be used once. If it's expired by the time you ` +
    `click it, just request a new one.\n\n` +
    `If you didn't request this, you can safely ignore this email -- nobody can sign in without ` +
    `clicking the link above.\n\n` +
    `---\n${SENDER_LINE}\n${addr}`;

  const htmlBody = htmlShell(
    `Your ${SITE_NAME} sign-in link`,
    `<h1 class="dr-fg" style="margin:0 0 16px;font-size:19px;font-weight:700;color:${LIGHT.fg};">` +
      `Sign in to ${esc(SITE_NAME)}</h1>` +
      p(
        "Signing in shows you every renewal deadline we're tracking for this email address, all " +
          "in one place. It's the same free reminders you're already getting &mdash; just " +
          "somewhere you can see them."
      ) +
      `<p style="margin:0 0 20px;">${button(loginUrl, "Sign in")}</p>` +
      p(
        "This link expires in 15 minutes and can only be used once. If it's expired by the time " +
          "you click it, just request a new one.",
        13,
        LIGHT.muted
      ) +
      p(
        "If you didn't request this, you can safely ignore this email &mdash; nobody can sign in " +
          "without clicking the link above.",
        13,
        LIGHT.muted
      ),
    `<p class="dr-muted" style="font-size:11px;color:${LIGHT.muted};line-height:1.5;margin:0;">` +
      `${esc(SENDER_LINE)}<br>${esc(addr)}</p>`
  );

  return { subject, textBody, htmlBody, headers: {} };
}

/**
 * Roadmap #12 (2026-08-07): subscriber-side self-service email change,
 * mirroring buildFirmEmailChangeConfirmEmail() -- same 15-minute/one-time
 * terms, same "clicking it also signs you in" note.
 */
export function buildSubscriberEmailChangeConfirmEmail(confirmUrl: string): BuiltEmail {
  const addr = mailingAddress();
  const subject = `Confirm your new ${SITE_NAME} email address`;

  const textBody =
    `Someone requested to change the email address on a ${SITE_NAME} account to this address. ` +
    `Click below to confirm and finish the change:\n\n` +
    `${confirmUrl}\n\n` +
    `This link expires in 15 minutes and can only be used once. Clicking it will also sign you in.\n\n` +
    `If you didn't request this -- or don't recognize the account -- you can safely ignore this ` +
    `email. Nothing changes unless you click the link above.\n\n` +
    `---\n${SENDER_LINE}\n${addr}`;

  const htmlBody = htmlShell(
    subject,
    `<h1 class="dr-fg" style="margin:0 0 16px;font-size:19px;font-weight:700;color:${LIGHT.fg};">` +
      `Confirm your new email address</h1>` +
      p(
        `Someone requested to change the email address on a ${esc(SITE_NAME)} account to this ` +
          `address. Click below to confirm and finish the change.`
      ) +
      `<p style="margin:0 0 20px;">${button(confirmUrl, "Confirm this email address")}</p>` +
      p(
        "This link expires in 15 minutes and can only be used once. Clicking it will also sign you in.",
        13,
        LIGHT.muted
      ) +
      p(
        "If you didn't request this -- or don't recognize the account -- you can safely ignore this " +
          "email. Nothing changes unless you click the link above.",
        13,
        LIGHT.muted
      ),
    `<p class="dr-muted" style="font-size:11px;color:${LIGHT.muted};line-height:1.5;margin:0;">` +
      `${esc(SENDER_LINE)}<br>${esc(addr)}</p>`
  );

  return { subject, textBody, htmlBody, headers: {} };
}

/**
 * Roadmap #12 companion to buildSubscriberEmailChangeConfirmEmail() --
 * sent to the OLD (current) address at REQUEST time, mirroring
 * buildFirmEmailChangeRequestedNoticeEmail()'s own detection-control
 * reasoning: if the request came from a stolen session, this is the only
 * signal the real person gets, and has to arrive before the new address
 * could confirm.
 */
export function buildSubscriberEmailChangeRequestedNoticeEmail(requestedNewEmail: string, whenIso: string): BuiltEmail {
  const addr = mailingAddress();
  const subject = `An email change was requested on your ${SITE_NAME} account`;

  const textBody =
    `A request was just made to change the email address on your ${SITE_NAME} account to ` +
    `${requestedNewEmail} (${whenIso}). Nothing has changed yet -- the new address still has to be ` +
    `confirmed before this takes effect.\n\n` +
    `If this was you, no action is needed.\n\n` +
    `IF THIS WAS NOT YOU, you can safely ignore this email -- nothing changes unless the new ` +
    `address is confirmed.\n\n` +
    `---\n${SENDER_LINE}\n${addr}`;

  const htmlBody = htmlShell(
    subject,
    `<h1 class="dr-fg" style="margin:0 0 16px;font-size:19px;font-weight:700;color:${LIGHT.fg};">` +
      `An email change was requested</h1>` +
      p(
        `A request was just made to change the email address on your ${esc(SITE_NAME)} account to ` +
          `<strong>${esc(requestedNewEmail)}</strong> (${esc(whenIso)}). Nothing has changed yet -- ` +
          `the new address still has to be confirmed before this takes effect.`
      ) +
      p("If this was you, no action is needed.", 13, LIGHT.muted) +
      p(
        "<strong>If this was not you</strong>, you can safely ignore this email -- nothing changes " +
          "unless the new address is confirmed.",
        13,
        LIGHT.muted
      ),
    `<p class="dr-muted" style="font-size:11px;color:${LIGHT.muted};line-height:1.5;margin:0;">` +
      `${esc(SENDER_LINE)}<br>${esc(addr)}</p>`
  );

  return { subject, textBody, htmlBody, headers: {} };
}

/**
 * Admin-triggered nudge (2026-08-05, staff self-service CPE entry): a firm
 * admin asks us to remind one specific staff member to log their CPE hours.
 * Reuses the EXACT same magic-link mechanism as buildSubscriberLoginEmail()
 * above (same token, same 15-minute/one-time terms) -- this is not a new
 * credential type, just different copy explaining WHY the link showed up,
 * naming the firm that asked (same transparency convention
 * buildFirmStaffAddedEmail() already established: the recipient should
 * never wonder who's contacting them or why).
 */
export function buildStaffCpeReminderEmail(loginUrl: string, firmName: string, stateName: string): BuiltEmail {
  const addr = mailingAddress();
  const safeFirmName = firmName.replace(/[\r\n]+/g, " ");
  const subject = `${safeFirmName} would like you to log your CPE hours`;

  const textBody =
    `${safeFirmName} asked us to remind you to log your continuing education hours for your ` +
    `${stateName} CPA license.\n\n` +
    `Click below to sign in and enter them -- it takes a minute:\n\n` +
    `${loginUrl}\n\n` +
    `This link expires in 15 minutes and can only be used once. If it's expired by the time you ` +
    `click it, ask ${safeFirmName} to send another.\n\n` +
    `Signing in also shows you every renewal deadline we're tracking for this email address, not ` +
    `just this one.\n\n` +
    `If this doesn't apply to you, you can safely ignore this email.\n\n` +
    `---\n${SENDER_LINE}\n${addr}`;

  const htmlBody = htmlShell(
    subject,
    `<h1 class="dr-fg" style="margin:0 0 16px;font-size:19px;font-weight:700;color:${LIGHT.fg};">` +
      `Log your CPE hours</h1>` +
      p(
        `${esc(safeFirmName)} asked us to remind you to log your continuing education hours for ` +
          `your ${esc(stateName)} CPA license.`
      ) +
      `<p style="margin:0 0 20px;">${button(loginUrl, "Sign in and log hours")}</p>` +
      p(
        `This link expires in 15 minutes and can only be used once. If it's expired by the time ` +
          `you click it, ask ${esc(safeFirmName)} to send another.`,
        13,
        LIGHT.muted
      ) +
      p("If this doesn't apply to you, you can safely ignore this email.", 13, LIGHT.muted),
    `<p class="dr-muted" style="font-size:11px;color:${LIGHT.muted};line-height:1.5;margin:0;">` +
      `${esc(SENDER_LINE)}<br>${esc(addr)}</p>`
  );

  return { subject, textBody, htmlBody, headers: {} };
}

/**
 * Admin-triggered rule-change notice (2026-08-06, live request off the
 * Calendar's rule-change badges: "notify staff in that state"). Sent to
 * every roster staffer licensed in the affected state -- content (summary,
 * effective date, citation, confidence) is passed in from the SAME
 * DR_RULE_CHANGE_EVENTS data the badge/modal already renders publicly on
 * the dashboard, not a second source of truth. Every field is escaped and
 * length-capped by the caller before reaching here (see
 * handleFirmRuleChangeNotify's own comment) -- treated as untrusted
 * display text, same as any other admin-supplied string that ends up in an
 * email body. No magic link: this is informational, not a credential, and
 * the citation URL (when we have one) is the authoritative source anyway.
 */
export function buildRuleChangeNotificationEmail(
  firmName: string,
  jurisdiction: string,
  stateName: string,
  summary: string,
  effectiveDateLabel: string,
  citationUrl: string | null
): BuiltEmail {
  const addr = mailingAddress();
  const safeFirmName = firmName.replace(/[\r\n]+/g, " ");
  const subject = `${jurisdiction} mobility rule change -- ${safeFirmName}`;

  const citationLine = citationUrl
    ? `Source: ${citationUrl}\n\n`
    : "";
  const textBody =
    `${safeFirmName} flagged an upcoming practice-privilege rule change in ${jurisdiction} that may ` +
    `affect you.\n\n` +
    `Effective ${effectiveDateLabel}:\n${summary}\n\n` +
    citationLine +
    `This is informational only, not a determination about your own situation -- check Practice ` +
    `Privilege Check or confirm directly with the ${stateName} board of accountancy.\n\n` +
    `If this doesn't apply to you, you can safely ignore this email.\n\n` +
    `---\n${SENDER_LINE}\n${addr}`;

  const htmlBody = htmlShell(
    subject,
    `<h1 class="dr-fg" style="margin:0 0 16px;font-size:19px;font-weight:700;color:${LIGHT.fg};">` +
      `${esc(jurisdiction)} mobility rule change</h1>` +
      p(
        `${esc(safeFirmName)} flagged an upcoming practice-privilege rule change in ` +
          `${esc(jurisdiction)} that may affect you.`
      ) +
      p(`<strong>Effective ${esc(effectiveDateLabel)}:</strong> ${esc(summary)}`) +
      (citationUrl
        ? `<p style="margin:0 0 20px;">${button(citationUrl, "See the source")}</p>`
        : "") +
      p(
        `This is informational only, not a determination about your own situation -- check Practice ` +
          `Privilege Check or confirm directly with the ${esc(stateName)} board of accountancy.`,
        13,
        LIGHT.muted
      ) +
      p("If this doesn't apply to you, you can safely ignore this email.", 13, LIGHT.muted),
    `<p class="dr-muted" style="font-size:11px;color:${LIGHT.muted};line-height:1.5;margin:0;">` +
      `${esc(SENDER_LINE)}<br>${esc(addr)}</p>`
  );

  return { subject, textBody, htmlBody, headers: {} };
}

/**
 * Roadmap #9/#319 (2026-08-08). The PROACTIVE counterpart to
 * buildRuleChangeNotificationEmail() above -- that one is staff-framed and
 * only ever sent when an admin clicks "Notify staff in this state" on a
 * SPECIFIC event they've already reviewed; this one is admin-framed and
 * sent by the cron the moment a new event is detected touching a state the
 * firm's roster is actually licensed in, before any human has looked at it.
 * Deliberately does NOT notify staff itself -- it tells the admin a change
 * exists and links to the same Calendar/modal where the existing button
 * lives, preserving their existing editorial control over what staff hear
 * about. Also names how to turn this specific alert off (an opt-out,
 * on-by-default setting -- see migration 0050's own docstring), since
 * unlike the button-triggered email, nobody asked for this one specifically.
 */
export function buildRuleChangeAdminAlertEmail(
  firmName: string,
  jurisdiction: string,
  stateName: string,
  summary: string,
  effectiveDateLabel: string,
  citationUrl: string | null,
  calendarUrl: string,
  accountSettingsUrl: string,
  // AuditLab UNSUB-2 (2026-08-10): a real one-click List-Unsubscribe target
  // (migration 0062's firms.admin_unsubscribe_token) -- turns OFF
  // rule_change_alerts_enabled specifically, the same toggle
  // accountSettingsUrl above already points an admin at manually.
  unsubscribeUrl: string,
  // AuditLab ALERT-1 secondary finding (2026-08-09): the dashboard modal
  // renders "· confidence: <value>" next to every event; this email
  // asserted the same claim with the label stripped off. Carried through
  // verbatim (raw confidence string, e.g. "dual_source"/"single_source"),
  // same "unverified" fallback the dashboard's own JS uses.
  confidenceLabel: string = "unverified"
): BuiltEmail {
  const addr = mailingAddress();
  const safeFirmName = firmName.replace(/[\r\n]+/g, " ");
  const subject = `New ${jurisdiction} mobility rule change affects your roster`;

  const citationLine = citationUrl ? `Source: ${citationUrl}\n\n` : "";
  const textBody =
    `${safeFirmName},\n\n` +
    `A new practice-privilege rule change was just added for ${jurisdiction} -- your roster has ` +
    `staff licensed there, so it may be worth a look.\n\n` +
    `Effective ${effectiveDateLabel} (confidence: ${confidenceLabel}):\n${summary}\n\n` +
    citationLine +
    `This is informational only, not a determination about any specific staff member's situation. ` +
    `We have not notified your staff about this -- open the Calendar to review it and use "Notify ` +
    `staff in this state" yourself if it's relevant:\n${calendarUrl}\n\n` +
    `You're getting this because proactive rule-change alerts are on for your account (on by ` +
    `default). Turn them off any time from your Account settings:\n${accountSettingsUrl}\n\n` +
    `Or unsubscribe from just this alert type, one click, no sign-in:\n${unsubscribeUrl}\n\n` +
    `---\n${SENDER_LINE}\n${addr}`;

  const htmlBody = htmlShell(
    subject,
    `<h1 class="dr-fg" style="margin:0 0 16px;font-size:19px;font-weight:700;color:${LIGHT.fg};">` +
      `New ${esc(jurisdiction)} rule change affects your roster</h1>` +
      p(
        `${esc(safeFirmName)}, a new practice-privilege rule change was just added for ` +
          `${esc(jurisdiction)} -- your roster has staff licensed there, so it may be worth a look.`
      ) +
      p(
        `<strong>Effective ${esc(effectiveDateLabel)}</strong> ` +
          `<span style="color:${LIGHT.muted};">(confidence: ${esc(confidenceLabel)})</span>: ${esc(summary)}`
      ) +
      (citationUrl ? `<p style="margin:0 0 20px;">${button(citationUrl, "See the source")}</p>` : "") +
      p(
        `This is informational only, not a determination about any specific staff member's ` +
          `situation. We have not notified your staff about this -- review it and use ` +
          `&ldquo;Notify staff in this state&rdquo; yourself if it's relevant.`,
        13,
        LIGHT.muted
      ) +
      `<p style="margin:0 0 20px;">${button(calendarUrl, "Review on the Calendar")}</p>` +
      p(
        `You're getting this because proactive rule-change alerts are on for your account (on by ` +
          `default). <a href="${esc(accountSettingsUrl)}" style="color:${LIGHT.accent};">Turn them ` +
          `off</a> any time from your Account settings, or ` +
          `<a href="${esc(unsubscribeUrl)}" style="color:${LIGHT.accent};">unsubscribe from just this ` +
          `alert type</a>, one click, no sign-in.`,
        13,
        LIGHT.muted
      ),
    `<p class="dr-muted" style="font-size:11px;color:${LIGHT.muted};line-height:1.5;margin:0;">` +
      `${esc(SENDER_LINE)}<br>${esc(addr)}</p>`
  );

  return { subject, textBody, htmlBody, headers: listUnsubHeaders(unsubscribeUrl) };
}

export interface AdminDigestItem {
  staffLabel: string;
  stateName: string;
  daysRemaining: number;
}

/**
 * Roadmap #151 Phase 5 (2026-08-10, "move the value line"): the firm-wide
 * counterpart to buildDigestEmail() above -- bundles newly-due items across
 * the WHOLE roster (not one subscriber's own items) into one email to
 * firm.admin_email, closing the gap /for-firms/'s own copy names directly:
 * "the partner who actually carries the regulatory risk never sees any of
 * this -- only the individual licensee's own inbox gets the reminder."
 * Unlike buildSlackDigestText() (scheduler.ts, a lighter heads-up with no
 * staff name -- state name only), this DOES include staffLabel, since the
 * whole point of an admin-facing digest is "who," not just "which state."
 *
 * Admin-framed voice and the on-by-default opt-out mention are carried over
 * from buildRuleChangeAdminAlertEmail() above (nobody asked for this
 * specific email, same as that one) -- the per-item bundle structure
 * (subject count, per-item loop, "nothing to do for anything not listed")
 * is carried over from buildDigestEmail() above. Never sent empty, same
 * "no filler" rule as buildDigestEmail().
 */
export function buildAdminDigestEmail(
  firmName: string,
  items: AdminDigestItem[],
  accountSettingsUrl: string,
  // AuditLab UNSUB-2 (2026-08-10): same firms.admin_unsubscribe_token
  // (migration 0062) target as buildRuleChangeAdminAlertEmail() above --
  // turns OFF admin_digest_enabled specifically.
  unsubscribeUrl: string
): BuiltEmail {
  if (items.length === 0) {
    throw new Error("buildAdminDigestEmail: items must be non-empty -- a digest is never sent with nothing to report");
  }
  const addr = mailingAddress();
  const safeFirmName = firmName.replace(/[\r\n]+/g, " ");
  const count = items.length;
  const subject =
    count === 1
      ? `${safeFirmName}: 1 renewal newly due across your roster`
      : `${safeFirmName}: ${count} renewals newly due across your roster`;

  const textItems = items
    .map((it) => `- ${it.staffLabel} (${it.stateName}): due ${daysPhrase(it.daysRemaining)}`)
    .join("\n");

  const textBody =
    `${safeFirmName},\n\n` +
    `${count === 1 ? "One renewal" : `${count} renewals`} across your roster ${count === 1 ? "is" : "are"} newly due:\n\n` +
    `${textItems}\n\n` +
    `Nothing to do for anyone not listed above -- we'll include them here once their own renewal is actually due.\n\n` +
    `You're getting this because firm-wide digest alerts are on for your account (on by default for an ` +
    `eligible plan). Turn them off any time from your Account settings:\n${accountSettingsUrl}\n\n` +
    `Or unsubscribe from just this digest, one click, no sign-in:\n${unsubscribeUrl}\n\n` +
    `---\n${SENDER_LINE}\n${addr}`;

  const htmlItems = items
    .map(
      (it) =>
        `<div style="margin:0 0 12px;padding:0 0 12px;border-bottom:1px solid ${LIGHT.border};">` +
        `<p class="dr-fg" style="margin:0 0 4px;font-size:15px;font-weight:700;color:${LIGHT.fg};">${esc(it.staffLabel)}</p>` +
        `<p class="dr-fg" style="margin:0;font-size:14px;color:${LIGHT.fg};">${esc(it.stateName)} &mdash; due ${esc(daysPhrase(it.daysRemaining))}</p>` +
        `</div>`
    )
    .join("");

  const htmlBody = htmlShell(
    subject,
    `<h1 class="dr-fg" style="margin:0 0 16px;font-size:19px;font-weight:700;color:${LIGHT.fg};">` +
      `${esc(count === 1 ? "1 renewal" : `${count} renewals`)} newly due across your roster</h1>` +
      p(`${esc(safeFirmName)}, here's who's newly due:`) +
      htmlItems +
      p("Nothing to do for anyone not listed above -- we'll include them here once their own renewal is actually due.", 13, LIGHT.muted) +
      p(
        `You're getting this because firm-wide digest alerts are on for your account (on by default for an ` +
          `eligible plan). <a href="${esc(accountSettingsUrl)}" style="color:${LIGHT.accent};">Turn them off</a> ` +
          `any time from your Account settings, or ` +
          `<a href="${esc(unsubscribeUrl)}" style="color:${LIGHT.accent};">unsubscribe from just this digest</a>, ` +
          `one click, no sign-in.`,
        13,
        LIGHT.muted
      ),
    `<p class="dr-muted" style="font-size:11px;color:${LIGHT.muted};line-height:1.5;margin:0;">` +
      `${esc(SENDER_LINE)}<br>${esc(addr)}</p>`
  );

  return { subject, textBody, htmlBody, headers: listUnsubHeaders(unsubscribeUrl) };
}

/**
 * Sent whenever a firm's password is set or changed (2026-07-30, from the
 * security review).
 *
 * This is a DETECTION control, and it closes a real hole. Because every
 * firm predating migration 0010 has no password, the "prove the current
 * password" check does not run for them -- so anyone holding a single
 * session cookie could set a permanent password, and the same request
 * terminates all of the owner's other sessions. Without this email the
 * owner's only symptom is one logout that looks exactly like normal
 * session expiry, while the attacker keeps a standing credential
 * indefinitely.
 *
 * Deliberately does NOT include a one-click "undo" link: that would be a
 * new unauthenticated state-changing capability sent over email, which is
 * its own attack surface. Recovery is the existing emailed sign-in link,
 * which the attacker cannot intercept without the mailbox.
 */
export function buildFirmPasswordChangedEmail(firmName: string, whenIso: string, adminName: string | null = null): BuiltEmail {
  const addr = mailingAddress();
  const subject = `A password was set on your ${SITE_NAME} account`;

  const textBody =
    `${textGreeting(adminName)}\n\n` +
    `The password for ${firmName} on ${SITE_NAME} was just set or changed (${whenIso}).

` +
    `Any other devices signed in to this account were signed out.

` +
    `If this was you, nothing further is needed.

` +
    `IF THIS WAS NOT YOU, someone else may have had access to your account. Request a sign-in ` +
    `link from the sign-in page to get back in, then change the password immediately. The sign-in ` +
    `link goes only to this address, so whoever set the password cannot intercept it.

` +
    `---
${SENDER_LINE}
${addr}`;

  const htmlBody = htmlShell(
    `A password was set on your ${SITE_NAME} account`,
    `<h1 class="dr-fg" style="margin:0 0 16px;font-size:19px;font-weight:700;color:${LIGHT.fg};">` +
      `A password was set on your account</h1>` +
      p(htmlGreeting(adminName)) +
      p(
        `The password for ${esc(firmName)} on ${esc(SITE_NAME)} was just set or changed ` +
          `(${esc(whenIso)}). Any other devices signed in to this account were signed out.`
      ) +
      p("If this was you, nothing further is needed.", 13, LIGHT.muted) +
      p(
        "<strong>If this was not you</strong>, someone else may have had access to your account. " +
          "Request a sign-in link from the sign-in page to get back in, then change the password " +
          "immediately. That link goes only to this address, so whoever set the password cannot " +
          "intercept it.",
        13,
        LIGHT.muted
      ),
    `<p class="dr-muted" style="font-size:11px;color:${LIGHT.muted};line-height:1.5;margin:0;">` +
      `${esc(SENDER_LINE)}<br>${esc(addr)}</p>`
  );

  return { subject, textBody, htmlBody, headers: {} };
}

/**
 * Roadmap #53 (2026-08-07). Sent to the MEMBER whose account just enrolled
 * or disabled two-factor authentication -- same detection-control reasoning
 * as buildFirmPasswordChangedEmail() above and buildFirmOauthLinkedEmail()
 * below: enrolling/disabling 2FA is a durable change to this account's
 * security posture, and unlike a password change there is no forced
 * sign-out of other sessions to notice it by, so this email is the only
 * signal a legitimate owner gets if someone else made the change.
 */
export function buildFirmTwoFactorChangedEmail(
  firmName: string,
  enabled: boolean,
  whenIso: string,
  adminName: string | null = null
): BuiltEmail {
  const addr = mailingAddress();
  const action = enabled ? "enabled" : "disabled";
  const subject = `Two-factor authentication was ${action} on your ${SITE_NAME} account`;

  const textBody =
    `${textGreeting(adminName)}\n\n` +
    `Two-factor authentication was just ${action} for ${firmName} on ${SITE_NAME} (${whenIso}).

` +
    `If this was you, nothing further is needed.

` +
    `IF THIS WAS NOT YOU, request a sign-in link from the sign-in page to get back in, then review ` +
    `your account's security settings immediately. The sign-in link goes only to this address, so ` +
    `whoever made this change cannot intercept it.

` +
    `---
${SENDER_LINE}
${addr}`;

  const htmlBody = htmlShell(
    `Two-factor authentication was ${action} on your ${SITE_NAME} account`,
    `<h1 class="dr-fg" style="margin:0 0 16px;font-size:19px;font-weight:700;color:${LIGHT.fg};">` +
      `Two-factor authentication was ${action}</h1>` +
      p(htmlGreeting(adminName)) +
      p(`Two-factor authentication was just ${action} for ${esc(firmName)} on ${esc(SITE_NAME)} (${esc(whenIso)}).`) +
      p("If this was you, nothing further is needed.", 13, LIGHT.muted) +
      p(
        "<strong>If this was not you</strong>, request a sign-in link from the sign-in page to get back " +
          "in, then review your account's security settings immediately. That link goes only to this " +
          "address, so whoever made this change cannot intercept it.",
        13,
        LIGHT.muted
      ),
    `<p class="dr-muted" style="font-size:11px;color:${LIGHT.muted};line-height:1.5;margin:0;">` +
      `${esc(SENDER_LINE)}<br>${esc(addr)}</p>`
  );

  return { subject, textBody, htmlBody, headers: {} };
}

/**
 * Sent to the FIRM'S OWN admin_email whenever a roster staffer unsubscribes
 * (2026-08-06, Task #10). Not the same recipient as
 * buildSignupNotificationEmail() (that one goes to INTERNAL_NOTIFY_EMAIL,
 * the business owner) -- this is a real customer being told about their own
 * roster, so it follows buildFirmPasswordChangedEmail()'s plain-transactional
 * pattern (SENDER_LINE + address, no unsubscribe apparatus) rather than
 * buildFirmStaffAddedEmail()'s marketing-adjacent one: there's no sensible
 * "opt out of operational notices about your own account" concept here.
 * Firm-side visibility already existed passively via the Recent Activity
 * panel (Task #26) -- this is the same event, just pushed instead of
 * requiring the admin to happen to check the dashboard.
 */
export function buildStaffUnsubscribedNotificationEmail(
  firmName: string,
  staffLabel: string | null,
  staffEmail: string,
  stateName: string,
  adminName: string | null = null
): BuiltEmail {
  const addr = mailingAddress();
  const displayName = (staffLabel || staffEmail).replace(/[\r\n]+/g, " ");
  const subject = `${displayName} unsubscribed from ${firmName}'s DeadlineRadar roster`;

  const textBody =
    `${textGreeting(adminName)}\n\n` +
    `${displayName} (${staffEmail}) just unsubscribed from renewal reminders for their ${stateName} ` +
    `CPA license, tracked under ${firmName} on ${SITE_NAME}.\n\n` +
    `Reminders have already stopped -- this is informational only, nothing further is needed unless ` +
    `you want to re-add them yourself from your dashboard's Roster tab.\n\n` +
    `---\n${SENDER_LINE}\n${addr}`;

  const htmlBody = htmlShell(
    subject,
    `<h1 class="dr-fg" style="margin:0 0 16px;font-size:19px;font-weight:700;color:${LIGHT.fg};">` +
      `A staff member unsubscribed</h1>` +
      p(htmlGreeting(adminName)) +
      p(
        `<strong>${esc(displayName)}</strong> (${esc(staffEmail)}) just unsubscribed from renewal ` +
          `reminders for their ${esc(stateName)} CPA license, tracked under ${esc(firmName)} on ` +
          `${esc(SITE_NAME)}.`
      ) +
      p(
        "Reminders have already stopped -- this is informational only, nothing further is needed " +
          "unless you want to re-add them yourself from your dashboard's Roster tab.",
        13,
        LIGHT.muted
      ),
    `<p class="dr-muted" style="font-size:11px;color:${LIGHT.muted};line-height:1.5;margin:0;">` +
      `${esc(SENDER_LINE)}<br>${esc(addr)}</p>`
  );

  return { subject, textBody, htmlBody, headers: {} };
}

/**
 * Sent whenever POST /firm/sign-out-other-devices ends at least one OTHER
 * session (2026-08-05, Task #18). Same rationale as
 * buildFirmPasswordChangedEmail() -- ending every other session is a
 * DETECTION control as much as a remediation one: if the click that
 * triggered it came from a stolen session rather than the real admin, this
 * email is the only signal the real admin ever gets that something used
 * their account. Unlike a password change, the credential itself is
 * unchanged here, so the remediation copy points at changing the password,
 * not just signing back in.
 */
export function buildFirmSessionsEndedEmail(
  firmName: string,
  whenIso: string,
  endedCount: number,
  adminName: string | null = null
): BuiltEmail {
  const addr = mailingAddress();
  const subject = `Other devices were signed out of your ${SITE_NAME} account`;
  const deviceWord = endedCount === 1 ? "device" : "devices";

  const textBody =
    `${textGreeting(adminName)}\n\n` +
    `${endedCount} other ${deviceWord} signed in to ${firmName} on ${SITE_NAME} were just signed out (${whenIso}).

` +
    `If this was you, nothing further is needed.

` +
    `IF THIS WAS NOT YOU, someone else may have had access to your account. Request a sign-in ` +
    `link from the sign-in page to get back in, then change your password immediately.

` +
    `---
${SENDER_LINE}
${addr}`;

  const htmlBody = htmlShell(
    `Other devices were signed out of your ${SITE_NAME} account`,
    `<h1 class="dr-fg" style="margin:0 0 16px;font-size:19px;font-weight:700;color:${LIGHT.fg};">` +
      `Other devices were signed out</h1>` +
      p(htmlGreeting(adminName)) +
      p(
        `${endedCount} other ${esc(deviceWord)} signed in to ${esc(firmName)} on ${esc(SITE_NAME)} were ` +
          `just signed out (${esc(whenIso)}).`
      ) +
      p("If this was you, nothing further is needed.", 13, LIGHT.muted) +
      p(
        "<strong>If this was not you</strong>, someone else may have had access to your account. " +
          "Request a sign-in link from the sign-in page to get back in, then change your password " +
          "immediately.",
        13,
        LIGHT.muted
      ),
    `<p class="dr-muted" style="font-size:11px;color:${LIGHT.muted};line-height:1.5;margin:0;">` +
      `${esc(SENDER_LINE)}<br>${esc(addr)}</p>`
  );

  return { subject, textBody, htmlBody, headers: {} };
}

/**
 * Sent whenever a new provider identity is linked to a firm via SSO
 * (2026-08-03, AuditLab SSO-B).
 *
 * Same rationale as buildFirmPasswordChangedEmail(): linking is a durable
 * credential grant (AuditLab SSO-A) with no other detection control. Unlike
 * a password change, linking does not end any session on its own -- the
 * remediation here is to remove the identity from the Account tab, so the
 * copy points there instead of to a sign-in link.
 */
export function buildFirmOauthLinkedEmail(
  firmName: string,
  providerDisplayName: string,
  providerEmail: string,
  whenIso: string,
  adminName: string | null = null
): BuiltEmail {
  const addr = mailingAddress();
  const subject = `A ${providerDisplayName} sign-in method was connected to your ${SITE_NAME} account`;

  const textBody =
    `${textGreeting(adminName)}\n\n` +
    `A ${providerDisplayName} account (${providerEmail}) was just connected as a sign-in method for ` +
    `${firmName} on ${SITE_NAME} (${whenIso}).

` +
    `Once connected, signing in with that ${providerDisplayName} account signs straight into this ` +
    `firm -- no password needed.

` +
    `If this was you, nothing further is needed.

` +
    `IF THIS WAS NOT YOU, someone with access to that ${providerDisplayName} account can now sign in ` +
    `to your firm indefinitely. Sign in and remove it from the Account tab under Connected Sign-In ` +
    `Methods, then change your password if you haven't already.

` +
    `---
${SENDER_LINE}
${addr}`;

  const htmlBody = htmlShell(
    `A ${providerDisplayName} sign-in method was connected to your ${SITE_NAME} account`,
    `<h1 class="dr-fg" style="margin:0 0 16px;font-size:19px;font-weight:700;color:${LIGHT.fg};">` +
      `A ${esc(providerDisplayName)} sign-in method was connected</h1>` +
      p(htmlGreeting(adminName)) +
      p(
        `A ${esc(providerDisplayName)} account (${esc(providerEmail)}) was just connected as a sign-in ` +
          `method for ${esc(firmName)} on ${esc(SITE_NAME)} (${esc(whenIso)}). Once connected, signing ` +
          `in with that ${esc(providerDisplayName)} account signs straight into this firm -- no ` +
          `password needed.`
      ) +
      p("If this was you, nothing further is needed.", 13, LIGHT.muted) +
      p(
        `<strong>If this was not you</strong>, someone with access to that ${esc(providerDisplayName)} ` +
          "account can now sign in to your firm indefinitely. Sign in and remove it from the Account " +
          "tab under Connected Sign-In Methods, then change your password if you haven't already.",
        13,
        LIGHT.muted
      ),
    `<p class="dr-muted" style="font-size:11px;color:${LIGHT.muted};line-height:1.5;margin:0;">` +
      `${esc(SENDER_LINE)}<br>${esc(addr)}</p>`
  );

  return { subject, textBody, htmlBody, headers: {} };
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

/**
 * Firm-tier HYBRID consent model (2026-07-28, per Devin's decision): a firm
 * admin adding a staff member creates an ACTIVE subscriber immediately (no
 * pending-confirmation gate -- see store.ts's addPending() `skipConfirmation`
 * option) so the firm's whole-roster coverage promise never has a silent
 * "pending" gap. This is the email that makes that transparent instead of
 * silent: sent once, on add, naming the firm that added them, stating
 * plainly what will happen (renewal reminders only, nothing else), and
 * giving an equally prominent one-click opt-out -- the CAN-SPAM-clean
 * counterpart to double opt-in for this admin-vouched-for B2B case. Reuses
 * the SAME unsubscribe_token/htmlFooter/List-Unsubscribe machinery every
 * other email already uses -- no new token type, no new opt-out mechanism.
 */
export function buildFirmStaffAddedEmail(firmName: string, stateName: string, unsubscribeUrl: string): BuiltEmail {
  const addr = mailingAddress();
  // AuditLab EMAIL-1 (LOW, 2026-08-04): the only subject line built from
  // attacker-influenceable text (firmName) with no control-char stripping
  // of its own -- CRLF survives into it if it ever got there. Not
  // exploitable today (handleFirmSignup()'s input gate 400s on control
  // characters, firm_name is set only at signup, and sender.ts JSON-encodes
  // the subject rather than writing raw SMTP headers), but the template
  // layer relying ENTIRELY on an upstream gate is exactly the kind of
  // single point of failure that becomes live the moment either changes --
  // a firm-rename route, or a transport swap to raw SMTP. One line of
  // defense-in-depth at the point where the string is actually built.
  const subject = `${firmName.replace(/[\r\n]+/g, " ")} added you to DeadlineRadar`;

  const textBody =
    `Hi there,\n\n` +
    `${firmName} added you to DeadlineRadar to track your ${stateName} CPA license renewal. ` +
    `You'll get advance email reminders before it's due -- 60, 30, 14, 7, 3, and 1 day out. ` +
    `That's the whole schedule -- nothing else, ever: no marketing, no third-party offers.\n\n` +
    `Not you, or would you rather not be tracked this way? One click removes you, no questions ` +
    `asked:\n\n` +
    `${unsubscribeUrl}\n\n` +
    `Questions about why you're getting this? Reply to this email or reach your firm directly.` +
    `${textFooter(unsubscribeUrl, addr)}`;

  const htmlBody = htmlShell(
    `${firmName} added you to DeadlineRadar`,
    `<h1 class="dr-fg" style="margin:0 0 16px;font-size:19px;font-weight:700;color:${LIGHT.fg};">` +
      `${esc(firmName)} added you to DeadlineRadar</h1>` +
      p(
        `${esc(firmName)} added you to DeadlineRadar to track your ${esc(stateName)} CPA license ` +
          `renewal. You'll get advance email reminders before it's due &mdash; 60, 30, 14, 7, 3, and ` +
          `1 day out. That's the whole schedule &mdash; nothing else, ever: no marketing, no ` +
          `third-party offers.`
      ) +
      p(
        "Not you, or would you rather not be tracked this way? One click removes you, no questions " +
          "asked:",
        13,
        LIGHT.muted
      ) +
      `<p style="margin:0 0 20px;">${button(unsubscribeUrl, "Remove me")}</p>` +
      p("Questions about why you're getting this? Reply to this email or reach your firm directly.", 13, LIGHT.muted),
    htmlFooter(unsubscribeUrl, addr)
  );

  return { subject, textBody, htmlBody, headers: listUnsubHeaders(unsubscribeUrl) };
}

/**
 * Internal-only notification (2026-08-05, Devin: "I want an email
 * notification on every signup. So I can personally reach out and greet
 * them."). Sent to INTERNAL_NOTIFY_EMAIL (a fixed constant in index.ts, not
 * a recipient any caller/request can influence), never to the person who
 * signed up -- this is not a customer-facing email, so it deliberately
 * skips every CAN-SPAM/unsubscribe apparatus every other builder in this
 * file carries (mailingAddress(), listUnsubHeaders(), htmlShell()'s full
 * branded footer): none of that applies to a message the business owner
 * sends to themselves.
 */
export function buildSignupNotificationEmail(
  kind: "individual" | "firm",
  details: { email: string; stateName?: string; firmName?: string; adminName?: string | null }
): BuiltEmail {
  // AuditLab EMAIL-1 (2026-08-04) fixed the same gap in
  // buildFirmStaffAddedEmail(): a subject line built from attacker-
  // influenceable text with no control-char stripping of its own lets CRLF
  // survive into it if it ever reaches here. Not exploitable today (both
  // fields are already control-char-gated upstream -- handleSubscribe()'s
  // email format check, handleFirmSignup()'s hasControlChars() sweep -- and
  // sender.ts JSON-encodes the subject rather than writing raw SMTP
  // headers), but that is exactly the "relies entirely on an upstream gate"
  // single point of failure EMAIL-1 called out. Same one-line fix, applied
  // here too rather than leaving this builder as the one that didn't get it.
  const safeFirmName = (details.firmName ?? "(no name)").replace(/[\r\n]+/g, " ");
  const safeEmail = details.email.replace(/[\r\n]+/g, " ");
  const subject = kind === "firm" ? `New firm signed up: ${safeFirmName}` : `New individual signup: ${safeEmail}`;
  // Same CRLF-stripping as safeFirmName/safeEmail above -- an admin_name
  // that reaches here has already been control-char-swept by
  // handleFirmSignup()'s hasControlChars() loop, but this builder doesn't
  // rely on that alone for the SUBJECT line already, so it doesn't start
  // here either.
  const safeAdminName = details.adminName ? details.adminName.replace(/[\r\n]+/g, " ") : null;

  const textBody =
    kind === "firm"
      ? `Firm: ${details.firmName ?? "(no name)"}\n` +
        (safeAdminName ? `Admin name: ${safeAdminName}\n` : "") +
        `Admin email: ${details.email}\n\n` +
        `This fired on their first successful sign-in (not the initial signup form), so the admin ` +
        `email is confirmed real.`
      : `Email: ${details.email}\nState: ${details.stateName ?? "(unknown)"}\n\n` +
        `This fired on double-opt-in confirmation, so the address is confirmed real.`;

  const htmlBody =
    `<p>${kind === "firm" ? "Firm" : "Individual"} signup:</p>` +
    `<ul>` +
    (kind === "firm"
      ? `<li>Firm: ${esc(details.firmName ?? "(no name)")}</li>` +
        (safeAdminName ? `<li>Admin name: ${esc(safeAdminName)}</li>` : "") +
        `<li>Admin email: ${esc(details.email)}</li>`
      : `<li>Email: ${esc(details.email)}</li><li>State: ${esc(details.stateName ?? "(unknown)")}</li>`) +
    `</ul>`;

  return { subject, textBody, htmlBody, headers: {} };
}

/**
 * Task #3 (2026-08-06): internal notification on a firm self-deleting its
 * account -- same "so Devin can actually see the feedback" reasoning as
 * sendSignupNotification() above, reused for the opposite event. The
 * survey is optional/skippable, so both fields may be null; the email says
 * so plainly rather than rendering an empty bullet.
 */
export function buildAccountDeletionNotificationEmail(details: {
  firmName: string;
  adminEmail: string;
  reason: string | null;
  detail: string | null;
  /**
   * AuditLab BILL-5 (HIGH, 2026-08-08): `"failed"` is a DISTINCT state from
   * `null` -- before this fix, a refund attempt that threw (Stripe 5xx, an
   * already-refunded PaymentIntent, a network blip) left this `null`,
   * rendering byte-identical to the three legitimate no-refund-owed cases
   * (no subscription / `amountPaid <= 0` / `proratedCents <= 0`). The one
   * signal meant to flag "a human must reconcile this" was indistinguishable
   * from the common normal case, so nobody would ever look. Cents, `null`
   * when genuinely no refund was owed, or `"failed"` when a refund SHOULD
   * have been attempted but the attempt itself threw.
   */
  refundCents: number | null | "failed";
}): BuiltEmail {
  const safeFirmName = details.firmName.replace(/[\r\n]+/g, " ");
  const safeEmail = details.adminEmail.replace(/[\r\n]+/g, " ");
  const safeDetail = details.detail ? details.detail.replace(/[\r\n]+/g, " ") : null;
  const subject = `Firm deleted their account: ${safeFirmName}`;
  const refundLine =
    details.refundCents === "failed"
      ? "REFUND FAILED -- reconcile manually (Stripe error during deletion, subscription cancellation was attempted independently)"
      : details.refundCents !== null
        ? `$${(details.refundCents / 100).toFixed(2)} (prorated, unused time)`
        : "(none)";

  const textBody =
    `Firm: ${details.firmName}\n` +
    `Admin email: ${details.adminEmail}\n` +
    `Reason given: ${details.reason ?? "(skipped)"}\n` +
    `Detail: ${safeDetail ?? "(none)"}\n` +
    `Refund issued: ${refundLine}\n\n` +
    `Account is deactivated immediately; the data hard-deletes automatically in 30 days.`;

  const htmlBody =
    `<p>Firm deleted their account:</p>` +
    `<ul>` +
    `<li>Firm: ${esc(safeFirmName)}</li>` +
    `<li>Admin email: ${esc(safeEmail)}</li>` +
    `<li>Reason given: ${esc(details.reason ?? "(skipped)")}</li>` +
    `<li>Detail: ${esc(safeDetail ?? "(none)")}</li>` +
    `<li>Refund issued: ${esc(refundLine)}</li>` +
    `</ul>` +
    `<p>Account is deactivated immediately; the data hard-deletes automatically in 30 days.</p>`;

  return { subject, textBody, htmlBody, headers: {} };
}

/**
 * Task #19 (2026-08-06): confirms a "notify me when this ships" signup on
 * the public /roadmap/ page. Voting itself is anonymous (a cookie, no
 * email) -- this is the ONE place on that page an email is collected, and
 * it's optional and opt-in, so it gets a real confirm-click before
 * anything is stored as confirmed (store.createFeatureIdeaNotifySignup()'s
 * own docstring). Plain transactional shape (SENDER_LINE + address, no
 * List-Unsubscribe machinery) -- there's nothing recurring to unsubscribe
 * from, this confirms a single one-time future email tied to one idea.
 */
export function buildFeatureIdeaNotifyConfirmEmail(ideaTitle: string, confirmUrl: string): BuiltEmail {
  const addr = mailingAddress();
  const safeTitle = ideaTitle.replace(/[\r\n]+/g, " ");
  const subject = `Confirm: notify me when "${safeTitle}" ships`;

  const textBody =
    `You asked to be notified when "${safeTitle}" ships on ${SITE_NAME}'s roadmap.\n\n` +
    `Click below to confirm -- this is the only email you'll get unless it actually ships:\n\n` +
    `${confirmUrl}\n\n` +
    `If you didn't request this, you can safely ignore it -- nothing happens unless you click.\n\n` +
    `---\n${SENDER_LINE}\n${addr}`;

  const htmlBody = htmlShell(
    subject,
    `<h1 class="dr-fg" style="margin:0 0 16px;font-size:19px;font-weight:700;color:${LIGHT.fg};">` +
      `Confirm your roadmap notification</h1>` +
      p(`You asked to be notified when <strong>${esc(safeTitle)}</strong> ships on ${esc(SITE_NAME)}'s roadmap.`) +
      `<p style="margin:0 0 20px;">${button(confirmUrl, "Confirm notification")}</p>` +
      p(
        "This is the only email you'll get unless it actually ships. If you didn't request this, " +
          "you can safely ignore it -- nothing happens unless you click.",
        13,
        LIGHT.muted
      ),
    `<p class="dr-muted" style="font-size:11px;color:${LIGHT.muted};line-height:1.5;margin:0;">` +
      `${esc(SENDER_LINE)}<br>${esc(addr)}</p>`
  );

  return { subject, textBody, htmlBody, headers: {} };
}

// ---------------------------------------------------------------------------
// Drip course (2026-08-08, roadmap #34). Four emails, days 0/7/14/21 after
// enrollment, to confirmed free-tier subscribers who haven't converted to a
// paying firm account. NOT the reminder footer above -- that copy promises
// "no marketing, ever," which this series would directly contradict. Uses
// the same minimal-footer shape buildStaffCpeReminderEmail()/
// buildFeatureIdeaShippedEmail() already use, plus one honest sentence
// naming this as a one-time series distinct from the recipient's actual
// deadline reminders.
// ---------------------------------------------------------------------------

function dripCourseHtmlFooter(unsubscribeUrl: string, addr: string): string {
  return (
    `<p class="dr-muted" style="font-size:12px;color:${LIGHT.muted};line-height:1.6;margin:0 0 10px;">` +
    `You're getting this because you confirmed a free ${esc(SITE_NAME)} reminder signup. This is a ` +
    `one-time, four-email series -- not a recurring newsletter -- and your actual renewal-deadline ` +
    `reminders are unaffected either way.` +
    `</p>` +
    `<p style="font-size:13px;margin:0 0 10px;">${textLink(unsubscribeUrl, "Unsubscribe from this series")}</p>` +
    `<p class="dr-muted" style="font-size:11px;color:${LIGHT.muted};line-height:1.5;margin:0;">` +
    `${esc(SENDER_LINE)}<br>${esc(addr)}</p>`
  );
}

function dripCourseTextFooter(unsubscribeUrl: string, addr: string): string {
  return (
    `\n\n---\n` +
    `You're getting this because you confirmed a free ${SITE_NAME} reminder signup. This is a ` +
    `one-time, four-email series -- not a recurring newsletter -- and your actual renewal-deadline ` +
    `reminders are unaffected either way.\n\n` +
    `Unsubscribe from this series any time: ${unsubscribeUrl}\n\n` +
    `${SENDER_LINE}\n${addr}`
  );
}

/**
 * Step 1 (day 0, sent immediately on enrollment). `cycleFact` is a short,
 * ALREADY-VERIFIED excerpt of the subscriber's own state's real renewal
 * mechanic -- the caller (scheduler.ts) sources this from the same
 * `cpa_deadlines.json` field the public state pages render, never a fact
 * invented here. Steps 2/3 below deliberately do NOT attempt the same
 * per-state depth for CPE/reinstatement specifics -- those numbers change
 * per state and would need the same citation-verification bar as the
 * public site pages carry; scoped down to generic, state-NAMED (not
 * state-SPECIFIC-numbers) guidance instead, so nothing here can go stale
 * or wrong the way an unverified specific claim could.
 */
export function buildDripCourseStep1Email(firstName: string | null, stateName: string, cycleFact: string, unsubscribeUrl: string): BuiltEmail {
  const addr = mailingAddress();
  const subject = `The real answer to "when does my CPA license renew?"`;

  const textBody =
    `${textGreeting(firstName)}\n\n` +
    `You confirmed a ${SITE_NAME} reminder a little while back, so we know you're already tracking ` +
    `your own renewal date. Over the next few weeks we'll send a short series -- no fluff, just the ` +
    `things that actually trip CPAs up on renewals. This is a one-time series, not a recurring ` +
    `newsletter.\n\n` +
    `First up: most people assume their renewal date is set by when they got their license. In ` +
    `${stateName}, that's not quite the whole picture -- ${cycleFact}\n\n` +
    `Knowing which pattern your state uses is the difference between "I'll get to it" and actually ` +
    `knowing your real deadline.\n\n` +
    `Next email in about a week: the CPE mistake that catches even careful CPAs off guard.` +
    dripCourseTextFooter(unsubscribeUrl, addr);

  const htmlBody = htmlShell(
    subject,
    `<h1 class="dr-fg" style="margin:0 0 16px;font-size:19px;font-weight:700;color:${LIGHT.fg};">` +
      `What actually decides your renewal date</h1>` +
      p(htmlGreeting(firstName)) +
      p(
        `You confirmed a ${esc(SITE_NAME)} reminder a little while back, so we know you're already ` +
          `tracking your own renewal date. Over the next few weeks we'll send a short series -- no ` +
          `fluff, just the things that actually trip CPAs up on renewals. This is a one-time series, ` +
          `not a recurring newsletter.`
      ) +
      p(
        `First up: most people assume their renewal date is set by when they got their license. In ` +
          `${esc(stateName)}, that's not quite the whole picture -- ${esc(cycleFact)}`
      ) +
      p(
        `Knowing which pattern your state uses is the difference between "I'll get to it" and ` +
          `actually knowing your real deadline.`,
        13,
        LIGHT.muted
      ) +
      p("Next email in about a week: the CPE mistake that catches even careful CPAs off guard.", 13, LIGHT.muted),
    dripCourseHtmlFooter(unsubscribeUrl, addr)
  );

  return { subject, textBody, htmlBody, headers: listUnsubHeaders(unsubscribeUrl) };
}

export function buildDripCourseStep2Email(firstName: string | null, stateName: string, unsubscribeUrl: string): BuiltEmail {
  const addr = mailingAddress();
  const subject = `The CPE rule most CPAs get wrong`;

  const textBody =
    `${textGreeting(firstName)}\n\n` +
    `Quick one this week. The most common CPE mistake isn't missing hours overall -- it's missing ` +
    `the ethics-specific minimum inside that total, or hitting an annual floor too late in the cycle ` +
    `to fix it. Most boards, ${stateName}'s included, treat those as separate requirements, not one ` +
    `combined number.\n\n` +
    `If you're not sure where you stand, most boards let you check your own CPE history online -- ` +
    `worth five minutes now rather than a scramble near the deadline.\n\n` +
    `Last email in the series is next week: what actually happens if a deadline slips past you.` +
    dripCourseTextFooter(unsubscribeUrl, addr);

  const htmlBody = htmlShell(
    subject,
    `<h1 class="dr-fg" style="margin:0 0 16px;font-size:19px;font-weight:700;color:${LIGHT.fg};">` +
      `The CPE mistake that catches people off guard</h1>` +
      p(htmlGreeting(firstName)) +
      p(
        `Quick one this week. The most common CPE mistake isn't missing hours overall -- it's ` +
          `missing the ethics-specific minimum inside that total, or hitting an annual floor too ` +
          `late in the cycle to fix it. Most boards, ${esc(stateName)}'s included, treat those as ` +
          `separate requirements, not one combined number.`
      ) +
      p(
        `If you're not sure where you stand, most boards let you check your own CPE history online ` +
          `-- worth five minutes now rather than a scramble near the deadline.`,
        13,
        LIGHT.muted
      ) +
      p("Last email in the series is next week: what actually happens if a deadline slips past you.", 13, LIGHT.muted),
    dripCourseHtmlFooter(unsubscribeUrl, addr)
  );

  return { subject, textBody, htmlBody, headers: listUnsubHeaders(unsubscribeUrl) };
}

export function buildDripCourseStep3Email(firstName: string | null, stateName: string, unsubscribeUrl: string): BuiltEmail {
  const addr = mailingAddress();
  const subject = `What actually happens if your license lapses`;

  const textBody =
    `${textGreeting(firstName)}\n\n` +
    `Not trying to alarm you -- you're already ahead of this by tracking your deadline. But it's ` +
    `worth knowing what "late" actually means in ${stateName}, because it's rarely instant and ` +
    `rarely simple: a lapsed license doesn't disappear, but reinstatement typically means a formal ` +
    `application, a fee, and proof of current CPE -- time you don't get back, for a deadline that ` +
    `was knowable months in advance.\n\n` +
    `That's exactly the gap ${SITE_NAME} exists to close, and you're already covered for your own ` +
    `license. One more email after this -- then the series is done and you're back to just your ` +
    `regular reminders.` +
    dripCourseTextFooter(unsubscribeUrl, addr);

  const htmlBody = htmlShell(
    subject,
    `<h1 class="dr-fg" style="margin:0 0 16px;font-size:19px;font-weight:700;color:${LIGHT.fg};">` +
      `What happens if you miss it</h1>` +
      p(htmlGreeting(firstName)) +
      p(
        `Not trying to alarm you -- you're already ahead of this by tracking your deadline. But ` +
          `it's worth knowing what "late" actually means in ${esc(stateName)}, because it's rarely ` +
          `instant and rarely simple: a lapsed license doesn't disappear, but reinstatement ` +
          `typically means a formal application, a fee, and proof of current CPE -- time you don't ` +
          `get back, for a deadline that was knowable months in advance.`
      ) +
      p(
        `That's exactly the gap ${esc(SITE_NAME)} exists to close, and you're already covered for ` +
          `your own license. One more email after this -- then the series is done and you're back ` +
          `to just your regular reminders.`,
        13,
        LIGHT.muted
      ),
    dripCourseHtmlFooter(unsubscribeUrl, addr)
  );

  return { subject, textBody, htmlBody, headers: listUnsubHeaders(unsubscribeUrl) };
}

/** Step 4 (day 21, final) -- the one soft CTA in the series, and only ever
 * toward a firm account: the $39/mo individual paid tier
 * (`individual_accounts`, migration 0018) is schema-only and has no live
 * route anywhere in this Worker, so "nudge toward upgrading" can only mean
 * firm conversion today. Framed as conditional ("if that's you") rather
 * than assumed, since most recipients are not firm admins. */
export function buildDripCourseStep4Email(firstName: string | null, unsubscribeUrl: string): BuiltEmail {
  const addr = mailingAddress();
  const forFirmsUrl = `${SITE_URL}/for-firms/`;
  const subject = `Last one -- and a question, if it applies to you`;

  const textBody =
    `${textGreeting(firstName)}\n\n` +
    `That's the series -- thanks for reading. Quick last thing, only relevant if it applies: if ` +
    `you're part of a firm that tracks renewal dates for more than just yourself (a few staff, a ` +
    `whole roster), ${SITE_NAME} has a firm plan built for exactly that -- one dashboard instead of ` +
    `everyone tracking their own date separately. If that's not you, no action needed, and no hard ` +
    `feelings either way.\n\n` +
    `${forFirmsUrl}\n\n` +
    `This is the last email in this series. You'll keep getting your normal deadline reminders ` +
    `exactly as before -- this doesn't change or repeat.` +
    dripCourseTextFooter(unsubscribeUrl, addr);

  const htmlBody = htmlShell(
    subject,
    `<h1 class="dr-fg" style="margin:0 0 16px;font-size:19px;font-weight:700;color:${LIGHT.fg};">` +
      `Last one -- and a question, if it applies to you</h1>` +
      p(htmlGreeting(firstName)) +
      p(
        `That's the series -- thanks for reading. Quick last thing, only relevant if it applies: ` +
          `if you're part of a firm that tracks renewal dates for more than just yourself (a few ` +
          `staff, a whole roster), ${esc(SITE_NAME)} has a firm plan built for exactly that -- one ` +
          `dashboard instead of everyone tracking their own date separately. If that's not you, no ` +
          `action needed, and no hard feelings either way.`
      ) +
      `<p style="margin:0 0 20px;">${button(forFirmsUrl, "See the firm plan")}</p>` +
      p(
        `This is the last email in this series. You'll keep getting your normal deadline reminders ` +
          `exactly as before -- this doesn't change or repeat.`,
        13,
        LIGHT.muted
      ),
    dripCourseHtmlFooter(unsubscribeUrl, addr)
  );

  return { subject, textBody, htmlBody, headers: listUnsubHeaders(unsubscribeUrl) };
}

/**
 * Task #19 (2026-08-06): sent once, when an operator marks a roadmap idea
 * shipped (no automatic detection -- see index.ts's handleRoadmapMarkShipped
 * docstring). One-time by construction (notified_at is set the moment this
 * goes out, and there's only ever one "shipped" transition per idea), so
 * this carries the same plain-transactional shape as the confirm email
 * above rather than full unsubscribe machinery.
 */
export function buildFeatureIdeaShippedEmail(ideaTitle: string): BuiltEmail {
  const addr = mailingAddress();
  const safeTitle = ideaTitle.replace(/[\r\n]+/g, " ");
  const subject = `It shipped: ${safeTitle}`;

  const textBody =
    `Good news -- "${safeTitle}" is live on ${SITE_NAME} now. You asked to hear about this on the ` +
    `roadmap page, so here it is.\n\n` +
    `---\n${SENDER_LINE}\n${addr}`;

  const htmlBody = htmlShell(
    subject,
    `<h1 class="dr-fg" style="margin:0 0 16px;font-size:19px;font-weight:700;color:${LIGHT.fg};">` +
      `It shipped</h1>` +
      p(
        `<strong>${esc(safeTitle)}</strong> is live on ${esc(SITE_NAME)} now. You asked to hear about ` +
          `this on the roadmap page, so here it is.`
      ),
    `<p class="dr-muted" style="font-size:11px;color:${LIGHT.muted};line-height:1.5;margin:0;">` +
      `${esc(SENDER_LINE)}<br>${esc(addr)}</p>`
  );

  return { subject, textBody, htmlBody, headers: {} };
}
