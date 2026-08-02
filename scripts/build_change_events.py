#!/usr/bin/env python3
"""Extract PUBLISHABLE rule-change events from the mobility ruleset.

## Why this is a separate file and a separate build step

The changes feed must be able to publish the change FACTS + citations while the
mobility DETERMINATION ENGINE stays held from production (orchestrator's
directive, 2026-08-01). Deriving events into their own dataset -- rather than
having the feed read the engine's ruleset directly -- is what keeps those two
separable. The feed depends on this file; it never imports mobility.

## Why status is derived from STRUCTURED FIELDS ONLY, never from prose

`EDITORIAL_CHARTER_law_coverage.md` mandates one explicit status label per item
(ENACTED / ADOPTED RULE / PROPOSED / DIED) and warns, with Florida's
died-two-sessions mobility bills as the example, that blurring them actively
misleads a CPA.

I measured whether the label could be inferred from each record's prose
(`flux_note` / `notes` / `citation`). It cannot: **27 of 55 records match
enacted-signals AND proposed-signals AND rule-signals simultaneously**, because
a single flux_note routinely discusses a signed act, the rulemaking that
follows it, and the board rule it amends. A regex over that prose would emit a
confident label with no basis -- precisely the failure the charter exists to
prevent.

So this script derives ONLY what the structured fields support:

  * `rule_changes_on` in the FUTURE  -> a dated, signed change not yet in force.
  * `rule_changes_on` in the PAST    -> a change whose date has passed. The
    charter forbids asserting it took effect without re-verification after the
    date, so these carry `needs_reverification` and the feed must render the
    charter's wording ("effective [date]; we re-verify on/after that date"),
    never "is now in effect".
  * `rule_in_flux` with NO date      -> NOT a rule change. These are the
    source-disagreement records (board page contradicts the statute). The
    directive is explicit that these must not be conflated with rule changes,
    so they get their own kind and never appear in the changes list.

Anything else is not emitted. A smaller, correct feed beats a complete one
with a guessed label.

## Hard rejections (charter: "No item without a source. Ever.")

A candidate is DROPPED, loudly, if it lacks a citation, lacks a primary-source
URL, has a non-http(s) URL, or names a jurisdiction outside our 55. The script
prints every rejection so a gap is visible rather than silent.
"""

from __future__ import annotations

import json
import pathlib
import sys
from datetime import date

ROOT = pathlib.Path(__file__).resolve().parent.parent
RULES = ROOT / "worker" / "src" / "mobility_rules.json"
OUT = ROOT / "data" / "reg_change_events.json"
DEADLINES = ROOT / "data" / "cpa_deadlines.json"

KIND_CHANGE = "rule_change"
KIND_CONFLICT = "source_conflict"


# Known jurisdiction-slug aliases between ScoutLab's vocabulary and ours.
#
# Deliberately an explicit, tiny, DOCUMENTED map rather than fuzzy matching:
# a slug mismatch must stay loud. This one was caught by the script's own
# rejection gate on 2026-08-01 -- ScoutLab emits "district-of-columbia" while
# every deadline record, URL and page on this site uses "dc". Without the
# alias, DC would silently vanish from the changes feed; with fuzzy matching,
# the NEXT mismatch would silently resolve to the wrong jurisdiction.
#
# Reported upstream so the source vocabulary converges. If this map grows
# beyond a couple of entries, fix it at the source instead.
SLUG_ALIASES = {"district-of-columbia": "dc"}


def _http(url: object) -> str | None:
    """Only http(s) survives -- these render into href attributes, where HTML
    escaping does nothing against a javascript: URI."""
    if isinstance(url, str) and url.startswith(("http://", "https://")):
        return url
    return None


def build(today: date) -> tuple[list[dict], list[str]]:
    rules = json.loads(RULES.read_text(encoding="utf-8"))["records"]
    valid_slugs = {
        r["state_slug"] for r in json.loads(DEADLINES.read_text(encoding="utf-8"))["records"]
    }

    events: list[dict] = []
    rejected: list[str] = []

    for r in rules:
        slug = SLUG_ALIASES.get(r.get("state_slug"), r.get("state_slug"))
        if slug not in valid_slugs:
            rejected.append(f"{slug}: jurisdiction not in our 55")
            continue
        if r.get("rule_in_flux") is not True:
            continue  # nothing changing and no disagreement -> not an event

        citation = r.get("citation")
        citation_url = _http(r.get("citation_url"))
        if not citation or not citation_url:
            rejected.append(f"{slug}: no citation or no primary-source URL -- charter forbids publishing")
            continue

        changes_on = r.get("rule_changes_on")
        parsed: date | None = None
        if changes_on:
            try:
                parsed = date.fromisoformat(changes_on)
            except (TypeError, ValueError):
                rejected.append(f"{slug}: unparseable rule_changes_on {changes_on!r}")
                continue

        base = {
            "event_id": f"{slug}-mobility-{changes_on or 'source-conflict'}",
            "jurisdiction_slug": slug,
            "jurisdiction": r.get("state") or slug,
            "topic": "practice privilege (mobility)",
            "citation": citation,
            "citation_url": citation_url,
            "secondary_url": _http(r.get("source_url")),
            "verified_date": r.get("verified_date"),
            "confidence": r.get("confidence"),
            # Verbatim prose from the record. The feed renders this as the
            # factual description; it is NOT re-worded, so no editorial voice
            # is introduced at this layer.
            "detail": r.get("flux_note") or r.get("notes"),
        }

        if parsed is None:
            base.update({
                "kind": KIND_CONFLICT,
                "effective_date": None,
                # Deliberately NOT one of the charter's law-status labels: this
                # is not a law changing, it is our two sources disagreeing.
                "status": "SOURCE_CONFLICT",
                "needs_reverification": False,
            })
        else:
            base.update({
                "kind": KIND_CHANGE,
                "effective_date": changes_on,
                "status": "ENACTED",
                "upcoming": parsed > today,
                # The charter forbids asserting a change took effect without
                # re-verifying after the date passed.
                "needs_reverification": parsed <= today,
            })
        events.append(base)

    events.sort(key=lambda e: (e.get("effective_date") or "9999-99-99", e["jurisdiction_slug"]))
    return events, rejected


def main() -> int:
    today = date.today()
    events, rejected = build(today)

    changes = [e for e in events if e["kind"] == KIND_CHANGE]
    upcoming = [e for e in changes if e.get("upcoming")]
    recent = [e for e in changes if not e.get("upcoming")]
    conflicts = [e for e in events if e["kind"] == KIND_CONFLICT]

    OUT.write_text(json.dumps({
        "_meta": {
            "purpose": "Publishable rule-change events for the public changes feed.",
            "generated_from": "worker/src/mobility_rules.json",
            "separable": "Deliberately independent of the mobility determination engine, which is "
                         "HELD from production. The feed publishes change facts + citations only.",
            "status_derivation": "Structured fields ONLY (rule_changes_on presence + direction). "
                                 "Status is NOT inferred from prose: 27 of 55 records match "
                                 "enacted/proposed/rule signals simultaneously, so a regex label "
                                 "would be a guess. Records whose status cannot be established "
                                 "from structure are not emitted.",
            "reverification_rule": "needs_reverification=true means the effective date has passed "
                                   "and we have NOT re-checked. The page must say 'effective [date]; "
                                   "we re-verify on/after that date' -- never 'is now in effect'.",
            "as_of": today.isoformat(),
        },
        "events": events,
    }, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    print(f"wrote {OUT.relative_to(ROOT)}")
    print(f"  rule changes   : {len(changes)}  ({len(upcoming)} upcoming, {len(recent)} past-dated)")
    print(f"  source conflicts: {len(conflicts)}  (rendered separately -- NOT rule changes)")
    print(f"  past-dated needing re-verification before we may claim they took effect: "
          f"{sum(1 for e in changes if e['needs_reverification'])}")
    if rejected:
        print(f"\n  REJECTED {len(rejected)} (visible, not silent):")
        for r in rejected:
            print(f"    - {r}")
    if not events:
        print("\n  no events -- nothing to publish", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
