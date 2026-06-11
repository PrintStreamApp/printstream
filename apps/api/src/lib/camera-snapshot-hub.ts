/**
 * Server-owned chamber snapshot polling.
 *
 * The web client declares interest in specific printer snapshot tiles.
 * While at least one client is watching a printer, this hub refreshes the
 * shared snapshot cache on a fast cadence and broadcasts a WS event so every
 * interested client can reuse the same cached frame.
 *
 * In addition, the hub keeps a slow background poll running for every online
 * camera-capable printer even when no web client is watching. That keeps the
 * shared snapshot cache reasonably fresh, so a user returning to the app after
 * an extended absence sees a recent frame instead of a stale one. The
 * background cadence is much slower than the watched cadence and is staggered
 * across printers to avoid a synchronized burst of camera reads.
 */
import type { WebSocket } from 'ws'
import type { Printer, PrinterStatus } from '@printstream/shared'
import { supportsChamberCamera } from './camera.js'
import { refreshSharedCameraSnapshot } from './camera-snapshot-cache.js'
import { printerEvents, type PrinterEventBus } from './printer-events.js'
import { printerManager } from './printer-manager.js'

/** Refresh cadence while at least one web client is watching a printer tile. */
const SNAPSHOT_INTERVAL_MS = 3_000
/** Background refresh cadence for online camera-capable printers with no viewers. */
const IDLE_SNAPSHOT_INTERVAL_MS = 20_000

interface WatchEntry {
  clients: Set<WebSocket>
  /** Keep a slow background poll running for this printer when no client watches. */
  background: boolean
  timer: NodeJS.Timeout | null
  inFlight: Promise<void> | null
}

export interface CameraSnapshotBroadcaster {
  broadcastSnapshotUpdated(printerId: string, capturedAt: number, tenantId?: string | null): void
}

type PrinterEventSubscriber = Pick<PrinterEventBus, 'on' | 'off'>

export interface CameraSnapshotHubOptions {
  snapshotIntervalMs?: number
  idleSnapshotIntervalMs?: number
  refreshSnapshot?: (printer: Printer) => Promise<unknown>
  getPrinter?: (printerId: string) => Printer | undefined
  supportsCamera?: (model: Printer['model']) => boolean
  getPrinterStatuses?: () => PrinterStatus[]
  events?: PrinterEventSubscriber
  getNow?: () => number
  /** Returns a value in [0, 1); used to stagger background polls. */
  random?: () => number
}

export class CameraSnapshotHub {
  private readonly watches = new Map<string, WatchEntry>()
  private readonly clientWatches = new Map<WebSocket, Set<string>>()

  private readonly snapshotIntervalMs: number
  private readonly idleSnapshotIntervalMs: number
  private readonly refreshSnapshot: (printer: Printer) => Promise<unknown>
  private readonly getPrinter: (printerId: string) => Printer | undefined
  private readonly supportsCamera: (model: Printer['model']) => boolean
  private readonly getPrinterStatuses: () => PrinterStatus[]
  private readonly events: PrinterEventSubscriber
  private readonly getNow: () => number
  private readonly random: () => number

  private started = false

  constructor(
    private readonly broadcaster: CameraSnapshotBroadcaster,
    options: CameraSnapshotHubOptions = {}
  ) {
    this.snapshotIntervalMs = options.snapshotIntervalMs ?? SNAPSHOT_INTERVAL_MS
    this.idleSnapshotIntervalMs = options.idleSnapshotIntervalMs ?? IDLE_SNAPSHOT_INTERVAL_MS
    this.refreshSnapshot = options.refreshSnapshot ?? refreshSharedCameraSnapshot
    this.getPrinter = options.getPrinter ?? ((printerId) => printerManager.getPrinter(printerId))
    this.supportsCamera = options.supportsCamera ?? supportsChamberCamera
    this.getPrinterStatuses = options.getPrinterStatuses ?? (() => printerManager.snapshots())
    this.events = options.events ?? printerEvents
    this.getNow = options.getNow ?? (() => Date.now())
    this.random = options.random ?? Math.random
  }

  /**
   * Begin background polling for online camera-capable printers and subscribe
   * to printer status changes so the background set tracks online state.
   */
  start(): void {
    if (this.started) return
    this.started = true

    this.events.on('status', this.handleStatus)
    this.events.on('printer.removed', this.handlePrinterRemoved)

    for (const status of this.getPrinterStatuses()) {
      this.handleStatus(status)
    }
  }

  /** Stop all polling and detach event listeners. */
  stop(): void {
    if (!this.started) return
    this.started = false

    this.events.off('status', this.handleStatus)
    this.events.off('printer.removed', this.handlePrinterRemoved)

    for (const entry of this.watches.values()) {
      this.clearTimer(entry)
    }
    this.watches.clear()
    this.clientWatches.clear()
  }

  watch(client: WebSocket, printerId: string): void {
    const printer = this.getPrinter(printerId)
    if (!printer || !this.supportsCamera(printer.model)) return

    let entry = this.watches.get(printerId)
    if (!entry) {
      entry = { clients: new Set(), background: false, timer: null, inFlight: null }
      this.watches.set(printerId, entry)
    }

    if (entry.clients.has(client)) return
    const wasIdle = entry.clients.size === 0
    entry.clients.add(client)

    let printerIds = this.clientWatches.get(client)
    if (!printerIds) {
      printerIds = new Set<string>()
      this.clientWatches.set(client, printerIds)
    }
    printerIds.add(printerId)

    if (wasIdle) {
      // First viewer: switch to the fast cadence and refresh immediately so the
      // tile updates without waiting for the next idle background poll.
      this.refreshAndSchedule(printerId, entry, true)
    }
  }

  unwatch(client: WebSocket, printerId: string): void {
    const entry = this.watches.get(printerId)
    if (!entry) return

    entry.clients.delete(client)
    const printerIds = this.clientWatches.get(client)
    printerIds?.delete(printerId)
    if (printerIds && printerIds.size === 0) {
      this.clientWatches.delete(client)
    }

    if (entry.clients.size > 0) return

    if (entry.background) {
      // Last viewer left, but keep a slow background poll alive.
      this.scheduleNext(printerId, entry)
    } else {
      this.clearTimer(entry)
      this.watches.delete(printerId)
    }
  }

  removeClient(client: WebSocket): void {
    const printerIds = this.clientWatches.get(client)
    if (!printerIds) return

    for (const printerId of [...printerIds]) {
      this.unwatch(client, printerId)
    }
  }

  private readonly handleStatus = (status: PrinterStatus): void => {
    const printer = this.getPrinter(status.printerId)
    const supported = !!printer && this.supportsCamera(printer.model)
    if (status.online && supported) {
      this.enableBackground(status.printerId)
    } else {
      this.disableBackground(status.printerId)
    }
  }

  private readonly handlePrinterRemoved = (event: { printerId: string }): void => {
    this.disableBackground(event.printerId)
  }

  private enableBackground(printerId: string): void {
    let entry = this.watches.get(printerId)
    if (!entry) {
      entry = { clients: new Set(), background: true, timer: null, inFlight: null }
      this.watches.set(printerId, entry)
      this.scheduleNext(printerId, entry, true)
      return
    }
    if (entry.background) return
    entry.background = true
    if (entry.clients.size === 0 && !entry.timer && !entry.inFlight) {
      this.scheduleNext(printerId, entry, true)
    }
  }

  private disableBackground(printerId: string): void {
    const entry = this.watches.get(printerId)
    if (!entry || !entry.background) return
    entry.background = false
    if (entry.clients.size === 0) {
      this.clearTimer(entry)
      this.watches.delete(printerId)
    }
  }

  private isActive(entry: WatchEntry): boolean {
    return entry.clients.size > 0 || entry.background
  }

  private refreshAndSchedule(printerId: string, entry: WatchEntry, immediate = false): void {
    this.clearTimer(entry)
    if (!this.isActive(entry)) return

    const run = () => {
      if (!this.isActive(entry)) return
      if (entry.inFlight) return

      const printer = this.getPrinter(printerId)
      if (!printer || !this.supportsCamera(printer.model)) {
        this.clearTimer(entry)
        this.watches.delete(printerId)
        return
      }

      entry.inFlight = Promise.resolve(this.refreshSnapshot(printer))
        .then(() => {
          this.broadcaster.broadcastSnapshotUpdated(printerId, this.getNow())
        })
        .catch(() => {
          // Best-effort; a transient camera failure should not tear down the watch.
        })
        .finally(() => {
          entry.inFlight = null
          if (this.isActive(entry)) {
            this.scheduleNext(printerId, entry)
          }
        })
    }

    if (immediate) {
      run()
      return
    }

    this.scheduleNext(printerId, entry)
  }

  private scheduleNext(printerId: string, entry: WatchEntry, stagger = false): void {
    this.clearTimer(entry)
    if (!this.isActive(entry)) return

    entry.timer = setTimeout(() => {
      entry.timer = null
      this.refreshAndSchedule(printerId, entry, true)
    }, this.nextDelayMs(entry, stagger))
  }

  private nextDelayMs(entry: WatchEntry, stagger: boolean): number {
    if (entry.clients.size > 0) {
      // Align the watched cadence to the interval boundary so refreshes for
      // multiple printers coalesce into shared broadcast ticks.
      const now = this.getNow()
      return this.snapshotIntervalMs - (now % this.snapshotIntervalMs) || this.snapshotIntervalMs
    }
    if (stagger) {
      // Spread the first background poll across the interval so many printers
      // coming online together do not all read their camera at the same moment.
      return Math.floor(this.random() * this.idleSnapshotIntervalMs)
    }
    return this.idleSnapshotIntervalMs
  }

  private clearTimer(entry: WatchEntry): void {
    if (!entry.timer) return
    clearTimeout(entry.timer)
    entry.timer = null
  }
}