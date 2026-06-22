/**
 * Test-fleet status builder: maps a configured printer (via its roster scenario)
 * to an explicit {@link PrinterStatus} pinned to one printer-card state, so the
 * whole UI matrix renders at once. Drives the simulator through its
 * `statusProvider` hook (see demo-simulator.ts). Pure + deterministic except for
 * `observedAt`/live progress, so each scenario is unit-testable.
 */
import {
  getTestFleetSeed,
  printerStatusSchema,
  type AmsSlot,
  type AmsUnit,
  type Printer,
  type PrinterStatus,
  type TestFleetScenario
} from '@printstream/shared'
import {
  activateAmsSlot,
  advancePrintStatus,
  buildIdleStatus,
  clearActiveAmsSlots,
  clearActiveExternalSpools,
  finishStatus
} from './demo-simulator.js'

/** Stamp `observedAt` so the API treats each emission as fresh. */
function stamp(status: PrinterStatus): PrinterStatus {
  return printerStatusSchema.parse({ ...status, observedAt: new Date().toISOString() })
}

interface PrintingOptions {
  jobName: string
  currentLayer: number
  totalLayers: number
  progressPercent: number
  remainingMinutes: number
  dualNozzle?: boolean
}

function printing(base: PrinterStatus, opts: PrintingOptions): PrinterStatus {
  return {
    ...base,
    stage: 'printing',
    subStage: `Layer ${opts.currentLayer} / ${opts.totalLayers}`,
    currentLayer: opts.currentLayer,
    totalLayers: opts.totalLayers,
    progressPercent: opts.progressPercent,
    remainingMinutes: opts.remainingMinutes,
    jobId: `test-print-${base.printerId}`,
    taskId: `test-task-${base.printerId}`,
    jobName: opts.jobName,
    lastJobName: opts.jobName,
    gcodeFile: `${opts.jobName.replace(/\s+/g, '_')}.gcode`,
    bedTemp: 55,
    bedTarget: 55,
    nozzleTemp: 220,
    nozzleTarget: 220,
    nozzles: base.nozzles.map((nozzle, index) => ({
      ...nozzle,
      currentTemp: opts.dualNozzle || index === 0 ? 220 : 32,
      targetTemp: opts.dualNozzle || index === 0 ? 220 : null
    })),
    chamberTemp: base.chamberTemp == null ? null : 34,
    partFanPercent: 70,
    auxFanPercent: 45,
    chamberFanPercent: 30,
    speedLevel: 2,
    ams: activateAmsSlot(base.ams, 0, 0),
    externalSpools: clearActiveExternalSpools(base.externalSpools)
  }
}

const ERROR_NOZZLE_CLOG = { code: 'test_nozzle_clog', message: 'Nozzle clog suspected. Clear the nozzle before continuing.' }
const ERROR_RUNOUT = { code: 'test_filament_runout', message: 'Filament ran out. Load filament to resume.' }
const HMS_HOTEND = { code: '0C0003000002001C', message: 'Potential hotend clumping detected.' }
const HMS_BED = { code: '0500030000020003', message: 'Heatbed temperature is abnormal; check the thermistor.' }

/** Override a slot to a specific presentation (empty / unknown / reading). */
function setSlot(unit: AmsUnit, slotIndex: number, patch: Partial<AmsSlot>): AmsUnit {
  return { ...unit, slots: unit.slots.map((slot, index) => (index === slotIndex ? { ...slot, ...patch } : slot)) }
}

export function buildTestFleetStatus(printer: Printer, previous: PrinterStatus | null): PrinterStatus {
  const seed = getTestFleetSeed(printer.serial)
  const scenario: TestFleetScenario = seed?.scenario ?? 'idle'
  const base = buildIdleStatus(printer)

  // Live printers keep advancing once they're running.
  if (seed?.live && previous && previous.stage === 'printing') {
    return stamp(advancePrintStatus(previous))
  }

  switch (scenario) {
    case 'idle':
    case 'chamber-duct':
    case 'a1-work-light':
      return stamp(base)

    case 'heating':
      return stamp({ ...base, stage: 'heating', subStage: 'Heating nozzle and bed', nozzleTemp: 140, nozzleTarget: 220, bedTemp: 48, bedTarget: 60 })

    case 'preparing':
      return stamp({ ...base, stage: 'preparing', subStage: 'Preparing print' })

    case 'printing-early':
      return stamp(printing(base, { jobName: 'Calibration Cube', currentLayer: 12, totalLayers: 164, progressPercent: 7, remainingMinutes: 134 }))
    case 'printing-mid':
    case 'skip-object':
      return stamp(printing(base, { jobName: 'Gridfinity Bin 2x2', currentLayer: 96, totalLayers: 205, progressPercent: 46, remainingMinutes: 52 }))
    case 'printing-near-done':
      return stamp(printing(base, { jobName: 'Cable Clip', currentLayer: 188, totalLayers: 206, progressPercent: 91, remainingMinutes: 9 }))
    case 'printing-dual-nozzle':
      return stamp(printing(base, { jobName: 'Two-Tone Sign', currentLayer: 143, totalLayers: 210, progressPercent: 68, remainingMinutes: 31, dualNozzle: true }))

    case 'paused-manual':
      return stamp({ ...printing(base, { jobName: 'Phone Stand', currentLayer: 60, totalLayers: 150, progressPercent: 40, remainingMinutes: 70 }), stage: 'paused', subStage: 'Paused' })

    case 'paused-runout':
      // stage 'paused' + subStage '6' is the filament-runout code; with a loadable
      // AMS slot this drives the "Load filament" recovery + the recovery dialog.
      return stamp({
        ...printing(base, { jobName: 'Lithophane', currentLayer: 80, totalLayers: 240, progressPercent: 33, remainingMinutes: 120 }),
        stage: 'paused',
        subStage: '6',
        deviceError: ERROR_RUNOUT,
        ams: activateAmsSlot(clearActiveAmsSlots(base.ams), 0, 1)
      })

    case 'paused-device-error':
      return stamp({
        ...printing(base, { jobName: 'Bracket', currentLayer: 45, totalLayers: 130, progressPercent: 35, remainingMinutes: 60 }),
        stage: 'paused',
        subStage: 'Paused — check printer',
        deviceError: ERROR_NOZZLE_CLOG
      })

    case 'check-assistant':
      return stamp({
        ...printing(base, { jobName: 'Enclosure Panel', currentLayer: 30, totalLayers: 200, progressPercent: 15, remainingMinutes: 150, dualNozzle: true }),
        stage: 'paused',
        subStage: 'Paused — attention needed',
        deviceError: ERROR_NOZZLE_CLOG,
        hmsErrors: [HMS_HOTEND]
      })

    case 'finished':
      return stamp({
        ...finishStatus(printing(base, { jobName: 'Desk Organizer', currentLayer: 180, totalLayers: 180, progressPercent: 100, remainingMinutes: 0 }), 'finished', 'Print completed'),
        lastJobName: 'Desk Organizer',
        deviceError: null,
        hmsErrors: [],
        ams: clearActiveAmsSlots(base.ams),
        externalSpools: clearActiveExternalSpools(base.externalSpools)
      })

    case 'failed':
      return stamp({
        ...printing(base, { jobName: 'Vase', currentLayer: 118, totalLayers: 186, progressPercent: 63, remainingMinutes: 0 }),
        stage: 'failed',
        subStage: 'Print failed',
        jobName: null,
        gcodeFile: null,
        remainingMinutes: null,
        deviceError: ERROR_NOZZLE_CLOG,
        hmsErrors: [HMS_HOTEND],
        ams: clearActiveAmsSlots(base.ams),
        externalSpools: clearActiveExternalSpools(base.externalSpools)
      })

    case 'hms-single':
      return stamp({ ...printing(base, { jobName: 'Knob', currentLayer: 22, totalLayers: 90, progressPercent: 24, remainingMinutes: 40 }), hmsErrors: [HMS_HOTEND] })
    case 'hms-multi':
      return stamp({ ...printing(base, { jobName: 'Tray', currentLayer: 70, totalLayers: 180, progressPercent: 39, remainingMinutes: 80 }), hmsErrors: [HMS_HOTEND, HMS_BED] })

    case 'offline':
      return stamp({ ...base, online: false, subStage: null })

    case 'lan-mode':
      return stamp({ ...base, connectionWarnings: [{ code: 'localConnectionFailed', message: 'Cloud connection only — LAN mode is unavailable.' }] })

    case 'external-spool':
      return stamp({ ...base, ams: [] })

    case 'ams-mixed-slots': {
      const unit = base.ams[0]
      if (!unit) return stamp(base)
      const mixed = setSlot(setSlot(setSlot(unit, 1, { filamentType: null, color: null, colors: [], trayName: null, occupied: false, remainPercent: null }), 2, { isReading: true, filamentType: null, color: null }), 3, { occupied: true, filamentType: null, color: null, trayName: null })
      return stamp({ ...base, ams: [mixed, ...base.ams.slice(1)] })
    }

    case 'ams-dual-units': {
      const unit = base.ams[0]
      if (!unit) return stamp(base)
      const second: AmsUnit = { ...unit, unitId: unit.unitId + 1, slots: unit.slots.map((slot) => ({ ...slot, active: false })) }
      return stamp({ ...base, ams: [unit, second] })
    }

    case 'ams-drying': {
      const unit = base.ams[0]
      if (!unit) return stamp(base)
      const drying: AmsUnit = { ...unit, supportDrying: true, dryingActive: true, dryTimeRemainingMinutes: 45, dryTemperature: 65, temperature: 38 }
      return stamp({ ...base, ams: [drying, ...base.ams.slice(1)] })
    }

    default:
      return stamp(base)
  }
}
