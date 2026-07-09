# DeadlineRadar — Prevention Register

Tracks failure classes (not one-off bugs) the same way the fleet's other prevention registers do:
instance → detector → propagate → verify → status. A class stays open until a detector exists that
would have caught the instance, and the detector has been run at least once against the current
live state.

---

## #1 — Static site and Worker deploy through separate pipelines

**Instance** (2026-07-09): South Dakota, Hawaii, and Oklahoma silently rejected real signups on the
live site with `"Unsupported or missing state"`. Root cause: the static site (`docs/`) redeploys
automatically on every push via GitHub Pages, but the Cloudflare Worker does NOT — it only picks up
a new `cpa_deadlines.json` when someone explicitly runs `wrangler deploy`. The Worker's bundled data
predated those three states' addition, even though their pages were already live and correct on the
static site. Found by the Synthetic Firm Pilot's very first test (South Dakota), confirmed via a
North Carolina control that correctly passed the same state-validation check.

**Fixed**: redeployed the Worker with the already-committed, already-reviewed current source
(`wrangler deploy` at commit `6ac5df0`) — no code change, just syncing the bundle. Verified via
direct curl: SD/HI/OK all now correctly reach Turnstile instead of failing at state validation.

**Detector**: `scripts/worker_deploy_staleness_check.py` — advisory-only, compares the last commit
that touched `worker/src/cpa_deadlines.json` against the commit recorded in
`worker/.last_deploy_commit` (updated after every real deploy). Flags if the data file changed after
the last recorded deploy. Deliberately does NOT live-probe the deployed Worker across all 51 states —
that would burn real per-IP rate-limit budget for no good reason when a local git comparison answers
the same question for free. Run it any time `cpa_deadlines.json` changes, and periodically otherwise.

**Process fix**: any change touching `data/cpa_deadlines.json` / `worker/src/cpa_deadlines.json`
needs a `wrangler deploy` as part of the same ship, not just a docs regenerate + push. Added to the
mental ship checklist here so it's not just tribal knowledge — **if you changed the CPA dataset,
redeploy the Worker before calling the ship done, and update `worker/.last_deploy_commit`.**

**Status**: CLOSED pending orchestrator confirmation (detector built + verified both directions —
correctly flags a stale state and correctly passes a current one — 2026-07-09).
