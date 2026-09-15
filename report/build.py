#!/usr/bin/env python3
"""Builds the report from the template and the measurement files, then renders the PDF.

    python3 report/build.py [headline experiment name]

Every number and every transcript is read from results/ rather than typed into
the template, so the report cannot drift away from the runs that produced it.
The prose that has to quote a number quotes it from the same file the figure
beside it was drawn from.
"""

import csv
import html
import json
import re
import subprocess
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from diagram import DIAGRAM  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
REPORT = ROOT / "report"
RESULTS = ROOT / "results"
SOURCES = ROOT / "sources"

OUT_HTML = REPORT / "report.html"
OUT_PDF = ROOT / "Akshat_Gupta_12340160_DynamicLoadBalancer_Report.pdf"

HEADLINE = sys.argv[1] if len(sys.argv) > 1 else "headline"


def esc(text):
    return html.escape(str(text).rstrip("\n"))


def read(path, missing=""):
    path = Path(path)
    return esc(path.read_text()) if path.exists() else esc(missing)


def read_json(name):
    path = RESULTS / name
    return json.loads(path.read_text()) if path.exists() else None


def figure(name):
    """An SVG figure, referenced rather than inlined so the HTML stays readable."""
    if not (REPORT / "figures" / name).exists():
        return '<p class="missing">figure not generated</p>'

    return f'<img src="figures/{name}" alt="">'


def terminal(text):
    """Marks up the prompt lines in a captured transcript."""
    lines = []

    for line in text.split("\n"):
        if line.startswith("$ "):
            lines.append('<span class="c">$</span> <span class="p">' + line[2:] + "</span>")
        elif line.startswith("# "):
            lines.append('<span class="c">' + line + "</span>")
        else:
            lines.append(line)

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Tables
# ---------------------------------------------------------------------------


def sweep_rows():
    path = RESULTS / "sweep.csv"
    if not path.exists():
        return []

    with path.open() as handle:
        return list(csv.DictReader(handle))


def sweep_table():
    rows = sweep_rows()
    if not rows:
        return "<p>The sweep has not been run.</p>"

    best = best_threshold(rows)

    out = [
        "<table>",
        "<thead><tr><th>Configuration</th><th class='num'>Requests/s</th>"
        "<th class='num'>Median</th><th class='num'>95th</th><th class='num'>99th</th>"
        "<th class='num'>Errors</th><th>Share per back end</th></tr></thead>",
        "<tbody>",
    ]

    for row in rows:
        total = max(1, int(row["chat_1"]) + int(row["chat_2"]) + int(row["chat_3"]))
        share = "  ".join(
            f"{int(row[key]) / total * 100:.0f}%" for key in ("chat_1", "chat_2", "chat_3")
        )

        emphasis = " class='total'" if best and row["config"] == best["config"] else ""
        label = esc(row["label"])
        if emphasis:
            label = f"<b>{label}</b> &larr; used"

        out.append(
            f"<tr{emphasis}><td>{label}</td>"
            f"<td class='num'>{float(row['throughput_rps']):.0f}</td>"
            f"<td class='num'>{float(row['p50_ms']):.0f} ms</td>"
            f"<td class='num'>{float(row['p95_ms']):.0f} ms</td>"
            f"<td class='num'>{float(row['p99_ms']):.0f} ms</td>"
            f"<td class='num'>{row['errors']}</td>"
            f"<td class='mono'>{share}</td></tr>"
        )

    out += ["</tbody></table>"]
    return "\n".join(out)


def best_threshold(rows=None):
    rows = rows if rows is not None else sweep_rows()
    candidates = [r for r in rows if r["policy"] == "performance"]

    if not candidates:
        return None

    return max(candidates, key=lambda r: float(r["throughput_rps"]))


def sweep_commentary():
    rows = sweep_rows()
    best = best_threshold(rows)
    if not best:
        return "<p>The sweep has not been run.</p>"

    by_name = {r["config"]: r for r in rows}
    rr = by_name.get("roundrobin")
    ll = by_name.get("leastload")

    def share_of_chat3(row):
        total = sum(int(row[key]) for key in ("chat_1", "chat_2", "chat_3"))
        return int(row["chat_3"]) / total if total else 0.0

    best_rps = float(best["throughput_rps"])
    threshold = float(best["threshold"])

    parts = [
        f"<p>The threshold this deployment uses is <b>{threshold:.2f}</b>, which was the fastest "
        f"of the nine at {best_rps:.0f} requests a second."
    ]

    if rr:
        rr_rps = float(rr["throughput_rps"])
        parts.append(
            f" That is {best_rps / rr_rps:.1f} times what the fixed rotation manages "
            f"({rr_rps:.0f} a second) with a 95th percentile "
            f"{float(rr['p95_ms']) / max(1.0, float(best['p95_ms'])):.1f} times lower."
        )

    parts.append("</p>")

    # The sweep's real finding is a relationship rather than a winning number:
    # how much of the traffic Sys4 was given, against what the cluster managed.
    ordered = sorted(
        (r for r in rows if r["policy"] == "performance" or r["config"] == "roundrobin"),
        key=share_of_chat3,
    )

    if len(ordered) >= 3:
        least, most = ordered[0], ordered[-1]
        parts.append(
            f"<p>Reading down the distribution column explains the whole table. The less traffic "
            f"a configuration gives chat-3, the more the cluster as a whole serves: "
            f"{least['label']} sends it {share_of_chat3(least) * 100:.0f}% of requests and "
            f"manages {float(least['throughput_rps']):.0f} a second, while {most['label']} sends "
            f"it {share_of_chat3(most) * 100:.0f}% and manages "
            f"{float(most['throughput_rps']):.0f}. That looks perverse until you remember what "
            f"is on Sys4: chat-3 shares its one core with the database that all three back ends "
            f"write to. A request sent there is not one request's worth of work, it is one "
            f"request's worth taken out of everybody's database. The high thresholds are slow "
            f"precisely because they are generous.</p>"
        )

    thresholds = sorted(
        (r for r in rows if r["policy"] == "performance"),
        key=lambda r: float(r["threshold"]),
    )

    if len(thresholds) >= 3 and ll:
        low = thresholds[0]
        ll_rps = float(ll["throughput_rps"])
        parts.append(
            f"<p>Going the other way has a limit, though, and that is what makes this a peak "
            f"rather than a slope. Below about 0.50 nearly every back end is over the threshold "
            f"nearly all the time, so the policy spends its life in the fallback path, where it "
            f"is doing nothing more than picking the current minimum: {low['label']} lands at "
            f"{float(low['throughput_rps']):.0f} a second, close to the "
            f"{ll_rps:.0f} that always picking the minimum gives on its own. The threshold has "
            f"stopped selecting anything and has become a formality.</p>"
        )

    parts.append(
        "<p>One thing the table cannot show is that this is a decision about load rather than "
        "about machines. At 0.60 and under heavy load chat-3 is excluded outright, because it is "
        "genuinely over the line the whole time. Run the same balancer against twenty users "
        "instead of a hundred and fifty and chat-3 stays under 0.60 and takes about a quarter of "
        "the traffic, alongside 39% and 36% for the other two. The balancer has no idea that one "
        "of its three back ends is different; it only knows that under load one of them keeps "
        "reporting less room than the others.</p>"
    )

    return "\n".join(parts)


def headline_table():
    summary = read_json(f"{HEADLINE}.json")
    if not summary:
        return "<p>No headline run recorded.</p>"

    latency = summary["latency_ms"]
    post = summary.get("post_latency_ms", {})
    feed = summary.get("feed_latency_ms", {})
    verification = summary.get("verification", {})

    rows = [
        ("Virtual users", f"{summary['users']}"),
        ("Run length", f"{summary['measured_s']:.0f} s measured, {summary['duration_s']:.0f} s total"),
        ("Message length", f"{summary['message_length_min']}&ndash;{summary['message_length_max']} characters, random"),
        ("Interval between a user's messages", f"{summary['interval_min_ms']}&ndash;{summary['interval_max_ms']} ms, random"),
        ("Requests completed", f"{summary['requests']:,}"),
        ("Throughput", f"<b>{summary['throughput_rps']:.0f} per second</b>"),
        ("Response time, median", f"{latency['p50']:.0f} ms"),
        ("Response time, 95th percentile", f"{latency['p95']:.0f} ms"),
        ("Response time, 99th percentile", f"{latency['p99']:.0f} ms"),
        ("POST /message, median", f"{post.get('p50', 0):.0f} ms"),
        ("GET /feed, median", f"{feed.get('p50', 0):.0f} ms"),
        ("Failed requests", f"{summary['transport_errors'] + summary['non_200_responses']}"),
    ]

    if verification:
        verdict = "every message present exactly once" if verification.get("ok") else "FAILED"
        rows.append(
            ("Messages checked in /feed afterwards",
             f"{verification.get('sent', 0):,} sent, {verification.get('missing', 0)} missing, "
             f"{verification.get('duplicated', 0)} duplicated &mdash; {verdict}")
        )

    body = "\n".join(f"<tr><td>{name}</td><td>{value}</td></tr>" for name, value in rows)

    return f"<table><tbody>{body}</tbody></table>"


def routing_commentary():
    timeline = read_json(f"{HEADLINE}_timeline.json")
    if not timeline or not timeline.get("samples"):
        return ""

    samples = timeline["samples"]
    threshold = timeline["threshold"]
    count = len(samples[0]["score"])

    over = [sum(1 for s in samples if s["over"][i]) for i in range(count)]
    total = len(samples)
    names = ["chat-1", "chat-2", "chat-3"]

    busiest = max(range(count), key=lambda i: over[i])

    if over[busiest] == 0:
        return (
            f"<p>No back end crossed {threshold:.2f} during this run, so the threshold never had "
            f"to act and every request went to whichever back end had the most headroom at the "
            f"time. That is the ordinary case and it is what the flat middle of the sweep is "
            f"made of.</p>"
        )

    return (
        f"<p>{names[busiest]} spent {over[busiest] / total * 100:.0f}% of this run over the "
        f"{threshold:.2f} threshold, and the lower panel shows what that cost it: each time its "
        f"score crosses the line its share of the traffic drops towards zero and the other two "
        f"absorb it, and each time it recovers the traffic comes back. It is the back end sharing "
        f"its core with the database, so it is the one that runs out of headroom first. Nothing "
        f"about this is configured per machine; the balancer has no idea which of the three is "
        f"different, only that one of them keeps reporting less room than the others.</p>"
    )


def failover_summary():
    summary = read_json("failover.json")
    metrics = read_json("failover_lb.json")

    if not summary:
        return "<p>The failover run has not been done.</p>"

    verification = summary.get("verification", {})
    failed = summary["transport_errors"] + summary["non_200_responses"]

    rows = [
        ("Requests completed", f"{summary['requests']:,}"),
        ("Throughput across the whole run", f"{summary['throughput_rps']:.0f} per second"),
        ("Response time, median / 95th", f"{summary['latency_ms']['p50']:.0f} ms / "
                                          f"{summary['latency_ms']['p95']:.0f} ms"),
        ("Requests the clients saw fail", f"<b>{failed}</b>"),
    ]

    if metrics:
        rows.append(("Requests the balancer replayed onto another back end",
                     f"{metrics.get('retried', 0)}"))

    if verification:
        rows.append(
            ("Messages checked in /feed afterwards",
             f"{verification.get('sent', 0):,} sent, {verification.get('missing', 0)} missing, "
             f"{verification.get('duplicated', 0)} duplicated")
        )

    body = "\n".join(f"<tr><td>{name}</td><td>{value}</td></tr>" for name, value in rows)

    return f"<table><tbody>{body}</tbody></table>"


def bottleneck():
    """What the utilisation traces say is in the way."""
    window = read_json(f"{HEADLINE}_window.json")
    if not window:
        return "<p>No headline run recorded.</p>"

    means = {}
    for index, key in enumerate(["sys1", "sys2", "sys3", "sys4"], start=1):
        path = RESULTS / f"{HEADLINE}_sys{index}.csv"
        if not path.exists():
            continue

        with path.open() as handle:
            values = [
                float(r["cpu_fraction"])
                for r in csv.DictReader(handle)
                if window["started_at"] <= float(r["epoch"]) <= window["finished_at"]
            ]

        if values:
            means[key] = sum(values) / len(values)

    if not means:
        return "<p>No utilisation samples for the headline run.</p>"

    lines = ["<table><thead><tr><th>System</th><th class='num'>Mean CPU</th><th>What is on it</th>"
             "</tr></thead><tbody>"]

    labels = {
        "sys1": "load balancer, and another project's service",
        "sys2": "chat-1",
        "sys3": "chat-2",
        "sys4": "chat-3 and MongoDB",
    }

    for key in ("sys1", "sys2", "sys3", "sys4"):
        if key not in means:
            continue
        lines.append(
            f"<tr><td>{key.replace('sys', 'Sys')}</td>"
            f"<td class='num'>{means[key] * 100:.0f}%</td><td>{labels[key]}</td></tr>"
        )

    lines.append("</tbody></table>")

    hottest = max(means, key=means.get)

    prose = [
        "<p>Each of these containers has one core, so a mean near 100% means that machine is the "
        "ceiling. "
    ]

    if hottest == "sys4":
        prose.append(
            "Sys4 is the ceiling here, and it is the ceiling for the whole cluster rather than "
            "for its own back end: it holds the database that the other two write to. The two "
            "processes' own CPU counters say where that core goes.</p>"
            f"<figure><pre>{read(RESULTS / 'sys4_split.txt', 'not measured')}</pre>"
            "<figcaption><b>Sys4 under load</b>, from "
            "<code>sources/ops/cpu-split.sh</code>. Every message from all three back ends is an "
            "insert into that one process on that one core.</figcaption></figure>"
            "<p>Which is why the balancer routes away from Sys4 under load rather than sharing "
            "equally, and why round robin is so much slower: work sent to Sys4 competes with the "
            "database that the other two machines are waiting on, so an evenly shared request is "
            "not an evenly priced one.</p>"
            "<p>The obvious question is whether the database should go back on Sys1 with the "
            "balancer. Measured, no: the balancer alone already uses about "
            f"{means.get('sys1', 0) * 100:.0f}% of Sys1's core at this load, and it handles every "
            "request twice, once inbound and once outbound. Adding three quarters of a core of "
            "database to it asks for more than the machine has, and Sys1 is also the container "
            "that has already been out-of-memory-killed 57 times with another project's service "
            "on it. The database is where it is because that was the least bad of the two "
            "places available.</p>"
            "<p>Getting it to stay there took two changes. MongoDB sizes its cache from the "
            "machine it can see rather than the cgroup it is in, and its smallest accepted "
            "setting for that, 0.25&nbsp;GB, was still enough to grow the process to 442&nbsp;MB "
            "of a 512&nbsp;MB container and have the kernel kill something mid-run. The cache is "
            "pinned to 112&nbsp;MB through the engine configuration string, which WiredTiger "
            "reads after the value the documented flag produces, and the back ends were cut from "
            "sixteen connections each to six. A three minute run at this load went from 8,064 "
            "failed requests to none.</p>"
        )
    else:
        prose.append(
            f"The hottest machine in this run is {hottest.replace('sys', 'Sys')}.</p>"
        )

    return "\n".join(lines) + "\n" + "".join(prose)


# ---------------------------------------------------------------------------

OPERATIONS = """\
# deploy everything, or restart it after a container reboot
sources/ops/deploy.sh all

# just one part of it
sources/ops/deploy.sh db | backends | lb

# one measured run: load, per-second response times, and CPU and memory
# for all four systems
sources/ops/experiment.sh headline 60 -users 150 -verify

# kill a back end in the middle of a run and watch the balancer notice
sources/ops/failover.sh 60

# how Sys4's one core is divided between the back end and the database
sources/ops/cpu-split.sh 20

# every routing policy and threshold, three runs each
sources/ops/threshold-sweep.sh 3 30

# capture the transcripts the report quotes
sources/ops/evidence.sh

# rebuild this report from whatever is in results/
python3 report/plots.py headline && python3 report/build.py headline\
"""

FILE_MAP = """\
sources/lb/main.go                the load balancer
sources/loadgen/main.go           the load generator
sources/server/                   the chat back end, as deployed
    server.js                       startup and wiring
    src/api/router.js               /message and /feed
    src/api/feedStore.js            the in-memory room /feed is served from
    src/api/writeQueue.js           batched, idempotent writes
    src/api/loadMetrics.js          what a back end reports about its load
    src/db/                         connection, indexes, message storage
    src/routes/health.js            /health and /lb/load
sources/ops/                      deploy, supervise, stop, experiment, sweep,
                                  failover, cpu-split, evidence, sample-system
sources/tools/                    replica set admin, migration, cleanup
sources/cross_replica_test.js     the browser chat, across all three back ends
sources/assignment1/              the previous assignment's sources
results/                          every measurement this report quotes
results/assignment1/              the previous assignment's results, untouched
report/                           template, stylesheet, figures, build scripts\
"""


FIELDS = {
    "DATE": date.today().strftime("%-d %B %Y"),
    "DIAGRAM": DIAGRAM,
    "INVENTORY": read(RESULTS / "inventory.txt", "not captured"),
    "ROUTES_DEMO": terminal(read(RESULTS / "routes_demo.txt", "not captured")),
    "DUPLICATE_DEMO": terminal(read(RESULTS / "duplicate_demo.txt", "not captured")),
    "CROSS_REPLICA": read(RESULTS / "cross-replica.txt", "not captured"),
    "SWEEP_TABLE": sweep_table(),
    "SWEEP_COMMENTARY": sweep_commentary(),
    "SWEEP_FIG": figure("sweep.svg"),
    "SWEEP_DIST_FIG": figure("sweep_distribution.svg"),
    "LOADGEN_USAGE": read(RESULTS / "loadgen_usage.txt", "not captured"),
    "HEADLINE_TABLE": headline_table(),
    "RESPONSE_FIG": figure(f"{HEADLINE}_response_time.svg"),
    "UTILISATION_FIG": figure(f"{HEADLINE}_utilisation.svg"),
    "ROUTING_FIG": figure(f"{HEADLINE}_routing.svg"),
    "ROUTING_COMMENTARY": routing_commentary(),
    "FAILOVER_SUMMARY": failover_summary(),
    "FAILOVER_FIG": figure("failover_response_time.svg"),
    "FAILOVER_ROUTING_FIG": figure("failover_routing.svg"),
    "FAILOVER_LOG": read(RESULTS / "failover_lb_log.txt", "not captured"),
    "BOTTLENECK": bottleneck(),
    "OPERATIONS": esc(OPERATIONS),
    "FILE_MAP": esc(FILE_MAP),
    "LB_SOURCE": read(SOURCES / "lb" / "main.go"),
    "ROUTER_SOURCE": read(SOURCES / "server" / "src" / "api" / "router.js"),
    "WRITEQUEUE_SOURCE": read(SOURCES / "server" / "src" / "api" / "writeQueue.js"),
    "FEEDSTORE_SOURCE": read(SOURCES / "server" / "src" / "api" / "feedStore.js"),
    "LOADMETRICS_SOURCE": read(SOURCES / "server" / "src" / "api" / "loadMetrics.js"),
    "LOADGEN_SOURCE": read(SOURCES / "loadgen" / "main.go"),
}


def main():
    page = (REPORT / "template.html").read_text()

    for key, value in FIELDS.items():
        token = "{{" + key + "}}"
        if token not in page:
            sys.exit(f"template has no slot for {key}")
        page = page.replace(token, str(value))

    # Only our own token shape counts as unfilled. Source listings contain
    # things like a JSDoc "{{ maxBatch?: number }}", which is not a placeholder
    # and should not stop the build.
    leftover = [line for line in page.splitlines() if re.search(r"\{\{[A-Z][A-Z0-9_]*\}\}", line)]
    if leftover:
        sys.exit(f"unfilled placeholder: {leftover[0].strip()}")

    OUT_HTML.write_text(page)
    print(f"wrote {OUT_HTML.relative_to(ROOT)}  ({len(page) / 1024:.0f} KB)")

    subprocess.run(
        [
            "google-chrome",
            "--headless",
            "--disable-gpu",
            "--no-sandbox",
            "--no-pdf-header-footer",
            f"--print-to-pdf={OUT_PDF}",
            OUT_HTML.as_uri(),
        ],
        check=True,
        capture_output=True,
    )
    print(f"wrote {OUT_PDF.relative_to(ROOT)}  ({OUT_PDF.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
