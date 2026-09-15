#!/usr/bin/env bash
# Starts one chat-server replica in the background and waits for it to answer.
# INSTANCE_NAME is passed in so the load balancer experiments can tell the
# three replicas apart in the response headers.
set -u
NAME="${1:-chat}"

# Stop a previous replica by port, not by command line: a -f pattern that
# matches "server.js" also matches this script's own ssh command line and would
# kill the session that started it.
OLDPID=$(ss -tulnp 2>/dev/null | awk '/:4000 /{print $NF}' | grep -o 'pid=[0-9]*' | cut -d= -f2 | head -1)
[ -n "${OLDPID:-}" ] && kill "$OLDPID" 2>/dev/null && sleep 2

mkdir -p "$HOME/logs"
cd "$HOME/chat/server" || exit 1
INSTANCE_NAME="$NAME" nohup "$HOME/node/bin/node" --env-file-if-exists=.env server.js \
  > "$HOME/logs/chat.log" 2>&1 < /dev/null &
disown

for i in $(seq 1 30); do
  sleep 1
  if curl -sf -m 2 http://127.0.0.1:4000/health > /dev/null 2>&1; then
    echo "UP after ${i}s"
    curl -s -m 3 http://127.0.0.1:4000/health; echo
    exit 0
  fi
done
echo "FAILED to come up"
tail -30 "$HOME/logs/chat.log"
exit 1
