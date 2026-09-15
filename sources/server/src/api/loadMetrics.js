'use strict';

// What this backend tells the load balancer about how busy it is.
//
// The load balancer needs a number it can compare across three machines, and
// it needs it cheaply, because it asks several times a second. So the numbers
// are sampled here on a timer and the endpoint just hands back the last
// snapshot. Reading them per request would make the measurement part of the
// load it is measuring.
//
// Four signals are collected, because no single one is enough:
//
//   cpu        the whole container's CPU use, from the cgroup. This is the
//              headline "system load" figure. It has to come from the cgroup
//              and not from /proc/stat, because /proc inside these containers
//              shows the host's 120 cores rather than the one core the
//              container is actually limited to.
//   loopLag    how long the event loop is taking to come back round. A Node
//              process waiting on the database sits at low CPU while its
//              queue grows, and only this number notices.
//   inflight   requests accepted but not yet answered. The fastest-moving
//              signal, and the one that reacts before CPU has caught up.
//   memory     the cgroup's memory use. Not part of the routing score, but
//              worth reporting: these containers have 512 MB and have been
//              OOM-killed before.

const fs = require('node:fs');
const v8 = require('node:v8');
const { monitorEventLoopDelay } = require('node:perf_hooks');

const CGROUP = '/sys/fs/cgroup';
const SAMPLE_INTERVAL_MS = 250;

// How often the event loop delay histogram takes a reading. Every reading
// carries the sampling interval itself as a floor, so an idle process reads
// back roughly this figure rather than zero. It is subtracted again below,
// which leaves 0 ms meaning "not behind" and keeps the number comparable
// between backends.
const LOOP_RESOLUTION_MS = 10;

// Reads one number out of a cgroup file, or null if this kernel does not
// expose it. Every reader below tolerates null so the server still runs on a
// machine without cgroup v2.
function readNumber(file) {
  try {
    return Number(fs.readFileSync(`${CGROUP}/${file}`, 'utf8').trim());
  } catch {
    return null;
  }
}

// Cumulative CPU microseconds used by everything in this container.
function readCpuUsage() {
  try {
    const line = fs
      .readFileSync(`${CGROUP}/cpu.stat`, 'utf8')
      .split('\n')
      .find((row) => row.startsWith('usage_usec '));

    return line ? Number(line.slice('usage_usec '.length)) : null;
  } catch {
    return null;
  }
}

// How many cores this container is allowed. "max 100000" means unlimited, in
// which case fall back to the core count the kernel reports.
function readCpuLimit() {
  try {
    const [quota, period] = fs
      .readFileSync(`${CGROUP}/cpu.max`, 'utf8')
      .trim()
      .split(/\s+/);

    if (quota === 'max') return require('node:os').cpus().length;

    return Number(quota) / Number(period);
  } catch {
    return require('node:os').cpus().length;
  }
}

class LoadMetrics {
  constructor(instance) {
    this.instance = instance;
    this.inflight = 0;
    this.cpuLimit = readCpuLimit() || 1;

    // 10 ms is fine grained enough to see a stalled loop without the timer
    // itself costing anything noticeable on a single core.
    this.loopDelay = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
    this.loopDelay.enable();

    this.lastCpuUsage = readCpuUsage();
    this.lastCpuAt = Date.now();
    this.lastProcCpu = process.cpuUsage();

    this.snapshot = this.build(0, 0);

    this.timer = setInterval(() => this.sample(), SAMPLE_INTERVAL_MS);
    // Do not hold the process open just to keep measuring it.
    this.timer.unref();
  }

  // Called by the request middleware. Kept as two plain counters because this
  // runs on every single request.
  requestStarted() {
    this.inflight += 1;
  }

  requestFinished() {
    this.inflight -= 1;
  }

  sample() {
    const now = Date.now();
    const elapsedMs = now - this.lastCpuAt;
    if (elapsedMs <= 0) return;

    // Container CPU, as a fraction of the cores this container may use.
    let cpu = 0;
    const usage = readCpuUsage();
    if (usage !== null && this.lastCpuUsage !== null) {
      cpu = (usage - this.lastCpuUsage) / (elapsedMs * 1000 * this.cpuLimit);
    }
    if (usage !== null) this.lastCpuUsage = usage;

    // This process on its own, so the report can separate the chat server from
    // anything else sharing the container.
    const procDelta = process.cpuUsage(this.lastProcCpu);
    this.lastProcCpu = process.cpuUsage();
    const procCpu = (procDelta.user + procDelta.system) / (elapsedMs * 1000 * this.cpuLimit);

    this.lastCpuAt = now;

    this.snapshot = this.build(clamp01(cpu), clamp01(procCpu));

    // The histogram measures since the last reset, so clear it every sample to
    // keep the figure current rather than an average over all of uptime.
    this.loopDelay.reset();
  }

  build(cpu, procCpu) {
    const memoryCurrent = readNumber('memory.current');
    const memoryMax = readNumber('memory.max');

    return {
      backend: this.instance,
      cpu,
      procCpu,
      loopLagMs: lagAbove(this.loopDelay.mean),
      loopLagP99Ms: lagAbove(this.loopDelay.percentile(99)),
      inflight: this.inflight,
      memoryUsed: memoryCurrent,
      memoryLimit: memoryMax,
      memoryFraction: memoryCurrent && memoryMax ? round(memoryCurrent / memoryMax, 4) : null,
      rssMB: round(process.memoryUsage.rss() / 1048576, 1),

      // Resident size alone cannot say whether this process is near trouble,
      // because most of what V8 holds is garbage it has not had a reason to
      // collect yet. The live figure is what says whether the room actually
      // fits: on 14 September chat-3's resident size was 142 MB with 24,545
      // messages held, which projected past the container's 512 MB before the
      // store's own 60,000 cap - and its live heap was a tenth of that.
      heapMB: round(v8.getHeapStatistics().used_heap_size / 1048576, 1),
      heapLimitMB: round(v8.getHeapStatistics().heap_size_limit / 1048576, 1),
      uptimeSeconds: Math.round(process.uptime()),
    };
  }

  // The snapshot plus whatever the caller wants to add, such as the write
  // queue depth and the size of the feed.
  report(extra = {}) {
    return { ...this.snapshot, inflight: this.inflight, ...extra };
  }
}

// Turns a raw histogram reading in nanoseconds into milliseconds behind
// schedule, with the sampling interval taken off.
function lagAbove(nanoseconds) {
  const milliseconds = nanoseconds / 1e6 - LOOP_RESOLUTION_MS;
  return milliseconds > 0 ? round(milliseconds, 2) : 0;
}

function clamp01(value) {
  if (!Number.isFinite(value) || value < 0) return 0;
  return value > 1 ? 1 : value;
}

function round(value, places) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

module.exports = { LoadMetrics };
