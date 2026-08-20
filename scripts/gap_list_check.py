#!/usr/bin/env python3
"""Gap-list inventory (SRC-4, AuditLab 2026-08-14).

AuditLab's SRC-4 finding: a "0 unresolved" claim about sourcing-gap records
was checked against a list that existed only in the working session's
context -- reconstructed by memory on each sweep, never the same subset
twice. 60 of 245 records across the four datasets carry a data_gap_note or
verification_note; a remembered sweep of 17 of them said "settled" while two
records outside that subset (nebraska-cpe, massachusetts-reinstatement) were
never in scope at all. The claim was unfalsifiable because it was a
statement about a list, not about the data.

This script derives that list mechanically every time it runs, the same
"replace a judgement that had to be remembered with a check that runs" move
already used by _DERIVED_FEE_CHECKS and source_check.py. It also persists
the result to data/gap_list.json -- a checked-in artifact instead of a
number quoted in a commit message -- so a future session can `cat` the file
instead of re-deriving the population from scratch.

Each entry is additionally classified for a block/parse claim (SRC-5's
class: "blocks automated requests", "could not be reached", etc.) using
source_check.BLOCK_CLAIM_RE -- the SAME regex object preship_gate.py's
check_block_claims_corroborated() gates on (imported, not copied, after
SRC-7 found the two had already drifted apart) -- a record in this list
making that specific claim is the subset SRC-5 already verifies against
source_check.py at gate time; this script does not duplicate those network
calls, only flags which entries fall in that class so a reader knows which
claims are independently live-checked.

Run standalone, this prints a report and never exits non-zero -- it is
inventory, not a pass/fail gate. Wired into preship_gate.py as an advisory
(print_gap_list_advisory()) so the artifact regenerates on every ship and
can never itself go stale.

Usage:
    python scripts/gap_list_check.py [repo_root]
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from source_check import BLOCK_CLAIM_RE

# (dataset filename, fields to check for a gap/verification note). Only
# cpa_deadlines.json carries verification_note as a distinct field from
# data_gap_note; the other three only ever use data_gap_note.
_DATASETS = [
    ("cpa_deadlines.json", ["data_gap_note", "verification_note"]),
    ("cpe_hours.json", ["data_gap_note"]),
    ("reinstatement.json", ["data_gap_note"]),
    ("renewal_fees.json", ["data_gap_note"]),
]


def collect_gap_entries(repo_root: Path) -> tuple[list[dict], int]:
    """Returns (entries, total_record_count) across all four datasets.
    Each entry: {dataset, id, state, state_slug, field, note, is_block_claim}."""
    entries = []
    total_records = 0
    for filename, fields in _DATASETS:
        data_path = repo_root / "data" / filename
        data = json.loads(data_path.read_text(encoding="utf-8"))
        records = data["records"]
        total_records += len(records)
        for r in records:
            for field in fields:
                note = r.get(field)
                if not note:
                    continue
                entries.append({
                    "dataset": filename,
                    "id": r.get("id"),
                    "state": r.get("state"),
                    "state_slug": r.get("state_slug"),
                    "field": field,
                    "note": note,
                    "is_block_claim": bool(BLOCK_CLAIM_RE.search(note)),
                })
    return entries, total_records


def main() -> None:
    repo_root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent
    entries, total_records = collect_gap_entries(repo_root)

    block_claims = [e for e in entries if e["is_block_claim"]]

    print(f"Gap-list inventory -- {len(entries)} record(s) of {total_records} total carry a "
          f"sourcing gap/verification note across {len(_DATASETS)} datasets")
    print(f"  of those, {len(block_claims)} make a block/parse claim (SRC-5's class, "
          f"independently verified against source_check.py at gate time)")

    by_dataset: dict[str, int] = {}
    for e in entries:
        by_dataset[e["dataset"]] = by_dataset.get(e["dataset"], 0) + 1
    for filename, _fields in _DATASETS:
        print(f"    {filename}: {by_dataset.get(filename, 0)}")

    if block_claims:
        print(f"\n  block/parse claims ({len(block_claims)}):")
        for e in sorted(block_claims, key=lambda x: (x["dataset"], x["state_slug"] or "")):
            print(f"    [{e['dataset']}:{e['id']}] {e['state']} ({e['field']}) -- {e['note'][:100]!r}")

    artifact_path = repo_root / "data" / "gap_list.json"
    artifact = {
        "_meta": {
            "generated_by": "scripts/gap_list_check.py",
            "purpose": "SRC-4 (AuditLab, 2026-08-14): mechanically-derived inventory of every "
                       "record carrying a sourcing gap/verification note, regenerated on every "
                       "preship_gate.py run so it can never go stale or be a remembered subset.",
        },
        "total_records": total_records,
        "gap_record_count": len(entries),
        "block_claim_count": len(block_claims),
        "entries": entries,
    }
    artifact_path.write_text(
        json.dumps(artifact, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n"
    )
    print(f"\n  artifact written: {artifact_path.relative_to(repo_root)}")


if __name__ == "__main__":
    main()
