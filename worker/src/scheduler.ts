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
import { buildReminderEmail, fmtDate } from "./emails";
import { DEFAULT_DAILY_SEND_CAP, checkAndCountSend, sendViaSendGrid } from "./sender";

// scheduler.py: store.ESCALATION_THRESHOLDS_DAYS.
export const ESCALATION_THRESHOLDS_DAYS = [1, 3, 7, 14, 30, 60];

const GRACE_PERIOD_PAST_DEADLINE_DAYS = 3;
const NEVER_NOTIFIED_CATCHUP_WINDOW_DAYS = 14;

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

const MS_PER_DAY = 86_400_000;

/**
 * scheduler.py `next_due_threshold()` -- the single nearest (most urgent)
 * threshold that's newly due, and NEVER a less-urgent tier than one already
 * sent (so a scheduler gap can't deliver reminders out of order).
 */
export function nextDueThreshold(daysRemaining: number, alreadySent: number[]): number | null {
  const mostUrgentSent = alreadySent.length > 0 ? Math.min(...alreadySent) : null;
  for (const threshold of [...ESCALATION_THRESHOLDS_DAYS].sort((a, b) => a - b)) {
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
  errors: { subscriber_id: string; error: string }[];
}

export type ReminderSendFn = (toEmail: string, email: BuiltEmail) => Promise<boolean>;

export interface RunReminderOptions {
  /** Scheduling clock. Defaults to now. A test can advance it without waiting
   * real days. */
  asOf?: Date;
  /** Injected sender for tests -- defaults to the real SendGrid send. Mirrors
   * the Python original passing an EmailSender in. */
  send?: ReminderSendFn;
}

function dailySendCap(env: Env): number {
  const n = Number.parseInt(env.REMINDERS_DAILY_SEND_CAP ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DAILY_SEND_CAP;
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
    ((to, built) => {
      if (!env.SENDGRID_API_KEY) return Promise.resolve(false);
      return sendViaSendGrid(env.SENDGRID_API_KEY, to, built, env.EMAIL_ALLOWLIST);
    });

  const cap = dailySendCap(env);
  const summary: ReminderSummary = {
    checked: 0,
    sent: 0,
    skipped_no_deadline: 0,
    skipped_grace_period: 0,
    errors: [],
  };

  const subscribers = await store.allConfirmedActive(env.DB);
  for (const sub of subscribers) {
    summary.checked += 1;

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

    let threshold: number | null;
    if (daysRemaining < -GRACE_PERIOD_PAST_DEADLINE_DAYS) {
      if (neverNotified && daysRemaining >= -NEVER_NOTIFIED_CATCHUP_WINDOW_DAYS) {
        // First-ever evaluation landed past-deadline -- one bounded catch-up at
        // the most urgent tier rather than silent-forever.
        threshold = Math.min(...ESCALATION_THRESHOLDS_DAYS);
      } else {
        summary.skipped_grace_period += 1;
        continue;
      }
    } else {
      threshold = nextDueThreshold(daysRemaining, alreadySent);
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
          sub.first_name
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

      const ok = await send(sub.email, built);
      if (ok) {
        summary.sent += 1;
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

export { StaleDataError };
