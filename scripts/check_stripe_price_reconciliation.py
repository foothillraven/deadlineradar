#!/usr/bin/env python3
"""Stripe price reconciliation check (2026-08-05, AuditLab BILL-3).

Two independent sources of truth for what a paid tier costs:
    displayed   worker/src/tiers.ts   { planTier, label, priceUsd, seatCap }
    charged     the real Stripe Price object each STRIPE_PRICE_* env var
                (a wrangler secret) points to -- unit_amount + interval

Nothing before this asserted the two agree. A mis-configured price ID, or an
amount edited directly in the Stripe dashboard, would leave the site
advertising one price while Stripe actually charges another, with no build
step, test, or guard noticing -- exactly the "silent mismatch" class this
whole reliability push exists to catch, applied to money instead of a
renewal date. This is the SAME shape as check_deadline_currency() in
preship_gate.py: convert a silent wrong answer into a loud, explicit failure.

Deliberately NOT wired into preship_gate.py's automatic flow: every other
check there is fully offline (reads local JSON/HTML, no network, no secret
needed), which is why it runs on every local `python generate.py`. This one
needs a live Stripe secret key and a real network call to a paid third-party
API -- a genuinely different dependency shape, so it stays a separate,
deliberately-run script. Run it by hand before any deploy that touches
Stripe price configuration (a new tier, a changed STRIPE_PRICE_* secret,
before flipping from test-mode to live-mode keys at Gate 2), not on every
build.

Usage:
    export STRIPE_SECRET_KEY=sk_test_...   (or source .secrets/stripe.env's
                                             STRIPE_TEST_SECRET_KEY as this)
    python scripts/check_stripe_price_reconciliation.py

Exit code 0 = every configured price matches what tiers.ts advertises.
Exit code 1 = at least one mismatch, or a configured price ID that Stripe
doesn't recognise at all (also a real, loud problem -- checkout would 500).
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

# Mirrors worker/src/tiers.ts's FIRM_TIERS exactly. Kept as a literal
# duplicate here (not parsed out of the .ts file) -- four numbers is cheap
# to keep in sync by eye, and a Python->TypeScript parser would be more
# code and more failure modes than the thing it's guarding against. If
# this ever drifts from tiers.ts, that IS the bug this script exists to
# catch on the OTHER side (Stripe) -- keep both sides honest by hand.
#
# STRIPE_PRICE_INDIVIDUAL removed 2026-08-09 -- the $39/yr Individual tier
# was folded into free (see tiers.ts/entitlements.ts's own comments); it
# never had a real checkout path, so there's no live Stripe price left to
# reconcile against.
EXPECTED_TIERS = {
    "STRIPE_PRICE_FIRM_STARTER": {"label": "Starter", "price_usd": 199},
    "STRIPE_PRICE_FIRM_GROWTH": {"label": "Growth", "price_usd": 299},
    "STRIPE_PRICE_FIRM_STANDARD": {"label": "Standard", "price_usd": 399},
    "STRIPE_PRICE_FIRM_SCALE": {"label": "Scale", "price_usd": 549},
}


def fetch_price(secret_key: str, price_id: str) -> dict:
    req = urllib.request.Request(
        f"https://api.stripe.com/v1/prices/{price_id}",
        headers={"Authorization": f"Basic {_basic_auth(secret_key)}"},
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _basic_auth(secret_key: str) -> str:
    import base64

    return base64.b64encode(f"{secret_key}:".encode("utf-8")).decode("ascii")


def main() -> int:
    secret_key = os.environ.get("STRIPE_SECRET_KEY")
    if not secret_key:
        print("REFUSING: STRIPE_SECRET_KEY not set. Export it (test or live) and re-run.", file=sys.stderr)
        return 1

    mismatches = []
    missing_env = []
    api_errors = []
    checked = 0

    for env_name, expected in EXPECTED_TIERS.items():
        price_id = os.environ.get(env_name)
        if not price_id:
            missing_env.append(env_name)
            continue
        try:
            price = fetch_price(secret_key, price_id)
        except urllib.error.HTTPError as e:
            api_errors.append((env_name, price_id, f"HTTP {e.code}: {e.read().decode('utf-8', 'replace')[:200]}"))
            continue
        except urllib.error.URLError as e:
            api_errors.append((env_name, price_id, str(e)))
            continue

        checked += 1
        expected_cents = expected["price_usd"] * 100
        actual_cents = price.get("unit_amount")
        actual_interval = (price.get("recurring") or {}).get("interval")
        actual_currency = price.get("currency")

        problems = []
        if actual_cents != expected_cents:
            problems.append(f"unit_amount={actual_cents} (expected {expected_cents}, i.e. ${expected['price_usd']})")
        if actual_interval != "year":
            problems.append(f"recurring.interval={actual_interval!r} (expected 'year')")
        if actual_currency != "usd":
            problems.append(f"currency={actual_currency!r} (expected 'usd')")
        if problems:
            mismatches.append((env_name, expected["label"], price_id, problems))

    print(f"Stripe price reconciliation check -- {checked} price(s) fetched and compared against tiers.ts")

    if missing_env:
        print(f"\nNOT CONFIGURED ({len(missing_env)}) -- env var unset, skipped:")
        for name in missing_env:
            print(f"  {name}")

    if api_errors:
        print(f"\nAPI ERROR ({len(api_errors)}) -- Stripe rejected or couldn't be reached for this price id:")
        for env_name, price_id, err in api_errors:
            print(f"  {env_name} ({price_id}): {err}")

    if mismatches:
        print(f"\nMISMATCH ({len(mismatches)}) -- site advertises one price, Stripe would charge another:")
        for env_name, label, price_id, problems in mismatches:
            print(f"  {env_name} [{label}] ({price_id}):")
            for p in problems:
                print(f"    - {p}")

    if not mismatches and not api_errors and checked > 0:
        print("\nPASS -- every configured price matches tiers.ts exactly.")

    return 1 if (mismatches or api_errors) else 0


if __name__ == "__main__":
    raise SystemExit(main())
