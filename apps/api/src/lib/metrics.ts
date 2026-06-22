/**
 * OpenTelemetry metrics, exposed for a self-hosted Prometheus scraper.
 *
 * Opt-in: nothing here runs unless `METRICS_ENABLED` is set. When disabled,
 * `initMetrics()` is a no-op and every `record*` helper is a cheap no-op, so
 * call sites stay unconditional and the OSS/self-hosted build pulls in no
 * telemetry runtime. When enabled, `initMetrics()` lazily imports the OTel SDK,
 * wires a `MeterProvider` to a Prometheus exporter (serving `/metrics` on
 * `METRICS_PORT`), and registers the instruments below.
 *
 * OTel is the instrumentation layer on purpose: the same `record*` calls can be
 * pointed at a different/extra backend (or traces added) later without touching
 * call sites. The Prometheus port is internal — do not proxy it publicly.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks'
import type { Counter, Histogram } from '@opentelemetry/api'
import type { BridgeMetricsSnapshot } from '@printstream/shared'
import { env } from './env.js'
import { registerShutdownHook } from './shutdown-hooks.js'

/** Outcome label shared by the dispatch and slice-job duration histograms. */
export type JobOutcome = 'success' | 'failed' | 'cancelled'

/** Live readings the observable gauges pull from on each scrape. */
export interface MetricsProviders {
  wsClients: () => number
  bridgesConnected: () => number
}

/**
 * Latest metrics snapshot a connected bridge pushed over its session, plus the
 * tenant it is paired to. Re-exported on this process's Prometheus endpoint via
 * observable instruments, labelled by bridge/tenant. Entries are cleared when
 * the bridge disconnects, and a staleness guard drops any that stopped updating.
 */
interface StoredBridgeSnapshot {
  tenantId: string | null
  snapshot: BridgeMetricsSnapshot
  updatedAtMs: number
}

/** Drop a bridge's series if it stops reporting (pushes ride the ~15s heartbeat). */
const BRIDGE_SNAPSHOT_STALE_MS = 90_000

let enabled = false
let httpServerDuration: Histogram | null = null
let printDispatchDuration: Histogram | null = null
let sliceJobDuration: Histogram | null = null
let wsEventsBroadcast: Counter | null = null
let bridgeMessagesDropped: Counter | null = null
const bridgeSnapshots = new Map<string, StoredBridgeSnapshot>()

export function isMetricsEnabled(): boolean {
  return enabled
}

/**
 * Bring up the meter provider + Prometheus exporter. Safe to call once at
 * startup; a no-op (and `false`) when `METRICS_ENABLED` is off or already
 * initialized. A bind/import failure is logged and swallowed — metrics are
 * optional and must never take the API down.
 */
export async function initMetrics(providers: MetricsProviders): Promise<boolean> {
  if (enabled || !env.METRICS_ENABLED) return false

  try {
    const { MeterProvider } = await import('@opentelemetry/sdk-metrics')
    const { PrometheusExporter } = await import('@opentelemetry/exporter-prometheus')
    const { resourceFromAttributes } = await import('@opentelemetry/resources')
    const { ATTR_SERVICE_NAME } = await import('@opentelemetry/semantic-conventions')

    const exporter = new PrometheusExporter({ port: env.METRICS_PORT }, (error) => {
      if (error) {
        console.error(`[metrics] Prometheus exporter failed to bind on :${env.METRICS_PORT}`, error)
      } else {
        console.log(`[metrics] Prometheus metrics available on :${env.METRICS_PORT}/metrics`)
      }
    })

    const provider = new MeterProvider({
      resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'printstream-api' }),
      readers: [exporter]
    })
    const meter = provider.getMeter('printstream-api')

    httpServerDuration = meter.createHistogram('printstream.http.server.duration', {
      description: 'HTTP request handling duration',
      unit: 'ms'
    })
    printDispatchDuration = meter.createHistogram('printstream.print_dispatch.duration', {
      description: 'Print dispatch (upload + start) duration by outcome',
      unit: 'ms'
    })
    sliceJobDuration = meter.createHistogram('printstream.slice_job.duration', {
      description: 'Slice job duration by outcome',
      unit: 'ms'
    })
    wsEventsBroadcast = meter.createCounter('printstream.ws.events_broadcast', {
      description: 'WebSocket events fanned out to clients'
    })
    bridgeMessagesDropped = meter.createCounter('printstream.bridge.messages_dropped', {
      description: 'Inbound bridge messages dropped as malformed'
    })

    const wsClients = meter.createObservableGauge('printstream.ws.clients', {
      description: 'Currently connected WebSocket clients'
    })
    wsClients.addCallback((result) => result.observe(providers.wsClients()))

    const bridgesConnected = meter.createObservableGauge('printstream.bridges.connected', {
      description: 'Currently connected bridges'
    })
    bridgesConnected.addCallback((result) => result.observe(providers.bridgesConnected()))

    const loopDelay = monitorEventLoopDelay({ resolution: 20 })
    loopDelay.enable()
    const eventLoopLag = meter.createObservableGauge('printstream.process.event_loop_lag_seconds', {
      description: 'Mean event-loop delay since the last scrape',
      unit: 's'
    })
    eventLoopLag.addCallback((result) => {
      result.observe(loopDelay.mean / 1e9)
      loopDelay.reset()
    })

    const memory = meter.createObservableGauge('printstream.process.memory_bytes', {
      description: 'Process memory usage',
      unit: 'By'
    })
    memory.addCallback((result) => {
      const usage = process.memoryUsage()
      result.observe(usage.rss, { type: 'rss' })
      result.observe(usage.heapUsed, { type: 'heap_used' })
      result.observe(usage.heapTotal, { type: 'heap_total' })
    })

    // Bridge-reported metrics, pushed over each bridge's session and re-exposed
    // here labelled by bridge/tenant. Each callback iterates the fresh snapshots.
    const forEachFreshBridge = (
      visit: (labels: { bridge_id: string; tenant_id: string }, snapshot: BridgeMetricsSnapshot) => void
    ): void => {
      const cutoff = Date.now() - BRIDGE_SNAPSHOT_STALE_MS
      for (const [bridgeId, entry] of bridgeSnapshots) {
        if (entry.updatedAtMs < cutoff) {
          bridgeSnapshots.delete(bridgeId)
          continue
        }
        visit({ bridge_id: bridgeId, tenant_id: entry.tenantId ?? 'none' }, entry.snapshot)
      }
    }

    const bridgePrintersMonitored = meter.createObservableGauge('printstream.bridge.printers_monitored', {
      description: 'Printers a bridge is monitoring'
    })
    bridgePrintersMonitored.addCallback((result) => {
      forEachFreshBridge((labels, snapshot) => result.observe(snapshot.printersMonitored, labels))
    })

    const bridgePrintersConnected = meter.createObservableGauge('printstream.bridge.printers_connected', {
      description: 'Monitored printers with a live MQTT connection on a bridge'
    })
    bridgePrintersConnected.addCallback((result) => {
      forEachFreshBridge((labels, snapshot) => result.observe(snapshot.printersConnected, labels))
    })

    const bridgeEventLoopLag = meter.createObservableGauge('printstream.bridge.event_loop_lag_seconds', {
      description: 'Bridge process mean event-loop delay',
      unit: 's'
    })
    bridgeEventLoopLag.addCallback((result) => {
      forEachFreshBridge((labels, snapshot) => result.observe(snapshot.eventLoopLagSeconds, labels))
    })

    const bridgeMemory = meter.createObservableGauge('printstream.bridge.memory_rss_bytes', {
      description: 'Bridge process resident set size',
      unit: 'By'
    })
    bridgeMemory.addCallback((result) => {
      forEachFreshBridge((labels, snapshot) => result.observe(snapshot.memoryRssBytes, labels))
    })

    const bridgeApiReconnects = meter.createObservableCounter('printstream.bridge.api_reconnects', {
      description: 'Cumulative bridge -> API session reconnects (resets on bridge restart)'
    })
    bridgeApiReconnects.addCallback((result) => {
      forEachFreshBridge((labels, snapshot) => result.observe(snapshot.apiReconnectsTotal, labels))
    })

    registerShutdownHook(async () => {
      loopDelay.disable()
      await provider.shutdown()
    })

    enabled = true
    return true
  } catch (error) {
    console.error('[metrics] failed to initialize; metrics disabled', error)
    return false
  }
}

export function recordHttpRequest(input: { method: string; route: string; statusCode: number; durationMs: number }): void {
  httpServerDuration?.record(input.durationMs, {
    http_request_method: input.method,
    http_route: input.route,
    http_response_status_code: input.statusCode
  })
}

export function recordPrintDispatch(input: { outcome: JobOutcome; durationMs: number }): void {
  printDispatchDuration?.record(input.durationMs, { outcome: input.outcome })
}

export function recordSliceJob(input: { outcome: JobOutcome; durationMs: number }): void {
  sliceJobDuration?.record(input.durationMs, { outcome: input.outcome })
}

export function recordWsEventBroadcast(type: string): void {
  wsEventsBroadcast?.add(1, { type })
}

export function recordBridgeMessageDropped(reason: string): void {
  bridgeMessagesDropped?.add(1, { reason })
}

/** Store a bridge's latest pushed metrics snapshot (no-op when metrics are off). */
export function recordBridgeMetricsSnapshot(bridgeId: string, tenantId: string | null, snapshot: BridgeMetricsSnapshot): void {
  if (!enabled) return
  bridgeSnapshots.set(bridgeId, { tenantId, snapshot, updatedAtMs: Date.now() })
}

/** Drop a bridge's metrics when its session ends, so its series stop reporting. */
export function clearBridgeMetrics(bridgeId: string): void {
  bridgeSnapshots.delete(bridgeId)
}
