#!/usr/bin/env python3
"""Citation-URL link-rot checker for DeadlineRadar.

Every "Confirmed at source" badge on this site is a promise that clicking
the link shows the reader the text we cited. AuditLab's first public-SEO
audit (2026-08-03) found 6 dead citation URLs -- one (Guam) had been dead
for roughly 3 months with nothing to notice it. Rule-TEXT changes are
already monitored (DiffLab); this is the same idea for the LINKS
themselves.

Walks every data/*.json and worker/src/*.json file, collects every string
value whose key ends in "_url" and starts with "http", and HEAD-checks each
(falling back to GET on a HEAD failure/405, since some government sites
don't implement HEAD). Reports non-2xx results.

This is a REPORT-ONLY, MANUALLY-RUN advisory -- like
worker_deploy_staleness_check.py, it does not fail preship_gate.py and
never edits data. A non-200 here is a strong signal to go verify in an
actual browser before touching the citation, not proof by itself that a
citation is dead -- some state/legislature sites 403 OR 404 automated
requests on pages that are perfectly live (e.g. legislature.mi.gov, caught
2026-08-03: 404 to this script, loads fine in a real browser). See the
2026-08-03 fix commits for confirmed real examples in both directions.

Usage: python scripts/check_citation_links.py [repo_root]
"""
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

TIMEOUT_SECONDS = 12
USER_AGENT = "Mozilla/5.0 (compatible; DeadlineRadarLinkCheck/1.0)"


def find_urls(obj, path=""):
    """Yields (path, url) for every string value at a key ending in "_url"
    that looks like an http(s) link. Deliberately generic (no hand-kept
    field-name list) so a newly added *_url field is covered automatically
    -- the same anti-drift reasoning as _mobility_covered_slugs() in
    generate.py.
    """
    if isinstance(obj, dict):
        for k, v in obj.items():
            key_path = f"{path}.{k}" if path else k
            if isinstance(v, str) and k.lower().endswith("_url") and v.startswith("http"):
                yield key_path, v
            else:
                yield from find_urls(v, key_path)
    elif isinstance(obj, list):
        for i, item in enumerate(obj):
            yield from find_urls(item, f"{path}[{i}]")


def check_url(url: str) -> tuple[bool, str]:
    """Returns (ok, detail). Tries HEAD first, falls back to GET (some
    government sites don't implement HEAD and return 405/501 to it)."""
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as resp:
            return 200 <= resp.status < 400, str(resp.status)
    except urllib.error.HTTPError as e:
        if e.code in (405, 501):
            pass  # fall through to GET
        elif 200 <= e.code < 400:
            return True, str(e.code)
        else:
            return False, str(e.code)
    except Exception as e:
        return False, type(e).__name__

    req = urllib.request.Request(url, method="GET", headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as resp:
            return 200 <= resp.status < 400, str(resp.status)
    except urllib.error.HTTPError as e:
        return 200 <= e.code < 400, str(e.code)
    except Exception as e:
        return False, type(e).__name__


def main() -> int:
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent
    files = sorted(root.glob("data/*.json")) + sorted(root.glob("worker/src/*.json"))

    all_urls: dict[str, list[str]] = {}
    for f in files:
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        for key_path, url in find_urls(data):
            all_urls.setdefault(url, []).append(f"{f.relative_to(root)}:{key_path}")

    print(f"Checking {len(all_urls)} distinct citation URLs across {len(files)} data files...")
    failures = []
    for i, (url, locations) in enumerate(sorted(all_urls.items()), 1):
        ok, detail = check_url(url)
        marker = "OK" if ok else "FAIL"
        print(f"[{i}/{len(all_urls)}] {marker} ({detail}) {url}")
        if not ok:
            failures.append((url, detail, locations))

    print()
    if not failures:
        print(f"PASS -- all {len(all_urls)} citation URLs responded.")
        return 0

    print(f"{len(failures)} of {len(all_urls)} URLs did not respond cleanly -- VERIFY IN A BROWSER before")
    print("treating any of these as dead. Some government sites 403 automated requests on live pages.")
    for url, detail, locations in failures:
        print(f"\n  {detail}  {url}")
        for loc in locations:
            print(f"    cited at: {loc}")
    return 0  # advisory only -- never fails the build


if __name__ == "__main__":
    sys.exit(main())
