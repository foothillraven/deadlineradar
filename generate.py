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
# "docs" (not "site") deliberately -- this is the zero-config GitHub Pages
# convention (Settings > Pages > Deploy from a branch > /docs), so this
# directory becomes the deploy target as-is once a repo + Pages source exist.
# No repo/Pages source exists yet -- this only prepares the file structure.
SITE_DIR = ROOT / "docs"

# Placeholder only. No domain has been purchased, nothing here is deployed yet.
# Swap this single constant for the real https://<user>.github.io/<repo> URL
# (or a real domain later) once publishing is explicitly decided -- do not
# hardcode a real URL before that.
SITE_BASE_URL = "https://deadline-radar.com"

# Reminder backend (worker/, the Phase-1 Cloudflare Worker -- see
# worker/DEPLOY.md). Same-origin relative path, not a separate domain: the
# Worker is bound to the deadline-radar.com/api/* Route, so the form posts
# to the same site it's served from. STAGED ONLY -- per the Phase-1
# directive, this change is committed locally but deliberately NOT pushed
# until AFTER the Worker is deployed and verified responding (worker/
# DEPLOY.md step 6); pushing before that would point the live, public
# signup form at a route that doesn't exist yet.
REMINDER_BACKEND_BASE_URL = "/api"

# States the signup form supports -- must match reminders/server.py's
# SUPPORTED_STATE_SLUGS exactly. New York is deliberately excluded: its
# renewal rule depends on a fact (first-registration date) this dataset
# doesn't have, so no reminder can be computed for it.
REMINDER_UNSUPPORTED_STATES = {"new-york"}

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
BRAND_NAME = "Ravenline"


def esc(s: str) -> str:
    return html.escape(str(s), quote=True)


PAGE_CSS = """
  :root {
    color-scheme: light dark;
    --bg: #ffffff; --fg: #1a2129; --muted: #5b6572; --border: #d8dee5;
    --accent: #1f5fbf; --accent-bg: #eaf1fc; --card-bg: #f7f9fb;
    --trust-bg: #fff8e6; --trust-border: #e3c476; --row-alt: #f3f5f7;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #12151a; --fg: #e7ebf0; --muted: #9aa5b1; --border: #2a323c;
      --accent: #7fb0ff; --accent-bg: #1b2836; --card-bg: #1a1f26;
      --trust-bg: #26210f; --trust-border: #5a4a20; --row-alt: #171b21;
    }
  }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    max-width: 800px; margin: 0 auto; padding: 0 1.25rem 3rem;
    line-height: 1.55; color: var(--fg); background: var(--bg);
  }
  a { color: var(--accent); }
  .site-header {
    display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.35rem 1rem;
    padding: 1.5rem 0 1rem; border-bottom: 1px solid var(--border); margin-bottom: 1.75rem;
  }
  .wordmark { font-size: 1.35rem; font-weight: 800; letter-spacing: -0.02em; }
  .wordmark a { color: var(--fg); text-decoration: none; }
  .tagline { color: var(--muted); font-size: 0.92rem; flex: 1 1 auto; }
  .by-line { color: var(--muted); font-size: 0.85rem; white-space: nowrap; }
  h1 { font-size: 1.7rem; margin: 0 0 0.3rem; line-height: 1.25; }
  .subhead { color: var(--muted); margin: 0 0 1.5rem; }
  .intro { margin: 0 0 1.25rem; }
  .callout {
    border: 1px solid var(--border); border-left: 4px solid var(--accent); border-radius: 8px;
    padding: 1.15rem 1.4rem; background: var(--card-bg); margin: 1.4rem 0;
  }
  .callout + .callout { margin-top: 1rem; }
  .callout .label {
    font-size: 0.78rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em;
  }
  .callout .date { font-size: 1.7rem; font-weight: 700; margin: 0.2rem 0 0.5rem; }
  .callout .rule { margin: 0; }
  .table-wrap {
    overflow-x: auto; margin: 1.1rem 0; border: 1px solid var(--border); border-radius: 8px;
    -webkit-overflow-scrolling: touch;
  }
  table { border-collapse: collapse; width: 100%; font-size: 0.92rem; min-width: 420px; }
  th, td { padding: 0.6rem 0.8rem; text-align: left; border-bottom: 1px solid var(--border); white-space: nowrap; }
  th { background: var(--accent-bg); font-weight: 700; }
  tbody tr:nth-child(even) { background: var(--row-alt); }
  tbody tr:last-child td { border-bottom: none; }
  .trust-line {
    border: 1px solid var(--trust-border); background: var(--trust-bg); border-radius: 8px;
    padding: 0.9rem 1.1rem; margin: 1.75rem 0; font-size: 0.92rem;
  }
  .backlink { display: inline-block; margin-top: 0.5rem; font-size: 0.92rem; }
  .how-it-works { color: var(--muted); font-size: 0.92rem; margin: 1.25rem 0 1.75rem; }
  .state-grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 0.85rem; margin: 0 0 2rem; list-style: none; padding: 0;
  }
  .state-card {
    display: block; border: 1px solid var(--border); border-radius: 8px; padding: 0.9rem 1rem;
    background: var(--card-bg); text-decoration: none; color: var(--fg);
  }
  .state-card:hover { border-color: var(--accent); }
  .state-card .state-name { font-weight: 700; margin-bottom: 0.2rem; }
  .state-card .state-hint { font-size: 0.85rem; color: var(--muted); }
  .site-footer {
    margin-top: 3rem; padding-top: 1.25rem; border-top: 1px solid var(--border);
    font-size: 0.85rem; color: var(--muted); line-height: 1.6;
  }
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
  @media (max-width: 480px) {
    .site-header { flex-direction: column; align-items: flex-start; }
    .callout .date { font-size: 1.4rem; }
    .signup-form-row { flex-direction: column; gap: 0; }
  }
"""


def site_header(home_href: str) -> str:
    return f"""<header class="site-header">
  <div class="wordmark"><a href="{esc(home_href)}">{esc(SITE_NAME)}</a></div>
  <div class="tagline">{esc(SITE_TAGLINE)}</div>
  <div class="by-line">by {esc(BRAND_NAME)}</div>
</header>"""


def site_footer() -> str:
    return f"""<footer class="site-footer">
  <p>{esc(SITE_NAME)} by {esc(BRAND_NAME)} &middot; compiled from official state board sources
  &middot; informational, not legal or official advice.</p>
  <p><a href="/privacy/">Privacy Policy</a></p>
</footer>"""


TRUST_MICROCOPY = (
    "We only email you deadline reminders. We never sell or share your address. Unsubscribe anytime."
)

_MONTH_OPTIONS = "\n".join(
    f'<option value="{i}">{MONTH_NAMES[i - 1]}</option>' for i in range(1, 13)
)


def _extra_fields_html(state_slug: str, records: list[dict]) -> str:
    """The state-specific fields beyond email, needed to compute THIS
    subscriber's exact deadline. Kept in sync with reminders/server.py's
    per-state field handling -- see that file's _handle_subscribe()."""
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


def signup_form_for_state(state_slug: str, state_name: str, records: list[dict]) -> str:
    if state_slug in REMINDER_UNSUPPORTED_STATES:
        return ""  # no computable deadline -- see REMINDER_UNSUPPORTED_STATES docstring
    return f"""<div class="signup-form">
  <h2>Get reminded before this deadline</h2>
  <p class="signup-microcopy">{esc(TRUST_MICROCOPY)}</p>
  <form method="post" action="{esc(REMINDER_BACKEND_BASE_URL)}/subscribe">
    <input type="hidden" name="state" value="{esc(state_slug)}">
    {_BOT_DEFENSE_FIELDS_HTML}
    {_FIRST_NAME_FIELD_HTML.format(id_prefix="")}
    <label for="email">Email address</label>
    <input type="email" id="email" name="email" required placeholder="you@example.com">
    {_extra_fields_html(state_slug, records)}
    <button type="submit">Remind me</button>
  </form>
</div>"""


def signup_form_homepage(by_slug: dict[str, list[dict]]) -> str:
    """Homepage doesn't know the state yet, so it collects it via a
    dropdown and shows/hides the right extra fields with a small vanilla-JS
    handler -- the only JS on the whole site, used only because it clearly
    helps usability here (per the design brief). Validation authority stays
    server-side in reminders/server.py regardless of what this JS does."""
    supported_slugs = sorted(s for s in by_slug if s not in REMINDER_UNSUPPORTED_STATES)
    state_options = "\n".join(
        f'<option value="{esc(slug)}">{esc(by_slug[slug][0]["state"])}</option>' for slug in supported_slugs
    )
    field_groups = "\n".join(
        f'<div class="signup-extra-fields" data-for-state="{esc(slug)}" hidden>'
        f'{_extra_fields_html(slug, by_slug[slug])}</div>'
        for slug in supported_slugs
        if _extra_fields_html(slug, by_slug[slug])
    )
    return f"""<div class="signup-form">
  <h2>Get reminded before your deadline</h2>
  <p class="signup-microcopy">{esc(TRUST_MICROCOPY)}</p>
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


def page_shell(title: str, meta_description: str, body: str, home_href: str) -> str:
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(title)}</title>
<meta name="description" content="{esc(meta_description)}">
{_turnstile_head_html()}
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
  <strong>Last verified: {esc(last_verified)}</strong> &middot; always confirm with the
  <a href="{esc(source_url)}">official state board</a> before relying on this date. License
  requirements and deadlines can change.
</div>"""


# ---------------------------------------------------------------------------
# Per-state page builders
# ---------------------------------------------------------------------------

def render_simple_deadline_records(records: list[dict]) -> str:
    """Wave 1 / plain fixed_calendar records with a single computed date each."""
    parts = []
    for r in records:
        d = date.fromisoformat(r["next_deadline_computed"])
        parts.append(f"""<div class="callout">
  <div class="label">{esc(r['license_type_label'])}</div>
  <div class="date">{esc(fmt_date(d))}</div>
  <p class="rule">{esc(r['cycle_description'])}</p>
</div>""")
    return "\n".join(parts)


def render_data_gap_records(records: list[dict]) -> str:
    parts = []
    for r in records:
        parts.append(f"""<div class="callout">
  <div class="label">{esc(r['license_type_label'])}</div>
  <div class="date">Date not confirmed</div>
  <p class="rule">{esc(r['cycle_description'])}</p>
  <p><em>{esc(r.get('data_gap_note', ''))}</em></p>
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


def build_state_page(state_slug: str, records: list[dict], as_of: date) -> tuple[str, str]:
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
        gapped = [r for r in records if not r.get("next_deadline_computed")]
        deadline_html = render_simple_deadline_records(computed)
        if gapped:
            deadline_html += "\n" + render_data_gap_records(gapped)

    body = f"""<h1>{esc(title)}</h1>
<p class="subhead">{esc(state_name)} CPA license renewal</p>
{deadline_html}
{trust_line(last_verified, source_url)}
{signup_form_for_state(state_slug, state_name, records)}
<p class="backlink"><a href="../">&larr; Back to all states</a></p>
"""
    return title, page_shell(title, meta_description, body, home_href="../")


# ---------------------------------------------------------------------------
# Index / sitemap / robots
# ---------------------------------------------------------------------------

def build_index_page(states: list[dict], as_of: date, by_slug: dict[str, list[dict]]) -> str:
    cards = []
    for s in sorted(states, key=lambda s: s["state"]):
        hint = "By birth month" if s["wave"] == 3 else "Fixed date"
        cards.append(
            f'<a class="state-card" href="{esc(s["state_slug"])}/">'
            f'<div class="state-name">{esc(s["state"])}</div>'
            f'<div class="state-hint">{esc(hint)}</div></a>'
        )
    body = f"""<h1>CPA License Renewal Deadlines by State</h1>
<p class="intro">Find your state's CPA license renewal deadline, sourced and verified against
the official state board of accountancy. Built for CPAs, firm administrators, and anyone who
just needs to know when their license is due.</p>
<div class="state-grid">
{chr(10).join(cards)}
</div>
<p class="how-it-works">How it works: each state page shows the actual next renewal deadline
(or, where the rule depends on your birth month, a full lookup table) computed from the
verified renewal rule, with a link back to the official source and a "last verified" date.
{len(states)} states covered so far, generated {esc(as_of.isoformat())}.</p>
{signup_form_homepage(by_slug)}
"""
    return page_shell(
        f"{SITE_NAME} — CPA License Renewal Deadlines by State",
        "Find your state's CPA license renewal deadline, verified against the official state "
        "board of accountancy. One page per state, kept current.",
        body,
        home_href="./",
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
    )


def build_sitemap(states: list[dict], as_of: date) -> str:
    urls = [f"""  <url>
    <loc>{SITE_BASE_URL}/</loc>
    <lastmod>{as_of.isoformat()}</lastmod>
  </url>""", f"""  <url>
    <loc>{SITE_BASE_URL}/privacy/</loc>
    <lastmod>{as_of.isoformat()}</lastmod>
  </url>"""]
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

    built = []
    for slug, recs in by_slug.items():
        title, page_html = build_state_page(slug, recs, as_of)
        state_dir = SITE_DIR / slug
        state_dir.mkdir(parents=True, exist_ok=True)
        (state_dir / "index.html").write_text(page_html, encoding="utf-8")
        built.append(state_meta[slug])
        print(f"wrote {SITE_DIR.name}/{slug}/index.html  ({title})")

    (SITE_DIR / "index.html").write_text(build_index_page(built, as_of, by_slug), encoding="utf-8")
    print(f"wrote {SITE_DIR.name}/index.html  ({len(built)} states)")

    (SITE_DIR / "sitemap.xml").write_text(build_sitemap(built, as_of), encoding="utf-8")
    print(f"wrote {SITE_DIR.name}/sitemap.xml")

    (SITE_DIR / "robots.txt").write_text(build_robots(), encoding="utf-8")
    print(f"wrote {SITE_DIR.name}/robots.txt")

    privacy_dir = SITE_DIR / "privacy"
    privacy_dir.mkdir(parents=True, exist_ok=True)
    (privacy_dir / "index.html").write_text(build_privacy_page(real_today), encoding="utf-8")
    print(f"wrote {SITE_DIR.name}/privacy/index.html")

    print(f"\nDone. {len(built)} state pages generated under {SITE_DIR}")


if __name__ == "__main__":
    main()
