/**
 * Seeded public-demo printer fleet and synthetic starting state.
 *
 * The public demo uses a fixed fleet so the web app can exercise the
 * normal printer, AMS, and jobs surfaces without relying on live MQTT
 * hardware.
 */
import {
  getDemoPrinterActiveJob,
  getPrinterDisplayCapabilities,
  getPrinterPrintOptionCapabilities,
  getPrinterPrintStartOptions,
  printerStatusSchema,
  type Printer,
  type PrinterNozzleDiameterSelection,
  type PrinterPressureAdvanceProfile,
  type PrinterPrintOptions,
  type PrinterStatus
} from '@printstream/shared'
import { env } from '../env.js'
import { rootPrisma } from '../prisma.js'
import { serializePrinterNozzleDiameters } from '../printer-record.js'

interface DemoPrinterSeed {
  name: string
  host: string
  serial: string
  accessCode: string
  model: Printer['model']
  currentPlateType: string | null
  currentNozzleDiameters: PrinterNozzleDiameterSelection[]
  position: number
  scenario: 'printing' | 'idle' | 'paused'
}

const HEATBED_LIGHT_MODELS = new Set<Printer['model']>(['H2D', 'H2DPRO', 'H2C', 'H2S'])
const DUAL_NOZZLE_MODELS = new Set<Printer['model']>(['X2D', 'H2D', 'H2DPRO', 'H2C'])
const WORK_LIGHT_MODELS = new Set<Printer['model']>(['A1', 'A1mini', 'A2L'])

export const DEMO_PRINTER_SEEDS: DemoPrinterSeed[] = [
  {
    name: 'Prototype X1C',
    host: 'demo-x1c.local',
    serial: 'DEMO-X1C-001',
    accessCode: 'DEMO-X1C',
    model: 'X1C',
    currentPlateType: 'Textured PEI Plate',
    currentNozzleDiameters: [{ extruderId: 0, diameter: '0.4' }],
    position: 0,
    scenario: 'idle'
  },
  {
    name: 'Studio H2D',
    host: 'demo-h2d.local',
    serial: 'DEMO-H2D-001',
    accessCode: 'DEMO-H2D',
    model: 'H2D',
    currentPlateType: 'Engineering Plate',
    currentNozzleDiameters: [
      { extruderId: 0, diameter: '0.4' },
      { extruderId: 1, diameter: '0.4' }
    ],
    position: 1,
    scenario: 'printing'
  },
  {
    name: 'Farm P1S',
    host: 'demo-p1s.local',
    serial: 'DEMO-P1S-001',
    accessCode: 'DEMO-P1S',
    model: 'P1S',
    currentPlateType: 'Smooth PEI Plate',
    currentNozzleDiameters: [{ extruderId: 0, diameter: '0.4' }],
    position: 2,
    scenario: 'paused'
  },
  {
    name: 'Backup X1C',
    host: 'demo-x1c-02.local',
    serial: 'DEMO-X1C-002',
    accessCode: 'DEMO-X1C2',
    model: 'X1C',
    currentPlateType: 'Cool Plate',
    currentNozzleDiameters: [{ extruderId: 0, diameter: '0.6' }],
    position: 3,
    scenario: 'printing'
  },
  {
    name: 'Lab H2D',
    host: 'demo-h2d-02.local',
    serial: 'DEMO-H2D-002',
    accessCode: 'DEMO-H2D2',
    model: 'H2D',
    currentPlateType: 'Smooth PEI Plate',
    currentNozzleDiameters: [
      { extruderId: 0, diameter: '0.4' },
      { extruderId: 1, diameter: '0.4' }
    ],
    position: 4,
    scenario: 'printing'
  },
  {
    name: 'Queue P1S',
    host: 'demo-p1s-02.local',
    serial: 'DEMO-P1S-002',
    accessCode: 'DEMO-P1S2',
    model: 'P1S',
    currentPlateType: 'Textured PEI Plate',
    currentNozzleDiameters: [{ extruderId: 0, diameter: '0.4' }],
    position: 5,
    scenario: 'printing'
  }
]

const SEEDED_DEMO_PROGRESS = new Map<string, Pick<PrinterStatus, 'subStage' | 'progressPercent' | 'currentLayer' | 'totalLayers' | 'remainingMinutes'>>([
  ['DEMO-H2D-001', { subStage: 'Layer 12 / 164', progressPercent: 7, currentLayer: 12, totalLayers: 164, remainingMinutes: 134 }],
  ['DEMO-P1S-001', { subStage: 'Layer 27 / 150', progressPercent: 18, currentLayer: 27, totalLayers: 150, remainingMinutes: 73 }],
  ['DEMO-X1C-002', { subStage: 'Layer 86 / 205', progressPercent: 42, currentLayer: 86, totalLayers: 205, remainingMinutes: 57 }],
  ['DEMO-H2D-002', { subStage: 'Layer 143 / 210', progressPercent: 68, currentLayer: 143, totalLayers: 210, remainingMinutes: 31 }],
  ['DEMO-P1S-002', { subStage: 'Layer 188 / 206', progressPercent: 91, currentLayer: 188, totalLayers: 206, remainingMinutes: 9 }]
])

export const DEMO_READY_TO_USE_PRINTER_SERIAL = DEMO_PRINTER_SEEDS[0]?.serial ?? ''

export function isReadyToUseDemoPrinter(printerSerial: string): boolean {
  return printerSerial === DEMO_READY_TO_USE_PRINTER_SERIAL
}

export async function reconcileDemoPrinters(): Promise<void> {
  const tenantId = await resolveDemoTenantId()
  if (!tenantId) return

  for (const seed of DEMO_PRINTER_SEEDS) {
    const existing = await rootPrisma.printer.findFirst({
      where: {
        tenantId,
        serial: seed.serial
      },
      select: { id: true }
    })

    if (existing) {
      await rootPrisma.printer.update({
        where: { id: existing.id },
        data: {
          name: seed.name,
          host: seed.host,
          accessCode: seed.accessCode,
          model: seed.model,
          currentPlateType: seed.currentPlateType,
          currentNozzleDiameters: serializePrinterNozzleDiameters(seed.currentNozzleDiameters),
          position: seed.position
        }
      })
      continue
    }

    await rootPrisma.printer.create({
      data: {
        tenantId,
        name: seed.name,
        host: seed.host,
        serial: seed.serial,
        accessCode: seed.accessCode,
        model: seed.model,
        currentPlateType: seed.currentPlateType,
        currentNozzleDiameters: serializePrinterNozzleDiameters(seed.currentNozzleDiameters),
        position: seed.position
      }
    })
  }
}

async function resolveDemoTenantId(): Promise<string | null> {
  const defaultSlug = env.DEFAULT_TENANT_SLUG
  if (defaultSlug) {
    const tenant = await rootPrisma.tenant.findUnique({
      where: { slug: defaultSlug },
      select: { id: true }
    })
    if (tenant) return tenant.id
  }

  const tenant = await rootPrisma.tenant.findFirst({
    orderBy: { createdAt: 'asc' },
    select: { id: true }
  })
  return tenant?.id ?? null
}

export function buildDemoStatus(printer: Printer): PrinterStatus {
  const seed = findDemoPrinterSeed(printer)
  const status = seed ? buildSeededDemoStatus(printer, seed) : buildFallbackDemoStatus(printer)
  return printerStatusSchema.parse(status)
}

export function buildDemoPressureAdvanceProfiles(request: {
  filamentId: string
  extruderId: number
  nozzleDiameter: string
}): PrinterPressureAdvanceProfile[] {
  const filamentId = request.filamentId.trim() || 'GFA00'
  return [
    {
      caliIdx: 0,
      filamentId,
      settingId: `${filamentId}-default`,
      name: 'Default',
      kValue: 0.018,
      nCoef: 1.4,
      nozzleDiameter: request.nozzleDiameter,
      confidence: 92
    },
    {
      caliIdx: 1,
      filamentId,
      settingId: `${filamentId}-speed`,
      name: request.extruderId > 0 ? 'Left nozzle tuned' : 'Balanced walls',
      kValue: 0.022,
      nCoef: 1.4,
      nozzleDiameter: request.nozzleDiameter,
      confidence: 81
    },
    {
      caliIdx: 2,
      filamentId,
      settingId: `${filamentId}-surface`,
      name: 'Surface finish',
      kValue: 0.026,
      nCoef: 1.4,
      nozzleDiameter: request.nozzleDiameter,
      confidence: 74
    }
  ]
}

function findDemoPrinterSeed(printer: Printer): DemoPrinterSeed | undefined {
  return DEMO_PRINTER_SEEDS.find((seed) => seed.serial === printer.serial)
}

function buildSeededDemoStatus(printer: Printer, seed: DemoPrinterSeed): PrinterStatus {
  const base = buildStatusBase(printer)
  const status = cloneStatus(base)
  const seededProgress = getSeededDemoProgress(seed.serial)
  const activeJob = getDemoPrinterActiveJob(seed.serial)
  const jobName = activeJob?.jobName ?? 'Storage Box'
  const gcodeFile = activeJob?.fileName ?? 'Storage_Box.gcode.3mf'

  switch (seed.scenario) {
    case 'printing': {
      status.stage = 'printing'
      status.subStage = seededProgress.subStage
      status.progressPercent = seededProgress.progressPercent
      status.currentLayer = seededProgress.currentLayer
      status.totalLayers = seededProgress.totalLayers
      status.remainingMinutes = seededProgress.remainingMinutes
      status.jobName = jobName
      status.lastJobName = jobName
      status.gcodeFile = gcodeFile
      status.bedTemp = 55
      status.bedTarget = 55
      status.nozzleTemp = 220
      status.nozzleTarget = 220
      status.nozzles = status.nozzles.map((nozzle, index) => ({
        ...nozzle,
        currentTemp: index === 0 ? 220 : 32,
        targetTemp: index === 0 ? 220 : null
      }))
      status.chamberTemp = base.chamberTemp == null ? null : 34
      status.partFanPercent = 70
      status.auxFanPercent = 45
      status.chamberFanPercent = 30
      status.speedLevel = 2
      status.ams = status.ams.map((unit, unitIndex) => ({
        ...unit,
        slots: unit.slots.map((slot, slotIndex) => ({
          ...slot,
          active: unitIndex === 0 && slotIndex === 0
        }))
      }))
      status.lightModes.chamber = 'on'
      break
    }
    case 'paused': {
      status.stage = 'paused'
      status.subStage = 'Paused for filament change'
      status.progressPercent = seededProgress.progressPercent
      status.currentLayer = seededProgress.currentLayer
      status.totalLayers = seededProgress.totalLayers
      status.remainingMinutes = seededProgress.remainingMinutes
      status.jobName = jobName
      status.lastJobName = jobName
      status.gcodeFile = gcodeFile
      status.bedTemp = 60
      status.bedTarget = 60
      status.nozzleTemp = 215
      status.nozzleTarget = 215
      status.nozzles = status.nozzles.map((nozzle) => ({
        ...nozzle,
        currentTemp: 215,
        targetTemp: 215
      }))
      status.chamberTemp = base.chamberTemp == null ? null : 33
      status.partFanPercent = 35
      status.auxFanPercent = 20
      status.chamberFanPercent = 22
      status.speedLevel = 1
      status.ams = status.ams.map((unit, unitIndex) => ({
        ...unit,
        slots: unit.slots.map((slot, slotIndex) => ({
          ...slot,
          active: unitIndex === 0 && slotIndex === 1
        }))
      }))
      status.lightModes.chamber = 'flashing'
      break
    }
    case 'idle':
    default:
      status.subStage = 'Ready to print'
      break
  }

  status.observedAt = new Date().toISOString()
  return status
}

function getSeededDemoProgress(printerSerial: string): Pick<PrinterStatus, 'subStage' | 'progressPercent' | 'currentLayer' | 'totalLayers' | 'remainingMinutes'> {
  return SEEDED_DEMO_PROGRESS.get(printerSerial)
    ?? { subStage: 'Layer 86 / 205', progressPercent: 42, currentLayer: 86, totalLayers: 205, remainingMinutes: 57 }
}

function buildFallbackDemoStatus(printer: Printer): PrinterStatus {
  return buildStatusBase(printer)
}

function buildStatusBase(printer: Printer): PrinterStatus {
  const nozzles = buildNozzles(printer)
  const printOptions = buildPrintOptions(printer.model)
  const displayCapabilities = getPrinterDisplayCapabilities(printer.model)
  const dualNozzles = DUAL_NOZZLE_MODELS.has(printer.model)

  return {
    printerId: printer.id,
    online: true,
    stage: 'idle',
    subStage: null,
    filamentChange: {
      currentStepIndex: null,
      currentStepLabel: null,
      steps: []
    },
    progressPercent: null,
    currentLayer: null,
    totalLayers: null,
    remainingMinutes: null,
    jobId: null,
    taskId: null,
    jobName: null,
    lastJobName: 'Needle Lift Tool',
    gcodeFile: null,
    bedTemp: 31,
    bedTarget: null,
    nozzleTemp: nozzles[0]?.currentTemp ?? null,
    nozzleTarget: nozzles[0]?.targetTemp ?? null,
    nozzles,
    chamberTemp: displayCapabilities.chamberTemperature ? (dualNozzles ? 29 : 27) : null,
    chamberTarget: displayCapabilities.chamberTemperature ? 45 : null,
    fanGearSpeed: 2,
    partFanPercent: 0,
    auxFanPercent: 0,
    chamberFanPercent: 0,
    wifiSignalDbm: -46,
    ipAddress: printer.host,
    doorOpen: displayCapabilities.doorState ? false : null,
    ductMode: displayCapabilities.airductMode ? 'cooling' : null,
    ductAvailableModes: displayCapabilities.airductMode ? ['cooling', 'heating'] : [],
    lightModes: {
      chamber: 'on',
      heatbed: HEATBED_LIGHT_MODELS.has(printer.model) ? 'off' : null,
      work: WORK_LIGHT_MODELS.has(printer.model) ? 'on' : null
    },
    lightCapabilities: {
      chamber: true,
      heatbed: HEATBED_LIGHT_MODELS.has(printer.model),
      work: WORK_LIGHT_MODELS.has(printer.model)
    },
    chamberLightOffRequiresConfirm: false,
    lightOn: true,
    speedLevel: null,
    commandTransport: buildCommandTransport(),
    printStartOptions: getPrinterPrintStartOptions(printer.model, { printOptions }),
    printOptions,
    deviceError: null,
    hmsErrors: [],
    amsSettings: {
      detectOnInsert: true,
      detectOnPowerup: true,
      remainEnabled: true,
      autoRefill: true,
      supportFilamentBackup: true
    },
    ams: buildAmsUnits(printer),
    externalSpools: buildExternalSpools(printer),
    firmwareVersion: printer.model === 'H2D' ? '01.02.00.14' : '01.09.00.00',
    sdCardPresent: true,
    observedAt: new Date().toISOString()
  }
}

function cloneStatus(status: PrinterStatus): PrinterStatus {
  return {
    ...status,
    nozzles: status.nozzles.map((nozzle) => ({ ...nozzle })),
    lightModes: { ...status.lightModes },
    lightCapabilities: { ...status.lightCapabilities },
    filamentChange: {
      ...status.filamentChange,
      steps: [...status.filamentChange.steps]
    },
    commandTransport: { ...status.commandTransport },
    printStartOptions: status.printStartOptions
      ? {
          bedLevel: { ...status.printStartOptions.bedLevel },
          vibrationCompensation: { ...status.printStartOptions.vibrationCompensation },
          flowCalibration: { ...status.printStartOptions.flowCalibration },
          firstLayerInspection: { ...status.printStartOptions.firstLayerInspection },
          timelapse: { ...status.printStartOptions.timelapse },
          filamentDynamicsCalibration: { ...status.printStartOptions.filamentDynamicsCalibration },
          nozzleOffsetCalibration: { ...status.printStartOptions.nozzleOffsetCalibration }
        }
      : undefined,
    printOptions: structuredClone(status.printOptions),
    deviceError: status.deviceError ? { ...status.deviceError } : null,
    hmsErrors: status.hmsErrors.map((entry) => ({ ...entry })),
    amsSettings: { ...status.amsSettings },
    ams: status.ams.map((unit) => ({
      ...unit,
      slots: unit.slots.map((slot) => ({ ...slot }))
    })),
    externalSpools: status.externalSpools.map((spool) => ({ ...spool }))
  }
}

function buildCommandTransport(): PrinterStatus['commandTransport'] {
  return {
    mqttBedTemperature: false,
    mqttAxisControl: false,
    mqttHoming: false,
    newFanControl: false
  }
}

function buildNozzles(printer: Printer): PrinterStatus['nozzles'] {
  const fallbackDiameters: PrinterNozzleDiameterSelection[] = DUAL_NOZZLE_MODELS.has(printer.model)
    ? [
        { extruderId: 0, diameter: '0.4' },
        { extruderId: 1, diameter: '0.4' }
      ]
    : [{ extruderId: 0, diameter: '0.4' }]
  const configured = printer.currentNozzleDiameters.length > 0 ? printer.currentNozzleDiameters : fallbackDiameters
  return configured.map((entry) => ({
    extruderId: entry.extruderId,
    diameter: entry.diameter ?? '0.4',
    typeCode: entry.diameter === '0.6' ? 'HS01' : 'HS00',
    material: 'stainless-steel',
    flow: 'standard',
    currentTemp: 32,
    targetTemp: null
  }))
}

function buildPrintOptions(model: Printer['model']): PrinterPrintOptions {
  const capabilities = getPrinterPrintOptionCapabilities(model)
  return {
    aiMonitoring: { supported: capabilities.flowCalibration, enabled: capabilities.flowCalibration ? true : null, sensitivity: capabilities.flowCalibration ? 'medium' : null },
    spaghettiDetection: { supported: capabilities.flowCalibration, enabled: capabilities.flowCalibration ? true : null, sensitivity: capabilities.flowCalibration ? 'medium' : null },
    purgeChutePileupDetection: { supported: capabilities.flowCalibration, enabled: capabilities.flowCalibration ? true : null, sensitivity: capabilities.flowCalibration ? 'medium' : null },
    nozzleClumpingDetection: { supported: capabilities.flowCalibration, enabled: capabilities.flowCalibration ? false : null, sensitivity: capabilities.flowCalibration ? 'medium' : null },
    airPrintingDetection: { supported: capabilities.flowCalibration, enabled: capabilities.flowCalibration ? false : null, sensitivity: capabilities.flowCalibration ? 'medium' : null },
    firstLayerInspection: { supported: capabilities.firstLayerInspection, enabled: capabilities.firstLayerInspection ? true : null },
    autoRecovery: { supported: true, enabled: true },
    promptSound: { supported: true, enabled: true },
    filamentTangleDetection: { supported: true, enabled: true }
  }
}

function buildAmsUnits(printer: Printer): PrinterStatus['ams'] {
  const seed = findDemoPrinterSeed(printer)

  switch (seed?.serial) {
    case 'DEMO-X1C-001':
      return [
        {
          unitId: 0,
          nozzleId: 0,
          supportDrying: false,
          dryTimeRemainingMinutes: null,
          dryingActive: false,
          dryFilament: null,
          dryTemperature: null,
          dryDurationHours: null,
          humidityPercent: null,
          humidityLevel: 2,
          temperature: 27,
          slots: [
            makeSlot(0, { trayName: 'PLA Basic Gray', filamentType: 'PLA Basic', trayInfoIdx: 'GFA00', color: '#A8ADB4', remainPercent: 6, trayUuid: 'DEMO-RFID-X1C1-0', k: 0.018 }),
            makeSlot(1, { trayName: 'PLA Basic Gray', filamentType: 'PLA Basic', trayInfoIdx: 'GFA00', color: '#A8ADB4', remainPercent: 43, trayUuid: 'DEMO-RFID-X1C1-1', k: 0.018 }),
            makeSlot(2, { trayName: 'PETG HF Teal', filamentType: 'PETG HF', color: '#138A8A', remainPercent: 54, trayUuid: 'DEMO-RFID-X1C1-2', k: 0.024 }),
            makeSlot(3, { trayName: 'PLA Silk Copper', filamentType: 'PLA Silk', color: '#A05B32', remainPercent: 63, trayUuid: 'DEMO-RFID-X1C1-3', k: 0.022 })
          ]
        }
      ]
    case 'DEMO-X1C-002':
      return [
        {
          unitId: 0,
          nozzleId: 0,
          supportDrying: false,
          dryTimeRemainingMinutes: null,
          dryingActive: false,
          dryFilament: null,
          dryTemperature: null,
          dryDurationHours: null,
          humidityPercent: null,
          humidityLevel: 2,
          temperature: 26,
          slots: [
            makeSlot(0, { trayName: 'ABS Orange', filamentType: 'ABS', trayInfoIdx: 'GFB99', color: '#E05A2B', remainPercent: 52, trayUuid: 'DEMO-RFID-X1C2-0', k: 0.028 }),
            makeSlot(1, { trayName: 'PLA Matte White', filamentType: 'PLA Matte', trayInfoIdx: 'GFL00', color: '#F5F5F3', remainPercent: 36, trayUuid: 'DEMO-RFID-X1C2-1', k: 0.022 }),
            makeSlot(2, { trayName: 'PETG HF Ocean Blue', filamentType: 'PETG HF', color: '#2B5FDE', remainPercent: 58, trayUuid: 'DEMO-RFID-X1C2-2', k: 0.023 }),
            makeSlot(3, { trayName: 'ASA Charcoal', filamentType: 'ASA', trayInfoIdx: 'GFB02', color: '#4A4F57', remainPercent: 41, trayUuid: 'DEMO-RFID-X1C2-3', k: 0.026 })
          ]
        }
      ]
    case 'DEMO-P1S-001':
      return [
        {
          unitId: 0,
          nozzleId: 0,
          supportDrying: false,
          dryTimeRemainingMinutes: null,
          dryingActive: false,
          dryFilament: null,
          dryTemperature: null,
          dryDurationHours: null,
          humidityPercent: null,
          humidityLevel: 2,
          temperature: 27,
          slots: [
            makeSlot(0, { trayName: 'PLA Basic Scarlet Red', filamentType: 'PLA Basic', trayInfoIdx: 'GFA05', color: '#C73B3B', remainPercent: 33, trayUuid: 'DEMO-RFID-P1S1-0', k: 0.02 }),
            makeSlot(1, { trayName: 'PETG HF Black', filamentType: 'PETG HF', trayInfoIdx: 'GFG01', color: '#1C1C1C', remainPercent: 9, trayUuid: 'DEMO-RFID-P1S1-1', k: 0.023 }),
            makeSlot(2, { trayName: 'PETG HF Black', filamentType: 'PETG HF', trayInfoIdx: 'GFG01', color: '#1C1C1C', remainPercent: 66, trayUuid: 'DEMO-RFID-P1S1-2', k: 0.023 }),
            makeSlot(3, { trayName: 'PLA Matte Sakura Pink', filamentType: 'PLA Matte', color: '#E6A6B3', remainPercent: 47, trayUuid: 'DEMO-RFID-P1S1-3', k: 0.022 })
          ]
        }
      ]
    case 'DEMO-P1S-002':
      return [
        {
          unitId: 0,
          nozzleId: 0,
          supportDrying: false,
          dryTimeRemainingMinutes: null,
          dryingActive: false,
          dryFilament: null,
          dryTemperature: null,
          dryDurationHours: null,
          humidityPercent: null,
          humidityLevel: 3,
          temperature: 28,
          slots: [
            makeSlot(0, { trayName: 'PLA Basic Lime Green', filamentType: 'PLA Basic', color: '#74C365', remainPercent: 8, trayUuid: 'DEMO-RFID-P1S2-0', k: 0.019 }),
            makeSlot(1, { trayName: 'PLA Basic Lime Green', filamentType: 'PLA Basic', color: '#74C365', remainPercent: 48, trayUuid: 'DEMO-RFID-P1S2-1', k: 0.019 }),
            makeSlot(2, { trayName: 'PLA Basic Violet', filamentType: 'PLA Basic', color: '#7A5AF8', remainPercent: 52, trayUuid: 'DEMO-RFID-P1S2-2', k: 0.02 }),
            makeSlot(3, { trayName: 'PETG HF Glacier Blue', filamentType: 'PETG HF', color: '#67B7D1', remainPercent: 44, trayUuid: 'DEMO-RFID-P1S2-3', k: 0.024 })
          ]
        }
      ]
    case 'DEMO-H2D-001':
      return [
        {
          unitId: 0,
          nozzleId: 0,
          supportDrying: true,
          dryTimeRemainingMinutes: null,
          dryingActive: false,
          dryFilament: null,
          dryTemperature: null,
          dryDurationHours: null,
          humidityPercent: 23,
          humidityLevel: null,
          temperature: 28,
          slots: [
            makeSlot(0, { trayName: 'PLA Basic Gray', filamentType: 'PLA Basic', trayInfoIdx: 'GFA00', color: '#A8ADB4', remainPercent: 7, trayUuid: 'DEMO-RFID-H2D1-0', k: 0.018 }),
            makeSlot(1, { trayName: 'PLA Basic Gray', filamentType: 'PLA Basic', trayInfoIdx: 'GFA00', color: '#A8ADB4', remainPercent: 37, trayUuid: 'DEMO-RFID-H2D1-1', k: 0.018 }),
            makeSlot(2, { trayName: 'Generic PLA', filamentType: 'PLA', trayInfoIdx: 'GFL99', color: '#286C8E', remainPercent: 49, k: 0.024 }),
            makeSlot(3, { trayName: 'PLA Silk Gold', filamentType: 'PLA Silk', color: '#C89B3C', remainPercent: 59, trayUuid: 'DEMO-RFID-H2D1-3', k: 0.023 })
          ]
        },
        {
          unitId: 1,
          nozzleId: 1,
          supportDrying: true,
          dryTimeRemainingMinutes: 126,
          dryingActive: true,
          dryFilament: 'ABS',
          dryTemperature: 55,
          dryDurationHours: 6,
          humidityPercent: 19,
          humidityLevel: null,
          temperature: 33,
          slots: [
            makeSlot(0, { trayName: 'ABS Orange', filamentType: 'ABS', trayInfoIdx: 'GFB99', color: '#E05A2B', remainPercent: 11, trayUuid: 'DEMO-RFID-H2D1-4', k: 0.028 }),
            makeSlot(1, { trayName: 'ABS Orange', filamentType: 'ABS', trayInfoIdx: 'GFB99', color: '#E05A2B', remainPercent: 46, trayUuid: 'DEMO-RFID-H2D1-5', k: 0.028 }),
            makeSlot(2, { trayName: 'Support PLA', filamentType: 'Support PLA', trayInfoIdx: 'GFS02', color: '#D8E2EC', remainPercent: 33, trayUuid: 'DEMO-RFID-H2D1-6', k: 0.02 }),
            makeSlot(3, { trayName: 'PAHT-CF', filamentType: 'PAHT-CF', trayInfoIdx: 'GFN01', color: '#2B3037', remainPercent: 44, trayUuid: 'DEMO-RFID-H2D1-7', k: 0.031 })
          ]
        }
      ]
    case 'DEMO-H2D-002':
      return [
        {
          unitId: 0,
          nozzleId: 0,
          supportDrying: true,
          dryTimeRemainingMinutes: null,
          dryingActive: false,
          dryFilament: null,
          dryTemperature: null,
          dryDurationHours: null,
          humidityPercent: 21,
          humidityLevel: null,
          temperature: 29,
          slots: [
            makeSlot(0, { trayName: 'PETG HF Black', filamentType: 'PETG HF', trayInfoIdx: 'GFG01', color: '#1C1C1C', remainPercent: 8, trayUuid: 'DEMO-RFID-H2D2-0', k: 0.024 }),
            makeSlot(1, { trayName: 'PETG HF Black', filamentType: 'PETG HF', trayInfoIdx: 'GFG01', color: '#1C1C1C', remainPercent: 42, trayUuid: 'DEMO-RFID-H2D2-1', k: 0.024 }),
            makeSlot(2, { trayName: 'PLA Basic Jade', filamentType: 'PLA Basic', color: '#2FA86D', remainPercent: 63, trayUuid: 'DEMO-RFID-H2D2-2', k: 0.019 }),
            makeSlot(3, { trayName: 'PLA Matte Lavender', filamentType: 'PLA Matte', color: '#B8A3D7', remainPercent: 39, trayUuid: 'DEMO-RFID-H2D2-3', k: 0.022 })
          ]
        },
        {
          unitId: 1,
          nozzleId: 1,
          supportDrying: true,
          dryTimeRemainingMinutes: 84,
          dryingActive: true,
          dryFilament: 'ABS',
          dryTemperature: 55,
          dryDurationHours: 4,
          humidityPercent: 18,
          humidityLevel: null,
          temperature: 32,
          slots: [
            makeSlot(0, { trayName: 'ABS Orange', filamentType: 'ABS', trayInfoIdx: 'GFB99', color: '#E05A2B', remainPercent: 14, trayUuid: 'DEMO-RFID-H2D2-4', k: 0.028 }),
            makeSlot(1, { trayName: 'ABS Orange', filamentType: 'ABS', trayInfoIdx: 'GFB99', color: '#E05A2B', remainPercent: 51, trayUuid: 'DEMO-RFID-H2D2-5', k: 0.028 }),
            makeSlot(2, { trayName: 'Support PLA', filamentType: 'Support PLA', trayInfoIdx: 'GFS02', color: '#D8E2EC', remainPercent: 28, trayUuid: 'DEMO-RFID-H2D2-6', k: 0.02 }),
            makeSlot(3, { trayName: 'PAHT-CF', filamentType: 'PAHT-CF', trayInfoIdx: 'GFN01', color: '#2B3037', remainPercent: 53, trayUuid: 'DEMO-RFID-H2D2-7', k: 0.031 })
          ]
        }
      ]
    default:
      break
  }

  if (DUAL_NOZZLE_MODELS.has(printer.model)) {
    return [
      {
        unitId: 0,
        nozzleId: 0,
        supportDrying: true,
        dryTimeRemainingMinutes: null,
        dryingActive: false,
        dryFilament: null,
        dryTemperature: null,
        dryDurationHours: null,
        humidityPercent: 23,
        humidityLevel: null,
        temperature: 28,
        slots: [
          makeSlot(0, { trayName: 'PLA Basic Gray', filamentType: 'PLA Basic', trayInfoIdx: 'GFA00', color: '#A8ADB4', remainPercent: 74, trayUuid: 'DEMO-RFID-0-0', k: 0.018 }),
          makeSlot(1, { trayName: 'PLA Matte White', filamentType: 'PLA Matte', trayInfoIdx: 'GFL00', color: '#F5F5F3', remainPercent: 61, trayUuid: 'DEMO-RFID-0-1', k: 0.022 }),
          makeSlot(2, { trayName: 'PETG HF Black', filamentType: 'PETG HF', trayInfoIdx: 'GFG01', color: '#1C1C1C', remainPercent: 49, trayUuid: 'DEMO-RFID-0-2', k: 0.024 }),
          makeSlot(3)
        ]
      },
      {
        unitId: 1,
        nozzleId: 1,
        supportDrying: true,
        dryTimeRemainingMinutes: 126,
        dryingActive: true,
        dryFilament: 'PETG',
        dryTemperature: 55,
        dryDurationHours: 6,
        humidityPercent: 19,
        humidityLevel: null,
        temperature: 33,
        slots: [
          makeSlot(0, { trayName: 'ABS Orange', filamentType: 'ABS', trayInfoIdx: 'GFB99', color: '#E05A2B', remainPercent: 52, trayUuid: 'DEMO-RFID-1-0', k: 0.028 }),
          makeSlot(1, { trayName: 'Support PLA', filamentType: 'Support PLA', trayInfoIdx: 'GFS02', color: '#D8E2EC', remainPercent: 33, trayUuid: 'DEMO-RFID-1-1', k: 0.02 }),
          makeSlot(2, { trayName: 'PAHT-CF', filamentType: 'PAHT-CF', trayInfoIdx: 'GFN01', color: '#2B3037', remainPercent: 44, trayUuid: 'DEMO-RFID-1-2', k: 0.031 }),
          makeSlot(3)
        ]
      }
    ]
  }

  return [{
    unitId: 0,
    nozzleId: 0,
    supportDrying: false,
    dryTimeRemainingMinutes: null,
    dryingActive: false,
    dryFilament: null,
    dryTemperature: null,
    dryDurationHours: null,
    humidityPercent: null,
    humidityLevel: 2,
    temperature: 27,
    slots: [
      makeSlot(0, { trayName: 'PLA Basic Gray', filamentType: 'PLA Basic', trayInfoIdx: 'GFA00', color: '#A8ADB4', remainPercent: 72, trayUuid: 'DEMO-RFID-AMS-0', k: 0.018 }),
      makeSlot(1, { trayName: 'PETG HF Black', filamentType: 'PETG HF', trayInfoIdx: 'GFG01', color: '#1C1C1C', remainPercent: 58, trayUuid: 'DEMO-RFID-AMS-1', k: 0.023 }),
      makeSlot(2, { trayName: 'PLA Matte White', filamentType: 'PLA Matte', trayInfoIdx: 'GFL00', color: '#F5F5F3', remainPercent: 37, trayUuid: 'DEMO-RFID-AMS-2', k: 0.022 }),
      makeSlot(3)
    ]
  }]
}

function buildExternalSpools(printer: Printer): PrinterStatus['externalSpools'] {
  const spools: PrinterStatus['externalSpools'] = [
    {
      amsId: 255,
      nozzleId: 0,
      trayName: 'Manual PLA-CF',
      filamentType: 'PLA-CF',
      color: '#4C4F54',
      colors: ['#4C4F54'],
      remainPercent: 41,
      active: false,
      trayInfoIdx: 'GFA00',
      caliIdx: -1,
      k: 0.025,
      trayUuid: null
    }
  ]

  if (DUAL_NOZZLE_MODELS.has(printer.model)) {
    spools.push({
      amsId: 254,
      nozzleId: 1,
      trayName: 'Manual TPU 95A',
      filamentType: 'TPU 95A',
      color: '#2F7ECA',
      colors: ['#2F7ECA'],
      remainPercent: 63,
      active: false,
      trayInfoIdx: 'GFU03',
      caliIdx: -1,
      k: 0.03,
      trayUuid: null
    })
  }

  return spools
}

function makeSlot(
  slot: number,
  overrides: Partial<PrinterStatus['ams'][number]['slots'][number]> = {}
): PrinterStatus['ams'][number]['slots'][number] {
  const color = overrides.color ?? null
  return {
    slot,
    trayName: overrides.trayName ?? null,
    filamentType: overrides.filamentType ?? null,
    color,
    colors: overrides.colors ?? (color ? [color] : []),
    remainPercent: overrides.remainPercent ?? null,
    active: overrides.active ?? false,
    isReading: overrides.isReading ?? false,
    trayInfoIdx: overrides.trayInfoIdx ?? null,
    caliIdx: overrides.caliIdx ?? -1,
    k: overrides.k ?? null,
    trayUuid: overrides.trayUuid ?? null
  }
}
