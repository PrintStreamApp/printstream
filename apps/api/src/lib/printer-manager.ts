/**
 * Printer connection manager.
 *
 * Owns one MQTT connection per persisted printer. Translates Bambu's
 * `report` payloads into the normalized {@link PrinterStatus} contract
 * and emits both the snapshot and lifecycle events on the shared
 * {@link printerEvents} bus.
 *
 * Bambu printers in Developer/LAN mode accept TLS MQTT on port 8883
 * with `bblp` as the username and the printer's access code as the
 * password. The status topic is `device/<serial>/report`; commands go
 * to `device/<serial>/request`.
 *
 * Bambu MQTT reports are partial deltas: each message only contains
 * the fields that changed. We therefore keep a per-printer cached
 * {@link PrinterStatus} and merge each report into it before emitting,
 * so subscribers always see a complete snapshot.
 *
 * The parser is intentionally tolerant: unknown fields are ignored
 * rather than rejected so firmware updates do not break the connection.
 */
import {
  isPrinterActiveJobStage,
  deepEqual,
  type Printer,
  type PrinterPressureAdvanceProfile,
  type PrinterStage,
  type PrinterStatus,
  type PrinterConnectionValidation
} from '@printstream/shared'
import { env } from './env.js'
import { bridgeSessionManager } from './bridge-session-manager.js'
import { rootPrisma } from './prisma.js'
import { printerEvents } from './printer-events.js'
import {
  ensureHmsDeviceTypeDictionary,
  getHmsDeviceType
} from './hms-codes.js'
import { toPrinterDto as toPrinter } from './printer-record.js'
import {
  isObject,
  makeOfflineStatus,
  parsePressureAdvanceProfiles,
  parsePressureAdvanceProfilesFailure,
  parseReport,
  stringOrNull
} from './bambu-report-parser.js'

interface ManagedPrinter {
  printer: Printer
  status: PrinterStatus
  lastStage: PrinterStage
  lastJobName: string | null
  sequenceId: number
}

interface PendingPressureAdvanceProfilesRequest {
  timer: ReturnType<typeof setTimeout>
  resolve: (profiles: PrinterPressureAdvanceProfile[]) => void
  reject: (error: Error) => void
}

const PRESSURE_ADVANCE_REQUEST_TIMEOUT_MS = 5_000
const LOG_MQTT_TRAFFIC = env.MQTT_DEBUG_LOGS

/**
 * Grace window before a bridge-session disconnect surfaces its printers as
 * offline. Bridge sessions reconnect within seconds (a reverse-proxy idle
 * reap, an API redeploy, a brief network drop), so blanking the whole fleet
 * offline the instant the socket closes makes every printer flicker offline on
 * each blip. A fresh report from the owning bridge inside this window cancels
 * the pending offline; only a disconnect that outlasts it is a real outage.
 */
const BRIDGE_OFFLINE_GRACE_MS = 15_000

class PrinterManager {
  private readonly managed = new Map<string, ManagedPrinter>()
  private readonly tenantIds = new Map<string, string>()
  private readonly bridgeIds = new Map<string, string | null>()
  private readonly pendingPressureAdvanceProfiles = new Map<string, PendingPressureAdvanceProfilesRequest>()
  // Per-printer timers that defer a bridge-disconnect offline through the grace
  // window above. Keyed by printerId; cancelled when the bridge reports again.
  private readonly pendingOfflineTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private started = false

  async start(): Promise<void> {
    if (this.started) return
    this.started = true

    const rows = await rootPrisma.printer.findMany({ orderBy: { position: 'asc' } })
    const printers = rows.map((row) => toPrinter(row))
    const deviceTypes = new Set<string>()
    for (const printer of printers) {
      const deviceType = getHmsDeviceType(printer.serial)
      if (deviceType) deviceTypes.add(deviceType)
    }

    await Promise.all(Array.from(deviceTypes, async (deviceType) => {
      await ensureHmsDeviceTypeDictionary(deviceType)
    }))

    for (const printer of printers) {
      const row = rows.find((candidate) => candidate.id === printer.id)
      if (row) this.tenantIds.set(printer.id, row.tenantId)
      this.bridgeIds.set(printer.id, row?.bridgeId ?? null)
      this.connect(printer)
    }
  }

  async stop(): Promise<void> {
    for (const entry of this.managed.values()) {
      this.clearPendingPressureAdvanceRequests(entry.printer.id, 'Printer connection stopped')
    }
    for (const timer of this.pendingOfflineTimers.values()) clearTimeout(timer)
    this.pendingOfflineTimers.clear()
    this.managed.clear()
    this.tenantIds.clear()
    this.bridgeIds.clear()
    this.started = false
  }

  add(printer: Printer, tenantId?: string, bridgeId: string | null = null): void {
    if (this.managed.has(printer.id)) {
      this.update(printer, tenantId, bridgeId)
      return
    }
    if (tenantId) this.tenantIds.set(printer.id, tenantId)
    this.bridgeIds.set(printer.id, bridgeId)
    this.connect(printer)
    printerEvents.emit('printer.added', printer)
  }

  update(printer: Printer, tenantId?: string, bridgeId: string | null = null): void {
    const existing = this.managed.get(printer.id)
    if (!existing) {
      if (tenantId) this.tenantIds.set(printer.id, tenantId)
      this.bridgeIds.set(printer.id, bridgeId)
      this.connect(printer)
      printerEvents.emit('printer.added', printer)
      return
    }
    if (tenantId) this.tenantIds.set(printer.id, tenantId)
    const previousBridgeId = this.bridgeIds.get(printer.id) ?? null
    this.bridgeIds.set(printer.id, bridgeId)
    const hostChanged = existing.printer.host !== printer.host
    const accessChanged = existing.printer.accessCode !== printer.accessCode
    const serialChanged = existing.printer.serial !== printer.serial
    const bridgeChanged = previousBridgeId !== bridgeId
    existing.printer = printer
    existing.status = { ...existing.status, printerId: printer.id }
    printerEvents.emit('printer.updated', printer)
    if (hostChanged || accessChanged || serialChanged || bridgeChanged) {
      // Reconnect under new credentials.
      this.clearPendingPressureAdvanceRequests(printer.id, 'Printer connection restarted')
      this.managed.delete(printer.id)
      this.connect(printer)
    }
  }

  remove(printerId: string): void {
    const existing = this.managed.get(printerId)
    if (!existing) return
    const tenantId = this.tenantIds.get(printerId)
    this.clearPendingPressureAdvanceRequests(printerId, 'Printer was removed')
    this.cancelPendingBridgePrinterOffline(printerId)
    this.managed.delete(printerId)
    this.tenantIds.delete(printerId)
    this.bridgeIds.delete(printerId)
    if (tenantId) {
      printerEvents.emit('printer.removed', {
        printerId,
        tenantId
      })
    }
  }

  /** Look up the cached tenant ID for a managed printer, if known. */
  getTenantId(printerId: string): string | undefined {
    return this.tenantIds.get(printerId)
  }

  /** Snapshot of the current cached status for every managed printer. */
  snapshots(): PrinterStatus[] {
    return Array.from(this.managed.values()).map((entry) => entry.status)
  }

  publishCommand(printerId: string, payload: Record<string, unknown>): boolean {
    return this.publishCommandWithSequence(printerId, payload) !== null
  }

  async requestPressureAdvanceProfiles(
    printerId: string,
    request: {
      filamentId: string
      extruderId: number
      nozzleDiameter: string
      nozzleTypeCode?: string | null
    }
  ): Promise<PrinterPressureAdvanceProfile[]> {
    const sequenceId = this.publishCommandWithSequence(printerId, {
      print: {
        command: 'extrusion_cali_get',
        filament_id: request.filamentId,
        extruder_id: request.extruderId,
        nozzle_id: `${request.nozzleTypeCode ?? 'HS00'}-${request.nozzleDiameter}`,
        nozzle_diameter: request.nozzleDiameter
      }
    })

    if (!sequenceId) {
      throw new Error('Printer is not connected')
    }

    const key = `${printerId}:${sequenceId}`
    return await new Promise<PrinterPressureAdvanceProfile[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingPressureAdvanceProfiles.delete(key)
        reject(new Error('Pressure-advance profile refresh timed out'))
      }, PRESSURE_ADVANCE_REQUEST_TIMEOUT_MS)

      this.pendingPressureAdvanceProfiles.set(key, { timer, resolve, reject })
    })
  }

  private publishCommandWithSequence(printerId: string, payload: Record<string, unknown>): string | null {
    const entry = this.managed.get(printerId)
    const bridgeId = this.bridgeIds.get(printerId) ?? null
    if (entry && bridgeId) {
      const nextSequenceId = ++entry.sequenceId
      const stamped = stampSequenceId(payload, nextSequenceId)
      if (LOG_MQTT_TRAFFIC) {
        console.log(`[bridge:publish] ${entry.printer.name} via ${bridgeId}`, JSON.stringify(stamped))
      }
      if (!bridgeSessionManager.sendCommand(bridgeId, entry.printer, stamped)) {
        console.warn(`[bridge:publish] bridge ${bridgeId} not connected, dropping command for printer ${printerId}`)
        return null
      }
      return String(nextSequenceId)
    }

    console.warn(`[bridge:publish] printer ${printerId} has no assigned bridge, dropping command`)
    return null
  }

  reconnect(printerId: string): boolean {
    const entry = this.managed.get(printerId)
    if (!entry) return false

    const bridgeId = this.bridgeIds.get(printerId) ?? null
    if (bridgeId) {
      return bridgeSessionManager.isConnected(bridgeId)
    }

    console.warn(`[printer:${entry.printer.name}] reconnect requested without an assigned bridge`)
    this.clearPendingPressureAdvanceRequests(printerId, 'Printer has no assigned bridge')
    this.mergeAndEmit(entry, { online: false })
    return false
  }

  /**
   * Look up the live printer record for a given id. Routes that need to
   * dispatch FTP uploads use this to avoid re-loading from Prisma.
   */
  getPrinter(printerId: string): Printer | undefined {
    return this.managed.get(printerId)?.printer
  }

  getBridgeId(printerId: string): string | null {
    return this.bridgeIds.get(printerId) ?? null
  }

  /** Most recent cached job name for the printer, if any. Used by the re-print command. */
  getLastJobName(printerId: string): string | null {
    const entry = this.managed.get(printerId)
    if (!entry) return null
    return entry.lastJobName ?? entry.status.lastJobName ?? entry.status.jobName ?? null
  }

  /** Clear the cached last-known job name surfaced on printer cards. */
  clearLastJobName(printerId: string): void {
    const entry = this.managed.get(printerId)
    if (!entry) return
    entry.lastJobName = null
    this.mergeAndEmit(entry, { lastJobName: null })
  }

  /** Most recent cached status for one managed printer. */
  getStatus(printerId: string): PrinterStatus | undefined {
    return this.managed.get(printerId)?.status
  }

  /**
   * Apply a telemetry report a bridge pushed for one of its printers. The
   * `bridgeId` is the *authenticated* reporting bridge; we drop the report unless
   * that bridge is the one this printer is actually assigned to, so a bridge can
   * never inject status for a printer it does not own (potentially in another
   * tenant). The same ownership guard applies to every `ingestBridge*` /
   * `markBridgePrinterOffline` entry point below.
   */
  ingestBridgeReport(printerId: string, report: unknown, bridgeId: string): void {
    const entry = this.managed.get(printerId)
    if (!entry || this.bridgeIds.get(printerId) !== bridgeId) return

    // A frame from the owning bridge proves the printer is reachable again, so
    // cancel any offline pending from a recent (now-recovered) session drop.
    this.cancelPendingBridgePrinterOffline(printerId)

    // Live telemetry is proof the LAN connection works, so any probe-derived
    // connection warning is stale — clear it. The periodic LAN probe opens a
    // second short-lived MQTT connection that a busy (e.g. printing) printer can
    // reject, producing a false warning the next real frame should retire.
    if (entry.status.connectionWarnings && entry.status.connectionWarnings.length > 0) {
      this.mergeAndEmit(entry, { connectionWarnings: [] })
    }

    this.resolvePressureAdvanceProfiles(entry, report)

    const delta = parseReport(report, entry.printer, entry.status)
    if (!delta) {
      if (!entry.status.online) {
        this.mergeAndEmit(entry, { online: true })
      }
      return
    }

    this.applyStatusDelta(entry, delta)
  }

  ingestBridgeStatus(status: PrinterStatus, bridgeId: string): void {
    const entry = this.managed.get(status.printerId)
    if (!entry || this.bridgeIds.get(status.printerId) !== bridgeId) return

    this.cancelPendingBridgePrinterOffline(status.printerId)
    this.applyStatusDelta(entry, status)
  }

  /**
   * Record the bridge's periodic LAN connection probe result, surfacing any
   * "not in LAN/developer mode" warning on the printer's live status so the web
   * can warn on the card. Reported separately from MQTT reports, so it merges
   * into the cached status without waiting for the next telemetry frame.
   */
  ingestBridgeConnectionValidation(printerId: string, validation: PrinterConnectionValidation, bridgeId: string): void {
    const entry = this.managed.get(printerId)
    if (!entry || this.bridgeIds.get(printerId) !== bridgeId) return
    this.mergeAndEmit(entry, { connectionWarnings: validation.ok ? [] : validation.warnings })
  }

  markBridgePrinterOffline(printerId: string, bridgeId: string): void {
    const entry = this.managed.get(printerId)
    if (!entry || this.bridgeIds.get(printerId) !== bridgeId) return
    // The bridge explicitly reported this printer offline (a real LAN/MQTT
    // drop, not a session blip), so surface it now and drop any pending grace.
    this.cancelPendingBridgePrinterOffline(printerId)
    this.clearPendingPressureAdvanceRequests(printerId, 'Bridge printer went offline')
    this.mergeAndEmit(entry, { online: false })
  }

  /**
   * The bridge's outbound session dropped. Rather than blanking every printer on
   * the bridge offline immediately — sessions reconnect within seconds and the
   * printers never actually left — start a per-printer grace timer. A fresh
   * report from the reconnected bridge cancels it; only a session that stays
   * down past {@link BRIDGE_OFFLINE_GRACE_MS} surfaces its printers as offline.
   */
  markBridgeDisconnected(bridgeId: string): void {
    for (const [printerId, printerBridgeId] of this.bridgeIds.entries()) {
      if (printerBridgeId !== bridgeId) continue
      this.scheduleBridgePrinterOffline(printerId)
    }
  }

  /** Arm the grace timer for one printer (idempotent — keeps an existing timer). */
  private scheduleBridgePrinterOffline(printerId: string): void {
    if (this.pendingOfflineTimers.has(printerId)) return
    const timer = setTimeout(() => {
      this.pendingOfflineTimers.delete(printerId)
      const entry = this.managed.get(printerId)
      if (!entry) return
      this.clearPendingPressureAdvanceRequests(printerId, 'Bridge session disconnected')
      this.mergeAndEmit(entry, { online: false })
    }, BRIDGE_OFFLINE_GRACE_MS)
    timer.unref?.()
    this.pendingOfflineTimers.set(printerId, timer)
  }

  /** Cancel a pending bridge-disconnect offline (the printer is reachable again). */
  private cancelPendingBridgePrinterOffline(printerId: string): void {
    const timer = this.pendingOfflineTimers.get(printerId)
    if (!timer) return
    clearTimeout(timer)
    this.pendingOfflineTimers.delete(printerId)
  }

  /**
   * Hint that a discovered printer is broadcasting again and should reconnect if
   * still offline. Scoped to the bridge that observed the discovery: serials are
   * only unique per tenant, so we act only on managed printers assigned to the
   * reporting `bridgeId` — never on a same-serial printer in another tenant/bridge.
   */
  hintOnline(serial: string, bridgeId: string): boolean {
    const offlineMatches = Array.from(this.managed.values())
      .filter((entry) =>
        entry.printer.serial === serial
        && entry.status.online !== true
        && this.bridgeIds.get(entry.printer.id) === bridgeId
      )

    let reconnected = false
    for (const entry of offlineMatches) {
      if (bridgeSessionManager.isConnected(bridgeId)) {
        this.mergeAndEmit(entry, { online: true })
        reconnected = true
        continue
      }

      reconnected = this.reconnect(entry.printer.id) || reconnected
    }
    return reconnected
  }

  private connect(printer: Printer, previousStatus?: PrinterStatus): void {
    void ensureHmsDeviceTypeDictionary(getHmsDeviceType(printer.serial))
    const bridgeId = this.bridgeIds.get(printer.id) ?? null

    if (bridgeId) {
      const entry: ManagedPrinter = {
        printer,
        status: previousStatus ?? makeOfflineStatus(printer),
        lastStage: previousStatus?.stage ?? 'unknown',
        lastJobName: previousStatus?.lastJobName ?? null,
        sequenceId: 0
      }
      this.managed.set(printer.id, entry)
      return
    }

    const entry: ManagedPrinter = {
      printer,
      status: previousStatus
        ? {
            ...previousStatus,
            online: false,
            firmwareVersion: previousStatus.firmwareVersion ?? null
          }
        : makeOfflineStatus(printer),
      lastStage: previousStatus?.stage ?? 'unknown',
      lastJobName: previousStatus?.lastJobName ?? null,
      sequenceId: 0
    }
    this.managed.set(printer.id, entry)

    console.warn(`[printer:${printer.name}] no bridge assigned; printer will remain offline until connected through a bridge`)
  }

  private handleMessage(entry: ManagedPrinter, raw: Buffer): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw.toString('utf8'))
    } catch {
      return
    }

    if (LOG_MQTT_TRAFFIC && parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>
      const summary: Record<string, unknown> = {}
      for (const [key, val] of Object.entries(obj)) {
        if (val && typeof val === 'object' && !Array.isArray(val)) {
          const inner = val as Record<string, unknown>
          summary[key] = { command: inner.command, msg: inner.msg, sequence_id: inner.sequence_id, _keys: Object.keys(inner).length }
        } else {
          summary[key] = val
        }
      }
      console.log(`[mqtt:recv] ${entry.printer.name} ←`, JSON.stringify(summary))
    }

    this.resolvePressureAdvanceProfiles(entry, parsed)

    const delta = parseReport(parsed, entry.printer, entry.status)
    if (!delta) return

    this.applyStatusDelta(entry, delta)
  }

  private mergeAndEmit(entry: ManagedPrinter, delta: Partial<PrinterStatus>): PrinterStatus {
    const previous = entry.status
    const next: PrinterStatus = {
      ...previous,
      ...delta,
      printerId: entry.printer.id,
      lastJobName: resolveLastJobName(entry, delta),
      observedAt: new Date().toISOString()
    }
    // Suppress redundant emits: bridges (and some report paths) deliver the
    // same status repeatedly, and `observedAt` is the only field that differs
    // each time. Comparing everything except `observedAt` lets genuinely new
    // data through while filtering out heartbeat duplicates, which otherwise
    // churn every downstream consumer (WS fan-out, notifications, the UI).
    if (statusEqualIgnoringObservedAt(previous, next)) {
      return previous
    }
    entry.status = next
    printerEvents.emit('status', next)
    return next
  }

  private applyStatusDelta(entry: ManagedPrinter, delta: Partial<PrinterStatus>): PrinterStatus {
    const previousStatus = entry.status
    const merged = this.mergeAndEmit(entry, { ...delta, online: true })

    const previousStage = entry.lastStage
    const previousTrackedJob = isTrackedJobLifecycleStatus(previousStatus)
    const nextTrackedJob = isTrackedJobLifecycleStatus(merged)
    if (previousStage !== merged.stage || previousTrackedJob !== nextTrackedJob) {
      if (!previousTrackedJob && nextTrackedJob) {
        entry.lastJobName = merged.jobName
        printerEvents.emit('job.started', { printer: entry.printer, jobName: merged.jobName ?? '' })
      }
      if (previousTrackedJob && !nextTrackedJob) {
        printerEvents.emit('job.finished', {
          printer: entry.printer,
          jobName: entry.lastJobName ?? '',
          result: merged.stage === 'failed' ? 'failed' : 'success'
        })
      }
      entry.lastStage = merged.stage
    }

    return merged
  }

  private resolvePressureAdvanceProfiles(entry: ManagedPrinter, parsed: unknown): void {
    if (!isObject(parsed) || !isObject(parsed.print) || parsed.print.command !== 'extrusion_cali_get') return

    const sequenceId = stringOrNull(parsed.print.sequence_id)
    if (!sequenceId) return

    const key = `${entry.printer.id}:${sequenceId}`
    const pending = this.pendingPressureAdvanceProfiles.get(key)
    if (!pending) return

    this.pendingPressureAdvanceProfiles.delete(key)
    clearTimeout(pending.timer)

    const failureReason = parsePressureAdvanceProfilesFailure(parsed.print)
    if (failureReason) {
      // BambuStudio still offers the built-in Default entry when the printer
      // does not return any PA history for a preset/nozzle combination.
      // Match that behavior by treating printer-reported lookup failures as
      // an empty profile list rather than surfacing a hard request error.
      pending.resolve([])
      return
    }

    try {
      pending.resolve(parsePressureAdvanceProfiles(parsed.print))
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error('Invalid pressure-advance profile response'))
    }
  }

  private clearPendingPressureAdvanceRequests(printerId: string, reason: string): void {
    for (const [key, pending] of this.pendingPressureAdvanceProfiles.entries()) {
      if (!key.startsWith(`${printerId}:`)) continue
      clearTimeout(pending.timer)
      pending.reject(new Error(reason))
      this.pendingPressureAdvanceProfiles.delete(key)
    }
  }

}

function resolveLastJobName(entry: ManagedPrinter, delta: Partial<PrinterStatus>): string | null {
  if ('lastJobName' in delta) return delta.lastJobName ?? null
  if (typeof delta.jobName === 'string' && delta.jobName.trim() !== '') return delta.jobName
  return entry.lastJobName ?? entry.status.lastJobName ?? null
}

function isTrackedJobLifecycleStatus(status: Pick<PrinterStatus, 'stage'>): boolean {
  return isPrinterActiveJobStage(status.stage)
}

/**
 * Two statuses are equivalent for fan-out purposes when every field except the
 * `observedAt` timestamp matches. `observedAt` advances on every report, so it
 * must be excluded or no two statuses would ever compare equal.
 */
function statusEqualIgnoringObservedAt(a: PrinterStatus, b: PrinterStatus): boolean {
  if (a.observedAt === b.observedAt) return deepEqual(a, b)
  return deepEqual({ ...a, observedAt: '' }, { ...b, observedAt: '' })
}

function stampSequenceId(payload: Record<string, unknown>, sequenceId: number): Record<string, unknown> {
  // Bambu firmwares expect a `sequence_id` string inside whatever sub-object
  // the command targets (`print`, `system`, `pushing`, `info`, ...). We add
  // it non-destructively so plugins can still pass plain payloads.
  const seq = String(sequenceId)
  const next: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(payload)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const inner = value as Record<string, unknown>
      next[key] = inner.sequence_id ? inner : { ...inner, sequence_id: seq }
    } else {
      next[key] = value
    }
  }
  return next
}

export const printerManager = new PrinterManager()
