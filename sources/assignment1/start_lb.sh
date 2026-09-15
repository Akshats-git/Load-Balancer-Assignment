#!/usr/bin/env bash
# Restarts the load balancer with a given backend list. The same binary serves
# Experiment 1 (Sys2 only) and Experiment 2 (all three) with no edits. It kills
# the old process by listening port, not by name, because a name pattern also
# matches the ssh command that runs this script.
#
# Port 3000 matters. The lab publishes each container's internal port 3000 as a
# host port, so a load balancer listening there is reachable from outside as
# https://10.1.75.53:3229 with no tunnel.
set -u
BACKENDS="${1:?usage: start-lb.sh <comma-separated backend urls> [port]}"
PORT="${2:-3000}"
CERT="$HOME/lb/cert.pem"
KEY="$HOME/lb/key.pem"

# Self signed certificate, generated once. It is here so the browser treats the
# origin as secure and gives the chat client WebCrypto. It proves nothing about
# identity, so the first visit still has to accept the warning.
if [ ! -f "$CERT" ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
    -keyout "$KEY" -out "$CERT" \
    -subj "/CN=10.1.75.53" \
    -addext "subjectAltName=IP:10.1.75.53,IP:127.0.0.1,DNS:localhost" 2>/dev/null
  echo "  generated a self-signed certificate"
fi

OLDPID=$(ss -tulnp 2>/dev/null | awk -v p=":$PORT " '$0 ~ p {print $NF}' | grep -o 'pid=[0-9]*' | cut -d= -f2 | head -1)
[ -n "${OLDPID:-}" ] && kill "$OLDPID" 2>/dev/null && sleep 2

mkdir -p "$HOME/logs"
nohup "$HOME/lb/lb" -listen ":$PORT" -backends "$BACKENDS" -health-path /health \
  -tls-cert "$CERT" -tls-key "$KEY" \
  > "$HOME/logs/lb.log" 2>&1 < /dev/null &
disown

for i in $(seq 1 20); do
  sleep 1
  if curl -skf -m 2 https://127.0.0.1:$PORT/lb/health > /dev/null 2>&1; then
    echo "LB UP after ${i}s"
    cat "$HOME/logs/lb.log"
    sleep 3   # let the first health-check sweep finish
    echo "--- /lb/status ---"
    curl -sk https://127.0.0.1:$PORT/lb/status
    exit 0
  fi
done
echo "LB FAILED to come up"
tail -20 "$HOME/logs/lb.log"
exit 1
