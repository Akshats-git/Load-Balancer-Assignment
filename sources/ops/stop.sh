#!/usr/bin/env bash
# Stops a supervised service, and means it.
#
#   stop.sh <name> [listening port]
#
# The sentinel file goes down first. Without it the supervisor would see the
# process exit and helpfully start it again.
#
# The process itself is found by the port it is listening on, not by a name
# pattern. A pattern like "server.js" also matches the ssh command line that
# carries it, so a pkill would take out the session running the command as
# well, which is a confusing way to lose a shell.

set -u

NAME="${1:?usage: stop.sh <name> [port]}"
PORT="${2:-}"

touch "$HOME/.$NAME.stop"

if [ -n "$PORT" ]; then
  PID=$(ss -tulnp 2>/dev/null | awk -v p=":$PORT " '$0 ~ p {print $NF}' \
        | grep -o 'pid=[0-9]*' | cut -d= -f2 | head -1)

  if [ -n "${PID:-}" ]; then
    echo "$NAME: stopping pid $PID on port $PORT"
    kill "$PID" 2>/dev/null

    for _ in $(seq 1 30); do
      sleep 1
      kill -0 "$PID" 2>/dev/null || break
    done

    if kill -0 "$PID" 2>/dev/null; then
      echo "$NAME: did not exit, sending SIGKILL"
      kill -9 "$PID" 2>/dev/null
    fi
  else
    echo "$NAME: nothing listening on port $PORT"
  fi
fi

# Wait for the supervisor itself to let go, not just for the process it was
# running. Until it does, a start issued straight after this would find the
# lock held, decline to supervise, and leave the old supervisor to restart the
# service with the environment it was originally given. Which is a confusing
# way for a changed setting to appear not to take effect.
for _ in $(seq 1 30); do
  if flock -n "$HOME/.$NAME.supervisor.lock" true 2>/dev/null; then
    echo "$NAME: stopped"
    exit 0
  fi
  sleep 1
done

echo "$NAME: process stopped, but a supervisor still holds the lock" >&2
exit 1
