#!/usr/bin/env python3
"""Turns the threshold sweep's per-run JSON into one table.

    python3 report/summarise_sweep.py

Reads results/sweep_<config>_r<n>.json, writes results/sweep.csv, and prints
the table. The median of the repeats is reported rather than the mean: these
are shared lab machines, and one run that happened to collide with something
else should not decide which threshold looks best.
"""

import csv
import json
import statistics
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RESULTS = ROOT / "results"

# name -> (label, policy, threshold)
CONFIGS = [
    ("roundrobin", "round robin", "roundrobin", None),
    ("leastload", "least load, no threshold", "least-load", None),
    ("t030", "threshold 0.30", "performance", 0.30),
    ("t040", "threshold 0.40", "performance", 0.40),
    ("t050", "threshold 0.50", "performance", 0.50),
    ("t060", "threshold 0.60", "performance", 0.60),
    ("t070", "threshold 0.70", "performance", 0.70),
    ("t080", "threshold 0.80", "performance", 0.80),
    ("t090", "threshold 0.90", "performance", 0.90),
]

COLUMNS = [
    "config",
    "label",
    "policy",
    "threshold",
    "runs",
    "throughput_rps",
    "p50_ms",
    "p95_ms",
    "p99_ms",
    "errors",
    "chat_1",
    "chat_2",
    "chat_3",
]


def median(values):
    return round(statistics.median(values), 1) if values else 0.0


def collect(name):
    runs = sorted(RESULTS.glob(f"sweep_{name}_r*.json"))
    runs = [path for path in runs if not path.name.endswith("_status.json")]

    return [json.loads(path.read_text()) for path in runs]


def main():
    rows = []

    for name, label, policy, threshold in CONFIGS:
        results = collect(name)
        if not results:
            continue

        per_backend = {"chat-1": [], "chat-2": [], "chat-3": []}
        for result in results:
            for backend in per_backend:
                per_backend[backend].append(result["per_backend"].get(backend, 0))

        rows.append(
            {
                "config": name,
                "label": label,
                "policy": policy,
                "threshold": threshold if threshold is not None else "",
                "runs": len(results),
                "throughput_rps": median([r["throughput_rps"] for r in results]),
                "p50_ms": median([r["latency_ms"]["p50"] for r in results]),
                "p95_ms": median([r["latency_ms"]["p95"] for r in results]),
                "p99_ms": median([r["latency_ms"]["p99"] for r in results]),
                "errors": sum(
                    r["transport_errors"] + r["non_200_responses"] for r in results
                ),
                "chat_1": int(median(per_backend["chat-1"])),
                "chat_2": int(median(per_backend["chat-2"])),
                "chat_3": int(median(per_backend["chat-3"])),
            }
        )

    if not rows:
        print("no sweep results found")
        return

    out = RESULTS / "sweep.csv"
    with out.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=COLUMNS)
        writer.writeheader()
        writer.writerows(rows)

    header = f"{'configuration':<26}{'rps':>9}{'p50':>9}{'p95':>9}{'p99':>10}{'errors':>8}   requests per backend"
    print(header)
    print("-" * len(header))

    for row in rows:
        print(
            f"{row['label']:<26}{row['throughput_rps']:>9.0f}{row['p50_ms']:>9.1f}"
            f"{row['p95_ms']:>9.1f}{row['p99_ms']:>10.1f}{row['errors']:>8}"
            f"   {row['chat_1']:>6} {row['chat_2']:>6} {row['chat_3']:>6}"
        )

    # The best configuration is the one that serves the most, provided it is
    # not doing so by making the tail unusable.
    usable = [r for r in rows if r["policy"] == "performance"]
    if usable:
        best = max(usable, key=lambda r: r["throughput_rps"])
        print(f"\nbest threshold by throughput: {best['label']} "
              f"({best['throughput_rps']:.0f} rps, p95 {best['p95_ms']:.0f} ms)")

    print(f"\nwrote {out.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
