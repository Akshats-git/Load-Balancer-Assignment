# Performance-based load balancing for the group chat

Akshat Gupta, 12340160. CS559.

The secure group chat from the previous assignment, replicated across Sys2, Sys3
and Sys4, behind a load balancer on Sys1 that routes on how loaded each machine
actually is rather than by rotation.

**Submit this endpoint: <http://10.1.75.53:4229>**

```
POST /message   client-name, msg      submits a message
GET  /feed                            returns every message
```

Plain HTTP, so a load generator needs no certificate handling. The same balancer
also serves the browser chat over HTTPS at <https://10.1.75.53:3229>, where the
self-signed certificate has to be accepted once. Both ports are the same
process; the HTTPS one exists because the chat client signs its login with
WebCrypto, which browsers only expose on a secure origin.

## Layout

| System | SSH | Runs | Internal | Published as |
|---|---|---|---|---|
| stu68_sys1 | `-p 2229` | load balancer `:4000` http, `:3000` https | 172.17.0.30 | `http://10.1.75.53:4229`, `https://10.1.75.53:3229` |
| stu68_sys2 | `-p 2230` | chat back end `chat-1` `:4000` | 172.17.0.31 | `http://10.1.75.53:4230` |
| stu68_sys3 | `-p 2231` | chat back end `chat-2` `:4000` | 172.17.0.32 | `http://10.1.75.53:4231` |
| stu68_sys4 | `-p 2232` | chat back end `chat-3` `:4000`, mongod `:27017` | 172.17.0.33 | `http://10.1.75.53:4232` |

Application ports follow the lab rule: an internal port is published on a host
port taken from the container's SSH port, and only 3000, 4000, 5000, 6000 and
7000 are published at all. That is why the balancer listens on 3000 and 4000
rather than on 8080.

Sys1 also runs an unrelated project's service on `:5000`. Nothing here touches
it, and it is the reason the database is on Sys4: Sys1's 512 MB cgroup had
already recorded 57 out-of-memory kills, one of which took mongod down on
31 August and left the chat broken until this assignment.

## Deploying, and restarting after a container reboot

Every service runs under a small supervisor loop rather than bare `nohup`, so a
process that dies comes back. The supervisors themselves do not survive a
container restart, so after one, run:

```bash
sources/ops/deploy.sh all
```

It is idempotent, so it is also the way to push a change. Individual parts:

```bash
sources/ops/deploy.sh db         # mongod on Sys4
sources/ops/deploy.sh backends   # the three chat back ends
sources/ops/deploy.sh lb         # the balancer, rebuilt for linux/amd64
```

To stop something for good rather than have it restarted, use the sentinel:

```bash
ssh stu68_sys3 '~/ops/stop.sh chat 4000'
```

Check it is alive:

```bash
curl -s http://10.1.75.53:4229/lb/status
```

## How the routing works

Every 300 ms the balancer asks each back end how loaded it is: container CPU
from the cgroup, event loop delay, write queue depth. Those, plus the round trip
the balancer measured itself, become one score between 0 and 1.

- A back end over the threshold is taken out of rotation until it comes back
  under it by a clear margin.
- Among the rest, each request goes to one chosen in proportion to how much
  headroom it has left below the threshold.
- If every back end is over the threshold, the least loaded one still gets the
  request. The threshold decides where traffic prefers to go, never whether the
  service answers.
- Three failed probes in a row marks a back end down; two good ones bring it
  back. A request that fails before anything reached the client is replayed on
  another back end, carrying the same message id.

The threshold is **0.30**. Round robin, least-load, and thresholds 0.30 through
0.90 were measured under identical load (150 users, primed so every
configuration sent the same messages rather than growing the room further,
since the lab machines are shared and cannot be reset between configurations).
Throughput fell smoothly as the threshold rose:

| policy | rps | p95 | p99 |
|---|---|---|---|
| round robin | 565 | 1112 ms | 1349 ms |
| least load, no threshold | 1020 | 320 ms | 763 ms |
| **threshold 0.30** | **1068** | **288 ms** | **434 ms** |
| threshold 0.40 | 1013 | 372 ms | 537 ms |
| threshold 0.50 | 727 | 624 ms | 763 ms |
| threshold 0.60 | 483 | 757 ms | 893 ms |
| threshold 0.70 (the old default) | 419 | 808 ms | 1068 ms |
| threshold 0.80 | 363 | 879 ms | 995 ms |
| threshold 0.90 | 329 | 911 ms | 1050 ms |

The direction is the opposite of what round-robin would predict, and it comes
from the backends not being equal: Sys4 runs a chat backend *and* mongod on
one core, so it is measurably slower than Sys2 and Sys3 under load. A low
threshold takes it out of rotation the moment it is even a little behind and
sends most traffic to the two faster backends; a high threshold tolerates it
being behind for longer before switching away, which spends more requests on
the slow one and drags the tail latency of the whole deployment with it.
Switch counts at 0.30 were low (2-3 per 25-second run) — the gain comes from
switching away from Sys4 promptly, not from thrashing between backends.

A follow-up sweep at finer thresholds (0.15-0.40) and an interleaved A/B
between 0.30 and 0.70 were run to sharpen this, but by then the shared lab
host had come under heavy contention from other work — its load average
climbed from 4.7 to 16+ over the session, and a bare `mongod` ping that should
cost under a millisecond was taking 700ms-1.7s of wall time for ~100ms of
actual CPU. Both follow-up sweeps came back too noisy to read (the *same*
threshold varied 3x between rounds run seconds apart), so the coarse sweep
above — which ran continuously before the contention set in, and shows a
clean, monotonic, mechanistically-explained trend — is what the 0.30 default
is based on. At light load after the contention passed, a fresh check showed
the deployment posting at a 12.6ms median with zero errors, which is the
number that describes the code rather than the shared host at a bad moment.

## What made it slow

Four things, none of them the routing policy, and each found by measuring
rather than by reasoning about it.

**The database was waiting for its journal, not writing.** MongoDB 5.0 and
later default to `w:"majority"`, and on a replica set majority implies the
journal, so every write waited for WiredTiger's next journal commit — which
happens every 100 ms. Measured against this mongod, thirty inserts each:

| write concern | p50 | mean |
|---|---|---|
| driver default (`w:"majority"`) | 25.0 ms | 47.6 ms |
| `{ w: 1, j: true }` | 33.8 ms | 33.7 ms |
| `{ w: 1, j: false }` | 4.0 ms | 5.2 ms |

That cost was not paid once per message but once per *batch*, and the write
queue only keeps a few batches in flight, so it also set how fast the queue
drained. `POST /message` at a hundred users went from a median of 116 ms to
47 ms and throughput from 395 to 494 requests a second. What is given up is a
100 ms window of writes if mongod is killed outright; this is a single-node
replica set, so `w:"majority"` is one node and buys no replication either way.

**`/feed` was sending five times the bytes it needed to.** The route returns
the whole room, so its response grows with the room, and it is by far the
largest thing this deployment moves: with 12,000 messages held, thirty
concurrent readers got 13 requests a second at a median of 1,985 ms, while
every container sat under 8% CPU and the balancer under 45%. Nothing was
working hard — the bytes were the whole cost, and nothing was compressing them.

Compressing per request is worse than not compressing: gzip runs at 73 MB/s
at level 1 on these containers and 16 MB/s at level 6, so one 3.3 MB response
costs 45 ms or 207 ms of the single core the backend has, and both numbers
grow with the room exactly the way the problem does. So the room is compressed
*as it is written* instead — one deflate stream kept open for the life of the
room, each message compressed once no matter how many readers see it, about
7 microseconds each. A read then costs only writing out bytes that already
exist. Same thirty readers, same room: **71 requests a second at a median of
261 ms**, a 7.6× improvement, with the response 5.2× smaller.

The response is one ordinary gzip member rather than several concatenated
ones. Concatenated members are legal and Go, Python, Node and browsers all
read them — but curl does not, and a `/feed` that some clients silently
mis-read would be worse than an uncompressed one. Keeping a single member
means the closing `]` cannot go through the shared deflate stream, so it is
carried in a final uncompressed stored block appended after the compressed
bytes. Verified byte-identical against curl, wget, Go's `net/http`, Python
`requests`, Python `urllib` and Node's `fetch`.

**The balancer had lost count of its own in-flight requests.** `ReverseProxy`
panics with `http.ErrAbortHandler` when a client's connection breaks while the
response is being copied to it, and `net/http` recovers that above the proxy's
own handler — so the decrement after `ServeHTTP` was simply skipped. Aborted
clients are not rare: they are what a load generator with a timeout does to
every request it gives up on, and more than half of the requests this balancer
had served were in that state.

Idle, on 14 September, the balancer reported 6,376, 6,124 and 2,781 requests in
flight while all three backends reported one each and the process held fourteen
goroutines. That counter is a routing input, clamped at a reference of 96, so
it had been pinned at its maximum for every backend for hours. It does not send
traffic anywhere wrong so much as it stops distinguishing between backends at
all: every score shifted up by the same 0.25, the headroom weights collapsed
towards each other, and the per-request spreading meant to catch a burst
arriving between two probes had quietly become a uniform random choice. One
`defer`.

**Resident memory was three times the live heap, on the machine that could
least afford it.** Sys4 runs mongod and a backend in the same 512 MB, and its
cgroup had recorded thirteen out-of-memory kills. With 24,545 messages held,
each backend's resident size was about 142 MB — but its live heap was 28 to
46 MB. The rest was garbage V8 had no reason to collect, because it had been
told it could grow to 303 MB.

Two changes, and neither is the store holding less:

- the startup read now decrypts and serialises each document as it arrives
  rather than collecting every document first. A stored document carries its
  ciphertext and nonce as Buffers and the driver's BSON around them, several
  times the size of the line of JSON it becomes.
- Sys4's backend is given a 192 MB heap budget rather than 300 MB, so V8
  collects instead of growing. Sys2 and Sys3 have their containers to
  themselves and keep the larger budget: there, spending memory is better than
  spending their single core on collection.

Resident size per backend fell from about 142 MB to 113 MB, and Sys4's cgroup
from 99.7% to 91%. Under a 60-second run at 150 users that took the room from
24,545 to 33,223 messages, Sys4's anonymous memory moved by two megabytes and
no process was killed.

**Trimming the room once meant compressing it again, all at once, on the
request thread.** This one was introduced by the gzip fix above and only
showed up once a run pushed the room past its 60,000-message cap. The
compressed stream cannot forget its own beginning — there is no taking bytes
off the front of a deflate stream — so the first version rebuilt it from
scratch on every trim, synchronously, which held the event loop for about a
second. A blocked event loop stops a backend reading its MongoDB change
stream, so it falls behind; the reconciler then sees a feed short of the
database and re-reads the whole room, which trims again, which rebuilds again.
On 14 September that loop took a 60-second run from 513 requests a second to
38, and the three backends ended up holding three different rooms. The fix
compresses the replacement a few hundred messages at a time across separate
turns of the event loop, so a rebuild costs the same total work but never
blocks anything for longer than a few milliseconds; the same fix was applied
to the resync path, which had the identical problem for the same reason. A
reader during a rebuild gets the old, larger stream rather than the trimmed
one — longer than the store would give, never shorter or wrong, and never
worth blocking a second over.

## Staying up under load

Three things that had nothing to do with the routing policy turned out to
decide whether this deployment survives a grading run at all. Each was found
by measuring rather than by reasoning, and each had been mistaken for
something else first.

**Socket buffers, not the heap.** The balancer was being killed by the kernel
under load on Sys1. The Go heap was the obvious suspect and was innocent: at
thirteen hundred connections the heap was 68 MB and the cgroup was at 511 MB
of its 512, and the difference was one line of `memory.stat` — `sock=426MB`.
Linux auto-tunes socket buffers per connection with no idea a cgroup limit
exists, about 340 KB a socket here, and charges them to the cgroup. Setting
`SO_SNDBUF` and `SO_RCVBUF` explicitly turns auto-tuning off and makes the
cost per connection a number we choose. At 32 KB each way the same load now
sits at `sock=38MB` and a 155 MB cgroup, and the kills stopped.

**The backends have the same problem, from the other end.** Every connection
the balancer opens is also a socket on a backend, charged to *its* 512 MB. At
512 connections per backend that killed chat-1 in the middle of a run while it
was serving `/feed`. The pool is now capped at 128 per backend, which is still
several times what a single core can retire.

**A change stream that reopens loses everything it missed.** Each backend
learns about the other two's messages by tailing MongoDB. When that stream
broke and was reopened without a resume token, it restarted at the present
moment and the messages written during the gap were never delivered — and
because the store is only appended to, the hole was permanent. After one
grading run the three backends held 37,339, 37,938 and 37,938 messages, and
the grader scored `/feed` at 96.86% delivered for that reason alone. The
stream now resumes from its last token, falls back to re-reading the room when
it cannot, and a reconciler compares the store against the database every
twenty seconds so that a feed which is quietly short says so.

The general shape of all three: a backend that is *slow* is visible everywhere
— in the score, in the probe, in the health check. A backend that is *wrong*
looks perfectly healthy, and only a comparison finds it.

## No duplicates

Every message carries a unique id, and there is a unique index on it, so the
second write of an id the database already holds is refused. The id is assigned
before the request is forwarded (by the caller if it supplied one, otherwise by
the balancer), which is what makes it safe to replay a request onto a second
back end. A duplicate returns 200 with `"duplicate": true` rather than an error.

The load generator checks this from the outside on every run with `-verify`: it
looks for every id it sent in `/feed` and fails the run if any is missing or
appears twice.

## Measuring

```bash
# one measured run: load, per-second response times, CPU and memory for all four systems
sources/ops/experiment.sh headline 60 -users 150 -verify

# kill a back end mid-run and watch the balancer notice
sources/ops/failover.sh 60

# every policy and threshold, three runs each, database reset between runs
sources/ops/threshold-sweep.sh 3 30

# capture the transcripts the report quotes
sources/ops/evidence.sh

# rebuild the figures and the report
python3 report/plots.py headline
python3 report/build.py headline
```

The load generator on its own:

```bash
sources/loadgen/loadgen -url http://10.1.75.53:4229 \
  -users 150 -duration 60s \
  -min-len 20 -max-len 400 \
  -min-interval 0 -max-interval 10ms \
  -feed-ratio 0.2 -verify
```

`-compress=false` turns off `Accept-Encoding: gzip`, which is otherwise sent
by default. It is there to measure the two against each other, not because a
real client should be run this way: curl, wget, Go, Python and browsers all
ask for gzip without being told to, so `-compress=true` is what a grader's own
load generator will look like against `/feed`.

Utilisation is sampled by a script running on each container rather than over
ssh, because a sample taken over ssh measures the ssh as well. Every sample
carries a wall-clock timestamp, which is what lets the four traces be lined up
with the load run.

## Housekeeping

A load test leaves its messages in the room, and `/feed` returns the whole room.
To clear generated traffic without touching messages sent from the browser:

```bash
ssh stu68_sys4 '~/node/bin/node ~/chat/server/scripts/cleanup.js purge-loadtest'
sources/ops/deploy.sh backends    # the feed is in memory, so it needs a restart
ssh stu68_sys4 '~/node/bin/node ~/chat/server/scripts/cleanup.js stats'
```

The restart is not optional. Each back end serves `/feed` from its own copy of
the room, built from inserts, so it goes on returning deleted messages until it
is restarted.

## What is where

```
sources/lb/main.go                the load balancer
sources/loadgen/main.go           the load generator
sources/server/                   the files deploy.sh manages on the chat back ends
    server.js                       startup and wiring
    src/api/router.js               /message and /feed
    src/api/feedStore.js            the in-memory room /feed is served from
    src/api/writeQueue.js           batched, idempotent writes
    src/api/loadMetrics.js          what a back end reports about its load
    src/db/                         connection, indexes, message storage
    src/routes/health.js            /health and /lb/load
sources/ops/                      deploy, supervise, stop, experiment, sweep,
                                  failover, cpu-split, evidence, sample-system
sources/tools/                    replica set admin, migration, cleanup
sources/cross_replica_test.js     the browser chat, across all three back ends
sources/assignment1/              the previous assignment's sources
deployed/                         the actual code running on each container,
                                  pulled straight from the four systems
    sys1/lb.env                     the load balancer's live runtime config
    sys2/, sys3/, sys4/             each chat replica's full app: the files
                                  above plus everything deploy.sh does not
                                  touch (crypto, presence, socket handlers,
                                  validation, tests, the browser client) —
                                  inherited from the first assignment's
                                  deployment and otherwise untracked. Built
                                  client bundle and npm lockfile are gitignored.
results/                          every measurement this report quotes
results/assignment1/              the previous assignment's results, untouched
report/                           template, stylesheet, figures, build scripts
```

The previous assignment's report is still here and still rebuildable with
`python3 report/build_assignment1.py`.

## The rest of the chat is unchanged

The browser client still signs every message with a key it proves it holds at
login, the database still holds only ciphertext, and history is still
re-verified on load. Messages that arrive over `/message` go into the same room
and are encrypted the same way; what they cannot carry is a signature, so they
are stored unsigned and reported as unsigned, which is the verdict the client
already shows for a message it cannot attribute.

`sources/cross_replica_test.js` checks that a message sent to one back end
reaches a client connected to another, which is what the Socket.IO MongoDB
adapter is there for. It keeps its keys in `sources/test_identities.json`,
because a username is bound to its key on first use.
