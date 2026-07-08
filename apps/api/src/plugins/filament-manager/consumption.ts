/**
 * Consumption observer: when a print finishes successfully, decrement the
 * spools it drew from and append `print` ledger rows.
 *
 * This is the non-Bambu half of the hybrid tracking model: spools whose
 * `remainSource` is `printer` are skipped here because the status observer keeps
 * them in sync from the AMS-reported remain%. Per-slot grams come from the 3MF's
 * per-filament `usedGrams` mapped through the job's `amsMapping`; when that is
 * unavailable (e.g. raw G-code) we fall back to attributing the job's aggregate
 * grams iff exactly one tracked spool is loaded on the printer.
 *
 * Failed/cancelled prints are not decremented — the partial amount consumed is
 * unknown, mirroring how production stats bucket waste separately.
 *
 * Runs outside a request context: `rootPrisma` with explicit tenant filters.
 */
import { trayIndexToAmsSlot, type Printer } from '@printstream/shared'
import type { ApiPluginContext } from '../../plugin/types.js'
import { printerManager } from '../../lib/printer-manager.js'
import { rootPrisma } from '../../lib/prisma.js'
import { readLibraryThreeMfIndex } from '../../lib/library-three-mf.js'
import { broadcastSpoolsChanged } from './events.js'
import { recordUsage } from './store.js'

type JobFinishedEvent = {
  jobId: string
  printer: Printer
  jobName: string
  result: 'success' | 'failed' | 'cancelled'
}

/**
 * Resolve a job's `amsMapping` global tray index to the physical `(amsId, slotId)`
 * pair recorded on a loaded spool, so the right spool gets decremented. Defers to
 * the shared {@link trayIndexToAmsSlot} so AMS HT (N3S, indices 128-152) and the
 * classic `unitId * 4 + slotId` band stay in sync with the print-dispatch path.
 */
export function trayIndexToSlot(trayIndex: number): { amsId: number; slotId: number | null } | null {
  return trayIndexToAmsSlot(trayIndex)
}

export function parseAmsMapping(value: string | null): number[] | null {
  if (!value) return null
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return null
    return parsed.map((n) => (typeof n === 'number' ? n : -1))
  } catch {
    return null
  }
}

export function createConsumptionObserver(context: ApiPluginContext): (event: JobFinishedEvent) => void {
  return (event: JobFinishedEvent): void => {
    void handle(event).catch((error) => {
      context.logger.error('Failed to record filament consumption for finished job', { jobId: event.jobId, error })
    })
  }

  /** Decrement a tracked spool at a slot; returns true if one was updated. */
  async function decrementSlot(tenantId: string, printerId: string, amsId: number, slotId: number | null, grams: number, jobId: string): Promise<boolean> {
    if (!(grams > 0)) return false
    const spool = await rootPrisma.filamentSpool.findFirst({
      where: { tenantId, loadedPrinterId: printerId, loadedAmsId: amsId, loadedSlotId: slotId, deletedAt: null }
    })
    // Hybrid: printer-tracked (Bambu RFID) spools are synced from remain% elsewhere.
    if (!spool || spool.remainSource === 'printer') return false
    const next = Math.max(0, spool.remainingGrams - grams)
    await rootPrisma.filamentSpool.updateMany({ where: { id: spool.id, tenantId }, data: { remainingGrams: next } })
    await recordUsage(rootPrisma, tenantId, spool.id, { grams, source: 'print', jobId })
    return true
  }

  async function handle(event: JobFinishedEvent): Promise<void> {
    if (event.result !== 'success') return
    const tenantId = printerManager.getTenantId(event.printer.id)
    if (!tenantId || !(context.isEnabledForTenant?.(tenantId) ?? true)) return

    const job = await rootPrisma.printJob.findFirst({
      where: { id: event.jobId, tenantId },
      select: {
        plate: true,
        amsMapping: true,
        filamentUsedGrams: true,
        file: { select: { storedPath: true, ownerBridgeId: true, kind: true } }
      }
    })
    if (!job) return

    const printerId = event.printer.id
    const mapping = parseAmsMapping(job.amsMapping)
    let mutated = false

    // Preferred path: per-filament grams from the 3MF mapped through amsMapping.
    if (mapping && job.file && (job.file.kind === '3mf' || job.file.kind === 'gcode')) {
      try {
        const index = await readLibraryThreeMfIndex({ ownerBridgeId: job.file.ownerBridgeId, storedPath: job.file.storedPath })
        const plate = index.plates.find((entry) => entry.index === (job.plate ?? 1))
        if (plate) {
          for (const filament of plate.filaments) {
            const grams = filament.usedGrams
            const trayIndex = mapping[filament.id - 1]
            if (grams == null || trayIndex == null) continue
            const slot = trayIndexToSlot(trayIndex)
            if (!slot) continue
            if (await decrementSlot(tenantId, printerId, slot.amsId, slot.slotId, grams, event.jobId)) mutated = true
          }
          if (mutated) broadcastSpoolsChanged(context, tenantId)
          return
        }
      } catch (error) {
        context.logger.warn('Could not read 3MF for filament consumption; falling back to aggregate', { jobId: event.jobId, error })
      }
    }

    // Fallback: attribute the aggregate grams iff exactly one tracked spool is loaded.
    const aggregate = job.filamentUsedGrams != null ? Number(job.filamentUsedGrams) : null
    if (aggregate != null && aggregate > 0) {
      const trackedLoaded = await rootPrisma.filamentSpool.findMany({
        where: { tenantId, loadedPrinterId: printerId, deletedAt: null, NOT: { remainSource: 'printer' } }
      })
      const spool = trackedLoaded.length === 1 ? trackedLoaded[0] : undefined
      if (spool) {
        const next = Math.max(0, spool.remainingGrams - aggregate)
        await rootPrisma.filamentSpool.updateMany({ where: { id: spool.id, tenantId }, data: { remainingGrams: next } })
        await recordUsage(rootPrisma, tenantId, spool.id, { grams: aggregate, source: 'print', jobId: event.jobId })
        mutated = true
      } else {
        context.logger.info('Skipped filament consumption: could not attribute grams to a single tracked spool', {
          jobId: event.jobId,
          trackedLoaded: trackedLoaded.length
        })
      }
    }

    if (mutated) broadcastSpoolsChanged(context, tenantId)
  }
}
