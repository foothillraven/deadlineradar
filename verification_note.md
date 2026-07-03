# DeadlineRadar local prototype — verification note

**Scope:** CPA-license-renewal vertical only (contractor licensing was researched and dropped
before any build — see the README's Status section for why). 10 states, 14 records, local-only
static site. No domain, no hosting, no Stripe, no billing, no network calls.

## Process

1. A build agent generated the pipeline (`data/cpa_deadlines.json` → `generate.py` →
   `site/*.html` + `sitemap.xml` + `robots.txt`), using only the verified 10-state data from the
   Day-0/7 spike — no invented data for the other ~40 states.
2. An adversarial verify agent independently re-read every actual file on disk (not the build
   agent's self-report) and re-derived the date math by hand for all 14 records plus the live
   wave-3 lookup-table logic. **Result: `overall_pass: false`** — it found two real, unshipped
   defects.
3. I fixed both defects myself (below), regenerated the site, and independently re-verified the
   fixes.

## Defects found by adversarial verify, and how they were fixed

1. **North Carolina data inconsistency (data-accuracy).** The record's own `cycle_description`
   said "annually before July 1" but `next_deadline_computed` was literally `2027-07-01` — an
   internally self-contradictory record (the wording implies June 30 is the real cutoff). The
   verify agent had no network access to check the primary source and correctly flagged this as
   unresolved rather than guessing. **Fix:** I fetched the NC Board's own 2025-2026 renewal page
   directly (`nccpaboard.gov/2025-2026-nc-certificate-renewal/`) and confirmed the actual cutoff is
   **June 30** ("must renew... by June 30, 2026... failure to act before July 1 triggers a Letter
   of Demand"). Corrected the record to `2027-06-30`, updated `cycle_description` to match the
   primary source's exact language, updated `source_url` to the specific renewal page (was the
   board's generic homepage), and added a `verification_note` field documenting the correction and
   why. This is exactly the kind of off-by-one error the vertical's own risk register flagged as a
   real trust/liability problem, and it shipped in the very first build — the adversarial check is
   what caught it, not the build itself.

2. **Title/meta-description year mismatch (SEO/indexability).** Every page's `<title>` and meta
   description hardcoded the generation year (2026) regardless of the actual deadline year(s)
   shown in the page body — e.g. Florida was titled "...Deadline 2026" while displaying December
   2027 dates for two of its three records. **Fix:** rewrote `build_state_page()` to derive the
   title year from the actual soonest computed deadline for that state (`compute_title_year()`),
   and to drop the year entirely in favor of "by Birth Month" phrasing for the three states
   (CA/TX/NY) whose data is a lookup table spanning many years rather than one date. Regenerated
   and confirmed by inspection: every title now matches its own page's earliest displayed date
   (Florida → 2026, matching its even-cohort date; Georgia → 2027, matching its earlier individual
   date, not the later 2028 firm date; Ohio → 2026, matching its soonest cohort group; CA/TX/NY →
   no year asserted).

3. **Staleness guard checked only against the data file's own `as_of_date`, never real wall-clock
   time (data freshness).** If `generate.py` were re-run long after `as_of_date` without anyone
   updating the data, the self-referential check would still pass cleanly while silently producing
   a site with deadlines drifted into the past relative to reality — disclosed as a known
   limitation in the original README but left unmitigated. **Fix:** added a real
   `date.today()`-anchored check: the build now refuses (`SystemExit`) if `as_of_date` is more than
   30 days old relative to actual today, and separately checks every computed deadline against
   real today in addition to `as_of_date`. **Tested this actually works**, not just written: ran
   the generator against a copy of the data with `as_of_date` artificially set to 2020-01-01 and
   confirmed it refused to build with a clear error message, rather than silently producing a stale
   site.

4. **Minor: `last_verified` aggregation used an incidental dict-overwrite instead of a deliberate
   rule** (harmless today since every record for a given state currently shares one
   `last_verified` value, but not enforced). **Fix:** changed to an explicit `max()` so if a future
   edit gives one state's records different verification dates, the page reflects the most recent
   one deliberately.

## Independent re-verification after fixes (this session, outside any agent)

- Regenerated the site (`python generate.py`) — succeeded, 10 pages + index + sitemap + robots.
- Confirmed via grep that every page's `<title>` now matches the earliest date shown in its own
  body (spot-checked all 10).
- Confirmed `sitemap.xml` still parses as valid XML (`xml.dom.minidom.parse`).
- Confirmed the staleness guard actually fires on stale input (see above) rather than just existing
  as unreachable code.
- Grepped the entire directory tree for network-call imports (`urllib`/`requests`/`socket`/
  `urlopen`/`http.client`) — none found.
- Grepped the entire directory tree for real personal/project identities and secrets (a checklist
  of known-sensitive proper nouns from the source project, plus `api_key`, `secret`, `stripe`) —
  no disqualifying matches (only an expected mention of "Stripe" in prose explaining what this
  prototype deliberately does NOT include).

## Result: PASS (after one fix cycle)

Indexability: all 10 pages have a title, meta description, H1, well-formed HTML, working back-link;
sitemap and robots.txt are valid and consistent. Data freshness: all computed deadlines are
genuinely in the future relative to both the data's `as_of_date` and real wall-clock time, verified
by hand for every record; the one factual inconsistency found (North Carolina) was corrected
against the primary source, not patched over. No silent-stale-data failure mode: the staleness
guard is tested and functional, not just documented.

## Known, disclosed limitations (prototype-stage, not blocking)

- Illinois firm-license renewal date is `null` (data gap: recurring month/day known, cycle-anchor
  year not confirmed in spike data) — the page says so plainly rather than guessing.
- Wave-1/2 dates are stored values tied to `as_of_date`; they need either live re-derivation from
  raw cycle rules or a documented periodic re-verification process before this could run
  unattended past prototype stage. The 30-day staleness guard added in this fix cycle is a partial
  mitigation (it stops the site from silently going stale) but is not the same as automated
  re-verification.
- Only 10 of 50 states have verified data. This is a prototype proving the pipeline, not a launch
  inventory — no billing, no domain, no deploy, per sprint scope.
