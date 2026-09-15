#!/usr/bin/env bash
# Pushes this repository onto the four lab containers and restarts the services.
#
#   sources/ops/deploy.sh            everything
#   sources/ops/deploy.sh backends   just the three chat backends
#   sources/ops/deploy.sh lb         just the load balancer
#
# Run from the repository root. It is idempotent: running it twice leaves the
# same deployment, so it is also the way to restart after a container reboot.
#
# Layout it produces:
#
#   Sys1  load balancer, HTTP :4000 and HTTPS :3000
#   Sys2  chat-1 :4000
#   Sys3  chat-2 :4000
#   Sys4  chat-3 :4000, and mongod :27017 for all three
#
# Sys1 also runs an unrelated service on :5000 that this script never touches.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OPS="$ROOT/sources/ops"
SERVER="$ROOT/sources/server"

DB_HOST="172.17.0.33"
BACKEND_URLS="http://172.17.0.31:4000,http://172.17.0.32:4000,http://172.17.0.33:4000"
MONGO_URI="mongodb://$DB_HOST:27017/?directConnection=true"

# host:instance name:V8 old-space budget in MB
#
# Sys4 gets a smaller heap than the other two because it is not alone in its
# container: mongod lives there too and holds about 300 MB of the 512 MB.
#
# The number to size this against is the live heap, not the resident size. With
# 24,545 messages held, each backend's resident size was about 142 MB while its
# live heap was 28-46 MB - V8 had simply not had a reason to collect, because
# it had been told it could grow to 303 MB. That is the right default on Sys2
# and Sys3, which have the container to themselves and are better off spending
# memory than spending their single core on collection. On Sys4 it is how the
# kernel ends up choosing between mongod and the backend, and it has chosen
# thirteen times.
#
# 160 MB is more than twice the live heap measured with the store full at its
# 60,000 message cap (45-70 MB), so it makes V8 collect rather than grow
# without ever being a ceiling the room actually reaches. It was 192 MB until
# a 60-second run at 150 users, with the room past the cap and trimming
# throughout, left Sys4 at 427 MB of anonymous memory and its cgroup recorded
# another out-of-memory kill.
BACKENDS=(
  "stu68_sys2:chat-1:300"
  "stu68_sys3:chat-2:300"
  "stu68_sys4:chat-3:160"
)

TARGET="${1:-all}"

# Repeated ssh to the same container costs a full connection setup each time,
# and this script makes a dozen of them. Multiplexing puts them all down one
# connection, which took the time to start four samplers from 22 seconds to
# about one. That matters here: the samplers are supposed to start together and
# before the load, not spread over the first half of the run.
SSH_OPTS=(-o ControlMaster=auto -o ControlPath="$HOME/.ssh/cm-%r@%h:%p" -o ControlPersist=120)
SSH=(ssh "${SSH_OPTS[@]}")
SCP=(scp -q "${SSH_OPTS[@]}")

say() { printf '\n=== %s ===\n' "$*"; }

# ---------------------------------------------------------------------------
# Shared operations scripts
# ---------------------------------------------------------------------------

push_ops() {
  local host="$1"
  "${SSH[@]}" "$host" 'mkdir -p ~/ops ~/logs'
  "${SCP[@]}" "$OPS/supervise.sh" "$OPS/stop.sh" "$OPS/sample-system.sh" "$host:/home/student/ops/"
  "${SSH[@]}" "$host" 'chmod +x ~/ops/*.sh'
}

# ---------------------------------------------------------------------------
# Database, on Sys4
# ---------------------------------------------------------------------------

deploy_database() {
  say "database on stu68_sys4"

  push_ops stu68_sys4
  "${SCP[@]}" "$OPS/run-mongod.sh" stu68_sys4:/home/student/ops/
  "${SSH[@]}" stu68_sys4 'chmod +x ~/ops/run-mongod.sh'

  # Stopped and started rather than left alone if it happens to be running.
  # mongod's settings are on its command line, so a running one is running the
  # settings it was started with, and this script exists to make what is
  # deployed match what is in the repository.
  "${SSH[@]}" stu68_sys4 "~/ops/stop.sh mongod 27017 || true"
  "${SSH[@]}" stu68_sys4 'setsid ~/ops/supervise.sh mongod ~/ops/run-mongod.sh >/dev/null 2>&1 </dev/null & sleep 3; exit 0'

  for _ in $(seq 1 30); do
    if "${SSH[@]}" stu68_sys4 'ss -lnt | grep -q ":27017 "'; then
      echo "mongod is listening"
      return 0
    fi
    sleep 1
  done

  echo "mongod did not come up" >&2
  "${SSH[@]}" stu68_sys4 'tail -20 ~/logs/mongod.log'
  return 1
}

# ---------------------------------------------------------------------------
# Chat backends, on Sys2, Sys3 and Sys4
# ---------------------------------------------------------------------------

deploy_backend() {
  IFS=: read -r host instance heap <<<"$1"

  say "$instance on $host"

  push_ops "$host"
  "${SCP[@]}" "$OPS/run-chat.sh" "$host:/home/student/ops/"
  "${SSH[@]}" "$host" 'chmod +x ~/ops/run-chat.sh'

  "${SSH[@]}" "$host" 'mkdir -p ~/chat/server/src/api ~/chat/server/src/routes ~/chat/server/src/db ~/chat/server/scripts'

  "${SCP[@]}" "$SERVER/server.js"                    "$host:/home/student/chat/server/server.js"
  "${SCP[@]}" "$SERVER/src/api/router.js"            "$host:/home/student/chat/server/src/api/router.js"
  "${SCP[@]}" "$SERVER/src/api/feedStore.js"         "$host:/home/student/chat/server/src/api/feedStore.js"
  "${SCP[@]}" "$SERVER/src/api/gzipFeed.js"          "$host:/home/student/chat/server/src/api/gzipFeed.js"
  "${SCP[@]}" "$SERVER/src/api/writeQueue.js"        "$host:/home/student/chat/server/src/api/writeQueue.js"
  "${SCP[@]}" "$SERVER/src/api/loadMetrics.js"       "$host:/home/student/chat/server/src/api/loadMetrics.js"
  "${SCP[@]}" "$SERVER/src/routes/health.js"         "$host:/home/student/chat/server/src/routes/health.js"
  "${SCP[@]}" "$SERVER/src/db/index.js"              "$host:/home/student/chat/server/src/db/index.js"
  "${SCP[@]}" "$SERVER/src/db/messageRepository.js"  "$host:/home/student/chat/server/src/db/messageRepository.js"
  "${SCP[@]}" "$ROOT/sources/tools/rsadmin.js"       "$host:/home/student/chat/server/scripts/rsadmin.js"
  "${SCP[@]}" "$ROOT/sources/tools/cleanup.js"       "$host:/home/student/chat/server/scripts/cleanup.js"

  # Point this backend at the database's new home, leaving the encryption key
  # and everything else in .env alone.
  "${SSH[@]}" "$host" "sed -i 's#^MONGODB_URI=.*#MONGODB_URI=$MONGO_URI#' ~/chat/server/.env && grep '^MONGODB_URI=' ~/chat/server/.env"

  "${SSH[@]}" "$host" "~/ops/stop.sh chat 4000 || true"
  "${SSH[@]}" "$host" "INSTANCE_NAME=$instance NODE_HEAP_MB=$heap setsid ~/ops/supervise.sh chat ~/ops/run-chat.sh >/dev/null 2>&1 </dev/null & sleep 3; exit 0"

  for i in $(seq 1 40); do
    if "${SSH[@]}" "$host" 'curl -sf -m 2 http://127.0.0.1:4000/health >/dev/null 2>&1'; then
      echo "up after ${i}s: $("${SSH[@]}" "$host" 'curl -s -m 3 http://127.0.0.1:4000/health')"
      return 0
    fi
    sleep 1
  done

  echo "$instance did not come up" >&2
  "${SSH[@]}" "$host" 'tail -30 ~/logs/chat.log'
  return 1
}

# ---------------------------------------------------------------------------
# Load balancer, on Sys1
# ---------------------------------------------------------------------------

deploy_lb() {
  say "load balancer on stu68_sys1"

  echo "building for linux/amd64"
  ( cd "$ROOT/sources/lb" && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags='-s -w' -o "$ROOT/sources/lb/lb" . )
  ls -lh "$ROOT/sources/lb/lb" | awk '{print $5, $9}'

  push_ops stu68_sys1
  "${SCP[@]}" "$OPS/run-lb.sh" stu68_sys1:/home/student/ops/
  "${SSH[@]}" stu68_sys1 'chmod +x ~/ops/run-lb.sh && mkdir -p ~/lb'

  "${SCP[@]}" "$ROOT/sources/lb/lb" stu68_sys1:/home/student/lb/lb.new
  "${SSH[@]}" stu68_sys1 'chmod +x ~/lb/lb.new'

  "${SSH[@]}" stu68_sys1 "cat > ~/lb/lb.env <<'EOF'
BACKENDS=\"$BACKEND_URLS\"
LISTEN=\":4000\"
TLS_LISTEN=\":3000\"
THRESHOLD=\"${LB_THRESHOLD:-0.30}\"
HYSTERESIS=\"${LB_HYSTERESIS:-0.08}\"
PROBE_INTERVAL=\"${LB_PROBE_INTERVAL:-300ms}\"
POLICY=\"${LB_POLICY:-performance}\"
EOF
cat ~/lb/lb.env"

  # Stop both listeners before swapping the binary: a running process holds its
  # own inode, but the supervisor would restart the old one otherwise.
  "${SSH[@]}" stu68_sys1 "~/ops/stop.sh lb 3000 || true"
  "${SSH[@]}" stu68_sys1 "~/ops/stop.sh lb 4000 || true"
  "${SSH[@]}" stu68_sys1 'mv -f ~/lb/lb.new ~/lb/lb'
  "${SSH[@]}" stu68_sys1 'setsid ~/ops/supervise.sh lb ~/ops/run-lb.sh >/dev/null 2>&1 </dev/null & sleep 3; exit 0'

  for i in $(seq 1 30); do
    if curl -sf -m 2 http://10.1.75.53:4229/lb/health >/dev/null 2>&1; then
      echo "load balancer up after ${i}s"
      return 0
    fi
    sleep 1
  done

  echo "load balancer did not come up" >&2
  "${SSH[@]}" stu68_sys1 'tail -30 ~/logs/lb.log'
  return 1
}

# ---------------------------------------------------------------------------

case "$TARGET" in
  all)
    deploy_database
    for entry in "${BACKENDS[@]}"; do deploy_backend "$entry"; done
    deploy_lb
    ;;
  db|database)
    deploy_database
    ;;
  backends)
    for entry in "${BACKENDS[@]}"; do deploy_backend "$entry"; done
    ;;
  lb)
    deploy_lb
    ;;
  *)
    echo "usage: deploy.sh [all|db|backends|lb]" >&2
    exit 1
    ;;
esac

say "deployment complete"
echo "  API      http://10.1.75.53:4229/feed"
echo "  browser  https://10.1.75.53:3229"
curl -sf -m 5 http://10.1.75.53:4229/lb/status || true
