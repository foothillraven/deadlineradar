#!/usr/bin/env python3
"""
DeadlineRadar -- CPA license renewal static site generator (LOCAL PROTOTYPE)

Reads data/cpa_deadlines.json (hand-verified, sourced 2026-07-03) and renders:
  - site/[state-slug]/index.html   one page per state
  - site/index.html                directory of all state pages
  - site/sitemap.xml                XML sitemap (placeholder domain, no network calls)
  - site/robots.txt                allow-all, points at the sitemap

Python stdlib only. No network calls. No real domain. No payment/Stripe code.
This script proves the ingest -> normalize -> generate pipeline; it is not a server.

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
SITE_BASE_URL = "https://example-deadlineradar.test"

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
# Wave-3 (birth-month) table computation
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
# HTML helpers
# ---------------------------------------------------------------------------

def esc(s: str) -> str:
    return html.escape(str(s), quote=True)


def page_shell(title: str, meta_description: str, body: str) -> str:
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(title)}</title>
<meta name="description" content="{esc(meta_description)}">
<style>
  :root {{ color-scheme: light dark; }}
  body {{
    font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
    max-width: 760px; margin: 0 auto; padding: 2rem 1.25rem 4rem;
    line-height: 1.5; color: #1a1a1a; background: #fff;
  }}
  @media (prefers-color-scheme: dark) {{
    body {{ color: #e8e8e8; background: #14161a; }}
    a {{ color: #7db8ff; }}
    .deadline-box {{ background: #1f232a; border-color: #333; }}
    table {{ border-color: #333; }}
    th {{ background: #1f232a; }}
    .disclaimer {{ background: #241f14; border-color: #5a4a20; }}
  }}
  h1 {{ font-size: 1.6rem; margin-bottom: 0.25rem; }}
  .subhead {{ color: #666; margin-top: 0; margin-bottom: 1.5rem; }}
  .deadline-box {{
    border: 1px solid #ccc; border-radius: 8px; padding: 1.25rem 1.5rem;
    background: #f6f8fa; margin: 1.5rem 0;
  }}
  .deadline-box .date {{ font-size: 1.6rem; font-weight: 700; margin: 0.25rem 0; }}
  .disclaimer {{
    border: 1px solid #e0c060; background: #fff8e0; border-radius: 8px;
    padding: 1rem 1.25rem; margin: 2rem 0; font-size: 0.95rem;
  }}
  .verified {{ font-size: 0.9rem; color: #666; margin-top: 0.5rem; }}
  table {{ border-collapse: collapse; width: 100%; margin: 1rem 0; font-size: 0.95rem; }}
  th, td {{ border: 1px solid #ccc; padding: 0.5rem 0.65rem; text-align: left; }}
  th {{ background: #f0f0f0; }}
  footer {{ margin-top: 3rem; padding-top: 1rem; border-top: 1px solid #ccc; font-size: 0.85rem; color: #666; }}
  .backlink {{ display: inline-block; margin-top: 1rem; }}
  code {{ background: rgba(127,127,127,0.15); padding: 0.1em 0.3em; border-radius: 3px; }}
</style>
</head>
<body>
{body}
<footer>
  <p>DeadlineRadar is a local prototype. This page is generated content, not legal or
  professional advice. Verify every deadline directly with the state board before relying on it.</p>
</footer>
</body>
</html>
"""


def disclaimer_block(source_url: str) -> str:
    return f"""<div class="disclaimer">
  <strong>Always confirm with the official state board.</strong> License requirements and
  deadlines can change. This page is a convenience summary, not a substitute for the
  official source: <a href="{esc(source_url)}">{esc(source_url)}</a>.
</div>"""


def verified_line(last_verified: str) -> str:
    return f'<p class="verified">Last verified: {esc(last_verified)}</p>'


# ---------------------------------------------------------------------------
# Per-state page builders
# ---------------------------------------------------------------------------

def render_simple_deadline_records(records: list[dict]) -> str:
    """Wave 1 / plain fixed_calendar records with a single computed date each."""
    parts = []
    for r in records:
        d = date.fromisoformat(r["next_deadline_computed"])
        parts.append(f"""<div class="deadline-box">
  <div>{esc(r['license_type_label'])}</div>
  <div class="date">{esc(fmt_date(d))}</div>
  <div>{esc(r['cycle_description'])}</div>
</div>""")
    return "\n".join(parts)


def render_data_gap_records(records: list[dict]) -> str:
    parts = []
    for r in records:
        parts.append(f"""<div class="deadline-box">
  <div>{esc(r['license_type_label'])}</div>
  <div class="date">Date not confirmed</div>
  <div>{esc(r['cycle_description'])}</div>
  <p><em>{esc(r.get('data_gap_note', ''))}</em></p>
</div>""")
    return "\n".join(parts)


def render_ohio(record: dict) -> str:
    rows = "\n".join(
        f"<tr><td>{esc(g['group'])}</td><td>{', '.join(str(y) for y in g['years'])}</td>"
        f"<td><strong>{esc(fmt_date(date.fromisoformat(g['next_deadline'])))}</strong></td></tr>"
        for g in record["cohort_groups"]
    )
    return f"""<div class="deadline-box">
  <div>{esc(record['license_type_label'])}</div>
  <p>{esc(record['cycle_description'])}</p>
  <p>{esc(record.get('grace_period_note', ''))}</p>
  <table>
    <tr><th>Cohort group</th><th>Years due</th><th>Next deadline</th></tr>
    {rows}
  </table>
  <p>Not sure which group you're in? Your license certificate or the
  <a href="{esc(record['source_url'])}">Accountancy Board of Ohio lookup</a> will show your
  assigned group.</p>
</div>"""


def render_california(record: dict, as_of: date) -> str:
    table = build_california_table(as_of)
    rows = "\n".join(
        f"<tr><td>{esc(r['month'])}</td><td>{esc(r['odd_birth_year_next_deadline'])}</td>"
        f"<td>{esc(r['even_birth_year_next_deadline'])}</td></tr>"
        for r in table
    )
    return f"""<div class="deadline-box">
  <p>{esc(record['cycle_description'])}</p>
  <p><strong>Find your row:</strong> look up your birth month below, then use the
  odd-birth-year or even-birth-year column depending on the year you were born.</p>
  <table>
    <tr><th>Birth month</th><th>Next deadline (odd birth year)</th><th>Next deadline (even birth year)</th></tr>
    {rows}
  </table>
  <p>Example: born in March of an odd year (e.g. 1985)? Your next deadline is the
  odd-birth-year date on the March row.</p>
</div>"""


def render_texas(record: dict, as_of: date) -> str:
    table = build_texas_table(as_of)
    rows = "\n".join(
        f"<tr><td>{esc(r['month'])}</td><td>{esc(r['next_deadline'])}</td></tr>"
        for r in table
    )
    return f"""<div class="deadline-box">
  <p>{esc(record['cycle_description'])}</p>
  <p><strong>Find your row:</strong> look up your birth month below for your next renewal date.
  Texas renewal is annual, so this repeats every year on the same month.</p>
  <table>
    <tr><th>Birth month</th><th>Next renewal deadline</th></tr>
    {rows}
  </table>
</div>"""


def render_new_york(record: dict) -> str:
    return f"""<div class="deadline-box">
  <p>{esc(record['cycle_description'])}</p>
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
    wave = min(r["wave"] for r in records)
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
<p class="subhead">Wave {wave} — {esc(state_name)} CPA license renewal</p>
{deadline_html}
{verified_line(last_verified)}
{disclaimer_block(source_url)}
<p class="backlink"><a href="../">&larr; Back to all states</a></p>
"""
    return title, page_shell(title, meta_description, body)


# ---------------------------------------------------------------------------
# Index / sitemap / robots
# ---------------------------------------------------------------------------

def build_index_page(states: list[dict], as_of: date) -> str:
    rows = []
    for s in sorted(states, key=lambda s: s["state"]):
        rows.append(
            f'<li><a href="{esc(s["state_slug"])}/">{esc(s["state"])} — '
            f'CPA License Renewal Deadline</a> <span style="color:#888">(wave {s["wave"]})</span></li>'
        )
    body = f"""<h1>DeadlineRadar — CPA License Renewal Deadlines</h1>
<p class="subhead">One page per state. Local prototype, {len(states)} states, generated {esc(as_of.isoformat())}.</p>
<ul>
{chr(10).join(rows)}
</ul>
<p class="verified">This is a local, no-domain, no-billing content pipeline prototype — see the
project README for scope and how to add a state.</p>
"""
    return page_shell(
        "DeadlineRadar — CPA License Renewal Deadlines by State",
        "Directory of CPA license renewal deadline pages by state, generated from verified state-board data.",
        body,
    )


def build_sitemap(states: list[dict], as_of: date) -> str:
    urls = [f"""  <url>
    <loc>{SITE_BASE_URL}/</loc>
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
# Main
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

    (SITE_DIR / "index.html").write_text(build_index_page(built, as_of), encoding="utf-8")
    print(f"wrote {SITE_DIR.name}/index.html  ({len(built)} states)")

    (SITE_DIR / "sitemap.xml").write_text(build_sitemap(built, as_of), encoding="utf-8")
    print(f"wrote {SITE_DIR.name}/sitemap.xml")

    (SITE_DIR / "robots.txt").write_text(build_robots(), encoding="utf-8")
    print(f"wrote {SITE_DIR.name}/robots.txt")

    print(f"\nDone. {len(built)} state pages generated under {SITE_DIR}")


if __name__ == "__main__":
    main()
