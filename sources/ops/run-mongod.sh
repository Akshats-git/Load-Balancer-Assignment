#!/usr/bin/env bash
# Runs mongod in the foreground. supervise.sh restarts it if it dies.
#
# The database lives on Sys4 rather than Sys1. Sys1 also hosts an unrelated
# service belonging to another project, and its 512 MB cgroup had already
# OOM-killed mongod once, which is what took the chat down. Sys4 runs one chat
# backend and has the room.
#
# The WiredTiger cache is pinned low for the same reason. Left at its default
# it sizes itself from the host's memory, not the container's, and asks for
# tens of gigabytes inside half a gigabyte. 0.25 GB is the smallest value
# MongoDB accepts.
#
# The cache is not the whole story, though, and this is what caught us out: with
# a 0.25 GB cache mongod still grew to 442 MB of a 512 MB container under load
# and the kernel killed something. The rest is connection buffers and memory
# that has been freed but not handed back, so tcmallocReleaseRate is raised to
# return it faster, and the back ends were told to open far fewer connections.
#
# 0.25 GB is also still too much here, and MongoDB will not accept a smaller
# value for --wiredTigerCacheSizeGB. The engine config string is passed to
# WiredTiger after the value that flag produces, and WiredTiger takes the last
# setting for a key, so the cache actually ends up at CACHE_MB. Check it rather
# than trust it:
#
#   node ~/chat/server/scripts/rsadmin.js cache
#
# A smaller cache means more reads reach the disk. That is the right trade here:
# this workload is almost entirely inserts, which go to the journal regardless,
# and the alternative is the kernel killing the database.
#
# 112 MB until 14 September, when a run that pushed the room past the feed
# store's cap left this container at 427 MB of anonymous memory - mongod 275 MB
# and the backend 214 MB - and the cgroup recorded another kill. Both sides
# were cut: the backend's V8 budget to 160 MB and this to 80 MB.

set -u

DATA_DIR="${MONGO_DATA:-$HOME/mongo-data}"
PORT="${MONGO_PORT:-27017}"
CACHE_GB="${MONGO_CACHE_GB:-0.25}"
CACHE_MB="${MONGO_CACHE_MB:-80}"

mkdir -p "$DATA_DIR"

exec "$HOME/mongodb/bin/mongod" \
  --dbpath "$DATA_DIR" \
  --bind_ip 0.0.0.0 \
  --port "$PORT" \
  --replSet rs0 \
  --wiredTigerCacheSizeGB "$CACHE_GB" \
  --wiredTigerEngineConfigString "cache_size=${CACHE_MB}M" \
  --setParameter tcmallocReleaseRate=5.0
