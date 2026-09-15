#!/usr/bin/env bash
# How Sys4's single core is divided between the chat back end and the database.
#
#   sources/ops/cpu-split.sh [seconds]
#
# The container's cgroup shows Sys4 pinned at 100% under load, which says the
# machine is the ceiling but not what is holding it there. This puts load on
# the balancer and reads the two processes' own CPU counters out of /proc while
# it runs, which is the only way to see the split.
#
# Writes results/sys4_split.txt, which the report quotes.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RESULTS="$ROOT/results"
LOADGEN="$ROOT/sources/loadgen/loadgen"
LB="${LB_URL:-http://10.1.75.53:4229}"

WINDOW="${1:-20}"

SSH=(ssh -o ControlMaster=auto -o ControlPath="$HOME/.ssh/cm-%r@%h:%p" -o ControlPersist=120)

mkdir -p "$RESULTS"

# Long enough to settle before measuring, and to still be running after.
"$LOADGEN" -url "$LB" -duration "$((WINDOW + 20))s" -users 150 \
  -min-interval 0 -max-interval 10ms -feed-ratio 0.2 -feed-limit 50 >/dev/null 2>&1 &
LOAD_PID=$!

sleep 10

{
  printf '### Sys4 CPU split under load, %s ###\n' "$(date -u '+%Y-%m-%d %H:%M UTC')"
  printf 'measured over %ds with 150 users against the balancer\n\n' "$WINDOW"

  # utime and stime are fields 14 and 15 of /proc/<pid>/stat, in clock ticks.
  "${SSH[@]}" stu68_sys4 "
    HZ=\$(getconf CLK_TCK)
    NODE=\$(ss -lntp 2>/dev/null | awk '/:4000 /{print \$NF}' | grep -o 'pid=[0-9]*' | cut -d= -f2 | head -1)
    MONGO=\$(ss -lntp 2>/dev/null | awk '/:27017 /{print \$NF}' | grep -o 'pid=[0-9]*' | cut -d= -f2 | head -1)

    read -r _ _ _ _ _ _ _ _ _ _ _ _ _ nu1 ns1 _ < /proc/\$NODE/stat
    read -r _ _ _ _ _ _ _ _ _ _ _ _ _ mu1 ms1 _ < /proc/\$MONGO/stat
    T0=\$(date +%s%N)

    sleep $WINDOW

    read -r _ _ _ _ _ _ _ _ _ _ _ _ _ nu2 ns2 _ < /proc/\$NODE/stat
    read -r _ _ _ _ _ _ _ _ _ _ _ _ _ mu2 ms2 _ < /proc/\$MONGO/stat
    T1=\$(date +%s%N)

    awk -v n=\$((nu2 + ns2 - nu1 - ns1)) -v m=\$((mu2 + ms2 - mu1 - ms1)) \\
        -v hz=\$HZ -v t0=\$T0 -v t1=\$T1 'BEGIN {
      s = (t1 - t0) / 1e9;
      printf \"  chat-3 (Node)   %.2f cores\n\", n / hz / s;
      printf \"  mongod          %.2f cores\n\", m / hz / s;
      printf \"  together        %.2f of the 1.00 core this container has\n\", (n + m) / hz / s;
    }'
  "
} | tee "$RESULTS/sys4_split.txt"

wait "$LOAD_PID" 2>/dev/null || true

echo "wrote results/sys4_split.txt"
