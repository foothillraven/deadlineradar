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

## Pattern found so far: two distinct cohort shapes, both already-solved shapes

- **Texas**: birth-month rolling 12-month cycle -- structurally identical to CPA's existing
  birth-month-cohort states. `next_deadline_computed` is null by design; needs one extra signup field
  (birth month), reusing the exact mechanism already built and live for CPA.
- **California**: 3-year cycle, but staggered into **3 cohort groups by first-letter-of-last-name**
  (A-G / H-M / N-Z), each with its own fixed reporting deadline. This is a **new cohort shape** not
  yet seen in the CPA dataset (which only has birth-month cohorts, not last-name cohorts) -- worth
  flagging to whoever eventually builds this vertical's signup form, since it needs a "pick your last
  name's group" extra field rather than a birth-month picker.

## Next steps for whoever continues this (not started yet)

1. Source the remaining 48 states/DC to the same two-source standard. Expect a mix of: fixed calendar
   dates (simplest), birth-month cohorts (reuse CPA's mechanism), last-name cohorts (California's new
   shape), and possibly other cohort shapes not yet seen -- document each new shape found here.
2. Do NOT start building `generate.py`/site scaffolding for this vertical until Devin/orchestrator
   explicitly green-lights it post-CPA-validation (per this directive's own instruction).
3. Keep this file (`vertical2_bar_cle/bar_cle_deadlines.json`) as the running sourcing dataset --
   separate from `data/cpa_deadlines.json`, never merged into it (different vertical, different site
   if/when built).
