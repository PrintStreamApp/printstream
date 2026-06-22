/**
 * Bridge-fed discovered printer registry.
 *
 * Bridges own LAN SSDP discovery. They periodically push their current
 * snapshot to the API over the bridge session, and this module keeps the
 * aggregated per-bridge cache plus tenant-scoped dismissals that back the
 * Add Printer UI and WS replay.
 */

import type { DiscoveredPrinter } from '@printstream/shared'
import { reconcileAdoptedPrinterHost } from './printer-discovery-reconcile.js'
import { printerEvents } from './printer-events.js'
import { printerManager } from './printer-manager.js'

const RECOVERY_HINT_COOLDOWN_MS = 30_000

interface DiscoveryEntry {
  bridgeId: string
  serial: string
  host: string
  modelCode: string | null
  model: DiscoveredPrinter['model']
  name: string | null
  firmware: string | null
  lastSeen: number
}

interface PrinterDiscoveryDeps {
  now: () => number
  reconcileHost: (discovered: { serial: string; host: string; bridgeId: string }) => Promise<boolean>
  recoverOfflinePrinter: (serial: string, bridgeId: string) => boolean
}

const defaultDeps: PrinterDiscoveryDeps = {
  now: () => Date.now(),
  reconcileHost: reconcileAdoptedPrinterHost,
  recoverOfflinePrinter: (serial, bridgeId) => printerManager.hintOnline(serial, bridgeId)
}

export class PrinterDiscovery {
  private readonly entriesByBridge = new Map<string, Map<string, DiscoveryEntry>>()
  private readonly dismissedTenantIds = new Map<string, Set<string>>()
  private readonly reconcileTasks = new Map<string, Promise<void>>()
  private readonly recoveryHints = new Map<string, number>()

  constructor(private readonly deps: PrinterDiscoveryDeps = defaultDeps) {}

  setBridgePrinters(bridgeId: string, printers: readonly DiscoveredPrinter[]): void {
    const previous = this.entriesByBridge.get(bridgeId) ?? new Map<string, DiscoveryEntry>()
    const next = new Map<string, DiscoveryEntry>()
    const now = this.deps.now()
    let changed = previous.size !== printers.length

    for (const printer of printers) {
      const entry: DiscoveryEntry = {
        bridgeId,
        serial: printer.serial,
        host: printer.host,
        modelCode: printer.modelCode,
        model: printer.model,
        name: printer.name,
        firmware: printer.firmware,
        lastSeen: Number.isFinite(Date.parse(printer.lastSeenAt)) ? Date.parse(printer.lastSeenAt) : now
      }
      next.set(entry.serial, entry)

      const previousEntry = previous.get(entry.serial)
      if (!previousEntry || previousEntry.host !== entry.host) {
        this.recoveryHints.delete(entry.serial)
        this.reconcileAdoptedPrinter(entry)
      } else {
        this.maybeRecoverOfflinePrinter(entry.serial, entry.bridgeId, now)
      }

      if (!previousEntry || this.entryChanged(previousEntry, entry)) {
        changed = true
      }
    }

    for (const serial of previous.keys()) {
      if (!next.has(serial)) {
        changed = true
        this.recoveryHints.delete(serial)
      }
    }

    this.entriesByBridge.set(bridgeId, next)
    this.pruneDismissalsForAbsentSerials()
    if (changed) this.broadcastChange()
  }

  clearBridge(bridgeId: string): void {
    const removed = this.entriesByBridge.delete(bridgeId)
    if (!removed) return

    for (const [serial] of this.recoveryHints) {
      if (!this.hasSerial(serial)) {
        this.recoveryHints.delete(serial)
      }
    }
    this.pruneDismissalsForAbsentSerials()

    this.broadcastChange()
  }

  /**
   * Drop per-tenant dismissals for serials no longer discovered on any bridge.
   * Without this, `dismissedTenantIds` grows unbounded (serial × dismissing tenant)
   * over the process lifetime as discovered printers age out, matching the
   * `recoveryHints` reconciliation already done above.
   */
  private pruneDismissalsForAbsentSerials(): void {
    for (const [serial] of this.dismissedTenantIds) {
      if (!this.hasSerial(serial)) this.dismissedTenantIds.delete(serial)
    }
  }

  reset(): void {
    this.entriesByBridge.clear()
    this.reconcileTasks.clear()
    this.recoveryHints.clear()
    this.dismissedTenantIds.clear()
  }

  /** Return a snapshot of currently-known bridge-fed discoveries. */
  list(input: { tenantId?: string | null; bridgeIds?: readonly string[] | null } = {}): DiscoveredPrinter[] {
    return this.selectEntries(input).map((entry) => this.toDto(entry))
  }

  /** Look up the current discovered record for a specific serial. */
  get(
    serial: string,
    tenantId: string | null = null,
    bridgeIds: readonly string[] | null = null
  ): DiscoveredPrinter | undefined {
    return this.list({ tenantId, bridgeIds }).find((entry) => entry.serial === serial)
  }

  /** Hide a discovered entry for a single tenant without affecting others. */
  dismiss(serial: string, tenantId: string): void {
    const dismissed = this.dismissedTenantIds.get(serial) ?? new Set<string>()
    if (dismissed.has(tenantId)) return
    dismissed.add(tenantId)
    this.dismissedTenantIds.set(serial, dismissed)
    this.broadcastChange()
  }

  /**
   * Drop a discovered entry. Called when the user adopts a printer so
   * the discovered list immediately reflects that it is no longer
   * pending adoption (the next broadcast will re-add it if relevant,
   * but by then the printer is in the main list).
   */
  forget(serial: string): void {
    let removed = false
    for (const entries of this.entriesByBridge.values()) {
      removed = entries.delete(serial) || removed
    }
    this.dismissedTenantIds.delete(serial)
    this.recoveryHints.delete(serial)
    if (removed) {
      this.broadcastChange()
    }
  }

  private broadcastChange(): void {
    printerEvents.emit('printer.discovered', this.list())
  }

  private reconcileAdoptedPrinter(entry: DiscoveryEntry): void {
    if (this.reconcileTasks.has(entry.serial)) return

    const task = this.deps.reconcileHost({ serial: entry.serial, host: entry.host, bridgeId: entry.bridgeId })
      .then(() => undefined)
      .catch((error) => {
        console.warn(
          `[discovery] failed to refresh adopted printer ${entry.serial}`,
          error instanceof Error ? error.message : error
        )
      })
      .finally(() => {
        if (this.reconcileTasks.get(entry.serial) === task) {
          this.reconcileTasks.delete(entry.serial)
        }
      })

    this.reconcileTasks.set(entry.serial, task)
  }

  private maybeRecoverOfflinePrinter(serial: string, bridgeId: string, now: number): void {
    const lastHintAt = this.recoveryHints.get(serial)
    if (lastHintAt !== undefined && now - lastHintAt < RECOVERY_HINT_COOLDOWN_MS) return

    if (this.deps.recoverOfflinePrinter(serial, bridgeId)) {
      this.recoveryHints.set(serial, now)
      return
    }

    this.recoveryHints.delete(serial)
  }

  private selectEntries(input: {
    tenantId?: string | null
    bridgeIds?: readonly string[] | null
  }): DiscoveryEntry[] {
    const bridgeIds = input.bridgeIds ? new Set(input.bridgeIds) : null
    const visibleBySerial = new Map<string, DiscoveryEntry>()

    for (const [bridgeId, entries] of this.entriesByBridge) {
      if (bridgeIds && !bridgeIds.has(bridgeId)) continue
      for (const entry of entries.values()) {
        if (input.tenantId && this.dismissedTenantIds.get(entry.serial)?.has(input.tenantId)) continue
        const current = visibleBySerial.get(entry.serial)
        if (!current || current.lastSeen < entry.lastSeen) {
          visibleBySerial.set(entry.serial, entry)
        }
      }
    }

    return Array.from(visibleBySerial.values()).sort((a, b) => (a.name ?? a.serial).localeCompare(b.name ?? b.serial))
  }

  private entryChanged(left: DiscoveryEntry, right: DiscoveryEntry): boolean {
    return left.host !== right.host
      || left.modelCode !== right.modelCode
      || left.model !== right.model
      || left.name !== right.name
      || left.firmware !== right.firmware
  }

  private hasSerial(serial: string): boolean {
    for (const entries of this.entriesByBridge.values()) {
      if (entries.has(serial)) return true
    }
    return false
  }

  private toDto(entry: DiscoveryEntry): DiscoveredPrinter {
    return {
      bridgeId: entry.bridgeId,
      serial: entry.serial,
      host: entry.host,
      modelCode: entry.modelCode,
      model: entry.model,
      name: entry.name,
      firmware: entry.firmware,
      lastSeenAt: new Date(entry.lastSeen).toISOString()
    }
  }
}

export const printerDiscovery = new PrinterDiscovery()
