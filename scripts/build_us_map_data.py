#!/usr/bin/env python3
"""
One-time (re-runnable) data-prep script: builds assets/us-map/state-paths.json from the two
raw public-domain source files in assets/us-map/ (see that directory's LICENSE.txt).

Not run by generate.py -- generate.py reads the already-built state-paths.json directly, same
as it reads cpa_deadlines.json. Re-run this only if the source files themselves ever need
replacing (e.g. a cleaner/more detailed public-domain map is found later).

Usage:
    python scripts/build_us_map_data.py
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ASSETS_DIR = ROOT / "assets" / "us-map"

CODE_TO_SLUG = {
    "al": "alabama", "ak": "alaska", "az": "arizona", "ar": "arkansas", "ca": "california",
    "co": "colorado", "ct": "connecticut", "de": "delaware", "dc": "dc", "fl": "florida",
    "ga": "georgia", "hi": "hawaii", "id": "idaho", "il": "illinois", "in": "indiana",
    "ia": "iowa", "ks": "kansas", "ky": "kentucky", "la": "louisiana", "me": "maine",
    "md": "maryland", "ma": "massachusetts", "mi": "michigan", "mn": "minnesota",
    "ms": "mississippi", "mo": "missouri", "mt": "montana", "ne": "nebraska",
    "nv": "nevada", "nh": "new-hampshire", "nj": "new-jersey", "nm": "new-mexico",
    "ny": "new-york", "nc": "north-carolina", "nd": "north-dakota", "oh": "ohio",
    "ok": "oklahoma", "or": "oregon", "pa": "pennsylvania", "ri": "rhode-island",
    "sc": "south-carolina", "sd": "south-dakota", "tn": "tennessee", "tx": "texas",
    "ut": "utah", "vt": "vermont", "va": "virginia", "wa": "washington",
    "wv": "west-virginia", "wi": "wisconsin", "wy": "wyoming",
}


def main() -> None:
    raphael_text = (ASSETS_DIR / "_source_raphael_paths.js").read_text(encoding="utf-8")
    pairs = re.findall(r'(\w+):"((?:[^"\\]|\\.)*)"', raphael_text)
    paths = dict(pairs)

    # Indiana is missing from the Raphael conversion -- pulled directly from the same
    # original Wikimedia source file, same coordinate space (959x593 viewBox).
    orig_text = (ASSETS_DIR / "_source_wikimedia_original.svg").read_text(encoding="utf-8")
    m = re.search(r'<path class="in" d="([^"]+)"', orig_text)
    if not m:
        raise SystemExit("Could not find Indiana's path in the original source SVG.")
    paths["in"] = m.group(1)

    if len(paths) != 51:
        raise SystemExit(f"Expected 51 paths (50 states + DC), got {len(paths)}: {sorted(paths)}")
    missing = set(CODE_TO_SLUG) - set(paths)
    if missing:
        raise SystemExit(f"Missing path data for: {missing}")

    # The Raphael source has at least one multi-subpath state (Michigan, upper + lower
    # peninsula) joined as "...z,M..." -- a comma directly between a closepath and the next
    # moveto. Commas are only valid SVG path syntax between numeric coordinates, not between
    # commands, so browsers stop parsing the path at that point (confirmed via a real browser
    # console error: "<path> attribute d: Expected path command"). Normalize any
    # command-comma-command junction to a space, which is valid and a no-op for paths that
    # don't have the issue.
    command_comma_command = re.compile(r"([a-zA-Z]),([a-zA-Z])")
    paths = {code: command_comma_command.sub(r"\1 \2", d) for code, d in paths.items()}

    out = [{"code": code, "slug": slug, "d": paths[code]} for code, slug in CODE_TO_SLUG.items()]
    out_path = ASSETS_DIR / "state-paths.json"
    out_path.write_text(json.dumps(out), encoding="utf-8")
    print(f"wrote {out_path} ({len(out)} states)")


if __name__ == "__main__":
    main()
