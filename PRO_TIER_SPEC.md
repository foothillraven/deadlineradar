# DeadlineRadar Pro — Spec (design doc, no build)

**Status:** design-only deliverable per orchestrator directive
`_AAA_orchestrator_20260720_spec_deadlineradar_pro_tier.md`. A follow-up directive
(`_AAA_orchestrator_20260720_BUILD_deadlineradar_pro_mvp.md`) pre-greenlit progressing from
spec to build, but per that same directive's own order-of-operations ("produce the spec
first... post it... don't block waiting"), this document is that spec. No code, no schema
migration, no Stripe call, no page copy change has been made as part of writing this.
Devin/orchestrator green-lights MVP scope before anything is built; nothing charges real
money without a separate, explicit go at the live-pricing gate.

**Date:** 2026-07-20
**Author:** AssetLab (subagent pass)
**Repo:** `b3_saas/deadlineradar` — live site `deadline-radar.com`, static via Cloudflare
Pages (`generate.py` → `docs/`), signup/reminder backend via Cloudflare Worker + D1
(`worker/`), bot defense via Turnstile.

---

## 0. Where things stand right now (context this spec is built on)

- **Free tier, unchanged, is the magnet:** 51 state renewal-date pages + a double
  opt-in email reminder (capture → confirm → Worker cron sends reminders at 60/30/14/7/3/1
  days out). This is the only thing driving organic traffic and it does not change.
- **23 states now also have a CPE-hours page** (`data/cpe_hours.json`,
  `cpe_hours_draft/`): total hours / ethics hours / reporting period, each field sourced
  to a state board page **and** a codified statute — same two-source verification bar as
  the renewal-date data.
- **First real organic-demand signal in months:** two state pages — **Kansas** and
  **Maryland** — have started pulling genuine (non-bot, non-self) organic search traffic
  in the last week. This is the first evidence real people with a real compliance
  problem are landing on the site, not just crawlers or synthetic pilots. These two pages
  are where the Pro CTA should go first.
- **A B2B "for firms" page already exists and is already live** at
  `docs/for-firms/index.html`: **$500/year flat for firms with up to 10 staff, ~$50/seat
  above that, free 30-day pilot, no card required** — currently an email-capture pilot
  (`mailto:`), not wired to Stripe or to any account system. This is a real, already-shipped
  price point this spec should reconcile with, not silently replace.
- **Stripe: found a discrepancy worth flagging up front.** The task brief for this spec
  states Stripe is "live in TEST MODE." The actual file at `AssetLab/.secrets/stripe.env`
  contains a **live-mode key pair** (`pk_live_…` / `sk_live_…` — Stripe's mode is
  determined by which key prefix you use, not by a separate "test mode" flag on a live
  account). Using those specific keys for anything would create real charges against a
  real bank account, not a sandboxed test charge. **Action needed before any billing code
  is written:** generate a **`sk_test_…` / `pk_test_…`** key pair from the same Stripe
  account's test-mode dashboard and use only those for the MVP build. Do not wire the
  existing `.secrets/stripe.env` values into anything that can be triggered by a real user
  action. This is flagged here rather than fixed silently because it's a guardrail-relevant
  finding (CLAUDE.md guardrail #2: no live Stripe mode without an explicit go), not a code
  change to make on my own authority.

---

## 1. Funnel — the free magnet stays exactly as-is

```
Google/Bing search ("kansas cpa cpe requirements", "maryland cpa license renewal", …)
        │
        ▼
Free SEO page (renewal date OR CPE-hours page, sourced + dated)
        │
        ├── existing: free double opt-in email reminder signup (unchanged, stays free forever)
        │
        └── NEW: "Go Pro" CTA  ───────────────────────────────────────────►  Pro signup
                                                                              (account + $/yr)
```

**Where the CPE content becomes the upsell hook, specifically:** the free CPE-hours page
already tells a CPA the one fact a compliance tool would need — *"Kansas requires 40 hours
every 2 years, 2 of which must be ethics, period ends June 30"* — sourced and dated. What
it cannot do, and never should as a free static page, is answer *"okay, but where do I
personally stand against that number right now?"* That question is the exact moment a free
reference page turns into a felt problem (a CPA doesn't know if they're on pace until
someone tallies it for them), and it's the one thing a static site structurally cannot
do. That gap **is** the product. The CTA copy pattern:

> *"Kansas requires 40 CPE hours (2 ethics) by June 30. **Track your actual hours against
> this — free reminder, plus Pro if you want your progress tracked automatically.**"*

Placement: a single CTA block under the requirement table on the CPE page (and,
secondarily, a smaller line on the renewal-date page pointing at the CPE page if the state
has one) — additive only, per the standing instruction not to touch the existing free
content's substance. Ships first on Kansas and Maryland (the two pages with real traffic
right now), then rolls to the rest of the 23 CPE states once the flow is proven.

The free tier's job doesn't change: be the trustworthy, sourced, findable answer. Pro's job
is entirely additive — remembering the user's own numbers against that answer over time.

---

## 2. Pro feature list — prioritized by value × build-effort

Scored value 1–5 (revenue/retention pull) and effort 1–5 (5 = biggest lift), using what's
actually in the repo today as the effort baseline.

| # | Feature | Value | Effort | Why | MVP? |
|---|---|---|---|---|---|
| 1 | **CPE hour tracking** (log hours/courses against the state's requirement; running total vs. target; ethics-hours sub-tracker; period countdown) | 5 | 3 | The only reason a free-tier reader would pay — turns the sourced requirement into a personal, ongoing answer. Needs accounts as a prerequisite but the tracking data model itself is small and well-scoped. | **YES — MVP anchor** |
| 2 | **All-deadlines-in-one-place** — license renewal (have data) + CPE/ethics (have data) + federal PTIN Dec 31 (no data yet) + peer review (no data yet) | 4 | 2 for the license+CPE slice we already have data for / 5 for the full vision (PTIN + peer review need brand-new sourced datasets, same two-source bar as everything else, before they're trackable at all) | Ship the cheap 80%: a "your deadlines" list combining license renewal + CPE period end, both already-sourced data. Do **not** promise PTIN/peer-review tracking until that data exists — a compliance tool that's wrong about a federal deadline is worse than one that's silent about it. | **PARTIAL in MVP** (license + CPE only); PTIN/peer-review = later phase, gated on sourcing new datasets |
| 3 | **Multi-state licensing** (a CPA holds licenses in >1 state, wants both tracked) | 3 | 4 | Real need for a meaningful minority of CPAs (reciprocity is common), but it's an amplifier on top of accounts + the tracking model, not a prerequisite — adds a one-to-many user↔requirement table and a "add another state" flow. | **NO — later phase** |
| 4 | **Firm/team accounts (B2B)** | 4 (higher ACV) | 5 (biggest lift on this list) | Multi-tenant data model, seat/role management, an admin dashboard, invite flow, its own billing shape (already-published $500/yr/10-seat exists as an unproven email pilot) — this is a genuinely different, harder product surface, and a different distribution motion (outbound/word-of-mouth vs. the SEO funnel that's actually converting right now). | **NO — later phase.** Leave the existing `/for-firms` email-pilot page exactly as-is; it costs nothing incremental and is already testing B2B appetite independently. |
| 5 | **Calendar sync + multi-deadline reminders** | 3 | 2 for a static per-account **.ics feed** / 5 for live two-way calendar API sync | A downloadable/subscribable ICS feed of a user's own deadlines is cheap once accounts + a deadlines list exist (just a formatting pass over data already in D1). Two-way Google/Outlook API sync is a materially bigger integration surface (OAuth, token refresh, webhook sync) for retention value that hasn't been asked for yet. | **NO — later phase** (static ICS export is a good fast-follow candidate right after MVP ships; full calendar API sync stays off the roadmap until there's a specific reason) |

**Read on the list:** feature #1 is the only one that's both high-value and low-effort
relative to the others — everything else either needs #1's account infrastructure first
(#2 partial, #3, #5) or is a materially larger, differently-shaped build (#4). This is
exactly the sequencing the "prove one operating spine before forking" instinct calls for.

---

## 3. Build-size assessment — reused vs. net-new

### Reused (materially lowers MVP cost)

- **D1 + Cloudflare Worker infrastructure.** `worker/migrations/0001`–`0006` already prove
  out a token-based lifecycle (`confirm_token` / `unsubscribe_token` / `renewed_token`,
  each independently unique, CSPRNG-generated), rate limiting (`0002_rate_limit_hits.sql`),
  and send-tracking (`0004_send_counters.sql`, `0006_resend_tracking.sql`). An
  accounts/session table is a straightforward extension of a pattern that's already live
  and already handled this exact class of problem (unique tokens, status transitions,
  timestamps as ISO text) once.
- **Turnstile bot defense** is already wired into every form on the site — the Pro
  signup/login forms reuse the same integration, not a new one.
- **Email sending path.** `reminders/sender.py` / `worker/src/sender.ts` already model the
  daily-cap circuit breaker and dry-run-vs-real-send split needed for transactional email
  (magic links, receipts, payment-failed notices) — the plumbing is proven, only the
  templates and trigger points are new. (Per README: **no real email has ever been sent**
  from this codebase yet — that gap has to close for Pro regardless of which auth pattern
  is chosen, since a compliance tool with unverifiable emails is a support/PII risk on
  its own.)
- **CPE reference data model** (`data/cpe_hours.json`, 23 states, board-page + statute
  sourcing). This is reused as **read-only input** — Pro's hour *log* is a new table that
  reads this data as the target, it does not replace or duplicate it.
- **generate.py static pipeline.** The "Go Pro" CTA is one more templated block, same
  pattern as the existing signup form partials (`signup_form_for_state()` /
  `signup_form_homepage()`) — low effort, no new rendering system.
- **Stripe payment-link pattern** — the *pattern* (not the keys) already has a working
  precedent elsewhere in the business (Moose & Raven), so this isn't first-time Stripe
  integration work for the fleet, just for this repo.

### Net-new (the real cost of Pro)

- **Account/auth data model + flow.** Real login credentials or magic links, session
  handling, password reset. This is a materially bigger security surface than the existing
  email-capture-with-tokens model — it's real ongoing PII plus an authentication boundary,
  not a one-shot confirm/unsubscribe token. Budget real review time here specifically
  (this is the one place a mistake is expensive: account takeover or PII leakage, not a
  stale date on a page).
- **CPE-hour-log data model + UI.** A new table (course/hours/date/ethics-flag per entry,
  keyed to account + state + period), a small dashboard (running total vs. requirement,
  progress bar, entries list, add/edit/delete), tied to the existing `cpe_hours.json`
  requirement as the target number. Genuinely new schema and new UI, but small and
  well-bounded — this is the anchor feature and it's a good scope for an MVP.
- **Billing wiring.** Stripe Checkout session creation, a webhook endpoint (subscription
  created / renewed / canceled / payment-failed), a `customers`/`subscriptions` table
  linking a Stripe customer to an account row, and feature-gating logic keyed off
  subscription status. New Worker routes, new D1 tables, and — per §0 above — a real
  action item to provision proper **test-mode** keys before any of this is wired, since
  the currently-available keys are live-mode.
- **"Go Pro" CTA on the pages.** Small — a templating addition to `generate.py`, not
  flagged as a cost driver.
- **Team/multi-tenant data model** (deferred). An orgs table, seat management, roles,
  invites, an admin view — sizable on its own, and it stacks on top of (not instead of)
  the individual-account auth work, so it's correctly a later phase, not a parallel track.
- **Multi-state per-user tracking** (deferred). Moderate — a `user_requirements` join table
  — but blocked on accounts existing first, so it's naturally sequenced after MVP.
- **Calendar sync** (deferred). ICS export is cheap once deadlines-in-one-place exists;
  live calendar API sync is a new integration surface with its own auth (OAuth) and isn't
  scoped here at all.
- **PTIN + peer-review tracking** (deferred). Not just a UI slice — these need **brand-new
  sourced datasets** (board/IRS page + citation, same verification bar as everything else)
  that don't exist yet. Don't schedule these as "just add a UI" — the data work comes
  first and hasn't started.

---

## 4. Pricing recommendation

### Individual Pro

**Recommend $39/year**, with a $5/month option for people who don't want an annual
commitment (annual should be the default/highlighted CTA — it's both better cash-you-can-
point-to for validating the tier and matches how the closest real comparables price).

**Comparables (searched live, cited, not recalled from training data):**

| Product | What it actually is | Price | Source |
|---|---|---|---|
| **Becker CPE Compliance Tracker** | Standalone CPE-hour compliance tracker aimed at CPAs specifically — the closest real analog to feature #1 above | **$19.99** (after a free 30-day trial) | [becker.com/cpe/catalog/compliance-tracker](https://www.becker.com/cpe/catalog/compliance-tracker) |
| **CE Broker — Professional** | Cross-profession CE/license compliance tracking (nursing, real estate, and other licensed professions; used as the actual state-mandated tracker in many states) — detailed transcripts, phone support | **$39.99/year** | [cebroker.com/plans](https://cebroker.com/plans) |
| **CE Broker — Pro+** | Adds multi-state tracking | **$89.99/year** | [help.cebroker.com — CE Broker Pro+](https://help.cebroker.com/hc/en-us/articles/26779473417364-CE-Broker-Pro) |
| **CE Broker — Concierge** | Personalized/priority-support tier | **$124.99/year** | [cebroker.com/plans](https://cebroker.com/plans) |

These two products (Becker, CE Broker) are the right comp class: **simple compliance
trackers**, not full practice-management suites. DeadlineRadar Pro's anchor feature sits
squarely between them in scope, so **$39/year lands right on CE Broker's Professional
price** — a real, currently-charged price point for materially the same job-to-be-done
(track my hours against my board's requirement, don't let me miss it), with the added
differentiator that every requirement number is individually sourced to a board page +
codified statute (most of these tools don't show you their source). That sourcing is worth
defending in marketing copy, not necessarily worth pricing above $39 for — the MVP's job
is to prove *anyone* pays, not to maximize ARPU on the first cohort.

**Suggested launch mechanic:** a $29/year "founding member" price for the first cohort
converting off the Kansas/Maryland pages specifically (first-mover, sunsets after a fixed
count or 90 days) — cheap to test willingness-to-pay without committing to a permanently
lower price.

### Firm/team

**Recommend keeping the already-published $500/year flat (up to 10 staff, ~$50/seat
above that)** from `/for-firms` rather than inventing a new number without cause — it's
already live, already been shown to real visitors as a 30-day-pilot offer, and independently
tests B2B appetite. It also benchmarks correctly against real per-seat practice-management
pricing:

| Product | What it is | Price | Source |
|---|---|---|---|
| **Karbon** | Full practice-management suite (email, workflow, time, billing) | **$59/mo/user (Team)** = ~$708/user/year; **$89/mo/user (Business)** = ~$1,068/user/year | [financial-cents.com — Karbon Pricing 2026](https://financial-cents.com/resources/articles/karbon-pricing/) |
| **TaxDome** | Full practice-management suite | **$800–$1,200/user/year** | [assembly.com/blog/taxdome-pricing](https://assembly.com/blog/taxdome-pricing) |
| **Canopy** | Full practice-management suite, modular | **$74–$149/user/month** (~$888–$1,788/user/year) | [getcanopy.com/pricing](https://www.getcanopy.com/pricing/) |

At $50/seat/year, DeadlineRadar's firm tier is roughly **14–35× cheaper per seat** than any
of these — which is *correct* positioning, not underpricing to worry about: those products
are full practice-management suites (billing, client portal, document management, CRM);
DeadlineRadar Pro for firms is deliberately a single-purpose compliance-deadline tracker.
Trying to price toward Karbon/TaxDome territory would be pricing a feature as if it were a
platform. **One flag for whoever revisits this post-MVP:** the $500/yr number was set
before CPE-hour tracking existed as the anchor differentiator — worth a fresh look (not
necessarily a change) once the firm tier actually includes per-staff hour tracking, not
just a shared deadline list. Not a reason to touch the live page now; firm accounts are
explicitly deferred past MVP.

---

## 5. MVP recommendation — smallest slice genuinely worth paying for, shippable soonest

**Build:**
1. **CPE hour tracking** (feature #1) — log entries against the state's `cpe_hours.json`
   requirement, running total, ethics sub-total, period countdown. The anchor and the only
   must-have feature.
2. **Basic account/auth** — email + password (or magic-link — pick whichever the team
   judges lower support burden; either is fine for MVP scope), sound-security baseline
   since this is real PII, nothing fancier.
3. **"Go Pro" CTA** on the CPE pages already getting organic traffic — **Kansas and
   Maryland first**, additive only, existing free content untouched.
4. **Stripe billing in TEST MODE ONLY** — using newly-provisioned `sk_test_`/`pk_test_`
   keys (see §0 flag — the existing `.secrets/stripe.env` pair is live-mode and must not be
   wired into this build).

**Explicitly deferred, not built, not scaffolded:**
- Firm/team accounts (existing `/for-firms` email pilot keeps running unchanged)
- Multi-state licensing
- Calendar sync (static ICS export is a reasonable fast-follow right after MVP; live
  two-way sync is not on the roadmap)
- PTIN (federal) and peer-review tracking (blocked on sourcing new datasets to the same
  two-source standard as everything else — not a UI gap, a data-sourcing gap)

**Why this is the right cut:** it's the one feature (#1) that is simultaneously highest
value and lowest incremental effort once accounts exist, it sits on the two pages that
just showed the first real organic-demand signal this business has had in months, it
prices against a real, currently-charged comparable ($39/yr vs. CE Broker Professional's
$39.99/yr), and it stays entirely inside the guardrails already in force — no live
charging, no new external account beyond Stripe test mode, no change to the free content
that's the actual traffic driver.

**Before build starts, two concrete action items from this spec:**
- Provision Stripe **test-mode** keys; do not reuse the live pair in `.secrets/stripe.env`
  for anything wired to a real user flow.
- Independent RE-QA gate (per the BUILD directive) applies before anything is
  publish-ready — this spec does not self-clear the build for shipping.
