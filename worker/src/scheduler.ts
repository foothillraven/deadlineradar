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

  const send: ReminderSendFn =
    opts.send ??
    ((to, built) => {
      if (!env.SENDGRID_API_KEY) return Promise.resolve(false);
      return sendViaSendGrid(env.SENDGRID_API_KEY, to, built);
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
      deadline = computeSubscriberDeadline(sub.state_slug, fields, asOf);
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

    const daysRemaining = Math.round((deadline.getTime() - asOf.getTime()) / MS_PER_DAY);
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

    const renewedUrl = `${ACTION_BASE_URL}/renewed?token=${encodeURIComponent(sub.renewed_token)}`;
    const unsubscribeUrl = `${ACTION_BASE_URL}/unsubscribe?token=${encodeURIComponent(sub.unsubscribe_token)}`;
    let built: BuiltEmail;
    try {
      built = buildReminderEmail(
        stateName,
        fmtDate(deadline),
        threshold,
        daysRemaining,
        renewedUrl,
        unsubscribeUrl,
        sub.first_name
      );
    } catch (err) {
      summary.errors.push({ subscriber_id: sub.id, error: `email build failed: ${String(err)}` });
      continue;
    }

    // Circuit breaker last, right before the send, so a build/suppression skip
    // above never consumes a day's send budget.
    const underCap = await checkAndCountSend(env.DB, cap);
    if (!underCap) {
      summary.errors.push({ subscriber_id: sub.id, error: "daily send cap reached -- halting further sends today." });
      continue;
    }

    const ok = await send(sub.email, built);
    if (ok) {
      await store.markReminderSent(env.DB, sub.id, threshold);
      summary.sent += 1;
    } else {
      summary.errors.push({ subscriber_id: sub.id, error: "send returned false" });
    }
  }

  return summary;
}

export { StaleDataError };
