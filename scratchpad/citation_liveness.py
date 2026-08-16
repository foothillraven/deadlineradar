"""Sweep every citation_url/source_url for links that dead-end on a live page.

Prompted by the Arkansas find (2026-08-14): both 17 CAR citation_urls returned
HTTP 200 with a .NET "Object reference not set to an instance of an object"
crash page, and source_check called them CONFIRMED_TEXT because 1061 characters
of site chrome came back. They were live on our state pages -- a reader clicking
"view the rule" landed on a stack-trace stub. Same family as the Colorado
raw-JSON citation Devin found by clicking it.

HTTP status is not the test. What renders is the test.
"""
import json
import pathlib
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "scripts"))
import source_check as sc  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATASETS = ["cpa_deadlines", "cpe_hours", "reinstatement", "renewal_fees"]
FIELDS = ["citation_url", "source_url"]
# mobility_rules.json lives only under worker/src/ (no data/ copy) and has never
# been run through this sweep -- added 2026-08-15 on the theory that a dataset
# nobody's checked is exactly where the Arkansas-shaped defect would still be
# hiding. Same {records: [...]} shape, no id field (state_slug doubles as id).
MOBILITY_PATH = ROOT / "worker" / "src" / "mobility_rules.json"

targets = []
seen = set()
for name in DATASETS:
    doc = json.loads((ROOT / "data" / f"{name}.json").read_text(encoding="utf-8"))
    for rec in doc["records"]:
        for f in FIELDS:
            u = rec.get(f)
            if u and u.startswith("http") and (u, f) not in seen:
                seen.add((u, f))
                targets.append((name, rec.get("id"), f, u))

if MOBILITY_PATH.exists():
    mdoc = json.loads(MOBILITY_PATH.read_text(encoding="utf-8"))
    for rec in mdoc["records"]:
        for f in FIELDS:
            u = rec.get(f)
            if u and u.startswith("http") and (u, f) not in seen:
                seen.add((u, f))
                targets.append(("mobility_rules", rec.get("state_slug"), f, u))

print(f"checking {len(targets)} distinct urls\n", flush=True)
bad, ok, err = [], 0, 0
for i, (ds, rid, field, url) in enumerate(targets, 1):
    try:
        r = sc.check(url)
        cls = r["classification"]
    except Exception as e:              # network/parse blowups are data too
        cls, r = "EXCEPTION", {"detail": repr(e)[:160]}
        err += 1
    if cls == "CONFIRMED_TEXT":
        ok += 1
    else:
        bad.append((ds, rid, field, url, cls, str(r.get("detail", ""))[:140]))
        print(f"  [{cls}] {rid} .{field}\n      {url}\n      {r.get('detail','')}", flush=True)
    if i % 25 == 0:
        print(f"  ...{i}/{len(targets)} ({len(bad)} bad)", flush=True)
    time.sleep(0.4)                     # be a polite visitor to state servers

print(f"\n==== {ok} ok / {len(bad)} not-ok / {err} exceptions, of {len(targets)} ====")
out = ROOT / "scratchpad" / "citation_liveness_results.json"
out.write_text(json.dumps(bad, indent=2), encoding="utf-8")
print("wrote", out)
