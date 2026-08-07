#!/usr/bin/env python3
"""Blog-guide review staleness check (2026-08-07, AuditLab PROSE-1).

The blog guides publish regulatory facts (fiscal-year windows, carryover
caps, cycle anchor dates) that live only in prose -- outside every dataset
and therefore outside every existing staleness tripwire. AuditLab's framing
of the real defect: "when Connecticut changes its carryover rule, nothing
on this site will notice."

data/guide_reviews.json is the registry this closes that with: one
last_reviewed date per guide, set only when a human (or a documented audit
pass) actually re-checks the guide's factual claims against their sources.
This script ages those dates the same way its three sibling checks age
their datasets, surfaced via preship_gate.py's advisory section.

Also cross-checks the registry against BLOG_ARTICLES' actual slugs in
generate.py (a guide added without a registry row would otherwise be
invisible to this check forever -- the exact silent-gap failure mode this
exists to prevent), by scanning generate.py's source for slug declarations.

Advisory only: prints a report, never blocks a build. The fix for a stale
row is a real re-review + date bump, not code.

Usage:
    python scripts/guide_review_staleness_check.py [repo_root]
"""
import json
import re
import sys
from datetime import date, datetime
from pathlib import Path


def main() -> None:
    repo_root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent
    data_path = repo_root / "data" / "guide_reviews.json"
    data = json.loads(data_path.read_text(encoding="utf-8"))
    threshold = int(data.get("review_threshold_days", 90))
    guides = data.get("guides", {})

    # Cross-check: every slug generate.py actually publishes must have a
    # registry row. Source-scanned (not imported) so this stays runnable
    # without generate.py's import-time side effects.
    gen_src = (repo_root / "generate.py").read_text(encoding="utf-8")
    published_slugs = set(re.findall(r'"slug":\s*"([a-z0-9-]+)"', gen_src))
    # generate.py has other "slug" keys (state options etc.) -- constrain to
    # the ones that render under /blog/ by checking the guide dir actually
    # built for them, when docs/ exists.
    blog_dir = repo_root / "docs" / "blog"
    if blog_dir.exists():
        built = {p.name for p in blog_dir.iterdir() if p.is_dir()}
        published_slugs = published_slugs & built
    unregistered = sorted(published_slugs - set(guides.keys()))
    orphaned = sorted(set(guides.keys()) - published_slugs) if published_slugs else []

    today = date.today()
    fresh, stale, unparseable = [], [], []
    for slug, row in guides.items():
        lr = row.get("last_reviewed")
        try:
            reviewed = datetime.strptime(lr, "%Y-%m-%d").date()
        except (TypeError, ValueError):
            unparseable.append(slug)
            continue
        age_days = (today - reviewed).days
        (stale if age_days > threshold else fresh).append((slug, lr, age_days))

    print(f"Guide-review staleness check -- {today.isoformat()} (threshold {threshold}d)")
    print(f"  fresh: {len(fresh)}   stale: {len(stale)}   unparseable: {len(unparseable)}   unregistered guides: {len(unregistered)}")

    if stale:
        print(f"\nSTALE -- past the {threshold}-day bar, re-review the guide's facts against sources ({len(stale)}):")
        for slug, lr, age_days in sorted(stale, key=lambda t: -t[2]):
            print(f"  /blog/{slug}/ -- last_reviewed={lr} ({age_days}d old)")
    if unparseable:
        print(f"\nUNPARSEABLE last_reviewed ({len(unparseable)}) -- treat as stale until fixed:")
        for slug in unparseable:
            print(f"  /blog/{slug}/")
    if unregistered:
        print(f"\nUNREGISTERED -- published under /blog/ with NO registry row ({len(unregistered)}); add one with a real review date:")
        for slug in unregistered:
            print(f"  /blog/{slug}/")
    if orphaned:
        print(f"\nORPHANED registry rows (no matching published guide) ({len(orphaned)}):")
        for slug in orphaned:
            print(f"  {slug}")

    if not (stale or unparseable or unregistered):
        print("\nPASS -- every published guide has a registry row within the freshness bar.")


if __name__ == "__main__":
    main()
