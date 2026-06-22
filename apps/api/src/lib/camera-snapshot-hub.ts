/**
 * Server-owned chamber snapshot polling.
 *
 * The web client declares interest in specific printer snapshot tiles.
 * While at least one client is watching a printer, this hub refreshes the
 * shared snapshot cache on a fast cadence and broadcasts a WS event so every
 * interested client can reuse the same cached frame.
 *
 * In addition, the hub keeps a slow background poll running for printers that
 * were *viewed recently* (within `BACKGROUND_RETENTION_MS`), even after the last
 * client stops watching. That keeps the shared snapshot cache fresh for a user
 * who steps away briefly and returns, without doing fleet-wide work for printers
 * nobody is watching: a printer that has never been viewed (or was last viewed
 * beyond the retention window) is not background-polled at all, so steady-state
 * camera reads track *viewer demand*, not printer inventory. The background
 * cadence is much slower than the watched cadence and is staggered across
 * printers to avoid a synchronized burst of camera reads.
 */
import type { WebSocket } from 'ws'
import type { Printer, PrinterStatus } from '@printstream/shared'
import { supportsChamberCamera } from './camera.js'
import { refreshSharedCameraSnapshot } from './camera-snapshot-cache.js'
import { printerEvents, type PrinterEventBus } from './printer-events.js'
import { printerManager } from './printer-manager.js'

/** Refresh cadence while at least one web client is watching a printer tile. */
const SNAPSHOT_INTERVAL_MS = 3_000
/** Background refresh cadence for recently-viewed printers with no current viewers. */
const IDLE_SNAPSHOT_INTERVAL_MS = 20_000
/**
 * How long after the last viewer leaves the hub keeps background-polling a
 * printer. Past this window an unwatched printer goes fully idle (no camera
 * reads) until someone watches it again, so background work decays with demand.
 */
const BACKGROUND_RETENTION_MS = 5 * 60_000

interface WatchEntry {
  clients: Set<WebSocket>
  /** This printer is online + camera-capable, so background polling is permitted. */
  background: boolean
  /** Epoch ms a client last watched this printer (0 = never); drives demand decay. */
  lastWatchedAt: number
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
  /** Window after the last viewer leaves during which background polling continues. */
  backgroundRetentionMs?: number
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
  private readonly backgroundRetentionMs: number
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
    this.backgroundRetentionMs = options.backgroundRetentionMs ?? BACKGROUND_RETENTION_MS
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
      entry = { clients: new Set(), background: false, lastWatchedAt: 0, timer: null, inFlight: null }
      this.watches.set(printerId, entry)
    }

    if (entry.clients.has(client)) return
    const wasIdle = entry.clients.size === 0
    entry.clients.add(client)
    entry.lastWatchedAt = this.getNow()

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

    // Anchor the decay window at the moment the last viewer leaves.
    entry.lastWatchedAt = this.getNow()
    if (this.isBackgroundEligible(entry)) {
      // Last viewer left, but keep a slow background poll alive for the
      // retention window so a quick return still sees a fresh frame.
      this.scheduleNext(printerId, entry)
    } else {
      this.clearTimer(entry)
      if (!entry.background) this.watches.delete(printerId)
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
      // Online + camera-capable, but not yet viewed: mark it background-eligible
      // without scheduling a poll. Background polling only starts once a client
      // has watched it (demand-decayed), so steady-state work tracks viewers.
      entry = { clients: new Set(), background: true, lastWatchedAt: 0, timer: null, inFlight: null }
      this.watches.set(printerId, entry)
      return
    }
    if (entry.background) return
    entry.background = true
    if (entry.clients.size === 0 && !entry.timer && !entry.inFlight && this.isBackgroundEligible(entry)) {
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

  /**
   * Background polling is eligible only for a printer that is background-flagged
   * (online + camera-capable) AND was viewed within the retention window. This
   * is the demand-decay gate: an online printer nobody has watched recently is
   * not polled at all.
   */
  private isBackgroundEligible(entry: WatchEntry): boolean {
    return entry.background
      && entry.lastWatchedAt > 0
      && (this.getNow() - entry.lastWatchedAt) <= this.backgroundRetentionMs
  }

  private isActive(entry: WatchEntry): boolean {
    return entry.clients.size > 0 || this.isBackgroundEligible(entry)
  }

  private refreshAndSchedule(printerId: string, entry: WatchEntry, immediate = false): void {
    this.clearTimer(entry)
    if (!this.started || !this.isActive(entry)) return

    const run = () => {
      if (!this.started || !this.isActive(entry)) return
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
    // Bail once stopped so an in-flight refresh's `.finally` can't resurrect a
    // timer on an entry the hub already cleared in stop().
    if (!this.started || !this.isActive(entry)) return

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