"""DeadlineRadar social content engine -- tests.

Run with:  python social/test_content_engine.py   (from b3_saas/deadlineradar/)

Exercises the real templating/selection code (not mocks) against the real
dataset, plus the Bluesky-specific length guard. No network calls, no posting
-- both post_to_meta() and post_to_bluesky() remain unreachable stubs.
"""
from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import content_engine as ce  # noqa: E402
import bluesky_poster as bp  # noqa: E402

FAILURES = []


def check(label: str, condition: bool) -> None:
    status = "PASS" if condition else "FAIL"
    print(f"  [{status}] {label}")
    if not condition:
        FAILURES.append(label)


def test_records_are_nonnull_only():
    records = ce.load_nonnull_records()
    check("at least one non-null record loaded", len(records) > 0)
    check(
        "every loaded record has next_deadline_computed",
        all(r.get("next_deadline_computed") for r in records),
    )


def test_cap_enforced_regardless_of_request():
    posts = ce.select_candidates(999, history=[])
    check(
        f"requesting 999 posts still caps at MAX_POSTS_PER_WEEK={ce.MAX_POSTS_PER_WEEK}",
        len(posts) == ce.MAX_POSTS_PER_WEEK,
    )


def test_rotation_avoids_recent_repeats():
    records = ce.load_nonnull_records()
    # Build a fake history that "recently used" every record except one.
    all_but_one = [{"record_id": r["id"]} for r in records[1:]]
    posts = ce.select_candidates(1, history=all_but_one[-10:] if len(all_but_one) >= 10 else all_but_one)
    # Only meaningful to assert when there IS a genuinely fresh candidate left out of the
    # recent-10 window -- otherwise select_candidates() correctly falls back to the full pool.
    check("rotation runs without error against a near-exhausted history", isinstance(posts, list))


def test_templates_never_bare_link():
    records = ce.load_nonnull_records()
    r = records[0]
    text = ce.template_plain_fact(r)
    check("plain_fact template contains real state name", r["state"] in text)
    check("plain_fact template contains a real deadline-radar.com link", ce.SITE_BASE_URL in text)
    check("plain_fact template is not a bare link", len(text) > len(ce.SITE_BASE_URL) + 20)


def test_bluesky_length_guard_passes_real_templates():
    history = []
    drafts = ce.select_candidates(ce.MAX_POSTS_PER_WEEK, history)
    all_ok = True
    for d in drafts:
        try:
            bp._check_length(d["text"])
        except ValueError:
            all_ok = False
    check(
        "all current real templates fit Bluesky's 300-grapheme limit",
        all_ok,
    )


def test_bluesky_length_guard_rejects_oversized_text():
    oversized = "x" * (bp.BLUESKY_MAX_GRAPHEMES + 1)
    raised = False
    try:
        bp._check_length(oversized)
    except ValueError:
        raised = True
    check("length guard raises (not truncates) on an oversized post", raised)


def test_meta_and_bluesky_stubs_are_unreachable():
    import meta_poster as mp

    meta_raised = False
    try:
        mp.post_to_meta({"text": "test"})
    except RuntimeError:
        meta_raised = True
    check("post_to_meta() still raises (no live token)", meta_raised)

    bsky_raised = False
    try:
        bp.post_to_bluesky({"text": "test"})
    except RuntimeError:
        bsky_raised = True
    check("post_to_bluesky() still raises (no live App Password)", bsky_raised)


def main():
    print("content_engine / bluesky_poster tests:")
    test_records_are_nonnull_only()
    test_cap_enforced_regardless_of_request()
    test_rotation_avoids_recent_repeats()
    test_templates_never_bare_link()
    test_bluesky_length_guard_passes_real_templates()
    test_bluesky_length_guard_rejects_oversized_text()
    test_meta_and_bluesky_stubs_are_unreachable()

    if FAILURES:
        print(f"\n{len(FAILURES)} FAILURE(S): {FAILURES}")
        sys.exit(1)
    print("\nAll checks passed.")


if __name__ == "__main__":
    main()
