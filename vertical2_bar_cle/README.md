# Vertical #2 sourcing groundwork -- attorney bar license / CLE-MCLE

**Status: sourcing groundwork only. No site, no `generate.py` integration, no build commitment.**
Started 2026-07-15 per `orchestrator_20260715T_dont_park_keep_building.md`, which explicitly scoped
this as "data-sourcing groundwork to the sourcing standard... build post-validation" -- i.e. prove the
sourcing method works and get ahead on research, do NOT start building a second full site before the
CPA vertical (DeadlineRadar itself) earns that investment.

## Why this vertical (context, not re-derived here)

Ranked #1 in the 2026-07-06 expansion-vertical analysis (see `HANDOFF.md`): no dedicated third-party
multi-state attorney CLE deadline aggregator exists (only official state-bar portals + course-content
providers), high consequence (bar suspension for non-compliance), and it reuses the CPA machine's
existing birth-month/cohort signup pattern almost directly.

## Sourcing standard (same one used for the 49 CPA records)

Every record needs **two independently verified sources**:
1. `source_url` -- the state bar's own plain-English compliance/reporting page.
2. `citation_url` + `citation` -- the actual codified rule/statute/court-rule the requirement derives
   from, fetched and read directly (not inferred from a secondary summary), same discipline as
   `scripts/codified_source_audit.py`'s `--check-links` pass already applies to the CPA dataset.

Both states sourced so far (California, Texas) had their citation text verified directly -- California
via a clean WebFetch of the Judicial Branch's own site, Texas via `pdftotext` extraction of the actual
State Bar Rules PDF (the live HTML/PDF fetch initially came back garbled, same known PDF-extraction
gap already documented for several CPA sources -- worked around with the same tool already used
elsewhere in this repo, not skipped or guessed).

## Pattern found so far: five distinct cohort shapes

- **Fixed calendar-year (Jan 1 - Dec 31)**: the simplest and most common shape found -- e.g. Iowa,
  Louisiana, Maine, Nebraska, Nevada, New Mexico. Reuses CPA's existing fixed-date mechanism directly.
- **Birth-month rolling 12-month cycle** (Texas): structurally identical to CPA's existing
  birth-month-cohort states. Needs one extra signup field (birth month), reusing the exact mechanism
  already built and live for CPA.
- **Last-name-initial cohort groups** (California, 3 groups A-G/H-M/N-Z, 3-year cycle): needs a
  "pick your last name's group" extra signup field.
- **Admission-date cohort categories** (Minnesota, 3 rotating categories on a staggered 3-year cycle,
  e.g. Category 3 reports 2026/2029/2032; New Jersey, 2 groups by birth-month-half on a 2-year cycle)
  -- a NEW shape not seen in the CPA dataset at all: cohort assignment is by admission date (or, for
  NJ, birth-month-half) rather than by name or birth month alone, and needs the actual assignment date
  captured at signup, not inferred.
- **Fixed non-calendar annual period**: a whole institution reports on the same annual cycle, but
  it isn't Jan-Dec -- Montana (Apr 1 - Mar 31), New Hampshire (Jun 1 - May 31). Structurally simple
  (same date for everyone) but the signup/reminder math needs a configurable fiscal-year-start, not
  an assumption that "annual" always means calendar year.
- **No mandatory CLE requirement**: confirmed (not assumed, and confirmed independently more than
  once) for **Michigan, South Dakota, Maryland, and Massachusetts** -- each via the state's own bar/
  court page stating so directly (Maryland: a Supreme Court notice explicitly postponing adoption
  "until further notice" as of April 28, 2025; Massachusetts: SJC Rule 3:16's only CLE-adjacent
  requirement was repealed effective August 14, 2024). A real, valid finding for some states, not a
  research gap -- worth keeping distinct from "not yet sourced" in the dataset
  (`no_cle_requirement: true`).

## Progress: 50 of 50 states sourced (2026-08-13) -- sourcing groundwork complete

First pass (48 states via 8 research+verify batches) landed 37; a genuine `could_not_verify` wall hit
11 states -- primary sources 403/404/500'd or gave inconsistent extraction on repeated WebFetch
attempts. Rather than include those on a shaky citation, they were left out and logged with exactly
what failed. A second, targeted pass (one dedicated agent per stuck state, given the specific prior
failure and told to try a different route -- Wayback Machine, an alternate URL on the same domain, a
real browser session instead of the WebFetch tool, direct PDF download + local text extraction)
resolved **all 11**: Arizona, Arkansas, Hawaii, Kentucky, Maryland, Massachusetts, Mississippi,
Missouri, Rhode Island, Virginia, Wisconsin. 10 came back dual-source-verified; Wisconsin is
single-source (the only independently-hosted mirror of its own rule text also failed, so it's the
same primary document reached two ways, not two distinct sources -- flagged honestly rather than
inflated to dual). Independently spot-checked 2 of the 11 (Maryland's no-CLE finding, Arizona's hour
figures) directly against the primary source before merging -- both confirmed exact.

## Next steps for whoever continues this

1. **Sourcing is done for all 50 states.** DC is not currently in scope (`states_total_needed: 50` in
   `_meta`) -- confirm with Devin/orchestrator whether it should be added.
2. Do NOT start building `generate.py`/site scaffolding for this vertical until Devin/orchestrator
   explicitly green-lights it post-CPA-validation (per the original directive's instruction) -- still
   true, unchanged by this pass. Sourcing completeness does not itself authorize a build.
3. Keep this file (`vertical2_bar_cle/bar_cle_deadlines.json`) as the running sourcing dataset --
   separate from `data/cpa_deadlines.json`, never merged into it (different vertical, different site
   if/when built).
4. Whenever the build IS authorized: this dataset is now old enough in places (some records sourced
   2026-07-15, most 2026-08-13) that a re-verification pass against each `citation_url`/`source_url`
   before wiring it live would be prudent, same "don't trust stale sourcing" discipline the CPA
   vertical's own staleness guard already enforces.
