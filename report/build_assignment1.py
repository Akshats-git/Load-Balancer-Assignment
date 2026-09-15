#!/usr/bin/env python3
"""Rebuilds the previous assignment's report, kept so it stays reproducible.

Source listings, transcripts and measured numbers are all read from the files
the run produced, so the report cannot drift away from the experiment.

    python3 report/build_assignment1.py
"""

import html
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPORT = ROOT / "report"
RESULTS = ROOT / "results" / "assignment1"
SOURCES = ROOT / "sources" / "assignment1"

OUT_HTML = REPORT / "report_assignment1.html"
OUT_PDF = ROOT / "Akshat_Gupta_12340160_LoadBalancer_Report.pdf"


def esc(text):
    return html.escape(text.rstrip("\n"))


def read(path):
    return esc(Path(path).read_text())


def result_json(name):
    """A measured result, printed the way it appeared on the terminal."""
    return json.dumps(json.loads((RESULTS / name).read_text()), indent=2)


def transcript(command, body):
    """One terminal block: the command that was run, then what it printed."""
    return f'<span class="c">$</span> <span class="p">{esc(command)}</span>\n{esc(body)}'


# --- the architecture diagram ------------------------------------------------
# Written as SVG rather than a rendered image so it stays sharp in the PDF.

DIAGRAM = """
<svg viewBox="0 0 760 220" xmlns="http://www.w3.org/2000/svg" role="img"
     aria-label="The load generator on the local PC sends load to the load balancer on
                 Sys1, which round robins across three chat back ends on Sys2, Sys3 and
                 Sys4. All three share one MongoDB on Sys1.">
  <defs>
    <marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#8a929b"/>
    </marker>
    <style>
      .box   { fill:#ffffff; stroke:#c3cad2; stroke-width:1.2; rx:5; }
      .lbbox { fill:#eef4f8; stroke:#14496b; stroke-width:1.6; rx:5; }
      .dbbox { fill:#fbf7ef; stroke:#a98a4e; stroke-width:1.2; rx:5; }
      .t     { font-family:'Source Sans 3',Helvetica,sans-serif; font-size:11.5px; fill:#16191d; font-weight:600; }
      .s     { font-family:'JetBrains Mono',monospace;           font-size:9px;    fill:#767d87; }
      .lbl   { font-family:'Source Sans 3',Helvetica,sans-serif; font-size:9px;    fill:#767d87; }
      .ln    { stroke:#8a929b; stroke-width:1.2; fill:none; marker-end:url(#ar); }
      .lnd   { stroke:#a98a4e; stroke-width:1;   fill:none; stroke-dasharray:3 3; }
    </style>
  </defs>

  <rect class="box" x="8" y="78" width="128" height="46"/>
  <text class="t" x="22" y="98">Local PC</text>
  <text class="s" x="22" y="113">load generators</text>

  <line class="ln" x1="140" y1="101" x2="212" y2="101"/>
  <text class="lbl" x="146" y="94">HTTPS :3229</text>

  <rect class="lbbox" x="216" y="70" width="150" height="62"/>
  <text class="t" x="232" y="92">Sys1, Load Balancer</text>
  <text class="s" x="232" y="107">172.17.0.30:3000</text>
  <text class="s" x="232" y="120">round robin + health</text>

  <line class="ln" x1="370" y1="88"  x2="556" y2="42"/>
  <line class="ln" x1="370" y1="101" x2="556" y2="101"/>
  <line class="ln" x1="370" y1="114" x2="556" y2="160"/>

  <rect class="box" x="560" y="20" width="192" height="44"/>
  <text class="t" x="574" y="39">Sys2, chat-1</text>
  <text class="s" x="574" y="53">172.17.0.31:4000</text>

  <rect class="box" x="560" y="79" width="192" height="44"/>
  <text class="t" x="574" y="98">Sys3, chat-2</text>
  <text class="s" x="574" y="112">172.17.0.32:4000</text>

  <rect class="box" x="560" y="138" width="192" height="44"/>
  <text class="t" x="574" y="157">Sys4, chat-3</text>
  <text class="s" x="574" y="171">172.17.0.33:4000</text>

  <rect class="dbbox" x="216" y="163" width="150" height="44"/>
  <text class="t" x="232" y="182">MongoDB (rs0)</text>
  <text class="s" x="232" y="196">172.17.0.30:27017</text>

  <path class="lnd" d="M560 42  C 470 42, 420 150, 368 178"/>
  <path class="lnd" d="M560 101 C 470 101, 430 165, 368 182"/>
  <path class="lnd" d="M560 160 C 480 160, 430 180, 368 186"/>
  <text class="lbl" x="392" y="209">shared history, keys and the Socket.IO broadcast channel</text>
</svg>
"""

FIELDS = {
    "DIAGRAM": DIAGRAM,
    "INVENTORY": read(RESULTS / "inventory.txt"),
    "LB_SOURCE": read(SOURCES / "lb_main.go"),
    "SERVER_PATCH": read(SOURCES / "chat_server.patch"),
    "DEPLOY_TRANSCRIPT": read(RESULTS / "deploy.txt"),
    "FAILOVER": read(RESULTS / "failover.txt"),
    "CROSS_REPLICA": read(RESULTS / "cross-replica.txt"),
    "EXP1_CHAT": transcript(
        "node chatload_main.js -url https://10.1.75.53:3229 -requests 600 "
        "-concurrency 30 -experiment chat-1-backend",
        result_json("exp1_chat.json"),
    ),
    "EXP1_HTTP": transcript(
        "./client -url https://10.1.75.53:3229/health -requests 5000 -concurrency 40 "
        "-timeout 10s -insecure -experiment http-1-backend",
        result_json("exp1_http.json"),
    ),
    "EXP2_CHAT": transcript(
        "node chatload_main.js -url https://10.1.75.53:3229 -requests 600 "
        "-concurrency 30 -experiment chat-3-backends",
        result_json("exp2_chat.json"),
    ),
    "EXP2_HTTP": transcript(
        "./client -url https://10.1.75.53:3229/health -requests 5000 -concurrency 40 "
        "-timeout 10s -insecure -experiment http-3-backends",
        result_json("exp2_http.json"),
    ),
    "DISTRIBUTION": (
        transcript("curl -sk https://10.1.75.53:3229/lb/metrics   # after the chat run",
                   result_json("exp2_chat_lb.json"))
        + "\n\n"
        + transcript("curl -sk https://10.1.75.53:3229/lb/metrics   # after the HTTP run",
                     result_json("exp2_http_lb.json"))
    ),
}


def main():
    page = (REPORT / "template_assignment1.html").read_text()

    for key, value in FIELDS.items():
        token = "{{" + key + "}}"
        if token not in page:
            sys.exit(f"template has no slot for {key}")
        page = page.replace(token, value)

    leftover = [line for line in page.splitlines() if "{{" in line]
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
