#!/usr/bin/env bash
# Starts whatever belongs on this container and is not currently running.
#
# These containers have no init: pid 1 is sshd, there is no cron and no
# systemd to register a service with, so when a container restarts it comes
# back with nothing running and nothing that intends to change that. That is
# not hypothetical. On 12 September Sys1 restarted in the middle of a grading
# run; the load balancer, its supervisor and an unrelated project's service
# all went with it, the submitted URL stopped answering, and the run scored
# zero. Nothing was wrong with the code.
#
# So this script is the thing that intends to change it. It is idempotent, it
# is what the watchdog on the other containers calls over ssh, and it is the
# forced command that watchdog's key is restricted to, so that key can do this
# and nothing else.
#
# A service that was deliberately stopped stays stopped: stop.sh leaves a
# sentinel, and an explicit stop is a decision, not a fault to repair.

set -u

ROLE_FILE="$HOME/ops/role.env"
[ -f "$ROLE_FILE" ] || { echo "no $ROLE_FILE, nothing known about this host" >&2; exit 1; }

# shellcheck source=/dev/null
. "$ROLE_FILE"

listening() { ss -lnt 2>/dev/null | grep -q ":$1 "; }

# Starts a supervisor for one service unless it is already up or was stopped
# on purpose. The supervisor takes a lock, so a second copy is harmless
# anyway; this only keeps the log quiet.
ensure() {
  local name="$1" port="$2" script="$3"

  if [ -f "$HOME/.$name.stop" ]; then
    echo "$name: stopped on purpose, leaving it alone"
    return 0
  fi

  if listening "$port"; then
    return 0
  fi

  echo "$name: not listening on $port, starting it"
  setsid "$HOME/ops/supervise.sh" "$name" "$script" >/dev/null 2>&1 </dev/null &
}

case "${ROLE:-}" in
  lb)
    ensure lb 4000 "$HOME/ops/run-lb.sh"
    ;;
  backend)
    [ "${WITH_DB:-0}" = "1" ] && ensure mongod 27017 "$HOME/ops/run-mongod.sh"

    # The backend is given its name through the environment, the same way the
    # deployment gives it, so a service restarted from here is the same
    # service and not an anonymous one.
    if [ ! -f "$HOME/.chat.stop" ] && ! listening 4000; then
      echo "chat: not listening on 4000, starting it as ${INSTANCE_NAME:-chat}"
      INSTANCE_NAME="${INSTANCE_NAME:-chat}" setsid "$HOME/ops/supervise.sh" chat "$HOME/ops/run-chat.sh" \
        >/dev/null 2>&1 </dev/null &
    fi
    ;;
  *)
    echo "unknown ROLE '${ROLE:-}' in $ROLE_FILE" >&2
    exit 1
    ;;
esac

# The watchdog is what repairs the other containers, so it is the one thing
# that must come back on every host, including one that has just been repaired
# by someone else. It holds a lock, so starting it twice does nothing.
if [ -x "$HOME/ops/watchdog.sh" ] && [ ! -f "$HOME/.watchdog.stop" ]; then
  setsid "$HOME/ops/supervise.sh" watchdog "$HOME/ops/watchdog.sh" >/dev/null 2>&1 </dev/null &
fi

exit 0
