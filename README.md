# DeadlineRadar — local prototype (CPA license renewal, 10 states)

**Status:** local-only content-pipeline prototype. No domain, no hosting, no Stripe, no
billing, no network calls anywhere in this directory. Nothing here is deployed or public.
Scope: CPA license renewal only. A companion "contractor licensing" vertical was scouted and
deliberately dropped before any build: a 10-state sample found most states have no single
state-level general-contractor license to point a page at at all (licensing is fragmented across
per-trade boards or pushed down to municipal registration), which breaks the one-page-per-state
model this pipeline depends on. CPA licensing cleared that same check cleanly (a majority of
states use a fixed calendar renewal date), so "renarrow to CPA-only" is a deliberate scope
decision made from real research, not a shortcut.

This exists to prove one thing: **the ingest → normalize → generate pipeline produces
correct, non-stale, per-state pages from verified source data.** It is not a business yet —
there is no distribution, no monetization, no account of any kind attached to it.

## Pipeline

```
data/cpa_deadlines.json   (ingest: hand-verified facts, one record per state/license-type/cohort)
        |
        v
   generate.py            (normalize: compute next_deadline_computed forward from as_of_date;
        |                   render: stdlib string templating, no framework, no network)
        v
   docs/                  (output: one folder per state + index + sitemap.xml + robots.txt)
```

- **Ingest.** `data/cpa_deadlines.json` holds one flat array of *records*. A record is the
  smallest unit of a renewal fact: `{state, state_slug, license_type, renewal_pattern,
  cycle_description, next_deadline_computed, source_url, last_verified, wave}`, plus a few
  pattern-specific extras (`cohort_groups` for Ohio's 3-group system, `computation` for the
  birth-month states, `data_gap_note` where the verified spike data doesn't give us enough
  to compute a date). A state can have more than one record (Florida has 3: two individual
  cohorts + firm; Georgia has 2: individual + firm). `generate.py` groups records by
  `state_slug` to build one page per state.

- **Normalize / compute.** `next_deadline_computed` in the JSON is only trustworthy as of
  `as_of_date` (2026-07-03) — it is *not* re-derived by `generate.py` from the raw renewal
  rule; it was computed once by hand (and double-checked with a throwaway Python script
  during the build) and stored as a plain ISO date. **This is a known limitation, not an
  oversight:** re-run this pipeline after `as_of_date` has passed and the wave-1/2 dates go
  stale silently, because the JSON's stored dates don't move with the calendar. Wave-3
  (birth-month) states don't have this problem — their tables are computed live, every run,
  from `date.today()`-equivalent math seeded by `as_of_date`, so they're correct for any
  `as_of_date` you set. See "Known limitation" below for the fix before this ships past
  prototype stage.

  `generate.py` does carry one live safety check: before writing anything, it refuses to
  build if any record's `next_deadline_computed` is on-or-before `as_of_date` (a stale/past
  date would silently ship a wrong deadline — see the `stale = [...]` guard in `main()`).
  That guard only catches staleness *relative to the JSON's own `as_of_date`*, not staleness
  from someone running the script six months later on the same file — see the limitation
  below.

- **Wave-3 birth-month computation.** California and Texas don't have one fixed date — the
  deadline depends on the reader's own birth month (and, for California, their birth year's
  odd/even parity). Rather than fake a single date, `generate.py` builds a full lookup table
  (12 months × the relevant parity split) computed from the actual calendar, so every cell is
  a real, non-stale date. New York is different again: its rule depends on the reader's
  *first-registration date*, which isn't a fact this dataset has at all, so its page states
  that plainly and sends the reader to the official NYSED lookup instead of asserting
  anything invented.

- **Generate.** `generate.py` is Python stdlib only (`json`, `html`, `pathlib`, `datetime`) —
  no templating framework, no `pip install`, no network access of any kind. It writes:
  - `docs/[state-slug]/index.html` — one page per state, every field driven by the JSON record(s)
  - `docs/index.html` — directory of all state pages
  - `docs/sitemap.xml` — valid XML sitemap, one `<url>` per generated page + the index, each
    with a `<lastmod>`
  - `docs/robots.txt` — allow-all, points at the sitemap

  All URLs in `sitemap.xml`/`robots.txt` use the placeholder base
  `https://example-deadlineradar.test` — there is no real domain anywhere in this repo.
  Publishing a real domain, hosting, or any public URL is treated as a deliberate, separately
  gated step and has not happened.

## Running it

```
cd b3_saas/deadlineradar
python generate.py
```

Output goes to `docs/`. Re-running is idempotent — it overwrites the same files. Confirmed by
running it during this build: it produced 10 state folders + index + sitemap + robots.txt,
listed below.

```
docs/california/index.html
docs/florida/index.html
docs/georgia/index.html
docs/illinois/index.html
docs/index.html
docs/michigan/index.html
docs/new-york/index.html
docs/north-carolina/index.html
docs/ohio/index.html
docs/pennsylvania/index.html
docs/robots.txt
docs/sitemap.xml
docs/texas/index.html
```

## Data coverage (10 states, 14 records, as of 2026-07-03)

| Wave | States | Pattern |
|---|---|---|
| 1 | FL, IL, PA, GA, NC, MI | Fixed calendar date (some with cohort splits — FL individual odd/even, GA firm separate from individual) |
| 2 | OH | Fixed date (Dec 31 + Jan 31 grace) but only ~1/3 of licensees due per year — 3-group rotating cohort, explained with a table instead of one asserted date |
| 3 | CA, TX, NY | No single fixed date — CA/TX depend on the licensee's own birth month (rendered as a full lookup table); NY additionally depends on first-registration date, which this dataset doesn't have, so its page is explicitly "look it up yourself" |

One known data gap, carried honestly rather than papered over: **Illinois firm-license
renewal** (`il-firm` record) has a confirmed recurring date (November 30) and cycle length
(3 years) but no confirmed anchor year in the verified spike data, unlike the Illinois
individual track which has one ("current cycle ends 2027-09-30"). `next_deadline_computed`
is `null` for that record and the generated Illinois page says so instead of guessing a year.

## How to add a new state

1. **Verify the renewal rule against the state board's own page** (not a secondary source).
   Confirm: is it a single fixed calendar date, a fixed date with a cohort/group split, or
   personal (birth-month / anniversary)? Get the *current* cycle-anchor year if it's
   multi-year, not just the recurring month/day.
2. Add one or more records to `data/cpa_deadlines.json`:
   - Fixed single date → set `renewal_pattern: "fixed_calendar"` and compute
     `next_deadline_computed` by hand (or with a throwaway script like the one used for this
     build) as the actual next occurrence on-or-after today.
   - Fixed date but only a subset of licensees due each year → follow the Ohio pattern:
     `renewal_pattern: "fixed_calendar_cohort"`, `next_deadline_computed: null`, and a
     `cohort_groups` array of `{group, years, next_deadline}`.
   - Personal/birth-month → follow the CA/TX pattern: `renewal_pattern: "birth_month"`,
     `next_deadline_computed: null`, and a `computation` object describing how
     `generate.py` should build the lookup table (`birth_month_parity` for a 2-year
     odd/even-birth-year split like CA, `birth_month_annual` for a straight annual repeat
     like TX). If the rule needs a fact this dataset can't have (like NY's
     first-registration date), use `computation.type: "unresolvable_needs_registration_date"`
     and write a clear note — don't invent a table.
   - Always fill `source_url` (the official state board page) and `last_verified` (the date
     you actually checked it, not today's build date if they differ).
3. If the new state needs page logic beyond the three existing patterns (e.g. a genuinely
   new cohort shape), add a small render function in `generate.py` next to `render_ohio` /
   `render_california` / `render_texas` / `render_new_york`, and branch to it in
   `build_state_page()` by `state_slug`, same as the existing ones.
4. Run `python generate.py`. It will refuse to build (raises `SystemExit`) if any record's
   `next_deadline_computed` is on-or-before `as_of_date` — that's the stale-data guard
   catching a bad hand computation before it ships.
5. Spot-check the generated `docs/[new-slug]/index.html`: title has state + year + "CPA
   License Renewal Deadline", the date shown is genuinely in the future, the source link
   works, "Last verified" is present, and the back-link to `../` resolves.

## Known limitation (flag for whoever picks this up next)

`next_deadline_computed` for wave-1/2 records is a **stored value**, computed once against
`as_of_date: 2026-07-03`, not a live computation from the raw renewal rule the way the
wave-3 birth-month tables are. **Partially mitigated:** `generate.py` now refuses to build
(`SystemExit`) if `as_of_date` is more than 30 days old relative to real wall-clock time
(`date.today()`), not just relative to the JSON's own `as_of_date` field — this was a real gap
found and fixed during adversarial verification (see `verification_note.md`), and it's
independently tested (confirmed the guard actually fires on artificially-staled input, not just
present-but-unreachable code). That guard stops the pipeline from silently shipping a stale site
if it's re-run long after `as_of_date` without anyone updating the data — but it's a tripwire,
not a fix: past 30 days, the build simply refuses to run at all until someone re-verifies every
record and bumps `as_of_date`. Before this goes anywhere near a real launch: re-derive every
wave-1/2 record from its raw rule (month/day + cycle length + anchor year) at generate-time the
same way wave-3 already does, so `as_of_date` can be bumped freely and every date recomputes
correctly without a human re-verification pass each time.

## GitHub Pages deploy-readiness (staged, not deployed)

Output is written to `docs/` (not `site/`) specifically because that's GitHub's zero-config Pages
convention (repo Settings > Pages > Deploy from a branch > `/docs`) — once this directory lives in
a pushed repo with Pages enabled on it, no build step, Actions workflow, or `gh-pages` branch is
needed. Confirmed deploy-ready:
- Every internal link in the generated pages is relative (`../` back-links, no `href="/..."` or
  `localhost`/`127.0.0.1` references anywhere in `docs/`) — safe under a GitHub Pages *project*
  URL (`https://<user>.github.io/<repo>/`), which serves from a subpath, not the domain root.
- The one place an absolute URL is required by spec — `sitemap.xml`'s `<loc>` entries and
  `robots.txt`'s `Sitemap:` line — uses a single placeholder constant (`SITE_BASE_URL` in
  `generate.py`), swap that one line for the real `https://<user>.github.io/<repo>` URL (or a
  real domain later) once a publish go is given.
**Still not deployed**: no repo exists for this directory yet, Pages has not been enabled anywhere,
and the placeholder URL has not been replaced. All of that requires a repo + an explicit publish
decision — this section documents readiness, not a deployment that happened.

## Explicitly out of scope for this prototype

- No domain, no DNS, no hosting, no deploy of any kind (see "GitHub Pages deploy-readiness" above
  for what's *prepared*, which is not the same as *deployed*).
- No Stripe, no payment processing, no billing, no email capture, no ICS file generation
  (the DeadlineRadar pitch's paid tier) — those are deliberately deferred, capital/account-
  creating steps, not part of proving the content pipeline.
- No analytics, no tracking, no external JS, no CDN — the generated pages have no
  outbound network calls of any kind either.
- 40 states not yet covered (this is the 10-state spike sample, not the full 50-state build).
