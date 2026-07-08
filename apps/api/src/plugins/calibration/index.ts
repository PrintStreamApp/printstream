/**
 * Calibration plugin (built-in, API side).
 *
 * Generates, slices, prints, and records OrcaSlicer-style calibration tests:
 * pressure-advance towers and flow-ratio plates. A run flows through the normal
 * pipeline (hidden library 3MF → slicing queue → print dispatcher); the user
 * enters a measurement and the computed value is saved, keyed by printer model +
 * nozzle and scoped to a spool or a filament identity so it can be reused.
 *
 * Extension surfaces: HTTP routes at `/api/plugins/calibration` (`routes.ts`).
 * External deps: none beyond the slicing/print pipeline, the printer event bus,
 * MQTT (for the optional pressure-advance push), and Prisma. It never imports
 * another plugin — the loaded filament's spool/identity comes from the shared
 * `slotFilamentResolvers` seam (filled by whichever filament plugin is present),
 * with the printer's live AMS status filling any gaps.
 */
import { printerModelSchema, type PrinterCommand, type PrinterPressureAdvanceProfile } from '@printstream/shared'
import type { ApiPlugin } from '../../plugin/types.js'
import { rootPrisma } from '../../lib/prisma.js'
import { slotFilamentResolvers } from '../../lib/slot-filament-registry.js'
import { printerManager } from '../../lib/printer-manager.js'
import { commandToMqttPayloads, resolvePressureAdvanceCommandContext } from '../../lib/printer-command-payloads.js'
import { registerCalibrationRoutes } from './routes.js'
import { autoApplyOnLoad, handlePrintFinished, type CalibrationRunManagerDeps } from './run-manager.js'

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
  async resolvePrinter(db, tenantId, printerId) {
    const printer = await db.printer.findFirst({
      where: { id: printerId, tenantId },
      select: { id: true, model: true, bridgeId: true, currentNozzleDiameters: true, currentPlateType: true }
    })
    if (!printer) throw Object.assign(new Error('Target printer not found'), { statusCode: 404 })
    return { id: printer.id, model: printer.model, bridgeId: printer.bridgeId, nozzleDiameter: firstNozzleDiameter(printer.currentNozzleDiameters), currentPlateType: printer.currentPlateType }
  },
  async resolveSlotFilament(_db, tenantId, printerId, amsId, slotId) {
    const status = printerManager.getStatus(printerId)
    const slot = status?.ams.find((unit) => unit.unitId === amsId)?.slots.find((entry) => entry.slot === slotId)
    // Prefer the tracked spool's rich identity (brand/colour/subtype + spoolId, so the run can be
    // saved "for this spool") when a filament plugin resolves the slot; fall back to the printer's
    // live tray for the fields it reports when no spool is tracked.
    const spool = await slotFilamentResolvers.resolve({ tenantId, printerId, amsId, slotId })
    return {
      spoolId: spool?.spoolId ?? null,
      brand: spool?.brand ?? null,
      filamentType: spool?.filamentType ?? slot?.filamentType ?? null,
      materialSubtype: spool?.materialSubtype ?? null,
      colorName: spool?.colorName ?? slot?.trayName ?? null
    }
  },
  getSlotK(printerId, amsId, slotId) {
    const status = printerManager.getStatus(printerId)
    return status?.ams.find((unit) => unit.unitId === amsId)?.slots.find((entry) => entry.slot === slotId)?.k ?? null
  },
  async applyPrinterKValue(input) {
    const status = printerManager.getStatus(input.printerId)
    const model = printerModelSchema.safeParse(input.printerModel).success ? input.printerModel : 'unknown'
    const context = resolvePressureAdvanceCommandContext(status, input.amsId)
    // Associate the K profile with the tray's Bambu preset when it has one; empty for custom
    // filament — the printer accepts an empty filament id and applies it to the tray all the same
    // (verified on hardware).
    const slot = status?.ams.find((unit) => unit.unitId === input.amsId)?.slots.find((entry) => entry.slot === input.slotId)
    const filamentId = slot?.trayInfoIdx ?? ''
    const label = [input.identity.brand, input.identity.filamentType].filter(Boolean).join(' ').trim()
    const profileName = `PS ${label || 'Calibration'}`.slice(0, 64)

    const publish = (command: PrinterCommand) => {
      for (const payload of commandToMqttPayloads(model, command, status)) {
        printerManager.publishCommand(input.printerId, payload)
      }
    }
    const loadProfiles = () => printerManager.requestPressureAdvanceProfiles(input.printerId, {
      filamentId,
      extruderId: context.extruderId,
      nozzleDiameter: input.nozzleDiameter,
      nozzleTypeCode: context.nozzleTypeCode
    })
    const sameName = (profile: PrinterPressureAdvanceProfile) => (profile.name?.trim() ?? '') === profileName && profile.filamentId === filamentId
    const matchesTarget = (profile: PrinterPressureAdvanceProfile) => sameName(profile) && Math.abs(profile.kValue - input.kValue) < 0.0005
    const newest = (profiles: PrinterPressureAdvanceProfile[]) => [...profiles].sort((left, right) => right.caliIdx - left.caliIdx)[0]

    // Creating a K profile does NOT apply it — the tray keeps its current selection until the
    // profile is selected (verified on Farm 06). So reuse an existing matching profile; otherwise
    // clear stale same-name profiles (avoid accumulation), create the new one, then select it.
    let profiles = await loadProfiles()
    let target = newest(profiles.filter(matchesTarget))
    if (!target) {
      for (const stale of profiles.filter(sameName)) {
        publish({ type: 'deleteAmsPressureAdvanceProfile', amsId: input.amsId, slotId: input.slotId, caliIdx: stale.caliIdx, filamentId, nozzleDiameter: input.nozzleDiameter, extruderId: context.extruderId })
      }
      publish({
        type: 'createAmsPressureAdvanceProfile',
        amsId: input.amsId,
        slotId: input.slotId,
        kValue: input.kValue,
        filamentId,
        settingId: '',
        profileName,
        nozzleDiameter: input.nozzleDiameter,
        extruderId: 0
      })
      profiles = await loadProfiles()
      target = newest(profiles.filter(matchesTarget))
    }
    if (target) {
      publish({ type: 'selectAmsPressureAdvanceProfile', amsId: input.amsId, slotId: input.slotId, caliIdx: target.caliIdx, filamentId, nozzleDiameter: input.nozzleDiameter, extruderId: context.extruderId })
    }
  }
}

export const calibrationPlugin: ApiPlugin = {
  name: 'calibration',
  version: '0.1.0',
  description: 'Print pressure-advance and flow-ratio calibration tests, then save the result for reuse on matching filament.',
  register(context) {
    registerCalibrationRoutes(context, deps)

    const onPrintFinished = (event: { printer: { id: string }; result: 'success' | 'failed' | 'cancelled' }) => {
      if (event.result !== 'success') return
      const tenantId = printerManager.getTenantId(event.printer.id)
      if (!tenantId) return
      void handlePrintFinished(rootPrisma, tenantId, event.printer.id, null).catch((error) => {
        context.logger.warn('Failed to advance calibration run on print finish', error instanceof Error ? error.message : error)
      })
    }
    context.printerEvents.on('print-job.finished', onPrintFinished)

    // When a filament is loaded into a slot, apply its saved pressure-advance value.
    const onFilamentLoaded = (event: {
      tenantId: string; printerId: string; amsId: number; slotId: number; spoolId: string
      brand: string | null; filamentType: string | null; materialSubtype: string | null; colorName: string | null
    }) => {
      if (!(context.isEnabledForTenant?.(event.tenantId) ?? true)) return
      void autoApplyOnLoad(deps, rootPrisma, event).catch((error) => {
        context.logger.warn('Failed to auto-apply saved calibration on filament load', error instanceof Error ? error.message : error)
      })
    }
    context.printerEvents.on('ams-slot.filament-loaded', onFilamentLoaded)

    context.onShutdown(() => {
      context.printerEvents.off('print-job.finished', onPrintFinished)
      context.printerEvents.off('ams-slot.filament-loaded', onFilamentLoaded)
    })
  }
}
