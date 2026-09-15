// Performance-based load balancer for Sys1, in front of the chat backends on
// Sys2, Sys3 and Sys4.
//
// The routing decision is not a rotation. Every backend reports how loaded it
// is several times a second, the balancer turns those reports into one score
// per backend, and a backend whose score climbs past a threshold stops
// receiving new traffic until it recovers. Among the backends still under the
// threshold, each request goes to the least loaded one.
//
// Why a threshold at all, rather than simply always picking the minimum: the
// scores are sampled, so between two samples every request would see the same
// minimum and pile onto one machine. The threshold makes the common case cheap
// and stable, and turns the interesting case into an explicit, tunable
// decision that can be measured and reported on.
//
// Three things feed the score, because no single one is sufficient:
//
//	CPU        the container's own CPU use, read from its cgroup. The headline
//	           measure of system load.
//	loop lag   how far behind the backend's event loop is. A Node process
//	           waiting on the database has low CPU and a growing queue, and
//	           this is what notices.
//	latency    what the balancer itself has recently measured for the backend,
//	           which catches everything the backend does not report.
//
// Plus, per request, the number of requests already in flight to that backend.
// That one is exact and instantaneous, and it is what stops a burst of
// arrivals between two samples from herding onto the same machine.
package main

import (
	"bufio"
	"bytes"
	"context"
	crand "crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"math"
	"math/rand/v2"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"runtime"
	"runtime/debug"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

// Reference points that turn a raw measurement into a 0..1 term. Each is the
// value at which that signal is considered to be contributing "fully loaded".
const (
	lagReference      = 60.0  // ms of event loop delay
	latencyReference  = 250.0 // ms of round trip measured at the balancer
	queueReference    = 200.0 // documents waiting to be written
	inflightReference = 96.0  // requests in flight to one backend
)

// Weights of the polled signals. They sum to 1, so a score is directly
// comparable with the threshold.
const (
	weightCPU     = 0.50
	weightLag     = 0.20
	weightLatency = 0.15
	weightQueue   = 0.15
)

// How much of the per-request score comes from the instantaneous in-flight
// count rather than the polled snapshot.
const inflightShare = 0.25

// New samples are blended into the previous score rather than replacing it, so
// one unlucky probe does not move traffic on its own.
const scoreSmoothing = 0.45

// ---------------------------------------------------------------------------
// Backends
// ---------------------------------------------------------------------------

type Backend struct {
	ID    int
	URL   *url.URL
	Host  string
	Proxy *httputil.ReverseProxy

	// Hot path, read and written per request.
	inflight    atomic.Int64
	served      atomic.Int64
	stickyHits  atomic.Int64
	failures    atomic.Int64
	latencyEWMA atomic.Uint64 // microseconds, fixed point

	mu         sync.RWMutex
	alive      bool
	overloaded bool
	okStreak   int
	failStreak int
	score      float64
	probe      probeResult
}

// What a backend reports about itself.
type probeResult struct {
	CPU            float64 `json:"cpu"`
	ProcCPU        float64 `json:"procCpu"`
	LoopLagMs      float64 `json:"loopLagMs"`
	Inflight       int     `json:"inflight"`
	QueueDepth     int     `json:"queueDepth"`
	FeedSize       int64   `json:"feedSize"`
	MemoryFraction float64 `json:"memoryFraction"`
	RSSMB          float64 `json:"rssMB"`
	Backend        string  `json:"backend"`

	At    time.Time `json:"-"`
	Error string    `json:"-"`
}

func (b *Backend) snapshot() (float64, bool, bool, probeResult) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return b.score, b.alive, b.overloaded, b.probe
}

// The score used to decide where one request goes. The polled part moves at
// the probe interval; the in-flight part moves with every request, which is
// what spreads a burst that arrives between two probes.
func (b *Backend) instantScore() float64 {
	b.mu.RLock()
	polled := b.score
	b.mu.RUnlock()

	load := float64(b.inflight.Load()) / inflightReference

	return (1-inflightShare)*polled + inflightShare*clamp01(load)
}

func (b *Backend) recordLatency(d time.Duration) {
	const alpha = 0.2

	sample := float64(d.Microseconds())
	previous := math.Float64frombits(b.latencyEWMA.Load())

	next := sample
	if previous > 0 {
		next = alpha*sample + (1-alpha)*previous
	}

	b.latencyEWMA.Store(math.Float64bits(next))
}

func (b *Backend) latencyMs() float64 {
	return math.Float64frombits(b.latencyEWMA.Load()) / 1000
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

var (
	backends []*Backend

	threshold  float64
	hysteresis float64
	sticky     bool
	policy     string

	roundRobin atomic.Uint64

	requests  atomic.Int64
	succeeded atomic.Int64
	failures  atomic.Int64
	retried   atomic.Int64
	abandoned atomic.Int64
	switches  atomic.Int64

	samples  latencyRing
	timeline timelineRing

	idPrefix  string
	idCounter atomic.Uint64

	memoryLimit int64
)

const stickyCookie = "lb_backend"

const (
	policyPerformance = "performance"
	policyRoundRobin  = "roundrobin"
	policyLeastLoad   = "least-load"
)

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

// Picks the backend for one request.
//
// Two stages, in this order.
//
// First the threshold. A backend whose score has climbed past it is set aside
// and receives nothing until it comes back down. If that leaves nothing at
// all, every backend is busy and the request still has to go somewhere, so the
// least loaded of them is used rather than refusing to serve.
//
// Then, among the backends still under the threshold, a weighted choice on how
// much headroom each one has left. A backend at score 0.1 against a threshold
// of 0.7 has six times the headroom of one at 0.6 and receives roughly six
// times as much traffic.
//
// Weighting rather than simply taking the minimum, because the minimum starves
// machines that are merely second best. One of these three containers also
// hosts the database, so its CPU is permanently a little higher than the other
// two: under a strict minimum it received no traffic at all while it still had
// most of a core spare. Sharing in proportion to headroom uses that machine for
// what it can still do, and the proportion shifts on its own as load moves.
//
// The headroom is computed from the per-request score, so it includes the
// in-flight count. That is what keeps a burst arriving between two probes from
// piling onto whichever backend happened to look best when the last probe ran.
func pick(exclude int) *Backend {
	const maxBackends = 16

	var (
		pool     [maxBackends]*Backend
		weights  [maxBackends]float64
		fallback [maxBackends]*Backend
	)

	poolCount, fallbackCount := 0, 0

	for _, b := range backends {
		if b.ID == exclude {
			continue
		}

		b.mu.RLock()
		up, over := b.alive, b.overloaded
		b.mu.RUnlock()

		if !up || fallbackCount >= maxBackends {
			continue
		}

		fallback[fallbackCount] = b
		fallbackCount++

		// The threshold belongs to the performance policy. The two comparison
		// policies are supposed to be what they are named, so neither of them
		// gets to quietly benefit from it.
		if !over || policy != policyPerformance {
			pool[poolCount] = b
			poolCount++
		}
	}

	// Everything is over the threshold. Fall back to the least loaded, because
	// dropping the request would be worse than sending it to a busy machine.
	if poolCount == 0 {
		if fallbackCount == 0 {
			return nil
		}

		best := fallback[0]
		bestScore := best.instantScore()

		for i := 1; i < fallbackCount; i++ {
			if score := fallback[i].instantScore(); score < bestScore {
				best, bestScore = fallback[i], score
			}
		}

		return best
	}

	if poolCount == 1 {
		return pool[0]
	}

	// The two comparison policies exist so the report can put numbers against
	// the claim that the performance-based one is worth having, rather than
	// asserting it. Neither is the deployed default.
	switch policy {
	case policyRoundRobin:
		// A fixed rotation. It ignores how loaded each backend is, which is
		// exactly what makes it the baseline rather than the answer.
		return pool[int(roundRobin.Add(1)%uint64(poolCount))]

	case policyLeastLoad:
		// Always the lowest score, with no threshold and no weighting. Useful
		// for showing what the threshold is actually buying.
		best := pool[0]
		bestScore := best.instantScore()
		for i := 1; i < poolCount; i++ {
			if score := pool[i].instantScore(); score < bestScore {
				best, bestScore = pool[i], score
			}
		}
		return best
	}

	// A backend sitting right on the threshold keeps a small share rather than
	// dropping to nothing: it has not crossed the line, and a share of zero
	// either side of one probe is how a backend ends up flapping.
	const minWeight = 0.02

	total := 0.0
	for i := 0; i < poolCount; i++ {
		headroom := threshold - pool[i].instantScore()
		if headroom < minWeight {
			headroom = minWeight
		}
		weights[i] = headroom
		total += headroom
	}

	point := rand.Float64() * total
	for i := 0; i < poolCount; i++ {
		point -= weights[i]
		if point <= 0 {
			return pool[i]
		}
	}

	return pool[poolCount-1]
}

// The cookie only governs Socket.IO. Its polling handshake is several requests
// that only the process holding the session can answer, so those have to stay
// together. The two HTTP routes are stateless and are never pinned, which is
// what lets the balancer keep moving them towards whichever backend is idle.
func stickyBackend(r *http.Request) *Backend {
	if !sticky || !isSocketIO(r.URL.Path) {
		return nil
	}

	cookie, err := r.Cookie(stickyCookie)
	if err != nil {
		return nil
	}

	id, err := strconv.Atoi(cookie.Value)
	if err != nil || id < 0 || id >= len(backends) {
		return nil
	}

	b := backends[id]

	b.mu.RLock()
	up := b.alive
	b.mu.RUnlock()

	if !up {
		return nil
	}

	b.stickyHits.Add(1)
	return b
}

func isSocketIO(path string) bool {
	return strings.HasPrefix(path, "/socket.io/")
}

// ---------------------------------------------------------------------------
// Proxying
// ---------------------------------------------------------------------------

// Wraps the real ResponseWriter for one attempt at one backend.
//
// Its job is to know whether anything has reached the client yet. The reverse
// proxy calls ErrorHandler before writing anything when a round trip fails, so
// if that happens and nothing has been written, the request can still be sent
// somewhere else and the client never learns that the first backend was tried.
type attempt struct {
	http.ResponseWriter
	code      int
	wrote     bool
	failed    bool
	abandoned bool
	failure   error
}

func (a *attempt) WriteHeader(code int) {
	a.wrote = true
	a.code = code
	a.ResponseWriter.WriteHeader(code)
}

func (a *attempt) Write(p []byte) (int, error) {
	if !a.wrote {
		a.wrote = true
		a.code = http.StatusOK
	}
	return a.ResponseWriter.Write(p)
}

// Needed for the WebSocket upgrade that Socket.IO uses once it is connected.
func (a *attempt) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	hijacker, ok := a.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, fmt.Errorf("connection cannot be hijacked")
	}
	return hijacker.Hijack()
}

func (a *attempt) Flush() {
	if flusher, ok := a.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

// Requests larger than this are forwarded straight through and not retried,
// because holding an arbitrary body in memory to be able to replay it is a
// better way to run out of memory than to survive a failure.
const maxReplayBytes = 1 << 16

func proxyHandler(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	requests.Add(1)

	// A message needs an id before it is forwarded, not after. If this request
	// has to be replayed onto a second backend, both copies carry the same id
	// and the database's unique index turns them into one stored message. An
	// id the caller supplied in the body or query string still wins: the
	// backend reads this header only when there is nothing better.
	if strings.HasPrefix(r.URL.Path, "/message") && r.Header.Get("X-Message-Id") == "" {
		r.Header.Set("X-Message-Id", nextMessageID())
	}

	upgrade := isUpgrade(r)

	// Buffer a small body so a failed attempt can be replayed. An upgrade is
	// never replayed, so it is never buffered.
	var body []byte
	replayable := true

	if r.Body != nil && !upgrade {
		if r.ContentLength > maxReplayBytes {
			replayable = false
		} else {
			limited := io.LimitReader(r.Body, maxReplayBytes+1)
			buffered, err := io.ReadAll(limited)
			if err != nil {
				http.Error(w, "could not read request body", http.StatusBadRequest)
				failures.Add(1)
				return
			}
			if len(buffered) > maxReplayBytes {
				replayable = false
			}
			body = buffered
			r.Body = io.NopCloser(bytes.NewReader(body))
		}
	}

	pinned := stickyBackend(r)
	b := pinned
	if b == nil {
		b = pick(-1)
	}

	if b == nil {
		failures.Add(1)
		http.Error(w, "no backend available", http.StatusServiceUnavailable)
		return
	}

	if sticky && pinned == nil && isSocketIO(r.URL.Path) {
		http.SetCookie(w, &http.Cookie{
			Name:   stickyCookie,
			Value:  strconv.Itoa(b.ID),
			Path:   "/",
			MaxAge: 3600,
		})
	}

	first := serveOnce(w, r, b, body)

	// One retry, on a different backend, only when the first attempt failed
	// before anything reached the client.
	if first.failed && !first.abandoned && !first.wrote && replayable && !upgrade {
		if next := pick(b.ID); next != nil {
			retried.Add(1)
			log.Printf("retrying %s %s on %s after %s failed: %v",
				r.Method, r.URL.Path, next.Host, b.Host, first.failure)

			second := serveOnce(w, r, next, body)
			finish(start, second)
			return
		}
	}

	finish(start, first)
}

// Whether a failed attempt failed because the client gave up rather than
// because the backend did.
//
// A caller that times out cancels its side of the round trip, and the proxy
// reports that cancellation the way it reports any other error. It is not the
// same thing at all: the backend may be answering perfectly and simply have
// been abandoned mid-answer. Blaming it is actively harmful, because under
// load clients time out in crowds — enough of them at once to push all three
// backends past the failure threshold within the same second and have the
// balancer start refusing traffic with "no backend available" while every
// backend is healthy. That is a load balancer manufacturing an outage out of
// impatience, and it was visible in a 300-user run on 12 September: three
// backends marked down in one second, all of them answering probes normally
// three seconds later.
//
// So: not counted against the backend, and not retried. A retry would send a
// second copy of the request to a second machine on behalf of a client that
// is no longer listening to either.
func clientGaveUp(r *http.Request, err error) bool {
	if errors.Is(err, context.Canceled) {
		return true
	}

	return r.Context().Err() != nil
}

func serveOnce(w http.ResponseWriter, r *http.Request, b *Backend, body []byte) *attempt {
	if body != nil {
		r.Body = io.NopCloser(bytes.NewReader(body))
	}

	b.served.Add(1)

	// Deferred, not written after ServeHTTP returns, because ServeHTTP does not
	// always return. When the client's connection breaks while the response is
	// being copied to it, ReverseProxy panics with http.ErrAbortHandler, which
	// net/http recovers at the top of the connection's goroutine - past this
	// function, so a plain decrement here is simply skipped.
	//
	// That turns the counter into a leak, and the counter is a routing input:
	// instantScore() reads it as a fraction of inflightReference and clamps at
	// one, so a balancer that has seen enough aborted clients believes every
	// backend is permanently at full occupancy. On 14 September, idle, this
	// balancer reported 6376, 6124 and 2781 requests in flight while all three
	// backends reported one each and the process held fourteen goroutines. The
	// instantaneous term had been pinned at its maximum for every backend for
	// hours, which does not take traffic anywhere wrong so much as it stops the
	// term from distinguishing between backends at all: every score was shifted
	// up by the same 0.25, the headroom weights collapsed towards each other,
	// and the per-request spreading that is supposed to catch a burst arriving
	// between two probes had quietly become a uniform random choice.
	//
	// Aborted clients are not rare here, they are what a load generator with a
	// timeout does to every request it gives up on: more than half of the
	// requests this balancer had served were in that state.
	b.inflight.Add(1)
	defer b.inflight.Add(-1)

	sent := time.Now()
	a := &attempt{ResponseWriter: w, code: http.StatusOK}
	b.Proxy.ServeHTTP(a, r)

	if a.failed {
		if clientGaveUp(r, a.failure) {
			a.abandoned = true
			abandoned.Add(1)
			return a
		}

		b.failures.Add(1)
		markFailure(b, a.failure)
		return a
	}

	// Socket.IO connections stay open for minutes, so timing them would swamp
	// the average with numbers that say nothing about how fast the backend is.
	if !isSocketIO(r.URL.Path) {
		b.recordLatency(time.Since(sent))
	}

	return a
}

func finish(start time.Time, a *attempt) {
	elapsed := time.Since(start)

	if a.failed {
		failures.Add(1)
		if !a.wrote {
			http.Error(a.ResponseWriter, "backend unavailable", http.StatusBadGateway)
		}
		return
	}

	if a.code >= 500 {
		failures.Add(1)
	} else {
		succeeded.Add(1)
	}

	samples.add(elapsed)
}

func isUpgrade(r *http.Request) bool {
	for _, value := range r.Header.Values("Connection") {
		if strings.Contains(strings.ToLower(value), "upgrade") {
			return true
		}
	}
	return false
}

// Message ids are generated here rather than read from a random source per
// request: a counter behind a per-process random prefix is unique across
// restarts and across the three backends, and costs nothing.
func nextMessageID() string {
	return idPrefix + strconv.FormatUint(idCounter.Add(1), 36)
}

// ---------------------------------------------------------------------------
// Probing and scoring
// ---------------------------------------------------------------------------

// Marks a backend down after enough consecutive failures. Called both by the
// prober and by a failed proxy attempt, so a backend that stops answering is
// noticed by real traffic rather than only at the next probe.
func markFailure(b *Backend, err error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	b.okStreak = 0
	b.failStreak++

	if b.alive && b.failStreak >= failureThreshold {
		b.alive = false
		log.Printf("%s marked DOWN after %d failures: %v", b.Host, b.failStreak, err)
	}
}

const (
	failureThreshold  = 3
	recoveryThreshold = 2
)

func probeLoop(client *http.Client, path string, every time.Duration) {
	ticker := time.NewTicker(every)
	defer ticker.Stop()

	for range ticker.C {
		var wg sync.WaitGroup

		for _, b := range backends {
			wg.Add(1)
			go func(b *Backend) {
				defer wg.Done()
				probe(client, b, path)
			}(b)
		}

		wg.Wait()
		timeline.add()
	}
}

func probe(client *http.Client, b *Backend, path string) {
	result, err := fetchLoad(client, b.URL.String()+path)

	b.mu.Lock()
	defer b.mu.Unlock()

	if err != nil {
		b.okStreak = 0
		b.failStreak++
		b.probe.Error = err.Error()
		b.probe.At = time.Now()

		if b.alive && b.failStreak >= failureThreshold {
			b.alive = false
			log.Printf("%s marked DOWN after %d failed probes: %v", b.Host, b.failStreak, err)
		}
		return
	}

	b.failStreak = 0
	b.okStreak++
	b.probe = result
	b.probe.At = time.Now()

	if !b.alive && b.okStreak >= recoveryThreshold {
		b.alive = true
		b.overloaded = false
		log.Printf("%s is back UP after %d good probes", b.Host, b.okStreak)
	}

	raw := weightCPU*clamp01(result.CPU) +
		weightLag*clamp01(result.LoopLagMs/lagReference) +
		weightLatency*clamp01(b.latencyMs()/latencyReference) +
		weightQueue*clamp01(float64(result.QueueDepth)/queueReference)

	if b.score == 0 {
		b.score = raw
	} else {
		b.score = scoreSmoothing*raw + (1-scoreSmoothing)*b.score
	}

	// Crossing the threshold takes traffic away; coming back takes a clear
	// margin, so a backend hovering at the line does not flip on every probe.
	switch {
	case !b.overloaded && b.score > threshold:
		b.overloaded = true
		switches.Add(1)
		log.Printf("%s over threshold (score %.3f > %.2f), routing away", b.Host, b.score, threshold)
	case b.overloaded && b.score < threshold-hysteresis:
		b.overloaded = false
		log.Printf("%s back under threshold (score %.3f), routing to it again", b.Host, b.score)
	}
}

func fetchLoad(client *http.Client, endpoint string) (probeResult, error) {
	var result probeResult

	resp, err := client.Get(endpoint)
	if err != nil {
		return result, err
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		io.Copy(io.Discard, resp.Body)
		return result, fmt.Errorf("status %d", resp.StatusCode)
	}

	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return result, err
	}

	return result, nil
}

func clamp01(v float64) float64 {
	if math.IsNaN(v) || v < 0 {
		return 0
	}
	if v > 1 {
		return 1
	}
	return v
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

// A bounded ring of recent request latencies. Bounded because the balancer is
// meant to run for days: the previous version kept every latency in a slice,
// which is a memory leak with a report attached.
type latencyRing struct {
	mu     sync.Mutex
	values []int32 // microseconds
	next   int
	full   bool
}

const latencyRingSize = 200_000

func (r *latencyRing) add(d time.Duration) {
	micros := d.Microseconds()
	if micros > math.MaxInt32 {
		micros = math.MaxInt32
	}

	r.mu.Lock()
	if r.values == nil {
		r.values = make([]int32, latencyRingSize)
	}

	r.values[r.next] = int32(micros)
	r.next++
	if r.next == len(r.values) {
		r.next = 0
		r.full = true
	}
	r.mu.Unlock()
}

func (r *latencyRing) sorted() []int32 {
	r.mu.Lock()
	count := r.next
	if r.full {
		count = len(r.values)
	}
	out := make([]int32, count)
	copy(out, r.values[:count])
	r.mu.Unlock()

	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

func (r *latencyRing) reset() {
	r.mu.Lock()
	r.next, r.full = 0, false
	r.mu.Unlock()
}

func percentile(sorted []int32, p float64) float64 {
	if len(sorted) == 0 {
		return 0
	}

	index := int(p / 100 * float64(len(sorted)))
	if index >= len(sorted) {
		index = len(sorted) - 1
	}

	return float64(sorted[index]) / 1000
}

// One row per probe sweep: what every backend looked like and where traffic
// was going. This is what the report's routing plots are drawn from.
type timelineSample struct {
	T        float64   `json:"t"`
	Score    []float64 `json:"score"`
	CPU      []float64 `json:"cpu"`
	LoopLag  []float64 `json:"loopLag"`
	Served   []int64   `json:"served"`
	Inflight []int64   `json:"inflight"`
	Over     []bool    `json:"over"`
	Alive    []bool    `json:"alive"`
}

type timelineRing struct {
	mu      sync.Mutex
	samples []timelineSample
	started time.Time
}

const timelineLimit = 20_000

func (t *timelineRing) add() {
	sample := timelineSample{T: time.Since(t.started).Seconds()}

	for _, b := range backends {
		score, alive, over, p := b.snapshot()
		sample.Score = append(sample.Score, round(score, 4))
		sample.CPU = append(sample.CPU, round(p.CPU, 4))
		sample.LoopLag = append(sample.LoopLag, round(p.LoopLagMs, 2))
		sample.Served = append(sample.Served, b.served.Load())
		sample.Inflight = append(sample.Inflight, b.inflight.Load())
		sample.Over = append(sample.Over, over)
		sample.Alive = append(sample.Alive, alive)
	}

	t.mu.Lock()
	if len(t.samples) >= timelineLimit {
		t.samples = t.samples[len(t.samples)/2:]
	}
	t.samples = append(t.samples, sample)
	t.mu.Unlock()
}

func (t *timelineRing) snapshot() []timelineSample {
	t.mu.Lock()
	defer t.mu.Unlock()

	out := make([]timelineSample, len(t.samples))
	copy(out, t.samples)
	return out
}

func (t *timelineRing) reset() {
	t.mu.Lock()
	t.samples = nil
	t.started = time.Now()
	t.mu.Unlock()
}

func round(v float64, places int) float64 {
	factor := math.Pow(10, float64(places))
	return math.Round(v*factor) / factor
}

// ---------------------------------------------------------------------------
// Admin endpoints
// ---------------------------------------------------------------------------

func statusHandler(w http.ResponseWriter, r *http.Request) {
	list := make([]map[string]any, 0, len(backends))

	for _, b := range backends {
		score, alive, over, p := b.snapshot()

		list = append(list, map[string]any{
			"id":             b.ID,
			"url":            b.URL.String(),
			"name":           p.Backend,
			"alive":          alive,
			"over_threshold": over,
			"score":          round(score, 4),
			"cpu":            round(p.CPU, 4),
			"loop_lag_ms":    p.LoopLagMs,
			"queue_depth":    p.QueueDepth,
			"feed_size":      p.FeedSize,
			"memory_used":    round(p.MemoryFraction, 4),
			"rss_mb":         p.RSSMB,
			"latency_ms":     round(b.latencyMs(), 2),
			"inflight":       b.inflight.Load(),
			"served":         b.served.Load(),
			"sticky":         b.stickyHits.Load(),
			"errors":         b.failures.Load(),
			"last_probe":     p.At.Format(time.RFC3339Nano),
			"probe_error":    p.Error,
		})
	}

	writeJSON(w, map[string]any{
		"policy":          policy,
		"threshold":       threshold,
		"hysteresis":      hysteresis,
		"sticky_socketio": sticky,
		"switches":        switches.Load(),
		"backends":        list,
	})
}

func metricsHandler(w http.ResponseWriter, r *http.Request) {
	sorted := samples.sorted()

	perBackend := map[string]int64{}
	for _, b := range backends {
		perBackend[b.Host] = b.served.Load()
	}

	writeJSON(w, map[string]any{
		"total":       requests.Load(),
		"success":     succeeded.Load(),
		"failed":      failures.Load(),
		"retried":     retried.Load(),
		"abandoned":   abandoned.Load(),
		"switches":    switches.Load(),
		"memory":      memoryStats(),
		"samples":     len(sorted),
		"p50_ms":      round(percentile(sorted, 50), 3),
		"p95_ms":      round(percentile(sorted, 95), 3),
		"p99_ms":      round(percentile(sorted, 99), 3),
		"per_backend": perBackend,
	})
}

// What this process is actually costing, which is not a curiosity here: this
// balancer shares a 512 MB cgroup with another project's service, and when the
// total goes over, the kernel kills the largest thing in it. That was this
// process, repeatedly, before the limits below were set from measurement
// rather than from guesswork.
//
// heap_mb is what Go is holding, sys_mb is what it has taken from the
// operating system and is the number the cgroup counts, and goroutines is
// what concurrency is costing, since each one owns a stack and, for a
// proxied request, connection buffers at both ends.
func memoryStats() map[string]any {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)

	return map[string]any{
		"heap_mb":    round(float64(m.HeapAlloc)/(1<<20), 1),
		"sys_mb":     round(float64(m.Sys)/(1<<20), 1),
		"stacks_mb":  round(float64(m.StackSys)/(1<<20), 1),
		"goroutines": runtime.NumGoroutine(),
		"gc_cycles":  m.NumGC,
		"limit_mb":   memoryLimit >> 20,
	}
}

func timelineHandler(w http.ResponseWriter, r *http.Request) {
	names := make([]string, 0, len(backends))
	for _, b := range backends {
		names = append(names, b.Host)
	}

	writeJSON(w, map[string]any{
		"backends":  names,
		"threshold": threshold,
		"samples":   timeline.snapshot(),
	})
}

// Clears the counters between experiments.
func resetHandler(w http.ResponseWriter, r *http.Request) {
	requests.Store(0)
	succeeded.Store(0)
	failures.Store(0)
	retried.Store(0)
	switches.Store(0)

	for _, b := range backends {
		b.served.Store(0)
		b.stickyHits.Store(0)
		b.failures.Store(0)
		b.latencyEWMA.Store(0)
	}

	samples.reset()
	timeline.reset()

	w.Write([]byte("reset done\n"))
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	encoder := json.NewEncoder(w)
	encoder.SetIndent("", "  ")
	encoder.Encode(v)
}

// ---------------------------------------------------------------------------
// Socket buffers
// ---------------------------------------------------------------------------

// How much kernel memory one connection may hold in each direction.
//
// This is the setting that keeps this container alive, and it took measuring
// to find, because everything about the symptom pointed somewhere else. The
// balancer was being killed under load on a 512 MB cgroup, so the Go heap was
// the obvious suspect; it was not the heap. At thirteen hundred connections
// the heap was 68 MB and the cgroup was at 511 MB, and the difference was
// almost entirely one line of /sys/fs/cgroup/memory.stat:
//
//	anon=68MB  file=5MB  slab=5MB  sock=426MB
//
// Socket buffers are charged to the cgroup, and Linux auto-tunes them upward
// per connection with no idea that a limit exists — about 340 KB per socket
// here, which is fine for one connection and fatal for thirteen hundred. The
// kernel then reclaims by killing the largest process in the cgroup, which is
// the balancer, for memory the balancer never allocated.
//
// Setting the buffer sizes explicitly turns auto-tuning off and makes the cost
// per connection a number we choose: 32 KB each way, so two thousand
// connections cost about 128 MB rather than 680 MB. On a local network this
// costs nothing in throughput — 32 KB against a fraction of a millisecond of
// round trip is far more in flight than any of this needs — and what it buys
// is that the ceiling stops moving with the load.
const socketBufferBytes = 32 << 10

// Applied to a socket before it is used, on both the listening sockets (from
// which accepted connections inherit it) and the connections dialled to the
// backends.
func capSocketBuffers(_, _ string, c syscall.RawConn) error {
	var setErr error

	err := c.Control(func(fd uintptr) {
		if err := syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_RCVBUF, socketBufferBytes); err != nil {
			setErr = err
			return
		}

		setErr = syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_SNDBUF, socketBufferBytes)
	})
	if err != nil {
		return err
	}

	return setErr
}

// ---------------------------------------------------------------------------
// Copy buffers
// ---------------------------------------------------------------------------

// ReverseProxy copies a backend response to the client through a 32 KB buffer
// that it allocates per request and then throws away. One buffer is nothing;
// a thousand requests in flight is 32 MB of garbage created and collected
// continuously, on a container with one core to collect it on and 512 MB to
// hold it in. Handing the proxy a pool makes those buffers be reused instead,
// which removes both the footprint and the collector work that came with it.
//
// A pooled buffer is the whole reason /feed stays affordable under load: that
// response is the largest thing this balancer moves, and it is moved through
// one of these rather than through a fresh allocation per reader.
type bufferPool struct {
	pool sync.Pool
}

func newBufferPool(size int) *bufferPool {
	return &bufferPool{
		pool: sync.Pool{
			New: func() any {
				buffer := make([]byte, size)
				return &buffer
			},
		},
	}
}

func (p *bufferPool) Get() []byte {
	return *(p.pool.Get().(*[]byte))
}

func (p *bufferPool) Put(b []byte) {
	p.pool.Put(&b)
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

// Go sees the host's core count, not the container's share of it. Left alone
// on a 120-core host it would run a 120-way scheduler and garbage collector
// inside a one-core cgroup, and spend a good part of that core on the
// contention that causes.
func applyCPULimit() int {
	raw, err := os.ReadFile("/sys/fs/cgroup/cpu.max")
	if err != nil {
		return runtime.GOMAXPROCS(0)
	}

	fields := strings.Fields(string(raw))
	if len(fields) != 2 || fields[0] == "max" {
		return runtime.GOMAXPROCS(0)
	}

	quota, err1 := strconv.ParseFloat(fields[0], 64)
	period, err2 := strconv.ParseFloat(fields[1], 64)
	if err1 != nil || err2 != nil || period <= 0 {
		return runtime.GOMAXPROCS(0)
	}

	limit := int(math.Ceil(quota / period))
	if limit < 1 {
		limit = 1
	}

	runtime.GOMAXPROCS(limit)
	return limit
}

// The same problem as GOMAXPROCS, one level down, and the one that actually
// took this process out: Go sizes its garbage collector against the memory it
// believes it has. By default it lets the heap grow to twice the live set
// before collecting, and on a host that reports 128 GB it has no reason to
// stop. Inside a 512 MB cgroup shared with another project's service, the
// kernel reaches its limit long before Go reaches its own, and the process is
// killed rather than collected.
//
// Measured, this is not hypothetical. A grading run on 12 September killed the
// balancer three times in forty seconds; nearly half of that run's requests
// failed, and every backend stayed healthy throughout. The balancer was the
// only thing that died.
//
// A soft memory limit inverts that: as the heap approaches the budget the
// collector runs continuously instead of growing, so the process trades
// throughput for staying alive. It is a ceiling to be approached, not a
// target, which is why the allocation itself is also cut back (the buffer
// pool and the smaller connection buffers below) rather than relying on this
// alone. A limit that the live heap genuinely exceeds only turns an
// out-of-memory kill into a collector spinning on one core.
//
// The share is deliberately well under the cgroup. This container also runs an
// unrelated service of about 150 MB that is not ours to move, plus the page
// cache, and being a good neighbour here is also self-interest: the kernel
// picks its victim by size, and for most of this container's life that was us.
func applyMemoryLimit() int64 {
	const fallbackMB = 192

	budget := int64(fallbackMB) << 20

	if raw := strings.TrimSpace(os.Getenv("LB_MEMORY_MB")); raw != "" {
		if mb, err := strconv.ParseInt(raw, 10, 64); err == nil && mb > 0 {
			debug.SetMemoryLimit(mb << 20)
			return mb << 20
		}
	}

	raw, err := os.ReadFile("/sys/fs/cgroup/memory.max")
	if err == nil {
		text := strings.TrimSpace(string(raw))
		if text != "max" {
			if total, err := strconv.ParseInt(text, 10, 64); err == nil && total > 0 {
				budget = total * 40 / 100
			}
		}
	}

	debug.SetMemoryLimit(budget)
	return budget
}

func main() {
	listenAddr := flag.String("listen", ":4000", "plain HTTP port")
	tlsListen := flag.String("tls-listen", ":3000", "HTTPS port, needs -tls-cert and -tls-key")
	list := flag.String("backends", "", "comma separated backend urls")
	loadPath := flag.String("load-path", "/lb/load", "endpoint on each backend that reports its load")
	probeEvery := flag.Duration("probe-interval", 300*time.Millisecond, "how often to ask each backend how loaded it is")
	thresholdFlag := flag.Float64("threshold", 0.30, "load score above which a backend stops receiving new requests")
	hysteresisFlag := flag.Float64("hysteresis", 0.08, "how far back under the threshold a backend must come to be used again")
	policyFlag := flag.String("policy", policyPerformance,
		"performance (threshold plus headroom weighting), roundrobin, or least-load")
	useSticky := flag.Bool("sticky", true, "pin Socket.IO sessions to one backend with a cookie")
	tlsCert := flag.String("tls-cert", "", "PEM certificate")
	tlsKey := flag.String("tls-key", "", "PEM private key")
	flag.Parse()

	if *list == "" {
		log.Fatal("give me some backends with -backends")
	}

	procs := applyCPULimit()
	memoryLimit = applyMemoryLimit()
	memoryBudget := memoryLimit

	threshold = *thresholdFlag
	hysteresis = *hysteresisFlag
	sticky = *useSticky
	policy = *policyFlag

	switch policy {
	case policyPerformance, policyRoundRobin, policyLeastLoad:
	default:
		log.Fatalf("unknown policy %q", policy)
	}
	timeline.started = time.Now()

	seed := make([]byte, 6)
	if _, err := crand.Read(seed); err != nil {
		log.Fatalf("could not seed message ids: %v", err)
	}
	idPrefix = "lb-" + hex.EncodeToString(seed) + "-"

	// One transport, shared by every backend. Sharing it means one connection
	// pool and one set of idle connections rather than three, and the default
	// of two idle connections per host is what capped the previous version at
	// a few hundred requests a second.
	//
	// The buffer sizes are per connection and are held for as long as the
	// connection is idle, so they multiply by the pool size rather than by the
	// number of requests: 512 idle connections to each of three backends at
	// 32 KB in each direction is 98 MB reserved for buffers alone, which this
	// container does not have. 8 KB is comfortably more than a chat message,
	// and a /feed response simply arrives in more reads.
	//
	// MaxConnsPerHost is a cap on how much concurrency may be handed to one
	// backend at a time, and the reason to have one is that the backend is a
	// single-core Node process. Two thousand callers arriving at once cannot
	// be served any faster by opening two thousand sockets to it; all that
	// does is move the queue into the backend, where each waiting request also
	// costs a socket and a slice of an event loop that has other work to do.
	// Past the cap the transport makes the request wait here instead, in a Go
	// process with room to wait in.
	//
	// The number is set by the backends' memory rather than by their speed,
	// because every connection this balancer opens is also a socket on the
	// far side, with kernel buffers charged to that container's 512 MB. At
	// 512 connections each, three backends are being handed fifteen hundred
	// sockets; on 13 September that killed chat-1 outright, in the middle of
	// a grading run, while it was serving /feed - the largest response it has
	// and so the one with the most buffered behind it.
	//
	// 128 is still far more than a single core can retire: at the hundred
	// milliseconds a request actually takes, it is about a thousand requests
	// a second per backend, several times what any of them can do. So this
	// costs nothing in throughput and removes an entire class of failure.
	//
	// The idle timeout has to stay below the backends' keep-alive timeout, so
	// that the pool closes its connections rather than finding them already
	// closed. They are at 120 seconds.
	transport := &http.Transport{
		Proxy:                 nil,
		MaxIdleConns:          384,
		MaxIdleConnsPerHost:   128,
		MaxConnsPerHost:       128,
		IdleConnTimeout:       90 * time.Second,
		DisableCompression:    true,
		ForceAttemptHTTP2:     false,
		ExpectContinueTimeout: 0,
		WriteBufferSize:       8 << 10,
		ReadBufferSize:        8 << 10,
		DialContext: (&net.Dialer{
			Timeout:   3 * time.Second,
			KeepAlive: 30 * time.Second,
			Control:   capSocketBuffers,
		}).DialContext,
	}

	copyBuffers := newBufferPool(32 << 10)

	for i, raw := range strings.Split(*list, ",") {
		parsed, err := url.Parse(strings.TrimSpace(raw))
		if err != nil {
			log.Fatalf("bad url %s: %v", raw, err)
		}

		b := &Backend{ID: i, URL: parsed, Host: parsed.Host, alive: true}
		b.Proxy = httputil.NewSingleHostReverseProxy(parsed)
		b.Proxy.Transport = transport
		b.Proxy.BufferPool = copyBuffers
		b.Proxy.FlushInterval = -1

		host := parsed.Host
		b.Proxy.ModifyResponse = func(resp *http.Response) error {
			resp.Header.Set("X-LB-Backend", host)
			return nil
		}

		// Reached when the round trip failed, before anything has been written
		// to the client. Recording it on the attempt lets the caller decide
		// whether to try somewhere else.
		b.Proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
			if a, ok := w.(*attempt); ok {
				a.failed = true
				a.failure = err
				return
			}
			http.Error(w, "backend error", http.StatusBadGateway)
		}

		backends = append(backends, b)
		log.Printf("backend %d: %s", i, parsed)
	}

	probeClient := &http.Client{
		Timeout: 2 * time.Second,
		Transport: &http.Transport{
			MaxIdleConnsPerHost: 4,
			IdleConnTimeout:     30 * time.Second,
			DisableCompression:  true,
		},
	}

	go probeLoop(probeClient, *loadPath, *probeEvery)

	mux := http.NewServeMux()
	mux.HandleFunc("/lb/health", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("ok\n"))
	})
	mux.HandleFunc("/lb/status", statusHandler)
	mux.HandleFunc("/lb/metrics", metricsHandler)
	mux.HandleFunc("/lb/timeline", timelineHandler)
	mux.HandleFunc("/lb/reset", resetHandler)
	mux.HandleFunc("/", proxyHandler)

	newServer := func(addr string) *http.Server {
		return &http.Server{
			Addr:              addr,
			Handler:           mux,
			ReadHeaderTimeout: 10 * time.Second,
			IdleTimeout:       120 * time.Second,
			// No write timeout on purpose: a Socket.IO connection is meant to
			// stay open, and a deadline here would cut it off mid-session.
		}
	}

	log.Printf("policy: %s, threshold %.2f, hysteresis %.2f, probe every %s",
		policy, threshold, hysteresis, *probeEvery)
	log.Printf("GOMAXPROCS set to %d from the cgroup CPU limit", procs)
	log.Printf("GOMEMLIMIT set to %d MB, the share of the cgroup this process may use", memoryBudget>>20)

	errs := make(chan error, 2)

	// The listeners are built rather than left to ListenAndServe, because the
	// socket buffer size has to be set on the listening socket for accepted
	// connections to inherit it. See capSocketBuffers: this is what stops a
	// thousand clients from costing more kernel memory than the container has.
	listenConfig := &net.ListenConfig{Control: capSocketBuffers}

	listen := func(addr string) (net.Listener, error) {
		return listenConfig.Listen(context.Background(), "tcp", addr)
	}

	if *tlsCert != "" && *tlsKey != "" {
		server := newServer(*tlsListen)
		// HTTP/2 is turned off for this listener. Socket.IO's WebSocket
		// transport is an HTTP/1.1 upgrade, which HTTP/2 has no room for, so
		// leaving h2 on would quietly push every browser client onto the
		// slower long-polling transport.
		server.TLSNextProto = map[string]func(*http.Server, *tls.Conn, http.Handler){}

		ln, err := listen(*tlsListen)
		if err != nil {
			log.Fatalf("could not listen on %s: %v", *tlsListen, err)
		}

		go func() {
			log.Printf("HTTPS listening on %s", *tlsListen)
			errs <- server.ServeTLS(ln, *tlsCert, *tlsKey)
		}()
	}

	plain, err := listen(*listenAddr)
	if err != nil {
		log.Fatalf("could not listen on %s: %v", *listenAddr, err)
	}

	go func() {
		log.Printf("HTTP listening on %s (socket buffers capped at %d KB each way)",
			*listenAddr, socketBufferBytes>>10)
		errs <- newServer(*listenAddr).Serve(plain)
	}()

	log.Fatal(<-errs)
}
