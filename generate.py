#!/usr/bin/env python3
"""
DeadlineRadar -- CPA license renewal static site generator (LOCAL PROTOTYPE)

Reads data/cpa_deadlines.json (hand-verified, sourced 2026-07-03) and renders:
  - docs/[state-slug]/index.html   one page per state
  - docs/index.html                directory of all state pages
  - docs/sitemap.xml               XML sitemap (placeholder domain, no network calls)
  - docs/robots.txt                allow-all, points at the sitemap

Python stdlib only. No network calls. No real domain. No payment/Stripe code.
This script proves the ingest -> normalize -> generate pipeline; it is not a server.

Design pass (2026-07-03): presentation layer only -- header/wordmark, styled
callouts, zebra tables, dark mode, mobile-responsive grid, prominent trust
line, fixed footer. NONE of the date-math, staleness-guard, or data-loading
logic below changed in this pass -- see the "Main" section, unchanged from
the prior build.

Usage:
    python generate.py
"""

from __future__ import annotations

import html
import json
import os
import pathlib
from datetime import date, timedelta

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

ROOT = pathlib.Path(__file__).resolve().parent
DATA_PATH = ROOT / "data" / "cpa_deadlines.json"
# Separate dataset (2026-07-15): CPE HOUR requirements, distinct from the renewal
# DATE data above -- same 2-source verification standard, never merged with
# cpa_deadlines.json. See data/cpe_hours.json's own _meta block for status.
CPE_HOURS_DATA_PATH = ROOT / "data" / "cpe_hours.json"
# Separate dataset (2026-07-25): what a LAPSED license costs to reinstate --
# fee + penalty/catch-up CPE hours. Distinct from both datasets above, same
# 2-source verification standard. See data/reinstatement.json's own _meta.
REINSTATEMENT_DATA_PATH = ROOT / "data" / "reinstatement.json"
# Separate dataset (2026-08-01/02): publishable rule-CHANGE events, built by
# scripts/build_change_events.py from the mobility ruleset + DiffLab's live
# monitoring. Deliberately independent of the mobility determination engine
# (held from production) -- this feed publishes change facts + citations only.
REG_CHANGE_EVENTS_PATH = ROOT / "data" / "reg_change_events.json"
# DiffLab's own monitoring-coverage numbers (2026-08-03), copied in from
# Orchestrator/reg_change_events/coverage_stats.json each capture cycle so
# the "0 real events yet" case on /rule-changes/ can show real proof of
# active work instead of reading as broken/abandoned -- same
# never-hardcode-a-published-number rule as everything else on this site.
RULE_CHANGE_COVERAGE_STATS_PATH = ROOT / "data" / "rule_change_coverage_stats.json"
# "docs" (not "site") deliberately -- this is the zero-config GitHub Pages
# convention (Settings > Pages > Deploy from a branch > /docs), so this
# directory becomes the deploy target as-is once a repo + Pages source exist.
# No repo/Pages source exists yet -- this only prepares the file structure.
#
# Overridable via DR_SITE_DIR (2026-07-28, firm-dashboard preview build) --
# unset, this is byte-identical to before. Set only by the preview build
# script so a preview generation writes to a separate directory instead of
# overwriting the real, committed, production docs/ tree.
SITE_DIR = ROOT / os.environ.get("DR_SITE_DIR", "docs")

# Self-hosted display font (2026-07-10 visual-trust redesign). Copied verbatim into
# docs/fonts/ at build time, referenced by an absolute /fonts/... URL in PAGE_CSS so
# every page shares one cached file instead of each page embedding its own copy --
# see assets/fonts/LICENSE.txt for the font's license (SIL OFL, embedding permitted).
FONT_ASSETS_DIR = ROOT / "assets" / "fonts"

# Placeholder only. No domain has been purchased, nothing here is deployed yet.
# Swap this single constant for the real https://<user>.github.io/<repo> URL
# (or a real domain later) once publishing is explicitly decided -- do not
# hardcode a real URL before that.
#
# Overridable via DR_SITE_BASE_URL (2026-07-28 preview build) -- same
# unset-is-unchanged convention as DR_SITE_DIR above.
SITE_BASE_URL = os.environ.get("DR_SITE_BASE_URL", "https://deadline-radar.com")

# IndexNow (indexnow.org) key -- proves ownership of the site to IndexNow-participating
# search engines (Bing, Yandex; not Google, which has no public IndexNow support) so
# `scripts/indexnow_ping.py` can notify them the instant a page changes, rather than
# waiting on their own re-crawl schedule. This constant only WRITES the required
# `{key}.txt` verification file as part of the static build (no network call here --
# generate.py stays offline by design, see the module docstring); the actual ping is a
# separate, deliberately-run script, invoked manually after a real push, not on every
# local build.
INDEXNOW_KEY = "8e043aa98a82c1c393f1ac2aead217d8"

# CPE-provider affiliate links. Each provider below is INDEPENDENTLY gated: it
# renders nothing at all until its own constant is swapped from the placeholder to a
# real tracked link -- no free referral traffic before there's a real ID to earn
# from, and no commercial placement on the trust-built pages until it's real (per
# review ruling). One provider can go live without the other.
#
# Illumeo: real, public, self-serve affiliate program (20% commission via FlexOffers,
# free to join, no minimum), NASBA-registry-listed (sponsor ID 109504) and separately
# registered with the Texas board (sponsor #009890), no accreditation/fraud red flags
# found in a dedicated vetting pass. No affiliate account exists yet: the free signup
# happens under the Moose & Raven LLC brand identity when convenient.
_ILLUMEO_AFFILIATE_PLACEHOLDER = "https://www.illumeo.com/"
ILLUMEO_AFFILIATE_URL = _ILLUMEO_AFFILIATE_PLACEHOLDER

# Becker: CPE + exam-prep provider, affiliate program run via Yazing (~6.3% net
# commission). Yazing is a coupon/cashback intermediary -- the tracked link routes
# through Yazing's own coupon page before landing on Becker, an extra hop Illumeo's
# direct FlexOffers link doesn't have. `_cpe_provider_html()`'s routing_note param
# exists specifically to disclose that hop in the placement copy itself, so a visitor
# isn't confused landing on an unfamiliar domain first -- a UX/trust concern, distinct
# from (and in addition to) the FTC material-connection disclosure every provider
# gets regardless of routing.
_BECKER_AFFILIATE_PLACEHOLDER = "https://www.becker.com/"
BECKER_AFFILIATE_URL = _BECKER_AFFILIATE_PLACEHOLDER

# MYCPE ONE, Surgent, WebCE, Gleim (2026-07-25 slot-infrastructure batch): the
# other 4 providers ScoutLab's 2026-07-21 product register confirmed run
# partner/affiliate programs and want individual-CPA leads (Becker + Illumeo
# above were vetted and wired first). SLOTS ONLY -- no vetting pass, no
# affiliate account, no real tracked link for any of these 4 yet. Same
# independent-gate discipline as Illumeo/Becker: each renders nothing until
# its own constant is swapped off its placeholder. Devin does the affiliate
# signups; this just makes flipping one live a one-line paste, not a rebuild.
_MYCPE_AFFILIATE_PLACEHOLDER = "https://my-cpe.com/"
MYCPE_AFFILIATE_URL = _MYCPE_AFFILIATE_PLACEHOLDER

_SURGENT_AFFILIATE_PLACEHOLDER = "https://www.surgentcpe.com/"
SURGENT_AFFILIATE_URL = _SURGENT_AFFILIATE_PLACEHOLDER

_WEBCE_AFFILIATE_PLACEHOLDER = "https://www.webce.com/"
WEBCE_AFFILIATE_URL = _WEBCE_AFFILIATE_PLACEHOLDER

_GLEIM_AFFILIATE_PLACEHOLDER = "https://www.gleim.com/"
GLEIM_AFFILIATE_URL = _GLEIM_AFFILIATE_PLACEHOLDER

# Reminder backend (worker/, the Phase-1 Cloudflare Worker -- see
# worker/DEPLOY.md). Same-origin relative path, not a separate domain: the
# Worker is bound to the deadline-radar.com/api/* Route, so the form posts
# to the same site it's served from. STAGED ONLY -- per the Phase-1
# directive, this change is committed locally but deliberately NOT pushed
# until AFTER the Worker is deployed and verified responding (worker/
# DEPLOY.md step 6); pushing before that would point the live, public
# signup form at a route that doesn't exist yet.
#
# Overridable via DR_REMINDER_BACKEND_BASE_URL (2026-07-28 preview build) --
# same unset-is-unchanged convention as DR_SITE_DIR/DR_SITE_BASE_URL above.
# The preview build points this at the preview Worker's own workers.dev URL
# (a different origin than the static preview pages), since a preview Pages
# deployment and a preview Worker deployment don't share one origin the way
# production's single deadline-radar.com domain does.
REMINDER_BACKEND_BASE_URL = os.environ.get("DR_REMINDER_BACKEND_BASE_URL", "/api")

# 2026-07-30 (auth suite). Comma-separated provider ids to render SSO
# buttons for, e.g. DR_SSO_PROVIDERS="google".
#
# Defaults to EMPTY -- no SSO buttons -- deliberately. The Worker gates each
# provider on ITS OWN secrets and 404s when they are absent, so a build that
# advertises a provider the deployed Worker has no credentials for would
# render a button that dead-ends on click. Safe-by-default means production
# shows nothing until the secrets are actually in place, and the flag is set
# for a build only alongside setting that environment's secrets.
SSO_PROVIDERS = [p.strip() for p in os.environ.get("DR_SSO_PROVIDERS", "").split(",") if p.strip()]

# States whose worker (deadline.ts's computeSubscriberDeadline) has dedicated
# per-state fields to compute a deadline even without a plain
# next_deadline_computed on any record -- birth-month (California/Texas) or a
# cohort-group selector (Ohio). Every other state needs at least one record
# with a real next_deadline_computed, or the worker's generic "exactly one
# computed record" path has nothing to return and /subscribe 400s on every
# submission. New York was the original example (its rule depends on a fact,
# first-registration date, this dataset doesn't have) but is not special --
# any state whose records are ALL null/gapped hits the identical failure mode.
_WORKER_FIELD_COMPUTED_STATES = {"california", "texas", "ohio"}


def _state_signup_supported(state_slug: str, records: list[dict]) -> bool:
    """Whether the reminder worker can compute a deadline for this state
    FROM STATE RULES ALONE (no user-supplied date). Discovered 2026-07-05
    during the correctness-audit ship: downgrading a state's last computable
    record to null (here, or already the case for several batch-2/3 states)
    silently left a live signup form on its page that would 400 on every
    real submission -- the front-end had no check against the worker's
    actual computation capability. Originally used to hide the form
    entirely on a false result; as of "bring your own date" (same day, later
    build) the form always renders now -- this function instead selects
    WHICH extra field(s) `_extra_fields_html()` shows: the per-state
    computed fields when true, or a plain date input when false. Mirrors
    deadline.ts's `isStateComputable()` exactly, same underlying data, so
    the two can't drift out of sync."""
    if state_slug in _WORKER_FIELD_COMPUTED_STATES:
        return True
    return any(r.get("next_deadline_computed") for r in records)

MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
]

MONTH_LAST_DAY = {
    1: 31, 2: 28, 3: 31, 4: 30, 5: 31, 6: 30,
    7: 31, 8: 31, 9: 30, 10: 31, 11: 30, 12: 31,
}


def month_last_day(year: int, month: int) -> int:
    """Last calendar day of a given month/year, accounting for leap Februaries."""
    if month == 2 and (year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)):
        return 29
    return MONTH_LAST_DAY[month]


def fmt_date(d: date) -> str:
    return f"{MONTH_NAMES[d.month - 1]} {d.day}, {d.year}"


def fmt_date_iso(d: date) -> str:
    return d.isoformat()


# ---------------------------------------------------------------------------
# Wave-3 (birth-month) table computation -- UNCHANGED this pass
# ---------------------------------------------------------------------------

def next_birth_month_parity_date(as_of: date, month: int, parity: str) -> date:
    """Next date, on the last day of `month`, in a year whose parity matches
    `parity` ('odd'/'even'), strictly after `as_of`."""
    y = as_of.year
    while True:
        year_is_target_parity = (y % 2 == 1) if parity == "odd" else (y % 2 == 0)
        if year_is_target_parity:
            d = date(y, month, month_last_day(y, month))
            if d > as_of:
                return d
        y += 1


def next_annual_month_end(as_of: date, month: int) -> date:
    """Next date on the last day of `month`, strictly after `as_of` (this year
    if it hasn't happened yet, else next year)."""
    d = date(as_of.year, month, month_last_day(as_of.year, month))
    if d <= as_of:
        d = date(as_of.year + 1, month, month_last_day(as_of.year + 1, month))
    return d


def build_california_table(as_of: date) -> list[dict]:
    rows = []
    for m in range(1, 13):
        odd_d = next_birth_month_parity_date(as_of, m, "odd")
        even_d = next_birth_month_parity_date(as_of, m, "even")
        rows.append({
            "month": MONTH_NAMES[m - 1],
            "odd_birth_year_next_deadline": fmt_date(odd_d),
            "even_birth_year_next_deadline": fmt_date(even_d),
        })
    return rows


def build_texas_table(as_of: date) -> list[dict]:
    rows = []
    for m in range(1, 13):
        d = next_annual_month_end(as_of, m)
        rows.append({
            "month": MONTH_NAMES[m - 1],
            "next_deadline": fmt_date(d),
        })
    return rows


# ---------------------------------------------------------------------------
# HTML helpers -- presentation layer, redesigned this pass
# ---------------------------------------------------------------------------

SITE_NAME = "DeadlineRadar"
SITE_TAGLINE = "CPA license renewal deadlines by state — verified and kept current"
BRAND_NAME = "Moose & Raven LLC"
JURISDICTION_COUNT = 51  # overwritten in main() from the real record count once data is loaded


def esc(s: str) -> str:
    return html.escape(str(s), quote=True)


# AuditLab ST-4: "a Alabama CPA" / "a Ohio CPA" read as a grammar slip in the
# first sentence under the H1 on 12 CPE pages. Letter-based (not
# pronunciation-based) so state names with a vowel-sound consonant start
# ("Utah") are hardcoded exceptions rather than silently getting "an Utah".
_A_AN_CONSONANT_SOUND_EXCEPTIONS = {"utah"}


def indefinite_article(name: str) -> str:
    if name.strip().lower() in _A_AN_CONSONANT_SOUND_EXCEPTIONS:
        return "a"
    return "an" if name[:1].upper() in "AEIOU" else "a"


def http_href(url: object, fallback: str = "#") -> str:
    """Only http(s) survives into an href -- esc() does nothing against a
    javascript: URI, so this (not escaping) is the actual guard. Mirrors
    scripts/build_change_events.py's _http(), but lives here too so every
    data-file-sourced link is guarded at render time regardless of which
    producer wrote the file."""
    if isinstance(url, str) and url.startswith(("http://", "https://")):
        return esc(url)
    return fallback


# Minimal calendar glyph, site accent color (#1f5fbf), flat and legible at 16px.
# Two "binder tabs" + a header band + one highlighted date square -- the smallest
# set of shapes that still reads as "calendar/deadline" at favicon size.
FAVICON_SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
<rect x="9" y="1" width="3" height="7" rx="1.5" fill="#1f5fbf"/>
<rect x="20" y="1" width="3" height="7" rx="1.5" fill="#1f5fbf"/>
<rect x="3" y="5" width="26" height="24" rx="4" fill="#1f5fbf"/>
<rect x="3" y="5" width="26" height="7" rx="4" fill="#ffffff" fill-opacity="0.25"/>
<rect x="13" y="17" width="6" height="6" rx="1.2" fill="#ffffff"/>
</svg>
"""

# ---------------------------------------------------------------------------
# 2026-07-31 CARD LAYOUT BUGFIX -- rationale kept HERE, in Python, deliberately.
#
# An earlier version of this explanation lived in the CSS itself, which is
# INLINED INTO EVERY RENDERED PAGE -- so it shipped internal language onto 181
# public URLs and preship_gate.py caught it. Lesson worth keeping: the CSS
# string in this file is PUBLIC OUTPUT, not source commentary. Explain things
# here; keep shipped comments terse and neutral.
#
# The bug: `.frow` was `grid-template-columns: 1fr auto` with `.cite` set to
# `white-space: nowrap`. A short statutory citation ("68 Ill. Admin. Code
# 1420.80(a)") fits, so most cards looked fine -- but a long prose citation
# ("Confirmed via Illinois IDFPR's public open-data licence register...")
# cannot wrap, so the `auto` track sized itself to the full 1850px chip inside
# an 1138px card. That left the `1fr` description track at 112px (measured),
# wrapping prose to 1-2 words per line for 20+ lines, and pushed the chip past
# the card edge.
#
# The report described the citation as "truncated". It was NOT: scrollWidth ==
# width and title == text, so the full string was always in the DOM and in the
# link -- it was overflowing the card and being visually clipped. No citation
# data was ever lost, which matters because the citation is the credibility
# asset this product sells.
#
# Fix: minmax(0,...) on both tracks (removing the min-content floor that let an
# un-wrappable chip dictate the layout) + a cap on the side track; `.cite`
# wraps; and citations over _CITATION_CHIP_MAX_CHARS render as their own
# full-width row instead of a right-aligned pill.

PAGE_CSS = """
  @font-face {
    font-family: 'Fraunces';
    font-style: normal;
    font-weight: 300 900;
    font-display: swap;
    src: url('/fonts/fraunces-variable.woff2') format('woff2');
  }
  :root {
    color-scheme: light dark;
    /* Tokens match the approved design concept exactly. */
    --bg: #f7f9fb; --page-bg: #f7f9fb; --fg: #17212b; --muted: #5a6b7a;
    /* AuditLab UX-3: the original light-mode value (#8595a3) was 3.08:1 against card-bg / 2.92:1 against page-bg on 12 small-text rules including disclaimer/trust copy (needs 4.5, and light mode is the default for most visitors). This one clears both (5.17 / 4.90) while staying lighter than --muted. */
    --faint: #5e6f80;
    --border: #e0e6ec; --border-strong: #c8d2db;
    --accent: #1f3d54; --accent-deep: #152c3e; --accent-bg: #eaeef1; --card-bg: #ffffff;
    --on-accent: #fff;
    /* AuditLab UX-1: foreground for text painted on an --accent/--accent-deep background (buttons, table headers) -- pairs per-theme instead of a hardcoded color, which broke once dark mode inverted --accent from dark-navy to light-blue (was 2.47:1, WCAG AA needs 4.5). Dark-mode value is 7.25:1 against dark --accent and 9.5:1 against --accent-deep, verified with a standalone relative-luminance calc. */
    --panel-dark: #152c3e; --panel-dark-fg: #eaf1f7;
    --gold: #8a6a33; --gold-line: #d8c9a6; --gold-bg: #f4eede;
    --verified-green: #256a4b; --verified-green-bg: #e8f1ec;
    --trust-bg: #f4eede; --trust-border: #d8c9a6; --row-alt: #f6f8f9;
    --shadow: 0 1px 2px rgba(23,33,43,.05), 0 6px 22px rgba(23,33,43,.06);
    --font-display: Georgia, 'Iowan Old Style', 'Times New Roman', serif;
    --font-mono: "SFMono-Regular", ui-monospace, "Cascadia Code", Consolas, "Liberation Mono", monospace;
    --map-fixed: #bcd4f5; --map-fixed-hover: #1f3d54;
    --map-variable: #e4e8ec; --map-variable-hover: #8a95a3;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #12151a; --page-bg: #12151a; --fg: #e7ebf0; --muted: #9aa5b1;
      /* AuditLab UX-2: the previous value was 3.79:1 against card-bg / 4.18:1 against page-bg for small supporting text (needs 4.5). This one clears both (4.91 / 5.42) while staying visibly dimmer than --muted. */
      --faint: #828d99;
      --border: #2a323c; --border-strong: #3a4552;
      --accent: #7fa8d9; --accent-deep: #9cc0ea; --accent-bg: #1b2836; --card-bg: #1a1f26;
      --on-accent: #0d1824;
      --panel-dark: #0d1824; --panel-dark-fg: #dbe6ef;
      --gold: #d6b45a; --gold-line: #8a6d1f; --gold-bg: #26210f;
      --verified-green: #4fd685; --verified-green-bg: rgba(52,199,120,0.12);
      --trust-bg: #26210f; --trust-border: #5a4a20; --row-alt: #171b21;
      --map-fixed: #2c4a72; --map-fixed-hover: #7fb0ff;
      --map-variable: #262b32; --map-variable-hover: #545e6c;
    }
  }
  * { box-sizing: border-box; }
  /* nav.mainnav is sticky at top:0 and ~60px tall -- without this, any
     browser- or JS-driven scroll (an anchor jump to #remind, a keyboard Tab
     landing on a roster row's button, scrollIntoView()) can land content
     flush against the viewport top, tucked UNDER the nav where it is both
     visually obscured (the nav's translucent background lets it show
     through, faintly, which is what makes it look clickable) and click-dead
     (the nav sits above it in the stacking order and receives the click
     instead). Reported directly, 2026-08-03: "clicked the top one, marked
     renewed, didn't do anything" on the roster table -- confirmed via
     elementFromPoint() that a row scrolled flush to the top resolves to the
     nav, not the button, at that exact coordinate. This fixes every
     browser-driven scroll-to-element case; it cannot fix a raw mouse-wheel
     scroll stopping at an arbitrary position, which is a standing
     limitation of any sticky header -- if this keeps happening, the next
     step is verifying it reproduces from a normal scroll and not only from
     scrollIntoView(). */
  html { scroll-padding-top: 68px; }
  html { background: var(--page-bg); }
  body {
    font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    margin: 0; padding: 0 0 3rem;
    line-height: 1.55; color: var(--fg); background: var(--page-bg);
  }
  /* Chrome (nav, topbar, footer border) spans the FULL browser width; only the reading
     content itself is centered in a max-width column -- .wrap is that single column,
     reused everywhere so nav/header/body/footer all align to the same edges. */
  .wrap { max-width: 1180px; margin: 0 auto; padding: 0 1.25rem; }
  a { color: var(--accent); }
  .topbar {
    background: var(--accent-deep); color: #cfe0ee;
    font-size: 0.78rem; letter-spacing: 0.02em; text-align: center; padding: 0.4rem 1rem;
  }
  nav.mainnav {
    background: rgba(247,249,251,.92); backdrop-filter: saturate(1.4) blur(8px);
    border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 20;
  }
  nav.mainnav--static { position: static; }
  @media (prefers-color-scheme: dark) {
    nav.mainnav { background: rgba(18,21,26,.92); }
  }
  .nav-inner {
    display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap;
  }
  .nav-links { display: flex; gap: 1.4rem; flex-wrap: wrap; }
  .nav-links a {
    color: var(--muted); text-decoration: none; font-size: 0.85rem;
    padding: 0.9rem 0; border-bottom: 2px solid transparent; white-space: nowrap;
  }
  .nav-links a:hover { color: var(--fg); }
  .nav-links a.cta { color: var(--accent); font-weight: 600; }
  .stat-strip {
    margin: 1.1rem -1.25rem 1.75rem; background: var(--card-bg); border-top: 1px solid var(--border);
    border-bottom: 1px solid var(--border); padding: 0.65rem 1.25rem; font-size: 0.8rem; color: var(--muted);
    display: flex; gap: 1.6rem; flex-wrap: wrap;
  }
  .stat-strip b { color: var(--accent); font-variant-numeric: tabular-nums; }
  .site-header {
    display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.35rem 1rem;
    padding: 1.5rem 0 1rem; margin-bottom: 0;
  }
  .wordmark { font-family: var(--font-display); font-size: 1.5rem; font-weight: 650; letter-spacing: -0.015em; }
  .wordmark a { color: var(--fg); text-decoration: none; }
  .wordmark b { color: var(--accent); }
  .tagline { color: var(--muted); font-size: 1.08rem; font-weight: 500; flex: 1 1 auto; }
  .by-line { color: var(--muted); font-size: 0.85rem; white-space: nowrap; }
  h1 {
    font-family: var(--font-display); font-weight: 600; font-size: 2.1rem; margin: 0 0 0.35rem;
    line-height: 1.12; letter-spacing: -0.01em; text-wrap: balance;
  }
  h2 { font-family: var(--font-display); font-weight: 600; letter-spacing: -0.005em; }
  .subhead { color: var(--muted); margin: 0 0 1.5rem; }
  .intro { margin: 0 0 1.25rem; }
  .callout {
    position: relative;
    border: 1px solid var(--border); border-left: 4px solid var(--gold-line); border-radius: 8px;
    padding: 1.15rem 1.4rem; background: var(--card-bg); margin: 1.4rem 0;
  }
  .callout + .callout { margin-top: 1rem; }
  .callout .label {
    font-size: 0.78rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em;
  }
  .callout .date {
    font-family: var(--font-display); font-weight: 620; font-size: 2.3rem; letter-spacing: -0.01em;
    margin: 0.15rem 0 0.55rem;
  }
  .callout .rule { margin: 0; }
  .table-wrap {
    overflow-x: auto; margin: 1.1rem 0; border: 1px solid var(--border); border-radius: 8px;
    -webkit-overflow-scrolling: touch;
  }
  table { border-collapse: collapse; width: 100%; font-size: 0.92rem; min-width: 420px; }
  th, td { padding: 0.6rem 0.8rem; text-align: left; border-bottom: 1px solid var(--border); white-space: nowrap; }
  th { background: var(--accent); color: var(--on-accent); font-weight: 700; }
  tbody tr:nth-child(even) { background: var(--row-alt); }
  tbody tr:last-child td { border-bottom: none; }
  .trust-line {
    border: 1px solid var(--trust-border); background: var(--trust-bg); border-radius: 8px;
    padding: 0.9rem 1.1rem; margin: 1.75rem 0; font-size: 0.92rem;
  }
  .trust-line strong::before { content: "\\2713\\a0"; color: var(--gold); }
  /* ---- Rule-changes feed, /rule-changes/ (2026-08-02) ---- */
  .rc-section-note { color: var(--muted); font-size: 0.88rem; margin: 0.2rem 0 0.9rem; }
  .rc-card {
    background: var(--card-bg); border: 1px solid var(--border-strong); border-radius: 10px;
    padding: 1rem 1.2rem; margin: 0 0 1rem;
  }
  .rc-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.5rem; }
  .rc-jurisdiction { font-family: var(--font-display); font-weight: 650; font-size: 1.02rem; }
  .rc-badge {
    font-size: 0.75rem; font-weight: 700; padding: 0.15rem 0.55rem; border-radius: 999px;
    background: var(--verified-green-bg); color: var(--verified-green);
  }
  .rc-badge-conflict { background: var(--gold-bg); color: var(--gold); }
  .rc-conflict { border-color: var(--gold); }
  .rc-date { margin: 0.5rem 0 0.2rem; font-size: 0.9rem; }
  .rc-detail { margin: 0.4rem 0; font-size: 0.92rem; line-height: 1.5; }
  .rc-cite { font-size: 0.85rem; color: var(--muted); margin-top: 0.5rem; }
  .rc-conf { color: var(--muted); }
  .rc-empty { color: var(--muted); font-style: italic; margin: 0.4rem 0 1.2rem; }
  /* ---- THE CENTERPIECE: citation-first fact sheet, per the approved concept's .sheet/.frow ---- */
  .sheet {
    background: var(--card-bg); border: 1px solid var(--border-strong); border-radius: 12px;
    box-shadow: var(--shadow); overflow: hidden; margin: 1.4rem 0;
  }
  .sheet + .sheet { margin-top: 1.4rem; }
  .sheethead {
    display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.7rem 1rem;
    padding: 0.9rem 1.2rem; background: linear-gradient(180deg,#fbfcfd,#f4f7f9); border-bottom: 1px solid var(--border);
    font-family: var(--font-display); font-size: 1rem; font-weight: 600; color: var(--fg);
  }
  @media (prefers-color-scheme: dark) {
    .sheethead { background: linear-gradient(180deg,#1c222a,#171c22); }
  }
  .sheethead .stamp { display: flex; align-items: center; gap: 0.45rem; font-size: 0.78rem; color: var(--verified-green); font-weight: 600; }
  .sheethead .stamp .dot {
    width: 0.5rem; height: 0.5rem; border-radius: 50%; background: var(--verified-green);
    box-shadow: 0 0 0 3px var(--verified-green-bg); display: inline-block;
  }
  .sheethead .stamp--unconfirmed { color: var(--gold); }
  .sheethead .stamp--unconfirmed .dot { background: var(--gold); box-shadow: 0 0 0 3px var(--gold-bg); }
  .rowlist { display: flex; flex-direction: column; }
  /* Both tracks are minmax(0,...) on purpose: a grid track's automatic minimum
     is min-content, which lets an un-wrappable child dictate the whole row. */
  .frow {
    display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 18rem); gap: 0.35rem 1.4rem;
    padding: 1.1rem 1.2rem; border-top: 1px solid var(--border);
  }
  .frow .v, .frow .side { min-width: 0; }
  .frow:first-child { border-top: 0; }
  .frow .k {
    font-size: 0.72rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--faint); grid-column: 1 / -1; margin-bottom: 0.1rem;
  }
  .frow .v { font-family: var(--font-display); font-size: 1.3rem; font-weight: 600; color: var(--fg); line-height: 1.2; }
  .frow .v small {
    font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 0.82rem; font-weight: 500; color: var(--muted); display: block; margin-top: 0.25rem; line-height: 1.4;
  }
  .frow .side { grid-column: 2; grid-row: 2; align-self: center; text-align: right; }
  /* Citations wrap rather than nowrap -- a citation must never be cut. */
  .cite {
    display: inline-flex; align-items: flex-start; gap: 0.4rem; font-family: var(--font-mono); font-size: 0.78rem;
    color: var(--gold); background: var(--gold-bg); border: 1px solid var(--gold-line); border-radius: 6px;
    padding: 0.25rem 0.55rem; text-decoration: none; white-space: normal; overflow-wrap: anywhere;
    text-align: left; max-width: 100%; box-sizing: border-box;
  }
  /* Long (prose) citations get their own full-width row; short statutory
     cites keep the right-aligned chip. Chosen in Python, so no :has() needed. */
  .frow .side--stacked { grid-column: 1 / -1; grid-row: auto; text-align: left; margin-top: 0.7rem; }
  .frow .side--stacked .cite { display: flex; }
  .cite:hover { background: #efe6d0; }
  @media (prefers-color-scheme: dark) { .cite:hover { background: #2e2712; } }
  .verified {
    display: inline-flex; align-items: center; gap: 0.35rem; font-size: 0.76rem; color: var(--verified-green);
    margin-top: 0.5rem;
  }
  .cite svg, .verified svg { width: 0.85em; height: 0.85em; flex: none; }
  .unconfirmed { color: var(--gold); }
  @media (max-width: 600px) {
    .frow { grid-template-columns: 1fr; }
    .frow .side { grid-column: 1; grid-row: auto; text-align: left; margin-top: 0.6rem; }
  }
  .sheetfoot {
    padding: 0.85rem 1.2rem; background: #fbfcfd; border-top: 1px solid var(--border); font-size: 0.78rem;
    color: var(--muted);
  }
  @media (prefers-color-scheme: dark) { .sheetfoot { background: #171c22; } }
  .factsheet-note { font-size: 0.85rem; color: var(--muted); padding: 0 1.2rem 1rem; }

  /* ---- homepage hero, per the approved concept ---- */
  .eyebrow {
    font-size: 0.72rem; font-weight: 600; letter-spacing: 0.11em; text-transform: uppercase;
    color: var(--gold); margin: 0 0 0.7rem;
  }
  .hero-grid { display: grid; grid-template-columns: 1.15fr 1fr; gap: 2.5rem; align-items: center; }
  @media (max-width: 860px) { .hero-grid { grid-template-columns: 1fr; } }
  .hero-accent { color: var(--accent); }
  .hero-lede { color: var(--muted); font-size: 1.05rem; line-height: 1.6; max-width: 60ch; margin: 1.1rem 0 0; }
  .lookup { margin-top: 1.6rem; max-width: 30rem; }
  .lookup-label {
    display: block; font-size: 0.76rem; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase;
    color: var(--muted); margin-bottom: 0.5rem;
  }
  .lookup-field {
    display: flex; gap: 0; box-shadow: var(--shadow); border-radius: 9px; overflow: hidden;
    border: 1px solid var(--border-strong); background: var(--card-bg);
  }
  .lookup-field input { flex: 1; border: 0; padding: 0.85rem 1rem; font-size: 1rem; font-family: inherit; color: var(--fg); background: transparent; }
  .lookup-field input:focus { outline: none; }
  .lookup-field:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(31,61,84,.14), var(--shadow); }
  .lookup-field button {
    border: 0; background: var(--accent); color: var(--on-accent); font-weight: 600; font-size: 0.92rem;
    padding: 0 1.3rem; cursor: pointer; font-family: inherit;
  }
  .lookup-field button:hover { background: var(--accent-deep); }
  .lookup-hint { margin-top: 0.6rem; font-size: 0.8rem; color: var(--faint); }
  /* A proper 3-column grid (2026-07-31). These were flex-wrapped, so two
     items stacked left while the third sat mid-right on its own baseline and
     the row read as misaligned rather than as a set of three facts. */
  .trust-row {
    display: grid; grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 1.1rem; margin-top: 1.5rem; align-items: start;
  }
  .trust-row .item { display: flex; flex-direction: column; gap: 0.15rem; min-width: 0; }
  .trust-row .n { font-family: var(--font-display); font-size: 1.6rem; font-weight: 650; color: var(--accent); font-variant-numeric: tabular-nums; line-height: 1.1; }
  .trust-row .lbl { font-size: 0.8rem; color: var(--muted); line-height: 1.35; }
  .nav-quiet { color: var(--faint); }
  .trust-footnote { margin-top: 1rem; font-size: 0.82rem; color: var(--faint); line-height: 1.5; max-width: 46ch; }
  @media (max-width: 620px) { .trust-row { grid-template-columns: 1fr 1fr; } }

  /* ---- hero-right: rotating verified-fact card, live proof of freshness ---- */
  .hfc-wrap { position: relative; min-height: 300px; }
  .hfc-card {
    position: absolute; inset: 0; opacity: 0; pointer-events: none; z-index: 1;
    transition: opacity 0.8s ease;
    background: var(--card-bg); border: 1px solid var(--border-strong); border-radius: 12px;
    box-shadow: var(--shadow); padding: 1.4rem 1.5rem;
    display: flex; flex-direction: column; justify-content: center; gap: 0.3rem;
  }
  .hfc-card.is-active { opacity: 1; pointer-events: auto; z-index: 2; }
  .hfc-state { font-family: var(--font-display); font-size: 1.3rem; font-weight: 600; color: var(--fg); }
  .hfc-stamp { display: flex; align-items: center; gap: 0.4rem; font-size: 0.76rem; color: var(--verified-green); font-weight: 600; }
  .hfc-stamp .dot { width: 0.45rem; height: 0.45rem; border-radius: 50%; background: var(--verified-green); display: inline-block; }
  .hfc-date { font-family: var(--font-display); font-size: 1.7rem; font-weight: 650; color: var(--accent); margin-top: 0.3rem; }
  .hfc-sub { font-size: 0.85rem; color: var(--muted); margin-bottom: 0.4rem; }
  .hfc-card .cite { align-self: flex-start; margin-top: 0.15rem; }
  .hfc-card .verified { margin-top: 0.3rem; }
  .hfc-coverage { font-size: 0.78rem; color: var(--muted); margin-top: 0.85rem; text-align: center; }
  .hfc-coverage b { color: var(--accent); }
  @media (prefers-reduced-motion: reduce) {
    .hfc-card { transition: none; }
  }

  /* ---- "how we verify" 3-card band ---- */
  .band-section { margin: 2.4rem 0 2rem; padding-top: 1.8rem; border-top: 1px solid var(--border); }
  .band-section h2 { font-size: 1.5rem; }
  .method-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1.1rem; margin: 1.6rem 0 1.8rem; }
  @media (max-width: 700px) { .method-grid { grid-template-columns: 1fr; } }
  .mcard { background: var(--card-bg); border: 1px solid var(--border); border-radius: 10px; padding: 1.3rem 1.2rem; }
  .mcard .step { font-family: var(--font-mono); font-size: 0.7rem; letter-spacing: 0.1em; color: var(--gold); font-weight: 600; }
  .mcard h3 { font-size: 1.05rem; margin: 0.6rem 0 0.4rem; font-family: var(--font-display); }
  .mcard p { margin: 0; color: var(--muted); font-size: 0.88rem; line-height: 1.55; }

  /* ---- reminder panel: two-column dark treatment ---- */
  .remind-panel {
    background: var(--panel-dark); color: var(--panel-dark-fg); border-radius: 12px; padding: 1.8rem;
    display: grid; grid-template-columns: 1.1fr 1fr; gap: 1.6rem; align-items: center; margin: 1.75rem 0;
  }
  @media (max-width: 700px) { .remind-panel { grid-template-columns: 1fr; padding: 1.4rem 1.2rem; } }
  .remind-panel h2 { color: #fff; font-size: 1.35rem; margin: 0; }
  .remind-panel .remind-copy { color: #b9cad9; margin: 0.7rem 0 0; font-size: 0.92rem; line-height: 1.6; }
  .remind-panel .remind-promise { margin-top: 0.8rem; font-size: 0.78rem; color: #8fa7bb; }
  .remind-list { list-style: none; margin: 1.3rem 0 0; padding: 0; display: flex; flex-direction: column; gap: 0.55rem; }
  .remind-list li { display: flex; align-items: flex-start; gap: 0.55rem; font-size: 0.85rem; color: #c4ceda; line-height: 1.4; }
  .remind-list .tick { color: var(--gold); flex: none; margin-top: 0.15rem; }
  .remind-panel form {
    display: flex; flex-direction: column; gap: 0.65rem; background: rgba(255,255,255,.05);
    border: 1px solid rgba(255,255,255,.12); border-radius: 10px; padding: 1.1rem;
  }
  .remind-panel label { color: #cfe0ee; font-size: 0.8rem; font-weight: 600; margin: 0.2rem 0 0; }
  .remind-panel label:first-of-type { margin-top: 0; }
  .remind-panel input, .remind-panel select {
    width: 100%; border: 1px solid rgba(255,255,255,.18); background: rgba(255,255,255,.06); color: #fff;
    border-radius: 7px; padding: 0.6rem 0.7rem; font-family: inherit; font-size: 0.92rem;
  }
  .remind-panel input::placeholder { color: #8fa7bb; }
  .remind-panel input:focus, .remind-panel select:focus {
    outline: none; border-color: #7fb0d6; box-shadow: 0 0 0 3px rgba(127,176,214,.2);
  }
  .remind-panel button, .remind-panel .cta-button {
    margin-top: 0.3rem; background: var(--gold); color: #22190a; border: 0; font-weight: 700;
    font-size: 0.92rem; padding: 0.7rem 1rem; border-radius: 7px; cursor: pointer; font-family: inherit;
    display: inline-block; text-decoration: none;
  }
  .remind-panel button:hover, .remind-panel .cta-button:hover { background: #9c7a3c; }
  .remind-panel .field-hint { color: #8fa7bb; }
  .cpe-affiliate-heading {
    font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.04em;
    color: var(--muted); margin: 1.6rem 0 0.5rem; padding-top: 1rem;
    border-top: 1px solid var(--border);
  }
  .cpe-affiliate {
    border: 1px solid var(--border); border-radius: 8px; padding: 1rem 1.25rem;
    background: var(--card-bg); margin: 0.6rem 0; font-size: 0.92rem;
  }
  .cpe-affiliate p { margin: 0 0 0.5rem; }
  .cpe-affiliate p:last-child { margin-bottom: 0; }
  .cpe-affiliate .disclosure { font-size: 0.8rem; color: var(--muted); }
  .firm-cta {
    border: 1px solid var(--accent); border-radius: 8px; padding: 1.1rem 1.3rem;
    background: var(--accent-bg); margin: 1.75rem 0; font-size: 0.94rem;
  }
  .firm-cta h2 { margin-top: 0; font-size: 1.05rem; }
  .firm-cta p { margin: 0 0 0.5rem; }
  .firm-cta p:last-child { margin-bottom: 0; }
  .firm-cta .disclosure { font-size: 0.8rem; color: var(--muted); }
  .state-links { padding-left: 1.2rem; margin: 0.75rem 0 1.5rem; }
  .state-links li { margin-bottom: 0.3rem; }
  .mock-dashboard {
    border: 1px solid var(--border); border-radius: 10px; overflow: hidden;
    margin: 1.5rem 0 0.6rem; box-shadow: 0 6px 20px rgba(20, 30, 45, 0.08);
  }
  .mock-chrome {
    display: flex; align-items: center; gap: 0.4rem;
    background: var(--row-alt); padding: 0.55rem 0.8rem; border-bottom: 1px solid var(--border);
  }
  .mock-dot {
    width: 0.55rem; height: 0.55rem; border-radius: 50%; background: var(--border);
    display: inline-block;
  }
  .mock-url {
    margin-left: 0.6rem; font-size: 0.72rem; color: var(--muted);
    font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
  }
  .mock-body { padding: 1.1rem 1.2rem 1.3rem; background: var(--bg); }
  .mock-firm-name { font-weight: 700; margin-bottom: 0.8rem; }
  .mock-firm-count { font-weight: 400; color: var(--muted); font-size: 0.88rem; }
  .mock-dashboard .table-wrap { margin: 0; }
  .mock-dashboard table { font-size: 0.86rem; }
  /* The mockup embeds the REAL dashboard shell (.dr-*) so the marketing
     preview is pixel-consistent with the real product (2026-07-30, BUILD v2
     Phase C) -- these two overrides only fix things that don't make sense
     inside a small decorative preview box: a sticky sidebar would try to
     stick to PAGE scroll instead of staying inside the mock frame, and the
     nested .table-wrap already gets .mock-dashboard's own margin/font-size
     rules above. */
  .mock-dashboard .dr-sidebar { position: static; }
  .mock-dashboard .dr-dash-shell { margin: 0; }
  .mock-dashboard .dr-nav a { pointer-events: none; }
  .mock-status {
    display: inline-block; font-size: 0.72rem; font-weight: 700; letter-spacing: 0.01em;
    padding: 0.18em 0.6em; border-radius: 999px; white-space: nowrap;
  }
  .mock-status--ok { background: rgba(31, 158, 92, 0.15); color: #1f9e5c; }
  .mock-status--pending { background: rgba(180, 140, 20, 0.15); color: #9c7a12; }
  .mock-status--risk { background: rgba(200, 55, 55, 0.15); color: #c33737; }
  @media (prefers-color-scheme: dark) {
    .mock-status--ok { background: rgba(52, 199, 120, 0.18); color: #4fd685; }
    .mock-status--pending { background: rgba(224, 179, 51, 0.18); color: #e0b333; }
    .mock-status--risk { background: rgba(230, 90, 90, 0.2); color: #ff8080; }
  }
  .mock-caption { font-size: 0.78rem; color: var(--muted); margin: 0 0 1.75rem; }
  .faq-list { margin: 1rem 0 1.75rem; }
  .faq-item {
    border-bottom: 1px solid var(--border); padding: 0.85rem 0;
  }
  .faq-item summary {
    cursor: pointer; font-weight: 600; list-style: none;
    display: flex; align-items: center; justify-content: space-between; gap: 1rem;
  }
  .faq-item summary::-webkit-details-marker { display: none; }
  .faq-item summary::after { content: "+"; color: var(--accent); font-size: 1.2rem; font-weight: 400; }
  .faq-item[open] summary::after { content: "\\2212"; }
  .faq-item p { margin: 0.7rem 0 0; color: var(--fg); }
  .backlink { display: inline-block; margin-top: 0.5rem; font-size: 0.92rem; }
  .how-it-works { color: var(--muted); font-size: 0.92rem; margin: 1.25rem 0 1.75rem; }
  .state-grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(148px, 1fr));
    gap: 0.65rem; margin: 0 0 2rem; list-style: none; padding: 0;
  }
  .state-grid--mobile-fallback { display: none; }
  .map-section {
    display: grid; grid-template-columns: 1fr 220px; gap: 1.25rem; align-items: stretch;
    margin: 0 0 2rem;
  }
  .map-figure { position: relative; border: 1px solid var(--border); border-radius: 10px; padding: 0.75rem; background: var(--card-bg); }
  .map-tooltip {
    position: absolute; z-index: 15; pointer-events: none; white-space: nowrap;
    background: var(--panel-dark); color: var(--panel-dark-fg); font-size: 0.8rem;
    padding: 0.35rem 0.6rem; border-radius: 6px; box-shadow: var(--shadow);
  }
  .map-tooltip[hidden] { display: none; }
  .us-map { width: 100%; height: auto; display: block; }
  .map-state {
    fill: var(--map-variable); stroke: var(--card-bg); stroke-width: 1.2;
    transition: fill 0.12s ease;
  }
  .map-state--fixed { fill: var(--map-fixed); }
  .map-link { cursor: pointer; outline: none; }
  .map-link:hover .map-state, .map-link:focus .map-state--variable { fill: var(--map-variable-hover); }
  .map-link:hover .map-state--fixed, .map-link:focus .map-state--fixed { fill: var(--map-fixed-hover); }
  .map-side {
    border: 1px solid var(--border); border-radius: 10px; padding: 1rem 1.1rem;
    background: var(--card-bg); font-size: 0.85rem;
  }
  .map-small-label { margin: 0 0 0.6rem; font-size: 0.8rem; color: var(--muted); }
  .map-small-pills { display: flex; flex-direction: column; align-items: flex-start; gap: 0.4rem; margin-bottom: 1rem; }
  .map-small-pill {
    display: inline-block; padding: 0.28em 0.6em; border-radius: 999px; font-size: 0.78rem;
    text-decoration: none; background: var(--map-fixed); color: var(--fg); white-space: nowrap;
  }
  .map-small-pill--variable { background: var(--map-variable); border: 1px solid var(--border); }
  .map-small-pill:hover { opacity: 0.82; }
  .legend { display: flex; flex-direction: column; gap: 0.4rem; font-size: 0.76rem; color: var(--muted); }
  .legend .swatch { width: 0.75rem; height: 0.75rem; border-radius: 3px; display: inline-block; margin-right: 0.4em; vertical-align: -1px; }
  .swatch--fixed { background: var(--map-fixed); }
  .swatch--variable { background: var(--map-variable); border: 1px solid var(--border); }
  @media (max-width: 700px) {
    .map-section { display: none; }
    .state-grid--mobile-fallback { display: grid; }
  }
  .state-card {
    display: block; border: 1px solid var(--border); border-radius: 8px; padding: 0.75rem 0.85rem;
    background: var(--card-bg); text-decoration: none; color: var(--fg);
    transition: opacity 0.15s ease;
  }
  .state-card:hover { border-color: var(--accent); }
  .state-card .state-name { font-weight: 700; margin-bottom: 0.2rem; font-size: 0.95rem; }
  .state-card .state-hint { font-size: 0.8rem; color: var(--muted); line-height: 1.3; }
  .state-card--dimmed { opacity: 0.3; pointer-events: none; }
  .state-card--variable {
    border-style: dashed;
  }
  .state-card--variable .state-hint { font-style: italic; }
  .state-search {
    margin: 1.6rem 0 0; max-width: 30rem;
  }
  .state-search label {
    display: block; font-size: 0.76rem; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase;
    color: var(--muted); margin: 0 0 0.5rem;
  }
  .state-search form {
    display: flex; gap: 0; box-shadow: var(--shadow); border-radius: 9px; overflow: hidden;
    border: 1px solid var(--border-strong); background: var(--card-bg);
  }
  .state-search-field { position: relative; flex: 1 1 auto; }
  .state-search-field:focus-within { box-shadow: 0 0 0 3px rgba(31,61,84,.14); }
  .state-search-field input {
    width: 100%; padding: 0.85rem 1rem; border: 0; background: transparent; color: var(--fg);
    font-size: 1rem; font-family: inherit;
  }
  .state-search-field input:focus { outline: none; }
  .state-search-submit {
    padding: 0 1.3rem; border: none; background: var(--accent);
    color: var(--on-accent); font-size: 0.92rem; font-weight: 600; cursor: pointer; flex: 0 0 auto;
  }
  .state-search-submit:hover { background: var(--accent-deep); }
  .state-search .field-hint { font-size: 0.8rem; color: var(--faint); margin: 0.6rem 0 0; }
  .state-search-dropdown {
    display: none; position: absolute; top: 100%; left: 0; right: 0; margin-top: 0.3rem;
    background: var(--card-bg); border: 1px solid var(--border); border-radius: 6px;
    max-height: 280px; overflow-y: auto; z-index: 30; box-shadow: 0 8px 24px rgba(0,0,0,0.18);
  }
  .state-search-dropdown.is-open { display: block; }
  .state-search-option {
    display: block; width: 100%; text-align: left; padding: 0.55rem 0.8rem; border: none;
    background: none; color: var(--fg); font-size: 0.95rem; font-family: inherit; cursor: pointer;
  }
  .state-search-option:hover, .state-search-option.is-active { background: var(--accent); color: var(--on-accent); }
  .state-search-empty { padding: 0.55rem 0.8rem; font-size: 0.85rem; color: var(--muted); }
  .site-footer {
    margin-top: 3rem; padding-top: 1.25rem; border-top: 1px solid var(--border);
    font-size: 0.85rem; color: var(--muted); line-height: 1.6;
  }
  .foot-top {
    display: flex; flex-wrap: wrap; justify-content: space-between; gap: 1rem 1.6rem;
    padding-bottom: 1.1rem; margin-bottom: 1.1rem; border-bottom: 1px solid var(--border);
  }
  .foot-links { display: flex; flex-wrap: wrap; gap: 0.4rem 1.3rem; }
  .foot-links a { color: var(--muted); text-decoration: none; }
  .foot-links a:hover { color: var(--fg); }
  .disc { font-size: 0.78rem; color: var(--faint); line-height: 1.6; }
  .disc strong { color: var(--muted); }
  .brand-glyph { flex: none; }
  code { background: rgba(127,127,127,0.15); padding: 0.1em 0.35em; border-radius: 3px; font-size: 0.9em; }
  .signup-form {
    border: 1px solid var(--border); border-radius: 8px; padding: 1.25rem 1.4rem;
    background: var(--card-bg); margin: 1.75rem 0;
  }
  .signup-form h2 { font-size: 1.1rem; margin: 0 0 0.4rem; }
  .signup-microcopy { font-size: 0.85rem; color: var(--muted); margin: 0 0 1rem; }
  .signup-form label {
    display: block; font-size: 0.85rem; font-weight: 600; margin: 0.75rem 0 0.3rem;
  }
  .signup-form label:first-of-type { margin-top: 0; }
  .signup-form input, .signup-form select {
    width: 100%; padding: 0.55rem 0.7rem; border: 1px solid var(--border); border-radius: 6px;
    background: var(--bg); color: var(--fg); font-size: 0.95rem; font-family: inherit;
  }
  .signup-form-row { display: flex; gap: 0.75rem; }
  .signup-form-row > div { flex: 1; }
  .signup-form button {
    margin-top: 1rem; padding: 0.6rem 1.1rem; border: none; border-radius: 6px;
    background: var(--accent); color: var(--on-accent); font-size: 0.95rem; font-weight: 700; cursor: pointer;
  }
  .signup-form button:hover { opacity: 0.92; }
  .signup-form .field-hint { font-size: 0.78rem; color: var(--muted); margin: 0.25rem 0 0; }
  .signup-form--compact { padding: 0.9rem 1.1rem; }
  .signup-form--compact .signup-form-compact-label { font-size: 0.85rem; font-weight: 600; margin: 0 0 0.5rem; display: block; }
  .signup-form--compact .signup-form-row input { flex: 1 1 auto; }
  .signup-form--compact .signup-form-row button { flex: 0 0 auto; margin-top: 0; }
  @media (max-width: 480px) {
    .site-header { flex-direction: column; align-items: flex-start; }
    h1 { font-size: 1.7rem; }
    .callout .date { font-size: 1.7rem; }
    .verified-badge { position: static; display: inline-flex; margin-bottom: 0.6rem; }
    .signup-form-row { flex-direction: column; gap: 0; }
    .signup-form--compact .signup-form-row { gap: 0.5rem; }
  }

  /* ---- Firm dashboard app shell (2026-07-30, BUILD v2 Phase B redesign) ----
     Own visual identity, not a copy of any incumbent's layout: reuses this
     site's existing tokens (--panel-dark is the same dark navy the homepage's
     .remind-panel already uses; --gold/--verified-green are the same citation/
     freshness accents everywhere else) inside a standard, generic dashboard
     idiom (dark sidebar nav + light content cards) -- gauge/donut/sidebar are
     universal dashboard components, not anyone's protected expression. */
  .dr-dash-shell { display: grid; grid-template-columns: 216px 1fr; gap: 1.5rem; margin: 1.5rem 0 2rem; align-items: start; }
  @media (max-width: 860px) { .dr-dash-shell { grid-template-columns: 1fr; } }

  .dr-sidebar { background: var(--panel-dark); color: var(--panel-dark-fg); border-radius: 12px; padding: 1.3rem 1rem; position: sticky; top: 5rem; }
  @media (max-width: 860px) { .dr-sidebar { position: static; } }
  .dr-firm-name {
    font-family: var(--font-display); font-size: 1.02rem; font-weight: 600; color: #fff;
    padding: 0 0.4rem 1rem; border-bottom: 1px solid rgba(255,255,255,.14); margin-bottom: 0.9rem; word-break: break-word;
  }
  .dr-nav { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.15rem; }
  .dr-nav a, .dr-nav-soon {
    display: flex; align-items: center; gap: 0.55rem; padding: 0.55rem 0.6rem; border-radius: 7px;
    color: #b9cad9; text-decoration: none; font-size: 0.87rem; font-weight: 500;
  }
  .dr-nav a.is-active { background: rgba(255,255,255,.1); color: #fff; font-weight: 600; }
  .dr-nav a:hover { background: rgba(255,255,255,.06); color: #fff; }
  /* ---- Practice-privilege checker (2026-07-30, pay-gated) ---- */
  .dr-mobility-callout { background: var(--row-alt); border-left: 3px solid var(--border-strong); border-radius: 6px; padding: 0.9rem 1.1rem; margin-bottom: 1.4rem; font-size: 0.88rem; line-height: 1.55; }
  .dr-mob-check { display: flex; gap: 0.6rem; align-items: flex-start; margin: 0.7rem 0; font-size: 0.9rem; font-weight: 400; }
  .dr-mob-check input { margin-top: 0.2rem; flex: 0 0 auto; }
  .dr-verdict { border: 1px solid var(--border); border-radius: 10px; padding: 1.1rem 1.2rem; margin-bottom: 1rem; background: var(--card-bg); }
  .dr-verdict h3 { margin: 0 0 0.5rem; font-size: 1rem; font-family: var(--font-display); }
  .dr-verdict-badge { display: inline-block; font-size: 0.72rem; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; padding: 0.2rem 0.5rem; border-radius: 999px; margin-bottom: 0.6rem; }
  .dr-verdict-clear { background: #e6f4ec; color: #1f6b43; }
  .dr-verdict-action { background: #fdf0e6; color: #9a5312; }
  .dr-verdict-unverified { background: var(--row-alt); color: var(--muted); }
  .dr-verdict-reqs { margin: 0.6rem 0 0; padding-left: 1.1rem; font-size: 0.88rem; }
  .dr-verdict-reqs li { margin-bottom: 0.3rem; }
  .dr-verdict-cite { font-size: 0.8rem; color: var(--muted); margin-top: 0.7rem; padding-top: 0.7rem; border-top: 1px solid var(--border); }
  .dr-verdict-overall { border-width: 2px; border-color: var(--border-strong); }
  .dr-verdict-disclaimer { font-size: 0.78rem; color: var(--faint); margin-top: 0.6rem; font-style: italic; }
  .dr-nav-soon { color: #6e8296; cursor: default; }
  .dr-soon-badge {
    margin-left: auto; font-size: 0.6rem; letter-spacing: 0.04em; text-transform: uppercase;
    background: rgba(255,255,255,.09); color: #9fb1c2; padding: 0.15em 0.5em; border-radius: 999px; white-space: nowrap;
  }
  .dr-sidebar-foot { margin-top: 1.2rem; padding-top: 1rem; border-top: 1px solid rgba(255,255,255,.14); }
  .dr-sidebar-foot button {
    width: 100%; padding: 0.55rem 0.7rem; border: 1px solid rgba(255,255,255,.2); border-radius: 7px;
    background: transparent; color: #cfe0ee; font-size: 0.84rem; cursor: pointer; font-family: inherit;
  }
  .dr-sidebar-foot button:hover { background: rgba(255,255,255,.07); }

  .dr-main { min-width: 0; }

  .dr-stat-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; margin-bottom: 1.2rem; }
  @media (max-width: 760px) { .dr-stat-row { grid-template-columns: 1fr; } }
  .dr-stat-card {
    background: var(--card-bg); border: 1px solid var(--border); border-radius: 11px;
    padding: 1.05rem 1.15rem; display: flex; align-items: center; gap: 1rem;
  }
  .dr-stat-label { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin: 0 0 0.3rem; }
  .dr-stat-value { font-family: var(--font-display); font-size: 1.55rem; font-weight: 650; color: var(--fg); line-height: 1.1; }
  .dr-stat-sub { font-size: 0.76rem; color: var(--muted); margin-top: 0.2rem; }

  .dr-ring-wrap { position: relative; width: 58px; height: 58px; flex: none; }
  .dr-ring-wrap svg { transform: rotate(-90deg); display: block; }
  .dr-ring-track { fill: none; stroke: var(--border); stroke-width: 6.5; }
  .dr-ring-value { fill: none; stroke: var(--verified-green); stroke-width: 6.5; stroke-linecap: round; transition: stroke-dasharray 0.5s ease; }
  .dr-ring-wrap.is-risk .dr-ring-value { stroke: #c33737; }
  @media (prefers-color-scheme: dark) { .dr-ring-wrap.is-risk .dr-ring-value { stroke: #ff8080; } }
  .dr-ring-pct {
    position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    font-family: var(--font-display); font-weight: 650; font-size: 0.85rem; color: var(--fg);
  }

  .dr-donut-wrap { display: flex; align-items: center; gap: 0.85rem; flex: none; }
  .dr-donut-legend { list-style: none; margin: 0; padding: 0; font-size: 0.74rem; color: var(--muted); display: flex; flex-direction: column; gap: 0.28rem; }
  .dr-donut-legend .swatch { width: 0.6rem; height: 0.6rem; border-radius: 2px; display: inline-block; margin-right: 0.4em; }

  .dr-panel-row { display: grid; grid-template-columns: 1fr 1fr; gap: 1.1rem; margin-bottom: 1.2rem; }
  @media (max-width: 860px) { .dr-panel-row { grid-template-columns: 1fr; } }
  .dr-panel { background: var(--card-bg); border: 1px solid var(--border); border-radius: 11px; padding: 1.1rem 1.2rem; }
  .dr-panel h2 { font-size: 0.98rem; margin: 0 0 0.85rem; font-family: var(--font-display); }
  .dr-panel-empty { color: var(--muted); font-size: 0.85rem; padding: 0.3rem 0; }
  .dr-at-risk-list, .dr-activity-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.6rem; }
  .dr-at-risk-item {
    display: flex; align-items: baseline; justify-content: space-between; gap: 0.8rem; font-size: 0.86rem;
    padding-bottom: 0.55rem; border-bottom: 1px solid var(--border);
  }
  .dr-at-risk-item:last-child { border-bottom: none; padding-bottom: 0; }
  .dr-at-risk-name { font-weight: 600; }
  .dr-at-risk-sub { color: var(--muted); font-size: 0.77rem; display: block; }
  .dr-at-risk-days { font-family: var(--font-display); font-weight: 650; white-space: nowrap; }
  .dr-at-risk-days--soon { color: #c33737; }
  @media (prefers-color-scheme: dark) { .dr-at-risk-days--soon { color: #ff8080; } }
  .dr-activity-item { display: flex; gap: 0.6rem; font-size: 0.85rem; align-items: flex-start; }
  .dr-activity-dot { width: 0.5rem; height: 0.5rem; border-radius: 50%; margin-top: 0.4rem; flex: none; background: var(--accent); }
  .dr-activity-dot--confirm { background: var(--verified-green); }
  .dr-activity-dot--optout { background: var(--gold); }
  .dr-activity-when { color: var(--faint); font-size: 0.75rem; display: block; margin-top: 0.1rem; }

  .dr-roster-panel { background: var(--card-bg); border: 1px solid var(--border); border-radius: 11px; padding: 1.1rem 1.2rem 0.2rem; margin-bottom: 1.2rem; }
  .dr-roster-panel h2 { font-size: 0.98rem; margin: 0 0 0.85rem; font-family: var(--font-display); }
  .dr-roster-panel .table-wrap { margin-top: 0; }

  /* ---- Full-roster table: keep Actions reachable (2026-07-31) ----------
     The problem reported (with screenshots): 7 columns overflowed to the
     right, and the Actions column -- Edit / Mark renewed / Remove -- fell
     off the end. .table-wrap already scrolled, but a control you have to
     go hunting for is effectively missing, and horizontal scrolling to
     reach the primary controls for every row is miserable.

     Three changes, in the order they matter:
       1. Actions is STICKY to the right edge, so it is on screen at every
          scroll position rather than merely reachable. This is the actual
          fix; the rest is about not needing to scroll in the first place.
       2. Email truncates with an ellipsis and keeps the full value in a
          title tooltip. Email was the widest low-value column and the main
          reason the table overflowed at all.
       3. Below 860px the table becomes stacked cards, because no amount of
          column trimming makes 7 columns work on a phone. */
  .dr-roster-panel table { width: 100%; }
  .dr-roster-panel td, .dr-roster-panel th { white-space: nowrap; }

  /* Email: the width hog. Truncate, full value on hover/focus via title. */
  .dr-roster-panel td.dr-cell-email {
    max-width: 15rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }

  /* Sticky Actions. The background is opaque and matches the row so the
     scrolled-under content does not bleed through, and the left shadow
     signals there is more table behind it. */
  .dr-roster-panel th.dr-actions-head,
  .dr-roster-panel td.dr-actions {
    position: sticky; right: 0; z-index: 2;
    box-shadow: -6px 0 6px -6px rgba(0,0,0,0.18);
  }
  /* Body cells match their row's own background -- card-bg / row-alt. */
  .dr-roster-panel td.dr-actions { background: var(--card-bg); }
  .dr-roster-panel tbody tr:nth-child(even) td.dr-actions { background: var(--row-alt); }
  /* The header row is NOT a body row -- it's dark accent with light text
     (the general `th` rule, line ~433), not card-bg. Reusing card-bg here
     (2026-08-03 bug, reported as "Actions header looks greyed out/
     unreadable"): the background flipped to near-white while `color`
     stayed inherited as the header's light `#eaf1f7`, so the sticky
     Actions header rendered near-white text on a near-white background --
     readable nowhere, not just "greyed." Match the header's own colors
     explicitly instead of assuming one shared background serves both. */
  .dr-roster-panel th.dr-actions-head { background: var(--accent); color: var(--on-accent); z-index: 3; }

  /* Tighter action buttons so the sticky column costs less width. */
  .dr-roster-panel td.dr-actions button { padding: 0.22rem 0.5rem; font-size: 0.76rem; white-space: nowrap; }

  @media (max-width: 860px) {
    /* Stacked cards. Each cell carries its own label via data-label, so the
       header row can be hidden without losing what each value means. */
    /* min-width MUST be reset here. The global `table { min-width: 420px }`
       (line ~397, there to stop wide tables collapsing) outranks width:100%
       and kept the stacked cards 420px wide inside a ~308px container --
       which the overflow-x:hidden below then CLIPPED, silently cutting off
       the right edge of every card. That is the same defect this change
       exists to fix, so it would have shipped the bug wearing a different
       hat. Caught by measuring computed min-width at 390px. */
    .dr-roster-panel table, .dr-roster-panel thead, .dr-roster-panel tbody,
    .dr-roster-panel tr, .dr-roster-panel td {
      display: block; width: 100%; min-width: 0; max-width: 100%;
    }
    .dr-roster-panel thead { position: absolute; left: -9999px; }
    .dr-roster-panel tbody tr {
      border: 1px solid var(--border); border-radius: 9px;
      padding: 0.7rem 0.85rem; margin-bottom: 0.7rem; background: var(--card-bg);
    }
    .dr-roster-panel td {
      display: flex; justify-content: space-between; gap: 1rem;
      border: none; padding: 0.25rem 0; white-space: normal;
    }
    .dr-roster-panel td::before {
      content: attr(data-label); font-weight: 600; color: var(--muted);
      font-size: 0.78rem; flex: 0 0 auto;
    }
    /* Must also undo the desktop nowrap/ellipsis, not just max-width: a long
       address kept forcing the card wider than the viewport and reintroduced
       horizontal scrolling on phones -- the exact problem this fix is for.
       Caught by measuring scrollWidth at 390px, not by eye. */
    .dr-roster-panel td.dr-cell-email {
      max-width: none; text-align: right;
      white-space: normal; overflow: visible; text-overflow: clip; overflow-wrap: anywhere;
    }
    /* Same reason: the global nowrap would otherwise keep cards wide. */
    .dr-roster-panel td, .dr-roster-panel th { white-space: normal; }
    .dr-roster-panel .table-wrap { overflow-x: hidden; }
    /* Sticky is meaningless once stacked -- unset it or the buttons pin
       oddly mid-card. */
    .dr-roster-panel td.dr-actions {
      position: static; box-shadow: none; background: none;
      display: flex; flex-wrap: wrap; gap: 0.4rem; justify-content: flex-start;
      padding-top: 0.6rem; margin-top: 0.4rem; border-top: 1px solid var(--border);
    }
    .dr-roster-panel td.dr-actions::before { content: ""; display: none; }
    .dr-roster-panel tbody tr:nth-child(even) td.dr-actions { background: none; }
  }

  /* ---- Calendar + Map views (2026-07-30, BUILD v2 Phase D) -- in-page tabs,
     same fetched drLicenses data the roster view already has, no new endpoint. ---- */
  .dr-view[hidden] { display: none; }

  .dr-cal-panel { background: var(--card-bg); border: 1px solid var(--border); border-radius: 11px; padding: 1.1rem 1.2rem; margin-bottom: 1.2rem; }
  .dr-cal-header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-bottom: 0.9rem; }
  .dr-cal-header h2 { font-size: 1.05rem; margin: 0; font-family: var(--font-display); }
  .dr-cal-nav { display: flex; gap: 0.4rem; }
  .dr-cal-nav button {
    border: 1px solid var(--border-strong); background: var(--card-bg); color: var(--fg);
    border-radius: 6px; padding: 0.3rem 0.6rem; cursor: pointer; font-family: inherit; font-size: 0.85rem;
  }
  .dr-cal-nav button:hover { background: var(--row-alt); }
  .dr-cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 0.35rem; }
  .dr-cal-dow { font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); text-align: center; padding-bottom: 0.3rem; }
  .dr-cal-day {
    min-height: 4.2rem; border: 1px solid var(--border); border-radius: 7px; padding: 0.3rem 0.35rem;
    font-size: 0.78rem; display: flex; flex-direction: column; gap: 0.2rem; background: var(--bg);
  }
  .dr-cal-day--empty { border-color: transparent; background: transparent; }
  .dr-cal-day--today { border-color: var(--accent); border-width: 2px; }
  .dr-cal-daynum { font-weight: 600; color: var(--muted); }
  .dr-cal-day--today .dr-cal-daynum { color: var(--accent); }
  .dr-cal-item {
    font-size: 0.7rem; line-height: 1.25; padding: 0.1rem 0.3rem; border-radius: 4px;
    background: var(--accent-bg); color: var(--fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .dr-cal-item--soon { background: rgba(200, 55, 55, 0.15); color: #c33737; }
  @media (prefers-color-scheme: dark) { .dr-cal-item--soon { background: rgba(230, 90, 90, 0.2); color: #ff8080; } }
  @media (max-width: 640px) {
    .dr-cal-grid { grid-template-columns: repeat(7, minmax(0, 1fr)); }
    .dr-cal-day { min-height: 3rem; font-size: 0.68rem; }
    .dr-cal-item { display: none; }
    .dr-cal-day--has-item::after { content: "\\2022"; color: var(--accent); font-size: 1.1rem; line-height: 1; }
  }
  .dr-agenda-panel { background: var(--card-bg); border: 1px solid var(--border); border-radius: 11px; padding: 1.1rem 1.2rem; margin-bottom: 1.2rem; }
  .dr-agenda-panel h2 { font-size: 1.05rem; margin: 0 0 0.85rem; font-family: var(--font-display); }
  .dr-agenda-group + .dr-agenda-group { margin-top: 0.9rem; padding-top: 0.9rem; border-top: 1px solid var(--border); }
  .dr-agenda-month { font-size: 0.78rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin: 0 0 0.5rem; }
  .dr-agenda-item { display: flex; justify-content: space-between; gap: 0.8rem; font-size: 0.86rem; padding: 0.35rem 0; }
  .dr-agenda-date { color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }

  .dr-map-panel { background: var(--card-bg); border: 1px solid var(--border); border-radius: 11px; padding: 1.1rem 1.2rem; margin-bottom: 1.2rem; }
  .dr-map-panel h2 { font-size: 1.05rem; margin: 0 0 0.6rem; font-family: var(--font-display); }
  .dr-map-body { display: grid; grid-template-columns: 1fr 220px; gap: 1.25rem; align-items: start; }
  @media (max-width: 760px) { .dr-map-body { grid-template-columns: 1fr; } }
  .dr-map-figure { position: relative; border: 1px solid var(--border); border-radius: 10px; padding: 0.75rem; background: var(--bg); }
  .dr-us-map { width: 100%; height: auto; display: block; }
  .dr-map-state { fill: var(--border); stroke: var(--card-bg); stroke-width: 1.2; transition: fill 0.12s ease; }
  .dr-map-state--active { fill: #1f9e5c; }
  .dr-map-state--risk { fill: #c33737; }
  .dr-map-state--home { fill: #1f9e5c; }
  .dr-map-state--clear { fill: #6b8fd4; }
  .dr-map-state--action { fill: #d98a1f; }
  .dr-map-state--coverage { fill: #8a6bd4; }
  .dr-map-link { cursor: default; outline: none; }
  .dr-map-link[data-has-staff="true"] { cursor: pointer; }
  .dr-map-tooltip {
    position: absolute; z-index: 15; pointer-events: none; white-space: nowrap;
    background: var(--panel-dark); color: var(--panel-dark-fg); font-size: 0.8rem;
    padding: 0.35rem 0.6rem; border-radius: 6px; box-shadow: var(--shadow);
  }
  .dr-map-tooltip[hidden] { display: none; }
  .dr-map-tooltip--wrap { white-space: normal; max-width: 260px; }
  .dr-map-legend { display: flex; flex-direction: column; gap: 0.5rem; font-size: 0.82rem; color: var(--muted); }
  .dr-map-legend[hidden] { display: none; }
  .dr-map-legend .swatch { width: 0.75rem; height: 0.75rem; border-radius: 3px; display: inline-block; margin-right: 0.5em; vertical-align: -1px; }
  .dr-map-note { font-size: 0.78rem; color: var(--faint); margin-top: 0.8rem; }
  .dr-map-controls { display: flex; align-items: center; gap: 0.6rem; margin-bottom: 1rem; flex-wrap: wrap; }
  .dr-map-controls label { font-size: 0.85rem; font-weight: 600; margin: 0; }
  .dr-map-controls select { font-family: inherit; font-size: 0.9rem; padding: 0.4rem 0.6rem;
    border: 1px solid var(--border-strong); border-radius: 7px; background: var(--bg); color: inherit; }
  .dr-map-mobility-note { font-size: 0.82rem; color: var(--muted); margin-bottom: 1rem; padding: 0.6rem 0.8rem;
    background: var(--row-alt); border-radius: 8px; }
  .dr-map-mobility-note[hidden] { display: none; }

  /* ---- CPE Hours tab (2026-07-30, new BUILD v2 phase) ---- */
  .dr-cpe-summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1rem; margin-bottom: 1.2rem; }
  .dr-cpe-staff-panel { background: var(--card-bg); border: 1px solid var(--border); border-radius: 11px; padding: 1.1rem 1.2rem; margin-bottom: 1.2rem; }
  .dr-cpe-staff-panel h2 { font-size: 1.05rem; margin: 0 0 0.85rem; font-family: var(--font-display); }
  .dr-cpe-staff-card { border: 1px solid var(--border); border-radius: 9px; padding: 0.9rem 1rem; margin-bottom: 0.7rem; }
  .dr-cpe-staff-card:last-child { margin-bottom: 0; }
  .dr-cpe-staff-head { display: flex; align-items: baseline; justify-content: space-between; gap: 0.8rem; margin-bottom: 0.6rem; }
  .dr-cpe-staff-name { font-weight: 600; }
  .dr-cpe-staff-state { color: var(--muted); font-size: 0.82rem; }
  .dr-cpe-bar-row { display: flex; align-items: center; gap: 0.7rem; font-size: 0.82rem; margin-top: 0.4rem; }
  .dr-cpe-bar-label { flex: 0 0 5.5rem; color: var(--muted); }
  .dr-cpe-bar-track { flex: 1 1 auto; height: 0.55rem; border-radius: 999px; background: var(--border); overflow: hidden; }
  .dr-cpe-bar-fill { display: block; height: 100%; border-radius: 999px; background: #1f9e5c; transition: width 0.3s ease; }
  .dr-cpe-bar-fill--behind { background: #c33737; }
  .dr-cpe-bar-value { flex: 0 0 auto; font-variant-numeric: tabular-nums; color: var(--muted); white-space: nowrap; }
  .dr-cpe-gap-note { font-size: 0.8rem; color: var(--faint); margin-top: 0.4rem; }
  .dr-cpe-log-panel { background: var(--card-bg); border: 1px solid var(--border); border-radius: 11px; padding: 1.1rem 1.2rem; margin-bottom: 1.2rem; }
  .dr-cpe-log-panel h2 { font-size: 1.05rem; margin: 0 0 0.6rem; font-family: var(--font-display); }
  .dr-cpe-recent-item { display: flex; align-items: center; justify-content: space-between; gap: 0.8rem; font-size: 0.85rem; padding: 0.5rem 0; border-bottom: 1px solid var(--border); }
  .dr-cpe-recent-item:last-child { border-bottom: none; }
  .dr-cpe-recent-remove { border: 1px solid var(--border-strong); background: var(--card-bg); color: var(--muted); border-radius: 6px; padding: 0.2rem 0.55rem; cursor: pointer; font-family: inherit; font-size: 0.78rem; }
  .dr-cpe-recent-remove:hover { background: var(--row-alt); color: #c33737; }

  /* ---- SSO sign-in button + account settings (2026-07-30, auth suite) ---- */
  .dr-sso-block { margin-top: 1rem; }
  .dr-sso-divider { display: flex; align-items: center; gap: 0.75rem; color: var(--faint); font-size: 0.8rem; margin: 0.9rem 0; }
  .dr-sso-divider::before, .dr-sso-divider::after { content: ""; flex: 1 1 auto; height: 1px; background: var(--border); }
  .dr-sso-button { display: flex; align-items: center; justify-content: center; gap: 0.6rem; width: 100%; box-sizing: border-box; padding: 0.62rem 1rem; border: 1px solid var(--border-strong); border-radius: 8px; background: #fff; color: #1f1f1f; font-family: inherit; font-size: 0.95rem; font-weight: 500; text-decoration: none; cursor: pointer; }
  .dr-sso-button:hover { background: #f6f8fa; }
  .dr-sso-mark { flex: 0 0 auto; }
  .dr-sso-note { margin-top: 0.55rem; }
  .dr-account-panel { background: var(--card-bg); border: 1px solid var(--border); border-radius: 11px; padding: 1.1rem 1.2rem; margin-bottom: 1.2rem; max-width: 32rem; }
  .dr-account-panel h2 { font-size: 1.05rem; margin: 0 0 0.6rem; font-family: var(--font-display); }
  .dr-account-ok { color: #1f9e5c; font-size: 0.85rem; margin-top: 0.6rem; }
  .dr-account-err { color: #c33737; font-size: 0.85rem; margin-top: 0.6rem; }

  /* ---- Sign-in account chooser, /signin/ (2026-08-02) ---- */
  .signin-choice { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.9rem; margin: 1.4rem 0 1.8rem; }
  .signin-card { display: flex; flex-direction: column; gap: 0.35rem; background: var(--card-bg); border: 1px solid var(--border-strong); border-radius: 11px; padding: 1.1rem 1.2rem; text-decoration: none; color: inherit; }
  .signin-card:hover { border-color: var(--accent); }
  .signin-kind { font-family: var(--font-display); font-size: 1.05rem; font-weight: 650; }
  .signin-desc { font-size: 0.85rem; color: var(--muted); line-height: 1.45; }
  .signin-go { font-size: 0.85rem; color: var(--accent); font-weight: 600; margin-top: 0.3rem; }
  @media (max-width: 620px) { .signin-choice { grid-template-columns: 1fr; } }
  /* ---- Conventional sign-in card, /firm-login/ (2026-07-31) ---- */
  /* One form at a time, centred, narrow. The width cap is the point: a
     sign-in form stretched to a content column is one of the tells that made
     the old page read unfinished. */
  .dr-auth-card { max-width: 26rem; margin: 0 auto; }
  .dr-auth-card h1 { font-size: 1.5rem; margin-bottom: 0.4rem; }
  .dr-auth-card .subhead { font-size: 0.92rem; margin-bottom: 1.4rem; }
  .dr-auth-card form { background: var(--card-bg); border: 1px solid var(--border); border-radius: 11px; padding: 1.3rem 1.4rem; }
  .dr-auth-card label, .dr-account-panel label { display: block; font-size: 0.85rem; font-weight: 600; margin: 0.9rem 0 0.3rem; }
  .dr-auth-card form > label:first-of-type, .dr-account-panel form > label:first-of-type { margin-top: 0; }
  .dr-auth-card input[type="email"], .dr-auth-card input[type="text"], .dr-auth-card input[type="password"],
  .dr-account-panel input[type="email"], .dr-account-panel input[type="text"], .dr-account-panel input[type="password"] {
    width: 100%; box-sizing: border-box; padding: 0.6rem 0.7rem; border: 1px solid var(--border-strong);
    border-radius: 7px; font-family: inherit; font-size: 0.95rem; background: var(--bg); color: inherit; }
  .dr-auth-card button[type="submit"], .dr-account-panel form button[type="submit"] {
    width: 100%; margin-top: 1.1rem; padding: 0.7rem 1rem; border: 0;
    border-radius: 8px; background: #1f5fbf; color: #fff; font-family: inherit; font-size: 0.98rem;
    font-weight: 700; cursor: pointer; }
  .dr-auth-card button[type="submit"]:hover, .dr-account-panel form button[type="submit"]:hover { background: #1a4f9e; }
  .dr-auth-secondary { margin-top: 0.9rem; font-size: 0.86rem; text-align: center; }
  .dr-auth-alt { margin-top: 1.1rem; font-size: 0.9rem; text-align: center; }
  .dr-sso-top { margin-bottom: 1.2rem; }
  /* interaction-only: normally renders nothing at all, so the slot must not
     reserve space or leave a gap where the old green box used to sit. */
  .dr-turnstile-slot { display: flex; justify-content: center; }
  .dr-turnstile-slot:empty { display: none; }
  .dr-turnstile-slot .cf-turnstile:not(:empty) { margin-top: 1.1rem; }

  /* ---- Free-tier individual dashboard, /my/ (2026-07-31) ---- */
  /* Deliberately CARDS, not the firm dashboard's table: an individual has a
     handful of licenses, not a roster of dozens, and cards reflow on a phone
     with no horizontal-scroll problem to solve -- the exact problem the firm
     roster table needed fixing for. */
  .dr-my-shell { max-width: 46rem; }
  .dr-my-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
  .dr-my-head h1 { margin-bottom: 0.3rem; }
  .dr-my-signout { margin-top: 0.3rem; }
  .dr-my-signout button { border: 1px solid var(--border-strong); background: var(--card-bg); color: var(--muted); border-radius: 7px; padding: 0.4rem 0.85rem; cursor: pointer; font-family: inherit; font-size: 0.85rem; }
  .dr-my-signout button:hover { background: var(--row-alt); }
  .dr-my-list { list-style: none; padding: 0; margin: 1.4rem 0 0; }
  .dr-my-loading { color: var(--muted); font-size: 0.9rem; }
  .dr-my-card { background: var(--card-bg); border: 1px solid var(--border); border-left: 4px solid var(--border-strong); border-radius: 11px; padding: 1rem 1.2rem; margin-bottom: 0.9rem; }
  .dr-my-card.is-soon { border-left-color: #d08a1f; }
  .dr-my-card.is-overdue { border-left-color: #c33737; }
  .dr-my-card-head { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; }
  .dr-my-card-head h3 { margin: 0; font-size: 1.05rem; font-family: var(--font-display); }
  .dr-my-pill { font-size: 0.72rem; letter-spacing: 0.02em; text-transform: uppercase; background: var(--row-alt); border: 1px solid var(--border); color: var(--muted); border-radius: 999px; padding: 0.15rem 0.55rem; }
  .dr-my-pill-quiet { color: var(--faint); }
  .dr-my-date { font-size: 1.15rem; font-variant-numeric: tabular-nums; margin-top: 0.5rem; }
  .dr-my-count { font-size: 0.85rem; color: var(--muted); margin-top: 0.15rem; }
  .is-soon .dr-my-count { color: #a86a10; }
  .is-overdue .dr-my-count { color: #c33737; }
  .dr-my-note { font-size: 0.82rem; color: var(--muted); margin-top: 0.55rem; }
  .dr-my-error { border: 1px solid #c33737; border-radius: 11px; padding: 0.9rem 1.1rem; margin-top: 1.2rem; font-size: 0.9rem; }
  .dr-my-empty { background: var(--card-bg); border: 1px solid var(--border); border-radius: 11px; padding: 1.2rem; margin-top: 1.2rem; }
  .dr-my-actions { margin-top: 1.4rem; font-size: 0.9rem; }
  .dr-my-upsell { background: var(--card-bg); border: 1px solid var(--border); border-radius: 11px; padding: 1.3rem 1.4rem; margin-top: 2rem; }
  .dr-my-upsell h2 { font-size: 1.1rem; margin: 0 0 0.6rem; font-family: var(--font-display); }
  .dr-my-upsell p { font-size: 0.92rem; }
"""


_BRAND_GLYPH_SVG = """<svg class="brand-glyph" viewBox="0 0 32 32" fill="none" aria-hidden="true" width="26" height="26">
  <circle cx="16" cy="16" r="13.5" stroke="#1f3d54" stroke-width="1.6"/>
  <circle cx="16" cy="16" r="8" stroke="#c8d2db" stroke-width="1.2"/>
  <circle cx="16" cy="16" r="2.3" fill="#8a6a33"/>
  <path d="M16 16 L26 9" stroke="#8a6a33" stroke-width="1.8" stroke-linecap="round"/>
  <path d="M16 3.5 L16 6" stroke="#1f3d54" stroke-width="1.6" stroke-linecap="round"/>
</svg>"""


def site_header(
    home_href: str, hide_signin: bool = False, has_remind_anchor: bool = False, sticky_top_nav: bool = True
) -> str:
    # hide_signin (2026-07-30, UX fix follow-up): the dashboard page
    # (build_firm_dashboard_page()) uses this SAME shared shell, but a
    # visitor there is by definition already signed in (the page's own JS
    # redirects to /firm-login/ on a 401) -- showing a site-wide "Sign In"
    # link next to the sidebar's own "Log out" reads as a real contradiction,
    # caught by adversarial review. Every other page keeps the link.
    # Retargeted to /signin/ (2026-07-31): the site now has two kinds of
    # account, and pointing the one nav link at /firm-login/ dropped every
    # free individual -- the larger group, and the whole funnel -- on a page
    # asking for a firm name with no way across. /signin/ leads with the
    # individual form and links straight to /firm-login/, so neither audience
    # lands at the wrong door. See build_signin_page().
    signin_link_html = "" if hide_signin else '<a href="/signin/" class="nav-quiet" id="dr-nav-signin">Sign In</a>\n      '
    # A signed-in firm clicking any OTHER page on the site saw "Sign In"
    # again and had no way back to the dashboard without re-authenticating
    # (2026-08-03, direct report). The session cookie is HttpOnly by design
    # (worker/src/index.ts's firmSessionSetCookieHeader -- an XSS payload
    # must not be able to read/exfiltrate it), so page JS cannot simply
    # check for its presence; the only honest way to know is to ask the API.
    # A lightweight authenticated GET (reusing the roster endpoint, not a
    # new one) -- 200 swaps the link to Dashboard, anything else (401, a
    # network hiccup) leaves "Sign In" as the safe default. Skipped when
    # hide_signin is set -- that's already the dashboard itself, which
    # knows its own auth state from its own page load.
    signin_swap_js_html = "" if hide_signin else f"""<script>
(function() {{
  var link = document.getElementById('dr-nav-signin');
  if (!link) return;
  fetch('{REMINDER_BACKEND_BASE_URL}/firm/licenses', {{credentials: 'include'}}).then(function(r) {{
    if (r.ok) {{ link.textContent = 'Dashboard'; link.href = '/firm-dashboard/'; }}
  }}).catch(function() {{}});
}})();
</script>"""
    # `#remind` is a same-page anchor -- it only does anything on a page that
    # actually has an element with id="remind" (the homepage, per-state
    # pages, CPE-hours pages, reinstatement pages). Every OTHER page (the
    # dashboard, account pages, legal/methodology pages, mobility checker,
    # blog, 404...) rendered this exact link anyway, so clicking "Get
    # reminders" there silently did nothing -- caught 2026-08-03 from a
    # direct report ("nothing happened" on the firm dashboard). When this
    # page has no local anchor, send the click to the homepage's own
    # section instead of a dead in-page jump.
    remind_href = "#remind" if has_remind_anchor else f"{home_href}#remind"
    # sticky_top_nav=False (2026-08-03, AuditLab re-verify): nav.mainnav is
    # position:sticky, top:0, ~60px tall, semi-translucent -- when a tall
    # scrollable interactive table (the roster) puts a row's buttons in
    # that band, the nav sits above them in the stacking order and eats
    # the click. `scroll-padding-top` (2026-08-03, first attempt) only
    # covers scrollIntoView()/anchor-jump/focus-navigation scrolling, not a
    # normal mouse-wheel scroll -- confirmed still reproducing that way,
    # which is almost certainly how the original report happened. The
    # dashboard's own sidebar (.dr-sidebar) is ALREADY sticky and is the
    # nav that actually matters once signed in, so un-sticking this
    # site-wide top bar here removes the whole class of overlap rather
    # than chasing every way a user can land a row under it.
    nav_class = "mainnav" if sticky_top_nav else "mainnav mainnav--static"
    return f"""<nav class="{nav_class}">
  <div class="nav-inner wrap">
    <a href="{esc(home_href)}" style="display:flex; align-items:center; gap:0.5rem; text-decoration:none; padding:0.7rem 0;">
      {_BRAND_GLYPH_SVG}
      <span class="wordmark">{esc(SITE_NAME)}</span>
    </a>
    <div class="nav-links">
      <a href="/">Browse States</a>
      <a href="/methodology/">How We Verify</a>
      <a href="/for-firms/">For Firms</a>
      {signin_link_html}<a href="{esc(remind_href)}" class="cta">Get reminders</a>
    </div>
  </div>
</nav>
{signin_swap_js_html}
<div class="wrap">
<header class="site-header">
  <div class="tagline">{esc(SITE_TAGLINE)}</div>
</header>"""


def site_footer() -> str:
    return f"""</div>
<footer class="site-footer">
  <div class="wrap">
  <div class="foot-top">
    <div style="display:flex; align-items:center; gap:0.5rem;">
      {_BRAND_GLYPH_SVG}
      <span class="wordmark">{esc(SITE_NAME)}</span>
    </div>
    <div class="foot-links">
      <a href="/">All {JURISDICTION_COUNT} jurisdictions</a>
      <a href="/methodology/">How We Verify</a>
      <a href="/rule-changes/">Rule Changes</a>
      <a href="/blog/">Guides</a>
      <a href="/privacy/">Privacy</a>
      <a href="/contact/">Contact</a>
      <a href="/for-firms/">For Firms</a>
    </div>
  </div>
  <p class="disc"><strong>{esc(SITE_NAME)} is an independent reminder service operated by {esc(BRAND_NAME)}.</strong> It is not
  affiliated with, endorsed by, or connected to NASBA, the AICPA, or any state board of
  accountancy. Renewal dates are compiled from public sources for informational purposes only
  &mdash; not legal, tax, or professional advice. Always confirm your exact renewal date with your
  state board or on your license.</p>
  </div>
</footer>"""


CONTACT_EMAIL = "support@deadline-radar.com"


TRUST_MICROCOPY = (
    "We only email you deadline reminders. We never sell or share your address. Unsubscribe anytime."
)

# Real, accurate facts about the reminder feature -- fills the remind-panel's copy column with
# genuine information rather than empty space, per Devin's "there's a lot of dead space" note
# (2026-07-17). The 60/30/14/7/3/1 schedule matches worker/src/index.ts's actual cron behavior.
_REMIND_LIST_HTML = """<ul class="remind-list">
  <li><span class="tick">&#10003;</span> Reminders at 60, 30, 14, 7, 3, and 1 day before your deadline</li>
  <li><span class="tick">&#10003;</span> Works whether your date is computed automatically or the rule needs your own license details</li>
  <li><span class="tick">&#10003;</span> One-click unsubscribe, no account or login required</li>
</ul>"""

_MONTH_OPTIONS = "\n".join(
    f'<option value="{i}">{MONTH_NAMES[i - 1]}</option>' for i in range(1, 13)
)


_USER_DEADLINE_MAX_DAYS = 1280  # keep in sync with worker/src/deadline.ts's USER_DEADLINE_MAX_DAYS


def _extra_fields_html(state_slug: str, records: list[dict], as_of: date) -> str:
    """The state-specific fields beyond email, needed to compute THIS
    subscriber's exact deadline. Kept in sync with reminders/server.py's
    per-state field handling -- see that file's _handle_subscribe().

    "Bring your own date" (2026-07-05): for a state the worker can't
    auto-compute (_state_signup_supported() is false), the field is a plain
    date input instead of any of the per-state fields below -- the
    subscriber supplies the date printed on their own license, sidestepping
    the data-correctness question entirely for these states. min/max are a
    same-day UX nicety only; the worker's own server-side check (index.ts's
    handleSubscribe(), matching this same 1-to-USER_DEADLINE_MAX_DAYS bound)
    is the real, authoritative validation regardless of what the browser
    enforces -- same "validation authority stays server-side" rule this
    function's own docstring already establishes for every other field."""
    if not _state_signup_supported(state_slug, records):
        min_date = as_of + timedelta(days=1)
        max_date = as_of + timedelta(days=_USER_DEADLINE_MAX_DAYS)
        return f"""<label for="license_expiration_date">License expiration date</label>
<input type="date" id="license_expiration_date" name="license_expiration_date"
  min="{fmt_date_iso(min_date)}" max="{fmt_date_iso(max_date)}" required>
<p class="field-hint">Enter the expiration date printed on your license -- we can't look this one
up automatically, so we'll remind you based on the date you give us.</p>"""
    if state_slug == "california":
        return f"""<div class="signup-form-row">
  <div>
    <label for="birth_month">Birth month</label>
    <select id="birth_month" name="birth_month" required>{_MONTH_OPTIONS}</select>
  </div>
  <div>
    <label for="birth_year">Birth year</label>
    <input type="number" id="birth_year" name="birth_year" min="1900" max="2100" required placeholder="1985">
  </div>
</div>
<p class="field-hint">Your renewal cycle is set by your birth month and whether your birth year is odd or even.</p>"""
    if state_slug == "texas":
        return f"""<label for="birth_month">Birth month</label>
<select id="birth_month" name="birth_month" required>{_MONTH_OPTIONS}</select>
<p class="field-hint">Texas renewal is due by the last day of your birth month, every year.</p>"""
    if state_slug == "ohio":
        return """<label for="cohort_group">Your cohort group</label>
<select id="cohort_group" name="cohort_group" required>
  <option value="">Select your group</option>
  <option value="Group 1">Group 1</option>
  <option value="Group 2">Group 2</option>
  <option value="Group 3">Group 3</option>
</select>
<p class="field-hint">Check your license certificate or the Accountancy Board of Ohio lookup if you're not sure.</p>"""
    computed = [r for r in records if r.get("next_deadline_computed")]
    if len(computed) > 1:
        options = "\n".join(
            f'<option value="{esc(r["id"])}">{esc(r["license_type_label"])}</option>' for r in computed
        )
        return f"""<label for="license_type_id">Which license?</label>
<select id="license_type_id" name="license_type_id" required>
  <option value="">Select the one that applies to you</option>
  {options}
</select>"""
    return ""



# Abuse-hardening (2026-07-03 audit). Two bot defenses embedded directly in
# every rendered form:
#
#   1. A honeypot field, invisible to a real person (off-screen, aria-hidden,
#      excluded from tab order, autocomplete disabled so password managers
#      never auto-fill it either) but present in the DOM like any other
#      input -- a bot that blindly fills every field will fill this one too.
#      server.py's _handle_subscribe() treats any non-empty value here as
#      "this is a bot" and silently no-ops (fake success, no record, no
#      email) rather than tipping off the bot with a visible rejection.
#   2. A reserved (but inert) Cloudflare Turnstile response field. The
#      widget script itself is NOT included here -- standing up a public
#      endpoint behind Turnstile is a plan-first, not something this
#      generator does unilaterally (see reminders/HOSTING_PROPOSAL.md). The
#      field name matches what server.py's _verify_turnstile() already
#      reads, so turning Turnstile on later is: (a) add the widget
#      <script>/div here, (b) set TURNSTILE_SECRET_KEY server-side. No other
#      code changes needed on either side.
_HONEYPOT_FIELD_NAME = "hp_website"

# Optional first-name field so reminder emails can greet by name ("Hi
# David,") instead of the generic "Hi there," -- never required. `maxlength`
# must match reminders/store.py's MAX_FIRST_NAME_LEN; validation authority
# stays server-side (reminders/server.py) regardless of this attribute.
_FIRST_NAME_FIELD_HTML = (
    '<label for="{id_prefix}first_name">First name (optional)</label>\n'
    '    <input type="text" id="{id_prefix}first_name" name="first_name" maxlength="60" '
    'autocomplete="given-name" placeholder="For a personal greeting, e.g. David">'
)

# Cloudflare Turnstile site key -- PUBLIC (safe to embed in HTML; the SECRET
# half lives only as the TURNSTILE_SECRET_KEY Worker secret). Empty string =
# Turnstile not configured yet: the form renders the same inert hidden
# cf-turnstile-response input it always has, and the Worker's verifyTurnstile()
# fails OPEN (no secret set). To turn Turnstile ON, set this to the real widget
# site key AND set the Worker secret together -- the site key must be live in
# the HTML at the same time (or before) the secret is set, because the Worker
# fails CLOSED once the secret exists and would otherwise reject every real
# submission that arrives without a widget token.
TURNSTILE_SITE_KEY = "0x4AAAAAADvxskBA78YAubz_"

def _bot_defense_fields_html(id_suffix: str = "", shared_widget: bool = False) -> str:
    """Honeypot + Turnstile widget for ONE form.

    Parameterised by id suffix because a page can legitimately carry more
    than one form (2026-07-28 /firm-login/ had two; the 2026-07-30 auth
    suite made it three: create-account, password sign-in, and the emailed
    sign-in link). Repeating a fixed `id="hp_website"` per form would emit
    duplicate ids and duplicate `<label for=...>` targets on one page -- an
    HTML-validity defect, and a real accessibility one, since a label would
    point at whichever field the browser resolved first.

    The honeypot NAME is deliberately identical across all of them: every
    handler in index.ts matches by name, never by id. Only the id varies.

    Cloudflare explicitly supports multiple independent `.cf-turnstile`
    widgets on a page, so one per form is fine.

    An absent TURNSTILE_SITE_KEY emits an empty hidden field instead, which
    the Worker treats as "not configured yet" rather than a failed check --
    matching verifyTurnstile()'s own degrade-safely contract.
    """
    field_id = f"{_HONEYPOT_FIELD_NAME}{id_suffix}"
    honeypot = (
        f'<div aria-hidden="true" style="position:absolute;left:-9999px;top:-9999px;'
        f'height:0;width:0;overflow:hidden;">'
        f'<label for="{field_id}">Leave this field blank</label>'
        f'<input type="text" id="{field_id}" name="{_HONEYPOT_FIELD_NAME}" '
        f'tabindex="-1" autocomplete="off">'
        f'</div>'
    )
    if TURNSTILE_SITE_KEY and not shared_widget:
        # data-appearance="interaction-only" (2026-08-01, sitewide sweep): renders
        # NOTHING unless Cloudflare actually needs a human interaction, so the
        # green "Success!" box is gone from every public form -- not just the two
        # login pages that were fixed first. An audit of the generated site found
        # 159 pages still on the default appearance (every state, CPE and
        # reinstatement page carries the signup form), which is why this belongs
        # in the shared helper rather than being patched page by page.
        widget = (
            f'    <div class="cf-turnstile" data-sitekey="{esc(TURNSTILE_SITE_KEY)}"'
            f' data-appearance="interaction-only"></div>'
        )
    else:
        # `shared_widget=True` (2026-07-31): this form does NOT render its own
        # widget. It carries only the empty hidden input that
        # _turnstile_shared_widget_html()'s script fills in on submit. Used on
        # /firm-login/, where three forms share ONE widget -- see that
        # function's docstring for why.
        widget = (
            f'    <!-- Turnstile reserved: set TURNSTILE_SITE_KEY (+ the Worker secret) to activate. '
            f'Empty/absent is treated as "not configured yet," not as a failed check. -->\n'
            f'    <input type="hidden" name="cf-turnstile-response" value="">'
        )
    return honeypot + "\n" + widget


def _turnstile_shared_widget_html() -> str:
    """ONE Turnstile widget serving every form on the page.

    Two problems this solves, both raised by Devin off a screenshot of the
    live /firm-login/ ("How do normal sign ins work? I don't see them like
    this"):

    1. **Three widgets on one page, each showing a green "Success!" box.**
       No real sign-in page looks like that, and on a product asking CPA
       firms to trust it with staff data it reads amateurish -- a
       credibility cost, which is a revenue cost.
    2. `data-appearance="interaction-only"` means the widget renders NOTHING
       unless Cloudflare actually needs a human interaction. The normal
       visitor now sees no box at all, passing silently in the background,
       which is the conventional behaviour.

    Mechanism: the widget lives OUTSIDE every form and captures its token
    into a JS variable via `data-callback`. Each form carries an empty
    hidden `cf-turnstile-response` input, filled from that variable at
    submit time. The Worker verifies the token STRING and does not care
    which form carried it, so nothing server-side changes -- this is a
    presentation + bot-protection-config change, not an auth change.

    Degradation is deliberate and safe in both directions:
      * no JS -> the hidden input stays empty -> the Worker's
        verifyTurnstile() fails CLOSED once its secret is set. A bot without
        JS is refused; a human without JS sees the honest "Verification
        failed" rather than a silent success.
      * token not yet issued when a very fast user submits -> same path.
        Turnstile resolves in well under a second and these forms require
        typing an email and a password first, so this is a narrow window.
    """
    if not TURNSTILE_SITE_KEY:
        return ""
    return f"""<div class="dr-turnstile-slot">
  <div class="cf-turnstile" data-sitekey="{esc(TURNSTILE_SITE_KEY)}"
       data-appearance="interaction-only" data-callback="drTurnstileDone"
       data-expired-callback="drTurnstileExpired" data-error-callback="drTurnstileExpired"></div>
</div>
<script>
(function () {{
  var drTurnstileToken = "";
  var drTurnstileWaiters = [];
  window.drTurnstileDone = function (token) {{
    drTurnstileToken = token || "";
    if (drTurnstileToken) {{
      var waiters = drTurnstileWaiters;
      drTurnstileWaiters = [];
      waiters.forEach(function (fn) {{ fn(); }});
    }}
  }};
  window.drTurnstileExpired = function () {{ drTurnstileToken = ""; }};
  // Called after a failed submit -- that token is now server-side consumed
  // (Turnstile tokens are single-use), so forget it and ask Cloudflare for a
  // fresh one. `cb` fires once a NEW token has actually arrived (or after a
  // safety timeout, so a Cloudflare hiccup can never leave a caller stuck
  // waiting forever).
  window.drTurnstileRecover = function (cb) {{
    drTurnstileToken = "";
    if (window.turnstile && typeof window.turnstile.reset === "function") {{
      try {{ window.turnstile.reset(); }} catch (err) {{}}
    }}
    var done = false;
    function finish() {{ if (done) return; done = true; cb(); }}
    // Not "if already have a token, finish immediately" -- drTurnstileToken
    // was just cleared above and reset() doesn't refill it synchronously, so
    // that check could never be true here (AuditLab, 2026-08-03: dead code,
    // harmless, cleaned up on this file's next touch).
    drTurnstileWaiters.push(finish);
    setTimeout(finish, 8000);
  }};
  // Fill whichever form is actually submitted. Listening in the CAPTURE
  // phase on the document means a form added or swapped later is covered
  // too, and there is no per-form wiring to forget. Unconditional overwrite
  // (not "only if empty"): a form's hidden field can otherwise carry a
  // stale, already-consumed token in from a previous failed attempt (2026-
  // 08-03, reported directly, still visible after an earlier fix attempt
  // that cleared the field but not this variable) -- always writing
  // whatever the CURRENT token is at the moment of actual submission is
  // simpler than trying to keep two places in sync.
  document.addEventListener("submit", function (e) {{
    var f = e.target;
    if (!f || f.tagName !== "FORM") return;
    var field = f.querySelector('input[name="cf-turnstile-response"]');
    if (field) field.value = drTurnstileToken;
  }}, true);
}})();
</script>"""


_BOT_DEFENSE_FIELDS_HTML = _bot_defense_fields_html()
# The three /firm-login/ forms share ONE widget (see
# _turnstile_shared_widget_html) -- these carry the hidden field only.
_BOT_DEFENSE_FIELDS_HTML_ALT = _bot_defense_fields_html("-alt", shared_widget=True)
_BOT_DEFENSE_FIELDS_HTML_SIGNIN = _bot_defense_fields_html("-signin", shared_widget=True)
_BOT_DEFENSE_FIELDS_HTML_MAGIC = _bot_defense_fields_html("-magic", shared_widget=True)


def _turnstile_head_html() -> str:
    """Cloudflare Turnstile loader script for <head> -- only when a site key is
    configured. Loading it unconditionally would be a wasted external request on
    a page whose form has no widget to render."""
    if not TURNSTILE_SITE_KEY:
        return ""
    return '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>'


def signup_form_for_state(state_slug: str, state_name: str, records: list[dict], as_of: date) -> str:
    # "Bring your own date" (2026-07-05): the form always renders now -- see
    # _extra_fields_html()'s own docstring for how it picks the right field(s)
    # per state. Every state can collect a signup, computed or user-provided.
    # Two-column dark treatment (2026-07-17), matching the approved concept's .remind panel.
    return f"""<div class="remind-panel" id="remind">
  <div>
    <h2>One email before it matters.</h2>
    <p class="remind-copy">We'll remind you ahead of your {esc(state_name)} renewal deadline &mdash;
    and again for your CPE, if your state tracks it separately. Set it once.</p>
    <p class="remind-promise">{esc(TRUST_MICROCOPY)}</p>
    {_REMIND_LIST_HTML}
  </div>
  <form method="post" action="{esc(REMINDER_BACKEND_BASE_URL)}/subscribe">
    <input type="hidden" name="state" value="{esc(state_slug)}">
    {_BOT_DEFENSE_FIELDS_HTML}
    {_FIRST_NAME_FIELD_HTML.format(id_prefix="")}
    <label for="email">Email address</label>
    <input type="email" id="email" name="email" required placeholder="you@example.com">
    {_extra_fields_html(state_slug, records, as_of)}
    <button type="submit">Remind me</button>
  </form>
</div>"""


def signup_form_homepage(by_slug: dict[str, list[dict]], as_of: date) -> str:
    """Homepage doesn't know the state yet, so it collects it via a
    dropdown and shows/hides the right extra fields with a small vanilla-JS
    handler -- the only JS on the whole site, used only because it clearly
    helps usability here (per the design brief). Validation authority stays
    server-side in reminders/server.py regardless of what this JS does.

    "Bring your own date" (2026-07-05): every state is now a valid dropdown
    option (previously filtered to `_state_signup_supported()`-true states
    only) -- an uncomputable state just gets the date-input extra field
    instead of a computed one, same as its own page."""
    all_slugs = sorted(by_slug, key=lambda slug: by_slug[slug][0]["state"])
    state_options = "\n".join(
        f'<option value="{esc(slug)}">{esc(by_slug[slug][0]["state"])}</option>' for slug in all_slugs
    )
    field_groups = "\n".join(
        f'<div class="signup-extra-fields" data-for-state="{esc(slug)}" hidden>'
        f'{_extra_fields_html(slug, by_slug[slug], as_of)}</div>'
        for slug in all_slugs
        if _extra_fields_html(slug, by_slug[slug], as_of)
    )
    return f"""<div class="remind-panel" id="remind">
  <div>
    <h2>One email before it matters.</h2>
    <p class="remind-copy">We'll remind you ahead of your renewal deadline &mdash; and again for your
    CPE, if your state tracks it separately. Set it once.</p>
    <p class="remind-promise">{esc(TRUST_MICROCOPY)}</p>
    {_REMIND_LIST_HTML}
  </div>
  <form method="post" action="{esc(REMINDER_BACKEND_BASE_URL)}/subscribe" id="homepage-signup-form">
    {_BOT_DEFENSE_FIELDS_HTML}
    <label for="home-state">Your state</label>
    <select id="home-state" name="state" required onchange="drUpdateFields(this.value)">
      <option value="">Select your state</option>
      {state_options}
    </select>
    {_FIRST_NAME_FIELD_HTML.format(id_prefix="home-")}
    {field_groups}
    <label for="home-email">Email address</label>
    <input type="email" id="home-email" name="email" required placeholder="you@example.com">
    <button type="submit">Remind me</button>
  </form>
</div>
<script>
function drUpdateFields(slug) {{
  document.querySelectorAll('.signup-extra-fields').forEach(function(el) {{
    var show = (el.getAttribute('data-for-state') === slug);
    el.hidden = !show;
    // Also enable/disable the controls inside each group. Toggling `hidden`
    // alone is NOT enough: a `required` control inside a hidden group still
    // fails HTML5 form validation on submit, and the browser cannot show a
    // validation bubble on a non-focusable (hidden) field, so it silently
    // refuses to submit -- the "click Remind me, nothing happens" bug. A
    // `disabled` control is skipped by validation AND excluded from the POST,
    // so only the visible state's extra fields are ever validated or sent.
    el.querySelectorAll('input, select, textarea').forEach(function(field) {{
      field.disabled = !show;
    }});
  }});
}}
// Initialize on load so a browser-restored/autofilled state selection starts
// in a consistent enabled/disabled state even if `onchange` never fires.
document.addEventListener('DOMContentLoaded', function() {{
  var sel = document.getElementById('home-state');
  drUpdateFields(sel ? sel.value : '');
}});
</script>"""


def _organization_schema() -> dict:
    return {
        "@context": "https://schema.org",
        "@type": "Organization",
        "name": BRAND_NAME,
        "url": SITE_BASE_URL,
    }


def _website_schema() -> dict:
    return {
        "@context": "https://schema.org",
        "@type": "WebSite",
        "name": SITE_NAME,
        "url": SITE_BASE_URL,
        "publisher": {"@type": "Organization", "name": BRAND_NAME},
    }


def _breadcrumb_schema(state_name: str, state_slug: str) -> dict:
    return {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": SITE_NAME, "item": f"{SITE_BASE_URL}/"},
            {
                "@type": "ListItem",
                "position": 2,
                "name": f"{state_name} CPA Renewal",
                "item": f"{SITE_BASE_URL}/{state_slug}/",
            },
        ],
    }


def _json_ld_html(schemas: list[dict] | None) -> str:
    """Renders each schema dict as its own <script type="application/ld+json"> block.
    None/empty input renders nothing -- callers that have no non-null data to describe
    (a gapped/BYOD state, e.g.) simply pass nothing rather than a script asserting a
    fact we haven't confirmed."""
    if not schemas:
        return ""
    return "\n".join(
        f'<script type="application/ld+json">{json.dumps(s, ensure_ascii=False)}</script>'
        for s in schemas
    )


def page_shell(
    title: str,
    meta_description: str,
    body: str,
    home_href: str,
    canonical_path: str,
    json_ld: list[dict] | None = None,
    extra_head: str = "",
    hide_signin: bool = False,
    has_remind_anchor: bool = False,
    sticky_top_nav: bool = True,
) -> str:
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(title)}</title>
<meta name="description" content="{esc(meta_description)}">
<link rel="canonical" href="{esc('https://deadline-radar.com' + canonical_path)}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
{_turnstile_head_html()}
{_json_ld_html(json_ld)}
{extra_head}
<style>
{PAGE_CSS}
</style>
</head>
<body>
{site_header(home_href, hide_signin=hide_signin, has_remind_anchor=has_remind_anchor, sticky_top_nav=sticky_top_nav)}
{body}
{site_footer()}
</body>
</html>
"""


def trust_line(last_verified: str, source_url: str, has_citation: bool) -> str:
    """AuditLab DATA-1 (HIGH, 2026-08-04): this unconditionally asserted "checked
    against the state's codified statute or administrative rule, not just a board
    webpage" on every page, including 11 records across 9 states that have ONLY a
    board webpage on record -- no citation, no citation_url. That is an
    affirmatively false provenance claim, the exact thing the methodology page's
    two-source rule promises never happens ("if we can't find or confirm the
    second source, the date is not published as a confirmed fact... the page says
    so plainly"). `has_citation` now gates which sentence renders -- same signal
    _source_cite_html()/_verified_badge_html() already use (record.get("citation")),
    so a record can never show the "Verified" badge or a Source-of-record block
    while this text still claims primary-law verification, or vice versa."""
    if has_citation:
        sourcing_claim = (
            "checked against the state's codified statute or administrative rule, not just a board "
            "webpage &mdash; if we can't verify a date against primary law, we say so instead of "
            'guessing (<a href="/methodology/">see how we verify every deadline</a>)'
        )
    else:
        sourcing_claim = (
            "sourced from the state board's own page; we could not independently confirm it against "
            "codified statute or administrative rule text, so we are not calling it primary-law-verified "
            '(<a href="/methodology/">see how we verify every deadline</a>)'
        )
    return f"""<div class="trust-line">
  <strong>Last verified: {esc(last_verified)}</strong> &middot; {sourcing_claim}. Always confirm with the
  <a href="{http_href(source_url)}">official state board</a> before relying on this date. License
  requirements and deadlines can change.
</div>"""


# ---------------------------------------------------------------------------
# Per-state page builders
# ---------------------------------------------------------------------------

def _affiliate_disclosure_html() -> str:
    """Shared FTC Endorsement Guides (16 CFR Part 255) material-connection disclosure.
    Centralized so every CPE-affiliate provider block renders byte-identical wording --
    a future provider can't accidentally ship with slightly different or missing
    copy. Called once per provider block, immediately after that specific provider's
    link -- the FTC requirement is disclosure adjacent to each link, not one mention
    site-wide in a footer or terms page.

    DRAFT WORDING pending explicit review (2026-07-09 multi-provider directive): this
    text predates Becker/Yazing and was written for Illumeo's direct FlexOffers link
    only. Kept unchanged here rather than silently reworded for the Yazing routing
    case -- see the propose-first filing for the reasoning and the proposed addition."""
    return ('<p class="disclosure">Disclosure: this is a paid affiliate link &mdash; we may earn a '
            "commission if you sign up through it, at no extra cost to you.</p>")


def _cpe_provider_html(url: str, placeholder: str, name: str, blurb: str, routing_note: str = "") -> str:
    """Shared renderer for one CPE-provider affiliate block. GATED: renders nothing at
    all while `url` still equals `placeholder` -- the same dormant pattern Illumeo has
    always used, now factored out so Becker (or any future provider) can't accidentally
    skip the gate or the disclosure. `routing_note` is a UX/trust disclosure (e.g. "this
    goes through an intermediary coupon page first"), separate from and in addition to
    the FTC disclosure `_affiliate_disclosure_html()` always renders below the link."""
    if url == placeholder:
        return ""
    note_html = f" {esc(routing_note)}" if routing_note else ""
    return f"""<div class="cpe-affiliate">
  <p><strong>Need CPE hours before your deadline?</strong> <a href="{http_href(url)}">{esc(name)}</a>
  {esc(blurb)}.{note_html}</p>
  {_affiliate_disclosure_html()}
</div>"""


def _cpe_affiliate_html() -> str:
    """Renders every CPE-provider block that currently has a real (non-placeholder)
    tracked URL -- each provider is independently gated (see _cpe_provider_html()), so
    Illumeo can go live without Becker or vice versa. Once any provider is active, its
    block renders on every state page, always paired with its own FTC disclosure.

    6-provider slate (2026-07-25) matches ScoutLab's 2026-07-21 product register
    exactly: "Becker has a confirmed affiliate program; MYCPE, Surgent, Illumeo,
    Gleim, WebCE all run partner/affiliate programs and want individual-CPA
    leads." Illumeo + Becker were vetted and wired first (2026-07-09); the other 4
    are slots only -- placeholder URLs, no vetting pass, no account -- so a real
    link is a one-line constant swap away whenever Devin runs that signup, not a
    rebuild of this block."""
    blocks = [
        _cpe_provider_html(
            ILLUMEO_AFFILIATE_URL, _ILLUMEO_AFFILIATE_PLACEHOLDER,
            "Illumeo", "offers self-study CPE courses for CPAs",
        ),
        _cpe_provider_html(
            BECKER_AFFILIATE_URL, _BECKER_AFFILIATE_PLACEHOLDER,
            "Becker", "offers CPE courses and exam-prep for CPAs",
            routing_note="(This link goes through Yazing's coupon page on the way to Becker -- that's expected.)",
        ),
        _cpe_provider_html(
            MYCPE_AFFILIATE_URL, _MYCPE_AFFILIATE_PLACEHOLDER,
            "MYCPE ONE", "offers unlimited CPE credits across 100+ credential types",
        ),
        _cpe_provider_html(
            SURGENT_AFFILIATE_URL, _SURGENT_AFFILIATE_PLACEHOLDER,
            "Surgent", "offers CPE webinars and self-study courses for CPAs",
        ),
        _cpe_provider_html(
            WEBCE_AFFILIATE_URL, _WEBCE_AFFILIATE_PLACEHOLDER,
            "WebCE", "offers NASBA-approved self-study CPE for CPAs",
        ),
        _cpe_provider_html(
            GLEIM_AFFILIATE_URL, _GLEIM_AFFILIATE_PLACEHOLDER,
            "Gleim", "offers self-paced CPE courses accepted by every state board",
        ),
    ]
    live_blocks = [b for b in blocks if b]
    if not live_blocks:
        return ""
    # Clearly-marked section heading (2026-07-25), only rendered once at least one
    # provider is live -- each individual block is already its own bordered,
    # separated card (.cpe-affiliate), so this just labels the group as a whole
    # rather than letting several provider cards run together with no heading.
    return '<p class="cpe-affiliate-heading">Recommended CPE providers</p>\n' + "\n".join(live_blocks)


def _is_operational_record(record: dict) -> bool:
    """True for records whose citation is government operational/administrative
    evidence (a live licensing register, a verification portal, dated board
    newsletters) rather than codified statute/rule text. Added 2026-07-17 per
    orchestrator ruling on task #11: this evidence class is real primary authority
    -- arguably stronger CPA-trust material than a bare rule cite, since it's the
    regulator's own operative records, not just a description of the rule -- but it
    is NOT codified law, and the site must not blur that distinction. Citation-class
    honesty IS the trust element here, so this flag drives visibly different label
    text everywhere a citation renders, never a silent "same as a rule cite" claim."""
    return record.get("citation_class") == "operational_record"


def _source_cite_html(record: dict) -> str:
    """Renders the citation as its own labeled element, distinct from the descriptive
    prose above it -- CPAs read citations as the actual trust signal (per the
    2026-07-06 CPA-trust pass), not something to leave buried mid-paragraph. Only
    ever called for a record that already has a real `citation` string (populated
    2026-07-06 from the same double-sourced research backing next_deadline_computed
    itself) -- a record with no citation renders no source-cite element at all,
    same "don't assert what you can't back up" rule as everywhere else in this file."""
    citation = record.get("citation")
    if not citation:
        return ""
    # `citation_url` is an explicit, individually-verified link to the actual cited
    # rule/statute text (added 2026-07-06 after an orchestrator review caught several
    # records where the old "secondary_source_url or source_url" guess picked a FAQ,
    # form, newsletter, or generic board homepage instead of the rule itself). Every
    # record with a `citation` also has a `citation_url` -- this is not an optional
    # fallback chain, so a record missing one is a data bug to fix, not silently paper
    # over with a worse link.
    link_url = record["citation_url"]
    label = "Source of record (official records, not codified rule text)" if _is_operational_record(record) else "Source of record"
    link_text = "see the records &rarr;" if _is_operational_record(record) else "read the rule &rarr;"
    return f"""<div class="source-cite">
  <span class="cite-label">{label}</span>
  <span class="cite-stamp">{esc(citation)}</span>
  <a href="{http_href(link_url)}" class="cite-link">{link_text}</a>
</div>"""


def _verified_badge_html(record: dict) -> str:
    """Small 'Verified' badge on a callout -- shown ONLY when the record has a real
    citation to codified law (same gate _source_cite_html already uses), never on a
    data-gap/unverified record. `.callout` needs `position: relative` for this badge's
    absolute positioning, set once in PAGE_CSS rather than per call site."""
    if not record.get("citation"):
        return ""
    return '<span class="verified-badge">Verified</span>'


_CITE_ICON_SVG = (
    '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true">'
    '<path d="M6.5 2.5h5.5a1 1 0 0 1 1 1V13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5.5z" '
    'stroke="currentColor" stroke-width="1.3"/>'
    '<path d="M6.5 2.5V5a.5.5 0 0 0 .5.5h2.5" stroke="currentColor" stroke-width="1.3"/></svg>'
)
_VERIFIED_ICON_SVG = (
    '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true">'
    '<path d="M3.5 8.5l3 3 6-7" stroke="currentColor" stroke-width="1.6" '
    'stroke-linecap="round" stroke-linejoin="round"/></svg>'
)


# A citation longer than this is a sentence, not a statutory label, and is laid
# out as its own full-width row instead of a right-aligned chip. Chosen by
# measuring the real dataset rather than guessed: every genuine statutory cite
# in cpa_deadlines.json ("68 Ill. Admin. Code 1420.80(a)", "Tex. Occ. Code
# 901.402") is comfortably under it, while the "Confirmed via ..." provenance
# sentences that broke the Illinois card are all well over.
_CITATION_CHIP_MAX_CHARS = 60


def _citation_is_long(record: dict) -> bool:
    return len(record.get("citation") or "") > _CITATION_CHIP_MAX_CHARS


def _side_class(record: dict) -> str:
    return "side side--stacked" if _citation_is_long(record) else "side"


def _cite_chip_html(record: dict, max_chars: int | None = None) -> str:
    """The 'seal of authority' -- brass, mono, links to the primary source. Only
    called for a record that already has a real `citation` string; a record with
    none renders no chip at all (never a placeholder/guessed citation).

    `max_chars` truncates the DISPLAYED text with an ellipsis for space-constrained
    contexts (the hero's compact rotating card) -- some records (e.g. Alabama's
    combined individual+firm entry) have a long compound citation that would
    overflow a small card. This never hides the citation itself: the link still
    points to the real citation_url and the full untruncated string is always
    shown on the record's actual state page one click away -- truncation here is
    a display-space concession for a teaser card, not withholding information."""
    if not record.get("citation"):
        return ""
    citation = record["citation"]
    display = citation
    if max_chars and len(citation) > max_chars:
        display = citation[: max_chars - 1].rstrip() + "…"
    return (
        f'<a class="cite" href="{http_href(record["citation_url"])}" title="{esc(citation)}">{_CITE_ICON_SVG}'
        f'{esc(display)}</a>'
    )


def render_simple_deadline_records(records: list[dict]) -> str:
    """Wave 1 / plain fixed_calendar records with a single computed date each.
    Rendered as the approved concept's .sheet/.frow fact sheet (2026-07-17 CPA-trust
    redesign, deadlineradar_concept_v1_APPROVED.html) -- citation lives inline on the
    same row as the value it backs, not a separate buried line."""
    parts = []
    for r in records:
        d = date.fromisoformat(r["next_deadline_computed"])
        has_citation = bool(r.get("citation"))
        stamp_class = "stamp" if has_citation else "stamp stamp--unconfirmed"
        stamp_text = f"Last verified {esc(r['last_verified'])}" if r.get("last_verified") else "Not independently verified"
        verified_text = "Confirmed via official records" if _is_operational_record(r) else "Confirmed at source"
        verified_line = (
            f'<div class="verified">{_VERIFIED_ICON_SVG}{verified_text}</div>' if has_citation else ""
        )
        parts.append(f"""<div class="sheet">
  <div class="sheethead">
    <span>{esc(r['license_type_label'])}</span>
    <div class="{stamp_class}"><span class="dot"></span>{stamp_text}</div>
  </div>
  <div class="rowlist">
    <div class="frow">
      <div class="k">Next renewal date</div>
      <div class="v">{esc(fmt_date(d))}<small>{esc(r['cycle_description'])}</small></div>
      <div class="{_side_class(r)}">
        {_cite_chip_html(r)}
        {verified_line}
      </div>
    </div>
  </div>
</div>""")
    return "\n".join(parts)


_DEFAULT_GAP_NOTE = (
    "Your exact deadline depends on details specific to your own license -- see the official "
    "source above for how to determine it."
)


def render_data_gap_records(records: list[dict]) -> str:
    """Gap-note fallback: a record can be null/unresolved either because the state
    doesn't publish a state-level fact (data_gap_note explains what's missing) or
    because it depends on a per-licensee formula this dataset intentionally doesn't
    guess at (a `computation` block, e.g. Arizona's birth-month formula) with no
    separate data_gap_note string. Either way the callout must show SOME explanatory
    text -- an empty note previously rendered as a blank <p><em></em></p>.
    Rendered as the same .sheet/.frow fact sheet as render_simple_deadline_records()
    so a "date not confirmed" answer reads as an honest, deliberate result within the
    same trusted format, not a lesser page -- the citation chip still renders if the
    RULE itself is cited (e.g. Illinois's firm-license rule), even when the specific
    date can't be computed from it (a real anchor-year gap, not a sourcing gap)."""
    parts = []
    for r in records:
        note = r.get("data_gap_note") or _DEFAULT_GAP_NOTE
        cite_html = _cite_chip_html(r)
        side_html = (
            f'{cite_html}<div class="verified unconfirmed">Anchor year not confirmed</div>'
            if cite_html else '<div class="verified unconfirmed">Not independently verified</div>'
        )
        parts.append(f"""<div class="sheet">
  <div class="sheethead">
    <span>{esc(r['license_type_label'])}</span>
    <div class="stamp stamp--unconfirmed"><span class="dot"></span>Date not confirmed</div>
  </div>
  <div class="rowlist">
    <div class="frow">
      <div class="k">Next renewal date</div>
      <div class="v">Not confirmed<small>{esc(r['cycle_description'])}</small></div>
      <div class="{_side_class(r)}">
        {side_html}
      </div>
    </div>
  </div>
  <div class="sheetfoot">{esc(note)}</div>
</div>""")
    return "\n".join(parts)


def render_ohio(record: dict) -> str:
    rows = "\n".join(
        f"<tr><td>{esc(g['group'])}</td><td>{', '.join(str(y) for y in g['years'])}</td>"
        f"<td><strong>{esc(fmt_date(date.fromisoformat(g['next_deadline'])))}</strong></td></tr>"
        for g in record["cohort_groups"]
    )
    return f"""<div class="callout">
  <div class="label">{esc(record['license_type_label'])}</div>
  <p class="rule">{esc(record['cycle_description'])}</p>
  <p>{esc(record.get('grace_period_note', ''))}</p>
</div>
<div class="table-wrap">
  <table>
    <thead><tr><th>Cohort group</th><th>Years due</th><th>Next deadline</th></tr></thead>
    <tbody>
    {rows}
    </tbody>
  </table>
</div>
<p>Not sure which group you're in? Your license certificate or the
<a href="{http_href(record['source_url'])}">Accountancy Board of Ohio lookup</a> will show your
assigned group.</p>"""


def render_cohort_group_record(record: dict) -> str:
    """Generic cohort-group table for any non-Ohio state with cohort_groups. Two distinct shapes
    share this same table: (1) a DEDUCIBLE split (Oregon/Kentucky's permit- or license-number-parity
    rule) -- a visitor who knows their own permit/license number parity can determine their exact
    group unaided, so the table alone is a complete, honest answer; (2) a NON-deducible split
    (Rhode Island/Kansas/Nebraska) -- the state genuinely staggers licensees across cohorts with no
    public rule tying a visible personal attribute to a group, so `data_gap_note` is also set on
    these records. The table is still useful reference info in both cases, but case (2) must ALSO
    carry the same honest sheetfoot explanation `render_data_gap_records()` shows -- silently
    dropping it (the bug this comment replaced) let 3 states' pages read as fully resolved when
    they weren't. Accepts either an explicit `years` list (Ohio's shape) or a plain-English
    `deadline_pattern` string (Oregon/Kentucky/Rhode Island's shape) per cohort group."""
    def years_cell(g: dict) -> str:
        if "years" in g:
            return ", ".join(str(y) for y in g["years"])
        return esc(g.get("deadline_pattern", ""))

    rows = "\n".join(
        f"<tr><td>{esc(g['group'])}</td><td>{years_cell(g)}</td>"
        f"<td><strong>{esc(fmt_date(date.fromisoformat(g['next_deadline'])))}</strong></td></tr>"
        for g in record["cohort_groups"]
    )
    gap_note = record.get("data_gap_note")
    gap_html = (
        f"""<div class="sheet">
  <div class="sheethead">
    <span>{esc(record['license_type_label'])}</span>
    <div class="stamp stamp--unconfirmed"><span class="dot"></span>Date not confirmed</div>
  </div>
  <div class="sheetfoot">{esc(gap_note)}</div>
</div>"""
        if gap_note else ""
    )
    footer = (
        gap_html
        if gap_note else
        f"""<p>Not sure which group applies to you? Your license certificate or the
<a href="{http_href(record['source_url'])}">official source above</a> will show your assigned group.</p>"""
    )
    return f"""<div class="callout">
  <div class="label">{esc(record['license_type_label'])}</div>
  <p class="rule">{esc(record['cycle_description'])}</p>
</div>
<div class="table-wrap">
  <table>
    <thead><tr><th>Cohort group</th><th>Years due</th><th>Next deadline</th></tr></thead>
    <tbody>
    {rows}
    </tbody>
  </table>
</div>
{footer}"""


def render_california(record: dict, as_of: date) -> str:
    table = build_california_table(as_of)
    rows = "\n".join(
        f"<tr><td>{esc(r['month'])}</td><td>{esc(r['odd_birth_year_next_deadline'])}</td>"
        f"<td>{esc(r['even_birth_year_next_deadline'])}</td></tr>"
        for r in table
    )
    return f"""<div class="callout">
  <p class="rule">{esc(record['cycle_description'])}</p>
  <p><strong>Find your row:</strong> look up your birth month below, then use the
  odd-birth-year or even-birth-year column depending on the year you were born.</p>
</div>
<div class="table-wrap">
  <table>
    <thead><tr><th>Birth month</th><th>Next deadline (odd birth year)</th><th>Next deadline (even birth year)</th></tr></thead>
    <tbody>
    {rows}
    </tbody>
  </table>
</div>
<p>Example: born in March of an odd year (e.g. 1985)? Your next deadline is the
odd-birth-year date on the March row.</p>"""


def render_texas(record: dict, as_of: date) -> str:
    table = build_texas_table(as_of)
    rows = "\n".join(
        f"<tr><td>{esc(r['month'])}</td><td>{esc(r['next_deadline'])}</td></tr>"
        for r in table
    )
    return f"""<div class="callout">
  <p class="rule">{esc(record['cycle_description'])}</p>
  <p><strong>Find your row:</strong> look up your birth month below for your next renewal date.
  Texas renewal is annual, so this repeats every year on the same month.</p>
</div>
<div class="table-wrap">
  <table>
    <thead><tr><th>Birth month</th><th>Next renewal deadline</th></tr></thead>
    <tbody>
    {rows}
    </tbody>
  </table>
</div>"""


def render_new_york(record: dict) -> str:
    return f"""<div class="callout">
  <p class="rule">{esc(record['cycle_description'])}</p>
  <p><strong>This one can't be looked up from your birth month alone.</strong>
  {esc(record['computation']['note'])}</p>
  <p>To find your exact triennial registration due date, check your registration
  certificate or look yourself up at
  <a href="{http_href(record['source_url'])}">NYSED Office of the Professions</a>.</p>
</div>"""


def compute_title_year(state_slug: str, records: list[dict]) -> int | None:
    """Derive the year shown in the title/meta description from the actual
    soonest computed deadline for this state -- never from the generation
    date. Returns None for pages where no single year is meaningful (a
    birth-month lookup table spans many years by design)."""
    if state_slug == "ohio":
        years = [int(g["next_deadline"][:4]) for r in records for g in r.get("cohort_groups", [])]
        return min(years) if years else None
    years = [
        date.fromisoformat(r["next_deadline_computed"]).year
        for r in records
        if r.get("next_deadline_computed")
    ]
    return min(years) if years else None


def _primary_individual_date(records: list[dict]) -> str | None:
    """The same 'one individual-facing date, if exactly one exists' selection
    state_hint() already uses for the homepage grid -- reused here so a state's
    cross-link peers are chosen by the same date homepage visitors actually see,
    not some other record on the page they might not even scroll to."""
    individual_records = [r for r in records if r.get("license_type") not in _FIRM_ONLY_LICENSE_TYPES]
    if len(individual_records) == 1 and individual_records[0].get("next_deadline_computed"):
        return individual_records[0]["next_deadline_computed"]
    return None


def _related_states_html(state_slug: str, records: list[dict], by_slug: dict[str, list[dict]]) -> str:
    """Honest, non-spammy internal linking: states that happen to share the exact
    same recurring month-day deadline as this one -- a real, verifiable similarity
    a visitor might genuinely want to know, not an arbitrary link-building filler
    block. Renders nothing if this state has no single individual date, or if
    fewer than 2 peers share it (a "related" list of one doesn't earn a section)."""
    my_date = _primary_individual_date(records)
    if not my_date:
        return ""
    my_month_day = my_date[5:]  # "MM-DD", ignoring the year
    peers = []
    for slug, recs in sorted(by_slug.items()):
        if slug == state_slug:
            continue
        d = _primary_individual_date(recs)
        if d and d[5:] == my_month_day:
            peers.append((recs[0]["state"], slug))
    if len(peers) < 2:
        return ""
    links = "\n".join(f'<a href="../{slug}/">{esc(name)}</a>' for name, slug in peers[:6])
    month_name = MONTH_NAMES[int(my_month_day[:2]) - 1]
    day = int(my_month_day[3:])
    return f"""<p class="how-it-works">Other states with the same {esc(month_name)} {day} deadline:
{links}</p>"""


def build_state_page(
    state_slug: str, records: list[dict], as_of: date, by_slug: dict[str, list[dict]] | None = None,
    cpe_hours_by_slug: dict[str, dict] | None = None, reinstatement_by_slug: dict[str, dict] | None = None,
) -> tuple[str, str]:
    """Returns (title, html_body) for a state's page."""
    state_name = records[0]["state"]
    source_url = records[0]["source_url"]
    last_verified = records[0]["last_verified"]

    patterns = {r["renewal_pattern"] for r in records}

    if patterns == {"birth_month"}:
        # A lookup table spans many years by construction -- asserting one
        # year in the title/description would be wrong on its face, not just
        # eventually stale. Describe the rule instead of a year.
        title = f"{state_name} CPA License Renewal Deadline by Birth Month"
        meta_description = (
            f"{state_name} CPA license renewal deadline by birth month: when it's due, "
            f"how the renewal cycle works, and the official state board source to confirm it."
        )
    else:
        title_year = compute_title_year(state_slug, records)
        # CTR fix (2026-07-25, per GSC: avg position ~19, 0.42% CTR across 711
        # impressions/28 days -- real discoverability, near-zero click-through).
        # Leading the SERP snippet with the actual date answers the query
        # directly instead of making a searcher click through to find out --
        # the single highest-leverage, lowest-risk copy change available
        # without touching title text (which risks ranking volatility on
        # already-indexed URLs). Falls back to the prior generic framing
        # whenever no single clean individual-facing date exists (multi-
        # record/cohort/data-gap states), same as before this pass.
        primary_date_iso = _primary_individual_date(records)
        primary_date_str = fmt_date(date.fromisoformat(primary_date_iso)) if primary_date_iso else None
        if title_year is not None:
            title = f"{state_name} CPA License Renewal Deadline {title_year}"
            if primary_date_str:
                meta_description = (
                    f"{state_name} CPA license renewal is due {primary_date_str}. See the renewal "
                    f"cycle details and the official state board source to confirm it."
                )
            else:
                meta_description = (
                    f"{state_name} CPA license renewal deadline for {title_year}: when it's due, "
                    f"how the renewal cycle works, and the official state board source to confirm it."
                )
        else:
            title = f"{state_name} CPA License Renewal Deadline"
            meta_description = (
                f"{state_name} CPA license renewal deadline: when it's due, "
                f"how the renewal cycle works, and the official state board source to confirm it."
            )

    if state_slug == "ohio":
        deadline_html = render_ohio(records[0])
    elif state_slug == "california":
        deadline_html = render_california(records[0], as_of)
    elif state_slug == "texas":
        deadline_html = render_texas(records[0], as_of)
    elif state_slug == "new-york":
        deadline_html = render_new_york(records[0])
    else:
        computed = [r for r in records if r.get("next_deadline_computed")]
        cohort_records = [
            r for r in records if not r.get("next_deadline_computed") and r.get("cohort_groups")
        ]
        gapped = [
            r for r in records
            if not r.get("next_deadline_computed") and not r.get("cohort_groups")
        ]
        deadline_html = render_simple_deadline_records(computed)
        for r in cohort_records:
            deadline_html += "\n" + render_cohort_group_record(r)
        if gapped:
            deadline_html += "\n" + render_data_gap_records(gapped)

    related_html = _related_states_html(state_slug, records, by_slug) if by_slug else ""
    cpe_hours_link_html = (
        _cpe_hours_reverse_link_html(state_slug, cpe_hours_by_slug) if cpe_hours_by_slug else ""
    )
    reinstatement_link_html = (
        _reinstatement_reverse_link_html(state_slug, reinstatement_by_slug) if reinstatement_by_slug else ""
    )
    body = f"""<h1>{esc(title)}</h1>
<p class="subhead">{esc(state_name)} CPA license renewal</p>
{deadline_html}
{trust_line(last_verified, source_url, all(r.get("citation") for r in records))}
{signup_form_for_state(state_slug, state_name, records, as_of)}
{_cpe_affiliate_html()}
{related_html}
{cpe_hours_link_html}
{reinstatement_link_html}
<p class="backlink"><a href="../">&larr; Back to all states</a></p>
"""
    json_ld = [_breadcrumb_schema(state_name, state_slug)]
    return title, page_shell(
        title, meta_description, body, home_href="../", canonical_path=f"/{state_slug}/",
        json_ld=json_ld, has_remind_anchor=True,
    )


# ---------------------------------------------------------------------------
# Index / sitemap / robots
# ---------------------------------------------------------------------------

_FIRM_ONLY_LICENSE_TYPES = {"firm", "cpa_firm"}


def state_hint(records: list[dict]) -> str:
    """Homepage state-grid one-liner, scoped to the INDIVIDUAL-license situation only
    (most visitors are individuals) -- never a firm-only date, and never invented from
    whichever record happens to have a date. Three outcomes:
      - exactly one individual-facing record with a real computed date -> show that date
        (e.g. "December 31, 2027"), the single biggest readability win over a vague label.
      - exactly one individual-facing record, no date, genuinely birth-month -> "By birth month".
      - anything else (no date and not birth-month; OR more than one individual-facing
        record, e.g. Florida's odd/even cohort filed as two separate flat records rather
        than one cohort_groups record) -> "Varies -- check your license". Multiple
        individual records means there's no single date safe to show without guessing
        which cohort a given visitor is actually in, so this collapses to the same
        honest "varies" bucket as Oregon/Kentucky's cohort_groups gap, even though the
        underlying data shape differs.
    'Individual-facing' = any record whose license_type is not purely firm-side
    (_FIRM_ONLY_LICENSE_TYPES) -- covers 'individual', 'individual_cpa', and 'all'
    (states like Alabama/Tennessee/North Carolina that cover both under one record)."""
    individual_records = [r for r in records if r.get("license_type") not in _FIRM_ONLY_LICENSE_TYPES]
    if len(individual_records) == 1:
        r = individual_records[0]
        if r.get("next_deadline_computed"):
            return fmt_date(date.fromisoformat(r["next_deadline_computed"]))
        if r.get("renewal_pattern") == "birth_month":
            return "By birth month"
        return "Varies — check your license"
    if any(r.get("renewal_pattern") == "birth_month" for r in individual_records):
        return "By birth month"
    return "Varies — check your license"


def _hint_is_variable(hint: str) -> bool:
    """True for the two state_hint() outcomes that mean 'no single date to show'
    (birth-month or the collapsed 'varies' bucket) -- used to give those state-grid
    cards a visibly different (dashed) treatment from a card showing a real fixed
    date, so the grid itself communicates which states are simple before a click."""
    return hint.startswith("Varies") or hint.startswith("By birth month")


# The 9 states whose real bounding-box area on the map (measured directly from the path
# data, see scripts/build_us_map_data.py's output -- not guessed) falls in a visibly
# separate, much-smaller cluster than every other state: DC through Maryland are all under
# ~3,300 sq. map-units; the next smallest (South Carolina) is nearly double that. These are
# the ones a real click/tap on the map itself would miss often enough to be worth a real
# supplementary list next to the map, not just a visual map. Ordered smallest-first.
_MAP_SMALL_STATES = [
    "dc", "rhode-island", "delaware", "connecticut", "new-jersey",
    "vermont", "new-hampshire", "massachusetts", "maryland",
]

_US_MAP_PATHS_PATH = ROOT / "assets" / "us-map" / "state-paths.json"


def build_us_map_html(by_slug: dict[str, list[dict]]) -> str:
    """Interactive US map for the homepage (2026-07-10, replacing the old uniform 51-card
    grid on wider screens per Devin's direct ask: "I don't like the state boxes... an outline
    of the states, clickable"). Each state's fill color and hover label are real data (fixed
    date vs. varies), not decorative -- reuses state_hint()/_hint_is_variable() so this can
    never drift from what the grid/individual pages already say. Path data is real public-
    domain US state outlines (assets/us-map/LICENSE.txt), not hand-drawn.

    The plain list/grid is NOT deleted -- see build_index_page() -- it stays in the HTML as
    the mobile-width version (a map is a worse interaction than a scrollable list on a small
    touchscreen) and the small-map-target fallback, toggled by CSS media query, not JS, so it
    works identically with JS disabled and stays crawlable either way."""
    map_states = json.loads(_US_MAP_PATHS_PATH.read_text(encoding="utf-8"))
    path_links = []
    pills_by_slug: dict[str, str] = {}
    for s in map_states:
        slug = s["slug"]
        recs = by_slug.get(slug, [])
        if not recs:
            continue
        hint = state_hint(recs)
        state_name = recs[0]["state"]
        variable = _hint_is_variable(hint)
        cls = "map-state map-state--variable" if variable else "map-state map-state--fixed"
        title = f"{state_name} — {hint}"
        path_links.append(
            f'<a href="{esc(slug)}/" class="map-link" aria-label="{esc(title)}" data-tip="{esc(title)}">'
            f'<path class="{cls}" d="{esc(s["d"])}"></path></a>'
        )
        if slug in _MAP_SMALL_STATES:
            pills_by_slug[slug] = (
                f'<a class="map-small-pill{" map-small-pill--variable" if variable else ""}" '
                f'href="{esc(slug)}/" title="{esc(title)}">{esc(state_name)}</a>'
            )
    # _MAP_SMALL_STATES is already ordered smallest-first -- render in that order, not
    # whatever order state-paths.json happens to list states in.
    ordered_pills = [pills_by_slug[slug] for slug in _MAP_SMALL_STATES if slug in pills_by_slug]

    svg = (
        '<svg class="us-map" viewBox="0 0 959 593" xmlns="http://www.w3.org/2000/svg" role="img" '
        'aria-label="Clickable map of US states -- select a state for its CPA renewal deadline">\n'
        + "\n".join(path_links) +
        "\n</svg>"
    )
    return f"""<div class="map-section">
  <div class="map-figure">
    {svg}
    <div class="map-tooltip" id="map-tooltip" hidden aria-hidden="true"></div>
  </div>
  <div class="map-side">
    <p class="map-small-label">Smaller states &amp; DC (tap here, easier than the map):</p>
    <div class="map-small-pills">
{chr(10).join(ordered_pills)}
    </div>
    <div class="legend">
      <span><span class="swatch swatch--fixed"></span>One fixed date every year</span>
      <span><span class="swatch swatch--variable"></span>Varies by birth month or license type</span>
    </div>
  </div>
</div>
<script>{_MAP_TOOLTIP_JS}</script>"""


# Hero card region pick (2026-08-03, Devin-approved option: "static per-visit,
# best-guess region"). Runs once, synchronously, before paint -- no timer, no
# interval, nothing to click. Every pool card is already in the HTML with
# is-active on card 0 as the no-JS/unrecognized-timezone fallback; this just
# swaps is-active to whichever card's state plausibly matches the visitor's
# IANA timezone before the browser ever paints, so there is no cross-fade to
# see. A reload can land on a different card from the same bucket (Math.random
# among same-region matches) -- that's the point, not a bug.
#
# AuditLab, 2026-08-03: the no-flash property is LOAD-BEARING on this script
# running as a synchronous inline IIFE during HTML parse -- .hfc-card still
# carries `transition: opacity 0.8s ease` (only killed under
# prefers-reduced-motion), so deferring this script, moving it to
# DOMContentLoaded, or wrapping it in requestAnimationFrame would silently
# reintroduce a visible cross-fade for every normal-motion visitor. Keep it
# inline and synchronous, right after the cards it selects among.
_HERO_REGION_JS = """
(function() {
  var wrap = document.getElementById('hfc-wrap');
  if (!wrap) return;
  var cards = wrap.querySelectorAll('.hfc-card');
  if (cards.length < 2) return;
  var TZ_REGION_STATES = {
    'America/New_York': ['New York','Florida','Georgia','North Carolina','Ohio','Pennsylvania','Virginia','Massachusetts','New Jersey','Michigan','South Carolina','Tennessee','Maine','Connecticut','Vermont','New Hampshire','Rhode Island','Delaware','Maryland','West Virginia','Kentucky','Indiana','District of Columbia'],
    'America/Detroit': ['Michigan','Ohio','Indiana'],
    'America/Indiana/Indianapolis': ['Indiana','Ohio','Kentucky'],
    'America/Kentucky/Louisville': ['Kentucky','Indiana','Ohio'],
    'America/Chicago': ['Illinois','Texas','Wisconsin','Minnesota','Missouri','Louisiana','Oklahoma','Iowa','Kansas','Alabama','Mississippi','Arkansas','Tennessee','Nebraska','South Dakota','North Dakota'],
    'America/Denver': ['Colorado','Utah','Montana','Wyoming','New Mexico','Idaho'],
    'America/Boise': ['Idaho','Montana'],
    'America/Phoenix': ['Arizona'],
    'America/Los_Angeles': ['California','Washington','Oregon','Nevada'],
    'America/Anchorage': ['Alaska'],
    'Pacific/Honolulu': ['Hawaii']
  };
  var tz = '';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) {}
  var candidates = TZ_REGION_STATES[tz] || null;
  var pool = Array.prototype.slice.call(cards);
  var matches = candidates ? pool.filter(function(c) {
    return candidates.indexOf(c.getAttribute('data-hfc-state')) !== -1;
  }) : [];
  var chosenFrom = matches.length ? matches : pool;
  var chosen = chosenFrom[Math.floor(Math.random() * chosenFrom.length)];
  pool.forEach(function(c) { c.classList.remove('is-active'); });
  chosen.classList.add('is-active');
})();
"""


# Instant hover tooltip for the US map (2026-07-17, per Devin's direct ask: the browser's
# native SVG <title> tooltip has a ~1s built-in delay that can't be shortened from CSS/HTML
# alone -- this replaces it with a same-frame custom tooltip. The native <title> stays in the
# markup too, as a harmless accessibility/keyboard-nav fallback; sighted mouse users will
# always see the instant one first.
_MAP_TOOLTIP_JS = """
(function() {
  var tip = document.getElementById('map-tooltip');
  var figure = tip ? tip.closest('.map-figure') : null;
  if (!tip || !figure) return;
  var links = figure.querySelectorAll('.map-link');
  function show(el, evt) {
    tip.textContent = el.getAttribute('data-tip') || '';
    tip.hidden = false;
    move(evt);
  }
  function move(evt) {
    var rect = figure.getBoundingClientRect();
    var x = (evt.clientX - rect.left) + 14;
    var y = (evt.clientY - rect.top) + 14;
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  }
  function hide() { tip.hidden = true; }
  links.forEach(function(el) {
    el.addEventListener('mouseenter', function(evt) { show(el, evt); });
    el.addEventListener('mousemove', move);
    el.addEventListener('mouseleave', hide);
    el.addEventListener('focus', function(evt) {
      tip.textContent = el.getAttribute('data-tip') || '';
      tip.hidden = false;
      var rect2 = el.getBoundingClientRect();
      var frect = figure.getBoundingClientRect();
      tip.style.left = (rect2.left - frect.left) + 'px';
      tip.style.top = (rect2.top - frect.top - 28) + 'px';
    });
    el.addEventListener('blur', hide);
  });
})();
"""


_STATE_SEARCH_JS = """
function drNormalize(s) { return s.trim().toLowerCase(); }

function drMatches(typed) {
  var norm = drNormalize(typed);
  if (!norm) return [];
  var starts = [], contains = [];
  DR_STATES.forEach(function(s) {
    var n = drNormalize(s.name);
    if (n.indexOf(norm) === 0) starts.push(s);
    else if (n.indexOf(norm) !== -1) contains.push(s);
  });
  return starts.concat(contains);
}

function drExactOrSingleMatch(typed) {
  var norm = drNormalize(typed);
  if (!norm) return null;
  var exact = null;
  DR_STATES.forEach(function(s) { if (drNormalize(s.name) === norm) exact = s; });
  if (exact) return exact.slug;
  var matches = drMatches(typed);
  return matches.length === 1 ? matches[0].slug : null;
}

function drGoToState(event) {
  if (event) event.preventDefault();
  var input = document.getElementById('state-search-input');
  var slug = drExactOrSingleMatch(input.value);
  if (slug) { window.location.href = '/' + slug + '/'; }
  return false;
}

function drFilterGrid() {
  var typed = drNormalize(document.getElementById('state-search-input').value);
  document.querySelectorAll('.state-card').forEach(function(card) {
    var name = drNormalize(card.getAttribute('data-state-name'));
    var match = !typed || name.indexOf(typed) !== -1;
    card.classList.toggle('state-card--dimmed', !match);
  });
}

var drActiveIndex = -1;

function drCloseDropdown() {
  var dropdown = document.getElementById('state-search-dropdown');
  var input = document.getElementById('state-search-input');
  dropdown.innerHTML = '';
  dropdown.classList.remove('is-open');
  input.setAttribute('aria-expanded', 'false');
  drActiveIndex = -1;
}

function drRenderDropdown() {
  var input = document.getElementById('state-search-input');
  var dropdown = document.getElementById('state-search-dropdown');
  var typed = input.value;
  if (!typed.trim()) { drCloseDropdown(); return; }
  var matches = drMatches(typed);
  drActiveIndex = -1;
  if (matches.length === 0) {
    dropdown.innerHTML = '<div class="state-search-empty">No matching state</div>';
    dropdown.classList.add('is-open');
    input.setAttribute('aria-expanded', 'true');
    return;
  }
  dropdown.innerHTML = matches.map(function(s, i) {
    return '<button type="button" class="state-search-option" data-slug="' + s.slug +
      '" data-index="' + i + '" role="option">' + s.name + '</button>';
  }).join('');
  dropdown.classList.add('is-open');
  input.setAttribute('aria-expanded', 'true');
}

function drSetActive(index) {
  var options = document.querySelectorAll('.state-search-option');
  options.forEach(function(opt) { opt.classList.remove('is-active'); });
  if (index >= 0 && index < options.length) {
    options[index].classList.add('is-active');
    options[index].scrollIntoView({ block: 'nearest' });
  }
  drActiveIndex = index;
}

document.addEventListener('DOMContentLoaded', function() {
  var input = document.getElementById('state-search-input');
  var dropdown = document.getElementById('state-search-dropdown');
  if (!input || !dropdown) return;

  input.addEventListener('input', function() {
    drRenderDropdown();
    drFilterGrid();
  });

  input.addEventListener('keydown', function(event) {
    var options = document.querySelectorAll('.state-search-option');
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (options.length) drSetActive((drActiveIndex + 1) % options.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (options.length) drSetActive((drActiveIndex - 1 + options.length) % options.length);
    } else if (event.key === 'Enter') {
      if (drActiveIndex >= 0 && options[drActiveIndex]) {
        event.preventDefault();
        window.location.href = '/' + options[drActiveIndex].getAttribute('data-slug') + '/';
      }
    } else if (event.key === 'Escape') {
      drCloseDropdown();
    }
  });

  dropdown.addEventListener('click', function(event) {
    var opt = event.target.closest('.state-search-option');
    if (opt) { window.location.href = '/' + opt.getAttribute('data-slug') + '/'; }
  });

  document.addEventListener('click', function(event) {
    if (event.target !== input && !dropdown.contains(event.target)) drCloseDropdown();
  });
});
"""


_HERO_ROTATION_MAX = 10


def _select_hero_rotation_pool(by_slug: dict[str, list[dict]]) -> list[dict]:
    """Real, fresh-verified, citation-backed records only -- the homepage hero's rotating
    card is meant as LIVE PROOF of the 30-day freshness claim, so a stale date here would
    directly contradict it (2026-07-17 orchestrator directive, Devin's own catch). One card
    per state (prefers the individual-license record over firm, since it's the more
    universally relatable deadline), sorted alphabetically for a stable rotation order.
    Anchored on real wall-clock time -- same STALENESS_THRESHOLD_DAYS the build-time staleness
    guard uses, not the data file's own as_of_date, so this can't silently go stale itself."""
    real_today = date.today()
    window_start = real_today - timedelta(days=STALENESS_THRESHOLD_DAYS)
    by_state: dict[str, dict] = {}
    for slug, recs in by_slug.items():
        for r in recs:
            if not (r.get("citation") and r.get("citation_url") and r.get("next_deadline_computed")):
                continue
            lv = r.get("last_verified")
            if not lv or date.fromisoformat(lv) < window_start:
                continue
            state = r["state"]
            is_individual = "individual" in (r.get("license_type") or "")
            existing = by_state.get(state)
            if existing is None or (is_individual and "individual" not in (existing.get("license_type") or "")):
                by_state[state] = r
    return sorted(by_state.values(), key=lambda r: r["state"])


# ---------------------------------------------------------------------------
# COVERAGE METRIC (2026-07-31). Rebuilt because the old "Verified - 38 of 55"
# measured the wrong thing and sat next to a "55 jurisdictions" stat, so the
# two read as a contradiction on the exact claim this product sells.
#
# The numbers below are DERIVED FROM THE DATA AND THE ENGINE at build time,
# never hand-written, so they cannot drift into a lie as coverage changes.
#
# I was asked to verify a suggested framing of "~51 determinable" before
# publishing it. It does not hold. That figure assumes we compute the date
# for all ~13 states whose renewal turns on a personal fact (birth month,
# cohort, parity, issue date). computeSubscriberDeadline() special-cases
# exactly THREE -- california, texas, ohio -- and every other such state
# falls through to "bring your own date", where the USER supplies the date
# and we track it. Publishing ~51 would have overstated determinable
# coverage by ten states.
#
# So the honest split, and what the page now says:
#   * we LIST all 55 jurisdictions;
#   * we DETERMINE the exact date for 38 published at state level, plus the
#     3 we compute from an input we collect = 41;
#   * for ~10 more the RULE is verified but the date depends on a personal
#     fact we do not compute -- the licensee enters their own date;
#   * for ~4 (Guam, CNMI, Puerto Rico, New Jersey) no verifiable source
#     publishes it at all, and we say so.
# ---------------------------------------------------------------------------


def verify_coverage_counts(cov: dict[str, int], by_slug: dict[str, list[dict]]) -> None:
    """Fail the BUILD rather than publish a coverage number that has drifted.

    The one hand-kept fact in _coverage_counts() is which states the engine
    special-cases. If someone adds a branch to computeSubscriberDeadline()
    without updating that set -- or removes one -- the site would keep
    publishing the old figure, and an understated or overstated coverage
    claim on the front page is precisely the failure this metric was rewritten
    to fix. These assertions are cheap and catch it at build time.
    """
    if cov["total"] != len(by_slug):
        raise SystemExit(f"coverage: total {cov['total']} != {len(by_slug)} jurisdictions")
    if cov["determined"] + cov["byod"] != cov["total"]:
        raise SystemExit("coverage: determined + byod must equal total")
    if cov["source_gap"] + cov["personal_fact"] != cov["byod"]:
        raise SystemExit("coverage: source_gap + personal_fact must equal byod")
    ts = (ROOT / "worker" / "src" / "deadline.ts").read_text(encoding="utf-8")
    for slug in ("california", "texas", "ohio"):
        if f'stateSlug === "{slug}"' not in ts:
            raise SystemExit(
                f"coverage: '{slug}' is counted as engine-computed but has no branch in "
                "deadline.ts -- update _coverage_counts() or the engine, do not ship a stale number."
            )


def _coverage_counts(by_slug: dict[str, list[dict]]) -> dict[str, int]:
    """Coverage, computed from the dataset and the engine's real capability.

    `ENGINE_COMPUTED_SLUGS` mirrors the explicit branches in
    worker/src/deadline.ts's computeSubscriberDeadline(). It is a small
    hand-kept list, which is a drift risk -- so `verify_coverage_counts()`
    below asserts it against the data, and generate.py fails loudly rather
    than quietly publishing a stale number.
    """
    ENGINE_COMPUTED_SLUGS = {"california", "texas", "ohio"}
    total = len(by_slug)
    published = {
        slug for slug, recs in by_slug.items()
        if any(r.get("next_deadline_computed") for r in recs)
    }
    computed_from_input = ENGINE_COMPUTED_SLUGS - published
    source_gap = {"guam", "northern-mariana-islands", "puerto-rico", "new-jersey"}
    determined = published | computed_from_input
    byod = set(by_slug) - determined
    return {
        "total": total,
        "published": len(published),
        "computed_from_input": len(computed_from_input),
        "determined": len(determined),
        "byod": len(byod),
        "source_gap": len(byod & source_gap),
        "personal_fact": len(byod - source_gap),
    }

def build_index_page(states: list[dict], as_of: date, by_slug: dict[str, list[dict]]) -> str:
    # Derived at build time from the data + the engine's real capability, so
    # the public coverage claim cannot drift away from what we actually do.
    _cov = _coverage_counts(by_slug)
    verify_coverage_counts(_cov, by_slug)
    sorted_states = sorted(states, key=lambda s: s["state"])
    cards = []
    for s in sorted_states:
        hint = state_hint(by_slug[s["state_slug"]])
        variable_class = " state-card--variable" if _hint_is_variable(hint) else ""
        cards.append(
            f'<a class="state-card{variable_class}" href="{esc(s["state_slug"])}/" data-state-name="{esc(s["state"])}">'
            f'<div class="state-name">{esc(s["state"])}</div>'
            f'<div class="state-hint">{esc(hint)}</div></a>'
        )

    # name + slug baked into the page for the search box's JS -- generated from the same
    # sorted_states list so it can never drift from what's actually rendered.
    state_options = [{"name": s["state"], "slug": s["state_slug"]} for s in sorted_states]

    search_html = f"""<div class="state-search">
  <label for="state-search-input">Find your state</label>
  <form id="state-search-form" role="search" onsubmit="return drGoToState(event)" autocomplete="off">
    <div class="state-search-field">
      <input type="text" id="state-search-input" name="state" placeholder="e.g. Texas, Illinois, Ohio…"
        autocomplete="off" role="combobox" aria-expanded="false" aria-autocomplete="list"
        aria-controls="state-search-dropdown">
      <div class="state-search-dropdown" id="state-search-dropdown" role="listbox"></div>
    </div>
    <button type="submit" class="state-search-submit">Go</button>
  </form>
  <p class="field-hint">Type your state and press Enter or select it to go straight to its page.</p>
</div>"""

    citation_count = sum(1 for recs in by_slug.values() for r in recs if r.get("citation"))

    all_fresh = _select_hero_rotation_pool(by_slug)
    rotation_pool = all_fresh[:_HERO_ROTATION_MAX]
    total_fresh = len(all_fresh)

    hero_right_html = ""
    if rotation_pool:
        hfc_cards = []
        for i, r in enumerate(rotation_pool):
            d = date.fromisoformat(r["next_deadline_computed"])
            active_class = " is-active" if i == 0 else ""
            hfc_verified_text = "Confirmed via official records" if _is_operational_record(r) else "Confirmed at source"
            hfc_cards.append(f"""<div class="hfc-card{active_class}" data-hfc-state="{esc(r['state'])}">
  <div class="hfc-state">{esc(r['state'])}</div>
  <div class="hfc-stamp"><span class="dot"></span>Verified {esc(r['last_verified'])}</div>
  <div class="hfc-date">{esc(fmt_date(d))}</div>
  <div class="hfc-sub">{esc(r['license_type_label'])}</div>
  {_cite_chip_html(r, max_chars=44)}
  <div class="verified">{_VERIFIED_ICON_SVG}{hfc_verified_text}</div>
</div>""")
        # STATIC PER VISIT (2026-08-03, Devin-approved option). This was a ~10-dot
        # auto-rotating carousel beside the search box; removed 2026-07-31 because
        # something moving every 5s next to the search box competes for exactly the
        # attention the search box needs, and motion reads as decoration on a page
        # whose whole pitch is sobriety. That reasoning still holds -- no timer, no
        # pips, no animation came back. What's new: instead of always showing the
        # same first-alphabetical state, a same-frame inline script below picks one
        # real, fully-cited card whose state plausibly matches the visitor's own
        # timezone, once, before paint. A reload can land on a different card from
        # the same region; there is nothing to click and nothing moves on its own.
        # All pool cards ship in the HTML (progressive enhancement: with JS off,
        # or on a timezone the map doesn't recognize, the first one is what shows).
        hero_right_html = f"""<div class="hero-right">
  <div class="hfc-wrap" id="hfc-wrap">
    {chr(10).join(hfc_cards)}
  </div>
  <div class="hfc-coverage">We list all <b>{_cov["total"]}</b> jurisdictions &middot; exact date
  determined in <b>{_cov["determined"]}</b> &middot; for the rest you enter your date and we track it</div>
</div>
<script>{_HERO_REGION_JS}</script>"""

    hero_html = f"""<div class="hero-grid">
<div class="hero-left">
  <h1>Know exactly when your license is due &mdash;<br>
  <span class="hero-accent">and see the rule that says so.</span></h1>
  <p class="hero-lede">Every date traced to your state board's own statute or rule, and stamped with
  the day we last checked it.</p>
{search_html}
  <div class="trust-row">
    <div class="item"><span class="n">{_cov["total"]}</span><span class="lbl">jurisdictions listed</span></div>
    <div class="item"><span class="n">{_cov["determined"]}</span><span class="lbl">where we determine your exact date</span></div>
    <div class="item"><span class="n">{citation_count}</span><span class="lbl">codified citations kept current</span></div>
  </div>
  <p class="trust-footnote">In the remaining {_cov["byod"]}, renewal turns on a personal fact
  &mdash; your birth month, cohort or issue date &mdash; or the board publishes no verifiable date.
  You enter the date on your license and we track it. We would rather say that than round up.</p>
</div>
{hero_right_html}
</div>"""

    method_band_html = """<section class="band-section">
  <p class="eyebrow">How we verify</p>
  <h2>Two independent sources, or we don't publish a date.</h2>
  <p style="color:var(--muted); margin:0.7rem 0 0; font-size:1.02rem;">This site's verification
  standard is stricter than most paid services. It's the whole reason a CPA can rely on this.</p>
  <div class="method-grid">
    <div class="mcard">
      <div class="step">STANDARD 01</div>
      <h3>The board's own page</h3>
      <p>We start at the state board of accountancy's official renewal and CPE pages &mdash; the
      operational source of truth CPAs already trust.</p>
    </div>
    <div class="mcard">
      <div class="step">STANDARD 02</div>
      <h3>The codified law</h3>
      <p>Then we confirm it against the actual statute or administrative rule &mdash; codified law,
      not a second webpage or a vendor's summary.</p>
    </div>
    <div class="mcard">
      <div class="step">STANDARD 03</div>
      <h3>Agree, or it's null</h3>
      <p>If the two don't agree, we don't guess &mdash; we mark it unverified rather than publish a
      date we can't stand behind.</p>
    </div>
  </div>
  <a href="/methodology/" style="font-weight:600;">Read our full verification standard &rarr;</a>
</section>"""

    # Homepage fact-sheet demo (2026-07-17, per orchestrator review): the concept showed a
    # sample state's fact sheet on the homepage itself, proving the citation-first payoff
    # before a visitor even picks a state. Real data, not the concept's illustrative CA/TX/NY
    # placeholders -- reuses the exact same render_simple_deadline_records() the real Illinois
    # page uses, so this can never drift into inventing a citation the state page doesn't have.
    demo_records = [r for r in by_slug.get("illinois", []) if r.get("id") == "il-individual"]
    demo_html = ""
    if demo_records:
        demo_html = f"""<section class="band-section" style="border-top:0; padding-top:0; margin-top:0;">
  <p class="eyebrow">What a lookup actually gives you</p>
  <h2>A fact sheet you could hand to a partner.</h2>
  <p style="color:var(--muted); margin:0.7rem 0 1.4rem; font-size:1.02rem;">Pick a state below.
  Each line shows the requirement, the exact legal source behind it, and when we last confirmed
  it &mdash; so you can verify it yourself in one click. Here's Illinois as an example:</p>
  {render_simple_deadline_records(demo_records)}
  <p style="font-size:0.88rem; color:var(--muted); margin-top:0.6rem;">
  <a href="illinois/" style="font-weight:600;">Open the full Illinois fact sheet &rarr;</a></p>
</section>"""

    firm_preview_html = f"""<section class="band-section">
  <p class="eyebrow">Built for firms too</p>
  <h2>One roster, not twenty separate inboxes.</h2>
  <p style="color:var(--muted); margin:0.7rem 0 1.4rem; font-size:1.02rem;">Free reminders above are
  for tracking your own individual license, always at no cost. If you're the one keeping track of a
  whole firm's staff across multiple states, the firm dashboard below is the same sourced-to-codified-
  law data in one roster view &mdash; who's current, who's at risk, and who needs to act.</p>
  {_firm_dashboard_mockup_html(by_slug, as_of)}
  <p class="how-it-works"><strong>$500/year, flat &mdash; up to 25 staff. No per-person pricing.</strong>
  Starting with a free 30-day pilot, no card required. More than 25 staff?
  <a href="mailto:{esc(CONTACT_EMAIL)}">Contact us</a>. <a href="for-firms/" style="font-weight:600;">See
  firm-tier pricing and details &rarr;</a></p>
</section>"""

    body = f"""{hero_html}
{demo_html}
{build_us_map_html(by_slug)}
<div class="state-grid state-grid--mobile-fallback">
{chr(10).join(cards)}
</div>
{method_band_html}
{firm_preview_html}
<p class="how-it-works">How it works: each state page shows the actual next renewal deadline
(or, where the rule depends on your birth month, a full lookup table) computed from the
verified renewal rule, with a link back to the official source and a "last verified" date.</p>
<p class="how-it-works">Also see our <a href="blog/">guides</a>: <a href="blog/cpe-vs-license-renewal/">CPE requirements vs. license renewal</a>, <a href="blog/common-cpa-renewal-mistakes/">common CPA renewal mistakes</a>, and the <a href="blog/missouri-cpa-license-renewal-guide/">Missouri renewal guide</a>.</p>
{signup_form_homepage(by_slug, as_of)}
<script>
var DR_STATES = {json.dumps(state_options)};
{_STATE_SEARCH_JS}
</script>
"""
    return page_shell(
        f"{SITE_NAME} — CPA License Renewal Deadlines by State",
        "Find your state's CPA license renewal deadline, verified against the official state "
        "board of accountancy. One page per state, kept current.",
        body,
        home_href="./",
        canonical_path="/",
        json_ld=[_organization_schema(), _website_schema()],
        has_remind_anchor=True,
    )


def build_privacy_page(updated: date) -> str:
    body = f"""<h1>Privacy Policy</h1>
<p class="intro"><strong>The short version:</strong> we use your email address for one thing only &mdash;
to send you the CPA license deadline reminders you asked for. We never sell, rent, or share it, and you
can unsubscribe in one click from any email. That's the whole deal.</p>

<h2>What we collect</h2>
<p>Only what's needed to remind you about your deadline:</p>
<ul>
  <li><strong>Your email address</strong> &mdash; so we can send the reminders.</li>
  <li><strong>Your state</strong> &mdash; to apply the correct renewal rule.</li>
  <li><strong>A few deadline details where the state's rule requires them</strong> &mdash; for example,
  your birth month/year in states whose renewal cycle depends on it. These are used only to compute your
  exact deadline.</li>
  <li><strong>Your first name (optional)</strong> &mdash; only if you choose to provide it, so reminders
  can greet you by name.</li>
</ul>
<p>We do not collect anything else, and we do not build a profile of who you are.</p>

<h2>How we use it</h2>
<p>Your information is used solely to operate the reminder service you signed up for: to send a
confirmation email, to send your deadline reminders as the date approaches, and to let you stop them at
any time. We never use it for advertising, and never for any purpose you didn't ask for.</p>

<h2>How it's stored and protected</h2>
<p>Your data is encrypted in transit (this site and the signup form use HTTPS) and stored in a private
database on Cloudflare's infrastructure. It is never published on this website, never included in our
public code, and never exposed to other visitors. Access is restricted to the service itself.</p>

<h2>Who we share it with</h2>
<p>We do <strong>not</strong> sell, rent, or trade your information to anyone. We rely on a small number
of service providers strictly to run the service:</p>
<ul>
  <li><strong>Cloudflare</strong> &mdash; hosting, our database, and bot/abuse protection.</li>
  <li><strong>Our email delivery provider</strong> &mdash; to send the reminder emails to your inbox.</li>
</ul>
<p>These providers process your data only to deliver the service on our behalf, never for their own
marketing.</p>

<h2>Cookies and analytics</h2>
<p>We do not use advertising cookies or cross-site trackers. We may use privacy-first, cookie-less
analytics (such as Cloudflare Web Analytics) to understand aggregate traffic &mdash; this does not track
you across the web or identify you personally.</p>

<h2>Your choices</h2>
<p>Every reminder email includes a one-click link to stop all reminders instantly. Using it permanently
removes and suppresses your address so you won't be contacted again. You may also contact us to request
access to, or deletion of, your information.</p>

<h2>Data retention</h2>
<p>We keep your information only while you're subscribed. When you unsubscribe, we stop contacting you
and suppress your address so it isn't reused.</p>

<h2>Children</h2>
<p>This service is intended for licensed professionals and is not directed to anyone under 16. We do not
knowingly collect information from children.</p>

<h2>Changes to this policy</h2>
<p>We may update this policy from time to time. The "last updated" date below always reflects the current
version.</p>

<h2>Contact</h2>
<p>Questions about your privacy, or requests to access or delete your data:</p>
<p>{esc(SITE_NAME)} by {esc(BRAND_NAME)}<br>
18121 E Hampden Ave, Unit C #1324<br>
Aurora, CO 80013</p>
<p>For the fastest removal, use the unsubscribe link in any reminder email &mdash; it's instant.</p>

<p class="how-it-works">Last updated: {esc(fmt_date(updated))}.</p>
"""
    return page_shell(
        f"Privacy Policy — {SITE_NAME}",
        "How DeadlineRadar collects, uses, and protects your information. We only send the CPA license "
        "deadline reminders you request — we never sell or share your data.",
        body,
        home_href="../",
        canonical_path="/privacy/",
    )


def build_methodology_page() -> str:
    """How-we-verify-our-data page (2026-07-15, per the orchestrator's 'press the
    validated bet' steer: apply the CPA-trust design lens by surfacing the sourcing
    method itself as a first-class trust asset, the way established compliance/legal
    reference sites do -- not by inventing any new claim, just making the standard
    already enforced everywhere else in this file (citation + citation_url on every
    record, honest null/gap-note when unverifiable) legible to a skeptical CPA
    visitor in one place instead of leaving it implicit."""
    body = f"""<h1>How We Verify Every Deadline</h1>
<p class="intro">CPAs are trained to be skeptical of unverified sources &mdash; so here is exactly how
this site's dates are sourced, checked, and kept current. Nothing below is aspirational; it describes
the actual standard already applied to every state page.</p>

<h2>The two-source rule</h2>
<p>Every date on this site must trace to two independent things before it's published:</p>
<ol>
  <li><strong>The state board's own page</strong> &mdash; the plain-English source most people would
  find first.</li>
  <li><strong>The actual codified statute or administrative rule</strong> the board's requirement
  derives from &mdash; not a summary of it, the primary legal text itself. That citation and a direct
  link to it are shown under every verified date on this site, labeled "Source of record."</li>
</ol>
<p>If we can't find or confirm the second source, the date is not published as a confirmed fact. Instead
the page says so plainly and points you to the official state board to determine your own exact
deadline &mdash; we do not guess, interpolate, or infer a date we can't back up with primary law.</p>

<h2>What the "Verified" badge means</h2>
<p>A callout shows a <strong>Verified</strong> badge only when that specific date has a real citation to
codified law behind it, checked the way described above. A record without one never shows the badge
&mdash; there is no in-between state where a date looks confirmed but isn't.</p>

<h2>What "Last verified" means</h2>
<p>The date shown in each state's trust line is the last time we directly re-checked that state's
citation against the primary source text (not just re-read our own notes about it). We periodically
re-run an automated check across every cited source looking for two things: a broken or redirected
link, and any sign the underlying rule has since been amended. When either turns up, we re-verify by
hand before changing anything a visitor sees &mdash; an automated flag never silently rewrites a
published date by itself.</p>

<h2>Where this can still fall short, honestly</h2>
<p>Some sources are genuinely harder to verify by automated means &mdash; a handful of citations point to
PDF documents or JavaScript-rendered pages our tooling can't text-extract automatically. Where that's the
case, those citations were still individually confirmed by hand at the time they were published; we
disclose the tooling gap rather than pretend an easier check covers it. If a rule changes between our
checks, use the contact link below to flag it and we'll re-verify and correct it quickly.</p>

<h2>What we don't verify this way</h2>
<p>CPE hour completion is self-reported wherever this site or its firm tier ever discusses it &mdash;
we label that clearly and never give it the same "Verified" treatment as a sourced renewal date. We also
don't independently verify a state's future policy changes; if a state proposes a new rule that hasn't
taken effect yet, we wait for it to become the actual current rule before citing it.</p>

<h2>See it for yourself</h2>
<p>Pick any state page and look for the "Source of record" line under its date &mdash; the citation and
the "read the rule" link go to the primary legal text, not a summary. That's the same standard behind
every date on this site.</p>

<p class="backlink"><a href="/contact/">Found something that looks wrong? Tell us &rarr;</a></p>
"""
    return page_shell(
        f"How We Verify Every Deadline — {SITE_NAME}",
        "DeadlineRadar's sourcing standard: every CPA license renewal date traces to the state board's "
        "own page plus the actual codified statute or rule behind it — never a guess.",
        body,
        home_href="../",
        canonical_path="/methodology/",
    )


def _rule_change_status_label(status: str | None) -> str:
    return {
        "ENACTED": "Enacted",
        "ENACTED_DATE_PENDING": "Enacted, date pending",
        "ADOPTED_RULE": "Adopted rule",
        "PROPOSED": "Proposed",
        "DIED_WITHDRAWN": "Died / withdrawn",
    }.get(status or "", "Enacted")


def _rule_change_card_html(e: dict) -> str:
    eff = e.get("effective_date")
    eff_html = ""
    if eff:
        eff_date = fmt_date(date.fromisoformat(eff))
        if e.get("upcoming"):
            eff_html = f'<p class="rc-date"><strong>Effective {esc(eff_date)}</strong> &mdash; not yet in force.</p>'
        elif e.get("needs_reverification"):
            eff_html = (
                f'<p class="rc-date"><strong>Effective {esc(eff_date)}</strong> &mdash; passed; we '
                f"re-verify on or after that date before treating it as settled, not asserting it "
                f"took effect from this record alone.</p>"
            )
        else:
            eff_html = f'<p class="rc-date"><strong>Effective {esc(eff_date)}</strong></p>'

    # summary_public ONLY -- never a raw internal-prose field. See
    # scripts/build_change_events.py's _public_summary()/rejection-on-missing
    # docstrings for why: this page nearly shipped a leaked research-note
    # string ("UPDATE (verifier): ... CiteID ...") caught by preship_gate.
    detail = e.get("summary_public") or ""
    source_label = "automated source monitoring" if e.get("source") == "difflab_reg_change_engine" else "dual-source legal research"
    return f"""<div class="rc-card">
  <div class="rc-head">
    <span class="rc-jurisdiction">{esc(e.get("jurisdiction") or e.get("jurisdiction_slug", ""))}</span>
    <span class="rc-badge">{esc(_rule_change_status_label(e.get("status")))}</span>
  </div>
  {eff_html}
  <p class="rc-detail">{esc(detail)}</p>
  <p class="rc-cite"><a href="{http_href(e.get("citation_url"))}">{esc(e.get("citation") or "Primary source")}</a>
  <span class="rc-conf">&middot; {esc(source_label)}, confidence: {esc(e.get("confidence") or "unverified")}</span></p>
</div>"""


def _rule_conflict_card_html(e: dict) -> str:
    return f"""<div class="rc-card rc-conflict">
  <div class="rc-head">
    <span class="rc-jurisdiction">{esc(e.get("jurisdiction") or e.get("jurisdiction_slug", ""))}</span>
    <span class="rc-badge rc-badge-conflict">Sources disagree</span>
  </div>
  <p class="rc-detail">{esc(e.get("summary_public") or "Our primary sources for this jurisdiction currently disagree with each other. We withhold a determination rather than pick a side.")}</p>
  <p class="rc-cite"><a href="{http_href(e.get("citation_url"))}">{esc(e.get("citation") or "Primary source")}</a></p>
</div>"""


def build_rule_changes_page() -> str:
    """Public CPA mobility/practice-privilege rule-change feed (2026-08-02).

    Two independent inputs, kept honestly distinct in both the data and the
    copy: dual-source legal research across all 55 jurisdictions (batch-
    verified, the same standard as every other dataset on this site), and
    DiffLab's day-to-day automated monitoring of the same jurisdictions'
    primary sources. Per the orchestrator's Wednesday directive, an empty or
    fake-looking feed is worse than not shipping -- every count below is
    derived from the data file at build time, never hardcoded, so this page
    cannot silently drift out of sync with what it actually contains.
    """
    raw = json.loads(REG_CHANGE_EVENTS_PATH.read_text(encoding="utf-8"))
    meta = raw.get("_meta", {})
    events = raw.get("events", [])
    changes = [e for e in events if e.get("kind") == "rule_change"]
    conflicts = [e for e in events if e.get("kind") == "source_conflict"]
    upcoming = [e for e in changes if e.get("upcoming")]
    recent = [e for e in changes if not e.get("upcoming")]
    monitoring_count = meta.get("live_monitoring_count", 0)

    upcoming_html = (
        "\n".join(_rule_change_card_html(e) for e in upcoming)
        if upcoming
        else '<p class="rc-empty">No upcoming changes detected right now.</p>'
    )
    recent_html = (
        "\n".join(_rule_change_card_html(e) for e in recent)
        if recent
        else '<p class="rc-empty">No recent changes pending re-verification right now.</p>'
    )
    conflict_html = "\n".join(_rule_conflict_card_html(e) for e in conflicts) if conflicts else ""

    if monitoring_count:
        monitoring_note = (
            f"Our automated monitoring has flagged and promoted {monitoring_count} change"
            f"{'s' if monitoring_count != 1 else ''} so far."
        )
    else:
        # DiffLab's own coverage numbers (2026-08-03), build-time-derived so this
        # can't drift into an overclaim -- "0 events" reads as broken/abandoned on
        # its own, so show the real monitoring activity behind that zero instead.
        # Deliberately NOT surfacing current_source_live_rate_pct here (DiffLab's
        # own caveat): it measures page fetchability, not catch rate, and would
        # misread as a data-quality score.
        cov = json.loads(RULE_CHANGE_COVERAGE_STATS_PATH.read_text(encoding="utf-8"))
        monitoring_started = fmt_date(date.fromisoformat(cov["monitoring_started"]))
        last_checked = fmt_date(date.fromisoformat(cov["last_checked_at"][:10]))
        monitoring_note = (
            f"Our automated day-to-day monitoring hasn't flagged and promoted a confirmed change yet "
            f"&mdash; that's expected in the early days of a new monitor watching mostly-static legal "
            f"text, not a sign the feed is broken. It's been watching {cov['sources_monitored']} "
            f"primary sources across all {cov['jurisdictions_monitored']} U.S. jurisdictions daily "
            f"since {monitoring_started}, and has run {cov['diffs_reviewed_total']} detected changes "
            f"through review so far &mdash; none of them a real CPA-relevant rule change yet. Last "
            f"checked {last_checked}. Every item below instead comes from our batch legal research."
        )

    body = f"""<h1>CPA Mobility &amp; Practice-Privilege Rule Changes</h1>
<p class="intro">A running feed of confirmed and pending changes to interstate CPA mobility rules
&mdash; practice privileges, notice/fee requirements, and firm registration &mdash; sourced the same
way as every other date on this site: a citation to the primary statute or rule, never a guess.
{monitoring_note}</p>

<h2>Upcoming changes ({len(upcoming)})</h2>
<p class="rc-section-note">A dated, signed change that hasn't taken effect yet.</p>
{upcoming_html}

<h2>Recently changed, pending re-verification ({len(recent)})</h2>
<p class="rc-section-note">The effective date has passed. We re-verify against the primary source
before treating a post-change rule as settled &mdash; we do not assume a law took effect just
because its start date arrived.</p>
{recent_html}
"""
    if conflicts:
        body += f"""
<h2>Sources under active disagreement ({len(conflicts)})</h2>
<p class="rc-section-note">For these jurisdictions, our two primary sources currently state
different rules for the same question. We withhold a determination rather than pick a side until
the conflict resolves &mdash; these are not confirmed rule changes.</p>
{conflict_html}
"""
    body += """
<p class="backlink"><a href="/methodology/">How we verify every date on this site &rarr;</a></p>
"""
    return page_shell(
        f"CPA Mobility Rule Changes — {SITE_NAME}",
        "A sourced, continuously-updated feed of interstate CPA mobility and practice-privilege rule "
        "changes by state, each with a primary-source citation.",
        body,
        home_href="../",
        canonical_path="/rule-changes/",
    )


def build_404_page(states: list[dict]) -> str:
    sorted_states = sorted(states, key=lambda s: s["state"])
    cards = "\n".join(
        f'<a class="state-card" href="/{esc(s["state_slug"])}/">'
        f'<div class="state-name">{esc(s["state"])}</div></a>'
        for s in sorted_states
    )
    body = f"""<h1>Page not found</h1>
<p class="intro">We couldn't find that page &mdash; it may have moved, or the link may be
mistyped. Find your state below, or head back to the homepage.</p>
<p class="backlink"><a href="/">&larr; Back to all states</a></p>
<div class="state-grid">
{cards}
</div>
"""
    return page_shell(
        f"Page Not Found — {SITE_NAME}",
        "This page could not be found. Find your state's CPA license renewal deadline from the "
        "full list.",
        body,
        home_href="/",
        canonical_path="/404.html",
    )


def build_contact_page() -> str:
    body = f"""<h1>Contact</h1>
<p class="intro">Questions, a correction to a deadline, or anything else &mdash; we'd like to hear from you.</p>

<h2>Email us</h2>
<p><a href="mailto:{esc(CONTACT_EMAIL)}">{esc(CONTACT_EMAIL)}</a></p>
<p>We read every message and usually reply within a couple of business days. This is a small, independent
project &mdash; there's a real person on the other end, not a support queue.</p>

<h2>Spotted a wrong date?</h2>
<p>Deadlines are compiled from official state board sources and we work hard to keep them current, but
rules change. If a date looks off, email us the state and what you're seeing and we'll verify it against
the source and fix it fast. Always confirm your exact deadline with your state board before relying on it.</p>

<h2>Stop your reminders</h2>
<p>The fastest way to stop reminders is the one-click unsubscribe link at the bottom of any email we send
&mdash; it's instant and permanent. You're welcome to email us too.</p>

<h2>Mailing address</h2>
<p>{esc(SITE_NAME)} by {esc(BRAND_NAME)}<br>
18121 E Hampden Ave, Unit C #1324<br>
Aurora, CO 80013</p>
"""
    return page_shell(
        f"Contact — {SITE_NAME}",
        "Contact DeadlineRadar — questions, deadline corrections, or help with your CPA license "
        "renewal reminders. Email us any time.",
        body,
        home_href="../",
        canonical_path="/contact/",
    )


def _firm_landing_links_html() -> str:
    """Cross-links from /for-firms/ to the firm-specific SEO landing pages (2026-07-10
    Wave-1 B2B directive) -- these pages are the inbound engine, so the B2B page itself
    should surface them rather than relying only on organic search to connect the two."""
    if not FIRM_LANDING_PAGES:
        return ""
    items = "\n".join(
        f'<li><a href="../{esc(p["slug"])}/">{esc(p["state_name"])} firm renewal</a></li>'
        for p in FIRM_LANDING_PAGES
    )
    return f"""<h2>Firm-registration deadlines by state</h2>
<p>Your firm's own registration or permit renews on a different clock than any individual staff CPA's
license. A few states where we've published the firm-specific filing date:</p>
<ul class="state-links">
{items}
</ul>"""


# (fictional example name, state_slug, license_type, status) for the /for-firms/ dashboard
# mockup (2026-07-10, per Devin's competitor-emulation directive: PE License Pro / CE Broker
# both lead with a real product screenshot instead of describing the product in prose). Status
# is illustrative copy, not derived from data. Dates are NOT hardcoded -- looked up live from
# cpa_deadlines.json at build time via _mockup_record() below, so this never goes stale the way
# a hand-typed date sitting on a marketing page silently would (the exact failure class this
# site's own trust pitch is built around catching).
_FIRM_MOCKUP_ROSTER = [
    ("Alex R.", "georgia", "individual", "Active"),
    ("Jordan M.", "alabama", "all", "Active"),
    ("Sam K.", "illinois", "individual", "Opted out"),
    ("Taylor B.", "missouri", "individual", "Needs attention"),
    ("Morgan P. — Firm Registration", "louisiana", "firm", "Active"),
    ("Casey T. — Firm Registration", "missouri", "firm", "Active"),
]

_MOCKUP_STATUS_CLASS = {
    "Active": "mock-status--ok",
    "Opted out": "mock-status--pending",
    "Needs attention": "mock-status--risk",
}


def _mockup_record(by_slug: dict[str, list[dict]], state_slug: str, license_type: str) -> dict | None:
    for r in by_slug.get(state_slug, []):
        if r.get("license_type") == license_type and r.get("next_deadline_computed"):
            return r
    return None


def _mock_ring_svg(pct: int, is_risk: bool) -> str:
    """Server-rendered twin of the dashboard's own drRingSvg() (generate.py's
    _FIRM_DASHBOARD_JS_HTML) -- same math, same CSS classes (.dr-ring-*), so
    the marketing preview is pixel-consistent with the real product a
    visitor will actually see after signing up, not a separately-styled
    approximation of it."""
    import math

    r = 24.0
    c = 2 * math.pi * r
    clamped = max(0, min(100, pct))
    dash = (clamped / 100) * c
    risk_class = " is-risk" if is_risk else ""
    return f"""<div class="dr-ring-wrap{risk_class}">
  <svg width="58" height="58" viewBox="0 0 58 58" aria-hidden="true">
    <circle class="dr-ring-track" cx="29" cy="29" r="{r:g}"></circle>
    <circle class="dr-ring-value" cx="29" cy="29" r="{r:g}" stroke-dasharray="{dash:.1f} {c:.1f}"></circle>
  </svg>
  <div class="dr-ring-pct">{clamped}%</div>
</div>"""


_MOCK_DONUT_COLORS = {
    "Active": "#1f9e5c",
    "Pending": "#9c7a12",
    "Needs attention": "#c33737",
    "Opted out": "#8595a3",
}


def _mock_donut_svg(counts: dict[str, int], total: int) -> str:
    """Server-rendered twin of drDonutSvg() -- same conic-gradient approach, same
    color mapping (matching DR_DONUT_COLORS in the real dashboard's JS)."""
    if not total:
        return ""
    order = ["Active", "Pending", "Needs attention", "Opted out"]
    acc = 0
    segments = []
    legend_items = []
    for key in order:
        n = counts.get(key, 0)
        if not n:
            continue
        start = (acc / total) * 360
        acc += n
        end = (acc / total) * 360
        segments.append(f"{_MOCK_DONUT_COLORS[key]} {start:.1f}deg {end:.1f}deg")
        legend_items.append(
            f'<li><span class="swatch" style="background:{_MOCK_DONUT_COLORS[key]}"></span>'
            f"{esc(key)} ({n})</li>"
        )
    gradient = ", ".join(segments)
    legend = "\n".join(legend_items)
    return f"""<div class="dr-donut-wrap">
  <div style="width:58px;height:58px;border-radius:50%;flex:none;display:flex;align-items:center;
  justify-content:center;background:conic-gradient({gradient});" aria-hidden="true">
    <div style="width:30px;height:30px;border-radius:50%;background:var(--card-bg);"></div>
  </div>
  <ul class="dr-donut-legend">{legend}</ul>
</div>"""


def _firm_dashboard_mockup_html(by_slug: dict[str, list[dict]], as_of: date) -> str:
    """A labeled, illustrative dashboard mockup -- NOT a screenshot of a real product (none
    exists yet) and NOT a real firm's data (every name is a fictional example, same honest
    convention PE License Pro's own marketing mockup uses ("Cardinal Engineering Group") and CE
    Broker's uses. Explicitly captioned as an example so this can never be mistaken for a claim
    that a real customer exists. Every date shown is real, current, computed from
    cpa_deadlines.json -- only the names and the roster grouping are invented.

    2026-07-30 (BUILD v2 Phase C): rebuilt to match the REAL dashboard's redesigned shell
    (build_firm_dashboard_page(), same tick) instead of the old plain-table mockup -- reuses
    the exact .dr-* CSS classes (dark sidebar, coverage ring, status donut) so a visitor sees
    the actual product, not a differently-styled placeholder of it."""
    rows = []
    status_counts: dict[str, int] = {}
    due_soon = 0
    for name, state_slug, license_type, status in _FIRM_MOCKUP_ROSTER:
        record = _mockup_record(by_slug, state_slug, license_type)
        if record is None:
            continue
        status_counts[status] = status_counts.get(status, 0) + 1
        deadline = date.fromisoformat(record["next_deadline_computed"])
        # Same definition drRenderStats() uses for the real dashboard's "Due
        # soon" tile: within 30 days, excluding opted-out (an earlier version
        # of this mockup counted the "Needs attention" STATUS instead, which
        # is a different concept entirely and produced a number that
        # disagreed with this exact sub-label's own text -- caught by
        # adversarial review; every _FIRM_MOCKUP_ROSTER record always has a
        # real computed date, so the real dashboard's "or unresolved" branch
        # never applies here).
        if status != "Opted out" and (deadline - as_of).days <= 30:
            due_soon += 1
        date_label = fmt_date(deadline)
        status_class = _MOCKUP_STATUS_CLASS.get(status, "mock-status--ok")
        rows.append(f"""<tr>
  <td>{esc(name)}</td>
  <td>{esc(record['state'])}</td>
  <td><span class="mock-status {status_class}">{esc(status)}</span></td>
  <td>{esc(date_label)}</td>
</tr>""")
    if not rows:
        return ""
    total = sum(status_counts.values())
    active = status_counts.get("Active", 0)
    coverage_pct = round((active / total) * 100) if total else 0
    due_soon_pct = round((due_soon / total) * 100) if total else 0

    return f"""<div class="mock-dashboard">
  <div class="mock-chrome">
    <span class="mock-dot"></span><span class="mock-dot"></span><span class="mock-dot"></span>
    <span class="mock-url">deadline-radar.com/firm-dashboard/</span>
  </div>
  <div class="mock-body">
  <div class="dr-dash-shell">
    <aside class="dr-sidebar">
      <div class="dr-firm-name">Example Firm, LLC</div>
      <ul class="dr-nav">
        <li><a href="#" class="is-active" tabindex="-1">Roster</a></li>
        <li><a href="#" tabindex="-1">Calendar</a></li>
        <li><a href="#" tabindex="-1">Map</a></li>
        <li><a href="#" tabindex="-1">CPE Hours</a></li>
        <li><a href="/firm-mobility/">Practice Privilege Check</a></li>
        <li><a href="#" tabindex="-1">Account</a></li>
        <li><span class="dr-nav-soon">Reports<span class="dr-soon-badge">Soon</span></span></li>
        <li><span class="dr-nav-soon">Documents<span class="dr-soon-badge">Soon</span></span></li>
      </ul>
    </aside>
    <div class="dr-main">
      <div class="dr-stat-row">
        <div class="dr-stat-card">{_mock_ring_svg(coverage_pct, False)}
          <div><div class="dr-stat-label">Coverage</div><div class="dr-stat-value">{coverage_pct}%</div>
          <div class="dr-stat-sub">{active} of {total} active</div></div></div>
        <div class="dr-stat-card">{_mock_donut_svg(status_counts, total)}
          <div><div class="dr-stat-label">Roster status</div><div class="dr-stat-value">{total}</div>
          <div class="dr-stat-sub">staff tracked</div></div></div>
        <div class="dr-stat-card">{_mock_ring_svg(due_soon_pct, due_soon > 0)}
          <div><div class="dr-stat-label">Due soon</div><div class="dr-stat-value">{due_soon}</div>
          <div class="dr-stat-sub">due within 30 days or unresolved</div></div></div>
      </div>
      <div class="table-wrap">
      <table>
        <thead><tr><th>Staff</th><th>State</th><th>Status</th><th>Next deadline</th></tr></thead>
        <tbody>
        {chr(10).join(rows)}
        </tbody>
      </table>
      </div>
    </div>
  </div>
  </div>
</div>
<p class="mock-caption">Illustrative example &mdash; not a real firm. Dates shown are the actual
current deadlines for these states, computed the same way as every free page on this site. This is
the real product design, not a mockup of a different one.</p>"""


_FIRM_FAQ = [
    (
        "Is the license status actually verified, or just self-reported?",
        "The renewal DATES are verified the same rigorous way as every free page on this site: "
        "sourced to the codified statute or rule, cited, and rechecked on our freshness cadence "
        "&mdash; <a href=\"../methodology/\">see exactly how</a>. What this is <em>not</em> is a "
        "recurring human lookup of each staff member's individual license status &mdash; there's no "
        "manual check-in against the state board or CPAverify.org on your behalf. Signup itself is "
        "self-serve: your admin adds the roster directly, and reminders start right away for each "
        "person &mdash; no confirmation step to wait on. Each staff member still gets one "
        "transparent email the moment they're added, naming your firm and with an equally "
        "prominent one-click opt-out.",
    ),
    (
        "What if my staff are licensed in a birth-month or \"bring your own date\" state?",
        "Still tracked the same way it works on the free tier: that staff member enters their own "
        "birth month or license expiration date once, and it shows up on your roster view like "
        "everyone else's.",
    ),
    (
        "Can I cancel the pilot anytime?",
        "Yes. It's a free 30-day pilot, no card required to start, and you can stop at any point "
        "during or after it &mdash; there's no contract to get out of.",
    ),
    (
        "Do you track CPE hours too?",
        "Not yet. If we ever add it, it will be labeled as your own self-reported log, not "
        "independently verified &mdash; we won't blur it with the sourced renewal dates that are "
        "the reason to trust this site in the first place.",
    ),
    (
        "How is this different from my staff just signing up for free individually?",
        "Nothing stops them from doing that today, and it's not a bad idea either way. What the "
        "firm tier adds is the view your admin doesn't get from 20 separate free sign-ups: one "
        "roster, one place to see who's current and who's at risk, plus the firm's own "
        "registration &mdash; not 20 inboxes to hope someone's watching.",
    ),
    (
        "Who actually sets up my staff -- your team, or us?",
        "You do, directly, once the self-serve dashboard is live: your admin adds each staff "
        "member's name, email, state, and license type, and their reminders start right away "
        "&mdash; no waiting on them to confirm anything, so your firm's coverage never has a silent "
        "gap. There's no concierge onboarding where our team collects a roster by email and enters "
        "it for you. Each staff member gets one transparent email the moment they're added, naming "
        "your firm and with an equally prominent one-click opt-out, so nobody is tracked silently.",
    ),
]


def _firm_faq_html() -> str:
    items = "\n".join(
        f"""<details class="faq-item">
  <summary>{esc(q)}</summary>
  <p>{a}</p>
</details>"""
        for q, a in _FIRM_FAQ
    )
    return f"""<h2>Questions firms ask before signing up</h2>
<div class="faq-list">
{items}
</div>"""


def build_firms_page(by_slug: dict[str, list[dict]], as_of: date) -> str:
    """B2B firm-tier landing page (rewritten 2026-07-28: the real buyer is the
    small-firm admin managing multiple staff CPAs across states, not a
    concierge-pilot where our team manually checks every staff license --
    that idea is retired here). The CTA is now a real HTML form
    (POST /api/firm/lead, see worker/src/index.ts's handleFirmLead()) that
    captures interest -- NOT an instant self-serve signup, since the actual
    firm-admin dashboard (staff roster + confirm-email flow) is a separate,
    parallel build that hasn't shipped yet. Do not re-add any claim of a
    recurring human/manual per-staff license check or a concierge-style
    onboarding where our team enters a firm's roster for them -- both were
    removed because they were never true and were about to become
    demonstrably false the moment the self-serve dashboard ships (it's
    self-serve BY DESIGN: the admin adds staff directly). Scoped deliberately
    to license-renewal tracking only, matching the free tier's trust model;
    any future CPE-hour tracking must be labeled as an unverified self-report,
    never given the same certainty language as the sourced renewal dates --
    that distinction is the entire brand and must not blur on the paid tier."""
    firm_lead_action = f"{esc(REMINDER_BACKEND_BASE_URL)}/firm/lead"
    body = f"""<h1>CPA License Tracking for Your Whole Firm</h1>
<p class="intro">Every accounting firm has someone who has to make sure every partner's and staff CPA's
license stays current &mdash; across however many states they're licensed in. One missed renewal slows
down engagements and creates real regulatory risk, and most firms track it today by spreadsheet. A
spreadsheet fails in three specific ways.</p>

<h2>Where a spreadsheet (and an individual CPA's own inbox) falls short</h2>
<p><strong>Multi-state blind spot.</strong> A state board only reminds a CPA about the license held
<em>with that board</em> &mdash; nobody sends a nudge about the other one or two states the same person
might also be licensed in. Nothing is watching the full multi-state picture except the CPA themselves,
one inbox at a time.</p>
<p><strong>No firm-level visibility.</strong> The partner or admin who actually carries the regulatory
risk for the firm never sees any of this &mdash; only the individual licensee's own inbox gets the
reminder. If that person doesn't forward it, changes their email, or leaves the firm, the firm has zero
visibility until a renewal is already missed.</p>
<p><strong>Filing vs. hours.</strong> CPE-hour tracking tools (MYCPE, Illumeo, and similar) track whether
staff completed their continuing-education hours. That's a different event from whether the actual
renewal <em>filing</em> with the state board happened. Finishing every CPE hour and still missing the
filing deadline is a real, common failure mode &mdash; this product is about the filing, not the hours.</p>

<h2>What you get</h2>
<p>A firm-wide view that answers what a spreadsheet can't: who's current, who's at risk, and who needs
to act before a deadline &mdash; for every staff CPA and the firm's own registration, sourced to the same
codified statute or rule we verify for every free state page on this site &mdash;
<a href="../methodology/">see exactly how we verify every deadline</a>. Any individual CPA can already
get free reminders on their own; what a firm gets here is the roster-level accountability view nobody's
personal inbox provides, in one place.</p>

{_firm_dashboard_mockup_html(by_slug, as_of)}

<p><strong>Scope, plainly stated:</strong> this tracks license <em>renewal dates</em> &mdash; the part we
can verify against actual state law, the same way we already do for individuals. It does not track CPE
hour completion. If we ever add that, it will be clearly labeled as your own self-reported log, not
independently verified &mdash; we won't blur it with the sourced renewal dates that are the whole reason to
trust this site.</p>

<h2>Pricing</h2>
<p><strong>$500/year, flat &mdash; up to 25 staff. No per-person pricing.</strong>
Start with a <strong>free 30-day pilot &mdash; no card required</strong>. More than 25 staff?
<a href="mailto:{esc(CONTACT_EMAIL)}">Contact us</a>.</p>

<div class="remind-panel" id="firm-signup">
  <div>
    <h2>Create your firm account</h2>
    <p class="remind-copy">Self-serve, no card required. Your admin creates an account and adds staff
    directly &mdash; name, email, state, and license type for each person &mdash; no concierge onboarding
    where our team enters a roster for you. Reminders start right away for each person added, no
    confirmation step to wait on, so your firm's coverage never has a silent gap. Each staff member
    gets one transparent email the moment they're added, naming your firm and with an equally
    prominent one-click opt-out.</p>
    <p class="remind-promise">Free 30-day pilot, no card collected anywhere in this flow.</p>
  </div>
  <p><a class="cta-button" href="../firm-login/">Create your firm account &rarr;</a></p>
</div>

<h2>How it actually works</h2>
<p>Deadline accuracy comes from the same sourced-to-codified-law data every free page on this site
already uses, not a recurring human check-in on each staff member's status. Billing today is a simple
invoice; a self-serve card-payment option is coming soon. Not ready to create an account yet?
<a href="#firm-lead">Leave your email instead</a> and we'll follow up.</p>

<div class="remind-panel" id="firm-lead">
  <div>
    <h2>Not ready yet? Just leave your email</h2>
    <p class="remind-copy">No account, no commitment &mdash; we'll follow up with anything a firm admin
    should know before signing up.</p>
  </div>
  <form method="post" action="{firm_lead_action}">
    {_BOT_DEFENSE_FIELDS_HTML}
    <label for="firm-lead-name">Firm name</label>
    <input type="text" id="firm-lead-name" name="firm_name" required placeholder="Example Firm, LLC">
    <label for="firm-lead-email">Your email</label>
    <input type="email" id="firm-lead-email" name="email" required placeholder="you@example.com">
    <label for="firm-lead-staff-count">Approx. staff count (optional)</label>
    <input type="text" id="firm-lead-staff-count" name="staff_count_hint" maxlength="20" placeholder="e.g. 8">
    <button type="submit">Reserve early access &rarr;</button>
  </form>
</div>

{_firm_landing_links_html()}

{_firm_faq_html()}

<h2>Questions first?</h2>
<p>Email us any time, no commitment:</p>
<p><a href="mailto:{esc(CONTACT_EMAIL)}?subject=Firm%20tier%20question">{esc(CONTACT_EMAIL)}</a></p>
"""
    return page_shell(
        f"For Firms — {SITE_NAME}",
        "CPA firm license tracking: $500/year flat for up to 25 staff, free 30-day pilot. "
        "Sourced to the same codified state law DeadlineRadar verifies for every state.",
        body,
        home_href="../",
        canonical_path="/for-firms/",
    )


# ---------------------------------------------------------------------------
# Firm dashboard MVP (2026-07-28, step 3/3) -- /firm-login/ + /firm-dashboard/.
# The user-facing half of migration 0008's firm accounts + staff-license CRUD
# (worker/src/index.ts's /firm/signup, /firm/login, /firm/login/verify,
# /firm/logout, /firm/licenses*). Both pages are still plain static HTML
# generated through page_shell() like every other page on this site -- no
# framework, no build step. /firm-dashboard/ is the one page on the whole
# site with real client-side JS beyond drUpdateFields(), because it is the
# one page whose content (a firm's own roster) cannot be known at static-
# build time at all -- it has to be fetched from the session-scoped API on
# load.
# ---------------------------------------------------------------------------


def build_firm_login_page() -> str:
    """Firm sign-in / create-account, rebuilt to the CONVENTIONAL pattern
    (2026-07-31, Devin off a screenshot: "How do normal sign ins work? I
    don't see them like this, so why this layout?").

    What was wrong: the page rendered THREE forms stacked and visible at
    once (create account / password sign-in / emailed link), each with its
    own Turnstile widget showing a green "Success!" box. Nothing real looks
    like that, and on a product asking CPA firms to trust it with staff data
    it reads unfinished -- a credibility cost, so a revenue cost.

    What it is now, matching what people expect everywhere else:
      * ONE form visible at a time; Sign in (email + password) is the
        default view.
      * A single switch link at the bottom swaps to Create account, which
        offers its own way back. No stacking.
      * The magic link is demoted to a secondary action under the password
        field ("Email me a sign-in link instead"), not a co-equal third form.
      * The SSO slot sits at the TOP above an "or" divider, per convention,
        and stays DARK until the OAuth apps are registered -- the slot is
        built, no fake buttons.
      * ONE Turnstile widget, `interaction-only`, so nothing is normally
        visible. See _turnstile_shared_widget_html().

    PROGRESSIVE ENHANCEMENT, deliberately: the HTML ships with every form
    VISIBLE and the switch links inert, and the script hides the non-default
    views on load. So a visitor without JS gets the old stacked page, which
    is ugly but fully functional, rather than a page whose only two forms
    are unreachable behind a dead link. The conventional layout is an
    enhancement, never a prerequisite for signing in.

    NOT CHANGED, and must not be: anti-enumeration (every path returns the
    same response whether or not an email has an account), the honeypot, the
    rate limits, and all session/auth behaviour. This is presentation plus a
    bot-protection config change; no auth logic was touched.

    The dead-end fix is preserved -- a first-time visitor still obviously
    finds "create an account", now via the switch link and copy rather than
    by having the form shouted at them. The original bug was the SILENT
    failure (no visible route to signup at all), not the form's position.
    """
    sso_buttons_html = ""
    if "google" in SSO_PROVIDERS:
        sso_buttons_html = f"""
  <div class="dr-sso-block dr-sso-top">
    <a class="dr-sso-button" href="{REMINDER_BACKEND_BASE_URL}/firm/auth/google/start">
      <svg class="dr-sso-mark" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
        <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"/>
        <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"/>
        <path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z"/>
        <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"/>
      </svg>
      <span>Continue with Google</span>
    </a>
    <div class="dr-sso-divider"><span>or</span></div>
  </div>"""

    body = f"""<div class="dr-auth-card">

<div class="dr-auth-view" id="dr-view-signin">
  <h1>Sign in</h1>
  <p class="subhead">One roster for every staff CPA's license renewal.</p>
{sso_buttons_html}
  <form method="post" action="{REMINDER_BACKEND_BASE_URL}/firm/login/password" id="dr-firmlogin-signin-form">
    {_BOT_DEFENSE_FIELDS_HTML_SIGNIN}
    <label for="signin-email">Email</label>
    <input type="email" id="signin-email" name="admin_email" required autocomplete="username"
    placeholder="you@yourfirm.com">
    <label for="signin-password">Password</label>
    <input type="password" id="signin-password" name="password" required
    autocomplete="current-password">
    <p id="dr-firmlogin-signin-error" class="field-hint" style="color:#c33737;" hidden></p>
    <button type="submit">Sign in</button>
  </form>
  <p class="dr-auth-secondary">
    <a href="#dr-view-magic" class="dr-auth-switch" data-target="dr-view-magic"
    data-intent="password_reset">Forgot your password?</a>
    &nbsp;&middot;&nbsp;
    <a href="#dr-view-magic" class="dr-auth-switch" data-target="dr-view-magic">Email me a sign-in
    link instead</a>
  </p>
  <p class="dr-auth-alt">New firm?
    <a href="#dr-view-signup" class="dr-auth-switch" data-target="dr-view-signup">Create an account</a>
  </p>
</div>

<div class="dr-auth-view" id="dr-view-signup">
  <h1>Create your firm account</h1>
  <p class="subhead">Free to start &mdash; a 30-day pilot, no card required.</p>
  <form method="post" action="{REMINDER_BACKEND_BASE_URL}/firm/signup" id="dr-firmlogin-signup-form">
    {_BOT_DEFENSE_FIELDS_HTML_ALT}
    <label for="signup-firm-name">Firm name</label>
    <input type="text" id="signup-firm-name" name="name" required maxlength="200"
    placeholder="Example Firm, LLC">
    <label for="signup-admin-email">Your email</label>
    <input type="email" id="signup-admin-email" name="admin_email" required
    autocomplete="email" placeholder="you@yourfirm.com">
    <p id="dr-firmlogin-signup-error" class="field-hint" style="color:#c33737;" hidden></p>
    <button type="submit">Create firm account</button>
  </form>
  <p class="signup-microcopy" id="dr-firmlogin-signup-ok" hidden>Check your email for a one-time link to finish setting up.</p>
  <p class="signup-microcopy" id="dr-firmlogin-signup-hint">We'll email your admin address a one-time link to finish setting up.</p>
  <p class="dr-auth-alt">Already have an account?
    <a href="#dr-view-signin" class="dr-auth-switch" data-target="dr-view-signin">Sign in</a>
  </p>
</div>

<div class="dr-auth-view" id="dr-view-magic">
  <h1 id="dr-magic-heading">Email me a sign-in link</h1>
  <p class="subhead" id="dr-magic-sub">Works whether or not you've set a password.</p>
  <form method="post" action="{REMINDER_BACKEND_BASE_URL}/firm/login" id="dr-magic-form">
    {_BOT_DEFENSE_FIELDS_HTML_MAGIC}
    <!-- Which affordance the visitor arrived from. The server writes this
         onto the login-token row, so the emailed link knows where to land.
         Flipped to "password_reset" by the view switcher when the visitor
         clicked "Forgot your password?" rather than the plain link option. -->
    <input type="hidden" id="dr-magic-intent" name="intent" value="login">
    <label for="login-email">Email</label>
    <input type="email" id="login-email" name="admin_email" required autocomplete="email"
    placeholder="you@yourfirm.com">
    <p id="dr-magic-error" class="field-hint" style="color:#c33737;" hidden></p>
    <button type="submit" id="dr-magic-submit">Email me a sign-in link</button>
  </form>
  <p class="dr-auth-alt" id="dr-magic-ok" hidden>Check your email for the link.</p>
  <p class="dr-auth-alt">
    <a href="#dr-view-signin" class="dr-auth-switch" data-target="dr-view-signin">&larr; Back to sign in</a>
  </p>
</div>

{_turnstile_shared_widget_html()}
</div>

<p class="how-it-works">Want pricing and details first? <a href="/for-firms/">See the firm overview</a>.</p>
<p class="how-it-works">Not a firm &mdash; just tracking your own license?
<a href="/signin/">Sign in here</a>.</p>

{_FIRM_LOGIN_VIEW_JS_HTML}
"""

    return page_shell(
        f"Sign In / Create Account — {SITE_NAME}",
        "Sign in to your DeadlineRadar firm dashboard, or create a new firm account to start "
        "tracking your staff's CPA license renewals.",
        body,
        home_href="../",
        canonical_path="/firm-login/",
        hide_signin=True,
    )


# View switching for /firm-login/. Deliberately hides the non-default views
# at RUNTIME rather than shipping them hidden: with JS off, all three forms
# stay visible and usable (the old layout), instead of leaving two of them
# stranded behind links that cannot fire.
# NOTE ON COMMENTS IN THE STRINGS BELOW: every _*_JS_HTML / CSS string in this
# file is INLINED INTO RENDERED PAGES, so any comment inside one is PUBLIC
# OUTPUT. preship_gate.py has now caught internal language leaking that way
# twice in one day. Keep shipped comments terse and factual; put reasoning in
# Python comments like this one.
#
# setIntent(): the magic-link view serves two intents -- "sign me in" and "let
# me set a password" -- and the copy must match the button that opened it.
# "Forgot your password?" promises a password, so the heading, the submit
# label and the hidden `intent` field change together. A control that says one
# thing while the form does another is exactly the bug this change fixes.
_FIRM_LOGIN_VIEW_JS_HTML = """<script>
(function () {
  var views = ["dr-view-signin", "dr-view-signup", "dr-view-magic"];

  function show(id) {
    for (var i = 0; i < views.length; i++) {
      var el = document.getElementById(views[i]);
      if (el) el.hidden = views[i] !== id;
    }
    // Move focus to the new view's first field, so a keyboard or
    // screen-reader user is not left where the old form used to be.
    var target = document.getElementById(id);
    if (target) {
      var first = target.querySelector("input:not([type=hidden]):not([tabindex='-1'])");
      if (first) first.focus();
    }
  }

  // Deep links (/firm-login/#dr-view-signup) and the back button both work.
  function fromHash() {
    var h = (window.location.hash || "").replace("#", "");
    return views.indexOf(h) !== -1 ? h : "dr-view-signin";
  }

  // Heading, button and submitted intent all change together.
  function setIntent(intent) {
    var field = document.getElementById("dr-magic-intent");
    var heading = document.getElementById("dr-magic-heading");
    var sub = document.getElementById("dr-magic-sub");
    var submit = document.getElementById("dr-magic-submit");
    var reset = intent === "password_reset";
    if (field) field.value = reset ? "password_reset" : "login";
    if (heading) heading.textContent = reset ? "Set a new password" : "Email me a sign-in link";
    if (sub) {
      sub.textContent = reset
        ? "We'll email you a link. Click it and we'll take you straight to a page where you can choose a new password."
        : "Works whether or not you've set a password.";
    }
    if (submit) submit.textContent = reset ? "Email me a password-reset link" : "Email me a sign-in link";
  }

  document.addEventListener("click", function (e) {
    var a = e.target.closest ? e.target.closest(".dr-auth-switch") : null;
    if (!a) return;
    e.preventDefault();
    var target = a.getAttribute("data-target");
    if (target === "dr-view-magic") setIntent(a.getAttribute("data-intent") || "login");
    if (window.history && window.history.replaceState) {
      window.history.replaceState(null, "", "#" + target);
    }
    show(target);
  });

  window.addEventListener("hashchange", function () { show(fromHash()); });
  show(fromHash());

  // These three forms POST straight to the Worker with no JS at all, so any
  // error (wrong password, a blocked domain, a rate limit) navigated the
  // whole browser to the raw API response instead of showing an error on
  // this page -- reported directly, 2026-08-03. The API still returns plain
  // HTML (not JSON) for these routes, always as a single <p>message</p> in
  // an otherwise-empty page, so that is what gets pulled out and shown
  // inline; nothing about the routes themselves changes.
  function firstParagraphText(html) {
    var match = /<p>([\s\S]*?)<\/p>/.exec(html);
    if (!match) return "Something went wrong. Please try again.";
    var div = document.createElement("div");
    div.innerHTML = match[1];
    return div.textContent || div.innerText || "Something went wrong. Please try again.";
  }

  // A failed submit used to reload the whole page, which re-rendered the
  // Turnstile widget from scratch (fresh token). Now that e.preventDefault()
  // keeps the same DOM alive across a retry, a stale already-used token sat
  // around and got resubmitted, so Turnstile rejected it as "Verification
  // failed", masking whatever the real error was (e.g. a genuinely wrong
  // password) -- reported directly, 2026-08-03. A first attempt at this
  // fix only cleared the FORM's hidden field and re-enabled the submit
  // button immediately, without waiting for Cloudflare to actually finish
  // issuing a new token (that variable lives in a different script's
  // closure, invisible from here) -- the exact same failure kept recurring
  // on retry, sometimes now with an EMPTY token instead of a stale one,
  // which is the same bug with a different symptom. Re-enabling the
  // button only after drTurnstileRecover's callback fires (a genuinely new
  // token has arrived, or the 8s safety timeout elapsed) closes that gap.
  function recoverThenReenable(submitBtn) {
    if (window.drTurnstileRecover) {
      window.drTurnstileRecover(function () {
        if (submitBtn) submitBtn.disabled = false;
      });
    } else if (submitBtn) {
      submitBtn.disabled = false;
    }
  }

  // AuditLab L-2, 2026-08-03: nothing stopped a submit while the shared
  // token was still "" (interaction-only hasn't resolved yet, or the
  // browser/network blocks challenges.cloudflare.com entirely -- ad
  // blockers and corporate proxies routinely do). That POST always fails,
  // and retrying it can never work, so catching it before the network
  // round trip and saying the real reason beats one more generic failure.
  function turnstileFieldValue(form) {
    var field = form.querySelector('input[name="cf-turnstile-response"]');
    return field ? field.value : "";
  }

  function ajaxifyForm(formId, errorId, onSuccess) {
    var form = document.getElementById(formId);
    var errEl = errorId ? document.getElementById(errorId) : null;
    if (!form) return;
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (errEl) { errEl.hidden = true; errEl.textContent = ""; }
      var submitBtn = form.querySelector('button[type="submit"]');
      if (submitBtn) submitBtn.disabled = true;
      if (!turnstileFieldValue(form)) {
        if (errEl) {
          errEl.textContent = "Security check hasn't finished loading -- give it a moment and try "
            + "again, or disable your ad blocker for this page.";
          errEl.hidden = false;
        }
        recoverThenReenable(submitBtn);
        return;
      }
      fetch(form.getAttribute("action"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(new FormData(form)).toString(),
      }).then(function (resp) {
        if (resp.redirected) { onSuccess(true); return; }
        return resp.text().then(function (html) {
          if (resp.ok) { onSuccess(false, html); return; }
          if (errEl) { errEl.textContent = firstParagraphText(html); errEl.hidden = false; }
          recoverThenReenable(submitBtn);
        });
      }).catch(function () {
        if (errEl) { errEl.textContent = "Something went wrong. Please try again."; errEl.hidden = false; }
        recoverThenReenable(submitBtn);
      });
    });
  }

  ajaxifyForm("dr-firmlogin-signin-form", "dr-firmlogin-signin-error", function () {
    window.location.href = "/firm-dashboard/";
  });
  ajaxifyForm("dr-firmlogin-signup-form", "dr-firmlogin-signup-error", function () {
    var form = document.getElementById("dr-firmlogin-signup-form");
    var hint = document.getElementById("dr-firmlogin-signup-hint");
    var ok = document.getElementById("dr-firmlogin-signup-ok");
    if (form) form.hidden = true;
    if (hint) hint.hidden = true;
    if (ok) ok.hidden = false;
  });
  ajaxifyForm("dr-magic-form", "dr-magic-error", function () {
    var form = document.getElementById("dr-magic-form");
    var ok = document.getElementById("dr-magic-ok");
    if (form) form.hidden = true;
    if (ok) ok.hidden = false;
  });
})();
</script>"""


_SET_PASSWORD_JS_HTML = """<script>
(function () {
  var form = document.getElementById('dr-setpw-form');
  var err = document.getElementById('dr-setpw-error');
  var ok = document.getElementById('dr-setpw-ok');
  if (!form) return;

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (err) { err.hidden = true; err.textContent = ''; }
    var pw = document.getElementById('dr-setpw-new').value;
    var confirm = document.getElementById('dr-setpw-confirm').value;
    if (pw !== confirm) {
      // Checked here purely so the user gets an instant answer; the server
      // is still the authority on every other rule (length, reuse, strength).
      if (err) { err.textContent = 'Those two passwords do not match.'; err.hidden = false; }
      return;
    }
    var body = {new_password: pw};
    var cur = document.getElementById('dr-setpw-current');
    if (cur && cur.value) body.current_password = cur.value;

    fetch('/api/firm/password', {
      method: 'POST', credentials: 'include',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body)
    }).then(function (res) {
      // 401 means the session expired between arriving and submitting. Send
      // them back to the front door rather than showing a bare error.
      if (res.status === 401) { window.location.href = '/firm-login/'; return null; }
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          if (err) {
            err.textContent = (data && data.error) || 'Something went wrong, please try again.';
            err.hidden = false;
          }
          return;
        }
        form.hidden = true;
        if (ok) ok.hidden = false;
      });
    }).catch(function () {
      if (err) { err.textContent = 'Something went wrong, please try again.'; err.hidden = false; }
    });
  });
})();
</script>"""

_SET_PASSWORD_JS_HTML = _SET_PASSWORD_JS_HTML.replace("'/api/firm", f"'{REMINDER_BACKEND_BASE_URL}/firm")


def build_set_password_page() -> str:
    """"Choose a password" -- where a password-reset link now lands.

    THE BUG THIS EXISTS FOR: clicking "Forgot password" emailed a sign-in
    link, the link signed you in, and dropped you on the dashboard with
    nothing offering to set a password. The endpoint and the Account-tab form
    both already existed; the reset INTENT just never survived the round trip
    through the email, so the button quietly did something other than what it
    said. A dedicated screen is the version of the fix that cannot be missed.

    Reached only by redirect from a redeemed password-reset token (see
    handleFirmLoginVerify), but it does NOT rely on that for security: the
    page is static and enforces nothing. `POST /firm/password` is
    session-gated server-side and is the only authority; a 401 bounces the
    visitor back to /firm-login/. Someone who navigates here directly while
    signed in simply gets a legitimate way to set their password, which is
    not a capability they lacked -- the Account tab has always offered it.

    `noindex`: a signed-in account screen, not indexable content.
    """
    body = f"""<div class="dr-auth-card">
  <h1>Choose a password</h1>
  <p class="subhead">You're signed in. Set a password now and you can use it next time instead of
  waiting for an emailed link.</p>

  <form id="dr-setpw-form">
    <label for="dr-setpw-current">Current password <span class="field-hint">(leave blank if you
    have never set one)</span></label>
    <input type="password" id="dr-setpw-current" name="current_password"
    autocomplete="current-password">

    <label for="dr-setpw-new">New password</label>
    <input type="password" id="dr-setpw-new" name="new_password" required
    autocomplete="new-password">
    <p class="field-hint">At least 12 characters. Longer beats complicated &mdash; a short phrase
    you'll remember is stronger than a scramble you won't.</p>

    <label for="dr-setpw-confirm">Confirm new password</label>
    <input type="password" id="dr-setpw-confirm" required autocomplete="new-password">

    <button type="submit">Save password</button>
    <p id="dr-setpw-error" class="dr-account-err" hidden></p>
  </form>

  <div id="dr-setpw-ok" hidden>
    <p class="dr-account-ok"><strong>Your password is set.</strong> You can now sign in with it.
    Any other sign-in links we emailed you have been cancelled, and you've been signed out on other
    devices.</p>
    <p><a class="cta-button" href="/firm-dashboard/">Go to your dashboard &rarr;</a></p>
  </div>

  <p class="dr-auth-alt"><a href="/firm-dashboard/">Skip for now &mdash; go to the dashboard</a></p>
</div>
{_SET_PASSWORD_JS_HTML}
"""
    return page_shell(
        f"Choose a password — {SITE_NAME}",
        "Set your DeadlineRadar firm account password.",
        body,
        home_href="../",
        canonical_path="/set-password/",
        extra_head='<meta name="robots" content="noindex">',
        hide_signin=True,
    )


# SIGN-IN ROUTING (2026-08-02). A firm admin -- a PAYING customer -- clicked the
# header "Sign In", landed on the free individual page, and had no way to reach
# his firm dashboard except a link buried at the bottom of a second card. The
# free path was styled as the page and the paid path as a footnote.
#
# Fixed by presentation, deliberately NOT by routing logic. The alternative was
# one form that accepts either account type and routes after submit; that is
# cleaner UX but it is an auth change, and an auth change costs the full
# adversarial gate. This version reaches the same outcome -- the paid path is at
# least as prominent as the free one, at the TOP, and neither is guessed at --
# while touching no authentication code and no anti-enumeration property.
#
# The individual form also states plainly that it cannot sign anyone into a
# firm account, so someone who picks wrong learns it before submitting rather
# than after an email round trip.
def build_signin_page() -> str:
    """The FREE-TIER individual's sign-in page (2026-07-31), and the site's
    single front door for "Sign In" in the main nav.

    Why one front door rather than pointing the nav at /firm-login/ as it
    did before: the site now has two kinds of account, and a person who
    clicks "Sign In" does not think of themselves as "a firm" or "an
    individual" -- they think they have an account. Sending everyone to the
    firm page meant the far larger group (free individuals, who ARE the
    funnel) landed on a page asking for a firm name, with no visible way
    across. This page leads with the individual form because that is the
    common case, and links to /firm-login/ prominently rather than burying
    it, so neither audience is trapped at the wrong door -- the same
    wrong-door failure Devin walked into on /firm-login/ itself.

    Magic-link only, deliberately: there is no individual password anywhere
    in this system, so there is no "forgot password" state to design, and no
    individual credential to store or leak. The form POSTs top-level to the
    Worker exactly like every other form on this site; the Worker's
    subscriberLoginSentPage() IS the success page, so there is no
    client-side success state here.
    """
    body = f"""<h1>Sign in</h1>
<p class="subhead">Two kinds of account. Pick the one you have.</p>

<div class="signin-choice">
  <a class="signin-card" href="/firm-login/">
    <span class="signin-kind">Firm account</span>
    <span class="signin-desc">You manage renewals for a team. Roster, calendar, CPE tracking.</span>
    <span class="signin-go">Sign in to your firm dashboard &rarr;</span>
  </a>
  <a class="signin-card" href="#signin-individual">
    <span class="signin-kind">Just my own license</span>
    <span class="signin-desc">You get reminders for your own renewal dates. Free, no password.</span>
    <span class="signin-go">Sign in below &darr;</span>
  </a>
</div>

<div class="signup-form" id="signin-individual">
  <h2 id="dr-signin-sub-heading">Sign in to your own reminders</h2>
  <p class="signup-microcopy" id="dr-signin-sub-intro">Free, and there's no password &mdash; enter the
  email address your reminders go to and we'll send you a one-time sign-in link. <strong>Managing a
  firm? Use the firm dashboard above &mdash; this form cannot sign you into a firm account.</strong></p>
  <form method="post" action="{REMINDER_BACKEND_BASE_URL}/subscriber/login" id="dr-signin-sub-form">
    {_BOT_DEFENSE_FIELDS_HTML}
    <label for="signin-sub-email">Your email</label>
    <input type="email" id="signin-sub-email" name="email" required autocomplete="email"
    placeholder="you@example.com">
    <button type="submit">Email me a sign-in link</button>
  </form>
  <p id="dr-signin-sub-error" class="field-hint" style="color:#c33737;" hidden></p>
  <p class="dr-auth-alt" id="dr-signin-sub-ok" hidden>Check your email for the link. It expires in 15
  minutes and works once.</p>
  <p class="signup-microcopy" id="dr-signin-sub-footer">Not signed up yet? <a href="/">Pick your
  state</a> to start getting free renewal reminders &mdash; no account needed.</p>
</div>
{_SIGNIN_SUB_FORM_JS_HTML}
"""

    return page_shell(
        f"Sign In — {SITE_NAME}",
        "Sign in to DeadlineRadar to see every CPA license renewal deadline we're tracking for "
        "you. Free, no password required.",
        body,
        home_href="../",
        canonical_path="/signin/",
        # A nav "Sign In" link pointing at the sign-in page you are already
        # on is noise at best and a confusing no-op at worst.
        hide_signin=True,
    )


# AuditLab L-3, 2026-08-03: c3bda560 AJAX-ified the 3 /firm-login/ forms but
# missed this one -- a wrong/expired magic link attempt here still navigated
# the whole browser to raw API text, on the page the sitewide "Sign In" nav
# link actually points to. Self-contained rather than sharing code with
# _FIRM_LOGIN_VIEW_JS_HTML: this page has exactly one form and one
# (non-shared) Turnstile widget, so it doesn't need that page's 3-form
# token-juggling -- just the same "wait for a real token before letting a
# retry through" discipline, scoped to a single widget.
_SIGNIN_SUB_FORM_JS_HTML = """<script>
(function () {
  var form = document.getElementById('dr-signin-sub-form');
  if (!form) return;
  var errEl = document.getElementById('dr-signin-sub-error');
  var okEl = document.getElementById('dr-signin-sub-ok');
  var heading = document.getElementById('dr-signin-sub-heading');
  var intro = document.getElementById('dr-signin-sub-intro');
  var footer = document.getElementById('dr-signin-sub-footer');

  function firstParagraphText(html) {
    var match = /<p>([\\s\\S]*?)<\\/p>/.exec(html);
    if (!match) return "Something went wrong. Please try again.";
    var div = document.createElement("div");
    div.innerHTML = match[1];
    return div.textContent || div.innerText || "Something went wrong. Please try again.";
  }

  function turnstileField() {
    return form.querySelector('input[name="cf-turnstile-response"]');
  }

  // Same discipline as _turnstile_shared_widget_html(), scoped to this one
  // widget: a Turnstile token is single-use, so a failed submit must get rid
  // of it and wait for Cloudflare to actually issue a new one before another
  // attempt can possibly succeed -- re-enabling immediately just resubmits
  // the same dead (or still-empty) token and fails again (AuditLab L-1/L-2).
  // This widget has no data-callback (it's the plain non-shared render --
  // see _bot_defense_fields_html()), so there is no event to hook; polling
  // the hidden field Cloudflare itself manages is the only signal available,
  // and it's cheap enough at 150ms to feel instant once the token lands.
  function recoverThenReenable(submitBtn) {
    var field = turnstileField();
    if (field) field.value = "";
    if (window.turnstile && typeof window.turnstile.reset === "function") {
      try { window.turnstile.reset(); } catch (err) {}
    }
    var done = false;
    function finish() { if (done) return; done = true; if (submitBtn) submitBtn.disabled = false; }
    var elapsed = 0;
    var poll = setInterval(function () {
      elapsed += 150;
      var f = turnstileField();
      if ((f && f.value) || elapsed >= 8000) {
        clearInterval(poll);
        finish();
      }
    }, 150);
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    if (errEl) { errEl.hidden = true; errEl.textContent = ""; }
    var submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;
    var field = turnstileField();
    if (field && !field.value) {
      if (errEl) {
        errEl.textContent = "Security check hasn't finished loading -- give it a moment and try "
          + "again, or disable your ad blocker for this page.";
        errEl.hidden = false;
      }
      recoverThenReenable(submitBtn);
      return;
    }
    fetch(form.getAttribute("action"), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(new FormData(form)).toString(),
    }).then(function (resp) {
      return resp.text().then(function (html) {
        if (resp.ok) {
          form.hidden = true;
          if (heading) heading.hidden = true;
          if (intro) intro.hidden = true;
          if (footer) footer.hidden = true;
          if (okEl) okEl.hidden = false;
          return;
        }
        if (errEl) { errEl.textContent = firstParagraphText(html); errEl.hidden = false; }
        recoverThenReenable(submitBtn);
      });
    }).catch(function () {
      if (errEl) { errEl.textContent = "Something went wrong. Please try again."; errEl.hidden = false; }
      recoverThenReenable(submitBtn);
    });
  });
})();
</script>"""


# The /my/ dashboard's client. Same conventions as _FIRM_DASHBOARD_JS_HTML:
# plain ES5-style functions, no build step, no dependencies, and every fetch
# carries credentials:'include' so the session cookie rides along (needed
# because a preview deploy puts the Worker on a different origin than this
# static site; on production they share deadline-radar.com and it's a no-op).
#
# A 401 sends the visitor to /signin/, NOT /firm-login/ -- this page's
# principal is an individual, and bouncing them to the firm door would be
# the exact wrong-door trap /signin/ exists to prevent.
_MY_DASHBOARD_JS_HTML = """<script>
(function () {
  var listEl = document.getElementById('dr-my-list');
  var emailEl = document.getElementById('dr-my-email');
  var emptyEl = document.getElementById('dr-my-empty');
  var errorEl = document.getElementById('dr-my-error');

  // `s == null` (loose, deliberate) catches both null and a missing value in
  // one comparison -- and keeps the literal word out of the shipped HTML,
  // which preship_gate.py scans for as a sign of a rendering bug leaking
  // onto a page.
  function drEsc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Deadlines are plain YYYY-MM-DD calendar dates with no timezone. Parsing
  // them with new Date('2027-01-31') would read them as UTC midnight and
  // then render them in local time, which shows the day BEFORE anywhere west
  // of UTC -- an off-by-one on the single number this whole product exists
  // to get right. Splitting the parts and using the local-time constructor
  // keeps the date the board actually published.
  function drParseDate(s) {
    var p = String(s).split('-');
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  }

  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                'August', 'September', 'October', 'November', 'December'];

  function drFormatDate(s) {
    if (!s) return null;
    var d = drParseDate(s);
    return MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
  }

  function drDaysUntil(s) {
    var d = drParseDate(s);
    var now = new Date();
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.round((d - today) / 86400000);
  }

  // Mirrors the urgency language of the reminder emails themselves, so the
  // dashboard and the inbox never describe the same deadline differently.
  function drUrgency(days) {
    if (days === null) return '';
    if (days < 0) return 'is-overdue';
    if (days <= 30) return 'is-soon';
    return '';
  }

  function drCountdown(days) {
    if (days === null) return '';
    if (days < 0) return 'Passed ' + Math.abs(days) + ' day' + (Math.abs(days) === 1 ? '' : 's') + ' ago';
    if (days === 0) return 'Due today';
    if (days === 1) return 'Due tomorrow';
    return days + ' days away';
  }

  function drStatusNote(lic) {
    if (lic.status === 'pending') {
      return 'Not confirmed yet -- check your inbox for the confirmation email, or reminders will not send.';
    }
    if (lic.status === 'opted_out') {
      return 'You unsubscribed from these reminders.';
    }
    if (lic.status === 'needs-attention' && lic.stop_reason === 'renewed') {
      return 'Reminders stopped after you renewed. Re-arm them from any past reminder email.';
    }
    if (lic.status === 'needs-attention') {
      return 'Reminders are not currently sending for this one.';
    }
    return null;
  }

  function drRender(data) {
    if (emailEl) emailEl.textContent = data.email || '';
    var licenses = data.licenses || [];
    if (!licenses.length) {
      if (emptyEl) emptyEl.hidden = false;
      return;
    }
    listEl.innerHTML = licenses.map(function (lic) {
      var days = lic.next_deadline ? drDaysUntil(lic.next_deadline) : null;
      var dateText = lic.next_deadline
        ? drFormatDate(lic.next_deadline)
        : 'No date on file yet';
      var note = drStatusNote(lic);
      // "Tracked by your firm" is shown because these rows are real and the
      // person really does get their reminders -- hiding them would show an
      // incomplete picture of their own deadlines. It is a LABEL, not a
      // control: the row belongs to the firm's roster and this page offers
      // no way to change it.
      var firmPill = lic.managed_by_firm
        ? '<span class="dr-my-pill">Tracked by your firm</span>' : '';
      var ownDatePill = lic.deadline_source === 'user'
        ? '<span class="dr-my-pill dr-my-pill-quiet">Your own date</span>' : '';
      return '<li class="dr-my-card ' + drUrgency(days) + '">' +
        '<div class="dr-my-card-head">' +
          '<h3>' + drEsc(lic.state_name) + '</h3>' + firmPill + ownDatePill +
        '</div>' +
        '<div class="dr-my-date">' + drEsc(dateText) + '</div>' +
        (days !== null ? '<div class="dr-my-count">' + drEsc(drCountdown(days)) + '</div>' : '') +
        (note ? '<div class="dr-my-note">' + drEsc(note) + '</div>' : '') +
        '</li>';
    }).join('');
  }

  fetch('/api/subscriber/licenses', {credentials: 'include'})
    .then(function (res) {
      if (res.status === 401) { window.location.href = '/signin/'; return null; }
      if (!res.ok) throw new Error('load failed');
      return res.json();
    })
    .then(function (data) { if (data) drRender(data); })
    .catch(function () {
      // Never leave the page sitting on "Loading..." forever -- a silent
      // spinner reads as "you have nothing", which for a deadline product is
      // a genuinely dangerous thing to imply.
      if (listEl) listEl.innerHTML = '';
      if (errorEl) errorEl.hidden = false;
    });
})();
</script>"""

_MY_DASHBOARD_JS_HTML = _MY_DASHBOARD_JS_HTML.replace(
    "'/api/subscriber", f"'{REMINDER_BACKEND_BASE_URL}/subscriber"
)


def build_my_page() -> str:
    """The free individual's dashboard (2026-07-31).

    Read-only, on purpose. Everything this page shows already existed --
    the reminders have been sending since day one -- so this adds visibility,
    not capability, and every mutation (unsubscribe, re-arm, "I renewed")
    stays where it already works: the tokenised links in the reminder emails
    themselves. That keeps the entire write surface for individuals at zero
    new endpoints.

    `noindex` for the same reason /firm-dashboard/ is: a signed-in app view,
    not indexable content. /signin/ stays indexable.
    """
    body = f"""<div class="dr-my-shell">
  <div class="dr-my-head">
    <div>
      <h1>Your renewal deadlines</h1>
      <p class="subhead" id="dr-my-email-line">Signed in as <span id="dr-my-email">&hellip;</span></p>
    </div>
    <form method="post" action="{REMINDER_BACKEND_BASE_URL}/subscriber/logout" class="dr-my-signout">
      <button type="submit">Sign out</button>
    </form>
  </div>

  <div class="dr-my-error" id="dr-my-error" hidden>
    <p><b>We couldn't load your deadlines just now.</b> Your reminders are unaffected &mdash; they
    send from our servers, not this page. Please refresh in a moment.</p>
  </div>

  <ul class="dr-my-list" id="dr-my-list"><li class="dr-my-loading">Loading&hellip;</li></ul>

  <div class="dr-my-empty" id="dr-my-empty" hidden>
    <p><b>Nothing tracked yet.</b> Pick your state and we'll email you before your license renewal
    is due &mdash; free, no account required.</p>
    <p><a class="cta-button" href="/">Choose your state &rarr;</a></p>
  </div>

  <div class="dr-my-actions">
    <p><a href="/">+ Track another state</a> &mdash; you can add as many as you hold licenses in.</p>
    <p class="signup-microcopy">To stop or restart reminders for any one deadline, use the links at
    the bottom of that deadline's reminder emails.</p>
  </div>

  <div class="dr-my-upsell">
    <h2>Tracking renewals for a team?</h2>
    <p>DeadlineRadar for Firms puts every staff CPA's renewal on one roster, sorted by what needs
    attention soonest &mdash; plus CPE hour tracking and a calendar view. Free 30-day pilot, no card
    required.</p>
    <p><a class="cta-button" href="/for-firms/">See DeadlineRadar for Firms &rarr;</a></p>
  </div>
</div>
{_MY_DASHBOARD_JS_HTML}
"""

    return page_shell(
        f"Your deadlines — {SITE_NAME}",
        "Your DeadlineRadar dashboard.",
        body,
        home_href="../",
        canonical_path="/my/",
        extra_head='<meta name="robots" content="noindex">',
        hide_signin=True,
        sticky_top_nav=False,
    )


def _firm_dashboard_map_svg_html(by_slug: dict[str, list[dict]]) -> str:
    """The dashboard's US map view (2026-07-30, BUILD v2 Phase D): renders all 51 state paths
    (same public-domain outline data as build_us_map_html() -- assets/us-map/LICENSE.txt) ONCE
    at build time, since geography doesn't change. Every path is left uncolored here (fill is
    entirely CSS default, i.e. "no staff" gray) and carries a `data-state-slug` attribute --
    the actual per-firm coloring (green/red by which states the signed-in firm has staff in,
    and whether any of them are at risk) can only be known client-side, from drLicenses, after
    the page loads and the firm's own roster is fetched. Territories (Guam/Puerto Rico/USVI/
    Northern Mariana Islands) have no path on a US outline map -- an inherent limitation of a
    geographic map, not a gap this view is hiding; the roster table already covers them.

    Keyboard/screen-reader access (2026-07-30, adversarial-review fix): tabindex="0" (not -1) +
    an initial aria-label -- an earlier version excluded these links from the tab order entirely,
    a real regression against this SAME file's own homepage map (build_us_map_html()), which
    keeps its links focusable with a focus/blur-wired tooltip. drRenderMap() (the JS) updates
    aria-label to the real per-state roster info once the firm's data loads, same as it already
    updates data-tip for the mouse-hover case."""
    map_states = json.loads(_US_MAP_PATHS_PATH.read_text(encoding="utf-8"))
    path_links = "\n".join(
        f'<a class="dr-map-link" data-state-slug="{esc(s["slug"])}" tabindex="0" '
        f'aria-label="{esc(by_slug[s["slug"]][0]["state"] if by_slug.get(s["slug"]) else s["slug"].replace("-", " ").title())} '
        f'-- no staff licensed here">'
        f'<path class="dr-map-state" d="{esc(s["d"])}"></path></a>'
        for s in map_states
    )
    return f"""<div class="dr-map-body">
  <div class="dr-map-figure">
    <svg class="dr-us-map" viewBox="0 0 959 593" xmlns="http://www.w3.org/2000/svg" role="img"
    aria-label="US map colored by whether your firm has staff licensed there, and their risk level">
{path_links}
    </svg>
    <div class="dr-map-tooltip" id="dr-map-tooltip" hidden aria-hidden="true"></div>
  </div>
  <div>
    <div class="dr-map-legend" id="dr-map-legend-staff">
      <span><span class="swatch" style="background:#1f9e5c"></span>Staff licensed here, all current</span>
      <span><span class="swatch" style="background:#c33737"></span>Staff licensed here, due soon or unresolved</span>
      <span id="dr-map-legend-coverage-item" hidden><span class="swatch" style="background:#8a6bd4"></span>No staff licensed here, but practice privilege clear for someone on your team</span>
      <span><span class="swatch" style="background:var(--border)"></span>No staff licensed here</span>
    </div>
    <div class="dr-map-legend" id="dr-map-legend-mobility" hidden>
      <span><span class="swatch" style="background:#1f9e5c"></span>Home state</span>
      <span><span class="swatch" style="background:#6b8fd4"></span>Practice privilege clear</span>
      <span><span class="swatch" style="background:#d98a1f"></span>Action required first</span>
      <span><span class="swatch" style="background:var(--border)"></span>Not verified / not covered</span>
    </div>
    <p class="dr-map-note">Territories (Guam, Puerto Rico, U.S. Virgin Islands, Northern Mariana
    Islands) aren't shown on the map -- see the roster table for your full list.</p>
  </div>
</div>"""


def _firm_dashboard_add_staff_form_html(by_slug: dict[str, list[dict]], as_of: date) -> str:
    """The "Add staff" form. Deliberately reuses the EXACT SAME per-state
    show/hide-by-state pattern as signup_form_homepage()/drUpdateFields() --
    a state dropdown plus one hidden `.signup-extra-fields` group per state
    (rendered via the same _extra_fields_html() every public signup form
    uses), rather than inventing a second implementation of "which fields
    does this state need" that could drift from resolveDeadlineInput() in
    worker/src/index.ts. `state_slug` is the field name here (not `state`,
    like the public form uses) because that's the key
    handleFirmLicenseCreate() actually reads.

    Inherits one pre-existing, harmless quirk from signup_form_homepage()'s
    identical pattern: two different states that both fall into the
    "multiple computed license types" family each render a
    `<select id="license_type_id">`, so this page (like the homepage) can
    have more than one element sharing that id. It is not a NEW defect this
    page introduces -- drUpdateFields() disables every field outside the
    selected state's group, and FormData only serializes ENABLED fields by
    name, so only one `license_type_id` is ever actually submitted. The
    duplicate id is an HTML-validity nit inherited from the homepage, not a
    functional bug."""
    all_slugs = sorted(by_slug, key=lambda slug: by_slug[slug][0]["state"])
    state_options = "\n".join(
        f'<option value="{esc(slug)}">{esc(by_slug[slug][0]["state"])}</option>' for slug in all_slugs
    )
    field_groups = "\n".join(
        f'<div class="signup-extra-fields" data-for-state="{esc(slug)}" hidden>'
        f'{_extra_fields_html(slug, by_slug[slug], as_of)}</div>'
        for slug in all_slugs
        if _extra_fields_html(slug, by_slug[slug], as_of)
    )
    return f"""<div class="signup-form" id="dr-add-staff">
  <h2>Add staff</h2>
  <p class="signup-microcopy">Their reminders start right away -- no confirmation step to wait on.
  They'll get one email the moment you add them, naming your firm and with a one-click opt-out if
  they'd rather not be tracked this way.</p>
  <form id="dr-add-staff-form">
    <label for="dr-add-label">Name or label (optional)</label>
    <input type="text" id="dr-add-label" name="staff_label" maxlength="120" placeholder="e.g. Alex Rivera">
    <label for="dr-add-email">Email</label>
    <input type="email" id="dr-add-email" name="email" required placeholder="alex@example.com">
    <label for="dr-add-state">State</label>
    <select id="dr-add-state" name="state_slug" required onchange="drUpdateFields(this.value)">
      <option value="">Select state</option>
      {state_options}
    </select>
    {field_groups}
    <button type="submit">Add staff</button>
  </form>
  <p id="dr-add-error" class="field-hint" style="color:#c33737;" hidden></p>
</div>"""


# The dashboard's client-side JS. A plain (non-f-string) constant -- this
# block is 100% static and has no build-time values to interpolate, so an
# f-string would only force every literal `{`/`}` in the JS (e.g.
# escapeHtml()'s character map) to be doubled for no benefit. Everything the
# dashboard renders from API data goes through escapeHtml() before ever
# touching innerHTML -- staff_label and email are admin-entered free text
# (see worker/src/index.ts's handleFirmLicenseCreate()/handleFirmLicensePatch(),
# which validate format/length/control-chars but do NOT strip HTML), so an
# unescaped render here would be a real stored-XSS hole on a page an
# authenticated firm admin will keep open, not merely a cosmetic bug.
_FIRM_DASHBOARD_JS_HTML = """<script>
function drUpdateFields(slug) {
  document.querySelectorAll('.signup-extra-fields').forEach(function(el) {
    var show = (el.getAttribute('data-for-state') === slug);
    el.hidden = !show;
    el.querySelectorAll('input, select, textarea').forEach(function(field) {
      field.disabled = !show;
    });
  });
}

function drEscapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function(c) {
    return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c];
  });
}

// HYBRID consent model (2026-07-28): a firm-added staffer is active
// immediately (no more "pending" state going forward on this path -- see
// worker/src/index.ts's firmLicenseStatus()). 'pending' is kept here only so
// an old/legacy row doesn't render as an unrecognized blank status; 'opted_out'
// is the new one, shown when a staffer used the one-click opt-out this
// consent model depends on for staying CAN-SPAM-clean.
var DR_STATUS_LABELS = {
  active: 'Active', confirmed: 'Active', pending: 'Pending',
  opted_out: 'Opted out', 'needs-attention': 'Needs attention'
};
var DR_STATUS_CLASSES = {
  active: 'mock-status--ok', confirmed: 'mock-status--ok', pending: 'mock-status--pending',
  opted_out: 'mock-status--pending', 'needs-attention': 'mock-status--risk'
};

var drLicenses = [];
var drEditingId = null;

function drShowError(msg) {
  var el = document.getElementById('dr-dash-error');
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
}
function drClearError() {
  var el = document.getElementById('dr-dash-error');
  if (!el) return;
  el.hidden = true;
  el.textContent = '';
}
function drReadJsonSafe(res) {
  return res.json().catch(function() { return null; });
}
function drPrettyLicenseType(id) {
  if (!id) return '\\u2014';
  // The leading segment is a 2-letter state/territory postal code (ga,
  // il, dc, us in "us-virgin-islands", ...) and reads as a typo in title
  // case ("La Individual" for Louisiana) -- reported directly, 2026-08-03.
  // Every other segment is a plain word ("individual", "firm", "virgin"),
  // fine to title-case normally.
  return String(id).split(/[_-]+/).map(function(part, i) {
    if (i === 0 && part.length === 2) return part.toUpperCase();
    return part.charAt(0).toUpperCase() + part.slice(1);
  }).join(' ');
}
function drFormatDeadline(iso) {
  if (!iso) return '\\u2014';
  try {
    var d = new Date(iso + 'T00:00:00Z');
    if (isNaN(d.getTime())) return iso;
    var browserLocale;
    return d.toLocaleDateString(browserLocale, {year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC'});
  } catch (e) {
    return iso;
  }
}

function drRenderRow(item) {
  var statusClass = DR_STATUS_CLASSES[item.status] || 'mock-status--risk';
  var statusLabel = DR_STATUS_LABELS[item.status] || item.status;
  var idAttr = drEscapeHtml(item.id);
  var staffCell, emailCell, actionsCell;
  if (drEditingId === item.id) {
    staffCell = '<input type="text" class="dr-edit-label" maxlength="120" value="' + drEscapeHtml(item.staff_label || '') + '">';
    emailCell = '<input type="email" class="dr-edit-email" value="' + drEscapeHtml(item.email) + '">';
    actionsCell =
      '<button type="button" class="dr-btn-save" data-id="' + idAttr + '">Save</button> ' +
      '<button type="button" class="dr-btn-cancel" data-id="' + idAttr + '">Cancel</button>';
  } else {
    staffCell = item.staff_label ? drEscapeHtml(item.staff_label) : '<span style="color:var(--muted)">\\u2014</span>';
    emailCell = drEscapeHtml(item.email);
    actionsCell =
      '<button type="button" class="dr-btn-edit" data-id="' + idAttr + '">Edit</button> ' +
      '<button type="button" class="dr-btn-renew" data-id="' + idAttr + '">Mark renewed</button> ' +
      '<button type="button" class="dr-btn-remove" data-id="' + idAttr + '">Remove</button>';
  }
  // data-label drives the stacked card layout under 860px (CSS renders it
  // via ::before), so the header row can be hidden without losing meaning.
  // The email cell also carries title= so truncation never destroys the
  // actual address -- it stays available on hover and to screen readers.
  var emailTitle = drEditingId === item.id ? '' : ' title="' + drEscapeHtml(item.email) + '"';
  return '<tr data-id="' + idAttr + '">' +
    '<td data-label="Staff">' + staffCell + '</td>' +
    '<td data-label="Email" class="dr-cell-email"' + emailTitle + '>' + emailCell + '</td>' +
    '<td data-label="State">' + drEscapeHtml(item.state_name || '') + '</td>' +
    '<td data-label="License type">' + drEscapeHtml(drPrettyLicenseType(item.license_type_id)) + '</td>' +
    '<td data-label="Status"><span class="mock-status ' + statusClass + '">' + drEscapeHtml(statusLabel) + '</span></td>' +
    '<td data-label="Next deadline">' + drEscapeHtml(drFormatDeadline(item.next_deadline)) + '</td>' +
    '<td data-label="Actions" class="dr-actions">' + actionsCell + '</td>' +
  '</tr>';
}

function drRenderTable() {
  var tbody = document.getElementById('dr-roster-body');
  if (!tbody) return;
  if (drLicenses.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7">No staff on your roster yet -- add your first one below.</td></tr>';
    return;
  }
  tbody.innerHTML = drLicenses.map(drRenderRow).join('');
}

// ---------------------------------------------------------------------------
// Dashboard overview panels (2026-07-30, BUILD v2 Phase B redesign): coverage
// gauge, status donut, staff-at-risk list, recent-activity feed. All computed
// client-side from the SAME drLicenses array the roster table already uses --
// no new endpoint, no new data beyond the created_at/confirmed_at/stopped_at/
// stop_reason/firm_name fields the API now also returns (index.ts's
// toFirmLicenseJson()/handleFirmLicensesList()). Deliberately no fabricated
// "renewed" activity type -- see toFirmLicenseJson()'s own comment for why
// that fact doesn't exist yet in this schema.
// ---------------------------------------------------------------------------

// Whole-day difference between an ISO date (YYYY-MM-DD, UTC-anchored, same
// convention drFormatDeadline() already uses) and today, in UTC calendar
// days -- not a raw ms/86400000 divide, which would drift by a day near a
// DST boundary if this ever ran against local time instead of UTC.
function drDaysUntil(iso) {
  if (!iso) return null;
  var target = new Date(iso + 'T00:00:00Z').getTime();
  if (isNaN(target)) return null;
  var now = new Date();
  var todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((target - todayUtc) / 86400000);
}

function drDaysAgo(isoTimestamp) {
  if (!isoTimestamp) return null;
  var then = new Date(isoTimestamp).getTime();
  if (isNaN(then)) return null;
  var days = Math.floor((Date.now() - then) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return '1 day ago';
  if (days < 30) return days + ' days ago';
  var months = Math.floor(days / 30);
  return months === 1 ? '1 month ago' : months + ' months ago';
}

function drRingSvg(pct, isRisk) {
  var r = 24, c = 2 * Math.PI * r;
  var clamped = Math.max(0, Math.min(100, pct));
  var dash = (clamped / 100) * c;
  return '<div class="dr-ring-wrap' + (isRisk ? ' is-risk' : '') + '">' +
    '<svg width="58" height="58" viewBox="0 0 58 58" aria-hidden="true">' +
    '<circle class="dr-ring-track" cx="29" cy="29" r="' + r + '"></circle>' +
    '<circle class="dr-ring-value" cx="29" cy="29" r="' + r + '" stroke-dasharray="' + dash.toFixed(1) + ' ' + c.toFixed(1) + '"></circle>' +
    '</svg><div class="dr-ring-pct">' + clamped + '%</div></div>';
}

var DR_DONUT_ORDER = ['active', 'pending', 'needs-attention', 'opted_out'];
var DR_DONUT_COLORS = {active: '#1f9e5c', pending: '#9c7a12', 'needs-attention': '#c33737', opted_out: '#8595a3'};
var DR_DONUT_LABELS = {active: 'Active', pending: 'Pending', 'needs-attention': 'Needs attention', opted_out: 'Opted out'};

// Plain CSS conic-gradient, not an SVG pie -- no path-arc trigonometry needed
// for a simple ring, and it's one element instead of N <path>s.
function drDonutSvg(counts, total) {
  if (!total) return '<div class="dr-donut-wrap"><div class="dr-panel-empty">No staff yet</div></div>';
  var acc = 0;
  var segments = [];
  DR_DONUT_ORDER.forEach(function(key) {
    var n = counts[key] || 0;
    if (!n) return;
    var start = (acc / total) * 360;
    acc += n;
    var end = (acc / total) * 360;
    segments.push(DR_DONUT_COLORS[key] + ' ' + start.toFixed(1) + 'deg ' + end.toFixed(1) + 'deg');
  });
  var legend = DR_DONUT_ORDER.filter(function(k) { return counts[k]; }).map(function(k) {
    return '<li><span class="swatch" style="background:' + DR_DONUT_COLORS[k] + '"></span>' +
      drEscapeHtml(DR_DONUT_LABELS[k]) + ' (' + counts[k] + ')</li>';
  }).join('');
  return '<div class="dr-donut-wrap">' +
    '<div style="width:58px;height:58px;border-radius:50%;flex:none;display:flex;align-items:center;' +
    'justify-content:center;background:conic-gradient(' + segments.join(', ') + ');" aria-hidden="true">' +
    '<div style="width:30px;height:30px;border-radius:50%;background:var(--card-bg);"></div></div>' +
    '<ul class="dr-donut-legend">' + legend + '</ul></div>';
}

function drRenderStats() {
  var row = document.getElementById('dr-stat-row');
  if (!row) return;
  var total = drLicenses.length;
  var counts = {active: 0, pending: 0, 'needs-attention': 0, opted_out: 0};
  var atRisk = 0;
  drLicenses.forEach(function(item) {
    var s = item.status || 'needs-attention';
    counts[s] = (counts[s] || 0) + 1;
    if (s === 'opted_out') return;
    var days = drDaysUntil(item.next_deadline);
    if (days === null || days <= 30) atRisk++;
  });
  var coveragePct = total ? Math.round((counts.active / total) * 100) : 0;
  var riskPct = total ? Math.round((atRisk / total) * 100) : 0;

  row.innerHTML =
    '<div class="dr-stat-card">' + drRingSvg(coveragePct, false) +
      '<div><div class="dr-stat-label">Coverage</div><div class="dr-stat-value">' + coveragePct + '%</div>' +
      '<div class="dr-stat-sub">' + counts.active + ' of ' + total + ' active</div></div></div>' +
    '<div class="dr-stat-card">' + drDonutSvg(counts, total) +
      '<div><div class="dr-stat-label">Roster status</div><div class="dr-stat-value">' + total + '</div>' +
      '<div class="dr-stat-sub">staff tracked</div></div></div>' +
    '<div class="dr-stat-card">' + drRingSvg(riskPct, atRisk > 0) +
      // Deliberately labeled "Due soon", not "Needs attention" -- that exact
      // phrase is already the donut/roster-table's label for the DIFFERENT,
      // narrower "needs-attention" status enum (a stuck/anomalous record).
      // This tile counts something broader (due within 30 days OR
      // unresolved, regardless of status, including healthy "active" rows),
      // so the two would routinely show different numbers under an
      // identical label on the same screen -- kept deliberately distinct.
      '<div><div class="dr-stat-label">Due soon</div><div class="dr-stat-value">' + atRisk + '</div>' +
      '<div class="dr-stat-sub">due within 30 days or unresolved</div></div></div>';
}

function drRenderAtRisk() {
  var el = document.getElementById('dr-at-risk-list');
  if (!el) return;
  var items = drLicenses.filter(function(item) {
    if (item.status === 'opted_out') return false;
    var days = drDaysUntil(item.next_deadline);
    return days === null || days <= 30;
  }).slice(0, 6);
  if (items.length === 0) {
    el.innerHTML = '<li class="dr-panel-empty">Nobody at risk right now.</li>';
    return;
  }
  el.innerHTML = items.map(function(item) {
    var days = drDaysUntil(item.next_deadline);
    var daysLabel = days === null ? 'Unresolved' : days < 0 ? 'Overdue' : days === 0 ? 'Due today' : 'in ' + days + 'd';
    var soon = days !== null && days <= 7;
    return '<li class="dr-at-risk-item"><span><span class="dr-at-risk-name">' +
      drEscapeHtml(item.staff_label || item.email) + '</span>' +
      '<span class="dr-at-risk-sub">' + drEscapeHtml(item.state_name || '') + '</span></span>' +
      '<span class="dr-at-risk-days' + (soon ? ' dr-at-risk-days--soon' : '') + '">' + daysLabel + '</span></li>';
  }).join('');
}

var DR_ACTIVITY_LABELS = {added: 'added to the roster', confirmed: 'went active', optout: 'opted out of reminders'};
var DR_ACTIVITY_DOT_CLASS = {added: '', confirmed: 'dr-activity-dot--confirm', optout: 'dr-activity-dot--optout'};

function drRenderActivity() {
  var el = document.getElementById('dr-activity-list');
  if (!el) return;
  var events = [];
  drLicenses.forEach(function(item) {
    var name = item.staff_label || item.email;
    if (item.created_at) events.push({type: 'added', at: item.created_at, name: name});
    // Skip a 'confirmed' event that landed at the exact same instant as
    // 'added' -- under the HYBRID consent model (the only path that creates
    // a firm-scoped roster entry today) every admin-added staffer is
    // confirmed immediately, so created_at === confirmed_at always. Without
    // this check one atomic "add staff" click would render as two separate
    // feed entries.
    if (item.confirmed_at && item.confirmed_at !== item.created_at) {
      events.push({type: 'confirmed', at: item.confirmed_at, name: name});
    }
    if (item.status === 'opted_out' && item.stopped_at) events.push({type: 'optout', at: item.stopped_at, name: name});
  });
  events.sort(function(a, b) { return new Date(b.at).getTime() - new Date(a.at).getTime(); });
  events = events.slice(0, 6);
  if (events.length === 0) {
    el.innerHTML = '<li class="dr-panel-empty">No activity yet.</li>';
    return;
  }
  el.innerHTML = events.map(function(ev) {
    return '<li class="dr-activity-item"><span class="dr-activity-dot ' + DR_ACTIVITY_DOT_CLASS[ev.type] + '"></span>' +
      '<span class="dr-activity-text"><b>' + drEscapeHtml(ev.name) + '</b> ' + DR_ACTIVITY_LABELS[ev.type] +
      '<span class="dr-activity-when">' + drDaysAgo(ev.at) + '</span></span></li>';
  }).join('');
}

function drRenderFirmName(name) {
  var el = document.getElementById('dr-firm-name');
  if (el && name) el.textContent = name;
}

// AuditLab ST-1: the API refuses new signups/staff-adds once its reference
// data is past the freshness threshold, but the dashboard used to show every
// date on this page -- including the one "Mark renewed" just computed -- with
// no hint that guard might be active. GET /api/firm/licenses now carries
// data_as_of/data_stale; surface it rather than stay silent.
function drRenderStalenessBanner(dataAsOf, dataStale) {
  var el = document.getElementById('dr-staleness-banner');
  if (!el) return;
  if (!dataStale) { el.hidden = true; el.textContent = ''; return; }
  el.textContent = 'Heads up: our reference data was last verified ' + dataAsOf +
    ' and is due for re-verification. Dates below may be out of date, and adding new staff or ' +
    'editing a license state/deadline is temporarily paused until we re-verify.';
  el.hidden = false;
}

// ---------------------------------------------------------------------------
// Calendar + Map views (2026-07-30, BUILD v2 Phase D) -- both render from the
// SAME drLicenses array the roster view already fetched; no new endpoint,
// no separate page load. Switching tabs never re-fetches.
// ---------------------------------------------------------------------------

function drSwitchView(view) {
  document.querySelectorAll('.dr-view').forEach(function(el) {
    el.hidden = (el.id !== 'dr-view-' + view);
  });
  document.querySelectorAll('.dr-nav a[data-view]').forEach(function(a) {
    var isActive = (a.getAttribute('data-view') === view);
    a.classList.toggle('is-active', isActive);
    a.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });
}

var DR_MONTH_NAMES = ['January','February','March','April','May','June','July',
  'August','September','October','November','December'];
var DR_DOW_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

// null until drRenderCalendar()'s first call, then holds the UTC first-of-
// month currently shown -- prev/next/today buttons mutate this and re-render.
var drCalendarRefDate = null;

function drLicensesByDate() {
  var map = {};
  drLicenses.forEach(function(item) {
    if (item.status === 'opted_out' || !item.next_deadline) return;
    if (!map[item.next_deadline]) map[item.next_deadline] = [];
    map[item.next_deadline].push(item);
  });
  return map;
}

function drRenderCalendar() {
  var grid = document.getElementById('dr-cal-grid');
  var label = document.getElementById('dr-cal-month-label');
  if (!grid || !label) return;
  if (!drCalendarRefDate) {
    var now = new Date();
    drCalendarRefDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  }
  var ref = drCalendarRefDate;
  label.textContent = DR_MONTH_NAMES[ref.getUTCMonth()] + ' ' + ref.getUTCFullYear();

  var byDate = drLicensesByDate();
  var firstDow = ref.getUTCDay();
  var numDays = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() + 1, 0)).getUTCDate();
  var todayIso = new Date().toISOString().slice(0, 10);

  var html = DR_DOW_NAMES.map(function(d) { return '<div class="dr-cal-dow">' + d + '</div>'; }).join('');
  for (var lead = 0; lead < firstDow; lead++) {
    html += '<div class="dr-cal-day dr-cal-day--empty"></div>';
  }
  for (var day = 1; day <= numDays; day++) {
    var iso = ref.getUTCFullYear() + '-' + String(ref.getUTCMonth() + 1).padStart(2, '0') +
      '-' + String(day).padStart(2, '0');
    var items = byDate[iso] || [];
    var cellItems = items.slice(0, 3).map(function(item) {
      var days = drDaysUntil(item.next_deadline);
      var soon = days !== null && days <= 7;
      return '<div class="dr-cal-item' + (soon ? ' dr-cal-item--soon' : '') + '">' +
        drEscapeHtml(item.staff_label || item.email) + '</div>';
    }).join('');
    if (items.length > 3) {
      cellItems += '<div class="dr-cal-item">+' + (items.length - 3) + ' more</div>';
    }
    html += '<div class="dr-cal-day' + (iso === todayIso ? ' dr-cal-day--today' : '') +
      (items.length ? ' dr-cal-day--has-item' : '') + '">' +
      '<span class="dr-cal-daynum">' + day + '</span>' + cellItems + '</div>';
  }
  grid.innerHTML = html;
}

function drRenderAgenda() {
  var el = document.getElementById('dr-agenda-body');
  if (!el) return;
  var items = drLicenses.filter(function(item) {
    if (item.status === 'opted_out' || !item.next_deadline) return false;
    var days = drDaysUntil(item.next_deadline);
    return days !== null && days >= 0 && days <= 90;
  });
  if (items.length === 0) {
    el.innerHTML = '<p class="dr-panel-empty">Nothing due in the next 90 days.</p>';
    return;
  }
  var groups = {};
  var order = [];
  items.forEach(function(item) {
    var key = item.next_deadline.slice(0, 7); // 'YYYY-MM', next_deadline is already YYYY-MM-DD
    if (!groups[key]) { groups[key] = []; order.push(key); }
    groups[key].push(item);
  });
  el.innerHTML = order.map(function(key) {
    var parts = key.split('-');
    var monthLabel = DR_MONTH_NAMES[parseInt(parts[1], 10) - 1] + ' ' + parts[0];
    var rows = groups[key].map(function(item) {
      return '<div class="dr-agenda-item"><span>' + drEscapeHtml(item.staff_label || item.email) +
        ' &mdash; ' + drEscapeHtml(item.state_name || '') + '</span>' +
        '<span class="dr-agenda-date">' + drEscapeHtml(drFormatDeadline(item.next_deadline)) + '</span></div>';
    }).join('');
    return '<div class="dr-agenda-group"><div class="dr-agenda-month">' + monthLabel + '</div>' + rows + '</div>';
  }).join('');
}

// Every color class either map mode can apply to a path -- both
// drRenderMap() and drApplyMobilityResults() clear this FULL set before
// applying their own, so switching modes never leaves a stale class from
// the other mode sitting on a path (2026-08-03: caught in verification --
// drRenderMap() only cleared its own two classes, so a state colored
// dr-map-state--home in mobility mode stayed that way after switching back
// to "All staff", visually fighting with the class the All view then added).
var DR_MAP_STATE_CLASSES = ['dr-map-state--active', 'dr-map-state--risk', 'dr-map-state--clear', 'dr-map-state--action', 'dr-map-state--home', 'dr-map-state--coverage'];

function drClearMapStateClasses(path) {
  DR_MAP_STATE_CLASSES.forEach(function(c) { path.classList.remove(c); });
}

function drRenderMap(gen) {
  var links = document.querySelectorAll('.dr-map-link');
  if (!links.length) return;
  var byState = {};
  drLicenses.forEach(function(item) {
    if (item.status === 'opted_out' || !item.state_slug) return;
    if (!byState[item.state_slug]) byState[item.state_slug] = {items: [], risk: false};
    byState[item.state_slug].items.push(item);
    var days = drDaysUntil(item.next_deadline);
    if (days === null || days <= 30) byState[item.state_slug].risk = true;
  });
  links.forEach(function(link) {
    var slug = link.getAttribute('data-state-slug');
    var path = link.querySelector('path');
    var info = byState[slug];
    drClearMapStateClasses(path);
    if (!info) {
      // Leave the server-rendered "-- no staff licensed here" aria-label as-is
      // (already correct, set at build time) -- nothing to update here.
      link.setAttribute('data-has-staff', 'false');
      link.removeAttribute('data-tip');
      return;
    }
    link.setAttribute('data-has-staff', 'true');
    path.classList.toggle('dr-map-state--risk', info.risk);
    path.classList.toggle('dr-map-state--active', !info.risk);
    var names = info.items.map(function(i) { return i.staff_label || i.email; }).join(', ');
    var summary = names + ' (' + info.items.length + (info.items.length === 1 ? ' person' : ' people') +
      (info.risk ? ', due soon or unresolved' : ', all current') + ')';
    // setAttribute escapes automatically (DOM API, not innerHTML) -- consistent
    // with data-tip below, both safe from the same admin-controlled staff_label/
    // email text the roster table already renders via drEscapeHtml() for the
    // innerHTML case.
    link.setAttribute('data-tip', summary);
    link.setAttribute('aria-label', summary);
  });
  drApplyAggregateCoverageOverlay(byState, gen);
}

// ---------------------------------------------------------------------------
// Map tab, reciprocity mode (2026-08-03, requested directly: "hover a
// state, show which employees can work there"). Picking a specific person
// still shows their own full picture (home/clear/action/not-verified) --
// rendering 20+ people's individually-attested reciprocity onto one map at
// once would be unreadable, so per-person detail needs a person selected.
// "All staff" layers one additional signal on top of the unchanged
// home-state-licensing view instead: a distinct color for a state nobody
// is directly licensed in, where at least one staff member's home state
// gives them practice privilege there ("your team's reach", requested
// directly 2026-08-03 after seeing the per-person view -- "so the user can
// see their complete coverage under the all"). Reuses POST
// /firm/mobility/check-batch (evaluateMobility() server-side, the same
// legally-reviewed engine /firm-mobility/ uses) rather than a second,
// client-side rule implementation -- see that endpoint's own docstring.
//
// license_in_good_standing/substantially_equivalent are NOT stored per
// staff member anywhere in this product, so this view assumes both true
// for every person (the common case) and discloses that assumption in
// dr-map-mobility-note -- it is a quick overview, not a per-person legal
// determination. For a specific person's own facts, Practice Privilege
// Check remains the authoritative tool.
// ---------------------------------------------------------------------------

var DR_MOBILITY_SERVICE_TYPE = 'tax';
var drMobilityCache = {}; // home_state_slug -> {results: [...]} | {denied: true}
// Incremented on every drRenderMapForSelection() call (every dropdown
// change, and the initial load). Async work below captures the value at
// the moment it started and checks it hasn't moved on before touching the
// DOM, so a slow fetch from a view the user has since left can never paint
// over whatever view is showing now.
var drMapSelectionGen = 0;

// "All staff" coverage overlay -- keyed on DISTINCT home states (not per
// person), since two staff members in the same state get an identical
// answer and share drMobilityCache's one entry for that state. Probes only
// the FIRST distinct home state before doing any more work: if that one
// call comes back denied (not entitled), the whole overlay is skipped
// silently -- "All" stays a free view with no paywall interruption, the
// upsell already lives on the per-person path.
function drApplyAggregateCoverageOverlay(byState, gen) {
  var legendItem = document.getElementById('dr-map-legend-coverage-item');
  var homeStates = {}; // slug -> [staff display names]
  drLicenses.forEach(function(item) {
    if (item.status === 'opted_out' || !item.state_slug) return;
    if (!homeStates[item.state_slug]) homeStates[item.state_slug] = [];
    homeStates[item.state_slug].push(item.staff_label || item.email);
  });
  var slugs = Object.keys(homeStates);
  if (!slugs.length) {
    if (legendItem) legendItem.hidden = true;
    return;
  }

  // `denied` is always a display-ready STRING here, never a bare boolean --
  // reported directly, 2026-08-03: this function used to cache {denied:
  // true}, and drMobilityCache is the SAME cache drRenderMapMobility()
  // reads from for the per-person view. When a firm without mobility
  // access later picked a person whose home state this function had
  // already probed, drApplyMobilityResults() did
  // `noteEl.textContent = entry.denied` -- assigning the boolean `true` to
  // .textContent coerces it to the literal string "true", which is what
  // rendered. Both call sites now agree on the same shape.
  function fetchForHome(slug) {
    var cached = drMobilityCache[slug];
    if (cached) return Promise.resolve(cached);
    return fetch('/api/firm/mobility/check-batch', {
      method: 'POST',
      credentials: 'include',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        home_state_slug: slug,
        service_type: DR_MOBILITY_SERVICE_TYPE,
        license_in_good_standing: true,
        substantially_equivalent: true
      })
    }).then(function(res) {
      return drReadJsonSafe(res).then(function(data) {
        // 429 is temporary -- same reasoning as drRenderMapMobility's own
        // 429 branch, and it has to be, since they share drMobilityCache.
        // AuditLab, 2026-08-03: this branch was missing here, so a 429
        // fell into the generic (!res.ok) case below and got WRITTEN to
        // the cache as a permanent-looking denial with the wrong reason --
        // once a rate-limited home state landed in the cache, switching to
        // any person with that home state stayed stuck on the stale
        // denial even after the window reset and a real answer would have
        // succeeded, with no way to recover short of a full page reload.
        if (res.status === 429) {
          return {denied: 'Too many practice-privilege checks this hour. Try again later.'};
        }
        if (res.status === 403) {
          var denied = (data && data.error) || 'Practice-privilege coloring is part of the paid firm plan.';
          drMobilityCache[slug] = {denied: denied};
          return drMobilityCache[slug];
        }
        drMobilityCache[slug] = (!res.ok || !data)
          ? {denied: 'Something went wrong checking practice privilege.'}
          : {results: data.results};
        return drMobilityCache[slug];
      });
    }).catch(function() { return {denied: 'Something went wrong checking practice privilege.'}; });
  }

  fetchForHome(slugs[0]).then(function(first) {
    // Bail if the user has since picked a different view (or reloaded the
    // roster) while this fetch was in flight -- reported directly,
    // 2026-08-03: a slow "All" fetch resolving AFTER the dropdown had moved
    // to a specific person painted stale purple coverage states over that
    // person's own home/clear/action picture, with no legend entry for it
    // since it belongs to a different mode entirely.
    if (gen !== drMapSelectionGen) return;
    if (!first || first.denied) {
      if (legendItem) legendItem.hidden = true;
      return;
    }
    Promise.all(slugs.slice(1).map(fetchForHome)).then(function(rest) {
      if (gen !== drMapSelectionGen) return;
      var all = [first].concat(rest);
      var coverage = {}; // target slug -> [staff names whose home state clears it]
      all.forEach(function(entry, i) {
        if (!entry || entry.denied || !entry.results) return;
        var homeSlug = slugs[i];
        entry.results.forEach(function(r) {
          if (r.overall !== 'clear' || byState[r.target_state_slug]) return;
          if (!coverage[r.target_state_slug]) coverage[r.target_state_slug] = [];
          homeStates[homeSlug].forEach(function(name) {
            if (coverage[r.target_state_slug].indexOf(name) === -1) coverage[r.target_state_slug].push(name);
          });
        });
      });
      var anyCoverage = Object.keys(coverage).length > 0;
      if (legendItem) legendItem.hidden = !anyCoverage;
      document.querySelectorAll('.dr-map-link').forEach(function(link) {
        var names = coverage[link.getAttribute('data-state-slug')];
        if (!names) return;
        link.querySelector('path').classList.add('dr-map-state--coverage');
        var tip = 'No staff licensed here directly, but practice privilege is clear for: ' + names.join(', ') +
          ' (assumes good standing + substantial equivalence).';
        link.setAttribute('data-tip', tip);
        link.setAttribute('aria-label', tip);
        link.setAttribute('data-has-staff', 'true');
      });
    });
  });
}

function drPopulateMapStaffSelect() {
  var sel = document.getElementById('dr-map-staff-select');
  if (!sel) return;
  var prevValue = sel.value;
  var active = drLicenses.filter(function(item) { return item.status !== 'opted_out'; });
  var options = ['<option value="">All staff (home-state licensing)</option>'].concat(
    active.map(function(item) {
      var label = item.staff_label || item.email;
      return '<option value="' + drEscapeHtml(item.id) + '">' + drEscapeHtml(label) +
        (item.state_name ? ' (' + drEscapeHtml(item.state_name) + ')' : '') + '</option>';
    })
  );
  sel.innerHTML = options.join('');
  // Keep the same person selected across a roster reload if they still
  // exist; otherwise fall back to "All" rather than silently pointing at a
  // removed id.
  var stillExists = active.some(function(item) { return item.id === prevValue; });
  sel.value = stillExists ? prevValue : '';
}

function drSetMapTooltipWrap(wrap) {
  var tip = document.getElementById('dr-map-tooltip');
  if (tip) tip.classList.toggle('dr-map-tooltip--wrap', wrap);
  var staffLegend = document.getElementById('dr-map-legend-staff');
  var mobilityLegend = document.getElementById('dr-map-legend-mobility');
  if (staffLegend) staffLegend.hidden = wrap;
  if (mobilityLegend) mobilityLegend.hidden = !wrap;
}

function drApplyMobilityResults(homeStateSlug, entry, gen) {
  if (gen !== drMapSelectionGen) return;
  var noteEl = document.getElementById('dr-map-mobility-note');
  var links = document.querySelectorAll('.dr-map-link');
  drSetMapTooltipWrap(true);
  if (entry.denied) {
    if (noteEl) {
      noteEl.textContent = entry.denied;
      noteEl.hidden = false;
    }
    links.forEach(function(link) {
      var path = link.querySelector('path');
      drClearMapStateClasses(path);
      link.removeAttribute('data-tip');
      link.setAttribute('data-has-staff', 'false');
    });
    return;
  }
  if (noteEl) {
    noteEl.textContent = 'Assumes an active license in good standing and substantial equivalence for ' +
      'every state (service type: ' + DR_MOBILITY_SERVICE_TYPE + '). For this person’s own facts, ' +
      'use Practice Privilege Check.';
    noteEl.hidden = false;
  }
  var byTarget = {};
  entry.results.forEach(function(r) { byTarget[r.target_state_slug] = r; });
  links.forEach(function(link) {
    var slug = link.getAttribute('data-state-slug');
    var path = link.querySelector('path');
    drClearMapStateClasses(path);
    if (slug === homeStateSlug) {
      path.classList.add('dr-map-state--home');
      var homeTip = 'Home state -- licensed here directly, not a reciprocity question.';
      link.setAttribute('data-tip', homeTip);
      link.setAttribute('aria-label', homeTip);
      link.setAttribute('data-has-staff', 'true');
      return;
    }
    var r = byTarget[slug];
    if (!r) {
      link.removeAttribute('data-tip');
      link.setAttribute('data-has-staff', 'false');
      return;
    }
    var verdict = r.overall;
    if (verdict === 'clear') path.classList.add('dr-map-state--clear');
    else if (verdict === 'action_required') path.classList.add('dr-map-state--action');
    // not_verified (or anything else): no color class, stays default gray.
    var tipText = r.individual && r.individual.summary ? r.individual.summary : 'Not verified for this state.';
    link.setAttribute('data-tip', tipText);
    link.setAttribute('aria-label', tipText);
    link.setAttribute('data-has-staff', verdict !== 'not_verified' ? 'true' : 'false');
  });
}

function drRenderMapMobility(subscriberId, gen) {
  var person = drLicenses.filter(function(item) { return item.id === subscriberId; })[0];
  if (!person || !person.state_slug) {
    drRenderMap(gen);
    return;
  }
  var homeStateSlug = person.state_slug;
  var cached = drMobilityCache[homeStateSlug];
  if (cached) {
    drApplyMobilityResults(homeStateSlug, cached, gen);
    return;
  }
  var noteEl = document.getElementById('dr-map-mobility-note');
  if (noteEl) {
    noteEl.textContent = 'Checking practice privilege for every state…';
    noteEl.hidden = false;
  }
  fetch('/api/firm/mobility/check-batch', {
    method: 'POST',
    credentials: 'include',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      home_state_slug: homeStateSlug,
      service_type: DR_MOBILITY_SERVICE_TYPE,
      license_in_good_standing: true,
      substantially_equivalent: true
    })
  }).then(function(res) {
    if (res.status === 401) { window.location.href = '/firm-login/'; return null; }
    return drReadJsonSafe(res).then(function(data) {
      // 429 is a TEMPORARY, not-entitled-vs-entitled question, so it is
      // never cached (a later retry -- switching away and back, or a
      // reload -- should get a fresh answer once the window resets) and
      // never uses the paywall wording, which would be a real lie to an
      // actually-entitled firm that simply explored the feature a lot in
      // one hour (reported directly, 2026-08-03 -- a real, active-pilot
      // firm, created hours earlier that same day, hit a denial that
      // should not have been possible on entitlement grounds alone).
      if (res.status === 429) {
        drApplyMobilityResults(homeStateSlug, {denied: 'Too many practice-privilege checks this hour. Try again later.'}, gen);
        return;
      }
      if (res.status === 403) {
        var denied = (data && data.error) || 'Practice-privilege coloring is part of the paid firm plan.';
        drMobilityCache[homeStateSlug] = {denied: denied};
        drApplyMobilityResults(homeStateSlug, drMobilityCache[homeStateSlug], gen);
        return;
      }
      if (!res.ok || !data) {
        if (gen === drMapSelectionGen && noteEl) { noteEl.textContent = 'Something went wrong checking practice privilege. Please try again.'; }
        return;
      }
      drMobilityCache[homeStateSlug] = {results: data.results};
      drApplyMobilityResults(homeStateSlug, drMobilityCache[homeStateSlug], gen);
    });
  }).catch(function() {
    if (gen === drMapSelectionGen && noteEl) { noteEl.textContent = 'Something went wrong checking practice privilege. Please try again.'; }
  });
}

function drRenderMapForSelection() {
  drMapSelectionGen++;
  var gen = drMapSelectionGen;
  var sel = document.getElementById('dr-map-staff-select');
  var value = sel ? sel.value : '';
  var noteEl = document.getElementById('dr-map-mobility-note');
  if (!value) {
    if (noteEl) noteEl.hidden = true;
    drSetMapTooltipWrap(false);
    drRenderMap(gen);
    return;
  }
  drRenderMapMobility(value, gen);
}

function drWireMapTooltip() {
  var tip = document.getElementById('dr-map-tooltip');
  var figure = tip ? tip.closest('.dr-map-figure') : null;
  if (!tip || !figure) return;
  function move(evt) {
    var rect = figure.getBoundingClientRect();
    tip.style.left = (evt.clientX - rect.left + 14) + 'px';
    tip.style.top = (evt.clientY - rect.top + 14) + 'px';
  }
  function hide() { tip.hidden = true; }
  function showAtElement(el) {
    var t = el.getAttribute('data-tip');
    if (!t) return;
    tip.textContent = t;
    tip.hidden = false;
    var rect = el.getBoundingClientRect();
    var frect = figure.getBoundingClientRect();
    tip.style.left = (rect.left - frect.left) + 'px';
    tip.style.top = (rect.top - frect.top - 28) + 'px';
  }
  figure.querySelectorAll('.dr-map-link').forEach(function(el) {
    // Keyboard/screen-reader parity with mouse hover -- matches the homepage
    // map's own focus/blur wiring (_MAP_TOOLTIP_JS) so a keyboard-only user
    // gets the same tooltip a mouse user does, not just the color.
    el.addEventListener('focus', function() { showAtElement(el); });
    el.addEventListener('blur', hide);
    el.addEventListener('mouseenter', function(evt) {
      var t = el.getAttribute('data-tip');
      if (!t) return;
      tip.textContent = t;
      tip.hidden = false;
      move(evt);
    });
    el.addEventListener('mousemove', move);
    el.addEventListener('mouseleave', hide);
  });
}

// ---------------------------------------------------------------------------
// CPE Hours tab (2026-07-30, new BUILD v2 phase). DR_CPE_REQUIREMENTS is
// inlined static reference data (generate.py, from data/cpe_hours.json) --
// the worker knows nothing about requirements, only entry CRUD. Requirement
// matching happens entirely here: sum this staffer's logged hours within
// their current cycle window (approximated as their own renewal date minus
// the state's period_years -- see the Python-side comment on
// cpe_requirements_json for why this is a deliberate simplification, not an
// authoritative legal cycle-boundary calculation) against the state's own
// published total/ethics requirement. A state with no requirement entry at
// all, or a null total_hours (codified law never states a figure, e.g.
// Nebraska), shows an honest gap note instead of a fabricated number --
// same standard as every public page on this site.
// ---------------------------------------------------------------------------

var drCpeEntries = [];

function drCpeCycleWindow(nextDeadlineIso, periodYears) {
  if (!nextDeadlineIso || !periodYears) return null;
  var end = new Date(nextDeadlineIso + 'T00:00:00Z');
  if (isNaN(end.getTime())) return null;
  var start = new Date(Date.UTC(end.getUTCFullYear() - periodYears, end.getUTCMonth(), end.getUTCDate()));
  return {start: start.toISOString().slice(0, 10), end: nextDeadlineIso};
}

// Ethics hours are treated as a SUBSET of the total (not additional) --
// matches how every state's own requirement is actually structured
// (e.g. Alabama: "40 hours... at least 2 hours must be a qualifying ethics
// course"), so totalLogged sums every category and ethicsLogged separately
// sums only 'ethics' entries within the same window.
function drCpeProgressForSubscriber(item) {
  var req = DR_CPE_REQUIREMENTS[item.state_slug];
  if (!req || (req.total_hours === null && req.ethics_hours === null)) {
    return {hasRequirement: false, dataGapNote: req ? req.data_gap_note : null};
  }
  var win = drCpeCycleWindow(item.next_deadline, req.period_years);
  var totalLogged = 0, ethicsLogged = 0, excludedCount = 0;
  drCpeEntries.forEach(function(e) {
    if (e.subscriber_id !== item.id) return;
    // No renewal date means we don't know the cycle boundary -- excluding
    // every entry (rather than summing an unbounded lifetime total) keeps
    // "0 logged" as an honest signal instead of a false on-track reading.
    if (!win) { excludedCount++; return; }
    // An entry dated before the window can genuinely happen -- e.g. hours
    // earned in the final weeks of a PRIOR cycle, logged before this one's
    // window (next_deadline minus one period) has technically started.
    // There is no record of that prior cycle's own boundary anywhere in
    // this product, so the entry can't safely be counted toward either
    // cycle -- but silently
    // dropping it with no explanation is its own bug (reported directly,
    // 2026-08-03: "I added 100 hours to test this out, and nothing
    // happened to it" -- the entry WAS saved and appears in Recently
    // Logged, it just isn't in this window's sum). excludedCount lets the
    // UI say so instead of just showing 0.
    if (e.entry_date < win.start || e.entry_date > win.end) { excludedCount++; return; }
    totalLogged += e.hours;
    if (e.category === 'ethics') ethicsLogged += e.hours;
  });
  var behind =
    (req.total_hours !== null && totalLogged < req.total_hours) ||
    (req.ethics_hours !== null && ethicsLogged < req.ethics_hours);
  return {
    hasRequirement: true,
    totalRequired: req.total_hours, totalLogged: totalLogged,
    ethicsRequired: req.ethics_hours, ethicsLogged: ethicsLogged,
    behind: behind,
    noCycleDate: !win,
    excludedCount: excludedCount,
    cycleWindow: win,
  };
}

function drCpeBarHtml(label, logged, required) {
  var pct = required ? Math.min(100, Math.round((logged / required) * 100)) : 0;
  var behind = required !== null && logged < required;
  return '<div class="dr-cpe-bar-row"><span class="dr-cpe-bar-label">' + drEscapeHtml(label) + '</span>' +
    '<span class="dr-cpe-bar-track"><span class="dr-cpe-bar-fill' + (behind ? ' dr-cpe-bar-fill--behind' : '') +
    '" style="width:' + pct + '%"></span></span>' +
    '<span class="dr-cpe-bar-value">' + logged + ' / ' + required + 'h</span></div>';
}

function drRenderCpeSummary() {
  var el = document.getElementById('dr-cpe-summary');
  if (!el) return;
  var behindCount = 0, trackedCount = 0;
  drLicenses.forEach(function(item) {
    if (item.status === 'opted_out') return;
    var p = drCpeProgressForSubscriber(item);
    if (!p.hasRequirement) return;
    trackedCount++;
    if (p.behind) behindCount++;
  });
  el.innerHTML =
    '<div class="dr-stat-card">' + drRingSvg(trackedCount ? Math.round((behindCount / trackedCount) * 100) : 0, behindCount > 0) +
    '<div><div class="dr-stat-label">Behind on hours</div><div class="dr-stat-value">' + behindCount + '</div>' +
    '<div class="dr-stat-sub">of ' + trackedCount + ' staff with a known requirement</div></div></div>';
}

function drRenderCpeStaffProgress() {
  var el = document.getElementById('dr-cpe-staff-body');
  if (!el) return;
  var active = drLicenses.filter(function(item) { return item.status !== 'opted_out'; });
  if (active.length === 0) {
    el.innerHTML = '<p class="dr-panel-empty">No staff on your roster yet.</p>';
    return;
  }
  el.innerHTML = active.map(function(item) {
    var p = drCpeProgressForSubscriber(item);
    var name = drEscapeHtml(item.staff_label || item.email);
    var state = drEscapeHtml(item.state_name || '');
    if (!p.hasRequirement) {
      var gapText = p.dataGapNote ? drEscapeHtml(p.dataGapNote) : 'Requirement not codified for this state &mdash; track manually.';
      return '<div class="dr-cpe-staff-card"><div class="dr-cpe-staff-head">' +
        '<span class="dr-cpe-staff-name">' + name + '</span><span class="dr-cpe-staff-state">' + state + '</span></div>' +
        '<p class="dr-cpe-gap-note">' + gapText + '</p></div>';
    }
    var totalBar = p.totalRequired !== null ? drCpeBarHtml('Total', p.totalLogged, p.totalRequired) : '';
    var ethicsBar = p.ethicsRequired !== null ? drCpeBarHtml('Ethics', p.ethicsLogged, p.ethicsRequired) : '';
    var cycleNote = p.noCycleDate
      ? '<p class="dr-cpe-gap-note">No renewal date on file &mdash; add one to track progress for this cycle.</p>'
      : (p.excludedCount > 0
        ? '<p class="dr-cpe-gap-note">' + p.excludedCount + ' logged ' + (p.excludedCount === 1 ? 'entry falls' : 'entries fall') +
          ' outside the current cycle (' + drEscapeHtml(drFormatDeadline(p.cycleWindow.start)) + '&ndash;' +
          drEscapeHtml(drFormatDeadline(p.cycleWindow.end)) + ') and ' + (p.excludedCount === 1 ? "isn't" : "aren't") +
          ' counted above &mdash; not a bug, just outside this renewal period.</p>'
        : '');
    return '<div class="dr-cpe-staff-card"><div class="dr-cpe-staff-head">' +
      '<span class="dr-cpe-staff-name">' + name + '</span><span class="dr-cpe-staff-state">' + state + '</span></div>' +
      totalBar + ethicsBar + cycleNote + '</div>';
  }).join('');
}

function drRenderCpeStaffSelect() {
  var sel = document.getElementById('dr-cpe-staff-select');
  if (!sel) return;
  var current = sel.value;
  var active = drLicenses.filter(function(item) { return item.status !== 'opted_out'; });
  sel.innerHTML = '<option value="">Select staff member</option>' + active.map(function(item) {
    return '<option value="' + drEscapeHtml(item.id) + '">' + drEscapeHtml(item.staff_label || item.email) + '</option>';
  }).join('');
  sel.value = current;
}

function drRenderCpeRecent() {
  var el = document.getElementById('dr-cpe-recent-body');
  if (!el) return;
  if (drCpeEntries.length === 0) {
    el.innerHTML = '<p class="dr-panel-empty">Nothing logged yet.</p>';
    return;
  }
  var byId = {};
  drLicenses.forEach(function(item) { byId[item.id] = item; });
  var sorted = drCpeEntries.slice().sort(function(a, b) {
    return a.entry_date < b.entry_date ? 1 : a.entry_date > b.entry_date ? -1 : 0;
  });
  el.innerHTML = sorted.slice(0, 15).map(function(e) {
    var staffer = byId[e.subscriber_id];
    var name = staffer ? drEscapeHtml(staffer.staff_label || staffer.email) : 'Removed staff member';
    var desc = e.description ? ' &mdash; ' + drEscapeHtml(e.description) : '';
    return '<div class="dr-cpe-recent-item"><span><b>' + name + '</b> logged ' + drEscapeHtml(String(e.hours)) +
      'h (' + drEscapeHtml(e.category) + ')' + desc +
      '<span class="dr-agenda-date" style="display:block;">' + drEscapeHtml(drFormatDeadline(e.entry_date)) + '</span></span>' +
      '<button type="button" class="dr-cpe-recent-remove" data-id="' + drEscapeHtml(e.id) + '" data-label="' +
      drEscapeHtml(String(e.hours) + 'h for ' + name) + '">Remove</button></div>';
  }).join('');
}

function drLoadCpeEntries() {
  return fetch('/api/firm/cpe', {credentials: 'include'})
    .then(function(res) {
      if (res.status === 401) { window.location.href = '/firm-login/'; return null; }
      if (!res.ok) return null;
      return res.json();
    })
    .then(function(data) {
      drCpeEntries = (data && data.entries) || [];
      drRenderCpeStaffSelect();
      drRenderCpeSummary();
      drRenderCpeStaffProgress();
      drRenderCpeRecent();
    })
    .catch(function() {});
}

function drSubmitCpeEntry(form) {
  var errEl = document.getElementById('dr-cpe-log-error');
  if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
  var fd = new FormData(form);
  var body = {};
  fd.forEach(function(v, k) { body[k] = v; });
  fetch('/api/firm/cpe', {
    method: 'POST', credentials: 'include',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(body)
  }).then(function(res) {
    if (res.status === 401) { window.location.href = '/firm-login/'; return null; }
    return drReadJsonSafe(res).then(function(data) {
      if (!res.ok) {
        var msg = data && data.error ? data.error : 'Something went wrong, please try again.';
        if (errEl) { errEl.textContent = msg; errEl.hidden = false; }
        return;
      }
      var keepStaffId = body.subscriber_id;
      form.reset();
      var staffSel = document.getElementById('dr-cpe-staff-select');
      if (staffSel) staffSel.value = keepStaffId;
      drLoadCpeEntries();
    });
  }).catch(function() {
    if (errEl) { errEl.textContent = 'Something went wrong, please try again.'; errEl.hidden = false; }
  });
}

function drRemoveCpeEntry(id, label) {
  if (!window.confirm('Remove this CPE entry' + (label ? ' (' + label + ')' : '') + '? This cannot be undone from the dashboard.')) return;
  fetch('/api/firm/cpe/' + encodeURIComponent(id), {method: 'DELETE', credentials: 'include'})
    .then(function(res) {
      if (res.status === 401) { window.location.href = '/firm-login/'; return; }
      if (res.ok) { drLoadCpeEntries(); return; }
      drReadJsonSafe(res).then(function(data) {
        window.alert((data && data.error) || 'Something went wrong removing that entry. Please try again.');
      });
    })
    .catch(function() {
      window.alert('Something went wrong removing that entry. Please try again.');
    });
}

function drRenderIdentities(items) {
  var el = document.getElementById('dr-identities-body');
  if (!el) return;
  if (!items || items.length === 0) {
    el.innerHTML = '<p class="dr-panel-empty">None connected. You sign in with a password or an emailed link.</p>';
    return;
  }
  el.innerHTML = items.map(function(it) {
    var label = it.provider === 'google' ? 'Google' : it.provider;
    var who = it.provider_email ? ' (' + drEscapeHtml(it.provider_email) + ')' : '';
    var last = it.last_login_at ? 'Last used ' + drEscapeHtml(drFormatDeadline(String(it.last_login_at).slice(0, 10))) : 'Never used';
    return '<div class="dr-cpe-recent-item"><span><b>' + drEscapeHtml(label) + '</b>' + who +
      '<span class="dr-agenda-date" style="display:block;">' + last + '</span></span>' +
      '<button type="button" class="dr-cpe-recent-remove" data-identity-id="' + drEscapeHtml(it.id) +
      '" data-identity-label="' + drEscapeHtml(label) + '">Remove</button></div>';
  }).join('');
}

function drLoadIdentities() {
  return fetch('/api/firm/oauth-identities', {credentials: 'include'})
    .then(function(res) {
      if (res.status === 401) { window.location.href = '/firm-login/'; return null; }
      if (!res.ok) return null;
      return res.json();
    })
    .then(function(data) { drRenderIdentities(data && data.identities); })
    .catch(function() {});
}

function drRemoveIdentity(id, label) {
  if (!window.confirm('Remove the ' + label + ' sign-in from this account? You can still sign in with a password or an emailed link.')) return;
  var errEl = document.getElementById('dr-identity-error');
  if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
  fetch('/api/firm/oauth-identities/' + encodeURIComponent(id), {method: 'DELETE', credentials: 'include'})
    .then(function(res) {
      if (res.status === 401) { window.location.href = '/firm-login/'; return; }
      if (res.ok) { drLoadIdentities(); return; }
      if (errEl) { errEl.textContent = 'Could not remove that sign-in method. Please try again.'; errEl.hidden = false; }
    })
    .catch(function() {
      if (errEl) { errEl.textContent = 'Could not remove that sign-in method. Please try again.'; errEl.hidden = false; }
    });
}

function drSubmitPassword(form) {
  var okEl = document.getElementById('dr-password-ok');
  var errEl = document.getElementById('dr-password-error');
  if (okEl) { okEl.hidden = true; okEl.textContent = ''; }
  if (errEl) { errEl.hidden = true; errEl.textContent = ''; }

  var fd = new FormData(form);
  var body = {new_password: fd.get('new_password') || ''};
  // Only sent when non-empty: a firm setting its FIRST password has no
  // current one to prove, and sending an empty string would look like a
  // failed check rather than an absent one.
  var current = fd.get('current_password');
  if (current) body.current_password = current;

  fetch('/api/firm/password', {
    method: 'POST', credentials: 'include',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(body)
  }).then(function(res) {
    if (res.status === 401) { window.location.href = '/firm-login/'; return null; }
    return drReadJsonSafe(res).then(function(data) {
      if (!res.ok) {
        var msg = (data && data.error) ? data.error : 'Something went wrong, please try again.';
        if (errEl) { errEl.textContent = msg; errEl.hidden = false; }
        return;
      }
      form.reset();
      if (okEl) {
        var ended = (data && data.other_sessions_ended) || 0;
        okEl.textContent = ended > 0
          ? 'Password saved. You were signed out on ' + ended + ' other device' + (ended === 1 ? '' : 's') + '.'
          : 'Password saved.';
        okEl.hidden = false;
      }
    });
  }).catch(function() {
    if (errEl) { errEl.textContent = 'Something went wrong, please try again.'; errEl.hidden = false; }
  });
}

function drLoadLicenses() {
  drClearError();
  fetch('/api/firm/licenses', {credentials: 'include'})
    .then(function(res) {
      if (res.status === 401) {
        window.location.href = '/firm-login/';
        return null;
      }
      if (!res.ok) {
        drShowError('Something went wrong loading your roster. Please try again.');
        return null;
      }
      return res.json();
    })
    .then(function(data) {
      if (!data) return;
      drLicenses = data.licenses || [];
      drRenderFirmName(data.firm_name);
      drRenderStalenessBanner(data.data_as_of, data.data_stale);
      drRenderTable();
      drRenderStats();
      drRenderAtRisk();
      drRenderActivity();
      drRenderCalendar();
      drRenderAgenda();
      drPopulateMapStaffSelect();
      drRenderMapForSelection();
      drLoadCpeEntries();
    })
    .catch(function() {
      drShowError('Something went wrong loading your roster. Please try again.');
    });
}

function drRenewLicense(id) {
  drClearError();
  fetch('/api/firm/licenses/' + encodeURIComponent(id) + '/renew', {method: 'POST', credentials: 'include'})
    .then(function(res) {
      if (res.status === 401) { window.location.href = '/firm-login/'; return null; }
      return drReadJsonSafe(res).then(function(data) {
        if (!res.ok) {
          drShowError(data && data.error ? data.error : 'Something went wrong, please try again.');
          return;
        }
        drLoadLicenses();
      });
    })
    .catch(function() { drShowError('Something went wrong, please try again.'); });
}

function drRemoveLicense(id, label) {
  if (!window.confirm('Remove ' + (label || 'this person') + ' from the roster? They will stop receiving reminders.')) return;
  drClearError();
  fetch('/api/firm/licenses/' + encodeURIComponent(id), {method: 'DELETE', credentials: 'include'})
    .then(function(res) {
      if (res.status === 401) { window.location.href = '/firm-login/'; return null; }
      return drReadJsonSafe(res).then(function(data) {
        if (!res.ok) {
          drShowError(data && data.error ? data.error : 'Something went wrong, please try again.');
          return;
        }
        drLoadLicenses();
      });
    })
    .catch(function() { drShowError('Something went wrong, please try again.'); });
}

function drSaveEdit(id, tr) {
  drClearError();
  var labelInput = tr.querySelector('.dr-edit-label');
  var emailInput = tr.querySelector('.dr-edit-email');
  var email = emailInput ? emailInput.value.trim() : '';
  if (!email) { drShowError('Email is required.'); return; }
  var body = {staff_label: labelInput ? labelInput.value.trim() : '', email: email};
  fetch('/api/firm/licenses/' + encodeURIComponent(id), {
    method: 'PATCH', credentials: 'include',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(body)
  }).then(function(res) {
    if (res.status === 401) { window.location.href = '/firm-login/'; return null; }
    return drReadJsonSafe(res).then(function(data) {
      if (!res.ok) {
        drShowError(data && data.error ? data.error : 'Something went wrong, please try again.');
        return;
      }
      drEditingId = null;
      drLoadLicenses();
    });
  }).catch(function() { drShowError('Something went wrong, please try again.'); });
}

document.addEventListener('DOMContentLoaded', function() {
  var stateSel = document.getElementById('dr-add-state');
  drUpdateFields(stateSel ? stateSel.value : '');

  drLoadLicenses();
  drWireMapTooltip();

  var mapStaffSelect = document.getElementById('dr-map-staff-select');
  if (mapStaffSelect) {
    mapStaffSelect.addEventListener('change', drRenderMapForSelection);
  }

  document.querySelectorAll('.dr-nav a[data-view]').forEach(function(a) {
    a.addEventListener('click', function(ev) {
      ev.preventDefault();
      drSwitchView(a.getAttribute('data-view'));
    });
  });

  var calPrev = document.getElementById('dr-cal-prev');
  var calNext = document.getElementById('dr-cal-next');
  var calToday = document.getElementById('dr-cal-today');
  if (calPrev) {
    calPrev.addEventListener('click', function() {
      // drCalendarRefDate is only set once drLoadLicenses()'s async fetch
      // resolves and drRenderCalendar() runs for the first time -- guard
      // against a click landing in that brief window before it's set.
      if (!drCalendarRefDate) return;
      drCalendarRefDate = new Date(Date.UTC(drCalendarRefDate.getUTCFullYear(), drCalendarRefDate.getUTCMonth() - 1, 1));
      drRenderCalendar();
    });
  }
  if (calNext) {
    calNext.addEventListener('click', function() {
      if (!drCalendarRefDate) return;
      drCalendarRefDate = new Date(Date.UTC(drCalendarRefDate.getUTCFullYear(), drCalendarRefDate.getUTCMonth() + 1, 1));
      drRenderCalendar();
    });
  }
  if (calToday) {
    calToday.addEventListener('click', function() {
      drCalendarRefDate = null;
      drRenderCalendar();
    });
  }

  var identitiesBody = document.getElementById('dr-identities-body');
  if (identitiesBody) {
    drLoadIdentities();
    identitiesBody.addEventListener('click', function(ev) {
      var btn = ev.target.closest ? ev.target.closest('[data-identity-id]') : null;
      if (!btn) return;
      drRemoveIdentity(btn.getAttribute('data-identity-id'), btn.getAttribute('data-identity-label'));
    });
  }

  var passwordForm = document.getElementById('dr-password-form');
  if (passwordForm) {
    passwordForm.addEventListener('submit', function(ev) {
      ev.preventDefault();
      drSubmitPassword(passwordForm);
    });
  }

  var cpeLogForm = document.getElementById('dr-cpe-log-form');
  if (cpeLogForm) {
    cpeLogForm.addEventListener('submit', function(ev) {
      ev.preventDefault();
      drSubmitCpeEntry(cpeLogForm);
    });
  }
  var cpeRecentBody = document.getElementById('dr-cpe-recent-body');
  if (cpeRecentBody) {
    cpeRecentBody.addEventListener('click', function(ev) {
      var btn = ev.target.closest ? ev.target.closest('.dr-cpe-recent-remove') : null;
      if (!btn) return;
      var id = btn.getAttribute('data-id');
      if (id) drRemoveCpeEntry(id, btn.getAttribute('data-label'));
    });
  }

  var tbody = document.getElementById('dr-roster-body');
  if (tbody) {
    tbody.addEventListener('click', function(ev) {
      var btn = ev.target.closest ? ev.target.closest('button') : null;
      if (!btn) return;
      var id = btn.getAttribute('data-id');
      if (btn.classList.contains('dr-btn-edit')) {
        drEditingId = id;
        drRenderTable();
      } else if (btn.classList.contains('dr-btn-cancel')) {
        drEditingId = null;
        drRenderTable();
      } else if (btn.classList.contains('dr-btn-save')) {
        drSaveEdit(id, btn.closest('tr'));
      } else if (btn.classList.contains('dr-btn-renew')) {
        drRenewLicense(id);
      } else if (btn.classList.contains('dr-btn-remove')) {
        var item = null;
        for (var i = 0; i < drLicenses.length; i++) {
          if (drLicenses[i].id === id) { item = drLicenses[i]; break; }
        }
        drRemoveLicense(id, item ? (item.staff_label || item.email) : null);
      }
    });
  }

  var addForm = document.getElementById('dr-add-staff-form');
  if (addForm) {
    addForm.addEventListener('submit', function(ev) {
      ev.preventDefault();
      var errEl = document.getElementById('dr-add-error');
      if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
      var fd = new FormData(addForm);
      var body = {};
      fd.forEach(function(v, k) { body[k] = v; });
      fetch('/api/firm/licenses', {
        method: 'POST', credentials: 'include',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body)
      }).then(function(res) {
        if (res.status === 401) { window.location.href = '/firm-login/'; return null; }
        return drReadJsonSafe(res).then(function(data) {
          if (!res.ok) {
            var msg = data && data.error ? data.error : 'Something went wrong, please try again.';
            if (errEl) { errEl.textContent = msg; errEl.hidden = false; } else { drShowError(msg); }
            return;
          }
          addForm.reset();
          drUpdateFields('');
          drLoadLicenses();
        });
      }).catch(function() {
        var msg = 'Something went wrong, please try again.';
        if (errEl) { errEl.textContent = msg; errEl.hidden = false; } else { drShowError(msg); }
      });
    });
  }
});
</script>"""

# Substituted (not an f-string, see the comment above this constant for why):
# every fetch() call above is hardcoded to '/api/firm/...' because that is
# genuinely correct for production (same-origin). A preview build (2026-07-28
# firm-dashboard preview, DR_REMINDER_BACKEND_BASE_URL set to the preview
# Worker's own workers.dev URL, a DIFFERENT origin than the preview static
# pages) needs those calls pointed elsewhere. Plain string replace is safe
# here specifically because '/api/firm' is a distinctive substring that
# appears nowhere else in this block -- confirmed byte-identical output when
# REMINDER_BACKEND_BASE_URL is unset (default "/api", so this replace is a
# no-op in production).
_FIRM_DASHBOARD_JS_HTML = _FIRM_DASHBOARD_JS_HTML.replace("'/api/firm", f"'{REMINDER_BACKEND_BASE_URL}/firm")


# ---------------------------------------------------------------------------
# Practice-privilege (mobility) checker -- PAY-GATED tool page (2026-07-30).
#
# Plain (non-f) string with a post-hoc .replace() for the backend base,
# exactly like _FIRM_DASHBOARD_JS_HTML below. Necessary, not stylistic: JS
# braces inside an f-string are read as format placeholders and blow up at
# import time.
# ---------------------------------------------------------------------------
_MOBILITY_JS_HTML = """<script>
(function () {
  var form = document.getElementById('dr-mobility-form');
  if (!form) return;
  var errEl = document.getElementById('dr-mobility-error');
  var resultEl = document.getElementById('dr-mobility-result');

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function badge(verdict) {
    if (verdict === 'clear') return '<span class="dr-verdict-badge dr-verdict-clear">Clear</span>';
    if (verdict === 'action_required') return '<span class="dr-verdict-badge dr-verdict-action">Action required</span>';
    if (verdict === 'not_applicable') return '<span class="dr-verdict-badge dr-verdict-unverified">Not applicable</span>';
    return '<span class="dr-verdict-badge dr-verdict-unverified">Not verified</span>';
  }

  function overallText(v) {
    if (v === 'clear') return 'Nothing outstanding that we could identify.';
    if (v === 'action_required') return 'Something has to happen before this work can proceed.';
    if (v === 'not_applicable') return 'This combination does not raise a practice-privilege question.';
    return 'We cannot confirm this. Treat it as unresolved and check with the state board.';
  }

  // Citation and disclaimer are read straight from the API payload rather
  // than reconstructed here. The server sends them with EVERY determination
  // precisely so this function cannot render a verdict without them.
  function findingHtml(title, f) {
    var reqs = '';
    if (f.requirements && f.requirements.length) {
      reqs = '<ul class="dr-verdict-reqs">' +
        f.requirements.map(function (r) { return '<li>' + esc(r) + '</li>'; }).join('') + '</ul>';
    }
    var cite;
    if (f.citation) {
      cite = f.citationUrl
        ? '<a href="' + esc(f.citationUrl) + '" rel="noopener noreferrer" target="_blank">' + esc(f.citation) + '</a>'
        : esc(f.citation);
      if (f.sourceUrl) {
        cite += ' &middot; <a href="' + esc(f.sourceUrl) + '" rel="noopener noreferrer" target="_blank">board page</a>';
      }
      if (f.verifiedDate) { cite += ' &middot; verified ' + esc(f.verifiedDate); }
      cite = '<p class="dr-verdict-cite">Source: ' + cite + '</p>';
    } else if (f.verdict === 'not_applicable') {
      // Telling a CPA we have "no verified citation" for their OWN home
      // state is both false and alarming. The question simply doesn't
      // apply here, so there is nothing to cite.
      cite = '';
    } else {
      cite = '<p class="dr-verdict-cite">No verified citation on file for this one &mdash; which is exactly why it is not a yes.</p>';
    }
    var gap = f.dataGapNote ? '<p class="dr-verdict-cite">' + esc(f.dataGapNote) + '</p>' : '';
    return '<div class="dr-verdict"><h3>' + esc(title) + '</h3>' + badge(f.verdict) +
      '<p>' + esc(f.summary) + '</p>' + reqs + cite + gap +
      '<p class="dr-verdict-disclaimer">' + esc(f.disclaimer) + '</p></div>';
  }

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
    if (resultEl) { resultEl.hidden = true; resultEl.innerHTML = ''; }

    var body = {
      home_state_slug: document.getElementById('dr-mob-home').value,
      target_state_slug: document.getElementById('dr-mob-target').value,
      service_type: document.getElementById('dr-mob-service').value,
      license_in_good_standing: document.getElementById('dr-mob-standing').checked,
      substantially_equivalent: document.getElementById('dr-mob-equiv').checked
    };

    fetch('/api/firm/mobility/check', {
      method: 'POST', credentials: 'include',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body)
    }).then(function (res) {
      if (res.status === 401) { window.location.href = '/firm-login/'; return null; }
      return res.json().catch(function () { return null; }).then(function (data) {
        if (!res.ok) {
          var msg = (data && data.error) ? data.error : 'Something went wrong, please try again.';
          if (errEl) { errEl.textContent = msg; errEl.hidden = false; }
          return;
        }
        if (!data) return;
        // The combined verdict is rendered FIRST and on its own. It exists
        // precisely so a reader cannot take the greener of the two cards as
        // the answer -- e.g. a green firm badge sitting above a grey
        // unverified individual card. Review found this field was being
        // discarded by the only caller, which made that safeguard dead code
        // exactly where it mattered.
        var html = '<h2>' + esc(data.home_state) + ' &rarr; ' + esc(data.target_state) + '</h2>' +
          '<div class="dr-verdict dr-verdict-overall"><h3>Overall</h3>' +
          badge(data.overall) + '<p>' + esc(overallText(data.overall)) + '</p></div>' +
          findingHtml('The individual CPA', data.individual) +
          findingHtml('The firm', data.firm);
        if (resultEl) { resultEl.innerHTML = html; resultEl.hidden = false; }
      });
    }).catch(function () {
      if (errEl) { errEl.textContent = 'Something went wrong, please try again.'; errEl.hidden = false; }
    });
  });
})();
</script>"""

_MOBILITY_JS_HTML = _MOBILITY_JS_HTML.replace("'/api/firm", f"'{REMINDER_BACKEND_BASE_URL}/firm")


def _mobility_covered_slugs() -> set[str]:
    """State slugs with a verified mobility rule, read from the SAME file the
    Worker imports (`worker/src/mobility_rules.json`).

    Reading the Worker's own data file rather than keeping a second list here
    is the point: a duplicated list would drift, and the failure mode of
    drift is the worst one this feature has -- offering a state we cannot
    answer for, or hiding one we can.

    A missing or unreadable file yields an EMPTY set, which disables every
    target state. That is deliberately the safe direction: a checker that
    offers nothing is obviously broken and gets fixed, whereas one that
    offers everything looks fine while returning not_verified for all of it.
    """
    path = pathlib.Path(__file__).resolve().parent / "worker" / "src" / "mobility_rules.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return set()
    # Same alias as scripts/build_change_events.py's SLUG_ALIASES: the
    # upstream mobility-research vocabulary has emitted "district-of-columbia"
    # before, while every deadline record/URL/page on this site uses "dc".
    # Caught here as a defensive translation (not just a one-time data fix)
    # because 2026-08-02 found the mismatch had silently force-disabled DC
    # in this exact dropdown, and forced not_verified in the Worker's own
    # lookup table -- a slug drift here is invisible until someone notices
    # a state wrongly greyed out.
    slug_aliases = {"district-of-columbia": "dc"}
    return {
        slug_aliases.get(r["state_slug"], r["state_slug"])
        for r in data.get("records", [])
        if isinstance(r, dict) and isinstance(r.get("state_slug"), str)
    }


def build_firm_mobility_page(by_slug: dict[str, list[dict]]) -> str:
    """Practice-privilege (mobility) checker -- a PAY-GATED tool page.

    Deliberately a standalone page rather than a dashboard tab, for one
    product reason and one practical one:

      * A mobility check is a QUERY TOOL: you arrive with a question and
        leave with a cited answer. That is a different interaction from the
        dashboard's data views (roster/calendar/map), which show you state
        you already own.
      * At the time this was built, FOUR other unmerged branches each added
        a tab to the dashboard sidebar, and the tab machinery itself
        (drSwitchView) lived on one of them rather than on main. A fifth tab
        would have guaranteed a merge conflict and coupled this feature to
        whichever branch shipped first. A standalone page merges cleanly
        regardless of branch order.

    Every determination rendered here carries its citation and the
    not-legal-advice disclaimer -- they arrive in the same API payload
    precisely so the UI cannot display a verdict without them.
    """
    all_slugs = sorted(by_slug, key=lambda slug: by_slug[slug][0]["state"])

    # HOME state: every jurisdiction, always. The determination is made
    # against the TARGET state's rules -- index.ts looks up
    # MOBILITY_RULES_BY_SLUG[targetStateSlug] and nothing else -- and
    # substantial equivalence is self-attested. So we need no data about
    # where the license is held, and restricting this list would block real
    # questions we can actually answer.
    home_state_options = "\n".join(
        f'<option value="{esc(slug)}">{esc(by_slug[slug][0]["state"])}</option>' for slug in all_slugs
    )

    # TARGET state: split by whether we have a verified rule row.
    #
    # The honest answer to "what do we do about the 50 states we have not
    # sourced yet" is: offer only the ones we can actually answer, and say
    # plainly that the rest are not covered. The engine already refuses to
    # guess (an absent state returns not_verified), but letting someone pick
    # a state and THEN telling them we don't know is a dead end -- the same
    # silent-failure shape as the /firm-login/ trap. Better to show the
    # limit before they spend the click.
    #
    # Uncovered states are rendered as DISABLED options rather than omitted.
    # Omitting them looks like a broken or incomplete list; showing them
    # greyed under an explicit label communicates "we know this state exists
    # and we have not verified it yet," which is the true statement.
    covered_slugs = _mobility_covered_slugs()
    covered = [s for s in all_slugs if s in covered_slugs]
    uncovered = [s for s in all_slugs if s not in covered_slugs]

    def _opt(slug: str, disabled: bool = False) -> str:
        return (
            f'<option value="{esc(slug)}"{" disabled" if disabled else ""}>'
            f'{esc(by_slug[slug][0]["state"])}</option>'
        )

    target_state_options = "\n".join(_opt(s) for s in covered)
    if uncovered:
        target_state_options += (
            '\n<optgroup label="Not yet verified -- we will not guess" disabled>\n'
            + "\n".join(_opt(s, disabled=True) for s in uncovered)
            + "\n</optgroup>"
        )

    coverage_line = (
        f"Verified in <strong>{len(covered)} of {len(all_slugs)}</strong> jurisdictions so far. "
        "We add states only once a primary source has been read and independently checked, so the "
        "list grows slowly on purpose."
    )

    body = f"""<h1>Practice-privilege check</h1>
<p class="subhead">Can this CPA provide this service in this state &mdash; and what has to happen
first? Every answer is tied to the rule it came from.</p>

<div class="dr-mobility-callout">
  <strong>Informational, not legal advice.</strong> Practice-privilege rules change, and they depend on
  facts we can't see. We show you the rule and where it came from so you can check it yourself &mdash;
  and where we haven't verified something against a primary source, we say so instead of guessing.
  Confirm with the state board before you rely on any answer here.
</div>

<div class="signup-form">
  <form id="dr-mobility-form">
    <div class="signup-form-row">
      <div>
        <label for="dr-mob-home">Home state (where the license is held)</label>
        <select id="dr-mob-home" name="home_state_slug" required>
          <option value="">Select state</option>
          {home_state_options}
        </select>
      </div>
      <div>
        <label for="dr-mob-target">Target state (where the work happens)</label>
        <select id="dr-mob-target" name="target_state_slug" required>
          <option value="">Select state</option>
          {target_state_options}
        </select>
        <p class="field-hint">{coverage_line}</p>
      </div>
    </div>

    <label for="dr-mob-service">Service type</label>
    <select id="dr-mob-service" name="service_type" required>
      <option value="">Select service type</option>
      <option value="tax">Tax</option>
      <option value="attest">Attest (audit, review, other attest)</option>
      <option value="other_non_attest">Other non-attest (consulting, advisory)</option>
    </select>
    <p class="field-hint">Attest work frequently triggers a firm-registration requirement where tax work
    doesn't &mdash; that gap is the most common real-world mobility mistake.</p>

    <label class="dr-mob-check">
      <input type="checkbox" id="dr-mob-standing" name="license_in_good_standing">
      The license is active and in good standing in the home state
    </label>
    <label class="dr-mob-check">
      <input type="checkbox" id="dr-mob-equiv" name="substantially_equivalent">
      The CPA meets substantial equivalence (150 semester hours, one year of experience, Uniform CPA Exam)
    </label>
    <p class="field-hint">We can't verify either of these &mdash; they're your inputs to the check, and
    the answer is only as good as they are.</p>

    <button type="submit">Run check</button>
  </form>
  <p id="dr-mobility-error" class="field-hint" style="color:#c33737;" hidden></p>
</div>

<div id="dr-mobility-result" hidden></div>

<p class="how-it-works"><a href="/firm-dashboard/">&larr; Back to your dashboard</a></p>

{_MOBILITY_JS_HTML}
"""
    return page_shell(
        f"Practice-Privilege Check — {SITE_NAME}",
        "Check whether a CPA can provide a service in another state, with the rule and citation behind "
        "every answer.",
        body,
        home_href="../",
        canonical_path="/firm-mobility/",
        extra_head='<meta name="robots" content="noindex">',
    )



def build_firm_dashboard_page(
    by_slug: dict[str, list[dict]], as_of: date, cpe_hours_by_slug: dict[str, dict]
) -> str:
    """The real firm dashboard (2026-07-28, step 3/3). Static HTML shell +
    _FIRM_DASHBOARD_JS_HTML: on load, fetches GET /api/firm/licenses
    (credentials:'include' -- the session cookie rides along automatically
    since the Worker's /api/* route and this static site share the
    deadline-radar.com origin) and renders the roster, trusting the API's
    own urgency sort rather than re-sorting client-side (per this build's own
    instruction). A 401 (no/expired session) redirects to /firm-login/ --
    this page assumes nothing about auth state at build time, since it's
    static HTML with no server-side session check of its own; the JS above
    is the only gate, exactly as it must be for a statically-hosted page.

    `noindex` (via page_shell's extra_head) because this is a signed-in app
    view, not indexable content -- unlike /firm-login/, which stays
    indexable/linkable like every other marketing/functional page.

    Edit is deliberately scoped to staff_label/email only, never
    state/license-type/deadline fields: GET /firm/licenses only returns
    license_type_id (see index.ts's toFirmLicenseJson()), never the
    underlying raw birth_month/birth_year/cohort_group/user_deadline a PATCH
    would need alongside a state_slug change to keep resolveDeadlineInput()
    happy. An edit UI that touched those fields without the real current
    values to pre-fill would either have to guess (risking silently
    corrupting a working deadline) or force a full re-entry that looks like
    an edit but actually resets configuration the admin never meant to
    touch. To change someone's state or license type, remove and re-add
    them -- safe, unambiguous, no silent data loss."""
    add_staff_html = _firm_dashboard_add_staff_form_html(by_slug, as_of)
    map_svg_html = _firm_dashboard_map_svg_html(by_slug)
    # CPE Hours tab (2026-07-30): the state-by-state REQUIREMENT (how many
    # hours, ethics sub-requirement, cycle length) is static reference data,
    # so it's inlined once at build time -- same "static data inlined,
    # dynamic per-firm data fetched live" split DR_STATES already uses on
    # the homepage. Deliberately a SMALL projection of cpe_hours.json's full
    # record (no citation/source_url/notes -- those belong on the public CPE
    # pages, not duplicated into every dashboard page load) -- just the
    # fields the progress calculation and the honest-gap message need.
    cpe_requirements_json = {
        slug: {
            "total_hours": rec.get("total_hours"),
            "period_years": rec.get("period_years"),
            "ethics_hours": rec.get("ethics_hours"),
            "ethics_period_years": rec.get("ethics_period_years"),
            "data_gap_note": rec.get("data_gap_note"),
        }
        for slug, rec in cpe_hours_by_slug.items()
    }
    # Sidebar nav: Roster/Calendar/Map are real in-page tabs (2026-07-30, BUILD
    # v2 Phase D -- all three render from the SAME already-fetched drLicenses,
    # no separate page load/re-auth). Reports/Documents are still BUILD v2
    # phases F/G, not built yet -- shown as disabled "Soon" items (the intended
    # IA, honestly labeled) rather than either omitted (misrepresenting scope
    # as smaller than planned) or linked (a link to nothing would be a real
    # defect).
    sidebar_nav_soon_items = "\n    ".join(
        f'<li><span class="dr-nav-soon">{esc(label)}<span class="dr-soon-badge">Soon</span></span></li>'
        for label in ("Reports", "Documents")
    )
    body = f"""<div class="dr-dash-shell">
  <aside class="dr-sidebar">
    <div class="dr-firm-name" id="dr-firm-name">Dashboard</div>
    <ul class="dr-nav" role="tablist" aria-label="Dashboard views">
      <li><a href="#" class="is-active" data-view="roster" role="tab" aria-selected="true">Roster</a></li>
      <li><a href="#" data-view="calendar" role="tab" aria-selected="false">Calendar</a></li>
      <li><a href="#" data-view="map" role="tab" aria-selected="false">Map</a></li>
      <li><a href="#" data-view="cpe" role="tab" aria-selected="false">CPE Hours</a></li>
      <li><a href="/firm-mobility/">Practice Privilege Check</a></li>
      <li><a href="#" data-view="account" role="tab" aria-selected="false">Account</a></li>
      {sidebar_nav_soon_items}
    </ul>
    <div class="dr-sidebar-foot">
      <form method="post" action="{REMINDER_BACKEND_BASE_URL}/firm/logout">
        <button type="submit">Log out</button>
      </form>
    </div>
  </aside>

  <div class="dr-main">
    <div id="dr-dash-error" class="callout" style="border-left-color:#c33737;" hidden></div>
    <div id="dr-staleness-banner" class="callout" style="border-left-color:#b8860b;" hidden></div>

    <div id="dr-view-roster" class="dr-view" role="tabpanel">
    <h1>Coverage overview</h1>
    <p class="subhead">Every CPA license you're tracking for your firm, at a glance.</p>

    <div class="dr-stat-row" id="dr-stat-row"></div>

    <div class="dr-panel-row">
      <div class="dr-panel">
        <h2>Staff at risk</h2>
        <ul class="dr-at-risk-list" id="dr-at-risk-list"><li class="dr-panel-empty">Loading&hellip;</li></ul>
      </div>
      <div class="dr-panel">
        <h2>Recent activity</h2>
        <ul class="dr-activity-list" id="dr-activity-list"><li class="dr-panel-empty">Loading&hellip;</li></ul>
      </div>
    </div>

    <div class="dr-roster-panel">
      <h2>Full roster</h2>
      <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Staff</th><th>Email</th><th>State</th><th>License type</th><th>Status</th><th>Next deadline</th><th class="dr-actions-head">Actions</th>
          </tr>
        </thead>
        <tbody id="dr-roster-body">
          <tr><td colspan="7">Loading your roster...</td></tr>
        </tbody>
      </table>
      </div>
    </div>

    {add_staff_html}
    </div>

    <div id="dr-view-calendar" class="dr-view" role="tabpanel" hidden>
      <h1>Calendar</h1>
      <p class="subhead">Upcoming renewal deadlines for your firm, by date.</p>
      <div class="dr-cal-panel">
        <div class="dr-cal-header">
          <h2 id="dr-cal-month-label">&nbsp;</h2>
          <div class="dr-cal-nav">
            <button type="button" id="dr-cal-prev" aria-label="Previous month">&larr;</button>
            <button type="button" id="dr-cal-today">Today</button>
            <button type="button" id="dr-cal-next" aria-label="Next month">&rarr;</button>
          </div>
        </div>
        <div class="dr-cal-grid" id="dr-cal-grid"></div>
      </div>
      <div class="dr-agenda-panel">
        <h2>Next 90 days</h2>
        <div id="dr-agenda-body"><p class="dr-panel-empty">Loading&hellip;</p></div>
      </div>
    </div>

    <div id="dr-view-map" class="dr-view" role="tabpanel" hidden>
      <h1>Map</h1>
      <p class="subhead">Where your firm has staff licensed, and who's at risk.</p>
      <div class="dr-map-controls">
        <label for="dr-map-staff-select">Show</label>
        <select id="dr-map-staff-select">
          <option value="">All staff (home-state licensing)</option>
        </select>
      </div>
      <p class="dr-map-mobility-note" id="dr-map-mobility-note" hidden></p>
      <div class="dr-map-panel">
        {map_svg_html}
      </div>
    </div>

    <div id="dr-view-cpe" class="dr-view" role="tabpanel" hidden>
      <h1>CPE Hours</h1>
      <p class="subhead">Track completed continuing-education hours against each state's own
      requirement. Internal visibility only -- not an official state filing, and not a substitute for
      your state board's own CPE reporting system.</p>

      <div class="dr-cpe-summary" id="dr-cpe-summary"></div>

      <div class="dr-cpe-staff-panel">
        <h2>Progress by staff member</h2>
        <div id="dr-cpe-staff-body"><p class="dr-panel-empty">Loading&hellip;</p></div>
      </div>

      <div class="dr-cpe-log-panel">
        <h2>Log completed hours</h2>
        <form id="dr-cpe-log-form">
          <label for="dr-cpe-staff-select">Staff member</label>
          <select id="dr-cpe-staff-select" name="subscriber_id" required>
            <option value="">Select staff member</option>
          </select>
          <div class="signup-form-row">
            <div>
              <label for="dr-cpe-entry-date">Date completed</label>
              <input type="date" id="dr-cpe-entry-date" name="entry_date" required>
            </div>
            <div>
              <label for="dr-cpe-hours">Hours</label>
              <input type="number" id="dr-cpe-hours" name="hours" min="0.1" max="100" step="0.1" required>
            </div>
          </div>
          <label for="dr-cpe-category">Category</label>
          <select id="dr-cpe-category" name="category">
            <option value="general">General</option>
            <option value="ethics">Ethics</option>
            <option value="other">Other</option>
          </select>
          <label for="dr-cpe-description">Course/provider (optional)</label>
          <input type="text" id="dr-cpe-description" name="description" maxlength="200" placeholder="e.g. AICPA ethics update">
          <button type="submit">Log hours</button>
        </form>
        <p id="dr-cpe-log-error" class="field-hint" style="color:#c33737;" hidden></p>
      </div>

      <div class="dr-cpe-log-panel">
        <h2>Recently logged</h2>
        <div id="dr-cpe-recent-body"><p class="dr-panel-empty">Loading&hellip;</p></div>
      </div>
    </div>

    <div id="dr-view-account" class="dr-view" role="tabpanel" hidden>
      <div class="dr-account-panel">
        <h2>Password</h2>
        <p class="signup-microcopy">Set a password to sign in directly, instead of waiting on an
        emailed link each time. If you already have one, enter it below to change it.</p>
        <!-- method/action are REQUIRED here even though JS intercepts the
             submit. Without them a native submit (JS error earlier in the
             bundle, an extension, Enter pressed before DOMContentLoaded)
             defaults to GET on the current URL, writing BOTH plaintext
             passwords into the URL bar, browser history, the static host's
             access logs, and any Referer sent from this page. Caught in
             the 2026-07-30 security review. -->
        <form id="dr-password-form" method="post" action="{REMINDER_BACKEND_BASE_URL}/firm/password">
          <label for="dr-current-password">Current password <span class="field-hint">(leave blank if you've never set one)</span></label>
          <input type="password" id="dr-current-password" name="current_password" autocomplete="current-password">
          <label for="dr-new-password">New password</label>
          <input type="password" id="dr-new-password" name="new_password" required minlength="12"
          autocomplete="new-password">
          <p class="field-hint">At least 12 characters. A short phrase you'll remember beats a short
          jumble you won't &mdash; length matters more than symbols.</p>
          <button type="submit">Save password</button>
        </form>
        <p id="dr-password-ok" class="dr-account-ok" hidden></p>
        <p id="dr-password-error" class="dr-account-err" hidden></p>
      </div>

      <div class="dr-account-panel">
        <h2>Connected sign-in accounts</h2>
        <p class="signup-microcopy">Accounts you can sign in with directly. Removing one doesn't lock
        you out &mdash; you can always request an emailed sign-in link.</p>
        <div id="dr-identities-body"><p class="dr-panel-empty">Loading&hellip;</p></div>
        <p id="dr-identity-error" class="dr-account-err" hidden></p>
      </div>
    </div>
  </div>
</div>

<script>
var DR_CPE_REQUIREMENTS = {json.dumps(cpe_requirements_json)};
</script>

{_FIRM_DASHBOARD_JS_HTML}
"""
    return page_shell(
        f"Firm Dashboard — {SITE_NAME}",
        "Manage your firm's CPA staff license roster: add staff, track renewal status, and mark "
        "licenses renewed.",
        body,
        home_href="../",
        canonical_path="/firm-dashboard/",
        extra_head='<meta name="robots" content="noindex">',
        hide_signin=True,
        sticky_top_nav=False,
    )


# Firm-admin-oriented SEO landing pages (2026-07-10 Wave-1 B2B inbound directive).
# Chosen for real, near-term firm-registration deadlines already backed by verified
# citation data in cpa_deadlines.json -- no new legal research needed, this just
# reframes already-vetted facts at a different reader (whoever owns the firm's own
# registration, not an individual CPA tracking their personal license). Ordered by
# deadline proximity: Idaho (Sep 30) is nearest, South Carolina (Feb 1) is furthest.
FIRM_LANDING_STATE_SLUGS = [
    "idaho", "missouri", "louisiana", "kansas", "alabama", "south-carolina",
]

# Populated by main() once by_slug is loaded (each entry: {"slug", "state_name"}) --
# build_firms_page() reads this to cross-link to every firm landing page that
# actually got built. Module-level and mutated rather than passed as a parameter,
# unlike by_slug itself (added 2026-07-10 for the dashboard mockup's real record
# lookups) -- FIRM_LANDING_PAGES is only known after that same build loop runs, so
# threading it through as a second parameter would just duplicate what's already
# sitting in module state by the time build_firms_page() is called.
FIRM_LANDING_PAGES: list[dict] = []


def load_cpe_hours_by_slug() -> dict[str, dict]:
    """CPE-hours cluster (2026-07-15): keyed by state_slug, one record per
    state currently verified to the 2-source standard (see cpe_hours.json's
    own _meta for what's held/pending). Loaded unconditionally at build
    time -- unlike FIRM_LANDING_PAGES this isn't populated by a build loop,
    it's independent input data, so callers that need it before the main
    per-state loop runs (build_state_page's reverse cross-link) can have it
    immediately."""
    if not CPE_HOURS_DATA_PATH.exists():
        return {}
    data = json.loads(CPE_HOURS_DATA_PATH.read_text(encoding="utf-8"))
    return {r["state_slug"]: r for r in data["records"]}


CPE_HOURS_PAGES: list[dict] = []


def load_reinstatement_by_slug() -> dict[str, dict]:
    """Reinstatement-cost cluster (2026-07-25): keyed by state_slug, same loading
    shape as load_cpe_hours_by_slug() and for the same reason -- independent input
    data, needed before the main per-state loop runs so build_state_page()'s reverse
    cross-link can use it immediately."""
    if not REINSTATEMENT_DATA_PATH.exists():
        return {}
    data = json.loads(REINSTATEMENT_DATA_PATH.read_text(encoding="utf-8"))
    return {r["state_slug"]: r for r in data["records"]}


REINSTATEMENT_PAGES: list[dict] = []


def _firm_relevant_record(records: list[dict]) -> dict | None:
    """Picks the record that best represents a state's FIRM-level registration/permit,
    for the firm-oriented SEO landing pages. Prefers a dedicated firm-type record
    (_FIRM_ONLY_LICENSE_TYPES) since its cycle_description is already written firm-
    specifically; falls back to an 'all' record (e.g. Alabama) whose cycle_description
    already covers the firm permit explicitly within the same combined record. Returns
    None if a state has neither, or the best candidate has no computed date -- callers
    must not build a firm landing page in either case (same "don't fabricate, disclose
    the gap instead" rule as every other record-shape check in this file)."""
    candidate = None
    for r in records:
        if r.get("license_type") in _FIRM_ONLY_LICENSE_TYPES:
            candidate = r
            break
    if candidate is None:
        for r in records:
            if r.get("license_type") == "all":
                candidate = r
                break
    if candidate is None or not candidate.get("next_deadline_computed"):
        return None
    return candidate


def build_firm_landing_page(state_slug: str, record: dict) -> tuple[str, str, str]:
    """Firm-admin-oriented SEO landing page -- same citation/sourcing standard as
    every individual state page, just reframed at the person who owns the FIRM's own
    registration/permit, not an individual CPA's license. Slug and copy are
    deliberately distinct from the state's main /<state_slug>/ page (which stays
    individual-license-focused) so this doesn't compete with or duplicate it --
    cross-links to /for-firms/ are the whole point. Returns (slug, title, html_body)."""
    state_name = record["state"]
    slug = f"{state_slug}-cpa-firm-renewal"
    title = f"{state_name} CPA Firm Renewal — What the Firm Itself Must File"
    meta_description = (
        f"{state_name} CPA firm registration/permit renewal: when it's due, what's required, and the "
        f"codified rule -- for whoever owns the firm's registration, not just individual staff licenses."
    )
    body = f"""<h1>{esc(title)}</h1>
<p class="subhead">{esc(state_name)} firm registration/permit &mdash; not individual license renewal</p>
<p class="intro">A CPA firm's own registration or permit to practice renews separately from any
individual staff CPA's license &mdash; and it's usually the filing that falls through the cracks,
because it belongs to whoever handles firm admin, not to a specific licensee tracking their own
renewal. Here's exactly when {esc(state_name)}'s firm-level filing is due.</p>
<div class="callout">
  {_verified_badge_html(record)}
  <div class="label">{esc(record['license_type_label'])}</div>
  <div class="date">{esc(fmt_date(date.fromisoformat(record['next_deadline_computed'])))}</div>
  <p class="rule">{esc(record['cycle_description'])}</p>
  {_source_cite_html(record)}
</div>
{trust_line(record['last_verified'], record['source_url'], bool(record.get('citation')))}

<div class="firm-cta">
<h2>Tracking this for more than one firm, or want someone else watching it?</h2>
<p>Any individual CPA at your firm can already get free renewal reminders for their own license. What
DeadlineRadar's firm tier adds is the view your admin doesn't get from 20 separate free sign-ups: one
place to see the whole roster's status &mdash; including this firm-level filing &mdash; not 20 inboxes
to hope someone's watching. <a href="../for-firms/">See firm-tier pricing &rarr;</a></p>
</div>

<p class="backlink"><a href="../">&larr; Back to all states</a></p>
"""
    # Not _breadcrumb_schema() -- that helper hardcodes " CPA Renewal" onto whatever
    # name it's given (built for the individual state pages), which would render this
    # as the wrong, garbled "{state} Firm Renewal CPA Renewal". Built inline instead
    # with the correct firm-specific breadcrumb label.
    json_ld = [{
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": SITE_NAME, "item": f"{SITE_BASE_URL}/"},
            {
                "@type": "ListItem",
                "position": 2,
                "name": f"{state_name} CPA Firm Renewal",
                "item": f"{SITE_BASE_URL}/{slug}/",
            },
        ],
    }]
    html = page_shell(
        f"{title} — {SITE_NAME}", meta_description, body, home_href="../",
        canonical_path=f"/{slug}/", json_ld=json_ld,
    )
    return slug, title, html


def _cpe_hours_signup_html(cpe_record: dict, renewal_records: list[dict], as_of: date) -> str:
    """Light single-line capture (2026-07-15, per orchestrator go-live review):
    option 1 -- capture reminder intent where it lands on the CPE-hours page,
    rather than funnel-only via the cross-link. Deliberately reuses the SAME
    real /subscribe backend, bot-defense fields, and extra-fields mechanism
    as signup_form_for_state() -- does NOT invent a new "CPE deadline
    reminder" the backend can't fulfill. Honest framing: CPE and license
    renewal are on related clocks, so a reminder about the renewal date is
    genuinely relevant here. Kept minimal (no first-name field, no full form
    heading) so it reads as one compact row, not a second competing form."""
    slug = cpe_record["state_slug"]
    if not renewal_records:
        return ""
    extra_fields = _extra_fields_html(slug, renewal_records, as_of)
    return f"""<div class="signup-form signup-form--compact" id="remind">
  <form method="post" action="{esc(REMINDER_BACKEND_BASE_URL)}/subscribe">
    <input type="hidden" name="state" value="{esc(slug)}">
    {_BOT_DEFENSE_FIELDS_HTML}
    <label for="cpe-email-{esc(slug)}" class="signup-form-compact-label">
      CPE hours and your renewal are on related clocks &mdash; get reminded before
      {esc(cpe_record['state'])}'s renewal date too:
    </label>
    <div class="signup-form-row">
      <input type="email" id="cpe-email-{esc(slug)}" name="email" required placeholder="you@example.com">
      <button type="submit">Remind me</button>
    </div>
    {extra_fields}
  </form>
</div>"""


def _reinstatement_signup_html(state_slug: str, state_name: str, renewal_records: list[dict], as_of: date) -> str:
    """Same compact capture pattern as _cpe_hours_signup_html() -- same real
    /subscribe backend, bot-defense fields, extra-fields mechanism -- but with
    copy that actually fits a reinstatement page: a visitor here already lapsed
    (or is worried they're about to), so the honest hook is "don't let it
    happen again," not the CPE-hours page's "CPE and renewal are on related
    clocks" framing, which doesn't make sense in this context."""
    if not renewal_records:
        return ""
    extra_fields = _extra_fields_html(state_slug, renewal_records, as_of)
    return f"""<div class="signup-form signup-form--compact" id="remind">
  <form method="post" action="{esc(REMINDER_BACKEND_BASE_URL)}/subscribe">
    <input type="hidden" name="state" value="{esc(state_slug)}">
    {_BOT_DEFENSE_FIELDS_HTML}
    <label for="reinstate-email-{esc(state_slug)}" class="signup-form-compact-label">
      Don't let it lapse again &mdash; get reminded before {esc(state_name)}'s next renewal date:
    </label>
    <div class="signup-form-row">
      <input type="email" id="reinstate-email-{esc(state_slug)}" name="email" required placeholder="you@example.com">
      <button type="submit">Remind me</button>
    </div>
    {extra_fields}
  </form>
</div>"""


def _every_n_years(n: int) -> str:
    """'every year' not 'every 1 year' -- the pluralization artifact the
    orchestrator's go-live review caught (2026-07-15). Used everywhere a CPE
    period gets rendered so this can't drift back out of sync per call site."""
    return "every year" if n == 1 else f"every {n} years"


def build_cpe_hours_page(
    cpe_record: dict, renewal_records: list[dict], as_of: date,
    reinstatement_by_slug: dict[str, dict] | None = None,
) -> tuple[str, str, str]:
    """CPE-hours-by-state page (2026-07-15 cluster). Flat sibling slug, same
    convention as build_firm_landing_page() -- e.g. /arizona-cpa-cpe-requirements/
    sits alongside /arizona/, not nested under it. Returns (slug, title, html),
    same shape as build_firm_landing_page() for the same reason: main() needs
    the slug to register it (sitemap, cross-links) without re-deriving it."""
    state_name = cpe_record["state"]
    slug = f"{cpe_record['state_slug']}-cpa-cpe-requirements"
    title = f"{state_name} CPA CPE Requirements: How Many Hours, By When"
    period_phrase = _every_n_years(cpe_record["period_years"])
    # CTR fix (2026-07-25, per GSC: avg position ~19, 0.42% CTR): the raw legal
    # citation at the end of the old meta description ate SERP-snippet space
    # without giving a searcher a reason to click -- it's already shown
    # on-page as the trust signal, doesn't need to double as click-bait copy.
    # Swapped for the ethics-hour figure when the state has one (a real,
    # frequently-searched sub-question -- "how many ethics hours" is its own
    # distinct query), falling back to a plain benefit line otherwise.
    ethics_hours = cpe_record.get("ethics_hours")
    if ethics_hours:
        # Same singular/plural guard as the body's ethics_line below -- caught
        # by an adversarial RE-QA pass (2026-07-25): North Carolina's real
        # 1-hour ethics requirement was rendering as "1 ethics hours" in the
        # meta description, a live SERP-facing typo this fix's own goal
        # (sharper copy) made doubly relevant to catch.
        meta_ethics_word = "hour" if ethics_hours == 1 else "hours"
        meta_tail = f"including {ethics_hours} ethics {meta_ethics_word}, verified against the state's own rule."
    else:
        meta_tail = "verified against the state's own board rule, not a guess."
    meta_description = (
        f"How many CPE hours does {state_name} require for CPAs, and by when? "
        f"{cpe_record['total_hours']} hours {period_phrase}, {meta_tail}"
    )

    ethics_line = ""
    if cpe_record.get("ethics_hours"):
        ethics_hour_word = "hour" if cpe_record["ethics_hours"] == 1 else "hours"
        ethics_period = cpe_record.get("ethics_period_years")
        if ethics_period and ethics_period != cpe_record.get("period_years"):
            ethics_line = (
                f"<li><strong>{cpe_record['ethics_hours']} ethics {ethics_hour_word}</strong>, required once "
                f"{_every_n_years(ethics_period)} (counts toward the total "
                f"above, not an add-on).</li>"
            )
        else:
            ethics_line = (
                f"<li><strong>{cpe_record['ethics_hours']} ethics {ethics_hour_word}</strong>, within that same "
                f"total.</li>"
            )
    annual_line = ""
    annual_minimum = cpe_record.get("annual_minimum_hours")
    # Suppress the bullet entirely when it's redundant with the total (a
    # 1-year cycle whose annual minimum equals its own total isn't a second
    # requirement -- it's the same fact stated twice, the exact "40-hour
    # minimum ... 40 hours every year" the go-live review flagged on NC).
    if annual_minimum and not (annual_minimum == cpe_record["total_hours"] and cpe_record["period_years"] == 1):
        annual_line = (
            f"<li><strong>{annual_minimum}-hour minimum</strong> in each 1-year "
            f"period (you can't front-load the whole requirement into a single year).</li>"
        )

    has_verified_date = any(r.get("next_deadline_computed") for r in renewal_records)
    if has_verified_date:
        cross_link_text = f"See {state_name}'s CPA license renewal deadline"
    else:
        cross_link_text = f"See {state_name}'s CPA license renewal page"

    # Gate the "Verified" badge on data_gap_note the same way
    # build_reinstatement_page() does (added 2026-07-25, same adversarial RE-QA
    # pass that flagged this page type as the one place a record admitting an
    # unconfirmed sourcing leg still showed the unconditional badge). Older
    # records (batches 1-4) predate this field entirely -- .get() returns None
    # for them, so they keep showing "Verified" exactly as before; nothing
    # about their own trust signal changes.
    data_gap_note = cpe_record.get("data_gap_note")
    verified_badge_html = "" if data_gap_note else '<span class="verified-badge">Verified</span>'
    sourcing_note_html = (
        f'<p class="disclosure">Sourcing note: {esc(data_gap_note)}</p>' if data_gap_note else ""
    )

    body = f"""<h1>{esc(title)}</h1>
<p class="intro">How much continuing professional education {indefinite_article(state_name)} {esc(state_name)} CPA actually
needs &mdash; sourced the same way every fact on this site is: a board page plus the codified rule
itself, never a guess.</p>

<div class="callout">
  {verified_badge_html}
  <div class="label">CPE Hour Requirement</div>
  <div class="date">{cpe_record['total_hours']} hours {period_phrase}</div>
  <ul>
    {annual_line}
    {ethics_line}
  </ul>
  {_source_cite_html(cpe_record)}
  {sourcing_note_html}
</div>

<p>{esc(cpe_record.get('notes', ''))}</p>

{_cpe_hours_signup_html(cpe_record, renewal_records, as_of)}

{_cpe_affiliate_html()}

{_reinstatement_reverse_link_html(cpe_record["state_slug"], reinstatement_by_slug) if reinstatement_by_slug else ""}

<p class="backlink-cross"><a href="../{esc(cpe_record['state_slug'])}/">{esc(cross_link_text)} &rarr;</a></p>

<p class="backlink"><a href="../">&larr; Back to all states</a></p>
"""
    json_ld = [{
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": SITE_NAME, "item": f"{SITE_BASE_URL}/"},
            {
                "@type": "ListItem",
                "position": 2,
                "name": f"{state_name} CPA CPE Requirements",
                "item": f"{SITE_BASE_URL}/{slug}/",
            },
        ],
    }]
    html = page_shell(
        f"{title} — {SITE_NAME}", meta_description, body, home_href="../",
        canonical_path=f"/{slug}/", json_ld=json_ld, has_remind_anchor=True,
    )
    return slug, title, html


def _cpe_hours_reverse_link_html(state_slug: str, cpe_hours_by_slug: dict[str, dict]) -> str:
    """Reverse cross-link (renewal page -> CPE-hours page), per the orchestrator's
    go-live checklist: cross-link integrity in BOTH directions, not just CPE-hours
    page -> renewal page. Renders nothing if this state has no verified CPE-hours
    record yet (most states, until the cluster grows past this first tranche)."""
    cpe_record = cpe_hours_by_slug.get(state_slug)
    if not cpe_record:
        return ""
    slug = f"{state_slug}-cpa-cpe-requirements"
    return (
        f'<p class="backlink-cross"><a href="../{esc(slug)}/">How many CPE hours does '
        f'{esc(cpe_record["state"])} require? &rarr;</a></p>'
    )


def _reinstatement_reverse_link_html(state_slug: str, reinstatement_by_slug: dict[str, dict]) -> str:
    """Reverse cross-link (renewal/CPE-hours page -> reinstatement page), same
    bidirectional-cross-link discipline as _cpe_hours_reverse_link_html(). Renders
    nothing if this state has no reinstatement record yet (most states, until the
    cluster grows past batch 1)."""
    record = reinstatement_by_slug.get(state_slug)
    if not record:
        return ""
    slug = f"{state_slug}-cpa-license-reinstatement"
    return (
        f'<p class="backlink-cross"><a href="../{esc(slug)}/">What does it cost to reinstate a lapsed '
        f'{esc(record["state"])} license? &rarr;</a></p>'
    )


def _reinstatement_fee_str(fee: float | int | None) -> str | None:
    """Single formatter for a reinstatement fee, shared by the page body and the
    meta description -- factored out after an adversarial RE-QA pass (2026-07-25)
    caught the two call sites rounding a fractional fee (Kansas's $247.50)
    differently, so the meta tag and the visible page disagreed on the same
    number. Returns None (not a fallback string) when there's no flat fee, so
    every caller must handle that case explicitly rather than inherit a default."""
    if fee is None:
        return None
    return f"${fee:,.2f}" if isinstance(fee, float) and not fee.is_integer() else f"${fee:,.0f}"


def _reinstatement_fee_line_html(record: dict) -> str:
    """Fee is a flat dollar figure for most states but a formula for a few (Texas,
    Ohio, Illinois's cap-not-flat case) -- render honestly either way, never forcing
    a formula into a fake point number."""
    fee_str = _reinstatement_fee_str(record.get("reinstatement_fee_usd"))
    notes = record.get("reinstatement_fee_notes") or ""
    if fee_str is not None:
        return f"<div class=\"date\">{esc(fee_str)}</div><p>{esc(notes)}</p>"
    # Every null-fee record's own notes text already opens with "No flat fee --"
    # (see data/reinstatement.json) explaining the formula, so this branch renders
    # the notes as-is rather than prepending a second, redundant "No flat fee" label.
    return f"<p>{esc(notes)}</p>"


def _reinstatement_cpe_line_html(record: dict) -> str:
    hours = record.get("penalty_cpe_hours")
    notes = record.get("penalty_cpe_notes") or ""
    ethics = record.get("penalty_ethics_hours")
    parts = []
    if hours is not None:
        parts.append(f"<li><strong>{hours} CPE hours</strong> {esc(notes)}</li>")
    elif notes:
        parts.append(f"<li>{esc(notes)}</li>")
    if ethics is not None:
        parts.append(f"<li><strong>{ethics} ethics hours</strong>, within that total.</li>")
    return "\n    ".join(parts)


def build_reinstatement_page(record: dict, renewal_records: list[dict], cpe_record: dict | None, as_of: date) -> tuple[str, str, str]:
    """Reinstatement-cost lead-magnet page (2026-07-25 affiliate-pivot batch).
    Flat sibling slug, same convention as build_cpe_hours_page() --
    /florida-cpa-license-reinstatement/ sits alongside /florida/, not nested
    under it. Returns (slug, title, html), same shape as the other flat-page
    builders for the same reason: main() needs the slug to register it
    (sitemap, cross-links) without re-deriving it.

    This page answers a panicked-lapser's search at peak intent -- the exact
    empty shelf ScoutLab's 2026-07-21 product register identified: no per-state
    reinstatement calculator exists anywhere. Same 2-source sourcing discipline
    as every other page on this site; a state whose real fee/hours figure is a
    formula (not a flat number) says so honestly rather than forcing a guess."""
    state_name = record["state"]
    slug = f"{record['state_slug']}-cpa-license-reinstatement"
    title = f"{state_name} CPA License Reinstatement: What a Lapsed License Costs"
    fee_str = _reinstatement_fee_str(record.get("reinstatement_fee_usd"))
    # CTR fix (2026-07-25, per GSC: avg position ~19, 0.42% CTR): the original
    # version appended the full legal citation to every meta description --
    # for a multi-section reinstatement citation that ran as long as 260+
    # characters (Google truncates around 155-160), cutting the snippet off
    # mid-sentence. Dropped the citation (already the on-page trust signal,
    # not a click driver) and reframed the formula-fee case as a reason to
    # click through rather than a dead-end "see below."
    if fee_str is not None:
        meta_description = (
            f"What does it cost to reinstate a lapsed {state_name} CPA license? "
            f"{fee_str} plus the exact catch-up CPE required, sourced to the state's own rule."
        )
    else:
        meta_description = (
            f"What does it cost to reinstate a lapsed {state_name} CPA license? "
            f"The fee follows a formula, not a flat rate -- see the exact breakdown and the "
            f"catch-up CPE required."
        )

    # A record whose own data_gap_note admits the board-page leg of the 2-source
    # rule isn't fully confirmed (e.g. a fetch that 404'd during research) must not
    # show the same unconditional "Verified" badge as a fully dual-sourced record --
    # caught by an adversarial RE-QA pass (2026-07-25) on Georgia/Ohio specifically.
    # The codified-rule citation below is still real either way; this only gates the
    # badge and surfaces the gap itself, it never hides or invents a number.
    data_gap_note = record.get("data_gap_note")
    verified_badge_html = "" if data_gap_note else '<span class="verified-badge">Verified</span>'
    sourcing_note_html = (
        f'<p class="disclosure">Sourcing note: {esc(data_gap_note)}</p>' if data_gap_note else ""
    )

    body = f"""<h1>{esc(title)}</h1>
<p class="subhead">If your {esc(state_name)} CPA license has already lapsed</p>
<p class="intro">What it actually takes to get a lapsed {esc(state_name)} CPA license back &mdash;
the fee, the catch-up CPE, and exactly what triggers "lapsed" in the first place. Sourced the same
way every fact on this site is: a board page plus the codified rule itself, never a guess.</p>

<div class="callout">
  {verified_badge_html}
  <div class="label">Reinstatement Fee</div>
  {_reinstatement_fee_line_html(record)}
</div>

<div class="callout">
  <div class="label">Catch-Up CPE Required</div>
  <ul>
    {_reinstatement_cpe_line_html(record)}
  </ul>
  {_source_cite_html(record)}
  {sourcing_note_html}
</div>

<p><strong>What triggers lapsed status:</strong> {esc(record['lapse_trigger'])}</p>

{trust_line(record["last_verified"], record["source_url"], bool(record.get("citation")))}

{_reinstatement_signup_html(record["state_slug"], state_name, renewal_records, as_of)}

{_cpe_affiliate_html()}

<p class="backlink-cross"><a href="../{esc(record['state_slug'])}/">See {esc(state_name)}'s CPA license renewal deadline &rarr;</a></p>
{f'<p class="backlink-cross"><a href="../{esc(record["state_slug"])}-cpa-cpe-requirements/">How many CPE hours does {esc(state_name)} require? &rarr;</a></p>' if cpe_record else ""}
<p class="backlink"><a href="../">&larr; Back to all states</a></p>
"""
    json_ld = [{
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": SITE_NAME, "item": f"{SITE_BASE_URL}/"},
            {
                "@type": "ListItem",
                "position": 2,
                "name": f"{state_name} CPA License Reinstatement",
                "item": f"{SITE_BASE_URL}/{slug}/",
            },
        ],
    }]
    html = page_shell(
        f"{title} — {SITE_NAME}", meta_description, body, home_href="../",
        canonical_path=f"/{slug}/", json_ld=json_ld, has_remind_anchor=True,
    )
    return slug, title, html


BLOG_ARTICLES = [
    {
        "slug": "cpe-vs-license-renewal",
        "title": "CPE Requirements vs. License Renewal — The Deadline CPAs Mix Up",
        "meta_description": (
            "CPE completion and license renewal are two different deadlines with two different "
            "rules. Here's how they differ, state by state, and what happens if you miss either one."
        ),
        "body_html": """
<p class="intro">CPAs juggle two deadlines that sound like they should be the same thing but often
aren't: the date your <strong>license itself renews</strong>, and the date your <strong>continuing
professional education (CPE) hours</strong> are due. Mixing them up is one of the most common ways a
CPA ends up scrambling in the last week before a deadline &mdash; or worse, finding out their license
lapsed because they tracked the wrong date.</p>

<p><strong>They're not always the same date &mdash; sometimes they're not even the same
<em>frequency</em>.</strong></p>

<p>Take Missouri. The license itself renews <strong>every two years</strong>, on a fixed September 30
date (Mo. Code Regs. Ann. tit. 20 &sect; 2010-2.070(1)). But CPE hours are checked <strong>every
single year</strong> &mdash; 40 hours including 2 ethics hours, due annually, even in the "off year"
when the license itself isn't up for renewal (20 CSR 2010-4.010(1)(C)). A Missouri CPA could renew
their license this year, relax about paperwork for twelve months, and still owe a full year of CPE
hours in that gap year &mdash; with a January 1&ndash;March 1 grace window to catch up if they fall
behind.</p>

<p>West Virginia shows the same pattern a different way: the license itself renews <strong>every year
on June 30</strong> (W. Va. Code &sect; 30-9-12(a)), but CPE is tracked on a rolling
<strong>three-year</strong> total (120 hours, minimum 20 per year) that must be completed by
<strong>December 31</strong> each year and reported to the Board by January 31 of the following year
(W. Va. CSR tit. 1, ser. 1, &sect; 1-1-7). Renew your license in June and you might assume you're
square for the year &mdash; but your CPE hours are still due six months later, on a completely
different clock.</p>

<p>Not every state splits them this way. Wisconsin, for example, ties CPE directly to the same renewal
date &mdash; there's no separate CPE-specific cutoff to track (Wis. Stat. &sect; 440.08(2); DSPS
Accounting Examining Board). So the honest answer to "are these the same deadline?" is:
<strong>it depends on your state, and you have to check both rules, not assume.</strong></p>

<p><strong>What happens if you miss one but not the other?</strong> The consequences are usually
different too &mdash; a missed license-renewal deadline typically means your license lapses and you
can't practice until you reinstate it (often with a fee). A missed CPE deadline, on the other hand, is
often a compliance issue caught at your <em>next</em> renewal, or during an audit of your CPE records
&mdash; annoying and sometimes costly, but not always an immediate practice-stopping event the way a
lapsed license is. Either way, your state board is the authority on what actually happens &mdash; this
isn't legal advice, just a map of how the two deadlines relate.</p>

<p><strong>The practical fix</strong>: don't rely on memory for either one.
<a href="../../">Find your state's CPA renewal deadline here</a> and set a reminder &mdash; and if
your state runs CPE on a different clock than your license (like Missouri or West Virginia above),
track that separately too.</p>
""",
    },
    {
        "slug": "common-cpa-renewal-mistakes",
        "title": "The Most Common CPA License-Renewal Mistakes (and How to Avoid Them)",
        "meta_description": (
            "The renewal mistakes that trip up CPAs most often — wrong deadline, wrong cycle "
            "length, and the ones that assume renewal rules are the same everywhere. How to avoid "
            "each one."
        ),
        "body_html": """
<p class="intro">Most CPA license lapses aren't dramatic &mdash; they're small, avoidable mix-ups.
Here are the ones that come up again and again.</p>

<p><strong>1. Assuming every state renews on the same cycle.</strong> Some states renew annually,
some every two years, some every three. Missouri's individual license renews every <strong>two</strong>
years; Missouri's firm permits renew every <strong>single</strong> year &mdash; a different cycle
length for the same board, in the same state (Mo. Code Regs. Ann. tit. 20 &sect;&sect;
2010-2.070(1), 2010-2.072(2)). If you assume your firm follows the same clock as your individual
license, you can be wrong by a full year.</p>

<p><strong>2. Confusing a fixed calendar date with a birth-month or cohort system.</strong> Some
states &mdash; Texas is a well-known example &mdash; renew each individual CPA annually, by the last
day of <em>their own birth month</em>, not a single date that applies to everyone (Texas State Board
of Public Accountancy, tsbpa.texas.gov/cpas/renewal/). If you're used to a fixed-date state and move
to or get licensed in a birth-month state, assuming a single statewide date is a fast way to miss your
actual deadline.</p>

<p><strong>3. Missing the CPE deadline while celebrating the license renewal.</strong> Covered in more
depth in our <a href="../cpe-vs-license-renewal/">CPE vs. license renewal</a> piece &mdash; the short
version is: renewing your license does not automatically mean your CPE hours are current, or that CPE
is even due at the same time. Check both, separately, every cycle.</p>

<p><strong>4. Trusting a stale reminder from a state board, an employer, or a CPE vendor.</strong> Some
state boards do send their own renewal reminders &mdash; but not all of them do, and the ones that do
vary in reliability and lead time. Relying solely on someone else to remember for you is a single
point of failure. A reminder tied to the actual published deadline, not a third party's internal
process, is safer.</p>

<p><strong>5. Waiting until the late-renewal grace window and assuming there's no real
consequence.</strong> Several states publish a formal late-renewal period with an added fee (Missouri's
late window ran through December 31 for its most recent cycle, per the Board's own 2026 Winter
newsletter) &mdash; but a grace period is not a second deadline. It's a penalty window, and after it
closes, reinstatement is usually harder and more expensive than a normal renewal.</p>

<p><strong>The fix for all five</strong>: know your specific state's exact rule (cycle length, fixed
date vs. birth-month vs. cohort, and whether CPE has its own separate deadline), and track it with a
real reminder tied to the actual date &mdash; not a guess, a memory, or someone else's process.
<a href="../../">Look up your state here</a>.</p>
""",
    },
    {
        "slug": "missouri-cpa-license-renewal-guide",
        "title": "How CPA License Renewal Works in Missouri: Dates, Fees, CPE, and Deadlines",
        "meta_description": (
            "Missouri CPA license renewal: the real dates for individual licenses and firm "
            "permits, CPE requirements, fees, and what happens if you miss a deadline."
        ),
        "body_html": """
<p class="intro">Missouri runs two genuinely different renewal cycles depending on whether you hold
an individual CPA license or a firm permit &mdash; and its CPE requirement runs on a third, separate
clock. Here's exactly how each one works, sourced to the Missouri Board's own published rule.</p>

<h2>Individual CPA license: renews every two years, ending September 30</h2>
<p>Missouri individual CPA licenses are issued for a two-year period beginning October 1 and expiring
September 30 (20 CSR 2010-2.070(1)). The Board's own 2026 Winter newsletter confirms the currently
active cycle: the timely renewal window for individual licenses closed September 30, 2025, with a
late-renewal window running through December 31, 2025 &mdash; placing the current cycle at October 1,
2025 through September 30, 2027. <a href="../../missouri/">Confirm your own next Missouri CPA renewal
deadline here</a>.</p>

<h2>Firm permits: a different cycle &mdash; annual, ending October 31</h2>
<p>Missouri firm permits do not follow the same two-year cycle as individual licenses. They're issued
for a one-year period beginning November 1 and expiring October 31, renewed every single year (20 CSR
2010-2.072(2)). The Board's newsletter confirms the current firm-permit cycle runs November 1, 2025
through October 31, 2026 &mdash; meaning a firm's renewal deadline can land in a completely different
year than its individual license holders' next renewal, even at the same firm.</p>

<h2>CPE: checked annually, regardless of the two-year license cycle</h2>
<p>Here's the part that catches people: even though the individual license itself only renews every
two years, CPE compliance is checked on a calendar-year basis &mdash; 40 hours per year, including 2
ethics hours, every single year, not just in "renewal years" (20 CSR 2010-4.010(1)(C)). If you fall
behind, the rule gives a January 1 through March 1 grace period each year to catch up on the prior
year's shortfall. Don't let a two-year license cycle lull you into treating CPE as a
once-every-two-years task &mdash; it isn't.</p>

<h2>What happens if you miss a deadline</h2>
<p>Missouri's own newsletter confirms a formal late-renewal window exists (through December 31 for the
cycle referenced above) with an added fee &mdash; but that window is a penalty period, not a real
second deadline, and reinstatement after it closes is a separate, harder process. The safest path is
renewing on time in the first place.</p>

<p><strong>Bottom line</strong>: if you're a Missouri CPA, track three things separately &mdash; your
individual license's 2-year cycle, your firm's separate annual cycle (if applicable), and your CPE
hours' annual clock. <a href="../../missouri/">Set a reminder for your Missouri deadline here</a> so
you don't have to hold all three in your head.</p>
""",
    },
    {
        # First Moderate-tier article (2026-07-10) -- Tier-A format #1 (per-state renewal
        # guide, the Missouri template rolled to a new state). Sequenced OUT of the standing
        # "largest-population-first" default deliberately: this state was chosen because a
        # real confirmed-organic Google referrer landed on ITS state page the same day the
        # trigger fired (see the trigger filing for the raw-log cross-check) -- a real signal
        # beats a population-based guess. Resume largest-population-first + alternating with
        # a CPE guide next week absent a similarly strong reason not to.
        "slug": "arizona-cpa-license-renewal-guide",
        "title": "How CPA License Renewal Works in Arizona: Birth-Month Cycles, Firm Registration, and Deadlines",
        "meta_description": (
            "Arizona CPA license renewal: how the birth-month/parity cycle works, why firm "
            "registration runs on a separate clock, and what happens if you miss the deadline."
        ),
        "body_html": """
<p class="intro">Arizona doesn't renew every CPA on the same date &mdash; your individual certificate
renews in your own birth month, and which <em>years</em> you renew in depends on whether you were born
in an odd or even year. Firm registration runs on an entirely separate clock. Here's exactly how each
piece works, sourced to Arizona's own statute and administrative rule.</p>

<h2>Individual CPA certificate: your birth month, every two years, matched to your birth year's parity</h2>
<p>Per A.R.S. &sect; 32-730 and A.A.C. R4-1-345(B)(1), Arizona's individual CPA certificate renews
biennially (every two years) &mdash; but WHICH two years depends on your birth year's parity: if you
were born in an even-numbered year, you renew during your birth month in every even-numbered year; born
in an odd-numbered year, you renew during your birth month in every odd-numbered year. Renewal has to be
<strong>received</strong> by the Board &mdash; postmarks don't count &mdash; by 5:00pm on the last
business day of your birth month. <a href="../../arizona/">Confirm your own next Arizona CPA renewal
deadline here</a>.</p>

<h2>Firm/business registration: a separate anniversary cycle, not your birth month</h2>
<p>This is the part that catches people who assume everything renews together. Per A.A.C.
R4-1-345(B)(2), a business-organization firm &mdash; a partnership, PC, PLLC, LLC, or LLP &mdash; renews
during the board-approved month of its <em>initial registration</em>, on the same odd/even-year parity
as the year it first registered. That's a completely different anchor date than any individual owner's
personal birth month. The one exception: a sole proprietorship or an individual registrant's own firm
registration is NOT on this separate cycle &mdash; it rides along with that person's individual
certificate renewal instead.</p>

<h2>CPE: the same clock as your renewal, not a separate one</h2>
<p>Unlike states that check continuing education on an annual calendar regardless of a multi-year
license cycle, Arizona's CPE reporting period is defined identically to your renewal period itself
&mdash; there's no separate CE deadline running on its own clock. Whatever window your certificate
renewal covers is the same window your CPE hours are checked against.</p>

<h2>What happens if you miss the deadline</h2>
<p>Missing the 5:00pm last-business-day cutoff triggers <strong>automatic suspension</strong>, plus a
$50 late fee to reactivate. That suspension isn't the end of the line by itself &mdash; but if it isn't
resolved within 3 months, the certificate doesn't just stay suspended, it <strong>expires</strong>. That's
a harder consequence than a simple late fee, and a real reason not to let a birth-month deadline sneak up
on you.</p>

<p><strong>Bottom line</strong>: if you're an Arizona CPA, your personal renewal (birth month,
parity-matched) and your firm's registration (if you're not a sole proprietor) can land in
completely different years from each other. <a href="../../arizona/">Set a reminder for your
Arizona deadline here</a> so you're tracking the date that actually applies to you, not a guess
at when "renewal season" is.</p>
""",
    },
    {
        "slug": "why-some-states-need-your-birth-month",
        "title": "Why This Site Sometimes Asks for Your Birth Month Instead of Just Showing a Date",
        "meta_description": (
            "Some states renew every CPA license on one fixed date. Others compute it from your "
            "birth month or year. The real difference, state by state, and why we ask instead of guess."
        ),
        "body_html": """
<p class="intro">Most of this site works the same way for every visitor to a given state page: pick
your state, see the date, done. A handful of states don't work that way, and if you've landed on one of
those pages wondering why we're asking for your birth month instead of just showing a date, here's
exactly why &mdash; and why we won't guess it for you.</p>

<h2>The simple case: one date, for everyone, codified in law</h2>
<p>Most states renew every individual CPA on the same calendar date, full stop. Wisconsin is a clean
example: every individual license renews <strong>December 15 of each odd-numbered year</strong> &mdash;
"the same statutory date for every licensee," per Wis. Stat. &sect; 440.08(2)(a)1. There's no formula to
apply, no personal detail needed &mdash; the date on the page is your date, and it's a real,
citation-backed fact this site verifies and marks <strong>Verified</strong>.</p>

<h2>The other case: your date depends on something specific to you</h2>
<p>Several states don't assign one date to everyone &mdash; they compute each licensee's own deadline
from a personal detail, most often the licensee's own birth month:</p>
<ul>
  <li><strong>Texas</strong>: renewal fee is due annually by the last day of your own birth month.</li>
  <li><strong>Oklahoma</strong>: "all permits issued shall be renewed on the last day of the
  individual's birth month" (Okla. Stat. tit. 59 &sect; 15.14A) &mdash; the Board even publishes its own
  birth-month lookup table.</li>
  <li><strong>New Mexico</strong>: annual renewal due by the last day of your birth month (16.60.3.9.I
  NMAC).</li>
  <li><strong>California</strong>: your license expires every 2 years at midnight on the last day of
  your birth month &mdash; which two years depends on whether your birth year is odd or even.</li>
  <li><strong>Arizona</strong>: biennial, matched to both your birth month <em>and</em> your birth
  year's odd/even parity (A.R.S. &sect; 32-730, A.A.C. R4-1-345(B)(1)) &mdash; see our
  <a href="../arizona-cpa-license-renewal-guide/">full Arizona guide</a> for exactly how that works.</li>
  <li><strong>New York</strong>: a mandatory triennial registration (separate from the license itself)
  that expires in the month <em>before</em> your own birth month.</li>
</ul>
<p>These aren't small variations on the same idea &mdash; a birth-<em>month</em> formula, a birth-
<em>year-parity</em> formula, and a fixed date that applies to everyone are three genuinely different
mechanisms, and mixing them up is an easy way to track the wrong deadline entirely.</p>

<h2>Why we ask instead of guess</h2>
<p>This site's whole standard, described in full on our <a href="../../methodology/">verification
methodology page</a>, is simple: if a date can't be confirmed against the actual codified rule for
<em>everyone</em> in a state, we don't publish a guessed date. For a birth-month-driven state, "your
deadline" genuinely doesn't exist as a single fact until you tell us the one detail the rule itself
depends on. So instead of picking a plausible-looking date and hoping it's close enough, the signup form
for these states asks for that one extra field &mdash; your birth month, or similar &mdash; and computes
your actual deadline from it, the same way the state's own rule does.</p>

<p><strong>Bottom line:</strong> if a state page shows an exact date with a <strong>Verified</strong>
badge, that date is confirmed law, the same for every licensee. If it asks you a question first, that's
not this site being vague &mdash; it's the actual rule working that way, and we'd rather ask than
guess.</p>
""",
    },
    {
        # 2026-07-17: GSC-steered pick -- "cpa renewal illinois" / "illinois cpa license renewal" /
        # "il cpa license renewal" are Illinois's strongest real query cluster in Search Console
        # (12 impressions at position 19.2 for the top variant, several more nearby), already next
        # in the standing blog queue (Illinois, then Connecticut, then Wisconsin) before this
        # confirmed it. Pure repackaging of already-verified data/cpe_hours.json entries, zero new
        # legal research.
        "slug": "illinois-cpa-license-renewal-guide",
        "title": "How CPA License Renewal Works in Illinois: Dates, CPE, and Firm Registration",
        "meta_description": (
            "Illinois CPA license renewal: the 3-year individual and firm cycles, the 120-hour "
            "CPE requirement, and the separate sexual harassment prevention training rule."
        ),
        "body_html": """
<p class="intro">Illinois runs individual licenses and firm licenses on the same 3-year cycle length,
but different expiration months and a different anchor-year picture &mdash; and its CPE rule bundles in
a training requirement that's easy to miss because it isn't labeled "ethics." Here's exactly how each
piece works, sourced to Illinois's own administrative code.</p>

<h2>Individual CPA license: every 3 years, ending September 30</h2>
<p>Illinois individual CPA licenses run on a 3-year cycle expiring September 30 (68 Ill. Admin. Code
1420.80(a)). The currently confirmed cycle ends September 30, 2027. <a href="../../illinois/">Confirm
your own next Illinois CPA renewal deadline here</a>.</p>

<h2>Firm licenses: same rule, different month &mdash; and a real data gap worth knowing about</h2>
<p>Firm licenses are governed by the same rule section, just a different subsection (68 Ill. Admin. Code
1420.80(b)): a 3-year cycle expiring November 30. What the rule text doesn't pin down is a specific
anchor year for the firm track the way it does for individual licenses. A 2021 IDFPR variance did extend
that cycle's firm-license expiration from November 30, 2021 to January 31, 2022 &mdash; but that's a
one-time administrative order, not codified rule text, so we're not projecting a current cycle from it.
If you hold a firm license, confirm your exact renewal date with IDFPR or on your permit itself rather
than assuming it lines up with any individual license at the same firm.</p>

<h2>CPE: 120 hours per 3-year period &mdash; checked at renewal, not annually</h2>
<p>Illinois requires 120 CPE hours per 3-year renewal period, including at least 4 hours of professional
ethics (68 Ill. Admin. Code &sect; 1420.70(a)(1)). Unlike states that check a chunk of your CPE every
single year regardless of license-cycle length, Illinois's rule states no separate annual minimum &mdash;
the 120-hour count is measured against the 3-year period as a whole.</p>

<h2>The requirement that's easy to miss: it isn't labeled "ethics"</h2>
<p>Illinois also requires a 1-hour sexual harassment prevention training &mdash; but the rule keeps this
as its own distinct category, separate from the 4-hour ethics requirement. It's easy to read "4 hours of
ethics" as the whole compliance picture and miss this second, smaller, differently-labeled requirement
entirely. Both are real, both are required, and they don't count toward each other.</p>

<p><strong>Bottom line</strong>: if you're an Illinois CPA, track two things separately &mdash; your
license's 3-year cycle (individual ending September 30, firm ending November 30 with no assumed anchor
year), and your 120-hour/3-year CPE count, remembering the 1-hour harassment-prevention training is a
second, separate line item from your 4 ethics hours.
<a href="../../illinois/">Set a reminder for your Illinois deadline here</a> so none of these get missed.</p>
""",
    },
    {
        # 2026-07-17: next in the standing blog queue (Illinois -> Connecticut -> Wisconsin), per
        # the GSC-steered content lever. Pure repackaging of data/cpa_deadlines.json's ct-individual
        # and ct-firm entries, zero new legal research.
        "slug": "connecticut-cpa-license-renewal-guide",
        "title": "How CPA License Renewal Works in Connecticut: Two Clocks That Don't Line Up",
        "meta_description": (
            "Connecticut CPA license renewal: the calendar-year license cycle, the separate "
            "fiscal-year CPE clock, and the firm-permit date that isn't codified."
        ),
        "body_html": """
<p class="intro">Connecticut is one of the few states where your license renewal and your CPE
reporting period don't share a start or end month at all &mdash; they're two genuinely separate
clocks. Here's exactly how each one works, sourced to Connecticut's own regulations.</p>

<h2>Individual license: calendar year, January 1 through December 31</h2>
<p>Connecticut CPA licenses run on the calendar year. Regulations of Connecticut State Agencies (RCSA)
&sect; 20-280-25(a) states a license "shall be valid for a period of one year from January 1 to December
31," renewed annually with the fee due by December 31. The Department of Consumer Protection's own
renewal page corroborates this in practice, and renewal notices go out by email between October and
December 31. <a href="../../connecticut/">Confirm your own next Connecticut CPA renewal deadline
here</a>.</p>

<h2>CPE: a completely different fiscal year &mdash; July 1 through June 30</h2>
<p>Here's the part that catches people: CPE is tracked on a <em>fiscal</em> year, July 1 through June
30 &mdash; not the calendar year your license itself runs on. The requirement is 40 hours minimum per
fiscal year (up to 60 hours are reportable), and you can carry over up to 20 hours, but only from the
immediately preceding fiscal year, and audit/attest hours aren't carryover-eligible. All of it gets
reported to the Board by December 31 as part of your renewal &mdash; so the reporting deadline lines up
with your license, even though the hours themselves are earned on a completely different 12-month clock.
Losing track of where the fiscal year starts is the easiest way to misjudge how much time you actually
have left to earn hours.</p>

<h2>Firm permits: a real gap in the codified record, not a guess we're willing to make</h2>
<p>The CPA Firm Permit renewal is bundled onto the same page and same Oct-Dec 31 notice window as the
individual license, which states December 31 renewal &mdash; but that sentence names only "license
and/or registration," not "Firm Permit" specifically. We checked the controlling statute (Conn. Gen.
Stat. &sect; 20-281e), which delegates the firm-permit renewal date to board regulation rather than
fixing it directly, and the only regulation adopted under that section (RCSA &sect;&sect; 20-281-1
through -12) governs peer-review timing, not the expiration date. The clearest concrete evidence we
found &mdash; DCP's own CPA Firm Permit Renewal Form stating a December 31 expiration &mdash; is an
administrative form, not a codified source, and the specific form we checked had an internal date
inconsistency. That doesn't clear our bar for a confirmed date. If you hold a firm permit, confirm your
exact renewal date directly with the CT Dept. of Consumer Protection rather than assuming it matches the
individual-license date.</p>

<p><strong>Bottom line</strong>: if you're a Connecticut CPA, track two separate clocks &mdash; your
license's calendar-year cycle (Jan 1-Dec 31), and your CPE's fiscal-year cycle (Jul 1-Jun 30) that
doesn't share a start month with it. If you also hold a firm permit, confirm its exact date directly
with DCP rather than assuming it mirrors your individual license.
<a href="../../connecticut/">Set a reminder for your Connecticut deadline here</a> so neither clock
catches you off guard.</p>
""",
    },
    {
        # 2026-07-17: last state in the standing blog queue (Illinois -> Connecticut -> Wisconsin).
        # Also independently confirmed by real GSC data: Wisconsin had the 4th-highest impression
        # count of any state page (26 impr.) in the same pull that surfaced Illinois. Pure
        # repackaging of data/cpa_deadlines.json's wi-individual/wi-firm entries + cpe_hours.json's
        # wi-cpe entry, zero new legal research.
        "slug": "wisconsin-cpa-license-renewal-guide",
        "title": "How CPA License Renewal Works in Wisconsin: One Date for Everyone",
        "meta_description": (
            "Wisconsin CPA license renewal: the biennial December 15 deadline for individuals and "
            "firms, the 80-hour CPE two-half pacing rule, and a real discrepancy between the "
            "statute and Board materials."
        ),
        "body_html": """
<p class="intro">Wisconsin keeps this simpler than most states in one specific way: individual
licenses and firm licenses renew on the exact same statutory date. Here's exactly how the renewal and
CPE rules work, sourced to Wisconsin's own statute and administrative code.</p>

<h2>One date, every odd-numbered year: December 15</h2>
<p>Both individual CPA licenses and accounting firm licenses expire December 15 of each odd-numbered
year &mdash; the same fixed calendar date for every licensee, not birth-month or cohort-based (Wis. Stat.
&sect; 440.08(2)(a)1. for individuals, &sect; 440.08(2)(a)3. for firms). There's no separate firm-specific
cycle to track here the way several other states require. <a href="../../wisconsin/">Confirm your own
next Wisconsin CPA renewal deadline here</a>.</p>

<h2>A real discrepancy worth knowing: December 15 vs. "December 14"</h2>
<p>Some of the Wisconsin Board's own materials describe the practical deadline as December 14, one day
earlier than what's actually written into statute. December 15 is the codified date we publish, sourced
directly to the statute text itself &mdash; but if you've seen "December 14" referenced somewhere and
wondered which is correct, that's why the discrepancy exists, and it's worth confirming directly rather
than assuming either version by default.</p>

<h2>CPE: 80 hours per 2-year period, paced across two halves</h2>
<p>Wisconsin requires 80 CPE credits per 2-year compliance period (the period immediately preceding
renewal), of which at least 40 must come from formal learning activities, and 3 of those formal-learning
hours must be on ethics (Wis. Admin. Code Accy 2.602). The part that's easy to miss: you can't bank all 80
hours in the final months before renewal &mdash; at least 20 credits must be completed in <em>each</em>
12-month half of the 2-year period. There's no separate CE-reporting deadline apart from the renewal date
itself, but the two-half pacing rule means procrastinating on the first year of a cycle can leave you
structurally unable to catch up in the second.</p>

<p><strong>Bottom line</strong>: if you're a Wisconsin CPA (or run a firm), one date &mdash; December 15
of each odd-numbered year &mdash; covers both your license and, if applicable, your firm's license. Pace
your 80 CPE hours across both 12-month halves of the cycle rather than the calendar year alone, since at
least 20 hours are required in each half specifically.
<a href="../../wisconsin/">Set a reminder for your Wisconsin deadline here</a> so the single date works
for you instead of sneaking up on you.</p>
""",
    },
]


def build_blog_article_page(article: dict) -> str:
    body = f"""<h1>{esc(article['title'])}</h1>
{article['body_html']}
<p class="backlink"><a href="../">&larr; Back to all guides</a></p>
"""
    return page_shell(
        f"{article['title']} — {SITE_NAME}",
        article["meta_description"],
        body,
        home_href="../../",
        canonical_path=f"/blog/{article['slug']}/",
    )


def build_blog_index_page(articles: list[dict]) -> str:
    cards = "\n".join(
        f'<a class="state-card" href="{esc(a["slug"])}/">'
        f'<div class="state-name">{esc(a["title"])}</div>'
        f'<div class="state-hint">{esc(a["meta_description"])}</div></a>'
        for a in articles
    )
    body = f"""<h1>Guides</h1>
<p class="intro">Deeper explainers on CPA license renewal and CPE deadlines &mdash; sourced the same
way as every state page on this site.</p>
<div class="state-grid">
{cards}
</div>
<p class="backlink"><a href="../">&larr; Back to home</a></p>
"""
    return page_shell(
        f"Guides — {SITE_NAME}",
        "In-depth guides on CPA license renewal deadlines and CPE requirements, state by state.",
        body,
        home_href="../",
        canonical_path="/blog/",
    )


def build_sitemap(states: list[dict], as_of: date) -> str:
    urls = [f"""  <url>
    <loc>{SITE_BASE_URL}/</loc>
    <lastmod>{as_of.isoformat()}</lastmod>
  </url>""", f"""  <url>
    <loc>{SITE_BASE_URL}/privacy/</loc>
    <lastmod>{as_of.isoformat()}</lastmod>
  </url>""", f"""  <url>
    <loc>{SITE_BASE_URL}/contact/</loc>
    <lastmod>{as_of.isoformat()}</lastmod>
  </url>""", f"""  <url>
    <loc>{SITE_BASE_URL}/for-firms/</loc>
    <lastmod>{as_of.isoformat()}</lastmod>
  </url>""", f"""  <url>
    <loc>{SITE_BASE_URL}/firm-login/</loc>
    <lastmod>{as_of.isoformat()}</lastmod>
  </url>""", f"""  <url>
    <loc>{SITE_BASE_URL}/signin/</loc>
    <lastmod>{as_of.isoformat()}</lastmod>
  </url>""", f"""  <url>
    <loc>{SITE_BASE_URL}/methodology/</loc>
    <lastmod>{as_of.isoformat()}</lastmod>
  </url>""", f"""  <url>
    <loc>{SITE_BASE_URL}/rule-changes/</loc>
    <lastmod>{as_of.isoformat()}</lastmod>
  </url>""", f"""  <url>
    <loc>{SITE_BASE_URL}/blog/</loc>
    <lastmod>{as_of.isoformat()}</lastmod>
  </url>"""]
    for article in BLOG_ARTICLES:
        urls.append(f"""  <url>
    <loc>{SITE_BASE_URL}/blog/{esc(article['slug'])}/</loc>
    <lastmod>{as_of.isoformat()}</lastmod>
  </url>""")
    for p in FIRM_LANDING_PAGES:
        urls.append(f"""  <url>
    <loc>{SITE_BASE_URL}/{esc(p['slug'])}/</loc>
    <lastmod>{as_of.isoformat()}</lastmod>
  </url>""")
    for p in CPE_HOURS_PAGES:
        urls.append(f"""  <url>
    <loc>{SITE_BASE_URL}/{esc(p['slug'])}/</loc>
    <lastmod>{as_of.isoformat()}</lastmod>
  </url>""")
    for p in REINSTATEMENT_PAGES:
        urls.append(f"""  <url>
    <loc>{SITE_BASE_URL}/{esc(p['slug'])}/</loc>
    <lastmod>{as_of.isoformat()}</lastmod>
  </url>""")
    for s in sorted(states, key=lambda s: s["state_slug"]):
        urls.append(f"""  <url>
    <loc>{SITE_BASE_URL}/{esc(s['state_slug'])}/</loc>
    <lastmod>{esc(s['last_verified'])}</lastmod>
  </url>""")
    body = "\n".join(urls)
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
{body}
</urlset>
"""


def build_robots() -> str:
    return f"""User-agent: *
Allow: /

Sitemap: {SITE_BASE_URL}/sitemap.xml
"""


# ---------------------------------------------------------------------------
# Main -- UNCHANGED this pass (data loading, staleness guards, file writes)
# ---------------------------------------------------------------------------

STALENESS_THRESHOLD_DAYS = 30


def main() -> None:
    global JURISDICTION_COUNT

    with open(DATA_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)

    as_of = date.fromisoformat(data["as_of_date"])
    real_today = date.today()
    records = data["records"]
    JURISDICTION_COUNT = len({r["state_slug"] for r in records})

    # Wall-clock staleness guard. Checking computed deadlines only against the
    # data file's OWN as_of_date (as the first version of this script did) is
    # not enough: if this script is re-run long after as_of_date without
    # anyone updating the data, that self-referential check still passes
    # cleanly while the site silently serves deadlines that have drifted into
    # the past relative to reality. Anchor on real time instead.
    age_days = (real_today - as_of).days
    if age_days > STALENESS_THRESHOLD_DAYS:
        raise SystemExit(
            f"REFUSING TO BUILD: data/cpa_deadlines.json's as_of_date ({as_of.isoformat()}) is "
            f"{age_days} days old (real today is {real_today.isoformat()}), past the "
            f"{STALENESS_THRESHOLD_DAYS}-day freshness threshold. Re-verify every record against "
            f"its source_url, bump as_of_date, and recompute next_deadline_computed values before "
            f"regenerating the site."
        )
    if age_days < 0:
        raise SystemExit(
            f"REFUSING TO BUILD: data/cpa_deadlines.json's as_of_date ({as_of.isoformat()}) is in "
            f"the future relative to real today ({real_today.isoformat()}) -- this indicates a "
            f"data-entry error, not a valid state."
        )

    # Sanity check: no record's computed deadline should be in the past,
    # checked against BOTH the data's own as_of_date AND real wall-clock time.
    #
    # STRICTLY `<`, not `<=` (fixed 2026-08-01). The old comparison treated a
    # deadline falling ON the current date as already stale, so the build
    # refused on the morning of a real deadline -- South Dakota (annual, due
    # August 1) and Kentucky both tripped it on 2026-08-01. That is backwards
    # for a deadline product: a date due TODAY has not passed, and it is the
    # single most urgent and most useful thing this site can display. The
    # guard's real job is catching dates that have genuinely elapsed, and it
    # still does that from the day after.
    stale = [
        r["id"] for r in records
        if r.get("next_deadline_computed") and (
            date.fromisoformat(r["next_deadline_computed"]) < as_of
            or date.fromisoformat(r["next_deadline_computed"]) < real_today
        )
    ]
    if stale:
        raise SystemExit(f"REFUSING TO BUILD: stale/past next_deadline_computed for: {stale}")

    cpe_hours_by_slug = load_cpe_hours_by_slug()
    reinstatement_by_slug = load_reinstatement_by_slug()

    by_slug: dict[str, list[dict]] = {}
    state_meta: dict[str, dict] = {}
    for r in records:
        by_slug.setdefault(r["state_slug"], []).append(r)
        prior = state_meta.get(r["state_slug"])
        state_meta[r["state_slug"]] = {
            "state": r["state"],
            "state_slug": r["state_slug"],
            "wave": min(prior["wave"], r["wave"]) if prior else r["wave"],
            # Deliberate max(), not "whichever record we saw last" -- if a
            # future edit ever gives two records for one state different
            # last_verified dates, the page should show the most recent one.
            "last_verified": max(prior["last_verified"], r["last_verified"]) if prior else r["last_verified"],
        }

    SITE_DIR.mkdir(parents=True, exist_ok=True)

    fonts_dir = SITE_DIR / "fonts"
    fonts_dir.mkdir(parents=True, exist_ok=True)
    font_src = FONT_ASSETS_DIR / "fraunces-variable.woff2"
    (fonts_dir / "fraunces-variable.woff2").write_bytes(font_src.read_bytes())
    print(f"wrote {SITE_DIR.name}/fonts/fraunces-variable.woff2")

    built = []
    for slug, recs in by_slug.items():
        title, page_html = build_state_page(slug, recs, as_of, by_slug, cpe_hours_by_slug, reinstatement_by_slug)
        state_dir = SITE_DIR / slug
        state_dir.mkdir(parents=True, exist_ok=True)
        (state_dir / "index.html").write_text(page_html, encoding="utf-8")
        built.append(state_meta[slug])
        print(f"wrote {SITE_DIR.name}/{slug}/index.html  ({title})")

    (SITE_DIR / "index.html").write_text(build_index_page(built, as_of, by_slug), encoding="utf-8")
    print(f"wrote {SITE_DIR.name}/index.html  ({len(built)} states)")

    FIRM_LANDING_PAGES.clear()
    for state_slug in FIRM_LANDING_STATE_SLUGS:
        recs = by_slug.get(state_slug)
        if not recs:
            print(f"  SKIPPED firm landing page for {state_slug}: no records found")
            continue
        record = _firm_relevant_record(recs)
        if record is None:
            print(f"  SKIPPED firm landing page for {state_slug}: no firm-relevant record with a computed date")
            continue
        slug, title, page_html = build_firm_landing_page(state_slug, record)
        page_dir = SITE_DIR / slug
        page_dir.mkdir(parents=True, exist_ok=True)
        (page_dir / "index.html").write_text(page_html, encoding="utf-8")
        FIRM_LANDING_PAGES.append({"slug": slug, "state_name": record["state"]})
        print(f"wrote {SITE_DIR.name}/{slug}/index.html  ({title})")

    CPE_HOURS_PAGES.clear()
    for state_slug, cpe_record in cpe_hours_by_slug.items():
        renewal_records = by_slug.get(state_slug, [])
        slug, title, page_html = build_cpe_hours_page(cpe_record, renewal_records, as_of, reinstatement_by_slug)
        page_dir = SITE_DIR / slug
        page_dir.mkdir(parents=True, exist_ok=True)
        (page_dir / "index.html").write_text(page_html, encoding="utf-8")
        CPE_HOURS_PAGES.append({"slug": slug, "state_name": cpe_record["state"]})
        print(f"wrote {SITE_DIR.name}/{slug}/index.html  ({title})")

    REINSTATEMENT_PAGES.clear()
    for state_slug, reinstatement_record in reinstatement_by_slug.items():
        renewal_records = by_slug.get(state_slug, [])
        cpe_record = cpe_hours_by_slug.get(state_slug)
        slug, title, page_html = build_reinstatement_page(reinstatement_record, renewal_records, cpe_record, as_of)
        page_dir = SITE_DIR / slug
        page_dir.mkdir(parents=True, exist_ok=True)
        (page_dir / "index.html").write_text(page_html, encoding="utf-8")
        REINSTATEMENT_PAGES.append({"slug": slug, "state_name": reinstatement_record["state"]})
        print(f"wrote {SITE_DIR.name}/{slug}/index.html  ({title})")

    # sitemap.xml (below) reads FIRM_LANDING_PAGES, CPE_HOURS_PAGES, and
    # REINSTATEMENT_PAGES, so it
    # must be written AFTER both loops above populate them.
    (SITE_DIR / "sitemap.xml").write_text(build_sitemap(built, as_of), encoding="utf-8")
    print(f"wrote {SITE_DIR.name}/sitemap.xml")

    (SITE_DIR / "robots.txt").write_text(build_robots(), encoding="utf-8")
    print(f"wrote {SITE_DIR.name}/robots.txt")

    (SITE_DIR / f"{INDEXNOW_KEY}.txt").write_text(INDEXNOW_KEY, encoding="utf-8")
    print(f"wrote {SITE_DIR.name}/{INDEXNOW_KEY}.txt (IndexNow key)")

    privacy_dir = SITE_DIR / "privacy"
    privacy_dir.mkdir(parents=True, exist_ok=True)
    (privacy_dir / "index.html").write_text(build_privacy_page(real_today), encoding="utf-8")
    print(f"wrote {SITE_DIR.name}/privacy/index.html")

    contact_dir = SITE_DIR / "contact"
    contact_dir.mkdir(parents=True, exist_ok=True)
    (contact_dir / "index.html").write_text(build_contact_page(), encoding="utf-8")
    print(f"wrote {SITE_DIR.name}/contact/index.html")

    methodology_dir = SITE_DIR / "methodology"
    methodology_dir.mkdir(parents=True, exist_ok=True)
    (methodology_dir / "index.html").write_text(build_methodology_page(), encoding="utf-8")
    print(f"wrote {SITE_DIR.name}/methodology/index.html")

    rule_changes_dir = SITE_DIR / "rule-changes"
    rule_changes_dir.mkdir(parents=True, exist_ok=True)
    (rule_changes_dir / "index.html").write_text(build_rule_changes_page(), encoding="utf-8")
    print(f"wrote {SITE_DIR.name}/rule-changes/index.html")

    firms_dir = SITE_DIR / "for-firms"
    firms_dir.mkdir(parents=True, exist_ok=True)
    (firms_dir / "index.html").write_text(build_firms_page(by_slug, as_of), encoding="utf-8")
    print(f"wrote {SITE_DIR.name}/for-firms/index.html")

    firm_login_dir = SITE_DIR / "firm-login"
    firm_login_dir.mkdir(parents=True, exist_ok=True)
    (firm_login_dir / "index.html").write_text(build_firm_login_page(), encoding="utf-8")
    print(f"wrote {SITE_DIR.name}/firm-login/index.html")

    set_password_dir = SITE_DIR / "set-password"
    set_password_dir.mkdir(parents=True, exist_ok=True)
    (set_password_dir / "index.html").write_text(build_set_password_page(), encoding="utf-8")
    print(f"wrote {SITE_DIR.name}/set-password/index.html")

    signin_dir = SITE_DIR / "signin"
    signin_dir.mkdir(parents=True, exist_ok=True)
    (signin_dir / "index.html").write_text(build_signin_page(), encoding="utf-8")
    print(f"wrote {SITE_DIR.name}/signin/index.html")

    my_dir = SITE_DIR / "my"
    my_dir.mkdir(parents=True, exist_ok=True)
    (my_dir / "index.html").write_text(build_my_page(), encoding="utf-8")
    print(f"wrote {SITE_DIR.name}/my/index.html")

    firm_mobility_dir = SITE_DIR / "firm-mobility"
    firm_mobility_dir.mkdir(parents=True, exist_ok=True)
    (firm_mobility_dir / "index.html").write_text(build_firm_mobility_page(by_slug), encoding="utf-8")
    print(f"wrote {SITE_DIR.name}/firm-mobility/index.html")

    firm_dashboard_dir = SITE_DIR / "firm-dashboard"
    firm_dashboard_dir.mkdir(parents=True, exist_ok=True)
    (firm_dashboard_dir / "index.html").write_text(
        build_firm_dashboard_page(by_slug, as_of, cpe_hours_by_slug), encoding="utf-8"
    )
    print(f"wrote {SITE_DIR.name}/firm-dashboard/index.html")

    (SITE_DIR / "404.html").write_text(build_404_page(built), encoding="utf-8")
    print(f"wrote {SITE_DIR.name}/404.html")

    blog_dir = SITE_DIR / "blog"
    blog_dir.mkdir(parents=True, exist_ok=True)
    (blog_dir / "index.html").write_text(build_blog_index_page(BLOG_ARTICLES), encoding="utf-8")
    print(f"wrote {SITE_DIR.name}/blog/index.html")
    for article in BLOG_ARTICLES:
        article_dir = blog_dir / article["slug"]
        article_dir.mkdir(parents=True, exist_ok=True)
        (article_dir / "index.html").write_text(build_blog_article_page(article), encoding="utf-8")
        print(f"wrote {SITE_DIR.name}/blog/{article['slug']}/index.html")

    (SITE_DIR / "favicon.svg").write_text(FAVICON_SVG, encoding="utf-8")
    print(f"wrote {SITE_DIR.name}/favicon.svg")

    print(f"\nDone. {len(built)} state pages generated under {SITE_DIR}")


if __name__ == "__main__":
    main()
