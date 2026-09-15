// Reverse proxy for Sys1, in front of the chat servers on Sys2, Sys3 and Sys4.
// Requests without the sticky cookie are round robined. Requests with it stay
// on the backend named in the cookie.
package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Backend struct {
	ID     int
	URL    *url.URL
	Proxy  *httputil.ReverseProxy
	Alive  bool
	Count  int // requests sent here by round robin
	Sticky int // requests sent here because of the cookie
	fails  int // failed health checks in a row
}

var (
	mu        sync.Mutex
	backends  []*Backend
	current   int // round robin position
	total     int
	success   int
	failed    int
	latencies []time.Duration
	sticky    bool
)

const stickyCookie = "lb_backend"

// picks the next alive backend, round robin
func nextBackend() *Backend {
	mu.Lock()
	defer mu.Unlock()

	for i := 0; i < len(backends); i++ {
		b := backends[current]
		current = (current + 1) % len(backends)
		if b.Alive {
			b.Count++
			return b
		}
	}
	return nil // everything is down
}

// Returns nil if the cookie is missing or its backend is down, so the caller
// falls back to round robin.
func stickyBackend(r *http.Request) *Backend {
	if !sticky {
		return nil
	}

	c, err := r.Cookie(stickyCookie)
	if err != nil {
		return nil
	}

	id, err := strconv.Atoi(c.Value)
	if err != nil || id < 0 || id >= len(backends) {
		return nil
	}

	mu.Lock()
	defer mu.Unlock()

	b := backends[id]
	if !b.Alive {
		return nil
	}

	b.Sticky++
	return b
}

func record(d time.Duration, ok bool) {
	mu.Lock()
	total++
	if ok {
		success++
		latencies = append(latencies, d)
	} else {
		failed++
	}
	mu.Unlock()
}

// wraps ResponseWriter to capture the status code
type recorder struct {
	http.ResponseWriter
	code int
}

func (r *recorder) WriteHeader(c int) {
	r.code = c
	r.ResponseWriter.WriteHeader(c)
}

// lets websocket upgrades through
func (r *recorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return r.ResponseWriter.(http.Hijacker).Hijack()
}

func proxyHandler(w http.ResponseWriter, r *http.Request) {
	start := time.Now()

	b := stickyBackend(r)
	pinned := b != nil

	if b == nil {
		b = nextBackend()
	}

	if b == nil {
		record(time.Since(start), false)
		http.Error(w, "no backend available", http.StatusServiceUnavailable)
		return
	}

	// Must be set before ServeHTTP. ReverseProxy overwrites this header map.
	if sticky && !pinned {
		http.SetCookie(w, &http.Cookie{
			Name:   stickyCookie,
			Value:  strconv.Itoa(b.ID),
			Path:   "/",
			MaxAge: 3600,
		})
	}

	rec := &recorder{w, http.StatusOK}
	b.Proxy.ServeHTTP(rec, r)

	record(time.Since(start), rec.code < 500)
}

// marks a backend down after three failed checks in a row
func healthCheck(path string, every time.Duration) {
	client := &http.Client{
		Timeout:   5 * time.Second,
		Transport: &http.Transport{DisableKeepAlives: true},
	}

	for {
		for _, b := range backends {
			resp, err := client.Get(b.URL.String() + path)
			good := err == nil && resp.StatusCode < 400
			if resp != nil {
				resp.Body.Close()
			}

			mu.Lock()
			if good {
				b.fails = 0
				if !b.Alive {
					log.Printf("%s is back up", b.URL)
					b.Alive = true
				}
			} else {
				b.fails++
				if b.fails >= 3 && b.Alive {
					log.Printf("%s marked down after %d failed checks: %v", b.URL, b.fails, err)
					b.Alive = false
				}
			}
			mu.Unlock()
		}
		time.Sleep(every)
	}
}

func percentile(sorted []time.Duration, p float64) float64 {
	if len(sorted) == 0 {
		return 0
	}
	i := int(p / 100 * float64(len(sorted)))
	if i >= len(sorted) {
		i = len(sorted) - 1
	}
	return float64(sorted[i].Microseconds()) / 1000
}

func statusHandler(w http.ResponseWriter, r *http.Request) {
	mu.Lock()
	defer mu.Unlock()

	out := []map[string]interface{}{}
	for _, b := range backends {
		out = append(out, map[string]interface{}{
			"id":     b.ID,
			"url":    b.URL.String(),
			"alive":  b.Alive,
			"served": b.Count,
			"sticky": b.Sticky,
		})
	}
	writeJSON(w, map[string]interface{}{
		"sticky_sessions": sticky,
		"backends":        out,
	})
}

func metricsHandler(w http.ResponseWriter, r *http.Request) {
	mu.Lock()
	defer mu.Unlock()

	sorted := make([]time.Duration, len(latencies))
	copy(sorted, latencies)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })

	perBackend := map[string]int{}
	for _, b := range backends {
		perBackend[b.URL.Host] = b.Count
	}

	writeJSON(w, map[string]interface{}{
		"total":       total,
		"success":     success,
		"failed":      failed,
		"p50_ms":      percentile(sorted, 50),
		"p95_ms":      percentile(sorted, 95),
		"p99_ms":      percentile(sorted, 99),
		"per_backend": perBackend,
	})
}

// clears the counters between experiments
func resetHandler(w http.ResponseWriter, r *http.Request) {
	mu.Lock()
	total, success, failed = 0, 0, 0
	latencies = nil
	for _, b := range backends {
		b.Count = 0
		b.Sticky = 0
	}
	mu.Unlock()
	w.Write([]byte("reset done\n"))
}

func writeJSON(w http.ResponseWriter, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	e := json.NewEncoder(w)
	e.SetIndent("", "  ")
	e.Encode(v)
}

func main() {
	listen := flag.String("listen", ":8080", "port to listen on")
	list := flag.String("backends", "", "comma separated backend urls")
	healthPath := flag.String("health-path", "/health", "path to check on backends")
	useSticky := flag.Bool("sticky", true, "pin a client to one backend with a cookie")
	// HTTPS is needed because the chat client uses WebCrypto to log in.
	tlsCert := flag.String("tls-cert", "", "PEM certificate, turns on HTTPS with -tls-key")
	tlsKey := flag.String("tls-key", "", "PEM private key")
	flag.Parse()

	if *list == "" {
		log.Fatal("give me some backends with -backends")
	}

	sticky = *useSticky

	for i, raw := range strings.Split(*list, ",") {
		u, err := url.Parse(strings.TrimSpace(raw))
		if err != nil {
			log.Fatalf("bad url %s: %v", raw, err)
		}

		b := &Backend{ID: i, URL: u, Alive: true}
		b.Proxy = httputil.NewSingleHostReverseProxy(u)

		// The default transport keeps two idle connections per host, which
		// capped the proxy at 443 req/s.
		b.Proxy.Transport = &http.Transport{
			MaxIdleConns:        512,
			MaxIdleConnsPerHost: 256,
			IdleConnTimeout:     90 * time.Second,
			DialContext: (&net.Dialer{
				Timeout:   3 * time.Second,
				KeepAlive: 30 * time.Second,
			}).DialContext,
		}

		// names the backend that answered
		b.Proxy.ModifyResponse = func(resp *http.Response) error {
			resp.Header.Set("X-LB-Backend", u.Host)
			return nil
		}

		// count a refused connection as a failed check
		b.Proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
			log.Printf("error from %s: %v", u, err)
			mu.Lock()
			b.fails++
			if b.fails >= 3 {
				b.Alive = false
			}
			mu.Unlock()
			http.Error(w, "backend error", http.StatusBadGateway)
		}

		backends = append(backends, b)
		log.Printf("added backend %s", u)
	}

	go healthCheck(*healthPath, 2*time.Second)

	http.HandleFunc("/lb/health", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("ok\n"))
	})
	http.HandleFunc("/lb/status", statusHandler)
	http.HandleFunc("/lb/metrics", metricsHandler)
	http.HandleFunc("/lb/reset", resetHandler)
	http.HandleFunc("/", proxyHandler)

	if *tlsCert != "" && *tlsKey != "" {
		log.Printf("load balancer running on %s with %d backends (sticky=%v, TLS)", *listen, len(backends), sticky)
		log.Fatal(http.ListenAndServeTLS(*listen, *tlsCert, *tlsKey, nil))
	}

	log.Printf("load balancer running on %s with %d backends (sticky=%v)", *listen, len(backends), sticky)
	log.Fatal(http.ListenAndServe(*listen, nil))
}
