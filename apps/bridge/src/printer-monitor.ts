/**
 * Per-printer MQTT monitor for the bridge.
 *
 * Holds one persistent MQTTS connection per configured printer, forwards raw
 * status reports to the runtime, and announces offline/removed transitions
 * (`offlineAnnounced` debounces repeated offline notices). Commands publish over
 * the live client when connected; otherwise they fall back to a one-shot
 * `publishPrinterCommand`.
 *
 * Reliability (Bambu printers, especially the P1 series, stop streaming LAN
 * telemetry after a cloud/LAN mode toggle and mqtt.js can wedge a reconnect
 * under a reused clientId):
 * - A periodic `pushall` re-requests a full status snapshot so live state can't
 *   silently freeze even while the socket looks healthy.
 * - A watchdog recreates the client with a *fresh* clientId when no report has
 *   arrived for a while, instead of trusting in-place auto-reconnect to recover
 *   a stuck session — the only thing that previously fixed it was a full restart.
 *
 * When a debug capture is active, every MQTT send/receive and connection
 * transition is mirrored into the capture buffer (see `debug-capture.ts`).
 */
import mqtt, { type MqttClient } from 'mqtt'
import type { Printer } from '@printstream/shared'
import { publishPrinterCommand, MQTT_PORT } from '@printstream/bridge-runtime'
import { recordCaptureFrame } from './debug-capture.js'

/** How often the watchdog checks each printer for a stalled report stream. */
const WATCHDOG_INTERVAL_MS = 15_000
/** Recreate the connection if no MQTT report has arrived for this long. */
const STALE_AFTER_MS = 90_000
/** Re-request a full status snapshot on this cadence while connected. */
const PUSHALL_INTERVAL_MS = 30_000

interface MonitoredPrinter {
  printer: Printer
  client: MqttClient
  offlineAnnounced: boolean
  /** Epoch ms of the last MQTT report (or connect); drives the watchdog. */
  lastReportAt: number
  watchdogTimer: ReturnType<typeof setInterval> | null
  pushallTimer: ReturnType<typeof setInterval> | null
}

export class BridgePrinterMonitor {
  private readonly printers = new Map<string, MonitoredPrinter>()

  constructor(
    private readonly sendMessage: (message: unknown) => void,
    private readonly connectClient: typeof mqtt.connect = mqtt.connect
  ) {}

  updatePrinters(printers: readonly Printer[]): void {
    const nextIds = new Set(printers.map((printer) => printer.id))

    for (const printerId of this.printers.keys()) {
      if (!nextIds.has(printerId)) {
        this.removePrinter(printerId, true)
      }
    }

    for (const printer of printers) {
      this.upsertPrinter(printer)
    }
  }

  async sendCommand(printer: Printer, payload: Record<string, unknown>): Promise<void> {
    const existing = this.printers.get(printer.id)
    const topic = `device/${printer.serial}/request`
    // Tap every command (both the live-client and one-shot fallback paths) so
    // captures stay complete without `@printstream/bridge-runtime` needing to
    // know about capture.
    recordCaptureFrame({
      kind: 'mqtt',
      direction: 'tx',
      printerId: printer.id,
      printerName: printer.name,
      topic,
      payload
    })
    if (existing?.client.connected) {
      existing.client.publish(topic, JSON.stringify(payload), { qos: 1 })
      return
    }

    await publishPrinterCommand(printer, payload)
  }

  stopAll(): void {
    for (const printerId of this.printers.keys()) {
      this.removePrinter(printerId, false)
    }
  }

  /** Number of printers this bridge is monitoring (for metrics/diagnostics). */
  monitoredCount(): number {
    return this.printers.size
  }

  /** Number of monitored printers with a live MQTT connection right now. */
  connectedCount(): number {
    let count = 0
    for (const entry of this.printers.values()) {
      if (entry.client?.connected) count += 1
    }
    return count
  }

  private upsertPrinter(printer: Printer): void {
    const existing = this.printers.get(printer.id)
    if (existing) {
      if (samePrinterConnection(existing.printer, printer)) {
        existing.printer = printer
        return
      }
      this.removePrinter(printer.id, false)
    }

    const entry: MonitoredPrinter = {
      printer,
      // Replaced synchronously by createClient below.
      client: undefined as unknown as MqttClient,
      offlineAnnounced: false,
      lastReportAt: Date.now(),
      watchdogTimer: null,
      pushallTimer: null
    }
    this.printers.set(printer.id, entry)
    this.createClient(entry)
    entry.watchdogTimer = setInterval(() => this.checkWatchdog(entry), WATCHDOG_INTERVAL_MS)
    // Don't let the watchdog/pushall timers hold the process open on shutdown.
    entry.watchdogTimer.unref?.()
  }

  /**
   * Build (or rebuild) the MQTT client for an entry and wire its handlers. Each
   * call mints a new clientId (the `Date.now()` suffix), so watchdog recovery
   * gets a clean session rather than resuming a wedged one.
   */
  private createClient(entry: MonitoredPrinter): void {
    const printer = entry.printer
    entry.lastReportAt = Date.now()
    const client = this.connectClient(`mqtts://${printer.host}:${MQTT_PORT}`, {
      username: 'bblp',
      password: printer.accessCode,
      reconnectPeriod: 5_000,
      connectTimeout: 10_000,
      keepalive: 30,
      rejectUnauthorized: false,
      clientId: `bambu-bridge-${printer.id}-${process.pid}-${Date.now().toString(36)}`,
      protocolVersion: 4
    })
    entry.client = client

    client.on('connect', () => {
      if (entry.offlineAnnounced) {
        console.log(`[bridge:printer:${printer.name}] reconnected`)
      }
      entry.offlineAnnounced = false
      entry.lastReportAt = Date.now()
      this.recordConnection(printer, 'connect')
      client.subscribe(`device/${printer.serial}/report`, { qos: 0 }, (error) => {
        if (error) {
          console.error(`[bridge:printer:${printer.name}] subscribe failed`, error.message)
          this.recordConnection(printer, `subscribe failed: ${error.message}`)
          this.announceOffline(entry)
          return
        }
        this.publishToPrinter(printer, { pushing: { command: 'pushall' } })
        this.publishToPrinter(printer, { info: { command: 'get_version' } })
        this.startPushallTimer(entry)
      })
    })

    client.on('message', (topic, raw) => {
      entry.offlineAnnounced = false
      entry.lastReportAt = Date.now()
      let report: unknown
      try {
        report = JSON.parse(raw.toString('utf8'))
      } catch {
        return
      }
      recordCaptureFrame({
        kind: 'mqtt',
        direction: 'rx',
        printerId: printer.id,
        printerName: printer.name,
        topic,
        payload: report
      })
      this.sendMessage({
        type: 'bridge.printer.report',
        printerId: printer.id,
        report
      })
    })

    client.on('reconnect', () => {
      this.recordConnection(printer, 'reconnect')
      this.announceOffline(entry)
    })

    client.on('close', () => {
      this.recordConnection(printer, 'close')
      this.announceOffline(entry)
    })

    client.on('error', (error) => {
      console.error(`[bridge:printer:${printer.name}] mqtt error`, error.message)
      this.recordConnection(printer, `error: ${error.message}`)
      if (!client.connected) {
        this.announceOffline(entry)
      }
    })
  }

  /** Publish a JSON command to the printer's request topic, tapping it for capture. */
  private publishToPrinter(printer: Printer, payload: Record<string, unknown>): void {
    const entry = this.printers.get(printer.id)
    if (!entry?.client.connected) return
    const topic = `device/${printer.serial}/request`
    recordCaptureFrame({
      kind: 'mqtt',
      direction: 'tx',
      printerId: printer.id,
      printerName: printer.name,
      topic,
      payload
    })
    entry.client.publish(topic, JSON.stringify(payload), { qos: 1 })
  }

  private startPushallTimer(entry: MonitoredPrinter): void {
    this.clearPushallTimer(entry)
    entry.pushallTimer = setInterval(() => {
      if (entry.client.connected) {
        this.publishToPrinter(entry.printer, { pushing: { command: 'pushall' } })
      }
    }, PUSHALL_INTERVAL_MS)
    entry.pushallTimer.unref?.()
  }

  private clearPushallTimer(entry: MonitoredPrinter): void {
    if (entry.pushallTimer) {
      clearInterval(entry.pushallTimer)
      entry.pushallTimer = null
    }
  }

  /**
   * Recreate the connection if reports have gone silent. Bambu's broker can
   * leave a reconnecting client wedged under its reused clientId; tearing it
   * down and rebuilding with a fresh clientId is what reliably recovers (the
   * behavior previously only achieved by restarting the whole bridge process).
   */
  private checkWatchdog(entry: MonitoredPrinter): void {
    if (this.printers.get(entry.printer.id) !== entry) return
    const silentMs = Date.now() - entry.lastReportAt
    if (silentMs <= STALE_AFTER_MS) return
    console.warn(
      `[bridge:printer:${entry.printer.name}] no MQTT report for ${Math.round(silentMs / 1000)}s; recreating connection`
    )
    this.recordConnection(entry.printer, `watchdog recreate after ${Math.round(silentMs / 1000)}s silent`)
    this.clearPushallTimer(entry)
    try {
      entry.client.removeAllListeners()
      entry.client.end(true)
    } catch {
      // ignore teardown failures; we are replacing the client regardless
    }
    this.createClient(entry)
  }

  private recordConnection(printer: Printer, summary: string): void {
    recordCaptureFrame({
      kind: 'connection',
      printerId: printer.id,
      printerName: printer.name,
      summary
    })
  }

  private announceOffline(entry: MonitoredPrinter): void {
    if (entry.offlineAnnounced) return
    entry.offlineAnnounced = true
    console.warn(`[bridge:printer:${entry.printer.name}] offline`)
    this.sendMessage({ type: 'bridge.printer.offline', printerId: entry.printer.id })
  }

  private removePrinter(printerId: string, announceRemoval: boolean): void {
    const entry = this.printers.get(printerId)
    if (!entry) return
    this.printers.delete(printerId)
    if (entry.watchdogTimer) clearInterval(entry.watchdogTimer)
    this.clearPushallTimer(entry)
    // Detach handlers before force-closing so a late close/error/message event from
    // the torn-down client can't fire (e.g. announcing offline for a removed printer),
    // mirroring the watchdog recovery path.
    entry.client.removeAllListeners()
    entry.client.end(true)
    if (announceRemoval) {
      this.sendMessage({
        type: 'bridge.printer.removed',
        printerId
      })
    }
  }
}

function samePrinterConnection(left: Printer, right: Printer): boolean {
  return left.host === right.host && left.serial === right.serial && left.accessCode === right.accessCode
}
