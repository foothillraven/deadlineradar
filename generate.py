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
# "docs" (not "site") deliberately -- this is the zero-config GitHub Pages
# convention (Settings > Pages > Deploy from a branch > /docs), so this
# directory becomes the deploy target as-is once a repo + Pages source exist.
# No repo/Pages source exists yet -- this only prepares the file structure.
SITE_DIR = ROOT / "docs"

# Self-hosted display font (2026-07-10 visual-trust redesign). Copied verbatim into
# docs/fonts/ at build time, referenced by an absolute /fonts/... URL in PAGE_CSS so
# every page shares one cached file instead of each page embedding its own copy --
# see assets/fonts/LICENSE.txt for the font's license (SIL OFL, embedding permitted).
FONT_ASSETS_DIR = ROOT / "assets" / "fonts"

# Placeholder only. No domain has been purchased, nothing here is deployed yet.
# Swap this single constant for the real https://<user>.github.io/<repo> URL
# (or a real domain later) once publishing is explicitly decided -- do not
# hardcode a real URL before that.
SITE_BASE_URL = "https://deadline-radar.com"

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

# Reminder backend (worker/, the Phase-1 Cloudflare Worker -- see
# worker/DEPLOY.md). Same-origin relative path, not a separate domain: the
# Worker is bound to the deadline-radar.com/api/* Route, so the form posts
# to the same site it's served from. STAGED ONLY -- per the Phase-1
# directive, this change is committed locally but deliberately NOT pushed
# until AFTER the Worker is deployed and verified responding (worker/
# DEPLOY.md step 6); pushing before that would point the live, public
# signup form at a route that doesn't exist yet.
REMINDER_BACKEND_BASE_URL = "/api"

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


def esc(s: str) -> str:
    return html.escape(str(s), quote=True)


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
    /* Tokens match the Devin-approved concept (deadlineradar_concept_v1_APPROVED.html) exactly. */
    --bg: #f7f9fb; --page-bg: #f7f9fb; --fg: #17212b; --muted: #5a6b7a; --faint: #8595a3;
    --border: #e0e6ec; --border-strong: #c8d2db;
    --accent: #1f3d54; --accent-deep: #152c3e; --accent-bg: #eaeef1; --card-bg: #ffffff;
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
      --bg: #12151a; --page-bg: #12151a; --fg: #e7ebf0; --muted: #9aa5b1; --faint: #6f7a86;
      --border: #2a323c; --border-strong: #3a4552;
      --accent: #7fa8d9; --accent-deep: #9cc0ea; --accent-bg: #1b2836; --card-bg: #1a1f26;
      --panel-dark: #0d1824; --panel-dark-fg: #dbe6ef;
      --gold: #d6b45a; --gold-line: #8a6d1f; --gold-bg: #26210f;
      --verified-green: #4fd685; --verified-green-bg: rgba(52,199,120,0.12);
      --trust-bg: #26210f; --trust-border: #5a4a20; --row-alt: #171b21;
      --map-fixed: #2c4a72; --map-fixed-hover: #7fb0ff;
      --map-variable: #262b32; --map-variable-hover: #545e6c;
    }
  }
  * { box-sizing: border-box; }
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
  th { background: var(--accent); color: #eaf1f7; font-weight: 700; }
  tbody tr:nth-child(even) { background: var(--row-alt); }
  tbody tr:last-child td { border-bottom: none; }
  .trust-line {
    border: 1px solid var(--trust-border); background: var(--trust-bg); border-radius: 8px;
    padding: 0.9rem 1.1rem; margin: 1.75rem 0; font-size: 0.92rem;
  }
  .trust-line strong::before { content: "\\2713\\a0"; color: var(--gold); }

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
  .frow {
    display: grid; grid-template-columns: 1fr auto; gap: 0.35rem 1.4rem;
    padding: 1.1rem 1.2rem; border-top: 1px solid var(--border);
  }
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
  .cite {
    display: inline-flex; align-items: center; gap: 0.4rem; font-family: var(--font-mono); font-size: 0.78rem;
    color: var(--gold); background: var(--gold-bg); border: 1px solid var(--gold-line); border-radius: 6px;
    padding: 0.25rem 0.55rem; text-decoration: none; white-space: nowrap;
  }
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
    border: 0; background: var(--accent); color: #fff; font-weight: 600; font-size: 0.92rem;
    padding: 0 1.3rem; cursor: pointer; font-family: inherit;
  }
  .lookup-field button:hover { background: var(--accent-deep); }
  .lookup-hint { margin-top: 0.6rem; font-size: 0.8rem; color: var(--faint); }
  .trust-row {
    display: flex; flex-wrap: wrap; gap: 0.8rem 1.8rem; margin: 1.8rem 0 2.2rem; padding-top: 1.4rem;
    border-top: 1px solid var(--border);
  }
  .trust-row .item { display: flex; align-items: baseline; gap: 0.5rem; }
  .trust-row .n { font-family: var(--font-display); font-size: 1.3rem; font-weight: 600; color: var(--accent); font-variant-numeric: tabular-nums; }
  .trust-row .lbl { font-size: 0.8rem; color: var(--muted); max-width: 22ch; line-height: 1.35; }

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
  .hfc-pips { display: flex; gap: 0.4rem; justify-content: center; margin-top: 0.55rem; }
  .hfc-pip {
    width: 0.45rem; height: 0.45rem; border-radius: 50%; border: 0; padding: 0; cursor: pointer;
    background: var(--border-strong);
  }
  .hfc-pip.is-active { background: var(--accent); }
  @media (prefers-reduced-motion: reduce) {
    .hfc-card { transition: none; }
    .hfc-pips { display: none; }
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
  .remind-panel button {
    margin-top: 0.3rem; background: var(--gold); color: #22190a; border: 0; font-weight: 700;
    font-size: 0.92rem; padding: 0.7rem; border-radius: 7px; cursor: pointer; font-family: inherit;
  }
  .remind-panel button:hover { background: #9c7a3c; }
  .remind-panel .field-hint { color: #8fa7bb; }
  .cpe-affiliate {
    border: 1px solid var(--border); border-radius: 8px; padding: 1rem 1.25rem;
    background: var(--card-bg); margin: 1.4rem 0; font-size: 0.92rem;
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
    color: #fff; font-size: 0.92rem; font-weight: 600; cursor: pointer; flex: 0 0 auto;
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
  .state-search-option:hover, .state-search-option.is-active { background: var(--accent); color: #fff; }
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
    background: var(--accent); color: #fff; font-size: 0.95rem; font-weight: 700; cursor: pointer;
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
"""


_BRAND_GLYPH_SVG = """<svg class="brand-glyph" viewBox="0 0 32 32" fill="none" aria-hidden="true" width="26" height="26">
  <circle cx="16" cy="16" r="13.5" stroke="#1f3d54" stroke-width="1.6"/>
  <circle cx="16" cy="16" r="8" stroke="#c8d2db" stroke-width="1.2"/>
  <circle cx="16" cy="16" r="2.3" fill="#8a6a33"/>
  <path d="M16 16 L26 9" stroke="#8a6a33" stroke-width="1.8" stroke-linecap="round"/>
  <path d="M16 3.5 L16 6" stroke="#1f3d54" stroke-width="1.6" stroke-linecap="round"/>
</svg>"""


def site_header(home_href: str) -> str:
    return f"""<nav class="mainnav">
  <div class="nav-inner wrap">
    <a href="{esc(home_href)}" style="display:flex; align-items:center; gap:0.5rem; text-decoration:none; padding:0.7rem 0;">
      {_BRAND_GLYPH_SVG}
      <span class="wordmark">{esc(SITE_NAME)}</span>
    </a>
    <div class="nav-links">
      <a href="/">Browse States</a>
      <a href="/methodology/">How We Verify</a>
      <a href="/for-firms/">For Firms</a>
      <a href="/contact/">Contact</a>
      <a href="#remind" class="cta">Get reminders</a>
    </div>
  </div>
</nav>
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
      <a href="/">All 51 jurisdictions</a>
      <a href="/methodology/">How We Verify</a>
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

_HONEYPOT_HTML = (
    f'<div aria-hidden="true" style="position:absolute;left:-9999px;top:-9999px;'
    f'height:0;width:0;overflow:hidden;">'
    f'<label for="{_HONEYPOT_FIELD_NAME}">Leave this field blank</label>'
    f'<input type="text" id="{_HONEYPOT_FIELD_NAME}" name="{_HONEYPOT_FIELD_NAME}" '
    f'tabindex="-1" autocomplete="off">'
    f'</div>'
)

if TURNSTILE_SITE_KEY:
    # Real widget. Cloudflare's api.js (loaded in <head> by _turnstile_head_html)
    # renders this div and injects the hidden `cf-turnstile-response` token input
    # inside it on solve, which then submits with the form.
    _BOT_DEFENSE_FIELDS_HTML = (
        _HONEYPOT_HTML + "\n"
        f'    <div class="cf-turnstile" data-sitekey="{esc(TURNSTILE_SITE_KEY)}"></div>'
    )
else:
    _BOT_DEFENSE_FIELDS_HTML = (
        _HONEYPOT_HTML + "\n"
        f'    <!-- Turnstile reserved: set TURNSTILE_SITE_KEY (+ the Worker secret) to activate. '
        f'Empty/absent is treated as "not configured yet," not as a failed check. -->\n'
        f'    <input type="hidden" name="cf-turnstile-response" value="">'
    )


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
    all_slugs = sorted(by_slug)
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
<style>
{PAGE_CSS}
</style>
</head>
<body>
{site_header(home_href)}
{body}
{site_footer()}
</body>
</html>
"""


def trust_line(last_verified: str, source_url: str) -> str:
    return f"""<div class="trust-line">
  <strong>Last verified: {esc(last_verified)}</strong> &middot; checked against the state's codified
  statute or administrative rule, not just a board webpage &mdash; if we can't verify a date against
  primary law, we say so instead of guessing (<a href="/methodology/">see how we verify every
  deadline</a>). Always confirm with the
  <a href="{esc(source_url)}">official state board</a> before relying on this date. License
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
  <p><strong>Need CPE hours before your deadline?</strong> <a href="{esc(url)}">{esc(name)}</a>
  {esc(blurb)}.{note_html}</p>
  {_affiliate_disclosure_html()}
</div>"""


def _cpe_affiliate_html() -> str:
    """Renders every CPE-provider block that currently has a real (non-placeholder)
    tracked URL -- each provider is independently gated (see _cpe_provider_html()), so
    Illumeo can go live without Becker or vice versa. Once any provider is active, its
    block renders on every state page, always paired with its own FTC disclosure."""
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
    ]
    return "\n".join(b for b in blocks if b)


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
    return f"""<div class="source-cite">
  <span class="cite-label">Source of record</span>
  <span class="cite-stamp">{esc(citation)}</span>
  <a href="{esc(link_url)}" class="cite-link">read the rule &rarr;</a>
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
        f'<a class="cite" href="{esc(record["citation_url"])}" title="{esc(citation)}">{_CITE_ICON_SVG}'
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
        verified_line = (
            f'<div class="verified">{_VERIFIED_ICON_SVG}Confirmed at source</div>' if has_citation else ""
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
      <div class="side">
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
      <div class="side">
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
<a href="{esc(record['source_url'])}">Accountancy Board of Ohio lookup</a> will show your
assigned group.</p>"""


def render_cohort_group_record(record: dict) -> str:
    """Generic cohort-group table for any non-Ohio state with cohort_groups (e.g. Oregon/Kentucky's
    permit- or license-number-parity split) -- same table shape as render_ohio() but state-agnostic:
    accepts either an explicit `years` list (Ohio's shape) or a plain-English `deadline_pattern`
    string (Oregon/Kentucky's shape) per cohort group."""
    def years_cell(g: dict) -> str:
        if "years" in g:
            return ", ".join(str(y) for y in g["years"])
        return esc(g.get("deadline_pattern", ""))

    rows = "\n".join(
        f"<tr><td>{esc(g['group'])}</td><td>{years_cell(g)}</td>"
        f"<td><strong>{esc(fmt_date(date.fromisoformat(g['next_deadline'])))}</strong></td></tr>"
        for g in record["cohort_groups"]
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
<p>Not sure which group applies to you? Your license certificate or the
<a href="{esc(record['source_url'])}">official source above</a> will show your assigned group.</p>"""


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
  <a href="{esc(record['source_url'])}">NYSED Office of the Professions</a>.</p>
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
    cpe_hours_by_slug: dict[str, dict] | None = None,
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
        if title_year is not None:
            title = f"{state_name} CPA License Renewal Deadline {title_year}"
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
    body = f"""<h1>{esc(title)}</h1>
<p class="subhead">{esc(state_name)} CPA license renewal</p>
{deadline_html}
{trust_line(last_verified, source_url)}
{signup_form_for_state(state_slug, state_name, records, as_of)}
{_cpe_affiliate_html()}
{related_html}
{cpe_hours_link_html}
<p class="backlink"><a href="../">&larr; Back to all states</a></p>
"""
    json_ld = [_breadcrumb_schema(state_name, state_slug)]
    return title, page_shell(
        title, meta_description, body, home_href="../", canonical_path=f"/{state_slug}/",
        json_ld=json_ld,
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


# Hero rotating verified-fact card (2026-07-17, orchestrator/Devin-approved spec): a slow
# ~5s cross-fade through real fresh-verified states, pausing on hover, and collapsing to a
# single static card (no interval at all) under prefers-reduced-motion -- checked once at
# start, not re-evaluated live, since a mid-rotation motion-preference flip is an edge case
# not worth the complexity.
_HERO_ROTATION_JS = """
(function() {
  var wrap = document.getElementById('hfc-wrap');
  var pipsWrap = document.getElementById('hfc-pips');
  if (!wrap) return;
  var cards = wrap.querySelectorAll('.hfc-card');
  var pips = pipsWrap ? pipsWrap.querySelectorAll('.hfc-pip') : [];
  if (cards.length < 2) return;
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduceMotion) return;
  var current = 0;
  var timer = null;
  function activate(i) {
    cards[current].classList.remove('is-active');
    if (pips[current]) pips[current].classList.remove('is-active');
    current = i;
    cards[current].classList.add('is-active');
    if (pips[current]) pips[current].classList.add('is-active');
  }
  function next() { activate((current + 1) % cards.length); }
  function start() { timer = setInterval(next, 5000); }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }
  pips.forEach(function(pip, i) {
    pip.addEventListener('click', function() { activate(i); stop(); start(); });
  });
  wrap.addEventListener('mouseenter', stop);
  wrap.addEventListener('mouseleave', start);
  wrap.addEventListener('focusin', stop);
  wrap.addEventListener('focusout', start);
  start();
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


def build_index_page(states: list[dict], as_of: date, by_slug: dict[str, list[dict]]) -> str:
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
            active = " is-active" if i == 0 else ""
            hfc_cards.append(f"""<div class="hfc-card{active}" data-hfc-index="{i}">
  <div class="hfc-state">{esc(r['state'])}</div>
  <div class="hfc-stamp"><span class="dot"></span>Verified {esc(r['last_verified'])}</div>
  <div class="hfc-date">{esc(fmt_date(d))}</div>
  <div class="hfc-sub">{esc(r['license_type_label'])}</div>
  {_cite_chip_html(r, max_chars=44)}
  <div class="verified">{_VERIFIED_ICON_SVG}Confirmed at source</div>
</div>""")
        pips = "\n".join(
            f'<button type="button" class="hfc-pip{" is-active" if i == 0 else ""}" '
            f'data-hfc-pip="{i}" aria-label="Show {esc(r["state"])}"></button>'
            for i, r in enumerate(rotation_pool)
        )
        hero_right_html = f"""<div class="hero-right">
  <div class="hfc-wrap" id="hfc-wrap">
    {chr(10).join(hfc_cards)}
  </div>
  <div class="hfc-coverage">Verified &middot; <b>{total_fresh}</b> of {len(states)} states</div>
  <div class="hfc-pips" id="hfc-pips">
    {pips}
  </div>
</div>
<script>{_HERO_ROTATION_JS}</script>"""

    hero_html = f"""<div class="hero-grid">
<div class="hero-left">
  <p class="eyebrow">CPA license renewal &amp; CPE deadlines</p>
  <h1>Know exactly when your license is due &mdash;<br>
  <span class="hero-accent">and see the rule that says so.</span></h1>
  <p class="hero-lede">Every renewal date on DeadlineRadar is traced to your state board's statute or
  administrative rule, checked against the primary source, and stamped with the date we last verified
  it. No guesswork. {esc(SITE_NAME)} is built for CPAs, firm administrators, and anyone who just needs
  to know when their license is due.</p>
{search_html}
  <div class="trust-row">
    <div class="item"><span class="n">{len(states)}</span><span class="lbl">jurisdictions, each on its own verified fact sheet</span></div>
    <div class="item"><span class="n">Every date</span><span class="lbl">cited to a statute or board rule &mdash; not just a webpage</span></div>
    <div class="item"><span class="n">{citation_count}</span><span class="lbl">codified citations tracked and kept current</span></div>
  </div>
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

    body = f"""{hero_html}
{demo_html}
{build_us_map_html(by_slug)}
<div class="state-grid state-grid--mobile-fallback">
{chr(10).join(cards)}
</div>
{method_band_html}
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
    ("Alex R.", "georgia", "individual", "Confirmed"),
    ("Jordan M.", "alabama", "all", "Confirmed"),
    ("Sam K.", "illinois", "individual", "Pending"),
    ("Taylor B.", "missouri", "individual", "Needs attention"),
    ("Morgan P. — Firm Registration", "louisiana", "firm", "Confirmed"),
    ("Casey T. — Firm Registration", "missouri", "firm", "Confirmed"),
]

_MOCKUP_STATUS_CLASS = {
    "Confirmed": "mock-status--ok",
    "Pending": "mock-status--pending",
    "Needs attention": "mock-status--risk",
}


def _mockup_record(by_slug: dict[str, list[dict]], state_slug: str, license_type: str) -> dict | None:
    for r in by_slug.get(state_slug, []):
        if r.get("license_type") == license_type and r.get("next_deadline_computed"):
            return r
    return None


def _firm_dashboard_mockup_html(by_slug: dict[str, list[dict]]) -> str:
    """A labeled, illustrative dashboard mockup -- NOT a screenshot of a real product (none
    exists yet) and NOT a real firm's data (every name is a fictional example, same honest
    convention PE License Pro's own marketing mockup uses ("Cardinal Engineering Group") and CE
    Broker's uses. Explicitly captioned as an example so this can never be mistaken for a claim
    that a real customer exists. Every date shown is real, current, computed from
    cpa_deadlines.json -- only the names and the roster grouping are invented."""
    rows = []
    for name, state_slug, license_type, status in _FIRM_MOCKUP_ROSTER:
        record = _mockup_record(by_slug, state_slug, license_type)
        if record is None:
            continue
        date_label = fmt_date(date.fromisoformat(record["next_deadline_computed"]))
        status_class = _MOCKUP_STATUS_CLASS.get(status, "mock-status--ok")
        rows.append(f"""<tr>
  <td>{esc(name)}</td>
  <td>{esc(record['state'])}</td>
  <td><span class="mock-status {status_class}">{esc(status)}</span></td>
  <td>{esc(date_label)}</td>
</tr>""")
    if not rows:
        return ""
    return f"""<div class="mock-dashboard">
  <div class="mock-chrome">
    <span class="mock-dot"></span><span class="mock-dot"></span><span class="mock-dot"></span>
    <span class="mock-url">deadline-radar.com/firm/example</span>
  </div>
  <div class="mock-body">
    <div class="mock-firm-name">Example Firm, LLC <span class="mock-firm-count">&middot; 6 staff</span></div>
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
<p class="mock-caption">Illustrative example &mdash; not a real firm. Dates shown are the actual
current deadlines for these states, computed the same way as every free page on this site.</p>"""


_FIRM_FAQ = [
    (
        "Is the license status actually verified, or just self-reported?",
        "Verified. At onboarding and every admin update cycle, we manually check each staff "
        "member's status against the state board or CPAverify.org &mdash; a real human lookup, "
        "not scraped or automated, and not just whatever the licensee tells us.",
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


def build_firms_page(by_slug: dict[str, list[dict]]) -> str:
    """B2B firm-tier landing page. Explicit price + a real inbound CTA -- still no
    Stripe/live payment infra (2026-07-10 Wave-1 directive: CTA action stays the
    existing mailto/inbound flow; billing swaps to a real checkout link the moment
    payment infra exists, not before). Scoped deliberately to license-renewal
    tracking only, matching the free tier's trust model; any future CPE-hour
    tracking must be labeled as an unverified self-report, never given the same
    certainty language as the sourced renewal dates -- that distinction is the
    entire brand and must not blur on the paid tier."""
    pilot_mailto = (
        f"mailto:{esc(CONTACT_EMAIL)}?subject=Firm%20tier%20pilot"
        f"&body=Firm%20name%3A%0AApprox.%20staff%20count%3A%0AState(s)%20licensed%20in%3A%0A"
    )
    body = f"""<h1>CPA License Tracking for Your Whole Firm</h1>
<p class="intro">Every accounting firm has someone who has to make sure every partner's and staff CPA's
license stays current &mdash; across however many states they're licensed in. One missed renewal slows
down engagements and creates real regulatory risk, and most firms track it today by spreadsheet.</p>

<h2>What you get</h2>
<p>A firm-wide view that answers what a spreadsheet can't: who's current, who's at risk, and who needs
to act before a deadline &mdash; for every staff CPA and the firm's own registration, sourced to the same
codified statute or rule we verify for every free state page on this site &mdash;
<a href="../methodology/">see exactly how we verify every deadline</a>. Any individual CPA can already
get free reminders on their own; what a firm gets here is the roster-level accountability view nobody's
personal inbox provides. Each staff member's license status is also manually verified against the state
board at onboarding and every admin update cycle &mdash; not just self-reported &mdash; so a lapsed or
expired license doesn't sit unnoticed until the next renewal deadline.</p>

{_firm_dashboard_mockup_html(by_slug)}

<p><strong>Scope, plainly stated:</strong> this tracks license <em>renewal dates</em> &mdash; the part we
can verify against actual state law, the same way we already do for individuals. It does not track CPE
hour completion. If we ever add that, it will be clearly labeled as your own self-reported log, not
independently verified &mdash; we won't blur it with the sourced renewal dates that are the whole reason to
trust this site.</p>

<h2>Pricing</h2>
<p><strong>$500/year flat for firms with up to 10 staff</strong>, about $50/seat/year above that.
Start with a <strong>free 30-day pilot &mdash; no card required</strong>.</p>
<div class="firm-cta">
<p><a href="{esc(pilot_mailto)}">Start your free 30-day pilot &rarr;</a></p>
<p class="disclosure">Say yes by email above and we'll follow up the same week with next steps.</p>
</div>

<h2>How a pilot actually works right now</h2>
<p>Honest about where we are: there's no self-serve signup or payment page yet. When you say yes, we
collect your staff roster and onboard each person through the same double opt-in signup every free
subscriber on this site already uses (each staff member confirms their own email &mdash; a real consent
step, not a firm admin subscribing colleagues who never agreed), then send your admin contact a status
update each cycle: who's confirmed, who's at risk, and any license flagged expired or lapsed during our
manual verification pass. Billing today is a simple invoice; a self-serve card-payment option is coming
soon.</p>

{_firm_landing_links_html()}

{_firm_faq_html()}

<h2>Questions first?</h2>
<p>Email us any time, no commitment:</p>
<p><a href="mailto:{esc(CONTACT_EMAIL)}?subject=Firm%20tier%20question">{esc(CONTACT_EMAIL)}</a></p>
"""
    return page_shell(
        f"For Firms — {SITE_NAME}",
        "CPA firm license tracking: $500/year flat for up to 10 staff, free 30-day pilot. "
        "Sourced to the same codified state law DeadlineRadar verifies for every state.",
        body,
        home_href="../",
        canonical_path="/for-firms/",
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
{trust_line(record['last_verified'], record['source_url'])}

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


def _every_n_years(n: int) -> str:
    """'every year' not 'every 1 year' -- the pluralization artifact the
    orchestrator's go-live review caught (2026-07-15). Used everywhere a CPE
    period gets rendered so this can't drift back out of sync per call site."""
    return "every year" if n == 1 else f"every {n} years"


def build_cpe_hours_page(cpe_record: dict, renewal_records: list[dict], as_of: date) -> tuple[str, str, str]:
    """CPE-hours-by-state page (2026-07-15 cluster). Flat sibling slug, same
    convention as build_firm_landing_page() -- e.g. /arizona-cpa-cpe-requirements/
    sits alongside /arizona/, not nested under it. Returns (slug, title, html),
    same shape as build_firm_landing_page() for the same reason: main() needs
    the slug to register it (sitemap, cross-links) without re-deriving it."""
    state_name = cpe_record["state"]
    slug = f"{cpe_record['state_slug']}-cpa-cpe-requirements"
    title = f"{state_name} CPA CPE Requirements: How Many Hours, By When"
    period_phrase = _every_n_years(cpe_record["period_years"])
    meta_description = (
        f"How many CPE hours does {state_name} require for CPAs, and by when? "
        f"{cpe_record['total_hours']} hours {period_phrase}, sourced to "
        f"{cpe_record['citation']}."
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

    body = f"""<h1>{esc(title)}</h1>
<p class="intro">How much continuing professional education a {esc(state_name)} CPA actually
needs &mdash; sourced the same way every fact on this site is: a board page plus the codified rule
itself, never a guess.</p>

<div class="callout">
  <span class="verified-badge">Verified</span>
  <div class="label">CPE Hour Requirement</div>
  <div class="date">{cpe_record['total_hours']} hours {period_phrase}</div>
  <ul>
    {annual_line}
    {ethics_line}
  </ul>
  {_source_cite_html(cpe_record)}
</div>

<p>{esc(cpe_record.get('notes', ''))}</p>

{_cpe_hours_signup_html(cpe_record, renewal_records, as_of)}

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
        canonical_path=f"/{slug}/", json_ld=json_ld,
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
            "A complete guide to Missouri CPA license renewal: the real renewal dates for "
            "individual licenses and firm permits, CPE requirements, fees, and what happens if you "
            "miss a deadline — sourced to the Missouri Board's own rules."
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
            "A complete guide to Arizona CPA license renewal: how the birth-month/parity cycle "
            "works, why firm registration runs on a separate clock, CPE timing, and what happens "
            "if you miss the deadline — sourced to Arizona's own statute and rule."
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
            "Some states renew every CPA license on one fixed date. Others compute your exact "
            "deadline from your own birth month or birth year. Here's the real difference, "
            "state by state, and why we ask instead of guess."
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
            "A complete guide to Illinois CPA license renewal: the 3-year individual and firm "
            "cycles, the 120-hour CPE requirement, and the separate sexual harassment prevention "
            "training rule — sourced to the Illinois Administrative Code."
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
            "A complete guide to Connecticut CPA license renewal: the calendar-year license cycle, "
            "the separate fiscal-year CPE clock, and the firm-permit date that isn't codified — "
            "sourced to Connecticut's own regulations."
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
            "A complete guide to Wisconsin CPA license renewal: the biennial December 15 deadline "
            "that applies to individuals and firms alike, the 80-hour CPE requirement's two-half "
            "pacing rule, and a real discrepancy between the statute and Board materials — sourced "
            "to Wisconsin's own statute and administrative code."
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
    <loc>{SITE_BASE_URL}/methodology/</loc>
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
    with open(DATA_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)

    as_of = date.fromisoformat(data["as_of_date"])
    real_today = date.today()
    records = data["records"]

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
    stale = [
        r["id"] for r in records
        if r.get("next_deadline_computed") and (
            date.fromisoformat(r["next_deadline_computed"]) <= as_of
            or date.fromisoformat(r["next_deadline_computed"]) <= real_today
        )
    ]
    if stale:
        raise SystemExit(f"REFUSING TO BUILD: stale/past next_deadline_computed for: {stale}")

    cpe_hours_by_slug = load_cpe_hours_by_slug()

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
        title, page_html = build_state_page(slug, recs, as_of, by_slug, cpe_hours_by_slug)
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
        slug, title, page_html = build_cpe_hours_page(cpe_record, renewal_records, as_of)
        page_dir = SITE_DIR / slug
        page_dir.mkdir(parents=True, exist_ok=True)
        (page_dir / "index.html").write_text(page_html, encoding="utf-8")
        CPE_HOURS_PAGES.append({"slug": slug, "state_name": cpe_record["state"]})
        print(f"wrote {SITE_DIR.name}/{slug}/index.html  ({title})")

    # sitemap.xml (below) reads FIRM_LANDING_PAGES and CPE_HOURS_PAGES, so it
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

    firms_dir = SITE_DIR / "for-firms"
    firms_dir.mkdir(parents=True, exist_ok=True)
    (firms_dir / "index.html").write_text(build_firms_page(by_slug), encoding="utf-8")
    print(f"wrote {SITE_DIR.name}/for-firms/index.html")

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
