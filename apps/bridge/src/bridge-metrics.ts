/**
 * Bridge-local metric collection.
 *
 * The bridge keeps no telemetry runtime of its own (it stays lean for the
 * single-file SEA packaging). Instead it gathers a handful of plain-number
 * readings and ships them as a `bridge.metrics` snapshot over the existing,
 * already-authenticated bridge -> API session (see `runtime.ts`); the API
 * re-exposes them on its Prometheus endpoint, labelled by bridge/tenant. This
 * piggyback avoids any inbound scrape route — remote bridges sit behind NAT and
 * cannot be scraped directly. Mirrors the log-forwarding pattern in
 * `bridge-logs.ts`.
 */
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks'
import type { BridgeMetricsSnapshot } from '@printstream/shared'

let apiReconnectsTotal = 0
let loopDelay: IntervalHistogram | null = null

/** Count a bridge -> API session (re)connection beyond the first attempt. */
export function recordApiReconnect(): void {
  apiReconnectsTotal += 1
}

function ensureLoopDelayHistogram(): IntervalHistogram {
  if (!loopDelay) {
    loopDelay = monitorEventLoopDelay({ resolution: 20 })
    loopDelay.enable()
  }
  return loopDelay
}

/**
 * Build a snapshot of current bridge metrics. Printer counts come from the
 * caller (the runtime owns the monitor); process/loop readings are gathered
 * here. The event-loop histogram is reset after each read so the next snapshot
 * reports the mean over that interval.
 */
export function collectBridgeMetrics(input: { printersMonitored: number; printersConnected: number }): BridgeMetricsSnapshot {
  const histogram = ensureLoopDelayHistogram()
  const meanLagSeconds = histogram.mean / 1e9
  histogram.reset()
  return {
    printersMonitored: input.printersMonitored,
    printersConnected: input.printersConnected,
    eventLoopLagSeconds: Number.isFinite(meanLagSeconds) ? meanLagSeconds : 0,
    memoryRssBytes: process.memoryUsage().rss,
    apiReconnectsTotal
  }
}
