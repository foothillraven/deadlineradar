#!/usr/bin/env python3
"""DeadlineRadar owned-social auto-posting (Meta: Facebook Page, optionally Instagram
Business) -- built 2026-07-06 per Devin's directive to pursue Meta over Bluesky/LinkedIn.

STATUS: dev/test mode only. `post_to_meta()` does not post anywhere -- there is no
access token configured yet, and this file must not go live until Devin has: created
the Page, completed Business Verification / App Review as needed, and approved the
first batch of templates + cadence (see assetlab_20260706T_meta_setup_build_plan.md).

Correctness rule, same as everywhere else in this repo: only ever draws from
NON-NULL `next_deadline_computed` records. A gapped/BYOD state is never posted about
-- `select_candidates()` filters these out structurally, not just by convention.

Usage (dev/test, safe to run any time -- prints drafts, posts nothing):
    python social/meta_poster.py --draft [N]        # print N draft posts (default 5)
    python social/meta_poster.py --history           # show what's already been "posted" (test log)
"""
from __future__ import annotations

import argparse
import json
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_PATH = ROOT / "data" / "cpa_deadlines.json"
POST_HISTORY_PATH = Path(__file__).resolve().parent / "post_history.json"

SITE_BASE_URL = "https://deadline-radar.com"

# Anti-spam design (per the greenlit plan, unchanged from the original proposal):
# a real cadence cap, spread across states/formats, never a bare link, no
# auto-follow/unfollow, no auto-reply/auto-DM. This constant is the enforcement
# point for the cap -- select_candidates() will not return more than this many
# per week regardless of how it's invoked.
MAX_POSTS_PER_WEEK = 5


def load_nonnull_records() -> list[dict]:
    data = json.loads(DATA_PATH.read_text(encoding="utf-8"))
    return [r for r in data["records"] if r.get("next_deadline_computed")]


def load_post_history() -> list[dict]:
    if not POST_HISTORY_PATH.exists():
        return []
    return json.loads(POST_HISTORY_PATH.read_text(encoding="utf-8"))


def save_post_history(history: list[dict]) -> None:
    POST_HISTORY_PATH.write_text(json.dumps(history, indent=2), encoding="utf-8")


def _fmt_date(iso: str) -> str:
    from datetime import date
    MONTH_NAMES = [
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December",
    ]
    d = date.fromisoformat(iso)
    return f"{MONTH_NAMES[d.month - 1]} {d.day}, {d.year}"


def template_plain_fact(record: dict) -> str:
    """The baseline template: one real fact, its citation, a link. Never a bare link."""
    date_str = _fmt_date(record["next_deadline_computed"])
    citation = record.get("citation")
    cite_part = f" ({citation})" if citation else ""
    return (
        f"{record['state']} CPAs: your {record['license_type_label'].lower()} renews "
        f"{date_str}{cite_part}. Free reminder -> "
        f"{SITE_BASE_URL}/{record['state_slug']}/"
    )


def template_cross_state_comparison(record: dict, other: dict) -> str:
    """Reuses the same 'two different clocks' angle as the blog's own CPE-vs-renewal
    piece -- genuinely informative, not filler, matches the site's existing voice."""
    return (
        f"{record['state']} and {other['state']} CPAs: different renewal clocks. "
        f"{record['state']} renews {_fmt_date(record['next_deadline_computed'])}, "
        f"{other['state']} renews {_fmt_date(other['next_deadline_computed'])}. "
        f"Find your state -> {SITE_BASE_URL}/"
    )


def template_blog_link(article_slug: str, hook: str) -> str:
    return f"{hook} -> {SITE_BASE_URL}/blog/{article_slug}/"


BLOG_HOOKS = [
    ("cpe-vs-license-renewal", "CPE due date and license renewal date -- not always the same day"),
    ("common-cpa-renewal-mistakes", "The 5 renewal mistakes that trip up CPAs most often"),
    ("missouri-cpa-license-renewal-guide", "How Missouri's 2-year license cycle and annual CPE actually work together"),
]


def select_candidates(count: int, history: list[dict]) -> list[dict]:
    """Picks up to `count` posts (capped at MAX_POSTS_PER_WEEK regardless of the
    caller's request), rotating states so the same one doesn't repeat back-to-back,
    and mixing template types for variety."""
    count = min(count, MAX_POSTS_PER_WEEK)
    records = load_nonnull_records()
    recent_ids = {h["record_id"] for h in history[-10:] if h.get("record_id")}
    fresh = [r for r in records if r["id"] not in recent_ids] or records

    posts = []
    for i in range(count):
        variant = i % 3
        if variant == 0 or len(fresh) < 2:
            r = random.choice(fresh)
            posts.append({
                "type": "plain_fact", "record_id": r["id"], "state": r["state"],
                "text": template_plain_fact(r),
            })
        elif variant == 1:
            r1, r2 = random.sample(fresh, 2)
            posts.append({
                "type": "comparison", "record_id": r1["id"], "state": f"{r1['state']}/{r2['state']}",
                "text": template_cross_state_comparison(r1, r2),
            })
        else:
            slug, hook = random.choice(BLOG_HOOKS)
            posts.append({
                "type": "blog_link", "record_id": None, "state": None,
                "text": template_blog_link(slug, hook),
            })
    return posts


def post_to_meta(post: dict) -> None:
    """NOT WIRED. Raises until a real access token exists and Devin has approved
    go-live -- this is deliberate, not an oversight. When ready, this becomes a
    Graph API POST to /{page-id}/feed with message=post['text'], using a token read
    from a gitignored local file (never committed), same credential pattern as the
    Cloudflare/GitHub tokens already used elsewhere in this session."""
    raise RuntimeError(
        "post_to_meta() is a dev/test-mode stub -- no access token is configured, "
        "and this must not go live before Devin approves the account + first batch. "
        "See assetlab_20260706T_meta_setup_build_plan.md."
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--draft", nargs="?", const=5, type=int, help="Print N draft posts (default 5)")
    parser.add_argument("--history", action="store_true", help="Show test post history")
    args = parser.parse_args()

    if args.history:
        history = load_post_history()
        print(f"{len(history)} test-mode 'posts' logged (nothing actually posted):")
        for h in history:
            print(f"  [{h['type']}] {h['state']}: {h['text']}")
        return

    n = args.draft if args.draft is not None else 5
    history = load_post_history()
    drafts = select_candidates(n, history)
    print(f"Drafted {len(drafts)} post(s) (dev/test mode -- nothing posted anywhere):\n")
    for d in drafts:
        print(f"[{d['type']}] {d['text']}\n")

    # Log to history as if posted, so repeated dev runs still rotate states/formats
    # realistically -- purely a test-mode convenience, not a real posting record.
    history.extend(drafts)
    save_post_history(history[-50:])


if __name__ == "__main__":
    main()
