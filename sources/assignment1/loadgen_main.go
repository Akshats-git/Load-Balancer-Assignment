package main

import (
	"crypto/tls"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

type result struct {
	Experiment       string  `json:"experiment"`
	Requests         int     `json:"requests"`
	Concurrency      int     `json:"concurrency"`
	Successful       int64   `json:"successful"`
	Failed           int64   `json:"failed"`
	ThroughputRPS    float64 `json:"throughput_rps"`
	DropoutPercent   float64 `json:"dropout_percent"`
	P50Ms            float64 `json:"p50_ms"`
	P95Ms            float64 `json:"p95_ms"`
	P99Ms            float64 `json:"p99_ms"`
	ElapsedSeconds   float64 `json:"elapsed_seconds"`
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

func main() {
	url := flag.String("url", "", "target URL")
	requests := flag.Int("requests", 1000, "total number of requests")
	concurrency := flag.Int("concurrency", 20, "number of concurrent workers")
	timeout := flag.Duration("timeout", 5*time.Second, "per-request timeout")
	experiment := flag.String("experiment", "run", "experiment label")
	out := flag.String("out", "", "write JSON result to this file")
	csvPath := flag.String("csv", "", "append a CSV row to this file")
	// The load balancer serves HTTPS with a self-signed certificate, which it
	// needs so browsers will expose WebCrypto to the chat client. Verification
	// is opt-out rather than off by default, so pointing this tool at a real
	// host still checks the certificate.
	insecure := flag.Bool("insecure", false, "accept a self-signed TLS certificate")
	flag.Parse()

	if *url == "" {
		fmt.Fprintln(os.Stderr, "need -url")
		os.Exit(1)
	}

	transport := &http.Transport{
		MaxIdleConnsPerHost: *concurrency,
	}
	if *insecure {
		transport.TLSClientConfig = &tls.Config{InsecureSkipVerify: true}
	}

	client := &http.Client{
		Timeout:   *timeout,
		Transport: transport,
	}

	jobs := make(chan int, *requests)
	for i := 0; i < *requests; i++ {
		jobs <- i
	}
	close(jobs)

	var success, failed int64
	var mu sync.Mutex
	var latencies []time.Duration

	var wg sync.WaitGroup
	start := time.Now()

	for w := 0; w < *concurrency; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range jobs {
				reqStart := time.Now()
				resp, err := client.Get(*url)
				d := time.Since(reqStart)
				if err != nil {
					atomic.AddInt64(&failed, 1)
					continue
				}
				io.Copy(io.Discard, resp.Body)
				resp.Body.Close()
				if resp.StatusCode >= 500 {
					atomic.AddInt64(&failed, 1)
					continue
				}
				atomic.AddInt64(&success, 1)
				mu.Lock()
				latencies = append(latencies, d)
				mu.Unlock()
			}
		}()
	}

	wg.Wait()
	elapsed := time.Since(start)

	sort.Slice(latencies, func(i, j int) bool { return latencies[i] < latencies[j] })

	total := success + failed
	res := result{
		Experiment:     *experiment,
		Requests:       *requests,
		Concurrency:    *concurrency,
		Successful:     success,
		Failed:         failed,
		ThroughputRPS:  float64(success) / elapsed.Seconds(),
		DropoutPercent: float64(failed) / float64(total) * 100,
		P50Ms:          percentile(latencies, 50),
		P95Ms:          percentile(latencies, 95),
		P99Ms:          percentile(latencies, 99),
		ElapsedSeconds: elapsed.Seconds(),
	}

	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	enc.Encode(res)

	if *out != "" {
		f, err := os.Create(*out)
		if err == nil {
			e := json.NewEncoder(f)
			e.SetIndent("", "  ")
			e.Encode(res)
			f.Close()
		}
	}

	if *csvPath != "" {
		writeHeader := false
		if _, err := os.Stat(*csvPath); os.IsNotExist(err) {
			writeHeader = true
		}
		f, err := os.OpenFile(*csvPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
		if err == nil {
			if writeHeader {
				fmt.Fprintln(f, "experiment,requests,concurrency,successful,failed,throughput_rps,dropout_percent,p50_ms,p95_ms,p99_ms,elapsed_seconds")
			}
			fmt.Fprintf(f, "%s,%d,%d,%d,%d,%.2f,%.2f,%.2f,%.2f,%.2f,%.3f\n",
				res.Experiment, res.Requests, res.Concurrency, res.Successful, res.Failed,
				res.ThroughputRPS, res.DropoutPercent, res.P50Ms, res.P95Ms, res.P99Ms, res.ElapsedSeconds)
			f.Close()
		}
	}
}
