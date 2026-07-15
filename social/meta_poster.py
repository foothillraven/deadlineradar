#!/usr/bin/env python3
"""DeadlineRadar owned-social auto-posting (Meta: Facebook Page, optionally Instagram
Business) -- built 2026-07-06 per Devin's directive to pursue Meta over Bluesky/LinkedIn.

STATUS: dev/test mode only. `post_to_meta()` does not post anywhere -- there is no
access token configured yet, and this file must not go live until Devin has: created
the Page, completed Business Verification / App Review as needed, and approved the
first batch of templates + cadence (see assetlab_20260706T_meta_setup_build_plan.md).

Content/templating/selection logic lives in content_engine.py (extracted 2026-07-15
so Bluesky/LinkedIn posters can share it) -- this file now only owns the Meta-specific
posting stub and its own post-history rotation state.

Usage (dev/test, safe to run any time -- prints drafts, posts nothing):
    python social/meta_poster.py --draft [N]        # print N draft posts (default 5)
    python social/meta_poster.py --history           # show what's already been "posted" (test log)
"""
from __future__ import annotations

import argparse
from pathlib import Path

from content_engine import (
    load_post_history,
    save_post_history,
    select_candidates,
)

POST_HISTORY_PATH = Path(__file__).resolve().parent / "post_history.json"


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
        history = load_post_history(POST_HISTORY_PATH)
        print(f"{len(history)} test-mode 'posts' logged (nothing actually posted):")
        for h in history:
            print(f"  [{h['type']}] {h['state']}: {h['text']}")
        return

    n = args.draft if args.draft is not None else 5
    history = load_post_history(POST_HISTORY_PATH)
    drafts = select_candidates(n, history)
    print(f"Drafted {len(drafts)} post(s) (dev/test mode -- nothing posted anywhere):\n")
    for d in drafts:
        print(f"[{d['type']}] {d['text']}\n")

    # Log to history as if posted, so repeated dev runs still rotate states/formats
    # realistically -- purely a test-mode convenience, not a real posting record.
    history.extend(drafts)
    save_post_history(POST_HISTORY_PATH, history[-50:])


if __name__ == "__main__":
    main()
