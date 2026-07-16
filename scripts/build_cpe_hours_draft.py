#!/usr/bin/env python3
"""Renders draft CPE-hours-by-state pages for orchestrator review.

STATUS: DRAFT ONLY. Writes to `cpe_hours_draft/` at the repo root -- NOT
`docs/`, so nothing here is deployed by GitHub Pages or reachable on the
live site. Per the orchestrator's 2026-07-15 approval: "keep it draft/
non-public... I review the RENDERED pages before go-live." Do not move
this output into docs/ or link it from any live page until that review
lands and explicitly says so.

Usage (from b3_saas/deadlineradar/):
    python scripts/build_cpe_hours_draft.py
"""
from __future__ import annotations

import json
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from generate import (  # noqa: E402
    BRAND_NAME,
    REMINDER_BACKEND_BASE_URL,
    SITE_BASE_URL,
    SITE_NAME,
    _BOT_DEFENSE_FIELDS_HTML,
    _extra_fields_html,
    esc,
    page_shell,
)

CPE_DATA_PATH = ROOT / "data" / "cpe_hours.json"
CPA_DATA_PATH = ROOT / "data" / "cpa_deadlines.json"
DRAFT_DIR = ROOT / "cpe_hours_draft"


def load_cpe_records() -> list[dict]:
    data = json.loads(CPE_DATA_PATH.read_text(encoding="utf-8"))
    return data["records"]


def load_renewal_by_slug() -> dict[str, list[dict]]:
    """For cross-linking: does this state have a live, non-gap renewal-date
    page to link to? (A gap/BYOD state still has a page, just not a Verified
    date -- still worth cross-linking either way, the link text just adapts.)"""
    data = json.loads(CPA_DATA_PATH.read_text(encoding="utf-8"))
    by_slug: dict[str, list[dict]] = {}
    for r in data["records"]:
        by_slug.setdefault(r["state_slug"], []).append(r)
    return by_slug


def _cpe_source_cite_html(record: dict) -> str:
    """Same visual/semantic treatment as generate.py's _source_cite_html() --
    a distinct 'Source of record' element, not buried in prose. Kept as a
    near-duplicate rather than importing the CPA version directly, since the
    CPA version is keyed to `citation_url` presence on a *renewal* record;
    this is deliberately parallel, not shared, until the cluster is proven
    and a real shared helper is worth extracting."""
    return f"""<div class="source-cite">
  <span class="cite-label">Source of record</span>
  <span class="cite-stamp">{esc(record['citation'])}</span>
  <a href="{esc(record['citation_url'])}" class="cite-link">read the rule &rarr;</a>
</div>"""


def _cpe_signup_html(record: dict, renewal_by_slug: dict[str, list[dict]], as_of: date) -> str:
    """Per the orchestrator's 2026-07-15 template-review decision: option 1,
    a light single-line capture on the CPE page itself rather than relying on
    the cross-link alone. Deliberately reuses the SAME real /subscribe
    backend and the SAME renewal reminder every state page already offers --
    this does NOT invent a new "CPE deadline reminder" promise the backend
    can't fulfill; the honest framing is "CPE and your renewal are on related
    clocks, get reminded before that date" (true for every state, since even
    a fixed-date state's renewal callout mentions CPE alongside it, and a
    birth-month/gap state's own extra field is what makes the reminder
    possible in the first place). Kept intentionally minimal -- no first-name
    field, no full form heading/microcopy -- so it reads as one compact row,
    not a second full signup form competing with the cited-authority feel of
    the page above it. A state needing an extra field (birth month, etc.)
    still gets exactly one extra input, same floor as the real renewal-page
    form for that state -- can't be avoided honestly, since the backend
    needs that value to do anything useful with the signup."""
    slug = record["state_slug"]
    renewal_records = renewal_by_slug.get(slug, [])
    if not renewal_records:
        return ""
    extra_fields = _extra_fields_html(slug, renewal_records, as_of)
    return f"""<div class="signup-form signup-form--compact">
  <form method="post" action="{esc(REMINDER_BACKEND_BASE_URL)}/subscribe">
    <input type="hidden" name="state" value="{esc(slug)}">
    {_BOT_DEFENSE_FIELDS_HTML}
    <label for="cpe-email-{esc(slug)}" class="signup-form-compact-label">
      CPE hours and your renewal are on related clocks &mdash; get reminded before
      {esc(record['state'])}'s renewal date too:
    </label>
    <div class="signup-form-row">
      <input type="email" id="cpe-email-{esc(slug)}" name="email" required placeholder="you@example.com">
      <button type="submit">Remind me</button>
    </div>
    {extra_fields}
  </form>
</div>"""


def _cross_link_html(record: dict, renewal_by_slug: dict[str, list[dict]]) -> str:
    """Uses an ABSOLUTE live-site URL, not a relative path -- this draft's own
    directory layout (cpe_hours_draft/<slug>/) doesn't match whatever the
    eventual live URL depth turns out to be (flat sibling like the firm-
    landing pages, e.g. /alabama-cpa-firm-renewal/, vs. something else --
    still to be decided/reviewed). A relative "../<slug>/" from inside this
    draft folder would actually self-link back to this same draft page, not
    the real renewal page -- caught that before shipping it. Once a final URL
    scheme is approved, this becomes a real relative path matching it."""
    slug = record["state_slug"]
    renewal_records = renewal_by_slug.get(slug, [])
    has_verified_date = any(r.get("next_deadline_computed") for r in renewal_records)
    if not renewal_records:
        return ""
    if has_verified_date:
        link_text = f"See {record['state']}'s CPA license renewal deadline"
    else:
        link_text = f"See {record['state']}'s CPA license renewal page"
    live_url = f"{SITE_BASE_URL}/{esc(slug)}/"
    return f"""<p class="backlink-cross"><a href="{live_url}">{esc(link_text)} &rarr;</a></p>"""


_COMPACT_SIGNUP_CSS = """<style>
  /* Draft-only inline override -- if this cluster ships, fold these two rules
     into generate.py's PAGE_CSS properly instead of duplicating them per page. */
  .signup-form--compact { padding: 0.9rem 1.1rem; }
  .signup-form--compact .signup-form-compact-label { font-size: 0.85rem; font-weight: 600; margin: 0 0 0.5rem; display: block; }
  .signup-form--compact .signup-form-row { display: flex; gap: 0.6rem; }
  .signup-form--compact .signup-form-row input { flex: 1 1 auto; }
  .signup-form--compact .signup-form-row button { flex: 0 0 auto; margin-top: 0; }
</style>"""


def build_cpe_hours_page(record: dict, renewal_by_slug: dict[str, list[dict]], as_of: date) -> str:
    ethics_line = ""
    if record.get("ethics_hours"):
        ethics_period = record.get("ethics_period_years")
        if ethics_period and ethics_period != record.get("period_years"):
            ethics_line = (
                f"<li><strong>{record['ethics_hours']} ethics hours</strong>, required once every "
                f"{ethics_period} year{'s' if ethics_period != 1 else ''} (counts toward the total "
                f"above, not an add-on).</li>"
            )
        else:
            ethics_line = (
                f"<li><strong>{record['ethics_hours']} ethics hours</strong>, within that same "
                f"total.</li>"
            )
    annual_line = ""
    if record.get("annual_minimum_hours"):
        annual_line = (
            f"<li><strong>{record['annual_minimum_hours']}-hour minimum</strong> in each 1-year "
            f"period (you can't front-load the whole requirement into a single year).</li>"
        )

    body = f"""<h1>{esc(record['state'])} CPA CPE Requirements: How Many Hours, By When</h1>
<p class="intro">How much continuing professional education a {esc(record['state'])} CPA actually
needs &mdash; sourced the same way every fact on this site is: a board page plus the codified rule
itself, never a guess.</p>

<div class="callout">
  <span class="verified-badge">Verified</span>
  <div class="label">CPE Hour Requirement</div>
  <div class="date">{record['total_hours']} hours every {record['period_years']} year{'s' if record['period_years'] != 1 else ''}</div>
  <ul>
    {annual_line}
    {ethics_line}
  </ul>
  {_cpe_source_cite_html(record)}
</div>

<p>{esc(record.get('notes', ''))}</p>

{_cpe_signup_html(record, renewal_by_slug, as_of)}

{_cross_link_html(record, renewal_by_slug)}

<p class="backlink"><a href="{SITE_BASE_URL}/">&larr; Back to all states</a></p>
{_COMPACT_SIGNUP_CSS}
"""
    # home_href/canonical_path use absolute URLs throughout this draft, same
    # reviewability reasoning as _cross_link_html() above -- this draft's own
    # folder depth (cpe_hours_draft/<slug>/) doesn't match any real live URL
    # depth yet, so relative paths here would silently point at nothing.
    return page_shell(
        f"{record['state']} CPA CPE Requirements — {SITE_NAME}",
        f"How many CPE hours does {record['state']} require for CPAs, and by when? "
        f"{record['total_hours']} hours every {record['period_years']} year(s), sourced to "
        f"{record['citation']}.",
        body,
        home_href=f"{SITE_BASE_URL}/",
        canonical_path=f"/cpe-hours-draft-not-live/{record['state_slug']}/",
    )


def main() -> None:
    records = load_cpe_records()
    renewal_by_slug = load_renewal_by_slug()
    as_of = date.today()
    DRAFT_DIR.mkdir(parents=True, exist_ok=True)
    for record in records:
        state_dir = DRAFT_DIR / record["state_slug"]
        state_dir.mkdir(parents=True, exist_ok=True)
        html = build_cpe_hours_page(record, renewal_by_slug, as_of)
        (state_dir / "index.html").write_text(html, encoding="utf-8")
        print(f"wrote {state_dir.relative_to(ROOT)}/index.html")
    print(f"\nDraft-only: {len(records)} pages written under {DRAFT_DIR.relative_to(ROOT)}/ "
          f"(NOT under docs/, NOT deployed, NOT linked from any live page).")


if __name__ == "__main__":
    main()
