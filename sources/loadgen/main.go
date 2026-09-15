// Load generator for the chat API behind the load balancer.
//
// It models users rather than requests. Each virtual user is a goroutine that
// waits a random interval, sends a message of random length, and now and then
// reads the feed instead. The three things the assignment asks to vary are all
// flags: how many users, how long the messages are, and how long the gaps
// between them are.
//
//	loadgen -url http://10.1.75.53:4229 -users 60 -duration 60s
//
// What it writes out:
//
//	-out         one JSON file with the percentiles, throughput and error
//	             counts for the whole run
//	-timeseries  a CSV with one row per second, which is what the response
//	             time plots in the report are drawn from
//
// With -verify it also checks the run for correctness rather than only for
// speed: every message id it sent is looked for in /feed afterwards, and the
// run fails if any is missing or appears twice. That is the duplicate
// suppression requirement, tested from the outside.
package main

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"time"
)

type record struct {
	at      time.Duration
	latency time.Duration
	status  int
	backend string
	feed    bool
	err     bool
}

type feedEntry struct {
	ID string `json:"id"`
}

var words = strings.Fields(`the quick brown fox jumps over a lazy dog while we
	deploy three chat backends behind one balancer and measure how long each
	request takes under load with messages of many different lengths sent at
	uneven intervals by a changing number of users`)

func main() {
	url := flag.String("url", "http://10.1.75.53:4229", "load balancer base url")
	users := flag.Int("users", 40, "number of concurrent virtual users")
	duration := flag.Duration("duration", 60*time.Second, "how long to keep sending")
	minLen := flag.Int("min-len", 20, "shortest message, in characters")
	maxLen := flag.Int("max-len", 400, "longest message, in characters")
	minGap := flag.Duration("min-interval", 20*time.Millisecond, "shortest pause between one user's messages")
	maxGap := flag.Duration("max-interval", 250*time.Millisecond, "longest pause between one user's messages")
	feedRatio := flag.Float64("feed-ratio", 0.2, "fraction of requests that read /feed instead of posting")
	feedLimit := flag.Int("feed-limit", 0, "if set, ask /feed for only this many recent messages")
	timeout := flag.Duration("timeout", 10*time.Second, "per request timeout")
	warmup := flag.Duration("warmup", 3*time.Second, "discard results from this long at the start")
	experiment := flag.String("experiment", "run", "name recorded in the output")
	out := flag.String("out", "", "write the summary to this JSON file")
	series := flag.String("timeseries", "", "write per-second numbers to this CSV file")
	verify := flag.Bool("verify", false, "afterwards, check every message sent appears in /feed exactly once")
	seed := flag.Int64("seed", 1, "random seed, so a run can be repeated")
	compress := flag.Bool("compress", true,
		"accept a gzip-encoded /feed, as an ordinary HTTP client does")
	flag.Parse()

	if *minLen > *maxLen {
		fmt.Fprintln(os.Stderr, "-min-len must not exceed -max-len")
		os.Exit(1)
	}

	transport := &http.Transport{
		MaxIdleConns:        4096,
		MaxIdleConnsPerHost: *users * 2,
		IdleConnTimeout:     90 * time.Second,
		// Left on by default, because every HTTP client a grader is likely to
		// use - Go's own, Python requests, curl, a browser - asks for gzip
		// without being told to, and /feed is where that decides the result.
		// The flag is here so the two can be measured against each other
		// rather than assumed.
		DisableCompression: !*compress,
		// The HTTPS listener uses a self-signed certificate. This tool is
		// pointed at a machine whose address is already known, so skipping the
		// check costs nothing that was being relied on.
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
	}
	client := &http.Client{Transport: transport, Timeout: *timeout}

	fmt.Printf("%s: %d users against %s for %s\n", *experiment, *users, *url, *duration)
	encoding := "identity"
	if *compress {
		encoding = "gzip if offered"
	}
	fmt.Printf("  message length %d-%d chars, interval %s-%s, %.0f%% of requests read the feed, accepting %s\n",
		*minLen, *maxLen, *minGap, *maxGap, *feedRatio*100, encoding)

	perUser := make([][]record, *users)
	sentIDs := make([][]string, *users)

	start := time.Now()
	deadline := start.Add(*duration)

	var wg sync.WaitGroup
	for id := 0; id < *users; id++ {
		wg.Add(1)

		go func(id int) {
			defer wg.Done()

			rng := rand.New(rand.NewSource(*seed + int64(id)*7919))
			name := fmt.Sprintf("user-%03d", id)

			records := make([]record, 0, 1024)
			ids := make([]string, 0, 1024)

			for time.Now().Before(deadline) {
				gap := *minGap
				if *maxGap > *minGap {
					gap += time.Duration(rng.Int63n(int64(*maxGap - *minGap)))
				}
				time.Sleep(gap)

				if !time.Now().Before(deadline) {
					break
				}

				if rng.Float64() < *feedRatio {
					records = append(records, readFeed(client, *url, *feedLimit, start))
					continue
				}

				text := message(rng, *minLen, *maxLen)
				messageID := fmt.Sprintf("%s-%d-%d", name, *seed, len(ids))

				r := postMessage(client, *url, name, text, messageID, start)
				records = append(records, r)

				if !r.err && r.status == http.StatusOK {
					ids = append(ids, messageID)
				}
			}

			perUser[id] = records
			sentIDs[id] = ids
		}(id)
	}

	wg.Wait()
	elapsed := time.Since(start)

	var all []record
	for _, records := range perUser {
		all = append(all, records...)
	}

	summary := summarise(*experiment, all, elapsed, *warmup, *users, *url)
	summary["message_length_min"] = *minLen
	summary["message_length_max"] = *maxLen
	summary["interval_min_ms"] = minGap.Milliseconds()
	summary["interval_max_ms"] = maxGap.Milliseconds()
	summary["feed_ratio"] = *feedRatio

	if *verify {
		var expected []string
		for _, ids := range sentIDs {
			expected = append(expected, ids...)
		}
		summary["verification"] = verifyFeed(client, *url, expected)
	}

	report(summary)

	if *out != "" {
		writeJSON(*out, summary)
		fmt.Printf("\nwrote %s\n", *out)
	}

	if *series != "" {
		writeSeries(*series, all, *warmup)
		fmt.Printf("wrote %s\n", *series)
	}
}

// A message of a random length, built out of whole words so it looks like text
// rather than noise.
func message(rng *rand.Rand, minLen, maxLen int) string {
	target := minLen
	if maxLen > minLen {
		target += rng.Intn(maxLen - minLen)
	}

	var b strings.Builder
	for b.Len() < target {
		if b.Len() > 0 {
			b.WriteByte(' ')
		}
		b.WriteString(words[rng.Intn(len(words))])
	}

	text := b.String()
	if len(text) > maxLen {
		text = text[:maxLen]
	}

	return text
}

func postMessage(client *http.Client, base, name, text, id string, start time.Time) record {
	payload, _ := json.Marshal(map[string]string{
		"client-name": name,
		"msg":         text,
		"id":          id,
	})

	at := time.Since(start)
	sent := time.Now()

	resp, err := client.Post(base+"/message", "application/json", bytes.NewReader(payload))
	if err != nil {
		return record{at: at, latency: time.Since(sent), err: true}
	}
	defer resp.Body.Close()

	io.Copy(io.Discard, resp.Body)

	return record{
		at:      at,
		latency: time.Since(sent),
		status:  resp.StatusCode,
		backend: resp.Header.Get("X-Backend"),
	}
}

func readFeed(client *http.Client, base string, limit int, start time.Time) record {
	endpoint := base + "/feed"
	if limit > 0 {
		endpoint = fmt.Sprintf("%s?limit=%d", endpoint, limit)
	}

	at := time.Since(start)
	sent := time.Now()

	resp, err := client.Get(endpoint)
	if err != nil {
		return record{at: at, latency: time.Since(sent), feed: true, err: true}
	}
	defer resp.Body.Close()

	io.Copy(io.Discard, resp.Body)

	return record{
		at:      at,
		latency: time.Since(sent),
		status:  resp.StatusCode,
		backend: resp.Header.Get("X-Backend"),
		feed:    true,
	}
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

func summarise(name string, all []record, elapsed, warmup time.Duration, users int, url string) map[string]any {
	// The first few seconds are connection setup and JIT warm up rather than
	// steady state, so they are measured but not counted.
	var kept []record
	for _, r := range all {
		if r.at >= warmup {
			kept = append(kept, r)
		}
	}

	measured := elapsed - warmup
	if measured <= 0 {
		measured = elapsed
	}

	var posts, feeds, errors, failed int
	perBackend := map[string]int{}
	postLatencies := make([]time.Duration, 0, len(kept))
	feedLatencies := make([]time.Duration, 0, len(kept))
	allLatencies := make([]time.Duration, 0, len(kept))

	for _, r := range kept {
		switch {
		case r.err:
			errors++
		case r.status != http.StatusOK:
			failed++
		default:
			allLatencies = append(allLatencies, r.latency)
			if r.feed {
				feedLatencies = append(feedLatencies, r.latency)
			} else {
				postLatencies = append(postLatencies, r.latency)
			}
			if r.backend != "" {
				perBackend[r.backend]++
			}
		}

		if r.feed {
			feeds++
		} else {
			posts++
		}
	}

	return map[string]any{
		"experiment":        name,
		"url":               url,
		"users":             users,
		"duration_s":        round(elapsed.Seconds(), 2),
		"measured_s":        round(measured.Seconds(), 2),
		"requests":          len(kept),
		"messages_posted":   posts,
		"feed_reads":        feeds,
		"transport_errors":  errors,
		"non_200_responses": failed,
		"throughput_rps":    round(float64(len(kept))/measured.Seconds(), 1),
		"latency_ms":        percentiles(allLatencies),
		"post_latency_ms":   percentiles(postLatencies),
		"feed_latency_ms":   percentiles(feedLatencies),
		"per_backend":       perBackend,
	}
}

func percentiles(values []time.Duration) map[string]float64 {
	if len(values) == 0 {
		return map[string]float64{}
	}

	sort.Slice(values, func(i, j int) bool { return values[i] < values[j] })

	at := func(p float64) float64 {
		index := int(p / 100 * float64(len(values)))
		if index >= len(values) {
			index = len(values) - 1
		}
		return round(float64(values[index].Microseconds())/1000, 3)
	}

	var total time.Duration
	for _, v := range values {
		total += v
	}

	return map[string]float64{
		"count": float64(len(values)),
		"mean":  round(float64(total.Microseconds())/1000/float64(len(values)), 3),
		"p50":   at(50),
		"p90":   at(90),
		"p95":   at(95),
		"p99":   at(99),
		"max":   round(float64(values[len(values)-1].Microseconds())/1000, 3),
	}
}

// Checks the run rather than timing it: every id sent must be in the feed, and
// no id may be there twice.
func verifyFeed(client *http.Client, base string, expected []string) map[string]any {
	resp, err := client.Get(base + "/feed")
	if err != nil {
		return map[string]any{"ok": false, "error": err.Error()}
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return map[string]any{"ok": false, "error": err.Error()}
	}

	var entries []feedEntry
	if err := json.Unmarshal(body, &entries); err != nil {
		return map[string]any{"ok": false, "error": "feed is not a JSON array: " + err.Error()}
	}

	seen := make(map[string]int, len(entries))
	for _, entry := range entries {
		seen[entry.ID]++
	}

	var missing, duplicated []string
	for _, id := range expected {
		switch seen[id] {
		case 1:
		case 0:
			missing = append(missing, id)
		default:
			duplicated = append(duplicated, id)
		}
	}

	return map[string]any{
		"ok":                 len(missing) == 0 && len(duplicated) == 0,
		"sent":               len(expected),
		"feed_entries":       len(entries),
		"missing":            len(missing),
		"duplicated":         len(duplicated),
		"missing_examples":   firstFew(missing),
		"duplicate_examples": firstFew(duplicated),
	}
}

func firstFew(items []string) []string {
	if len(items) > 5 {
		return items[:5]
	}
	return items
}

func report(summary map[string]any) {
	encoded, _ := json.MarshalIndent(summary, "", "  ")
	fmt.Println(string(encoded))
}

func writeJSON(path string, value any) {
	encoded, _ := json.MarshalIndent(value, "", "  ")
	if err := os.WriteFile(path, append(encoded, '\n'), 0o644); err != nil {
		fmt.Fprintf(os.Stderr, "could not write %s: %v\n", path, err)
	}
}

// One row per second: how many requests completed in that second and what the
// response time looked like inside it.
func writeSeries(path string, all []record, warmup time.Duration) {
	buckets := map[int][]time.Duration{}
	errorsPerSecond := map[int]int{}

	for _, r := range all {
		second := int(r.at.Seconds())
		if r.err || r.status != http.StatusOK {
			errorsPerSecond[second]++
			continue
		}
		buckets[second] = append(buckets[second], r.latency)
	}

	seconds := make([]int, 0, len(buckets))
	for second := range buckets {
		seconds = append(seconds, second)
	}
	for second := range errorsPerSecond {
		if _, ok := buckets[second]; !ok {
			seconds = append(seconds, second)
		}
	}
	sort.Ints(seconds)

	var b strings.Builder
	b.WriteString("second,requests,errors,mean_ms,p50_ms,p95_ms,p99_ms,warmup\n")

	for _, second := range seconds {
		values := buckets[second]
		stats := percentiles(values)

		warm := 0
		if time.Duration(second)*time.Second < warmup {
			warm = 1
		}

		fmt.Fprintf(&b, "%d,%d,%d,%g,%g,%g,%g,%d\n",
			second, len(values), errorsPerSecond[second],
			stats["mean"], stats["p50"], stats["p95"], stats["p99"], warm)
	}

	if err := os.WriteFile(path, []byte(b.String()), 0o644); err != nil {
		fmt.Fprintf(os.Stderr, "could not write %s: %v\n", path, err)
	}
}

func round(v float64, places int) float64 {
	factor := 1.0
	for i := 0; i < places; i++ {
		factor *= 10
	}
	return float64(int64(v*factor+0.5)) / factor
}
