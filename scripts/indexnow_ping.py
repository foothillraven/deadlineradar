#!/usr/bin/env python3
"""IndexNow ping (indexnow.org) -- notifies Bing/Yandex a page changed, instead of
waiting on their normal re-crawl schedule. Google has no public IndexNow support;
this doesn't touch Google indexing at all.

Deliberately NOT part of generate.py's build step (that file is offline-only by
design). Run this by hand after a real push to production has actually gone live --
pinging with URLs that aren't live yet just wastes the submission and looks sloppy
to the search engines' own abuse detection.

Usage:
    python scripts/indexnow_ping.py [--urls url1 url2 ...] [--all]

  --all         submit every URL in the live sitemap.xml (fetched from the real
                site, not the local build -- so it only ever pings URLs that are
                actually deployed)
  --urls ...    submit only the specific URLs listed (e.g. just-changed pages)

Prints the exact request and response; does not retry or hide a failure.
"""
import argparse
import json
import re
import sys
import urllib.request

SITE_BASE_URL = "https://deadline-radar.com"
INDEXNOW_KEY = "8e043aa98a82c1c393f1ac2aead217d8"
INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow"


def fetch_live_sitemap_urls() -> list[str]:
    with urllib.request.urlopen(f"{SITE_BASE_URL}/sitemap.xml", timeout=15) as resp:
        xml = resp.read().decode("utf-8")
    return re.findall(r"<loc>([^<]+)</loc>", xml)


def submit(urls: list[str]) -> None:
    if not urls:
        print("No URLs to submit.")
        return
    payload = {
        "host": "deadline-radar.com",
        "key": INDEXNOW_KEY,
        "keyLocation": f"{SITE_BASE_URL}/{INDEXNOW_KEY}.txt",
        "urlList": urls,
    }
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        INDEXNOW_ENDPOINT, data=body, method="POST",
        headers={"Content-Type": "application/json; charset=utf-8"},
    )
    print(f"Submitting {len(urls)} URL(s) to {INDEXNOW_ENDPOINT} ...")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            print(f"Response: HTTP {resp.status}")
    except urllib.error.HTTPError as e:
        print(f"HTTP error: {e.code} {e.reason}")
        print(e.read().decode("utf-8", errors="replace"))
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--urls", nargs="+", help="Specific URLs to submit")
    parser.add_argument("--all", action="store_true", help="Submit every URL in the live sitemap")
    args = parser.parse_args()

    if args.all:
        urls = fetch_live_sitemap_urls()
        print(f"Fetched {len(urls)} URLs from the live sitemap.")
    elif args.urls:
        urls = args.urls
    else:
        parser.error("Specify --all or --urls <url> [<url> ...]")
        return

    submit(urls)


if __name__ == "__main__":
    main()
