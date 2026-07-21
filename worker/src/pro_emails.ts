/**
 * DeadlineRadar Pro -- account-transactional email copy (verify email,
 * password reset). Reuses emails.ts's shared building blocks (htmlShell,
 * button, p, mailingAddress, LIGHT/DARK) rather than a second copy of the
 * same layout -- these are account-security emails, not the renewal-
 * reminder subscription flow emails.ts's own footer copy is written for, so
 * this file has its own footer text (no "unsubscribe" language -- there's
 * nothing to unsubscribe from here) but the same CAN-SPAM mailing-address +
 * non-affiliation disclaimer requirement applies to every commercial email
 * regardless of type.
 */
import { escapeHtml } from "./validation";
import {
  SITE_NAME,
  BRAND_NAME,
  SENDER_LINE,
  htmlShell,
  button,
  p,
  mailingAddress,
  LIGHT,
  type BuiltEmail,
} from "./emails";

function esc(s: string): string {
  return escapeHtml(String(s));
}

function proHtmlFooter(addr: string): string {
  return (
    `<p class="dr-muted" style="font-size:12px;color:${LIGHT.muted};line-height:1.6;margin:0 0 10px;">` +
    `You're getting this because this address was used to create or manage a ${esc(SITE_NAME)} Pro ` +
    `account. This is a one-time account-security message, not a recurring subscription.</p>` +
    `<p class="dr-muted" style="font-size:11px;color:${LIGHT.muted};line-height:1.5;margin:0;">` +
    `${esc(SENDER_LINE)}<br>${esc(addr)}</p>` +
    `<p class="dr-muted" style="font-size:11px;color:${LIGHT.muted};line-height:1.5;margin:8px 0 0;">` +
    `${esc(SITE_NAME)} is an independent service operated by ${esc(BRAND_NAME)}. It is not ` +
    `affiliated with, endorsed by, or connected to NASBA, the AICPA, or any state board of ` +
    `accountancy.</p>`
  );
}

function proTextFooter(addr: string): string {
  return (
    `\n\n---\n` +
    `You're getting this because this address was used to create or manage a ${SITE_NAME} Pro ` +
    `account. This is a one-time account-security message, not a recurring subscription.\n\n` +
    `${SENDER_LINE}\n${addr}\n\n` +
    `${SITE_NAME} is an independent service operated by ${BRAND_NAME}. It is not affiliated with, ` +
    `endorsed by, or connected to NASBA, the AICPA, or any state board of accountancy.`
  );
}

export function buildProVerifyEmail(verifyUrl: string): BuiltEmail {
  const addr = mailingAddress(); // hard-fails first, same as every other builder in this codebase
  const subject = `Verify your ${SITE_NAME} Pro email`;

  const textBody =
    `Confirm this is really your inbox to finish setting up your ${SITE_NAME} Pro account:\n\n` +
    `${verifyUrl}\n\n` +
    `If you didn't create this account, just ignore this email -- nothing else happens ` +
    `automatically.` +
    `${proTextFooter(addr)}`;

  const htmlBody = htmlShell(
    `Verify your ${SITE_NAME} Pro email`,
    `<h1 class="dr-fg" style="margin:0 0 16px;font-size:19px;font-weight:700;color:${LIGHT.fg};">` +
      `Verify your email</h1>` +
      p(
        `Confirm this is really your inbox to finish setting up your ${esc(SITE_NAME)} Pro account.`
      ) +
      `<p style="margin:0 0 20px;">${button(verifyUrl, "Verify my email")}</p>` +
      p(
        "If you didn't create this account, just ignore this email -- nothing else happens " +
          "automatically.",
        13,
        LIGHT.muted
      ),
    proHtmlFooter(addr)
  );

  return { subject, textBody, htmlBody, headers: {} };
}

export function buildProPasswordResetEmail(resetUrl: string): BuiltEmail {
  const addr = mailingAddress();
  const subject = `Reset your ${SITE_NAME} Pro password`;

  const textBody =
    `Someone (hopefully you) asked to reset the password on your ${SITE_NAME} Pro account. This ` +
    `link works for 1 hour:\n\n` +
    `${resetUrl}\n\n` +
    `If you didn't request this, you can safely ignore this email -- your password will not change ` +
    `unless you click the link above and set a new one.` +
    `${proTextFooter(addr)}`;

  const htmlBody = htmlShell(
    `Reset your ${SITE_NAME} Pro password`,
    `<h1 class="dr-fg" style="margin:0 0 16px;font-size:19px;font-weight:700;color:${LIGHT.fg};">` +
      `Reset your password</h1>` +
      p(
        `Someone (hopefully you) asked to reset the password on your ${esc(SITE_NAME)} Pro ` +
          `account. This link works for <strong>1 hour</strong>.`
      ) +
      `<p style="margin:0 0 20px;">${button(resetUrl, "Reset my password")}</p>` +
      p(
        "If you didn't request this, you can safely ignore this email -- your password will not " +
          "change unless you click the link above and set a new one.",
        13,
        LIGHT.muted
      ),
    proHtmlFooter(addr)
  );

  return { subject, textBody, htmlBody, headers: {} };
}

/**
 * Sent when someone tries to sign up with an email that already has a Pro
 * account (out-of-band notice to the real account holder's inbox -- see
 * pro.ts's handleProSignup docstring for why the HTTP response itself must
 * stay generic regardless of which branch ran).
 */
export function buildProExistingAccountNoticeEmail(): BuiltEmail {
  const addr = mailingAddress();
  const subject = `Someone tried to sign up with your ${SITE_NAME} Pro email`;

  const textBody =
    `Someone just tried to create a new ${SITE_NAME} Pro account using this email address -- but you ` +
    `already have one.\n\n` +
    `If that was you, just log in instead: https://deadline-radar.com/pro/\n\n` +
    `Forgot your password? Use the "Forgot your password?" link on that page.\n\n` +
    `If it wasn't you, no action is needed -- no new account was created and your existing one is ` +
    `unaffected.` +
    `${proTextFooter(addr)}`;

  const htmlBody = htmlShell(
    subject,
    `<h1 class="dr-fg" style="margin:0 0 16px;font-size:19px;font-weight:700;color:${LIGHT.fg};">` +
      `Someone tried to sign up with your email</h1>` +
      p(
        `Someone just tried to create a new ${esc(SITE_NAME)} Pro account using this email address ` +
          `-- but you already have one.`
      ) +
      `<p style="margin:0 0 20px;">${button("https://deadline-radar.com/pro/", "Log in instead")}</p>` +
      p(
        `If it wasn't you, no action is needed &mdash; no new account was created and your existing ` +
          `one is unaffected.`,
        13,
        LIGHT.muted
      ),
    proHtmlFooter(addr)
  );

  return { subject, textBody, htmlBody, headers: {} };
}
