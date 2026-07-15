#!/usr/bin/env python3
"""DeadlineRadar owned-social auto-posting (Bluesky / AT Protocol) -- built
2026-07-15 per the unified social auto-poster plan (assetlab_20260715T_social_
autoposter_plan.md): Bluesky is the zero-approval-friction starter channel.

STATUS: dev/test mode only. `post_to_bluesky()` does not post anywhere -- there
is no App Password configured yet, and this file must not go live until Devin
has created the Bluesky account and handed over one App Password (Settings ->
Privacy & Security -> App Passwords), and approved the first batch of templates
+ cadence, same two-gate discipline as the Meta pipeline.

Reuses content_engine.py's templating/selection logic (shared with
meta_poster.py) rather than duplicating it -- the content model is identical
across platforms, only the posting transport and the per-platform character
limit differ.

Bluesky posts are capped at 300 graphemes (AT Protocol's documented limit).
Every generated post is checked against this before it's ever queued to
"post" -- a violation raises loudly rather than silently truncating a
citation or link, same fail-closed pattern as this repo's mailing-address
and deadline-date guards elsewhere.

Usage (dev/test, safe to run any time -- prints drafts, posts nothing):
    python social/bluesky_poster.py --draft [N]      # print N draft posts (default 5)
    python social/bluesky_poster.py --history         # show what's already been "posted" (test log)
"""
from __future__ import annotations

import argparse
from pathlib import Path

from content_engine import (
    load_post_history,
    save_post_history,
    select_candidates,
)

POST_HISTORY_PATH = Path(__file__).resolve().parent / "bluesky_post_history.json"

# AT Protocol's documented per-post grapheme limit. Enforced here, not just
# assumed -- a post that would exceed it must fail loudly during drafting,
# never get silently truncated (a truncated citation/URL is a worse failure
# than no post at all).
BLUESKY_MAX_GRAPHEMES = 300


def _check_length(text: str) -> None:
    if len(text) > BLUESKY_MAX_GRAPHEMES:
        raise ValueError(
            f"Generated post is {len(text)} chars, over Bluesky's "
            f"{BLUESKY_MAX_GRAPHEMES}-grapheme limit -- refusing to queue it "
            f"rather than silently truncate: {text!r}"
        )


def post_to_bluesky(post: dict) -> None:
    """NOT WIRED. Raises until a real App Password exists and Devin has approved
    go-live -- this is deliberate, not an oversight. When ready, this becomes an
    authenticated call via the official `@atproto/api`-equivalent flow (or a
    plain HTTPS POST to com.atproto.repo.createRecord) using credentials read
    from a gitignored local file (never committed), same pattern as every other
    token in this repo."""
    raise RuntimeError(
        "post_to_bluesky() is a dev/test-mode stub -- no App Password is "
        "configured, and this must not go live before Devin approves the "
        "account + first batch. See assetlab_20260715T_social_autoposter_plan.md."
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
    for d in drafts:
        _check_length(d["text"])

    print(f"Drafted {len(drafts)} post(s) (dev/test mode -- nothing posted anywhere):\n")
    for d in drafts:
        print(f"[{d['type']}] ({len(d['text'])}/{BLUESKY_MAX_GRAPHEMES} chars) {d['text']}\n")

    # Log to history as if posted, so repeated dev runs still rotate states/formats
    # realistically -- purely a test-mode convenience, not a real posting record.
    history.extend(drafts)
    save_post_history(POST_HISTORY_PATH, history[-50:])


if __name__ == "__main__":
    main()
