#!/usr/bin/env bash
# Finds the switching threshold that actually performs best, by measuring it.
#
#   sources/ops/threshold-sweep.sh [repeats] [seconds per run]
#
# Every configuration gets the same workload from the same load generator, and
# each is run more than once because the lab machines are shared and a single
# run of anything on them is not a measurement. The summary reports the median
# of the repeats.
#
# Two baselines are included alongside the thresholds:
#
#   roundrobin   a fixed rotation that ignores load entirely. This is the
#                policy the assignment rules out, and it is here so that ruling
#                it out is a result rather than an assertion.
#   least-load   always the lowest scoring backend, no threshold. This is the
#                obvious alternative, and it shows what the threshold buys.
#
# Results land in results/sweep_<config>_r<n>.json and results/sweep.csv.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RESULTS="$ROOT/results"
LOADGEN="$ROOT/sources/loadgen/loadgen"
LB="${LB_URL:-http://10.1.75.53:4229}"
LB_HOST=stu68_sys1

REPEATS="${1:-3}"
DURATION="${2:-30}"

# users, think time and message sizes are held constant across the sweep. Only
# the routing policy changes.
LOAD_ARGS=(-users 150 -min-interval 0 -max-interval 10ms
           -min-len 20 -max-len 400 -feed-ratio 0.2 -feed-limit 50 -warmup 4s)

SSH_OPTS=(-o ControlMaster=auto -o ControlPath="$HOME/.ssh/cm-%r@%h:%p" -o ControlPersist=120)
SSH=(ssh "${SSH_OPTS[@]}")

BACKEND_URLS="http://172.17.0.31:4000,http://172.17.0.32:4000,http://172.17.0.33:4000"

# name:policy:threshold
CONFIGS=(
  "roundrobin:roundrobin:0.70"
  "leastload:least-load:0.70"
  "t030:performance:0.30"
  "t040:performance:0.40"
  "t050:performance:0.50"
  "t060:performance:0.60"
  "t070:performance:0.70"
  "t080:performance:0.80"
  "t090:performance:0.90"
)

mkdir -p "$RESULTS"

BACKEND_HOSTS=("stu68_sys2:chat-1" "stu68_sys3:chat-2" "stu68_sys4:chat-3")

# Every run starts from the same database and the same empty feed.
#
# Without this the sweep would be measuring its own history. Each run leaves
# tens of thousands of messages behind, so a run that follows another starts
# with a larger collection to index and a fuller feed to hold, and the
# configurations tested last would look worse for reasons that have nothing to
# do with how they route. Resetting per run rather than per configuration costs
# about twenty seconds each and makes the repeats comparable to each other as
# well as to the other configurations.
#
# SWEEP_RESET=0 holds the room still a different way, for when emptying the
# database is not available: every run is given the same seed, so every run
# sends the same message ids, so every run after the first stores nothing. The
# room then does not grow at all and each configuration does identical work.
#
# What that gives up is the insert itself: a repeated id is refused by the
# unique index rather than written, so the sweep exercises the routing, the
# parsing, the encryption, the bulk write and the round trip to MongoDB, but
# not the part of the write that appends. It is a fair comparison between
# configurations - every one of them is measured on the same thing - and it is
# not a measure of absolute throughput. The runs that report throughput
# elsewhere do not use this mode.
reset_state() {
  if [ "${SWEEP_RESET:-1}" = "0" ]; then
    curl -sf -m 5 "$LB/lb/reset" >/dev/null || true
    return 0
  fi

  for entry in "${BACKEND_HOSTS[@]}"; do
    "${SSH[@]}" "${entry%%:*}" "~/ops/stop.sh chat 4000 >/dev/null 2>&1" || true
  done

  "${SSH[@]}" stu68_sys4 '~/node/bin/node ~/chat/server/scripts/cleanup.js purge-loadtest' | sed 's/^/  /'

  for entry in "${BACKEND_HOSTS[@]}"; do
    "${SSH[@]}" -n "${entry%%:*}" \
      "INSTANCE_NAME=${entry##*:} setsid ~/ops/supervise.sh chat ~/ops/run-chat.sh >/dev/null 2>&1 </dev/null & exit 0"
  done

  for _ in $(seq 1 60); do
    up=0
    for port in 4230 4231 4232; do
      curl -sf -m 2 "http://10.1.75.53:$port/health" >/dev/null 2>&1 && up=$((up + 1))
    done
    [ "$up" = 3 ] && return 0
    sleep 1
  done

  echo "backends did not come back" >&2
  return 1
}

reconfigure() {
  local policy="$1" threshold="$2"

  "${SSH[@]}" "$LB_HOST" "cat > ~/lb/lb.env <<EOF
BACKENDS=\"$BACKEND_URLS\"
LISTEN=\":4000\"
TLS_LISTEN=\":3000\"
THRESHOLD=\"$threshold\"
HYSTERESIS=\"0.08\"
PROBE_INTERVAL=\"300ms\"
POLICY=\"$policy\"
EOF"

  "${SSH[@]}" "$LB_HOST" "~/ops/stop.sh lb 4000 >/dev/null 2>&1" || true
  "${SSH[@]}" -n "$LB_HOST" "setsid ~/ops/supervise.sh lb ~/ops/run-lb.sh >/dev/null 2>&1 </dev/null & exit 0"

  for _ in $(seq 1 30); do
    if curl -sf -m 2 "$LB/lb/health" >/dev/null 2>&1; then
      # Let one probe sweep land so the first requests are not routed on an
      # empty set of scores.
      sleep 2
      return 0
    fi
    sleep 1
  done

  echo "load balancer did not come back for $policy/$threshold" >&2
  return 1
}

echo "sweep: ${#CONFIGS[@]} configurations, $REPEATS repeats of ${DURATION}s each"

for entry in "${CONFIGS[@]}"; do
  IFS=: read -r name policy threshold <<< "$entry"

  echo "--- $name ($policy, threshold $threshold) ---"
  reconfigure "$policy" "$threshold"

  for run in $(seq 1 "$REPEATS"); do
    reset_state
    curl -sf -m 5 "$LB/lb/reset" >/dev/null || true

    # One seed per repeat rather than per run, so that repeat 1 of every
    # configuration sends exactly the same messages as repeat 1 of every other.
    "$LOADGEN" -url "$LB" -duration "${DURATION}s" -experiment "$name-r$run" \
      -seed "$run" "${LOAD_ARGS[@]}" \
      -out "$RESULTS/sweep_${name}_r${run}.json" >/dev/null

    curl -sf -m 10 "$LB/lb/status" -o "$RESULTS/sweep_${name}_r${run}_status.json" || true

    python3 - "$RESULTS/sweep_${name}_r${run}.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
l = d["latency_ms"]
print(f"  run {d['experiment'][-1]}: {d['throughput_rps']:>7.0f} rps  "
      f"p50={l['p50']:>6.1f}  p95={l['p95']:>7.1f}  p99={l['p99']:>8.1f}  "
      f"errors={d['transport_errors']}/{d['non_200_responses']}")
PY
  done
done

# Back to the deployed configuration.
reconfigure performance "${LB_THRESHOLD:-0.30}"

python3 "$ROOT/report/summarise_sweep.py"
