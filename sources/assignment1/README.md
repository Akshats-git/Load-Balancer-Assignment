# Previous assignment's sources

These are the files the first load balancer assignment was built from, kept so
that its report stays reproducible (`python3 report/build_assignment1.py`) and
so the two submissions can be compared. Its measurements are in
`results/assignment1/`.

Nothing here is deployed. What replaced each of them:

| Here | Now |
|---|---|
| `lb_main.go` | `sources/lb/main.go`, which routes on measured load rather than by rotation |
| `loadgen_main.go`, `chatload_main.js` | `sources/loadgen/main.go` |
| `start_chat.sh`, `start_lb.sh` | `sources/ops/`, which supervises rather than backgrounds |
| `failover_demo.sh` | `sources/ops/failover.sh` |
| `chat_server.patch`, `chat_server_patched.js` | `sources/server/` (the files `deploy.sh` manages) and `deployed/sys2/` (the full chat app as it actually runs) |
| `lbstatus.py` | `curl .../lb/status` |
