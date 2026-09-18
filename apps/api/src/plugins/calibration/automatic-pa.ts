/**
 * Standalone X1 calibration lifecycle. Preparation is inert; the existing Print
 * action checks the plate guard and starts the physical routine. Results enter
 * the ordinary PS save dialog, never printer profile history.
 *
 * Firmware exposes only its latest result, without a run id. Consequently a live
 * observer must see this start progress through an active stage and finish before
 * reading it. Restarted/interrupted observers fail closed instead of adopting an
 * old measurement. Assumes one API node, like the printer manager; revisit with
 * multi-node printer ownership.
 */
import {
  isAutomaticPressureAdvance, supportsAutomaticPressureAdvance,
  printerModelSchema,
  type CreateCalibrationRun, type PrinterStatus
} from '@printstream/shared'
import type { CalibrationRun } from '@prisma/client'
import type { AnyPrismaClient } from '../../lib/prisma.js'
import { badRequest, conflict, notFound } from '../../lib/http-error.js'
import { printGuards } from '../../lib/print-guards.js'
import { assertAutomaticPrintCompatibility } from '../../lib/print-filament-compatibility.js'
import { resolveSlicingPresetFiles } from '../../lib/slicing-presets.js'
import { slicerClient } from '../../lib/slicer-client.js'
import { observeAutomaticPa } from './automatic-pa-monitor.js'
import type { CalibrationRunManagerDeps } from './run-manager.js'
import { createRun, getRun, updateRun } from './store.js'
import { toCalibrationRunParameters } from './dto.js'
import { automaticPaSetup, automaticPaStartFields, type AutomaticPaSetup } from './automatic-pa-protocol.js'
import { automaticPaFilamentMatches, automaticPaFilamentSnapshot, automaticPaMaterialTypesMatch } from './automatic-pa-identity.js'

export interface AutomaticPaTransport {
  getStatus(printerId: string): PrinterStatus | undefined
  requestAutomaticCalibration(printerId: string, command: 'extrusion_cali' | 'extrusion_cali_get_result', fields: Record<string, unknown>): Promise<Record<string, unknown>>
}

/** Owns background work for one plugin registration; shutdown removes every polling timer. */
export class AutomaticPaRuns {
  private readonly active = new Set<string>()
  private readonly shutdown = new AbortController()

  constructor(
    private readonly db: AnyPrismaClient,
    private readonly deps: CalibrationRunManagerDeps,
    private readonly transport: AutomaticPaTransport,
    private readonly warn: (message: string, detail: string) => void
  ) {}

  /** A restart loses observation provenance. Preserve the run, but refuse its latest firmware result. */
  async recover(): Promise<void> {
    const rows = await this.db.calibrationRun.findMany({ where: { status: 'printing', kind: 'pressureAdvance' } })
    for (const row of rows) {
      if (!isAutomaticPressureAdvance(toCalibrationRunParameters(row))) continue
      await this.fail(row, 'Calibration monitoring was interrupted. Run it again to obtain a fresh measurement.')
    }
  }

  /** Stop monitoring only; shutting down PS must never silently send a printer stop command. */
  close(): void {
    this.shutdown.abort()
  }

  /** Reserve the printer against another PS dispatch while its measurement is in flight. */
  isActive(printerId: string): boolean {
    return this.active.has(printerId)
  }

  /** Prepare a server-owned recipe and identity snapshot without starting the printer. */
  async prepare(db: AnyPrismaClient, workspaceId: string, input: CreateCalibrationRun): Promise<CalibrationRun> {
    const printer = await this.deps.resolvePrinter(db, workspaceId, input.printerId)
    if (!supportsAutomaticPressureAdvance(printer.model)) throw badRequest('Automatic Micro Lidar calibration requires an X1-series printer')
    if (input.parameters.kind !== 'pressureAdvance') throw badRequest('Automatic calibration only measures pressure advance')
    const status = this.requireReady(printer.id)
    const slot = status.ams.find((unit) => unit.unitId === input.amsId)?.slots.find((tray) => tray.slot === input.slotId)
    if (!slot?.filamentType) throw badRequest('Select a loaded AMS slot')
    if (!input.filamentProfileId) throw badRequest('Select the filament preset to calibrate')
    const [profile] = await resolveSlicingPresetFiles(workspaceId, [{ id: input.filamentProfileId, kind: 'filament' }])
    if (!profile) throw notFound('Filament preset not found')
    const config = await slicerClient.resolveFilamentConfig(null, profile)
    if (!config) throw badRequest('The filament preset could not be resolved')
    const presetType = Array.isArray(config.filament_type) ? config.filament_type[0] : config.filament_type
    if (!automaticPaMaterialTypesMatch(presetType, slot.filamentType)) {
      throw badRequest('The selected preset must match the loaded filament material')
    }
    const trayIndex = this.deps.resolveTrayIndex?.(printer.id, input.amsId, input.slotId)
    if (trayIndex == null) throw badRequest('The selected AMS slot is unavailable')
    const setup = automaticPaSetup(config, input.plateType ?? printer.currentPlateType, trayIndex)
    setup.trayUuid = slot.trayUuid
    setup.trayInfoIdx = slot.trayInfoIdx
    setup.filamentType = slot.filamentType
    const observed = await this.deps.resolveSlotFilament(db, workspaceId, printer.id, input.amsId, input.slotId)
    setup.observedFilament = automaticPaFilamentSnapshot(slot, observed)
    return createRun(db, workspaceId, {
      kind: 'pressureAdvance', status: 'readyToPrint', printerId: printer.id,
      printerModel: printer.model, nozzleDiameter: printer.nozzleDiameter,
      amsId: input.amsId, slotId: input.slotId,
      spoolId: input.spoolId ?? observed.spoolId,
      brand: input.brand ?? observed.brand,
      filamentType: input.filamentType ?? observed.filamentType,
      materialSubtype: input.materialSubtype ?? observed.materialSubtype,
      colorName: input.colorName ?? observed.colorName,
      parameters: {
        kind: 'pressureAdvance', method: 'automatic', pressureAdvanceMode: 'native',
        startK: 0, endK: 0.1, step: 0.002, automaticSetup: setup
      }
    })
  }

  /** Claim this run before dispatch; repeated clicks cannot start a second physical calibration. */
  async start(db: AnyPrismaClient, workspaceId: string, run: CalibrationRun): Promise<void> {
    const parameters = toCalibrationRunParameters(run)
    if (parameters.kind !== 'pressureAdvance' || !parameters.automaticSetup || !run.printerId || run.amsId == null || run.slotId == null) {
      throw badRequest('This automatic calibration is missing its prepared settings')
    }
    const key = run.printerId
    if (this.active.has(key)) throw conflict('This printer already has an automatic calibration in progress')
    const guard = printGuards.evaluate({ printerId: key, source: 'calibration' })
    if (guard) throw conflict(guard.reason ?? 'Calibration is blocked')
    this.active.add(key)
    try {
      const printer = await this.deps.resolvePrinter(db, workspaceId, key)
      if (printer.model !== run.printerModel || printer.nozzleDiameter !== run.nozzleDiameter) {
        throw conflict('The printer or nozzle changed. Prepare a new calibration.')
      }
      const status = this.requireReady(key)
      const slot = status.ams.find((unit) => unit.unitId === run.amsId)?.slots.find((tray) => tray.slot === run.slotId)
      const setup = parameters.automaticSetup
      if (!slot?.filamentType || slot.filamentType !== setup.filamentType
        || slot.trayUuid !== setup.trayUuid || slot.trayInfoIdx !== setup.trayInfoIdx) {
        throw conflict('The loaded filament changed. Prepare a new calibration.')
      }
      const observed = await this.deps.resolveSlotFilament(db, workspaceId, key, run.amsId, run.slotId)
      if (!automaticPaFilamentMatches(setup.observedFilament, automaticPaFilamentSnapshot(slot, observed))) {
        throw conflict('The loaded filament changed. Prepare a new calibration.')
      }
      await assertAutomaticPrintCompatibility({
        workspaceId, printerId: key, index: null, plate: 1,
        printerModel: printerModelSchema.parse(printer.model), printerStatus: status,
        useAms: true, amsMapping: [parameters.automaticSetup.trayIndex]
      })
      const claimed = await db.calibrationRun.updateMany({
        where: { id: run.id, workspaceId, status: 'readyToPrint' }, data: { status: 'printing', errorMessage: null }
      })
      if (claimed.count !== 1) throw conflict('This calibration is no longer ready to start')
      try {
        const reply = await this.transport.requestAutomaticCalibration(key, 'extrusion_cali',
          automaticPaStartFields(parameters.automaticSetup, run.nozzleDiameter, run.amsId, run.slotId))
        if (reply.result !== 'success') throw new Error('The printer did not accept automatic calibration')
      } catch (error) {
        await this.fail(run, error instanceof Error ? error.message : 'Calibration start failed')
        throw error
      }
      // The row and recipe are now durable; the request can return while the printer measures.
      void this.monitor(run, parameters.automaticSetup).catch((error) => {
        this.warn('Could not persist automatic calibration outcome', error instanceof Error ? error.message : String(error))
      }).finally(() => this.active.delete(key))
    } catch (error) {
      this.active.delete(key)
      throw error
    }
  }

  private requireReady(printerId: string): PrinterStatus {
    const status = this.transport.getStatus(printerId)
    if (!status?.online || !['idle', 'finished'].includes(status.stage)) throw conflict('The printer must be online and idle to calibrate')
    return status
  }

  /** Poll only after a freshly observed print, and give firmware a bounded interval to publish its result. */
  private async monitor(run: CalibrationRun, setup: AutomaticPaSetup): Promise<void> {
    try {
      const result = await observeAutomaticPa(setup, run.nozzleDiameter, {
        status: () => this.transport.getStatus(run.printerId!),
        result: () => this.transport.requestAutomaticCalibration(run.printerId!, 'extrusion_cali_get_result', { nozzle_diameter: run.nozzleDiameter }),
        signal: this.shutdown.signal
      })
      const current = await getRun(this.db, run.workspaceId, run.id)
      if (!current || current.status !== 'printing') return
      const parameters = toCalibrationRunParameters(current)
      if (parameters.kind !== 'pressureAdvance') return
      await updateRun(this.db, run.workspaceId, run.id, {
        status: 'awaitingResult', resultValue: result.k,
        parameters: { ...parameters, automaticNCoefficient: result.n }
      })
    } catch (error) {
      const message = this.shutdown.signal.aborted
        ? 'Calibration monitoring was interrupted. Run it again for a fresh measurement.'
        : error instanceof Error ? error.message : 'Automatic calibration failed'
      await this.fail(run, message)
    }
  }

  private async fail(run: CalibrationRun, message: string): Promise<void> {
    this.warn('Automatic calibration failed', `${run.id}: ${message}`)
    await updateRun(this.db, run.workspaceId, run.id, { status: 'failed', errorMessage: message })
  }
}
