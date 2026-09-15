#!/usr/bin/env bash
# Samples one container's CPU and memory once a second into a CSV.
#
#   sample-system.sh <seconds> <output file>
#
# It runs on the container rather than over ssh, because a sample taken over
# ssh measures the ssh as well, and at one sample a second across four machines
# that is not a small share of a single core.
#
# The numbers come from the cgroup, not from /proc. Inside these containers
# /proc shows the host: 120 cores and 128 GB, none of which this container may
# use. cpu.stat and memory.current describe the container itself, and a CPU
# figure of 1.0 means one full core, which is this container's entire limit.

set -u

SECONDS_TO_RUN="${1:?usage: sample-system.sh <seconds> <output file>}"
OUTPUT="${2:?usage: sample-system.sh <seconds> <output file>}"

CGROUP=/sys/fs/cgroup

usage_usec() { awk '/^usage_usec /{print $2}' "$CGROUP/cpu.stat"; }

# quota/period, so "100000 100000" is one core.
read -r quota period < "$CGROUP/cpu.max"
if [ "$quota" = "max" ]; then
  cores=$(nproc)
else
  cores=$(awk -v q="$quota" -v p="$period" 'BEGIN{print q/p}')
fi

limit=$(cat "$CGROUP/memory.max" 2>/dev/null || echo 0)

# The epoch column is what lets the report line these rows up with the load
# generator's own clock. Without it a plot can only assume the two started
# together, and they do not: starting a sampler on four containers takes a few
# seconds of ssh before the load begins.
echo "epoch,second,cpu_fraction,cpu_cores_used,memory_bytes,memory_fraction" > "$OUTPUT"

previous=$(usage_usec)
previous_ns=$(date +%s%N)

for i in $(seq 1 "$SECONDS_TO_RUN"); do
  sleep 1

  current=$(usage_usec)
  current_ns=$(date +%s%N)
  memory=$(cat "$CGROUP/memory.current" 2>/dev/null || echo 0)

  awk -v i="$i" -v a="$previous" -v b="$current" -v t0="$previous_ns" -v t1="$current_ns" \
      -v cores="$cores" -v mem="$memory" -v lim="$limit" 'BEGIN {
    epoch = t1 / 1000000000;
    elapsed_us = (t1 - t0) / 1000;
    used_us = b - a;
    cores_used = (elapsed_us > 0) ? used_us / elapsed_us : 0;
    fraction = (cores > 0) ? cores_used / cores : 0;
    memfrac = (lim > 0) ? mem / lim : 0;
    printf "%.3f,%d,%.4f,%.4f,%d,%.4f\n", epoch, i, fraction, cores_used, mem, memfrac;
  }' >> "$OUTPUT"

  previous=$current
  previous_ns=$current_ns
done
