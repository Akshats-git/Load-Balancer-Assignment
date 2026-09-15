#!/usr/bin/env bash
# Keeps one service running on a lab container.
#
# These containers have no init system and no passwordless sudo, so there is
# nothing to register a service with. The previous deployment ran everything
# under nohup, and the result was a database that had been OOM-killed weeks
# earlier with nothing to notice or restart it. This is the smallest thing that
# fixes that: a loop that restarts the process when it exits.
#
#   supervise.sh <name> <command...>
#
# Start it detached so it outlives the ssh session that launched it:
#
#   setsid ~/ops/supervise.sh chat ~/ops/run-chat.sh >/dev/null 2>&1 </dev/null &
#
# Safe to run twice: the lock means the second copy exits instead of fighting
# the first one for the port.
#
# To stop a service for good, use stop.sh, which leaves the sentinel file this
# loop checks. Killing the process alone only gets it restarted.

set -u

NAME="${1:?usage: supervise.sh <name> <command...>}"
shift

LOG_DIR="$HOME/logs"
LOG="$LOG_DIR/$NAME.log"
LOCK="$HOME/.$NAME.supervisor.lock"
STOP="$HOME/.$NAME.stop"

MAX_LOG_BYTES=$((32 * 1024 * 1024))
RESTART_DELAY=2

mkdir -p "$LOG_DIR"

# A start request cancels any previous stop request, and it has to happen
# before the lock is tested rather than after.
#
# The order matters more than it looks. stop.sh leaves a sentinel file and
# kills the process; the supervisor sees the sentinel on its next pass and
# exits. If a start arrives in that window and gives up on the lock first, the
# sentinel is still there when the old supervisor looks, and it shuts down a
# service that was just asked to start. Clearing the sentinel first means
# whichever supervisor holds the lock keeps the service running, which is what
# "start" was asking for.
rm -f "$STOP"

# One supervisor per service.
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "$NAME: a supervisor is already running" >&2
  exit 0
fi

echo "$(date -Is) supervisor starting: $*" >> "$LOG"

while true; do
  if [ -f "$STOP" ]; then
    echo "$(date -Is) stop requested, supervisor exiting" >> "$LOG"
    exit 0
  fi

  # Keep the log from filling the disk over a long run.
  if [ -f "$LOG" ] && [ "$(stat -c %s "$LOG")" -gt "$MAX_LOG_BYTES" ]; then
    mv -f "$LOG" "$LOG.1"
  fi

  "$@" >> "$LOG" 2>&1
  code=$?

  if [ -f "$STOP" ]; then
    echo "$(date -Is) $NAME exited ($code) after a stop request" >> "$LOG"
    exit 0
  fi

  echo "$(date -Is) $NAME exited with $code, restarting in ${RESTART_DELAY}s" >> "$LOG"
  sleep "$RESTART_DELAY"
done
