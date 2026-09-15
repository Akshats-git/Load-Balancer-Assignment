#!/usr/bin/env bash
# Health check failover test against the load balancer on Sys1.
# Run from the local system. The -k flags are for the self signed certificate.
set -u
LB=https://10.1.75.53:3229

show() {
  curl -sk -m 10 "$LB/lb/status" | python3 "$(dirname "$0")/lbstatus.py"
}

# One request per line, showing the status code and which backend answered.
traffic() {
  local n=$1 hdr
  hdr=$(mktemp)
  for i in $(seq 1 "$n"); do
    curl -sk -m 10 -D "$hdr" -o /dev/null "$LB/health"
    printf '  request %-2s -> %s  served by %s\n' \
      "$i" \
      "$(grep -i '^HTTP/' "$hdr" | awk '{print $2}' | tr -d '\r')" \
      "$(grep -i '^x-lb-backend:' "$hdr" | awk '{print $2}' | tr -d '\r')"
  done
  rm -f "$hdr"
}

echo "### 1. all three backends healthy ###"
show

echo
echo "### 2. six requests, all backends up, strict round robin ###"
curl -sk -m 10 "$LB/lb/reset" > /dev/null
traffic 6

echo
echo "### 3. stop the chat server on Sys3 (172.17.0.32) ###"
ssh stu68_sys3 'P=$(ss -tulnp 2>/dev/null | awk "/:4000 /{print \$NF}" | grep -o "pid=[0-9]*" | cut -d= -f2 | head -1); kill $P && echo "  killed chat-2 (pid $P) on Sys3"'
echo "  waiting 8s. The health check runs every 2s and needs 3 misses in a row."
sleep 8
show

echo
echo "### 4. six more requests with Sys3 down, no failures, Sys3 skipped ###"
traffic 6

echo
echo "### 5. restart the chat server on Sys3 ###"
ssh stu68_sys3 'bash ~/start-chat.sh chat-2' 2>&1 | head -2
echo "  waiting 6s..."
sleep 6
show

echo
echo "### 6. six requests after recovery, Sys3 is back in the rotation ###"
traffic 6

echo
echo "### 7. load balancer log ###"
ssh stu68_sys1 'tail -3 ~/logs/lb.log'
