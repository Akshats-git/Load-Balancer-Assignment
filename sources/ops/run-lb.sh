#!/usr/bin/env bash
# Runs the load balancer in the foreground. supervise.sh restarts it if it dies.
#
# Settings come from ~/lb/lb.env, which is read on every start rather than
# baked into the supervisor's command line. That is what makes the threshold
# sweep possible: write a new threshold, restart the process, and the
# supervisor brings it back with the new value.

set -u

LB_DIR="$HOME/lb"
CONFIG="$LB_DIR/lb.env"

BACKENDS=""
LISTEN=":4000"
TLS_LISTEN=":3000"
THRESHOLD="0.70"
HYSTERESIS="0.08"
PROBE_INTERVAL="300ms"
POLICY="performance"

# shellcheck source=/dev/null
[ -f "$CONFIG" ] && . "$CONFIG"

if [ -z "$BACKENDS" ]; then
  echo "no BACKENDS set in $CONFIG" >&2
  exit 1
fi

CERT="$LB_DIR/cert.pem"
KEY="$LB_DIR/key.pem"

# Self-signed, generated once. It is here so the browser treats the origin as
# secure and gives the chat client WebCrypto, which it needs to sign a login.
# It proves nothing about identity, so a first visit still has to accept the
# warning. The plain HTTP listener exists alongside it for API clients, which
# have no reason to be handed a certificate they cannot verify.
if [ ! -f "$CERT" ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 730 \
    -keyout "$KEY" -out "$CERT" \
    -subj "/CN=10.1.75.53" \
    -addext "subjectAltName=IP:10.1.75.53,IP:127.0.0.1,DNS:localhost" 2>/dev/null
  echo "generated a self-signed certificate"
fi

exec "$LB_DIR/lb" \
  -listen "$LISTEN" \
  -tls-listen "$TLS_LISTEN" \
  -tls-cert "$CERT" \
  -tls-key "$KEY" \
  -backends "$BACKENDS" \
  -policy "$POLICY" \
  -threshold "$THRESHOLD" \
  -hysteresis "$HYSTERESIS" \
  -probe-interval "$PROBE_INTERVAL"
