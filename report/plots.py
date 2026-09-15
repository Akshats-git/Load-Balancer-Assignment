#!/usr/bin/env python3
"""Draws the report's figures from the measurement files.

    python3 report/plots.py

Every figure is read straight out of results/, so a figure cannot disagree with
the run that produced it. Missing inputs are skipped with a note rather than
faked.

Output is SVG, into report/figures/, because the report is rendered to PDF and
a vector figure stays sharp when someone zooms in on a percentile.
"""

import csv
import json
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.ticker import FuncFormatter  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
RESULTS = ROOT / "results"
FIGURES = ROOT / "report" / "figures"

# Categorical slots, assigned in order and never cycled.
BLUE, ORANGE, AQUA, YELLOW = "#2a78d6", "#eb6834", "#1baf7a", "#eda100"
VIOLET, RED = "#4a3aa7", "#e34948"

INK = "#0b0b0b"
INK_SOFT = "#52514e"
INK_MUTED = "#767d87"
GRID = "#e3e3e0"
SURFACE = "#ffffff"

SYSTEMS = [
    ("sys1", "Sys1  load balancer", BLUE),
    ("sys2", "Sys2  chat-1", ORANGE),
    ("sys3", "Sys3  chat-2", AQUA),
    ("sys4", "Sys4  chat-3 and MongoDB", VIOLET),
]

plt.rcParams.update(
    {
        "font.family": "sans-serif",
        "font.sans-serif": ["DejaVu Sans", "Helvetica", "Arial"],
        "font.size": 8.5,
        "axes.edgecolor": GRID,
        "axes.labelcolor": INK_SOFT,
        "axes.titlecolor": INK,
        "axes.titlesize": 9.5,
        "axes.titleweight": "600",
        "axes.labelsize": 8.5,
        "xtick.color": INK_MUTED,
        "ytick.color": INK_MUTED,
        "xtick.labelsize": 8,
        "ytick.labelsize": 8,
        "figure.facecolor": SURFACE,
        "axes.facecolor": SURFACE,
        "savefig.facecolor": SURFACE,
        "legend.frameon": False,
        "legend.fontsize": 8,
    }
)


def tidy(ax, ylabel=None, xlabel=None):
    """Recessive axes: keep the data, lose the box."""
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.spines["left"].set_color(GRID)
    ax.spines["bottom"].set_color(GRID)
    ax.grid(axis="y", color=GRID, linewidth=0.7)
    ax.set_axisbelow(True)
    if ylabel:
        ax.set_ylabel(ylabel)
    if xlabel:
        ax.set_xlabel(xlabel)


def save(fig, name):
    FIGURES.mkdir(parents=True, exist_ok=True)
    path = FIGURES / name
    fig.savefig(path, format="svg", bbox_inches="tight", pad_inches=0.02)
    plt.close(fig)
    print(f"  wrote {path.relative_to(ROOT)}")


def read_series(name):
    path = RESULTS / f"{name}_series.csv"
    if not path.exists():
        return None
    with path.open() as handle:
        return list(csv.DictReader(handle))


def read_json(name):
    path = RESULTS / name
    return json.loads(path.read_text()) if path.exists() else None


def percent(value, _pos):
    return f"{value * 100:.0f}%"


def smooth(values, window):
    """Centred rolling mean, shrinking the window at the ends."""
    out = []
    half = window // 2

    for i in range(len(values)):
        chunk = values[max(0, i - half):i + half + 1]
        out.append(sum(chunk) / len(chunk))

    return out


# ---------------------------------------------------------------------------
# Response time and throughput over one run
# ---------------------------------------------------------------------------


def figure_response_time(name, title):
    rows = read_series(name)
    if not rows:
        print(f"  skipping response time: no {name}_series.csv")
        return

    seconds = [int(r["second"]) for r in rows]
    warm = [int(r["second"]) for r in rows if r["warmup"] == "1"]
    warm_end = max(warm) + 1 if warm else 0

    fig, (top, bottom) = plt.subplots(
        2, 1, figsize=(7.0, 4.4), sharex=True, gridspec_kw={"height_ratios": [3, 2]}
    )

    for key, label, colour in (
        ("p50_ms", "median", BLUE),
        ("p95_ms", "95th percentile", ORANGE),
        ("p99_ms", "99th percentile", AQUA),
    ):
        top.plot(seconds, [float(r[key]) for r in rows], linewidth=2, color=colour, label=label)

    if warm_end:
        for ax in (top, bottom):
            ax.axvspan(0, warm_end, color=GRID, alpha=0.55, linewidth=0)
        top.text(
            warm_end / 2, top.get_ylim()[1] * 0.92, "warm up\n(not counted)",
            ha="center", va="top", fontsize=7, color=INK_MUTED,
            bbox=dict(facecolor=SURFACE, edgecolor="none", pad=1.5, alpha=0.85),
        )

    top.set_title(title, pad=22)
    tidy(top, ylabel="response time (ms)")
    top.set_ylim(bottom=0)
    # Above the plot rather than inside it: at these percentile spreads any
    # in-axes position sits on top of a line.
    top.legend(loc="lower left", bbox_to_anchor=(0, 1.0), ncol=3, borderaxespad=0)

    bottom.plot(seconds, [int(r["requests"]) for r in rows], linewidth=2, color=VIOLET)
    tidy(bottom, ylabel="requests served", xlabel="seconds into the run")
    # From zero, so the height of the line means what it looks like it means.
    bottom.set_ylim(bottom=0)

    errors = [int(r["errors"]) for r in rows]
    if any(errors):
        bottom.plot(seconds, errors, linewidth=2, color=RED, label="errors")
        bottom.legend(loc="upper right")

    save(fig, f"{name}_response_time.svg")


# ---------------------------------------------------------------------------
# Utilisation of all four systems
# ---------------------------------------------------------------------------


def figure_utilisation(name):
    window = read_json(f"{name}_window.json")
    if not window:
        print(f"  skipping utilisation: no {name}_window.json")
        return

    start, end = window["started_at"], window["finished_at"]

    fig, axes = plt.subplots(4, 2, figsize=(7.2, 6.6), sharex=True)
    fig.subplots_adjust(wspace=0.34, hspace=0.55)

    for row, (key, label, colour) in enumerate(SYSTEMS):
        path = RESULTS / f"{name}_{key}.csv"
        if not path.exists():
            continue

        with path.open() as handle:
            rows = [r for r in csv.DictReader(handle) if start <= float(r["epoch"]) <= end]

        if not rows:
            continue

        t = [float(r["epoch"]) - start for r in rows]
        cpu = [float(r["cpu_fraction"]) for r in rows]
        memory = [float(r["memory_fraction"]) for r in rows]

        left, right = axes[row]

        left.fill_between(t, cpu, color=colour, alpha=0.16, linewidth=0)
        left.plot(t, cpu, linewidth=2, color=colour)
        left.set_ylim(0, 1.08)
        left.yaxis.set_major_formatter(FuncFormatter(percent))
        tidy(left)
        left.set_ylabel(label, fontsize=8, color=INK, rotation=0, ha="right", va="center",
                        labelpad=8)

        # Above the axes, not inside them: a container pinned at 100% leaves no
        # room in the plot for a label about being pinned at 100%.
        mean = sum(cpu) / len(cpu)
        left.annotate(f"mean {mean * 100:.0f}%", xy=(1.0, 1.04), xycoords="axes fraction",
                      ha="right", va="bottom", fontsize=7.5, color=INK_SOFT)

        right.fill_between(t, memory, color=colour, alpha=0.16, linewidth=0)
        right.plot(t, memory, linewidth=2, color=colour)
        right.set_ylim(0, 1.08)
        right.yaxis.set_major_formatter(FuncFormatter(percent))
        tidy(right)

        peak = max(memory)
        right.annotate(f"peak {peak * 100:.0f}%", xy=(1.0, 1.04), xycoords="axes fraction",
                       ha="right", va="bottom", fontsize=7.5, color=INK_SOFT)

    axes[0][0].set_title("CPU (share of one core)", pad=18)
    axes[0][1].set_title("Memory (share of 512 MB)", pad=18)
    axes[3][0].set_xlabel("seconds into the run")
    axes[3][1].set_xlabel("seconds into the run")

    fig.align_ylabels(axes[:, 0])
    save(fig, f"{name}_utilisation.svg")


# ---------------------------------------------------------------------------
# Threshold sweep
# ---------------------------------------------------------------------------


def figure_sweep():
    path = RESULTS / "sweep.csv"
    if not path.exists():
        print("  skipping sweep: no sweep.csv")
        return

    with path.open() as handle:
        rows = list(csv.DictReader(handle))

    labels = [r["label"].replace("threshold ", "T = ") for r in rows]
    throughput = [float(r["throughput_rps"]) for r in rows]
    p95 = [float(r["p95_ms"]) for r in rows]

    # Baselines are drawn in a muted ink so the eye goes to the thresholds,
    # which are the thing being chosen between.
    colours = [INK_MUTED if r["policy"] != "performance" else BLUE for r in rows]
    best = max(range(len(rows)), key=lambda i: throughput[i] if colours[i] == BLUE else -1)
    colours[best] = ORANGE

    fig, (top, bottom) = plt.subplots(2, 1, figsize=(7.0, 5.0), sharex=True)

    positions = range(len(rows))

    top.bar(positions, throughput, color=colours, width=0.62)
    for i, value in enumerate(throughput):
        top.annotate(f"{value:.0f}", xy=(i, value), xytext=(0, 3), textcoords="offset points",
                     ha="center", fontsize=7.5, color=INK_SOFT)
    top.set_title("Throughput and tail latency by routing policy")
    tidy(top, ylabel="requests per second")

    bottom.bar(positions, p95, color=colours, width=0.62)
    for i, value in enumerate(p95):
        bottom.annotate(f"{value:.0f}", xy=(i, value), xytext=(0, 3), textcoords="offset points",
                        ha="center", fontsize=7.5, color=INK_SOFT)
    tidy(bottom, ylabel="95th percentile (ms)")

    bottom.set_xticks(list(positions))
    bottom.set_xticklabels(labels, rotation=30, ha="right", fontsize=7.5)

    save(fig, "sweep.svg")


def figure_sweep_distribution():
    path = RESULTS / "sweep.csv"
    if not path.exists():
        return

    with path.open() as handle:
        rows = [r for r in csv.DictReader(handle)]

    labels = [r["label"].replace("threshold ", "T = ") for r in rows]
    chat1 = [int(r["chat_1"]) for r in rows]
    chat2 = [int(r["chat_2"]) for r in rows]
    chat3 = [int(r["chat_3"]) for r in rows]

    totals = [max(1, a + b + c) for a, b, c in zip(chat1, chat2, chat3)]
    share = lambda values: [v / t for v, t in zip(values, totals)]  # noqa: E731

    fig, ax = plt.subplots(figsize=(7.0, 2.9))
    positions = range(len(rows))

    s1, s2, s3 = share(chat1), share(chat2), share(chat3)
    bottom2 = s1
    bottom3 = [a + b for a, b in zip(s1, s2)]

    # 2px surface gap between stacked segments, so the boundaries read as
    # boundaries rather than as colour changes.
    ax.bar(positions, s1, color=ORANGE, width=0.62, label="chat-1 (Sys2)",
           edgecolor=SURFACE, linewidth=1.6)
    ax.bar(positions, s2, bottom=bottom2, color=AQUA, width=0.62, label="chat-2 (Sys3)",
           edgecolor=SURFACE, linewidth=1.6)
    ax.bar(positions, s3, bottom=bottom3, color=VIOLET, width=0.62,
           label="chat-3 (Sys4, shares its core with MongoDB)",
           edgecolor=SURFACE, linewidth=1.6)

    ax.set_ylim(0, 1)
    ax.yaxis.set_major_formatter(FuncFormatter(percent))
    ax.set_title("Where the requests went")
    tidy(ax, ylabel="share of requests")
    ax.set_xticks(list(positions))
    ax.set_xticklabels(labels, rotation=30, ha="right", fontsize=7.5)
    ax.legend(loc="upper center", bbox_to_anchor=(0.5, -0.32), ncol=3)

    save(fig, "sweep_distribution.svg")


# ---------------------------------------------------------------------------
# What the balancer was thinking, second by second
# ---------------------------------------------------------------------------


def figure_routing(name):
    timeline = read_json(f"{name}_timeline.json")
    if not timeline or not timeline.get("samples"):
        print(f"  skipping routing: no {name}_timeline.json")
        return

    samples = timeline["samples"]
    threshold = timeline["threshold"]
    names = ["chat-1 (Sys2)", "chat-2 (Sys3)", "chat-3 (Sys4)"]
    colours = [ORANGE, AQUA, VIOLET]

    t = [s["t"] for s in samples]

    fig, (top, bottom) = plt.subplots(
        2, 1, figsize=(7.0, 4.6), sharex=True, gridspec_kw={"height_ratios": [3, 2]}
    )

    for index, (label, colour) in enumerate(zip(names, colours)):
        top.plot(t, [s["score"][index] for s in samples], linewidth=2, color=colour, label=label)

    top.axhline(threshold, color=INK_SOFT, linewidth=1.4, linestyle=(0, (5, 3)))
    top.annotate(
        f"threshold {threshold:.2f}", xy=(t[-1], threshold), xytext=(-2, 5),
        textcoords="offset points", ha="right", va="bottom",
        fontsize=7.5, color=INK_SOFT,
        bbox=dict(facecolor=SURFACE, edgecolor="none", pad=1.0),
    )

    top.set_ylim(0, 1.02)
    top.set_title("Load score per backend, and where the traffic went")
    tidy(top, ylabel="load score")
    top.legend(loc="upper left", ncol=3)

    # Requests routed between one probe and the next. Smoothed over five
    # probes: the raw per-probe rate is dominated by where each 300 ms sample
    # boundary happened to fall, which is sampling noise rather than routing.
    for index, colour in enumerate(colours):
        served = [s["served"][index] for s in samples]
        delta = [0] + [max(0, b - a) for a, b in zip(served, served[1:])]
        gaps = [1e-9] + [max(1e-9, b - a) for a, b in zip(t, t[1:])]
        bottom.plot(t, smooth([d / g for d, g in zip(delta, gaps)], 5),
                    linewidth=1.8, color=colour)

    tidy(bottom, ylabel="requests per second\n(5 probe rolling mean)",
         xlabel="seconds into the run")
    bottom.set_ylim(bottom=0)

    save(fig, f"{name}_routing.svg")


# ---------------------------------------------------------------------------


def main():
    headline = sys.argv[1] if len(sys.argv) > 1 else "headline"

    print("drawing figures")
    figure_response_time(headline, "Response time and throughput through the load balancer")
    figure_utilisation(headline)
    figure_routing(headline)
    figure_sweep()
    figure_sweep_distribution()

    for name, title in (
        ("failover", "Response time while a backend is killed and restarted"),
    ):
        if (RESULTS / f"{name}_series.csv").exists():
            figure_response_time(name, title)
            figure_routing(name)
            figure_utilisation(name)


if __name__ == "__main__":
    main()
