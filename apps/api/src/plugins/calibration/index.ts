/**
 * Calibration plugin (built-in, API side).
 *
 * Generates, slices, prints, and records filament and motion calibration tests:
 * pressure advance, flow ratio, temperature, retraction, max volumetric speed, and VFA. Manual tests use the normal
 * pipeline (hidden library 3MF → slicing queue → print dispatcher); the user
 * enters a measurement. X1 automatic PA observes firmware's standalone routine.
 * Values are saved for selected printers or models, a nozzle size, and a spool
 * or filament identity. Neither path writes printer-side calibration profiles.
 *
 * Extension surfaces: HTTP routes at `/api/plugins/calibration` (`routes.ts`).
 * External deps: none beyond the slicing/print pipeline, the printer event bus,
 * and Prisma. It never imports
 * another plugin: the loaded filament's spool/identity comes from the shared
 * `slotFilamentResolvers` seam (filled by whichever filament plugin is present),
 * with the printer's live AMS status filling any gaps.
 */
import { amsTrayIndex, calibrationFilamentIdentityFromTray } from '@printstream/shared'
import type { ApiPlugin } from '../../plugin/types.js'
import { rootPrisma } from '../../lib/prisma.js'
import { slotFilamentResolvers } from '../../lib/slot-filament-registry.js'
import { printerManager } from '../../lib/printer-manager.js'
import { registerCalibrationRoutes } from './routes.js'
import { handlePrintFinished, type CalibrationRunManagerDeps } from './run-manager.js'
import { AutomaticPaRuns } from './automatic-pa.js'
import { printGuards } from '../../lib/print-guards.js'

function firstNozzleDiameter(raw: string | null): string {
  if (!raw) return '0.4'
  try {
    const parsed = JSON.parse(raw) as Array<{ extruderId: number; diameter: string | null }>
    return parsed.find((entry) => entry.extruderId === 0)?.diameter ?? parsed[0]?.diameter ?? '0.4'
  } catch {
    return '0.4'
  }
}

const deps: CalibrationRunManagerDeps = {
  async resolvePrinter(db, workspaceId, printerId) {
    const printer = await db.printer.findFirst({
      where: { id: printerId, workspaceId },
      select: { id: true, model: true, bridgeId: true, currentNozzleDiameters: true, currentPlateType: true }
    })
    if (!printer) throw Object.assign(new Error('Target printer not found'), { statusCode: 404 })
    return { id: printer.id, model: printer.model, bridgeId: printer.bridgeId, nozzleDiameter: firstNozzleDiameter(printer.currentNozzleDiameters), currentPlateType: printer.currentPlateType }
  },
  async resolveSlotFilament(_db, workspaceId, printerId, amsId, slotId) {
    const status = printerManager.getStatus(printerId)
    const slot = status?.ams.find((unit) => unit.unitId === amsId)?.slots.find((entry) => entry.slot === slotId)
    // Capture the same canonical identity used by the slice picker and calibration wizard.
    const spool = await slotFilamentResolvers.resolve({ workspaceId, printerId, amsId, slotId })
    return calibrationFilamentIdentityFromTray(slot, spool)
  },
  resolveTrayIndex(printerId, amsId, slotId) {
    const status = printerManager.getStatus(printerId)
    const unit = status?.ams.find((entry) => entry.unitId === amsId)
    if (!unit) return null
    return amsTrayIndex(unit.type, amsId, slotId)
  },
}

export const calibrationPlugin: ApiPlugin = {
  name: 'calibration',
  version: '0.1.0',
  description: 'Print filament and motion calibration tests, then save the result for reuse on matching filament.',
  async register(context) {
    const automatic = new AutomaticPaRuns(rootPrisma, deps, printerManager, (message, detail) => context.logger.warn(message, detail))
    await automatic.recover()
    const removeGuard = printGuards.register(({ printerId }) => !automatic.isActive(printerId)
      ? true : { allowed: false, reason: 'Automatic pressure advance calibration is in progress' })
    registerCalibrationRoutes(context, deps, automatic)

    const onPrintFinished = (event: { printer: { id: string }; result: 'success' | 'failed' | 'cancelled' }) => {
      if (event.result !== 'success') return
      const workspaceId = printerManager.getWorkspaceId(event.printer.id)
      if (!workspaceId) return
      void handlePrintFinished(rootPrisma, workspaceId, event.printer.id, null).catch((error) => {
        context.logger.warn('Failed to advance calibration run on print finish', error instanceof Error ? error.message : error)
      })
    }
    context.printerEvents.on('print-job.finished', onPrintFinished)

    // Plugin values are slice inputs, not printer profiles. AMS owns printer-side K selection.

    context.onShutdown(() => {
      automatic.close()
      removeGuard()
      context.printerEvents.off('print-job.finished', onPrintFinished)
    })
  }
}
