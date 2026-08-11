#!/usr/bin/env python3
"""
DeadlineRadar -- CPA license renewal static site generator (LOCAL PROTOTYPE)

Reads data/cpa_deadlines.json (hand-verified, sourced 2026-07-03) and renders:
  - docs/[state-slug]/index.html   one page per state
  - docs/index.html                directory of all state pages
  - docs/sitemap.xml               XML sitemap (placeholder domain, no network calls)
  - docs/robots.txt                allow-all, points at the sitemap

Python stdlib only for the actual site logic. No network calls. No real domain.
No payment/Stripe code. This script proves the ingest -> normalize -> generate
pipeline; it is not a server.

Two BUILD-TIME-ONLY exceptions (2026-08-04, AuditLab LEAK-1): every shipped
<style>/<script> block gets its comments stripped before being written to
disk (see _strip_shipped_comments()) -- generate.py's own comments are
genuinely useful engineering documentation, but they were shipping verbatim
to every browser (746 internal name/finding-ID mentions across 183 public
pages). This needs `tinycss2` (pip, pure Python, already a plain dependency)
for CSS, and a real JS parser for JS -- a hand-rolled comment stripper is NOT
safe here, since this codebase's own escapeHtml() uses regex literals like
/[&<>"']/g, and correctly telling a comment apart from a regex literal or a
string containing '//' is exactly what a naive stripper gets wrong. Run via
`node scripts/js_tools/node_modules/terser/bin/terser` (pinned in
scripts/js_tools/package.json, `npm install` there once). Neither dependency
ships anywhere -- both only ever touch the generator's own output before it
is written to docs/.

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
import re
import subprocess
import tempfile
import urllib.parse
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
# Roadmap #49 (2026-08-07): hand-curated public changelog entries -- see
# build_changelog_page()'s own docstring for why this is NOT generated from
# raw git commit history.
CHANGELOG_DATA_PATH = ROOT / "data" / "changelog.json"
# AuditLab PROSE-1 (2026-08-07): per-guide fact-review registry -- see the
# file's own schema_note and scripts/guide_review_staleness_check.py.
GUIDE_REVIEWS_PATH = ROOT / "data" / "guide_reviews.json"
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
# Originally defaulted to EMPTY (no SSO buttons) deliberately, so a build
# never advertised a provider the deployed Worker had no credentials for --
# safe-by-default while Google SSO was still pre-production. Google SSO
# shipped and went live 2026-08-05 (commit 0f169ce8, GOOGLE_OAUTH_CLIENT_ID/
# SECRET set on both prod and preview), so the default flips to "google"
# here rather than staying an env-var-only opt-in: AUTH_SSO_SETUP.md itself
# flagged the old default as an error-prone footgun ("every future
# `python generate.py` run must include this flag... or the next unrelated
# regen will silently drop the button again") -- and it fired the very
# session it was written, a plain regen for an unrelated fix silently
# dropped the button. A future provider going live should get the same
# treatment: flip its own default once its secrets are confirmed live,
# rather than requiring DR_SSO_PROVIDERS to be remembered by hand forever.
SSO_PROVIDERS = [p.strip() for p in os.environ.get("DR_SSO_PROVIDERS", "google").split(",") if p.strip()]

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
    deadline.ts's `isStateComputable()` -- the DATA-derived half (below)
    can't drift, since both sides read the same JSON, but
    _WORKER_FIELD_COMPUTED_STATES above is a hardcoded literal duplicated
    in TypeScript and nothing enforced the two staying equal (AuditLab
    SYNC-1, 2026-08-09 -- an earlier version of this docstring claimed
    otherwise). preship_gate.py's check_field_computed_states_sync() is
    the actual enforcement now; add a state to BOTH sets together."""
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
    `parity` ('odd'/'even'), on or after `as_of` -- a date due today has not
    passed (AuditLab DEADLINE-1, matches the same "due today" principle
    documented near line 9916 below and mirrored in deadline.ts)."""
    y = as_of.year
    while True:
        year_is_target_parity = (y % 2 == 1) if parity == "odd" else (y % 2 == 0)
        if year_is_target_parity:
            d = date(y, month, month_last_day(y, month))
            if d >= as_of:
                return d
        y += 1


def next_annual_month_end(as_of: date, month: int) -> date:
    """Next date on the last day of `month`, on or after `as_of` (this year
    if it hasn't happened yet or is due today, else next year)."""
    d = date(as_of.year, month, month_last_day(as_of.year, month))
    if d < as_of:
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

# Roadmap #56 (2026-08-07): "Terms of Service version tracking per firm."
# build_terms_page()/build_privacy_page() were previously called with
# `real_today` -- the BUILD date, not the date the legal text actually last
# changed, so the "Last updated" line on both pages claimed a change every
# single day the site was regenerated, whether the wording moved or not.
# That's a real dishonesty bug on its own (this site's whole posture is
# "never claim more than what's true"), and it also made per-firm version
# tracking meaningless -- there was no stable identifier to record. These
# two constants are the real, git-verified dates each page's body text was
# last actually edited (`git log -S "def build_terms_page"` /
# "def build_privacy_page" -- confirmed no edits since). Bump BY HAND the
# day the wording actually changes; do not wire this to "today" again.
# worker/src/index.ts's TERMS_VERSION constant must be kept in sync with
# TERMS_LAST_CHANGED -- enforced by preship_gate.py's
# check_terms_version_sync().
TERMS_LAST_CHANGED = date(2026, 8, 5)
PRIVACY_LAST_CHANGED = date(2026, 8, 5)


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
  /* Hamburger nav (2026-08-06) -- below ~680px, 6 nav items wrapped onto
     2-3 stacked rows above the fold (.nav-links's own flex-wrap was the
     entire mobile strategy). Hidden by default; the media query below is
     the only place that shows it, so desktop never renders a dead button. */
  .nav-toggle {
    display: none; border: 1px solid var(--border-strong); background: var(--card-bg); color: var(--fg);
    border-radius: 6px; font-size: 1.15rem; line-height: 1; cursor: pointer; padding: 0.35rem 0.6rem;
  }
  @media (max-width: 680px) {
    .nav-toggle { display: block; }
    .nav-links {
      display: none; flex-direction: column; align-items: stretch; gap: 0;
      width: 100%; order: 3; border-top: 1px solid var(--border); margin-top: 0.5rem;
    }
    .nav-links.dr-nav-open { display: flex; }
    .nav-links a { padding: 0.75rem 0.1rem; border-bottom: 1px solid var(--border); }
  }
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
  /* Birth-month personalized finder (California/Texas only) -- lets a visitor
     see their own row instantly instead of self-cross-referencing the table.
     Reuses .signup-form's existing input/select/button/row styling for visual
     consistency rather than introducing new form-control CSS. */
  .dr-bf-result {
    font-family: var(--font-display); font-weight: 620; font-size: 1.4rem; letter-spacing: -0.01em;
    margin: 0.9rem 0 0; padding: 0.7rem 1rem; border-radius: 8px;
    background: var(--card-bg); border: 1px solid var(--border);
  }
  tr.dr-bf-highlight { background: var(--card-bg); outline: 2px solid var(--accent); outline-offset: -2px; }
  /* AuditLab A11Y-4 (LOW, 2026-08-04): standard visually-hidden pattern --
     present for screen readers (a <table> caption, in this case), removed
     from visual/document flow for sighted users who already have the
     adjacent <h2> as a heading. Clip-based, not display:none/visibility:
     hidden, which some screen readers skip entirely. */
  .dr-visually-hidden {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
  }
  /* Roadmap #41: programmatic grouping for the reminder-cadence checkboxes
     via <fieldset>/<legend> (the legend itself is visually-hidden -- the
     panel's own <h2> already labels it for sighted users). Reset default
     UA fieldset chrome so it doesn't introduce a visible border/box the
     rest of the panel doesn't have. */
  .dr-cadence-fieldset {
    border: 0; margin: 0; padding: 0;
  }
  /* Roadmap #44: skeleton placeholder for the two Coverage-overview panels
     that are guaranteed visible during real network latency (the landing
     tab, shown before drLoadLicenses()'s first fetch resolves) -- other
     "Loading..." panels sit behind a tab click that in practice usually
     happens after that same fetch has already resolved, so they weren't
     worth the same treatment. Border-based gradient (not a literal color)
     so it tracks light/dark theme automatically via the existing vars. */
  .dr-skeleton-line {
    height: 0.85rem; border-radius: 4px; margin: 0.5rem 0;
    background: linear-gradient(90deg, var(--border) 25%, var(--border-strong) 50%, var(--border) 75%);
    background-size: 200% 100%;
    animation: dr-skeleton-shimmer 1.4s ease-in-out infinite;
  }
  .dr-skeleton-line:nth-child(2) { width: 80%; }
  .dr-skeleton-line:nth-child(3) { width: 60%; }
  @keyframes dr-skeleton-shimmer {
    0% { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    .dr-skeleton-line { animation: none; }
  }
  /* Roadmap #57: fixed bottom bar, deliberately unobtrusive (no overlay,
     doesn't block page content) since it's a notice, not a blocking gate. */
  .dr-cookie-notice {
    position: fixed; left: 0; right: 0; bottom: 0; z-index: 40;
    background: var(--fg); color: var(--bg);
    padding: 0.75rem 1.2rem; display: flex; align-items: center; justify-content: center;
    gap: 1rem; flex-wrap: wrap; font-size: 0.85rem;
  }
  .dr-cookie-notice p { margin: 0; max-width: 46rem; }
  .dr-cookie-notice a { color: inherit; }
  .dr-cookie-notice button {
    font-family: inherit; font-size: 0.82rem; font-weight: 600; padding: 0.35rem 0.9rem;
    border: 1px solid var(--bg); border-radius: 6px; background: transparent; color: inherit;
    cursor: pointer; flex-shrink: 0;
  }
  .dr-cookie-notice button:hover { opacity: 0.85; }
  /* Devin, 2026-08-07 (COOKIE-1): [hidden]'s specificity (0,1,0, one
     attribute selector) ties with .dr-cookie-notice's own bare class
     selector (0,1,0) -- and author styles always beat the UA stylesheet's
     [hidden]{display:none} regardless of that tie, so el.hidden = true in
     the dismiss handler had zero visual effect. Live on every page; far
     more noticeable on mobile (a full-width fixed bottom bar eating a big
     chunk of the viewport) than on desktop's thin strip nobody
     double-checked. [hidden] + class beats the bare class on specificity
     alone, no !important needed. */
  .dr-cookie-notice[hidden] { display: none; }
  .table-wrap {
    overflow-x: auto; margin: 1.1rem 0; border: 1px solid var(--border); border-radius: 8px;
    -webkit-overflow-scrolling: touch;
  }
  table { border-collapse: collapse; width: 100%; font-size: 0.92rem; min-width: 420px; }
  th, td { padding: 0.6rem 0.8rem; text-align: left; border-bottom: 1px solid var(--border); white-space: nowrap; }
  th { background: var(--accent); color: var(--on-accent); font-weight: 700; }
  tbody tr:nth-child(even) { background: var(--row-alt); }
  tbody tr:last-child td { border-bottom: none; }
  /* Roadmap #33 (2026-08-07): /compare/ page. Overrides the base table's
     white-space: nowrap -- these cells hold full sentences, not short
     values like the state data tables this base style was built for. */
  .compare-table td, .compare-table th { white-space: normal; }
  .compare-table td:first-child { font-weight: 600; }
  .trust-line {
    border: 1px solid var(--trust-border); background: var(--trust-bg); border-radius: 8px;
    padding: 0.9rem 1.1rem; margin: 1.75rem 0; font-size: 0.92rem;
  }
  .trust-line strong::before { content: "\\2713\\a0"; color: var(--gold); }
  /* ---- Rule-changes feed, /rule-changes/ (2026-08-02) ---- */
  .rc-section-note { color: var(--muted); font-size: 0.88rem; margin: 0.2rem 0 0.9rem; }
  /* Roadmap #49 (2026-08-07): /changelog/. */
  .cl-list { list-style: none; margin: 1.2rem 0; padding: 0; display: flex; flex-direction: column; gap: 0.75rem; }
  .cl-list li { padding-bottom: 0.75rem; border-bottom: 1px solid var(--border); }
  .cl-list li:last-child { border-bottom: none; }
  .cl-date { display: block; font-size: 0.8rem; color: var(--muted); margin-bottom: 0.15rem; }
  .cl-summary { display: block; }
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
  /* Reported directly, 2026-08-04: "Enacted" is accurate legislative language
     (signed into law) but its badge reused --verified-green, the same
     "confirmed/settled" color as every other verified date on this site --
     directly beside "not yet in force" copy for upcoming items, that reads
     as self-contradictory. Gold is this page's own existing "pending/not
     yet settled" color (see rc-badge-conflict above); only actually-in-force
     changes keep the green "Enacted" treatment. */
  .rc-badge-upcoming { background: var(--gold-bg); color: var(--gold); }
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
  .hero-lede strong { color: var(--fg); }
  /* Task #152 (2026-08-09, ValueLab's own pick for "sharpest competitive
     sentence in the whole site"): promoted from /for-firms/ to the
     homepage's second line, ahead of the original hero-lede -- that
     sentence didn't disappear, just moved down a line under its own
     lighter style so both messages (why this beats a CPE tracker, why the
     dates themselves are trustworthy) still show without competing for
     the same visual weight. Same faint/46ch pattern .trust-footnote
     already uses for a secondary supporting line under the primary one. */
  .hero-subtext { color: var(--faint); font-size: 0.88rem; line-height: 1.5; max-width: 55ch; margin: 0.6rem 0 0; }
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

  /* Roadmap #325 (2026-08-10, ValueLab design-pattern-mining #4): intent
     chips directly under the hero -- pure routing, same pill shape as
     .map-small-pill/.dr-mob-mode-btn elsewhere on the site, not a new
     visual language. */
  .dr-intent-chips { display: flex; flex-wrap: wrap; gap: 0.6rem; margin: 1.6rem 0 0; }
  .dr-intent-chip {
    display: inline-block; background: transparent; color: var(--fg); border: 1px solid var(--border-strong);
    border-radius: 999px; padding: 0.5rem 1rem; font-size: 0.86rem; font-weight: 600; text-decoration: none;
    cursor: pointer; font-family: inherit;
  }
  .dr-intent-chip:hover { border-color: var(--accent); color: var(--accent); }

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

  /* Roadmap #324 (2026-08-10, ValueLab design-pattern-mining #5): the same
     three pain-point sentences /for-firms/ already had, re-laid-out as an
     icon-led 3-column grid instead of stacked paragraphs -- same
     .method-grid/.mcard shape this file already uses elsewhere, not a new
     visual language. */
  .dr-pain-headline { font-size: 1.5rem; margin: 0 0 0.3rem; }
  .dr-pain-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1.2rem; margin: 1.4rem 0 1.8rem; }
  @media (max-width: 700px) { .dr-pain-grid { grid-template-columns: 1fr; } }
  .dr-pain-col { background: var(--card-bg); border: 1px solid var(--border); border-radius: 10px; padding: 1.3rem 1.2rem; }
  .dr-pain-icon { width: 28px; height: 28px; color: var(--accent); margin-bottom: 0.7rem; }
  .dr-pain-col p { margin: 0; font-size: 0.9rem; line-height: 1.55; }

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
  /* CONTRAST-1 (LOW, 2026-08-04): this was scoped to .remind-panel only, so
     every input outside it (the 55 state pages' CPE/reinstatement
     email-capture forms, /signin/, the homepage state search) fell back to
     Chrome's default placeholder grey -- 3.97:1 against this site's dark
     backgrounds, below WCAG AA's 4.5:1. #8fa7bb is already proven at 5.31:1
     against the darkest background in use; unscoping it clears every case
     with margin instead of picking a new color. */
  input::placeholder, textarea::placeholder { color: #8fa7bb; }
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
  .guide-disclosure {
    border: 1px solid var(--border); border-radius: 8px; padding: 0.85rem 1.1rem;
    background: var(--card-bg); margin: 1.75rem 0; font-size: 0.85rem; color: var(--muted);
  }
  .guide-disclosure p { margin: 0; }
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
  /* Roadmap #48 (2026-08-07): user-flaggable "this looks wrong" link. */
  .flag-wrong { margin: 0.4rem 0 0; font-size: 0.82rem; color: var(--muted); }
  .flag-wrong a { color: inherit; }
  .how-it-works { color: var(--muted); font-size: 0.92rem; margin: 1.25rem 0 1.75rem; }
  .state-grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(148px, 1fr));
    gap: 0.65rem; margin: 0 0 2rem; list-style: none; padding: 0;
  }
  .state-grid--mobile-fallback { display: none; }
  /* Reported directly, 2026-08-04: /blog/'s 8 cards inherited .state-grid's
     minmax(148px,...) columns, which fits 7 per row at this page's content
     width -- orphaning the 8th card alone on a near-empty second row. That
     column width is right for a single state name (the homepage/404 use of
     .state-grid); a guide card also carries a full description line and
     reads better wider anyway. minmax(240px,...) fits exactly 4 per row at
     .wrap's 1180px max-width, so today's 8 guides fill two full rows with
     nothing left over. */
  .guide-grid { grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); }
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
  /* Roadmap #341 (2026-08-10): featured guide card on /blog/ -- accent
     border + a small label, same accent color already used for badges
     elsewhere on the site rather than inventing a new one. */
  .guide-card--featured { border: 1px solid var(--accent); margin-bottom: 1rem; }
  .guide-featured-label {
    display: inline-block; font-size: 0.7rem; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.05em; color: var(--accent); margin-bottom: 0.3rem;
  }
  /* Roadmap #50 (2026-08-07): shown only on the exception -- see the call
     site's own comment for why the majority case isn't repeated here. */
  .state-card .state-confidence {
    margin-top: 0.3rem; font-size: 0.72rem; color: var(--gold); font-weight: 600;
  }
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
  .signup-form input:not([type="checkbox"]):not([type="radio"]), .signup-form select {
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
  /* Roadmap #25 (2026-08-07): in-app notification center. */
  .dr-notif-bell {
    position: relative; display: inline-flex; align-items: center; justify-content: center;
    width: 34px; height: 34px; margin: -0.3rem 0 0.6rem; border: none; border-radius: 8px;
    background: transparent; color: #b9cad9; cursor: pointer;
  }
  .dr-notif-bell:hover { background: rgba(255,255,255,.08); color: #fff; }
  .dr-notif-bell svg { width: 18px; height: 18px; }
  .dr-notif-badge {
    position: absolute; top: 2px; right: 2px; min-width: 15px; height: 15px; padding: 0 3px;
    border-radius: 999px; background: #c33737; color: #fff; font-size: 0.62rem; font-weight: 700;
    line-height: 15px; text-align: center;
  }
  .dr-notif-panel {
    position: absolute; z-index: 20; left: 1rem; top: 3.6rem; width: 300px; max-width: calc(100vw - 2rem);
    background: var(--card-bg); color: var(--fg); border: 1px solid var(--border); border-radius: 10px;
    box-shadow: 0 8px 24px rgba(0,0,0,.25); max-height: 60vh; overflow-y: auto; padding: 0.6rem;
  }
  .dr-notif-panel-head { display: flex; align-items: center; justify-content: space-between; padding: 0.2rem 0.6rem 0.5rem; font-size: 0.78rem; color: var(--muted); }
  .dr-notif-item-row { display: flex; align-items: flex-start; gap: 0.15rem; }
  .dr-notif-item-row + .dr-notif-item-row { margin-top: 0.15rem; }
  .dr-notif-item { display: block; flex: 1 1 auto; min-width: 0; padding: 0.55rem 0.6rem; border-radius: 6px; font-size: 0.85rem; line-height: 1.4; }
  .dr-notif-item:hover { background: var(--row-alt); }
  .dr-notif-item-sub { display: block; color: var(--muted); font-size: 0.78rem; margin-top: 0.1rem; }
  .dr-notif-dismiss-btn {
    flex: 0 0 auto; background: transparent; border: none; color: var(--muted); cursor: pointer;
    font-size: 1rem; line-height: 1; padding: 0.55rem 0.4rem; border-radius: 6px; font-family: inherit;
  }
  .dr-notif-dismiss-btn:hover { color: var(--fg); background: var(--row-alt); }
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
  /* Roadmap #320 (2026-08-10): "Check one person" / "Check whole roster"
     mode toggle on /firm-mobility/ -- same accent/on-accent pairing as
     .dr-btn-save for the active state, outlined for the inactive one, same
     paired-buttons convention .dr-modal-actions already established. */
  .dr-mob-mode-toggle { display: flex; gap: 0.5rem; margin-bottom: 1.4rem; }
  .dr-mob-mode-btn {
    background: transparent; color: var(--muted); border: 1px solid var(--border-strong);
    border-radius: 999px; cursor: pointer; padding: 0.45rem 1.1rem; font-size: 0.87rem;
    font-weight: 600; font-family: inherit;
  }
  .dr-mob-mode-btn--active { background: var(--accent); color: var(--on-accent); border-color: var(--accent); }
  .dr-mob-roster-table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  .dr-mob-roster-table th { text-align: left; font-size: 0.76rem; text-transform: uppercase; letter-spacing: 0.03em; color: var(--muted); padding: 0.5rem 0.7rem; border-bottom: 1px solid var(--border-strong); }
  .dr-mob-roster-table td { padding: 0.6rem 0.7rem; border-bottom: 1px solid var(--border); vertical-align: middle; }
  .dr-mob-roster-table tr:last-child td { border-bottom: none; }

  /* Roadmap #323 (2026-08-10): six-tab product showcase on /for-firms/,
     real screenshots of the shared demo account. Tab-button shape reused
     verbatim from .dr-mob-mode-btn above -- same visual language, not a
     new component style. */
  .dr-showcase-tabs { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 1rem; }
  .dr-showcase-tab {
    background: transparent; color: var(--muted); border: 1px solid var(--border-strong);
    border-radius: 999px; cursor: pointer; padding: 0.45rem 1.1rem; font-size: 0.85rem;
    font-weight: 600; font-family: inherit;
  }
  .dr-showcase-tab--active { background: var(--accent); color: var(--on-accent); border-color: var(--accent); }
  .dr-showcase-frame { border: 1px solid var(--border); border-radius: 10px; overflow: hidden; background: var(--card-bg); }
  .dr-showcase-frame img { display: block; width: 100%; height: auto; }
  .dr-questionnaire-check { display: flex; gap: 0.6rem; align-items: flex-start; margin: 0.5rem 0; font-size: 0.88rem; font-weight: 400; }
  .dr-questionnaire-check input { margin-top: 0.2rem; flex: 0 0 auto; }
  .dr-nps-scale { display: flex; flex-wrap: wrap; gap: 0.4rem; margin: 0.9rem 0; }
  .dr-nps-score-btn {
    font-family: inherit; font-size: 0.85rem; font-weight: 600; width: 2.4rem; height: 2.4rem;
    border: 1px solid var(--border-strong); border-radius: 7px; background: transparent; color: inherit;
    cursor: pointer;
  }
  .dr-nps-score-btn:hover { border-color: var(--fg); }
  .dr-nps-score-btn:disabled { opacity: 0.6; cursor: default; }
  /* .dr-questionnaire-other, not an #id selector -- preship_gate's stylesheet-
     integrity check (added after the 2026-07-31 truncated-CSS incident, see
     its own docstring) flags ANY line starting with "#" as a leaked Python
     comment, since CSS's own comment syntax never does. A real #id selector
     is a false positive for that heuristic, not a bug in the check -- easier
     to just not write one here than to loosen a check that already caught a
     genuine site-wide breakage once. */
  .dr-questionnaire-other { width: 100%; font-family: inherit; font-size: 0.88rem; padding: 0.5rem; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--bg); color: inherit; resize: vertical; }
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
  /* 2026-08-10, Devin's own live-test report ("what is this saying?"):
     Overall can read ACTION REQUIRED directly above an individual card
     that says CLEAR, with nothing at the top explaining WHY -- shown only
     when that specific contradiction is real (the firm-level card is
     what's actually driving it), so it never appears when Overall and the
     individual card already agree. */
  .dr-verdict-pointer { font-size: 0.85rem; font-weight: 600; color: var(--gold); margin: 0.5rem 0 0; }
  .dr-verdict-disclaimer { font-size: 0.78rem; color: var(--faint); margin-top: 0.6rem; font-style: italic; }
  /* 2026-08-10: "Mark requirements met" now renders INSIDE whichever card
     actually carries the action_required verdict (was its own trailing
     block after both cards, unattached to either) -- same divider
     treatment .dr-verdict-cite already uses so it reads as a distinct
     action row, not a run-on continuation of the italic disclaimer above it.
     Class, not the #dr-mob-complete-wrap id (still kept for the click
     handler's getElementById lookup) -- this file styles by class only,
     never a bare id selector. */
  .dr-mob-complete-wrap { margin-top: 0.8rem; padding-top: 0.8rem; border-top: 1px solid var(--border); }
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
  /* Roadmap #151 Phase 4: spans the full 3-column stat row when the
     synthesis rollup is gated (post-cutover free firm) -- same card
     chrome as .dr-stat-card so it doesn't look like a layout break. */
  .dr-stat-upsell {
    grid-column: 1 / -1; background: var(--card-bg); border: 1px solid var(--border); border-radius: 11px;
    padding: 1.05rem 1.15rem; color: var(--muted); font-size: 0.88rem;
  }
  .dr-stat-upsell a { color: var(--accent); }

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

  /* Dashboard-polish item #3 (2026-08-05): Coverage overview's cross-links
     to Calendar/Map/CPE Hours -- plain text links, not styled as nav items
     (no is-active toggling reaches these, unlike .dr-nav's own links), so a
     simple inline row with the site's standard link color and a bit of
     breathing room reads as "quick links out of this view" rather than a
     second, competing tab strip. */
  /* Roadmap #28 (2026-08-06): guided onboarding checklist. */
  .dr-onboarding-checklist {
    background: var(--card-bg); border: 1px solid var(--border-strong); border-radius: 11px;
    padding: 1rem 1.2rem; margin-bottom: 1.2rem;
  }
  .dr-onboarding-checklist[hidden] { display: none; }
  .dr-onboarding-checklist-head { display: flex; align-items: center; justify-content: space-between; }
  .dr-onboarding-checklist-head h2 { font-size: 0.98rem; margin: 0; font-family: var(--font-display); }
  .dr-onboarding-dismiss {
    background: transparent; border: none; color: var(--muted); font-size: 1.3rem; line-height: 1;
    cursor: pointer; padding: 0.1rem 0.3rem;
  }
  .dr-onboarding-dismiss:hover { color: var(--fg); }
  .dr-onboarding-checklist ul { list-style: none; margin: 0.7rem 0 0; padding: 0; display: flex; flex-wrap: wrap; gap: 0.6rem 1.4rem; }
  .dr-onboarding-step {
    font-size: 0.85rem; color: var(--fg); position: relative; padding-left: 1.4rem;
  }
  .dr-onboarding-step a { color: inherit; text-decoration: underline; }
  .dr-onboarding-step::before {
    content: ""; position: absolute; left: 0; top: 0.15rem; width: 1rem; height: 1rem;
    border: 1.5px solid var(--border-strong); border-radius: 4px; box-sizing: border-box;
  }
  .dr-onboarding-step--done { color: var(--muted); text-decoration: line-through; }
  .dr-onboarding-step--done a { color: var(--muted); }
  .dr-onboarding-step--done::before {
    border-color: var(--verified-green); background: var(--verified-green);
  }
  .dr-onboarding-step--done::after {
    content: ""; position: absolute; left: 0.28rem; top: 0.32rem; width: 0.4rem; height: 0.65rem;
    border: solid white; border-width: 0 2px 2px 0; transform: rotate(45deg);
  }
  /* Roadmap #29 (2026-08-07): sample-data mode for brand-new accounts. */
  .dr-link-btn {
    background: transparent; border: none; padding: 0; margin: 0; color: var(--accent);
    font: inherit; text-decoration: underline; cursor: pointer;
  }
  .dr-link-btn:hover { color: var(--accent-deep); }
  .dr-sample-mode-banner { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
  .dr-sample-mode-banner[hidden] { display: none; }
  .dr-sample-mode-banner .dr-link-btn { white-space: nowrap; font-weight: 600; }
  /* AuditLab SAMPLE-2: print-only counterpart to the on-screen sample
     banner -- never visible on screen, loud in print (see the @media print
     block for the print-side rule). */
  .dr-print-sample-notice { display: none; }
  .dr-sample-tag {
    display: inline-block; color: var(--muted); font-size: 0.78rem; font-style: italic;
    padding: 0.2rem 0;
  }
  /* Roadmap #30 (2026-08-07): in-app product tour. position:fixed -- JS
     computes top/left against a live sidebar nav item on every step change
     and on resize (see drPositionProductTour()), not document flow. */
  .dr-product-tour {
    position: fixed; z-index: 40; width: 260px; background: var(--card-bg);
    border: 1px solid var(--accent); border-radius: 10px; padding: 1rem 1.1rem;
    box-shadow: var(--shadow);
  }
  .dr-product-tour[hidden] { display: none; }
  .dr-product-tour-step { font-size: 0.72rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 0.4rem; }
  .dr-product-tour p { font-size: 0.88rem; margin: 0 0 0.9rem; }
  .dr-product-tour-actions { display: flex; align-items: center; justify-content: space-between; gap: 0.8rem; }
  @media (max-width: 860px) {
    /* The sidebar collapses/reflows under 860px (matches the site's other
       responsive breakpoints) -- fixed-right-of-nav-item positioning stops
       making sense there, so the tour anchors to a plain top-of-viewport
       banner instead of chasing a nav item that may no longer be visible. */
    .dr-product-tour { position: fixed; top: 12px !important; left: 12px !important; right: 12px; width: auto; }
  }
  /* Roadmap #3 (2026-08-07): Reports tab (compliance-summary printable). */
  .dr-report-toolbar { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
  .dr-report-generated { color: var(--muted); font-size: 0.88rem; margin: 0 0 0.9rem; }
  .dr-report-summary { list-style: none; margin: 0 0 1.3rem; padding: 0; display: flex; flex-wrap: wrap; gap: 0.5rem 1.6rem; font-size: 0.92rem; }
  .dr-report-table td, .dr-report-table th { white-space: normal; }
  /* Roadmap #15 (2026-08-07): Audit trail filtering/search -- purely
     client-side over the same GET /firm/audit-trail response #8 already
     fetches, no new endpoint. */
  .dr-audit-filter { display: flex; flex-wrap: wrap; gap: 0.7rem; margin: 0.9rem 0; }
  .dr-audit-filter input, .dr-audit-filter select {
    padding: 0.55rem 0.7rem; border: 1px solid var(--border); border-radius: 6px;
    background: var(--bg); color: var(--fg); font-size: 0.9rem; font-family: inherit;
  }
  .dr-audit-filter input { flex: 1 1 220px; min-width: 160px; }
  /* Roadmap #16 (2026-08-07): bulk-tag panel -- collapsed by default
     (<details>) so it doesn't compete with the roster table for attention
     on a page an admin visits mostly to look, not to bulk-edit. */
  .dr-bulk-tag-panel {
    background: var(--card-bg); border: 1px solid var(--border); border-radius: 11px;
    padding: 0.9rem 1.1rem; margin: 0.9rem 0; font-size: 0.9rem;
  }
  .dr-bulk-tag-panel summary { cursor: pointer; font-weight: 600; }
  .dr-bulk-tag-panel label { display: block; font-size: 0.85rem; font-weight: 600; margin: 0.75rem 0 0.3rem; }
  .dr-bulk-tag-panel select, .dr-bulk-tag-panel input {
    width: 100%; padding: 0.55rem 0.7rem; border: 1px solid var(--border); border-radius: 6px;
    background: var(--bg); color: var(--fg); font-size: 0.9rem; font-family: inherit;
  }
  .dr-bulk-tag-panel button {
    margin-top: 0.8rem; padding: 0.55rem 1rem; border: none; border-radius: 6px;
    background: var(--accent); color: var(--on-accent); font-size: 0.9rem; font-weight: 700; cursor: pointer;
  }
  .dr-bulk-tag-panel button:hover { opacity: 0.92; }
  .dr-bulk-tag-panel #dr-bulk-tag-status { margin: 0.6rem 0 0; }
  /* Roadmap #38 (2026-08-07): saved-view list rows, inside the same
     .dr-bulk-tag-panel <details> box as the bulk-tag panel above. */
  .dr-saved-view-item {
    display: flex; align-items: center; justify-content: space-between; gap: 0.6rem;
    padding: 0.4rem 0; border-bottom: 1px solid var(--border); font-size: 0.85rem;
  }
  .dr-saved-view-item:last-child { border-bottom: none; }
  .dr-saved-view-item button { font-size: 0.78rem; padding: 0.25rem 0.6rem; }
  /* Roadmap #17 (2026-08-07): CSV bulk import preview/results table. */
  .dr-csv-import-panel code { background: var(--bg); border-radius: 3px; padding: 0.05rem 0.3rem; font-size: 0.85em; }
  .dr-csv-preview-table { width: 100%; border-collapse: collapse; margin-top: 0.9rem; font-size: 0.85rem; }
  .dr-csv-preview-table th, .dr-csv-preview-table td {
    text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid var(--border);
  }
  .dr-csv-row-ready { color: var(--muted); }
  .dr-csv-row-error { color: #c33737; }
  .dr-csv-row-added { color: #2e8b57; }
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
  /* AuditLab VIS-1 (MEDIUM, 2026-08-04, per product decision): opted-out staff
     get NO automated reminder at all, so the firm's own at-risk view is the
     only remaining warning channel for them -- this chip makes that gap
     explicit rather than letting the row look like any other at-risk entry.
     Muted/gray, matching the roster table's own "Opted out" status color
     (#8595a3), deliberately NOT the urgency red of dr-at-risk-days--soon --
     this is a channel-gap notice, not an urgency escalation. */
  .dr-at-risk-optedout { display: block; font-size: 0.72rem; color: #8595a3; margin-top: 0.15rem; }
  .dr-activity-item { display: flex; gap: 0.6rem; font-size: 0.85rem; align-items: flex-start; }
  /* Dashboard-polish item #4 (2026-08-05): was a plain colored dot (0.5rem
     filled circle) -- now holds a small per-event-type icon instead, same
     color logic (the --confirm/--optout modifiers), just driving `color`
     for the icon's `stroke="currentColor"` rather than `background` for a
     solid circle. Sized for the icon's own 16x16 viewBox at roughly the
     text's own line-height, not a tiny dot's size. */
  .dr-activity-dot { width: 1rem; height: 1rem; margin-top: 0.1rem; flex: none; color: var(--accent); }
  .dr-activity-dot svg { width: 100%; height: 100%; display: block; }
  .dr-activity-dot--confirm { color: var(--verified-green); }
  .dr-activity-dot--optout { color: var(--gold); }
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
  /* 2026-08-04: Actions was reported overlapping Status/Next-deadline --
     e.g. the header text read "Sta" cut off mid-word right next to
     "Actions". Root cause, confirmed by measuring computed layout in a
     browser rather than guessing: with no explicit column widths, the
     browser's auto table-layout algorithm and the sticky Actions column
     (position: sticky; right: 0, below) fight over the same space
     differently depending on viewport width -- sometimes it scrolls clean,
     sometimes a neighboring column's cell gets partially painted over
     mid-character. table-layout: fixed with an explicit width per column
     (nth-child, matching real column order) makes every column's boundary
     deterministic regardless of viewport width, so the sticky Actions
     column always either fully covers or fully reveals its neighbor --
     never a half-visible "Sta". */
  /* 2026-08-04 correction: `width: 100%` + `table-layout: fixed` with no
     min-width does NOT make the table overflow when the declared column
     widths don't fit -- it makes the browser treat those widths as
     PROPORTIONAL WEIGHTS within a table forcibly locked to exactly 100% of
     the container, squeezing every column (Status/Next-deadline included)
     down to fit, down to near-zero visible width for the narrower ones.
     Caught live: Status and Next-deadline had gone from "overlapping" to
     "invisible", not fixed. min-width equal to the column
     budget (9+14+7+8+6+8+15=67rem, border-box so padding is already
     included) restores the actual intent -- the table can grow past 100%
     and .table-wrap's existing overflow-x:auto scrolls to it, while still
     shrinking to fit when the container genuinely has 67rem to spare. */
  /* 2026-08-04, reported directly ("no Status or expiration column" -- the
     67rem budget assumed generous per-column widths nothing here actually
     needed, scrolling Status/Next-deadline off-screen behind the sticky
     Actions column on every normal desktop). First fix (53.5rem, 7 separate
     columns) traded that bug for two new ones, both also reported directly:
     wrapping Email/Staff/State onto multiple lines to avoid a hover-only
     truncated value made the whole table look ragged ("it now looks
     worse") -- text breaking mid-word with overflow-wrap: anywhere is
     genuinely ugly, not just narrower. **Staff and Email are now ONE
     column** (name on its own line, email smaller/muted beneath it,
     mirroring the exact stacked-name pattern the at-risk panel already
     uses -- .dr-at-risk-name/.dr-at-risk-sub) instead of splitting one
     combined "who is this" identity across two competing narrow columns.
     One column gets real width to work with (11rem, more than Staff+Email
     got SEPARATELY before) and truncates-with-tooltip on each line
     independently, rather than either column starving the other or every
     row growing tall from mid-word wrapping. State reverts to plain
     truncate + tooltip too (wrapping a state name is the same "looks
     ragged" problem at smaller scale, and unlike email a state name is
     rarely critical to read in full without hovering). 6 columns now, not
     7. New sum: 11+6+7+7+7+15 = 53rem -- still fits the measured 859px/
     53.7rem container with zero overflow, verified against the actual
     rendered table.scrollWidth in a browser both times this area has
     regressed from trusting arithmetic on paper instead. */
  .dr-roster-panel table { width: 100%; min-width: 53rem; table-layout: fixed; }
  .dr-roster-panel td, .dr-roster-panel th { white-space: nowrap; }
  .dr-roster-panel th:nth-child(1), .dr-roster-panel td:nth-child(1) { width: 11rem; } /* Staff (name + email stacked) */
  .dr-roster-panel th:nth-child(2), .dr-roster-panel td:nth-child(2) { width: 6rem; }  /* State */
  .dr-roster-panel th:nth-child(3), .dr-roster-panel td:nth-child(3) { width: 7rem; }  /* License type */
  .dr-roster-panel th:nth-child(4), .dr-roster-panel td:nth-child(4) { width: 7rem; }  /* Status -- was 6rem, undersized for its own worst case ("Needs attention" measures 6.55rem) */
  .dr-roster-panel th:nth-child(5), .dr-roster-panel td:nth-child(5) { width: 7rem; }  /* Next deadline -- real rendered format is "Dec 31, 2026" (short month), needs only 6.83rem */
  .dr-roster-panel th:nth-child(6), .dr-roster-panel td:nth-child(6) { width: 15rem; } /* Actions -- UNCHANGED, matches the 3-button group's measured natural width (~237px); shrinking this specifically is what caused the original overlap bug */

  /* Roadmap #37 (2026-08-07): sortable column headers. A <button> (not a
     plain <th> click target) for the same reason data-view links use a
     real <a> elsewhere on this page -- keyboard/screen-reader accessible
     by default, no extra ARIA needed beyond aria-sort on the parent <th>
     (set in JS). Styled to read as a header, not a button. */
  .dr-sort-th {
    background: none; border: none; padding: 0; margin: 0; font: inherit; color: inherit;
    cursor: pointer; display: flex; align-items: center; gap: 0.3rem; width: 100%; text-align: left;
  }
  .dr-sort-th:hover { text-decoration: underline; }
  .dr-sort-th .dr-sort-arrow { font-size: 0.7rem; opacity: 0.5; }
  .dr-sort-th[data-active="true"] .dr-sort-arrow { opacity: 1; }

  /* Truncate with an ellipsis + title tooltip, not wrap -- see the comment
     above for why wrapping (the first attempt at this) looked worse, not
     just narrower. Name and email each truncate on their OWN line inside
     the stacked Staff cell, independently, so a long email doesn't eat
     into the name's line or vice versa.

     Reported directly (2026-08-06, live screenshot): the State column's
     bottom border hugged its text instead of spanning the full row like
     every other column. Root cause -- this rule's selector list ALSO
     matched `td:nth-child(2)` (the State cell itself, not just the
     name/email SPANS inside Staff), so `display: block` landed on the
     table cell too. A block-display <td> stops participating in normal
     table-row sizing -- its border-bottom sits at the bottom of its OWN
     one-line content box instead of the shared row height every sibling
     cell (still `display: table-cell`) uses. `.dr-roster-name`/
     `.dr-roster-email` genuinely need `display: block` (they're inline
     <span>s -- text-overflow does nothing on an inline box); the State
     <td> does not -- text-overflow works on a table-cell box directly,
     with table-layout: fixed already giving it a real width to truncate
     against. Split into two rules so the fix can't silently regress by
     someone adding a third column to this same list later. */
  .dr-roster-panel .dr-roster-name,
  .dr-roster-panel .dr-roster-email {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block;
  }
  .dr-roster-panel td:nth-child(2) {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .dr-roster-panel .dr-roster-name { font-weight: 600; }
  .dr-roster-panel .dr-roster-email { color: var(--muted); font-size: 0.82rem; margin-top: 0.1rem; }
  /* Roadmap #16 (2026-08-07): office/department tag -- a small pill under
     the email line, deliberately distinct from .dr-roster-email's plain
     text treatment so it reads as a tag, not more identity info. */
  .dr-roster-panel .dr-roster-office {
    display: inline-block; margin-top: 0.3rem; font-size: 0.72rem; color: var(--muted);
    background: var(--card-bg); border: 1px solid var(--border); border-radius: 999px;
    padding: 0.08rem 0.55rem;
  }

  /* Task #16 (2026-08-05, confirmed via live test): an overdue Next deadline
     read as a plain date with no visual difference from a comfortably-future
     one -- the Status badge doesn't reliably catch this either, since it's
     computed off missing/unresolvable data, not off the date itself. Same
     red (#c33737) already used for "Overdue" everywhere else on this
     dashboard (Staff-at-risk list, Coverage donut, /my/ cards). */
  .dr-roster-panel .dr-deadline-overdue { color: #c33737; font-weight: 700; }

  /* Actions used to be `position: sticky; right: 0` so it stayed reachable
     without scrolling. Reverted (2026-08-06, reported live + reproduced):
     a sticky td doesn't push table content out of the way, it paints over
     it -- the table's own content width exceeded its container (a common
     ~900px), so the sticky column rendered 80+px to the LEFT of its natural
     position to stay on-screen, silently covering the right portion of
     Next-deadline for every row -- "Jan 1, 2026" read as just "Ja".
     Measured and reproduced exactly (deadlineRect vs actionsRect overlap ==
     table.scrollWidth - wrap.clientWidth) before reverting; obscuring real
     data is worse than the original "have to scroll right to reach
     Actions" annoyance sticky was added to fix, and .table-wrap's own
     overflow-x:auto still makes Actions reachable, just no longer glued
     over its neighbor. */
  .dr-roster-panel td.dr-actions { background: var(--card-bg); }
  .dr-roster-panel tbody tr:nth-child(even) td.dr-actions { background: var(--row-alt); }
  .dr-roster-panel th.dr-actions-head { background: var(--accent); color: var(--on-accent); }

  /* Keeps Edit/Mark renewed/Remove compact within the Actions column's own
     width budget. */
  .dr-roster-panel td.dr-actions button { padding: 0.22rem 0.5rem; font-size: 0.76rem; white-space: nowrap; margin: 0.1rem 0; }
  /* 2026-08-07, reported live (Devin's screenshot: "The Documents part is
     getting cut off"): the Actions cell gained a 4th button (Documents,
     with the document-storage feature) but the 15rem column budget above
     was measured for the original 3 -- with the global td nowrap rule the
     button row's natural width (~310px) overflowed the table's fixed
     budget by ~67px (measured live: scrollWidth 926 vs clientWidth 859),
     clipping the Documents button off-screen. Fix: let the buttons WRAP
     within the cell (each button stays nowrap internally). Widening the
     column to fit 4-in-a-row instead would push min-width past the
     container and reintroduce the always-horizontal-scroll problem the
     53rem budget exists to avoid -- a second row of buttons costs a
     little row height, hides nothing, works at every width. */
  .dr-roster-panel td.dr-actions { white-space: normal; }

  /* Edit-staff modal (2026-08-06) -- replaces the old inline in-row edit
     entirely. Inline edit squeezed two <input>s into the already-narrow
     Staff cell, which forced the WHOLE table wider (table-layout: fixed
     shares one column width across every row) just to fit an editable
     email -- that width blowout is what caused the Next-deadline/Actions
     overlap the sticky-removal comment above describes, and it kept
     regressing (Task #13, then again live 2026-08-06) because the table's
     own column budget and its container's real width were two different
     numbers that had to be hand-kept in sync. A fixed-position overlay has
     no such coupling: it isn't part of the table's layout at all, so
     editing never changes the table's width on any viewport, and there's
     no separate mobile-stacked-card variant to maintain either. */
  /* 2026-08-08, reported live on mobile: the Edit staff modal's form (name,
     email, deadline, fee, CPE carryover, office, notes, then Save/Cancel)
     is taller than a phone viewport. align-items: center on a fixed,
     non-scrolling overlay just centers the overflow -- neither the top nor
     the Save button at the bottom was reachable, with no way to scroll to
     either. overflow-y: auto here lets the OVERLAY itself scroll when its
     content doesn't fit, same fix needed on every viewport, not just
     mobile -- a short browser window on desktop hits the identical problem. */
  .dr-modal-overlay {
    position: fixed; inset: 0; background: rgba(10, 14, 20, 0.55);
    display: flex; align-items: center; justify-content: center;
    padding: 1rem; z-index: 50; overflow-y: auto;
  }
  .dr-modal-overlay[hidden] { display: none; }
  .dr-modal {
    background: var(--card-bg); color: var(--fg); border: 1px solid var(--border);
    border-radius: 12px; padding: 1.4rem 1.5rem; width: 100%; max-width: 26rem;
    box-shadow: 0 12px 40px rgba(0,0,0,0.35);
  }
  .dr-modal h2 { margin: 0 0 1rem; font-size: 1.1rem; font-family: var(--font-display); }
  .dr-modal label { display: block; font-weight: 600; font-size: 0.85rem; margin: 0.9rem 0 0.3rem; }
  .dr-modal label:first-of-type { margin-top: 0; }
  .dr-modal input[type="text"], .dr-modal input[type="email"], .dr-modal input[type="date"],
  .dr-modal select, .dr-modal textarea {
    width: 100%; box-sizing: border-box; padding: 0.55rem 0.65rem;
    border: 1px solid var(--border-strong); border-radius: 6px;
    background: var(--bg); color: var(--fg); font-size: inherit; font-family: inherit;
  }
  .dr-modal textarea { resize: vertical; }
  .dr-modal input:focus, .dr-modal select:focus, .dr-modal textarea:focus {
    outline: none; border-color: var(--accent-deep); box-shadow: 0 0 0 3px var(--accent-bg);
  }
  /* Only shown for "bring your own date" records (deadline_source==='user')
     -- the small set of states this product has no computable renewal rule
     for at all, so a manual date is the ONLY valid representation of their
     deadline (see resolveDeadlineInput()'s own comment, worker/src/index.ts).
     Every other record's deadline is state-rule-computed and deliberately
     NOT editable here -- letting a firm freely override a computed
     compliance date would undermine the one thing this product promises to
     get right, and the backend refuses it anyway (PATCH silently re-derives
     a computed state's deadline from state_slug/license_type_id, never from
     a raw date). */
  .dr-modal-hint { font-size: 0.78rem; color: var(--muted); margin: 0.35rem 0 0; line-height: 1.4; }
  .dr-modal-actions { display: flex; gap: 0.6rem; margin-top: 1.3rem; }
  /* Same accent/on-accent pairing every primary CTA on this site already
     uses (.signup-form button); Cancel stays visually secondary (outlined,
     not filled) so the two read as a clear pair. Unscoped (not
     .dr-modal-actions-only) -- reported live 2026-08-07: .dr-btn-save/
     .dr-btn-cancel/.dr-btn-edit are all reused OUTSIDE modals too (Account
     page's tour-replay button, Reports' Print/CSV buttons, peer-review's
     inline Save/Cancel/Clear), and outside a modal they picked up none of
     this styling at all -- just the browser's bare default button chrome,
     visibly out of place next to everything else on the page. .dr-btn-renew/
     .dr-btn-remove/.dr-btn-documents get the same treatment so a roster
     row's four Actions buttons stay a consistent set rather than Edit alone
     looking different from its siblings. */
  .dr-btn-save {
    background: var(--accent); color: var(--on-accent);
    border: 1px solid var(--accent); border-radius: 5px; font-weight: 700; cursor: pointer;
    padding: 0.5rem 1rem; font-size: 0.9rem; font-family: inherit;
  }
  .dr-btn-save:hover:not(:disabled) { opacity: 0.9; }
  .dr-btn-save:disabled { opacity: 0.6; cursor: default; }
  .dr-btn-cancel, .dr-btn-edit, .dr-btn-renew, .dr-btn-documents {
    background: transparent; color: var(--muted);
    border: 1px solid var(--border-strong); border-radius: 5px; cursor: pointer;
    padding: 0.5rem 1rem; font-size: 0.9rem; font-family: inherit;
  }
  .dr-btn-cancel:hover, .dr-btn-edit:hover:not(:disabled),
  .dr-btn-renew:hover:not(:disabled), .dr-btn-documents:hover:not(:disabled) { color: var(--fg); border-color: var(--fg); }
  .dr-btn-edit:disabled, .dr-btn-renew:disabled, .dr-btn-documents:disabled { opacity: 0.6; cursor: default; }
  .dr-btn-remove {
    background: transparent; color: #c33737;
    border: 1px solid #c33737; border-radius: 5px; cursor: pointer;
    padding: 0.5rem 1rem; font-size: 0.9rem; font-family: inherit;
  }
  .dr-btn-remove:hover:not(:disabled) { background: rgba(200, 55, 55, 0.1); }
  .dr-btn-remove:disabled { opacity: 0.45; cursor: default; }

  /* Paid-tier upgrade buttons -- shared by the pricing page, the /pricing/
     cards, and the dashboard's own billing-panel upgrade prompt (2026-08-06:
     the old whole-dashboard paywall panel that originally introduced this
     class was removed once Roster/Calendar/CPE Hours became a standing free
     tier with nothing left to gate there -- only Map and Practice Privilege
     Check are paid now, and both already degrade gracefully in place on a
     403 rather than blocking the whole dashboard). Reuses the site's own
     accent/on-accent pairing (same as .dr-btn-save above), not a new palette. */
  .dr-paywall-tiers {
    display: flex; flex-wrap: wrap; gap: 0.7rem; margin-top: 0.9rem;
  }
  .dr-paywall-tier-btn {
    flex: 1 1 160px; background: var(--accent); color: var(--on-accent);
    border: 1px solid var(--accent); border-radius: 9px; font-weight: 700;
    font-size: 1rem; padding: 0.8rem 1rem; cursor: pointer; font-family: inherit;
    text-align: center; line-height: 1.5;
  }
  .dr-paywall-tier-btn span { display: block; font-weight: 500; font-size: 0.82rem; opacity: 0.9; }
  .dr-paywall-tier-btn:hover { opacity: 0.9; }
  .dr-paywall-tier-btn:disabled { opacity: 0.6; cursor: default; }
  /* Task #8 (2026-08-06) -- reuses .dr-paywall-tier-btn's own button styling
     (var(--accent), already global) rather than the unscoped .cta-button
     class, which turns out to only actually be styled inside .remind-panel
     (checked -- every OTHER standalone `<a class="cta-button">` on this site
     is unintentionally plain-text; not this page's bug to fix, but not one
     to copy either). */
  .pricing-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem; margin: 1.4rem 0; }
  .pricing-card {
    background: var(--card-bg); border: 1px solid var(--border-strong); border-radius: 12px;
    padding: 1.2rem 1.1rem; display: flex; flex-direction: column; gap: 0.6rem;
  }
  .pricing-card h2 { font-size: 1.05rem; margin: 0; font-family: var(--font-display); }
  .pricing-card .price { font-size: 1.6rem; font-weight: 700; margin: 0; color: var(--fg); }
  .pricing-card .price span { font-size: 0.85rem; font-weight: 500; color: var(--muted); }
  .pricing-card p.detail { color: var(--muted); font-size: 0.87rem; flex: 1; margin: 0; }
  .pricing-card .dr-paywall-tier-btn, .pricing-card a.dr-paywall-tier-btn {
    text-decoration: none; display: block; flex: 0 0 auto; margin-top: auto;
  }
  .pricing-card--wide { grid-column: 1 / -1; text-align: center; }

  /* Public roadmap (Task #19, 2026-08-06). */
  .dr-roadmap-list { display: flex; flex-direction: column; gap: 0.9rem; margin: 1.4rem 0; }
  .dr-roadmap-idea {
    background: var(--card-bg); border: 1px solid var(--border-strong); border-radius: 12px;
    padding: 1.1rem 1.2rem; display: flex; flex-wrap: wrap; align-items: center;
    justify-content: space-between; gap: 1rem;
  }
  .dr-roadmap-idea-info { flex: 1 1 260px; min-width: 0; }
  .dr-roadmap-idea-info h2 { font-size: 1.02rem; margin: 0 0 0.25rem; font-family: var(--font-display); }
  .dr-roadmap-idea-info p { margin: 0; color: var(--muted); font-size: 0.88rem; }
  .dr-roadmap-status {
    display: inline-block; margin-left: 0.6rem; font-size: 0.7rem; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.03em; padding: 0.15rem 0.5rem; border-radius: 999px;
    vertical-align: middle;
  }
  .dr-roadmap-status--in_progress { background: var(--gold-bg); color: var(--gold); }
  .dr-roadmap-status--shipped { background: rgba(31, 158, 92, 0.15); color: var(--verified-green); }
  .dr-roadmap-idea-actions { flex: 0 0 auto; display: flex; flex-direction: column; align-items: flex-end; gap: 0.4rem; }
  .dr-roadmap-vote-form { margin: 0; }
  .dr-roadmap-vote-btn {
    background: var(--accent); color: var(--on-accent); border: 1px solid var(--accent);
    border-radius: 999px; font-weight: 700; cursor: pointer; padding: 0.45rem 1rem; font-size: 0.88rem;
    font-family: inherit; white-space: nowrap;
  }
  .dr-roadmap-vote-btn:disabled { opacity: 0.65; cursor: default; background: var(--muted); border-color: var(--muted); }
  .dr-roadmap-notify-toggle {
    background: transparent; border: none; color: var(--muted); font-size: 0.78rem; cursor: pointer;
    text-decoration: underline; padding: 0; font-family: inherit;
  }
  /* [hidden] override required (2026-08-06, caught live): an unconditional
     `display: flex` here beats the browser's own [hidden] UA rule, same
     class of bug as .dr-view[hidden] elsewhere in this file already guards
     against -- the form was visible by default despite hidden="true". */
  .dr-roadmap-notify-form { margin: 0; display: flex; gap: 0.4rem; align-items: center; }
  .dr-roadmap-notify-form[hidden] { display: none; }
  .dr-roadmap-notify-form input[type=email] {
    font-size: 0.85rem; padding: 0.35rem 0.5rem; border: 1px solid var(--border-strong); border-radius: 6px;
    background: var(--bg); color: inherit; width: 190px; max-width: 40vw;
  }
  .dr-roadmap-notify-form button {
    font-size: 0.85rem; padding: 0.35rem 0.7rem; border: 1px solid var(--border-strong); border-radius: 6px;
    background: transparent; color: inherit; cursor: pointer; font-family: inherit; white-space: nowrap;
  }
  .dr-roadmap-notify-result { margin: 0; font-size: 0.8rem; color: var(--muted); text-align: right; }
  @media (max-width: 560px) {
    .dr-roadmap-idea { flex-direction: column; align-items: stretch; }
    .dr-roadmap-idea-actions { align-items: stretch; }
    .dr-roadmap-notify-form input[type=email] { width: auto; max-width: none; flex: 1; }
  }

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
    /* The desktop per-column nth-child widths (added 2026-08-04) have HIGHER
       specificity (class + nth-child + type) than the block above (class +
       type), so without this explicit reset they would win the cascade here
       too and reintroduce fixed-width columns inside the stacked cards --
       the same "reset it explicitly or it silently wins" trap the min-width
       comment above already documents for a different property. */
    .dr-roster-panel td:nth-child(1), .dr-roster-panel td:nth-child(2), .dr-roster-panel td:nth-child(3),
    .dr-roster-panel td:nth-child(4), .dr-roster-panel td:nth-child(5), .dr-roster-panel td:nth-child(6) {
      width: 100%;
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
       value kept forcing the card wider than the viewport and reintroduced
       horizontal scrolling on phones -- the exact problem this fix is for.
       Caught by measuring scrollWidth at 390px, not by eye. Staff's name
       and email (now stacked in one cell, 2026-08-04) and State get the
       same reset. */
    .dr-roster-panel .dr-roster-name,
    .dr-roster-panel .dr-roster-email,
    .dr-roster-panel td:nth-child(2) {
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
  .dr-cal-nav { display: flex; align-items: center; gap: 0.4rem; }
  .dr-cal-nav button {
    border: 1px solid var(--border-strong); background: var(--card-bg); color: var(--fg);
    border-radius: 6px; padding: 0.3rem 0.6rem; cursor: pointer; font-family: inherit; font-size: 0.85rem;
  }
  .dr-cal-nav button:hover { background: var(--row-alt); }
  /* Static one-time export, same visual weight as the Prev/Today/Next
     buttons but a plain <a> (2026-08-06) -- a normal same-site anchor click
     already carries the session cookie, so no JS fetch/blob dance needed. */
  .dr-cal-export {
    border: 1px solid var(--border-strong); background: var(--card-bg); color: var(--fg);
    border-radius: 6px; padding: 0.3rem 0.6rem; font-size: 0.85rem; text-decoration: none;
    margin-left: 0.4rem;
  }
  .dr-cal-export:hover { background: var(--row-alt); }
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
  /* Upcoming rule-change events (2026-08-06) -- a real <button>, not a div
     like the staff .dr-cal-item entries above, since this one opens a
     detail modal and needs to be keyboard-operable. Gold, matching
     rc-badge-upcoming's own "not yet settled" color on /rule-changes/
     itself -- this is the exact same feed, so the color should read the
     same way in both places. */
  .dr-cal-item--rule-change {
    display: block; width: 100%; text-align: left; border: none; font: inherit;
    background: var(--gold-bg); color: var(--gold); cursor: pointer;
    font-size: 0.7rem; line-height: 1.25; padding: 0.1rem 0.3rem; border-radius: 4px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .dr-cal-item--rule-change:hover, .dr-cal-item--rule-change:focus-visible {
    outline: 2px solid var(--gold); outline-offset: 1px;
  }
  @media (max-width: 640px) {
    .dr-cal-grid { grid-template-columns: repeat(7, minmax(0, 1fr)); }
    .dr-cal-day { min-height: 3rem; font-size: 0.68rem; }
    .dr-cal-item { display: none; }
    .dr-cal-day--has-item::after { content: "\\2022"; color: var(--accent); font-size: 1.1rem; line-height: 1; }
    /* 2026-08-09, Devin's live report ("the blue dots still don't say
       anything") -- at this width .dr-cal-item is hidden above and replaced
       by the bare ::after dot, which (being a pseudo-element, and on a
       touch device with no hover) could never carry a tooltip or any other
       info. Tap-to-expand: drRenderCalendar() now only adds --has-item (and
       so only draws a dot) for a day with real staff items, and the click
       delegation in the main script toggles --expanded on tap, which
       un-hides the actual labeled .dr-cal-item rows for that one day and
       swaps the dot off so it doesn't look like there's still more hidden. */
    .dr-cal-day--has-item { cursor: pointer; }
    .dr-cal-day--expanded {
      min-height: auto; grid-column: 1 / -1;
      /* grid-column span (2026-08-10) -- an expanded cell still stuck in its
         normal ~50px-wide grid column left every .dr-cal-item's own
         white-space:nowrap/text-overflow:ellipsis truncating it just as hard
         as the collapsed dot did (measured live: "Missouri: rule change"
         still clipped to ~33px post-expand, scrollWidth 115 vs clientWidth
         33) -- tap-to-expand looked like it worked but never actually
         revealed the name. Spanning the full row gives every item's own
         100%-width rule ~350-390px to render against instead, which is
         enough for any real item text on this site to show in full. */
    }
    .dr-cal-day--expanded .dr-cal-item { display: block; }
    .dr-cal-day--expanded.dr-cal-day--has-item::after { content: none; }
    /* 2026-08-10, Devin's live report ("I clicked the 27th to see the
       name, this is all that showed") -- .dr-cal-item--rule-change was
       deliberately EXEMPTED from the .dr-cal-item{display:none} rule above
       (see that class's own comment) so it would stay a labeled, tappable
       button at every width. In practice a ~50px-wide cell leaves no room
       for "Missouri: rule change" -- measured live at a 390px viewport, the
       button renders at 33x17px showing "Mi..." (confirmed against
       production, a firm with 3 Missouri rule-change events on one day
       showed 3 of these, none legible or reliably tappable). Same fix as
       the staff dot above: hide the button, mark the day with a dot via
       --has-rule-change, and let tap-to-expand reveal the real, full-size,
       legible button -- the modal it opens (drOpenRuleChangeModal) already
       works fine once actually hit, this only fixes discoverability of the
       tap target. Gold (not the staff dot's accent color) so a day mixing
       both item types still reads as "something regulatory happened here";
       --has-rule-change is checked after --has-item in the selector list
       below so gold wins on a mixed day -- one dot, one color, no attempt
       at rendering two overlapping dots in the same tiny cell. */
    .dr-cal-item--rule-change { display: none; }
    .dr-cal-day--has-rule-change::after { content: "\\2022"; color: var(--gold); font-size: 1.1rem; line-height: 1; }
    .dr-cal-day--has-rule-change { cursor: pointer; }
    .dr-cal-day--expanded .dr-cal-item--rule-change { display: block; }
    .dr-cal-day--expanded.dr-cal-day--has-rule-change::after { content: none; }
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
  /* 2026-08-04: self-reported "we handled it" -- deliberately a distinct
     teal, never the same blue as --clear (an independently rule-verified
     determination). See migration 0016's docstring for why these must
     never look identical. */
  .dr-map-state--complete { fill: #1f9e8e; }
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
  .dr-cpe-staff-state { color: var(--muted); font-size: 0.82rem; margin-right: auto; }
  /* Staff self-service nudge (2026-08-05) -- margin-right:auto on the state
     span above absorbs the space-between gap so this button sits flush
     right regardless of name/state length, without restructuring the
     name+state markup into a shared wrapper just for this. */
  .dr-cpe-remind-btn { font-family: inherit; font-size: 0.78rem; padding: 0.25rem 0.6rem; border: 1px solid var(--border-strong); border-radius: 6px; background: transparent; color: var(--muted); cursor: pointer; white-space: nowrap; }
  .dr-cpe-remind-btn:hover { color: var(--fg); border-color: var(--fg); }
  .dr-cpe-remind-btn:disabled { opacity: 0.6; cursor: default; }
  .dr-cpe-bar-row { display: flex; align-items: center; gap: 0.7rem; font-size: 0.82rem; margin-top: 0.4rem; }
  .dr-cpe-bar-label { flex: 0 0 5.5rem; color: var(--muted); }
  .dr-cpe-bar-track { flex: 1 1 auto; height: 0.55rem; border-radius: 999px; background: var(--border); overflow: hidden; }
  .dr-cpe-bar-fill { display: block; height: 100%; border-radius: 999px; background: #1f9e5c; transition: width 0.3s ease; }
  .dr-cpe-bar-fill--behind { background: #c33737; }
  .dr-cpe-bar-value { flex: 0 0 auto; font-variant-numeric: tabular-nums; color: var(--muted); white-space: nowrap; }
  .dr-cpe-gap-note { font-size: 0.8rem; color: var(--faint); margin-top: 0.4rem; }
  .dr-cpe-log-panel { background: var(--card-bg); border: 1px solid var(--border); border-radius: 11px; padding: 1.1rem 1.2rem; margin-bottom: 1.2rem; }
  .dr-cpe-log-panel h2 { font-size: 1.05rem; margin: 0 0 0.6rem; font-family: var(--font-display); }
  /* 2026-08-04, reported directly ("this is still weird" -- Staff member/
     Category/Course/Log-hours all ran together on one line): this form was
     never wired up to the label/input/select block-stacking rules every
     other form on the page gets via .signup-form (confirmed: dr-add-staff-
     form and dr-mobility-form both use that class correctly; this panel's
     form never did). label/select/input are inline-level by default, so
     with nothing forcing a line break they just flowed left-to-right and
     wrapped wherever they ran out of room -- exactly the reported layout.
     Same rules .signup-form already uses, scoped to this form specifically
     rather than adding the .signup-form class wholesale, since that class
     also sets its own border/padding/background and .dr-cpe-log-panel
     already has its own (adding both would double the box chrome). */
  .dr-cpe-log-panel form label { display: block; font-size: 0.85rem; font-weight: 600; margin: 0.75rem 0 0.3rem; }
  .dr-cpe-log-panel form label:first-of-type { margin-top: 0; }
  .dr-cpe-log-panel form input, .dr-cpe-log-panel form select {
    width: 100%; padding: 0.55rem 0.7rem; border: 1px solid var(--border); border-radius: 6px;
    background: var(--bg); color: var(--fg); font-size: 0.95rem; font-family: inherit;
  }
  .dr-cpe-log-panel form button {
    margin-top: 1rem; padding: 0.6rem 1.1rem; border: none; border-radius: 6px;
    background: var(--accent); color: var(--on-accent); font-size: 0.95rem; font-weight: 700; cursor: pointer;
  }
  .dr-cpe-log-panel form button:hover { opacity: 0.92; }
  .dr-cpe-recent-item { display: flex; align-items: center; justify-content: space-between; gap: 0.8rem; font-size: 0.85rem; padding: 0.5rem 0; border-bottom: 1px solid var(--border); }
  .dr-cpe-recent-item:last-child { border-bottom: none; }
  .dr-cpe-recent-remove { border: 1px solid var(--border-strong); background: var(--card-bg); color: var(--muted); border-radius: 6px; padding: 0.2rem 0.55rem; cursor: pointer; font-family: inherit; font-size: 0.78rem; }
  .dr-cpe-recent-remove:hover { background: var(--row-alt); color: #c33737; }

  /* Roadmap #1/#2 (2026-08-07): documents modal list items -- same shape as
     .dr-cpe-recent-item just above. */
  .dr-document-item { display: flex; align-items: center; justify-content: space-between; gap: 0.8rem; font-size: 0.85rem; padding: 0.5rem 0; border-bottom: 1px solid var(--border); }
  .dr-document-item:last-child { border-bottom: none; }
  .dr-document-item a { font-weight: 600; }
  .dr-document-remove { border: 1px solid var(--border-strong); background: var(--card-bg); color: var(--muted); border-radius: 6px; padding: 0.2rem 0.55rem; cursor: pointer; font-family: inherit; font-size: 0.78rem; margin-left: 0.5rem; }
  .dr-document-remove:hover { background: var(--row-alt); color: #c33737; }
  .dr-modal #dr-documents-list { margin: 1rem 0; }

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
  /* Task #3 (2026-08-06): visually set apart from every other Account tab
     panel above it -- same red already used for .dr-account-err/
     .dr-cal-item--soon, at low opacity so it reads as "be careful here"
     rather than as an active error state. */
  .dr-danger-zone { border-color: rgba(200, 55, 55, 0.4); }
  .dr-danger-zone h2 { color: #c33737; }
  .dr-btn-danger {
    background: transparent; color: #c33737; border: 1px solid #c33737; border-radius: 6px;
    font-weight: 600; cursor: pointer; padding: 0.5rem 1rem; font-size: 0.88rem; font-family: inherit;
  }
  .dr-btn-danger:hover:not(:disabled) { background: rgba(200, 55, 55, 0.1); }
  .dr-btn-danger:disabled { opacity: 0.45; cursor: default; }

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
  /* Roadmap #20 (2026-08-08): same visual weight as the submit-button rule
     above, but NOT form/submit-scoped -- covers the Slack "Connect" <a> (a
     real OAuth-redirect navigation, not a form submit) and "Disconnect"
     <button type="button">, both siblings of but outside any <form>. */
  .dr-account-panel .dr-btn-secondary {
    display: inline-block; margin-top: 0.4rem; padding: 0.6rem 1.1rem; border: 0;
    border-radius: 8px; background: #1f5fbf; color: #fff; font-family: inherit; font-size: 0.95rem;
    font-weight: 700; cursor: pointer; text-decoration: none; }
  .dr-account-panel .dr-btn-secondary:hover { background: #1a4f9e; }
  /* Self-serve cancellation (2026-08-05) -- a standalone action button in a
     paragraph, not a form's own submit, so it gets the same compact/bordered
     treatment as this dashboard's other secondary action buttons
     (.dr-cpe-remind-btn) rather than the full-width form-submit style above. */
  .dr-account-panel #dr-billing-body button, .dr-account-panel #dr-signout-other-btn, .dr-account-panel #dr-2fa-body button { font-family: inherit; font-size: 0.85rem; font-weight: 600; padding: 0.4rem 0.9rem; border: 1px solid var(--border-strong); border-radius: 7px; background: transparent; color: inherit; cursor: pointer; margin-top: 0.4rem; }
  .dr-account-panel #dr-billing-body button:hover, .dr-account-panel #dr-signout-other-btn:hover, .dr-account-panel #dr-2fa-body button:hover { border-color: var(--fg); }
  .dr-account-panel #dr-billing-body button:disabled, .dr-account-panel #dr-signout-other-btn:disabled, .dr-account-panel #dr-2fa-body button:disabled { opacity: 0.6; cursor: default; }
  /* Roadmap #53 (2026-08-07): the enrollment secret and backup codes are the
     one place this dashboard shows a value the user is expected to copy
     character-for-character -- a proportional font makes 0/O and 1/I/l hard
     to tell apart, which is exactly the ambiguity the backup-code alphabet
     itself was already chosen to avoid (see totp.ts). */
  .dr-2fa-secret, .dr-2fa-backup-codes { font-family: ui-monospace, "SF Mono", "Cascadia Code", Consolas, monospace; }
  .dr-2fa-secret { display: inline-block; background: var(--row-alt); border: 1px solid var(--border); border-radius: 6px; padding: 0.4rem 0.6rem; font-size: 0.95rem; letter-spacing: 0.03em; word-break: break-all; margin: 0.4rem 0; }
  .dr-2fa-backup-codes { list-style: none; margin: 0.6rem 0; padding: 0.8rem 0.9rem; background: var(--row-alt); border: 1px solid var(--border); border-radius: 8px; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.35rem 1rem; font-size: 0.92rem; }
  .dr-2fa-warn { background: rgba(200, 55, 55, 0.08); border: 1px solid rgba(200, 55, 55, 0.35); border-radius: 8px; padding: 0.6rem 0.8rem; font-size: 0.85rem; margin: 0.7rem 0; }
  .dr-2fa-status-line { font-size: 0.9rem; font-weight: 600; margin: 0 0 0.3rem; }
  /* Demo-account lockdown (2026-08-06): input:disabled has no useful default
     look in most browsers -- still full-contrast text, no visual signal it's
     inert. Scoped to .dr-account-panel forms only, the two this ever hits. */
  .dr-account-panel input:disabled, .dr-account-panel select:disabled, .dr-account-panel button:disabled {
    opacity: 0.55; cursor: not-allowed; background: var(--row-alt);
  }
  /* Show/hide-password toggle (2026-08-04, reported directly) -- generic,
     not scoped to any one form: _SHOW_PASSWORD_TOGGLE_HTML wraps every
     input[type=password] on every page in this span, wherever it lives.
     display:block on the span (a <span> is inline by default) keeps it
     filling the same width the input already did before being wrapped;
     the input's own width:100% then fills the span exactly like it filled
     its old parent. padding-right on the input makes room so the button
     never sits on top of typed characters. */
  .dr-pw-wrap { position: relative; display: block; }
  .dr-pw-wrap input { padding-right: 3.4rem !important; }
  .dr-pw-toggle {
    position: absolute; right: 0.5rem; top: 50%; transform: translateY(-50%);
    background: none; border: none; cursor: pointer; color: var(--muted);
    font-family: inherit; font-size: 0.78rem; font-weight: 600; padding: 0.2rem 0.35rem;
    min-height: 24px; display: inline-flex; align-items: center;
  }
  .dr-pw-toggle:hover { color: var(--fg); }
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
  /* CPE self-service (2026-08-05) -- only rendered inside a managed_by_firm
     card. Same visual language as the rest of this page (var(--card-bg)
     nested block, var(--muted) secondary text) rather than borrowing the
     firm dashboard's own CPE bar styling, since this page's tone is calmer/
     personal, not a roster-wide risk scan. */
  .dr-my-cpe { border-top: 1px solid var(--border); margin-top: 0.8rem; padding-top: 0.8rem; }
  .dr-my-cpe h4 { margin: 0 0 0.5rem; font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.03em; color: var(--muted); }
  .dr-my-cpe-bar-row { display: flex; align-items: center; gap: 0.6rem; font-size: 0.82rem; margin-bottom: 0.4rem; }
  .dr-my-cpe-bar-row > span:first-child { flex: 0 0 3.2rem; color: var(--muted); }
  .dr-my-cpe-bar-row > span:last-child { flex: 0 0 auto; font-variant-numeric: tabular-nums; color: var(--muted); }
  .dr-my-cpe-bar-track { flex: 1 1 auto; height: 7px; border-radius: 4px; background: var(--row-alt); overflow: hidden; }
  .dr-my-cpe-bar-fill { display: block; height: 100%; background: var(--accent); border-radius: 4px; }
  .dr-my-cpe-bar-fill--behind { background: #c33737; }
  .dr-my-cpe-entries { list-style: none; padding: 0; margin: 0.4rem 0; font-size: 0.82rem; color: var(--muted); }
  .dr-my-cpe-entries li { padding: 0.2rem 0; }
  .dr-my-cpe-empty { font-size: 0.82rem; color: var(--muted); margin: 0.4rem 0; }
  .dr-my-cpe-form { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; margin-top: 0.6rem; }
  .dr-my-cpe-form input, .dr-my-cpe-form select { font-family: inherit; font-size: 0.85rem; padding: 0.4rem 0.5rem; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--card-bg); color: inherit; }
  .dr-my-cpe-form input[type=number] { width: 5.5rem; }
  .dr-my-cpe-form button { font-family: inherit; font-size: 0.85rem; font-weight: 700; padding: 0.4rem 0.9rem; border: 0; border-radius: 6px; background: var(--accent); color: var(--on-accent); cursor: pointer; }
  .dr-my-cpe-form button:hover { opacity: 0.9; }
  .dr-my-cpe-form button:disabled { opacity: 0.6; cursor: default; }
  .dr-my-cpe-error { flex: 1 0 100%; font-size: 0.8rem; color: #c33737; }
  .dr-my-error { border: 1px solid #c33737; border-radius: 11px; padding: 0.9rem 1.1rem; margin-top: 1.2rem; font-size: 0.9rem; }
  .dr-my-empty { background: var(--card-bg); border: 1px solid var(--border); border-radius: 11px; padding: 1.2rem; margin-top: 1.2rem; }
  .dr-my-actions { margin-top: 1.4rem; font-size: 0.9rem; }
  .dr-my-upsell { background: var(--card-bg); border: 1px solid var(--border); border-radius: 11px; padding: 1.3rem 1.4rem; margin-top: 2rem; }
  .dr-my-upsell h2 { font-size: 1.1rem; margin: 0 0 0.6rem; font-family: var(--font-display); }
  .dr-my-upsell p { font-size: 0.92rem; }

  /* Orchestrator (2026-08-05): the homepage promises "a fact sheet you
     could hand to a partner" (see build_homepage_page()'s "WHAT A LOOKUP
     ACTUALLY GIVES YOU" section) but nothing backed that up -- printing a
     state page dumped the dark-theme UI as-is: dark background (wastes ink,
     may not even render on some printers), full nav bar, footer legal
     disclaimer block. Overriding the SAME custom properties everything
     already reads from (:root, above) is the one-place fix -- every
     component using var(--bg)/var(--fg)/var(--card-bg) etc. inherits the
     light values automatically, same technique dark mode itself already
     uses, just for print instead of a color-scheme media query. Nav,
     footer, and every signup/lead-capture CTA are hidden outright -- none
     of those belong on a printed handout, and per this file's own citation-
     first design, the .sheet fact-sheet card (citation, deadline, verified
     badge) is what's left standing. */
  @media print {
    :root {
      --bg: #ffffff; --page-bg: #ffffff; --fg: #000000; --muted: #333333; --faint: #444444;
      --border: #cccccc; --border-strong: #999999; --card-bg: #ffffff; --row-alt: #f4f4f4;
      --accent: #17212b; --accent-deep: #000000; --accent-bg: #eeeeee; --on-accent: #000000;
      --gold: #6b5423; --gold-line: #999999; --gold-bg: #ffffff;
      --verified-green: #1c5238; --verified-green-bg: #ffffff;
      --trust-bg: #ffffff; --trust-border: #999999;
      --shadow: none;
    }
    .mainnav, .site-footer, .signup-form, .remind-panel,
    .state-search-wrap, .dr-sso-block, button:not(.dr-sort-th), .cta-button {
      display: none !important;
    }
    /* Roadmap #37 (2026-08-07): sortable column-header buttons are table
       structure, not an action -- keep them (as plain header text, not a
       clickable control) when printing, unlike Edit/Remove/etc. */
    .dr-sort-th { background: none !important; border: none !important; padding: 0 !important; color: inherit !important; }
    /* Roadmap #3 (2026-08-07): printing the Reports tab (the only view with a
       print button, so the only one reachable via window.print()) should show
       just the report -- none of the dashboard's own chrome around it. Each
       selector below shares a line with a leading . or non-# token so none of
       these lines can ever be mistaken for a leaked Python comment (this
       file's own preship gate flags any shipped CSS line starting with #). */
    .dr-sidebar, .dr-onboarding-checklist, .dr-sample-mode-banner, .dr-product-tour,
    .dr-dash-shell #dr-dash-error, .dr-dash-shell #dr-dash-success,
    .dr-dash-shell #dr-dash-warning, .dr-dash-shell #dr-staleness-banner {
      display: none !important;
    }
    /* AuditLab SAMPLE-2: hiding the sample banner above is right for real
       data (it's chrome) but left a sample-mode printout with zero
       indication its rows are fabricated. This print-only notice fills
       that hole -- [hidden] (real-data mode) still wins, so it only ever
       prints while sample mode is genuinely active. */
    .dr-print-sample-notice:not([hidden]) {
      display: block; font-weight: 700; font-size: 1.05rem; border: 2px solid #000000;
      padding: 0.5rem 0.8rem; margin: 0 0 1rem;
    }
    .dr-dash-shell { display: block; }
    body { padding: 0; }
    .wrap { max-width: none; }
    .sheet { box-shadow: none; border: 1px solid #999999; break-inside: avoid; }
    a { color: inherit; text-decoration: none; }
    .cite a, .trust-line a, .cite-link { text-decoration: underline; } /* the citation link IS the point of a printed fact sheet */
    /* AuditLab PRINT-1 (2026-08-05): an underlined link with no printed URL
       points nowhere on paper. Scoped to EXTERNAL citations only (http/https)
       -- the internal cross-links (CPE-hours page, reinstatement page, "back
       to all states", "see how we verify every deadline") are navigation,
       not evidence, and printing THEIR relative paths would just be noise
       with no source to trace; the [href^="http"] scoping is what keeps
       those out automatically (they're all relative paths).

       FOUR distinct DOM patterns render "the citation" depending on page/
       record type -- confirmed live, not assumed, after AuditLab's suggested
       single `.cite` selector turned out to match neither Texas nor Illinois
       (both real live pages) at all:
         .cite       the link ITSELF carries this class (<a class="cite">),
                     not a wrapper -- AuditLab PRINT-1r (2026-08-05) caught
                     that the first fix used the descendant form (`.cite a`,
                     0 matches) instead of the self form, the same class-name-
                     without-reading-the-element mistake their own original
                     suggestion made, on the very selector they named.
         .trust-line "Last verified... official state board" prose block --
                     what /texas/, /illinois/, and reinstatement pages use
         .cite-link  "Source of record ... read the rule ->" block
                     (_source_cite_html()) -- what CPE-hours pages use
         .rc-cite    /rule-changes/'s citation, a real wrapper (<p class=
                     "rc-cite"><a href=...>) -- was never in scope until
                     PRINT-1r caught it; needs the descendant form, unlike
                     .cite.
       All four need the fix independently; fixing only the pattern named in
       the original AuditLab report would have left the two MOST COMMON real
       patterns (.trust-line, .cite-link) broken, which is exactly what
       shipping that suggestion as-is would have done. */
    .cite[href^="http"]::after, .cite a[href^="http"]::after,
    .trust-line a[href^="http"]::after, .cite-link[href^="http"]::after,
    .rc-cite a[href^="http"]::after {
      content: " (" attr(href) ")"; font-size: 0.85em; word-break: break-all;
    }
  }
"""


# Task #20 (2026-08-06): the hamburger button above ~680px does nothing on
# its own -- this toggles .dr-nav-open (shown/hidden by the media query on
# .nav-links) and keeps aria-expanded honest for screen readers. Closes on
# a link click too, so navigating away doesn't leave the menu open behind
# the new page. Present on every page (not conditional like the sign-in
# swap script above it) since every page has the same nav markup.
_NAV_TOGGLE_JS_HTML = """<script>
(function() {
  var btn = document.getElementById('dr-nav-toggle');
  var links = document.getElementById('dr-nav-links');
  if (!btn || !links) return;
  btn.addEventListener('click', function() {
    var open = links.classList.toggle('dr-nav-open');
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  links.addEventListener('click', function(ev) {
    if (ev.target.tagName === 'A') {
      links.classList.remove('dr-nav-open');
      btn.setAttribute('aria-expanded', 'false');
    }
  });
})();
</script>"""

# Task #8 (2026-08-06): every firm-tier button on /pricing/ always attempts
# a REAL checkout first (Devin's explicit call) -- for a visitor who
# already has a firm session (free tier or already paid), this is one click
# straight into Stripe, identical to the dashboard's own billing-panel
# upgrade prompt. For an anonymous visitor, POST /firm/billing/checkout
# 401s (requireFirmSession gates it) and this sends them to create a free
# account first.
#
# ValueLab customer-walkthrough finding (2026-08-10): this used to redirect
# to bare /firm-login/ (the SIGN-IN view) -- an anonymous visitor who just
# clicked "Get Essentials" has no account to sign into yet, so this landed
# every buy-path click on the wrong form. Fixed to the signup view directly
# (#dr-view-signup, the same anchor /pricing/'s own free-tier CTA above
# already uses). Deliberately NOT the same fix as drStartCheckout() below --
# that one is dashboard-only, reachable only by an ALREADY-authenticated
# session whose cookie merely expired mid-use, so sign-IN is the correct
# landing there, not signup.
_PRICING_CHECKOUT_JS_HTML = f"""<script>
(function() {{
  var buttons = document.querySelectorAll('.dr-pricing-tier-btn');
  var errEl = document.getElementById('dr-pricing-error');
  for (var i = 0; i < buttons.length; i++) {{
    buttons[i].addEventListener('click', function(ev) {{
      var btn = ev.currentTarget;
      var tier = btn.getAttribute('data-tier');
      if (errEl) {{ errEl.hidden = true; errEl.textContent = ''; }}
      btn.disabled = true;
      fetch('{REMINDER_BACKEND_BASE_URL}/firm/billing/checkout', {{
        method: 'POST',
        credentials: 'include',
        headers: {{'content-type': 'application/json'}},
        body: JSON.stringify({{tier: tier}})
      }}).then(function(res) {{
        if (res.status === 401) {{ window.location.href = '/firm-login/#dr-view-signup'; return null; }}
        return res.json().catch(function() {{ return null; }}).then(function(data) {{
          if (!res.ok) {{
            if (errEl) {{
              errEl.textContent = (data && data.error) ? data.error : 'Something went wrong, please try again.';
              errEl.hidden = false;
            }}
            btn.disabled = false;
            return;
          }}
          if (data && data.checkout_url) {{ window.location.href = data.checkout_url; }}
          else {{ btn.disabled = false; }}
        }});
      }}).catch(function() {{
        if (errEl) {{ errEl.textContent = 'Something went wrong, please try again.'; errEl.hidden = false; }}
        btn.disabled = false;
      }});
    }});
  }}
}})();
</script>"""

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
    # Reported live 2026-08-07: once swapped, "Dashboard" kept the SAME
    # nav-quiet (faint gray) styling "Sign In" had -- fine for an
    # occasional link a visitor either clicks or ignores, wrong for a
    # signed-in firm's one way back to their own data while browsing the
    # rest of the site. Promoted to the exact same .cta treatment "Get
    # reminders" already uses (accent color, bold) rather than inventing a
    # third visual tier -- the two now read as a matched pair of real
    # actions instead of "Dashboard" hiding among the quiet nav links.
    signin_swap_js_html = "" if hide_signin else f"""<script>
(function() {{
  var link = document.getElementById('dr-nav-signin');
  if (!link) return;
  fetch('{REMINDER_BACKEND_BASE_URL}/firm/licenses', {{credentials: 'include'}}).then(function(r) {{
    if (r.ok) {{
      link.textContent = 'Dashboard'; link.href = '/firm-dashboard/';
      link.classList.remove('nav-quiet'); link.classList.add('cta');
    }}
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
    <button type="button" class="nav-toggle" id="dr-nav-toggle" aria-expanded="false" aria-controls="dr-nav-links" aria-label="Menu">&#9776;</button>
    <div class="nav-links" id="dr-nav-links">
      <a href="/#all-states">Browse States</a>
      <a href="/methodology/">How We Verify</a>
      <a href="/blog/">Guides</a>
      <a href="/for-firms/">For Firms</a>
      <a href="{REMINDER_BACKEND_BASE_URL}/firm/demo-login">Live Demo</a>
      {signin_link_html}<a href="{esc(remind_href)}" class="cta">Get reminders</a>
    </div>
  </div>
</nav>
{signin_swap_js_html}
{_NAV_TOGGLE_JS_HTML}
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
      <a href="/practice-privilege-check/">Practice Privilege Check</a>
      <a href="/multi-state-firms/">Multi-State Firms</a>
      <a href="/rule-changes/">Mobility Rule Changes</a>
      <a href="/blog/cpe-vs-license-renewal/">CPE vs. License Renewal</a>
      <a href="/blog/">Guides</a>
      <a href="/pricing/">Pricing</a>
      <a href="/compare/">Compare</a>
      <a href="/roadmap/">Roadmap</a>
      <a href="/privacy/">Privacy</a>
      <a href="/terms/">Terms</a>
      <a href="/security/">Security</a>
      <a href="/status/">Status</a>
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

# Task #33 (2026-08-06): public demo firm account -- Devin + orchestrator's
# decision was "public link, no gate" (the competitive-snooping risk is
# theoretical; the actual moat is sourced-citation data quality, not UI,
# and there's essentially no traffic yet for a competitor to stumble onto
# this). demo_locked=1 on this firm's row blocks password changes/SSO
# linking entirely (see migration 0024's own docstring) -- publishing the
# password here is safe BECAUSE that flag exists, not despite it. On a
# paid tier server-side so it can actually demonstrate Map/Practice
# Privilege Check, the two features this account exists to show off.
#
# AuditLab DEMO-2 (2026-08-06, LOW): these two constants are the ONLY
# place in the repo tying the static site's advertised login to the live
# demo@deadline-radar.com account's real credential -- no migration seeds
# password_hash from this value, nothing verifies the two stay in sync.
# Rotating the demo password is a manual, out-of-repo action (an operator
# acting directly against D1 -- see the rotation note in
# `passive_income_register.md` / `HANDOFF.md`'s own DeadlineRadar entries)
# with nothing forcing that rotation to also update this constant and
# regenerate the site. If they ever diverge, the public "Try the live
# demo" link silently starts auto-filling a WRONG password -- not a
# security issue (this credential is intentionally public), but every
# prospect who clicks it gets a same-page login failure with no
# explanation. WHOEVER ROTATES demo@deadline-radar.com's PASSWORD MUST
# UPDATE DEMO_FIRM_PASSWORD BELOW AND REGENERATE THE SITE IN THE SAME
# STEP -- there is no automated check that catches a mismatch.
DEMO_FIRM_EMAIL = "demo@deadline-radar.com"
DEMO_FIRM_PASSWORD = "ZcWxv-5BbcS-Xjbcv-ASPi0"


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


def _birth_month_finder_html(needs_year: bool) -> str:
    """California/Texas only (2026-08-08, roadmap item from the UX-audit
    finding): the table below asks a visitor to self-cross-reference their
    own row, which doesn't match the homepage's "know exactly when YOUR
    license is due" promise. This widget answers instantly instead, reading
    the answer straight out of the already-rendered table (client-side only,
    no new data collection, no risk of drifting from the Python-computed
    dates -- the signup form's own birth_month/birth_year fields are a
    separate, later step for the ongoing reminder relationship; this is
    purely an instant on-page answer for a visitor who hasn't decided to
    sign up yet). `needs_year` is True for California (odd/even birth-year
    parity changes the answer), False for Texas (month alone is enough)."""
    year_field = (
        """<div>
    <label for="dr-bf-year" class="signup-form-compact-label">Birth year</label>
    <input type="number" id="dr-bf-year" min="1900" max="2100" placeholder="e.g. 1985">
  </div>"""
        if needs_year else ""
    )
    return f"""<form class="signup-form signup-form--compact" onsubmit="return false" aria-label="Find your renewal date">
  <div class="signup-form-row">
    <div>
      <label for="dr-bf-month" class="signup-form-compact-label">Your birth month</label>
      <select id="dr-bf-month">
        <option value="">Select&hellip;</option>
        {_MONTH_OPTIONS}
      </select>
    </div>
    {year_field}
    <div><button type="button" id="dr-bf-go">Show my date</button></div>
  </div>
</form>
<p id="dr-bf-result" class="dr-bf-result" hidden></p>"""


def _birth_month_finder_js(needs_year: bool) -> str:
    needs_year_js = "true" if needs_year else "false"
    return f"""<script>
(function() {{
  var monthSel = document.getElementById('dr-bf-month');
  var yearInput = document.getElementById('dr-bf-year');
  var goBtn = document.getElementById('dr-bf-go');
  var result = document.getElementById('dr-bf-result');
  var needsYear = {needs_year_js};
  var lastRow = null;
  function show() {{
    var month = parseInt(monthSel.value, 10);
    if (!month) return;
    var row = document.querySelector('tr[data-month="' + month + '"]');
    if (!row) return;
    if (lastRow) lastRow.classList.remove('dr-bf-highlight');
    row.classList.add('dr-bf-highlight');
    lastRow = row;
    row.scrollIntoView({{behavior: 'smooth', block: 'center'}});
    var cells = row.querySelectorAll('td');
    var dateText = null;
    if (needsYear) {{
      var year = parseInt(yearInput.value, 10);
      if (year) {{
        var isOdd = (year % 2) === 1;
        dateText = (isOdd ? cells[1] : cells[2]).textContent;
      }}
    }} else {{
      dateText = cells[1] ? cells[1].textContent : null;
    }}
    result.hidden = false;
    result.textContent = dateText
      ? ('Your next renewal: ' + dateText)
      : 'Enter your birth year too — it changes the date for this state.';
  }}
  goBtn.addEventListener('click', show);
  monthSel.addEventListener('change', show);
  if (yearInput) yearInput.addEventListener('input', show);
}})();
</script>"""


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
    <select id="birth_month" name="birth_month" required>
      <option value="">Select&hellip;</option>
      {_MONTH_OPTIONS}
    </select>
  </div>
  <div>
    <label for="birth_year">Birth year</label>
    <input type="number" id="birth_year" name="birth_year" min="1900" max="2100" required placeholder="1985">
  </div>
</div>
<p class="field-hint">Your renewal cycle is set by your birth month and whether your birth year is odd or even.</p>"""
    if state_slug == "texas":
        return f"""<label for="birth_month">Birth month</label>
<select id="birth_month" name="birth_month" required>
  <option value="">Select&hellip;</option>
  {_MONTH_OPTIONS}
</select>
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
  <p id="dr-turnstile-blocked-notice" role="status" hidden style="font-size:0.85rem; color:var(--muted); margin-top:0.5rem;">
    Having trouble? If you use an ad blocker or privacy extension, try allowing
    <code>challenges.cloudflare.com</code> for this page &mdash; you can still submit either way.
  </p>
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
  // Purely informational, never blocks submission (the server accepts a
  // missing token on the routes this widget serves -- see verifyTurnstile()'s
  // `allowMissingToken`). 2026-08-05: an ad blocker can prevent
  // challenges.cloudflare.com from ever loading with no visible sign
  // anything is wrong, so a visitor who never sees this widget resolve has
  // no way to know WHY -- this surfaces that explanation without gating
  // anything on it.
  setTimeout(function () {{
    if (drTurnstileToken) return;
    var notice = document.getElementById("dr-turnstile-blocked-notice");
    if (notice) notice.hidden = false;
  }}, 4000);
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


def _upcoming_change_events_by_state() -> dict[str, list[dict]]:
    """Same kind=='rule_change' AND upcoming filter build_firm_dashboard_page()
    already uses for its own rule-change surface, and the exact set
    build_rule_changes_page()'s "Upcoming changes" section publishes -- so a
    per-state page can never show something that page itself wouldn't stand
    behind. Grouped by jurisdiction_slug and computed once at module load
    (not per page) since the source feed is small and identical for every
    caller this build. Sorted soonest-first per state."""
    raw = json.loads(REG_CHANGE_EVENTS_PATH.read_text(encoding="utf-8"))
    by_state: dict[str, list[dict]] = {}
    for e in raw.get("events", []):
        if e.get("kind") != "rule_change" or not e.get("upcoming") or not e.get("effective_date"):
            continue
        slug = e.get("jurisdiction_slug")
        if not slug:
            continue
        by_state.setdefault(slug, []).append(e)
    for events in by_state.values():
        events.sort(key=lambda ev: ev["effective_date"])
    return by_state


_UPCOMING_CHANGE_EVENTS_BY_STATE = _upcoming_change_events_by_state()


def _upcoming_change_callout_html(state_slug: str) -> str:
    """Devin, 2026-08-07: "if someone does a reminder, say hey are you aware
    of this change coming up." Shown ABOVE the signup form (not only after
    submitting) rather than personalizing worker/src/index.ts's
    SUBSCRIBE_SUCCESS_PAGE -- that page is deliberately the SAME generic
    response across several different backend code paths (real success,
    honeypot, a couple of early-return cases) as an anti-enumeration
    measure, and differentiating it per state would need real backend work
    to thread state-specific content through only the genuine-success path
    without weakening that. Showing it before signup sidesteps that
    entirely, needs no backend/worker change, and arguably serves the
    visitor better anyway -- they see it before deciding to sign up, not as
    a surprise after. Empty string (renders nothing) for the ~46 states
    with no real upcoming event on file -- no "nothing to report" filler."""
    events = _UPCOMING_CHANGE_EVENTS_BY_STATE.get(state_slug)
    if not events:
        return ""
    e = events[0]
    # Same scheme guard as rule_change_events_json's own citation_url field
    # (AuditLab XSS-1) -- this one goes through esc() into a plain href
    # attribute (not JSON), so entity-escaping IS the right guard here, but
    # the underlying "never trust a data-file URL without a scheme check"
    # rule is identical.
    citation_url = e.get("citation_url")
    safe_citation_url = (
        citation_url if isinstance(citation_url, str) and citation_url.startswith(("http://", "https://")) else None
    )
    citation_link_html = f' <a href="{esc(safe_citation_url)}">See the citation</a>.' if safe_citation_url else ""
    topic = e.get("topic") or "regulatory"
    jurisdiction = e.get("jurisdiction") or state_slug
    summary = e.get("summary_public") or ""
    return f"""<div class="callout" style="border-left-color:var(--gold);">
  <p class="label">Heads up</p>
  <p>A {esc(topic)} change is coming to {esc(jurisdiction)}, effective {esc(e["effective_date"])}.
  {esc(summary)}{citation_link_html}</p>
</div>"""


def signup_form_for_state(state_slug: str, state_name: str, records: list[dict], as_of: date) -> str:
    # "Bring your own date" (2026-07-05): the form always renders now -- see
    # _extra_fields_html()'s own docstring for how it picks the right field(s)
    # per state. Every state can collect a signup, computed or user-provided.
    # Two-column dark treatment (2026-07-17), matching the approved concept's .remind panel.
    return f"""{_upcoming_change_callout_html(state_slug)}
<div class="remind-panel" id="remind">
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


_JS_TOOLS_DIR = pathlib.Path(__file__).resolve().parent / "scripts" / "js_tools"
_TERSER_CLI = _JS_TOOLS_DIR / "node_modules" / "terser" / "bin" / "terser"

_STRIPPED_JS_CACHE: dict[str, str] = {}
_STRIPPED_CSS_CACHE: dict[str, str] = {}


def _strip_js_comments(js: str) -> str:
    """AuditLab LEAK-1 (MEDIUM, 2026-08-04): runs shipped JS through terser
    (build-time only, see the module docstring for why a hand-rolled stripper
    isn't safe) to remove comments while leaving behavior byte-for-byte
    equivalent. Cached by exact content -- the same script block repeats
    verbatim across many of the 184 pages, no need to re-invoke node per page."""
    if js in _STRIPPED_JS_CACHE:
        return _STRIPPED_JS_CACHE[js]
    if not _TERSER_CLI.exists():
        raise RuntimeError(
            f"terser not found at {_TERSER_CLI} -- run `npm install` in "
            f"{_JS_TOOLS_DIR} before building. Refusing to silently ship "
            f"un-stripped JS (AuditLab LEAK-1) instead of failing loudly."
        )
    fd, temp_path = tempfile.mkstemp(suffix=".js")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(js)
        result = subprocess.run(
            ["node", str(_TERSER_CLI), temp_path],
            capture_output=True, text=True, encoding="utf-8", check=False,
        )
    finally:
        os.unlink(temp_path)
    if result.returncode != 0 or not result.stdout.strip():
        raise RuntimeError(f"terser failed on a shipped <script> block:\n{result.stderr}")
    stripped = result.stdout.strip()
    _STRIPPED_JS_CACHE[js] = stripped
    return stripped


def _strip_css_comments(css: str) -> str:
    """Same LEAK-1 fix, CSS side. tinycss2 is a real CSS tokenizer (pure
    Python, no subprocess) -- safe here because CSS has none of JS's
    regex-literal ambiguity; only genuine /* */ comments are removed, and a
    string value that happens to contain '/*' text (none exist in PAGE_CSS
    today, but the parser handles it correctly regardless) is left alone."""
    if css in _STRIPPED_CSS_CACHE:
        return _STRIPPED_CSS_CACHE[css]

    # AuditLab GATE-1 (2026-08-05, MEDIUM): preship_gate.py's brace-balance
    # check can never fire on a real build, because tinycss2 does not error
    # or drop content on an unbalanced brace -- it silently RE-PARENTS the
    # trailing rules into the previous rule's body instead, producing a
    # syntactically valid but structurally wrong stylesheet (deleting one
    # `}` from the real stylesheet turned 379/447 top-level rules into rules
    # nested inside a single selector, which every browser then only applies
    # *inside* that selector -- the same site-wide silent style loss as the
    # 2026-07-31 incident this whole stripper exists to prevent, just
    # laundered past the check written to catch it, since the gate only
    # ever scans POST-strip docs/, where the round-trip has already
    # repaired the imbalance).
    #
    # The naive fix -- compare tinycss2's parsed rule count before vs after
    # its own round-trip -- does NOT work and was caught only by writing a
    # control test against the exact mutation above: tinycss2 performs the
    # re-parenting at PARSE time, on the very first parse of the (already
    # corrupted) input, so "parse once" and "parse-serialize-reparse" of
    # that SAME input are idempotent -- both already reflect the corrupted
    # structure, so they always agree with each other, whether or not the
    # SOURCE was well-formed. tinycss2 never sees a "before" state to
    # compare against.
    #
    # The only signal a real corruption actually leaves behind is a RAW
    # brace-count mismatch on the source text itself, before tinycss2 ever
    # touches it (comments stripped with a plain regex here, not a full
    # parse, purely to keep a brace character inside a comment from
    # producing a false positive) -- confirmed against the real stylesheet:
    # a deleted brace shows raw 579 open / 578 close on the SOURCE, while
    # tinycss2's own output is (by construction) always exactly balanced.
    _naive_comment_free = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    raw_open, raw_close = _naive_comment_free.count("{"), _naive_comment_free.count("}")
    if raw_open != raw_close:
        raise RuntimeError(
            f"_strip_css_comments: source CSS has unbalanced braces ({raw_open} open vs "
            f"{raw_close} close). tinycss2 will silently re-parent this into a syntactically "
            f"valid but structurally wrong stylesheet rather than erroring on it -- fix the "
            f"source CSS; do not ship this."
        )

    import tinycss2
    rules = tinycss2.parse_stylesheet(css, skip_comments=True, skip_whitespace=False)
    stripped = tinycss2.serialize(rules)
    _STRIPPED_CSS_CACHE[css] = stripped
    return stripped


_STYLE_BLOCK_RE = re.compile(r"<style>\n?(.*?)\n?</style>", re.DOTALL)
_SCRIPT_BLOCK_RE = re.compile(r"<script>(.*?)</script>", re.DOTALL)


def _strip_shipped_comments(page_html: str) -> str:
    """Applied once, in page_shell(), the single choke point all ~20
    build_*_page() functions already route through -- covers every current
    and future page without needing to touch each call site. Deliberately
    matches ONLY the exact-attribute-free <style> and <script> tags this
    codebase actually emits -- never <script type="application/ld+json">
    (structured data, not JS -- running it through a JS parser would be both
    wrong and pointless, json.dumps() output never has comments to strip)
    and never <script src="..."> (external, empty body -- e.g. the Turnstile
    widget loader)."""
    page_html = _STYLE_BLOCK_RE.sub(
        lambda m: "<style>\n" + _strip_css_comments(m.group(1)) + "\n</style>", page_html, count=1
    )
    page_html = _SCRIPT_BLOCK_RE.sub(
        lambda m: "<script>" + _strip_js_comments(m.group(1)) + "</script>", page_html
    )
    return page_html


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


# Reported directly ("add the ability for user to see the password they
# typed", 2026-08-04): every password field on the site was type="password"
# with no reveal option -- ordinary, but this product's own passwords are
# long, un-memorized CSPRNG-adjacent strings a password manager fills in
# (per the site's own copy: "a short phrase you'll remember"), exactly the
# case where a typo is both likely and invisible without a reveal toggle.
# One shared script, added once in page_shell() (the choke point every page
# already routes through) rather than duplicated per form -- wraps every
# input[type=password] found anywhere on the page in a small relative
# wrapper with a Show/Hide button that flips the input's type attribute.
# Never touches the input's id/name/value/other attributes or any existing
# JS that references it by id, so nothing else on any page needs to change.
_SHOW_PASSWORD_TOGGLE_HTML = """<script>
(function () {
  document.querySelectorAll('input[type="password"]').forEach(function (input) {
    var wrap = document.createElement('span');
    wrap.className = 'dr-pw-wrap';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dr-pw-toggle';
    btn.textContent = 'Show';
    btn.setAttribute('aria-label', 'Show password');
    btn.addEventListener('click', function () {
      var revealed = input.type === 'text';
      input.type = revealed ? 'password' : 'text';
      btn.textContent = revealed ? 'Show' : 'Hide';
      btn.setAttribute('aria-label', revealed ? 'Show password' : 'Hide password');
    });
    wrap.appendChild(btn);
  });
})();
</script>"""

# Roadmap #57 (2026-08-07): a cookie NOTICE, not a consent-with-reject-
# button flow -- the Privacy page (see "Cookies and analytics" section)
# already discloses that this site uses only strictly-necessary session
# cookies and (at most) cookie-less analytics, no advertising/tracking
# cookies. Strictly-necessary cookies don't legally require opt-in consent
# under GDPR/ePrivacy, only disclosure, which the Privacy page already
# provides -- building a full accept/reject consent flow here would imply
# non-essential cookies exist when they don't. This is purely a trust/
# expectation-setting notice, dismissed once via localStorage, mirrored
# exactly against what Privacy actually says so it can't drift out of sync.
_COOKIE_NOTICE_HTML = """<div class="dr-cookie-notice" id="dr-cookie-notice" hidden>
  <p>We use only the strictly-necessary cookies described in our <a href="/privacy/">Privacy
  Policy</a> to keep you signed in &mdash; no ads, no trackers.</p>
  <button type="button" id="dr-cookie-notice-dismiss">Got it</button>
</div>
<script>
(function () {
  try {
    if (window.localStorage.getItem('dr_cookie_notice_dismissed')) return;
  } catch (e) { return; }
  var el = document.getElementById('dr-cookie-notice');
  if (!el) return;
  el.hidden = false;
  var btn = document.getElementById('dr-cookie-notice-dismiss');
  if (btn) {
    btn.addEventListener('click', function () {
      el.hidden = true;
      try { window.localStorage.setItem('dr_cookie_notice_dismissed', '1'); } catch (e) {}
    });
  }
})();
</script>"""


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
    canonical_url = "https://deadline-radar.com" + canonical_path
    page_html = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(title)}</title>
<meta name="description" content="{esc(meta_description)}">
<link rel="canonical" href="{esc(canonical_url)}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<meta property="og:title" content="{esc(title)}">
<meta property="og:description" content="{esc(meta_description)}">
<meta property="og:url" content="{esc(canonical_url)}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="{esc(SITE_NAME)}">
<meta property="og:image" content="https://deadline-radar.com/og-image.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{esc(title)}">
<meta name="twitter:description" content="{esc(meta_description)}">
<meta name="twitter:image" content="https://deadline-radar.com/og-image.png">
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
{_SHOW_PASSWORD_TOGGLE_HTML}
{_COOKIE_NOTICE_HTML}
</body>
</html>
"""
    return _strip_shipped_comments(page_html)


def _record_fully_cited(record: dict) -> bool:
    """AuditLab DATA-3 (MEDIUM, 2026-08-04): DATA-1's gate was "does this record
    have a citation" -- true for `dc-all`, whose citation (17 DCMR SS 2547) covers
    only the firm-permit half of a "individual CPA license and firm permit" claim,
    not the individual-license half. A citation existing is not the same as a
    citation covering everything the record claims. `citation_covers_full_claim`
    is an explicit opt-out (defaults True -- only `dc-all` sets it False today) for
    exactly that gap, so trust_line()'s confident sentence can't contradict a
    cycle_description that's already caveating the same record."""
    return bool(record.get("citation")) and record.get("citation_covers_full_claim", True)


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
    absolute positioning, set once in PAGE_CSS rather than per call site.

    Roadmap #47/#302 (2026-08-07, same underlying ask -- #302's own text: "show the
    actual verified date... right on the badge itself, so it reads as 'we checked this
    specific fact on this specific date' rather than a generic trust icon anyone could
    fake"): the date is folded directly into the badge text rather than left to a
    separate stamp/line elsewhere on the page -- this specific badge (used on the
    firm-renewal page) had no adjacent date element at all before this, unlike the
    richer .sheet/.frow fact-sheet cards (render_simple_deadline_records) which already
    show a "Last verified" stamp alongside their own verified checkmark."""
    if not record.get("citation"):
        return ""
    last_verified = record.get("last_verified")
    label = f"Verified {esc(last_verified)}" if last_verified else "Verified"
    return f'<span class="verified-badge">{label}</span>'


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
    points to the real citation_url, the full untruncated string is always in
    title= (a real hover tooltip, present on every chip -- reported as absent
    2026-08-04, but it was there; the actual gap was the hard character cut
    below), and the full string is also shown on the record's actual state page
    one click away -- truncation here is a display-space concession for a
    teaser card, not withholding information.

    Breaks at the last word boundary before max_chars rather than a hard
    character cut, so "...Marketplace" doesn't become "...Marketpl" -- cosmetic
    only, the tooltip and the real citation were never affected by this."""
    if not record.get("citation"):
        return ""
    citation = record["citation"]
    display = citation
    if max_chars and len(citation) > max_chars:
        truncated = citation[: max_chars - 1]
        last_space = truncated.rfind(" ")
        if last_space > max_chars * 0.6:  # don't chop a short first word down to nothing
            truncated = truncated[:last_space]
        display = truncated.rstrip() + "…"
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
        has_citation = _record_fully_cited(r)
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
        f'<tr data-month="{i}"><td>{esc(r["month"])}</td><td>{esc(r["odd_birth_year_next_deadline"])}</td>'
        f'<td>{esc(r["even_birth_year_next_deadline"])}</td></tr>'
        for i, r in enumerate(table, start=1)
    )
    return f"""<div class="callout">
  <p class="rule">{esc(record['cycle_description'])}</p>
  <p><strong>Enter your birth month and year below</strong> to see your date instantly, or
  look up your row in the full table yourself.</p>
</div>
{_birth_month_finder_html(needs_year=True)}
<div class="table-wrap">
  <table>
    <thead><tr><th>Birth month</th><th>Next deadline (odd birth year)</th><th>Next deadline (even birth year)</th></tr></thead>
    <tbody>
    {rows}
    </tbody>
  </table>
</div>
<p>Example: born in March of an odd year (e.g. 1985)? Your next deadline is the
odd-birth-year date on the March row.</p>
{_birth_month_finder_js(needs_year=True)}"""


def render_texas(record: dict, as_of: date) -> str:
    table = build_texas_table(as_of)
    rows = "\n".join(
        f'<tr data-month="{i}"><td>{esc(r["month"])}</td><td>{esc(r["next_deadline"])}</td></tr>'
        for i, r in enumerate(table, start=1)
    )
    return f"""<div class="callout">
  <p class="rule">{esc(record['cycle_description'])}</p>
  <p><strong>Enter your birth month below</strong> to see your date instantly, or look up
  your row in the full table yourself. Texas renewal is annual, so this repeats every year
  on the same month.</p>
</div>
{_birth_month_finder_html(needs_year=False)}
<div class="table-wrap">
  <table>
    <thead><tr><th>Birth month</th><th>Next renewal deadline</th></tr></thead>
    <tbody>
    {rows}
    </tbody>
  </table>
</div>
{_birth_month_finder_js(needs_year=False)}"""


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


# Roadmap #65 (2026-08-07): "staff in TX? here's what CA also requires" --
# genuine multi-state-practice discovery. Land-border adjacency between the
# 48 contiguous states + DC, symmetric by construction (verified with a
# standalone script before being pasted in here: every A-lists-B pair also
# has B-lists-A). Deliberately geography, not an inferred "similar states"
# heuristic like _related_states_html() below uses -- a firm's staff
# realistically clusters across state LINES a firm actually operates near,
# and a land border is simply a fact, never a judgment call that could be
# wrong. Colorado/Arizona and Utah/New Mexico meet ONLY at the single
# Four Corners point, not a real border line, and are deliberately NOT
# listed as neighbors of each other for that reason. Alaska, Hawaii, and
# the 4 territories (Guam, Puerto Rico, Northern Mariana Islands, US
# Virgin Islands) have no bordering US state and are correctly absent
# from this dict entirely -- not an oversight, and _nearby_states_html()
# below renders nothing for them rather than an empty "0 nearby states"
# section.
US_STATE_ADJACENCY: dict[str, list[str]] = {
    "alabama": ["florida", "georgia", "mississippi", "tennessee"],
    "arizona": ["california", "nevada", "new-mexico", "utah"],
    "arkansas": ["louisiana", "mississippi", "missouri", "oklahoma", "tennessee", "texas"],
    "california": ["arizona", "nevada", "oregon"],
    "colorado": ["kansas", "nebraska", "new-mexico", "oklahoma", "utah", "wyoming"],
    "connecticut": ["massachusetts", "new-york", "rhode-island"],
    "dc": ["maryland", "virginia"],
    "delaware": ["maryland", "new-jersey", "pennsylvania"],
    "florida": ["alabama", "georgia"],
    "georgia": ["alabama", "florida", "north-carolina", "south-carolina", "tennessee"],
    "idaho": ["montana", "nevada", "oregon", "utah", "washington", "wyoming"],
    "illinois": ["indiana", "iowa", "kentucky", "missouri", "wisconsin"],
    "indiana": ["illinois", "kentucky", "michigan", "ohio"],
    "iowa": ["illinois", "minnesota", "missouri", "nebraska", "south-dakota", "wisconsin"],
    "kansas": ["colorado", "missouri", "nebraska", "oklahoma"],
    "kentucky": ["illinois", "indiana", "missouri", "ohio", "tennessee", "virginia", "west-virginia"],
    "louisiana": ["arkansas", "mississippi", "texas"],
    "maine": ["new-hampshire"],
    "maryland": ["delaware", "pennsylvania", "virginia", "dc", "west-virginia"],
    "massachusetts": ["connecticut", "new-hampshire", "new-york", "rhode-island", "vermont"],
    "michigan": ["indiana", "ohio", "wisconsin"],
    "minnesota": ["iowa", "north-dakota", "south-dakota", "wisconsin"],
    "mississippi": ["alabama", "arkansas", "louisiana", "tennessee"],
    "missouri": ["arkansas", "illinois", "iowa", "kansas", "kentucky", "nebraska", "oklahoma", "tennessee"],
    "montana": ["idaho", "north-dakota", "south-dakota", "wyoming"],
    "nebraska": ["colorado", "iowa", "kansas", "missouri", "south-dakota", "wyoming"],
    "nevada": ["arizona", "california", "idaho", "oregon", "utah"],
    "new-hampshire": ["maine", "massachusetts", "vermont"],
    "new-jersey": ["delaware", "new-york", "pennsylvania"],
    "new-mexico": ["arizona", "colorado", "oklahoma", "texas"],
    "new-york": ["connecticut", "massachusetts", "new-jersey", "pennsylvania", "vermont"],
    "north-carolina": ["georgia", "south-carolina", "tennessee", "virginia"],
    "north-dakota": ["minnesota", "montana", "south-dakota"],
    "ohio": ["indiana", "kentucky", "michigan", "pennsylvania", "west-virginia"],
    "oklahoma": ["arkansas", "colorado", "kansas", "missouri", "new-mexico", "texas"],
    "oregon": ["california", "idaho", "nevada", "washington"],
    "pennsylvania": ["delaware", "maryland", "new-jersey", "new-york", "ohio", "west-virginia"],
    "rhode-island": ["connecticut", "massachusetts"],
    "south-carolina": ["georgia", "north-carolina"],
    "south-dakota": ["iowa", "minnesota", "montana", "nebraska", "north-dakota", "wyoming"],
    "tennessee": ["alabama", "arkansas", "georgia", "kentucky", "mississippi", "missouri", "north-carolina", "virginia"],
    "texas": ["arkansas", "louisiana", "new-mexico", "oklahoma"],
    "utah": ["arizona", "colorado", "idaho", "nevada", "wyoming"],
    "vermont": ["massachusetts", "new-hampshire", "new-york"],
    "virginia": ["dc", "kentucky", "maryland", "north-carolina", "tennessee", "west-virginia"],
    "washington": ["idaho", "oregon"],
    "west-virginia": ["kentucky", "maryland", "ohio", "pennsylvania", "virginia"],
    "wisconsin": ["illinois", "iowa", "michigan", "minnesota"],
    "wyoming": ["colorado", "idaho", "montana", "nebraska", "south-dakota", "utah"],
}


def _nearby_states_html(state_slug: str, by_slug: dict[str, list[dict]]) -> str:
    """Renders nothing for a state with no bordering US state (Alaska,
    Hawaii, the 4 territories -- all correctly absent from
    US_STATE_ADJACENCY) or if every neighbor is somehow missing from
    by_slug (defensive; every real neighbor has a page today)."""
    neighbors = US_STATE_ADJACENCY.get(state_slug)
    if not neighbors:
        return ""
    links = [
        f'<a href="../{slug}/">{esc(by_slug[slug][0]["state"])}</a>'
        for slug in neighbors
        if slug in by_slug
    ]
    if not links:
        return ""
    return f"""<p class="how-it-works">Also tracking staff in a neighboring state?
{" &middot; ".join(links)}</p>"""


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


def _state_quick_search_html(by_slug: dict[str, list[dict]]) -> str:
    """Roadmap #64 (2026-08-07): the homepage's own "Find your state" search
    box (state-search-input, drGoToState() etc. in _STATE_SEARCH_JS) never
    reached the individual state pages themselves -- getting from Illinois to
    Texas meant a detour back through "Back to all states" first. Reuses the
    exact same JS/CSS as the homepage widget (same element ids/classes, same
    drGoToState() navigation-by-slug), just rendered smaller and generated
    fresh from by_slug/each page's own build call rather than threaded
    through page_shell for every page type."""
    state_options = [{"name": recs[0]["state"], "slug": slug} for slug, recs in sorted(by_slug.items(), key=lambda kv: kv[1][0]["state"])]
    return f"""<div class="state-search">
  <label for="state-search-input">Jump to another state</label>
  <form id="state-search-form" role="search" onsubmit="return drGoToState(event)" autocomplete="off">
    <div class="state-search-field">
      <input type="text" id="state-search-input" name="state" placeholder="e.g. Texas, Illinois, Ohio…"
        autocomplete="off" role="combobox" aria-expanded="false" aria-autocomplete="list"
        aria-controls="state-search-dropdown">
      <div class="state-search-dropdown" id="state-search-dropdown" role="listbox"></div>
    </div>
    <button type="submit" class="state-search-submit">Go</button>
  </form>
</div>
<script>
var DR_STATES = {json.dumps(state_options)};
{_STATE_SEARCH_JS}
</script>"""


def _flag_wrong_html(state_name: str, state_slug: str) -> str:
    """Roadmap #48 (2026-08-07): a user-flaggable 'this looks wrong' link on
    every state page. Deliberately a plain mailto: link, not a new backend
    form/endpoint -- /contact/'s own existing copy already states the site's
    real posture on corrections ("there's a real person on the other end,
    not a support queue"; today ONLY reachable by navigating away to
    /contact/). A backend-persisted flagging system would need its own
    abuse-hardening (rate limiting, spam/Turnstile, a moderation surface)
    for a report-a-typo feature that doesn't need any of that -- the
    existing "email us" channel already has zero abuse surface, a real
    human already reads it, and this just makes the SAME channel reachable
    with one click, pre-filled with the exact state and page URL, directly
    from the page where a visitor would actually notice something wrong,
    instead of requiring a detour to /contact/ first."""
    subject = urllib.parse.quote(f"Data correction: {state_name}")
    body = urllib.parse.quote(
        f"I think something on the {state_name} page looks wrong:\n"
        f"{SITE_BASE_URL}/{state_slug}/\n\n"
        f"What I'm seeing:\n"
    )
    mailto_href = f"mailto:{CONTACT_EMAIL}?subject={subject}&body={body}"
    return (
        f'<p class="flag-wrong"><a href="{esc(mailto_href)}">'
        f"Something on this page look wrong? Flag it &rarr;</a></p>"
    )


def build_state_page(
    state_slug: str, records: list[dict], as_of: date, by_slug: dict[str, list[dict]] | None = None,
    cpe_hours_by_slug: dict[str, dict] | None = None, reinstatement_by_slug: dict[str, dict] | None = None,
    guide_slugs_by_state: dict[str, str] | None = None,
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
    nearby_html = _nearby_states_html(state_slug, by_slug) if by_slug else ""
    cpe_hours_link_html = (
        _cpe_hours_reverse_link_html(state_slug, cpe_hours_by_slug) if cpe_hours_by_slug else ""
    )
    reinstatement_link_html = (
        _reinstatement_reverse_link_html(state_slug, reinstatement_by_slug) if reinstatement_by_slug else ""
    )
    guide_link_html = (
        _blog_guide_reverse_link_html(state_slug, state_name, guide_slugs_by_state) if guide_slugs_by_state else ""
    )
    quick_search_html = _state_quick_search_html(by_slug) if by_slug else ""
    body = f"""<h1>{esc(title)}</h1>
<p class="subhead">{esc(state_name)} CPA license renewal</p>
{deadline_html}
{trust_line(last_verified, source_url, all(_record_fully_cited(r) for r in records))}
{_flag_wrong_html(state_name, state_slug)}
{signup_form_for_state(state_slug, state_name, records, as_of)}
{_cpe_affiliate_html()}
{related_html}
{nearby_html}
{cpe_hours_link_html}
{reinstatement_link_html}
{guide_link_html}
{quick_search_html}
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
            if not (_record_fully_cited(r) and r.get("citation_url") and r.get("next_deadline_computed")):
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
        state_records = by_slug[s["state_slug"]]
        hint = state_hint(state_records)
        variable_class = " state-card--variable" if _hint_is_variable(hint) else ""
        # Roadmap #50 (2026-08-07): "confidence scoring shown to visitors,"
        # scoped to the SAME discrete, already-verified fact each state's own
        # page already discloses via trust_line() -- never a fabricated
        # numeric score. Deliberately shown ONLY on the exception (a record
        # sourced from the board's own page but not independently confirmed
        # against codified law) -- the majority-case "fully verified" state
        # isn't repeated on all ~33 cards, matching how data_gap_note/
        # state-card--variable already flag exceptions rather than the
        # default here.
        fully_cited = all(_record_fully_cited(r) for r in state_records)
        confidence_html = (
            ""
            if fully_cited
            else '<div class="state-confidence" title="Sourced from the state board\'s own page; '
            'not independently confirmed against codified statute or rule text -- see this state\'s '
            'own page for the full disclosure.">Board-page sourced only</div>'
        )
        cards.append(
            f'<a class="state-card{variable_class}" href="{esc(s["state_slug"])}/" data-state-name="{esc(s["state"])}">'
            f'<div class="state-name">{esc(s["state"])}</div>'
            f'<div class="state-hint">{esc(hint)}</div>'
            f'{confidence_html}</a>'
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

    # Roadmap #334 (2026-08-10, ValueLab's Canopy-exhaustive report, RANK #2):
    # sharpens the 3rd trust-row stat below from a static "kept current" claim
    # into the same live, computed freshness figure /methodology/ already
    # shows -- same slot, same hero footprint, a stronger and more specific
    # claim (Canopy repeats one proof token across every page; this is our
    # equivalent, verifiable and recomputed at every build, never hardcoded).
    _verified_recent, _total_citations = _citation_freshness_stat(
        [r for recs in by_slug.values() for r in recs], as_of
    )

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
  <p class="hero-lede"><strong>Finishing every CPE hour and still missing the filing deadline is a
  real, common failure mode</strong> &mdash; this product is about the filing, not the hours.</p>
  <p class="hero-subtext">Every date traced to your state board's own statute or rule, and stamped with
  the day we last checked it.</p>
{search_html}
  <p class="field-hint">Run a whole firm's staff instead?
  <a href="{esc(REMINDER_BACKEND_BASE_URL)}/firm/demo-login" style="font-weight:600;">Try the live demo &rarr;</a>
  A shared account, seeded with sample staff &mdash; one click, no signup, no credentials to type.</p>
  <div class="trust-row">
    <div class="item"><span class="n">{_cov["total"]}</span><span class="lbl">jurisdictions listed</span></div>
    <div class="item"><span class="n">{_cov["determined"]}</span><span class="lbl">where we determine your exact date</span></div>
    <div class="item"><span class="n">{_verified_recent} of {_total_citations}</span><span class="lbl">citations re-checked in the last {STALENESS_THRESHOLD_DAYS} days</span></div>
  </div>
  <p class="trust-footnote">In the remaining {_cov["byod"]}, renewal turns on a personal fact
  &mdash; your birth month, cohort or issue date &mdash; or the board publishes no verifiable date.
  You enter the date on your license and we track it. We would rather say that than round up.</p>
</div>
{hero_right_html}
</div>
<div class="dr-intent-chips" role="navigation" aria-label="Jump to what you need">
  <button type="button" class="dr-intent-chip" id="dr-intent-own-date">I just want my own renewal date</button>
  <a class="dr-intent-chip" href="for-firms/">I track a whole firm's staff</a>
  <a class="dr-intent-chip" href="firm-mobility/">Can my firm sign in another state?</a>
  <a class="dr-intent-chip" href="rule-changes/">What's changing in 2026?</a>
</div>
<script>
(function () {{
  // Roadmap #325 (2026-08-10, ValueLab design-pattern-mining #4): the one
  // chip that isn't a real navigation -- "your own renewal date" is
  // already answerable by the search box sitting right above this row, so
  // this just draws the visitor's eye back to it instead of duplicating
  // the state-search UI a second time on the same page.
  var chip = document.getElementById('dr-intent-own-date');
  var input = document.getElementById('state-search-input');
  if (chip && input) {{
    chip.addEventListener('click', function () {{
      input.scrollIntoView({{ behavior: 'smooth', block: 'center' }});
      input.focus();
    }});
  }}
}})();
</script>"""

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
  <p class="how-it-works"><strong>Roster, calendar, and CPE tracking are free, up to 3 staff</strong>,
  no card required, no time limit. Firm plans from $199/year (up to 5 staff) to $549/year (up to 35
  staff) add the multistate map and practice-privilege check &mdash; every paid tier has the identical
  feature set, gated only by staff count. <a href="for-firms/" style="font-weight:600;">See the firm overview
  &rarr;</a> &middot; <a href="pricing/">Full pricing (incl. individual) &rarr;</a></p>
</section>"""

    body = f"""{hero_html}
{demo_html}
<div id="all-states">
{build_us_map_html(by_slug)}
<div class="state-grid state-grid--mobile-fallback">
{chr(10).join(cards)}
</div>
</div>
{method_band_html}
{firm_preview_html}
<p class="how-it-works">How it works: each state page shows the actual next renewal deadline
(or, where the rule depends on your birth month, a full lookup table) computed from the
verified renewal rule, with a link back to the official source and a "last verified" date.</p>
<p class="how-it-works">Also see our <a href="blog/">guides</a>: <a href="blog/cpe-vs-license-renewal/">CPE requirements vs. license renewal</a>, <a href="blog/common-cpa-renewal-mistakes/">common CPA renewal mistakes</a>, and the <a href="blog/missouri-cpa-license-renewal-guide/">Missouri renewal guide</a>.</p>
<section class="band-section">
{_individual_faq_html()}
</section>
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
        json_ld=[_organization_schema(), _website_schema(), _individual_faq_schema()],
        has_remind_anchor=True,
    )


def build_terms_page(updated: date) -> str:
    """Task #28 (2026-08-05). Genuinely net-new -- grepped the whole codebase
    first and confirmed zero existing "Terms of Service"/"/terms/" reference
    anywhere, including at signup/checkout, which had no agreement language
    pointing at anything. Written the same way build_privacy_page() was
    rewritten: every claim below describes real, shipped behavior (checked
    against tiers.ts, the billing-cancellation handler, and the actual
    live pricing copy on /for-firms/ while writing this), not aspirational
    copy. Does NOT mention a separate paid Individual tier -- the $39/year
    Individual tier was folded into the free tier 2026-08-09 (it never had
    a real checkout path; see tiers.ts/entitlements.ts's own comments) --
    a solo CPA's account is just a free firm account with Practice
    Privilege Check included at no cost. Cancellation terms quote the dashboard's own confirm-dialog
    wording verbatim (generate.py's drToggleCancellation()) rather than a
    paraphrase that could drift from what the product actually does."""
    body = f"""<h1>Terms of Service</h1>
<p class="intro"><strong>The short version:</strong> {esc(SITE_NAME)} is an informational reminder and
license-tracking service. Free individual reminders stay free. Paid firm plans self-serve cancel any
time &mdash; no refund for the time already paid for, but you keep full access through the end of the
period you paid for. Nothing here is legal, tax, or professional advice.</p>

<h2>1. Who we are, and what this service is</h2>
<p>{esc(SITE_NAME)} is operated by {esc(BRAND_NAME)}. We track publicly available CPA license renewal
deadlines, CPE requirements, and practice-privilege (mobility) rules, and send reminder emails based on
them. We are an independent service &mdash; <strong>not affiliated with, endorsed by, or connected to
NASBA, the AICPA, or any state board of accountancy.</strong> Renewal dates and rules are compiled from
public sources for informational purposes only; they are not legal, tax, or professional advice, and you
should always confirm your exact deadline and requirements directly with your state board before relying
on anything shown here.</p>

<h2>2. Accounts</h2>
<p>An individual reminder signup requires only an email address and state. A firm account additionally
requires an admin email, and may have a password you set. You're responsible for keeping your login
credentials confidential and for all activity under your account. If a firm admin adds staff to a
roster, that admin is responsible for the accuracy of the license and contact information entered on
that person's behalf.</p>

<h2>3. Free tier and paid firm plans</h2>
<p>Individual reminder signups are free, with no card required, for as long as you stay subscribed. New
firm accounts start on a <strong>standing free tier</strong> &mdash; roster, calendar, and CPE-hours
tracking, with no card required and no time limit. Individual Practice Privilege Check (one person, one
target state) is also free on every tier. Nothing is charged unless and until you choose to upgrade to a
paid firm plan for the multistate map and the firm-level registration check.</p>

<h2>4. Paid firm plans and billing</h2>
<p>Paid firm plans (Essentials, Growth, Professional, and Enterprise, priced by staff-count capacity &mdash; every tier has
the identical feature set) are billed annually in advance through Stripe. We never see or store your card
number; Stripe processes payment directly. By subscribing to a paid plan, you authorize us to charge your
payment method on file for each renewal period until you cancel. A solo CPA tracking only their own
license gets the multistate map and firm-level registration check included on the free tier too, at no
cost &mdash; no separate paid plan or billing relationship for that case.</p>

<h2>5. Cancellation and refunds</h2>
<p>You can cancel a paid subscription at any time from your account's Billing tab. <strong>Cancelling
stops future renewal charges but does not refund the current period</strong> &mdash; you keep full access
to your plan through the end of the period you already paid for, then your account reverts to the free
tier (roster, calendar, CPE-hours tracking, and individual Practice Privilege Check remain available; the
map and firm-level registration check do not). You can resume a subscription you've scheduled to cancel
at any point before that period ends, and billing continues normally. Cancelling alone is not prorated or
refunded; deleting your account instead of just cancelling is &mdash; see Section 11.</p>

<h2>6. Acceptable use</h2>
<p>You agree not to: use the service to violate any law; attempt to access another firm's account, staff
roster, or data; interfere with or disrupt the service's operation; scrape or bulk-extract data from the
site beyond normal use of the tools we provide; or misrepresent your identity or authority to add staff
to a firm roster. We may suspend or terminate an account that violates this section.</p>

<h2>7. Practice Privilege Check and CPE tracking are informational tools, not verification</h2>
<p>The Practice Privilege Check tool and CPE-hour tracking reflect rules we've researched and hours you
or your firm self-report &mdash; they are not independently verified against your actual license status,
and a "clear" result is never a substitute for confirming directly with the relevant state board of
accountancy before providing services there. See each result's own disclaimer for the specifics.</p>

<h2>8. Intellectual property</h2>
<p>The site's design, code, and compiled datasets belong to {esc(BRAND_NAME)}. We grant you a limited,
non-exclusive right to use the service for its intended purpose &mdash; tracking your own or your firm's
renewal deadlines. You may not copy, resell, or redistribute the service or its underlying data as your
own product.</p>

<h2>9. Disclaimers</h2>
<p>The service is provided "as is." We work to keep renewal dates, CPE requirements, and mobility rules
accurate and current (see <a href="/methodology/">how we verify our data</a>), but rules change, and we
cannot guarantee the service is error-free or that a deadline will never change after we've verified it.
<strong>We are not liable for a missed deadline, late fee, license lapse, or any other consequence of
relying on information from this service</strong> instead of confirming directly with the applicable
state board of accountancy.</p>

<h2>10. Limitation of liability</h2>
<p>To the maximum extent permitted by law, {esc(BRAND_NAME)}'s total liability for any claim relating to
the service is limited to the amount you paid us, if any, in the 12 months before the claim arose. We are
not liable for indirect, incidental, or consequential damages.</p>

<h2>11. Termination</h2>
<p>You may stop using the service at any time &mdash; the one-click unsubscribe link in any reminder
email works instantly for individual reminders; a firm admin can cancel a paid plan from the Billing tab
(access continues through the period already paid for, no refund) or delete the account entirely from
the Account tab. Deleting is different from cancelling: it deactivates your account immediately, and if
you're on a paid plan, we refund the prorated, unused portion of your current billing period rather than
holding payment for time you can no longer access. Deleted account data is permanently erased 30 days
later. We may suspend or terminate an account for violating these terms.</p>

<h2>12. Changes to these terms</h2>
<p>We may update these terms from time to time. The "last updated" date below always reflects the current
version. Continued use of the service after a change means you accept the updated terms.</p>

<h2>13. Governing law</h2>
<p>These terms are governed by the laws of the State of Colorado, without regard to conflict-of-law
principles.</p>

<h2>14. Contact</h2>
<p>Questions about these terms:</p>
<p>{esc(SITE_NAME)} by {esc(BRAND_NAME)}<br>
18121 E Hampden Ave, Unit C #1324<br>
Aurora, CO 80013</p>

<p class="how-it-works">Last updated: {esc(fmt_date(updated))}. See also our <a
href="/privacy/">Privacy Policy</a>.</p>
"""
    return page_shell(
        f"Terms of Service — {SITE_NAME}",
        "The terms that govern using DeadlineRadar's free reminders and paid firm plans, including "
        "our self-serve cancellation and no-refund billing policy.",
        body,
        home_href="../",
        canonical_path="/terms/",
    )


def _pricing_feature_table_rows_html() -> str:
    """Free-vs-paid feature grid (2026-08-09, Devin-greenlit, ValueLab's #1 site
    fix -- "you are underselling a better product than you appear to have").
    Every row below is checked directly against the shipped code, not
    assumed from memory of what was BUILT to be true -- see the session's own
    verification pass before writing this:

    - SMS is deliberately NOT a row here: it's a capability of the separate
      free public individual-subscriber product (worker/src/sms.ts,
      scheduler.ts's runSmsAlertPass() pulls from the `subscribers` table),
      not a firm-roster feature at all. Listing it here would be exactly the
      kind of inaccurate-comparison-table mistake this table exists to fix.
    - Slack/Teams alerts moved behind the paid tier for NEW signups
      (roadmap #151 Phase 3, 2026-08-10) -- same grandfather mechanism as
      document storage below. Gated in two places: the connect/webhook-set
      handlers (stops a new post-cutover free firm from connecting) AND the
      scheduler send passes runSlackAlertPass/runTeamsAlertPass (closes the
      gap where downgrading after connecting never clears the stored
      webhook on its own).
    - Document storage moved behind the paid tier for NEW signups (roadmap
      #151, 2026-08-10) -- existing free firms keep it (grandfathered),
      but a firm signing up today does not get it free. No solo-account
      exception here (unlike Map/PPC below) -- it's a flat paid-vs-free
      split by signup date, same 2MB/file, 50MB/firm cap either way
      (store.ts's DOCUMENT_MAX_FILE_BYTES/DOCUMENT_MAX_FIRM_TOTAL_BYTES).
    - The referral program is functionally PAID-ONLY even though nothing in
      entitlements.ts names it explicitly: store.mintReferralCode()'s only
      two callers are both inside handleStripeWebhook, tied to a real paid
      Stripe invoice (checkout.session.completed / invoice.created) -- a
      free-tier firm's referral_code stays null forever, shown on the
      dashboard as "no active code yet."
    - Inviting a SECOND team member login is its OWN paid-only gate
      (handleFirmMemberInvite 402s a free-tier firm outright) -- separate
      from, and stricter than, the roster-of-LICENSES cap itself (3 for a
      new signup as of roadmap #151, 2026-08-10; existing free firms keep
      their prior 25). Listed as its own row so the two aren't conflated.
    - Map / the firm-level registration check (roadmap #318) both carry the
      same solo-free exception (2026-08-09): a genuinely one-person free
      account gets them too. Marked with the page's own footnote rather
      than a plain "Paid only" that would now be inaccurate.
    - Individual Practice Privilege Check (one person, one target state) is
      its OWN row, free for every tier since 2026-08-10 (Devin's decision,
      matching NASBA's own CPAmobility.org giving the identical lookup away
      free/unlimited) -- NOT the same solo-free exception as the two rows
      above, so it can't share their asterisk without implying a firm with
      teammates doesn't get it too. It does.
    """
    rows = [
        ("Roster &amp; staff license tracking", "Up to 3 staff", "Up to 35 staff (Enterprise)"),
        ("Calendar view", "Yes", "Yes"),
        ("CPE-hour tracking", "Yes", "Yes"),
        ("Email renewal reminders", "Yes", "Yes"),
        ("Individual Practice Privilege Check", "Yes", "Yes"),
        ("Slack &amp; Teams deadline alerts", "&mdash;", "Yes"),
        ("Document storage (2MB/file, 50MB/firm)", "&mdash;", "Yes"),
        ("Invite teammates to sign in", "Just you", "Yes"),
        ("Multistate Map view", "Solo accounts only*", "Yes"),
        ("Firm-level registration check", "Solo accounts only*", "Yes"),
        ("Refer a firm, both get 10% off", "&mdash;", "Yes"),
    ]
    return "\n".join(f"  <tr><td>{label}</td><td>{free_cell}</td><td>{paid_cell}</td></tr>" for label, free_cell, paid_cell in rows)


def build_pricing_page(by_slug: dict[str, list[dict]], as_of: date) -> str:
    """Task #8 (2026-08-06): a dedicated /pricing/ page. Devin's rationale (the
    task's own record): an individual visitor may never click into
    /for-firms/, so today they never see ANY pricing. This is the one
    canonical pricing surface with all rows -- /for-firms/'s own pricing
    list stays as-is (that sub-question wasn't part of what Devin decided,
    only that firm-tier buttons should go straight into real checkout), but
    now links here too instead of being the only place pricing lives.

    Firm-tier buttons always attempt a REAL Stripe checkout first (Devin's
    explicit call, see _PRICING_CHECKOUT_JS_HTML's own comment for the
    anonymous-visitor fallback).

    Individual tier FOLDED INTO FREE 2026-08-09 (Devin's decision): the old
    $39/yr Individual card had a dead "checkout isn't live yet" mailto CTA
    -- rather than build real checkout for a tier nobody could ever
    actually buy, it's gone. A solo CPA (a firm account that never invites
    a second person) gets Practice Privilege Check at no cost -- see
    entitlements.ts's own solo-free exception. The card below reflects
    that: free, a real signup link, no mailto dead end.
    """
    _verified_recent, _total_citations = _citation_freshness_stat(
        [r for recs in by_slug.values() for r in recs], as_of
    )
    body = f"""<h1>Pricing</h1>
<p class="intro">Roster, calendar, CPE-hours tracking, and individual Practice Privilege Check are
<strong>free for any firm, up to 3 staff</strong>, no card required, no time limit. Paid firm plans add
the multistate map and the firm-level registration check &mdash; every paid tier has the identical
feature set, priced only by how many staff it covers; nothing is held back on a cheaper plan.</p>
<p class="field-hint"><strong>{_verified_recent} of {_total_citations}</strong> citations on this site
were individually re-checked against their source within the last {STALENESS_THRESHOLD_DAYS} days
&mdash; <a href="/methodology/">see exactly how we verify every deadline</a>.</p>

<p id="dr-pricing-error" role="alert" class="field-hint" style="color:#c33737;" hidden></p>

<div class="pricing-grid">
  <div class="pricing-card">
    <h2>Individual</h2>
    <p class="price">Free</p>
    <p class="detail">Your own CPE-hour tracking and Practice Privilege Check &mdash; included at no
    cost for a solo CPA tracking just your own license.</p>
    <a class="dr-paywall-tier-btn" href="/firm-login/#dr-view-signup">Create a free account</a>
    <p class="detail">Just want free renewal reminders? <a href="/#remind">Sign up free</a> &mdash; no
    account needed.</p>
  </div>
  <div class="pricing-card">
    <h2>Essentials</h2>
    <p class="price">$199<span>/year</span></p>
    <p class="detail">Up to 5 staff.</p>
    <button type="button" class="dr-paywall-tier-btn dr-pricing-tier-btn" data-tier="firm_starter">Get Essentials</button>
  </div>
  <div class="pricing-card">
    <h2>Growth</h2>
    <p class="price">$299<span>/year</span></p>
    <p class="detail">Up to 10 staff.</p>
    <button type="button" class="dr-paywall-tier-btn dr-pricing-tier-btn" data-tier="firm_growth">Get Growth</button>
  </div>
  <div class="pricing-card">
    <h2>Professional</h2>
    <p class="price">$399<span>/year</span></p>
    <p class="detail">Up to 20 staff.</p>
    <button type="button" class="dr-paywall-tier-btn dr-pricing-tier-btn" data-tier="firm_standard">Get Professional</button>
  </div>
  <div class="pricing-card">
    <h2>Enterprise</h2>
    <p class="price">$549<span>/year</span></p>
    <p class="detail">Up to 35 staff.</p>
    <button type="button" class="dr-paywall-tier-btn dr-pricing-tier-btn" data-tier="firm_scale">Get Enterprise</button>
  </div>
  <div class="pricing-card pricing-card--wide">
    <h2>More than 35 staff?</h2>
    <p class="detail"><a href="mailto:{esc(CONTACT_EMAIL)}">Contact us</a> &mdash; no formula, we'll work out what fits.</p>
  </div>
</div>

<p>Roster, calendar, CPE-hours tracking, and individual Practice Privilege Check are free for any firm,
up to 3 staff, no card required, no time limit. The buttons above are for the paid map + firm-level
registration check tiers: if you don't already have a firm account, they start free signup first; if
you're already signed in, they go straight to checkout for that tier, same as the dashboard's own
upgrade panel.</p>

<h2>What's actually included, free vs. paid</h2>
<p class="intro">Every paid tier (Essentials through Enterprise) has the identical feature set, priced
only by staff count. This table is the real, code-verified breakdown &mdash; not a marketing summary.</p>

<div class="table-wrap">
<table class="compare-table">
  <caption class="dr-visually-hidden">Free vs. paid firm plan feature comparison</caption>
  <thead>
    <tr><th scope="col">Feature</th><th scope="col">Free</th><th scope="col">Paid (any tier)</th></tr>
  </thead>
  <tbody>
{_pricing_feature_table_rows_html()}
  </tbody>
</table>
</div>
<p class="field-hint">* A solo account (you're the only person signed in, no team invited) gets the Map
and the firm-level registration check free too &mdash; inviting a teammate is itself a paid-tier
feature, so a genuinely one-person account is where "free" and "everything included"
overlap.</p>

<p class="backlink">See exactly <a href="/methodology/">how we verify every deadline</a>, or read the
<a href="/for-firms/">full firm-tier breakdown</a>.</p>
"""
    return page_shell(
        f"Pricing — {SITE_NAME}",
        "DeadlineRadar pricing: free individual reminders and free Practice Privilege Check for any "
        "firm, and firm plans from $199/year for up to 5 staff, up to $549/year for up to 35. Every "
        "firm tier has the identical feature set.",
        body,
        home_href="../",
        canonical_path="/pricing/",
        has_remind_anchor=False,
    ) + _PRICING_CHECKOUT_JS_HTML


# Roadmap #335 (2026-08-10, ValueLab's 137-page Canopy-comparison-page
# walkthrough): named practice-management-suite competitors, priced for a
# 6-person firm -- the SAME two facts /compare/ has independently verified
# per competitor (2026-08-10 pricing-page check + the "does not track a
# staff CPA license" observation), pulled into one canonical list so the
# overview table and each competitor's own dedicated page can't drift apart.
# Deliberately NOT 5 -- ValueLab's item asked for "5, not Canopy's 18" as an
# upper bound, but this file only has independently verified facts for 3 of
# that shape (Canopy/Karbon/TaxDome) plus MYCPE ONE (a different shape, see
# below) -- inventing a 5th competitor's numbers to hit a round number would
# violate the exact honesty standard the item itself invoked. Flagged to the
# orchestrator rather than guessed.
COMPETITOR_FACTS = [
    {
        "slug": "canopy",
        "name": "Canopy",
        "plan_name": "Standard",
        "annual_cost_6_person": "~$5,328/year",
        "cost_basis": "$74/user/mo",
    },
    {
        "slug": "karbon",
        "name": "Karbon",
        "plan_name": "Business",
        "annual_cost_6_person": "~$6,408/year",
        "cost_basis": "$89/user/mo",
    },
    {
        "slug": "taxdome",
        "name": "TaxDome",
        "plan_name": "Pro",
        "annual_cost_6_person": "~$6,000/year",
        "cost_basis": "$1,000/seat/yr, 1-yr term",
    },
]

# MYCPE ONE is a different shape (a CPE-hours platform, not a practice-
# management suite) so it doesn't fit COMPETITOR_FACTS' 6-person-firm cost
# table -- kept as its own fact record for the same reason: one canonical
# source both /compare/ and its own dedicated page read from.
MYCPE_ONE_FACTS = {
    "slug": "mycpe-one",
    "name": "MYCPE ONE",
    "annual_cost": "$199/year",
}

# Populated by main()'s build loop, same pattern as FIRM_LANDING_PAGES --
# build_sitemap() reads this once it's known.
COMPETITOR_COMPARE_PAGES: list[dict] = []


def build_compare_page(by_slug: dict[str, list[dict]], as_of: date) -> str:
    """Roadmap #33 (2026-08-07, roadmap_items table, IMMEDIATE RELEASE):
    "Comparison page (DeadlineRadar vs. spreadsheet vs. competitor)."

    Named real competitors added 2026-08-10 (ValueLab's customer-walkthrough
    report, independently spot-checked by the orchestrator) -- the ORIGINAL
    build deliberately named no one because this file had no verified,
    current facts about any named third party's actual pricing, and
    publishing unverified claims about a real business is both a
    false-advertising risk and flatly against this site's own
    two-source-verification standard (build_methodology_page()). That
    constraint hasn't changed in principle -- only the FACT SET has: pricing
    for a 6-person firm and the single feature-absence claim "does not track
    a staff CPA license" are now independently verified (ValueLab + a second
    check), so those two claims are named. Everything else about those
    products (their full feature set, their own roadmap, anything not
    checked above) is still unverified here and stays out -- the feature
    table below still uses a generic, unnamed "tracking tool" column for
    every claim this file cannot independently back up.
    """
    # Free/Paid split added 2026-08-09 (Devin, alongside the /pricing/
    # feature table this mirrors) -- the single "DeadlineRadar" column used
    # to claim "Yes" unconditionally for the Map/Practice Privilege Check
    # row, which was already inaccurate the moment those became paid-tier
    # features. Splitting into Free/Paid fixes that instead of just adding
    # a column that repeats the same wrong claim twice.
    rows = [
        (
            "Sourced, cited renewal dates for all 55 U.S. jurisdictions",
            "Yes",
            "Yes",
            "You research and maintain this yourself, state by state.",
            "Usually generic scheduling, not built around real CPA renewal rules.",
        ),
        (
            "Automated email reminders before a deadline",
            "Yes",
            "Yes",
            "Only if you build your own reminder system on top of it.",
            "Varies by tool; rarely tuned to a CPA renewal cycle specifically.",
        ),
        (
            "Slack &amp; Teams deadline alerts",
            "&mdash;",
            "Yes",
            "No.",
            "Not CPA-specific; varies by tool.",
        ),
        (
            "Individual Practice Privilege Check (one person, one target state)",
            "Yes",
            "Yes",
            "No, you would have to research each state's mobility rule yourself.",
            "Not CPA-specific, so this generally does not exist.",
        ),
        (
            "Multistate coverage Map, and firm-level registration check",
            "Solo accounts only*",
            "Yes &mdash; Map view plus a firm-level registration check.",
            "No, you would have to research each state's mobility rule yourself.",
            "Not CPA-specific, so this generally does not exist.",
        ),
        (
            "CPE-hour tracking against the real requirement for each state",
            "Yes",
            "Yes",
            "Manual, and easy to lose track of across a whole roster.",
            "Usually a generic hour counter, not tied to actual state CPE rules.",
        ),
        (
            "Setup effort",
            "Minutes",
            "Minutes &mdash; add a staff member and their state, done.",
            "Hours of your own research, plus ongoing upkeep as rules change.",
            "Some setup, but you still have to supply the CPA-specific rules yourself.",
        ),
        (
            "Cost",
            "$0, no card required, no time limit.",
            "$199&ndash;$549/year, priced by staff count (see full pricing).",
            "Free license cost, but your own time is the real cost.",
            "Varies; often priced for general use, not firm-specific compliance tracking.",
        ),
    ]
    table_rows_html = "\n".join(
        f"  <tr><td>{esc(label)}</td><td>{esc(free_cell)}</td><td>{paid_cell}</td><td>{esc(spreadsheet_cell)}</td><td>{esc(generic_cell)}</td></tr>"
        for label, free_cell, paid_cell, spreadsheet_cell, generic_cell in rows
    )
    _verified_recent, _total_citations = _citation_freshness_stat(
        [r for recs in by_slug.values() for r in recs], as_of
    )
    competitor_rows_html = "\n".join(
        f'    <tr><td><a href="{esc(c["slug"])}/">{esc(c["name"])} ({esc(c["plan_name"])})</a></td>'
        f'<td>{esc(c["annual_cost_6_person"])}</td><td>No</td></tr>'
        for c in COMPETITOR_FACTS
    )
    body = f"""<h1>DeadlineRadar vs. Practice-Management Suites vs. a Spreadsheet</h1>
<p class="intro">Every one of those other trackers makes <em>you</em> type in the expiration date and
takes it on faith. We compute it from the codified statute or board rule and show you the citation
&mdash; that's the one sentence that actually separates this from a CPE vendor, a practice-management
suite's generic renewals tab, or a spreadsheet: <a href="/methodology/">see exactly how we verify every
date</a>. <strong>{_verified_recent} of {_total_citations}</strong> of those citations were
individually re-checked against their source within the last {STALENESS_THRESHOLD_DAYS} days.</p>

<h2>What a 6-person firm pays elsewhere</h2>
<p>None of these track an individual staff CPA's license renewal &mdash; they're practice-management
suites with a generic reminders/tasks feature, not a sourced compliance tool. Prices below are each
product's own published rate for a 6-person firm, checked directly against their current pricing pages.
Competitor prices verified 2026-08-10 against each vendor's published pricing page (Canopy Standard
$74/user/mo; Karbon Business $89/user/mo; TaxDome Pro $1,000/seat/yr, 1-yr term); they may have changed
since.</p>
<div class="table-wrap">
<table class="compare-table">
  <caption class="dr-visually-hidden">Annual cost for a 6-person firm, DeadlineRadar vs. named practice-management suites</caption>
  <thead><tr><th scope="col">Product</th><th scope="col">Annual cost, 6-person firm</th><th scope="col">Tracks a staff CPA's license?</th></tr></thead>
  <tbody>
    <tr><td><strong>DeadlineRadar</strong></td><td>$299/year (Growth tier, up to 10 staff)</td><td>Yes</td></tr>
{competitor_rows_html}
  </tbody>
</table>
</div>
<p class="field-hint">These are broad practice-management platforms &mdash; client portals, workflow,
document management &mdash; and license tracking is a reasonable thing for them not to specialize in.
The point isn't that they're bad products; it's that a firm already paying one of them still has no
sourced answer to "when does Alex's CPA license renew" without something like this alongside it.</p>

<h2>The one competitor close enough in price to actually confuse</h2>
<p><strong><a href="{esc(MYCPE_ONE_FACTS["slug"])}/">MYCPE ONE</a></strong> lists at {esc(MYCPE_ONE_FACTS["annual_cost"])}
&mdash; the same headline price our old Individual tier used to carry. Worth naming specifically because
it's the one product priced close enough to cause real confusion, but it does a different job: it's a
CPE-hours platform (tracking completed continuing-education credits), not a license-renewal filing
tracker. Both matter to a CPA; they're not the same problem, and DeadlineRadar's own CPE Hours tab is
free, not a $199 add-on.</p>

<h2>Feature-by-feature, DeadlineRadar vs. a spreadsheet vs. a generic tool</h2>
<p class="intro">The table above names real products for the two facts we've independently verified
(price, and whether they track a staff license). For everything else &mdash; what's actually inside a
generic subscription-tracking tool, feature by feature &mdash; this file has no verified, current facts
about any one company, so the comparison below stays honest about that and names no one (see
<a href="/methodology/">How We Verify</a> for the same standard applied to every renewal date).</p>

<div class="table-wrap">
<table class="compare-table">
  <caption class="dr-visually-hidden">Feature comparison: DeadlineRadar free tier, DeadlineRadar paid tier, a spreadsheet, and a generic tracking tool</caption>
  <thead>
    <tr><th scope="col">Feature</th><th scope="col">DeadlineRadar Free</th><th scope="col">DeadlineRadar Paid</th><th scope="col">A spreadsheet</th><th scope="col">A generic tracking tool</th></tr>
  </thead>
  <tbody>
{table_rows_html}
  </tbody>
</table>
</div>
<p class="field-hint">* A solo account (you're the only person signed in, no team invited) gets the Map and
firm-level registration check free too &mdash; see the <a href="/pricing/">full free-vs-paid breakdown</a>.
The individual check above is free for every account regardless.</p>

<h2>Where a spreadsheet is genuinely fine</h2>
<p>If your firm has one or two staff and someone is already diligent about checking renewal dates by
hand, a spreadsheet works. It gets harder as headcount grows, as staff move between states, and as CPE
requirements pile up per person &mdash; the failure mode is never a dramatic one, it is a single missed
renewal on a spreadsheet no one opened that week.</p>

<p class="backlink">See <a href="/pricing/">pricing</a>, or <a href="/for-firms/">the full firm-tier
breakdown</a>.</p>
"""
    return page_shell(
        f"DeadlineRadar vs. Canopy, Karbon, TaxDome, and a Spreadsheet — {SITE_NAME}",
        "What a 6-person firm pays for Canopy, Karbon, and TaxDome vs. DeadlineRadar, plus an honest "
        "feature-by-feature comparison against a spreadsheet and generic tracking tools.",
        body,
        home_href="../",
        canonical_path="/compare/",
        has_remind_anchor=False,
    )


def build_competitor_compare_page(c: dict) -> tuple[str, str, str]:
    """Roadmap #335 -- one dedicated page per named practice-management-suite
    competitor, split out of /compare/'s single combined page. Reuses the
    exact same COMPETITOR_FACTS entry /compare/'s own table reads from, so
    the two pages can't drift on price. Returns (slug, title, html_body)."""
    title = f"DeadlineRadar vs. {c['name']} — CPA License Renewal Tracking"
    meta_description = (
        f"DeadlineRadar vs. {c['name']} for a 6-person CPA firm: {c['annual_cost_6_person']} vs. "
        f"$299/year, and whether either one tracks an individual staff CPA's license renewal."
    )
    body = f"""<h1>{esc(title)}</h1>
<p class="intro">{esc(c['name'])} ({esc(c['plan_name'])}) is a practice-management suite &mdash; client
portals, workflow, document management. It's a genuinely different product than DeadlineRadar, not a
head-to-head rival, and a firm can reasonably run both. This page exists for the one question that
actually overlaps: does either one track when an individual staff CPA's <em>license itself</em> is due
for renewal.</p>

<div class="table-wrap">
<table class="compare-table">
  <caption class="dr-visually-hidden">Annual cost for a 6-person firm, DeadlineRadar vs. {esc(c['name'])}</caption>
  <thead><tr><th scope="col">Product</th><th scope="col">Annual cost, 6-person firm</th><th scope="col">Tracks a staff CPA's license?</th></tr></thead>
  <tbody>
    <tr><td><strong>DeadlineRadar</strong></td><td>$299/year (Growth tier, up to 10 staff)</td><td>Yes</td></tr>
    <tr><td>{esc(c['name'])} ({esc(c['plan_name'])})</td><td>{esc(c['annual_cost_6_person'])}</td><td>No</td></tr>
  </tbody>
</table>
</div>
<p class="field-hint">{esc(c['name'])}'s price above is its own published rate ({esc(c['cost_basis'])}),
verified 2026-08-10 against its current pricing page &mdash; it may have changed since. DeadlineRadar's
sourced, cited renewal dates for all 55 U.S. jurisdictions are described in full on our
<a href="../../methodology/">verification methodology page</a>.</p>

<h2>Why this isn't really a competitive comparison</h2>
<p>{esc(c['name'])} solves client-facing workflow &mdash; the day-to-day of running client engagements.
DeadlineRadar solves one narrow, specific compliance problem: knowing, with a citation, exactly when
every staff CPA's license and firm registration is due, and getting reminded before it lapses. Most
firms using {esc(c['name'])} still have no sourced answer to "when does this person's license renew"
inside it &mdash; that's not a criticism, license tracking just isn't what it's built for.</p>

<p class="backlink">See the <a href="../">full comparison page</a>, or <a href="../../pricing/">DeadlineRadar
pricing</a>.</p>
"""
    html = page_shell(
        f"{title} — {SITE_NAME}", meta_description, body, home_href="../../",
        canonical_path=f"/compare/{c['slug']}/", has_remind_anchor=False,
    )
    return c["slug"], title, html


def build_mycpe_one_compare_page() -> tuple[str, str, str]:
    """Roadmap #335 -- MYCPE ONE's own dedicated page. Kept separate from
    build_competitor_compare_page() since it's a different shape (a CPE-hours
    platform, not a practice-management suite) with a different comparison
    (CPE tracking scope, not a 6-person-firm cost table)."""
    c = MYCPE_ONE_FACTS
    title = f"DeadlineRadar vs. {c['name']} — CPE Tracking vs. License Renewal Tracking"
    meta_description = (
        f"DeadlineRadar vs. {c['name']}: {c['name']} tracks completed CPE hours for {c['annual_cost']}. "
        f"DeadlineRadar's CPE Hours tracking is free, and also tracks the license renewal itself."
    )
    body = f"""<h1>{esc(title)}</h1>
<p class="intro">{esc(c['name'])} lists at {esc(c['annual_cost'])} &mdash; close enough to our old
Individual tier's own headline price to cause real confusion. But it does a different job: it's a
CPE-hours platform, tracking completed continuing-education credits. DeadlineRadar tracks the license
renewal filing itself &mdash; a genuinely different deadline, on a genuinely different clock in most
states.</p>

<div class="table-wrap">
<table class="compare-table">
  <caption class="dr-visually-hidden">DeadlineRadar vs. {esc(c['name'])}</caption>
  <thead><tr><th scope="col">Product</th><th scope="col">Price</th><th scope="col">What it tracks</th></tr></thead>
  <tbody>
    <tr><td><strong>DeadlineRadar</strong></td><td>Free (individual)</td>
      <td>License renewal deadline, sourced and cited &mdash; plus free CPE-hour tracking against the
      real requirement for your state.</td></tr>
    <tr><td>{esc(c['name'])}</td><td>{esc(c['annual_cost'])}</td>
      <td>Completed CPE hours/credits.</td></tr>
  </tbody>
</table>
</div>
<p class="field-hint">Both matter to a working CPA &mdash; missing your CPE hours and missing your
license renewal are two different ways to end up out of compliance, covered in more depth in our
<a href="../../blog/cpe-vs-license-renewal/">CPE vs. license renewal</a> guide. DeadlineRadar's own
CPE Hours tab is free, not a paid add-on.</p>

<p class="backlink">See the <a href="../">full comparison page</a>, or <a href="../../pricing/">DeadlineRadar
pricing</a>.</p>
"""
    html = page_shell(
        f"{title} — {SITE_NAME}", meta_description, body, home_href="../../",
        canonical_path=f"/compare/{c['slug']}/", has_remind_anchor=False,
    )
    return c["slug"], title, html


def build_roadmap_page() -> str:
    """Task #19 (2026-08-06): public roadmap voting. Design settled with
    Devin across several rounds -- see migration 0029's own docstring for
    the full reasoning. Voting is anonymous (a cookie, no account); "notify
    me when this ships" is a separate, optional, email-confirmed opt-in.

    The idea list and vote counts are NOT baked in at build time -- they're
    live (GET /roadmap-data), same reasoning /firm-mobility/'s roster
    dropdown fetches live rather than being static. One shared Turnstile
    widget (shared_widget=True forms) covers both the vote buttons and the
    notify-signup forms, matching /firm-login/'s own multi-form pattern --
    a widget per idea would be visually loud on a page meant to be quick to
    use.
    """
    body = f"""<h1>Roadmap</h1>
<p class="intro">Vote on what we build next. No account needed &mdash; one click per idea, and you can
change your mind later. Want an email when something ships? Say so after you vote.</p>

{_turnstile_shared_widget_html()}

<div id="dr-roadmap-error" role="alert" class="field-hint" style="color:#c33737;" hidden></div>
<div id="dr-roadmap-list" class="dr-roadmap-list"><p class="dr-panel-empty">Loading&hellip;</p></div>

<p class="backlink">Have an idea that's not listed? <a href="mailto:{esc(CONTACT_EMAIL)}?subject=Roadmap%20idea">Tell us</a> &mdash;
new ideas get added by hand, not submitted directly, to keep this list something worth actually
looking at.</p>
"""
    return page_shell(
        f"Roadmap — {SITE_NAME}",
        "Vote on what DeadlineRadar builds next -- SMS reminders, practice-management integrations, "
        "API access, and more. No account needed.",
        body,
        home_href="../",
        canonical_path="/roadmap/",
        has_remind_anchor=False,
    ) + _ROADMAP_JS_HTML


# Fixed, in case the idea list ever needs a client-side label without a
# server round trip -- kept as documentation of what ships server-side in
# migration 0029's seed data, not read by the JS below (which always
# renders whatever GET /roadmap-data actually returns, live).
_ROADMAP_HONEYPOT_TURNSTILE_HIDDEN_HTML = (
    f'<div aria-hidden="true" style="position:absolute;left:-9999px;top:-9999px;height:0;width:0;overflow:hidden;">'
    f'<input type="text" name="{_HONEYPOT_FIELD_NAME}" tabindex="-1" autocomplete="off"></div>'
    f'<input type="hidden" name="cf-turnstile-response" value="">'
)

_ROADMAP_JS_HTML = f"""<script>
(function() {{
  var API = "{REMINDER_BACKEND_BASE_URL}";
  var listEl = document.getElementById('dr-roadmap-list');
  var errEl = document.getElementById('dr-roadmap-error');
  if (!listEl) return;

  function esc(s) {{
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }}

  var hiddenFieldsHtml = {json.dumps(_ROADMAP_HONEYPOT_TURNSTILE_HIDDEN_HTML)};

  var STATUS_LABELS = {{in_progress: 'In progress', shipped: 'Shipped'}};

  function render(ideas) {{
    listEl.innerHTML = ideas.map(function(idea) {{
      var statusLabel = STATUS_LABELS[idea.status];
      var statusBadge = statusLabel
        ? '<span class="dr-roadmap-status dr-roadmap-status--' + esc(idea.status) + '">' + statusLabel + '</span>'
        : '';
      var shipped = idea.status === 'shipped';
      // Voting stays open for 'open' and 'in_progress' -- shipped is the
      // one state where a vote button stops making sense (nothing left to
      // decide). Notify-me still shows for a shipped idea in the rare case
      // someone's landing on this page for the first time after it went
      // live -- no reason to hide the option just because it's already true.
      var voteHtml = shipped
        ? ''
        : '<form class="dr-roadmap-vote-form" data-idea-id="' + esc(idea.id) + '">' + hiddenFieldsHtml +
          '<button type="submit" class="dr-roadmap-vote-btn"' + (idea.voted_by_me ? ' disabled' : '') + '>' +
          (idea.voted_by_me ? '&check; Voted' : '&#9650; Vote') +
          ' <span class="dr-roadmap-vote-count">' + idea.vote_count + '</span></button></form>';
      return '<div class="dr-roadmap-idea">' +
        '<div class="dr-roadmap-idea-info"><h2>' + esc(idea.title) + statusBadge + '</h2>' +
        (idea.description ? '<p>' + esc(idea.description) + '</p>' : '') + '</div>' +
        '<div class="dr-roadmap-idea-actions">' +
        voteHtml +
        '<button type="button" class="dr-roadmap-notify-toggle">Notify me when this ships</button>' +
        '<form class="dr-roadmap-notify-form" data-idea-id="' + esc(idea.id) + '" hidden>' + hiddenFieldsHtml +
        '<input type="email" class="dr-roadmap-notify-email" placeholder="you@example.com" required autocomplete="email">' +
        '<button type="submit">Notify me</button></form>' +
        '<p class="dr-roadmap-notify-result" hidden></p>' +
        '</div></div>';
    }}).join('');
  }}

  function loadIdeas() {{
    fetch(API + '/roadmap-data', {{credentials: 'include'}})
      .then(function(res) {{ return res.ok ? res.json() : null; }})
      .then(function(data) {{
        if (!data || !data.ideas) {{
          if (errEl) {{ errEl.hidden = false; errEl.textContent = 'Something went wrong loading the roadmap. Please try again.'; }}
          return;
        }}
        render(data.ideas);
      }})
      .catch(function() {{
        if (errEl) {{ errEl.hidden = false; errEl.textContent = 'Something went wrong loading the roadmap. Please try again.'; }}
      }});
  }}

  listEl.addEventListener('submit', function(ev) {{
    var form = ev.target;
    if (form.classList.contains('dr-roadmap-vote-form')) {{
      ev.preventDefault();
      var btn = form.querySelector('.dr-roadmap-vote-btn');
      var ideaId = form.getAttribute('data-idea-id');
      var turnstileToken = form.querySelector('input[name="cf-turnstile-response"]').value;
      if (btn) btn.disabled = true;
      fetch(API + '/roadmap/vote', {{
        method: 'POST', credentials: 'include',
        headers: {{'Content-Type': 'application/json'}},
        body: JSON.stringify({{idea_id: ideaId, 'cf-turnstile-response': turnstileToken}})
      }}).then(function(res) {{
        return res.json().then(function(data) {{ return {{ok: res.ok, data: data}}; }});
      }}).then(function(result) {{
        if (!result.ok) {{
          if (btn) btn.disabled = false;
          if (errEl) {{ errEl.hidden = false; errEl.textContent = (result.data && result.data.error) || 'Something went wrong. Please try again.'; }}
          return;
        }}
        var countEl = form.querySelector('.dr-roadmap-vote-count');
        if (countEl) countEl.textContent = result.data.vote_count;
        if (btn) btn.innerHTML = '&check; Voted <span class="dr-roadmap-vote-count">' + result.data.vote_count + '</span>';
      }}).catch(function() {{
        if (btn) btn.disabled = false;
        if (errEl) {{ errEl.hidden = false; errEl.textContent = 'Something went wrong. Please try again.'; }}
      }});
      return;
    }}
    if (form.classList.contains('dr-roadmap-notify-form')) {{
      ev.preventDefault();
      var ideaId2 = form.getAttribute('data-idea-id');
      var emailEl = form.querySelector('.dr-roadmap-notify-email');
      var turnstileToken2 = form.querySelector('input[name="cf-turnstile-response"]').value;
      var resultEl = form.parentElement.querySelector('.dr-roadmap-notify-result');
      var submitBtn = form.querySelector('button[type="submit"]');
      if (submitBtn) submitBtn.disabled = true;
      fetch(API + '/roadmap/notify-signup', {{
        method: 'POST', credentials: 'include',
        headers: {{'Content-Type': 'application/json'}},
        body: JSON.stringify({{idea_id: ideaId2, email: emailEl.value, 'cf-turnstile-response': turnstileToken2}})
      }}).then(function(res) {{
        return res.json().then(function(data) {{ return {{ok: res.ok, data: data}}; }});
      }}).then(function(result) {{
        if (submitBtn) submitBtn.disabled = false;
        if (resultEl) {{
          resultEl.hidden = false;
          resultEl.textContent = result.ok
            ? 'Check your inbox to confirm.'
            : ((result.data && result.data.error) || 'Something went wrong. Please try again.');
        }}
        if (result.ok) {{ form.hidden = true; }}
      }}).catch(function() {{
        if (submitBtn) submitBtn.disabled = false;
        if (resultEl) {{ resultEl.hidden = false; resultEl.textContent = 'Something went wrong. Please try again.'; }}
      }});
      return;
    }}
  }});

  listEl.addEventListener('click', function(ev) {{
    var toggle = ev.target.closest ? ev.target.closest('.dr-roadmap-notify-toggle') : null;
    if (!toggle) return;
    var form = toggle.parentElement.querySelector('.dr-roadmap-notify-form');
    if (form) {{
      form.hidden = !form.hidden;
      if (!form.hidden) {{
        var emailInput = form.querySelector('.dr-roadmap-notify-email');
        if (emailInput) emailInput.focus();
      }}
    }}
  }});

  loadIdeas();
}})();
</script>"""


def build_privacy_page(updated: date) -> str:
    """Expanded 2026-08-05 (Devin: "everything we've changed") -- the original
    version described a single-purpose free reminder tool (email + state +
    optional birth-month field, nothing else). Since then this product grew a
    firm tier (accounts, passwords, a staff roster one admin enters on behalf
    of other people, CPE-hour self-logging, Practice Privilege Check queries,
    Google OAuth sign-in) and real Stripe billing. None of that was reflected
    here -- this rewrite adds a section per genuinely new data category
    instead of folding firm data into the individual-only list above it,
    since a firm's roster is data about people who did NOT sign themselves
    up, which deserves its own explicit disclosure. Every claim below
    describes real, shipped behavior (checked against entitlements.ts,
    store.ts, stripe.ts, and oauth.ts while writing this), not aspirational
    copy -- same standard this site holds its deadline data to."""
    body = f"""<h1>Privacy Policy</h1>
<p class="intro"><strong>The short version:</strong> we collect only what's needed to run the reminder
and license-tracking service you or your firm signed up for, we never sell or rent it, and every email
gives you a one-click way to stop. Firms have a few more data categories than individuals (a password,
a staff roster, CPE hours, billing status) -- all covered below.</p>

<h2>What we collect &mdash; individual reminders</h2>
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
<p>We do not build a profile of who you are from this.</p>

<h2>What we collect &mdash; firm accounts</h2>
<p>A firm account collects a few things an individual signup doesn't:</p>
<ul>
  <li><strong>Firm name and admin email</strong> &mdash; to create and identify the account.</li>
  <li><strong>A password, if you set one</strong> &mdash; stored as a salted, one-way hash. We cannot see
  or recover your actual password, and never store it in plain text.</li>
  <li><strong>CPE (continuing education) hours you log</strong> &mdash; date, hour count, and category.
  This is your own self-reported record, not independently verified, and is used only to show your
  progress against your state's requirement.</li>
  <li><strong>Practice Privilege Check queries and completions</strong> &mdash; which states and service
  type you looked up, and any completion you mark, used only to show that determination back to you.</li>
  <li><strong>Billing status</strong> &mdash; which plan you're on and identifiers Stripe assigns to your
  account (see "Payment information" below). We do not store card numbers.</li>
</ul>

<h2>If your firm adds you to its roster</h2>
<p>A firm admin can add staff directly &mdash; meaning some people in our system did not sign themselves
up. If that's you: your firm's admin provided your name, email, state, and license type to track your
renewal on the firm's behalf. We email you directly the moment you're added, naming the firm that added
you, with a one-click link to opt out that works exactly like the individual unsubscribe link below
&mdash; nothing about being added by someone else changes your ability to stop being contacted.</p>

<h2>Payment information</h2>
<p>Paid firm plans are billed through <strong>Stripe</strong>. When you check out, you enter your card
details directly on Stripe's own secure checkout page &mdash; <strong>we never see, receive, or store
your card number</strong>. What we do store is the plan you're on and the Stripe-assigned customer and
subscription identifiers needed to keep your account's access in sync with your billing status.</p>

<h2>Signing in with Google</h2>
<p>If a firm chooses "Continue with Google" instead of a password, Google shares your email address and
account identifier with us so we can recognize you on return visits. We do not request or receive access
to your Google Drive, contacts, or anything beyond basic sign-in identity.</p>

<h2>How we use it</h2>
<p>Your information is used solely to operate the service you or your firm signed up for: sending
confirmation and reminder emails, showing your roster/CPE/renewal status, processing billing, and letting
you stop any of it at any time. We never use it for advertising, and never for any purpose you didn't
ask for.</p>

<h2>How it's stored and protected</h2>
<p>Your data is encrypted in transit (this site and every form use HTTPS) and stored in a private
database on Cloudflare's infrastructure. Passwords are never stored in plain text. It is never published
on this website, never included in our public code, and never exposed to other visitors. Access is
restricted to the service itself.</p>

<h2>Who we share it with</h2>
<p>We do <strong>not</strong> sell, rent, or trade your information to anyone. We rely on a small number
of service providers strictly to run the service:</p>
<ul>
  <li><strong>Cloudflare</strong> &mdash; hosting, our database, and bot/abuse protection.</li>
  <li><strong>Our email delivery provider</strong> &mdash; to send confirmation, reminder, and account
  emails to your inbox.</li>
  <li><strong>Stripe</strong> &mdash; to process payment for paid firm plans. Stripe receives your card
  details directly; we do not.</li>
  <li><strong>Google</strong> &mdash; only if you choose "Continue with Google" to sign in, to verify your
  identity.</li>
</ul>
<p>These providers process your data only to deliver the service on our behalf, never for their own
marketing.</p>

<h2>Cookies and analytics</h2>
<p>We do not use advertising cookies or cross-site trackers. Signed-in firm and individual sessions use a
strictly-necessary cookie to keep you logged in &mdash; not for tracking. We may use privacy-first,
cookie-less analytics (such as Cloudflare Web Analytics) to understand aggregate traffic &mdash; this
does not track you across the web or identify you personally.</p>

<h2>Your choices</h2>
<p>Every reminder email includes a one-click link to stop all reminders instantly. Using it permanently
removes and suppresses your address so you won't be contacted again. You may also contact us to request
access to, correction of, or deletion of your information.</p>

<h2>Data retention</h2>
<p>We keep your information while you're subscribed and actively being reminded, or while your firm
account is active. When you unsubscribe &mdash; whether through your own one-click link, or because a
firm admin removes you from their roster &mdash; we stop contacting you, but we retain a suppressed
record of your address so it is never re-contacted and so a firm's roster history stays accurate. Billing
records are retained as required to maintain accurate account and payment history.</p>

<h2>Children</h2>
<p>This service is intended for licensed professionals and is not directed to anyone under 16. We do not
knowingly collect information from children.</p>

<h2>Changes to this policy</h2>
<p>We may update this policy from time to time. The "last updated" date below always reflects the current
version.</p>

<h2>Contact</h2>
<p>Questions about your privacy, or requests to access, correct, or delete your data:</p>
<p>{esc(SITE_NAME)} by {esc(BRAND_NAME)}<br>
18121 E Hampden Ave, Unit C #1324<br>
Aurora, CO 80013</p>
<p>For the fastest removal, use the unsubscribe link in any reminder email &mdash; it's instant.</p>

<p class="how-it-works">Last updated: {esc(fmt_date(updated))}. See also our <a
href="/terms/">Terms of Service</a>.</p>
"""
    return page_shell(
        f"Privacy Policy — {SITE_NAME}",
        "How DeadlineRadar collects, uses, and protects your information. We only send the CPA license "
        "deadline reminders you request — we never sell or share your data.",
        body,
        home_href="../",
        canonical_path="/privacy/",
    )


def build_security_page() -> str:
    """Roadmap #311 (2026-08-07): a public security/trust page. Every claim
    below describes real, shipped, checked behavior (cross-referenced against
    index.ts's withSecurityHeaders()/handleDocumentDownload(), password.ts,
    store.ts's hashToken(), and the CSRF/rate-limit pattern used across every
    write route in this codebase), not aspirational security-theater copy --
    same standard build_privacy_page() holds itself to. Deliberately does NOT
    claim a formal certification (SOC 2, ISO 27001) or a bug-bounty program --
    neither exists, and claiming either would be a false statement a small
    team could not back up if asked."""
    body = f"""<h1>Security &amp; Trust</h1>
<p class="intro">What actually protects your firm's data on {esc(SITE_NAME)}, in plain language --
not a compliance-theater checklist. Every claim on this page describes something actually shipped in
this product's code, not a policy aspiration.</p>

<h2>Data handling</h2>
<p>We collect only what the reminder and license-tracking service actually needs to work -- see the
full breakdown on our <a href="/privacy/">Privacy Policy</a>. A firm's roster data (staff names,
emails, license states, CPE hours, any documents uploaded) is scoped strictly to that firm: every
storage query used to read or write it is filtered by the requesting firm's own account id, not just
checked once at the door. We do not sell or share your data with third parties, and we do not run
advertising or cross-site tracking of any kind (see our <a href="/privacy/">cookie disclosure</a>).</p>

<h2>Encryption</h2>
<p>Every connection to {esc(SITE_NAME)} is HTTPS-only -- we send an HTTP Strict-Transport-Security
header instructing browsers to never downgrade to plain HTTP, on every response. Passwords are never
stored in plain text: they're hashed with PBKDF2-HMAC-SHA256 at 100,000 iterations per password, each
with its own random salt, using the same standard the U.S. federal government's own NIST password
guidance describes. Session and login tokens are stored as one-way SHA-256 hashes, not the raw value a
stolen database dump could reuse to sign in. Uploaded documents (license and CPE certificates) are
served back only with <code>Content-Disposition: attachment</code> and
<code>X-Content-Type-Options: nosniff</code> on every response, so a maliciously crafted file can never
be interpreted as an inline webpage by a browser.</p>

<h2>Access control</h2>
<p>Sign-in cookies are marked <code>HttpOnly</code> (invisible to any page script, including a
successful XSS payload), <code>Secure</code> (HTTPS-only transmission), and scoped with
<code>SameSite</code>. Every request that changes data -- adding staff, editing a record, changing a
password -- is checked against the Origin header the browser itself sends, rejecting cross-site
forgery attempts before they reach the database. Every write endpoint is rate-limited -- keyed to your
account where one's already established, or to your IP address for the handful of actions (like
signing out) that happen before a session exists to key on -- so a compromised session or a scripting
bug can't be abused to hammer the system. We send a Content-
Security-Policy, X-Frame-Options, and X-Content-Type-Options header on every response as additional,
independent layers against the same class of attack.</p>

<h2>Incident response</h2>
<p>We're a small, hands-on team, not a large enterprise with a dedicated security operations center --
we won't claim otherwise. What that means in practice: a real person reviews this system regularly,
security-relevant code changes go through the same scrutiny as everything else we ship, and if
something ever goes wrong, we will tell affected firms directly and promptly, not bury it in a
changelog. We do not currently hold a formal security certification (SOC 2, ISO 27001) or run a paid
bug-bounty program -- if that changes, this page will say so, not before.</p>

<h2>Found something?</h2>
<p>If you believe you've found a security issue, email us directly at
<a href="mailto:{esc(CONTACT_EMAIL)}">{esc(CONTACT_EMAIL)}</a> with what you found and how to reproduce
it. A real person reads every message here -- see our <a href="/contact/">Contact page</a> for more.</p>

<p class="how-it-works">See also our <a href="/privacy/">Privacy Policy</a> and
<a href="/terms/">Terms of Service</a>.</p>
"""
    return page_shell(
        f"Security & Trust — {SITE_NAME}",
        "How DeadlineRadar protects your firm's data: encryption, access control, and incident "
        "response, explained in plain language with no compliance-theater claims.",
        body,
        home_href="../",
        canonical_path="/security/",
    )


def build_status_page() -> str:
    """Roadmap #60 (2026-08-07): a public status page. Deliberately does NOT
    claim a specific uptime percentage or ship a fabricated incident-history
    log -- there is no live monitoring/paging pipeline behind this product
    (a real status-page vendor would be a new external account, out of
    scope for a build-now item), and inventing either would be exactly the
    kind of overclaim build_security_page()'s own docstring already refuses
    to make. What this page actually offers, honestly: what the site runs
    on (so a visitor can check the PLATFORM's own status directly rather
    than trust a claim from us about it), and where a real incident would
    actually be posted if one happened."""
    body = f"""<h1>Status</h1>
<p class="intro">There is no live-updating dashboard on this page -- for a small, hands-on team, a
fake "all systems operational" badge would be a claim we can't actually back with real monitoring
data. Here's what's true instead.</p>

<h2>What this runs on</h2>
<p>{esc(SITE_NAME)} is served entirely on Cloudflare's own infrastructure -- Cloudflare Workers for
the dynamic site (firm dashboard, sign-in, reminders) and Cloudflare Pages for every public page,
including this one. That means the platform-level uptime that actually matters here is Cloudflare's,
not a smaller vendor's -- check <a href="https://www.cloudflarestatus.com/" rel="noopener">Cloudflare's
own public status page</a> directly for real-time platform incidents, rather than trust a summary of
it from us.</p>

<h2>If something on our side breaks</h2>
<p>A code-level bug or a misconfiguration on our side (not Cloudflare's own platform) is possible like
it is for any small team. If a material incident on our side ever affects your data or your reminders,
we will tell affected firms directly, the same commitment our <a href="/security/">Security &amp;
Trust</a> page already makes -- not bury it in a footnote here. Day-to-day shipped changes (not
incidents) are tracked on our <a href="/changelog/">changelog</a>.</p>

<h2>Something look wrong right now?</h2>
<p>Email us directly at <a href="mailto:{esc(CONTACT_EMAIL)}">{esc(CONTACT_EMAIL)}</a> -- see our
<a href="/contact/">Contact page</a> for more. A real person reads every message.</p>
"""
    return page_shell(
        f"Status — {SITE_NAME}",
        "What DeadlineRadar actually runs on, and where a real incident would be posted -- no "
        "fabricated uptime percentage or fake status widget.",
        body,
        home_href="../",
        canonical_path="/status/",
    )


def _citation_freshness_stat(records: list[dict], real_today: date) -> tuple[int, int]:
    """Roadmap #46 (2026-08-07): live, computed freshness statistic (how many of the N
    citations were individually re-verified within the last STALENESS_THRESHOLD_DAYS
    days, AS OF THIS BUILD) -- same last_verified data and same bar
    scripts/cpa_deadlines_staleness_check.py (roadmap #45) checks on every pre-ship run,
    so this number can never silently drift from what that check would actually report.
    Returns (verified_recent, total) so callers can render their own copy/placement
    around it -- roadmap #334 (2026-08-10, ValueLab's Canopy-exhaustive report, RANK #2)
    promotes this beyond its original single home on /methodology/ to the homepage hero,
    /for-firms/, /compare/, and /pricing/, always via this SAME live computation, never a
    copy-pasted static figure that would go stale the moment a citation's own
    last_verified date does."""
    verified_recent = 0
    for r in records:
        lv = r.get("last_verified")
        if not lv:
            continue
        try:
            age_days = (real_today - date.fromisoformat(lv)).days
        except ValueError:
            continue
        if age_days <= STALENESS_THRESHOLD_DAYS:
            verified_recent += 1
    return verified_recent, len(records)


def build_methodology_page(records: list[dict], real_today: date) -> str:
    """How-we-verify-our-data page (2026-07-15, per the orchestrator's 'press the
    validated bet' steer: apply the CPA-trust design lens by surfacing the sourcing
    method itself as a first-class trust asset, the way established compliance/legal
    reference sites do -- not by inventing any new claim, just making the standard
    already enforced everywhere else in this file (citation + citation_url on every
    record, honest null/gap-note when unverifiable) legible to a skeptical CPA
    visitor in one place instead of leaving it implicit."""
    verified_recent, total = _citation_freshness_stat(records, real_today)
    # Reuses the site's existing .callout box (no new CSS) -- same visual
    # treatment already used for the per-state "Verified" callouts, so this
    # rolled-up site-wide stat reads as the same kind of trust signal, not a
    # bespoke one-off.
    freshness_stat_html = (
        f'<div class="callout"><p><strong>{verified_recent} of {total}</strong> '
        f"citations on this site were individually re-checked against their source within the last "
        f"{STALENESS_THRESHOLD_DAYS} days, as of this page's last build ({real_today.isoformat()}). "
        f"Every state page's own \"Last verified\" line shows that specific citation's own date &mdash; "
        f"this is the same fact, rolled up across the whole site."
        f"</p></div>"
    )
    body = f"""<h1>How We Verify Every Deadline</h1>
{freshness_stat_html}
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

<p class="backlink"><a href="/changelog/">See exactly what's changed and when &rarr;</a> &middot;
<a href="/contact/">Found something that looks wrong? Tell us &rarr;</a></p>
"""
    return page_shell(
        f"How We Verify Every Deadline — {SITE_NAME}",
        "DeadlineRadar's sourcing standard: every CPA license renewal date traces to the state board's "
        "own page plus the actual codified statute or rule behind it — never a guess.",
        body,
        home_href="../",
        canonical_path="/methodology/",
    )


def build_changelog_page() -> str:
    """Public changelog page (2026-08-07, roadmap #49): when this site's own data was
    corrected or materially updated. Deliberately hand-curated, not generated from raw
    git commit history -- this repo's real commit messages reference internal tooling
    and finding codes never meant for public copy (checked directly before deciding
    this: e.g. "Fix AuditLab DATA-3 (MEDIUM): DC citation covers firm permit only").
    Every entry in data/changelog.json is a genuine, dated, already-verified change,
    rewritten in plain language -- not an exhaustive commit-by-commit log, and the page
    says so rather than implying completeness it doesn't have."""
    changelog = json.loads(CHANGELOG_DATA_PATH.read_text(encoding="utf-8"))
    entries = changelog.get("entries", [])
    entries_html = "\n".join(
        f'<li><span class="cl-date">{esc(fmt_date(date.fromisoformat(e["date"])))}</span>'
        f'<span class="cl-summary">{esc(e["summary"])}</span></li>'
        for e in entries
    )
    body = f"""<h1>Changelog</h1>
<p class="intro">A running record of material corrections and updates to this site's data &mdash;
not every commit, but every change that could affect what a visitor sees. See
<a href="/methodology/">how we verify every deadline</a> for the full sourcing standard behind it.</p>

<ul class="cl-list">
{entries_html}
</ul>

<p class="backlink"><a href="/contact/">Found something that looks wrong? Tell us &rarr;</a></p>
"""
    return page_shell(
        f"Changelog — {SITE_NAME}",
        "A running record of material corrections and updates to DeadlineRadar's CPA license "
        "renewal data -- dated, plain-language, never hidden.",
        body,
        home_href="../",
        canonical_path="/changelog/",
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
    badge_class = "rc-badge rc-badge-upcoming" if e.get("upcoming") else "rc-badge"
    return f"""<div class="rc-card">
  <div class="rc-head">
    <span class="rc-jurisdiction">{esc(e.get("jurisdiction") or e.get("jurisdiction_slug", ""))}</span>
    <span class="{badge_class}">{esc(_rule_change_status_label(e.get("status")))}</span>
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
        <li><a href="#" tabindex="-1">Reports</a></li>
        <li><a href="/firm-mobility/">Practice Privilege Check</a></li>
        <li><a href="#" tabindex="-1">Account</a></li>
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
the real product design, not a mockup of a different one. 6 staff shown here to also illustrate firm
registration (a separate feature, 2 of the rows above) &mdash; the free tier itself covers up to
3 staff; paid tiers cover more.</p>"""


# Roadmap #323 (2026-08-10, ValueLab design-pattern-mining #3, TOP PRIORITY):
# six-tab product showcase on /for-firms/, replacing the single static
# roster-only mockup above with REAL screenshots across every dashboard view
# plus Practice Privilege Check. NOT mockups (see _firm_dashboard_mockup_html
# above for that, still used on the homepage's own lighter teaser) -- these
# are actual screenshots of the shared live demo account (the same one
# /firm/demo-login signs a visitor into), captured 2026-08-10, saved to
# assets/showcase/*.jpg and copied verbatim into the built site (see the
# asset-copy loop in main()). Same "real data, shared account, not a private
# one" disclosure the demo-login banner itself already carries -- these
# screenshots show exactly what a fresh visitor sees clicking "Live Demo",
# nothing staged beyond picking which of the 6 nav views to capture.
_PRODUCT_SHOWCASE_TABS = [
    ("roster", "Roster", "showcase/roster.jpg", "Coverage overview: who's current, who's at risk, at a glance."),
    ("calendar", "Calendar", "showcase/calendar.jpg", "Every upcoming renewal, by date, with an .ics feed to export."),
    ("map", "Map", "showcase/map.jpg", "Which states your firm has staff licensed in, and who's at risk."),
    ("cpe", "CPE Hours", "showcase/cpe-hours.jpg", "Completed continuing-education hours, tracked per staff member against each state's own requirement."),
    ("reports", "Reports", "showcase/reports.jpg", "A printable compliance summary and audit trail, for a board inquiry or your own file."),
    ("mobility", "Practice Privilege Check", "showcase/mobility.jpg", "A real result: can this CPA provide this service in this state, and what has to happen first."),
]


def _product_showcase_html() -> str:
    tabs_html = "\n  ".join(
        f'<button type="button" class="dr-showcase-tab{" dr-showcase-tab--active" if i == 0 else ""}" '
        f'data-showcase="{esc(key)}" aria-pressed="{"true" if i == 0 else "false"}">{esc(label)}</button>'
        for i, (key, label, _src, _caption) in enumerate(_PRODUCT_SHOWCASE_TABS)
    )
    first_src, first_caption = _PRODUCT_SHOWCASE_TABS[0][2], _PRODUCT_SHOWCASE_TABS[0][3]
    data_map = ", ".join(
        f'{key}: {{src: "/{esc(src)}", caption: "{esc(caption)}"}}' for key, _label, src, caption in _PRODUCT_SHOWCASE_TABS
    )
    return f"""<div class="dr-showcase">
  <div class="dr-showcase-tabs" role="tablist">
  {tabs_html}
  </div>
  <div class="dr-showcase-frame">
    <img src="/{esc(first_src)}" alt="{esc(first_caption)}" id="dr-showcase-img" width="1568" height="778" loading="lazy">
  </div>
  <p class="mock-caption" id="dr-showcase-caption">{esc(first_caption)} Real screenshot of our own shared
  live demo account &mdash; the same one you land on if you click "Live Demo" above &mdash; not a mockup.</p>
</div>
<script>
(function () {{
  var data = {{{data_map}}};
  var img = document.getElementById('dr-showcase-img');
  var caption = document.getElementById('dr-showcase-caption');
  var tabs = document.querySelectorAll('.dr-showcase-tab');
  tabs.forEach(function (tab) {{
    tab.addEventListener('click', function () {{
      var key = tab.getAttribute('data-showcase');
      var entry = data[key];
      if (!entry || !img) return;
      img.src = entry.src;
      img.alt = entry.caption;
      if (caption) {{
        caption.textContent = entry.caption + ' Real screenshot of our own shared live demo account -- the same one you land on if you click "Live Demo" above -- not a mockup.';
      }}
      tabs.forEach(function (t) {{
        t.classList.toggle('dr-showcase-tab--active', t === tab);
        t.setAttribute('aria-pressed', t === tab ? 'true' : 'false');
      }});
    }});
  }});
}})();
</script>"""


# Roadmap #58 (2026-08-07): the homepage (the free individual funnel --
# this site's primary distribution surface) had no FAQ at all; only
# /for-firms/ did. Every answer below restates a fact already established
# and shipped elsewhere on the site (methodology page, the remind-panel's
# own trust bullets, the unsubscribe flow, the standing non-affiliation
# disclaimer) rather than asserting anything new -- same discipline
# _FIRM_FAQ below already holds itself to.
_INDIVIDUAL_FAQ = [
    (
        "Is this actually free?",
        "Yes. Individual reminders, CPE-hour tracking, and individual Practice Privilege Check "
        "(one person, one target state) are all free, no card required, no time limit -- for any "
        "account, solo or with a whole firm's roster. Paid firm plans exist for the multistate Map "
        "and firm-level registration check.",
    ),
    (
        "How do you actually verify the dates?",
        "Every renewal date is sourced to the codified statute or board rule, cited, and rechecked on "
        "a regular freshness cadence -- never guessed or estimated. <a href=\"methodology/\">See "
        "exactly how, state by state.</a>",
    ),
    (
        "Will you sell my email or spam me?",
        "No. We only email you deadline reminders. We never sell or share your address, and "
        "unsubscribing is one click, anytime, with no account or login required.",
    ),
    (
        "My state's rule depends on my birth month (or I already know my exact date) -- can you still track it?",
        "Yes. Some states compute your deadline from your birth month automatically; others let you "
        "enter your own known renewal or expiration date directly (\"bring your own date\"). Either "
        "way it shows up as one tracked deadline with the same escalating reminders.",
    ),
    (
        "Are you affiliated with my state board of accountancy?",
        "No. DeadlineRadar is an independent reminder and license-tracking service, not affiliated "
        "with, endorsed by, or connected to any state board of accountancy, NASBA, or the AICPA. "
        "Always confirm your exact renewal date with your own board if you're ever unsure.",
    ),
    (
        "I'm tracking a whole firm's staff, not just my own license -- is there something for that?",
        "Yes -- see the <a href=\"for-firms/\">firm overview</a>. Roster, calendar, CPE tracking, and "
        "individual Practice Privilege Check are free there too; paid tiers add a multistate map and "
        "the firm-level registration check.",
    ),
]


def _individual_faq_schema() -> dict:
    """FAQPage structured data for the homepage FAQ -- schema.org's
    plain-text convention for acceptedAnswer.text, so the 2 answers above
    with an inline <a> link get their markup stripped here rather than
    emitting raw HTML into JSON-LD."""
    return {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        "mainEntity": [
            {
                "@type": "Question",
                "name": q,
                "acceptedAnswer": {"@type": "Answer", "text": re.sub(r"<[^>]+>", "", a)},
            }
            for q, a in _INDIVIDUAL_FAQ
        ],
    }


def _individual_faq_html() -> str:
    items = "\n".join(
        f"""<details class="faq-item">
  <summary>{esc(q)}</summary>
  <p>{a}</p>
</details>"""
        for q, a in _INDIVIDUAL_FAQ
    )
    return f"""<h2>Questions people ask before signing up</h2>
<div class="faq-list">
{items}
</div>"""


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
        "Can I cancel anytime?",
        "Yes. Roster, calendar, CPE Hours, and individual Practice Privilege Check are free with no "
        "card required and no time limit. If you upgrade for the map and firm-level registration "
        "check, you can cancel that subscription at any point &mdash; there's no contract to get out "
        "of, and your account just drops back to the free tier at the end of the period you already "
        "paid for.",
    ),
    (
        "Which plan should my firm pick?",
        "Whatever covers your current staff count &mdash; Essentials (up to 5), Growth (up to 10), "
        "Professional (up to 20), or Enterprise (up to 35). Every tier has the exact same feature set (Roster, Calendar, Map, CPE "
        "Hours, Practice Privilege Check); the only thing that changes between tiers is how many "
        "staff it covers, never what it can do. Outgrowing your plan later just means moving up a "
        "tier, not losing anything.",
    ),
    (
        "I'm a single CPA, not a firm — is this for me?",
        "This page is about the firm tier: a roster for whoever is tracking multiple staff CPAs. If "
        "you're only tracking your own license, the free individual reminders on our homepage "
        "already cover that at no cost, unchanged. CPE-hour tracking and Practice Privilege Check are "
        "also free for a solo CPA &mdash; <a href=\"/firm-login/#dr-view-signup\">create a free "
        "account</a> to use them.",
    ),
    (
        "Do you track CPE hours too?",
        "Yes &mdash; the dashboard has a CPE Hours tab where your firm can log completed hours "
        "against each state's own requirement. That log is your own self-reported record, not "
        "independently verified, and we keep it clearly labeled and separate from the sourced "
        "renewal dates &mdash; we won't blur the two.",
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
        "You do, directly, through the self-serve dashboard: your admin adds each staff "
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
    that idea is retired here). The self-serve firm-admin dashboard (staff
    roster, Calendar, Map, CPE Hours, Practice Privilege Check) has since
    shipped and is live -- this page's "Create your firm account" CTA links
    straight to it (POST /api/firm/lead below is the SEPARATE "not ready
    yet, just leave your email" lead-capture path, not the primary CTA). Do
    not re-add any claim of a recurring human/manual per-staff license check
    or a concierge-style onboarding where our team enters a firm's roster
    for them -- both were removed because they were never true (it's
    self-serve BY DESIGN: the admin adds staff directly). CPE-hour tracking
    also shipped (the dashboard's CPE Hours tab) -- reported directly,
    2026-08-05, that this page's copy still described it as unbuilt future
    tense weeks after it went live; keep it labeled as an unverified
    self-report, never given the same certainty language as the sourced
    renewal dates, but describe it as PRESENT, not hypothetical -- that
    distinction (sourced vs. self-reported, not built vs. unbuilt) is the
    entire brand and must not blur on the paid tier."""
    firm_lead_action = f"{esc(REMINDER_BACKEND_BASE_URL)}/firm/lead"
    _verified_recent, _total_citations = _citation_freshness_stat(
        [r for recs in by_slug.values() for r in recs], as_of
    )
    body = f"""<h1>CPA License Tracking for Your Whole Firm</h1>
<p class="intro">Every accounting firm has someone who has to make sure every partner's and staff CPA's
license stays current &mdash; across however many states they're licensed in. One missed renewal slows
down engagements and creates real regulatory risk, and most firms track it today by spreadsheet. A
spreadsheet fails in three specific ways.</p>
<p class="field-hint"><strong>{_verified_recent} of {_total_citations}</strong> citations on this site
were individually re-checked against their source within the last {STALENESS_THRESHOLD_DAYS} days
&mdash; <a href="/methodology/">see exactly how we verify every deadline</a>.</p>

<h2 class="dr-pain-headline">Every hour completed. The filing still missed.</h2>
<p class="subhead">Where a spreadsheet (and an individual CPA's own inbox) falls short:</p>
<div class="dr-pain-grid">
  <div class="dr-pain-col">
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" class="dr-pain-icon">
      <path d="M8 1.5c-2.2 0-4 1.8-4 4 0 3 4 9 4 9s4-6 4-9c0-2.2-1.8-4-4-4z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
      <circle cx="8" cy="5.5" r="1.4" stroke="currentColor" stroke-width="1.3"/>
    </svg>
    <p><strong>Multi-state blind spot.</strong> A state board only reminds a CPA about the license held
    <em>with that board</em> &mdash; nobody sends a nudge about the other one or two states the same
    person might also be licensed in. Nothing is watching the full multi-state picture except the CPA
    themselves, one inbox at a time.</p>
  </div>
  <div class="dr-pain-col">
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" class="dr-pain-icon">
      <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
      <circle cx="8" cy="8" r="1.8" stroke="currentColor" stroke-width="1.3"/>
      <line x1="2.5" y1="13" x2="13.5" y2="3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
    </svg>
    <p><strong>No firm-level visibility.</strong> The partner or admin who actually carries the
    regulatory risk for the firm never sees any of this &mdash; only the individual licensee's own
    inbox gets the reminder. If that person doesn't forward it, changes their email, or leaves the
    firm, the firm has zero visibility until a renewal is already missed.</p>
  </div>
  <div class="dr-pain-col">
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" class="dr-pain-icon">
      <path d="M4 1.5h5.5L11.5 3.5V14.5h-7.5Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
      <path d="M9.5 1.5v2h2" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
      <path d="M5.5 8.5l1.5 1.5 3-3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
    <p><strong>Filing vs. hours.</strong> CPE-hour tracking tools track whether staff completed their
    continuing-education hours. That's a different event from whether the actual renewal
    <em>filing</em> with the state board happened. Finishing every CPE hour and still missing the
    filing deadline is a real, common failure mode &mdash; this product is about the filing, not the
    hours.</p>
  </div>
</div>

<h2>What you get</h2>
<p>A firm-wide view that answers what a spreadsheet can't: who's current, who's at risk, and who needs
to act before a deadline &mdash; for every staff CPA and the firm's own registration, sourced to the same
codified statute or rule we verify for every free state page on this site &mdash;
<a href="../methodology/">see exactly how we verify every deadline</a>. Any individual CPA can already
get free reminders on their own; what a firm gets here is the roster-level accountability view nobody's
personal inbox provides, in one place. Reminders aren't limited to email either &mdash; connect Slack or
Microsoft Teams and your admin gets a daily digest of newly-due renewals posted straight to the channel
your team already watches, included on every paid plan.</p>

<h2>What Practice Privilege Check actually does</h2>
<p>A different question from renewal dates: can this CPA provide this specific service in this specific
state right now, without a local license &mdash; and what has to happen first? Pick a service type (Tax;
Attest &mdash; audit, review, or other attest; or Other non-attest &mdash; consulting, advisory). Attest
work frequently triggers a firm-registration requirement where tax work doesn't &mdash; that gap is the
most common real-world mobility mistake, and this catches it. The determination needs two inputs only
you can attest to &mdash; that the license is active and in good standing, and that the CPA meets
substantial equivalence (150 semester hours, one year of experience, the Uniform CPA Exam) &mdash; we
can't verify either one ourselves, so the answer is only as good as what you tell it, same honesty
standard as every renewal date on this site. Verified in all 55 U.S. jurisdictions today, both for the
individual question above and a separate firm-level registration check (does the FIRM itself need to
register somewhere it has no office, even when the individual CPA is covered). The individual check is
free on every tier, for any account &mdash; a free signup is all it takes, no card, no paid plan
required; <a href="../pricing/">the firm-level check and the multistate coverage map are part of a
paid plan</a>. Staff across more than one state? See how Map, Practice Privilege Check, and
<a href="../rule-changes/">Rule Changes</a> work together on the
<a href="../multi-state-firms/">multi-state firm overview</a>.</p>

{_product_showcase_html()}

<p class="how-it-works"><strong>Want to click around for real instead of screenshots?</strong>
<a href="{REMINDER_BACKEND_BASE_URL}/firm/demo-login" style="font-weight:600;">Try the live demo &rarr;</a> A shared
account, seeded with sample staff &mdash; one click, no signup, no credentials to type.</p>

<p><strong>Scope, plainly stated:</strong> the license <em>renewal dates</em> are the part we verify
against actual state law, the same way we already do for individuals. The dashboard also has a CPE
Hours tab where your firm can log completed hours against each state's own requirement &mdash; that
log is your own self-reported record, not independently verified, and we keep it clearly labeled and
separate from the sourced renewal dates. We won't blur the two &mdash; self-reported hours and
sourced dates staying visibly distinct is the whole reason to trust this site.</p>

<h2>Pricing</h2>
<p>Roster, Calendar, CPE Hours, and individual Practice Privilege Check are <strong>free for any firm,
up to 3 staff</strong>, no card required, no time limit. Paid tiers add the Map and the firm-level
registration check &mdash; every paid tier gets the identical feature set; the only difference between
them is how many staff it covers, nothing is held back on a cheaper plan.</p>
<ul class="firm-pricing-list">
  <li><strong>Essentials</strong> &mdash; $199/year, up to 5 staff</li>
  <li><strong>Growth</strong> &mdash; $299/year, up to 10 staff</li>
  <li><strong>Professional</strong> &mdash; $399/year, up to 20 staff</li>
  <li><strong>Enterprise</strong> &mdash; $549/year, up to 35 staff</li>
  <li><strong>More than 35 staff?</strong> <a href="mailto:{esc(CONTACT_EMAIL)}">Contact us</a>.</li>
</ul>
<p><a href="/pricing/">See full pricing &rarr;</a></p>
<p><strong>Tracking just your own license, not a firm roster?</strong> The free individual reminders
on our homepage already cover that at no cost, unchanged. CPE-hour tracking and Practice Privilege
Check are also <strong>free</strong> for a solo CPA &mdash;
<a href="/firm-login/#dr-view-signup">create a free account</a> to use them.</p>

<div class="remind-panel" id="firm-signup">
  <div>
    <h2>Create your firm account</h2>
    <p class="remind-copy">Self-serve, no card required. Your admin creates an account and adds staff
    directly &mdash; name, email, state, and license type for each person &mdash; no concierge onboarding
    where our team enters a roster for you. Reminders start right away for each person added, no
    confirmation step to wait on, so your firm's coverage never has a silent gap. Each staff member
    gets one transparent email the moment they're added, naming your firm and with an equally
    prominent one-click opt-out.</p>
    <p class="remind-promise">Free, no time limit, no card collected anywhere in this flow.</p>
  </div>
  <p><a class="cta-button" id="dr-firms-cta" href="../firm-login/#dr-view-signup">Create your firm account &rarr;</a></p>
  <p class="field-hint">By creating an account, you agree to our <a href="../terms/">Terms of
  Service</a> and <a href="../privacy/">Privacy Policy</a>.</p>
</div>

<h2>How it actually works</h2>
<p>Deadline accuracy comes from the same sourced-to-codified-law data every free page on this site
already uses, not a recurring human check-in on each staff member's status. Self-serve card checkout
through Stripe is live today for Essentials, Growth, and Professional -- pick a plan above and pay by
card, no invoice or sales call required. Enterprise (35+ staff) currently needs a quick email first;
<a href="mailto:{esc(CONTACT_EMAIL)}">contact us</a> and we'll get you set up. Not ready to create an
account yet? <a href="#firm-lead">Leave your email instead</a> and we'll follow up.</p>

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
<script>
(function() {{
  // Roadmap #31 (2026-08-09, referral program). Carries a ?ref= referral
  // code from THIS page's own query string onto the signup CTA link --
  // /firm-login/'s own signup form (dr-view-signup) reads it back off
  // ITS query string and prefills a hidden field. Deliberately no
  // format validation here (this page can't know what a valid code
  // looks like without duplicating store.ts's alphabet) -- the SERVER
  // is the real authority and silently ignores anything unresolvable,
  // same "an invalid code never fails the signup" posture the backend
  // handler has.
  var ref = new URLSearchParams(window.location.search).get('ref');
  if (!ref) return;
  var cta = document.getElementById('dr-firms-cta');
  if (cta) cta.href = '../firm-login/?ref=' + encodeURIComponent(ref) + '#dr-view-signup';
}})();
</script>
"""
    return page_shell(
        f"For Firms — {SITE_NAME}",
        "CPA firm license tracking: roster, calendar, CPE hours, and individual Practice Privilege "
        "Check free forever, plus paid plans from $199/year (5 staff) to $549/year (35 staff) for the "
        "map and firm-level registration check. Sourced to the same codified state law DeadlineRadar "
        "verifies for every state.",
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
  <p class="dr-account-ok" id="dr-account-deleted-notice" hidden>Your account has been deleted. It's
  deactivated immediately; the data is permanently erased in 30 days.</p>
  <p class="dr-account-ok" id="dr-demo-prefill-notice" hidden>Demo credentials filled in below --
  click Sign in. It's a shared account (roster changes are visible to other visitors, and the password
  can't be changed), seeded with sample data so you can look around.</p>
{sso_buttons_html}
  <form method="post" action="{REMINDER_BACKEND_BASE_URL}/firm/login/password" id="dr-firmlogin-signin-form">
    {_BOT_DEFENSE_FIELDS_HTML_SIGNIN}
    <label for="signin-email">Email</label>
    <input type="email" id="signin-email" name="admin_email" required autocomplete="username"
    placeholder="you@yourfirm.com">
    <label for="signin-password">Password</label>
    <input type="password" id="signin-password" name="password" required
    autocomplete="current-password">
    <p id="dr-firmlogin-signin-error" role="alert" class="field-hint" style="color:#c33737;" hidden></p>
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
  <p class="subhead">Free, no time limit, no card required.</p>
  <form method="post" action="{REMINDER_BACKEND_BASE_URL}/firm/signup" id="dr-firmlogin-signup-form">
    {_BOT_DEFENSE_FIELDS_HTML_ALT}
    <!-- Roadmap #31 (referral program): populated by this page's own JS
         from a ?ref= query param, never user-typed. An invalid/unresolvable
         code never fails the signup (server-side, see index.ts). -->
    <input type="hidden" id="dr-firmlogin-referral-code" name="referral_code" value="">
    <label for="signup-firm-name">Firm name</label>
    <input type="text" id="signup-firm-name" name="name" required maxlength="200"
    placeholder="Example Firm, LLC">
    <label for="signup-admin-name">Your name (optional)</label>
    <input type="text" id="signup-admin-name" name="admin_name" maxlength="60"
    autocomplete="name" placeholder="Jane Smith">
    <label for="signup-admin-email">Your email</label>
    <input type="email" id="signup-admin-email" name="admin_email" required
    autocomplete="email" placeholder="you@yourfirm.com">
    <p id="dr-firmlogin-signup-error" role="alert" class="field-hint" style="color:#c33737;" hidden></p>
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
    <p id="dr-magic-error" role="alert" class="field-hint" style="color:#c33737;" hidden></p>
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

  // Task #3 (2026-08-06): the redirect target after a successful self-serve
  // account deletion -- the session that did the deleting is already dead
  // server-side by the time this page loads, so there's nothing to sign out
  // of; this is purely a "yes, that worked" confirmation.
  if (new URLSearchParams(window.location.search).get("account-deleted") === "1") {
    var deletedNotice = document.getElementById("dr-account-deleted-notice");
    if (deletedNotice) deletedNotice.hidden = false;
  }

  // Roadmap #31 (2026-08-09, referral program): carries a ?ref= referral
  // code (propagated here from /for-firms/'s own CTA link, or shared
  // directly) into the hidden field the real POST /firm/signup submit
  // reads. No format validation here -- see /for-firms/'s own script for
  // why that's deliberately left to the server.
  var referralCodeParam = new URLSearchParams(window.location.search).get("ref");
  if (referralCodeParam) {
    var referralCodeEl = document.getElementById("dr-firmlogin-referral-code");
    if (referralCodeEl) referralCodeEl.value = referralCodeParam;
  }

  // Task #33 (2026-08-06): public demo link (/firm-login/?demo=1) pre-fills
  // the sign-in form with the shared demo account's credentials -- still a
  // real form submit, one real click, not an auto-login teleport, so it
  // stays obviously "this is a real login" rather than something that
  // could be mistaken for a broken auth bypass. demo_locked on that firm's
  // row means these credentials can only ever sign in, never change
  // anything about their own account (see migration 0024).
  if (new URLSearchParams(window.location.search).get("demo") === "1") {
    var demoEmailEl = document.getElementById("signin-email");
    var demoPasswordEl = document.getElementById("signin-password");
    if (demoEmailEl) demoEmailEl.value = "__DEMO_EMAIL__";
    if (demoPasswordEl) demoPasswordEl.value = "__DEMO_PASSWORD__";
    var demoNoticeEl = document.getElementById("dr-demo-prefill-notice");
    if (demoNoticeEl) demoNoticeEl.hidden = false;
  }

  // These three forms POST straight to the Worker with no JS at all, so any
  // error (wrong password, a blocked domain, a rate limit) navigated the
  // whole browser to the raw API response instead of showing an error on
  // this page -- reported directly, 2026-08-03. The API still returns plain
  // HTML (not JSON) for these routes, always as a single <p>message</p> in
  // an otherwise-empty page, so that is what gets pulled out and shown
  // inline; nothing about the routes themselves changes.
  function firstParagraphText(html) {
    var match = /<p>([\\s\\S]*?)<\\/p>/.exec(html);
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

  // 2026-08-05, live Gate-1 testing: this used to hard-block submission
  // client-side whenever the token was empty, showing a client-only error
  // and NEVER calling fetch() -- indistinguishable, from the visitor's
  // side, from the button doing nothing at all. Confirmed live: an ad
  // blocker (a real, non-trivial share of traffic, not just an edge case)
  // silently prevents challenges.cloudflare.com from ever loading, so the
  // token never arrives and that block became a permanent dead end for
  // every one of those visitors, right at the top of the signup funnel.
  // The WORKER is now the one source of truth for whether a missing token
  // is acceptable on a given route (verifyTurnstile's `allowMissingToken`,
  // true only on routes gated by a subsequent real email click -- see that
  // function's own docstring) -- so this always attempts the real request
  // and lets the server's actual response drive the UI, rather than a
  // client-side guess that can only be wrong in the direction of blocking
  // a real visitor.
  function ajaxifyForm(formId, errorId, onSuccess) {
    var form = document.getElementById(formId);
    var errEl = errorId ? document.getElementById(errorId) : null;
    if (!form) return;
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (errEl) { errEl.hidden = true; errEl.textContent = ""; }
      var submitBtn = form.querySelector('button[type="submit"]');
      if (submitBtn) submitBtn.disabled = true;
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
_FIRM_LOGIN_VIEW_JS_HTML = (
    _FIRM_LOGIN_VIEW_JS_HTML.replace("__DEMO_EMAIL__", DEMO_FIRM_EMAIL).replace("__DEMO_PASSWORD__", DEMO_FIRM_PASSWORD)
)


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
    <input type="password" id="dr-setpw-new" name="new_password" required minlength="12"
    autocomplete="new-password">
    <p class="field-hint">At least 12 characters. Longer beats complicated &mdash; a short phrase
    you'll remember is stronger than a scramble you won't.</p>

    <label for="dr-setpw-confirm">Confirm new password</label>
    <input type="password" id="dr-setpw-confirm" required autocomplete="new-password">

    <button type="submit">Save password</button>
    <p id="dr-setpw-error" role="alert" class="dr-account-err" hidden></p>
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


_FIRM_2FA_ENTRY_JS_HTML = """<script>
(function () {
  var params = new URLSearchParams(window.location.search);
  var pending = params.get('pending') || '';
  var form = document.getElementById('dr-2fa-entry-form');
  var err = document.getElementById('dr-2fa-entry-error');
  var noPending = document.getElementById('dr-2fa-entry-no-pending');
  if (!pending) {
    if (form) form.hidden = true;
    if (noPending) noPending.hidden = false;
    return;
  }
  if (!form) return;

  function firstParagraphText(html) {
    var match = /<p>([\\s\\S]*?)<\\/p>/.exec(html);
    if (!match) return 'Something went wrong. Please try again.';
    var div = document.createElement('div');
    div.innerHTML = match[1];
    return div.textContent || div.innerText || 'Something went wrong. Please try again.';
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (err) { err.hidden = true; err.textContent = ''; }
    var code = document.getElementById('dr-2fa-entry-code').value.trim();
    var submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;

    fetch(form.getAttribute('action'), {
      method: 'POST',
      credentials: 'include',
      headers: {'Content-Type': 'application/x-www-form-urlencoded'},
      body: new URLSearchParams({pending: pending, code: code}).toString()
    }).then(function (resp) {
      if (resp.redirected) { window.location.href = resp.url; return null; }
      return resp.text().then(function (html) {
        if (resp.ok) { window.location.href = '/firm-dashboard/'; return; }
        if (err) { err.textContent = firstParagraphText(html); err.hidden = false; }
        if (submitBtn) submitBtn.disabled = false;
      });
    }).catch(function () {
      if (err) { err.textContent = 'Something went wrong. Please try again.'; err.hidden = false; }
      if (submitBtn) submitBtn.disabled = false;
    });
  });
})();
</script>"""


def build_firm_2fa_page() -> str:
    """/firm-login/2fa/ -- roadmap #53. Where handleFirmPasswordLogin() and
    handleFirmLoginVerify() redirect a TOTP-enrolled member instead of
    signing them straight in (`?pending=<token>`), per migration 0047's own
    gate-placement reasoning: the original credential is proven but the
    session/side-effect is deferred until a code is verified here too.

    Static and enforces nothing itself, same posture as build_set_password_page():
    `POST /firm/2fa/verify` is the only real authority, and this page is just
    a place to collect the code and show its response. Reached only by
    redirect with a real `pending` token in practice, but a direct visit
    with none just shows a plain "no sign-in in progress" message instead of
    a broken form -- there is no session to leak by visiting this URL cold.

    `noindex`: a mid-authentication utility screen, not indexable content.
    """
    body = f"""<div class="dr-auth-card">
  <h1>Enter your code</h1>
  <p class="subhead">Enter the 6-digit code from your authenticator app, or one of your backup
  codes.</p>

  <form id="dr-2fa-entry-form" method="post" action="{REMINDER_BACKEND_BASE_URL}/firm/2fa/verify">
    <label for="dr-2fa-entry-code">Code</label>
    <input type="text" id="dr-2fa-entry-code" name="code" required autocomplete="one-time-code"
    autofocus>
    <button type="submit">Verify</button>
    <p id="dr-2fa-entry-error" role="alert" class="dr-account-err" hidden></p>
  </form>

  <p class="dr-account-err" id="dr-2fa-entry-no-pending" hidden>There is no sign-in in progress.
  Please sign in again.</p>

  <p class="dr-auth-alt"><a href="../">Back to sign in</a></p>
</div>
{_FIRM_2FA_ENTRY_JS_HTML}
"""
    return page_shell(
        f"Enter your code — {SITE_NAME}",
        "Two-factor authentication code entry for DeadlineRadar firm accounts.",
        body,
        home_href="../../",
        canonical_path="/firm-login/2fa/",
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
  <p id="dr-signin-sub-error" role="alert" class="field-hint" style="color:#c33737;" hidden></p>
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

  // Staff self-service CPE entry (2026-08-05). drCpeEntries and drLicenses
  // are module-level (not just locals inside drRender) because the
  // delegated form-submit handler below needs to look up which state/
  // requirement a given subscriber_id belongs to, and because logging a new
  // entry re-renders from the SAME two arrays rather than re-fetching
  // licenses (which never change from this page).
  var drLicenses = [];
  var drCpeEntries = [];

  function drCpeReq(stateSlug) {
    return (window.DR_CPE_REQUIREMENTS || {})[stateSlug] || null;
  }

  // Deliberately simpler than the firm dashboard's drCpeProgressForSubscriber:
  // no pace-aware "behind" risk verdict here -- this is one person's own
  // view of their own hours, not a roster-wide risk stat an admin scans for
  // who to chase. Just an honest "here's what's logged against what's
  // required."
  function drCpeProgressFor(lic) {
    var req = drCpeReq(lic.state_slug);
    if (!req || (req.total_hours === null && req.ethics_hours === null)) {
      return {hasRequirement: false, dataGapNote: req ? req.data_gap_note : null};
    }
    var totalLoggedTenths = 0, ethicsLoggedTenths = 0;
    drCpeEntries.forEach(function (e) {
      if (e.subscriber_id !== lic.id) return;
      totalLoggedTenths += Math.round(e.hours * 10);
      if (e.category === 'ethics') ethicsLoggedTenths += Math.round(e.hours * 10);
    });
    return {
      hasRequirement: true,
      totalRequired: req.total_hours, totalLogged: totalLoggedTenths / 10,
      ethicsRequired: req.ethics_hours, ethicsLogged: ethicsLoggedTenths / 10,
    };
  }

  // AuditLab BAR-1r (LOW, 2026-08-05): this reimplements drCpeBarHtml()
  // from the firm dashboard and reintroduced the exact BAR-1 defect already
  // fixed there -- rounding independently of completion let 119.5/120h
  // round to 100% and paint a full, unmodified-green bar on someone who
  // hasn't actually met their requirement. Same one-expression fix: cap at
  // 99% while incomplete. Deliberately staying completion-only (no
  // riskBehind param) rather than adopting the dashboard's pace-aware
  // colour -- this is the staff member's OWN view of their OWN progress,
  // not an admin's at-risk triage list, so a plain still-short-of-done
  // signal is the right scope here.
  function drCpeBarHtml(label, logged, required) {
    if (required === null) return '';
    var incomplete = logged < required;
    var pct = Math.min(incomplete ? 99 : 100, Math.round((logged / required) * 100));
    return '<div class="dr-my-cpe-bar-row"><span>' + drEsc(label) + '</span>' +
      '<span class="dr-my-cpe-bar-track"><span class="dr-my-cpe-bar-fill' + (incomplete ? ' dr-my-cpe-bar-fill--behind' : '') + '" style="width:' + pct + '%"></span></span>' +
      '<span>' + logged + ' / ' + required + 'h</span></div>';
  }

  function drCpeEntriesHtml(lic) {
    var entries = drCpeEntries.filter(function (e) { return e.subscriber_id === lic.id; });
    if (!entries.length) return '<p class="dr-my-cpe-empty">No hours logged yet.</p>';
    return '<ul class="dr-my-cpe-entries">' + entries.map(function (e) {
      return '<li>' + drEsc(e.entry_date) + ' &mdash; ' + e.hours + 'h' +
        (e.category !== 'general' ? ' (' + drEsc(e.category) + ')' : '') +
        (e.description ? ': ' + drEsc(e.description) : '') + '</li>';
    }).join('') + '</ul>';
  }

  // Only rendered for a firm-tracked license (lic.managed_by_firm) -- CPE
  // entries require a firm_id by schema (migration 0009), so a free
  // individual's own license structurally can never have any; showing this
  // section there would be a form that always 404s on submit.
  function drCpeSectionHtml(lic) {
    var p = drCpeProgressFor(lic);
    if (!p.hasRequirement) {
      var gapText = p.dataGapNote ? drEsc(p.dataGapNote) : 'CPE requirement not codified for this state.';
      return '<div class="dr-my-cpe"><h4>CPE hours</h4><p class="dr-my-cpe-empty">' + gapText + '</p></div>';
    }
    var totalBar = p.totalRequired !== null ? drCpeBarHtml('Total', p.totalLogged, p.totalRequired) : '';
    var ethicsBar = p.ethicsRequired !== null ? drCpeBarHtml('Ethics', p.ethicsLogged, p.ethicsRequired) : '';
    return '<div class="dr-my-cpe"><h4>CPE hours</h4>' + totalBar + ethicsBar +
      drCpeEntriesHtml(lic) +
      '<form class="dr-my-cpe-form" data-subscriber-id="' + drEsc(lic.id) + '">' +
        '<input type="date" name="entry_date" required aria-label="Date completed">' +
        '<input type="number" name="hours" step="0.1" min="0.1" max="1000" required aria-label="Hours" placeholder="Hours">' +
        '<select name="category" aria-label="Category">' +
          '<option value="general">General</option><option value="ethics">Ethics</option><option value="other">Other</option>' +
        '</select>' +
        '<button type="submit">Log hours</button>' +
        '<span class="dr-my-cpe-error" role="alert" hidden></span>' +
      '</form></div>';
  }

  // Roadmap #12: pre-fills the profile form from the SAME /subscriber/licenses
  // response drRender() already gets -- first_name/reminder_thresholds are
  // person-level (every row sharing this email agrees), so no separate
  // fetch is needed. Only runs once (nameInput.dataset.drFilled guards a
  // re-render, e.g. after logging CPE hours, from clobbering an in-progress
  // edit the person hasn't saved yet).
  function drMyFillProfile(data) {
    var nameInput = document.getElementById('dr-my-name-input');
    if (nameInput && !nameInput.dataset.drFilled) {
      nameInput.value = data.first_name || '';
      nameInput.dataset.drFilled = '1';
    }
    var cadenceForm = document.getElementById('dr-my-cadence-form');
    if (cadenceForm && !cadenceForm.dataset.drFilled) {
      var active = data.reminder_thresholds; // null -> every box checked (the default)
      var boxes = cadenceForm.querySelectorAll('input[name="my-cadence"]');
      for (var i = 0; i < boxes.length; i++) {
        boxes[i].checked = !active || active.indexOf(Number(boxes[i].value)) !== -1;
      }
      cadenceForm.dataset.drFilled = '1';
    }
    var modeForm = document.getElementById('dr-my-notification-mode-form');
    if (modeForm && !modeForm.dataset.drFilled) {
      var mode = data.notification_mode || 'immediate';
      var modeRadios = modeForm.querySelectorAll('input[name="my-notification-mode"]');
      for (var j = 0; j < modeRadios.length; j++) {
        modeRadios[j].checked = modeRadios[j].value === mode;
      }
      modeForm.dataset.drFilled = '1';
    }
    // Roadmap #22: three-state panel (not opted in / awaiting a code /
    // opted in), so this always reflects the server's own state on every
    // render -- no drFilled guard, since "awaiting a code" is a transient
    // client-only state that a background poll/re-render should not
    // clobber once the person has actually submitted a phone number, but
    // a genuine server-confirmed opted-in status should always win.
    drRenderSmsPanel(Boolean(data.sms_opted_in), data.phone_last4 || null);
  }

  // Roadmap #22 (2026-08-09): SMS opt-in, double opt-in flow (send a code,
  // confirm it) -- same rigor as the email confirm_token flow, applied to
  // a new channel with real TCPA consent requirements. Three UI states:
  // not opted in (phone input), awaiting a code (code input), opted in
  // (status + opt-out button).
  function drRenderSmsPanel(optedIn, phoneLast4) {
    var disconnectedEl = document.getElementById('dr-sms-disconnected');
    var awaitingEl = document.getElementById('dr-sms-awaiting-code');
    var connectedEl = document.getElementById('dr-sms-connected');
    var statusEl = document.getElementById('dr-sms-status-text');
    if (!disconnectedEl || !awaitingEl || !connectedEl) return;
    if (optedIn) {
      if (statusEl) statusEl.textContent = 'Texts enabled for the number ending in ' + (phoneLast4 || '????') + '.';
      connectedEl.hidden = false;
      disconnectedEl.hidden = true;
      awaitingEl.hidden = true;
    } else if (!awaitingEl.dataset.drAwaitingCode) {
      connectedEl.hidden = true;
      disconnectedEl.hidden = false;
      awaitingEl.hidden = true;
    }
  }

  function drSmsStartVerification(form) {
    var okEl = document.getElementById('dr-sms-ok');
    var errEl = document.getElementById('dr-sms-error');
    if (okEl) { okEl.hidden = true; okEl.textContent = ''; }
    if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
    var input = document.getElementById('dr-sms-phone-input');
    var phone = input ? input.value.trim() : '';
    var consentBox = document.getElementById('dr-sms-consent-checkbox');
    if (!consentBox || !consentBox.checked) {
      if (errEl) { errEl.textContent = 'Please check the box to confirm you want text reminders.'; errEl.hidden = false; }
      return;
    }
    // AuditLab SMS-3 (2026-08-09): this client check is a UX nicety, not
    // the enforcement -- consent + consent_version are transmitted below
    // and the server independently refuses without them (validation
    // authority stays server-side). Bump the version string here (and the
    // matching one worker/src/sms.ts's SMS_CONSENT_VERSION documents) any
    // time the disclosure text a few lines below changes.
    var submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;

    fetch('/api/subscriber/phone/start-verification', {
      method: 'POST', credentials: 'include',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({phone_number: phone, consent: true, consent_version: 'sms-consent-2026-08-09'}),
    }).then(function (res) {
      if (submitBtn) submitBtn.disabled = false;
      if (res.status === 401) { window.location.href = '/signin/'; return null; }
      return res.json().catch(function () { return null; }).then(function (data) {
        if (!res.ok) {
          if (errEl) { errEl.textContent = (data && data.error) ? data.error : 'Something went wrong, please try again.'; errEl.hidden = false; }
          return;
        }
        var disconnectedEl = document.getElementById('dr-sms-disconnected');
        var awaitingEl = document.getElementById('dr-sms-awaiting-code');
        if (disconnectedEl) disconnectedEl.hidden = true;
        if (awaitingEl) { awaitingEl.hidden = false; awaitingEl.dataset.drAwaitingCode = '1'; }
        if (okEl) { okEl.textContent = 'Code sent -- check your phone.'; okEl.hidden = false; }
      });
    }).catch(function () {
      if (submitBtn) submitBtn.disabled = false;
      if (errEl) { errEl.textContent = 'Something went wrong, please try again.'; errEl.hidden = false; }
    });
  }

  function drSmsConfirmVerification(form) {
    var okEl = document.getElementById('dr-sms-ok');
    var errEl = document.getElementById('dr-sms-error');
    if (okEl) { okEl.hidden = true; okEl.textContent = ''; }
    if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
    var input = document.getElementById('dr-sms-code-input');
    var code = input ? input.value.trim() : '';
    var submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;

    fetch('/api/subscriber/phone/confirm-verification', {
      method: 'POST', credentials: 'include',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({code: code}),
    }).then(function (res) {
      if (submitBtn) submitBtn.disabled = false;
      if (res.status === 401) { window.location.href = '/signin/'; return null; }
      return res.json().catch(function () { return null; }).then(function (data) {
        if (!res.ok) {
          if (errEl) { errEl.textContent = (data && data.error) ? data.error : 'That code is incorrect or has expired.'; errEl.hidden = false; }
          return;
        }
        var awaitingEl = document.getElementById('dr-sms-awaiting-code');
        if (awaitingEl) delete awaitingEl.dataset.drAwaitingCode;
        drRenderSmsPanel(true, data.phone_last4 || null);
        if (okEl) { okEl.textContent = 'Text reminders enabled.'; okEl.hidden = false; }
      });
    }).catch(function () {
      if (submitBtn) submitBtn.disabled = false;
      if (errEl) { errEl.textContent = 'Something went wrong, please try again.'; errEl.hidden = false; }
    });
  }

  function drSmsOptOut() {
    var okEl = document.getElementById('dr-sms-ok');
    var errEl = document.getElementById('dr-sms-error');
    if (okEl) { okEl.hidden = true; okEl.textContent = ''; }
    if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
    var btn = document.getElementById('dr-sms-opt-out-btn');
    if (btn) btn.disabled = true;

    fetch('/api/subscriber/phone/opt-out', {
      method: 'POST', credentials: 'include',
      headers: {'content-type': 'application/json'},
    }).then(function (res) {
      if (btn) btn.disabled = false;
      if (res.status === 401) { window.location.href = '/signin/'; return null; }
      return res.json().catch(function () { return null; }).then(function (data) {
        if (!res.ok) {
          if (errEl) { errEl.textContent = (data && data.error) ? data.error : 'Something went wrong, please try again.'; errEl.hidden = false; }
          return;
        }
        drRenderSmsPanel(false, null);
        if (okEl) { okEl.textContent = 'Text reminders turned off.'; okEl.hidden = false; }
      });
    }).catch(function () {
      if (btn) btn.disabled = false;
      if (errEl) { errEl.textContent = 'Something went wrong, please try again.'; errEl.hidden = false; }
    });
  }

  function drRender(data) {
    if (emailEl) emailEl.textContent = data.email || '';
    drMyFillProfile(data);
    drLicenses = data.licenses || [];
    if (!drLicenses.length) {
      if (emptyEl) emptyEl.hidden = false;
      return;
    }
    listEl.innerHTML = drLicenses.map(function (lic) {
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
        (lic.managed_by_firm ? drCpeSectionHtml(lic) : '') +
        '</li>';
    }).join('');
  }

  // Delegated submit handler -- the forms above are rebuilt on every
  // drRender() call, so a per-form listener would need re-wiring each time;
  // one listener on the list container survives every re-render.
  listEl.addEventListener('submit', function (e) {
    var form = e.target.closest ? e.target.closest('.dr-my-cpe-form') : null;
    if (!form) return;
    e.preventDefault();
    var errEl = form.querySelector('.dr-my-cpe-error');
    if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
    var btn = form.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;
    var body = {
      subscriber_id: form.getAttribute('data-subscriber-id'),
      entry_date: form.entry_date.value,
      hours: form.hours.value,
      category: form.category.value,
    };
    fetch('/api/subscriber/cpe', {
      method: 'POST',
      credentials: 'include',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify(body),
    }).then(function (res) {
      if (res.status === 401) { window.location.href = '/signin/'; return null; }
      return res.json().catch(function () { return null; }).then(function (data) {
        if (!res.ok) {
          if (errEl) { errEl.textContent = (data && data.error) ? data.error : 'Something went wrong, please try again.'; errEl.hidden = false; }
          if (btn) btn.disabled = false;
          return;
        }
        if (data) drCpeEntries.push(data);
        drRender({email: emailEl ? emailEl.textContent : '', licenses: drLicenses});
      });
    }).catch(function () {
      if (errEl) { errEl.textContent = 'Something went wrong, please try again.'; errEl.hidden = false; }
      if (btn) btn.disabled = false;
    });
  });

  fetch('/api/subscriber/licenses', {credentials: 'include'})
    .then(function (res) {
      if (res.status === 401) { window.location.href = '/signin/'; return null; }
      if (!res.ok) throw new Error('load failed');
      return res.json();
    })
    .then(function (data) {
      if (!data) return null;
      // CPE entries loaded BEFORE the first render, so a firm-tracked
      // license's progress bars never flash empty-then-populated.
      return fetch('/api/subscriber/cpe', {credentials: 'include'})
        .then(function (res) { return res.ok ? res.json() : {entries: []}; })
        .catch(function () { return {entries: []}; })
        .then(function (cpeData) {
          drCpeEntries = (cpeData && cpeData.entries) || [];
          drRender(data);
        });
    })
    .catch(function () {
      // Never leave the page sitting on "Loading..." forever -- a silent
      // spinner reads as "you have nothing", which for a deadline product is
      // a genuinely dangerous thing to imply.
      if (listEl) listEl.innerHTML = '';
      if (errorEl) errorEl.hidden = false;
    });

  // Roadmap #12: self-service profile -- name, email, reminder cadence.
  var nameForm = document.getElementById('dr-my-name-form');
  if (nameForm) {
    nameForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var okEl = document.getElementById('dr-my-name-ok');
      var errEl = document.getElementById('dr-my-name-error');
      if (okEl) { okEl.hidden = true; okEl.textContent = ''; }
      if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
      fetch('/api/subscriber/profile', {
        method: 'POST', credentials: 'include',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({first_name: document.getElementById('dr-my-name-input').value}),
      }).then(function (res) {
        if (res.status === 401) { window.location.href = '/signin/'; return null; }
        return res.json().catch(function () { return null; }).then(function (data) {
          if (!res.ok) {
            if (errEl) { errEl.textContent = (data && data.error) ? data.error : 'Something went wrong, please try again.'; errEl.hidden = false; }
            return;
          }
          if (okEl) { okEl.textContent = 'Name saved.'; okEl.hidden = false; }
        });
      }).catch(function () {
        if (errEl) { errEl.textContent = 'Something went wrong, please try again.'; errEl.hidden = false; }
      });
    });
  }

  var emailForm = document.getElementById('dr-my-email-form');
  if (emailForm) {
    emailForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var okEl = document.getElementById('dr-my-email-ok');
      var errEl = document.getElementById('dr-my-email-error');
      if (okEl) { okEl.hidden = true; okEl.textContent = ''; }
      if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
      var newEmail = document.getElementById('dr-my-email-input').value;
      fetch('/api/subscriber/change-email', {
        method: 'POST', credentials: 'include',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({new_email: newEmail}),
      }).then(function (res) {
        if (res.status === 401) { window.location.href = '/signin/'; return null; }
        return res.json().catch(function () { return null; }).then(function (data) {
          if (!res.ok) {
            if (errEl) { errEl.textContent = (data && data.error) ? data.error : 'Something went wrong, please try again.'; errEl.hidden = false; }
            return;
          }
          emailForm.reset();
          if (okEl) { okEl.textContent = 'Check ' + newEmail + ' for a confirmation link -- nothing changes until you click it.'; okEl.hidden = false; }
        });
      }).catch(function () {
        if (errEl) { errEl.textContent = 'Something went wrong, please try again.'; errEl.hidden = false; }
      });
    });
  }

  var cadenceFormEl = document.getElementById('dr-my-cadence-form');
  if (cadenceFormEl) {
    cadenceFormEl.addEventListener('submit', function (e) {
      e.preventDefault();
      var okEl = document.getElementById('dr-my-cadence-ok');
      var errEl = document.getElementById('dr-my-cadence-error');
      if (okEl) { okEl.hidden = true; okEl.textContent = ''; }
      if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
      var boxes = cadenceFormEl.querySelectorAll('input[name="my-cadence"]:checked');
      var thresholds = [];
      for (var i = 0; i < boxes.length; i++) thresholds.push(Number(boxes[i].value));
      // All 6 checked is indistinguishable from "never set" server-side --
      // send null in that one case so it stays a true "inherit" rather than
      // an explicit (but equivalent) subset, same posture the firm-side
      // cadence form would need if it offered a "reset to default" action.
      var body = thresholds.length === 6 ? {thresholds: null} : {thresholds: thresholds};
      fetch('/api/subscriber/reminder-cadence', {
        method: 'PATCH', credentials: 'include',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify(body),
      }).then(function (res) {
        if (res.status === 401) { window.location.href = '/signin/'; return null; }
        return res.json().catch(function () { return null; }).then(function (data) {
          if (!res.ok) {
            if (errEl) { errEl.textContent = (data && data.error) ? data.error : 'Please choose at least one reminder timing.'; errEl.hidden = false; }
            return;
          }
          if (okEl) { okEl.textContent = 'Reminder timing saved.'; okEl.hidden = false; }
        });
      }).catch(function () {
        if (errEl) { errEl.textContent = 'Something went wrong, please try again.'; errEl.hidden = false; }
      });
    });
  }

  var modeFormEl = document.getElementById('dr-my-notification-mode-form');
  if (modeFormEl) {
    modeFormEl.addEventListener('submit', function (e) {
      e.preventDefault();
      var okEl = document.getElementById('dr-my-notification-mode-ok');
      var errEl = document.getElementById('dr-my-notification-mode-error');
      if (okEl) { okEl.hidden = true; okEl.textContent = ''; }
      if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
      var checked = modeFormEl.querySelector('input[name="my-notification-mode"]:checked');
      var mode = checked ? checked.value : 'immediate';
      fetch('/api/subscriber/notification-mode', {
        method: 'PATCH', credentials: 'include',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({mode: mode}),
      }).then(function (res) {
        if (res.status === 401) { window.location.href = '/signin/'; return null; }
        return res.json().catch(function () { return null; }).then(function (data) {
          if (!res.ok) {
            if (errEl) { errEl.textContent = (data && data.error) ? data.error : 'Something went wrong, please try again.'; errEl.hidden = false; }
            return;
          }
          if (okEl) { okEl.textContent = 'Notification preference saved.'; okEl.hidden = false; }
        });
      }).catch(function () {
        if (errEl) { errEl.textContent = 'Something went wrong, please try again.'; errEl.hidden = false; }
      });
    });
  }

  var smsStartFormEl = document.getElementById('dr-sms-start-form');
  if (smsStartFormEl) {
    smsStartFormEl.addEventListener('submit', function (e) {
      e.preventDefault();
      drSmsStartVerification(smsStartFormEl);
    });
  }
  var smsConfirmFormEl = document.getElementById('dr-sms-confirm-form');
  if (smsConfirmFormEl) {
    smsConfirmFormEl.addEventListener('submit', function (e) {
      e.preventDefault();
      drSmsConfirmVerification(smsConfirmFormEl);
    });
  }
  var smsOptOutBtn = document.getElementById('dr-sms-opt-out-btn');
  if (smsOptOutBtn) {
    smsOptOutBtn.addEventListener('click', function (e) {
      e.preventDefault();
      drSmsOptOut();
    });
  }

  // Roadmap #12: the email-change confirm click lands back here with a
  // query-string outcome (?email_changed=1 / ?email_change_failed=conflict)
  // -- same "tell them what happened" posture the firm dashboard's own
  // #account?email_changed=1 hash handling already established.
  var myParams = new URLSearchParams(window.location.search);
  if (myParams.get('email_changed') === '1') {
    var nameOk = document.getElementById('dr-my-email-ok');
    if (nameOk) { nameOk.textContent = 'Your email address was updated.'; nameOk.hidden = false; }
  } else if (myParams.get('email_change_failed') === 'conflict') {
    var emailErr = document.getElementById('dr-my-email-error');
    if (emailErr) { emailErr.textContent = 'That address was claimed by someone else before you confirmed. Please try again with a different one.'; emailErr.hidden = false; }
  }
})();
</script>"""

_MY_DASHBOARD_JS_HTML = _MY_DASHBOARD_JS_HTML.replace(
    "'/api/subscriber", f"'{REMINDER_BACKEND_BASE_URL}/subscriber"
)


def build_my_page(cpe_hours_by_slug: dict[str, dict]) -> str:
    """The free individual's dashboard (2026-07-31).

    Was read-only by design -- every mutation (unsubscribe, re-arm, "I
    renewed") stayed on the tokenised links in reminder emails, keeping the
    write surface at zero new endpoints. That changed 2026-08-05 (Devin:
    staff self-service CPE entry, "an email... but only option is to input
    hours"): this page is also where a firm-tracked staffer signs in
    themselves, so it's no longer accurate to call the whole page read-only
    -- CPE hours are the one thing a signed-in subscriber can now write, and
    only ever against their own subscriber row(s) (POST /subscriber/cpe,
    proven by email match server-side, never by anything this page sends).
    Everything else on this page -- unsubscribe, re-arm, "I renewed" -- is
    still exactly as read-only as before.

    `noindex` for the same reason /firm-dashboard/ is: a signed-in app view,
    not indexable content. /signin/ stays indexable.
    """
    # Same small, static projection of cpe_hours.json build_firm_dashboard_page()
    # embeds -- see that function's own comment for why (no citation/notes,
    # just what the progress calculation and the honest-gap message need).
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

  <div class="dr-account-panel" id="dr-my-profile">
    <h2>Your profile</h2>
    <p class="signup-microcopy">Your own name, email, and which reminders you get -- applies across
    every deadline above, including any your firm tracks for you. To stop or restart reminders for
    one specific deadline instead, use the links at the bottom of that deadline's emails.</p>

    <form id="dr-my-name-form">
      <label for="dr-my-name-input">Your name (optional)</label>
      <input type="text" id="dr-my-name-input" maxlength="60" placeholder="How should we address you?">
      <button type="submit">Save name</button>
    </form>
    <p id="dr-my-name-ok" class="dr-account-ok" hidden></p>
    <p id="dr-my-name-error" role="alert" class="dr-account-err" hidden></p>

    <form id="dr-my-email-form">
      <label for="dr-my-email-input">Change your email address</label>
      <input type="email" id="dr-my-email-input" required placeholder="you@example.com">
      <button type="submit">Send confirmation link</button>
    </form>
    <p class="field-hint">We'll email a confirmation link to the new address before anything
    changes, and let your current address know too.</p>
    <p id="dr-my-email-ok" class="dr-account-ok" hidden></p>
    <p id="dr-my-email-error" role="alert" class="dr-account-err" hidden></p>

    <form id="dr-my-cadence-form">
      <fieldset class="dr-cadence-fieldset">
        <legend>Which reminders you get</legend>
        <label><input type="checkbox" name="my-cadence" value="60"> 60 days out</label>
        <label><input type="checkbox" name="my-cadence" value="30"> 30 days out</label>
        <label><input type="checkbox" name="my-cadence" value="14"> 14 days out</label>
        <label><input type="checkbox" name="my-cadence" value="7"> 7 days out</label>
        <label><input type="checkbox" name="my-cadence" value="3"> 3 days out</label>
        <label><input type="checkbox" name="my-cadence" value="1"> 1 day out (final reminder)</label>
      </fieldset>
      <p class="field-hint">Leave all checked (the default) for the full escalating schedule, or use
      this to receive fewer. This is your own setting -- it applies even if your firm has its own
      cadence, and doesn't change anything for anyone else on their roster.</p>
      <button type="submit">Save</button>
    </form>
    <p id="dr-my-cadence-ok" class="dr-account-ok" hidden></p>
    <p id="dr-my-cadence-error" role="alert" class="dr-account-err" hidden></p>

    <form id="dr-my-notification-mode-form">
      <fieldset class="dr-cadence-fieldset">
        <legend>How you're notified</legend>
        <label><input type="radio" name="my-notification-mode" value="immediate"> Email me as each reminder point arrives</label>
        <label><input type="radio" name="my-notification-mode" value="digest"> Bundle into one email a week, only when something's new</label>
      </fieldset>
      <p class="field-hint">Digest mode never sends an empty "nothing to report" email -- you'll hear
      from us at most once a week, and only when a reminder above is actually due.</p>
      <button type="submit">Save</button>
    </form>
    <p id="dr-my-notification-mode-ok" class="dr-account-ok" hidden></p>
    <p id="dr-my-notification-mode-error" role="alert" class="dr-account-err" hidden></p>
  </div>

  <div class="dr-account-panel" id="dr-my-sms">
    <h2>Text reminders</h2>
    <p class="signup-microcopy">Get a text at the same reminder points as your email, on top of it
    -- not instead of it. Message and data rates may apply. Reply STOP at any time to opt out.</p>
    <div id="dr-sms-disconnected">
      <form id="dr-sms-start-form">
        <label for="dr-sms-phone-input">Your phone number</label>
        <input type="tel" id="dr-sms-phone-input" placeholder="+15551234567">
        <label class="dr-sms-consent-label">
          <input type="checkbox" id="dr-sms-consent-checkbox">
          I agree to receive automated CPA renewal deadline text reminders from DeadlineRadar at
          this number. Message and data rates may apply. Reply STOP to opt out, HELP for help.
        </label>
        <button type="submit">Send code</button>
      </form>
    </div>
    <div id="dr-sms-awaiting-code" hidden>
      <form id="dr-sms-confirm-form">
        <label for="dr-sms-code-input">Enter the code we texted you</label>
        <input type="text" id="dr-sms-code-input" inputmode="numeric" maxlength="6" placeholder="123456">
        <button type="submit">Confirm</button>
      </form>
    </div>
    <div id="dr-sms-connected" hidden>
      <p id="dr-sms-status-text"></p>
      <button type="button" id="dr-sms-opt-out-btn" class="dr-btn-secondary">Turn off text reminders</button>
    </div>
    <p id="dr-sms-ok" class="dr-account-ok" hidden></p>
    <p id="dr-sms-error" role="alert" class="dr-account-err" hidden></p>
  </div>

  <div class="dr-my-error" id="dr-my-error" role="alert" hidden>
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
    attention soonest &mdash; plus CPE hour tracking and a calendar view. Free, no time limit, no card
    required.</p>
    <p><a class="cta-button" href="/for-firms/">See DeadlineRadar for Firms &rarr;</a></p>
  </div>
</div>
<script>
var DR_CPE_REQUIREMENTS = {json.dumps(cpe_requirements_json)};
</script>
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
      <span><span class="swatch" style="background:#1f9e8e"></span>Requirements marked complete (your firm's own record)</span>
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
    <label for="dr-add-fee">Renewal fee (optional)</label>
    <input type="text" inputmode="decimal" id="dr-add-fee" name="renewal_fee" placeholder="e.g. 199.00">
    <label for="dr-add-office">Office / department (optional)</label>
    <input type="text" id="dr-add-office" name="office_tag" maxlength="60" placeholder="e.g. Downtown office">
    <button type="submit">Add staff</button>
  </form>
  <p id="dr-add-error" role="alert" class="field-hint" style="color:#c33737;" hidden></p>
</div>

<div class="signup-form dr-csv-import-panel" id="dr-csv-import">
  <h2>Import staff (CSV)</h2>
  <p class="signup-microcopy">One row per staff member. First row must be column headers -- at
  minimum <code>email</code> and <code>state</code> (or <code>state_slug</code>). Optional columns:
  <code>staff_label</code>, <code>license_type_id</code>, <code>birth_month</code>,
  <code>birth_year</code>, <code>cohort_group</code>, <code>license_expiration_date</code>,
  <code>renewal_fee</code>, <code>office_tag</code> -- same fields the form above accepts, so a state
  needing more than email/state (about a third of them do) needs the matching column filled in or
  that row will be skipped with the same reason the single Add Staff form would show.</p>
  <p class="signup-microcopy">Starting from an existing spreadsheet? <button type="button" class="dr-link-btn" id="dr-csv-template-btn">Download a blank template</button>
  with the exact column headers below, then copy your staff into it -- safer than retyping headers by hand.</p>
  <label for="dr-csv-import-file">CSV file</label>
  <input type="file" id="dr-csv-import-file" accept=".csv,text/csv">
  <button type="button" id="dr-csv-preview-btn">Preview</button>
  <div id="dr-csv-preview-body"></div>
  <button type="button" id="dr-csv-import-btn" hidden>Import staff</button>
  <p class="dr-modal-hint" id="dr-csv-import-status"></p>
</div>

<div class="signup-form dr-csv-import-panel" id="dr-csv-export">
  <h2>Export staff (CSV)</h2>
  <p class="signup-microcopy">Download your full roster as a CSV -- every field this page tracks,
  plus current CPE progress. A read-only report for backups or spreadsheets, not formatted for
  re-import (it uses display labels like state name and license type name, not the raw
  state_slug/license_type_id codes Import above expects).</p>
  <button type="button" id="dr-csv-export-btn">Export staff</button>
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
var drEditModalId = null;
var drEditModalTriggerBtn = null;
var drDeleteAccountModalTriggerBtn = null;
var drRuleChangeModalTriggerBtn = null;
var drRuleChangeModalCurrentEvent = null;
// GET /firm/licenses's own seat_cap (worker/src/validation.ts's
// SELF_SERVE_SEAT_CAP) -- null until the first successful load, same "don't
// show a number we haven't actually gotten from the server yet" posture as
// drLicenses starting empty rather than a guessed default.
var drSeatCap = null;

// Self-serve cancellation (2026-08-05, migration 0021). Same "null until
// the first real load" posture as drSeatCap above.
var drBilling = null;

// Roadmap #151 Phase 4 (2026-08-10): server-computed (index.ts's
// handleFirmLicensesList) so the client never reimplements the cutover-date
// math itself. Starts true (not null/false) so the brief pre-load window
// never flashes a false upsell before the real value arrives. Set once,
// from drLoadLicenses()'s response, right before drRenderStats()/
// drRenderAtRisk() (both read this at their own top) are called.
// drEnterSampleMode()/drExitSampleMode() deliberately do NOT touch this --
// sample mode mirrors the REAL firm's own entitlement rather than always
// showing the full paid view, so a free-tier firm previewing sample data
// sees the same upsell it would with real data, not a confusing mismatch.
var drDashboardSynthesisIncluded = true;
var DR_PLAN_TIER_LABELS = {
  firm_starter: 'Essentials', firm_growth: 'Growth', firm_standard: 'Professional', firm_scale: 'Enterprise'
};

// migration 0045 (roadmap #11/#13/#14/#51): the CALLER's own role/member id,
// same "null until the first real load" posture as drBilling above. Drives
// which Team panel controls render -- the backend is the real gate either
// way (every mutating /firm/members/* route re-checks this itself).
var drRole = null;
var drMemberId = null;
var drTeamMembers = [];
var DR_ROLE_LABELS = { partner: 'Partner', office_manager: 'Office Manager', staff: 'Staff' };

// Task #14 (2026-08-05, reported directly: "why would nothing happen when
// clicking Mark Renewed" -- the write DID succeed, drShowSuccess() DID run,
// but this banner lives at the very top of .dr-main while the Roster table
// (and its Mark renewed/Remove/Save buttons) sits well below the overview
// stats/at-risk panel/activity feed -- on any normal viewport the banner
// fires completely off-screen above whatever the admin is actually looking
// at, indistinguishable from silently doing nothing. scrollIntoView on both
// banners (not just success) fixes the whole class of "did my click do
// anything" reports from any roster action, not just this one.
function drScrollBannerIntoView(el) {
  if (el && typeof el.scrollIntoView === 'function') {
    el.scrollIntoView({behavior: 'smooth', block: 'nearest'});
  }
}
function drShowError(msg) {
  drClearSuccess();
  var el = document.getElementById('dr-dash-error');
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
  drScrollBannerIntoView(el);
}
function drClearError() {
  var el = document.getElementById('dr-dash-error');
  if (!el) return;
  el.hidden = true;
  el.textContent = '';
}
// Mirrors drShowError/drClearError -- same single-banner pattern, separate
// element so a success message never collides with role="alert" (an
// assistive-tech alert role is for problems, not confirmations).
function drShowSuccess(msg) {
  drClearError();
  var el = document.getElementById('dr-dash-success');
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
  drScrollBannerIntoView(el);
}
function drClearSuccess() {
  var el = document.getElementById('dr-dash-success');
  if (!el) return;
  el.hidden = true;
  el.textContent = '';
}
// Same single-banner pattern as drShowError/drShowSuccess, but deliberately
// does NOT clear a success message (or get cleared by one) -- a duplicate-
// email warning is a caution ABOUT a successful add/edit, not a competing
// outcome, so both can be visible together. Still clears any stale error.
function drShowWarning(msg) {
  drClearError();
  var el = document.getElementById('dr-dash-warning');
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
}
function drClearWarning() {
  var el = document.getElementById('dr-dash-warning');
  if (!el) return;
  el.hidden = true;
  el.textContent = '';
}
function drStartCheckout(tier, btn, errElId) {
  // Task #12: the billing panel's upgrade buttons (the only remaining caller
  // -- the old whole-dashboard paywall panel was removed 2026-08-06 once
  // Roster/Calendar/CPE Hours became a standing free tier with nothing left
  // to gate there) surface their error in the Account tab's dr-billing-error
  // box.
  var errEl = document.getElementById(errElId || 'dr-billing-error');
  if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
  if (btn) btn.disabled = true;
  fetch('/api/firm/billing/checkout', {
    method: 'POST',
    credentials: 'include',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({tier: tier})
  }).then(function(res) {
    if (res.status === 401) { window.location.href = '/firm-login/'; return null; }
    return drReadJsonSafe(res).then(function(data) {
      if (!res.ok) {
        if (errEl) {
          errEl.textContent = (data && data.error) ? data.error : 'Something went wrong, please try again.';
          errEl.hidden = false;
        }
        if (btn) btn.disabled = false;
        return;
      }
      if (data && data.checkout_url) { window.location.href = data.checkout_url; }
    });
  }).catch(function() {
    if (errEl) { errEl.textContent = 'Something went wrong, please try again.'; errEl.hidden = false; }
    if (btn) btn.disabled = false;
  });
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

// Roster table gap, confirmed via live test (2026-08-05): the Status badge
// column can say "Active" or "Needs attention" without matching whether the
// date in the very next column has actually passed -- "Needs attention" is
// server-computed off missing/unresolvable data, not off the deadline date
// itself, so a genuinely overdue license with otherwise-complete data reads
// as a plain, unremarkable date next to an "Active" badge. Same is-overdue
// definition (days < 0) the Staff-at-risk panel and Coverage donut already
// use (see drDaysUntil() below), so a date can't be flagged here and not
// there. drDaysUntil() is declared further down but hoisted (function
// declaration, not a var), so calling it here is safe.
function drRosterDeadlineCellAttrs(iso) {
  var days = drDaysUntil(iso);
  if (days === null || days >= 0) return '';
  return ' class="dr-deadline-overdue" title="Overdue"';
}

// ---------------------------------------------------------------------------
// Roadmap #29 (2026-08-07): sample-data mode for brand-new accounts. Purely
// client-side -- swaps the SAME drLicenses/drCpeEntries arrays every render
// function above and below already reads, so Roster/Calendar/Map/CPE Hours
// all show a consistent sample dashboard with zero new rendering logic.
// Nothing here ever reaches the server: no new endpoint, no fake DB rows
// that could leak into a real ICS export, an actual reminder email, or the
// seat count. drLoadLicenses()'s success handler unconditionally exits
// sample mode before applying its own result, so a stale sample view can
// never survive past the moment real data exists (e.g. right after adding
// a first real staff member re-triggers a load).
// ---------------------------------------------------------------------------
var drSampleModeActive = false;

function drIsoDateFromNow(offsetDays) {
  var d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

// Same 5 state/license-type pairs the live public demo account
// (demo@deadline-radar.com) already uses in production -- proven to render
// cleanly everywhere, including the CPE Hours requirement lookup, rather
// than guessing at slugs/ids that might hit a data gap. Deadlines are
// computed relative to "now" (never a hardcoded ISO date) so the sample
// spread never goes stale regardless of when a firm actually signs up, and
// are deliberately mixed -- 2 comfortably active, 2 due soon, 1 overdue --
// so the demo shows what an actual alert looks like, not just an empty
// green screen.
function drBuildSampleLicenses() {
  return [
    {id: 'sample-1', staff_label: 'Riley Chen', email: 'riley.chen@example.com', state_slug: 'georgia', state_name: 'Georgia', license_type_id: 'ga-individual', status: 'confirmed', next_deadline: drIsoDateFromNow(280), is_sample: true},
    {id: 'sample-2', staff_label: 'Devon Park', email: 'devon.park@example.com', state_slug: 'alabama', state_name: 'Alabama', license_type_id: 'al-all', status: 'confirmed', next_deadline: drIsoDateFromNow(12), is_sample: true},
    {id: 'sample-3', staff_label: 'Casey Nguyen', email: 'casey.nguyen@example.com', state_slug: 'missouri', state_name: 'Missouri', license_type_id: 'mo-individual', status: 'confirmed', next_deadline: drIsoDateFromNow(-6), is_sample: true},
    {id: 'sample-4', staff_label: 'Jamie Torres', email: 'jamie.torres@example.com', state_slug: 'louisiana', state_name: 'Louisiana', license_type_id: 'la-firm', status: 'confirmed', next_deadline: drIsoDateFromNow(150), is_sample: true},
    {id: 'sample-5', staff_label: 'Morgan Ellis', email: 'morgan.ellis@example.com', state_slug: 'illinois', state_name: 'Illinois', license_type_id: 'il-individual', status: 'confirmed', next_deadline: drIsoDateFromNow(25), is_sample: true}
  ];
}

function drBuildSampleCpeEntries() {
  return [
    {id: 'sample-cpe-1', subscriber_id: 'sample-1', hours: 8, category: 'technical', description: 'Sample entry', entry_date: drIsoDateFromNow(-30)},
    {id: 'sample-cpe-2', subscriber_id: 'sample-4', hours: 4, category: 'ethics', description: 'Sample entry', entry_date: drIsoDateFromNow(-60)}
  ];
}

// Every view that reads drLicenses/drCpeEntries directly, in the same order
// drLoadLicenses()'s own success handler renders them in -- entering or
// exiting sample mode re-runs this exact sequence so no view is left
// showing a stale mix of real and sample data.
function drRenderAllViews() {
  drRenderTable();
  drRenderStats();
  drRenderRenewalFeeRollup();
  drRenderAtRisk();
  drRenderNotifications();
  drRenderCalendar();
  drRenderAgenda();
  drPopulateMapStaffSelect();
  drRenderMapForSelection();
  drRenderCpeSummary();
  drRenderCpeStaffProgress();
  drRenderCpeStaffSelect();
  drRenderCpeRecent();
  drRenderReport();
}

function drEnterSampleMode() {
  drSampleModeActive = true;
  drLicenses = drBuildSampleLicenses();
  drCpeEntries = drBuildSampleCpeEntries();
  var banner = document.getElementById('dr-sample-mode-banner');
  if (banner) banner.hidden = false;
  // AuditLab SAMPLE-2: print-only counterpart (the print stylesheet hides
  // the banner above by design) -- toggled in lockstep everywhere sample
  // mode changes so a Ctrl+P mid-sample always prints the notice.
  var printNotice = document.getElementById('dr-print-sample-notice');
  if (printNotice) printNotice.hidden = false;
  drRenderAllViews();
}

function drExitSampleMode() {
  drSampleModeActive = false;
  drLicenses = [];
  drCpeEntries = [];
  var banner = document.getElementById('dr-sample-mode-banner');
  if (banner) banner.hidden = true;
  var printNotice = document.getElementById('dr-print-sample-notice');
  if (printNotice) printNotice.hidden = true;
  drRenderAllViews();
}

function drRenderRow(item) {
  var statusClass = DR_STATUS_CLASSES[item.status] || 'mock-status--risk';
  var statusLabel = DR_STATUS_LABELS[item.status] || item.status;
  var idAttr = drEscapeHtml(item.id);
  // AuditLab A11Y-3 (LOW, 2026-08-04): every button already has visible text
  // (no unnamed-button failures), but at roster scale a screen-reader user
  // tabbing through hears "Edit, Mark renewed, Remove" repeated once per
  // row with nothing distinguishing whose row they're on -- "Remove" is
  // destructive and identical-sounding to the next row's "Remove". Naming
  // each button with the row's own staff name/email (same fallback pattern
  // used everywhere else on this page) fixes that without changing the
  // visible label.
  var whoAttr = drEscapeHtml(item.staff_label || item.email);
  // Staff + Email merged into one stacked cell (2026-08-04, second attempt
  // -- see the CSS comment on .dr-roster-panel table for why the first
  // attempt, wrapping each onto multiple lines in separate columns, looked
  // worse rather than just narrower).
  var nameTitle = item.staff_label ? ' title="' + drEscapeHtml(item.staff_label) + '"' : '';
  var nameLine = item.staff_label
    ? '<span class="dr-roster-name"' + nameTitle + '>' + drEscapeHtml(item.staff_label) + '</span>'
    : '<span class="dr-roster-name" style="color:var(--muted)">\\u2014</span>';
  // Roadmap #16: office/department tag, shown as a small subtitle rather
  // than a new table column -- keeps the roster table's existing width/
  // scroll behavior unchanged on every page this shared row renderer feeds.
  var officeLine = item.office_tag ? '<span class="dr-roster-office">' + drEscapeHtml(item.office_tag) + '</span>' : '';
  // Roadmap #68: same small-subtitle treatment as office_tag above, but the
  // full note only shows on hover (title attribute) -- unlike a short office
  // tag, a note can run up to 500 characters and would otherwise dominate
  // the row.
  var notesLine = item.internal_notes
    ? '<span class="dr-roster-office" title="' + drEscapeHtml(item.internal_notes) + '">Note</span>'
    : '';
  // Roadmap #26: self-service snooze, admin-visible so nobody's left
  // guessing why a staffer's reminders went quiet -- see toFirmLicenseJson()
  // for why this is read-only from here (only the subscriber's own link, or
  // a renewal, can change it). Only shown while genuinely still in effect --
  // a past date is stale data the scheduler already ignores, not something
  // to keep displaying as if it still applies.
  var isSnoozed = item.snoozed_until && item.snoozed_until >= drIsoDateFromNow(0);
  var snoozeLine = isSnoozed
    ? '<span class="dr-roster-office">Snoozed until ' + drEscapeHtml(drFormatDeadline(item.snoozed_until)) + '</span>'
    : '';
  var staffCell = nameLine + '<span class="dr-roster-email" title="' + drEscapeHtml(item.email) + '">' + drEscapeHtml(item.email) + '</span>' + officeLine + notesLine + snoozeLine;
  // Roadmap #29: a sample row's id ('sample-1' etc.) matches nothing on the
  // server, so Edit/Mark renewed/Remove would either 404 or -- far worse if
  // ids ever collided -- silently act on a real record. No functional
  // buttons for a sample row, full stop; a plain badge instead.
  var actionsCell = item.is_sample
    ? '<span class="dr-sample-tag">Sample</span>'
    : '<button type="button" class="dr-btn-edit" data-id="' + idAttr + '" aria-label="Edit ' + whoAttr + '">Edit</button> ' +
      '<button type="button" class="dr-btn-renew" data-id="' + idAttr + '" aria-label="Mark ' + whoAttr + ' renewed">Mark renewed</button> ' +
      '<button type="button" class="dr-btn-remove" data-id="' + idAttr + '" aria-label="Remove ' + whoAttr + '">Remove</button> ' +
      // Roadmap #1/#2 (2026-08-07): document storage.
      '<button type="button" class="dr-btn-documents" data-id="' + idAttr + '" data-who="' + whoAttr + '" aria-label="Documents for ' + whoAttr + '">Documents</button>';
  // data-label drives the stacked card layout under 860px (CSS renders it
  // via ::before), so the header row can be hidden without losing meaning.
  var stateTitle = item.state_name ? ' title="' + drEscapeHtml(item.state_name) + '"' : '';
  // Reported directly ("wouldn't everyone have a license type?"): fall back
  // to the state's own single-record default (see DR_DEFAULT_LICENSE_TYPE_ID's
  // own comment on the Python side for exactly which states qualify and
  // why) -- display-only, never sent back to the server, never overrides a
  // real stored license_type_id.
  var licenseTypeIdForDisplay = item.license_type_id || DR_DEFAULT_LICENSE_TYPE_ID[item.state_slug];
  return '<tr data-id="' + idAttr + '">' +
    '<td data-label="Staff">' + staffCell + '</td>' +
    '<td data-label="State"' + stateTitle + '>' + drEscapeHtml(item.state_name || '') + '</td>' +
    '<td data-label="License type">' + drEscapeHtml(drPrettyLicenseType(licenseTypeIdForDisplay)) + '</td>' +
    '<td data-label="Status"><span class="mock-status ' + statusClass + '">' + drEscapeHtml(statusLabel) + '</span></td>' +
    '<td data-label="Next deadline"' + drRosterDeadlineCellAttrs(item.next_deadline) + '>' + drEscapeHtml(drFormatDeadline(item.next_deadline)) + '</td>' +
    '<td data-label="Actions" class="dr-actions">' + actionsCell + '</td>' +
  '</tr>';
}

// Roadmap #16 (2026-08-07): current "group by" selection, persisted across
// re-renders (add/edit/remove all funnel through drRenderTable()) so the
// filter doesn't silently reset every time the roster refreshes.
var drOfficeGroupFilter = '';

// Roadmap #38 (2026-08-07): "due within N days" quick filter, part of the
// same saved-view combination as the search/office/sort state below.
var drDueWithinDays = '';

// Roadmap #37 (2026-08-07): roster column sorting/filtering. Search is a
// substring match on name+email (same instant-filter posture #15's audit-
// trail search already established); sort is a single active column +
// direction, toggled by clicking a header again. Both are client-side over
// the already-fetched drLicenses -- no new endpoint.
var drRosterSearchQuery = '';
var drRosterSortColumn = null;
var drRosterSortDir = 'asc';

var DR_ROSTER_SORT_KEYS = {
  staff: function(item) { return (item.staff_label || item.email || '').toLowerCase(); },
  state: function(item) { return (item.state_name || '').toLowerCase(); },
  license_type: function(item) {
    var licenseTypeIdForDisplay = item.license_type_id || DR_DEFAULT_LICENSE_TYPE_ID[item.state_slug];
    return drPrettyLicenseType(licenseTypeIdForDisplay).toLowerCase();
  },
  status: function(item) { return (DR_STATUS_LABELS[item.status] || item.status || '').toLowerCase(); },
  // Unresolved (null) deadlines sort last regardless of direction -- "no
  // known date" isn't meaningfully "earliest" or "latest," and burying it
  // at the bottom either way keeps real dates from being interrupted by it.
  next_deadline: function(item) { return item.next_deadline || '9999-99-99'; }
};

function drApplyRosterSort(items) {
  var keyFn = drRosterSortColumn && DR_ROSTER_SORT_KEYS[drRosterSortColumn];
  if (!keyFn) return items;
  return items.slice().sort(function(a, b) {
    var ka = keyFn(a), kb = keyFn(b);
    if (ka < kb) return drRosterSortDir === 'asc' ? -1 : 1;
    if (ka > kb) return drRosterSortDir === 'asc' ? 1 : -1;
    return 0;
  });
}

function drRenderRosterSortHeaders() {
  document.querySelectorAll('.dr-sort-th').forEach(function(btn) {
    var col = btn.getAttribute('data-sort');
    var active = col === drRosterSortColumn;
    btn.setAttribute('data-active', active ? 'true' : 'false');
    var th = btn.closest('th');
    if (th) th.setAttribute('aria-sort', active ? (drRosterSortDir === 'asc' ? 'ascending' : 'descending') : 'none');
    var arrow = btn.querySelector('.dr-sort-arrow');
    if (arrow) arrow.textContent = active ? (drRosterSortDir === 'asc' ? '▲' : '▼') : '';
  });
  // Roadmap #40: keep the mobile <select> in sync when a sort was set via
  // header-button click (or a saved-view apply, or the initial no-sort state).
  var sortSelect = document.getElementById('dr-roster-sort-select');
  if (sortSelect) {
    sortSelect.value = drRosterSortColumn ? (drRosterSortColumn + ':' + drRosterSortDir) : '';
  }
}

function drRenderTable() {
  var tbody = document.getElementById('dr-roster-body');
  // Roadmap #28: re-checked on every roster render (add/edit/remove/renew
  // all funnel through here already) so the "add your first staff member"
  // checklist step updates live, not just on the next full page load.
  drRenderOnboardingChecklist();
  drRenderOfficeGroupFilter();
  drRenderBulkTagStaffSelect();
  drRenderRosterSortHeaders();
  if (!tbody) return;
  if (drLicenses.length === 0) {
    // Roadmap #29: only reachable when the real roster is genuinely empty
    // (sample mode fills drLicenses with 5 rows), so this is always the
    // real "nothing added yet" state -- offer the sample-data preview here.
    tbody.innerHTML = '<tr><td colspan="6">No staff on your roster yet -- add your first one below, or ' +
      '<button type="button" class="dr-link-btn" id="dr-sample-mode-enter-btn">see a sample roster</button> ' +
      'to preview what DeadlineRadar looks like once it&rsquo;s populated.</td></tr>';
    return;
  }
  var visible = drOfficeGroupFilter
    ? drLicenses.filter(function(item) { return item.office_tag === drOfficeGroupFilter; })
    : drLicenses;
  if (drRosterSearchQuery) {
    var q = drRosterSearchQuery.toLowerCase();
    visible = visible.filter(function(item) {
      return (item.staff_label || '').toLowerCase().indexOf(q) !== -1 ||
        (item.email || '').toLowerCase().indexOf(q) !== -1;
    });
  }
  if (drDueWithinDays) {
    var maxDays = Number(drDueWithinDays);
    visible = visible.filter(function(item) {
      var days = drDaysUntil(item.next_deadline);
      // An unresolved/unknown deadline never qualifies as "due within N
      // days" -- there's no date to compare, and silently INCLUDING it
      // would misrepresent an unknown as urgent.
      return days !== null && days <= maxDays;
    });
  }
  visible = drApplyRosterSort(visible);
  if (visible.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6">No staff match the current search or filter.</td></tr>';
    return;
  }
  tbody.innerHTML = visible.map(drRenderRow).join('');
}

// Roadmap #38 (2026-08-07): saved custom views. Stored in THIS browser's
// localStorage only -- a personal shortcut for the admin using this
// browser, not firm data another admin or device needs to see, so no new
// backend endpoint. A malformed/cleared localStorage value degrades to "no
// saved views" rather than breaking the roster itself.
var DR_SAVED_VIEWS_KEY = 'dr_saved_roster_views';

function drGetSavedViews() {
  try {
    var raw = window.localStorage.getItem(DR_SAVED_VIEWS_KEY);
    var parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function drSetSavedViews(views) {
  try {
    window.localStorage.setItem(DR_SAVED_VIEWS_KEY, JSON.stringify(views));
  } catch (e) {
    // Private-browsing/storage-full -- the view still applied for this
    // session, it just won't persist. Not worth surfacing as an error for
    // a convenience feature.
  }
}

function drRenderSavedViewsList() {
  var el = document.getElementById('dr-saved-views-list');
  if (!el) return;
  var views = drGetSavedViews();
  if (views.length === 0) {
    el.innerHTML = '<p class="dr-panel-empty">No saved views yet.</p>';
    return;
  }
  el.innerHTML = views.map(function(v, i) {
    var name = drEscapeHtml(v.name);
    return '<div class="dr-saved-view-item"><span>' + name + '</span><span>' +
      '<button type="button" class="dr-link-btn" data-apply-view="' + i + '" aria-label="Apply view \\'' + name + '\\'">Apply</button> ' +
      '<button type="button" class="dr-link-btn" data-delete-view="' + i + '" aria-label="Delete view \\'' + name + '\\'">Delete</button></span></div>';
  }).join('');
}

function drSaveCurrentView(name) {
  var views = drGetSavedViews();
  views.push({
    name: name,
    officeTag: drOfficeGroupFilter,
    dueWithinDays: drDueWithinDays,
    search: drRosterSearchQuery,
    sortColumn: drRosterSortColumn,
    sortDir: drRosterSortDir
  });
  drSetSavedViews(views);
  drRenderSavedViewsList();
}

function drApplySavedView(view) {
  drOfficeGroupFilter = view.officeTag || '';
  drDueWithinDays = view.dueWithinDays || '';
  drRosterSearchQuery = view.search || '';
  drRosterSortColumn = view.sortColumn || null;
  drRosterSortDir = view.sortDir || 'asc';
  var officeSel = document.getElementById('dr-office-group-filter');
  if (officeSel) officeSel.value = drOfficeGroupFilter;
  var dueSel = document.getElementById('dr-due-within-filter');
  if (dueSel) dueSel.value = drDueWithinDays;
  var searchInput = document.getElementById('dr-roster-search');
  if (searchInput) searchInput.value = drRosterSearchQuery;
  drRenderTable();
}

function drDeleteSavedView(index) {
  var views = drGetSavedViews();
  views.splice(index, 1);
  drSetSavedViews(views);
  drRenderSavedViewsList();
}

// Roadmap #16: distinct office_tag values currently on the roster, sorted --
// options rebuild on every render so a newly-applied tag shows up as a
// filter choice immediately, not just after a full page reload.
function drRenderOfficeGroupFilter() {
  var sel = document.getElementById('dr-office-group-filter');
  if (!sel) return;
  var current = sel.value;
  var tags = [];
  drLicenses.forEach(function(item) {
    if (item.office_tag && tags.indexOf(item.office_tag) === -1) tags.push(item.office_tag);
  });
  tags.sort();
  sel.innerHTML = '<option value="">All offices/departments</option>' + tags.map(function(t) {
    return '<option value="' + drEscapeHtml(t) + '">' + drEscapeHtml(t) + '</option>';
  }).join('');
  // Preserve the selection across a re-render UNLESS that tag no longer
  // exists on the roster (e.g. the last staffer wearing it was just
  // re-tagged or removed) -- falls back to "All" rather than silently
  // filtering on a value nothing matches.
  sel.value = tags.indexOf(current) !== -1 ? current : '';
  drOfficeGroupFilter = sel.value;
}

// Roadmap #16: staff options for the bulk-tag multi-select. Excludes sample
// rows for the same reason drRenderRow() gives every sample row's Actions
// cell no functional buttons -- a sample id matches nothing on the server,
// so a PATCH against it would just 404.
function drRenderBulkTagStaffSelect() {
  var sel = document.getElementById('dr-bulk-tag-staff-select');
  if (!sel) return;
  var previouslyChecked = {};
  Array.from(sel.selectedOptions || []).forEach(function(o) { previouslyChecked[o.value] = true; });
  sel.innerHTML = drLicenses.filter(function(item) { return !item.is_sample; }).map(function(item) {
    var label = (item.staff_label || item.email) + (item.office_tag ? ' (' + item.office_tag + ')' : '');
    var selectedAttr = previouslyChecked[item.id] ? ' selected' : '';
    return '<option value="' + drEscapeHtml(item.id) + '"' + selectedAttr + '>' + drEscapeHtml(label) + '</option>';
  }).join('');
}

function drApplyBulkTag() {
  var sel = document.getElementById('dr-bulk-tag-staff-select');
  var valueInput = document.getElementById('dr-bulk-tag-value');
  var statusEl = document.getElementById('dr-bulk-tag-status');
  var ids = sel ? Array.from(sel.selectedOptions).map(function(o) { return o.value; }) : [];
  if (ids.length === 0) {
    if (statusEl) statusEl.textContent = 'Select at least one staff member first.';
    return;
  }
  var tagValue = valueInput ? valueInput.value.trim() : '';
  if (statusEl) statusEl.textContent = 'Applying to ' + ids.length + ' staff member' + (ids.length === 1 ? '' : 's') + '\\u2026';
  // Sequential PATCH per id, reusing the existing single-record endpoint --
  // firms are capped at 35 staff at most (the top paid tier's seat cap;
  // free/pilot firms are capped lower, at SELF_SERVE_SEAT_CAP), so this is
  // always a small, bounded number of requests, not worth a new bulk
  // backend route.
  var applyOne = function(id) {
    return fetch('/api/firm/licenses/' + encodeURIComponent(id), {
      method: 'PATCH', credentials: 'include',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({office_tag: tagValue})
    }).then(function(res) { return res.ok; });
  };
  Promise.all(ids.map(applyOne)).then(function(results) {
    var failed = results.filter(function(ok) { return !ok; }).length;
    if (statusEl) {
      statusEl.textContent = failed > 0
        ? ('Tagged ' + (ids.length - failed) + ' of ' + ids.length + ' -- ' + failed + ' failed, please retry.')
        : ('Tagged ' + ids.length + ' staff member' + (ids.length === 1 ? '' : 's') + '.');
    }
    drLoadLicenses();
  }).catch(function() {
    if (statusEl) statusEl.textContent = 'Something went wrong, please try again.';
  });
}

// ---------------------------------------------------------------------------
// Roadmap #17 (2026-08-07): CSV bulk import of staff roster. Deliberately no
// new backend endpoint or duplicated validation logic -- parses the file
// client-side, then submits each row through the EXACT SAME POST
// /firm/licenses the single Add Staff form already uses (same email/state
// validation, same seat-cap/dedupe checks, same transparency email per row).
// A row missing a field its state actually needs (about a third of states
// need more than email/state -- license_type_id, birth_month, etc.) gets the
// SAME error message a manual single add would get; this importer never
// guesses a value to make a row "succeed."
// ---------------------------------------------------------------------------

// Known column names, matching POST /firm/licenses' own body keys exactly
// (index.ts's `form` object reads these by name regardless of whether they
// came from a real <form> submission or here).
var DR_CSV_KNOWN_COLUMNS = [
  'email', 'staff_label', 'license_type_id', 'birth_month', 'birth_year',
  'cohort_group', 'license_expiration_date', 'renewal_fee', 'office_tag'
];

// Minimal RFC4180-ish CSV parser -- handles quoted fields (embedded commas,
// embedded "" as an escaped quote, embedded newlines inside quotes). Not a
// full spec implementation (e.g. no BOM handling beyond a plain strip), but
// covers what a real spreadsheet export (Excel/Sheets/Numbers) produces.
function drParseCsv(text) {
  var rows = [];
  var row = [];
  var field = '';
  var inQuotes = false;
  var i = 0;
  text = text.replace(/^\\uFEFF/, '');
  while (i < text.length) {
    var ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ',') { row.push(field); field = ''; i++; continue; }
    if (ch === '\\r') { i++; continue; }
    if (ch === '\\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += ch; i++;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter(function(r) { return !(r.length === 1 && r[0].trim() === ''); });
}

// Roadmap #17: lets a CSV say "California" instead of requiring the exact
// internal slug -- built from the live Add Staff state <select>'s own
// options, so it can never drift from the real supported-state list.
function drStateNameToSlugMap() {
  var map = {};
  var stateSelect = document.getElementById('dr-add-state');
  if (!stateSelect) return map;
  Array.from(stateSelect.options).forEach(function(o) {
    if (!o.value) return;
    map[o.value.toLowerCase()] = o.value;
    map[o.textContent.trim().toLowerCase()] = o.value;
  });
  return map;
}

var drCsvRows = [];

function drPreviewCsvImport() {
  var fileInput = document.getElementById('dr-csv-import-file');
  var statusEl = document.getElementById('dr-csv-import-status');
  var file = fileInput && fileInput.files && fileInput.files[0];
  if (!file) {
    if (statusEl) statusEl.textContent = 'Choose a CSV file first.';
    return;
  }
  var reader = new FileReader();
  reader.onload = function() {
    var parsed = drParseCsv(String(reader.result));
    if (parsed.length < 2) {
      if (statusEl) statusEl.textContent = 'That file has no data rows (just a header, or empty).';
      drCsvRows = [];
      drRenderCsvPreview();
      return;
    }
    var headers = parsed[0].map(function(h) { return h.trim().toLowerCase(); });
    var stateMap = drStateNameToSlugMap();
    // Roadmap #17: capped -- a CSV this large is almost certainly a mistake
    // (25-staff seat cap on the self-serve plan), and an unbounded preview
    // table would be its own UX problem.
    var dataRows = parsed.slice(1, 201);
    drCsvRows = dataRows.map(function(cells) {
      var fields = {};
      headers.forEach(function(h, idx) {
        var value = (cells[idx] || '').trim();
        if (!value) return;
        if (h === 'state' || h === 'state_slug') { fields.__state_raw = value; return; }
        if (DR_CSV_KNOWN_COLUMNS.indexOf(h) !== -1) fields[h] = value;
      });
      var reason = null;
      if (!fields.email || !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(fields.email)) {
        reason = 'missing or invalid email';
      } else if (!fields.__state_raw) {
        reason = 'missing state';
      } else {
        var slug = stateMap[fields.__state_raw.toLowerCase()];
        if (!slug) {
          reason = 'unrecognized state "' + fields.__state_raw + '"';
        } else {
          fields.state_slug = slug;
        }
      }
      delete fields.__state_raw;
      return {fields: fields, valid: !reason, reason: reason, result: null};
    });
    drRenderCsvPreview();
  };
  reader.onerror = function() {
    if (statusEl) statusEl.textContent = 'Could not read that file.';
  };
  reader.readAsText(file);
}

function drRenderCsvPreview() {
  var el = document.getElementById('dr-csv-preview-body');
  var importBtn = document.getElementById('dr-csv-import-btn');
  var statusEl = document.getElementById('dr-csv-import-status');
  if (!el) return;
  if (drCsvRows.length === 0) {
    el.innerHTML = '';
    if (importBtn) importBtn.hidden = true;
    return;
  }
  var validCount = drCsvRows.filter(function(r) { return r.valid; }).length;
  var rowsHtml = drCsvRows.map(function(r) {
    var statusText = r.result === 'added' ? 'Added'
      : r.result === 'failed' ? ('Failed: ' + r.resultReason)
      : r.valid ? 'Ready'
      : ('Skipped: ' + r.reason);
    var statusClass = r.result === 'added' ? 'dr-csv-row-added'
      : (r.result === 'failed' || !r.valid) ? 'dr-csv-row-error' : 'dr-csv-row-ready';
    return '<tr><td>' + drEscapeHtml(r.fields.staff_label || '') + '</td><td>' +
      drEscapeHtml(r.fields.email || '') + '</td><td>' + drEscapeHtml(r.fields.state_slug || '') + '</td>' +
      '<td class="' + statusClass + '">' + drEscapeHtml(statusText) + '</td></tr>';
  }).join('');
  el.innerHTML = '<table class="dr-csv-preview-table"><thead><tr><th scope="col">Name</th>' +
    '<th scope="col">Email</th><th scope="col">State</th><th scope="col">Status</th></tr></thead>' +
    '<tbody>' + rowsHtml + '</tbody></table>';
  if (importBtn) importBtn.hidden = validCount === 0;
  // Roadmap #17 bug fix (caught live-testing this same ship): drImportCsvRows()
  // also calls this function on every row (to refresh the per-row Added/
  // Failed cells) and again at the end (for the final summary) -- if this
  // function unconditionally overwrote the status line every time, the
  // "Importing... 2 of 3" progress and the final "Imported N; M failed"
  // summary would each get immediately clobbered back to this "ready to
  // import" count the instant they were set. Only own the status line
  // BEFORE any row has actually been attempted; once import starts,
  // drImportCsvRows() is the sole writer of statusEl.
  var importStarted = drCsvRows.some(function(r) { return r.result !== null; });
  if (statusEl && !importStarted) {
    statusEl.textContent = validCount + ' of ' + drCsvRows.length + ' row' +
      (drCsvRows.length === 1 ? '' : 's') + ' ready to import.';
  }
}

function drImportCsvRows() {
  var statusEl = document.getElementById('dr-csv-import-status');
  var importBtn = document.getElementById('dr-csv-import-btn');
  var toImport = drCsvRows.filter(function(r) { return r.valid && r.result === null; });
  if (toImport.length === 0) return;
  if (importBtn) importBtn.disabled = true;
  var done = 0;
  var addOne = function(row) {
    return fetch('/api/firm/licenses', {
      method: 'POST', credentials: 'include',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(row.fields)
    }).then(function(res) {
      return drReadJsonSafe(res).then(function(data) {
        row.result = res.ok ? 'added' : 'failed';
        row.resultReason = res.ok ? null : ((data && data.error) || ('HTTP ' + res.status));
        done++;
        if (statusEl) statusEl.textContent = 'Importing\\u2026 ' + done + ' of ' + toImport.length;
        drRenderCsvPreview();
      });
    }).catch(function() {
      row.result = 'failed';
      row.resultReason = 'network error';
      done++;
      drRenderCsvPreview();
    });
  };
  // Sequential, not Promise.all -- each row is a real write (+ a real email
  // send), same "don't hammer the endpoint" posture as a human clicking Add
  // staff N times in a row, not a parallel burst.
  var chain = Promise.resolve();
  toImport.forEach(function(row) {
    chain = chain.then(function() { return addOne(row); });
  });
  chain.then(function() {
    var added = drCsvRows.filter(function(r) { return r.result === 'added'; }).length;
    var failed = drCsvRows.filter(function(r) { return r.result === 'failed'; }).length;
    if (statusEl) {
      statusEl.textContent = 'Imported ' + added + ' staff member' + (added === 1 ? '' : 's') +
        (failed > 0 ? ('; ' + failed + ' failed (see table).') : '.');
    }
    if (importBtn) importBtn.disabled = false;
    drRenderCsvPreview();
    drLoadLicenses();
  });
}

// ---------------------------------------------------------------------------
// Dashboard overview panels (2026-07-30, BUILD v2 Phase B redesign): coverage
// gauge, status donut, staff-at-risk list, recent-activity feed. All computed
// client-side from the SAME drLicenses array the roster table already uses --
// no new endpoint, no new data beyond the created_at/confirmed_at/stopped_at/
// stop_reason/last_edited_at/renewed_at/firm_name fields the API returns
// (index.ts's toFirmLicenseJson()/handleFirmLicensesList()). 'edited' and
// 'renewed' events (added 2026-08-04, migration 0017) read last_edited_at/
// renewed_at -- real server timestamps, not fabricated from a client-side
// guess -- so an admin action is never silently indistinguishable from the
// original "added to the roster" event in the audit trail.
// ---------------------------------------------------------------------------

// Whole-day difference between an ISO date (YYYY-MM-DD, UTC-anchored, same
// convention drFormatDeadline() already uses) and today, in UTC calendar
// days -- not a raw ms/86400000 divide, which would drift by a day near a
// DST boundary if this ever ran against local time instead of UTC.
function drDaysUntil(iso) {
  if (!iso) return null;
  var target = new Date(iso + 'T00:00:00Z').getTime();
  if (isNaN(target)) return null;
  // AuditLab TZ-1 (MEDIUM, 2026-08-04): the deadline itself stays a UTC
  // calendar date (right -- drFormatDeadline() renders it with
  // timeZone: 'UTC' on purpose, so the same statutory date reads identically
  // for every viewer). But "today" was ALSO anchored to UTC, and this is a
  // US-only product -- every customer is west of UTC, so UTC rolls to
  // tomorrow hours before their own working day ends. On the deadline day
  // itself this told an Eastern CPA "OVERDUE" at 8pm with 4 real hours left,
  // and a Hawaii CPA from 4pm. Anchoring "today" to the viewer's own local
  // calendar (matches _MY_DASHBOARD_JS_HTML's drDaysUntil(), which already
  // did this correctly) fixes it while keeping the deadline side UTC-pinned
  // and the whole comparison DST-safe (both sides are UTC-midnight keys).
  var now = new Date();
  var todayLocal = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target - todayLocal) / 86400000);
}

function drDaysAgo(isoTimestamp) {
  if (!isoTimestamp) return null;
  var then = new Date(isoTimestamp);
  if (isNaN(then.getTime())) return null;
  // AuditLab TZ-2 (LOW, 2026-08-04): this measured elapsed milliseconds
  // (a rolling 24h window), not calendar days, so "today"/"1 day ago" were
  // elapsed-time claims wearing calendar-day labels -- evening activity
  // (a CPA logging CPE after work) read as "today" for nearly the whole of
  // the FOLLOWING day too. Same fix as TZ-1's drDaysUntil(): anchor both
  // sides to the viewer's own local calendar midnight before differencing,
  // so the label is an actual calendar-day comparison.
  var now = new Date();
  var thenLocal = Date.UTC(then.getFullYear(), then.getMonth(), then.getDate());
  var nowLocal = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  var days = Math.round((nowLocal - thenLocal) / 86400000);
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

// Dashboard-polish item #2 (2026-08-05, Devin): a SECOND, orthogonal
// breakdown from the same drDonutSvg() renderer -- by deadline PROXIMITY
// (is this person's next renewal comfortably out, due soon, or overdue),
// not by the subscriber status enum DR_DONUT_ORDER already covers. Reuses
// this site's own existing green/gold/red status language (the exact same
// hex values as DR_DONUT_COLORS.active/pending/needs-attention above) --
// deliberately not a new palette, just a new grouping of the same colors.
// "Due soon" uses the identical 30-day-or-unresolved test the "Due soon"
// stat tile and the Staff-at-risk panel already use, so the three can never
// silently disagree about who counts.
var DR_PROXIMITY_ORDER = ['active', 'due_soon', 'overdue'];
var DR_PROXIMITY_COLORS = {active: '#1f9e5c', due_soon: '#9c7a12', overdue: '#c33737'};
var DR_PROXIMITY_LABELS = {active: 'Active', due_soon: 'Due soon', overdue: 'Overdue'};

// Plain CSS conic-gradient, not an SVG pie -- no path-arc trigonometry needed
// for a simple ring, and it's one element instead of N <path>s. order/colors/
// labels default to the subscriber-status breakdown (the Roster status
// tile's own original call shape) so that call site didn't need to change
// when this grew a second use (the Coverage tile's proximity breakdown).
function drDonutSvg(counts, total, order, colors, labels) {
  order = order || DR_DONUT_ORDER;
  colors = colors || DR_DONUT_COLORS;
  labels = labels || DR_DONUT_LABELS;
  if (!total) return '<div class="dr-donut-wrap"><div class="dr-panel-empty">No staff yet</div></div>';
  var acc = 0;
  var segments = [];
  order.forEach(function(key) {
    var n = counts[key] || 0;
    if (!n) return;
    var start = (acc / total) * 360;
    acc += n;
    var end = (acc / total) * 360;
    segments.push(colors[key] + ' ' + start.toFixed(1) + 'deg ' + end.toFixed(1) + 'deg');
  });
  var legend = order.filter(function(k) { return counts[k]; }).map(function(k) {
    return '<li><span class="swatch" style="background:' + colors[k] + '"></span>' +
      drEscapeHtml(labels[k]) + ' (' + counts[k] + ')</li>';
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
  // Roadmap #151 Phase 4: UI convenience gate, not a real access boundary --
  // every field this function reads is already sent to every tier in the
  // /firm/licenses response (required so the plain roster list stays free).
  if (!drDashboardSynthesisIncluded) {
    row.innerHTML = '<div class="dr-stat-upsell">Coverage %, roster-status breakdown, and the ' +
      '"due soon" count are part of a paid firm plan. <a href="/pricing/">See plans</a></div>';
    return;
  }
  var total = drLicenses.length;
  var counts = {active: 0, pending: 0, 'needs-attention': 0, opted_out: 0};
  var proximity = {active: 0, due_soon: 0, overdue: 0};
  var atRisk = 0;
  drLicenses.forEach(function(item) {
    var s = item.status || 'needs-attention';
    counts[s] = (counts[s] || 0) + 1;
    // AuditLab VIS-1 (MEDIUM, 2026-08-04, per product decision): opted-out staff
    // used to be excluded here entirely, so a firm's ONLY warning channel
    // for someone who unsubscribed (no reminder email will ever fire for
    // them) was this tile going silent about them too. Now counted under
    // the SAME within-30-days-or-unresolved test as everyone else -- not
    // unconditionally, so this tile doesn't permanently inflate for an
    // opted-out person whose deadline is a year out and genuinely isn't
    // time-sensitive yet.
    var days = drDaysUntil(item.next_deadline);
    if (days === null || days <= 30) atRisk++;
    // Same three-way split the "Due soon" tile's own definition and the
    // Staff-at-risk list already use -- "overdue" is `days < 0` (matches
    // drRenderAtRisk()'s "Overdue" label), "due soon" is the identical
    // within-30-days-or-unresolved test as atRisk above, everyone else is
    // comfortably on track.
    if (days !== null && days < 0) proximity.overdue++;
    else if (days === null || days <= 30) proximity.due_soon++;
    else proximity.active++;
  });
  var proximityPct = total ? Math.round((proximity.active / total) * 100) : 0;
  var riskPct = total ? Math.round((atRisk / total) * 100) : 0;
  // Dashboard-polish item #1 (2026-08-05, Devin): the 25-staff cap was
  // invisible until a firm actually hit it and got rejected -- showing
  // usage against the limit up front (once the API has actually told us
  // what it is; drSeatCap starts null) is a normal SaaS dashboard
  // convention this was missing entirely.
  var seatSub = drSeatCap !== null ? total + ' / ' + drSeatCap + ' staff tracked' : total + ' staff tracked';

  row.innerHTML =
    '<div class="dr-stat-card">' + drDonutSvg(proximity, total, DR_PROXIMITY_ORDER, DR_PROXIMITY_COLORS, DR_PROXIMITY_LABELS) +
      '<div><div class="dr-stat-label">Coverage</div><div class="dr-stat-value">' + proximityPct + '%</div>' +
      '<div class="dr-stat-sub">on track</div></div></div>' +
    '<div class="dr-stat-card">' + drDonutSvg(counts, total) +
      '<div><div class="dr-stat-label">Roster status</div><div class="dr-stat-value">' + total + '</div>' +
      '<div class="dr-stat-sub">' + seatSub + '</div></div></div>' +
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

// Roadmap #7 (2026-08-07): renewal-cost rollup, computed client-side from
// the SAME drLicenses array every other roster stat already reads -- no
// separate aggregate endpoint. Self-reported per license (migration 0034),
// so this is always honest about how much of the roster is actually
// covered by an entered fee rather than silently implying completeness.
function drRenderRenewalFeeRollup() {
  var el = document.getElementById('dr-renewal-fee-body');
  if (!el) return;
  var active = drLicenses.filter(function(item) { return item.status !== 'opted_out'; });
  if (active.length === 0) {
    el.innerHTML = '<p class="dr-panel-empty">Add staff to start tracking renewal costs.</p>';
    return;
  }
  var totalCents = 0, withFee = 0;
  active.forEach(function(item) {
    if (typeof item.renewal_fee_cents === 'number') {
      totalCents += item.renewal_fee_cents;
      withFee++;
    }
  });
  var totalDollars = (totalCents / 100).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
  var missing = active.length - withFee;
  var missingNote = missing > 0
    ? ' <span class="dr-panel-empty">(' + missing + ' of ' + active.length + ' staff have no fee entered yet -- edit a roster row to add one.)</span>'
    : '';
  el.innerHTML = '<p><strong>$' + drEscapeHtml(totalDollars) + '</strong> total across ' + withFee + ' of ' + active.length + ' staff.' + missingNote + '</p>';
}

function drRenderAtRisk() {
  var el = document.getElementById('dr-at-risk-list');
  if (!el) return;
  // Roadmap #151 Phase 4: same gate as drRenderStats() -- see its own
  // comment. <li>, not <div>, since this container is a <ul>.
  if (!drDashboardSynthesisIncluded) {
    el.innerHTML = '<li class="dr-panel-empty">The at-risk ranking is part of a paid firm plan. ' +
      '<a href="/pricing/">See plans</a></li>';
    return;
  }
  // AuditLab VIS-1 (MEDIUM, 2026-08-04, per product decision): opted-out staff
  // used to be filtered out of this list entirely -- the one person the
  // firm's automated reminders will NEVER reach was also the one person
  // this panel never warned about. Now included under the same day-window
  // test as everyone else; the "no reminder will be sent" chip below is
  // what makes their row different, not exclusion.
  var allAtRisk = drLicenses.filter(function(item) {
    var days = drDaysUntil(item.next_deadline);
    return days === null || days <= 30;
  });
  var items = allAtRisk.slice(0, 6);
  if (items.length === 0) {
    el.innerHTML = '<li class="dr-panel-empty">Nobody at risk right now.</li>';
    return;
  }
  var html = items.map(function(item) {
    var days = drDaysUntil(item.next_deadline);
    var daysLabel = days === null ? 'Unresolved' : days < 0 ? 'Overdue' : days === 0 ? 'Due today' : 'in ' + days + 'd';
    var soon = days !== null && days <= 7;
    var optedOut = item.status === 'opted_out';
    return '<li class="dr-at-risk-item"><span><span class="dr-at-risk-name">' +
      drEscapeHtml(item.staff_label || item.email) + '</span>' +
      '<span class="dr-at-risk-sub">' + drEscapeHtml(item.state_name || '') + '</span>' +
      (optedOut ? '<span class="dr-at-risk-optedout">Opted out &mdash; no reminder will be sent</span>' : '') +
      '</span>' +
      '<span class="dr-at-risk-days' + (soon ? ' dr-at-risk-days--soon' : '') + '">' + daysLabel + '</span></li>';
  }).join('');
  // AuditLab VIS-2 (LOW, 2026-08-04): this list has always silently
  // truncated at 6 -- mitigated by the adjacent "Due soon" tile showing the
  // true count from the identical filter, but a firm with more than 6
  // people actually at risk saw no indication there were more. The tile
  // count is already computed the same way in drRenderStats(), so this
  // reuses that same 30-day-or-unresolved definition rather than
  // introducing a second one that could drift from it.
  if (allAtRisk.length > items.length) {
    html += '<li class="dr-panel-empty">+' + (allAtRisk.length - items.length) + ' more &mdash; see Roster for the full list.</li>';
  }
  el.innerHTML = html;
}

var DR_ACTIVITY_LABELS = {
  added: 'added to the roster', opted_out: 'opted out of reminders',
  edited: 'record updated', renewed: 'marked renewed', removed: 'removed from the roster'
};
var DR_ACTIVITY_DOT_CLASS = {
  added: '', opted_out: 'dr-activity-dot--optout',
  edited: '', renewed: 'dr-activity-dot--confirm', removed: 'dr-activity-dot--optout'
};
// Dashboard-polish item #4 (2026-08-05, Devin): per-type icon on each
// Recent Activity line -- same minimal-line-SVG house style as
// _VERIFIED_ICON_SVG (16x16 viewBox, stroke="currentColor", ~1.4-1.6
// stroke-width), not a borrowed icon set.
var DR_ACTIVITY_ICON = {
  added: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  opted_out: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 8h8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  edited: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10.3 3.3l2.4 2.4-6.6 6.6-3 .6.6-3z" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  renewed: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M12.3 8a4.3 4.3 0 1 1-1.4-3.2M12.3 2.3v3.2h-3.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  removed: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 8h8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>'
};

// Task #26 (2026-08-06, Devin's decision: durable log, not a live-roster
// reflection). Fetched separately from drLoadLicenses()'s own GET
// /firm/licenses -- same "own fetch, own render, doesn't block the primary
// roster load" pattern drLoadCpeEntries() already uses right next to this
// call. Was previously DERIVED from drLicenses (the live roster array),
// which structurally could never show a removal: listFirmLicenses()
// deliberately excludes admin-removed rows from what it returns, so a
// removed staffer's edit AND removal both silently vanished from the feed
// the moment they were removed. GET /firm/activity reads from its own
// durable table instead, unaffected by later roster changes.
function drLoadActivity() {
  return fetch('/api/firm/activity', {credentials: 'include'})
    .then(function(res) {
      if (!res.ok) return null;
      return res.json();
    })
    .then(function(data) {
      drRenderActivity((data && data.events) || []);
    })
    .catch(function() {});
}

function drRenderActivity(events) {
  var el = document.getElementById('dr-activity-list');
  if (!el) return;
  events = events.slice(0, 6);
  if (events.length === 0) {
    el.innerHTML = '<li class="dr-panel-empty">No activity yet.</li>';
    return;
  }
  el.innerHTML = events.map(function(ev) {
    var name = ev.staff_label || ev.email;
    return '<li class="dr-activity-item"><span class="dr-activity-dot ' + (DR_ACTIVITY_DOT_CLASS[ev.event_type] || '') + '">' + (DR_ACTIVITY_ICON[ev.event_type] || '') + '</span>' +
      '<span class="dr-activity-text"><b>' + drEscapeHtml(name) + '</b> ' + (DR_ACTIVITY_LABELS[ev.event_type] || ev.event_type) +
      '<span class="dr-activity-when">' + drDaysAgo(ev.created_at) + '</span></span></li>';
  }).join('');
}

function drRenderFirmName(name) {
  var el = document.getElementById('dr-firm-name');
  if (el && name) el.textContent = name;
}

// Task #29 (2026-08-05): shows what the email-change form is changing FROM.
function drRenderCurrentEmail(email) {
  var el = document.getElementById('dr-current-email');
  if (el && email) el.textContent = email;
}

// Roadmap #28 (2026-08-06): guided onboarding checklist. drOnboardingChecklistPending
// is set once from the /firm/licenses response, same pattern as the
// questionnaire's own pending flag -- server-side dismissal (durable,
// cross-device); the four step checkmarks themselves are computed live
// from data already in memory (drLicenses/drCpeEntries) or a per-browser
// localStorage flag (drMarkOnboardingVisit above), never a fifth round trip.
var drOnboardingChecklistPending = false;
function drRenderOnboardingChecklist() {
  var panel = document.getElementById('dr-onboarding-checklist');
  if (!panel) return;
  if (!drOnboardingChecklistPending) { panel.hidden = true; return; }
  panel.hidden = false;
  var visitedCalendar = false, visitedMap = false;
  try { visitedCalendar = localStorage.getItem(DR_ONBOARDING_VISIT_KEYS.calendar) === '1'; } catch (e) {}
  try { visitedMap = localStorage.getItem(DR_ONBOARDING_VISIT_KEYS.map) === '1'; } catch (e) {}
  var steps = [
    {id: 'dr-onboarding-step-staff', done: drLicenses.length > 0},
    {id: 'dr-onboarding-step-calendar', done: visitedCalendar},
    {id: 'dr-onboarding-step-map', done: visitedMap},
    {id: 'dr-onboarding-step-cpe', done: drCpeEntries.length > 0}
  ];
  steps.forEach(function(step) {
    var el = document.getElementById(step.id);
    if (el) el.classList.toggle('dr-onboarding-step--done', step.done);
  });
}

function drDismissOnboardingChecklist() {
  drOnboardingChecklistPending = false;
  drRenderOnboardingChecklist();
  fetch('/api/firm/onboarding-checklist/dismiss', {method: 'POST', credentials: 'include'}).catch(function() {});
}

// ---------------------------------------------------------------------------
// Roadmap #30 (2026-08-07): in-app product tour. A 4-step sequence anchored
// to the sidebar's own real nav items (data-view attrs it already has), one
// tooltip at a time -- deliberately not a full-screen spotlight overlay
// (a bigger UI investment this roadmap item doesn't call for) and
// deliberately distinct content from the onboarding checklist just above:
// the checklist says WHAT TO DO, this explains WHAT EACH SCREEN IS. Each
// step actually switches the dashboard to that view (drSwitchView, already
// defined) so the tour walks through real screens, not just nav labels.
// ---------------------------------------------------------------------------
var DR_PRODUCT_TOUR_STEPS = [
  {view: 'roster', title: 'Roster', body: 'Your full staff list and renewal status, all in one place -- this is home base.'},
  {view: 'calendar', title: 'Calendar', body: 'Every upcoming renewal deadline laid out by date, so nothing sneaks up on you.'},
  {view: 'map', title: 'Map', body: 'See at a glance which states your firm is covered in, and where the gaps are.'},
  {view: 'cpe', title: 'CPE Hours', body: 'Track continuing-education progress against the real requirement for each state.'}
];
var drProductTourStepIndex = 0;
var drProductTourActive = false;

function drPositionProductTour() {
  var el = document.getElementById('dr-product-tour');
  if (!el || el.hidden) return;
  var step = DR_PRODUCT_TOUR_STEPS[drProductTourStepIndex];
  var navEl = document.querySelector('.dr-nav a[data-view="' + step.view + '"]');
  if (!navEl) return;
  // position: fixed (see CSS) -- tracks the viewport, not document flow, so
  // this only needs the nav item's current on-screen rect, recomputed on
  // every step change and on resize (wired below).
  var rect = navEl.getBoundingClientRect();
  el.style.top = Math.max(12, rect.top + rect.height / 2 - el.offsetHeight / 2) + 'px';
  el.style.left = (rect.right + 14) + 'px';
}

function drRenderProductTourStep() {
  var step = DR_PRODUCT_TOUR_STEPS[drProductTourStepIndex];
  var stepEl = document.getElementById('dr-product-tour-step');
  var bodyEl = document.getElementById('dr-product-tour-body');
  var nextBtn = document.getElementById('dr-product-tour-next-btn');
  if (!stepEl || !bodyEl || !nextBtn) return;
  stepEl.textContent = (drProductTourStepIndex + 1) + ' of ' + DR_PRODUCT_TOUR_STEPS.length;
  bodyEl.innerHTML = '<b>' + drEscapeHtml(step.title) + '</b> &mdash; ' + drEscapeHtml(step.body);
  nextBtn.textContent = (drProductTourStepIndex === DR_PRODUCT_TOUR_STEPS.length - 1) ? 'Done' : 'Next';
  drSwitchView(step.view);
  drPositionProductTour();
}

function drStartProductTour() {
  drProductTourActive = true;
  drProductTourStepIndex = 0;
  var el = document.getElementById('dr-product-tour');
  if (el) el.hidden = false;
  drRenderProductTourStep();
}

function drAdvanceProductTour() {
  if (drProductTourStepIndex < DR_PRODUCT_TOUR_STEPS.length - 1) {
    drProductTourStepIndex++;
    drRenderProductTourStep();
    return;
  }
  drEndProductTour();
}

// Called by BOTH "Skip tour" and "Done" on the last step -- same single
// dismiss action either way, matching dismissProductTour()'s own server-side
// idempotent-once shape.
function drEndProductTour() {
  drProductTourActive = false;
  var el = document.getElementById('dr-product-tour');
  if (el) el.hidden = true;
  fetch('/api/firm/product-tour/dismiss', {method: 'POST', credentials: 'include'}).catch(function() {});
}

// Demo-account Account-tab lockdown (2026-08-06, reported live against the
// newly public demo). The backend already refuses email/password/billing/
// delete-account changes for a demo_locked firm (403, see those handlers'
// own comments) -- this greys the controls out up front instead of letting
// a visitor fill out a form and only find out it's refused on submit.
// Disables by disabling every real input/button rather than hiding the
// panels outright, so a demo visitor can still see exactly what the Account
// tab looks like, just can't submit anything from it.
function drRenderAccountLockdown() {
  var locked = !!(drBilling && drBilling.demoLocked);
  var banner = document.getElementById('dr-account-demo-lockdown-banner');
  if (banner) banner.hidden = !locked;
  ['dr-change-email-form', 'dr-password-form'].forEach(function(formId) {
    var form = document.getElementById(formId);
    if (!form) return;
    form.querySelectorAll('input, button, select, textarea').forEach(function(el) { el.disabled = locked; });
  });
  var signoutBtn = document.getElementById('dr-signout-other-btn');
  if (signoutBtn) signoutBtn.disabled = locked;
  var deleteBtn = document.getElementById('dr-delete-account-open-btn');
  if (deleteBtn) deleteBtn.disabled = locked;
}

// Self-serve cancellation (2026-08-05, Devin's decision: build self-serve
// cancel now; no refunds, access continues to the current period's end).
// drBilling.cancelAtPeriodEnd is a SCHEDULING flag, not an access change --
// the plan_tier this panel shows doesn't move until Stripe's own
// customer.subscription.deleted webhook fires at the real period end, so a
// firm mid-cancellation still sees its real, unchanged plan name here (not
// "free") right up until that date. current_period_end is a full ISO
// datetime from Stripe; drFormatDeadline() expects a plain date, hence the
// slice(0, 10).
// Roadmap #66: null until the load response sets it (never re-derived
// client-side -- it's a server fact, when the previous session logged in).
var drPreviousLoginAt = null;

function drRenderLastLoginBanner() {
  var el = document.getElementById('dr-last-login-banner');
  if (!el) return;
  if (!drPreviousLoginAt) { el.hidden = true; return; }
  var changed = drLicenses.filter(function(item) {
    return item.last_edited_at && item.last_edited_at > drPreviousLoginAt;
  }).length;
  if (changed === 0) { el.hidden = true; return; }
  var textEl = document.getElementById('dr-last-login-banner-text');
  if (textEl) {
    var when = drFormatDeadline(String(drPreviousLoginAt).slice(0, 10));
    textEl.textContent = changed + ' roster change' + (changed === 1 ? '' : 's') +
      ' since you were last here (' + when + ') -- see Recent activity below for what changed.';
  }
  el.hidden = false;
}

// Roadmap #144: null until the load response sets it. Shown after a "Mark
// renewed" success (drRenewLicense() reloads via drLoadLicenses(), which
// re-checks this) or on ordinary page load once the quarterly cooldown has
// elapsed -- both paths funnel through the same drLoadLicenses() response,
// so one trigger point (called there) covers both cases without a separate
// post-renewal-specific hook.
var drNpsPromptDue = false;

function drMaybeShowNpsPrompt() {
  var modal = document.getElementById('dr-nps-modal');
  if (!modal || !modal.hidden || !drNpsPromptDue) return;
  modal.hidden = false;
}

function drCloseNpsModal() {
  var modal = document.getElementById('dr-nps-modal');
  if (modal) modal.hidden = true;
}

function drSubmitNpsScore(score, btn) {
  var errEl = document.getElementById('dr-nps-error');
  if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
  document.querySelectorAll('.dr-nps-score-btn').forEach(function(b) { b.disabled = true; });
  fetch('/api/firm/nps', {
    method: 'POST', credentials: 'include',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({score: score})
  }).then(function(res) {
    if (res.status === 401) { window.location.href = '/firm-login/'; return; }
    // Whole-quarter cooldown either way -- don't leave the prompt eligible
    // to reappear on the next roster action within this same visit even if
    // the write itself somehow failed server-side.
    drNpsPromptDue = false;
    if (!res.ok) {
      document.querySelectorAll('.dr-nps-score-btn').forEach(function(b) { b.disabled = false; });
      if (errEl) { errEl.textContent = 'Something went wrong, please try again.'; errEl.hidden = false; }
      return;
    }
    drCloseNpsModal();
    // Roadmap #312: promoter-tier score (the standard NPS 9-10 "promoter"
    // threshold) chains straight into the testimonial-capture modal --
    // asking right after someone signals they'd recommend the product is
    // exactly the moment review-capture best practice targets, and this
    // way it never needs its own separate nag cadence.
    if (score >= 9) drOpenTestimonialModal();
  }).catch(function() {
    drNpsPromptDue = false;
    drCloseNpsModal();
  });
}

function drOpenTestimonialModal() {
  var modal = document.getElementById('dr-testimonial-modal');
  if (modal) modal.hidden = false;
}

function drCloseTestimonialModal() {
  var modal = document.getElementById('dr-testimonial-modal');
  if (modal) modal.hidden = true;
}

function drSubmitTestimonial(ev) {
  if (ev) ev.preventDefault();
  var textEl = document.getElementById('dr-testimonial-text');
  var publishEl = document.getElementById('dr-testimonial-can-publish');
  var okEl = document.getElementById('dr-testimonial-ok');
  var errEl = document.getElementById('dr-testimonial-error');
  if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
  if (okEl) okEl.hidden = true;
  var quote = textEl ? textEl.value.trim() : '';
  if (!quote) { if (errEl) { errEl.textContent = 'Please enter a quote before submitting.'; errEl.hidden = false; } return; }
  fetch('/api/firm/testimonial', {
    method: 'POST', credentials: 'include',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({quote_text: quote, can_publish: publishEl ? publishEl.checked : false})
  }).then(function(res) {
    if (res.status === 401) { window.location.href = '/firm-login/'; return; }
    if (!res.ok) {
      if (errEl) { errEl.textContent = 'Something went wrong, please try again.'; errEl.hidden = false; }
      return;
    }
    if (okEl) okEl.hidden = false;
    window.setTimeout(drCloseTestimonialModal, 1500);
  }).catch(function() {
    if (errEl) { errEl.textContent = 'Something went wrong, please try again.'; errEl.hidden = false; }
  });
}

// Escape/backdrop-click on this modal also count as "not now" -- see the
// wiring below -- so an accidental close can't leave the prompt eligible to
// pop up again on the very next roster action within the same visit.
function drDismissNpsPrompt() {
  drNpsPromptDue = false;
  drCloseNpsModal();
  fetch('/api/firm/nps/dismiss', {method: 'POST', credentials: 'include'}).catch(function() {});
}

// Roadmap #42: shown only while the firm has no paid tier -- same
// DR_PLAN_TIER_LABELS[planTier] truthiness check drRenderBillingPanel()
// itself uses just below to decide "is this firm on the free tier".
function drRenderMapValueCallout() {
  var el = document.getElementById('dr-map-value-callout');
  if (!el || !drBilling) return;
  el.hidden = !!DR_PLAN_TIER_LABELS[drBilling.planTier];
}

function drRenderBillingPanel() {
  var body = document.getElementById('dr-billing-body');
  if (!body || !drBilling) return;
  var tierDef = DR_PLAN_TIER_LABELS[drBilling.planTier];
  if (!tierDef) {
    // Task #12 (2026-08-05): a real, always-visible upgrade trigger on the
    // Account tab, rather than making a free-tier firm discover paid plans
    // only by clicking into the Map and hitting the 403 denial there (the
    // individual Practice Privilege Check itself no longer 403s at all,
    // 2026-08-10 -- see handleMobilityCheck()'s own docstring). POST
    // /firm/billing/checkout (drStartCheckout) has
    // always accepted a free-tier firm. Same tier-fit filtering the old
    // whole-dashboard paywall panel used (courtesy only -- checkout
    // re-checks the real roster count server-side either way).
    var seatCount = drLicenses.length;
    var tiersHtml = '<div class="dr-paywall-tiers" id="dr-billing-upgrade-tiers">' +
      '<button type="button" class="dr-paywall-tier-btn" data-tier="firm_starter" data-seat-cap="5" ' + (seatCount > 5 ? 'hidden' : '') + '>Essentials<br><span>$199/year &middot; up to 5 staff</span></button>' +
      '<button type="button" class="dr-paywall-tier-btn" data-tier="firm_growth" data-seat-cap="10" ' + (seatCount > 10 ? 'hidden' : '') + '>Growth<br><span>$299/year &middot; up to 10 staff</span></button>' +
      '<button type="button" class="dr-paywall-tier-btn" data-tier="firm_standard" data-seat-cap="20" ' + (seatCount > 20 ? 'hidden' : '') + '>Professional<br><span>$399/year &middot; up to 20 staff</span></button>' +
      '<button type="button" class="dr-paywall-tier-btn" data-tier="firm_scale" data-seat-cap="35" ' + (seatCount > 35 ? 'hidden' : '') + '>Enterprise<br><span>$549/year &middot; up to 35 staff</span></button>' +
      '</div>';
    // AuditLab PAYNOW-1 (2026-08-05, caught pre-deploy): a roster over the
    // top tier's cap hides all buttons -- without this, that firm sees the
    // intro line then an empty box, no explanation. Ceiling moved to 35
    // with the 2026-08-09 seat-cliff re-tier (was 25).
    var moreThanTopTierHtml = '<p style="font-size:0.85rem; color:var(--muted); margin-top:0.7rem;">' +
      'More than 35 staff? <a href="/for-firms/">Contact us</a>.</p>';
    body.innerHTML = '<p class="dr-panel-empty">You are on the free tier. Upgrade any time for the ' +
      'map and firm-level registration check.</p>' + tiersHtml + moreThanTopTierHtml;
    if (drBilling.demoLocked) body.querySelectorAll('button').forEach(function(b) { b.disabled = true; });
    return;
  }
  if (drBilling.cancelAtPeriodEnd && drBilling.currentPeriodEnd) {
    var endDate = drFormatDeadline(drBilling.currentPeriodEnd.slice(0, 10));
    body.innerHTML = '<p><strong>' + drEscapeHtml(tierDef) + ' plan</strong> &mdash; ' +
      'ending ' + drEscapeHtml(endDate) + '. You will keep full access until then; no refund for ' +
      'the current period.</p>' +
      '<button type="button" id="dr-billing-resume-btn">Resume subscription</button>';
    var resumeBtn = document.getElementById('dr-billing-resume-btn');
    if (resumeBtn) {
      resumeBtn.disabled = drBilling.demoLocked;
      resumeBtn.addEventListener('click', function() { drToggleCancellation(false, resumeBtn); });
    }
  } else {
    body.innerHTML = '<p><strong>' + drEscapeHtml(tierDef) + ' plan</strong> &mdash; active.</p>' +
      '<button type="button" id="dr-billing-cancel-btn">Cancel subscription</button>';
    var cancelBtn = document.getElementById('dr-billing-cancel-btn');
    if (cancelBtn) {
      cancelBtn.disabled = drBilling.demoLocked;
      cancelBtn.addEventListener('click', function() { drToggleCancellation(true, cancelBtn); });
    }
  }
}

// Referral v2 (2026-08-09). link is server-built (staticSiteAbsoluteBaseUrl()
// + the firm's own, currently-live referral_code) -- this function never
// assembles a URL itself. A null link means this firm has no paid invoice
// yet (codes are now minted only by invoice.created, never at signup) --
// shown as its own explanatory state, not a silent no-op, since the panel
// starts as a "Loading..." placeholder that must never be left stuck.
// Clipboard-only "Copy link" (no server round trip); rewardCount counts
// only REWARDED referrals (see countRewardedReferrals()'s own docstring),
// never raw signups; usesRemaining is this code's own 10-use cap headroom.
function drRenderReferralPanel(link, usesRemaining, rewardCount) {
  var body = document.getElementById('dr-referral-body');
  if (!body) return;
  if (!link) {
    body.innerHTML = '<p class="dr-panel-empty">No active referral code yet &mdash; one arrives with your next invoice.</p>';
    return;
  }
  var usesText = usesRemaining > 0
    ? usesRemaining + ' of 10 uses left on this code.'
    : 'This code has reached its 10-use limit; a new one arrives with your next invoice.';
  var countText = rewardCount > 0
    ? rewardCount + (rewardCount === 1 ? ' firm has' : ' firms have') + ' joined using your link.'
    : 'No referrals yet.';
  body.innerHTML =
    '<input type="text" id="dr-referral-link-input" readonly value="' + drEscapeHtml(link) + '">' +
    '<button type="button" class="dr-btn-secondary" id="dr-referral-copy-btn">Copy link</button>' +
    '<p class="dr-panel-empty">' + drEscapeHtml(usesText) + '</p>' +
    '<p class="dr-panel-empty">' + drEscapeHtml(countText) + '</p>';
  var copyBtn = document.getElementById('dr-referral-copy-btn');
  if (copyBtn) {
    copyBtn.addEventListener('click', function() {
      var input = document.getElementById('dr-referral-link-input');
      var done = function() { copyBtn.textContent = 'Copied!'; setTimeout(function() { copyBtn.textContent = 'Copy link'; }, 2000); };
      var fail = function() { if (input) { input.focus(); input.select(); } };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(link).then(done, fail);
      } else {
        fail();
      }
    });
  }
}

function drToggleCancellation(cancel, btn) {
  var confirmMsg = cancel
    ? 'Cancel your subscription? No refund for the current period, but you will keep full access until it ends.'
    : 'Resume your subscription? It will renew normally at the end of the current period.';
  if (!window.confirm(confirmMsg)) return;
  if (btn) btn.disabled = true;
  var okEl = document.getElementById('dr-billing-ok');
  var errEl = document.getElementById('dr-billing-error');
  if (okEl) okEl.hidden = true;
  if (errEl) errEl.hidden = true;
  fetch('/api/firm/billing/' + (cancel ? 'cancel' : 'resume'), {
    method: 'POST',
    credentials: 'include',
  }).then(function(res) {
    if (res.status === 401) { window.location.href = '/firm-login/'; return null; }
    return drReadJsonSafe(res).then(function(data) {
      if (!res.ok) {
        if (errEl) { errEl.textContent = (data && data.error) || 'Something went wrong, please try again.'; errEl.hidden = false; }
        if (btn) btn.disabled = false;
        return;
      }
      drBilling = {
        planTier: drBilling.planTier,
        cancelAtPeriodEnd: Boolean(data.cancel_at_period_end),
        currentPeriodEnd: data.current_period_end || null
      };
      if (okEl) {
        okEl.textContent = cancel ? 'Subscription set to cancel at period end.' : 'Subscription resumed.';
        okEl.hidden = false;
      }
      drRenderBillingPanel();
    });
  }).catch(function() {
    if (errEl) { errEl.textContent = 'Something went wrong, please try again.'; errEl.hidden = false; }
    if (btn) btn.disabled = false;
  });
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

// ValueLab customer-walkthrough finding (2026-08-10): a successful demo
// login's ONLY visible signal was "Dashboard" quietly replacing "Sign In"
// in the header nav -- easy to miss, reads as if the click failed. This
// makes a successful demo session unmistakable regardless of how the
// visitor got here (the "View the demo" button, a bookmarked link, a
// shared URL) -- demo_locked is already sent on every /firm/licenses
// response (Account-tab lockdown, 2026-08-06), just never surfaced as its
// own banner until now.
function drRenderDemoBanner(demoLocked) {
  var el = document.getElementById('dr-demo-banner');
  if (el) el.hidden = !demoLocked;
}

// ---------------------------------------------------------------------------
// Calendar + Map views (2026-07-30, BUILD v2 Phase D) -- both render from the
// SAME drLicenses array the roster view already fetched; no new endpoint,
// no separate page load. Switching tabs never re-fetches.
// ---------------------------------------------------------------------------

// Roadmap #28 (2026-08-06): the guided onboarding checklist's "visited
// Calendar"/"visited Map" steps are tracked client-side only, in
// localStorage -- a UX nicety, not durable account data, so no new
// server-side column/round trip for something this low-stakes. Keyed per
// BROWSER, not per firm -- a courtesy for whoever's actually clicking
// around, not a cross-device completion record.
var DR_ONBOARDING_VISIT_KEYS = {calendar: 'dr_visited_calendar', map: 'dr_visited_map'};
function drMarkOnboardingVisit(view) {
  var key = DR_ONBOARDING_VISIT_KEYS[view];
  if (!key) return;
  try { localStorage.setItem(key, '1'); } catch (e) {}
  drRenderOnboardingChecklist();
}

function drSwitchView(view) {
  drMarkOnboardingVisit(view);
  document.querySelectorAll('.dr-view').forEach(function(el) {
    var isTarget = (el.id === 'dr-view-' + view);
    el.hidden = !isTarget;
    // AuditLab A11Y-2 (MEDIUM, 2026-08-04): the panel swapped silently -- a
    // keyboard/screen-reader user activating a tab stayed parked on the tab
    // strip with no indication the view changed. tabindex="-1" makes the
    // panel programmatically focusable without adding it to the normal Tab
    // order (it's not meant to be tabbed TO directly, only focused by this
    // handler), and .focus() moves the user's actual position to the new
    // content the way a real tab-panel switch should.
    if (isTarget) {
      el.setAttribute('tabindex', '-1');
      el.focus();
    }
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

// Upcoming rule-change events (2026-08-06) that affect one of THIS firm's
// staff -- DR_RULE_CHANGE_EVENTS (build-time, from data/reg_change_events.json,
// see generate.py's own comment) is the same 55-jurisdiction feed
// /rule-changes/ publishes; "affects this firm" is the one thing that page
// can't answer, since it doesn't know any firm's roster. Scoped to
// jurisdictions with at least one active, non-opted-out staff member --
// a jurisdiction change is only actionable for a firm that actually has
// someone practicing there.
function drRuleChangeEventsForFirm() {
  var activeStates = {};
  drLicenses.forEach(function(item) {
    if (item.status === 'opted_out' || !item.state_slug) return;
    activeStates[item.state_slug] = true;
  });
  return DR_RULE_CHANGE_EVENTS.filter(function(e) { return activeStates[e.jurisdiction_slug]; });
}

function drRuleChangeEventsByDate() {
  var map = {};
  drRuleChangeEventsForFirm().forEach(function(e) {
    if (!map[e.effective_date]) map[e.effective_date] = [];
    map[e.effective_date].push(e);
  });
  return map;
}

function drOpenRuleChangeModal(event, triggerBtn) {
  var modal = document.getElementById('dr-rule-change-modal');
  if (!modal || !event) return;
  drRuleChangeModalTriggerBtn = triggerBtn || null;
  drRuleChangeModalCurrentEvent = event;
  document.getElementById('dr-rule-change-modal-title').textContent = event.jurisdiction;
  document.getElementById('dr-rule-change-modal-date').innerHTML =
    '<strong>Effective ' + drEscapeHtml(drFormatDeadline(event.effective_date)) + '</strong> &mdash; not yet in force.';
  document.getElementById('dr-rule-change-modal-summary').textContent = event.summary;
  var citeLink = document.getElementById('dr-rule-change-modal-citation-link');
  citeLink.href = event.citation_url || '#';
  citeLink.textContent = event.citation || 'Primary source';
  document.getElementById('dr-rule-change-modal-confidence').textContent =
    ' · confidence: ' + (event.confidence || 'unverified');
  var notifyBtn = document.getElementById('dr-rule-change-notify-btn');
  if (notifyBtn) notifyBtn.disabled = false;
  var notifyResult = document.getElementById('dr-rule-change-notify-result');
  if (notifyResult) { notifyResult.hidden = true; notifyResult.textContent = ''; }
  modal.hidden = false;
  document.getElementById('dr-rule-change-modal-close').focus();
}

function drCloseRuleChangeModal() {
  var modal = document.getElementById('dr-rule-change-modal');
  if (modal) modal.hidden = true;
  if (drRuleChangeModalTriggerBtn && document.body.contains(drRuleChangeModalTriggerBtn)) {
    drRuleChangeModalTriggerBtn.focus();
  }
  drRuleChangeModalTriggerBtn = null;
  drRuleChangeModalCurrentEvent = null;
}

// "Notify staff in this state" (2026-08-06, live request off the Calendar's
// rule-change badges) -- POST /firm/rule-change/notify emails every roster
// staffer licensed in jurisdiction_slug who hasn't opted out. Sends the
// event's own already-public fields (same data the modal above already
// rendered) rather than re-deriving them server-side -- see that route's
// own docstring for why there's no separate server-side copy of this data.
function drNotifyRuleChangeStaff() {
  var event = drRuleChangeModalCurrentEvent;
  var btn = document.getElementById('dr-rule-change-notify-btn');
  var resultEl = document.getElementById('dr-rule-change-notify-result');
  if (!event || !btn) return;
  btn.disabled = true;
  if (resultEl) { resultEl.hidden = true; resultEl.textContent = ''; }
  fetch('/api/firm/rule-change/notify', {
    method: 'POST',
    credentials: 'include',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      state_slug: event.jurisdiction_slug,
      jurisdiction: event.jurisdiction,
      summary: event.summary,
      effective_date_label: drFormatDeadline(event.effective_date),
      citation_url: event.citation_url || ''
    })
  }).then(function(res) {
    if (res.status === 401) { window.location.href = '/firm-login/'; return null; }
    btn.disabled = false;
    return drReadJsonSafe(res).then(function(data) {
      if (!resultEl) return;
      resultEl.hidden = false;
      if (!res.ok) {
        resultEl.textContent = (data && data.error) || 'Something went wrong. Please try again.';
        return;
      }
      if (data.total === 0) {
        resultEl.textContent = 'Nobody on your roster is licensed in this state.';
      } else if (data.sent > 0) {
        resultEl.textContent = 'Notified ' + data.sent + ' of ' + data.total + ' staff member' +
          (data.total === 1 ? '' : 's') + (data.skipped > 0 ? ' (' + data.skipped + ' skipped -- unsubscribed or over today’s email limit).' : '.');
      } else {
        resultEl.textContent = data.reason || 'Nobody was notified -- everyone on the list has unsubscribed or today’s email limit was reached.';
      }
    });
  }).catch(function() {
    btn.disabled = false;
    if (resultEl) { resultEl.hidden = false; resultEl.textContent = 'Something went wrong. Please try again.'; }
  });
}

function drRenderCalendar() {
  var grid = document.getElementById('dr-cal-grid');
  var label = document.getElementById('dr-cal-month-label');
  if (!grid || !label) return;
  if (!drCalendarRefDate) {
    // AuditLab CAL-1 (LOW, 2026-08-04): this picked the default month from
    // UTC while "today" (below, todayIso) is marked from LOCAL -- once UTC
    // rolls into next month but the viewer's local date hasn't, the grid
    // opens on the WRONG month with no "today" cell at all. Every customer
    // is US-based (negative UTC offset), so this hit every viewer once a
    // month, in the evening, on the last day of the month. Seeding from
    // local Y/M (matches TZ-1/TZ-2's fix) makes both anchors agree; the
    // grid itself stays UTC-built (correct -- cell keys are date-only
    // strings, see this function's own next lines).
    var now = new Date();
    drCalendarRefDate = new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1));
  }
  var ref = drCalendarRefDate;
  label.textContent = DR_MONTH_NAMES[ref.getUTCMonth()] + ' ' + ref.getUTCFullYear();

  var byDate = drLicensesByDate();
  var ruleChangesByDate = drRuleChangeEventsByDate();
  var firstDow = ref.getUTCDay();
  var numDays = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() + 1, 0)).getUTCDate();
  // AuditLab TZ-1 (MEDIUM, 2026-08-04), same class as drDaysUntil() above:
  // toISOString() is always UTC, so this lit up "today" a day early every
  // evening for every US timezone. The day cells themselves are keyed by
  // calendar date (built from ref's UTC getters just above, which is fine --
  // ref is a fixed month reference, not "now"); this needs to match the
  // viewer's own local calendar date instead.
  var todayNow = new Date();
  var todayIso = todayNow.getFullYear() + '-' + String(todayNow.getMonth() + 1).padStart(2, '0') +
    '-' + String(todayNow.getDate()).padStart(2, '0');

  var html = DR_DOW_NAMES.map(function(d) { return '<div class="dr-cal-dow">' + d + '</div>'; }).join('');
  for (var lead = 0; lead < firstDow; lead++) {
    html += '<div class="dr-cal-day dr-cal-day--empty"></div>';
  }
  for (var day = 1; day <= numDays; day++) {
    var iso = ref.getUTCFullYear() + '-' + String(ref.getUTCMonth() + 1).padStart(2, '0') +
      '-' + String(day).padStart(2, '0');
    var items = byDate[iso] || [];
    var ruleEvents = ruleChangesByDate[iso] || [];
    var cellItems = items.slice(0, 3).map(function(item) {
      var days = drDaysUntil(item.next_deadline);
      var soon = days !== null && days <= 7;
      // Richer hover detail (2026-08-06, Devin's live-test feedback: "what
      // else could go into a calendar cell?") -- every field is already on
      // drLicenses (fetched once, already in memory), no new endpoint. Same
      // hover-tooltip pattern the Staff/Email roster columns already use
      // (.dr-roster-name/.dr-roster-email's own title attrs); desktop-hover
      // only, the sub-640px layout already collapses this cell to a dot.
      var licenseTypeIdForDisplay = item.license_type_id || DR_DEFAULT_LICENSE_TYPE_ID[item.state_slug];
      var daysLabel = days === null ? '' : days < 0 ? 'Overdue' : days === 0 ? 'Due today' : 'in ' + days + ' day' + (days === 1 ? '' : 's');
      var itemTitle = [item.state_name, drPrettyLicenseType(licenseTypeIdForDisplay), daysLabel].filter(Boolean).join(' — ');
      return '<div class="dr-cal-item' + (soon ? ' dr-cal-item--soon' : '') + '" title="' + drEscapeHtml(itemTitle) + '">' +
        drEscapeHtml(item.staff_label || item.email) + '</div>';
    }).join('');
    if (items.length > 3) {
      cellItems += '<div class="dr-cal-item">+' + (items.length - 3) + ' more</div>';
    }
    // Upcoming rule-change events affecting this firm's staff (2026-08-06,
    // reported directly by Devin live-testing the calendar) -- a real
    // <button> (not the plain divs above) so it's keyboard-operable;
    // data-rule-change-id looked up against DR_RULE_CHANGE_EVENTS by the
    // grid's own click delegation below, rather than re-serializing the
    // whole event object into the DOM.
    cellItems += ruleEvents.map(function(e) {
      return '<button type="button" class="dr-cal-item--rule-change" data-rule-change-id="' + drEscapeHtml(e.id) + '" ' +
        'aria-label="Rule change: ' + drEscapeHtml(e.jurisdiction) + '">' +
        drEscapeHtml(e.jurisdiction) + ': rule change</button>';
    }).join('');
    // --has-item (staff) and --has-rule-change (regulatory) are separate
    // classes so the sub-640px dot can be colored per type (see that CSS's
    // own comment, updated 2026-08-10 -- rule-change buttons are now hidden
    // at this width same as staff items, both revealed by tap-to-expand).
    // aria-label carries the same summary a screen reader would otherwise
    // get from the now-hidden item titles/buttons, independent of the CSS.
    var dayAriaLabelParts = [];
    if (items.length) {
      dayAriaLabelParts.push(items.slice(0, 3).map(function(item) { return item.staff_label || item.email; }).join(', ') +
        (items.length > 3 ? ', and ' + (items.length - 3) + ' more' : '') + ' due this day');
    }
    if (ruleEvents.length) {
      dayAriaLabelParts.push(ruleEvents.map(function(e) { return e.jurisdiction; }).join(', ') + ' rule change' + (ruleEvents.length > 1 ? 's' : ''));
    }
    var dayAriaLabel = dayAriaLabelParts.length ? drEscapeHtml(dayAriaLabelParts.join(' -- ') + ' -- tap for details') : '';
    html += '<div class="dr-cal-day' + (iso === todayIso ? ' dr-cal-day--today' : '') +
      (items.length ? ' dr-cal-day--has-item' : '') +
      (ruleEvents.length ? ' dr-cal-day--has-rule-change' : '') + '"' +
      (dayAriaLabelParts.length ? ' role="button" tabindex="0" aria-label="' + dayAriaLabel + '"' : '') + '>' +
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
var DR_MAP_STATE_CLASSES = ['dr-map-state--active', 'dr-map-state--risk', 'dr-map-state--clear', 'dr-map-state--action', 'dr-map-state--complete', 'dr-map-state--home', 'dr-map-state--coverage'];

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
      var coverage = {}; // target slug -> {names: [...], fluxNote: bool}
      all.forEach(function(entry, i) {
        if (!entry || entry.denied || !entry.results) return;
        var homeSlug = slugs[i];
        entry.results.forEach(function(r) {
          if (r.overall !== 'clear' || byState[r.target_state_slug]) return;
          if (!coverage[r.target_state_slug]) {
            // AuditLab MOB-2 follow-up (2026-08-06, LOW): this overlay
            // builds its own tooltip from staff names only and never reads
            // r.individual.summary at all -- so unlike the per-person Map
            // view (drApplyMobilityResults, fixed separately), a settled-
            // flux target state showed zero "rule recently changed" signal
            // here. mobility.ts's applyRecentChangeCaveat() appends that
            // caveat to summary as "...(This state's rule changed on
            // DATE.)" -- detected by substring rather than re-parsing the
            // date, since this view only needs to know THAT it applies, not
            // repeat the exact date (which the per-person view / Practice
            // Privilege Check page already state precisely).
            var fluxNote = !!(r.individual && r.individual.summary &&
              r.individual.summary.indexOf("rule changed on") !== -1);
            coverage[r.target_state_slug] = {names: [], fluxNote: fluxNote};
          }
          homeStates[homeSlug].forEach(function(name) {
            if (coverage[r.target_state_slug].names.indexOf(name) === -1) coverage[r.target_state_slug].names.push(name);
          });
        });
      });
      var anyCoverage = Object.keys(coverage).length > 0;
      if (legendItem) legendItem.hidden = !anyCoverage;
      // Reported live, 2026-08-06: this tooltip lists every covering staff
      // member by name, easily 100+ characters, but rendered as one
      // unbroken nowrap line stretching off past the legend instead of
      // wrapping inside the box. Deliberately NOT drSetMapTooltipWrap(true)
      // here -- that function also swaps #dr-map-legend-staff for
      // #dr-map-legend-mobility, which is correct for the per-person
      // mobility view (drApplyMobilityResults, its only other caller) but
      // wrong here: this is still the aggregate "All staff" view, which
      // uses #dr-map-legend-staff (with its own nested coverage-item row,
      // toggled just above) the whole time. Setting the wrap CLASS directly
      // gets the same safe-for-any-length tooltip behavior without
      // swapping in the wrong legend.
      var tipEl = document.getElementById('dr-map-tooltip');
      if (anyCoverage && tipEl) tipEl.classList.add('dr-map-tooltip--wrap');
      document.querySelectorAll('.dr-map-link').forEach(function(link) {
        var cov = coverage[link.getAttribute('data-state-slug')];
        if (!cov) return;
        link.querySelector('path').classList.add('dr-map-state--coverage');
        var tip = 'No staff licensed here directly, but practice privilege is clear for: ' + cov.names.join(', ') +
          ' (assumes good standing + substantial equivalence).';
        if (cov.fluxNote) tip += ' This state’s rule recently changed — see Practice Privilege Check for details.';
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
  // AuditLab SAMPLE-1 (LOW): same !is_sample filter as drRenderCpeStaffSelect().
  var active = drLicenses.filter(function(item) { return item.status !== 'opted_out' && !item.is_sample; });
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

function drApplyMobilityResults(homeStateSlug, entry, gen, subscriberId) {
  if (gen !== drMapSelectionGen) return;
  var noteEl = document.getElementById('dr-map-mobility-note');
  // AuditLab MOB-1 (2026-08-05, MEDIUM): mobility.ts's own MobilityFinding
  // contract says "Always present. The UI must render it next to every
  // determination" -- the Map painted per-state clear/action-required
  // verdicts without it (the /firm-mobility/ single-check page already
  // rendered it correctly; only this view missed the wiring). `disclaimer`
  // is a per-result field but its value (MOBILITY_DISCLAIMER) is the SAME
  // constant on every result in a batch, so reading it off the first
  // result is representative of the whole map, not a shortcut that could
  // show the wrong text for some states.
  var disclaimerEl = document.getElementById('dr-map-mobility-disclaimer');
  var links = document.querySelectorAll('.dr-map-link');
  drSetMapTooltipWrap(true);
  if (entry.denied) {
    if (noteEl) {
      noteEl.textContent = entry.denied;
      noteEl.hidden = false;
    }
    // No determinations are being shown in the denied/rate-limited case --
    // nothing here for the disclaimer to be "next to".
    if (disclaimerEl) disclaimerEl.hidden = true;
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
  if (disclaimerEl) {
    var disclaimerText = (entry.results && entry.results[0] && entry.results[0].disclaimer) || '';
    if (disclaimerText) {
      disclaimerEl.textContent = disclaimerText;
      disclaimerEl.hidden = false;
    } else {
      disclaimerEl.hidden = true;
    }
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
      link.removeAttribute('href');
      return;
    }
    var r = byTarget[slug];
    if (!r) {
      link.removeAttribute('data-tip');
      link.setAttribute('data-has-staff', 'false');
      link.removeAttribute('href');
      return;
    }
    var verdict = r.overall;
    // Self-reported completion overrides action_required's COLOR only, never
    // the underlying verdict data or the tooltip's requirements text -- a
    // firm saying "we did this" is a different, less certain kind of true
    // than the engine's own "clear", and must never be visually
    // indistinguishable from it (see migration 0016's docstring for the
    // full reasoning). Deliberately does NOT check staleness
    // yet (r.rule_verified_date vs. the completion's own snapshot) -- v1
    // shows "complete" for any non-deleted completion regardless of
    // whether the rule has since changed; that comparison is a named
    // follow-up, not silently skipped forever.
    var completionKey = subscriberId ? drMobilityCompletionKey(subscriberId, slug, DR_MOBILITY_SERVICE_TYPE) : null;
    var completed = verdict === 'action_required' && completionKey && drMobilityCompletions[completionKey];
    if (verdict === 'clear') path.classList.add('dr-map-state--clear');
    else if (completed) path.classList.add('dr-map-state--complete');
    else if (verdict === 'action_required') path.classList.add('dr-map-state--action');
    // not_verified (or anything else): no color class, stays default gray.
    // 2026-08-10, same root issue as /firm-mobility/'s own Overall pointer
    // fix (Devin's live-test report): this tooltip used to read
    // individual.summary ALONE, so an orange (action_required) state could
    // show a clear-sounding individual summary while a firm-level
    // requirement was the real driver -- reversed here: when overall is
    // action_required but the individual side is clear, the firm-level
    // finding IS the story, so lead with that instead of the
    // clear-sounding individual text.
    var firmDriven = verdict === 'action_required' && r.individual && r.individual.verdict === 'clear';
    var tipText = firmDriven && r.firm && r.firm.summary
      ? 'Firm-level requirement: ' + r.firm.summary
      : (r.individual && r.individual.summary ? r.individual.summary : 'Not verified for this state.');
    if (completed) tipText += ' Marked complete by your firm.';
    if (verdict !== 'action_required' || !completed) {
      // Deep-link into Practice Privilege Check with the same home/target/
      // service/staff already picked (2026-08-06, live request: "exactly
      // what needs to be done, or a way to mark someone cleared" -- the
      // tooltip already has the requirement text on hover, this is the
      // "now go do something about it" click). Skipped once already marked
      // complete -- clicking through again to re-run the same check the
      // firm already resolved isn't useful, and (unlike the tooltip note
      // above) href absence is the one signal cursor:default vs pointer
      // actually reads correctly on a state that's already handled.
      tipText += ' Click to open Practice Privilege Check for this person and state.';
      // setAttribute(), NOT link.href = ... -- these are SVG <a> elements,
      // and unlike an HTML anchor, SVG's .href is an SVGAnimatedString
      // object, not a plain settable string; assigning to it silently does
      // nothing. Caught live: the tooltip text updated correctly but every
      // link's real href stayed null. setAttribute() works identically on
      // both HTML and SVG elements, which is why link.removeAttribute('href')
      // just above/below already used it instead of `link.href = null`.
      link.setAttribute('href', '/firm-mobility/?home=' + encodeURIComponent(homeStateSlug) +
        '&target=' + encodeURIComponent(slug) +
        '&service=' + encodeURIComponent(DR_MOBILITY_SERVICE_TYPE) +
        (subscriberId ? '&staff=' + encodeURIComponent(subscriberId) : ''));
    } else {
      link.removeAttribute('href');
    }
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
    drApplyMobilityResults(homeStateSlug, cached, gen, subscriberId);
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
        drApplyMobilityResults(homeStateSlug, {denied: 'Too many practice-privilege checks this hour. Try again later.'}, gen, subscriberId);
        return;
      }
      if (res.status === 403) {
        var denied = (data && data.error) || 'Practice-privilege coloring is part of the paid firm plan.';
        drMobilityCache[homeStateSlug] = {denied: denied};
        drApplyMobilityResults(homeStateSlug, drMobilityCache[homeStateSlug], gen, subscriberId);
        return;
      }
      if (!res.ok || !data) {
        if (gen === drMapSelectionGen && noteEl) { noteEl.textContent = 'Something went wrong checking practice privilege. Please try again.'; }
        return;
      }
      drMobilityCache[homeStateSlug] = {results: data.results};
      drApplyMobilityResults(homeStateSlug, drMobilityCache[homeStateSlug], gen, subscriberId);
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
  var disclaimerEl = document.getElementById('dr-map-mobility-disclaimer');
  if (!value) {
    if (noteEl) noteEl.hidden = true;
    if (disclaimerEl) disclaimerEl.hidden = true;
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
  // AuditLab CPE-1 (HIGH, 2026-08-04): ethics has its own period_years in 6
  // states (e.g. Texas: 120h/3y total, but ethics is 4h/2y -- an ANNUAL-ish
  // obligation nested inside the longer total-hours cycle). Judging ethics
  // against the total window silently accepted stale ethics credit and
  // showed "on track" for firms that were actually behind. Falls back to
  // the total window when ethics_period_years is null (44 states where the
  // two match, plus LA/SD whose rules set no ethics hour count at all).
  var winEthics = drCpeCycleWindow(item.next_deadline, req.ethics_period_years || req.period_years);
  // AuditLab CPE-2 (MEDIUM, 2026-08-04): summing IEEE-754 doubles directly
  // (e.g. 2.4 + 4.3 = 6.699999999999999) both rendered a 16-digit number to
  // the customer and, worse, could put a subscriber who logged EXACTLY the
  // required hours a hair under the requirement (39.99999999999999 < 40 ->
  // shown as behind, and counted against the firm's "behind" percentage).
  // Every hours value is entered via step="0.1", so accumulating in integer
  // tenths and dividing back once at the end -- rather than accumulating
  // in fractional hours and rounding only for display -- makes both the
  // comparison and the displayed value exact.
  var totalLoggedTenths = 0, ethicsLoggedTenths = 0, excludedCount = 0;
  drCpeEntries.forEach(function(e) {
    if (e.subscriber_id !== item.id) return;
    // No renewal date means we don't know either cycle boundary -- excluding
    // every entry (rather than summing an unbounded lifetime total) keeps
    // "0 logged" as an honest signal instead of a false on-track reading.
    if (!win) { excludedCount++; return; }
    // An entry dated before a window can genuinely happen -- e.g. hours
    // earned in the final weeks of a PRIOR cycle, logged before this one's
    // window (next_deadline minus one period) has technically started.
    // There is no record of that prior cycle's own boundary anywhere in
    // this product, so the entry can't safely be counted toward either
    // cycle -- but silently dropping it with no explanation is its own bug
    // (reported directly, 2026-08-03: "I added 100 hours to test this out,
    // and nothing happened to it" -- the entry WAS saved and appears in
    // Recently Logged, it just isn't in this window's sum). excludedCount
    // lets the UI say so instead of just showing 0.
    //
    // The total and ethics windows can now differ (Texas: 3y total, 2y
    // ethics), so an ethics entry can legitimately fall outside the total
    // window but inside its own shorter ethics window -- only exclude an
    // entry when it lands outside BOTH of the windows it's actually
    // relevant to, or a correctly-counted ethics entry would be reported
    // as ignored.
    var inTotalWindow = e.entry_date >= win.start && e.entry_date <= win.end;
    var inEthicsWindow = winEthics && e.entry_date >= winEthics.start && e.entry_date <= winEthics.end;
    if (!inTotalWindow && !(e.category === 'ethics' && inEthicsWindow)) { excludedCount++; return; }
    if (inTotalWindow) totalLoggedTenths += Math.round(e.hours * 10);
    if (e.category === 'ethics' && inEthicsWindow) ethicsLoggedTenths += Math.round(e.hours * 10);
  });
  // Roadmap #10 (2026-08-07): self-reported carryover hours (migration
  // 0036), added to the TOTAL track only -- deliberately never to ethics.
  // At least one state's own rule (Maryland, per data/cpe_hours.json's
  // notes) explicitly caps carried-over hours from satisfying a FUTURE
  // ethics requirement even though they count toward the general total --
  // applying carryover to ethics too would risk overstating ethics
  // compliance in exactly the states where the real rule is narrower.
  // Same "no cycle window, no count" exclusion as a dated entry above --
  // a carryover figure is meaningless without a cycle to apply it to.
  var carryoverHours = (typeof item.carryover_hours === 'number') ? item.carryover_hours : 0;
  if (win && carryoverHours > 0) totalLoggedTenths += Math.round(carryoverHours * 10);
  var totalLogged = totalLoggedTenths / 10, ethicsLogged = ethicsLoggedTenths / 10;
  var totalShort = req.total_hours !== null && totalLoggedTenths < Math.round(req.total_hours * 10);
  var ethicsShort = req.ethics_hours !== null && ethicsLoggedTenths < Math.round(req.ethics_hours * 10);
  // Orchestrator/Devin, 2026-08-05: "behind" was a blind hours-logged-so-far
  // < required check, with no regard for how much of the cycle remains --
  // that flagged 18/20 staff as behind, most of whom simply hadn't finished
  // yet with a year or more still left, not anyone actually at risk of
  // missing their deadline. Real "behind" has to answer "can this person
  // still realistically finish before their real deadline," not "have they
  // finished the whole thing right now" -- there's no legal even-pacing
  // requirement for CPE hours (states don't mandate finishing any fixed
  // fraction by a cycle's midpoint), so the only defensible signal for "running
  // out of time" is proximity to the deadline itself. Reuses the EXACT same
  // within-30-days-or-unresolved-date convention drRenderStats() already
  // uses for the Roster's own due-soon/overdue split (see its own comment),
  // rather than inventing a second, different threshold for CPE.
  //
  // AuditLab CPE-3 follow-up: total and ethics get their OWN pace-aware
  // verdict (totalBehind/ethicsBehind), not one shared flag -- the renewal
  // DEADLINE is the same date for both (so dueSoonOrOverdue is shared), but
  // someone can be short on ethics while having fully met their total
  // hours (or vice versa), and a single combined flag would incorrectly
  // paint BOTH bars red for a shortfall in only one of them.
  var daysUntilDeadline = drDaysUntil(item.next_deadline);
  var dueSoonOrOverdue = daysUntilDeadline === null || daysUntilDeadline <= 30;
  var totalBehind = totalShort && dueSoonOrOverdue;
  var ethicsBehind = ethicsShort && dueSoonOrOverdue;
  return {
    hasRequirement: true,
    totalRequired: req.total_hours, totalLogged: totalLogged,
    ethicsRequired: req.ethics_hours, ethicsLogged: ethicsLogged,
    totalBehind: totalBehind,
    ethicsBehind: ethicsBehind,
    // Aggregate for the roster-wide "Behind on hours" stat -- true if EITHER
    // metric is genuinely at risk.
    behind: totalBehind || ethicsBehind,
    noCycleDate: !win,
    excludedCount: excludedCount,
    cycleWindow: win,
    carryoverHoursApplied: (win && carryoverHours > 0) ? carryoverHours : 0,
  };
}

// AuditLab CPE-3 (MEDIUM, found @ 84021e37): this used to compute its OWN
// `behind` locally (raw logged < required, no deadline-proximity check) --
// a second, different definition from the pace-aware one 5aef8a3e added to
// drCpeProgressForSubscriber(). Both rendered on the same screen: the
// summary ring could read "0% behind" (correctly, per the pace-aware
// definition) while every individual row still painted a red risk-styled
// bar (per the old raw-completion one) -- same data, contradictory
// verdicts, exactly the wall-of-red the original report was about.
// `riskBehind` is now the CALLER's already-computed pace-aware verdict
// (drCpeProgressForSubscriber()'s `p.behind`), so one definition drives
// both. `incomplete` stays a separate, LOCAL raw-completion check used only
// for the bar's WIDTH -- "10/40 hours logged" should still show as ~25%
// full regardless of how urgent it is, that's honest progress, not a risk
// claim. Keeping the two questions (how much is done vs. how worried
// should you be) visually distinct is the whole point of the pace-aware
// change; this just stops the color from re-asking the old question.
function drCpeBarHtml(label, logged, required, riskBehind) {
  var incomplete = required !== null && logged < required;
  // AuditLab BAR-1 (LOW, 2026-08-04): rounding independently of `incomplete`
  // let anything >=99.5% of the requirement paint a FULL-width bar on
  // someone who hasn't met it (e.g. 119.5/120h rounds to 100%) -- the fill
  // width said done while the number didn't. Capping at 99 while incomplete
  // keeps the bar visibly short of complete regardless of how close the
  // rounded percentage gets.
  var pct = required ? Math.min(incomplete ? 99 : 100, Math.round((logged / required) * 100)) : 0;
  return '<div class="dr-cpe-bar-row"><span class="dr-cpe-bar-label">' + drEscapeHtml(label) + '</span>' +
    '<span class="dr-cpe-bar-track"><span class="dr-cpe-bar-fill' + (riskBehind ? ' dr-cpe-bar-fill--behind' : '') +
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
    // Roadmap #43: was a dead-end message -- a[data-view] is already
    // delegated at DOMContentLoaded time (drSwitchView on click), so this
    // link works with no extra wiring.
    el.innerHTML = '<p class="dr-panel-empty">No staff on your roster yet -- ' +
      '<a href="#" data-view="roster">add staff</a> to start tracking CPE hours.</p>';
    return;
  }
  el.innerHTML = active.map(function(item) {
    var p = drCpeProgressForSubscriber(item);
    var name = drEscapeHtml(item.staff_label || item.email);
    var state = drEscapeHtml(item.state_name || '');
    // Admin-triggered nudge (2026-08-05, staff self-service CPE entry):
    // lives on the CPE Hours tab, next to the exact progress it's about,
    // rather than the roster's already-crowded Actions column.
    // Roadmap #29: same reasoning as drRenderRow's Actions cell -- a sample
    // row's id matches nothing on the server, so no functional button.
    var reminderBtn = item.is_sample
      ? '<span class="dr-sample-tag">Sample</span>'
      : '<button type="button" class="dr-cpe-remind-btn" data-id="' + drEscapeHtml(item.id) +
        '" aria-label="Email ' + name + ' a CPE-hours reminder">Email reminder</button>';
    if (!p.hasRequirement) {
      var gapText = p.dataGapNote ? drEscapeHtml(p.dataGapNote) : 'Requirement not codified for this state &mdash; track manually.';
      return '<div class="dr-cpe-staff-card"><div class="dr-cpe-staff-head">' +
        '<span class="dr-cpe-staff-name">' + name + '</span><span class="dr-cpe-staff-state">' + state + '</span>' + reminderBtn + '</div>' +
        '<p class="dr-cpe-gap-note">' + gapText + '</p></div>';
    }
    var totalBar = p.totalRequired !== null ? drCpeBarHtml('Total', p.totalLogged, p.totalRequired, p.totalBehind) : '';
    var ethicsBar = p.ethicsRequired !== null ? drCpeBarHtml('Ethics', p.ethicsLogged, p.ethicsRequired, p.ethicsBehind) : '';
    var carryoverNote = p.carryoverHoursApplied > 0
      ? '<p class="dr-cpe-gap-note">Includes ' + p.carryoverHoursApplied + ' carried-over hour' + (p.carryoverHoursApplied === 1 ? '' : 's') + ' toward the total above.</p>'
      : '';
    var cycleNote = p.noCycleDate
      ? '<p class="dr-cpe-gap-note">No renewal date on file &mdash; add one to track progress for this cycle.</p>'
      : (p.excludedCount > 0
        ? '<p class="dr-cpe-gap-note">' + p.excludedCount + ' logged ' + (p.excludedCount === 1 ? 'entry falls' : 'entries fall') +
          ' outside the current cycle (' + drEscapeHtml(drFormatDeadline(p.cycleWindow.start)) + '&ndash;' +
          drEscapeHtml(drFormatDeadline(p.cycleWindow.end)) + ') and ' + (p.excludedCount === 1 ? "isn't" : "aren't") +
          ' counted above &mdash; not a bug, just outside this renewal period.</p>'
        : '');
    return '<div class="dr-cpe-staff-card"><div class="dr-cpe-staff-head">' +
      '<span class="dr-cpe-staff-name">' + name + '</span><span class="dr-cpe-staff-state">' + state + '</span>' + reminderBtn + '</div>' +
      totalBar + ethicsBar + carryoverNote + cycleNote + '</div>';
  }).join('');
}

function drRenderCpeStaffSelect() {
  var sel = document.getElementById('dr-cpe-staff-select');
  if (!sel) return;
  var current = sel.value;
  // AuditLab SAMPLE-1 (LOW): sample rows were selectable here, so a form
  // submit against a fake id hit the server's ownership 404 -- confusing,
  // if harmless (the backstop always fires). Same !is_sample filter the
  // roster's Actions buttons already use.
  var active = drLicenses.filter(function(item) { return item.status !== 'opted_out' && !item.is_sample; });
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
    // Roadmap #29: a sample entry's id ('sample-cpe-1' etc.) matches nothing
    // on the server -- same reasoning as drRenderRow's sample-row Actions
    // cell, no functional Remove button for one.
    var removeControl = (staffer && staffer.is_sample)
      ? '<span class="dr-sample-tag">Sample</span>'
      : '<button type="button" class="dr-cpe-recent-remove" data-id="' + drEscapeHtml(e.id) + '" data-label="' +
        drEscapeHtml(String(e.hours) + 'h for ' + name) + '">Remove</button>';
    return '<div class="dr-cpe-recent-item"><span><b>' + name + '</b> logged ' + drEscapeHtml(String(e.hours)) +
      'h (' + drEscapeHtml(e.category) + ')' + desc +
      '<span class="dr-agenda-date" style="display:block;">' + drEscapeHtml(drFormatDeadline(e.entry_date)) + '</span></span>' +
      removeControl + '</div>';
  }).join('');
}

// ---------------------------------------------------------------------------
// Roadmap #3 (2026-08-07): "Reports: exportable compliance-summary PDF for
// firm leadership." No new endpoint, no PDF library -- a printable HTML
// summary of data already in memory (drLicenses/drCpeEntries, the SAME
// arrays every other view already renders from), plus a plain
// window.print() button. Every modern OS's print dialog already offers
// "Save as PDF" as a destination, so this delivers exactly what the roadmap
// item asks for (an exportable PDF) with zero new backend surface and zero
// new dependency -- a real PDF-generation library in a Worker (no native
// canvas/font rendering available in that runtime) would be a materially
// bigger, riskier lift for the same end result. .dr-report-print-only CSS
// (see PAGE_CSS's @media print block) hides the sidebar/banners/buttons so
// the printed page is just this content, not a screenshot of the whole
// dashboard shell.
// ---------------------------------------------------------------------------
function drRenderReport() {
  var el = document.getElementById('dr-report-body');
  if (!el) return;
  // AuditLab SAMPLE-2 (MEDIUM, 2026-08-06): with no check here, sample mode
  // produced a dated, firm-named, print-ready "compliance summary" built
  // entirely from the 5 fabricated preview staffers, with the one on-screen
  // sample banner explicitly hidden by the print stylesheet. Refusing to
  // render the report from sample data at all (AuditLab's own suggested
  // fix) is safer than labeling -- a portable document of record built on
  // fiction shouldn't exist, labeled or not.
  if (drSampleModeActive) {
    el.innerHTML = '<p class="dr-panel-empty">You\\u2019re viewing sample data \\u2014 ' +
      '<a href="#" data-view="roster">add real staff</a> to generate a report.</p>';
    return;
  }
  var now = new Date();
  var generatedOn = now.toLocaleDateString('en-US', {year: 'numeric', month: 'long', day: 'numeric'});
  var firmNameEl = document.getElementById('dr-firm-name');
  var firmName = firmNameEl ? firmNameEl.textContent : 'Your firm';

  var total = drLicenses.length;
  var atRisk = drLicenses.filter(function(item) {
    var days = drDaysUntil(item.next_deadline);
    return days === null || days <= 30;
  }).length;
  var cpeBehind = 0, cpeTracked = 0;
  drLicenses.forEach(function(item) {
    if (item.status === 'opted_out') return;
    var p = drCpeProgressForSubscriber(item);
    if (!p.hasRequirement) return;
    cpeTracked++;
    if (p.behind) cpeBehind++;
  });

  if (total === 0) {
    el.innerHTML = '<p class="dr-panel-empty"><a href="#" data-view="roster">Add staff to your ' +
      'roster</a> to generate a report.</p>';
    return;
  }

  var summaryHtml = '<p class="dr-report-generated">Generated for <strong>' + drEscapeHtml(firmName) +
    '</strong> on ' + drEscapeHtml(generatedOn) + '.</p>' +
    '<ul class="dr-report-summary">' +
    '<li><strong>' + total + '</strong> staff tracked</li>' +
    '<li><strong>' + atRisk + '</strong> due within 30 days or unresolved</li>' +
    '<li><strong>' + cpeBehind + '</strong> of ' + cpeTracked + ' behind on CPE hours</li>' +
    '</ul>';

  var rows = drLicenses.slice().sort(function(a, b) {
    var da = drDaysUntil(a.next_deadline), db = drDaysUntil(b.next_deadline);
    if (da === null) return 1;
    if (db === null) return -1;
    return da - db;
  }).map(function(item) {
    var name = drEscapeHtml(item.staff_label || item.email);
    var state = drEscapeHtml(item.state_name || '');
    var licenseTypeIdForDisplay = item.license_type_id || DR_DEFAULT_LICENSE_TYPE_ID[item.state_slug];
    var licenseType = drEscapeHtml(drPrettyLicenseType(licenseTypeIdForDisplay));
    var statusLabel = drEscapeHtml(DR_STATUS_LABELS[item.status] || item.status);
    var deadline = drEscapeHtml(drFormatDeadline(item.next_deadline));
    var p = drCpeProgressForSubscriber(item);
    var cpeCell;
    if (!p.hasRequirement) {
      cpeCell = 'Not tracked';
    } else {
      var totalPart = p.totalRequired !== null ? p.totalLogged + ' / ' + p.totalRequired + ' hrs' + (p.totalBehind ? ' (behind)' : '') : '';
      var ethicsPart = p.ethicsRequired !== null ? p.ethicsLogged + ' / ' + p.ethicsRequired + ' ethics hrs' + (p.ethicsBehind ? ' (behind)' : '') : '';
      cpeCell = drEscapeHtml([totalPart, ethicsPart].filter(Boolean).join(', '));
    }
    return '<tr><td>' + name + '</td><td>' + state + '</td><td>' + licenseType + '</td><td>' +
      statusLabel + '</td><td>' + deadline + '</td><td>' + cpeCell + '</td></tr>';
  }).join('');

  el.innerHTML = summaryHtml +
    '<div class="table-wrap"><table class="dr-report-table">' +
    '<thead><tr><th scope="col">Staff</th><th scope="col">State</th><th scope="col">License type</th>' +
    '<th scope="col">Status</th><th scope="col">Next deadline</th><th scope="col">CPE progress</th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table></div>';
}

// Roadmap #18 (2026-08-07): CSV bulk export of roster + deadline data. Pure
// client-side, built from the SAME drLicenses array every other roster view
// already has -- no new endpoint, same "reuse what's already fetched"
// posture as #15 (audit trail filtering). Wraps a field in quotes (doubling
// any embedded quote) whenever it contains a comma/quote/newline -- the same
// RFC4180-ish convention drParseCsv() (#17) reads back on the way in, so a
// roster exported here re-imports cleanly through that same feature.
function drCsvField(value) {
  var s = (value == null) ? '' : String(value);
  // AuditLab CSV-1/CSV-2 (2026-08-07): standard CSV-formula-injection
  // prefix set -- the same characters worker/src/validation.ts's
  // sanitizeFreeText() already guards at WRITE time for staff_label/
  // office_tag, but every other exported column (email, state name,
  // license type, etc.) reaches this function without ever passing
  // through that guard. This is the one choke point every exported cell
  // passes through regardless of which validator produced the value, so
  // guarding here too (defense in depth, not a replacement for the
  // write-time guard) can't decay the way a per-field guard does when a
  // new column is added later. Must run BEFORE the quote-wrapping below --
  // prefixing after would land the leading quote-char outside the
  // wrapping quotes.
  if (['=', '+', '-', '@', '\\t'].indexOf(s.charAt(0)) !== -1) s = "'" + s;
  if (/[",\\n\\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// Shared by drDownloadRosterCsv() and drDownloadCsvTemplate() -- `lines` is
// already-CSV-escaped rows (each a joined, comma-separated string). A
// leading BOM (matches drParseCsv()'s own strip-on-read) so Excel opens the
// file as UTF-8 instead of guessing the system codepage and mangling any
// non-ASCII staff name.
function drTriggerCsvDownload(filename, lines) {
  var blob = new Blob(['﻿' + lines.join('\\r\\n') + '\\r\\n'], {type: 'text/csv;charset=utf-8;'});
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function drDownloadRosterCsv() {
  var headers = ['Staff', 'Email', 'State', 'License type', 'Status', 'Next deadline',
    'Renewal fee', 'Office/department', 'CPE carryover hours', 'CPE total logged', 'CPE total required',
    'CPE ethics logged', 'CPE ethics required'];
  var lines = [headers.map(drCsvField).join(',')];
  drLicenses.forEach(function(item) {
    var licenseTypeIdForDisplay = item.license_type_id || DR_DEFAULT_LICENSE_TYPE_ID[item.state_slug];
    var p = drCpeProgressForSubscriber(item);
    var fee = (typeof item.renewal_fee_cents === 'number') ? (item.renewal_fee_cents / 100).toFixed(2) : '';
    var row = [
      item.staff_label || '', item.email, item.state_name || '',
      drPrettyLicenseType(licenseTypeIdForDisplay), DR_STATUS_LABELS[item.status] || item.status,
      item.next_deadline || '', fee, item.office_tag || '',
      (typeof item.carryover_hours === 'number') ? item.carryover_hours : '',
      p.hasRequirement ? p.totalLogged : '', p.hasRequirement && p.totalRequired !== null ? p.totalRequired : '',
      p.hasRequirement ? p.ethicsLogged : '', p.hasRequirement && p.ethicsRequired !== null ? p.ethicsRequired : ''
    ];
    lines.push(row.map(drCsvField).join(','));
  });
  var today = new Date().toISOString().slice(0, 10);
  drTriggerCsvDownload('deadlineradar-roster-' + today + '.csv', lines);
}

// Requested live 2026-08-07: a firm starting from an existing spreadsheet
// wants to see the EXACT column layout Import expects rather than retyping
// header names by hand and hoping they match. Headers come straight from
// DR_CSV_KNOWN_COLUMNS (plus 'state', which drPreviewCsvImport() also
// accepts in place of state_slug) so this can never drift from what Import
// actually reads. One example row shows the always-safe fields
// (email/state/staff_label/renewal_fee/office_tag); the state-specific
// columns (license_type_id, birth_month, birth_year, cohort_group,
// license_expiration_date) are left blank in the example rather than
// guessing a value that would only be correct for some states -- the
// Import panel's own copy already explains when those are needed.
function drDownloadCsvTemplate() {
  var headers = ['email', 'state', 'staff_label', 'license_type_id', 'birth_month',
    'birth_year', 'cohort_group', 'license_expiration_date', 'renewal_fee', 'office_tag'];
  var exampleRow = ['jane.doe@example.com', 'Georgia', 'Jane Doe', '', '', '', '', '', '199.00', 'Downtown office'];
  var lines = [headers.map(drCsvField).join(','), exampleRow.map(drCsvField).join(',')];
  drTriggerCsvDownload('deadlineradar-import-template.csv', lines);
}

// ---------------------------------------------------------------------------
// Roadmap #8 (2026-08-07): "'Reasonable process' audit trail export (dates
// tracked, dates reminded)". Own fetch (GET /firm/audit-trail), own render
// -- combines activity_log (every roster event, uncapped) and reminder_log
// (every REAL reminder-send date, migration 0035) into one chronological
// table. Both are durable logs independent of current roster membership,
// same "outlive the row it describes" design as Recent Activity's own
// smaller panel.
// ---------------------------------------------------------------------------
function drLoadAuditTrail() {
  return fetch('/api/firm/audit-trail', {credentials: 'include'})
    .then(function(res) {
      if (res.status === 401) { window.location.href = '/firm-login/'; return null; }
      if (!res.ok) return null;
      return res.json();
    })
    .then(function(data) {
      drRenderAuditTrail(data);
    })
    .catch(function() {
      drRenderAuditTrail(null);
    });
}

// Roadmap #15 (2026-08-07): the full, unfiltered row set drApplyAuditTrailFilter()
// re-filters against on every keystroke/select change -- populated once per
// drLoadAuditTrail() fetch, not re-derived from the DOM.
var drAuditTrailRows = [];

function drRenderAuditTrail(data) {
  var el = document.getElementById('dr-audit-trail-body');
  if (!el) return;
  if (!data) {
    drAuditTrailRows = [];
    el.innerHTML = '<p class="dr-panel-empty">Could not load the audit trail right now.</p>';
    return;
  }
  var rows = [];
  (data.activity || []).forEach(function(e) {
    rows.push({
      when: e.created_at,
      who: e.staff_label || e.email,
      what: DR_ACTIVITY_LABELS[e.event_type] || e.event_type,
      // Filter value -- deliberately the raw event_type, not the
      // human-readable `what` label, so filtering survives a future label
      // wording change.
      kind: e.event_type
    });
  });
  (data.reminders || []).forEach(function(r) {
    rows.push({
      when: r.sent_at,
      who: r.staff_label,
      what: 'reminded (' + r.threshold_days + '-day notice)',
      kind: 'reminded'
    });
  });
  rows.sort(function(a, b) { return a.when < b.when ? -1 : a.when > b.when ? 1 : 0; });
  drAuditTrailRows = rows;
  drApplyAuditTrailFilter();
}

function drApplyAuditTrailFilter() {
  var el = document.getElementById('dr-audit-trail-body');
  if (!el) return;
  if (drAuditTrailRows.length === 0) {
    el.innerHTML = '<p class="dr-panel-empty">Nothing tracked yet.</p>';
    return;
  }
  var searchInput = document.getElementById('dr-audit-search');
  var eventSelect = document.getElementById('dr-audit-event-filter');
  var search = searchInput ? searchInput.value.trim().toLowerCase() : '';
  var kind = eventSelect ? eventSelect.value : '';
  var filtered = drAuditTrailRows.filter(function(r) {
    if (kind && r.kind !== kind) return false;
    if (search && r.who.toLowerCase().indexOf(search) === -1) return false;
    return true;
  });
  if (filtered.length === 0) {
    el.innerHTML = '<p class="dr-panel-empty">No matching events.</p>';
    return;
  }
  var tableRows = filtered.map(function(r) {
    return '<tr><td>' + drEscapeHtml(drFormatDeadline(String(r.when).slice(0, 10))) + '</td><td>' +
      drEscapeHtml(r.who) + '</td><td>' + drEscapeHtml(r.what) + '</td></tr>';
  }).join('');
  el.innerHTML = '<div class="table-wrap"><table class="dr-report-table">' +
    '<thead><tr><th scope="col">Date</th><th scope="col">Staff</th><th scope="col">Event</th></tr></thead>' +
    '<tbody>' + tableRows + '</tbody></table></div>';
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
      drRenderReport();
    })
    .catch(function() {});
}

// Practice-privilege completion tracking (2026-08-04, migration 0016).
// Fetched once alongside the roster/CPE data, not re-fetched per Map
// dropdown change -- same "fetch the firm's rows once, filter client-side"
// pattern drCpeEntries already uses. Keyed as "subscriberId|targetSlug|
// serviceType" for O(1) lookup from drApplyMobilityResults() below.
var drMobilityCompletions = {}; // key -> {rule_verified_date}
function drMobilityCompletionKey(subscriberId, targetStateSlug, serviceType) {
  return subscriberId + '|' + targetStateSlug + '|' + serviceType;
}
function drLoadMobilityCompletions() {
  return fetch('/api/firm/mobility/completions', {credentials: 'include'})
    .then(function(res) {
      if (res.status === 401) { window.location.href = '/firm-login/'; return null; }
      if (!res.ok) return null;
      return res.json();
    })
    .then(function(data) {
      drMobilityCompletions = {};
      ((data && data.completions) || []).forEach(function(c) {
        drMobilityCompletions[drMobilityCompletionKey(c.subscriber_id, c.target_state_slug, c.service_type)] =
          {rule_verified_date: c.rule_verified_date};
      });
    })
    .catch(function() {});
}

function drSubmitCpeEntry(form) {
  // AuditLab IDEM-1 (MEDIUM, 2026-08-04): two concurrent submits of this
  // form (a double-click, or a slow network making a first click look like
  // nothing happened) created two identical CPE entries -- no dedupe on
  // (date, hours, category) either client or server side, so one 8-hour
  // double-click became 16 hours toward the requirement. This is the exact
  // CPE-1 harm direction (a staffer reads "on track" on hours not actually
  // completed) reached through a different route. A hard dedupe would risk
  // silently dropping a real second entry that genuinely matches (rare but
  // not impossible), so the fix is an in-flight guard, not a server-side
  // reject.
  var submitBtn = form.querySelector('button[type="submit"]');
  if (submitBtn && submitBtn.disabled) return;
  if (submitBtn) submitBtn.disabled = true;
  var errEl = document.getElementById('dr-cpe-log-error');
  if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
  var fd = new FormData(form);
  var body = {};
  // #dr-cpe-certificate has no `name` attribute (deliberately), so it never
  // appears in this loop -- a File value ending up in `body` and then
  // through JSON.stringify would serialize as "{}", not the file. Handled
  // as its own separate upload step below instead.
  fd.forEach(function(v, k) { body[k] = v; });

  var certificateInput = document.getElementById('dr-cpe-certificate');
  var certificateFile = certificateInput && certificateInput.files ? certificateInput.files[0] : null;

  // Roadmap #1/#2 (2026-08-07): if a certificate was attached, upload it
  // FIRST (as a 'cpe' document for the same staff member) and link the
  // resulting document_id into the CPE entry -- if the upload itself fails,
  // the whole submission is blocked with a clear error rather than silently
  // creating an entry with no certificate the user explicitly attached one for.
  var uploadStep = certificateFile
    ? (function() {
        var uploadForm = new FormData();
        uploadForm.append('file', certificateFile);
        uploadForm.append('kind', 'cpe');
        return fetch('/api/firm/licenses/' + encodeURIComponent(body.subscriber_id) + '/documents', {
          method: 'POST', credentials: 'include', body: uploadForm
        }).then(function(res) {
          if (res.status === 401) { window.location.href = '/firm-login/'; return Promise.reject(new Error('redirecting')); }
          return drReadJsonSafe(res).then(function(data) {
            if (!res.ok) {
              throw new Error((data && data.error) ? data.error : 'Could not upload the certificate.');
            }
            return data && data.document ? data.document.id : null;
          });
        });
      })()
    : Promise.resolve(null);

  uploadStep.then(function(documentId) {
    if (documentId) body.document_id = documentId;
    return fetch('/api/firm/cpe', {
      method: 'POST', credentials: 'include',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body)
    });
  }).then(function(res) {
    if (!res) return null; // redirecting to login
    if (res.status === 401) { window.location.href = '/firm-login/'; return null; }
    return drReadJsonSafe(res).then(function(data) {
      if (!res.ok) {
        var msg = data && data.error ? data.error : 'Something went wrong, please try again.';
        if (errEl) { errEl.textContent = msg; errEl.hidden = false; }
        if (submitBtn) submitBtn.disabled = false;
        return;
      }
      var keepStaffId = body.subscriber_id;
      form.reset();
      var staffSel = document.getElementById('dr-cpe-staff-select');
      if (staffSel) staffSel.value = keepStaffId;
      if (submitBtn) submitBtn.disabled = false;
      drLoadCpeEntries();
    });
  }).catch(function(err) {
    if (errEl) { errEl.textContent = (err && err.message) ? err.message : 'Something went wrong, please try again.'; errEl.hidden = false; }
    if (submitBtn) submitBtn.disabled = false;
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

// Roadmap #52 (2026-08-07): self-service active-session view. Same
// load/render/action shape as drLoadIdentities()/drRenderIdentities()/
// drRemoveIdentity() just below -- the sibling security panel on this same
// Account tab.
function drRenderSessions(items) {
  var el = document.getElementById('dr-sessions-list');
  if (!el) return;
  if (!items || items.length === 0) {
    el.innerHTML = '<p class="dr-panel-empty">No active sessions.</p>';
    return;
  }
  el.innerHTML = items.map(function(s) {
    var signedIn = drEscapeHtml(drFormatDeadline(String(s.created_at).slice(0, 10)));
    var lastActive = drEscapeHtml(drFormatDeadline(String(s.last_seen_at).slice(0, 10)));
    var thisDevice = s.is_current
      ? '<span class="dr-agenda-date" style="display:block;">This device</span>'
      : '<button type="button" class="dr-cpe-recent-remove" data-session-id="' + drEscapeHtml(s.id) + '">Revoke</button>';
    return '<div class="dr-cpe-recent-item"><span><b>Signed in ' + signedIn + '</b>' +
      '<span class="dr-agenda-date" style="display:block;">Last active ' + lastActive + '</span></span>' +
      thisDevice + '</div>';
  }).join('');
}

function drLoadSessions() {
  return fetch('/api/firm/sessions', {credentials: 'include'})
    .then(function(res) {
      if (res.status === 401) { window.location.href = '/firm-login/'; return null; }
      if (!res.ok) return null;
      return res.json();
    })
    .then(function(data) { drRenderSessions(data && data.sessions); })
    .catch(function() {});
}

function drRevokeSession(id) {
  if (!window.confirm('End this session? That device or tab will be signed out immediately.')) return;
  var errEl = document.getElementById('dr-session-revoke-error');
  if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
  fetch('/api/firm/sessions/' + encodeURIComponent(id), {method: 'DELETE', credentials: 'include'})
    .then(function(res) {
      if (res.status === 401) { window.location.href = '/firm-login/'; return; }
      if (res.ok) { drLoadSessions(); return; }
      if (errEl) { errEl.textContent = 'Could not end that session. Please try again.'; errEl.hidden = false; }
    })
    .catch(function() {
      if (errEl) { errEl.textContent = 'Something went wrong, please try again.'; errEl.hidden = false; }
    });
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

// migration 0045 (roadmap #11/#13/#14/#51): the Team panel. Same load/
// render/action shape as drLoadSessions()/drLoadIdentities() above -- the
// backend is the real permission gate either way (every mutating
// /firm/members/* route re-checks drRole server-side), this just avoids
// rendering controls the signed-in role could not use anyway.
function drTeamStatusLabel(m) {
  if (m.joined_at) return "Joined";
  return "Invited " + drFormatDeadline(String(m.invited_at).slice(0, 10)) + " &middot; pending";
}

function drRenderTeam(members) {
  drTeamMembers = members || [];
  var listEl = document.getElementById('dr-team-list');
  if (listEl) {
    if (drTeamMembers.length === 0) {
      listEl.innerHTML = '<p class="dr-panel-empty">No team members yet.</p>';
    } else {
      listEl.innerHTML = drTeamMembers.map(function(m) {
        var isSelf = m.id === drMemberId;
        var tags = '';
        if (m.is_primary) tags += ' &middot; <span class="dr-agenda-date">Primary contact</span>';
        if (isSelf) tags += ' &middot; <span class="dr-agenda-date">You</span>';
        var nameLine = drEscapeHtml(m.name || m.email);
        var subLine = drEscapeHtml(m.email) + ' &middot; ' + (DR_ROLE_LABELS[m.role] || m.role) + ' &middot; ' + drTeamStatusLabel(m) + tags;

        var actions = '';
        var canManage = drRole === 'partner' || (drRole === 'office_manager' && m.role === 'staff');
        if (!isSelf && canManage) {
          if (drRole === 'partner') {
            actions += '<select class="dr-team-role-select" data-member-id="' + drEscapeHtml(m.id) + '">' +
              ['partner', 'office_manager', 'staff'].map(function(r) {
                return '<option value="' + r + '"' + (r === m.role ? ' selected' : '') + '>' + DR_ROLE_LABELS[r] + '</option>';
              }).join('') + '</select>';
            if (m.role === 'partner' && !m.is_primary) {
              actions += '<button type="button" class="dr-cpe-recent-remove" data-make-primary-id="' +
                drEscapeHtml(m.id) + '" data-member-label="' + nameLine + '">Make primary</button>';
            }
          }
          if (!m.is_primary) {
            actions += '<button type="button" class="dr-cpe-recent-remove" data-remove-member-id="' +
              drEscapeHtml(m.id) + '" data-member-label="' + nameLine + '">Remove</button>';
          }
        }
        return '<div class="dr-cpe-recent-item"><span><b>' + nameLine + '</b>' +
          '<span class="dr-agenda-date" style="display:block;">' + subLine + '</span></span>' + actions + '</div>';
      }).join('');
    }
  }

  var upgradeNotice = document.getElementById('dr-team-upgrade-notice');
  var inviteForm = document.getElementById('dr-team-invite-form');
  var isFree = !drBilling || drBilling.planTier === 'free';
  var canInvite = drRole === 'partner' || drRole === 'office_manager';
  if (upgradeNotice) upgradeNotice.hidden = !(isFree && canInvite);
  if (inviteForm) {
    inviteForm.hidden = !(canInvite && !isFree);
    if (!inviteForm.hidden) {
      var roleSelect = document.getElementById('dr-team-invite-role');
      if (roleSelect) {
        // AuditLab ROLE-3 (MEDIUM, 2026-08-09): no blank option meant
        // 'partner' -- first in the list, and the HIGHEST privilege --
        // was silently pre-selected. A Partner who typed an email and
        // clicked "Send invite" without opening the dropdown silently
        // granted another Partner (billing, member management, ownership
        // transfer, account deletion). Same fix shape as dr-documents-kind:
        // a blank leading option + `required` on the <select> forces an
        // explicit choice, so there's nothing left to silently inherit.
        var opts = drRole === 'partner' ? ['partner', 'office_manager', 'staff'] : ['staff'];
        roleSelect.innerHTML = '<option value="">Select a role&hellip;</option>' + opts.map(function(r) {
          return '<option value="' + r + '">' + DR_ROLE_LABELS[r] + '</option>';
        }).join('');
      }
    }
  }
}

function drLoadTeam() {
  return fetch('/api/firm/members', {credentials: 'include'})
    .then(function(res) {
      if (res.status === 401) { window.location.href = '/firm-login/'; return null; }
      if (!res.ok) return null;
      return res.json();
    })
    .then(function(data) { drRenderTeam(data && data.members); })
    .catch(function() {});
}

function drSubmitTeamInvite(form) {
  var okEl = document.getElementById('dr-team-invite-ok');
  var errEl = document.getElementById('dr-team-invite-error');
  if (okEl) { okEl.hidden = true; okEl.textContent = ''; }
  if (errEl) { errEl.hidden = true; errEl.textContent = ''; }

  var fd = new FormData(form);
  var email = fd.get('email') || '';
  var body = {email: email, role: fd.get('role') || 'staff'};

  fetch('/api/firm/members/invite', {
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
      if (okEl) { okEl.textContent = 'Invite sent to ' + email + '.'; okEl.hidden = false; }
      drLoadTeam();
    });
  }).catch(function() {
    if (errEl) { errEl.textContent = 'Something went wrong, please try again.'; errEl.hidden = false; }
  });
}

function drChangeTeamMemberRole(id, role) {
  var errEl = document.getElementById('dr-team-error');
  if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
  fetch('/api/firm/members/' + encodeURIComponent(id), {
    method: 'PATCH', credentials: 'include',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({role: role})
  }).then(function(res) {
    if (res.status === 401) { window.location.href = '/firm-login/'; return null; }
    return drReadJsonSafe(res).then(function(data) {
      if (res.ok) { drLoadTeam(); return; }
      var msg = (data && data.error) ? data.error : 'Could not change that role. Please try again.';
      if (errEl) { errEl.textContent = msg; errEl.hidden = false; }
      drLoadTeam();
    });
  }).catch(function() {
    if (errEl) { errEl.textContent = 'Something went wrong, please try again.'; errEl.hidden = false; }
  });
}

function drRemoveTeamMember(id, label) {
  if (!window.confirm('Remove ' + label + ' from your team? They will be signed out immediately, and any pending invite link stops working.')) return;
  var errEl = document.getElementById('dr-team-error');
  if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
  fetch('/api/firm/members/' + encodeURIComponent(id), {method: 'DELETE', credentials: 'include'})
    .then(function(res) {
      if (res.status === 401) { window.location.href = '/firm-login/'; return null; }
      return drReadJsonSafe(res).then(function(data) {
        if (res.ok) { drLoadTeam(); return; }
        var msg = (data && data.error) ? data.error : 'Could not remove that team member. Please try again.';
        if (errEl) { errEl.textContent = msg; errEl.hidden = false; }
      });
    })
    .catch(function() {
      if (errEl) { errEl.textContent = 'Something went wrong, please try again.'; errEl.hidden = false; }
    });
}

function drMakeTeamMemberPrimary(id, label) {
  if (!window.confirm('Make ' + label + ' the primary contact for this firm? Billing receipts and account-level email go to them instead.')) return;
  var errEl = document.getElementById('dr-team-error');
  if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
  fetch('/api/firm/members/' + encodeURIComponent(id) + '/make-primary', {method: 'POST', credentials: 'include'})
    .then(function(res) {
      if (res.status === 401) { window.location.href = '/firm-login/'; return null; }
      return drReadJsonSafe(res).then(function(data) {
        if (res.ok) { drLoadTeam(); drLoadLicenses(); return; }
        var msg = (data && data.error) ? data.error : 'Could not update the primary contact. Please try again.';
        if (errEl) { errEl.textContent = msg; errEl.hidden = false; }
      });
    })
    .catch(function() {
      if (errEl) { errEl.textContent = 'Something went wrong, please try again.'; errEl.hidden = false; }
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

// Task #18 (2026-08-05): explicit self-serve version of the same
// other-sessions sweep drSubmitPassword() already triggers as a side
// effect of changing a password -- same endpoint response shape
// ({ok, other_sessions_ended}), same "this device stays signed in" framing.
function drSignOutOtherDevices(btn) {
  if (!window.confirm('Sign out every OTHER device? This browser stays signed in.')) return;
  var okEl = document.getElementById('dr-signout-other-ok');
  var errEl = document.getElementById('dr-signout-other-error');
  if (okEl) { okEl.hidden = true; okEl.textContent = ''; }
  if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
  if (btn) btn.disabled = true;

  fetch('/api/firm/sign-out-other-devices', {
    method: 'POST', credentials: 'include'
  }).then(function(res) {
    if (res.status === 401) { window.location.href = '/firm-login/'; return null; }
    return drReadJsonSafe(res).then(function(data) {
      if (btn) btn.disabled = false;
      if (!res.ok) {
        var msg = (data && data.error) ? data.error : 'Something went wrong, please try again.';
        if (errEl) { errEl.textContent = msg; errEl.hidden = false; }
        return;
      }
      var ended = (data && data.other_sessions_ended) || 0;
      if (okEl) {
        okEl.textContent = ended > 0
          ? 'Signed out on ' + ended + ' other device' + (ended === 1 ? '' : 's') + '.'
          : 'No other sessions were active.';
        okEl.hidden = false;
      }
      if (ended > 0) drLoadSessions();
    });
  }).catch(function() {
    if (btn) btn.disabled = false;
    if (errEl) { errEl.textContent = 'Something went wrong, please try again.'; errEl.hidden = false; }
  });
}

// Roadmap #53 (2026-08-07): two-factor authentication self-service. Same
// load/render shape as drLoadIdentities()/drLoadSessions() above, but with
// three states instead of one list: not enrolled (a single Enable button),
// mid-enrollment (secret + confirm-code form, rendered by
// drRender2faEnrollForm), and enrolled (status + a Disable toggle). The
// backup-codes view after a successful confirm is a fourth, ONE-TIME-ONLY
// render -- drLoad2faStatus() is never called again until the user
// acknowledges having saved them, since that GET would otherwise just show
// the same "enabled" state and make the codes' one-time disclosure feel
// like it silently vanished.
function drLoad2faStatus() {
  return fetch('/api/firm/2fa/status', {credentials: 'include'})
    .then(function(res) {
      if (res.status === 401) { window.location.href = '/firm-login/'; return null; }
      if (!res.ok) return null;
      return res.json();
    })
    .then(function(data) { if (data) drRender2faStatus(data.enabled, data.backup_codes_remaining); })
    .catch(function() {});
}

function drRender2faStatus(enabled, remaining) {
  var el = document.getElementById('dr-2fa-body');
  if (!el) return;
  if (enabled) {
    el.innerHTML =
      '<p class="dr-2fa-status-line">Enabled</p>' +
      '<p class="signup-microcopy">' + remaining + ' backup code' + (remaining === 1 ? '' : 's') + ' remaining.</p>' +
      '<button type="button" id="dr-2fa-disable-toggle">Disable two-factor authentication</button>' +
      '<div id="dr-2fa-disable-form-wrap"></div>';
    var toggleBtn = document.getElementById('dr-2fa-disable-toggle');
    if (toggleBtn) toggleBtn.addEventListener('click', drShow2faDisableForm);
  } else {
    el.innerHTML =
      '<p class="dr-2fa-status-line">Not enabled</p>' +
      '<form id="dr-2fa-enable-form">' +
        '<label for="dr-2fa-enable-password">Current password ' +
        '<span class="field-hint">(leave blank if you have never set one)</span></label>' +
        '<input type="password" id="dr-2fa-enable-password" name="current_password" autocomplete="current-password">' +
        '<button type="submit">Enable two-factor authentication</button>' +
      '</form>' +
      '<div id="dr-2fa-enroll-wrap"></div>';
    var enableForm = document.getElementById('dr-2fa-enable-form');
    if (enableForm) {
      enableForm.addEventListener('submit', function(ev) { ev.preventDefault(); drStart2faEnroll(enableForm); });
    }
  }
}

function drShow2faDisableForm() {
  var wrap = document.getElementById('dr-2fa-disable-form-wrap');
  if (!wrap) return;
  wrap.innerHTML =
    '<form id="dr-2fa-disable-form">' +
      '<label for="dr-2fa-disable-code">Current code from your app, or a backup code</label>' +
      '<input type="text" id="dr-2fa-disable-code" name="code" required autocomplete="one-time-code">' +
      '<button type="submit">Confirm disable</button>' +
    '</form>';
  var form = document.getElementById('dr-2fa-disable-form');
  if (form) {
    form.addEventListener('submit', function(ev) { ev.preventDefault(); drSubmit2faDisable(form); });
  }
}

function drSubmit2faDisable(form) {
  var errEl = document.getElementById('dr-2fa-error');
  if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
  var fd = new FormData(form);
  var code = (fd.get('code') || '').toString().trim();
  var btn = form.querySelector('button[type="submit"]');
  if (btn) btn.disabled = true;
  fetch('/api/firm/2fa/disable', {
    method: 'POST', credentials: 'include',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({code: code})
  }).then(function(res) {
    if (res.status === 401) { window.location.href = '/firm-login/'; return null; }
    return drReadJsonSafe(res).then(function(data) {
      if (btn) btn.disabled = false;
      if (!res.ok) {
        var msg = (data && data.error) ? data.error : 'Something went wrong, please try again.';
        if (errEl) { errEl.textContent = msg; errEl.hidden = false; }
        return;
      }
      drLoad2faStatus();
    });
  }).catch(function() {
    if (btn) btn.disabled = false;
    if (errEl) { errEl.textContent = 'Something went wrong, please try again.'; errEl.hidden = false; }
  });
}

// AuditLab 2FA-2 (MEDIUM, 2026-08-07): enrollment now requires step-up
// proof (the current password, same as every sibling credential-changing
// action -- see handleFirm2faEnroll's own comment) so a stolen session
// alone can never enroll 2FA with an attacker-controlled secret and lock
// the real owner out. Sent even when blank -- a magic-link-only member has
// no password to prove, and the server-side check already exempts that
// case exactly the way handleFirmChangeEmailRequest's does.
function drStart2faEnroll(form) {
  var errEl = document.getElementById('dr-2fa-error');
  if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
  var fd = new FormData(form);
  var currentPassword = (fd.get('current_password') || '').toString();
  var btn = form.querySelector('button[type="submit"]');
  if (btn) btn.disabled = true;
  fetch('/api/firm/2fa/enroll', {
    method: 'POST', credentials: 'include',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({current_password: currentPassword})
  })
    .then(function(res) {
      if (res.status === 401) { window.location.href = '/firm-login/'; return null; }
      return drReadJsonSafe(res).then(function(data) {
        if (btn) btn.disabled = false;
        if (!res.ok) {
          var msg = (data && data.error) ? data.error : 'Something went wrong, please try again.';
          if (errEl) { errEl.textContent = msg; errEl.hidden = false; }
          return;
        }
        form.hidden = true;
        drRender2faEnrollForm(data.secret, data.otpauth_uri);
      });
    }).catch(function() {
      if (btn) btn.disabled = false;
      if (errEl) { errEl.textContent = 'Something went wrong, please try again.'; errEl.hidden = false; }
    });
}

function drRender2faEnrollForm(secret, otpauthUri) {
  var wrap = document.getElementById('dr-2fa-enroll-wrap');
  if (!wrap) return;
  wrap.innerHTML =
    '<p class="signup-microcopy">Add a new account in your authenticator app (Google Authenticator, ' +
    '1Password, Authy, etc.), choose &ldquo;Enter a setup key manually&rdquo;, and enter this code:</p>' +
    '<p class="dr-2fa-secret">' + drEscapeHtml(secret) + '</p>' +
    '<p class="signup-microcopy">On a phone with the app already installed, you can instead ' +
    '<a href="' + drEscapeHtml(otpauthUri) + '">tap to add it directly</a>.</p>' +
    '<form id="dr-2fa-confirm-form">' +
      '<label for="dr-2fa-confirm-code">6-digit code from the app</label>' +
      '<input type="text" id="dr-2fa-confirm-code" name="code" required inputmode="numeric" ' +
      'pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code">' +
      '<button type="submit">Confirm and enable</button>' +
    '</form>' +
    '<p id="dr-2fa-enroll-error" role="alert" class="dr-account-err" hidden></p>' +
    '<button type="button" id="dr-2fa-cancel-enroll">Cancel</button>';
  var form = document.getElementById('dr-2fa-confirm-form');
  if (form) {
    form.addEventListener('submit', function(ev) { ev.preventDefault(); drSubmit2faEnrollConfirm(form, secret); });
  }
  var cancelBtn = document.getElementById('dr-2fa-cancel-enroll');
  if (cancelBtn) cancelBtn.addEventListener('click', function() { drLoad2faStatus(); });
}

function drSubmit2faEnrollConfirm(form, secret) {
  var errEl = document.getElementById('dr-2fa-enroll-error');
  if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
  var fd = new FormData(form);
  var code = (fd.get('code') || '').toString().trim();
  var btn = form.querySelector('button[type="submit"]');
  if (btn) btn.disabled = true;
  fetch('/api/firm/2fa/enroll/confirm', {
    method: 'POST', credentials: 'include',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({secret: secret, code: code})
  }).then(function(res) {
    if (res.status === 401) { window.location.href = '/firm-login/'; return null; }
    return drReadJsonSafe(res).then(function(data) {
      if (btn) btn.disabled = false;
      if (!res.ok) {
        var msg = (data && data.error) ? data.error : 'That code was not right. Please try again.';
        if (errEl) { errEl.textContent = msg; errEl.hidden = false; }
        return;
      }
      drRender2faBackupCodes(data.backup_codes || []);
    });
  }).catch(function() {
    if (btn) btn.disabled = false;
    if (errEl) { errEl.textContent = 'Something went wrong, please try again.'; errEl.hidden = false; }
  });
}

function drRender2faBackupCodes(codes) {
  var el = document.getElementById('dr-2fa-body');
  if (!el) return;
  el.innerHTML =
    '<p class="dr-2fa-status-line">Two-factor authentication is enabled.</p>' +
    '<div class="dr-2fa-warn">Save these backup codes somewhere safe now. Each one works once, if ' +
    'you lose access to your authenticator app. They will not be shown again.</div>' +
    '<ul class="dr-2fa-backup-codes">' +
    codes.map(function(c) { return '<li>' + drEscapeHtml(c) + '</li>'; }).join('') +
    '</ul>' +
    '<button type="button" id="dr-2fa-backup-done">I have saved these</button>';
  var doneBtn = document.getElementById('dr-2fa-backup-done');
  if (doneBtn) doneBtn.addEventListener('click', function() { drLoad2faStatus(); });
}

// Task #19 (2026-08-06): one-time post-signup feature-request prompt.
// Both "Submit" and "Skip" mark it dismissed server-side (POST
// /firm/questionnaire and /firm/questionnaire/dismiss respectively) -- the
// modal never reopens after either, only after neither has happened yet.
function drOpenQuestionnaireModal() {
  var modal = document.getElementById('dr-questionnaire-modal');
  if (!modal || !modal.hidden) return; // already open -- a second /firm/licenses
  modal.hidden = false;                // reload mid-decision must not reset the form
}

function drCloseQuestionnaireModal() {
  var modal = document.getElementById('dr-questionnaire-modal');
  if (modal) modal.hidden = true;
}

function drSubmitQuestionnaire(ev) {
  ev.preventDefault();
  var form = document.getElementById('dr-questionnaire-form');
  var errEl = document.getElementById('dr-questionnaire-error');
  var submitBtn = document.getElementById('dr-questionnaire-submit-btn');
  if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
  var checked = Array.prototype.slice.call(form.querySelectorAll('input[name="feature"]:checked'))
    .map(function(el) { return el.value; });
  var otherText = (document.getElementById('dr-questionnaire-other').value || '').trim();
  if (submitBtn) submitBtn.disabled = true;
  fetch('/api/firm/questionnaire', {
    method: 'POST', credentials: 'include',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({selected_features: checked, other_text: otherText || null})
  }).then(function(res) {
    if (submitBtn) submitBtn.disabled = false;
    if (res.status === 401) { window.location.href = '/firm-login/'; return null; }
    return drReadJsonSafe(res).then(function(data) {
      if (!res.ok) {
        if (errEl) { errEl.textContent = (data && data.error) || 'Something went wrong, please try again.'; errEl.hidden = false; }
        return;
      }
      drCloseQuestionnaireModal();
      drShowSuccess('Thanks -- that helps us decide what to build next.');
    });
  }).catch(function() {
    if (submitBtn) submitBtn.disabled = false;
    if (errEl) { errEl.textContent = 'Something went wrong, please try again.'; errEl.hidden = false; }
  });
}

function drSkipQuestionnaire() {
  var skipBtn = document.getElementById('dr-questionnaire-skip-btn');
  if (skipBtn) skipBtn.disabled = true;
  fetch('/api/firm/questionnaire/dismiss', {method: 'POST', credentials: 'include'})
    .then(function(res) {
      if (skipBtn) skipBtn.disabled = false;
      if (res.status === 401) { window.location.href = '/firm-login/'; return; }
      // Close either way -- a network hiccup on a "skip" shouldn't trap the
      // admin in the modal; worst case it just reappears next load.
      drCloseQuestionnaireModal();
    })
    .catch(function() { if (skipBtn) skipBtn.disabled = false; drCloseQuestionnaireModal(); });
}

// Task #3 (2026-08-06): self-serve account deletion. The "type your firm's
// name to confirm" gate (drCheckDeleteConfirmName) is the REAL "are you
// sure" -- deliberately not a second click/window.confirm(), which is too
// easy to reflexively dismiss for something this irreversible-in-effect.
//
// AuditLab DELMODAL-1 (2026-08-06, LOW): this was the only modal of the
// three on the dashboard with no focus management -- a keyboard user
// activating "Delete account..." landed with focus stuck behind the now-
// open modal, and closing it never returned focus to the trigger either.
// Mirrors drOpenEditModal()/drCloseEditModal()'s exact pattern (store the
// trigger button, focus the first real control on open, restore focus on
// close) rather than inventing a new one.
function drOpenDeleteAccountModal(triggerBtn) {
  var modal = document.getElementById('dr-delete-account-modal');
  if (!modal) return;
  drDeleteAccountModalTriggerBtn = triggerBtn || null;
  var nameEl = document.getElementById('dr-firm-name');
  var firmName = nameEl ? nameEl.textContent : '';
  var targetEl = document.getElementById('dr-delete-confirm-name-target');
  if (targetEl) targetEl.textContent = firmName;
  var form = document.getElementById('dr-delete-account-form');
  if (form) form.reset();
  var submitBtn = document.getElementById('dr-delete-account-submit-btn');
  if (submitBtn) submitBtn.disabled = true;
  var errEl = document.getElementById('dr-delete-account-error');
  if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
  modal.hidden = false;
  var reasonEl = document.getElementById('dr-delete-reason');
  if (reasonEl) reasonEl.focus();
}
function drCloseDeleteAccountModal() {
  var modal = document.getElementById('dr-delete-account-modal');
  if (modal) modal.hidden = true;
  if (drDeleteAccountModalTriggerBtn && document.body.contains(drDeleteAccountModalTriggerBtn)) {
    drDeleteAccountModalTriggerBtn.focus();
  }
  drDeleteAccountModalTriggerBtn = null;
}
function drCheckDeleteConfirmName() {
  var input = document.getElementById('dr-delete-confirm-name');
  var targetEl = document.getElementById('dr-delete-confirm-name-target');
  var submitBtn = document.getElementById('dr-delete-account-submit-btn');
  if (!input || !targetEl || !submitBtn) return;
  submitBtn.disabled = input.value.trim() !== targetEl.textContent.trim();
}
function drSubmitDeleteAccount(ev) {
  ev.preventDefault();
  var submitBtn = document.getElementById('dr-delete-account-submit-btn');
  if (submitBtn && submitBtn.disabled) return;
  if (submitBtn) submitBtn.disabled = true;
  var errEl = document.getElementById('dr-delete-account-error');
  if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
  var reasonEl = document.getElementById('dr-delete-reason');
  var detailEl = document.getElementById('dr-delete-detail');
  var currentPasswordEl = document.getElementById('dr-delete-current-password');
  fetch('/api/firm/account/delete', {
    method: 'POST', credentials: 'include',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({
      reason: reasonEl ? reasonEl.value : '',
      detail: detailEl ? detailEl.value : '',
      current_password: currentPasswordEl ? currentPasswordEl.value : ''
    })
  }).then(function(res) {
    if (res.status === 401) { window.location.href = '/firm-login/'; return null; }
    return drReadJsonSafe(res).then(function(data) {
      if (!res.ok) {
        var msg = (data && data.error) ? data.error : 'Something went wrong, please try again.';
        if (errEl) { errEl.textContent = msg; errEl.hidden = false; }
        if (submitBtn) submitBtn.disabled = false;
        return;
      }
      // Nothing left to load -- the account is deactivated and the session
      // that just deleted it is already dead server-side. account-deleted=1
      // lets /firm-login/ show a real confirmation instead of a blank form.
      window.location.href = '/firm-login/?account-deleted=1';
    });
  }).catch(function() {
    if (errEl) { errEl.textContent = 'Something went wrong, please try again.'; errEl.hidden = false; }
    if (submitBtn) submitBtn.disabled = false;
  });
}

// Task #29 (2026-08-05): requests an email change -- does NOT apply it.
// POST /firm/change-email only issues a confirmation token and emails a
// link to the NEW address; the actual swap happens when that link is
// clicked (handleFirmLoginVerify's email_change branch), landing back here
// via the '#account?email_changed=1' hash this same tick's DOMContentLoaded
// block now reads.
function drSubmitChangeEmail(form) {
  var okEl = document.getElementById('dr-change-email-ok');
  var errEl = document.getElementById('dr-change-email-error');
  if (okEl) { okEl.hidden = true; okEl.textContent = ''; }
  if (errEl) { errEl.hidden = true; errEl.textContent = ''; }

  var fd = new FormData(form);
  var newEmail = fd.get('new_email') || '';
  // AuditLab EMAILCHG-1 (2026-08-05): step-up auth, same field/semantics as
  // drSubmitPassword() -- only sent when non-empty, so a magic-link-only
  // firm (no password yet) isn't blocked from ever using this form.
  var changeBody = {new_email: newEmail};
  var currentPassword = fd.get('current_password');
  if (currentPassword) changeBody.current_password = currentPassword;
  var submitBtn = form.querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.disabled = true;

  fetch('/api/firm/change-email', {
    method: 'POST', credentials: 'include',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(changeBody)
  }).then(function(res) {
    if (submitBtn) submitBtn.disabled = false;
    if (res.status === 401) { window.location.href = '/firm-login/'; return null; }
    return drReadJsonSafe(res).then(function(data) {
      if (!res.ok) {
        var msg = (data && data.error) ? data.error : 'Something went wrong, please try again.';
        if (errEl) { errEl.textContent = msg; errEl.hidden = false; }
        return;
      }
      form.reset();
      if (okEl) {
        okEl.textContent = 'Check ' + newEmail + ' for a confirmation link. Nothing changes until you click it.';
        okEl.hidden = false;
      }
    });
  }).catch(function() {
    if (submitBtn) submitBtn.disabled = false;
    if (errEl) { errEl.textContent = 'Something went wrong, please try again.'; errEl.hidden = false; }
  });
}

// Roadmap #19 (2026-08-07): white-label reminder emails, lightweight scope
// (Devin's decision) -- the firm's own name (already stored) is shown in
// every reminder a firm-tracked staffer receives automatically, no setting
// needed for that part. This panel only covers the ONE thing that IS a
// setting: an optional reply-to address.
function drRenderReplyTo(email) {
  var input = document.getElementById('dr-reply-to-input');
  if (input) input.value = email || '';
}

function drSubmitReplyTo(form) {
  var okEl = document.getElementById('dr-reply-to-ok');
  var errEl = document.getElementById('dr-reply-to-error');
  if (okEl) { okEl.hidden = true; okEl.textContent = ''; }
  if (errEl) { errEl.hidden = true; errEl.textContent = ''; }

  var input = document.getElementById('dr-reply-to-input');
  var value = input ? input.value.trim() : '';
  var submitBtn = form.querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.disabled = true;

  fetch('/api/firm/reply-to', {
    method: 'PATCH', credentials: 'include',
    headers: {'Content-Type': 'application/json'},
    // Present-but-empty explicitly clears it, matching every other
    // optional-field PATCH endpoint on this dashboard (renewal_fee,
    // carryover_hours, office_tag, peer_review's own due_date).
    body: JSON.stringify({email: value || null})
  }).then(function(res) {
    if (submitBtn) submitBtn.disabled = false;
    if (res.status === 401) { window.location.href = '/firm-login/'; return null; }
    return drReadJsonSafe(res).then(function(data) {
      if (!res.ok) {
        var msg = (data && data.error) ? data.error : 'Something went wrong, please try again.';
        if (errEl) { errEl.textContent = msg; errEl.hidden = false; }
        return;
      }
      drRenderReplyTo(data.reply_to_email);
      if (okEl) { okEl.textContent = data.reply_to_email ? 'Saved.' : 'Cleared.'; okEl.hidden = false; }
    });
  }).catch(function() {
    if (submitBtn) submitBtn.disabled = false;
    if (errEl) { errEl.textContent = 'Something went wrong, please try again.'; errEl.hidden = false; }
  });
}

// Roadmap #23 (2026-08-07): customizable reminder cadence, scoped to a
// SUBSET of the 6 fixed escalation points -- see migration 0039's own
// docstring for why not arbitrary day-offsets. `thresholds` is null (every
// box checked) or an array of the values this firm currently uses.
function drRenderReminderCadence(thresholds) {
  var form = document.getElementById('dr-reminder-cadence-form');
  if (!form) return;
  var boxes = form.querySelectorAll('input[name="cadence"]');
  boxes.forEach(function(box) {
    box.checked = thresholds === null || thresholds.indexOf(Number(box.value)) !== -1;
  });
}

function drSubmitReminderCadence(form) {
  var okEl = document.getElementById('dr-reminder-cadence-ok');
  var errEl = document.getElementById('dr-reminder-cadence-error');
  if (okEl) { okEl.hidden = true; okEl.textContent = ''; }
  if (errEl) { errEl.hidden = true; errEl.textContent = ''; }

  var boxes = Array.from(form.querySelectorAll('input[name="cadence"]'));
  var checked = boxes.filter(function(b) { return b.checked; }).map(function(b) { return Number(b.value); });
  if (checked.length === 0) {
    if (errEl) { errEl.textContent = 'Choose at least one reminder timing.'; errEl.hidden = false; }
    return;
  }
  // Every box checked is the same as the default (null) -- send null so a
  // firm that never touches this panel, or resets it back to everything,
  // stores the same "no customization" value a brand-new firm has.
  var allChecked = checked.length === boxes.length;
  var submitBtn = form.querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.disabled = true;

  fetch('/api/firm/reminder-cadence', {
    method: 'PATCH', credentials: 'include',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({thresholds: allChecked ? null : checked})
  }).then(function(res) {
    if (submitBtn) submitBtn.disabled = false;
    if (res.status === 401) { window.location.href = '/firm-login/'; return null; }
    return drReadJsonSafe(res).then(function(data) {
      if (!res.ok) {
        var msg = (data && data.error) ? data.error : 'Something went wrong, please try again.';
        if (errEl) { errEl.textContent = msg; errEl.hidden = false; }
        return;
      }
      drRenderReminderCadence(data.reminder_thresholds);
      if (okEl) { okEl.textContent = 'Saved.'; okEl.hidden = false; }
    });
  }).catch(function() {
    if (submitBtn) submitBtn.disabled = false;
    if (errEl) { errEl.textContent = 'Something went wrong, please try again.'; errEl.hidden = false; }
  });
}

// Roadmap #9/#319 (2026-08-08): proactive rule-change alerts, opt-out
// (defaults on) -- same load/render/submit shape as
// drRenderReminderCadence()/drSubmitReminderCadence() just above, but a
// single checkbox instead of a fieldset.
function drRenderRuleChangeAlerts(enabled) {
  var box = document.getElementById('dr-rule-change-alerts-checkbox');
  if (box) box.checked = enabled !== false;
}

function drSubmitRuleChangeAlerts(form) {
  var okEl = document.getElementById('dr-rule-change-alerts-ok');
  var errEl = document.getElementById('dr-rule-change-alerts-error');
  if (okEl) { okEl.hidden = true; okEl.textContent = ''; }
  if (errEl) { errEl.hidden = true; errEl.textContent = ''; }

  var box = document.getElementById('dr-rule-change-alerts-checkbox');
  var enabled = box ? box.checked : true;
  var submitBtn = form.querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.disabled = true;

  fetch('/api/firm/rule-change-alerts', {
    method: 'PATCH', credentials: 'include',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({enabled: enabled})
  }).then(function(res) {
    if (submitBtn) submitBtn.disabled = false;
    if (res.status === 401) { window.location.href = '/firm-login/'; return null; }
    return drReadJsonSafe(res).then(function(data) {
      if (!res.ok) {
        var msg = (data && data.error) ? data.error : 'Something went wrong, please try again.';
        if (errEl) { errEl.textContent = msg; errEl.hidden = false; }
        return;
      }
      drRenderRuleChangeAlerts(data.rule_change_alerts_enabled);
      if (okEl) { okEl.textContent = 'Saved.'; okEl.hidden = false; }
    });
  }).catch(function() {
    if (submitBtn) submitBtn.disabled = false;
    if (errEl) { errEl.textContent = 'Something went wrong, please try again.'; errEl.hidden = false; }
  });
}

// Roadmap #151 Phase 5 (2026-08-10): firm-wide admin digest, opt-out
// (defaults on for an eligible firm) -- same load/render/submit shape as
// drRenderRuleChangeAlerts()/drSubmitRuleChangeAlerts() just above.
function drRenderAdminDigest(enabled) {
  var box = document.getElementById('dr-admin-digest-checkbox');
  if (box) box.checked = enabled !== false;
}

function drSubmitAdminDigest(form) {
  var okEl = document.getElementById('dr-admin-digest-ok');
  var errEl = document.getElementById('dr-admin-digest-error');
  if (okEl) { okEl.hidden = true; okEl.textContent = ''; }
  if (errEl) { errEl.hidden = true; errEl.textContent = ''; }

  var box = document.getElementById('dr-admin-digest-checkbox');
  var enabled = box ? box.checked : true;
  var submitBtn = form.querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.disabled = true;

  fetch('/api/firm/admin-digest', {
    method: 'PATCH', credentials: 'include',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({enabled: enabled})
  }).then(function(res) {
    if (submitBtn) submitBtn.disabled = false;
    if (res.status === 401) { window.location.href = '/firm-login/'; return null; }
    return drReadJsonSafe(res).then(function(data) {
      if (!res.ok) {
        var msg = (data && data.error) ? data.error : 'Something went wrong, please try again.';
        if (errEl) { errEl.textContent = msg; errEl.hidden = false; }
        return;
      }
      drRenderAdminDigest(data.admin_digest_enabled);
      if (okEl) { okEl.textContent = 'Saved.'; okEl.hidden = false; }
    });
  }).catch(function() {
    if (submitBtn) submitBtn.disabled = false;
    if (errEl) { errEl.textContent = 'Something went wrong, please try again.'; errEl.hidden = false; }
  });
}

// Roadmap #20 (2026-08-08): Slack integration. Unlike every other
// Account-tab panel, "connect" is a plain top-level navigation (an <a
// href> to the OAuth start route, not a fetch) -- Slack's own consent
// screen has to be a real page the browser navigates to. "Disconnect" is
// the one piece that's a normal fetch-based action, same shape as
// drSubmitRuleChangeAlerts() above.
function drRenderSlackIntegration(connected, teamName, channelName) {
  var connectedEl = document.getElementById('dr-slack-connected');
  var disconnectedEl = document.getElementById('dr-slack-disconnected');
  var statusEl = document.getElementById('dr-slack-status-text');
  if (!connectedEl || !disconnectedEl) return;
  if (connected) {
    if (statusEl) {
      statusEl.textContent = 'Connected to #' + (channelName || '') + ' in ' + (teamName || 'your workspace') + '.';
    }
    connectedEl.hidden = false;
    disconnectedEl.hidden = true;
  } else {
    connectedEl.hidden = true;
    disconnectedEl.hidden = false;
  }
}

// Roadmap #21 (2026-08-08): Microsoft Teams. Unlike Slack, the webhook URL
// is write-only from the client's perspective -- the backend never sends
// it back (same "never serialize the secret" posture as Slack's own
// webhook URL), so this panel toggles between an empty input (not
// connected) and a plain "Connected" status + Clear button, rather than
// pre-filling a saved value the way drRenderReplyTo() does for the
// non-secret reply-to email.
function drRenderTeamsIntegration(connected) {
  var connectedEl = document.getElementById('dr-teams-connected');
  var disconnectedEl = document.getElementById('dr-teams-disconnected');
  if (!connectedEl || !disconnectedEl) return;
  connectedEl.hidden = !connected;
  disconnectedEl.hidden = connected;
  if (!connected) {
    var input = document.getElementById('dr-teams-webhook-input');
    if (input) input.value = '';
  }
}

function drSubmitTeamsWebhook(form) {
  var okEl = document.getElementById('dr-teams-ok');
  var errEl = document.getElementById('dr-teams-error');
  if (okEl) { okEl.hidden = true; okEl.textContent = ''; }
  if (errEl) { errEl.hidden = true; errEl.textContent = ''; }

  var input = document.getElementById('dr-teams-webhook-input');
  var value = input ? input.value.trim() : '';
  if (!value) {
    if (errEl) { errEl.textContent = 'Paste the webhook URL from your Teams workflow first.'; errEl.hidden = false; }
    return;
  }
  var submitBtn = form.querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.disabled = true;

  fetch('/api/firm/integrations/teams', {
    method: 'PATCH', credentials: 'include',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({webhook_url: value})
  }).then(function(res) {
    if (submitBtn) submitBtn.disabled = false;
    if (res.status === 401) { window.location.href = '/firm-login/'; return null; }
    return drReadJsonSafe(res).then(function(data) {
      if (!res.ok) {
        var msg = (data && data.error) ? data.error : 'Something went wrong, please try again.';
        if (errEl) { errEl.textContent = msg; errEl.hidden = false; }
        return;
      }
      drRenderTeamsIntegration(true);
      if (okEl) { okEl.textContent = 'Saved.'; okEl.hidden = false; }
    });
  }).catch(function() {
    if (submitBtn) submitBtn.disabled = false;
    if (errEl) { errEl.textContent = 'Something went wrong, please try again.'; errEl.hidden = false; }
  });
}

function drTeamsClear() {
  var okEl = document.getElementById('dr-teams-ok');
  var errEl = document.getElementById('dr-teams-error');
  if (okEl) { okEl.hidden = true; okEl.textContent = ''; }
  if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
  var btn = document.getElementById('dr-teams-clear-btn');
  if (btn) btn.disabled = true;

  fetch('/api/firm/integrations/teams', {
    method: 'PATCH', credentials: 'include',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({webhook_url: null})
  }).then(function(res) {
    if (btn) btn.disabled = false;
    if (res.status === 401) { window.location.href = '/firm-login/'; return null; }
    return drReadJsonSafe(res).then(function(data) {
      if (!res.ok) {
        var msg = (data && data.error) ? data.error : 'Something went wrong, please try again.';
        if (errEl) { errEl.textContent = msg; errEl.hidden = false; }
        return;
      }
      drRenderTeamsIntegration(false);
      if (okEl) { okEl.textContent = 'Cleared.'; okEl.hidden = false; }
    });
  }).catch(function() {
    if (btn) btn.disabled = false;
    if (errEl) { errEl.textContent = 'Something went wrong, please try again.'; errEl.hidden = false; }
  });
}

function drSlackDisconnect() {
  var okEl = document.getElementById('dr-slack-ok');
  var errEl = document.getElementById('dr-slack-error');
  if (okEl) { okEl.hidden = true; okEl.textContent = ''; }
  if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
  var btn = document.getElementById('dr-slack-disconnect-btn');
  if (btn) btn.disabled = true;

  fetch('/api/firm/integrations/slack/disconnect', {
    method: 'POST', credentials: 'include',
    headers: {'Content-Type': 'application/json'}
  }).then(function(res) {
    if (btn) btn.disabled = false;
    if (res.status === 401) { window.location.href = '/firm-login/'; return null; }
    return drReadJsonSafe(res).then(function(data) {
      if (!res.ok) {
        var msg = (data && data.error) ? data.error : 'Something went wrong, please try again.';
        if (errEl) { errEl.textContent = msg; errEl.hidden = false; }
        return;
      }
      drRenderSlackIntegration(false, null, null);
      if (okEl) { okEl.textContent = 'Disconnected.'; okEl.hidden = false; }
    });
  }).catch(function() {
    if (btn) btn.disabled = false;
    if (errEl) { errEl.textContent = 'Something went wrong, please try again.'; errEl.hidden = false; }
  });
}

// Roadmap #25 (2026-08-07): in-app notification center. Purely a more
// portable way to surface what "Staff at risk" (drRenderAtRisk) and the CPE
// Hours tab's own behind-on-hours flag already compute -- same 30-day-or-
// unresolved definition drRenderStats()/drRenderAtRisk() already use for
// "at risk" (deliberately not a THIRD threshold), reachable from a bell
// icon in the sidebar rather than only from the Roster overview tab.
//
// Reported live 2026-08-07: no way to clear/dismiss items -- the badge only
// ever dropped by actually resolving the underlying condition (renew, log
// CPE hours). Added a per-item, browser-local dismiss (localStorage, not
// server-side -- this mirrors a live status, not a durable event log, so
// there's nothing meaningful to sync across devices). Each item is keyed by
// subscriber+type and stamped with a SIGNATURE of the value that would make
// the dismissal stale: the exact next_deadline date for a deadline item,
// hours-logged-so-far for a CPE item. Dismissing hides it until that
// underlying value actually changes, not just until the next page load --
// marking renewed changes next_deadline (a fresh signature, item
// re-surfaces if still due soon under the new date); logging more CPE
// hours changes the hours signature and re-surfaces the item only if still
// behind after the new entry.
var DR_NOTIF_DISMISS_KEY = 'dr_notif_dismissed';
var drCurrentNotifItems = [];

function drGetDismissedNotifs() {
  try {
    var raw = window.localStorage.getItem(DR_NOTIF_DISMISS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    return {};
  }
}

function drSetDismissedNotifs(map) {
  try {
    window.localStorage.setItem(DR_NOTIF_DISMISS_KEY, JSON.stringify(map));
  } catch (e) {
    // Storage unavailable (private browsing, quota) -- the dismissal just
    // won't persist across reloads. Not worth surfacing as an error for a
    // purely cosmetic feature.
  }
}

function drDismissNotif(id, sig) {
  var map = drGetDismissedNotifs();
  map[id] = sig;
  drSetDismissedNotifs(map);
  drRenderNotifications();
}

function drDismissAllNotifs() {
  var map = drGetDismissedNotifs();
  drCurrentNotifItems.forEach(function(n) { map[n.id] = n.sig; });
  drSetDismissedNotifs(map);
  drRenderNotifications();
}

function drComputeNotifications() {
  var items = [];
  drLicenses.forEach(function(item) {
    if (item.status === 'opted_out') return;
    var days = drDaysUntil(item.next_deadline);
    if (days === null || days <= 30) {
      var daysLabel = days === null ? 'Unresolved deadline' : days < 0 ? 'Overdue' : days === 0 ? 'Due today' : 'Due in ' + days + 'd';
      items.push({
        id: 'deadline:' + item.id,
        sig: String(item.next_deadline),
        view: 'roster',
        title: (item.staff_label || item.email) + ' — ' + daysLabel,
        sub: item.state_name || ''
      });
    }
    var p = drCpeProgressForSubscriber(item);
    if (p.hasRequirement && p.behind) {
      items.push({
        id: 'cpe:' + item.id,
        sig: p.totalLogged + ':' + p.ethicsLogged,
        view: 'cpe',
        title: (item.staff_label || item.email) + ' — behind on CPE hours',
        sub: item.state_name || ''
      });
    }
  });
  return items;
}

function drRenderNotifications() {
  var badge = document.getElementById('dr-notif-badge');
  var body = document.getElementById('dr-notif-panel-body');
  if (!badge || !body) return;
  var dismissed = drGetDismissedNotifs();
  var items = drComputeNotifications().filter(function(n) { return dismissed[n.id] !== n.sig; });
  drCurrentNotifItems = items;
  badge.textContent = String(items.length);
  badge.hidden = items.length === 0;
  if (items.length === 0) {
    body.innerHTML = '<p class="dr-panel-empty">Nothing needs your attention right now.</p>';
    return;
  }
  var headHtml = '<div class="dr-notif-panel-head"><span>' + items.length + ' item' + (items.length === 1 ? '' : 's') +
    '</span><button type="button" class="dr-link-btn" id="dr-notif-dismiss-all-btn">Dismiss all</button></div>';
  body.innerHTML = headHtml + items.map(function(n) {
    return '<div class="dr-notif-item-row"><a href="#" class="dr-notif-item" data-view="' + n.view + '">' + drEscapeHtml(n.title) +
      (n.sub ? '<span class="dr-notif-item-sub">' + drEscapeHtml(n.sub) + '</span>' : '') + '</a>' +
      '<button type="button" class="dr-notif-dismiss-btn" data-notif-id="' + drEscapeHtml(n.id) + '" data-notif-sig="' + drEscapeHtml(n.sig) +
      '" aria-label="Dismiss: ' + drEscapeHtml(n.title) + '">&times;</button></div>';
  }).join('');
}

function drCloseNotifications() {
  var panel = document.getElementById('dr-notif-panel');
  var btn = document.getElementById('dr-notif-bell-btn');
  if (panel) panel.hidden = true;
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

// ValueLab customer-walkthrough finding (2026-08-10): a fresh login
// (including the demo) landing straight on this page's first
// /firm/licenses call sometimes 401s once, immediately after a genuinely
// successful login, then bounces to /firm-login/ with no explanation --
// the session IS real (confirmed: D1 rows exist, a retried request or a
// subsequent page load succeeds) so this reads as a transient race, not
// an actually-invalid session. One retry after a short delay before
// concluding the session is really gone -- costs ~300ms only on this
// already-rare error path, never affects the normal case.
function drLoadLicensesInner(isRetry) {
  return fetch('/api/firm/licenses', {credentials: 'include'})
    .then(function(res) {
      if (res.status === 401) {
        if (!isRetry) {
          return new Promise(function(resolve) { setTimeout(resolve, 300); })
            .then(function() { return drLoadLicensesInner(true); });
        }
        window.location.href = '/firm-login/';
        return null;
      }
      // Roster/Calendar/CPE Hours are a standing free tier with no
      // entitlement gate (2026-08-06) -- /firm/licenses only ever 401s (no
      // session) or 403s via requireFirmSession()'s own inactive/suspended
      // check, which falls through to the generic fallback below.
      if (!res.ok) {
        drShowError('Something went wrong loading your roster. Please try again.');
        return null;
      }
      return res.json();
    });
}

function drLoadLicenses() {
  drClearError();
  drLoadLicensesInner(false)
    .then(function(data) {
      if (!data) return;
      // Roadmap #29: real data always wins -- a stale sample view (e.g. a
      // background tab left open) can never survive past the moment a real
      // load resolves, even if the admin never clicked "Exit sample view".
      if (drSampleModeActive) {
        drSampleModeActive = false;
        var sampleBanner = document.getElementById('dr-sample-mode-banner');
        if (sampleBanner) sampleBanner.hidden = true;
        var samplePrintNotice = document.getElementById('dr-print-sample-notice');
        if (samplePrintNotice) samplePrintNotice.hidden = true;
      }
      drLicenses = data.licenses || [];
      drPreviousLoginAt = data.previous_login_at || null;
      drNpsPromptDue = Boolean(data.nps_prompt_due);
      drSeatCap = typeof data.seat_cap === 'number' ? data.seat_cap : null;
      // Roadmap #151 Phase 4: real server-computed value, replacing the
      // optimistic `true` default set above -- read by drRenderStats()/
      // drRenderAtRisk() below.
      drDashboardSynthesisIncluded = Boolean(data.dashboard_synthesis_included);
      drBilling = {
        planTier: data.plan_tier || 'free',
        cancelAtPeriodEnd: Boolean(data.cancel_at_period_end),
        currentPeriodEnd: data.current_period_end || null,
        demoLocked: Boolean(data.demo_locked)
      };
      drRole = data.role || 'partner';
      drMemberId = data.member_id || null;
      drRenderFirmName(data.firm_name);
      drRenderCurrentEmail(data.admin_email);
      drRenderStalenessBanner(data.data_as_of, data.data_stale);
      drRenderDemoBanner(Boolean(data.demo_locked));
      drRenderAccountLockdown();
      // Task #19 (2026-08-06): one-time post-signup feature-request prompt.
      // Checked on every load (not just the very first) since
      // questionnaire_pending stays true until a real submit or an
      // explicit skip -- a firm that closes the tab mid-decision sees it
      // again next time, same as it would have the first time.
      if (data.questionnaire_pending) drOpenQuestionnaireModal();
      // Roadmap #30: only auto-starts once the questionnaire modal is no
      // longer pending -- a brand-new firm's very first load would
      // otherwise show the modal AND the tour's tooltip at once. The tour
      // simply waits for the NEXT load (any later page visit) rather than
      // fighting the modal for attention on this one.
      if (!data.questionnaire_pending && data.product_tour_pending) drStartProductTour();
      // Roadmap #144: same "wait its turn" precedence as the tour just
      // above -- a brand-new firm's first-ever load has BOTH the
      // questionnaire and nps_prompt_due true (never prompted for either
      // yet); only shows once neither onboarding prompt is still pending,
      // so it never competes with those for attention on the same load.
      if (!data.questionnaire_pending && !data.product_tour_pending) drMaybeShowNpsPrompt();
      // Roadmap #28: pending flag is server-side/durable, but the CPE step
      // needs drCpeEntries, not loaded yet at this point in the function --
      // rendered again once drLoadCpeEntries() resolves, below.
      drOnboardingChecklistPending = Boolean(data.onboarding_checklist_pending);
      drRenderOnboardingChecklist();
      drRenderBillingPanel();
      drRenderMapValueCallout();
      drRenderLastLoginBanner();
      // Roadmap #6: firm-level, so this comes from the same /firm/licenses
      // response but isn't part of drLicenses/drRenderStats at all.
      drPeerReviewDueDate = data.peer_review_due_date || null;
      drRenderPeerReview();
      // Roadmap #19: same "firm-level, comes from this same response" note
      // as peer_review_due_date above.
      drRenderReplyTo(data.reply_to_email || null);
      // Roadmap #23: same note.
      drRenderReminderCadence(data.reminder_thresholds || null);
      // Roadmap #9/#319: same note.
      drRenderRuleChangeAlerts(data.rule_change_alerts_enabled);
      // Roadmap #151 Phase 5: same note.
      drRenderAdminDigest(data.admin_digest_enabled);
      // Roadmap #20: same note.
      drRenderSlackIntegration(Boolean(data.slack_connected), data.slack_team_name, data.slack_channel_name);
      // Roadmap #21: same note.
      drRenderTeamsIntegration(Boolean(data.teams_connected));
      // Roadmap #31: same note.
      drRenderReferralPanel(data.referral_link || null, data.referral_code_uses_remaining || 0, data.referral_reward_count || 0);
      drRenderTable();
      drRenderStats();
      drRenderRenewalFeeRollup();
      drRenderAtRisk();
      drRenderNotifications();
      drRenderCalendar();
      drRenderAgenda();
      drPopulateMapStaffSelect();
      // Completions loaded BEFORE the first map paint so
      // drApplyMobilityResults() never renders a stale (pre-completion)
      // color for the initial view -- a later reload from drMarkMobility-
      // Complete() doesn't need this ordering since drMobilityCompletions
      // is already populated by then.
      drLoadMobilityCompletions().then(drRenderMapForSelection);
      // 2026-08-09, Devin's live report ("this notification keeps coming up
      // after I dismiss it, when I leave the dashboard and come back"):
      // drRenderNotifications() just above runs off whatever drCpeEntries
      // held BEFORE this load started -- on a fresh page visit that's still
      // [] (drCpeEntries only becomes real data once THIS fetch resolves),
      // so every subscriber with a CPE requirement looks like they've
      // logged 0 hours and gets a bogus "behind on CPE hours" notification
      // stamped with sig "0:0". That sig never matches a real dismissal
      // (e.g. "38:2"), so a genuinely-dismissed item reappears on every
      // single page load, and nothing ever re-rendered it correctly once
      // the real entries arrived. Chained onto the same
      // drLoadCpeEntries().then() the onboarding checklist already uses
      // right below for this exact "needs drCpeEntries, not loaded yet"
      // reason.
      drLoadCpeEntries().then(function() { drRenderOnboardingChecklist(); drRenderNotifications(); });
      drLoadActivity();
      drLoadAuditTrail();
      drLoadTeam();
    })
    .catch(function() {
      drShowError('Something went wrong loading your roster. Please try again.');
    });
}

function drRenewLicense(id, btn, label) {
  // AuditLab IDEM-2 (LOW, 2026-08-04): a double-clicked "Mark renewed"
  // reached the server twice, advancing `cycle` twice and burning both
  // unsubscribe/renewed tokens the first response minted before anything
  // could use them. Guard is on the BUTTON, not just a debounce timer --
  // if btn is already disabled, this is a second dispatch of the same
  // click (or a fast double-click) and must be dropped before it ever
  // reaches fetch(). Re-enabling only happens in the error paths: on
  // success drLoadLicenses() re-renders the whole table, which replaces
  // this button (and its disabled state) along with everything else.
  if (btn && btn.disabled) return;
  if (btn) btn.disabled = true;
  drClearError();
  fetch('/api/firm/licenses/' + encodeURIComponent(id) + '/renew', {method: 'POST', credentials: 'include'})
    .then(function(res) {
      if (res.status === 401) { window.location.href = '/firm-login/'; return null; }
      return drReadJsonSafe(res).then(function(data) {
        if (!res.ok) {
          drShowError(data && data.error ? data.error : 'Something went wrong, please try again.');
          if (btn) btn.disabled = false;
          return;
        }
        // Reported directly, 2026-08-04: clicking this gave no toast, no
        // error, no visible change -- indistinguishable from doing nothing.
        // The write DID succeed (renewed_at is now a real column, migration
        // 0017); a fixed-calendar state's computed next deadline correctly
        // does not move just because someone renewed early, so this
        // confirmation is the only signal a CPA has that the click landed.
        drShowSuccess((label || 'Staff member') + ' marked renewed.');
        drLoadLicenses();
      });
    })
    .catch(function() {
      drShowError('Something went wrong, please try again.');
      if (btn) btn.disabled = false;
    });
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
        drShowSuccess((label || 'Staff member') + ' removed from the roster.');
        drLoadLicenses();
      });
    })
    .catch(function() { drShowError('Something went wrong, please try again.'); });
}

// Edit-staff modal (2026-08-06, replaced inline in-row edit -- see the CSS
// comment on .dr-modal-overlay for why). drEditModalTriggerBtn is the Edit
// button that opened the modal, so closing it (Cancel, Escape, backdrop
// click, or a successful Save) returns focus there instead of dropping it
// to <body>, same as any well-behaved modal.
function drOpenEditModal(item, triggerBtn) {
  var modal = document.getElementById('dr-edit-modal');
  var labelInput = document.getElementById('dr-edit-modal-label');
  var emailInput = document.getElementById('dr-edit-modal-email');
  var title = document.getElementById('dr-edit-modal-title');
  var deadlineField = document.getElementById('dr-edit-modal-deadline-field');
  var deadlineInput = document.getElementById('dr-edit-modal-deadline');
  if (!modal || !labelInput || !emailInput) return;
  drEditModalId = item.id;
  drEditModalTriggerBtn = triggerBtn || null;
  labelInput.value = item.staff_label || '';
  emailInput.value = item.email || '';
  // "Bring your own date" records (see the CSS comment on
  // .dr-modal-hint) are the only ones with an editable deadline -- every
  // other record's deadline is state-rule-computed, and the PATCH endpoint
  // itself ignores a raw date for those, so there's nothing useful for this
  // field to do there.
  var isOwnDate = item.deadline_source === 'user';
  if (deadlineField) deadlineField.hidden = !isOwnDate;
  if (deadlineInput) {
    deadlineInput.value = isOwnDate && item.next_deadline ? item.next_deadline : '';
    deadlineInput.required = isOwnDate;
    // Same-day UX nicety only (matches the public signup form's own
    // license_expiration_date field) -- the PATCH endpoint's own
    // resolveDeadlineInput() is the real, authoritative "not in the past"
    // check regardless of what the browser enforces.
    if (isOwnDate) {
      var todayLocal = new Date();
      deadlineInput.min = new Date(todayLocal.getFullYear(), todayLocal.getMonth(), todayLocal.getDate() + 1)
        .toISOString().slice(0, 10);
    }
  }
  var feeInput = document.getElementById('dr-edit-modal-fee');
  if (feeInput) {
    feeInput.value = (typeof item.renewal_fee_cents === 'number') ? (item.renewal_fee_cents / 100).toFixed(2) : '';
  }
  var carryoverInput = document.getElementById('dr-edit-modal-carryover');
  if (carryoverInput) {
    carryoverInput.value = (typeof item.carryover_hours === 'number') ? String(item.carryover_hours) : '';
  }
  var carryoverNote = document.getElementById('dr-edit-modal-carryover-note');
  if (carryoverNote) {
    // Roadmap #10: the state's own already-published carryover sentence
    // (from data/cpe_hours.json's notes, republished verbatim -- see
    // cpe_requirements_json's own comment for why this is safe to show
    // without asserting a new structured claim), shown only when this
    // state actually has one on file.
    var req = DR_CPE_REQUIREMENTS[item.state_slug];
    var note = req ? req.carryover_note : null;
    carryoverNote.textContent = note ? ('This state: ' + note) : '';
    carryoverNote.hidden = !note;
  }
  var officeInput = document.getElementById('dr-edit-modal-office');
  if (officeInput) officeInput.value = item.office_tag || '';
  var notesInput = document.getElementById('dr-edit-modal-notes');
  if (notesInput) notesInput.value = item.internal_notes || '';
  if (title) title.textContent = 'Edit ' + (item.staff_label || item.email);
  drClearError();
  drClearWarning();
  modal.hidden = false;
  labelInput.focus();
}

function drCloseEditModal() {
  var modal = document.getElementById('dr-edit-modal');
  if (modal) modal.hidden = true;
  drEditModalId = null;
  if (drEditModalTriggerBtn && document.body.contains(drEditModalTriggerBtn)) {
    drEditModalTriggerBtn.focus();
  }
  drEditModalTriggerBtn = null;
}

function drSubmitEditModal(ev) {
  if (ev) ev.preventDefault();
  if (!drEditModalId) return;
  drClearError();
  drClearWarning();
  var labelInput = document.getElementById('dr-edit-modal-label');
  var emailInput = document.getElementById('dr-edit-modal-email');
  var deadlineField = document.getElementById('dr-edit-modal-deadline-field');
  var deadlineInput = document.getElementById('dr-edit-modal-deadline');
  var email = emailInput ? emailInput.value.trim() : '';
  if (!email) { drShowError('Email is required.'); return; }
  var body = {staff_label: labelInput ? labelInput.value.trim() : '', email: email};
  // Only sent for "bring your own date" records (the field is hidden for
  // everyone else) -- omitting the key entirely for a computed-cadence
  // record matters, not just hiding the input: sending it would make the
  // PATCH handler re-resolve the deadline at all, which server-side ignores
  // a raw date for a computable state and can 400 instead of a harmless no-op.
  if (deadlineField && !deadlineField.hidden) {
    var deadlineValue = deadlineInput ? deadlineInput.value : '';
    if (!deadlineValue) { drShowError('License expiration date is required.'); return; }
    body.license_expiration_date = deadlineValue;
  }
  var feeInput = document.getElementById('dr-edit-modal-fee');
  // Roadmap #7: always sent (even empty), unlike the deadline field above --
  // an empty string here is a real, meaningful "clear the fee" instruction
  // the PATCH handler already supports, not an omission to avoid.
  body.renewal_fee = feeInput ? feeInput.value.trim() : '';
  var carryoverInput = document.getElementById('dr-edit-modal-carryover');
  // Roadmap #10: same always-sent, empty-string-clears convention as renewal_fee above.
  body.carryover_hours = carryoverInput ? carryoverInput.value.trim() : '';
  var officeInput = document.getElementById('dr-edit-modal-office');
  // Roadmap #16: same always-sent, empty-string-clears convention.
  body.office_tag = officeInput ? officeInput.value.trim() : '';
  var notesInput = document.getElementById('dr-edit-modal-notes');
  // Roadmap #68: same always-sent, empty-string-clears convention.
  body.internal_notes = notesInput ? notesInput.value.trim() : '';
  var id = drEditModalId;
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
      if (data && data.duplicate_email_warning) { drShowWarning(data.duplicate_email_warning); }
      drShowSuccess((body.staff_label || body.email) + ' updated.');
      drCloseEditModal();
      drLoadLicenses();
    });
  }).catch(function() { drShowError('Something went wrong, please try again.'); });
}

// ---------------------------------------------------------------------------
// Document storage (2026-08-07, roadmap #1/#2). Same modal open/close/
// focus-restore pattern as drOpenEditModal/drCloseEditModal above.
// ---------------------------------------------------------------------------
var drDocumentsModalSubscriberId = null;
var drDocumentsModalTriggerBtn = null;

function drOpenDocumentsModal(subscriberId, who, triggerBtn) {
  var modal = document.getElementById('dr-documents-modal');
  var title = document.getElementById('dr-documents-modal-title');
  var errEl = document.getElementById('dr-documents-error');
  var fileInput = document.getElementById('dr-documents-file');
  if (!modal) return;
  drDocumentsModalSubscriberId = subscriberId;
  drDocumentsModalTriggerBtn = triggerBtn || null;
  if (title) title.textContent = 'Documents for ' + who;
  if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
  if (fileInput) fileInput.value = '';
  modal.hidden = false;
  drLoadDocumentsList();
  var kindSelect = document.getElementById('dr-documents-kind');
  if (kindSelect) kindSelect.focus();
}

function drCloseDocumentsModal() {
  var modal = document.getElementById('dr-documents-modal');
  if (modal) modal.hidden = true;
  drDocumentsModalSubscriberId = null;
  if (drDocumentsModalTriggerBtn && document.body.contains(drDocumentsModalTriggerBtn)) {
    drDocumentsModalTriggerBtn.focus();
  }
  drDocumentsModalTriggerBtn = null;
}

function drRenderDocumentsList(documents) {
  var el = document.getElementById('dr-documents-list');
  if (!el) return;
  if (documents.length === 0) {
    el.innerHTML = '<p class="dr-panel-empty">No documents uploaded yet.</p>';
    return;
  }
  el.innerHTML = documents.map(function(doc) {
    var kindLabel = doc.kind === 'cpe' ? 'CPE certificate' : 'License certificate';
    var sizeKb = Math.max(1, Math.round(doc.size_bytes / 1024));
    var uploadedDate = drEscapeHtml(drFormatDeadline(String(doc.uploaded_at).slice(0, 10)));
    return '<div class="dr-document-item"><span><b>' + drEscapeHtml(doc.filename) + '</b> &mdash; ' +
      drEscapeHtml(kindLabel) + ', ' + sizeKb + 'KB' +
      '<span class="dr-agenda-date" style="display:block;">' + uploadedDate + '</span></span>' +
      '<span><a href="/api/firm/documents/' + encodeURIComponent(doc.id) + '/download" target="_blank" rel="noopener">Download</a> ' +
      '<button type="button" class="dr-document-remove" data-id="' + drEscapeHtml(doc.id) + '" data-label="' + drEscapeHtml(doc.filename) + '" aria-label="Remove ' + drEscapeHtml(doc.filename) + '">Remove</button></span></div>';
  }).join('');
}

function drLoadDocumentsList() {
  var el = document.getElementById('dr-documents-list');
  if (!drDocumentsModalSubscriberId) return;
  if (el) el.innerHTML = '<p class="dr-panel-empty">Loading&hellip;</p>';
  fetch('/api/firm/licenses/' + encodeURIComponent(drDocumentsModalSubscriberId) + '/documents', {credentials: 'include'})
    .then(function(res) {
      if (res.status === 401) { window.location.href = '/firm-login/'; return null; }
      if (!res.ok) return null;
      return res.json();
    })
    .then(function(data) {
      drRenderDocumentsList((data && data.documents) || []);
    })
    .catch(function() {
      if (el) el.innerHTML = '<p class="dr-panel-empty">Something went wrong loading documents.</p>';
    });
}

function drSubmitDocumentUpload(ev) {
  if (ev) ev.preventDefault();
  if (!drDocumentsModalSubscriberId) return;
  var errEl = document.getElementById('dr-documents-error');
  var fileInput = document.getElementById('dr-documents-file');
  var kindSelect = document.getElementById('dr-documents-kind');
  if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
  var file = fileInput && fileInput.files ? fileInput.files[0] : null;
  if (!file) {
    if (errEl) { errEl.textContent = 'Choose a file first.'; errEl.hidden = false; }
    return;
  }
  var formData = new FormData();
  formData.append('file', file);
  formData.append('kind', kindSelect ? kindSelect.value : 'license');
  var submitBtn = document.querySelector('#dr-documents-upload-form button[type="submit"]');
  if (submitBtn) submitBtn.disabled = true;
  fetch('/api/firm/licenses/' + encodeURIComponent(drDocumentsModalSubscriberId) + '/documents', {
    method: 'POST', credentials: 'include', body: formData
  }).then(function(res) {
    if (res.status === 401) { window.location.href = '/firm-login/'; return null; }
    return drReadJsonSafe(res).then(function(data) {
      if (!res.ok) {
        if (errEl) { errEl.textContent = (data && data.error) ? data.error : 'Something went wrong, please try again.'; errEl.hidden = false; }
        return;
      }
      if (fileInput) fileInput.value = '';
      drLoadDocumentsList();
    });
  }).catch(function() {
    if (errEl) { errEl.textContent = 'Something went wrong, please try again.'; errEl.hidden = false; }
  }).finally(function() {
    if (submitBtn) submitBtn.disabled = false;
  });
}

function drRemoveDocument(id, label) {
  if (!window.confirm('Remove "' + label + '"? This cannot be undone.')) return;
  fetch('/api/firm/documents/' + encodeURIComponent(id), {method: 'DELETE', credentials: 'include'})
    .then(function(res) {
      if (res.status === 401) { window.location.href = '/firm-login/'; return; }
      drLoadDocumentsList();
    })
    .catch(function() {});
}

// ---------------------------------------------------------------------------
// Roadmap #5 (2026-08-07): new-hire multi-state onboarding checklist. Shown
// once, right after a successful add-staff submit, for that one person --
// reuses the SAME already-reviewed mobility engine the Map/Practice
// Privilege Check pages already call (POST /firm/mobility/check-batch), no
// new legal-determination logic. Deliberately read-only and non-durable
// (no dismiss flag persisted anywhere) -- this is a one-time nudge tied to
// the moment of adding someone, not a standing dashboard fixture like the
// onboarding checklist (#28) or product tour (#30).
// ---------------------------------------------------------------------------
function drDismissNewHireChecklist() {
  var panel = document.getElementById('dr-new-hire-checklist');
  if (panel) panel.hidden = true;
}

function drShowNewHireChecklist(record) {
  var panel = document.getElementById('dr-new-hire-checklist');
  var title = document.getElementById('dr-new-hire-checklist-title');
  var body = document.getElementById('dr-new-hire-checklist-body');
  if (!panel || !body || !record || !record.state_slug) return;
  var who = record.staff_label || record.email;
  if (title) title.textContent = 'Multi-state checklist for ' + who;
  body.innerHTML = '<p class="dr-panel-empty">Checking multistate practice privilege&hellip;</p>';
  panel.hidden = false;
  drScrollBannerIntoView(panel);

  fetch('/api/firm/mobility/check-batch', {
    method: 'POST', credentials: 'include',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      home_state_slug: record.state_slug,
      service_type: DR_MOBILITY_SERVICE_TYPE,
      license_in_good_standing: true,
      substantially_equivalent: true
    })
  }).then(function(res) {
    if (res.status === 401) { window.location.href = '/firm-login/'; return null; }
    if (res.status === 403) {
      // Free tier -- same discoverability posture the Map already uses
      // (still visible, plainly labeled as paid) rather than hiding this
      // panel outright.
      body.innerHTML = '<p class="dr-panel-empty">See where ' + drEscapeHtml(who) +
        ' can already practice in other states without extra paperwork &mdash; that is part of the ' +
        'paid plan. <a href="/pricing/">See plans</a>.</p>';
      return null;
    }
    return drReadJsonSafe(res).then(function(data) {
      if (!res.ok || !data) {
        body.innerHTML = '<p class="dr-panel-empty">Could not check multistate practice privilege right now.</p>';
        return;
      }
      var clear = [], actionRequired = [];
      (data.results || []).forEach(function(r) {
        if (r.overall === 'clear') clear.push(r);
        else if (r.overall === 'action_required') actionRequired.push(r);
      });
      if (clear.length === 0 && actionRequired.length === 0) {
        body.innerHTML = '<p class="dr-panel-empty">No verified multistate practice-privilege data for ' +
          drEscapeHtml(record.state_name || '') + ' yet.</p>';
        return;
      }
      function stateLink(r) {
        var href = '/firm-mobility/?home=' + encodeURIComponent(record.state_slug) +
          '&target=' + encodeURIComponent(r.target_state_slug) +
          '&service=' + encodeURIComponent(DR_MOBILITY_SERVICE_TYPE) +
          '&staff=' + encodeURIComponent(record.id);
        return '<a href="' + href + '">' + drEscapeHtml(r.target_state) + '</a>';
      }
      var html = '';
      if (clear.length > 0) {
        html += '<p><strong>Already clear to practice in ' + clear.length + ' other state' + (clear.length === 1 ? '' : 's') + ':</strong> ' +
          clear.slice(0, 10).map(stateLink).join(', ') + (clear.length > 10 ? ', &hellip;' : '') + '</p>';
      }
      if (actionRequired.length > 0) {
        html += '<p><strong>Needs a state-specific step first in ' + actionRequired.length + ' state' + (actionRequired.length === 1 ? '' : 's') + ':</strong> ' +
          actionRequired.slice(0, 10).map(stateLink).join(', ') + (actionRequired.length > 10 ? ', &hellip;' : '') + '</p>';
      }
      html += '<p class="dr-panel-empty">Assumes an active license in good standing and substantial equivalence. Click a state for the exact requirement, or see the full <a href="/firm-mobility/">Practice Privilege Check</a>.</p>';
      body.innerHTML = html;
    });
  }).catch(function() {
    body.innerHTML = '<p class="dr-panel-empty">Could not check multistate practice privilege right now.</p>';
  });
}

// ---------------------------------------------------------------------------
// Roadmap #6 (2026-08-07): firm-level peer-review deadline tracking. A
// single admin-entered "bring your own date" field (same posture as a
// roster record with no computable state rule) -- this product does not
// attempt to compute peer-review cadence, which varies too much by state/
// situation to guess at safely.
// ---------------------------------------------------------------------------
var drPeerReviewDueDate = null;
var drPeerReviewEditing = false;

function drRenderPeerReview() {
  var el = document.getElementById('dr-peer-review-body');
  if (!el) return;
  if (drPeerReviewEditing) {
    el.innerHTML = '<label for="dr-peer-review-input" class="dr-visually-hidden">Peer review due date</label>' +
      '<input type="date" id="dr-peer-review-input" value="' + drEscapeHtml(drPeerReviewDueDate || '') + '"> ' +
      '<button type="button" class="dr-btn-edit" id="dr-peer-review-save-btn">Save</button> ' +
      '<button type="button" class="dr-btn-cancel" id="dr-peer-review-cancel-btn">Cancel</button>' +
      (drPeerReviewDueDate ? ' <button type="button" class="dr-btn-cancel" id="dr-peer-review-clear-btn">Clear</button>' : '');
    return;
  }
  if (!drPeerReviewDueDate) {
    el.innerHTML = '<p class="dr-panel-empty">Not tracked yet. <button type="button" class="dr-link-btn" id="dr-peer-review-edit-btn">Set a date</button></p>';
    return;
  }
  var days = drDaysUntil(drPeerReviewDueDate);
  var daysLabel = days === null ? '' : days < 0 ? 'Overdue' : days === 0 ? 'Due today' : 'in ' + days + 'd';
  var soon = days !== null && days <= 60;
  el.innerHTML = '<p>Due <strong>' + drEscapeHtml(drFormatDeadline(drPeerReviewDueDate)) + '</strong> ' +
    '<span class="dr-at-risk-days' + (soon ? ' dr-at-risk-days--soon' : '') + '">' + drEscapeHtml(daysLabel) + '</span> ' +
    '<button type="button" class="dr-link-btn" id="dr-peer-review-edit-btn">Edit</button></p>';
}

function drSavePeerReview() {
  var input = document.getElementById('dr-peer-review-input');
  var value = input ? input.value : '';
  if (!value) return;
  fetch('/api/firm/peer-review', {
    method: 'PATCH', credentials: 'include',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({due_date: value})
  }).then(function(res) {
    if (res.status === 401) { window.location.href = '/firm-login/'; return null; }
    return drReadJsonSafe(res).then(function(data) {
      if (!res.ok) { drShowError((data && data.error) ? data.error : 'Something went wrong, please try again.'); return; }
      drPeerReviewDueDate = data.peer_review_due_date;
      drPeerReviewEditing = false;
      drRenderPeerReview();
    });
  }).catch(function() { drShowError('Something went wrong, please try again.'); });
}

function drClearPeerReview() {
  if (!window.confirm('Stop tracking a peer review due date?')) return;
  fetch('/api/firm/peer-review', {
    method: 'PATCH', credentials: 'include',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({due_date: null})
  }).then(function(res) {
    if (res.status === 401) { window.location.href = '/firm-login/'; return; }
    drPeerReviewDueDate = null;
    drPeerReviewEditing = false;
    drRenderPeerReview();
  }).catch(function() {});
}

document.addEventListener('DOMContentLoaded', function() {
  var stateSel = document.getElementById('dr-add-state');
  drUpdateFields(stateSel ? stateSel.value : '');

  drLoadLicenses();
  drWireMapTooltip();

  var editModal = document.getElementById('dr-edit-modal');
  var editModalForm = document.getElementById('dr-edit-modal-form');
  var editModalCancelBtn = document.getElementById('dr-edit-modal-cancel');
  if (editModalForm) editModalForm.addEventListener('submit', drSubmitEditModal);
  if (editModalCancelBtn) editModalCancelBtn.addEventListener('click', drCloseEditModal);
  if (editModal) {
    editModal.addEventListener('click', function(ev) {
      if (ev.target === editModal) drCloseEditModal();
    });
    document.addEventListener('keydown', function(ev) {
      if (ev.key === 'Escape' && !editModal.hidden) drCloseEditModal();
    });
  }

  // Roadmap #41 (accessibility audit): all six .dr-modal-overlay dialogs
  // already set role="dialog"/aria-modal and close on Escape, but none
  // trapped Tab -- a keyboard user could Tab straight out into background
  // content while a modal was open. One shared listener (keyed off
  // whichever .dr-modal-overlay is currently visible) covers every modal
  // instead of duplicating trap logic per modal.
  document.addEventListener('keydown', function(ev) {
    if (ev.key !== 'Tab') return;
    var openModal = document.querySelector('.dr-modal-overlay:not([hidden])');
    if (!openModal) return;
    var focusable = openModal.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])');
    if (!focusable.length) return;
    var first = focusable[0], last = focusable[focusable.length - 1];
    if (ev.shiftKey && document.activeElement === first) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && document.activeElement === last) {
      ev.preventDefault();
      first.focus();
    }
  });

  var documentsModal = document.getElementById('dr-documents-modal');
  var documentsUploadForm = document.getElementById('dr-documents-upload-form');
  var documentsModalCloseBtn = document.getElementById('dr-documents-modal-close');
  var documentsList = document.getElementById('dr-documents-list');
  if (documentsUploadForm) documentsUploadForm.addEventListener('submit', drSubmitDocumentUpload);
  if (documentsModalCloseBtn) documentsModalCloseBtn.addEventListener('click', drCloseDocumentsModal);

  var newHireChecklistDismissBtn = document.getElementById('dr-new-hire-checklist-dismiss');
  if (newHireChecklistDismissBtn) newHireChecklistDismissBtn.addEventListener('click', drDismissNewHireChecklist);

  var peerReviewBody = document.getElementById('dr-peer-review-body');
  if (peerReviewBody) {
    peerReviewBody.addEventListener('click', function(ev) {
      if (ev.target.id === 'dr-peer-review-edit-btn') {
        drPeerReviewEditing = true;
        drRenderPeerReview();
      } else if (ev.target.id === 'dr-peer-review-cancel-btn') {
        drPeerReviewEditing = false;
        drRenderPeerReview();
      } else if (ev.target.id === 'dr-peer-review-save-btn') {
        drSavePeerReview();
      } else if (ev.target.id === 'dr-peer-review-clear-btn') {
        drClearPeerReview();
      }
    });
  }
  if (documentsList) {
    documentsList.addEventListener('click', function(ev) {
      var btn = ev.target.closest ? ev.target.closest('.dr-document-remove') : null;
      if (!btn) return;
      var id = btn.getAttribute('data-id');
      if (id) drRemoveDocument(id, btn.getAttribute('data-label'));
    });
  }
  if (documentsModal) {
    documentsModal.addEventListener('click', function(ev) {
      if (ev.target === documentsModal) drCloseDocumentsModal();
    });
    document.addEventListener('keydown', function(ev) {
      if (ev.key === 'Escape' && !documentsModal.hidden) drCloseDocumentsModal();
    });
  }

  var ruleChangeModal = document.getElementById('dr-rule-change-modal');
  var ruleChangeModalCloseBtn = document.getElementById('dr-rule-change-modal-close');
  if (ruleChangeModalCloseBtn) ruleChangeModalCloseBtn.addEventListener('click', drCloseRuleChangeModal);
  var ruleChangeNotifyBtn = document.getElementById('dr-rule-change-notify-btn');
  if (ruleChangeNotifyBtn) ruleChangeNotifyBtn.addEventListener('click', drNotifyRuleChangeStaff);
  if (ruleChangeModal) {
    ruleChangeModal.addEventListener('click', function(ev) {
      if (ev.target === ruleChangeModal) drCloseRuleChangeModal();
    });
    document.addEventListener('keydown', function(ev) {
      if (ev.key === 'Escape' && !ruleChangeModal.hidden) drCloseRuleChangeModal();
    });
  }

  var mapStaffSelect = document.getElementById('dr-map-staff-select');
  if (mapStaffSelect) {
    mapStaffSelect.addEventListener('change', drRenderMapForSelection);
  }

  // Dashboard-polish item #3 (2026-08-05): was scoped to just .dr-nav (the
  // sidebar) -- widened to any [data-view] link so every other data-view
  // link on the page (onboarding checklist, last-login banner, etc.) works
  // through the exact same drSwitchView() call, not a second click-handling
  // path.
  document.querySelectorAll('a[data-view]').forEach(function(a) {
    a.addEventListener('click', function(ev) {
      ev.preventDefault();
      drSwitchView(a.getAttribute('data-view'));
    });
  });

  // Roadmap #25: the panel's own items are rendered dynamically (after this
  // DOMContentLoaded block already ran), so they can't be caught by the
  // one-time querySelectorAll wiring above -- delegated on the panel body
  // instead, same pattern as the peer-review/documents-list panels already
  // use for their own dynamically-rendered content.
  var notifBellBtn = document.getElementById('dr-notif-bell-btn');
  var notifPanel = document.getElementById('dr-notif-panel');
  var notifPanelBody = document.getElementById('dr-notif-panel-body');
  if (notifBellBtn && notifPanel) {
    notifBellBtn.addEventListener('click', function() {
      var willOpen = notifPanel.hidden;
      notifPanel.hidden = !willOpen;
      notifBellBtn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    });
    document.addEventListener('click', function(ev) {
      if (notifPanel.hidden) return;
      if (notifPanel.contains(ev.target) || notifBellBtn.contains(ev.target)) return;
      drCloseNotifications();
    });
    document.addEventListener('keydown', function(ev) {
      if (ev.key === 'Escape' && !notifPanel.hidden) drCloseNotifications();
    });
  }
  if (notifPanelBody) {
    notifPanelBody.addEventListener('click', function(ev) {
      var dismissBtn = ev.target.closest('.dr-notif-dismiss-btn');
      if (dismissBtn) {
        ev.preventDefault();
        drDismissNotif(dismissBtn.getAttribute('data-notif-id'), dismissBtn.getAttribute('data-notif-sig'));
        return;
      }
      if (ev.target.closest('#dr-notif-dismiss-all-btn')) {
        ev.preventDefault();
        drDismissAllNotifs();
        return;
      }
      var link = ev.target.closest('[data-view]');
      if (!link) return;
      ev.preventDefault();
      drSwitchView(link.getAttribute('data-view'));
      drCloseNotifications();
    });
  }

  // Reported directly, 2026-08-05: every /firm-mobility/ sidebar link
  // (Calendar, Map, CPE Hours, Account) pointed at a bare /firm-dashboard/
  // with no way to say WHICH tab -- this page's tabs are pure client-side
  // JS state (drSwitchView()), never read from the URL, so every one of
  // those links silently landed on whatever tab the static markup shows
  // by default (Roster) regardless of which the customer actually clicked.
  // Reading a #view hash on load (matching _dashboard_sidebar_html()'s new
  // /firm-dashboard/#{view} links) closes that without changing how
  // in-page tab clicks work at all -- they still call drSwitchView()
  // directly, never touching the hash.
  // Task #29 (2026-08-05): the hash can carry a view name AND an outcome
  // query string on the SAME redirect (e.g. '#account?email_changed=1',
  // matching the '#account?checkout=success'/'?checkout=cancelled' shape
  // Stripe's own successUrl/cancelUrl already used). Split on the first '?'
  // BEFORE doing the dr-view-* lookup below -- an unsplit
  // 'account?email_changed=1' matches no element id at all, which is a
  // real, live bug this same tick fixes: the Stripe checkout redirect has
  // set '#account?checkout=success'/'?checkout=cancelled' since Task #12,
  // and NOTHING has ever read it -- a firm completing real payment lands
  // back on the default Roster tab with no confirmation shown at all.
  var hashRaw = (window.location.hash || '').replace('#', '');
  var qIdx = hashRaw.indexOf('?');
  var initialView = qIdx === -1 ? hashRaw : hashRaw.slice(0, qIdx);
  var hashParams = new URLSearchParams(qIdx === -1 ? '' : hashRaw.slice(qIdx + 1));
  if (initialView && document.getElementById('dr-view-' + initialView)) {
    drSwitchView(initialView);
  }
  if (hashParams.get('checkout') === 'success') {
    drShowSuccess('Payment successful — your plan is now active.');
  } else if (hashParams.get('checkout') === 'cancelled') {
    drShowError('Checkout was cancelled. No charge was made.');
  } else if (hashParams.get('email_changed') === '1') {
    drShowSuccess('Your sign-in email has been updated.');
  } else if (hashParams.get('email_change_failed') === 'conflict') {
    drShowError('That email address was claimed by another account before you confirmed. Nothing changed — try a different address.');
  } else if (hashParams.get('slack_connected') === '1') {
    drShowSuccess('Slack connected — expect a daily digest of newly-due renewals.');
  } else if (hashParams.get('slack_connect_failed') === 'paid_plan_required') {
    drShowError('Slack alerts are part of a paid firm plan. Pick a plan to continue.');
  } else if (hashParams.get('slack_connect_failed')) {
    drShowError('Slack connection failed. Please try again.');
  }

  // Task #12: delegated pattern, since #dr-billing-body's innerHTML is rebuilt by
  // drRenderBillingPanel() on every load/tier-change (a listener attached
  // directly to a tier button would be destroyed with it).
  var billingBody = document.getElementById('dr-billing-body');
  if (billingBody) {
    billingBody.addEventListener('click', function(e) {
      var btn = e.target.closest('.dr-paywall-tier-btn');
      if (!btn) return;
      drStartCheckout(btn.getAttribute('data-tier'), btn, 'dr-billing-error');
    });
  }

  // Staff self-service CPE-entry nudge (2026-08-05) -- one delegated
  // listener on the container, since drRenderCpeStaffProgress() rebuilds
  // #dr-cpe-staff-body's innerHTML on every reload and a per-button
  // listener would need re-wiring each time.
  var cpeStaffBody = document.getElementById('dr-cpe-staff-body');
  if (cpeStaffBody) {
    cpeStaffBody.addEventListener('click', function(e) {
      var btn = e.target.closest('.dr-cpe-remind-btn');
      if (!btn) return;
      var subscriberId = btn.getAttribute('data-id');
      var originalText = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Sending…';
      fetch('/api/firm/staff-cpe-reminder', {
        method: 'POST',
        credentials: 'include',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({subscriber_id: subscriberId}),
      }).then(function (res) {
        if (res.status === 401) { window.location.href = '/firm-login/'; return null; }
        return res.json().catch(function () { return null; });
      }).then(function (data) {
        if (!data) return;
        // Honest per-click feedback, not a generic toast -- the response
        // itself says WHY nothing sent (suppressed / cap hit / no key),
        // and this is exactly the button that was clicked, so putting the
        // answer right there beats a page-wide banner for a one-off action.
        btn.textContent = data.sent ? 'Sent!' : (data.reason || 'Not sent');
        setTimeout(function () { btn.textContent = originalText; btn.disabled = false; }, 3000);
      }).catch(function () {
        btn.textContent = 'Failed — try again';
        setTimeout(function () { btn.textContent = originalText; btn.disabled = false; }, 3000);
      });
    });
  }

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
  var calGrid = document.getElementById('dr-cal-grid');
  if (calGrid) {
    // 2026-08-09, Devin's live report ("the blue dots still don't say
    // anything"): a day cell with hidden staff items (.dr-cal-day--has-item,
    // only drawn on screens <=640px, see that CSS rule's own comment) is now
    // tappable -- toggles --expanded, which un-hides the real labeled
    // .dr-cal-item rows for that one cell instead of leaving a bare,
    // unexplained dot. Checked ahead of the existing rule-change-button
    // handling below so a tap on the rule-change pill itself still only
    // opens ITS OWN modal, not both. 2026-08-10: extended to
    // --has-rule-change too, now that its own button is hidden the same
    // way at this width -- see that class's CSS comment.
    var DR_CAL_EXPANDABLE_SELECTOR = '.dr-cal-day--has-item, .dr-cal-day--has-rule-change';
    function drToggleCalDayExpanded(day) {
      day.classList.toggle('dr-cal-day--expanded');
    }
    calGrid.addEventListener('click', function(ev) {
      var ruleBtn = ev.target.closest ? ev.target.closest('.dr-cal-item--rule-change') : null;
      if (ruleBtn) {
        var id = ruleBtn.getAttribute('data-rule-change-id');
        var event = DR_RULE_CHANGE_EVENTS.filter(function(e) { return e.id === id; })[0];
        if (event) drOpenRuleChangeModal(event, ruleBtn);
        return;
      }
      var day = ev.target.closest ? ev.target.closest(DR_CAL_EXPANDABLE_SELECTOR) : null;
      if (day) drToggleCalDayExpanded(day);
    });
    calGrid.addEventListener('keydown', function(ev) {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      // A rule-change button nested inside an expanded day is itself
      // keyboard-focusable (real <button>) -- let its own Enter/Space
      // activation open the modal via the click handler above rather than
      // also toggling the day (which would collapse the very button just
      // activated) -- same guard the click handler already uses.
      if (ev.target.closest && ev.target.closest('.dr-cal-item--rule-change')) return;
      var day = ev.target.closest ? ev.target.closest(DR_CAL_EXPANDABLE_SELECTOR) : null;
      if (!day) return;
      ev.preventDefault();
      drToggleCalDayExpanded(day);
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

  var sessionsList = document.getElementById('dr-sessions-list');
  if (sessionsList) {
    drLoadSessions();
    sessionsList.addEventListener('click', function(ev) {
      var btn = ev.target.closest ? ev.target.closest('[data-session-id]') : null;
      if (!btn) return;
      drRevokeSession(btn.getAttribute('data-session-id'));
    });
  }

  var dr2faBody = document.getElementById('dr-2fa-body');
  if (dr2faBody) {
    drLoad2faStatus();
  }

  var teamList = document.getElementById('dr-team-list');
  if (teamList) {
    teamList.addEventListener('click', function(ev) {
      var removeBtn = ev.target.closest ? ev.target.closest('[data-remove-member-id]') : null;
      if (removeBtn) {
        drRemoveTeamMember(removeBtn.getAttribute('data-remove-member-id'), removeBtn.getAttribute('data-member-label'));
        return;
      }
      var primaryBtn = ev.target.closest ? ev.target.closest('[data-make-primary-id]') : null;
      if (primaryBtn) {
        drMakeTeamMemberPrimary(primaryBtn.getAttribute('data-make-primary-id'), primaryBtn.getAttribute('data-member-label'));
      }
    });
    teamList.addEventListener('change', function(ev) {
      var select = ev.target.closest ? ev.target.closest('.dr-team-role-select') : null;
      if (!select) return;
      drChangeTeamMemberRole(select.getAttribute('data-member-id'), select.value);
    });
  }

  var teamInviteForm = document.getElementById('dr-team-invite-form');
  if (teamInviteForm) {
    teamInviteForm.addEventListener('submit', function(ev) {
      ev.preventDefault();
      drSubmitTeamInvite(teamInviteForm);
    });
  }

  var changeEmailForm = document.getElementById('dr-change-email-form');
  if (changeEmailForm) {
    changeEmailForm.addEventListener('submit', function(ev) {
      ev.preventDefault();
      drSubmitChangeEmail(changeEmailForm);
    });
  }

  var replyToForm = document.getElementById('dr-reply-to-form');
  if (replyToForm) {
    replyToForm.addEventListener('submit', function(ev) {
      ev.preventDefault();
      drSubmitReplyTo(replyToForm);
    });
  }

  var reminderCadenceForm = document.getElementById('dr-reminder-cadence-form');
  if (reminderCadenceForm) {
    reminderCadenceForm.addEventListener('submit', function(ev) {
      ev.preventDefault();
      drSubmitReminderCadence(reminderCadenceForm);
    });
  }

  var ruleChangeAlertsForm = document.getElementById('dr-rule-change-alerts-form');
  if (ruleChangeAlertsForm) {
    ruleChangeAlertsForm.addEventListener('submit', function(ev) {
      ev.preventDefault();
      drSubmitRuleChangeAlerts(ruleChangeAlertsForm);
    });
  }

  var adminDigestForm = document.getElementById('dr-admin-digest-form');
  if (adminDigestForm) {
    adminDigestForm.addEventListener('submit', function(ev) {
      ev.preventDefault();
      drSubmitAdminDigest(adminDigestForm);
    });
  }

  var slackDisconnectBtn = document.getElementById('dr-slack-disconnect-btn');
  if (slackDisconnectBtn) {
    slackDisconnectBtn.addEventListener('click', function(ev) {
      ev.preventDefault();
      drSlackDisconnect();
    });
  }

  var teamsForm = document.getElementById('dr-teams-form');
  if (teamsForm) {
    teamsForm.addEventListener('submit', function(ev) {
      ev.preventDefault();
      drSubmitTeamsWebhook(teamsForm);
    });
  }
  var teamsClearBtn = document.getElementById('dr-teams-clear-btn');
  if (teamsClearBtn) {
    teamsClearBtn.addEventListener('click', function(ev) {
      ev.preventDefault();
      drTeamsClear();
    });
  }

  var passwordForm = document.getElementById('dr-password-form');
  if (passwordForm) {
    passwordForm.addEventListener('submit', function(ev) {
      ev.preventDefault();
      drSubmitPassword(passwordForm);
    });
  }

  var signOutOtherBtn = document.getElementById('dr-signout-other-btn');
  if (signOutOtherBtn) {
    signOutOtherBtn.addEventListener('click', function() {
      drSignOutOtherDevices(signOutOtherBtn);
    });
  }

  var onboardingDismissBtn = document.getElementById('dr-onboarding-dismiss-btn');
  if (onboardingDismissBtn) onboardingDismissBtn.addEventListener('click', drDismissOnboardingChecklist);

  var sampleModeExitBtn = document.getElementById('dr-sample-mode-exit-btn');
  if (sampleModeExitBtn) sampleModeExitBtn.addEventListener('click', drExitSampleMode);

  var productTourNextBtn = document.getElementById('dr-product-tour-next-btn');
  if (productTourNextBtn) productTourNextBtn.addEventListener('click', drAdvanceProductTour);
  var productTourSkipBtn = document.getElementById('dr-product-tour-skip-btn');
  if (productTourSkipBtn) productTourSkipBtn.addEventListener('click', drEndProductTour);
  var productTourReplayBtn = document.getElementById('dr-product-tour-replay-btn');
  if (productTourReplayBtn) productTourReplayBtn.addEventListener('click', drStartProductTour);
  var reportPrintBtn = document.getElementById('dr-report-print-btn');
  if (reportPrintBtn) reportPrintBtn.addEventListener('click', function() { window.print(); });
  var rosterPrintBtn = document.getElementById('dr-roster-print-btn');
  if (rosterPrintBtn) rosterPrintBtn.addEventListener('click', function() { window.print(); });

  // Roadmap #37.
  var rosterSearchInput = document.getElementById('dr-roster-search');
  if (rosterSearchInput) {
    rosterSearchInput.addEventListener('input', function() {
      drRosterSearchQuery = rosterSearchInput.value.trim();
      drRenderTable();
    });
  }
  var rosterThead = document.querySelector('.dr-roster-panel thead');
  if (rosterThead) {
    rosterThead.addEventListener('click', function(ev) {
      var btn = ev.target.closest('.dr-sort-th');
      if (!btn) return;
      var col = btn.getAttribute('data-sort');
      if (drRosterSortColumn === col) {
        drRosterSortDir = drRosterSortDir === 'asc' ? 'desc' : 'asc';
      } else {
        drRosterSortColumn = col;
        drRosterSortDir = 'asc';
      }
      drRenderTable();
    });
  }

  // Roadmap #40: mobile-accessible equivalent of the header-button sort
  // above -- the <thead> those buttons live in is moved off-screen at the
  // mobile breakpoint (stacked-card layout), so this <select> is the only
  // reachable sort control on a narrow viewport. Drives the exact same
  // drRosterSortColumn/drRosterSortDir state and drApplyRosterSort(), kept
  // in sync with header-button clicks by drRenderRosterSortHeaders().
  var lastLoginDismissBtn = document.getElementById('dr-last-login-banner-dismiss');
  if (lastLoginDismissBtn) {
    lastLoginDismissBtn.addEventListener('click', function() {
      var el = document.getElementById('dr-last-login-banner');
      if (el) el.hidden = true;
    });
  }

  var rosterSortSelect = document.getElementById('dr-roster-sort-select');
  if (rosterSortSelect) {
    rosterSortSelect.addEventListener('change', function() {
      var val = rosterSortSelect.value;
      if (!val) {
        drRosterSortColumn = null;
        drRosterSortDir = 'asc';
      } else {
        var parts = val.split(':');
        drRosterSortColumn = parts[0];
        drRosterSortDir = parts[1];
      }
      drRenderTable();
    });
  }

  // Roadmap #38.
  var dueWithinFilter = document.getElementById('dr-due-within-filter');
  if (dueWithinFilter) {
    dueWithinFilter.addEventListener('change', function() {
      drDueWithinDays = dueWithinFilter.value;
      drRenderTable();
    });
  }
  drRenderSavedViewsList();
  var saveViewBtn = document.getElementById('dr-save-view-btn');
  if (saveViewBtn) {
    saveViewBtn.addEventListener('click', function() {
      var nameInput = document.getElementById('dr-saved-view-name');
      var name = nameInput ? nameInput.value.trim() : '';
      if (!name) return;
      drSaveCurrentView(name);
      if (nameInput) nameInput.value = '';
    });
  }
  var savedViewsList = document.getElementById('dr-saved-views-list');
  if (savedViewsList) {
    savedViewsList.addEventListener('click', function(ev) {
      var applyBtn = ev.target.closest('[data-apply-view]');
      if (applyBtn) {
        var views = drGetSavedViews();
        var view = views[Number(applyBtn.getAttribute('data-apply-view'))];
        if (view) drApplySavedView(view);
        return;
      }
      var deleteBtn = ev.target.closest('[data-delete-view]');
      if (deleteBtn) {
        drDeleteSavedView(Number(deleteBtn.getAttribute('data-delete-view')));
      }
    });
  }

  var reportCsvBtn = document.getElementById('dr-report-csv-btn');
  if (reportCsvBtn) reportCsvBtn.addEventListener('click', drDownloadRosterCsv);
  // Roadmap #15: purely client-side, re-filters the rows already fetched by
  // drLoadAuditTrail() -- no re-fetch on every keystroke.
  var auditSearchInput = document.getElementById('dr-audit-search');
  if (auditSearchInput) auditSearchInput.addEventListener('input', drApplyAuditTrailFilter);
  var auditEventFilter = document.getElementById('dr-audit-event-filter');
  if (auditEventFilter) auditEventFilter.addEventListener('change', drApplyAuditTrailFilter);
  // Roadmap #16.
  var officeGroupFilter = document.getElementById('dr-office-group-filter');
  if (officeGroupFilter) officeGroupFilter.addEventListener('change', function() {
    drOfficeGroupFilter = officeGroupFilter.value;
    drRenderTable();
  });
  var bulkTagApplyBtn = document.getElementById('dr-bulk-tag-apply-btn');
  if (bulkTagApplyBtn) bulkTagApplyBtn.addEventListener('click', drApplyBulkTag);
  // Roadmap #17.
  var csvPreviewBtn = document.getElementById('dr-csv-preview-btn');
  if (csvPreviewBtn) csvPreviewBtn.addEventListener('click', drPreviewCsvImport);
  var csvImportBtn = document.getElementById('dr-csv-import-btn');
  if (csvImportBtn) csvImportBtn.addEventListener('click', drImportCsvRows);
  var csvTemplateBtn = document.getElementById('dr-csv-template-btn');
  if (csvTemplateBtn) csvTemplateBtn.addEventListener('click', drDownloadCsvTemplate);
  // Reported live 2026-08-07: Export wasn't discoverable next to Import --
  // reuses the same drDownloadRosterCsv() the Reports tab's "Download CSV"
  // button already calls rather than a second implementation.
  var csvExportBtn = document.getElementById('dr-csv-export-btn');
  if (csvExportBtn) csvExportBtn.addEventListener('click', drDownloadRosterCsv);
  // Anchored via getBoundingClientRect() against a live nav item -- has to
  // be recomputed if the viewport (and so the sidebar's on-screen position)
  // changes while the tour is open.
  window.addEventListener('resize', function() {
    if (drProductTourActive) drPositionProductTour();
  });

  var questionnaireForm = document.getElementById('dr-questionnaire-form');
  var questionnaireSkipBtn = document.getElementById('dr-questionnaire-skip-btn');
  var questionnaireModal = document.getElementById('dr-questionnaire-modal');
  if (questionnaireForm) questionnaireForm.addEventListener('submit', drSubmitQuestionnaire);
  if (questionnaireSkipBtn) questionnaireSkipBtn.addEventListener('click', drSkipQuestionnaire);
  if (questionnaireModal) {
    // Backdrop click / Escape count as a skip, not just a close -- this
    // modal is meant to appear exactly once total (submit or skip both
    // dismiss it server-side); a bare close would just bring it back on
    // the next page load, which defeats the point.
    questionnaireModal.addEventListener('click', function(ev) {
      if (ev.target === questionnaireModal) drSkipQuestionnaire();
    });
    document.addEventListener('keydown', function(ev) {
      if (ev.key === 'Escape' && !questionnaireModal.hidden) drSkipQuestionnaire();
    });
  }

  var npsModal = document.getElementById('dr-nps-modal');
  var npsDismissBtn = document.getElementById('dr-nps-dismiss-btn');
  if (npsDismissBtn) npsDismissBtn.addEventListener('click', drDismissNpsPrompt);
  if (npsModal) {
    npsModal.addEventListener('click', function(ev) {
      var scoreBtn = ev.target.closest ? ev.target.closest('.dr-nps-score-btn') : null;
      if (scoreBtn) { drSubmitNpsScore(Number(scoreBtn.getAttribute('data-score')), scoreBtn); return; }
      // Same "backdrop/Escape counts as dismiss" reasoning as the
      // questionnaire modal above -- this is meant to appear at most once
      // per quarter; a bare close would leave it eligible to reappear on
      // the very next roster action within the same visit.
      if (ev.target === npsModal) drDismissNpsPrompt();
    });
    document.addEventListener('keydown', function(ev) {
      if (ev.key === 'Escape' && !npsModal.hidden) drDismissNpsPrompt();
    });
  }

  var testimonialForm = document.getElementById('dr-testimonial-form');
  var testimonialSkipBtn = document.getElementById('dr-testimonial-skip-btn');
  var testimonialModal = document.getElementById('dr-testimonial-modal');
  if (testimonialForm) testimonialForm.addEventListener('submit', drSubmitTestimonial);
  if (testimonialSkipBtn) testimonialSkipBtn.addEventListener('click', drCloseTestimonialModal);
  if (testimonialModal) {
    testimonialModal.addEventListener('click', function(ev) {
      if (ev.target === testimonialModal) drCloseTestimonialModal();
    });
    document.addEventListener('keydown', function(ev) {
      if (ev.key === 'Escape' && !testimonialModal.hidden) drCloseTestimonialModal();
    });
  }

  var deleteAccountOpenBtn = document.getElementById('dr-delete-account-open-btn');
  if (deleteAccountOpenBtn) deleteAccountOpenBtn.addEventListener('click', function(ev) { drOpenDeleteAccountModal(ev.currentTarget); });
  var deleteAccountModal = document.getElementById('dr-delete-account-modal');
  var deleteAccountForm = document.getElementById('dr-delete-account-form');
  var deleteAccountCancelBtn = document.getElementById('dr-delete-account-cancel');
  var deleteConfirmNameInput = document.getElementById('dr-delete-confirm-name');
  if (deleteAccountForm) deleteAccountForm.addEventListener('submit', drSubmitDeleteAccount);
  if (deleteAccountCancelBtn) deleteAccountCancelBtn.addEventListener('click', drCloseDeleteAccountModal);
  if (deleteConfirmNameInput) deleteConfirmNameInput.addEventListener('input', drCheckDeleteConfirmName);
  if (deleteAccountModal) {
    deleteAccountModal.addEventListener('click', function(ev) {
      if (ev.target === deleteAccountModal) drCloseDeleteAccountModal();
    });
    document.addEventListener('keydown', function(ev) {
      if (ev.key === 'Escape' && !deleteAccountModal.hidden) drCloseDeleteAccountModal();
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
      // Roadmap #29: only present inside the empty-roster row (drRenderTable's
      // own empty branch), so this always fires against an empty real roster.
      if (btn.id === 'dr-sample-mode-enter-btn') { drEnterSampleMode(); return; }
      var id = btn.getAttribute('data-id');
      if (btn.classList.contains('dr-btn-edit')) {
        var editItem = null;
        for (var k = 0; k < drLicenses.length; k++) {
          if (drLicenses[k].id === id) { editItem = drLicenses[k]; break; }
        }
        if (editItem) drOpenEditModal(editItem, btn);
      } else if (btn.classList.contains('dr-btn-renew')) {
        var renewItem = null;
        for (var j = 0; j < drLicenses.length; j++) {
          if (drLicenses[j].id === id) { renewItem = drLicenses[j]; break; }
        }
        drRenewLicense(id, btn, renewItem ? (renewItem.staff_label || renewItem.email) : null);
      } else if (btn.classList.contains('dr-btn-remove')) {
        var item = null;
        for (var i = 0; i < drLicenses.length; i++) {
          if (drLicenses[i].id === id) { item = drLicenses[i]; break; }
        }
        drRemoveLicense(id, item ? (item.staff_label || item.email) : null);
      } else if (btn.classList.contains('dr-btn-documents')) {
        drOpenDocumentsModal(id, btn.getAttribute('data-who') || id, btn);
      }
    });
  }

  var addForm = document.getElementById('dr-add-staff-form');
  if (addForm) {
    addForm.addEventListener('submit', function(ev) {
      ev.preventDefault();
      var errEl = document.getElementById('dr-add-error');
      if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
      drClearWarning();
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
          if (data && data.duplicate_email_warning) { drShowWarning(data.duplicate_email_warning); }
          addForm.reset();
          drUpdateFields('');
          drLoadLicenses();
          // Roadmap #5: one-time nudge for the person just added, not a
          // standing fixture -- data is the new record itself (id/
          // state_slug/staff_label/email), no extra fetch needed.
          if (data) drShowNewHireChecklist(data);
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
# Practice-privilege (mobility) checker (2026-07-30). Individual check is free
# on every tier since 2026-08-10; the firm-level check further down the same
# page is still paid (solo-free exception aside) -- see handleMobilityCheck()'s
# own docstring in index.ts for the full reasoning.
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
  function findingHtml(title, f, actionBtnHtml) {
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
      // MOB-2 (AuditLab, 2026-08-05, LOW): confidence was already on every
      // API response and rendered nowhere -- 7 of 55 states rest on a
      // single source, presented identically to the other 48's dual-source
      // records. Only surfaced when BELOW the site's stated two-source
      // standard (/methodology/), same "only flag what's weaker than the
      // default" posture the state pages already use -- not a badge of
      // honor on the other 48 for meeting the bar.
      if (f.confidence === 'single_source') {
        cite += ' &middot; single-source (not yet independently confirmed by a second source)';
      }
      cite = '<p class="dr-verdict-cite">Source: ' + cite + '</p>';
    } else if (f.verdict === 'not_applicable') {
      // Telling a CPA we have "no verified citation" for their OWN home
      // state is both false and alarming. The question simply doesn't
      // apply here, so there is nothing to cite.
      cite = '';
    } else {
      cite = '<p class="dr-verdict-cite">No verified citation on file for this one &mdash; which is exactly why it is not a yes.</p>';
    }
    // Reported directly, 2026-08-05: dataGapNote was rendered here verbatim,
    // unlabeled, in the SAME <p class="dr-verdict-cite"> style as the real
    // citation -- indistinguishable from an official source to a customer.
    // mobility_rules.json's data_gap_note is authored as internal
    // verification methodology (53 of 55 states have one), full of phrases
    // like "verifier concurs" and "RESOLVED (verifier)" -- it is the
    // record's own research audit trail, not customer copy, and no amount
    // of labeling fixes prose written in that register. The engine still
    // uses data_gap_note internally (isSubstantiveCitation() etc., see
    // mobility.ts) to decide staleness/verification status; only the
    // customer-facing render of the raw text is removed here.
    return '<div class="dr-verdict"><h3>' + esc(title) + '</h3>' + badge(f.verdict) +
      '<p>' + esc(f.summary) + '</p>' + reqs + cite +
      '<p class="dr-verdict-disclaimer">' + esc(f.disclaimer) + '</p>' +
      (actionBtnHtml || '') + '</div>';
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
        // 2026-08-10, Devin's own live-test report: Overall can read ACTION
        // REQUIRED directly above an individual card that says CLEAR, with
        // nothing at the top explaining why -- the real driver (a firm-level
        // requirement) is real and correct, just buried in the third card
        // below with no pointer to it. Only shown for that EXACT
        // contradiction (never when Overall and the individual verdict
        // already agree), so it never fires as noise on an ordinary result.
        var overallPointer = (data.overall === 'action_required' && data.individual && data.individual.verdict === 'clear')
          ? '<p class="dr-verdict-pointer">This comes from a firm-level requirement, not the individual CPA &mdash; see "The firm" below.</p>'
          : '';
        // "Mark requirements met" -- only offered when there is something to
        // mark (action_required) AND a real roster record to attach it to
        // (a staff member was picked, not the anonymous "just checking"
        // default). Records ONLY that the firm says it handled this, never
        // a re-verification -- see migration 0016's own comment for why
        // this is a deliberately distinct signal from the engine's verdict.
        //
        // 2026-08-10, Devin's own live-test report: this used to always
        // render in its own block AFTER both cards, regardless of which one
        // actually carried the action_required verdict -- reading as
        // disconnected from what it resolves when only "The firm" needed
        // action. Now built once and handed to whichever findingHtml() call
        // below actually owns the action_required verdict, so it renders
        // attached to that specific card. overall === 'action_required'
        // guarantees at least one of the two IS action_required (see
        // evaluateMobility()'s own not_verified-first precedence), so
        // exactly one of the two branches below ever gets it.
        var staffId = document.getElementById('dr-mob-staff').value;
        var actionBtnHtml = '';
        if (data.overall === 'action_required' && staffId) {
          actionBtnHtml = '<div class="dr-mob-complete-wrap" id="dr-mob-complete-wrap">' +
            '<button type="button" class="dr-btn-save" id="dr-mob-complete-btn" data-subscriber-id="' + esc(staffId) +
            '" data-target-state-slug="' + esc(body.target_state_slug) + '" data-service-type="' + esc(body.service_type) + '">' +
            'Mark requirements met</button>' +
            '<p class="field-hint">Records that your firm handled this -- not a re-check. Also updates the Map.</p></div>';
        }
        var individualIsAction = data.individual && data.individual.verdict === 'action_required';
        var html = '<h2>' + esc(data.home_state) + ' &rarr; ' + esc(data.target_state) + '</h2>' +
          '<div class="dr-verdict dr-verdict-overall"><h3>Overall</h3>' +
          badge(data.overall) + '<p>' + esc(overallText(data.overall)) + '</p>' + overallPointer + '</div>' +
          findingHtml('The individual CPA', data.individual, individualIsAction ? actionBtnHtml : '') +
          findingHtml('The firm', data.firm, individualIsAction ? '' : actionBtnHtml);
        if (resultEl) { resultEl.innerHTML = html; resultEl.hidden = false; }
      });
    }).catch(function () {
      if (errEl) { errEl.textContent = 'Something went wrong, please try again.'; errEl.hidden = false; }
    });
  });

  // Delegated (the button is created fresh on every result render, never
  // present at page load) -- same pattern the dashboard's own dynamically
  // rendered roster-action buttons would use if this page had that JS
  // loaded, which it doesn't.
  if (resultEl) {
    resultEl.addEventListener('click', function (ev) {
      var btn = ev.target.closest('#dr-mob-complete-btn');
      if (!btn) return;
      btn.disabled = true;
      btn.textContent = 'Saving…';
      fetch('/api/firm/mobility/completions', {
        method: 'POST', credentials: 'include',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          subscriber_id: btn.getAttribute('data-subscriber-id'),
          target_state_slug: btn.getAttribute('data-target-state-slug'),
          service_type: btn.getAttribute('data-service-type')
        })
      }).then(function (res) {
        if (res.status === 401) { window.location.href = '/firm-login/'; return null; }
        return res.ok;
      }).then(function (ok) {
        var wrap = document.getElementById('dr-mob-complete-wrap');
        if (!wrap) return;
        if (ok) {
          wrap.innerHTML = '<p>Marked complete. The Map will show this the next time it loads.</p>';
        } else {
          wrap.innerHTML = '<p class="field-hint" style="color:#c33737;">Something went wrong saving that. Please try again.</p>';
        }
      }).catch(function () {
        btn.disabled = false;
        btn.textContent = 'Mark requirements met';
      });
    });
  }

  // Roadmap #320 (2026-08-10): "Check one person" / "Check whole roster"
  // mode toggle -- swaps which panel is visible, nothing else. Individual
  // mode stays the default (matches the deep-link prefill from the Map,
  // which always targets the individual form's own fields).
  var modeIndividualBtn = document.getElementById('dr-mob-mode-individual');
  var modeRosterBtn = document.getElementById('dr-mob-mode-roster');
  var individualPanel = document.getElementById('dr-mob-individual-panel');
  var rosterPanel = document.getElementById('dr-mob-roster-panel');
  function setMobMode(mode) {
    var isRoster = mode === 'roster';
    if (individualPanel) individualPanel.hidden = isRoster;
    if (rosterPanel) rosterPanel.hidden = !isRoster;
    if (modeIndividualBtn) {
      modeIndividualBtn.classList.toggle('dr-mob-mode-btn--active', !isRoster);
      modeIndividualBtn.setAttribute('aria-pressed', String(!isRoster));
    }
    if (modeRosterBtn) {
      modeRosterBtn.classList.toggle('dr-mob-mode-btn--active', isRoster);
      modeRosterBtn.setAttribute('aria-pressed', String(isRoster));
    }
  }
  if (modeIndividualBtn) modeIndividualBtn.addEventListener('click', function () { setMobMode('individual'); });
  if (modeRosterBtn) modeRosterBtn.addEventListener('click', function () { setMobMode('roster'); });

  // Roadmap #320: whole-roster batch check. Reuses badge()/esc()/
  // overallText() already defined above in this same scope -- one engine,
  // one set of render helpers, just a different result shape (a list of
  // per-person findings instead of one individual+firm pair).
  var rosterForm = document.getElementById('dr-mobility-roster-form');
  var rosterErrEl = document.getElementById('dr-mobility-roster-error');
  var rosterResultEl = document.getElementById('dr-mobility-roster-result');
  // Worst-first, same convention the dashboard's own "Staff at risk" panel
  // already uses -- what needs attention surfaces before what doesn't.
  // Starts at 1, not 0: the `|| 9` unknown-verdict fallback below would
  // otherwise silently treat action_required's own rank of 0 as falsy and
  // fall through to 9, sorting it LAST instead of first (caught live by
  // testing all three severities together, not just one at a time).
  var ROSTER_SEVERITY_RANK = {action_required: 1, not_verified: 2, clear: 3, not_applicable: 4};
  if (rosterForm) {
    rosterForm.addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (rosterErrEl) { rosterErrEl.hidden = true; rosterErrEl.textContent = ''; }
      if (rosterResultEl) { rosterResultEl.hidden = true; rosterResultEl.innerHTML = ''; }

      var targetStateSlug = document.getElementById('dr-mob-roster-target').value;
      var serviceType = document.getElementById('dr-mob-roster-service').value;

      fetch('/api/firm/mobility/check-roster', {
        method: 'POST', credentials: 'include',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({target_state_slug: targetStateSlug, service_type: serviceType})
      }).then(function (res) {
        if (res.status === 401) { window.location.href = '/firm-login/'; return null; }
        return res.json().catch(function () { return null; }).then(function (data) {
          if (!res.ok) {
            var msg = (data && data.error) ? data.error : 'Something went wrong, please try again.';
            if (rosterErrEl) { rosterErrEl.textContent = msg; rosterErrEl.hidden = false; }
            return;
          }
          if (!data) return;

          if (!data.results || data.results.length === 0) {
            if (rosterResultEl) {
              rosterResultEl.innerHTML = '<p class="dr-panel-empty">No one is on your roster yet.</p>';
              rosterResultEl.hidden = false;
            }
            return;
          }

          var sorted = data.results.slice().sort(function (a, b) {
            return (ROSTER_SEVERITY_RANK[a.overall] || 9) - (ROSTER_SEVERITY_RANK[b.overall] || 9);
          });
          var rowsHtml = sorted.map(function (r) {
            var detailsUrl = '/firm-mobility/?home=' + encodeURIComponent(r.home_state_slug) +
              '&target=' + encodeURIComponent(data.target_state_slug) +
              '&service=' + encodeURIComponent(data.service_type) +
              '&staff=' + encodeURIComponent(r.subscriber_id) + '#dr-mobility-form';
            return '<tr>' +
              '<td>' + esc(r.staff_label) + '</td>' +
              '<td>' + esc(r.home_state) + '</td>' +
              '<td>' + badge(r.overall) + '</td>' +
              '<td><a href="' + esc(detailsUrl) + '">Details &rarr;</a></td>' +
              '</tr>';
          }).join('');
          var assumptionNote = (data.assumed_license_good_standing && data.assumed_substantially_equivalent)
            ? '<p class="field-hint">Assumes every person\\'s license is active and in good standing, and meets substantial equivalence -- click a row\\'s Details link to verify someone\\'s actual attestation.</p>'
            : '';
          if (rosterResultEl) {
            rosterResultEl.innerHTML = '<h2>' + esc(data.target_state) + ' &mdash; whole roster</h2>' +
              '<table class="dr-mob-roster-table"><thead><tr><th>Staff</th><th>Home state</th><th>Overall</th><th></th></tr></thead>' +
              '<tbody>' + rowsHtml + '</tbody></table>' + assumptionNote +
              '<p class="dr-verdict-disclaimer">' + esc(data.disclaimer) + '</p>';
            rosterResultEl.hidden = false;
          }
        });
      }).catch(function () {
        if (rosterErrEl) { rosterErrEl.textContent = 'Something went wrong, please try again.'; rosterErrEl.hidden = false; }
      });
    });
  }
})();
</script>"""

_MOBILITY_JS_HTML = _MOBILITY_JS_HTML.replace("'/api/firm", f"'{REMINDER_BACKEND_BASE_URL}/firm")

# Roadmap #318 (2026-08-09). Same badge()/esc() shape as _MOBILITY_JS_HTML
# above (a separate copy, not a shared function, since these two scripts
# are independently-loaded <script> blocks on the same page with no shared
# module system) but simpler: one finding, not individual+firm; no staff
# picker or "mark complete" flow this pass (see the plan's own scope note).
_FIRM_MOBILITY_JS_HTML = """<script>
(function () {
  var form = document.getElementById('dr-firm-mobility-form');
  if (!form) return;
  var errEl = document.getElementById('dr-firm-mobility-error');
  var resultEl = document.getElementById('dr-firm-mobility-result');

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

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
    if (resultEl) { resultEl.hidden = true; resultEl.innerHTML = ''; }

    var body = {
      firm_home_state_slug: document.getElementById('dr-firmmob-home').value,
      target_state_slug: document.getElementById('dr-firmmob-target').value,
      has_physical_office: document.getElementById('dr-firmmob-office').checked
    };

    fetch('/api/firm/mobility/firm-check', {
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
        var reqs = '';
        if (data.requirements && data.requirements.length) {
          reqs = '<ul class="dr-verdict-reqs">' +
            data.requirements.map(function (r) { return '<li>' + esc(r) + '</li>'; }).join('') + '</ul>';
        }
        var cite;
        if (data.citation) {
          cite = data.citation_url
            ? '<a href="' + esc(data.citation_url) + '" rel="noopener noreferrer" target="_blank">' + esc(data.citation) + '</a>'
            : esc(data.citation);
          if (data.verified_date) { cite += ' &middot; verified ' + esc(data.verified_date); }
          if (data.confidence === 'single_source') {
            cite += ' &middot; single-source (not yet independently confirmed by a second source)';
          }
          cite = '<p class="dr-verdict-cite">Source: ' + cite + '</p>';
        } else if (data.verdict === 'not_applicable') {
          cite = '';
        } else {
          cite = '<p class="dr-verdict-cite">No verified citation on file for this one &mdash; which is exactly why it is not a yes.</p>';
        }
        var html = '<h3>' + esc(data.firm_home_state) + ' &rarr; ' + esc(data.target_state) + '</h3>' +
          '<div class="dr-verdict">' + badge(data.verdict) + '<p>' + esc(data.summary) + '</p>' +
          reqs + cite + '<p class="dr-verdict-disclaimer">' + esc(data.disclaimer) + '</p></div>';
        if (resultEl) { resultEl.innerHTML = html; resultEl.hidden = false; }
      });
    }).catch(function () {
      if (errEl) { errEl.textContent = 'Something went wrong, please try again.'; errEl.hidden = false; }
    });
  });
})();
</script>"""

_FIRM_MOBILITY_JS_HTML = _FIRM_MOBILITY_JS_HTML.replace("'/api/firm", f"'{REMINDER_BACKEND_BASE_URL}/firm")


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


def _firm_mobility_covered_slugs() -> set[str]:
    """State slugs with a verified FIRM-level registration rule (roadmap
    #318), read from the SAME file the Worker imports
    (`worker/src/firm_mobility_rules.json`) -- same "read the Worker's own
    data file rather than a second hand-kept list" reasoning as
    _mobility_covered_slugs() above. That file's dataset is already keyed
    by this repo's own canonical slugs (the "dc" vs "district-of-columbia"
    drift _mobility_covered_slugs() had to alias-translate for the
    individual dataset was instead fixed AT THE SOURCE when this file was
    created -- confirmed via a direct diff against cpa_deadlines.json's own
    55-slug set -- so no alias table is needed here.

    A missing/unreadable file yields an EMPTY set, same deliberately-safe
    direction as _mobility_covered_slugs(): a checker offering nothing is
    obviously broken and gets fixed; one offering everything looks fine
    while quietly returning not_verified for all of it.
    """
    path = pathlib.Path(__file__).resolve().parent / "worker" / "src" / "firm_mobility_rules.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return set()
    if not isinstance(data, dict):
        return set()
    return {slug for slug in data if isinstance(slug, str)}


def _dashboard_sidebar_html(active: str, tabs_live_here: bool) -> str:
    """Shared sidebar markup for the firm dashboard's own page
    (build_firm_dashboard_page, tabs_live_here=True -- Roster/Calendar/Map/
    CPE Hours/Account are real in-page JS tabs there) and for
    /firm-mobility/ (build_firm_mobility_page, tabs_live_here=False).

    2026-08-04, Devin reported live: navigating to Practice Privilege Check
    from the dashboard sidebar dropped the sidebar entirely -- the page
    became a generic content page with only the site's top nav, no way back
    into the dashboard's other views without a full "back" click. That was a
    deliberate original design choice (see build_firm_mobility_page's own
    docstring: standalone page, not a tab, both for a product reason and a
    since-resolved merge-conflict-avoidance reason) but the loses-your-place
    feeling it produces is a real regression regardless of the original
    reasoning. Fix: render the SAME sidebar on both pages rather than
    converting mobility into a true in-page tab (a bigger, riskier rewrite of
    its pay-gated fetch/session logic into drSwitchView's tab machinery for a
    problem that's purely "the sidebar disappeared", not "the interaction
    model is wrong"). On /firm-mobility/ the Roster/Calendar/Map/CPE Hours/
    Account items link to /firm-dashboard/#{view} (there is no tab-switch JS
    on THIS page to answer a click on those) -- the #view hash is read once
    on /firm-dashboard/'s own DOMContentLoaded to open the right tab (fixed
    2026-08-05: it used to link to a bare /firm-dashboard/ with no hash at
    all, which silently landed on whichever tab the static markup defaults
    to -- Roster -- regardless of which link was actually clicked). Practice
    Privilege Check itself is a plain highlighted link, not a tab."""
    def item(view: str, label: str) -> str:
        is_current = active == view
        cls = ' class="is-active"' if is_current else ""
        if view == "mobility":
            return f'<li><a href="/firm-mobility/"{cls}>{esc(label)}</a></li>'
        if tabs_live_here:
            aria = "true" if is_current else "false"
            # AuditLab A11Y-2 (MEDIUM, 2026-08-04): aria-controls links this tab
            # to the panel it opens -- the ARIA scaffolding (role=tab/tabpanel,
            # aria-selected) was otherwise already correct, this was the one
            # missing piece.
            return f'<li><a href="#"{cls} data-view="{view}" role="tab" aria-selected="{aria}" aria-controls="dr-view-{view}">{esc(label)}</a></li>'
        return f'<li><a href="/firm-dashboard/#{view}"{cls}>{esc(label)}</a></li>'

    nav_items = "\n      ".join(
        item(view, label)
        for view, label in (
            ("roster", "Roster"),
            ("calendar", "Calendar"),
            ("map", "Map"),
            ("cpe", "CPE Hours"),
            ("reports", "Reports"),
            ("mobility", "Practice Privilege Check"),
            ("account", "Account"),
        )
    )
    # Roadmap #3 (2026-08-07) then #1/#2 (2026-08-07): Reports and Documents
    # are both real now -- Documents is reached per-staff-member (a
    # "Documents" button on each roster row opens that person's upload/list
    # modal), not a dedicated sidebar tab of its own, so there's nothing left
    # to list here as "Soon". Kept as a tuple (not deleted outright) since a
    # FUTURE firm-wide document library view is a real, separate possibility
    # this placeholder mechanism can pick back up.
    sidebar_nav_soon_items = "\n    ".join(
        f'<li><span class="dr-nav-soon">{esc(label)}<span class="dr-soon-badge">Soon</span></span></li>'
        for label in ()
    )
    firm_name_html = (
        '<div class="dr-firm-name" id="dr-firm-name">Dashboard</div>'
        if tabs_live_here
        else '<div class="dr-firm-name" id="dr-firm-name-static">Dashboard</div>'
    )
    # Roadmap #25 (2026-08-07): in-app notification center. Only rendered on
    # the real dashboard page (tabs_live_here) -- drLicenses, the data this
    # reads, is never loaded on /firm-mobility/'s own separate JS bundle, so
    # a bell there would have nothing to compute from. Pure client-side,
    # same "reuse data already fetched" posture as #15/#16 -- no new
    # endpoint, no read/unread persistence (a live, always-current computed
    # list, not a durable notification log).
    notification_bell_html = (
        """<button type="button" class="dr-notif-bell" id="dr-notif-bell-btn" aria-label="Notifications" aria-haspopup="true" aria-expanded="false">
      <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 2a4 4 0 0 0-4 4v2.5L2.5 11h11L12 8.5V6a4 4 0 0 0-4-4Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M6.3 13a1.8 1.8 0 0 0 3.4 0" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
      <span class="dr-notif-badge" id="dr-notif-badge" hidden>0</span>
    </button>
    <div class="dr-notif-panel" id="dr-notif-panel" hidden role="region" aria-label="Notifications">
      <div id="dr-notif-panel-body"></div>
    </div>"""
        if tabs_live_here
        else ""
    )
    return f"""<aside class="dr-sidebar">
    {firm_name_html}
    {notification_bell_html}
    <ul class="dr-nav" role="tablist" aria-label="Dashboard views">
      {nav_items}
      {sidebar_nav_soon_items}
    </ul>
    <div class="dr-sidebar-foot">
      <form method="post" action="{REMINDER_BACKEND_BASE_URL}/firm/logout">
        <button type="submit">Log out</button>
      </form>
    </div>
  </aside>"""


def build_firm_mobility_page(by_slug: dict[str, list[dict]]) -> str:
    """Practice-privilege (mobility) checker. The individual check (top of
    the page, one person/one target state) is FREE on every tier since
    2026-08-10 -- matching NASBA's own CPAmobility.org giving the identical
    lookup away free/unlimited (Devin's decision, relayed via orchestrator).
    The firm-level registration check further down the SAME page is still
    paid (solo-free exception aside) -- see handleMobilityCheck()'s own
    docstring in index.ts for the full reasoning on why only the individual
    check dropped its gate.

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

    # Roadmap #318 (2026-08-09): the FIRM-level registration panel below --
    # a separate coverage list from the individual one above, since it's a
    # separate dataset/question (see firm_mobility.ts's own module
    # docstring for why). Same covered/disabled-uncovered rendering
    # convention as the individual target select just above.
    firm_covered_slugs = _firm_mobility_covered_slugs()
    firm_covered = [s for s in all_slugs if s in firm_covered_slugs]
    firm_uncovered = [s for s in all_slugs if s not in firm_covered_slugs]
    firm_target_state_options = "\n".join(_opt(s) for s in firm_covered)
    if firm_uncovered:
        firm_target_state_options += (
            '\n<optgroup label="Not yet verified -- we will not guess" disabled>\n'
            + "\n".join(_opt(s, disabled=True) for s in firm_uncovered)
            + "\n</optgroup>"
        )
    firm_coverage_line = (
        f"Verified in <strong>{len(firm_covered)} of {len(all_slugs)}</strong> jurisdictions so far. "
        "Separate dataset from the individual check above -- a state can be verified for one and not "
        "yet the other."
    )

    sidebar_html = _dashboard_sidebar_html("mobility", tabs_live_here=False)
    body = f"""<div class="dr-dash-shell">
  {sidebar_html}

  <div class="dr-main">
<h1>Practice-privilege check</h1>
<p class="subhead">Can this CPA provide this service in this state &mdash; and what has to happen
first? Every answer is tied to the rule it came from.</p>

<div class="dr-mobility-callout">
  <strong>Informational, not legal advice.</strong> Practice-privilege rules change, and they depend on
  facts we can't see. We show you the rule and where it came from so you can check it yourself &mdash;
  and where we haven't verified something against a primary source, we say so instead of guessing.
  Confirm with the state board before you rely on any answer here.
</div>

<div class="dr-mob-mode-toggle" role="tablist">
  <button type="button" id="dr-mob-mode-individual" class="dr-mob-mode-btn dr-mob-mode-btn--active" aria-pressed="true">Check one person</button>
  <button type="button" id="dr-mob-mode-roster" class="dr-mob-mode-btn" aria-pressed="false">Check whole roster</button>
</div>

<div id="dr-mob-individual-panel">
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

    <label for="dr-mob-staff">For which staff member? (optional)</label>
    <select id="dr-mob-staff" name="staff_subscriber_id">
      <option value="">Just checking &mdash; don't save this result</option>
    </select>
    <p class="field-hint">Pick someone from your roster if you want to mark an "Action required"
    result complete once you've handled it &mdash; that also updates the Map.</p>

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
  <p id="dr-mobility-error" role="alert" class="field-hint" style="color:#c33737;" hidden></p>
</div>

<div id="dr-mobility-result" hidden></div>
</div>

<div id="dr-mob-roster-panel" hidden>
<p class="subhead">Roadmap #320: run every roster member's own home state against ONE target state at
once, instead of picking each person one at a time above.</p>
<div class="signup-form">
  <form id="dr-mobility-roster-form">
    <label for="dr-mob-roster-target">Target state (where the work happens)</label>
    <select id="dr-mob-roster-target" name="target_state_slug" required>
      <option value="">Select state</option>
      {target_state_options}
    </select>
    <p class="field-hint">{coverage_line}</p>

    <label for="dr-mob-roster-service">Service type</label>
    <select id="dr-mob-roster-service" name="service_type" required>
      <option value="">Select service type</option>
      <option value="tax">Tax</option>
      <option value="attest">Attest (audit, review, other attest)</option>
      <option value="other_non_attest">Other non-attest (consulting, advisory)</option>
    </select>
    <p class="field-hint">Attest work frequently triggers a firm-registration requirement where tax work
    doesn't &mdash; that gap is the most common real-world mobility mistake.</p>

    <p class="field-hint">Assumes every staff member's own license is active and in good standing, and
    meets substantial equivalence. Switch to &ldquo;Check one person&rdquo; above to verify an
    individual's actual attestation, or use a result row's own &ldquo;Details&rdquo; link below.</p>

    <button type="submit">Run check across the roster</button>
  </form>
  <p id="dr-mobility-roster-error" role="alert" class="field-hint" style="color:#c33737;" hidden></p>
</div>

<div id="dr-mobility-roster-result" hidden></div>
</div>

<hr style="margin:2.5rem 0;">

<h1>Does your firm need to register here?</h1>
<p class="subhead">A different question from the check above: does your FIRM itself need to register
in a state where it has no office, for attest work you're doing there? Firms sometimes assume that if
the individual CPA has practice privilege, the firm is covered too &mdash; the firm often still has its
own separate registration requirement, and that gap is one of the most common real-world mobility
mistakes.</p>

<div class="dr-mobility-callout">
  <strong>Informational, not legal advice.</strong> Same posture as the check above &mdash; every answer
  is tied to the rule it came from, and where we haven't verified something against a primary source,
  we say so instead of guessing. Confirm with the state board before you rely on any answer here.
</div>

<div class="signup-form">
  <form id="dr-firm-mobility-form">
    <div class="signup-form-row">
      <div>
        <label for="dr-firmmob-home">Your firm's home state</label>
        <select id="dr-firmmob-home" name="firm_home_state_slug" required>
          <option value="">Select state</option>
          {home_state_options}
        </select>
      </div>
      <div>
        <label for="dr-firmmob-target">Target state (where the attest work happens)</label>
        <select id="dr-firmmob-target" name="target_state_slug" required>
          <option value="">Select state</option>
          {firm_target_state_options}
        </select>
        <p class="field-hint">{firm_coverage_line}</p>
      </div>
    </div>

    <label class="dr-mob-check">
      <input type="checkbox" id="dr-firmmob-office" name="has_physical_office">
      Your firm has a physical office in the target state
    </label>
    <p class="field-hint">A physical office is its own, separate trigger for registration in most
    states, regardless of service type -- this changes which rule applies.</p>

    <button type="submit">Check firm registration</button>
  </form>
  <p id="dr-firm-mobility-error" role="alert" class="field-hint" style="color:#c33737;" hidden></p>
</div>

<div id="dr-firm-mobility-result" hidden></div>

<p class="how-it-works"><a href="/firm-dashboard/">&larr; Back to your dashboard</a></p>
  </div>
</div>

<script>
(function () {{
  var nameEl = document.getElementById('dr-firm-name-static');
  var staffSel = document.getElementById('dr-mob-staff');
  if (!nameEl && !staffSel) return;
  fetch('{REMINDER_BACKEND_BASE_URL}/firm/licenses', {{credentials: 'include'}}).then(function (r) {{
    return r.ok ? r.json() : null;
  }}).then(function (data) {{
    if (!data) return;
    if (nameEl && data.firm_name) nameEl.textContent = data.firm_name;
    // Staff dropdown, so marking an "Action required" result complete (see
    // _MOBILITY_JS_HTML) can actually be tied to a real roster record
    // instead of a bare state pair -- POST /firm/mobility/completions needs
    // a subscriber_id. The first option ("just checking") stays selected by
    // default so this remains a fully anonymous quick-lookup tool unless the
    // caller deliberately picks someone.
    if (staffSel && data.licenses) {{
      data.licenses.forEach(function (item) {{
        var opt = document.createElement('option');
        opt.value = item.id;
        opt.textContent = (item.staff_label || item.email) + ' (' + (item.state_name || item.state_slug) + ')';
        staffSel.appendChild(opt);
      }});
    }}
    // Deep-link pre-fill from the dashboard Map (2026-08-06, live request:
    // "exactly what needs to be done, or a way to mark someone cleared" --
    // the Map already shows the exact requirement text on hover and
    // "Mark complete" already existed on THIS page, the missing piece was
    // getting here with the same home/target/service/staff already picked,
    // instead of re-selecting all four by hand). Pre-fills only -- the
    // click that actually spends a mobility-check rate-limit unit stays a
    // deliberate "Run check" from the visitor, same principle as the demo
    // login pre-fill (?demo=1 on /firm-login/) not auto-submitting either.
    var deepLinkParams = new URLSearchParams(window.location.search);
    var homeSel = document.getElementById('dr-mob-home');
    var targetSel = document.getElementById('dr-mob-target');
    var serviceSel = document.getElementById('dr-mob-service');
    if (homeSel && deepLinkParams.get('home')) homeSel.value = deepLinkParams.get('home');
    if (targetSel && deepLinkParams.get('target')) targetSel.value = deepLinkParams.get('target');
    if (serviceSel && deepLinkParams.get('service')) serviceSel.value = deepLinkParams.get('service');
    if (staffSel && deepLinkParams.get('staff')) staffSel.value = deepLinkParams.get('staff');
  }}).catch(function () {{}});
}})();
</script>

{_MOBILITY_JS_HTML}
{_FIRM_MOBILITY_JS_HTML}
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


def build_practice_privilege_landing_page() -> str:
    """Roadmap #339: Practice Privilege Check gets its own page. The actual
    tool lives at /firm-mobility/, but that page is noindex (it's built as a
    dashboard-shell screen, same family as /firm-dashboard/ -- see that
    page's own docstring), so nothing indexable currently explains what
    practice privilege / CPA mobility even means as its own topic; /for-firms/
    covers it but framed as one feature of a firm-wide product, not the
    concept's own landing page. This is a clean, standalone, always-public
    explainer -- reuses the exact existing explainer paragraph and the
    exact existing "informational, not legal advice" callout verbatim from
    /for-firms/ and /firm-mobility/ respectively (no new marketing copy
    invented), and sends anyone who wants to actually run a check to the
    real tool at /firm-mobility/.
    """
    body = f"""<h1>Practice Privilege Check: Can a CPA Work in Another State Without a License?</h1>
<p class="subhead">Can this CPA provide this service in this state &mdash; and what has to happen
first? Every answer is tied to the rule it came from.</p>

<div class="dr-mobility-callout">
  <strong>Informational, not legal advice.</strong> Practice-privilege rules change, and they depend on
  facts we can't see. We show you the rule and where it came from so you can check it yourself &mdash;
  and where we haven't verified something against a primary source, we say so instead of guessing.
  Confirm with the state board before you rely on any answer here.
</div>

<h2>What Practice Privilege Check actually does</h2>
<p>A different question from renewal dates: can this CPA provide this specific service in this specific
state right now, without a local license &mdash; and what has to happen first? Pick a service type (Tax;
Attest &mdash; audit, review, or other attest; or Other non-attest &mdash; consulting, advisory). Attest
work frequently triggers a firm-registration requirement where tax work doesn't &mdash; that gap is the
most common real-world mobility mistake, and this catches it. The determination needs two inputs only
you can attest to &mdash; that the license is active and in good standing, and that the CPA meets
substantial equivalence (150 semester hours, one year of experience, the Uniform CPA Exam) &mdash; we
can't verify either one ourselves, so the answer is only as good as what you tell it, same honesty
standard as every renewal date on this site. Verified in all 55 U.S. jurisdictions today, both for the
individual question above and a separate firm-level registration check (does the FIRM itself need to
register somewhere it has no office, even when the individual CPA is covered). The individual check is
free on every tier, for any account &mdash; a free signup is all it takes, no card, no paid plan
required; <a href="/pricing/">the firm-level check and the multistate coverage map are part of a paid
plan</a>.</p>

<p><a class="cta-button" href="{REMINDER_BACKEND_BASE_URL}/firm/demo-login">Run a free check now &rarr;</a></p>

<p><strong>Tracking a whole firm's roster, not just one lookup?</strong> See the
<a href="/for-firms/">firm overview</a> &mdash; Roster, Calendar, CPE tracking, and individual Practice
Privilege Check are free there too; paid tiers add the multistate map and the firm-level registration
check. See <a href="/pricing/">full pricing</a>.</p>

<p class="backlink"><a href="/">&larr; Back to all states</a></p>
"""
    return page_shell(
        f"Practice Privilege Check — {SITE_NAME}",
        "What CPA practice privilege (mobility) means, how substantial equivalence works, and how to "
        "check whether a CPA can serve a client in another state without a local license -- free, "
        "verified in all 55 U.S. jurisdictions.",
        body,
        home_href="../",
        canonical_path="/practice-privilege-check/",
        has_remind_anchor=False,
    )


def build_multi_state_firms_page() -> str:
    """Roadmap #337: one page assembling Map + Practice Privilege Check +
    Rule Changes for a firm whose staff span multiple states -- explicitly
    ONE page, not six state-segment pages (the item's own instruction).
    Each of the three pillars reuses existing, already-shipped copy
    verbatim (the Map value-callout text from the dashboard, the rule-
    changes feed's own intro sentence) rather than inventing new marketing
    claims about features described precisely elsewhere."""
    body = f"""<h1>Running a Multi-State CPA Firm? Here's the Full Picture.</h1>
<p class="intro">A firm with staff licensed or practicing across more than one state has a genuinely
different problem than a single-state firm: knowing where everyone can legally work, catching it before
a rule changes underneath you, and keeping a citation behind every answer. Three pieces of this site
work together for exactly that.</p>

<h2>1. Map &mdash; see every state your team can practice in</h2>
<p>A color-coded map of exactly which states your team can practice in today without a local license,
plus a firm-level registration check for attest work where your firm itself (not just the individual
CPA) needs to register. Part of a paid firm plan &mdash; <a href="/pricing/">see plans</a>.</p>

<h2>2. Practice Privilege Check &mdash; verify before staff take on out-of-state work</h2>
<p>Before a staff CPA takes on work in a state they're not locally licensed in, run the check: service
type, home state, target state, and the answer comes back with the rule and citation behind it &mdash;
never a guess. <a href="/practice-privilege-check/">Free for any account, no paid plan required</a>.</p>

<h2>3. Rule Changes &mdash; a running feed, not a one-time check</h2>
<p>A running feed of confirmed and pending changes to interstate CPA mobility rules &mdash; practice
privileges, notice/fee requirements, and firm registration &mdash; sourced the same way as every other
date on this site: a citation to the primary statute or rule, never a guess. Your firm's own calendar
surfaces the changes that actually affect your roster's states.
<a href="/rule-changes/">See the full public feed</a>.</p>

<p><a class="cta-button" href="{REMINDER_BACKEND_BASE_URL}/firm/demo-login">Try the live demo &rarr;</a></p>

<p><strong>New to DeadlineRadar?</strong> See the <a href="/for-firms/">full firm overview</a> for
pricing, the whole feature set, and how renewal-date tracking fits alongside these three.</p>

<p class="backlink"><a href="/">&larr; Back to all states</a></p>
"""
    return page_shell(
        f"Multi-State CPA Firms: Map, Mobility Check, and Rule Changes — {SITE_NAME}",
        "For a CPA firm with staff across multiple states: a coverage map, a free Practice Privilege "
        "Check, and a running feed of mobility rule changes -- all sourced and cited.",
        body,
        home_href="../",
        canonical_path="/multi-state-firms/",
        has_remind_anchor=False,
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

    Edit is scoped to staff_label/email/license-expiration-date (only for
    "bring your own date" records -- see the edit modal's own JS comments),
    never state or license type: GET /firm/licenses only returns
    license_type_id (see index.ts's toFirmLicenseJson()), never the
    underlying raw birth_month/birth_year/cohort_group a PATCH would need
    alongside a state_slug change to keep resolveDeadlineInput() happy. An
    edit UI that touched those fields without the real current values to
    pre-fill would either have to guess (risking silently corrupting a
    working deadline) or force a full re-entry that looks like an edit but
    actually resets configuration the admin never meant to touch. The one
    exception, license_expiration_date, doesn't have this problem: it IS
    the raw stored value for a "bring your own date" record (no per-state
    fields to reconstruct), which is exactly why it's the one deadline
    field this form can safely expose (2026-08-06, Devin caught the gap
    live -- the "edit their record with the new date" banner had nothing to
    edit). To change someone's state or license type, remove and re-add
    them -- safe, unambiguous, no silent data loss."""
    add_staff_html = _firm_dashboard_add_staff_form_html(by_slug, as_of)
    map_svg_html = _firm_dashboard_map_svg_html(by_slug)
    # Calendar tab, "upcoming rule changes" (2026-08-06, reported directly by
    # Devin live-testing the calendar): the same sourced feed /rule-changes/
    # already publishes (data/reg_change_events.json), reused here rather
    # than a second dataset -- inlined at build time same as
    # cpe_requirements_json below, since it's small, static, and identical
    # for every firm. Client-side JS (drRuleChangeEventsForFirm()) filters
    # this down to only the jurisdictions a firm actually has staff in --
    # "affects one of the firm's staff" is a roster-dependent, per-firm
    # question this static page can't answer at build time. Scoped to
    # kind=='rule_change' AND upcoming (excludes source_conflict entries,
    # which aren't confirmed changes, and already-effective ones, which
    # belong on the roster/deadline surfaces instead) -- matches
    # build_rule_changes_page()'s own "Upcoming changes" section exactly, so
    # this can never show something that page itself wouldn't stand behind.
    # summary_public ONLY, same reason as that page's own comment: never a
    # raw internal-prose field.
    _reg_change_raw = json.loads(REG_CHANGE_EVENTS_PATH.read_text(encoding="utf-8"))
    rule_change_events_json = [
        {
            "id": e["event_id"],
            "jurisdiction_slug": e["jurisdiction_slug"],
            "jurisdiction": e.get("jurisdiction") or e["jurisdiction_slug"],
            "effective_date": e["effective_date"],
            "topic": e.get("topic") or "",
            "summary": e.get("summary_public") or "",
            "citation": e.get("citation") or "",
            # AuditLab XSS-1 (LOW, 2026-08-06): the ONE data-file-sourced
            # href in the codebase that skipped a scheme guard -- the JS
            # assigns this straight to citeLink.href, where esc() (and
            # therefore http_href(), which esc()es) is the wrong tool: this
            # value travels via json.dumps, so the guard is the scheme
            # check alone, not entity escaping. None (not "#") on refusal --
            # the JS's `event.citation_url || '#'` fallback already handles
            # it.
            "citation_url": e["citation_url"]
            if isinstance(e.get("citation_url"), str) and e["citation_url"].startswith(("http://", "https://"))
            else None,
            "confidence": e.get("confidence") or "",
        }
        for e in _reg_change_raw.get("events", [])
        if e.get("kind") == "rule_change" and e.get("upcoming") and e.get("effective_date")
    ]
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
            # Roadmap #10 (2026-08-07): only 12 of 55 jurisdictions in
            # cpe_hours.json mention carryover in their free-text `notes` at
            # all -- not enough to assert a structured carryover_allowed/
            # carryover_max_hours fact for every state (silence elsewhere
            # could mean "genuinely none" or "not yet researched," and this
            # dataset can't tell those apart). Surfacing the raw, already-
            # published, already-cited sentence as a hint next to the
            # self-reported carryover input is honest either way -- it's the
            # SAME sentence the public CPE page for that state already shows,
            # not a new claim.
            "carryover_note": rec.get("notes") if rec.get("notes") and "carry" in rec.get("notes", "").lower() else None,
        }
        for slug, rec in cpe_hours_by_slug.items()
    }
    # AuditLab-adjacent finding, reported directly ("wouldn't everyone have a
    # license type?" -- 2026-08-04): the roster's License type column showed
    # "-" for most rows, not because the license type was unknown but because
    # license_type_id is only ever COLLECTED for states with real ambiguity
    # (the 18-state "Which license?" dropdown, computeSubscriberDeadline's
    # own `computed.length > 1` branch) -- every other state has exactly one
    # real answer that was simply never asked for or stored. For a
    # single-record state that one answer is unambiguous by construction, so
    # it's safe to fill in as a display-only default -- this does NOT touch
    # what's stored on the subscriber row, only what the roster shows when
    # license_type_id is empty. Matches computeSubscriberDeadline's own
    # criterion exactly (worker/src/deadline.ts): a state contributes a
    # default only when it has exactly one record, full stop -- California/
    # Texas/Ohio's single record and every one-record "bring your own date"
    # state (no next_deadline_computed at all) are included on the same
    # basis; the 18 real two-record states are deliberately excluded even
    # when a subscriber there also never picked one, because THAT case is a
    # genuine unresolved ambiguity, not a settled fact -- "-" stays honest
    # for those, matching this site's own no-guessing standard everywhere
    # else.
    default_license_type_id_json = {
        slug: recs[0]["id"] for slug, recs in by_slug.items() if len(recs) == 1
    }
    # Sidebar nav: Roster/Calendar/Map are real in-page tabs (2026-07-30, BUILD
    # v2 Phase D -- all three render from the SAME already-fetched drLicenses,
    # no separate page load/re-auth). Reports/Documents are still BUILD v2
    # phases F/G, not built yet -- shown as disabled "Soon" items (the intended
    # IA, honestly labeled) rather than either omitted (misrepresenting scope
    # as smaller than planned) or linked (a link to nothing would be a real
    # defect). Markup itself lives in _dashboard_sidebar_html() -- shared with
    # /firm-mobility/ (build_firm_mobility_page) so that page no longer loses
    # the sidebar entirely, see that helper's own docstring.
    sidebar_html = _dashboard_sidebar_html("roster", tabs_live_here=True)
    body = f"""<div class="dr-dash-shell">
  {sidebar_html}

  <div class="dr-product-tour" id="dr-product-tour" hidden role="dialog" aria-label="Product tour" aria-describedby="dr-product-tour-body">
    <div class="dr-product-tour-step" id="dr-product-tour-step"></div>
    <p id="dr-product-tour-body"></p>
    <div class="dr-product-tour-actions">
      <button type="button" class="dr-link-btn" id="dr-product-tour-skip-btn">Skip tour</button>
      <button type="button" class="dr-btn-edit" id="dr-product-tour-next-btn">Next</button>
    </div>
  </div>

  <div class="dr-main">
    <div id="dr-dash-error" class="callout" style="border-left-color:#c33737;" role="alert" hidden></div>
    <div id="dr-dash-success" class="callout" style="border-left-color:var(--verified-green);" role="status" hidden></div>
    <div id="dr-dash-warning" class="callout" style="border-left-color:var(--gold);" role="status" hidden></div>
    <div id="dr-staleness-banner" class="callout" style="border-left-color:#b8860b;" hidden></div>
    <div id="dr-demo-banner" class="callout" style="border-left-color:var(--accent);" role="status" hidden>
      You&rsquo;re signed in to the <strong>shared live demo</strong> firm &mdash; this is real data
      other visitors also see, not a private account. <a href="/for-firms/#firm-signup">Create your
      own firm account</a> to try this with your own roster.
    </div>
    <div id="dr-sample-mode-banner" class="callout dr-sample-mode-banner" style="border-left-color:var(--accent);" role="status" hidden>
      You&rsquo;re viewing sample data &mdash; nothing here is real, and no reminders will be sent for it.
      <button type="button" class="dr-link-btn" id="dr-sample-mode-exit-btn">Exit sample view</button>
    </div>
    <!-- AuditLab SAMPLE-2 (2026-08-07 follow-up): the print stylesheet hides
         the sample banner above by design (dashboard chrome), which left a
         printed page with NO indication its rows are fabricated. This
         notice is the inverse: invisible on screen, shown ONLY in print,
         toggled with the same sample-mode state as the banner. Covers
         every print path at once -- the Reports button, #36's Roster
         button, and a plain Ctrl+P no button-gating could catch. -->
    <p class="dr-print-sample-notice" id="dr-print-sample-notice" hidden>SAMPLE DATA &mdash; every
    person and date on this page is fictional preview content, not this firm&rsquo;s real roster.</p>

    <div id="dr-view-roster" class="dr-view" role="tabpanel">
    <div class="dr-report-toolbar">
      <div>
        <h1>Coverage overview</h1>
        <p class="subhead">Every CPA license you're tracking for your firm, at a glance.</p>
      </div>
      <!-- Roadmap #36: the same @media print rule the Reports tab's print
           button already uses is scoped globally, not per-tab -- this makes
           it discoverable from Roster too. Same label as that button
           (not "Print roster" specifically) since this prints the whole
           visible Coverage overview -- stat cards and panels included, not
           just the table -- and the button shouldn't claim narrower scope
           than what actually comes out of the printer. -->
      <button type="button" class="dr-btn-edit" id="dr-roster-print-btn">Print / Save as PDF</button>
    </div>

    <div class="dr-onboarding-checklist" id="dr-onboarding-checklist" hidden>
      <div class="dr-onboarding-checklist-head">
        <h2>Getting started</h2>
        <button type="button" class="dr-onboarding-dismiss" id="dr-onboarding-dismiss-btn" aria-label="Dismiss checklist">&times;</button>
      </div>
      <ul>
        <li id="dr-onboarding-step-staff" class="dr-onboarding-step">Add your first staff member</li>
        <li id="dr-onboarding-step-calendar" class="dr-onboarding-step"><a href="#" data-view="calendar">Look at your Calendar</a></li>
        <li id="dr-onboarding-step-map" class="dr-onboarding-step"><a href="#" data-view="map">Check the Map</a></li>
        <li id="dr-onboarding-step-cpe" class="dr-onboarding-step"><a href="#" data-view="cpe">Log a CPE hour entry</a></li>
      </ul>
    </div>

    <div class="dr-stat-row" id="dr-stat-row"></div>

    <div class="dr-panel" id="dr-peer-review-panel">
      <div class="dr-onboarding-checklist-head">
        <h2>Peer review</h2>
      </div>
      <div id="dr-peer-review-body"></div>
    </div>

    <div class="dr-panel" id="dr-renewal-fee-panel">
      <div class="dr-onboarding-checklist-head">
        <h2>Renewal costs</h2>
      </div>
      <div id="dr-renewal-fee-body"></div>
    </div>

    <!-- Roadmap #66 (2026-08-07): "what changed since your last login" --
         previous_login_at comes from GET /firm/licenses (store.getPreviousLoginAt(),
         the most recent OTHER firm_sessions row -- no new migration). Counted
         against drLicenses' own last_edited_at client-side, since that data's
         already loaded for this same view; no second fetch. -->
    <div class="callout" id="dr-last-login-banner" hidden>
      <p><span id="dr-last-login-banner-text"></span>
      <button type="button" class="dr-link-btn" id="dr-last-login-banner-dismiss">Dismiss</button></p>
    </div>

    <div class="dr-panel-row">
      <div class="dr-panel">
        <h2>Staff at risk</h2>
        <ul class="dr-at-risk-list" id="dr-at-risk-list" role="status" aria-live="polite">
          <li class="dr-visually-hidden">Loading&hellip;</li>
          <li aria-hidden="true"><div class="dr-skeleton-line"></div><div class="dr-skeleton-line"></div><div class="dr-skeleton-line"></div></li>
        </ul>
      </div>
      <div class="dr-panel">
        <h2>Recent activity</h2>
        <ul class="dr-activity-list" id="dr-activity-list">
          <li class="dr-visually-hidden">Loading&hellip;</li>
          <li aria-hidden="true"><div class="dr-skeleton-line"></div><div class="dr-skeleton-line"></div><div class="dr-skeleton-line"></div></li>
        </ul>
      </div>
    </div>

    <div class="dr-roster-panel">
      <h2>Full roster</h2>
      <div class="dr-audit-filter">
        <select id="dr-office-group-filter" aria-label="Group roster by office or department">
          <option value="">All offices/departments</option>
        </select>
        <select id="dr-due-within-filter" aria-label="Filter roster by deadline window">
          <option value="">Any time</option>
          <option value="30">Due within 30 days</option>
          <option value="90">Due within 90 days (this quarter)</option>
          <option value="365">Due within 1 year</option>
        </select>
      </div>
      <details class="dr-bulk-tag-panel">
        <summary>Bulk-tag staff</summary>
        <label for="dr-bulk-tag-staff-select">Staff to tag (select multiple)</label>
        <select id="dr-bulk-tag-staff-select" multiple size="5"></select>
        <label for="dr-bulk-tag-value">Office / department</label>
        <input type="text" id="dr-bulk-tag-value" maxlength="60" placeholder="e.g. Downtown office &ndash; leave blank to clear">
        <button type="button" id="dr-bulk-tag-apply-btn">Apply to selected</button>
        <p class="dr-modal-hint" id="dr-bulk-tag-status"></p>
      </details>
      <div class="dr-audit-filter">
        <input type="text" id="dr-roster-search" placeholder="Search by name or email&hellip;" aria-label="Search roster by name or email">
        <!-- Roadmap #40 (2026-08-07): the clickable column headers below the
             table's own <thead> are the primary way to sort on desktop, but
             the mobile stacked-card layout moves <thead> off-screen
             (position:absolute; left:-9999px -- the existing card layout's
             own long-standing fix for the OLD purely-informational header
             row). That silently made #37's sort buttons unreachable on
             mobile -- found by tracing through this exact CSS rule, since a
             real narrow-viewport render wasn't available to test directly
             in this session (noted honestly rather than claimed as visually
             verified). This select uses the SAME drRosterSortColumn/
             drRosterSortDir state and drApplyRosterSort() the header
             buttons already drive, kept in sync both directions, and stays
             visible at every width -- also a more standard accessible
             pattern than click-only header sorting on its own. -->
        <select id="dr-roster-sort-select" aria-label="Sort roster">
          <option value="">Sort by&hellip;</option>
          <option value="staff:asc">Staff (A-Z)</option>
          <option value="staff:desc">Staff (Z-A)</option>
          <option value="state:asc">State (A-Z)</option>
          <option value="state:desc">State (Z-A)</option>
          <option value="license_type:asc">License type (A-Z)</option>
          <option value="license_type:desc">License type (Z-A)</option>
          <option value="status:asc">Status (A-Z)</option>
          <option value="status:desc">Status (Z-A)</option>
          <option value="next_deadline:asc">Next deadline (soonest first)</option>
          <option value="next_deadline:desc">Next deadline (latest first)</option>
        </select>
      </div>
      <!-- Roadmap #38: saved custom views (e.g. "staff expiring this
           quarter") -- captures the CURRENT search/office-tag/due-within/
           sort combination under a name, stored in this browser only
           (localStorage, no new backend endpoint for what's fundamentally a
           personal shortcut, not firm data other admins or devices need to
           see). -->
      <details class="dr-bulk-tag-panel">
        <summary>Saved views</summary>
        <label for="dr-saved-view-name">Save the current search/filter/sort as</label>
        <input type="text" id="dr-saved-view-name" maxlength="60" placeholder="e.g. Staff expiring this quarter">
        <button type="button" id="dr-save-view-btn">Save view</button>
        <div id="dr-saved-views-list"></div>
      </details>
      <div class="table-wrap" role="status" aria-live="polite">
      <table>
        <caption class="dr-visually-hidden">Your firm's tracked CPA staff and their license renewal status</caption>
        <thead>
          <tr>
            <th scope="col"><button type="button" class="dr-sort-th" data-sort="staff">Staff<span class="dr-sort-arrow" aria-hidden="true"></span></button></th>
            <th scope="col"><button type="button" class="dr-sort-th" data-sort="state">State<span class="dr-sort-arrow" aria-hidden="true"></span></button></th>
            <th scope="col"><button type="button" class="dr-sort-th" data-sort="license_type">License type<span class="dr-sort-arrow" aria-hidden="true"></span></button></th>
            <th scope="col"><button type="button" class="dr-sort-th" data-sort="status">Status<span class="dr-sort-arrow" aria-hidden="true"></span></button></th>
            <th scope="col"><button type="button" class="dr-sort-th" data-sort="next_deadline">Next deadline<span class="dr-sort-arrow" aria-hidden="true"></span></button></th>
            <th scope="col" class="dr-actions-head">Actions</th>
          </tr>
        </thead>
        <tbody id="dr-roster-body">
          <tr><td colspan="6">Loading your roster...</td></tr>
        </tbody>
      </table>
      </div>
    </div>

    <div id="dr-edit-modal" class="dr-modal-overlay" hidden>
      <div class="dr-modal" role="dialog" aria-modal="true" aria-labelledby="dr-edit-modal-title">
        <h2 id="dr-edit-modal-title">Edit staff member</h2>
        <form id="dr-edit-modal-form">
          <label for="dr-edit-modal-label">Name or label</label>
          <input type="text" id="dr-edit-modal-label" maxlength="120" placeholder="Name or label">
          <label for="dr-edit-modal-email">Email</label>
          <input type="email" id="dr-edit-modal-email" required>
          <div id="dr-edit-modal-deadline-field" hidden>
            <label for="dr-edit-modal-deadline">License expiration date</label>
            <input type="date" id="dr-edit-modal-deadline">
            <p class="dr-modal-hint">This state has no automatic renewal rule we can compute, so we track whatever date is printed on the license -- update it here whenever it renews.</p>
          </div>
          <label for="dr-edit-modal-fee">Renewal fee (optional)</label>
          <input type="text" inputmode="decimal" id="dr-edit-modal-fee" placeholder="e.g. 199.00">
          <p class="dr-modal-hint">Self-reported -- whatever you know this renewal actually costs. Leave blank if unknown.</p>
          <label for="dr-edit-modal-carryover">CPE carryover hours (optional)</label>
          <input type="text" inputmode="decimal" id="dr-edit-modal-carryover" placeholder="e.g. 10">
          <p class="dr-modal-hint">Hours carried over from a prior CPE cycle, if this state allows it. Self-reported -- applied to this cycle's total-hours progress only, not ethics. Leave blank if none.</p>
          <p class="dr-modal-hint" id="dr-edit-modal-carryover-note" hidden></p>
          <label for="dr-edit-modal-office">Office / department (optional)</label>
          <input type="text" id="dr-edit-modal-office" maxlength="60" placeholder="e.g. Downtown office">
          <p class="dr-modal-hint">Your own label for grouping staff -- shown on the roster, used by the bulk-tag tool below it. Leave blank if you don't need groups.</p>
          <label for="dr-edit-modal-notes">Internal notes (optional)</label>
          <textarea id="dr-edit-modal-notes" maxlength="500" rows="2" placeholder="e.g. Out on leave through March"></textarea>
          <p class="dr-modal-hint">For your own reference only -- never shown to this person or in any email they receive.</p>
          <div class="dr-modal-actions">
            <button type="submit" class="dr-btn-save">Save</button>
            <button type="button" class="dr-btn-cancel" id="dr-edit-modal-cancel">Cancel</button>
          </div>
        </form>
      </div>
    </div>

    <div id="dr-documents-modal" class="dr-modal-overlay" hidden>
      <div class="dr-modal" role="dialog" aria-modal="true" aria-labelledby="dr-documents-modal-title">
        <h2 id="dr-documents-modal-title">Documents</h2>
        <p class="dr-modal-hint">PDF, JPG, or PNG, up to 2MB per file.</p>
        <form id="dr-documents-upload-form">
          <label for="dr-documents-kind">Document type</label>
          <select id="dr-documents-kind" required>
            <option value="">Select&hellip;</option>
            <option value="license">License certificate</option>
            <option value="cpe">CPE completion certificate</option>
          </select>
          <label for="dr-documents-file">File</label>
          <input type="file" id="dr-documents-file" accept="application/pdf,image/jpeg,image/png" required>
          <div class="dr-modal-actions">
            <button type="submit" class="dr-btn-save">Upload</button>
          </div>
        </form>
        <p id="dr-documents-error" role="alert" class="field-hint" style="color:#c33737;" hidden></p>
        <div id="dr-documents-list"><p class="dr-panel-empty">Loading&hellip;</p></div>
        <div class="dr-modal-actions">
          <button type="button" class="dr-btn-cancel" id="dr-documents-modal-close">Close</button>
        </div>
      </div>
    </div>

    {add_staff_html}

    <div class="dr-panel" id="dr-new-hire-checklist" hidden>
      <div class="dr-onboarding-checklist-head">
        <h2 id="dr-new-hire-checklist-title">Multi-state checklist</h2>
        <button type="button" class="dr-onboarding-dismiss" id="dr-new-hire-checklist-dismiss" aria-label="Dismiss">&times;</button>
      </div>
      <div id="dr-new-hire-checklist-body"></div>
    </div>
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
            <a class="dr-cal-export" href="{REMINDER_BACKEND_BASE_URL}/firm/calendar.ics" title="Downloads a one-time snapshot -- it will not stay in sync with future roster changes">Download .ics</a>
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
      <!-- Roadmap #42: a free-tier firm previously only learned the Map was
           paid by clicking in and hitting a denial (#dr-map-mobility-note's
           "part of the paid firm plan" text below, which still fires --
           Task #12's 2026-08-05 design intentionally kept that as the
           reactive explanation). This adds the proactive "why you'd want
           this" framing before that point, shown/hidden by
           drRenderMapValueCallout() once billing status is known.
           2026-08-10: individual Practice Privilege Check dropped OUT of
           this pitch -- it's free on every tier now, so listing it as
           something upgrading unlocks would be actively wrong. -->
      <div class="callout" id="dr-map-value-callout" hidden>
        <p><strong>What upgrading unlocks:</strong> a color-coded map of exactly which states your
        team can practice in today without a local license, plus a firm-level registration check for
        attest work where your firm itself (not just the individual CPA) needs to register. Roster,
        calendar, CPE-hour tracking, and individual Practice Privilege Check stay free either way.
        <a href="#" data-view="account">See plans</a>.</p>
      </div>
      <div class="dr-map-controls">
        <label for="dr-map-staff-select">Show</label>
        <select id="dr-map-staff-select">
          <option value="">All staff (home-state licensing)</option>
        </select>
      </div>
      <p class="dr-map-mobility-note" id="dr-map-mobility-note" hidden></p>
      <p class="dr-verdict-disclaimer" id="dr-map-mobility-disclaimer" hidden></p>
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
          <label for="dr-cpe-certificate">Completion certificate (optional)</label>
          <input type="file" id="dr-cpe-certificate" accept="application/pdf,image/jpeg,image/png">
          <p class="field-hint">PDF, JPG, or PNG, up to 2MB. Saved to this staff member&rsquo;s Documents.</p>
          <button type="submit">Log hours</button>
        </form>
        <p id="dr-cpe-log-error" role="alert" class="field-hint" style="color:#c33737;" hidden></p>
      </div>

      <div class="dr-cpe-log-panel">
        <h2>Recently logged</h2>
        <div id="dr-cpe-recent-body"><p class="dr-panel-empty">Loading&hellip;</p></div>
      </div>
    </div>

    <div id="dr-view-reports" class="dr-view" role="tabpanel" hidden>
      <div class="dr-report-toolbar">
        <div>
          <h1>Compliance Summary</h1>
          <p class="subhead">A printable snapshot of your firm's renewal and CPE status, for
          leadership or your own records.</p>
        </div>
        <button type="button" class="dr-btn-edit" id="dr-report-print-btn">Print / Save as PDF</button>
        <button type="button" class="dr-btn-edit" id="dr-report-csv-btn">Download CSV</button>
      </div>
      <div id="dr-report-body"><p class="dr-panel-empty">Loading&hellip;</p></div>

      <h2>Audit trail</h2>
      <p class="subhead">A dated record of every roster change and reminder actually sent -- evidence
      of a reasonable process, for a board inquiry or your own file.</p>
      <div class="dr-audit-filter">
        <input type="text" id="dr-audit-search" placeholder="Search by staff name&hellip;" aria-label="Search audit trail by staff name">
        <select id="dr-audit-event-filter" aria-label="Filter audit trail by event type">
          <option value="">All events</option>
          <option value="added">Added to roster</option>
          <option value="edited">Record updated</option>
          <option value="renewed">Marked renewed</option>
          <option value="opted_out">Opted out</option>
          <option value="removed">Removed from roster</option>
          <option value="reminded">Reminder sent</option>
        </select>
      </div>
      <div id="dr-audit-trail-body"><p class="dr-panel-empty">Loading&hellip;</p></div>
    </div>

    <div id="dr-view-account" class="dr-view" role="tabpanel" hidden>
      <h1>Account</h1>
      <div class="callout" id="dr-account-demo-lockdown-banner" style="border-left-color:#b8860b;" hidden>
      This is a shared demo account &mdash; email, password, billing, and delete-account changes are
      disabled here so one visitor can't break the demo for the next one.</div>

      <div class="dr-account-panel">
        <h2>Help</h2>
        <p class="signup-microcopy">New here, or just want a refresher on what each part of the dashboard does?</p>
        <button type="button" class="dr-btn-edit" id="dr-product-tour-replay-btn">Take the tour again</button>
      </div>

      <div class="dr-account-panel" id="dr-billing-panel">
        <h2>Billing</h2>
        <div id="dr-billing-body"><p class="dr-panel-empty">Loading&hellip;</p></div>
        <p id="dr-billing-ok" class="dr-account-ok" hidden></p>
        <p id="dr-billing-error" role="alert" class="dr-account-err" hidden></p>
      </div>

      <div class="dr-account-panel" id="dr-referral-panel">
        <h2>Refer a firm</h2>
        <p class="signup-microcopy">Share your link with another CPA firm. When they sign up for a
        paid plan, you both get 10% off your next invoice. A new code with up to 10 uses arrives
        on every paid invoice, replacing the old one.</p>
        <div id="dr-referral-body"><p class="dr-panel-empty">Loading&hellip;</p></div>
      </div>

      <div class="dr-account-panel">
        <h2>Email address</h2>
        <p class="signup-microcopy">Currently signed in as <strong id="dr-current-email">&hellip;</strong>.
        Changing this sends a confirmation link to the NEW address &mdash; nothing changes until you
        click it there.</p>
        <form id="dr-change-email-form" method="post" action="{REMINDER_BACKEND_BASE_URL}/firm/change-email">
          <label for="dr-new-email">New email address</label>
          <input type="email" id="dr-new-email" name="new_email" required autocomplete="email">
          <label for="dr-change-email-current-password">Current password <span class="field-hint">(leave blank if you've never set one)</span></label>
          <input type="password" id="dr-change-email-current-password" name="current_password" autocomplete="current-password">
          <button type="submit">Send confirmation link</button>
        </form>
        <p id="dr-change-email-ok" class="dr-account-ok" hidden></p>
        <p id="dr-change-email-error" role="alert" class="dr-account-err" hidden></p>
      </div>

      <div class="dr-account-panel">
        <h2>Reminder email branding</h2>
        <p class="signup-microcopy">Every reminder your staff receive already mentions your firm's
        name. Optionally set a reply-to address so a reply reaches you directly instead of
        DeadlineRadar &mdash; reminders still send from DeadlineRadar's own address; only where a
        reply goes changes.</p>
        <form id="dr-reply-to-form">
          <label for="dr-reply-to-input">Reply-to address (optional)</label>
          <input type="email" id="dr-reply-to-input" placeholder="you@yourfirm.com">
          <button type="submit">Save</button>
        </form>
        <p id="dr-reply-to-ok" class="dr-account-ok" hidden></p>
        <p id="dr-reply-to-error" role="alert" class="dr-account-err" hidden></p>
      </div>

      <div class="dr-account-panel">
        <h2>Reminder timing</h2>
        <p class="signup-microcopy">Choose which of the standard reminder points your staff
        receive. At least one must stay checked -- leave them all checked (the default) for the
        full escalating schedule.</p>
        <form id="dr-reminder-cadence-form">
          <fieldset class="dr-cadence-fieldset">
            <legend class="dr-visually-hidden">Reminder timing</legend>
            <label><input type="checkbox" name="cadence" value="60"> 60 days out</label>
            <label><input type="checkbox" name="cadence" value="30"> 30 days out</label>
            <label><input type="checkbox" name="cadence" value="14"> 14 days out</label>
            <label><input type="checkbox" name="cadence" value="7"> 7 days out</label>
            <label><input type="checkbox" name="cadence" value="3"> 3 days out</label>
            <label><input type="checkbox" name="cadence" value="1"> 1 day out (final reminder)</label>
          </fieldset>
          <button type="submit">Save</button>
        </form>
        <p id="dr-reminder-cadence-ok" class="dr-account-ok" hidden></p>
        <p id="dr-reminder-cadence-error" role="alert" class="dr-account-err" hidden></p>
      </div>

      <div class="dr-account-panel">
        <h2>Proactive rule-change alerts</h2>
        <p class="signup-microcopy">We'll email you when a new mobility rule change affects a state
        your roster is licensed in -- on by default. You still choose whether to notify staff; this
        just means you don't have to remember to check the Calendar yourself.</p>
        <form id="dr-rule-change-alerts-form">
          <label><input type="checkbox" id="dr-rule-change-alerts-checkbox" checked> Email me about
          new rule changes affecting my roster</label>
          <button type="submit">Save</button>
        </form>
        <p id="dr-rule-change-alerts-ok" class="dr-account-ok" hidden></p>
        <p id="dr-rule-change-alerts-error" role="alert" class="dr-account-err" hidden></p>
      </div>

      <div class="dr-account-panel">
        <h2>Firm-wide digest</h2>
        <p class="signup-microcopy">A periodic email bundling every newly-due renewal across your
        WHOLE roster, sent to you as the firm admin -- on by default for an eligible plan. Nobody's
        own individual reminder is affected either way; this is in addition to those, not instead of
        them.</p>
        <form id="dr-admin-digest-form">
          <label><input type="checkbox" id="dr-admin-digest-checkbox" checked> Email me a firm-wide
          digest of newly-due renewals</label>
          <button type="submit">Save</button>
        </form>
        <p id="dr-admin-digest-ok" class="dr-account-ok" hidden></p>
        <p id="dr-admin-digest-error" role="alert" class="dr-account-err" hidden></p>
      </div>

      <div class="dr-account-panel">
        <h2>Slack alerts</h2>
        <p class="signup-microcopy">Connect a Slack channel to get one daily digest of renewals that
        became newly due for your roster -- bundled into a single message, never one ping per
        deadline. Uses the same reminder timing you've already set above.</p>
        <div id="dr-slack-disconnected">
          <a href="{REMINDER_BACKEND_BASE_URL}/firm/integrations/slack/connect" class="dr-btn-secondary">Connect Slack</a>
        </div>
        <div id="dr-slack-connected" hidden>
          <p id="dr-slack-status-text"></p>
          <button type="button" id="dr-slack-disconnect-btn" class="dr-btn-secondary">Disconnect</button>
        </div>
        <p id="dr-slack-ok" class="dr-account-ok" hidden></p>
        <p id="dr-slack-error" role="alert" class="dr-account-err" hidden></p>
      </div>

      <div class="dr-account-panel">
        <h2>Microsoft Teams alerts</h2>
        <p class="signup-microcopy">Same daily digest as Slack, posted to a Teams channel instead.
        Microsoft retired one-click Teams connectors, so this one's manual: in Teams, open the
        channel, choose <strong>More options (&hellip;) &rarr; Workflows &rarr; "Send webhook alerts
        to a channel"</strong>, save it, then paste the webhook URL it gives you below.</p>
        <div id="dr-teams-disconnected">
          <form id="dr-teams-form">
            <label for="dr-teams-webhook-input">Teams webhook URL</label>
            <input type="url" id="dr-teams-webhook-input" placeholder="https://xxxxx.webhook.office.com/...">
            <button type="submit">Save</button>
          </form>
        </div>
        <div id="dr-teams-connected" hidden>
          <p>Connected.</p>
          <button type="button" id="dr-teams-clear-btn" class="dr-btn-secondary">Clear</button>
        </div>
        <p id="dr-teams-ok" class="dr-account-ok" hidden></p>
        <p id="dr-teams-error" role="alert" class="dr-account-err" hidden></p>
      </div>

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
        <p id="dr-password-error" role="alert" class="dr-account-err" hidden></p>
      </div>

      <div class="dr-account-panel">
        <h2>Two-factor authentication</h2>
        <p class="signup-microcopy">Require a code from an authenticator app, in addition to your
        password or sign-in link, before this account can be signed in. Doesn't apply when you sign
        in with Google &mdash; that already proves a real, typically 2FA-protected Google account.</p>
        <div id="dr-2fa-body"><p class="dr-panel-empty">Loading&hellip;</p></div>
        <p id="dr-2fa-error" role="alert" class="dr-account-err" hidden></p>
      </div>

      <div class="dr-account-panel">
        <h2>Sessions</h2>
        <p class="signup-microcopy">Where you're currently signed in. This can only show WHEN each
        session signed in and was last active -- not device or location, which DeadlineRadar has
        never recorded.</p>
        <div id="dr-sessions-list"><p class="dr-panel-empty">Loading&hellip;</p></div>
        <p id="dr-session-revoke-error" role="alert" class="dr-account-err" hidden></p>
        <p class="signup-microcopy">Signed in somewhere you shouldn't be and don't recognize which row
        above it is? End every OTHER session at once instead.</p>
        <button type="button" id="dr-signout-other-btn">Sign out other devices</button>
        <p id="dr-signout-other-ok" class="dr-account-ok" hidden></p>
        <p id="dr-signout-other-error" role="alert" class="dr-account-err" hidden></p>
      </div>

      <div class="dr-account-panel">
        <h2>Connected sign-in accounts</h2>
        <p class="signup-microcopy">Accounts you can sign in with directly. Removing one doesn't lock
        you out &mdash; you can always request an emailed sign-in link.</p>
        <div id="dr-identities-body"><p class="dr-panel-empty">Loading&hellip;</p></div>
        <p id="dr-identity-error" role="alert" class="dr-account-err" hidden></p>
      </div>

      <div class="dr-account-panel">
        <h2>Team</h2>
        <p class="signup-microcopy">Everyone who can sign in to this firm's account, and what they
        can do. Partners have full access; Office Managers can manage the roster, CPE, and firm
        settings but not billing; Staff can view everything but not change it.</p>
        <div id="dr-team-list"><p class="dr-panel-empty">Loading&hellip;</p></div>
        <p id="dr-team-error" role="alert" class="dr-account-err" hidden></p>
        <p id="dr-team-upgrade-notice" class="signup-microcopy" hidden>Adding team members requires a
        paid plan. <a href="#account">Upgrade your plan</a> to invite your team &mdash; once you're on
        any paid tier, team members are included at no extra charge.</p>
        <form id="dr-team-invite-form" hidden>
          <label for="dr-team-invite-email">Invite someone by email</label>
          <input type="email" id="dr-team-invite-email" name="email" placeholder="name@yourfirm.com" required>
          <label for="dr-team-invite-role">Role</label>
          <select id="dr-team-invite-role" name="role" required></select>
          <button type="submit">Send invite</button>
        </form>
        <p id="dr-team-invite-ok" class="dr-account-ok" hidden></p>
        <p id="dr-team-invite-error" role="alert" class="dr-account-err" hidden></p>
      </div>

      <div class="dr-account-panel dr-danger-zone">
        <h2>Delete account</h2>
        <p class="signup-microcopy">Deactivates your account immediately -- your roster stops sending
        reminders and nobody can sign in, including you. The data is permanently erased 30 days later.
        This can't be undone.</p>
        <button type="button" class="dr-btn-danger" id="dr-delete-account-open-btn">Delete account&hellip;</button>
      </div>
    </div>
  </div>
</div>

<!-- Moved here from inside #dr-view-roster (2026-08-06: a Calendar-tab
     rule-change badge click did nothing visible). It opened correctly
     (hidden->false, real content filled in) but rendered at 0x0 -- a
     position:fixed descendant of a display:none ancestor (the Roster tab's own
     .dr-view[hidden] rule) still collapses to nothing, fixed positioning
     doesn't escape it. dr-delete-account-modal (right below) already lives
     outside every .dr-view for this exact reason -- this one just missed the
     pattern because it was added inline right after the Roster view's own
     markup. (dr-edit-modal has the identical nesting but never hits the bug
     in practice, since it's only ever opened while the Roster tab -- its own
     container -- is already the visible one; worth the same fix if it ever
     needs opening from elsewhere.) -->
<div id="dr-rule-change-modal" class="dr-modal-overlay" hidden>
  <div class="dr-modal" role="dialog" aria-modal="true" aria-labelledby="dr-rule-change-modal-title">
    <div class="rc-head">
      <span class="rc-jurisdiction" id="dr-rule-change-modal-title"></span>
      <span class="rc-badge rc-badge-upcoming">Upcoming</span>
    </div>
    <p class="rc-date" id="dr-rule-change-modal-date"></p>
    <p class="rc-detail" id="dr-rule-change-modal-summary"></p>
    <p class="rc-cite">
      <a id="dr-rule-change-modal-citation-link" target="_blank" rel="noopener"></a>
      <span class="rc-conf" id="dr-rule-change-modal-confidence"></span>
    </p>
    <p id="dr-rule-change-notify-result" class="dr-account-ok" hidden></p>
    <div class="dr-modal-actions">
      <button type="button" class="dr-btn-save" id="dr-rule-change-notify-btn">Notify staff in this state</button>
      <button type="button" class="dr-btn-cancel" id="dr-rule-change-modal-close">Close</button>
    </div>
  </div>
</div>

<div id="dr-questionnaire-modal" class="dr-modal-overlay" hidden>
  <div class="dr-modal" role="dialog" aria-modal="true" aria-labelledby="dr-questionnaire-modal-title">
    <h2 id="dr-questionnaire-modal-title">What would make this more useful for your firm?</h2>
    <p class="dr-modal-hint">Totally optional, one-time, and skippable -- just tell us what'd help, or skip it.</p>
    <form id="dr-questionnaire-form">
      <label class="dr-questionnaire-check"><input type="checkbox" name="feature" value="SMS reminders"> SMS reminders</label>
      <label class="dr-questionnaire-check"><input type="checkbox" name="feature" value="Practice-management integration"> Practice-management integration (QuickBooks, Karbon, Canopy)</label>
      <label class="dr-questionnaire-check"><input type="checkbox" name="feature" value="Batch Practice Privilege Check"> Batch Practice Privilege Check</label>
      <label class="dr-questionnaire-check"><input type="checkbox" name="feature" value="White-label / custom branding"> White-label / custom branding</label>
      <label class="dr-questionnaire-check"><input type="checkbox" name="feature" value="API access"> API access</label>
      <label class="dr-questionnaire-check"><input type="checkbox" name="feature" value="CPE certificate upload"> CPE certificate upload</label>
      <label class="dr-questionnaire-check"><input type="checkbox" name="feature" value="Slack / Teams notifications"> Slack / Teams notifications</label>
      <label class="dr-questionnaire-check"><input type="checkbox" name="feature" value="Custom reminder schedule"> Custom reminder schedule</label>
      <label for="dr-questionnaire-other" style="margin-top:0.7rem;">Something else? <span class="field-hint">(optional)</span></label>
      <textarea id="dr-questionnaire-other" class="dr-questionnaire-other" name="other_text" rows="2" maxlength="1000"></textarea>
      <div class="dr-modal-actions">
        <button type="submit" class="dr-btn-save" id="dr-questionnaire-submit-btn">Submit</button>
        <button type="button" class="dr-btn-cancel" id="dr-questionnaire-skip-btn">Skip</button>
      </div>
    </form>
    <p id="dr-questionnaire-error" role="alert" class="dr-account-err" hidden></p>
  </div>
</div>

<!-- Roadmap #144 (2026-08-07): 1-question NPS micro-survey, shown after a
     "Mark renewed" action or quarterly otherwise -- see drMaybeShowNpsPrompt()'s
     own comment for the trigger logic. -->
<div id="dr-nps-modal" class="dr-modal-overlay" hidden>
  <div class="dr-modal" role="dialog" aria-modal="true" aria-labelledby="dr-nps-modal-title">
    <h2 id="dr-nps-modal-title">Quick question</h2>
    <p class="dr-modal-hint">How likely are you to recommend DeadlineRadar to another firm?
    (0 = not at all, 10 = extremely likely)</p>
    <div class="dr-nps-scale" role="group" aria-label="Score, 0 to 10">
      <button type="button" class="dr-nps-score-btn" data-score="0">0</button>
      <button type="button" class="dr-nps-score-btn" data-score="1">1</button>
      <button type="button" class="dr-nps-score-btn" data-score="2">2</button>
      <button type="button" class="dr-nps-score-btn" data-score="3">3</button>
      <button type="button" class="dr-nps-score-btn" data-score="4">4</button>
      <button type="button" class="dr-nps-score-btn" data-score="5">5</button>
      <button type="button" class="dr-nps-score-btn" data-score="6">6</button>
      <button type="button" class="dr-nps-score-btn" data-score="7">7</button>
      <button type="button" class="dr-nps-score-btn" data-score="8">8</button>
      <button type="button" class="dr-nps-score-btn" data-score="9">9</button>
      <button type="button" class="dr-nps-score-btn" data-score="10">10</button>
    </div>
    <p class="dr-modal-hint"><button type="button" class="dr-link-btn" id="dr-nps-dismiss-btn">Not now</button></p>
    <p id="dr-nps-error" role="alert" class="dr-account-err" hidden></p>
  </div>
</div>

<!-- Roadmap #312 (2026-08-07): chained after a promoter-tier (>=9) NPS
     score, not its own separate quarterly prompt -- see
     drSubmitNpsScore()'s own comment. Never auto-published; a human
     reviews every submission before any public use. -->
<div id="dr-testimonial-modal" class="dr-modal-overlay" hidden>
  <div class="dr-modal" role="dialog" aria-modal="true" aria-labelledby="dr-testimonial-modal-title">
    <h2 id="dr-testimonial-modal-title">Glad to hear it!</h2>
    <p class="dr-modal-hint">Mind leaving a quick quote we could feature (with your permission)?
    Totally optional -- nothing you write here is published without you opting in below.</p>
    <form id="dr-testimonial-form">
      <label for="dr-testimonial-text" class="dr-visually-hidden">Your quote</label>
      <textarea id="dr-testimonial-text" maxlength="500" rows="3"
      placeholder="What's DeadlineRadar done for your firm?"></textarea>
      <label class="dr-questionnaire-check"><input type="checkbox" id="dr-testimonial-can-publish" checked>
      You can quote me publicly, with my firm's name</label>
      <div class="dr-modal-actions">
        <button type="submit" class="dr-btn-save">Submit</button>
        <button type="button" class="dr-btn-cancel" id="dr-testimonial-skip-btn">Not now</button>
      </div>
    </form>
    <p id="dr-testimonial-ok" class="dr-account-ok" hidden>Thank you!</p>
    <p id="dr-testimonial-error" role="alert" class="dr-account-err" hidden></p>
  </div>
</div>

<div id="dr-delete-account-modal" class="dr-modal-overlay" hidden>
  <div class="dr-modal" role="dialog" aria-modal="true" aria-labelledby="dr-delete-account-modal-title">
    <h2 id="dr-delete-account-modal-title">Delete your account?</h2>
    <p class="dr-modal-hint">Your account deactivates immediately -- nobody, including you, can sign in
    afterward, and your roster stops sending reminders right away. The underlying data is permanently
    erased 30 days from now. If you're on a paid plan, your subscription cancels immediately and we
    refund the prorated, unused portion of your current billing period. This can't be undone.</p>

    <form id="dr-delete-account-form">
      <p class="dr-modal-hint" style="margin-bottom:0.3rem;"><strong>Optional</strong> &mdash; help us
      improve (skip if you'd rather not):</p>
      <label for="dr-delete-reason">Reason</label>
      <select id="dr-delete-reason" name="reason">
        <option value="">Prefer not to say</option>
        <option value="too_expensive">Too expensive</option>
        <option value="missing_feature">Missing a feature we need</option>
        <option value="switching_tools">Switching to another tool</option>
        <option value="no_longer_needed">No longer needed</option>
        <option value="other">Other</option>
      </select>
      <label for="dr-delete-detail">Anything else? <span class="field-hint">(optional)</span></label>
      <textarea id="dr-delete-detail" name="detail" rows="2" maxlength="500"></textarea>

      <label for="dr-delete-confirm-name" style="margin-top:0.9rem;">Type your firm's name
      (<strong id="dr-delete-confirm-name-target"></strong>) to confirm</label>
      <input type="text" id="dr-delete-confirm-name" autocomplete="off">

      <!-- AuditLab DELETE-1 (HIGH, 2026-08-06): a session cookie alone used
           to be sufficient to delete the account, cancel billing, and
           trigger a real refund -- no proof of credential possession
           required. Mirrors the Password panel's own "leave blank if
           you've never set one" convention, since a magic-link-only firm
           genuinely has nothing to enter here (the backend skips the check
           entirely in that case). -->
      <label for="dr-delete-current-password" style="margin-top:0.9rem;">Current password
      <span class="field-hint">(leave blank if you've never set one)</span></label>
      <input type="password" id="dr-delete-current-password" autocomplete="current-password">

      <div class="dr-modal-actions">
        <button type="submit" class="dr-btn-danger" id="dr-delete-account-submit-btn" disabled>Permanently delete</button>
        <button type="button" class="dr-btn-cancel" id="dr-delete-account-cancel">Cancel</button>
      </div>
    </form>
    <p id="dr-delete-account-error" role="alert" class="dr-account-err" hidden></p>
  </div>
</div>

<script>
var DR_CPE_REQUIREMENTS = {json.dumps(cpe_requirements_json)};
var DR_DEFAULT_LICENSE_TYPE_ID = {json.dumps(default_license_type_id_json)};
var DR_RULE_CHANGE_EVENTS = {json.dumps(rule_change_events_json)};
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
{trust_line(record['last_verified'], record['source_url'], _record_fully_cited(record))}

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
    # Roadmap #47/#302: date folded into the badge itself -- see
    # _verified_badge_html()'s own docstring for the full rationale.
    cpe_verified_date = cpe_record.get("verified_date")
    verified_badge_label = f"Verified {esc(cpe_verified_date)}" if cpe_verified_date else "Verified"
    verified_badge_html = "" if data_gap_note else f'<span class="verified-badge">{verified_badge_label}</span>'
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


def _blog_guide_reverse_link_html(state_slug: str, state_name: str, guide_slugs_by_state: dict[str, str]) -> str:
    """Reverse cross-link (renewal page -> full renewal-guide blog post), same
    bidirectional-cross-link discipline as _cpe_hours_reverse_link_html() --
    every guide already links back to its state page, this closes the loop the
    other way. Renders nothing if this state has no dedicated guide yet (6 of
    55, as of 2026-08-10)."""
    guide_slug = guide_slugs_by_state.get(state_slug)
    if not guide_slug:
        return ""
    return (
        f'<p class="backlink-cross"><a href="../blog/{esc(guide_slug)}/">Read the full {esc(state_name)} '
        f'CPA renewal guide &rarr;</a></p>'
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
    # Roadmap #47/#302: date folded into the badge itself -- see
    # _verified_badge_html()'s own docstring for the full rationale.
    reinstatement_verified_date = record.get("last_verified")
    verified_badge_label = f"Verified {esc(reinstatement_verified_date)}" if reinstatement_verified_date else "Verified"
    verified_badge_html = "" if data_gap_note else f'<span class="verified-badge">{verified_badge_label}</span>'
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

{trust_line(record["last_verified"], record["source_url"], _record_fully_cited(record))}

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
when the license itself isn't up for renewal (20 CSR 2010-4.010(1)(B)). A Missouri CPA could renew
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
ethics hours, every single year, not just in "renewal years" (20 CSR 2010-4.010(1)(B)). If you fall
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
    {
        # 2026-08-07: standing weekly blog post, GSC-steered (Florida was the
        # highest-impressions state page with no dedicated guide yet and a
        # poor position -- see the 2026-08-07 GSC pull, 28-day window,
        # 82 impressions/position ~18.1/0% CTR, ranked above every other
        # uncovered state). Repackages fl-individual/fl-firm (data/cpa_deadlines.json)
        # and fl-cpe (data/cpe_hours.json) -- zero new legal research, same
        # process as every prior post in this series.
        "slug": "florida-cpa-license-renewal-guide",
        "title": "Florida CPA License Renewal: Why There's No Single Date to Give You",
        "meta_description": (
            "Florida CPA license renewal doesn't follow a public odd/even pattern for "
            "individuals -- here's why, what actually determines your date, the firm-license "
            "rule that IS fixed, and the 80-hour CPE requirement."
        ),
        "body_html": """
<p class="intro">If you've searched for "Florida CPA renewal date" expecting a single answer the way
Wisconsin or Illinois CPAs get one, here's the honest answer: for individual licenses, there isn't
one &mdash; and that's worth understanding rather than guessing at.</p>

<h2>Individual licenses: no public odd/even rule, despite what you might expect</h2>
<p>Florida CPA license renewal used to be described here (and in a lot of secondary sources online) as
following an odd/even-year cohort split, the same pattern many other states use. A 2026-07-05 data
review found that framing was wrong: Florida's Department of Business and Professional Regulation
(DBPR) runs individual CPA licenses on a rolling 2-year "reestablishment period" anchored to each
CPA's own <em>original certificate date</em> &mdash; not a publicly stated calendar rule. Checked
against DBPR's own live license-verification tool, real active licenses show both odd- and even-year
expirations simultaneously, confirming there's no single date that applies to "Florida CPAs" as a
group. <a href="../../florida/">Check your exact license status on Florida's own DBPR lookup, linked
from our Florida page</a> &mdash; it's the only way to know your actual date.</p>

<h2>Firm licenses: this part IS fixed &mdash; December 31 of odd-numbered years</h2>
<p>Unlike the individual-license picture, Florida firm licenses are simple: a single cohort expiring
December 31 of each odd-numbered year. This isn't a guess -- Florida's own public CPA license records
(DBPR's published license-data file, reviewed 2026-07-30) show 4,932 of 4,933 active firm licenses
sharing that same December 31, 2027 expiration, about as close to a universal rule as operational data
gets. If you're a firm owner rather than tracking your own individual license, this is the date that
actually applies to you.</p>

<h2>CPE: 80 hours per 2-year period, including 4 ethics hours</h2>
<p>Florida requires 80 CPE hours per 2-year re-establishment period (Fla. Admin. Code Ann. R.
61H1-33.003): at least 8 hours in accounting/auditing, at least 4 hours of Board-approved ethics (a
review of Chapters 455 and 473, Florida Statutes, and related rules), and no more than 20 hours in
behavioral subjects. There's no separate annual minimum written into the rule itself -- the 80-hour
count is checked against the full 2-year period. One date worth flagging separately from your license
renewal itself: CPE reporting is due <strong>July 31</strong>, ahead of the biennial renewal, not on
the renewal date itself.</p>

<p><strong>Bottom line</strong>: if you're an individual Florida CPA, don't trust an odd/even guess --
confirm your exact date on DBPR's own license lookup, since it's tied to your personal certificate
date, not a public calendar rule. If you're tracking a firm license instead, December 31 of odd years
is the real, confirmed date. Either way, your 80-hour/2-year CPE count (with its July 31 reporting
deadline) runs on its own separate clock.
<a href="../../florida/">See the full sourcing and set a reminder for your Florida deadline here</a>.</p>
""",
    },
]


def build_blog_article_page(article: dict) -> str:
    # AuditLab PROSE-1 (2026-08-07): every guide's factual claims now carry a
    # visible review date from data/guide_reviews.json -- the same registry
    # scripts/guide_review_staleness_check.py ages via the preship gate, so
    # this date can't quietly go stale without the gate surfacing it. A
    # guide missing from the registry fails loudly here rather than
    # rendering an unstamped page (the exact silent-gap failure mode
    # PROSE-1 is about).
    reviews = json.loads(GUIDE_REVIEWS_PATH.read_text(encoding="utf-8"))["guides"]
    review_row = reviews.get(article["slug"])
    if not review_row:
        raise RuntimeError(
            f"guide '{article['slug']}' has no row in data/guide_reviews.json -- "
            "add one with a real review date before shipping it"
        )
    reviewed_on = fmt_date(date.fromisoformat(review_row["last_reviewed"]))
    body = f"""<h1>{esc(article['title'])}</h1>
{article['body_html']}
<div class="guide-disclosure">
<p>This guide is general orientation, not a primary-source citation in itself &mdash; it draws on
board rules and, where available, this site's own verified dataset. Its factual claims were last
reviewed against those sources on <strong>{esc(reviewed_on)}</strong>. For the current renewal date
or CPE figures your state actually enforces, use the state page linked above: those carry a direct
link to the board page and codified rule, per our
<a href="../../methodology/">verification standard</a>.</p>
</div>
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
    # Roadmap #341: promote the CPE-vs-renewal guide out of the undifferentiated
    # chronological list -- it's this site's own core thesis (renewing your
    # license does not mean your CPE hours are current), referenced from more
    # other pages than any other guide. "Permanent structure" here means
    # featured placement + a footer link (see site_footer()), not a URL move --
    # this URL is already linked from elsewhere on the site and possibly
    # indexed, and a move would need real redirect infrastructure this repo
    # doesn't have yet. One page, no duplicate content, same URL.
    featured = next((a for a in articles if a["slug"] == "cpe-vs-license-renewal"), None)
    rest = [a for a in articles if a is not featured]
    featured_html = ""
    if featured:
        featured_html = f"""<a class="state-card guide-card--featured" href="{esc(featured["slug"])}/">
  <div class="guide-featured-label">Start here</div>
  <div class="state-name">{esc(featured["title"])}</div>
  <div class="state-hint">{esc(featured["meta_description"])}</div>
</a>"""
    cards = "\n".join(
        f'<a class="state-card" href="{esc(a["slug"])}/">'
        f'<div class="state-name">{esc(a["title"])}</div>'
        f'<div class="state-hint">{esc(a["meta_description"])}</div></a>'
        for a in rest
    )
    body = f"""<h1>Guides</h1>
<p class="intro">Deeper explainers on CPA license renewal and CPE deadlines &mdash; sourced the same
way as every state page on this site.</p>
{featured_html}
<div class="state-grid guide-grid">
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
    <loc>{SITE_BASE_URL}/terms/</loc>
    <lastmod>{as_of.isoformat()}</lastmod>
  </url>""", f"""  <url>
    <loc>{SITE_BASE_URL}/security/</loc>
    <lastmod>{as_of.isoformat()}</lastmod>
  </url>""", f"""  <url>
    <loc>{SITE_BASE_URL}/status/</loc>
    <lastmod>{as_of.isoformat()}</lastmod>
  </url>""", f"""  <url>
    <loc>{SITE_BASE_URL}/for-firms/</loc>
    <lastmod>{as_of.isoformat()}</lastmod>
  </url>""", f"""  <url>
    <loc>{SITE_BASE_URL}/pricing/</loc>
    <lastmod>{as_of.isoformat()}</lastmod>
  </url>""", f"""  <url>
    <loc>{SITE_BASE_URL}/compare/</loc>
    <lastmod>{as_of.isoformat()}</lastmod>
  </url>""", f"""  <url>
    <loc>{SITE_BASE_URL}/practice-privilege-check/</loc>
    <lastmod>{as_of.isoformat()}</lastmod>
  </url>""", f"""  <url>
    <loc>{SITE_BASE_URL}/multi-state-firms/</loc>
    <lastmod>{as_of.isoformat()}</lastmod>
  </url>""", f"""  <url>
    <loc>{SITE_BASE_URL}/roadmap/</loc>
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
    <loc>{SITE_BASE_URL}/changelog/</loc>
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
    for p in COMPETITOR_COMPARE_PAGES:
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
    guide_slugs_by_state = {
        a["slug"][: -len("-cpa-license-renewal-guide")]: a["slug"]
        for a in BLOG_ARTICLES if a["slug"].endswith("-cpa-license-renewal-guide")
    }

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

    # AuditLab SEO-3r (LOW, 2026-08-04): completes SEO-3 -- every og:/twitter:
    # tag except og:image was already correct; this was the one static asset
    # still missing. Copied verbatim, same pattern as the font above.
    og_image_src = ROOT / "assets" / "og-image.png"
    (SITE_DIR / "og-image.png").write_bytes(og_image_src.read_bytes())
    print(f"wrote {SITE_DIR.name}/og-image.png")

    # Roadmap #323 (2026-08-10, ValueLab design-pattern-mining #3): real
    # screenshots of the live demo firm's own dashboard, for the /for-firms/
    # product showcase (_PRODUCT_SHOWCASE_TABS below) -- not mockups, not
    # stock UI, not fabricated. Same copy-verbatim pattern as the font/
    # og-image above.
    showcase_src_dir = ROOT / "assets" / "showcase"
    showcase_dst_dir = SITE_DIR / "showcase"
    showcase_dst_dir.mkdir(parents=True, exist_ok=True)
    for showcase_file in sorted(showcase_src_dir.glob("*.jpg")):
        (showcase_dst_dir / showcase_file.name).write_bytes(showcase_file.read_bytes())
    print(f"wrote {SITE_DIR.name}/showcase/ ({len(list(showcase_src_dir.glob('*.jpg')))} images)")

    built = []
    for slug, recs in by_slug.items():
        title, page_html = build_state_page(
            slug, recs, as_of, by_slug, cpe_hours_by_slug, reinstatement_by_slug, guide_slugs_by_state,
        )
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

    COMPETITOR_COMPARE_PAGES.clear()
    for competitor_page_builder in (
        [lambda c=c: build_competitor_compare_page(c) for c in COMPETITOR_FACTS]
        + [build_mycpe_one_compare_page]
    ):
        c_slug, c_title, c_html = competitor_page_builder()
        c_dir = SITE_DIR / "compare" / c_slug
        c_dir.mkdir(parents=True, exist_ok=True)
        (c_dir / "index.html").write_text(c_html, encoding="utf-8")
        COMPETITOR_COMPARE_PAGES.append({"slug": f"compare/{c_slug}"})
        print(f"wrote {SITE_DIR.name}/compare/{c_slug}/index.html  ({c_title})")

    # sitemap.xml (below) reads FIRM_LANDING_PAGES, CPE_HOURS_PAGES,
    # REINSTATEMENT_PAGES, and COMPETITOR_COMPARE_PAGES, so it must be
    # written AFTER every loop above populates them.
    (SITE_DIR / "sitemap.xml").write_text(build_sitemap(built, as_of), encoding="utf-8")
    print(f"wrote {SITE_DIR.name}/sitemap.xml")

    (SITE_DIR / "robots.txt").write_text(build_robots(), encoding="utf-8")
    print(f"wrote {SITE_DIR.name}/robots.txt")

    (SITE_DIR / f"{INDEXNOW_KEY}.txt").write_text(INDEXNOW_KEY, encoding="utf-8")
    print(f"wrote {SITE_DIR.name}/{INDEXNOW_KEY}.txt (IndexNow key)")

    privacy_dir = SITE_DIR / "privacy"
    privacy_dir.mkdir(parents=True, exist_ok=True)
    (privacy_dir / "index.html").write_text(build_privacy_page(PRIVACY_LAST_CHANGED), encoding="utf-8")
    print(f"wrote {SITE_DIR.name}/privacy/index.html")

    terms_dir = SITE_DIR / "terms"
    terms_dir.mkdir(parents=True, exist_ok=True)
    (terms_dir / "index.html").write_text(build_terms_page(TERMS_LAST_CHANGED), encoding="utf-8")
    print(f"wrote {SITE_DIR.name}/terms/index.html")

    security_dir = SITE_DIR / "security"
    security_dir.mkdir(parents=True, exist_ok=True)
    (security_dir / "index.html").write_text(build_security_page(), encoding="utf-8")
    print(f"wrote {SITE_DIR.name}/security/index.html")

    status_dir = SITE_DIR / "status"
    status_dir.mkdir(parents=True, exist_ok=True)
    (status_dir / "index.html").write_text(build_status_page(), encoding="utf-8")
    print(f"wrote {SITE_DIR.name}/status/index.html")

    pricing_dir = SITE_DIR / "pricing"
    pricing_dir.mkdir(parents=True, exist_ok=True)
    (pricing_dir / "index.html").write_text(build_pricing_page(by_slug, as_of), encoding="utf-8")
    print(f"wrote {SITE_DIR.name}/pricing/index.html")

    compare_dir = SITE_DIR / "compare"
    compare_dir.mkdir(parents=True, exist_ok=True)
    (compare_dir / "index.html").write_text(build_compare_page(by_slug, as_of), encoding="utf-8")
    print(f"wrote {SITE_DIR.name}/compare/index.html")

    ppc_dir = SITE_DIR / "practice-privilege-check"
    ppc_dir.mkdir(parents=True, exist_ok=True)
    (ppc_dir / "index.html").write_text(build_practice_privilege_landing_page(), encoding="utf-8")
    print(f"wrote {SITE_DIR.name}/practice-privilege-check/index.html")

    multi_state_dir = SITE_DIR / "multi-state-firms"
    multi_state_dir.mkdir(parents=True, exist_ok=True)
    (multi_state_dir / "index.html").write_text(build_multi_state_firms_page(), encoding="utf-8")
    print(f"wrote {SITE_DIR.name}/multi-state-firms/index.html")

    roadmap_dir = SITE_DIR / "roadmap"
    roadmap_dir.mkdir(parents=True, exist_ok=True)
    (roadmap_dir / "index.html").write_text(build_roadmap_page(), encoding="utf-8")
    print(f"wrote {SITE_DIR.name}/roadmap/index.html")

    contact_dir = SITE_DIR / "contact"
    contact_dir.mkdir(parents=True, exist_ok=True)
    (contact_dir / "index.html").write_text(build_contact_page(), encoding="utf-8")
    print(f"wrote {SITE_DIR.name}/contact/index.html")

    methodology_dir = SITE_DIR / "methodology"
    methodology_dir.mkdir(parents=True, exist_ok=True)
    (methodology_dir / "index.html").write_text(build_methodology_page(records, real_today), encoding="utf-8")
    print(f"wrote {SITE_DIR.name}/methodology/index.html")

    changelog_dir = SITE_DIR / "changelog"
    changelog_dir.mkdir(parents=True, exist_ok=True)
    (changelog_dir / "index.html").write_text(build_changelog_page(), encoding="utf-8")
    print(f"wrote {SITE_DIR.name}/changelog/index.html")

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

    firm_2fa_dir = firm_login_dir / "2fa"
    firm_2fa_dir.mkdir(parents=True, exist_ok=True)
    (firm_2fa_dir / "index.html").write_text(build_firm_2fa_page(), encoding="utf-8")
    print(f"wrote {SITE_DIR.name}/firm-login/2fa/index.html")

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
    (my_dir / "index.html").write_text(build_my_page(cpe_hours_by_slug), encoding="utf-8")
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
