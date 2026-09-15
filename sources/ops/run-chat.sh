#!/usr/bin/env bash
# Runs one chat backend in the foreground. supervise.sh restarts it if it dies.
#
# The Node flags are all about the container rather than the application. These
# containers have 512 MB and one core but the kernel shows them the host's 128
# GB and 120 cores, so left alone V8 sizes its heap and its worker pool for a
# machine that is not there: it would let the heap grow past the cgroup limit
# and get the process OOM-killed rather than run a garbage collection, and it
# would start dozens of worker threads to contend over a single core.

set -u

NAME="${INSTANCE_NAME:-chat}"
PORT="${PORT:-4000}"
APP_DIR="$HOME/chat/server"

# Leaves room for the operating system, the page cache and the buffers Node
# allocates outside the heap, inside a 512 MB cgroup.
HEAP_MB="${NODE_HEAP_MB:-300}"

cd "$APP_DIR" || exit 1

exec "$HOME/node/bin/node" \
  --max-old-space-size="$HEAP_MB" \
  --v8-pool-size=2 \
  --env-file-if-exists=.env \
  server.js
