#!/usr/bin/env python3
"""DeadlineRadar owned-social content engine -- platform-agnostic templating,
candidate selection, and rotation. Extracted 2026-07-15 from meta_poster.py
(originally built 2026-07-06) so Bluesky/LinkedIn posters can reuse the exact
same content logic instead of duplicating it -- nothing here is Meta-specific.

Correctness rule, same as everywhere else in this repo: only ever draws from
NON-NULL `next_deadline_computed` records. A gapped/BYOD state is never posted
about -- `select_candidates()` filters these out structurally, not just by
convention.
"""
from __future__ import annotations

import json
import random
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_PATH = ROOT / "data" / "cpa_deadlines.json"

SITE_BASE_URL = "https://deadline-radar.com"

# Anti-spam design (per the greenlit plan, unchanged from the original proposal):
# a real cadence cap, spread across states/formats, never a bare link, no
# auto-follow/unfollow, no auto-reply/auto-DM. This constant is the enforcement
# point for the cap -- select_candidates() will not return more than this many
# per week regardless of how it's invoked. Each platform enforces its OWN cap
# independently (separate history files), so this is a per-platform ceiling,
# not a shared fleet-wide one.
MAX_POSTS_PER_WEEK = 5

MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
]


def load_nonnull_records() -> list[dict]:
    data = json.loads(DATA_PATH.read_text(encoding="utf-8"))
    return [r for r in data["records"] if r.get("next_deadline_computed")]


def load_post_history(history_path: Path) -> list[dict]:
    if not history_path.exists():
        return []
    return json.loads(history_path.read_text(encoding="utf-8"))


def save_post_history(history_path: Path, history: list[dict]) -> None:
    history_path.write_text(json.dumps(history, indent=2), encoding="utf-8")


def _fmt_date(iso: str) -> str:
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
