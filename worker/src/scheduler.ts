/**
 * DeadlineRadar Worker -- the escalating reminder scheduler (Phase 3).
 *
 * Ported from reminders/scheduler.py `run_once()`. Runs one pass: for each
 * confirmed subscriber, compute their OWN next deadline, find the nearest
 * newly-due escalation threshold (60/30/14/7/3/1 days), and send exactly one
 * reminder for it. Driven by a daily Cloudflare Cron Trigger (see index.ts's
 * scheduled() and wrangler.toml's [triggers]).
 *
 * Every abuse/correctness rule from the Python original is carried over:
 *   - next-due-threshold never regresses to a less-urgent tier once a more
 *     urgent one has fired (a scheduler gap must not send reminders out of order).
 *   - a never-yet-notified subscriber whose first evaluation lands past the
 *     deadline gets exactly one bounded catch-up, not silence forever.
 *   - a permanently-unsubscribed address is re-checked right before the send,
 *     independent of the status filter (defense-in-depth).
 *   - one bad subscriber record never aborts the whole run.
 *   - every send counts against the same daily circuit breaker the
 *     confirmation email uses (shared total-sends-per-day cap).
 *   - a threshold is claimed atomically BEFORE send() is called (optimistic
 *     concurrency on reminders_sent), so two overlapping passes -- a cron
 *     retry, a redeploy mid-run, a manual /debug/run-reminder-pass racing the
 *     cron -- can't both send the same tier. The loser's claim fails and it
 *     skips. See store.claimReminderThreshold()/unclaimReminderThreshold().
 *   - a lost claim is reverted (unclaimed) on any handled failure -- send()
 *     returning false, the daily cap being hit, or any thrown error from the
 *     per-subscriber body -- so a transient failure re-tries that tier on the
 *     next pass rather than silently losing it. Delivery is at-least-once for
 *     every failure this code can observe and react to; the only remaining
 *     miss window is the Worker being killed outright between the claim
 *     write and send() returning, which no non-transactional external-side-
 *     effect system can fully close.
 */

import type { Env } from "./env";
import type { BuiltEmail } from "./emails";
import * as store from "./store";
import { StaleDataError, checkDataFreshness, computeSubscriberDeadline, stateNameForSlug } from "./deadline";
import {
  buildReminderEmail,
  fmtDate,
  SNOOZE_DAYS,
  buildDripCourseStep1Email,
  buildDripCourseStep2Email,
  buildDripCourseStep3Email,
  buildDripCourseStep4Email,
  buildRuleChangeAdminAlertEmail,
  buildDigestEmail,
  type DigestItem,
  buildAdminDigestEmail,
  type AdminDigestItem,
  buildNewsletterDigestEmail,
  type NewsletterDigestItem,
} from "./emails";
import {
  DEFAULT_DAILY_SEND_CAP,
  resolveDailySendCap,
  checkAndCountSend,
  DEFAULT_DAILY_DRIP_COURSE_SEND_CAP,
  checkAndCountDripCourseSend,
  DEFAULT_DAILY_RULE_CHANGE_ALERT_SEND_CAP,
  checkAndCountRuleChangeAlertSend,
  DEFAULT_DAILY_DIGEST_SEND_CAP,
  checkAndCountDigestSend,
  DEFAULT_DAILY_SLACK_ALERT_SEND_CAP,
  checkAndCountSlackAlertSend,
  DEFAULT_DAILY_TEAMS_ALERT_SEND_CAP,
  checkAndCountTeamsAlertSend,
  DEFAULT_DAILY_SMS_SEND_CAP,
  checkAndCountSmsSend,
  DEFAULT_DAILY_ADMIN_DIGEST_SEND_CAP,
  checkAndCountAdminDigestSend,
  DEFAULT_DAILY_NEWSLETTER_SEND_CAP,
  checkAndCountNewsletterSend,
  sendViaSendGrid,
} from "./sender";
import { sendToSlack } from "./slack";
import { sendToTeams } from "./teams";
import { sendSms, isWithinSmsQuietHours } from "./sms";
import { decryptSecretAesGcm } from "./totp";
import { hasValueLineAccess } from "./entitlements";
import cpaDataForDripCourse from "./cpa_deadlines.json";
import regChangeEventsData from "./reg_change_events.json";

// scheduler.py: store.ESCALATION_THRESHOLDS_DAYS.
export const ESCALATION_THRESHOLDS_DAYS = [1, 3, 7, 14, 30, 60];

const GRACE_PERIOD_PAST_DEADLINE_DAYS = 3;
const NEVER_NOTIFIED_CATCHUP_WINDOW_DAYS = 14;

// AuditLab DIGEST-1 (2026-08-09): a threshold at or below this many days
// remaining bypasses a still-closed digest window rather than waiting for
// it to reopen -- otherwise a 1- or 3-day item claimed mid-window can sit
// unsent until the rolling window catches up, which can land AFTER the
// deadline it was warning about. Matches ESCALATION_THRESHOLDS_DAYS' own
// two most urgent tiers.
const DIGEST_URGENT_BYPASS_THRESHOLD_DAYS = 3;

// Action links point back at the Worker's /api route (Cloudflare delivers the
// /api prefix; the fetch handler strips it again on the way in).
const ACTION_BASE_URL = "https://deadline-radar.com/api";

// Preview/staging override -- see env.ts's ACTION_BASE_URL docstring and
// index.ts's identical helper. Kept as a separate local copy rather than a
// shared import since this module already duplicates ACTION_BASE_URL itself
// (see the comment above) rather than importing it from index.ts.
function actionBaseUrl(env: Env): string {
  return env.ACTION_BASE_URL || ACTION_BASE_URL;
}

// AuditLab UNSUB-2 (2026-08-10): one-click List-Unsubscribe target for the
// two admin-facing passes below, backed by firms.admin_unsubscribe_token
// (migration 0062). Two distinct literal paths (not a query-string
// `channel` param) so this rides the SAME generic ACTION_PAGES/ACTION_PATHS
// GET-renders-a-page/POST-changes-state machinery every other action link
// in this file already uses, unmodified -- each path flips its own single
// toggle, same as their Account-settings equivalents already do.
function adminUnsubscribeUrl(env: Env, token: string, channel: "rule-change" | "digest"): string {
  return `${actionBaseUrl(env)}/firm-admin-unsubscribe/${channel}?token=${encodeURIComponent(token)}`;
}

// AuditLab LINK-1 (2026-08-10, HIGH -- live customer email, fixed same day):
// the static site's own absolute origin, same "why a browser-redirect-style
// relative fallback is WRONG here" reasoning as index.ts's own
// staticSiteAbsoluteBaseUrl()/SITE_ORIGIN (index.ts:721-735, built
// 2026-08-05 for the identical bug class against Stripe's Checkout Session
// API) -- an email client has no browser context to resolve a relative
// href against, so `env.STATIC_SITE_BASE_URL || ""` rendered a bare path
// like `/my/` as a dead link in every one of runDigestPass/
// runRuleChangeAlertPass/runAdminDigestAlertPass's real emails.
// STATIC_SITE_BASE_URL is unset in production (confirmed live by AuditLab
// via the session-cookie SameSite oracle), so this was live, not
// theoretical -- do NOT fix by setting the env var directly, it also flips
// firmSessionCookieSameSite() to SameSite=None site-wide (index.ts's own
// docstring on that function). Kept as its own local copy, same
// "duplicate rather than import from index.ts" precedent as
// actionBaseUrl() above (importing FROM index.ts would be a circular
// import -- index.ts already imports this module's own passes).
const STATIC_SITE_ORIGIN = "https://deadline-radar.com";
function staticSiteAbsoluteBaseUrl(env: Env): string {
  return env.STATIC_SITE_BASE_URL || STATIC_SITE_ORIGIN;
}

const MS_PER_DAY = 86_400_000;

/**
 * scheduler.py `next_due_threshold()` -- the single nearest (most urgent)
 * threshold that's newly due, and NEVER a less-urgent tier than one already
 * sent (so a scheduler gap can't deliver reminders out of order).
 */
// Roadmap #23: optional 3rd param, defaulting to the full fixed set --
// every existing caller (including every test that doesn't pass one) is
// byte-identical to before this parameter existed. `thresholds` is always
// a SUBSET of ESCALATION_THRESHOLDS_DAYS by construction (validated at
// write time, index.ts's parseReminderThresholds()) -- this function
// doesn't re-validate that, same trust-the-caller posture as the rest of
// this file.
export function nextDueThreshold(
  daysRemaining: number,
  alreadySent: number[],
  thresholds: number[] = ESCALATION_THRESHOLDS_DAYS
): number | null {
  const mostUrgentSent = alreadySent.length > 0 ? Math.min(...alreadySent) : null;
  for (const threshold of [...thresholds].sort((a, b) => a - b)) {
    if (alreadySent.includes(threshold)) continue;
    if (mostUrgentSent !== null && threshold >= mostUrgentSent) continue;
    if (daysRemaining <= threshold) return threshold;
  }
  return null;
}

export interface ReminderSummary {
  checked: number;
  sent: number;
  skipped_no_deadline: number;
  skipped_grace_period: number;
  // Roadmap #26: a subscriber whose self-service snooze hasn't expired yet.
  skipped_snoozed: number;
  errors: { subscriber_id: string; error: string }[];
}

// Roadmap #26 (migration 0040): re-exported so callers/tests can import the
// fixed snooze duration from either module -- see the top-of-file import
// for why it's actually DEFINED in emails.ts, not here.
export { SNOOZE_DAYS };

// Roadmap #19: optional 3rd param, added after every existing caller/mock
// was already written with 1-2 params -- safe by TS's own function-type
// compatibility rules (a function accepting fewer params satisfies a type
// expecting more), so no existing test mock needed updating for this.
export type ReminderSendFn = (toEmail: string, email: BuiltEmail, replyTo?: string) => Promise<boolean>;

export interface RunReminderOptions {
  /** Scheduling clock. Defaults to now. A test can advance it without waiting
   * real days. */
  asOf?: Date;
  /** Injected sender for tests -- defaults to the real SendGrid send. Mirrors
   * the Python original passing an EmailSender in. */
  send?: ReminderSendFn;
}

function dailySendCap(env: Env): number {
  return resolveDailySendCap(env.REMINDERS_DAILY_SEND_CAP, DEFAULT_DAILY_SEND_CAP);
}

/**
 * One scheduling pass. Returns a summary for logging/testing. Never throws for
 * a single bad subscriber; only throws (StaleDataError) if the reference data
 * is too stale to schedule off at all -- a stale reminder is a wrong-date
 * email, worse than a stale static page.
 */
export async function runReminderPass(env: Env, opts: RunReminderOptions = {}): Promise<ReminderSummary> {
  const asOf = opts.asOf ?? new Date();
  // Freshness is judged against the REAL current date, even when a test
  // simulates asOf far in the future -- mirrors scheduler.py's
  // `check_data_freshness(... date.today())`. A simulated future asOf must not
  // trip the staleness guard on its own.
  const freshnessToday = opts.asOf ? new Date() : asOf;
  checkDataFreshness(freshnessToday);

  // AuditLab SCHED-E (2026-08-05, HIGH): the cron fires at 18:00 UTC
  // (wrangler.toml), so an un-normalised `asOf` is always ~0.75 days short of
  // a full day before the UTC-midnight-anchored deadline -- Math.round() then
  // rounds every daysRemaining down by exactly one (k - 0.75 rounds to k - 1),
  // understating every reminder's day count and shifting every threshold a
  // day early. Normalised to UTC midnight here, used ONLY for the
  // daysRemaining subtraction below -- deadline computation above still uses
  // the raw asOf, unchanged.
  const asOfDay = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()));

  const send: ReminderSendFn =
    opts.send ??
    ((to, built, replyTo) => {
      if (!env.SENDGRID_API_KEY) return Promise.resolve(false);
      return sendViaSendGrid(env.SENDGRID_API_KEY, to, built, env.EMAIL_ALLOWLIST, replyTo);
    });

  // Roadmap #19: one query, not one per subscriber -- see
  // store.listAllFirmsBasicInfo()'s own docstring for why.
  const firmsById = new Map((await store.listAllFirmsBasicInfo(env.DB)).map((f) => [f.id, f]));

  const cap = dailySendCap(env);
  const summary: ReminderSummary = {
    checked: 0,
    sent: 0,
    skipped_no_deadline: 0,
    skipped_grace_period: 0,
    skipped_snoozed: 0,
    errors: [],
  };

  const todayIso = asOfDay.toISOString().slice(0, 10);

  const subscribers = await store.allConfirmedActive(env.DB);
  for (const sub of subscribers) {
    summary.checked += 1;

    // Roadmap #26: checked before any deadline/threshold work -- a snoozed
    // subscriber gets NO evaluation at all this pass, same as a not-yet-due
    // one, rather than a suppressed-at-send-time special case.
    if (sub.snoozed_until && sub.snoozed_until >= todayIso) {
      summary.skipped_snoozed += 1;
      continue;
    }

    // Roadmap #24: a digest-mode subscriber is handled ENTIRELY by
    // runDigestPass() below, on its own weekly cadence -- if this pass
    // sent to them too they'd get both an immediate ping AND a later
    // digest for the same threshold. Not counted in any summary field
    // (this is a routing decision, not a skip condition like snoozed_until
    // above -- the digest pass has its own summary for its own outcomes).
    if (sub.notification_mode === store.NOTIFICATION_MODE_DIGEST) {
      continue;
    }

    let deadline: Date | null;
    let fields: Record<string, string>;
    try {
      fields = JSON.parse(sub.deadline_fields || "{}");
      // "Bring your own date" (migration 0005): a user-provided subscriber's
      // deadline is a literal stored value, not something to re-derive from
      // state rules -- use it directly and skip computeSubscriberDeadline()
      // entirely. Every escalation/threshold/grace-period rule below is
      // completely unchanged; it only ever sees a Date, never cares how it
      // was derived.
      deadline =
        sub.deadline_source === store.DEADLINE_SOURCE_USER && sub.user_deadline
          ? new Date(`${sub.user_deadline}T00:00:00Z`)
          : computeSubscriberDeadline(sub.state_slug, fields, asOf);
    } catch (err) {
      summary.errors.push({ subscriber_id: sub.id, error: String(err) });
      continue;
    }
    if (deadline === null) {
      summary.skipped_no_deadline += 1;
      continue;
    }
    const stateName = stateNameForSlug(sub.state_slug);
    if (stateName === null) {
      summary.skipped_no_deadline += 1;
      continue;
    }

    const daysRemaining = Math.round((deadline.getTime() - asOfDay.getTime()) / MS_PER_DAY);
    let alreadySent: number[];
    try {
      alreadySent = JSON.parse(sub.reminders_sent || "[]");
    } catch {
      alreadySent = [];
    }
    const neverNotified = alreadySent.length === 0;

    // Roadmap #19/#23: looked up once here (not per-use below) since both
    // the catch-up tier and nextDueThreshold() need the firm's own
    // threshold subset, not just the email-building step further down.
    // null for a free-tier individual (sub.firm_id is null) or,
    // defensively, if the firm_id somehow doesn't resolve.
    const firmInfo = sub.firm_id ? firmsById.get(sub.firm_id) ?? null : null;
    let thresholds: number[] = ESCALATION_THRESHOLDS_DAYS;
    if (firmInfo?.reminder_thresholds) {
      try {
        const parsed = JSON.parse(firmInfo.reminder_thresholds);
        if (Array.isArray(parsed) && parsed.length > 0) thresholds = parsed;
      } catch {
        // Malformed value somehow reached storage -- fall back to the full
        // default set rather than silently sending nothing.
      }
    }
    // Roadmap #12 (migration 0046): a per-subscriber override, applied
    // AFTER the firm's own setting -- "my own communication preferences"
    // wins over the firm's default, never the reverse. NULL means
    // "inherit," same posture as the firm-level column itself.
    if (sub.reminder_thresholds) {
      try {
        const parsed = JSON.parse(sub.reminder_thresholds);
        if (Array.isArray(parsed) && parsed.length > 0) thresholds = parsed;
      } catch {
        // Same fall-through posture as the firm-level parse above.
      }
    }

    let threshold: number | null;
    if (daysRemaining < -GRACE_PERIOD_PAST_DEADLINE_DAYS) {
      if (neverNotified && daysRemaining >= -NEVER_NOTIFIED_CATCHUP_WINDOW_DAYS) {
        // First-ever evaluation landed past-deadline -- one bounded catch-up at
        // the most urgent tier this firm actually uses, rather than silent-
        // forever OR a tier they've deliberately turned off.
        threshold = Math.min(...thresholds);
      } else {
        summary.skipped_grace_period += 1;
        continue;
      }
    } else {
      threshold = nextDueThreshold(daysRemaining, alreadySent, thresholds);
      if (threshold === null) continue;
    }

    // SCHED-B: every D1/network call below can throw (client hiccup, D1
    // blip). One bad subscriber must not abort the whole pass -- the module
    // docstring promises that but previously only JSON.parse/computeSubscriberDeadline
    // and buildReminderEmail were actually guarded. This try wraps the rest of
    // the per-subscriber body so any unhandled throw is recorded and the loop
    // moves on to the next subscriber instead of aborting the pass.
    let claimedThreshold = false;
    try {
      // AuditLab DEMO-5 (MEDIUM, 2026-08-07): the shared public demo
      // account's roster is deliberately still mutable (DEMO-3/DEMO-4's
      // own "gate the send, not the mutation" line) -- a demo visitor's
      // Add Staff row with an arbitrary email and a "bring your own date"
      // deadline landing on a threshold day would otherwise reach this
      // cron and get emailed for real, up to ~24h later. Checked before
      // isPermanentlySuppressed (no DB call needed) and, per AuditLab's
      // own framing, WITHOUT claiming the threshold -- claiming would mark
      // it as sent when nothing was, silently breaking the demo's own
      // "try the reminder feature" story for the next visitor.
      if (firmInfo?.demo_locked) {
        summary.errors.push({
          subscriber_id: sub.id,
          error: "SKIPPED: firm is demo_locked -- no email sent from the shared demo account.",
        });
        continue;
      }

      // Defense-in-depth: allConfirmedActive() already filters to confirmed, but
      // a permanently-unsubscribed address must never be sent to even if a status
      // bug elsewhere left it confirmed. Re-check right before the send.
      if (await store.isPermanentlySuppressed(env.DB, sub.email)) {
        summary.errors.push({
          subscriber_id: sub.id,
          error: "BLOCKED: email is permanently suppressed (unsubscribed) -- refusing despite status=confirmed.",
        });
        continue;
      }

      // Both action links use the SAME renewed_token -- store.renewAndRearmByToken()
      // and store.stop() both accept either renewed_token or unsubscribe_token, so
      // this is not a new token type, just a new URL path over an existing one.
      const renewedNextCycleUrl = `${actionBaseUrl(env)}/renewed-next-cycle?token=${encodeURIComponent(sub.renewed_token)}`;
      const renewedUrl = `${actionBaseUrl(env)}/renewed?token=${encodeURIComponent(sub.renewed_token)}`;
      const unsubscribeUrl = `${actionBaseUrl(env)}/unsubscribe?token=${encodeURIComponent(sub.unsubscribe_token)}`;
      // Roadmap #26: same shared-token reasoning as the two links above.
      const snoozeUrl = `${actionBaseUrl(env)}/snooze?token=${encodeURIComponent(sub.renewed_token)}`;
      let built: BuiltEmail;
      try {
        built = buildReminderEmail(
          stateName,
          fmtDate(deadline),
          threshold,
          daysRemaining,
          renewedNextCycleUrl,
          renewedUrl,
          unsubscribeUrl,
          sub.first_name,
          firmInfo?.name ?? null,
          snoozeUrl
        );
      } catch (err) {
        summary.errors.push({ subscriber_id: sub.id, error: `email build failed: ${String(err)}` });
        continue;
      }

      // SCHED-A: claim this threshold atomically BEFORE calling send(). If
      // another overlapping pass already claimed it (or already sent it),
      // this loses the race and skips -- the tier is not ours to send.
      const claimed = await store.claimReminderThreshold(env.DB, sub.id, sub.reminders_sent || "[]", threshold);
      if (!claimed) continue;
      claimedThreshold = true;

      // Circuit breaker last, right before the send, so a build/suppression skip
      // above never consumes a day's send budget.
      const underCap = await checkAndCountSend(env.DB, cap);
      if (!underCap) {
        await store.unclaimReminderThreshold(env.DB, sub.id, threshold);
        summary.errors.push({ subscriber_id: sub.id, error: "daily send cap reached -- halting further sends today." });
        // SCHED-C: actually halt (matches the message above) instead of
        // `continue`-ing through the rest of the cohort, which used to churn
        // one wasted D1 write plus an errors[] entry per remaining subscriber.
        break;
      }

      const ok = await send(sub.email, built, firmInfo?.reply_to_email ?? undefined);
      if (ok) {
        summary.sent += 1;
        // Roadmap #8: the "dates reminded" half of the audit-trail export --
        // only for firm-tracked subscribers (a free-tier individual has no
        // dashboard to show this in), and only after send() genuinely
        // reports success. Best-effort: a logging failure must never affect
        // whether this reminder counts as sent.
        if (sub.firm_id) {
          await store.logReminderSent(env.DB, sub.firm_id, sub.id, threshold).catch(() => {});
        }
      } else {
        await store.unclaimReminderThreshold(env.DB, sub.id, threshold);
        summary.errors.push({ subscriber_id: sub.id, error: "send returned false" });
      }
    } catch (err) {
      if (claimedThreshold) {
        await store.unclaimReminderThreshold(env.DB, sub.id, threshold).catch(() => {});
      }
      summary.errors.push({ subscriber_id: sub.id, error: `unexpected error: ${String(err)}` });
    }
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Drip course (2026-08-08, roadmap #34). Same daily-cron trigger, own
// independent pass -- see index.ts's scheduled(). Anchored on
// drip_course_enrollments.started_at (days SINCE enrollment), the opposite
// orientation from the reminder pass above (days UNTIL a deadline) -- see
// nextDueDripStep()'s own comment for how the never-regress rule inverts.
// ---------------------------------------------------------------------------

export const DRIP_COURSE_STEP_DAYS = [0, 7, 14, 21];
export const DRIP_COURSE_ENROLL_BATCH_SIZE = 50;

interface DripCourseCpaRecord {
  state_slug: string;
  cycle_description?: string;
  // AuditLab DRIP-1 (MEDIUM, 2026-08-09): present (non-null) was assumed to
  // mean this record's own public state page deliberately publishes NO
  // computed date and shows a sourcing caveat instead. 2026-08-17: that
  // assumption broke for `computation`-backed records (Texas etc.) --
  // data_gap_note is also used to record confident dual-source
  // VERIFICATION methodology, unrelated to whether a date is published.
  // Texas's own page (render_texas() in generate.py) shows a full
  // confident birth-month lookup table, no caveat at all, despite
  // carrying a data_gap_note -- see dripCourseCycleFact() below for how
  // `computation` narrows this back to the intended signal.
  data_gap_note?: string | null;
  // Present when the record's date is a per-licensee FORMULA (birth-month,
  // etc.) rather than unknown -- the page still states the rule
  // confidently (generate.py's render_texas()/computation-aware paths),
  // so cycle_description is safe to quote even though no single
  // next_deadline_computed date exists.
  computation?: Record<string, unknown> | null;
}
const DRIP_COURSE_CPA_RECORDS = (cpaDataForDripCourse as unknown as { records: DripCourseCpaRecord[] }).records;

const DRIP_COURSE_CYCLE_FACT_MAX_LEN = 220;
const DRIP_COURSE_GENERIC_CYCLE_FACT =
  "renewal cycles vary by state (fixed calendar date, birth-month, or a multi-year cohort), so it's " +
  "worth confirming which pattern applies to you specifically, not assuming it matches a neighboring state.";

/** A short excerpt of the subscriber's own state's real renewal mechanic,
 * sourced from the SAME cpa_deadlines.json field the public state pages
 * render -- never a fact invented for this email. Falls back to a
 * deliberately generic (never wrong) sentence when no record matches or the
 * description is empty, rather than fabricating a per-state claim.
 *
 * AuditLab DRIP-1 (MEDIUM, 2026-08-09): these fields are routinely written
 * as claim-first, caveat-second ("X expires biennially on July 31. Neither
 * official source specifies which year of the cycle applies..."), so a
 * mid-sentence truncation preserves grammar but not meaning -- the cut can
 * land exactly between the claim and the caveat that qualifies it,
 * simulated to affect 14/55 states. Two guards now, both from the
 * finding's own cheapest-fix list: (1) a record with data_gap_note AND no
 * `computation` formula (the public page itself deliberately publishes no
 * date and shows a sourcing caveat) never gets excerpted at all -- the
 * email must never be MORE assertive than the product's own page for that
 * exact record. 2026-08-17: narrowed from "any data_gap_note" -- that was
 * also silently suppressing `computation`-backed records (Texas etc.),
 * whose public page states the rule confidently with no caveat at all;
 * data_gap_note there records verification methodology, not a sourcing
 * gap. (2) the excerpt is only used when the WHOLE cycle_description fits
 * under the cap, otherwise fall back to the generic (never-wrong)
 * sentence rather than ever truncating -- removes the truncation failure
 * mode entirely instead of patching individual instances of it. */
export function dripCourseCycleFact(stateSlug: string | null): string {
  if (!stateSlug) return DRIP_COURSE_GENERIC_CYCLE_FACT;
  const record = DRIP_COURSE_CPA_RECORDS.find((r) => r.state_slug === stateSlug && r.cycle_description);
  if (record?.data_gap_note && !record.computation) return DRIP_COURSE_GENERIC_CYCLE_FACT;
  const desc = record?.cycle_description?.trim();
  if (!desc) return DRIP_COURSE_GENERIC_CYCLE_FACT;
  if (desc.length <= DRIP_COURSE_CYCLE_FACT_MAX_LEN) return desc;
  return DRIP_COURSE_GENERIC_CYCLE_FACT;
}

/**
 * Finds the nearest due-and-unsent step, never regressing to an EARLIER
 * step than the most recent one already sent. Inverted from
 * nextDueThreshold() above: there, smaller = more urgent and time counts
 * DOWN toward a deadline; here, larger = later-in-the-series and time
 * counts UP from enrollment, so "never regress" means never re-sending a
 * numerically smaller step after a larger one has already gone out.
 */
export function nextDueDripStep(daysSinceStart: number, alreadySent: number[], steps: number[] = DRIP_COURSE_STEP_DAYS): number | null {
  const mostRecentSent = alreadySent.length > 0 ? Math.max(...alreadySent) : -1;
  for (const step of [...steps].sort((a, b) => a - b)) {
    if (alreadySent.includes(step)) continue;
    if (step <= mostRecentSent) continue;
    if (daysSinceStart >= step) return step;
  }
  return null;
}

export interface DripCourseSummary {
  enrolled: number;
  checked: number;
  sent: number;
  errors: { enrollment_id: string; error: string }[];
}

function dailyDripCourseSendCap(env: Env): number {
  return resolveDailySendCap(env.DRIP_COURSE_DAILY_SEND_CAP, DEFAULT_DAILY_DRIP_COURSE_SEND_CAP);
}

export async function runDripCoursePass(env: Env, opts: RunReminderOptions = {}): Promise<DripCourseSummary> {
  const asOf = opts.asOf ?? new Date();
  // AuditLab DRIP-3 (MEDIUM, 2026-08-09): this pass builds email 1's
  // cycleFact from the SAME cpa_deadlines.json runReminderPass() guards
  // with checkDataFreshness() -- without this, once the data aged past 30
  // days, reminders to paying subscribers correctly stopped while
  // marketing emails kept quoting that same stale file to leads, the
  // guard doing the opposite of its purpose in the channel with the least
  // context. Same real-vs-simulated freshness split as runReminderPass()'s
  // own comment explains -- a simulated future asOf must not trip this on
  // its own.
  const freshnessToday = opts.asOf ? new Date() : asOf;
  checkDataFreshness(freshnessToday);
  const asOfDay = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()));

  const send: ReminderSendFn =
    opts.send ??
    ((to, built) => {
      if (!env.SENDGRID_API_KEY) return Promise.resolve(false);
      return sendViaSendGrid(env.SENDGRID_API_KEY, to, built, env.EMAIL_ALLOWLIST);
    });

  const summary: DripCourseSummary = { enrolled: 0, checked: 0, sent: 0, errors: [] };

  // Phase 1: enroll newly-eligible leads. Bounded per pass so a large
  // backlog on first deploy doesn't try to enroll everyone in one burst.
  const eligible = await store.findEligibleDripCourseLeads(env.DB, DRIP_COURSE_ENROLL_BATCH_SIZE);
  for (const lead of eligible) {
    await store.enrollDripCourseLead(env.DB, lead);
    summary.enrolled += 1;
  }

  const cap = dailyDripCourseSendCap(env);
  const actionBase = actionBaseUrl(env);
  const enrollments = await store.listActiveDripCourseEnrollments(env.DB);

  for (const enr of enrollments) {
    summary.checked += 1;
    // Normalized to its own UTC midnight, same as asOfDay -- started_at
    // carries a real time-of-day (whenever the cron happened to enroll
    // them), and subtracting that against asOfDay's midnight would
    // otherwise floor to -1 for the entire rest of enrollment day (any
    // enrollment after 00:00 UTC looks like it happened "tomorrow" relative
    // to today's midnight until normalized the same way).
    const startedAtRaw = new Date(enr.started_at);
    const startedAtDay = new Date(Date.UTC(startedAtRaw.getUTCFullYear(), startedAtRaw.getUTCMonth(), startedAtRaw.getUTCDate()));
    const daysSinceStart = Math.floor((asOfDay.getTime() - startedAtDay.getTime()) / MS_PER_DAY);
    let alreadySent: number[];
    try {
      alreadySent = JSON.parse(enr.steps_sent || "[]");
    } catch {
      alreadySent = [];
    }
    const step = nextDueDripStep(daysSinceStart, alreadySent);
    if (step === null) continue;

    // AuditLab DRIP-2 (MEDIUM, 2026-08-09): enrollment checks permanent
    // suppression (findEligibleDripCourseLeads()) but the send loop never
    // did, so unsubscribing from a REMINDER after enrolling didn't stop the
    // marketing drip -- up to three more sends over the next three weeks,
    // the exact thing runReminderPass() itself refuses to do. Checked here,
    // before claiming a step, so a skipped send doesn't burn a step the
    // person would otherwise never get credit for (irrelevant once
    // suppressed, but keeps steps_sent an honest record either way).
    if (await store.isPermanentlySuppressed(env.DB, enr.email)) continue;

    let claimedStep = false;
    try {
      const unsubscribeUrl = `${actionBase}/drip-course/unsubscribe?token=${encodeURIComponent(enr.unsubscribe_token)}`;
      const stateName = (enr.state_slug ? stateNameForSlug(enr.state_slug) : null) ?? "your state";
      let built: BuiltEmail;
      switch (step) {
        case 0:
          built = buildDripCourseStep1Email(enr.first_name, stateName, dripCourseCycleFact(enr.state_slug), unsubscribeUrl);
          break;
        case 7:
          built = buildDripCourseStep2Email(enr.first_name, stateName, unsubscribeUrl);
          break;
        case 14:
          built = buildDripCourseStep3Email(enr.first_name, stateName, unsubscribeUrl);
          break;
        case 21:
          built = buildDripCourseStep4Email(enr.first_name, unsubscribeUrl);
          break;
        default:
          continue;
      }

      const claimed = await store.claimDripCourseStep(env.DB, enr.id, enr.steps_sent || "[]", step);
      if (!claimed) continue;
      claimedStep = true;

      const underCap = await checkAndCountDripCourseSend(env.DB, cap);
      if (!underCap) {
        await store.unclaimDripCourseStep(env.DB, enr.id, step);
        summary.errors.push({ enrollment_id: enr.id, error: "daily send cap reached -- halting further sends today." });
        break;
      }

      const ok = await send(enr.email, built);
      if (ok) {
        summary.sent += 1;
      } else {
        await store.unclaimDripCourseStep(env.DB, enr.id, step);
        summary.errors.push({ enrollment_id: enr.id, error: "send returned false" });
      }
    } catch (err) {
      if (claimedStep) {
        await store.unclaimDripCourseStep(env.DB, enr.id, step).catch(() => {});
      }
      summary.errors.push({ enrollment_id: enr.id, error: `unexpected error: ${String(err)}` });
    }
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Rule-change alerts (2026-08-08, roadmap #9/#319). Same daily-cron trigger,
// own independent pass -- see index.ts's scheduled(). Proactively alerts a
// firm's admin when a new rule-change event touches a state their roster is
// actually licensed in, wiring the existing reg_change_events.json feed
// together with the existing send/suppression machinery. Deliberately does
// NOT notify staff itself -- see buildRuleChangeAdminAlertEmail()'s own
// comment for why that stays the admin's own choice via the existing
// button.
// ---------------------------------------------------------------------------

export interface RuleChangeEvent {
  event_id: string;
  jurisdiction_slug: string;
  jurisdiction: string;
  topic?: string;
  effective_date: string;
  summary_public?: string;
  citation?: string;
  citation_url?: string;
  kind: string;
  upcoming: boolean;
  // AuditLab ALERT-1 (MEDIUM, 2026-08-09): these two exist specifically to
  // mark an event as not-yet-trustworthy, and upcomingRuleChangeEvents()
  // below didn't read either -- today's safety against emailing a
  // not-yet-real change was an accident of `upcoming` timing, not an
  // actual check. See that function's own comment.
  status?: string;
  needs_reverification?: boolean;
  confidence?: string;
}
const RULE_CHANGE_EVENTS = (regChangeEventsData as unknown as { events: RuleChangeEvent[] }).events;

// Same filter generate.py's own DR_RULE_CHANGE_EVENTS construction and
// build_rule_changes_page() both use, PLUS two conditions those pages
// don't need (their own reader can weigh a caveat visually; this filter's
// output goes straight into an email asserting the change as fact) --
// AuditLab ALERT-1: `kind`/`upcoming`/`effective_date` alone let a future
// event flagged needs_reverification=true through (Louisiana qualified on
// every axis except the calendar), and let a PROPOSED rule (frequently
// doesn't pass) through the moment it got a future effective_date, since
// `status` was never compared to ENACTED. A false positive here is worse
// than a missed alert -- it triggers the admin's own "notify staff"
// follow-up, propagating one wrong event to a whole roster. Exported as
// its own pure function (rather than inlined into the .filter() call) so
// it's unit-testable against synthetic events -- no currently-live event
// combines needs_reverification=true or a non-ENACTED status with
// upcoming=true, so a live-data test alone couldn't prove this closes the
// gap it's meant to.
export function isEmailableRuleChangeEvent(e: RuleChangeEvent): boolean {
  return e.kind === "rule_change" && e.upcoming && Boolean(e.effective_date) && e.status === "ENACTED" && !e.needs_reverification;
}

function upcomingRuleChangeEvents(): RuleChangeEvent[] {
  return RULE_CHANGE_EVENTS.filter(isEmailableRuleChangeEvent);
}

export interface RuleChangeAlertSummary {
  eventsChecked: number;
  firmsChecked: number;
  sent: number;
  errors: { firm_id: string; event_id: string; error: string }[];
}

function dailyRuleChangeAlertSendCap(env: Env): number {
  return resolveDailySendCap(env.RULE_CHANGE_ALERT_DAILY_SEND_CAP, DEFAULT_DAILY_RULE_CHANGE_ALERT_SEND_CAP);
}

export async function runRuleChangeAlertPass(env: Env, opts: RunReminderOptions = {}): Promise<RuleChangeAlertSummary> {
  const send: ReminderSendFn =
    opts.send ??
    ((to, built) => {
      if (!env.SENDGRID_API_KEY) return Promise.resolve(false);
      return sendViaSendGrid(env.SENDGRID_API_KEY, to, built, env.EMAIL_ALLOWLIST);
    });

  const summary: RuleChangeAlertSummary = { eventsChecked: 0, firmsChecked: 0, sent: 0, errors: [] };
  const cap = dailyRuleChangeAlertSendCap(env);
  const staticBase = staticSiteAbsoluteBaseUrl(env);
  const calendarUrl = `${staticBase}/firm-dashboard/#calendar`;
  const accountSettingsUrl = `${staticBase}/firm-dashboard/#account`;

  let capReached = false;
  for (const event of upcomingRuleChangeEvents()) {
    if (capReached) break;
    summary.eventsChecked += 1;
    const stateName = stateNameForSlug(event.jurisdiction_slug) ?? event.jurisdiction;
    const firms = await store.findFirmsEligibleForRuleChangeAlert(env.DB, event.jurisdiction_slug, event.event_id, 200);

    for (const firm of firms) {
      summary.firmsChecked += 1;
      // AuditLab DEMO-5's own reasoning, same as runReminderPass()'s
      // identical check above: the shared public demo account's roster is
      // deliberately still mutable, so it could otherwise be structurally
      // eligible here too. Checked BEFORE claiming (no DB write) and
      // WITHOUT claiming -- claiming would mark this event as "handled"
      // for the demo firm when nothing was actually sent, silently
      // breaking a future real send once the account is unlocked.
      if (firm.demo_locked) {
        summary.errors.push({
          firm_id: firm.id,
          event_id: event.event_id,
          error: "SKIPPED: firm is demo_locked -- no email sent from the shared demo account.",
        });
        continue;
      }
      // AuditLab ALERT-2 (LOW-MED, 2026-08-09): permanent suppression is
      // the one signal that means "stop emailing me" globally --
      // runReminderPass() already refuses on it ("BLOCKED: email is
      // permanently suppressed"); this pass didn't. Same before-claim,
      // no-DB-write placement as the demo_locked check above.
      if (await store.isPermanentlySuppressed(env.DB, firm.admin_email)) {
        summary.errors.push({
          firm_id: firm.id,
          event_id: event.event_id,
          error: "BLOCKED: admin_email is permanently suppressed -- refusing despite an active account.",
        });
        continue;
      }
      let claimed = false;
      try {
        claimed = await store.claimRuleChangeNotification(env.DB, firm.id, event.event_id);
        if (!claimed) continue;

        const underCap = await checkAndCountRuleChangeAlertSend(env.DB, cap);
        if (!underCap) {
          await store.unclaimRuleChangeNotification(env.DB, firm.id, event.event_id);
          summary.errors.push({
            firm_id: firm.id,
            event_id: event.event_id,
            error: "daily send cap reached -- halting further sends today.",
          });
          capReached = true;
          break;
        }

        const built = buildRuleChangeAdminAlertEmail(
          firm.name,
          event.jurisdiction,
          stateName,
          event.summary_public || "",
          fmtDate(new Date(`${event.effective_date}T00:00:00Z`)),
          event.citation_url && event.citation_url.startsWith("https://") ? event.citation_url : null,
          calendarUrl,
          accountSettingsUrl,
          adminUnsubscribeUrl(env, firm.admin_unsubscribe_token, "rule-change"),
          event.confidence || "unverified"
        );

        const ok = await send(firm.admin_email, built);
        if (ok) {
          summary.sent += 1;
        } else {
          await store.unclaimRuleChangeNotification(env.DB, firm.id, event.event_id);
          summary.errors.push({ firm_id: firm.id, event_id: event.event_id, error: "send returned false" });
        }
      } catch (err) {
        if (claimed) {
          await store.unclaimRuleChangeNotification(env.DB, firm.id, event.event_id).catch(() => {});
        }
        summary.errors.push({ firm_id: firm.id, event_id: event.event_id, error: `unexpected error: ${String(err)}` });
      }
    }
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Digest mode (2026-08-08, roadmap #24). Same daily-cron trigger, own
// independent pass -- see index.ts's scheduled(). A per-subscriber delivery-
// cadence preference (store.NOTIFICATION_MODE_DIGEST) that bundles every
// currently-due item for a person -- who can own several `subscribers` rows,
// one per state/license tracked -- into ONE weekly email instead of
// runReminderPass()'s one-per-threshold sends (that pass excludes digest-mode
// rows entirely -- see its own notification_mode check above). Replays that
// same per-row deadline/threshold-resolution/claim body verbatim per row
// below; digest mode only changes WHEN a claimed item's email goes out, never
// the escalation machinery itself. Gated on a rolling +7-day window
// (digest_next_send_at) rather than a fixed day-of-week -- advanced only on
// an actual send, so a quiet week (nothing due) never fires an empty
// "nothing to report" email and a due item arriving mid-window simply waits,
// unclaimed, for the window to reopen and bundle with whatever else is due
// by then.
// ---------------------------------------------------------------------------

export interface DigestSummary {
  emailsChecked: number;
  itemsClaimed: number;
  digestsSent: number;
  errors: { email: string; error: string }[];
}

const DIGEST_WINDOW_DAYS = 7;
const DIGEST_ELIGIBLE_EMAIL_BATCH_SIZE = 200;

function dailyDigestSendCap(env: Env): number {
  return resolveDailySendCap(env.DIGEST_DAILY_SEND_CAP, DEFAULT_DAILY_DIGEST_SEND_CAP);
}

export async function runDigestPass(env: Env, opts: RunReminderOptions = {}): Promise<DigestSummary> {
  const asOf = opts.asOf ?? new Date();
  // Same real-vs-simulated freshness split as runReminderPass() above.
  const freshnessToday = opts.asOf ? new Date() : asOf;
  checkDataFreshness(freshnessToday);
  const asOfDay = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()));
  const todayIso = asOfDay.toISOString().slice(0, 10);

  const send: ReminderSendFn =
    opts.send ??
    ((to, built) => {
      if (!env.SENDGRID_API_KEY) return Promise.resolve(false);
      return sendViaSendGrid(env.SENDGRID_API_KEY, to, built, env.EMAIL_ALLOWLIST);
    });

  const firmsById = new Map((await store.listAllFirmsBasicInfo(env.DB)).map((f) => [f.id, f]));
  const cap = dailyDigestSendCap(env);
  const staticBase = staticSiteAbsoluteBaseUrl(env);
  const manageUrl = `${staticBase}/my/`;

  const summary: DigestSummary = { emailsChecked: 0, itemsClaimed: 0, digestsSent: 0, errors: [] };

  const emails = await store.listDigestEligibleEmails(env.DB, DIGEST_ELIGIBLE_EMAIL_BATCH_SIZE);

  let capReached = false;
  for (const emailNormalized of emails) {
    if (capReached) break;
    summary.emailsChecked += 1;

    const rows = await store.listSubscriberLicenses(env.DB, emailNormalized);
    // Same value on every row sharing this email -- advanceDigestWindow()
    // writes it across all of them unconditionally. AuditLab DIGEST-1: this
    // no longer gates WHICH emails get examined (listDigestEligibleEmails()
    // returns all digest-mode confirmed emails now); it only gates whether
    // a NON-urgent item waits below.
    const digestNextSendAt = rows[0]?.digest_next_send_at ?? null;
    const windowOpen = !digestNextSendAt || digestNextSendAt <= todayIso;
    const items: DigestItem[] = [];
    const claimedRows: { sub: store.SubscriberRow; threshold: number }[] = [];
    let firstName: string | null = null;

    try {
      for (const sub of rows) {
        // Defense-in-depth, same posture as allConfirmedActive()'s own
        // status filter for the immediate pass -- listSubscriberLicenses()
        // includes non-removed stopped/pending rows too, which must never
        // reach threshold evaluation.
        if (sub.status !== store.STATUS_CONFIRMED) continue;
        // A person's rows can straddle both modes mid-transition (a mode
        // change writes across every row sharing the email, but a row
        // added between that write and this pass could theoretically
        // differ) -- only digest-mode rows belong in this bundle; any
        // immediate-mode row was already handled by runReminderPass().
        if (sub.notification_mode !== store.NOTIFICATION_MODE_DIGEST) continue;
        if (sub.snoozed_until && sub.snoozed_until >= todayIso) continue;
        if (!firstName && sub.first_name) firstName = sub.first_name;

        let deadline: Date | null;
        let fields: Record<string, string>;
        try {
          fields = JSON.parse(sub.deadline_fields || "{}");
          deadline =
            sub.deadline_source === store.DEADLINE_SOURCE_USER && sub.user_deadline
              ? new Date(`${sub.user_deadline}T00:00:00Z`)
              : computeSubscriberDeadline(sub.state_slug, fields, asOf);
        } catch (err) {
          summary.errors.push({ email: emailNormalized, error: `subscriber ${sub.id}: ${String(err)}` });
          continue;
        }
        if (deadline === null) continue;
        const stateName = stateNameForSlug(sub.state_slug);
        if (stateName === null) continue;

        const daysRemaining = Math.round((deadline.getTime() - asOfDay.getTime()) / MS_PER_DAY);
        let alreadySent: number[];
        try {
          alreadySent = JSON.parse(sub.reminders_sent || "[]");
        } catch {
          alreadySent = [];
        }
        const neverNotified = alreadySent.length === 0;

        // AuditLab DEMO-5's own reasoning, same as runReminderPass()'s
        // identical check -- checked before claiming, without claiming.
        const firmInfo = sub.firm_id ? firmsById.get(sub.firm_id) ?? null : null;
        if (firmInfo?.demo_locked) continue;

        let thresholds: number[] = ESCALATION_THRESHOLDS_DAYS;
        if (firmInfo?.reminder_thresholds) {
          try {
            const parsed = JSON.parse(firmInfo.reminder_thresholds);
            if (Array.isArray(parsed) && parsed.length > 0) thresholds = parsed;
          } catch {
            // Same fall-through posture as runReminderPass() above.
          }
        }
        if (sub.reminder_thresholds) {
          try {
            const parsed = JSON.parse(sub.reminder_thresholds);
            if (Array.isArray(parsed) && parsed.length > 0) thresholds = parsed;
          } catch {
            // Same fall-through posture as runReminderPass() above.
          }
        }

        let threshold: number | null;
        if (daysRemaining < -GRACE_PERIOD_PAST_DEADLINE_DAYS) {
          if (neverNotified && daysRemaining >= -NEVER_NOTIFIED_CATCHUP_WINDOW_DAYS) {
            threshold = Math.min(...thresholds);
          } else {
            continue;
          }
        } else {
          threshold = nextDueThreshold(daysRemaining, alreadySent, thresholds);
          if (threshold === null) continue;
        }

        // Same defense-in-depth re-check as runReminderPass() above.
        if (await store.isPermanentlySuppressed(env.DB, sub.email)) continue;

        // Claimed BEFORE this row's item is added to the batch -- same
        // atomic-claim-before-any-side-effect posture as runReminderPass().
        // A lost race here just means this row's item isn't in TODAY's
        // digest; it stays claimed by whichever pass won, exactly as
        // intended.
        const claimed = await store.claimReminderThreshold(env.DB, sub.id, sub.reminders_sent || "[]", threshold);
        if (!claimed) continue;
        claimedRows.push({ sub, threshold });
        summary.itemsClaimed += 1;

        const unsubscribeUrl = `${actionBaseUrl(env)}/unsubscribe?token=${encodeURIComponent(sub.unsubscribe_token)}`;
        items.push({
          stateName,
          deadlineDateStr: fmtDate(deadline),
          threshold,
          daysRemaining,
          rowUnsubscribeUrl: unsubscribeUrl,
        });
      }

      // Nothing due for this person this pass -- leave digest_next_send_at
      // untouched (whether NULL or already in the future) and retry next
      // pass. No claim was taken above, so there's nothing to revert.
      if (items.length === 0) continue;

      // AuditLab DIGEST-2 (2026-08-09, fixed 2026-08-13): items arrive in
      // whatever order store.listSubscriberLicenses() returns its rows --
      // ORDER BY state_slug ASC, i.e. alphabetical, not urgency.
      // buildDigestEmail() itself just renders items in the order given
      // (verified: it doesn't sort), so an unsorted caller means a digest
      // subject "N renewals need attention" lists a 28-day-out Alabama
      // item above a 2-day-out Wyoming one, every week, for as long as
      // both stay open -- the one signal this bundle carries (what to do
      // first) was encoding the alphabet instead. Sorted here, once, right
      // after the collection loop finishes, rather than inside
      // buildDigestEmail() itself -- keeps the builder a pure renderer and
      // leaves listSubscriberLicenses()'s own ORDER BY untouched for its
      // other callers.
      items.sort((a, b) => a.daysRemaining - b.daysRemaining);

      // AuditLab DIGEST-1: the window is still closed and nothing claimed
      // this pass is urgent enough to bypass it -- release the claims so a
      // later pass (window reopening, or one of these items escalating to
      // an urgent tier) re-evaluates them fresh. Same "no send happened,
      // nothing to revert but the claims themselves" posture as the
      // cap-reached and send-failed paths below.
      const hasUrgentItem = items.some((item) => item.threshold <= DIGEST_URGENT_BYPASS_THRESHOLD_DAYS);
      if (!windowOpen && !hasUrgentItem) {
        for (const { sub, threshold } of claimedRows) {
          await store.unclaimReminderThreshold(env.DB, sub.id, threshold);
        }
        continue;
      }

      // Circuit breaker right before the send, same "claims above this
      // point are cheap to lose, the send itself is not" placement as
      // runReminderPass().
      const underCap = await checkAndCountDigestSend(env.DB, cap);
      if (!underCap) {
        for (const { sub, threshold } of claimedRows) {
          await store.unclaimReminderThreshold(env.DB, sub.id, threshold);
        }
        summary.errors.push({ email: emailNormalized, error: "daily send cap reached -- halting further sends today." });
        capReached = true;
        break;
      }

      // AuditLab UNSUB-3: any of this email's own subscriber rows' tokens
      // resolves to the same email in digestUnsubscribeByToken() -- reusing
      // one of claimedRows' (guaranteed non-empty here, items.length > 0
      // above and the two arrays are pushed in lockstep) rather than
      // minting anything new.
      const firstClaimedRow = claimedRows[0];
      if (!firstClaimedRow) {
        throw new Error("buildDigestEmail: claimedRows must be non-empty when items is non-empty");
      }
      const digestUnsubscribeUrl = `${actionBaseUrl(env)}/unsubscribe/digest?token=${encodeURIComponent(firstClaimedRow.sub.unsubscribe_token)}`;
      const built = buildDigestEmail(items, manageUrl, digestUnsubscribeUrl, firstName);
      const ok = await send(emailNormalized, built);
      if (ok) {
        summary.digestsSent += 1;
        const nextSendAt = new Date(asOfDay.getTime() + DIGEST_WINDOW_DAYS * MS_PER_DAY).toISOString().slice(0, 10);
        await store.advanceDigestWindow(env.DB, emailNormalized, nextSendAt);
      } else {
        for (const { sub, threshold } of claimedRows) {
          await store.unclaimReminderThreshold(env.DB, sub.id, threshold);
        }
        summary.errors.push({ email: emailNormalized, error: "send returned false" });
      }
    } catch (err) {
      for (const { sub, threshold } of claimedRows) {
        await store.unclaimReminderThreshold(env.DB, sub.id, threshold).catch(() => {});
      }
      summary.errors.push({ email: emailNormalized, error: `unexpected error: ${String(err)}` });
    }
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Slack alerts (2026-08-08, roadmap #20). Same daily-cron trigger, own
// independent pass -- see index.ts's scheduled(). Firm-centric (only firms
// with slack_webhook_url set), unlike runReminderPass()/runDigestPass()
// above which iterate subscribers first: one daily digest per firm bundling
// every newly-due reminder threshold across its OWN roster, never one
// message per threshold (which would flood a shared channel). Reuses the
// SAME per-row deadline/threshold-resolution body those two passes already
// use, and the firm's own reminder_thresholds setting -- no new threshold
// logic. Dedup is INDEPENDENT of reminders_sent (migration 0052's own
// docstring) via claimSlackThresholdNotification(), so the email and Slack
// channels can never starve each other.
// ---------------------------------------------------------------------------

export interface SlackAlertSummary {
  firmsChecked: number;
  itemsClaimed: number;
  digestsSent: number;
  errors: { firm_id: string; error: string }[];
}

interface SlackDigestItem {
  stateName: string;
  deadlineDateStr: string;
  daysRemaining: number;
}

export interface RunSlackAlertOptions {
  asOf?: Date;
  /** Injected for tests -- defaults to the real Slack webhook POST. Takes a
   * plain message string, not a BuiltEmail -- deliberately its own shape,
   * not ReminderSendFn, since Slack has nothing resembling a subject/HTML
   * body. */
  send?: (webhookUrl: string, text: string) => Promise<boolean>;
}

function dailySlackAlertSendCap(env: Env): number {
  return resolveDailySendCap(env.SLACK_ALERT_DAILY_SEND_CAP, DEFAULT_DAILY_SLACK_ALERT_SEND_CAP);
}

function daysPhraseForSlack(actual: number): string {
  if (actual > 0) return `in ${actual} day${actual !== 1 ? "s" : ""}`;
  if (actual === 0) return "today";
  return `${-actual} day${actual !== -1 ? "s" : ""} ago`;
}

/** Plain-text Slack message (Slack's own light "mrkdwn" -- `*bold*`, not
 * full Markdown). No links/citations here unlike the email builders in
 * emails.ts -- this is a heads-up, not the determination itself; staff
 * still go to the dashboard or their email for the full reminder. */
function buildSlackDigestText(firmName: string, items: SlackDigestItem[]): string {
  const count = items.length;
  const header =
    count === 1
      ? `*Deadline-Radar: 1 renewal newly due for ${firmName}*`
      : `*Deadline-Radar: ${count} renewals newly due for ${firmName}*`;
  const lines = items.map((it) => `• ${it.stateName}: due ${it.deadlineDateStr} (${daysPhraseForSlack(it.daysRemaining)})`);
  return `${header}\n${lines.join("\n")}`;
}

export async function runSlackAlertPass(env: Env, opts: RunSlackAlertOptions = {}): Promise<SlackAlertSummary> {
  const asOf = opts.asOf ?? new Date();
  // Same real-vs-simulated freshness split as runReminderPass()/
  // runDigestPass() above -- this pass computes deadlines the same way.
  const freshnessToday = opts.asOf ? new Date() : asOf;
  checkDataFreshness(freshnessToday);
  const asOfDay = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()));
  const todayIso = asOfDay.toISOString().slice(0, 10);

  const send = opts.send ?? sendToSlack;
  const cap = dailySlackAlertSendCap(env);

  const summary: SlackAlertSummary = { firmsChecked: 0, itemsClaimed: 0, digestsSent: 0, errors: [] };

  const firms = await store.listFirmsWithSlackConnected(env.DB);

  let capReached = false;
  for (const firm of firms) {
    if (capReached) break;
    summary.firmsChecked += 1;

    // AuditLab DEMO-5's own reasoning, same as every other pass's identical
    // check -- checked before any claiming, without claiming.
    if (firm.demo_locked) {
      summary.errors.push({ firm_id: firm.id, error: "SKIPPED: firm is demo_locked -- no Slack post from the shared demo account." });
      continue;
    }

    // Roadmap #151 Phase 3 (2026-08-10): layer 2 of the multi-channel gate
    // -- handleFirmSlackConnectCallback() (index.ts) already stops a NEW
    // post-cutover free firm from connecting, but downgrading AFTER
    // connecting (customer.subscription.deleted) never clears
    // slack_webhook_url on its own, so this send-time check is what
    // actually closes that gap. Skip, don't error -- same posture as the
    // demo_locked check just above.
    if (!hasValueLineAccess(firm)) {
      summary.errors.push({ firm_id: firm.id, error: "SKIPPED: firm no longer has value-line access to multi-channel alerts (downgraded since connecting)." });
      continue;
    }

    let thresholds: number[] = ESCALATION_THRESHOLDS_DAYS;
    if (firm.reminder_thresholds) {
      try {
        const parsed = JSON.parse(firm.reminder_thresholds);
        if (Array.isArray(parsed) && parsed.length > 0) thresholds = parsed;
      } catch {
        // Same fall-through posture as runReminderPass() above.
      }
    }

    const roster = await store.listFirmLicenses(env.DB, firm.id);
    const items: SlackDigestItem[] = [];
    const claimed: { subscriberId: string; threshold: number }[] = [];

    try {
      for (const sub of roster) {
        if (sub.status !== store.STATUS_CONFIRMED) continue;
        if (sub.snoozed_until && sub.snoozed_until >= todayIso) continue;

        let deadline: Date | null;
        let fields: Record<string, string>;
        try {
          fields = JSON.parse(sub.deadline_fields || "{}");
          deadline =
            sub.deadline_source === store.DEADLINE_SOURCE_USER && sub.user_deadline
              ? new Date(`${sub.user_deadline}T00:00:00Z`)
              : computeSubscriberDeadline(sub.state_slug, fields, asOf);
        } catch (err) {
          summary.errors.push({ firm_id: firm.id, error: `subscriber ${sub.id}: ${String(err)}` });
          continue;
        }
        if (deadline === null) continue;
        const stateName = stateNameForSlug(sub.state_slug);
        if (stateName === null) continue;

        const daysRemaining = Math.round((deadline.getTime() - asOfDay.getTime()) / MS_PER_DAY);
        // Deliberately NOT sub.reminders_sent -- that's the EMAIL claim
        // history. This pass's own escalation-ordering (nextDueThreshold()
        // below) must be independent of it, or a threshold already claimed
        // by email would silently suppress its own separate Slack
        // notification -- exactly the coupling migration 0052's docstring
        // says must never happen. listSlackNotifiedThresholds() reads
        // firm_slack_notified_thresholds instead.
        const alreadySent = await store.listSlackNotifiedThresholds(env.DB, sub.id);
        const neverNotified = alreadySent.length === 0;

        // Same subscriber-level override as runReminderPass()/runDigestPass()
        // -- "my own communication preferences" wins over the firm's default.
        let effectiveThresholds = thresholds;
        if (sub.reminder_thresholds) {
          try {
            const parsed = JSON.parse(sub.reminder_thresholds);
            if (Array.isArray(parsed) && parsed.length > 0) effectiveThresholds = parsed;
          } catch {
            // Same fall-through posture as above.
          }
        }

        let threshold: number | null;
        if (daysRemaining < -GRACE_PERIOD_PAST_DEADLINE_DAYS) {
          if (neverNotified && daysRemaining >= -NEVER_NOTIFIED_CATCHUP_WINDOW_DAYS) {
            threshold = Math.min(...effectiveThresholds);
          } else {
            continue;
          }
        } else {
          threshold = nextDueThreshold(daysRemaining, alreadySent, effectiveThresholds);
          if (threshold === null) continue;
        }

        // Independent of claimReminderThreshold()/reminders_sent -- see
        // migration 0052's own docstring for why the two channels must
        // never starve each other. A lost race here just means this item
        // isn't in TODAY's Slack digest; already-claimed-by-a-concurrent-
        // pass is not an error.
        const wasClaimed = await store.claimSlackThresholdNotification(env.DB, sub.id, threshold);
        if (!wasClaimed) continue;
        claimed.push({ subscriberId: sub.id, threshold });
        summary.itemsClaimed += 1;
        items.push({ stateName, deadlineDateStr: fmtDate(deadline), daysRemaining });
      }

      // Nothing newly due for this firm -- no message, same "no filler"
      // posture as runDigestPass() above. Nothing was claimed above, so
      // there's nothing to revert.
      if (items.length === 0) continue;

      const underCap = await checkAndCountSlackAlertSend(env.DB, cap);
      if (!underCap) {
        for (const { subscriberId, threshold } of claimed) {
          await store.unclaimSlackThresholdNotification(env.DB, subscriberId, threshold);
        }
        summary.errors.push({ firm_id: firm.id, error: "daily send cap reached -- halting further sends today." });
        capReached = true;
        break;
      }

      // AuditLab SLACK-1: decrypt right before use -- never held in a
      // wider-scoped variable than this. A decrypt failure (missing
      // TOTP_ENCRYPTION_KEY, tampered ciphertext, or a pre-migration-0056
      // plaintext value that no longer parses as ciphertext) fails closed
      // exactly like a failed send -- claims are released, retried next
      // pass once/if the key is restored.
      const webhookUrl = firm.slack_webhook_url_iv && env.TOTP_ENCRYPTION_KEY
        ? await decryptSecretAesGcm(firm.slack_webhook_url, firm.slack_webhook_url_iv, firm.id, env.TOTP_ENCRYPTION_KEY)
        : null;
      const text = buildSlackDigestText(firm.name, items);
      const ok = webhookUrl ? await send(webhookUrl, text) : false;
      if (ok) {
        summary.digestsSent += 1;
      } else {
        for (const { subscriberId, threshold } of claimed) {
          await store.unclaimSlackThresholdNotification(env.DB, subscriberId, threshold);
        }
        summary.errors.push({ firm_id: firm.id, error: webhookUrl ? "send returned false" : "failed to decrypt webhook URL" });
      }
    } catch (err) {
      for (const { subscriberId, threshold } of claimed) {
        await store.unclaimSlackThresholdNotification(env.DB, subscriberId, threshold).catch(() => {});
      }
      summary.errors.push({ firm_id: firm.id, error: `unexpected error: ${String(err)}` });
    }
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Microsoft Teams alerts (2026-08-08, roadmap #21). Near-identical
// structure to runSlackAlertPass() above -- same firm-centric daily digest,
// same per-row threshold-resolution body reused from runReminderPass(),
// same "own dedup table, independent of reminders_sent AND
// firm_slack_notified_thresholds" posture (migration 0053's own docstring).
// Kept as its own separate function rather than sharing one with the Slack
// pass, matching this codebase's own established "one function per
// channel" precedent (drip course/rule-change/digest/Slack are all
// separate top-level passes, never unified into one generic notification
// engine). Real differences from runSlackAlertPass(): source table
// (listFirmsWithTeamsConnected), dedup table (firm_teams_notified_thresholds),
// send counter (teams_alert_send_counters), and the send function
// (sendToTeams) -- no OAuth/access-token concern at all, see teams.ts's
// own docstring for why.
// ---------------------------------------------------------------------------

export interface TeamsAlertSummary {
  firmsChecked: number;
  itemsClaimed: number;
  digestsSent: number;
  errors: { firm_id: string; error: string }[];
}

export interface RunTeamsAlertOptions {
  asOf?: Date;
  /** Injected for tests -- defaults to the real Teams webhook POST. Same
   * plain-message-string shape as RunSlackAlertOptions.send, not
   * ReminderSendFn. */
  send?: (webhookUrl: string, text: string) => Promise<boolean>;
}

function dailyTeamsAlertSendCap(env: Env): number {
  return resolveDailySendCap(env.TEAMS_ALERT_DAILY_SEND_CAP, DEFAULT_DAILY_TEAMS_ALERT_SEND_CAP);
}

/** Same digest-text shape as buildSlackDigestText() above -- Teams'
 * confirmed-minimal payload ({"text": "..."}) accepts the identical plain
 * message, no Adaptive Card envelope required (teams.ts's own docstring). */
function buildTeamsDigestText(firmName: string, items: SlackDigestItem[]): string {
  const count = items.length;
  const header =
    count === 1
      ? `Deadline-Radar: 1 renewal newly due for ${firmName}`
      : `Deadline-Radar: ${count} renewals newly due for ${firmName}`;
  const lines = items.map((it) => `- ${it.stateName}: due ${it.deadlineDateStr} (${daysPhraseForSlack(it.daysRemaining)})`);
  return `${header}\n${lines.join("\n")}`;
}

export async function runTeamsAlertPass(env: Env, opts: RunTeamsAlertOptions = {}): Promise<TeamsAlertSummary> {
  const asOf = opts.asOf ?? new Date();
  const freshnessToday = opts.asOf ? new Date() : asOf;
  checkDataFreshness(freshnessToday);
  const asOfDay = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()));
  const todayIso = asOfDay.toISOString().slice(0, 10);

  const send = opts.send ?? sendToTeams;
  const cap = dailyTeamsAlertSendCap(env);

  const summary: TeamsAlertSummary = { firmsChecked: 0, itemsClaimed: 0, digestsSent: 0, errors: [] };

  const firms = await store.listFirmsWithTeamsConnected(env.DB);

  let capReached = false;
  for (const firm of firms) {
    if (capReached) break;
    summary.firmsChecked += 1;

    if (firm.demo_locked) {
      summary.errors.push({ firm_id: firm.id, error: "SKIPPED: firm is demo_locked -- no Teams post from the shared demo account." });
      continue;
    }

    // Roadmap #151 Phase 3 (2026-08-10): same layer-2 gate as
    // runSlackAlertPass() above -- see its own comment.
    if (!hasValueLineAccess(firm)) {
      summary.errors.push({ firm_id: firm.id, error: "SKIPPED: firm no longer has value-line access to multi-channel alerts (downgraded since connecting)." });
      continue;
    }

    let thresholds: number[] = ESCALATION_THRESHOLDS_DAYS;
    if (firm.reminder_thresholds) {
      try {
        const parsed = JSON.parse(firm.reminder_thresholds);
        if (Array.isArray(parsed) && parsed.length > 0) thresholds = parsed;
      } catch {
        // Same fall-through posture as runReminderPass() above.
      }
    }

    const roster = await store.listFirmLicenses(env.DB, firm.id);
    const items: SlackDigestItem[] = [];
    const claimed: { subscriberId: string; threshold: number }[] = [];

    try {
      for (const sub of roster) {
        if (sub.status !== store.STATUS_CONFIRMED) continue;
        if (sub.snoozed_until && sub.snoozed_until >= todayIso) continue;

        let deadline: Date | null;
        let fields: Record<string, string>;
        try {
          fields = JSON.parse(sub.deadline_fields || "{}");
          deadline =
            sub.deadline_source === store.DEADLINE_SOURCE_USER && sub.user_deadline
              ? new Date(`${sub.user_deadline}T00:00:00Z`)
              : computeSubscriberDeadline(sub.state_slug, fields, asOf);
        } catch (err) {
          summary.errors.push({ firm_id: firm.id, error: `subscriber ${sub.id}: ${String(err)}` });
          continue;
        }
        if (deadline === null) continue;
        const stateName = stateNameForSlug(sub.state_slug);
        if (stateName === null) continue;

        const daysRemaining = Math.round((deadline.getTime() - asOfDay.getTime()) / MS_PER_DAY);
        // Deliberately NOT sub.reminders_sent -- same independence
        // reasoning as runSlackAlertPass() above, but from Teams' own
        // dedup table instead of Slack's.
        const alreadySent = await store.listTeamsNotifiedThresholds(env.DB, sub.id);
        const neverNotified = alreadySent.length === 0;

        let effectiveThresholds = thresholds;
        if (sub.reminder_thresholds) {
          try {
            const parsed = JSON.parse(sub.reminder_thresholds);
            if (Array.isArray(parsed) && parsed.length > 0) effectiveThresholds = parsed;
          } catch {
            // Same fall-through posture as above.
          }
        }

        let threshold: number | null;
        if (daysRemaining < -GRACE_PERIOD_PAST_DEADLINE_DAYS) {
          if (neverNotified && daysRemaining >= -NEVER_NOTIFIED_CATCHUP_WINDOW_DAYS) {
            threshold = Math.min(...effectiveThresholds);
          } else {
            continue;
          }
        } else {
          threshold = nextDueThreshold(daysRemaining, alreadySent, effectiveThresholds);
          if (threshold === null) continue;
        }

        const wasClaimed = await store.claimTeamsThresholdNotification(env.DB, sub.id, threshold);
        if (!wasClaimed) continue;
        claimed.push({ subscriberId: sub.id, threshold });
        summary.itemsClaimed += 1;
        items.push({ stateName, deadlineDateStr: fmtDate(deadline), daysRemaining });
      }

      if (items.length === 0) continue;

      const underCap = await checkAndCountTeamsAlertSend(env.DB, cap);
      if (!underCap) {
        for (const { subscriberId, threshold } of claimed) {
          await store.unclaimTeamsThresholdNotification(env.DB, subscriberId, threshold);
        }
        summary.errors.push({ firm_id: firm.id, error: "daily send cap reached -- halting further sends today." });
        capReached = true;
        break;
      }

      // AuditLab SLACK-1 (extends to Teams): same decrypt-right-before-use,
      // fail-closed-on-decrypt-failure posture as runSlackAlertPass() above.
      const webhookUrl = firm.teams_webhook_url_iv && env.TOTP_ENCRYPTION_KEY
        ? await decryptSecretAesGcm(firm.teams_webhook_url, firm.teams_webhook_url_iv, firm.id, env.TOTP_ENCRYPTION_KEY)
        : null;
      const text = buildTeamsDigestText(firm.name, items);
      const ok = webhookUrl ? await send(webhookUrl, text) : false;
      if (ok) {
        summary.digestsSent += 1;
      } else {
        for (const { subscriberId, threshold } of claimed) {
          await store.unclaimTeamsThresholdNotification(env.DB, subscriberId, threshold);
        }
        summary.errors.push({ firm_id: firm.id, error: webhookUrl ? "send returned false" : "failed to decrypt webhook URL" });
      }
    } catch (err) {
      for (const { subscriberId, threshold } of claimed) {
        await store.unclaimTeamsThresholdNotification(env.DB, subscriberId, threshold).catch(() => {});
      }
      summary.errors.push({ firm_id: firm.id, error: `unexpected error: ${String(err)}` });
    }
  }

  return summary;
}

// ---------------------------------------------------------------------------
// SMS alerts (2026-08-09, roadmap #22). Same daily-cron trigger, own
// independent pass. Per-SUBSCRIBER (like runReminderPass() above), not
// per-firm like Slack/Teams -- filtered to store.allSmsOptedInConfirmed().
// Reuses the identical threshold-resolution body, the firm-then-subscriber
// reminder_thresholds resolution, and the same demo_locked check, but:
//   - a quiet-hours gate (sms.ts's isWithinSmsQuietHours()) runs FIRST,
//     before any threshold work -- a subscriber outside 8am-9pm their
//     licensing state's approximate local time is skipped entirely this
//     pass, real TCPA requirement, not a style choice.
//   - dedup is via sms_notified_thresholds, INDEPENDENT of reminders_sent
//     and both Slack's/Teams' own tables -- migration 0054's own docstring.
//   - ONE text per newly-due threshold, never batched into a digest like
//     Slack/Teams -- a text is already minimal/single-purpose, batching
//     would only delay urgent per-deadline information for no benefit.
// ---------------------------------------------------------------------------

export interface SmsAlertSummary {
  checked: number;
  itemsClaimed: number;
  sent: number;
  skippedQuietHours: number;
  errors: { subscriber_id: string; error: string }[];
}

export interface RunSmsAlertOptions {
  asOf?: Date;
  /** Injected for tests -- defaults to the real Twilio send. Plain
   * (to, body) shape, not ReminderSendFn -- an SMS has no subject/HTML. */
  send?: (to: string, body: string) => Promise<boolean>;
}

function dailySmsSendCap(env: Env): number {
  return resolveDailySendCap(env.SMS_DAILY_SEND_CAP, DEFAULT_DAILY_SMS_SEND_CAP);
}

function smsBodyFor(stateName: string, deadlineStr: string, daysRemaining: number): string {
  const dp =
    daysRemaining > 0
      ? `in ${daysRemaining} day${daysRemaining !== 1 ? "s" : ""}`
      : daysRemaining === 0
        ? "today"
        : `${-daysRemaining} day${daysRemaining !== -1 ? "s" : ""} ago`;
  return `Deadline-Radar: your ${stateName} CPA renewal is due ${dp} (${deadlineStr}). Reply STOP to opt out.`;
}

export async function runSmsAlertPass(env: Env, opts: RunSmsAlertOptions = {}): Promise<SmsAlertSummary> {
  const asOf = opts.asOf ?? new Date();
  const freshnessToday = opts.asOf ? new Date() : asOf;
  checkDataFreshness(freshnessToday);
  const asOfDay = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()));
  const todayIso = asOfDay.toISOString().slice(0, 10);

  const send: (to: string, body: string) => Promise<boolean> =
    opts.send ??
    ((to, body) => {
      if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_FROM_NUMBER) return Promise.resolve(false);
      return sendSms(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN, env.TWILIO_FROM_NUMBER, to, body);
    });

  const firmsById = new Map((await store.listAllFirmsBasicInfo(env.DB)).map((f) => [f.id, f]));
  const cap = dailySmsSendCap(env);

  const summary: SmsAlertSummary = { checked: 0, itemsClaimed: 0, sent: 0, skippedQuietHours: 0, errors: [] };

  const subscribers = await store.allSmsOptedInConfirmed(env.DB);
  let capReached = false;
  for (const sub of subscribers) {
    if (capReached) break;
    summary.checked += 1;

    if (!sub.phone_number) continue; // defensive -- sms_opted_in=1 should always carry a number

    // TCPA quiet hours -- checked before ANY threshold work, same
    // "evaluated at all" gate as snoozed_until below.
    if (!isWithinSmsQuietHours(sub.state_slug, asOf)) {
      summary.skippedQuietHours += 1;
      continue;
    }

    if (sub.snoozed_until && sub.snoozed_until >= todayIso) continue;

    let deadline: Date | null;
    let fields: Record<string, string>;
    try {
      fields = JSON.parse(sub.deadline_fields || "{}");
      deadline =
        sub.deadline_source === store.DEADLINE_SOURCE_USER && sub.user_deadline
          ? new Date(`${sub.user_deadline}T00:00:00Z`)
          : computeSubscriberDeadline(sub.state_slug, fields, asOf);
    } catch (err) {
      summary.errors.push({ subscriber_id: sub.id, error: String(err) });
      continue;
    }
    if (deadline === null) continue;
    const stateName = stateNameForSlug(sub.state_slug);
    if (stateName === null) continue;

    const daysRemaining = Math.round((deadline.getTime() - asOfDay.getTime()) / MS_PER_DAY);
    // Deliberately NOT sub.reminders_sent -- same independence reasoning
    // as runSlackAlertPass()/runTeamsAlertPass() above, from SMS' own
    // dedup table instead.
    const alreadySent = await store.listSmsNotifiedThresholds(env.DB, sub.id);
    const neverNotified = alreadySent.length === 0;

    const firmInfo = sub.firm_id ? firmsById.get(sub.firm_id) ?? null : null;
    let thresholds: number[] = ESCALATION_THRESHOLDS_DAYS;
    if (firmInfo?.reminder_thresholds) {
      try {
        const parsed = JSON.parse(firmInfo.reminder_thresholds);
        if (Array.isArray(parsed) && parsed.length > 0) thresholds = parsed;
      } catch {
        // Same fall-through posture as runReminderPass() above.
      }
    }
    if (sub.reminder_thresholds) {
      try {
        const parsed = JSON.parse(sub.reminder_thresholds);
        if (Array.isArray(parsed) && parsed.length > 0) thresholds = parsed;
      } catch {
        // Same fall-through posture as above.
      }
    }

    let threshold: number | null;
    if (daysRemaining < -GRACE_PERIOD_PAST_DEADLINE_DAYS) {
      if (neverNotified && daysRemaining >= -NEVER_NOTIFIED_CATCHUP_WINDOW_DAYS) {
        threshold = Math.min(...thresholds);
      } else {
        continue;
      }
    } else {
      threshold = nextDueThreshold(daysRemaining, alreadySent, thresholds);
      if (threshold === null) continue;
    }

    let claimedThreshold = false;
    try {
      // Same AuditLab DEMO-5 reasoning as every other pass -- checked
      // before claiming, without claiming.
      if (firmInfo?.demo_locked) {
        summary.errors.push({ subscriber_id: sub.id, error: "SKIPPED: firm is demo_locked -- no SMS sent from the shared demo account." });
        continue;
      }

      // Roadmap #151 Phase 3 (2026-08-10): SAME send-time gate as Slack/
      // Teams, but ONLY for a subscriber attached to a firm -- a firm-less
      // subscriber (firmInfo === null, sub.firm_id IS NULL) has no
      // meaningful signup date or tier to gate on at all, since this
      // feature is a FIRM-tier economics lever and a standalone individual
      // subscriber isn't a firm-billing entity. SMS's own connect step
      // (phone verification) is deliberately left ungated for the same
      // reason -- this is the one and only #151 check for SMS.
      if (firmInfo && !hasValueLineAccess(firmInfo)) {
        summary.errors.push({ subscriber_id: sub.id, error: "SKIPPED: firm no longer has value-line access to multi-channel alerts (downgraded since connecting)." });
        continue;
      }

      const claimed = await store.claimSmsThresholdNotification(env.DB, sub.id, threshold);
      if (!claimed) continue;
      claimedThreshold = true;
      summary.itemsClaimed += 1;

      const underCap = await checkAndCountSmsSend(env.DB, cap);
      if (!underCap) {
        await store.unclaimSmsThresholdNotification(env.DB, sub.id, threshold);
        summary.errors.push({ subscriber_id: sub.id, error: "daily send cap reached -- halting further sends today." });
        capReached = true;
        break;
      }

      const body = smsBodyFor(stateName, fmtDate(deadline), daysRemaining);
      const ok = await send(sub.phone_number, body);
      if (ok) {
        summary.sent += 1;
      } else {
        await store.unclaimSmsThresholdNotification(env.DB, sub.id, threshold);
        summary.errors.push({ subscriber_id: sub.id, error: "send returned false" });
      }
    } catch (err) {
      if (claimedThreshold) {
        await store.unclaimSmsThresholdNotification(env.DB, sub.id, threshold).catch(() => {});
      }
      summary.errors.push({ subscriber_id: sub.id, error: `unexpected error: ${String(err)}` });
    }
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Firm-wide admin digest (2026-08-10, roadmap #151 Phase 5, "move the value
// line" -- the last of five phases). Same firm-centric daily-digest shape
// as runSlackAlertPass()/runTeamsAlertPass() (own roster scan, own
// threshold resolution, own dedup table, ONE bundled message per firm), but
// delivered by email (like runRuleChangeAlertPass()) rather than a chat
// webhook, since firm.admin_email is always known -- no "connect" step
// exists for this channel the way Slack/Teams need one. Closes the gap
// /for-firms/'s own copy names directly: "the partner who actually carries
// the regulatory risk never sees any of this -- only the individual
// licensee's own inbox gets the reminder."
// ---------------------------------------------------------------------------

export interface AdminDigestAlertSummary {
  firmsChecked: number;
  itemsClaimed: number;
  digestsSent: number;
  errors: { firm_id: string; error: string }[];
}

export interface RunAdminDigestAlertOptions {
  asOf?: Date;
  send?: ReminderSendFn;
}

function dailyAdminDigestSendCap(env: Env): number {
  return resolveDailySendCap(env.ADMIN_DIGEST_DAILY_SEND_CAP, DEFAULT_DAILY_ADMIN_DIGEST_SEND_CAP);
}

export async function runAdminDigestAlertPass(env: Env, opts: RunAdminDigestAlertOptions = {}): Promise<AdminDigestAlertSummary> {
  const asOf = opts.asOf ?? new Date();
  const freshnessToday = opts.asOf ? new Date() : asOf;
  checkDataFreshness(freshnessToday);
  const asOfDay = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()));
  const todayIso = asOfDay.toISOString().slice(0, 10);

  const send: ReminderSendFn =
    opts.send ??
    ((to, built) => {
      if (!env.SENDGRID_API_KEY) return Promise.resolve(false);
      return sendViaSendGrid(env.SENDGRID_API_KEY, to, built, env.EMAIL_ALLOWLIST);
    });
  const cap = dailyAdminDigestSendCap(env);
  const staticBase = staticSiteAbsoluteBaseUrl(env);
  const accountSettingsUrl = `${staticBase}/firm-dashboard/#account`;

  const summary: AdminDigestAlertSummary = { firmsChecked: 0, itemsClaimed: 0, digestsSent: 0, errors: [] };

  const firms = await store.listAllFirmsBasicInfo(env.DB);

  let capReached = false;
  for (const firm of firms) {
    if (capReached) break;
    // Every ACTIVE firm is a candidate (no "connect" step like Slack/Teams
    // -- admin_email always exists), so firmsChecked is meaningfully larger
    // here than the chat-channel passes'.
    if (firm.status !== "active") continue;
    summary.firmsChecked += 1;

    // Same AuditLab DEMO-5 reasoning as every other pass -- checked before
    // any claiming, without claiming.
    if (firm.demo_locked) {
      summary.errors.push({ firm_id: firm.id, error: "SKIPPED: firm is demo_locked -- no email sent from the shared demo account." });
      continue;
    }

    // Roadmap #151 Phase 5's own send-time gate -- same hasValueLineAccess()
    // check Phase 3 already uses for Slack/Teams/SMS.
    if (!hasValueLineAccess(firm)) {
      summary.errors.push({ firm_id: firm.id, error: "SKIPPED: firm no longer has value-line access to the firm-wide admin digest." });
      continue;
    }

    // Opt-out (migration 0061, on by default for an eligible firm) --
    // checked here, not folded into hasValueLineAccess(), since it's a
    // firm PREFERENCE, not an entitlement.
    if (!firm.admin_digest_enabled) continue;

    // Same AuditLab ALERT-2 reasoning as runRuleChangeAlertPass() -- the one
    // signal that means "stop emailing me" globally, checked before
    // claiming, without claiming.
    if (await store.isPermanentlySuppressed(env.DB, firm.admin_email)) {
      summary.errors.push({ firm_id: firm.id, error: "BLOCKED: admin_email is permanently suppressed -- refusing despite an active account." });
      continue;
    }

    let thresholds: number[] = ESCALATION_THRESHOLDS_DAYS;
    if (firm.reminder_thresholds) {
      try {
        const parsed = JSON.parse(firm.reminder_thresholds);
        if (Array.isArray(parsed) && parsed.length > 0) thresholds = parsed;
      } catch {
        // Same fall-through posture as runReminderPass() above.
      }
    }

    const roster = await store.listFirmLicenses(env.DB, firm.id);
    const items: AdminDigestItem[] = [];
    const claimed: { subscriberId: string; threshold: number }[] = [];

    try {
      for (const sub of roster) {
        if (sub.status !== store.STATUS_CONFIRMED) continue;
        if (sub.snoozed_until && sub.snoozed_until >= todayIso) continue;

        let deadline: Date | null;
        let fields: Record<string, string>;
        try {
          fields = JSON.parse(sub.deadline_fields || "{}");
          deadline =
            sub.deadline_source === store.DEADLINE_SOURCE_USER && sub.user_deadline
              ? new Date(`${sub.user_deadline}T00:00:00Z`)
              : computeSubscriberDeadline(sub.state_slug, fields, asOf);
        } catch (err) {
          summary.errors.push({ firm_id: firm.id, error: `subscriber ${sub.id}: ${String(err)}` });
          continue;
        }
        if (deadline === null) continue;
        const stateName = stateNameForSlug(sub.state_slug);
        if (stateName === null) continue;

        const daysRemaining = Math.round((deadline.getTime() - asOfDay.getTime()) / MS_PER_DAY);
        // Independent of reminders_sent AND every other channel's own dedup
        // table -- see migration 0061's own docstring.
        const alreadySent = await store.listAdminDigestNotifiedThresholds(env.DB, sub.id);
        const neverNotified = alreadySent.length === 0;

        let effectiveThresholds = thresholds;
        if (sub.reminder_thresholds) {
          try {
            const parsed = JSON.parse(sub.reminder_thresholds);
            if (Array.isArray(parsed) && parsed.length > 0) effectiveThresholds = parsed;
          } catch {
            // Same fall-through posture as above.
          }
        }

        let threshold: number | null;
        if (daysRemaining < -GRACE_PERIOD_PAST_DEADLINE_DAYS) {
          if (neverNotified && daysRemaining >= -NEVER_NOTIFIED_CATCHUP_WINDOW_DAYS) {
            threshold = Math.min(...effectiveThresholds);
          } else {
            continue;
          }
        } else {
          threshold = nextDueThreshold(daysRemaining, alreadySent, effectiveThresholds);
          if (threshold === null) continue;
        }

        const wasClaimed = await store.claimAdminDigestThresholdNotification(env.DB, sub.id, threshold);
        if (!wasClaimed) continue;
        claimed.push({ subscriberId: sub.id, threshold });
        summary.itemsClaimed += 1;
        items.push({ staffLabel: sub.staff_label || sub.email, stateName, daysRemaining });
      }

      // Nothing newly due for this firm -- no email, same "no filler"
      // posture as every other digest pass.
      if (items.length === 0) continue;

      const underCap = await checkAndCountAdminDigestSend(env.DB, cap);
      if (!underCap) {
        for (const { subscriberId, threshold } of claimed) {
          await store.unclaimAdminDigestThresholdNotification(env.DB, subscriberId, threshold);
        }
        summary.errors.push({ firm_id: firm.id, error: "daily send cap reached -- halting further sends today." });
        capReached = true;
        break;
      }

      const built = buildAdminDigestEmail(
        firm.name,
        items,
        accountSettingsUrl,
        adminUnsubscribeUrl(env, firm.admin_unsubscribe_token, "digest")
      );
      const ok = await send(firm.admin_email, built);
      if (ok) {
        summary.digestsSent += 1;
      } else {
        for (const { subscriberId, threshold } of claimed) {
          await store.unclaimAdminDigestThresholdNotification(env.DB, subscriberId, threshold);
        }
        summary.errors.push({ firm_id: firm.id, error: "send returned false" });
      }
    } catch (err) {
      for (const { subscriberId, threshold } of claimed) {
        await store.unclaimAdminDigestThresholdNotification(env.DB, subscriberId, threshold).catch(() => {});
      }
      summary.errors.push({ firm_id: firm.id, error: `unexpected error: ${String(err)}` });
    }
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Compliance-news newsletter (roadmap #124, 2026-08-13, Devin: "Good to
// build 2"). A NEW public list (own table, own tokens -- store.ts's
// newsletter_subscribers, migration 0066), unrelated to any subscriber's own
// renewal deadline. Same daily-cron trigger as every other independent pass
// in this file (index.ts's scheduled()), but a MONTHLY-cadence send, not a
// daily one -- gated here, inside the pass itself, on newsletter_digest_state
// (a singleton row), the same "the pass decides its own cadence, not the
// cron dispatcher" shape runDigestPass()'s per-subscriber weekly window
// already uses, just for one shared piece of content instead of N personal
// ones.
//
// Content selection reuses isEmailableRuleChangeEvent() VERBATIM -- the
// exact same safety filter (ENACTED status, not needs_reverification, has a
// real effective_date, upcoming) that already gates the firm rule-change
// admin alert. This pass adds no new judgment about which events are safe
// to assert as fact in an email; it only decides WHICH of the already-safe
// events haven't been reported yet (via last_included_event_ids) and
// whether there's enough real content to justify a send at all -- see
// buildNewsletterDigestEmail()'s own refusal to build an empty issue.
// ---------------------------------------------------------------------------

const NEWSLETTER_DIGEST_MIN_INTERVAL_DAYS = 27;
const NEWSLETTER_DIGEST_MAX_ITEMS = 12;

export interface ComplianceNewsletterSummary {
  dueForSend: boolean;
  candidateEvents: number;
  itemsIncluded: number;
  subscribersChecked: number;
  sent: number;
  errors: { subscriber_id: string; error: string }[];
  skippedReason?: string;
}

function newsletterCap(env: Env): number {
  return resolveDailySendCap(env.NEWSLETTER_DAILY_SEND_CAP, DEFAULT_DAILY_NEWSLETTER_SEND_CAP);
}

export async function runComplianceNewsletterPass(
  env: Env,
  opts: RunReminderOptions = {}
): Promise<ComplianceNewsletterSummary> {
  const send: ReminderSendFn =
    opts.send ??
    ((to, built) => {
      if (!env.SENDGRID_API_KEY) return Promise.resolve(false);
      return sendViaSendGrid(env.SENDGRID_API_KEY, to, built, env.EMAIL_ALLOWLIST);
    });
  const asOf = opts.asOf ?? new Date();

  const summary: ComplianceNewsletterSummary = {
    dueForSend: false,
    candidateEvents: 0,
    itemsIncluded: 0,
    subscribersChecked: 0,
    sent: 0,
    errors: [],
  };

  const state = await store.getNewsletterDigestState(env.DB);
  if (state.last_sent_at) {
    const daysSinceLastSend = (asOf.getTime() - new Date(state.last_sent_at).getTime()) / 86_400_000;
    if (daysSinceLastSend < NEWSLETTER_DIGEST_MIN_INTERVAL_DAYS) {
      summary.skippedReason = `not due -- last sent ${daysSinceLastSend.toFixed(1)}d ago, interval is ${NEWSLETTER_DIGEST_MIN_INTERVAL_DAYS}d`;
      return summary;
    }
  }
  summary.dueForSend = true;

  let alreadyIncluded: string[];
  try {
    const parsed: unknown = JSON.parse(state.last_included_event_ids);
    alreadyIncluded = Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    alreadyIncluded = [];
  }
  const alreadyIncludedSet = new Set(alreadyIncluded);

  const candidates = upcomingRuleChangeEvents().filter((e) => !alreadyIncludedSet.has(e.event_id));
  summary.candidateEvents = candidates.length;

  // Never manufacture filler -- a content-free month simply doesn't send,
  // and does NOT update newsletter_digest_state, so the next day's cron
  // tries again rather than waiting a further full interval for nothing.
  if (candidates.length === 0) {
    summary.skippedReason = "due, but no new emailable events since the last issue -- not sending an empty digest";
    return summary;
  }

  const sorted = [...candidates].sort((a, b) => a.effective_date.localeCompare(b.effective_date));
  const selected = sorted.slice(0, NEWSLETTER_DIGEST_MAX_ITEMS);
  const staticBase = staticSiteAbsoluteBaseUrl(env);
  const detailUrl = `${staticBase}/rule-changes/`;

  const items: NewsletterDigestItem[] = [];
  for (const e of selected) {
    // AuditLab-style discipline carried forward: a summary-less event isn't
    // publishable content even if it passed the ENACTED/not-reverification
    // filter above -- summary_public is optional on the underlying type
    // (admin alerts don't require it since the admin already sees full
    // context on the dashboard), but this digest IS the full context a
    // reader gets, so skip rather than print an empty line.
    if (!e.summary_public) continue;
    items.push({
      jurisdiction: stateNameForSlug(e.jurisdiction_slug) ?? e.jurisdiction,
      topic: e.topic ?? "practice/license rule change",
      summary: e.summary_public,
      effectiveDate: e.effective_date || null,
      citation: e.citation ?? null,
      citationUrl: e.citation_url ?? null,
      detailUrl,
    });
  }
  summary.itemsIncluded = items.length;

  if (items.length === 0) {
    summary.skippedReason = "due, had candidate events, but none had a publishable summary -- not sending";
    return summary;
  }

  const cap = newsletterCap(env);
  const subscribers = await store.listConfirmedNewsletterSubscribers(env.DB);
  summary.subscribersChecked = subscribers.length;

  let capReached = false;
  for (const subscriber of subscribers) {
    if (capReached) break;
    try {
      const underCap = await checkAndCountNewsletterSend(env.DB, cap);
      if (!underCap) {
        capReached = true;
        summary.errors.push({ subscriber_id: subscriber.id, error: "SKIPPED: daily newsletter send cap reached." });
        continue;
      }
      const unsubscribeUrl = `${actionBaseUrl(env)}/newsletter/unsubscribe?token=${encodeURIComponent(subscriber.unsubscribe_token)}`;
      const built = buildNewsletterDigestEmail(items, unsubscribeUrl);
      const ok = await send(subscriber.email, built);
      if (ok) {
        summary.sent += 1;
      } else {
        summary.errors.push({ subscriber_id: subscriber.id, error: "send returned false" });
      }
    } catch (err) {
      summary.errors.push({ subscriber_id: subscriber.id, error: `unexpected error: ${String(err)}` });
    }
  }

  // Only mark the issue "sent" if it genuinely was -- a run that hit the
  // cap partway through, or every send call failed, must not advance
  // last_sent_at/last_included_event_ids, so the next day's cron retries
  // the SAME content rather than skipping it forever.
  if (summary.sent > 0) {
    await store.recordNewsletterDigestSent(env.DB, [...alreadyIncluded, ...selected.map((e) => e.event_id)]);
  }

  return summary;
}

export { StaleDataError };
