#!/usr/bin/env bash
# Captures the transcripts the report quotes, so it quotes a real terminal.
#
#   sources/ops/evidence.sh
#
# Everything it writes goes to results/, and report/build.py reads it from
# there. Run it against the live deployment; it sends a handful of requests and
# reads back what happened to them.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RESULTS="$ROOT/results"
LB="${LB_URL:-http://10.1.75.53:4229}"

SSH_OPTS=(-o ControlMaster=auto -o ControlPath="$HOME/.ssh/cm-%r@%h:%p" -o ControlPersist=120)
SSH=(ssh "${SSH_OPTS[@]}")

mkdir -p "$RESULTS"

# A prompt line, then what the command printed. The report styles the two
# differently, which is why they are marked here rather than there.
run() {
  printf '$ %s\n' "$1"
  eval "$1" 2>&1
  printf '\n'
}

# ---------------------------------------------------------------------------
# The two routes
# ---------------------------------------------------------------------------

{
  run "curl -s -X POST $LB/message -H 'Content-Type: application/json' \\
     -d '{\"client-name\":\"aarav\",\"msg\":\"posted as json\"}'"

  run "curl -s -X POST $LB/message -d 'client-name=meera&msg=posted as a form'"

  run "curl -s --get '$LB/message' \\
     --data-urlencode 'client-name=rohan' --data-urlencode 'msg=posted as a query string'"

  run "curl -s '$LB/feed?limit=3' | python3 -m json.tool"
} > "$RESULTS/routes_demo.txt"

echo "wrote results/routes_demo.txt"

# ---------------------------------------------------------------------------
# The same id, twice
# ---------------------------------------------------------------------------

MARK="report-demo-$(date +%s)"

{
  run "curl -s -X POST $LB/message -H 'Content-Type: application/json' \\
     -d '{\"client-name\":\"aarav\",\"msg\":\"sent once\",\"id\":\"$MARK\"}'"

  printf '%s\n' "# the same request again, as a retrying client would send it"
  run "curl -s -X POST $LB/message -H 'Content-Type: application/json' \\
     -d '{\"client-name\":\"aarav\",\"msg\":\"sent once\",\"id\":\"$MARK\"}'"

  run "curl -s $LB/feed | python3 -c \\
     'import json,sys; print(sum(1 for m in json.load(sys.stdin) if m[\"id\"] == \"$MARK\"), \"copies in the feed\")'"
} > "$RESULTS/duplicate_demo.txt"

echo "wrote results/duplicate_demo.txt"

# ---------------------------------------------------------------------------
# What is actually running
# ---------------------------------------------------------------------------

{
  printf '### deployment inventory, %s ###\n' "$(date -u '+%Y-%m-%d %H:%M UTC')"
  printf 'all four containers: 512 MB RAM, 1 vCPU (cgroup enforced), Ubuntu 24.04\n\n'

  for host in stu68_sys1 stu68_sys2 stu68_sys3 stu68_sys4; do
    address=$("${SSH[@]}" "$host" 'hostname -I' | tr -d ' \n')
    printf -- '--- %-12s %s ---\n' "$host" "$address"

    "${SSH[@]}" "$host" '
      printf "  listening : "
      ss -lnt 2>/dev/null | awk "/LISTEN/{print \$4}" | sed "s/.*://" | sort -n | uniq | tr "\n" " "
      printf "\n"
      ps -eo rss,args --sort=-rss | awk "NR>1 && \$1 > 15000 {
        rss = \$1 / 1024; \$1 = \"\";
        cmd = \$0; sub(/^ +/, \"\", cmd);
        if (length(cmd) > 74) cmd = substr(cmd, 1, 74) \"...\";
        printf \"  %6.0f MB  %s\n\", rss, cmd
      }"
      awk -v used="$(cat /sys/fs/cgroup/memory.current)" -v limit="$(cat /sys/fs/cgroup/memory.max)" \
        "BEGIN { printf \"  memory    : %d MB of %d MB\\n\", used/1048576, limit/1048576 }"
    '
    printf '\n'
  done

  printf -- '--- database ---\n'
  "${SSH[@]}" stu68_sys4 '~/node/bin/node ~/chat/server/scripts/rsadmin.js status'
  "${SSH[@]}" stu68_sys4 '~/node/bin/node ~/chat/server/scripts/cleanup.js indexes'
} > "$RESULTS/inventory.txt"

echo "wrote results/inventory.txt"

# ---------------------------------------------------------------------------
# The load generator's own usage text
# ---------------------------------------------------------------------------

"$ROOT/sources/loadgen/loadgen" -h > "$RESULTS/loadgen_usage.txt" 2>&1
echo "wrote results/loadgen_usage.txt"
