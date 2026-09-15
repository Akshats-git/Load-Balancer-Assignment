#!/usr/bin/env bash
# Runs one measured experiment and collects everything it produced.
#
#   sources/ops/experiment.sh <name> <seconds> [extra loadgen flags...]
#
# Each run leaves these behind under results/:
#
#   <name>.json          the load generator's summary
#   <name>_series.csv    response time and throughput, one row per second
#   <name>_lb.json       what the balancer counted
#   <name>_status.json   per backend scores and health at the end
#   <name>_timeline.json score and CPU per backend for every probe of the run
#   <name>_sysN.csv      CPU and memory for each of the four systems
#
# The utilisation samplers run on the containers rather than over ssh, so they
# are started first, in the background, and collected afterwards.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RESULTS="$ROOT/results"
LOADGEN="$ROOT/sources/loadgen/loadgen"
LB="${LB_URL:-http://10.1.75.53:4229}"

NAME="${1:?usage: experiment.sh <name> <seconds> [loadgen flags]}"
DURATION="${2:?usage: experiment.sh <name> <seconds> [loadgen flags]}"
shift 2

HOSTS=(stu68_sys1 stu68_sys2 stu68_sys3 stu68_sys4)

# Repeated ssh to the same container costs a full connection setup each time,
# and this script makes a dozen of them. Multiplexing puts them all down one
# connection, which took the time to start four samplers from 22 seconds to
# about one. That matters here: the samplers are supposed to start together and
# before the load, not spread over the first half of the run.
SSH_OPTS=(-o ControlMaster=auto -o ControlPath="$HOME/.ssh/cm-%r@%h:%p" -o ControlPersist=120)
SSH=(ssh "${SSH_OPTS[@]}")
SCP=(scp -q "${SSH_OPTS[@]}")

mkdir -p "$RESULTS"

if [ ! -x "$LOADGEN" ]; then
  echo "building the load generator"
  ( cd "$ROOT/sources/loadgen" && go build -o loadgen . )
fi

phase() { printf '[%s] %s\n' "$(date +%H:%M:%S.%3N)" "$*"; }

phase "=== $NAME: ${DURATION}s against $LB ==="

# Sample well past the end of the run. The traces are cut to the run window
# afterwards using the epoch column, so sampling too long costs nothing and
# sampling too briefly loses the tail.
SAMPLE_FOR=$((DURATION + 20))

# All four at once. Started one after another, the ssh round trips alone put
# ten seconds between the first sampler and the last, which is enough to make
# the four traces describe different parts of the run.
# One round trip per host. The sampler itself is put there by deploy.sh, so
# there is nothing to copy at experiment time.
for host in "${HOSTS[@]}"; do
  "${SSH[@]}" -n "$host" "setsid ~/ops/sample-system.sh $SAMPLE_FOR /home/student/sample.csv >/dev/null 2>&1 </dev/null & exit 0" &
done
wait
phase "samplers started"

curl -sf -m 5 "$LB/lb/reset" >/dev/null || echo "warning: could not reset balancer counters"

phase "counters reset"
STARTED_AT=$(date +%s.%N)

"$LOADGEN" \
  -url "$LB" \
  -duration "${DURATION}s" \
  -experiment "$NAME" \
  -out "$RESULTS/$NAME.json" \
  -timeseries "$RESULTS/${NAME}_series.csv" \
  "$@"

FINISHED_AT=$(date +%s.%N)
phase "load finished"

# The window the load actually ran in, so the utilisation traces can be cut to
# match it rather than eyeballed.
cat > "$RESULTS/${NAME}_window.json" <<EOF
{
  "experiment": "$NAME",
  "started_at": $STARTED_AT,
  "finished_at": $FINISHED_AT,
  "duration_s": $DURATION
}
EOF

curl -sf -m 10 "$LB/lb/metrics"  -o "$RESULTS/${NAME}_lb.json"       || true
curl -sf -m 10 "$LB/lb/status"   -o "$RESULTS/${NAME}_status.json"   || true
curl -sf -m 20 "$LB/lb/timeline" -o "$RESULTS/${NAME}_timeline.json" || true

phase "waiting for the utilisation samplers to finish"
sleep $((SAMPLE_FOR - DURATION + 2))

index=1
for host in "${HOSTS[@]}"; do
  "${SCP[@]}" "$host:/home/student/sample.csv" "$RESULTS/${NAME}_sys${index}.csv" || echo "no sample from $host"
  index=$((index + 1))
done

echo "collected:"
ls -1 "$RESULTS/$NAME"* | sed 's|^|  |'
