#!/usr/bin/env bash
# Kills a backend in the middle of a load run and watches what the balancer does.
#
#   sources/ops/failover.sh [seconds] [host] [name]
#
# The requirement being tested is that the balancer notices a backend that has
# stopped answering and stops sending requests to it. So the run is deliberately
# ordinary: steady load through the balancer, one backend killed a third of the
# way in, brought back two thirds of the way in, and no client told about any of
# it.
#
# What to look for afterwards, in results/failover_*:
#
#   the timeline shows the killed backend's request rate going to zero, and the
#   other two picking up what it was carrying
#   the load generator's error count, which is what the clients actually saw
#   the balancer's retry counter, for requests that were in flight at the moment
#   the backend went away and were replayed onto another one

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RESULTS="$ROOT/results"
LOADGEN="$ROOT/sources/loadgen/loadgen"
LB="${LB_URL:-http://10.1.75.53:4229}"

DURATION="${1:-60}"
VICTIM_HOST="${2:-stu68_sys3}"
VICTIM_NAME="${3:-chat-2}"
NAME=failover

HOSTS=(stu68_sys1 stu68_sys2 stu68_sys3 stu68_sys4)

SSH_OPTS=(-o ControlMaster=auto -o ControlPath="$HOME/.ssh/cm-%r@%h:%p" -o ControlPersist=180)
SSH=(ssh "${SSH_OPTS[@]}")
SCP=(scp -q "${SSH_OPTS[@]}")

KILL_AT=$((DURATION / 3))
RESTORE_AT=$(((DURATION * 2) / 3))
SAMPLE_FOR=$((DURATION + 20))

mkdir -p "$RESULTS"

phase() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }

phase "failover run: ${DURATION}s, killing $VICTIM_NAME on $VICTIM_HOST at +${KILL_AT}s, back at +${RESTORE_AT}s"

for host in "${HOSTS[@]}"; do
  "${SSH[@]}" -n "$host" "setsid ~/ops/sample-system.sh $SAMPLE_FOR /home/student/sample.csv >/dev/null 2>&1 </dev/null & exit 0" &
done
wait

curl -sf -m 5 "$LB/lb/reset" >/dev/null || true

# Where the balancer's log has got to, so that afterwards this run's lines can
# be taken without the previous run's lines coming with them.
LOG_MARK=$("${SSH[@]}" stu68_sys1 'wc -l < ~/logs/lb.log' | tr -d ' ')

STARTED_AT=$(date +%s.%N)

"$LOADGEN" -url "$LB" -duration "${DURATION}s" -experiment "$NAME" \
  -users 120 -min-interval 0 -max-interval 15ms -feed-ratio 0.2 -feed-limit 50 \
  -warmup 4s -verify \
  -out "$RESULTS/$NAME.json" -timeseries "$RESULTS/${NAME}_series.csv" &
LOAD_PID=$!

sleep "$KILL_AT"
phase "killing $VICTIM_NAME"
KILLED_AT=$(date +%s.%N)
"${SSH[@]}" "$VICTIM_HOST" "~/ops/stop.sh chat 4000" | sed 's/^/  /'

sleep $((RESTORE_AT - KILL_AT))
phase "restarting $VICTIM_NAME"
RESTORED_AT=$(date +%s.%N)
"${SSH[@]}" -n "$VICTIM_HOST" \
  "INSTANCE_NAME=$VICTIM_NAME setsid ~/ops/supervise.sh chat ~/ops/run-chat.sh >/dev/null 2>&1 </dev/null & exit 0"

wait "$LOAD_PID"
FINISHED_AT=$(date +%s.%N)

cat > "$RESULTS/${NAME}_window.json" <<EOF
{
  "experiment": "$NAME",
  "started_at": $STARTED_AT,
  "finished_at": $FINISHED_AT,
  "killed_at": $KILLED_AT,
  "restored_at": $RESTORED_AT,
  "victim": "$VICTIM_NAME",
  "victim_host": "$VICTIM_HOST",
  "duration_s": $DURATION
}
EOF

curl -sf -m 10 "$LB/lb/metrics"  -o "$RESULTS/${NAME}_lb.json"       || true
curl -sf -m 10 "$LB/lb/status"   -o "$RESULTS/${NAME}_status.json"   || true
curl -sf -m 20 "$LB/lb/timeline" -o "$RESULTS/${NAME}_timeline.json" || true

phase "waiting for the samplers"
sleep $((SAMPLE_FOR - DURATION + 2))

index=1
for host in "${HOSTS[@]}"; do
  "${SCP[@]}" "$host:/home/student/sample.csv" "$RESULTS/${NAME}_sys${index}.csv" || true
  index=$((index + 1))
done

phase "what the balancer logged"
"${SSH[@]}" stu68_sys1 "tail -n +$((LOG_MARK + 1)) ~/logs/lb.log | grep -E 'marked DOWN|back UP|retrying' | head -12" \
  | tee "$RESULTS/${NAME}_lb_log.txt" | sed 's/^/  /'

phase "done"
