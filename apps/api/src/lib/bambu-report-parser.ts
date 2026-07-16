/**
 * Pure Bambu MQTT report -> PrinterStatus parser.
 *
 * Owns the stateless translation from Bambu's partial `report` payloads
 * into the normalized {@link PrinterStatus} contract: {@link parseReport}
 * plus every stateless helper it calls (AMS/tray, nozzle, light, fan,
 * temperature, IP/hex/bit decoders) and the {@link makeOfflineStatus}
 * default-status builder.
 *
 * This module holds no manager/singleton state: nothing here references the
 * PrinterManager class, the live connection map, or any mutable per-printer
 * cache. The manager imports these functions; the dependency is one-way
 * (manager -> parser), so this module must never import `./printer-manager.js`.
 *
 * The parser is intentionally tolerant: unknown fields are ignored rather
 * than rejected so firmware updates do not break the connection.
 */
import {
  amsUnitTypeFromCode,
  getPrinterDisplayCapabilities,
  getPrinterPrintStartOptions,
  getPrinterControlCapabilities,
  normalizeNozzleDiameter,
  printerModelSchema,
  printerPressureAdvanceProfileSchema,
  supportsPrinterAirductMode,
  supportsPrinterDoorSensor,
  supportsPrinterSecondaryChamberLight,
  type Printer,
  type PrinterAmsDryingPhase,
  type PrinterAirductMode,
  type PrinterFirmwareModule,
  type PrinterLightMode,
  type PrinterPressureAdvanceProfile,
  type PrinterStage,
  type PrinterStatus
} from '@printstream/shared'
import {
  formatHmsCode,
  formatPrintErrorCode,
  getHmsDeviceType,
  lookupHmsMessage
} from './hms-codes.js'
import { parseTrayColor, parseTrayColors } from './tray-colors.js'

const VIRTUAL_TRAY_MAIN_ID = 255
const VIRTUAL_TRAY_DEPUTY_ID = 254
const HEATBED_LIGHT_MODELS = new Set<Printer['model']>(['H2D', 'H2DPRO', 'H2C', 'H2S'])

type ActiveTraySelections = Map<number, { amsId: number; slot: number } | null>

export function makeOfflineStatus(printer: Printer): PrinterStatus {
  return {
    printerId: printer.id,
    online: false,
    stage: 'unknown',
    subStage: null,
    filamentChange: makeDefaultFilamentChange(),
    progressPercent: null,
    currentLayer: null,
    totalLayers: null,
    remainingMinutes: null,
    jobId: null,
    taskId: null,
    jobName: null,
    lastJobName: null,
    gcodeFile: null,
    bedTemp: null,
    bedTarget: null,
    nozzleTemp: null,
    nozzleTarget: null,
    nozzles: [],
    nozzleRack: null,
    filamentTrackSwitch: null,
    chamberTemp: null,
    chamberTarget: null,
    fanGearSpeed: null,
    partFanPercent: null,
    auxFanPercent: null,
    chamberFanPercent: null,
    wifiSignalDbm: null,
    ipAddress: null,
    doorOpen: null,
    ductMode: null,
    ductAvailableModes: [],
    lightModes: {
      chamber: null,
      heatbed: null,
      work: null
    },
    lightCapabilities: {
      chamber: false,
      heatbed: false,
      work: false
    },
    chamberLightOffRequiresConfirm: false,
    lightOn: null,
    speedLevel: null,
    commandTransport: makeDefaultCommandTransport(),
    printStartOptions: getPrinterPrintStartOptions(printer.model, null),
    printOptions: makeDefaultPrintOptions(),
    deviceError: null,
    hmsErrors: [],
    amsSettings: {
      detectOnInsert: null,
      detectOnPowerup: null,
      remainEnabled: null,
      autoRefill: null,
      supportFilamentBackup: null
    },
    ams: [],
    externalSpools: buildDefaultExternalSpools(printer),
    firmwareVersion: null,
    firmwareModules: [],
    sdCardPresent: null,
    skippedObjectIds: null,
    connectionWarnings: [],
    observedAt: new Date().toISOString()
  }
}

/**
 * Normalize the `module` array from a `get_version` reply into the typed
 * {@link PrinterFirmwareModule} list. Skips entries without a name or a
 * usable `sw_ver` (some controllers report an empty version).
 */
function parseFirmwareModules(rawModules: unknown[]): PrinterFirmwareModule[] {
  const modules: PrinterFirmwareModule[] = []
  for (const entry of rawModules) {
    if (!isObject(entry)) continue
    const name = typeof entry.name === 'string' ? entry.name.trim() : ''
    const version = typeof entry.sw_ver === 'string' ? entry.sw_ver.trim() : ''
    if (name === '' || version === '') continue
    const hardwareVersion = typeof entry.hw_ver === 'string' && entry.hw_ver.trim() !== ''
      ? entry.hw_ver.trim()
      : null
    modules.push({ name, version, hardwareVersion })
  }
  return modules
}

const BAMBU_FILAMENT_CHANGE_STEP_LABELS: Record<number, string> = {
  0: 'Idling...',
  1: 'Pause',
  2: 'Heat the nozzle',
  3: 'Cut filament',
  4: 'Pull back current filament',
  5: 'Push new filament into extruder',
  6: 'Grab new filament',
  7: 'Purge old filament',
  8: 'Check filament location',
  9: 'Switch extruder',
  10: 'Switch hotend',
  11: 'Wait for AMS cooling',
  12: 'Switch current filament at Filament Track Switch',
  13: 'Pull back current filament at Filament Track Switch',
  14: 'Switch track at Filament Track Switch',
  15: 'Confirm extruded'
}

function makeDefaultFilamentChange(): PrinterStatus['filamentChange'] {
  return {
    currentStepIndex: null,
    currentStepLabel: null,
    steps: []
  }
}

function mapFilamentChangeStepLabel(stepCode: number | null): string | null {
  if (stepCode == null || stepCode <= 1) return null
  return BAMBU_FILAMENT_CHANGE_STEP_LABELS[stepCode] ?? null
}

function parseFilamentChange(print: Record<string, unknown>, currentStatus?: PrinterStatus): PrinterStatus['filamentChange'] | null {
  const previous = currentStatus?.filamentChange ?? makeDefaultFilamentChange()
  let nextSteps = previous.steps
  let nextCurrentStepLabel = previous.currentStepLabel
  let sawUpdate = false

  const ams = isObject(print.ams) ? print.ams : null
  if (ams) {
    sawUpdate = true
    nextSteps = Array.isArray(ams.cfs)
      ? ams.cfs
        .map((step) => mapFilamentChangeStepLabel(intOrNull(step)))
        .filter((step): step is string => step !== null)
      : []
  }

  const device = isObject(print.device) ? print.device : null
  const extruder = device && isObject(device.extruder) ? device.extruder : null
  const extruderInfo = extruder && Array.isArray(extruder.info)
    ? extruder.info.filter(isObject)
    : null

  if (extruderInfo) {
    let nextCurrentStepCode: number | null = null
    let sawExtruderStat = false

    for (const entry of extruderInfo) {
      const stat = intOrNull(entry.stat)
      if (stat == null) continue
      sawExtruderStat = true
      const stepCode = stat & 0xff
      if (mapFilamentChangeStepLabel(stepCode) != null) {
        nextCurrentStepCode = stepCode
        break
      }
      if (stepCode <= 1) {
        nextCurrentStepCode = null
      }
    }

    if (sawExtruderStat) {
      sawUpdate = true
      nextCurrentStepLabel = mapFilamentChangeStepLabel(nextCurrentStepCode)
    }
  }

  if (!sawUpdate) return null

  const currentStepIndex = nextCurrentStepLabel ? nextSteps.indexOf(nextCurrentStepLabel) : -1
  return {
    currentStepIndex: currentStepIndex >= 0 ? currentStepIndex : null,
    currentStepLabel: nextCurrentStepLabel,
    steps: nextSteps
  }
}

function buildDefaultExternalSpools(printer: Printer): PrinterStatus['externalSpools'] {
  const spools: PrinterStatus['externalSpools'] = [{
    amsId: VIRTUAL_TRAY_MAIN_ID,
    nozzleId: 0,
    trayName: null,
    filamentType: null,
    color: null,
    colors: [],
    remainPercent: null,
    active: false,
    trayInfoIdx: null,
    caliIdx: null,
    k: null,
    trayUuid: null
  }]

  if (getPrinterControlCapabilities(printer.model).dualNozzles) {
    spools.push({
      amsId: VIRTUAL_TRAY_DEPUTY_ID,
      nozzleId: 1,
      trayName: null,
      filamentType: null,
      color: null,
      colors: [],
      remainPercent: null,
      active: false,
      trayInfoIdx: null,
      caliIdx: null,
      k: null,
      trayUuid: null
    })
  }

  return spools
}

type AmsUnitNozzleMap = Map<number, number>
type InstalledNozzleSpec = {
  diameter: string | null
  typeCode: PrinterStatus['nozzles'][number]['typeCode']
  material: PrinterStatus['nozzles'][number]['material']
  flow: PrinterStatus['nozzles'][number]['flow']
}

function parseCurrentStageCode(print: Record<string, unknown>): string | null {
  const rawStageCode = print.stg_cur ?? print.stage_curr

  if (typeof rawStageCode === 'string' && /^-?\d+$/.test(rawStageCode)) {
    return rawStageCode
  }

  if (typeof rawStageCode === 'number' && Number.isFinite(rawStageCode)) {
    return String(Math.trunc(rawStageCode))
  }

  return null
}

function parseSubStageCode(print: Record<string, unknown>): string | null {
  const rawSubStage = print.mc_print_sub_stage

  if (typeof rawSubStage === 'string' && /^-?\d+$/.test(rawSubStage)) {
    return rawSubStage
  }

  if (typeof rawSubStage === 'number' && Number.isFinite(rawSubStage)) {
    return String(Math.trunc(rawSubStage))
  }

  return null
}

function parsePrintState(print: Record<string, unknown>): string | null {
  if (typeof print.print_status === 'string' && print.print_status.trim() !== '') {
    return print.print_status
  }

  if (typeof print.gcode_state === 'string' && print.gcode_state.trim() !== '') {
    return print.gcode_state
  }

  return null
}

function isSentinelSubStageCode(value: string | null): boolean {
  return value === '0' || value === '-1' || value === '255'
}

export function parseReport(value: unknown, printer: Printer, currentStatus?: PrinterStatus): Partial<PrinterStatus> | null {
  if (!value || typeof value !== 'object') return null
  const root = value as Record<string, unknown>

  // `info.command = "get_version"` is the reply to our post-connect version
  // request. It carries a list of modules. `ota` is the human-facing firmware
  // version Bambu publishes on its wiki / firmware download page; the rest
  // (each AMS unit, the various controllers) are surfaced as `firmwareModules`
  // so callers can tell when, e.g., an AMS unit lags the main firmware.
  const info = isObject(root.info) ? root.info : null
  if (info && info.command === 'get_version' && Array.isArray(info.module)) {
    const modules = parseFirmwareModules(info.module)
    if (modules.length > 0) {
      const ota = modules.find((module) => module.name === 'ota')
      const delta: Partial<PrinterStatus> = { firmwareModules: modules }
      if (ota) delta.firmwareVersion = ota.version
      return delta
    }
  }

  const system = isObject(root.system) ? root.system : null
  const systemLightDelta = system ? parseSystemLightDelta(system, printer.model, currentStatus) : null

  const print = isObject(root.print) ? root.print : null
  if (!print) return systemLightDelta

  const delta: Partial<PrinterStatus> = {}
  if (systemLightDelta) Object.assign(delta, systemLightDelta)

  if ('sdcard' in print) {
    const raw = print.sdcard
    if (typeof raw === 'boolean') {
      delta.sdCardPresent = raw
    } else if (typeof raw === 'string') {
      const upper = raw.toUpperCase()
      delta.sdCardPresent = upper.includes('HAS_SDCARD') || upper === 'TRUE' || upper === 'NORMAL' || upper === '1'
    } else if (typeof raw === 'number') {
      delta.sdCardPresent = raw !== 0
    }
  }

  // `s_obj` lists the instance identify_ids the firmware currently skips for the
  // running print (partskip-capable firmware only). An empty array is a real state
  // ("nothing skipped"), so it is applied too; a malformed value is ignored like any
  // other unknown field. The status stays null until the printer first reports it.
  if (Array.isArray(print.s_obj)) {
    delta.skippedObjectIds = print.s_obj
      .map((value) => intOrNull(value))
      .filter((value): value is number => value !== null)
  }

  const printState = parsePrintState(print)
  if (printState) {
    delta.stage = mapStage(printState)
  }
  const rawSubStageCode = parseSubStageCode(print)
  const currentStageCode = parseCurrentStageCode(print)
  if (rawSubStageCode && !isSentinelSubStageCode(rawSubStageCode)) {
    delta.subStage = rawSubStageCode
  } else if (currentStageCode) {
    delta.subStage = currentStageCode
  } else if (rawSubStageCode) {
    delta.subStage = rawSubStageCode
  }
  const filamentChange = parseFilamentChange(print, currentStatus)
  if (filamentChange) {
    delta.filamentChange = filamentChange
  }
  if (typeof print.mc_percent === 'number') {
    delta.progressPercent = clampPercent(print.mc_percent)
  }
  assignLayerProgress(delta, print)
  if (typeof print.mc_remaining_time === 'number') {
    delta.remainingMinutes = Math.max(0, Math.round(print.mc_remaining_time))
  }
  if (typeof print.job_id === 'string') {
    delta.jobId = print.job_id || null
  } else if (typeof print.job_id === 'number' && Number.isFinite(print.job_id)) {
    delta.jobId = String(Math.trunc(print.job_id))
  }
  if (typeof print.task_id === 'string') {
    delta.taskId = print.task_id || null
  } else if (typeof print.task_id === 'number' && Number.isFinite(print.task_id)) {
    delta.taskId = String(Math.trunc(print.task_id))
  }
  if (typeof print.subtask_name === 'string') {
    delta.jobName = print.subtask_name || null
  }
  if (typeof print.gcode_file === 'string') {
    delta.gcodeFile = print.gcode_file || null
  }

  assignNumber(delta, 'bedTemp', print.bed_temper)
  assignNumber(delta, 'bedTarget', print.bed_target_temper)
  assignNumber(delta, 'nozzleTemp', print.nozzle_temper)
  assignNumber(delta, 'nozzleTarget', print.nozzle_target_temper)
  const nozzles = parseNozzles(print, currentStatus?.nozzles ?? [])
  if (nozzles) {
    delta.nozzles = nozzles
    const primaryNozzle = nozzles.find((nozzle) => nozzle.extruderId === 0) ?? nozzles[0]
    if (primaryNozzle) {
      delta.nozzleTemp = primaryNozzle.currentTemp
      delta.nozzleTarget = primaryNozzle.targetTemp
    }
  }
  const nozzleRack = parseNozzleRack(print, currentStatus?.nozzleRack ?? null)
  if (nozzleRack !== undefined) delta.nozzleRack = nozzleRack

  const filamentTrackSwitch = parseFilamentTrackSwitch(print, currentStatus?.filamentTrackSwitch ?? null)
  if (filamentTrackSwitch !== undefined) delta.filamentTrackSwitch = filamentTrackSwitch
  assignChamberTemperature(delta, print, printer.model)
  assignFanSpeed(delta, 'fanGearSpeed', print.fan_gear)
  assignFanSpeed(delta, 'partFanPercent', print.cooling_fan_speed)
  assignFanSpeed(delta, 'auxFanPercent', print.big_fan1_speed)
  assignFanSpeed(delta, 'chamberFanPercent', print.big_fan2_speed)

  if ('wifi_signal' in print) {
    const wifiSignalDbm = parseWifiSignalDbm(print.wifi_signal)
    if (wifiSignalDbm !== null) delta.wifiSignalDbm = wifiSignalDbm
  }

  if ('net' in print) {
    const ipAddress = parseReportedIpAddress(print.net)
    if (ipAddress !== null) delta.ipAddress = ipAddress
  }

  const doorOpen = parseDoorOpen(print, printer.model)
  if (doorOpen !== null) delta.doorOpen = doorOpen

  const ductMode = parseDuctMode(print.device, printer.model)
  if (ductMode !== null) delta.ductMode = ductMode

  const ductAvailableModes = parseDuctAvailableModes(print.device, printer.model)
  if (ductAvailableModes !== null) delta.ductAvailableModes = ductAvailableModes

  if (typeof print.spd_lvl === 'number') {
    delta.speedLevel = print.spd_lvl
  }

  const chamberLightOffRequiresConfirm = parseChamberLightOffRequiresConfirm(print.stat)
  if (chamberLightOffRequiresConfirm !== null) {
    delta.chamberLightOffRequiresConfirm = chamberLightOffRequiresConfirm
  }

  delta.commandTransport = parseCommandTransport(print, currentStatus?.commandTransport)

  const lightCapabilities = resolveLightCapabilities('lights_report' in print ? print.lights_report : null, printer.model, currentStatus?.lightCapabilities)
  if (!sameLightCapabilities(lightCapabilities, currentStatus?.lightCapabilities)) {
    delta.lightCapabilities = lightCapabilities
  }

  if ('lights_report' in print) {
    const lightModes = parseLightModes(print.lights_report, currentStatus?.lightModes)
    if (lightModes !== null) {
      delta.lightModes = lightModes
      if (lightModes.chamber === 'on' || lightModes.chamber === 'off') {
        delta.lightOn = lightModes.chamber === 'on'
      }
    }
  }

  if ('hms' in print || 'print_error' in print) {
    const deviceType = getHmsDeviceType(printer.serial)
    if ('hms' in print) {
      delta.hmsErrors = parseHmsErrors(print.hms, deviceType)
    }
    if ('print_error' in print) {
      delta.deviceError = parseDeviceError(print.print_error, deviceType)
    }
    // When only `print_error` arrives without the `hms` array, preserve
    // existing HMS entries so a partial clear doesn't wipe unrelated errors.
    if (!('hms' in print) && delta.hmsErrors?.length === 0) {
      delete delta.hmsErrors
    }
  }

  delta.printOptions = parsePrintOptions(print, currentStatus?.printOptions)
  delta.printStartOptions = getPrinterPrintStartOptions(printer.model, { printOptions: delta.printOptions })

  delta.amsSettings = parseAmsSettings(print, currentStatus?.amsSettings)

  if (isObject(print.ams)) {
    const amsNozzleMap = parseAmsUnitNozzleMap(print)
    const ams = parseAms(print.ams, currentStatus?.ams ?? [], amsNozzleMap)
    if (ams) delta.ams = ams
  } else {
    const amsNozzleMap = parseAmsUnitNozzleMap(print)
    if (amsNozzleMap && currentStatus?.ams.length) {
      delta.ams = applyAmsUnitNozzleMap(currentStatus.ams, amsNozzleMap)
    }
  }

  const externalSpools = parseExternalSpools(print, currentStatus?.externalSpools ?? [], printer.model)
  if (externalSpools) delta.externalSpools = externalSpools

  const pressureAdvanceStateDelta = parsePressureAdvanceStateDelta(
    print,
    delta.ams ?? currentStatus?.ams ?? [],
    delta.externalSpools ?? currentStatus?.externalSpools ?? []
  )
  if (pressureAdvanceStateDelta) {
    delta.ams = pressureAdvanceStateDelta.ams
    delta.externalSpools = pressureAdvanceStateDelta.externalSpools
  }

  const activeTraySelections = parseActiveTraySelections(print)
  if (activeTraySelections) {
    const highlighted = applyActiveTraySelections(
      delta.ams ?? currentStatus?.ams ?? [],
      delta.externalSpools ?? currentStatus?.externalSpools ?? [],
      activeTraySelections
    )
    delta.ams = highlighted.ams
    delta.externalSpools = highlighted.externalSpools
  }

  return delta
}


function assignNumber(target: Partial<PrinterStatus>, key: keyof PrinterStatus, value: unknown): void {
  const n = numberOrNull(value)
  if (n !== null) {
    ;(target as Record<string, unknown>)[key as string] = n
  }
}

function assignLayerProgress(target: Partial<PrinterStatus>, print: Record<string, unknown>): void {
  const currentLayer = roundedNonNegativeInt(numberOrNull(print.layer_num))
  const totalLayers = roundedNonNegativeInt(numberOrNull(print.total_layer_num))

  if (currentLayer !== null) target.currentLayer = currentLayer
  if (totalLayers !== null) target.totalLayers = totalLayers
}

/**
 * Chamber temperature arrives in both the legacy `print.chamber_temper`
 * field and the newer V2 `print.device.ctc.info.temp` bit-packed payload.
 * Prefer the V2 reading when present so H2D/H2C chambers surface live temp.
 */
function assignChamberTemperature(
  target: Partial<PrinterStatus>,
  print: Record<string, unknown>,
  model: Printer['model']
): void {
  if (!getPrinterDisplayCapabilities(model).chamberTemperature) return

  assignNumber(target, 'chamberTemp', print.chamber_temper)
  assignNumber(target, 'chamberTarget', print.ctt)

  const device = isObject(print.device) ? print.device : null
  const ctc = device && isObject(device.ctc) ? device.ctc : null
  const info = ctc && isObject(ctc.info) ? ctc.info : null
  const packedTemp = info ? numberOrNull(info.temp) : null
  if (packedTemp === null) return

  ;(target as Record<string, unknown>).chamberTemp = packedTemp >>> 0 & 0xffff
  ;(target as Record<string, unknown>).chamberTarget = packedTemp >>> 16 & 0xffff
}

/**
 * Bambu reports fan speed as either a 0-100 percentage or a stringified
 * 0-15 gear value. Normalize both to a 0-100 percent so the UI can render
 * a single bar regardless of source.
 */
function assignFanSpeed(target: Partial<PrinterStatus>, key: keyof PrinterStatus, value: unknown): void {
  let n: number | null = null
  if (typeof value === 'number' && Number.isFinite(value)) {
    n = value
  } else if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) n = parsed
  }
  if (n === null) return
  if (n <= 15) n = Math.round((n / 15) * 100)
  ;(target as Record<string, unknown>)[key as string] = Math.max(0, Math.min(100, n))
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, value))
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function intOrNull(value: unknown): number | null {
  const numeric = numberOrNull(value)
  return numeric === null ? null : Math.round(numeric)
}

function booleanishOrNull(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value !== 0
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true' || normalized === '1' || normalized === 'on') return true
    if (normalized === 'false' || normalized === '0' || normalized === 'off') return false
  }
  return null
}

function parseWifiSignalDbm(value: unknown): number | null {
  const numeric = numberOrNull(value)
  if (numeric !== null) return Math.round(numeric)
  if (typeof value !== 'string') return null

  const match = value.match(/(-?\d+)/)
  return match ? Number(match[1]) : null
}

function parseReportedIpAddress(value: unknown): string | null {
  if (!isObject(value) || !Array.isArray(value.info)) return null

  for (const entry of value.info) {
    if (!isObject(entry)) continue
    const rawIp = numberOrNull(entry.ip)
    if (rawIp == null || rawIp <= 0) continue
    return littleEndianIpv4(rawIp)
  }

  return null
}

function littleEndianIpv4(value: number): string {
  const normalized = value >>> 0
  return [
    normalized & 0xff,
    normalized >>> 8 & 0xff,
    normalized >>> 16 & 0xff,
    normalized >>> 24 & 0xff
  ].join('.')
}

function roundedNonNegativeInt(value: number | null): number | null {
  if (value === null) return null
  return Math.max(0, Math.round(value))
}

const HOME_FLAG_DOOR_OPEN_MASK = 0x00800000
const STAT_DOOR_OPEN_MASK = 0x00800000

function parseDoorOpen(print: Record<string, unknown>, model: Printer['model']): boolean | null {
  if (!supportsPrinterDoorSensor(model)) return null

  if ((model === 'X1' || model === 'X1C' || model === 'X1E') && 'home_flag' in print) {
    const homeFlag = numberOrNull(print.home_flag)
    if (homeFlag !== null) return ((homeFlag >>> 0) & HOME_FLAG_DOOR_OPEN_MASK) !== 0
  }

  if ((model === 'X2D' || model === 'P2S' || model === 'H2D' || model === 'H2DPRO' || model === 'H2C' || model === 'H2S') && typeof print.stat === 'string') {
    const statValue = Number.parseInt(print.stat, 16)
    if (Number.isFinite(statValue)) return (((statValue >>> 0) & STAT_DOOR_OPEN_MASK) !== 0)
  }

  return null
}

const AIRDUCT_MODE_MAP: Record<number, PrinterAirductMode> = {
  0: 'cooling',
  1: 'heating',
  2: 'laser'
}

const LIGHT_NODE_MAP = {
  chamber_light: 'chamber',
  heatbed_light: 'heatbed',
  work_light: 'work'
} as const

const SECONDARY_CHAMBER_LIGHT_NODE = 'chamber_light2'

function parseDuctMode(value: unknown, model: Printer['model']): PrinterAirductMode | null {
  if (!supportsPrinterAirductMode(model)) return null
  if (!isObject(value) || !isObject(value.airduct)) return null

  const modeId = roundedNonNegativeInt(numberOrNull(value.airduct.modeCur))
  if (modeId === null) return null
  return AIRDUCT_MODE_MAP[modeId] ?? null
}

function parseDuctAvailableModes(value: unknown, model: Printer['model']): PrinterStatus['ductAvailableModes'] | null {
  if (!supportsPrinterAirductMode(model)) return null
  if (!isObject(value) || !isObject(value.airduct) || !Array.isArray(value.airduct.modeList)) return null

  const modes: PrinterStatus['ductAvailableModes'] = []
  for (const entry of value.airduct.modeList) {
    if (!isObject(entry)) continue
    const modeId = roundedNonNegativeInt(numberOrNull(entry.modeId))
    if (modeId == null) continue
    const mode = AIRDUCT_MODE_MAP[modeId]
    if ((mode === 'cooling' || mode === 'heating') && !modes.includes(mode)) {
      modes.push(mode)
    }
  }
  return modes
}

function resolveLightCapabilities(
  value: unknown,
  model: Printer['model'],
  current: PrinterStatus['lightCapabilities'] | undefined
): PrinterStatus['lightCapabilities'] {
  const next: PrinterStatus['lightCapabilities'] = {
    chamber: true,
    heatbed: current?.heatbed ?? HEATBED_LIGHT_MODELS.has(model),
    work: current?.work ?? false
  }

  if (supportsPrinterSecondaryChamberLight(model)) {
    next.chamber = true
  }

  if (!Array.isArray(value)) return next
  for (const entry of value) {
    if (!isObject(entry) || typeof entry.node !== 'string') continue
    if (entry.node === SECONDARY_CHAMBER_LIGHT_NODE) {
      next.chamber = true
      continue
    }
    const node = LIGHT_NODE_MAP[entry.node as keyof typeof LIGHT_NODE_MAP]
    if (node) next[node] = true
  }

  return next
}

function sameLightCapabilities(
  next: PrinterStatus['lightCapabilities'],
  current: PrinterStatus['lightCapabilities'] | undefined
): boolean {
  if (!current) return false
  return next.chamber === current.chamber
    && next.heatbed === current.heatbed
    && next.work === current.work
}

function parseLightModes(
  value: unknown,
  current: PrinterStatus['lightModes'] | undefined
): PrinterStatus['lightModes'] | null {
  if (!Array.isArray(value)) return null

  const next: PrinterStatus['lightModes'] = {
    chamber: current?.chamber ?? null,
    heatbed: current?.heatbed ?? null,
    work: current?.work ?? null
  }
  let changed = false
  let chamberModeFromSecondary: PrinterLightMode | null = null
  let sawPrimaryChamber = false

  for (const entry of value) {
    if (!isObject(entry) || typeof entry.node !== 'string') continue
    if (entry.node === SECONDARY_CHAMBER_LIGHT_NODE) {
      chamberModeFromSecondary = parseLightMode(entry.mode)
      continue
    }
    const node = LIGHT_NODE_MAP[entry.node as keyof typeof LIGHT_NODE_MAP]
    const mode = parseLightMode(entry.mode)
    if (!node || mode == null || next[node] === mode) continue
    if (node === 'chamber') {
      sawPrimaryChamber = true
    }
    next[node] = mode
    changed = true
  }

  if (!sawPrimaryChamber && chamberModeFromSecondary != null && next.chamber !== chamberModeFromSecondary) {
    next.chamber = chamberModeFromSecondary
    changed = true
  }

  return changed ? next : null
}

function parseLightMode(value: unknown): PrinterLightMode | null {
  if (typeof value !== 'string') return null
  switch (value) {
    case 'on':
    case 'off':
    case 'flashing':
    case 'unknown':
      return value
    default:
      return 'unknown'
  }
}

function parseSystemLightDelta(
  value: Record<string, unknown>,
  model: Printer['model'],
  currentStatus: PrinterStatus | undefined
): Partial<PrinterStatus> | null {
  if (value.command !== 'ledctrl' || typeof value.led_node !== 'string') return null

  const mode = parseLightMode(value.led_mode)
  if (mode == null) return null

  if (value.led_node === SECONDARY_CHAMBER_LIGHT_NODE && currentStatus?.lightModes.chamber != null) {
    return null
  }

  const node = value.led_node === SECONDARY_CHAMBER_LIGHT_NODE
    ? 'chamber'
    : LIGHT_NODE_MAP[value.led_node as keyof typeof LIGHT_NODE_MAP]
  if (!node) return null

  const lightModes: PrinterStatus['lightModes'] = {
    chamber: currentStatus?.lightModes.chamber ?? null,
    heatbed: currentStatus?.lightModes.heatbed ?? null,
    work: currentStatus?.lightModes.work ?? null
  }
  lightModes[node] = mode

  const lightCapabilities = resolveLightCapabilities(null, model, currentStatus?.lightCapabilities)
  lightCapabilities[node] = true

  return {
    lightModes,
    lightCapabilities,
    ...(node === 'chamber' && (mode === 'on' || mode === 'off') ? { lightOn: mode === 'on' } : {})
  }
}

function hexBitsValue(value: string | null, startBit: number, bitCount: number): number | null {
  if (!value || startBit < 0 || bitCount <= 0) return null
  const normalized = value.trim().toLowerCase()
  if (!/^[0-9a-f]+$/.test(normalized)) return null

  let result = 0
  for (let offset = 0; offset < bitCount; offset += 1) {
    if (isHexBitSet(normalized, startBit + offset)) {
      result |= 1 << offset
    }
  }
  return result
}

function mapStage(gcodeState: string): PrinterStage {
  switch (gcodeState.toUpperCase()) {
    case 'IDLE':
      return 'idle'
    case 'FINISH':
      return 'finished'
    case 'PREPARE':
      return 'preparing'
    case 'RUNNING':
      return 'printing'
    case 'PAUSE':
      return 'paused'
    case 'FAILED':
      return 'failed'
    default:
      return 'unknown'
  }
}

/**
 * Normalize the printer's HMS array (and optional top-level `print_error`)
 * into a flat list of `{ code, message }` entries. Each entry's code is the
 * canonical Bambu identifier (16 hex chars for HMS, 8 hex chars for
 * `print_error`) so the UI can show it consistently and link to Bambu's
 * lookup page when no description is known.
 */
function parseHmsErrors(
  hms: unknown,
  deviceType: string | null
): PrinterStatus['hmsErrors'] {
  const entries: PrinterStatus['hmsErrors'] = []
  const seen = new Set<string>()

  if (Array.isArray(hms)) {
    for (const raw of hms) {
      if (!isObject(raw)) continue
      const attr = numberOrNull(raw.attr)
      const code = numberOrNull(raw.code)
      if (code === null) continue
      const canonical = formatHmsCode(attr ?? 0, code)
      if (seen.has(canonical)) continue
      seen.add(canonical)
      // Hide codes the HMS dictionary has no description for (e.g. 0500-0600-0002-0070):
      // the printer and Bambu Handy/Studio don't surface them either, so a bare code with
      // no text is noise. Dropping it here hides it everywhere (status, chips, notifications).
      const message = lookupHmsMessage(canonical, deviceType)
      if (!message) continue
      entries.push({ code: canonical, message })
    }
  }

  return entries
}

function parseDeviceError(
  printError: unknown,
  deviceType: string | null
): PrinterStatus['deviceError'] {
  const printErrorCode = numberOrNull(printError)
  if (printErrorCode === null || printErrorCode === 0) {
    return null
  }

  const canonical = formatPrintErrorCode(printErrorCode)
  return {
    code: canonical,
    message: lookupHmsMessage(canonical, deviceType)
  }
}

/**
 * AMS report shape: `print.ams = { ams: [{ id, humidity, humidity_raw, temp, tray: [...] }] }`.
 * Bambu sends partial deltas at the unit level too, but for the v1 dashboard
 * we just take whatever the latest message contains; the merge happens at the
 * top-level `PrinterStatus` so prior units survive.
 *
 * Two humidity fields exist on the wire:
 * - `humidity_raw` is an actual percentage (0-100) and is only emitted by
 *   newer hardware (AMS 2 Pro, AMS HT). When present we surface it as
 *   `humidityPercent`.
 * - `humidity` is a coarse 1-5 index (1 = very dry, 5 = wet) that older AMS
 *   units report instead of a percentage. Surfaced as `humidityLevel` so the
 *   UI can render it as a level rather than mistaking it for a percentage.
 */
function parseAms(
  value: Record<string, unknown>,
  existingUnits: PrinterStatus['ams'],
  amsNozzleMap: AmsUnitNozzleMap | null
): PrinterStatus['ams'] | null {
  const list = Array.isArray(value.ams) ? value.ams : null
  const trayExistBits = stringOrNull(value.tray_exist_bits)
  const trayReadingBits = stringOrNull(value.tray_reading_bits)
  const trayReadDoneBits = stringOrNull(value.tray_read_done_bits)
  if (!list && !trayExistBits && !trayReadingBits && !trayReadDoneBits) return null

  const unitsById = new Map<number, PrinterStatus['ams'][number]>(
    existingUnits.map((unit) => [
      unit.unitId,
      {
        ...unit,
        slots: unit.slots.map((slot) => ({ ...slot }))
      }
    ])
  )

  if (list) {
    for (const entry of list) {
      if (!isObject(entry)) continue
      const unitId = numberOrNull(entry.id) ?? 0
      const previousUnit = unitsById.get(unitId)
      const infoBits = stringOrNull(entry.info)
      const amsType = hexBitsValue(infoBits, 0, 4)
      const dryStatus = hexBitsValue(infoBits, 4, 4)
      const drySubStatus = hexBitsValue(infoBits, 22, 2)
      const dryTime = 'dry_time' in entry ? roundedNonNegativeInt(numberOrNull(entry.dry_time)) : previousUnit?.dryTimeRemainingMinutes ?? null
      const dryingActive = dryStatus != null
        ? [1, 2, 5, 6].includes(dryStatus)
        : previousUnit?.dryingActive ?? ((dryTime ?? 0) > 0)
      const dryingPhase = parseAmsDryingPhase(dryStatus, drySubStatus, dryTime, previousUnit?.dryingPhase, dryingActive)
      const drySetting = isObject(entry.dry_setting) ? entry.dry_setting : null
      const nextHumidityPercent = 'humidity_raw' in entry
        ? parseAmsHumidityPercent(entry.humidity_raw, previousUnit?.humidityPercent ?? null)
        : previousUnit?.humidityPercent ?? null
      const nextTemperature = 'temp' in entry
        ? parseAmsTemperature(entry.temp, previousUnit?.temperature ?? null)
        : previousUnit?.temperature ?? null
      // DevAmsType code lives in `info` bits 0-3; when a delta omits `info`,
      // keep the type resolved from an earlier report. Drives the global
      // tray-index math (AMS HT / N3S units number their trays 128+).
      const unitType = amsType != null ? amsUnitTypeFromCode(amsType) : previousUnit?.type ?? 'unknown'
      const nextUnit: PrinterStatus['ams'][number] = {
        unitId,
        type: unitType,
        nozzleId: amsNozzleMap?.get(unitId) ?? previousUnit?.nozzleId ?? null,
        switchInput: 'info' in entry
          ? parseAmsUnitSwitchInputFromInfo(entry)
          : previousUnit?.switchInput ?? null,
        supportDrying: amsType === 3 || amsType === 4 || previousUnit?.supportDrying === true,
        dryTimeRemainingMinutes: dryTime,
        dryingActive,
        dryingPhase,
        dryFilament: drySetting && 'dry_filament' in drySetting
          ? stringOrNull(drySetting.dry_filament)
          : previousUnit?.dryFilament ?? null,
        dryTemperature: drySetting && 'dry_temperature' in drySetting
          ? numberOrNull(drySetting.dry_temperature)
          : previousUnit?.dryTemperature ?? null,
        dryDurationHours: drySetting && 'dry_duration' in drySetting
          ? roundedNonNegativeInt(numberOrNull(drySetting.dry_duration))
          : previousUnit?.dryDurationHours ?? null,
        humidityPercent: nextHumidityPercent,
        humidityLevel: 'humidity' in entry ? clampHumidityLevel(numberOrNull(entry.humidity)) : previousUnit?.humidityLevel ?? null,
        temperature: nextTemperature,
        slots: previousUnit?.slots.map((slot) => ({ ...slot })) ?? []
      }

      if (dryStatus != null && dryStatus === 3 && drySubStatus === 0) {
        nextUnit.dryingActive = false
        nextUnit.dryingPhase = 'idle'
      }

      const trays = Array.isArray(entry.tray) ? entry.tray : []
      for (const [index, tray] of trays.filter(isObject).entries()) {
        const slotId = numberOrNull(tray.id) ?? index
        const previousSlot = nextUnit.slots.find((slot) => slot.slot === slotId)
        const reportedFilamentType = 'tray_type' in tray ? stringOrNull(tray.tray_type) : undefined
        const clearsPreviousTrayIdentity = reportedFilamentType === null
        const filamentType: string | null = 'tray_type' in tray ? reportedFilamentType ?? null : previousSlot?.filamentType ?? null
        const trayInfoIdx = 'tray_info_idx' in tray
          ? stringOrNull(tray.tray_info_idx)
          : clearsPreviousTrayIdentity
            ? null
            : previousSlot?.trayInfoIdx ?? null
        const trayName = 'tray_id_name' in tray || 'tray_sub_brands' in tray
          ? stringOrNull(tray.tray_id_name) ?? stringOrNull(tray.tray_sub_brands) ?? null
          : clearsPreviousTrayIdentity
            ? null
            : previousSlot?.trayName ?? null
        const remainPercent = 'remain' in tray
          ? clampPercentNullable(numberOrNull(tray.remain))
          : clearsPreviousTrayIdentity
            ? null
            : previousSlot?.remainPercent ?? null
        const trayExists = parseAmsTrayExists(trayExistBits, unitId, slotId, amsType)
        // Third-party AMS spools may have no RFID-backed tray identity but
        // still report physical occupancy through `tray_exist_bits`.
        // BambuStudio renders `is_exists && !is_tray_info_ready()` as a
        // third-party placeholder, and only treats `!is_exists` as empty.
        const isEmpty = trayExists === false || (
          trayExists !== true
          && filamentType === null
          && trayInfoIdx === null
          && trayName === null
          && remainPercent === null
        )
        const color = isEmpty
          ? null
          : ('tray_color' in tray ? parseTrayColor(tray.tray_color) : previousSlot?.color ?? null)
        const colors = isEmpty
          ? []
          : 'cols' in tray
            ? parseTrayColors(tray.cols, color)
            : 'tray_color' in tray
              ? (color ? [color] : [])
              : previousSlot?.colors ?? (color ? [color] : [])
        const caliIdx = 'cali_idx' in tray
          ? intOrNull(tray.cali_idx)
          : clearsPreviousTrayIdentity
            ? null
            : previousSlot?.caliIdx ?? null
        const k = 'k' in tray
          ? numberOrNull(tray.k)
          : clearsPreviousTrayIdentity
            ? null
            : previousSlot?.k ?? null
        const trayUuid = 'tray_uuid' in tray
          ? parseTrayUuid(tray.tray_uuid)
          : clearsPreviousTrayIdentity
            ? null
            : previousSlot?.trayUuid ?? null
        // When the slot is empty, clear ALL spool identity — not just the
        // color. A spool removal is often reported by flipping the slot's
        // `tray_exist_bits` bit to 0 while the tray object still carries the
        // removed spool's stale RFID identity (`tray_type`, `tray_info_idx`,
        // `remain`, ...). Those identity fields fall back to `previousSlot`,
        // so without this gate they leak into the merged state and the slot
        // keeps showing a phantom spool until the process restarts. BambuStudio
        // renders `!is_exists` as empty regardless of lingering RFID data; we
        // mirror that so removed spools clear on the next report.
        const nextSlot: PrinterStatus['ams'][number]['slots'][number] = {
          slot: slotId,
          trayName: isEmpty ? null : trayName,
          filamentType: isEmpty ? null : filamentType,
          color,
          colors,
          remainPercent: isEmpty ? null : remainPercent,
          active: previousSlot?.active ?? false,
          isReading: previousSlot?.isReading ?? false,
          occupied: trayExists ?? !isEmpty,
          trayInfoIdx: isEmpty ? null : trayInfoIdx,
          caliIdx: isEmpty ? null : caliIdx,
          k: isEmpty ? null : k,
          trayUuid: isEmpty ? null : trayUuid
        }

        const existingIndex = nextUnit.slots.findIndex((slot) => slot.slot === slotId)
        if (existingIndex >= 0) nextUnit.slots[existingIndex] = nextSlot
        else nextUnit.slots.push(nextSlot)
      }

      nextUnit.slots.sort((left, right) => left.slot - right.slot)
      unitsById.set(unitId, nextUnit)
    }
  }

  const units = Array.from(unitsById.values()).sort((left, right) => left.unitId - right.unitId)
  if (amsNozzleMap) {
    for (const unit of units) {
      unit.nozzleId = amsNozzleMap.get(unit.unitId) ?? unit.nozzleId ?? null
    }
  }
  let slotBitIndex = 0
  for (const unit of units) {
    for (const slot of unit.slots) {
      const isReadingBitSet = isHexBitSet(trayReadingBits, slotBitIndex)
      if (trayReadingBits !== null) {
        slot.isReading = isReadingBitSet
      }
      slotBitIndex += 1
    }
  }

  return units
}

function parseAmsDryingPhase(
  dryStatus: number | null,
  drySubStatus: number | null,
  dryTimeRemainingMinutes: number | null,
  previousPhase: PrinterAmsDryingPhase | undefined,
  dryingActive: boolean
): PrinterAmsDryingPhase {
  if (dryStatus == null) {
    if (dryingActive) return previousPhase ?? 'unknown'
    return dryTimeRemainingMinutes != null && dryTimeRemainingMinutes > 0 ? previousPhase ?? 'drying' : 'idle'
  }

  if (dryStatus === 3 && drySubStatus === 0) return 'idle'

  switch (dryStatus) {
    case 0:
    case 3:
      return 'idle'
    case 1:
      return 'starting'
    case 2:
      return 'drying'
    case 5:
      return 'cooling'
    case 6:
      return 'finishing'
    default:
      return dryingActive ? previousPhase ?? 'unknown' : 'idle'
  }
}

/**
 * Bambu Studio derives AMS binding from each AMS unit's `info` field and
 * only uses separate transport state for active/target slots. Prefer the
 * unit-local binding bits so new H2D payloads keep working even if
 * `print.mapping` changes shape again.
 */
function parseAmsUnitNozzleMap(print: Record<string, unknown>): AmsUnitNozzleMap | null {
  const mapping = new Map<number, number>()
  const ams = isObject(print.ams) ? print.ams : null
  const units = ams && Array.isArray(ams.ams) ? ams.ams.filter(isObject) : []

  for (const unit of units) {
    const unitId = numberOrNull(unit.id)
    const nozzleId = parseAmsUnitNozzleIdFromInfo(unit)
    if (unitId === null || nozzleId === null) continue
    mapping.set(unitId, nozzleId)
  }

  if (mapping.size > 0) return mapping
  if (!Array.isArray(print.mapping)) return null

  for (const [extruderId, rawValue] of print.mapping.entries()) {
    if (extruderId > 1) break
    const route = numberOrNull(rawValue)
    if (route === null) continue
    const unitId = parseMappedAmsUnitId(route)
    if (unitId === null) continue
    mapping.set(unitId, extruderId)
  }

  return mapping.size > 0 ? mapping : null
}

function parseAmsUnitNozzleIdFromInfo(unit: Record<string, unknown>): number | null {
  const infoBits = stringOrNull(unit.info)
  const nozzleId = hexBitsValue(infoBits, 8, 4)
  return nozzleId === 0 || nozzleId === 1 ? nozzleId : null
}

/**
 * Filament Track Switch input a unit is routed through: `info` bits 24-27,
 * meaningful only when the extruder nibble (bits 8-11) reads `0xE` ("via
 * switch"). BambuStudio maps 0 -> input B, 1 -> input A. Such a unit is
 * reachable by both extruders, so its `nozzleId` stays null.
 */
function parseAmsUnitSwitchInputFromInfo(unit: Record<string, unknown>): 'A' | 'B' | null {
  const infoBits = stringOrNull(unit.info)
  if (hexBitsValue(infoBits, 8, 4) !== 0xe) return null
  const switchInput = hexBitsValue(infoBits, 24, 4)
  if (switchInput === 0) return 'B'
  if (switchInput === 1) return 'A'
  return null
}

function parseAmsTrayExists(
  trayExistBits: string | null,
  unitId: number,
  slotId: number,
  amsType: number | null
): boolean | null {
  if (trayExistBits === null) return null
  const bitIndex = amsType === 4 || unitId >= 128
    ? 16 + (unitId - 128) + slotId
    : unitId * 4 + slotId
  return isHexBitSet(trayExistBits, bitIndex)
}

function parseActiveTraySelections(print: Record<string, unknown>): ActiveTraySelections | null {
  const selections = new Map<number, { amsId: number; slot: number } | null>()
  const device = isObject(print.device) ? print.device : null
  const extruder = device && isObject(device.extruder) ? device.extruder : null
  const extruderInfo = extruder && Array.isArray(extruder.info)
    ? extruder.info.filter(isObject)
    : null

  if (extruderInfo && extruderInfo.length > 0) {
    for (const entry of extruderInfo) {
      const extruderId = numberOrNull(entry.id)
      if (extruderId === null || extruderId < 0) continue
      const rawRoute = numberOrNull(entry.snow)
      if (rawRoute === null) continue
      selections.set(extruderId, decodeActiveTraySelection(rawRoute, true))
    }
    return selections.size > 0 ? selections : null
  }

  const ams = isObject(print.ams) ? print.ams : null
  const trayNow = numberOrNull(ams?.tray_now)
  if (trayNow === null) return null
  selections.set(0, decodeActiveTraySelection(trayNow, false))
  return selections
}

function decodeActiveTraySelection(rawRoute: number, packedByExtruder: boolean): { amsId: number; slot: number } | null {
  if (!Number.isInteger(rawRoute)) return null

  if (packedByExtruder) {
    const normalized = rawRoute & 0xffff
    if (normalized === 0xffff) return null
    const amsId = normalized >> 8
    const slot = normalized & 0x3
    if (amsId === VIRTUAL_TRAY_MAIN_ID && slot === 3) return null
    if (amsId === VIRTUAL_TRAY_MAIN_ID || amsId === VIRTUAL_TRAY_DEPUTY_ID) {
      return { amsId, slot: 0 }
    }
    return amsId >= 0 ? { amsId, slot } : null
  }

  if (rawRoute === 255) return null
  if (rawRoute === 254) return { amsId: VIRTUAL_TRAY_MAIN_ID, slot: 0 }
  if (rawRoute >= 80) return { amsId: rawRoute, slot: 0 }
  return { amsId: rawRoute >> 2, slot: rawRoute & 0x3 }
}

function applyActiveTraySelections(
  units: PrinterStatus['ams'],
  externalSpools: PrinterStatus['externalSpools'],
  selections: ActiveTraySelections
): { ams: PrinterStatus['ams']; externalSpools: PrinterStatus['externalSpools'] } {
  const activeKeys = new Set<string>()
  for (const selection of selections.values()) {
    if (!selection) continue
    activeKeys.add(`${selection.amsId}:${selection.slot}`)
  }

  return {
    ams: units.map((unit) => ({
      ...unit,
      slots: unit.slots.map((slot) => ({
        ...slot,
        active: activeKeys.has(`${unit.unitId}:${slot.slot}`)
      }))
    })),
    externalSpools: externalSpools.map((spool) => ({
      ...spool,
      active: activeKeys.has(`${spool.amsId}:0`)
    }))
  }
}

function parseAmsSettings(
  print: Record<string, unknown>,
  existing: PrinterStatus['amsSettings'] | undefined
): PrinterStatus['amsSettings'] {
  const previous = existing ?? {
    detectOnInsert: null,
    detectOnPowerup: null,
    remainEnabled: null,
    autoRefill: null,
    supportFilamentBackup: null
  }

  const ams = isObject(print.ams) ? print.ams : null
  const cfg = stringOrNull(print.cfg)
  const homeFlag = numberOrNull(print.home_flag)

  return {
    detectOnInsert: booleanishOrNull(ams?.insert_flag)
      ?? (cfg ? isHexBitSet(cfg, 0) : null)
      ?? previous.detectOnInsert,
    detectOnPowerup: booleanishOrNull(ams?.power_on_flag)
      ?? (cfg ? isHexBitSet(cfg, 1) : null)
      ?? previous.detectOnPowerup,
    remainEnabled: booleanishOrNull(ams?.calibrate_remain_flag)
      ?? (cfg ? isHexBitSet(cfg, 17) : null)
      ?? (homeFlag != null ? ((Math.trunc(homeFlag) >> 7) & 0x1) !== 0 : null)
      ?? previous.remainEnabled,
    autoRefill: (cfg ? isHexBitSet(cfg, 18) : null)
      ?? (homeFlag != null ? ((Math.trunc(homeFlag) >> 10) & 0x1) !== 0 : null)
      ?? previous.autoRefill,
    supportFilamentBackup: booleanishOrNull(print.support_filament_backup) ?? previous.supportFilamentBackup
  }
}

function parseMappedAmsUnitId(route: number): number | null {
  if (!Number.isInteger(route)) return null
  const lowByte = route & 0xff
  const highByte = route >> 8
  if (highByte !== 0x01 || lowByte <= 0) return null
  return lowByte - 1
}

function applyAmsUnitNozzleMap(
  units: PrinterStatus['ams'],
  amsNozzleMap: AmsUnitNozzleMap
): PrinterStatus['ams'] {
  return units.map((unit) => ({
    ...unit,
    nozzleId: amsNozzleMap.get(unit.unitId) ?? unit.nozzleId ?? null,
    slots: unit.slots.map((slot) => ({ ...slot }))
  }))
}

function makeDefaultCommandTransport(): PrinterStatus['commandTransport'] {
  return {
    mqttBedTemperature: null,
    mqttAxisControl: null,
    mqttHoming: null,
    newFanControl: null
  }
}

function parseCommandTransport(
  print: Record<string, unknown>,
  existing: PrinterStatus['commandTransport'] | undefined
): PrinterStatus['commandTransport'] {
  const next = { ...(existing ?? makeDefaultCommandTransport()) }
  if (
    Object.prototype.hasOwnProperty.call(print, 'cfg')
    && Object.prototype.hasOwnProperty.call(print, 'fun')
    && Object.prototype.hasOwnProperty.call(print, 'aux')
    && Object.prototype.hasOwnProperty.call(print, 'stat')
  ) {
    next.newFanControl = true
  }

  const fun = stringOrNull(print.fun)
  if (!fun) return next

  next.mqttHoming = isHexBitSet(fun, 32)
  next.mqttAxisControl = isHexBitSet(fun, 38)
  next.mqttBedTemperature = isHexBitSet(fun, 39)
  return next
}

function parseChamberLightOffRequiresConfirm(stat: unknown): boolean | null {
  const statBits = stringOrNull(stat)
  if (!statBits) return null
  return isHexBitSet(statBits, 36)
}

function makeDefaultPrintOptions(): PrinterStatus['printOptions'] {
  return {
    aiMonitoring: { supported: false, enabled: null, sensitivity: null },
    spaghettiDetection: { supported: false, enabled: null, sensitivity: null },
    purgeChutePileupDetection: { supported: false, enabled: null, sensitivity: null },
    nozzleClumpingDetection: { supported: false, enabled: null, sensitivity: null },
    airPrintingDetection: { supported: false, enabled: null, sensitivity: null },
    firstLayerInspection: { supported: false, enabled: null },
    autoRecovery: { supported: false, enabled: null },
    promptSound: { supported: false, enabled: null },
    filamentTangleDetection: { supported: false, enabled: null }
  }
}

function clonePrintOptions(options: PrinterStatus['printOptions']): PrinterStatus['printOptions'] {
  return {
    aiMonitoring: { ...options.aiMonitoring },
    spaghettiDetection: { ...options.spaghettiDetection },
    purgeChutePileupDetection: { ...options.purgeChutePileupDetection },
    nozzleClumpingDetection: { ...options.nozzleClumpingDetection },
    airPrintingDetection: { ...options.airPrintingDetection },
    firstLayerInspection: { ...options.firstLayerInspection },
    autoRecovery: { ...options.autoRecovery },
    promptSound: { ...options.promptSound },
    filamentTangleDetection: { ...options.filamentTangleDetection }
  }
}

function parsePrintOptions(
  print: Record<string, unknown>,
  existing: PrinterStatus['printOptions'] | undefined
): PrinterStatus['printOptions'] {
  const next = clonePrintOptions(existing ?? makeDefaultPrintOptions())
  const homeFlag = numberOrNull(print.home_flag)
  const cfg = stringOrNull(print.cfg)
  const fun = stringOrNull(print.fun)
  const xcam = isObject(print.xcam) ? print.xcam : null

  if (homeFlag !== null) {
    next.autoRecovery.supported = true
    next.autoRecovery.enabled = ((Math.trunc(homeFlag) >> 4) & 0x1) !== 0
    next.promptSound.supported = ((Math.trunc(homeFlag) >> 18) & 0x1) !== 0
    next.promptSound.enabled = ((Math.trunc(homeFlag) >> 17) & 0x1) !== 0
    next.filamentTangleDetection.supported = ((Math.trunc(homeFlag) >> 19) & 0x1) !== 0
    next.filamentTangleDetection.enabled = ((Math.trunc(homeFlag) >> 20) & 0x1) !== 0
  }

  if (cfg) {
    next.firstLayerInspection.supported = true
    next.firstLayerInspection.enabled = isHexBitSet(cfg, 12)
    next.aiMonitoring.supported = true
    next.aiMonitoring.enabled = isHexBitSet(cfg, 15)
    next.aiMonitoring.sensitivity = parseAiMonitoringSensitivity(hexBitsValue(cfg, 13, 2))
    next.autoRecovery.supported = true
    next.autoRecovery.enabled = isHexBitSet(cfg, 16)
    next.promptSound.supported = true
    next.promptSound.enabled = isHexBitSet(cfg, 22)
    next.filamentTangleDetection.supported = true
    next.filamentTangleDetection.enabled = isHexBitSet(cfg, 23)
  }

  if (fun) {
    next.firstLayerInspection.supported = next.firstLayerInspection.supported || isHexBitSet(fun, 5)
    next.promptSound.supported = next.promptSound.supported || isHexBitSet(fun, 8)
    next.filamentTangleDetection.supported = next.filamentTangleDetection.supported || isHexBitSet(fun, 9)
    next.spaghettiDetection.supported = next.spaghettiDetection.supported || isHexBitSet(fun, 42)
    next.purgeChutePileupDetection.supported = next.purgeChutePileupDetection.supported || isHexBitSet(fun, 43)
    next.nozzleClumpingDetection.supported = next.nozzleClumpingDetection.supported || isHexBitSet(fun, 44)
    next.airPrintingDetection.supported = next.airPrintingDetection.supported || isHexBitSet(fun, 45)
  }

  applyPrintOptionSupport(next.firstLayerInspection, print.support_first_layer_inspect)
  applyPrintOptionSupport(next.aiMonitoring, print.support_ai_monitoring)
  applyPrintOptionSupport(next.autoRecovery, print.support_auto_recovery_step_loss)
  applyPrintOptionSupport(next.promptSound, print.support_prompt_sound)
  applyPrintOptionSupport(next.filamentTangleDetection, print.support_filament_tangle_detect)

  if (xcam) {
    const xcamCfg = numberOrNull(xcam.cfg)
    if (xcamCfg !== null) {
      next.aiMonitoring.supported = true
      next.spaghettiDetection.supported = true
      next.purgeChutePileupDetection.supported = true
      next.nozzleClumpingDetection.supported = true
      next.airPrintingDetection.supported = true
      next.spaghettiDetection.enabled = ((Math.trunc(xcamCfg) >> 7) & 0x1) !== 0
      next.spaghettiDetection.sensitivity = parseDetectionSensitivity((Math.trunc(xcamCfg) >> 8) & 0x3)
      next.purgeChutePileupDetection.enabled = ((Math.trunc(xcamCfg) >> 10) & 0x1) !== 0
      next.purgeChutePileupDetection.sensitivity = parseDetectionSensitivity((Math.trunc(xcamCfg) >> 11) & 0x3)
      next.nozzleClumpingDetection.enabled = ((Math.trunc(xcamCfg) >> 13) & 0x1) !== 0
      next.nozzleClumpingDetection.sensitivity = parseDetectionSensitivity((Math.trunc(xcamCfg) >> 14) & 0x3)
      next.airPrintingDetection.enabled = ((Math.trunc(xcamCfg) >> 16) & 0x1) !== 0
      next.airPrintingDetection.sensitivity = parseDetectionSensitivity((Math.trunc(xcamCfg) >> 17) & 0x3)
    }

    applyPrintOptionEnabled(next.aiMonitoring, booleanishOrNull(xcam.printing_monitor), true)
    applyPrintOptionEnabled(next.firstLayerInspection, booleanishOrNull(xcam.first_layer_inspector), true)
    applyPrintOptionEnabled(next.spaghettiDetection, booleanishOrNull(xcam.spaghetti_detector), true)
    applyPrintOptionEnabled(next.purgeChutePileupDetection, booleanishOrNull(xcam.pileup_detector), true)
    applyPrintOptionEnabled(next.nozzleClumpingDetection, booleanishOrNull(xcam.clump_detector), true)
    applyPrintOptionEnabled(next.airPrintingDetection, booleanishOrNull(xcam.airprint_detector), true)
  }

  applyXcamModuleUpdate(
    next,
    stringOrNull(print.module_name),
    booleanishOrNull(print.enable) ?? booleanishOrNull(print.control),
    normalizePrintOptionSensitivity(print.halt_print_sensitivity)
  )

  return next
}

function applyPrintOptionSupport(
  option: PrinterStatus['printOptions'][keyof PrinterStatus['printOptions']],
  value: unknown
): void {
  const supported = booleanishOrNull(value)
  if (supported !== null) option.supported = supported
}

function applyPrintOptionEnabled(
  option: PrinterStatus['printOptions'][keyof PrinterStatus['printOptions']],
  enabled: boolean | null,
  markSupported: boolean
): void {
  if (enabled === null) return
  option.enabled = enabled
  if (markSupported) option.supported = true
}

function applyXcamModuleUpdate(
  options: PrinterStatus['printOptions'],
  moduleName: string | null,
  enabled: boolean | null,
  sensitivity: PrinterStatus['printOptions']['aiMonitoring']['sensitivity']
): void {
  if (!moduleName || enabled === null) return

  switch (moduleName) {
    case 'printing_monitor':
      options.aiMonitoring.supported = true
      options.aiMonitoring.enabled = enabled
      if (sensitivity !== null) options.aiMonitoring.sensitivity = sensitivity
      break
    case 'first_layer_inspector':
      options.firstLayerInspection.supported = true
      options.firstLayerInspection.enabled = enabled
      break
    case 'spaghetti_detector':
      options.spaghettiDetection.supported = true
      options.spaghettiDetection.enabled = enabled
      if (sensitivity !== null) options.spaghettiDetection.sensitivity = sensitivity
      break
    case 'pileup_detector':
      options.purgeChutePileupDetection.supported = true
      options.purgeChutePileupDetection.enabled = enabled
      if (sensitivity !== null) options.purgeChutePileupDetection.sensitivity = sensitivity
      break
    case 'clump_detector':
      options.nozzleClumpingDetection.supported = true
      options.nozzleClumpingDetection.enabled = enabled
      if (sensitivity !== null) options.nozzleClumpingDetection.sensitivity = sensitivity
      break
    case 'airprint_detector':
      options.airPrintingDetection.supported = true
      options.airPrintingDetection.enabled = enabled
      if (sensitivity !== null) options.airPrintingDetection.sensitivity = sensitivity
      break
    default:
      break
  }
}

function parseAiMonitoringSensitivity(
  value: number | null
): PrinterStatus['printOptions']['aiMonitoring']['sensitivity'] {
  switch (value) {
    case 0:
      return 'never_halt'
    case 1:
      return 'low'
    case 2:
      return 'medium'
    case 3:
      return 'high'
    default:
      return null
  }
}

function parseDetectionSensitivity(
  value: number | null
): PrinterStatus['printOptions']['aiMonitoring']['sensitivity'] {
  switch (value) {
    case 0:
      return 'low'
    case 1:
      return 'medium'
    case 2:
      return 'high'
    default:
      return null
  }
}

function normalizePrintOptionSensitivity(
  value: unknown
): PrinterStatus['printOptions']['aiMonitoring']['sensitivity'] {
  if (typeof value !== 'string') return null
  switch (value.trim().toLowerCase()) {
    case 'never_halt':
    case 'low':
    case 'medium':
    case 'high':
      return value.trim().toLowerCase() as PrinterStatus['printOptions']['aiMonitoring']['sensitivity']
    default:
      return null
  }
}

/**
 * Normalize Bambu's virtual-tray reports (`vt_tray` / `vir_slot`) into the
 * manual external spool slots surfaced in the web UI.
 */
function parseExternalSpools(
  value: Record<string, unknown>,
  existingSpools: PrinterStatus['externalSpools'],
  model: string
): PrinterStatus['externalSpools'] | null {
  const virtualSlots = Array.isArray(value.vir_slot)
    ? value.vir_slot.filter(isObject)
    : isObject(value.vt_tray)
      ? [value.vt_tray]
      : null
  if (!virtualSlots) return null

  const spoolsById = new Map<number, PrinterStatus['externalSpools'][number]>(
    existingSpools.map((spool) => [spool.amsId, { ...spool }])
  )

  for (const slot of virtualSlots) {
    const amsId = parseVirtualTrayId(slot.id) ?? VIRTUAL_TRAY_MAIN_ID
    const previous = spoolsById.get(amsId)
    const reportedFilamentType = 'tray_type' in slot ? stringOrNull(slot.tray_type) : undefined
    const clearsPreviousTrayIdentity = reportedFilamentType === null
    const filamentType: string | null = 'tray_type' in slot ? reportedFilamentType ?? null : previous?.filamentType ?? null
    const trayInfoIdx = 'tray_info_idx' in slot
      ? stringOrNull(slot.tray_info_idx)
      : clearsPreviousTrayIdentity
        ? null
        : previous?.trayInfoIdx ?? null
    const trayName = 'tray_id_name' in slot || 'tray_sub_brands' in slot
      ? stringOrNull(slot.tray_id_name) ?? stringOrNull(slot.tray_sub_brands) ?? null
      : clearsPreviousTrayIdentity
        ? null
        : previous?.trayName ?? null
    const remainPercent = 'remain' in slot
      ? clampPercentNullable(numberOrNull(slot.remain))
      : clearsPreviousTrayIdentity
        ? null
        : previous?.remainPercent ?? null
    const isEmpty = filamentType === null && trayInfoIdx === null && trayName === null && remainPercent === null
    const color = isEmpty
      ? null
      : ('tray_color' in slot ? parseTrayColor(slot.tray_color) : previous?.color ?? null)
    const colors = isEmpty
      ? []
      : 'cols' in slot
        ? parseTrayColors(slot.cols, color)
        : 'tray_color' in slot
          ? (color ? [color] : [])
          : previous?.colors ?? (color ? [color] : [])

    spoolsById.set(amsId, {
      amsId,
      nozzleId: amsId === VIRTUAL_TRAY_MAIN_ID ? 0 : amsId === VIRTUAL_TRAY_DEPUTY_ID ? 1 : previous?.nozzleId ?? null,
      trayName,
      filamentType,
      color,
      colors,
      remainPercent,
      active: previous?.active ?? false,
      trayInfoIdx,
      caliIdx: 'cali_idx' in slot
        ? intOrNull(slot.cali_idx)
        : clearsPreviousTrayIdentity
          ? null
          : previous?.caliIdx ?? null,
      k: 'k' in slot
        ? numberOrNull(slot.k)
        : clearsPreviousTrayIdentity
          ? null
          : previous?.k ?? null,
      trayUuid: 'tray_uuid' in slot
        ? parseTrayUuid(slot.tray_uuid)
        : clearsPreviousTrayIdentity
          ? null
          : previous?.trayUuid ?? null
    })
  }

  const normalizedModel = printerModelSchema.safeParse(model).success ? printerModelSchema.parse(model) : 'unknown'
  const allowDeputySpool = getPrinterControlCapabilities(normalizedModel).dualNozzles

  return Array.from(spoolsById.values())
    .filter((spool) => allowDeputySpool || spool.amsId !== VIRTUAL_TRAY_DEPUTY_ID)
    .sort((left, right) => right.amsId - left.amsId)
}

/**
 * Normalize nozzle temperatures for both classic single-nozzle reports and
 * H2/X2 dual-nozzle `device.extruder.info[]` payloads.
 *
 * Bambu Studio's device parser and Bambuddy both treat `temp > 500` in the
 * dual-nozzle extruder info as a packed `(target << 16) | current` value.
 */
function parseNozzles(
  print: Record<string, unknown>,
  existingNozzles: PrinterStatus['nozzles']
): PrinterStatus['nozzles'] | null {
  const previousById = new Map<number, PrinterStatus['nozzles'][number]>(
    existingNozzles.map((nozzle) => [nozzle.extruderId, { ...nozzle }])
  )

  const device = isObject(print.device) ? print.device : null
  const nozzleSpecsByInstalledId = parseInstalledNozzleSpecs(device)
  const extruder = device && isObject(device.extruder) ? device.extruder : null
  const extruderInfo = extruder && Array.isArray(extruder.info)
    ? extruder.info.filter(isObject)
    : null

  if (extruderInfo && extruderInfo.length > 0) {
    return extruderInfo.map((entry, index) => {
      const extruderId = numberOrNull(entry.id) ?? index
      const previous = previousById.get(extruderId)
      const decoded = decodeNozzleTemperature(entry.temp, previous?.targetTemp ?? null)
      const nozzleSpec = parseExtruderNozzleSpec(entry, nozzleSpecsByInstalledId)
      return {
        extruderId,
        diameter: nozzleSpec?.diameter ?? previous?.diameter ?? null,
        typeCode: nozzleSpec?.typeCode ?? previous?.typeCode ?? null,
        material: nozzleSpec?.material ?? previous?.material ?? null,
        flow: nozzleSpec?.flow ?? previous?.flow ?? null,
        currentTemp: decoded?.currentTemp
          ?? numberOrNull(entry.current_temp)
          ?? previous?.currentTemp
          ?? null,
        targetTemp: numberOrNull(entry.target_temp)
          ?? decoded?.targetTemp
          ?? previous?.targetTemp
          ?? null
      }
    }).sort((left, right) => left.extruderId - right.extruderId)
  }

  const primaryCurrent = numberOrNull(print.nozzle_temper)
  const primaryTarget = numberOrNull(print.nozzle_target_temper)
  const secondaryCurrent = numberOrNull(print.nozzle_temper_2)
  const secondaryTarget = numberOrNull(print.nozzle_target_temper_2)
  const nozzleDevice = device && isObject(device.nozzle) ? device.nozzle : null
  const fallbackPrimarySpec = nozzleSpecsByInstalledId.get(0)
    ?? (nozzleSpecsByInstalledId.size === 1 ? Array.from(nozzleSpecsByInstalledId.values())[0] : undefined)
    ?? null
  const primaryTypeInfo = parseNozzleTypeInfo(print.nozzle_type)
    ?? parseNozzleTypeInfo(nozzleDevice?.type)
  const secondaryTypeInfo = parseNozzleTypeInfo(print.nozzle_type_2)
  const secondarySpec = nozzleSpecsByInstalledId.get(1) ?? null
  const primaryDiameter = parseReportedNozzleDiameter(print.nozzle_diameter)
    ?? parseReportedNozzleDiameter(nozzleDevice?.diameter)
    ?? fallbackPrimarySpec?.diameter
    ?? null
  const hasDualNozzleState =
    secondaryCurrent !== null ||
    secondaryTarget !== null ||
    previousById.has(1)
  const hasPrimaryNozzleState =
    primaryCurrent !== null ||
    primaryTarget !== null ||
    primaryDiameter !== null ||
    previousById.has(0)

  if (!hasDualNozzleState && !hasPrimaryNozzleState) return null

  if (!hasDualNozzleState) {
    return [{
      extruderId: 0,
      diameter: primaryDiameter ?? previousById.get(0)?.diameter ?? null,
      typeCode: primaryTypeInfo?.typeCode ?? fallbackPrimarySpec?.typeCode ?? previousById.get(0)?.typeCode ?? null,
      material: primaryTypeInfo?.material ?? fallbackPrimarySpec?.material ?? previousById.get(0)?.material ?? null,
      flow: primaryTypeInfo?.flow ?? fallbackPrimarySpec?.flow ?? previousById.get(0)?.flow ?? null,
      currentTemp: primaryCurrent ?? previousById.get(0)?.currentTemp ?? null,
      targetTemp: primaryTarget ?? previousById.get(0)?.targetTemp ?? null
    }]
  }

  return [
    {
      extruderId: 0,
      diameter: primaryDiameter ?? previousById.get(0)?.diameter ?? null,
      typeCode: primaryTypeInfo?.typeCode ?? fallbackPrimarySpec?.typeCode ?? previousById.get(0)?.typeCode ?? null,
      material: primaryTypeInfo?.material ?? fallbackPrimarySpec?.material ?? previousById.get(0)?.material ?? null,
      flow: primaryTypeInfo?.flow ?? fallbackPrimarySpec?.flow ?? previousById.get(0)?.flow ?? null,
      currentTemp: primaryCurrent ?? previousById.get(0)?.currentTemp ?? null,
      targetTemp: primaryTarget ?? previousById.get(0)?.targetTemp ?? null
    },
    {
      extruderId: 1,
      diameter: secondarySpec?.diameter ?? previousById.get(1)?.diameter ?? null,
      typeCode: secondaryTypeInfo?.typeCode ?? secondarySpec?.typeCode ?? previousById.get(1)?.typeCode ?? null,
      material: secondaryTypeInfo?.material ?? secondarySpec?.material ?? previousById.get(1)?.material ?? null,
      flow: secondaryTypeInfo?.flow ?? secondarySpec?.flow ?? previousById.get(1)?.flow ?? null,
      currentTemp: secondaryCurrent ?? previousById.get(1)?.currentTemp ?? null,
      targetTemp: secondaryTarget ?? previousById.get(1)?.targetTemp ?? null
    }
  ]
}


const RACK_STATUS_BY_CODE: Record<number, NonNullable<PrinterStatus['nozzleRack']>['status']> = {
  0: 'idle',
  1: 'hotendCentre',
  2: 'toolheadCentre',
  3: 'calibrateHotendRack',
  4: 'cutMaterial',
  5: 'unlockHotend',
  6: 'liftHotendRack',
  7: 'placeHotend',
  8: 'pickHotend',
  9: 'lockHotend'
}

const RACK_POSITION_BY_CODE: Record<number, NonNullable<PrinterStatus['nozzleRack']>['position']> = {
  0: 'unknown',
  1: 'aTop',
  2: 'bTop',
  3: 'centre'
}

/**
 * Parse a nozzle `type` token into material/flow. Bambu reports either a plain
 * material name (`hardened_steel`) or a coded string (`HH01`); try the plain
 * form first, then fall back to the shared code parser.
 */
function parseNozzleMaterialToken(value: unknown): Omit<InstalledNozzleSpec, 'diameter'> | null {
  const raw = stringOrNull(value)
  if (!raw) return null
  const material = raw.toLowerCase() === 'hardened_steel'
    ? 'hardened-steel' as const
    : raw.toLowerCase() === 'stainless_steel'
      ? 'stainless-steel' as const
      : raw.toLowerCase() === 'tungsten_carbide'
        ? 'tungsten-carbide' as const
        : null
  if (material) return { typeCode: raw, material, flow: null }
  return parseNozzleTypeInfo(raw)
}

/**
 * H2C nozzle-changer (rack) state, from `device.nozzle` (the nozzle list, each
 * entry's `id` low nibble = nozzle id, next nibble = a parked-in-rack flag) plus
 * `device.holder` (rack motion state/position). Mirrors BambuStudio's
 * `DevNozzleSystemParser`.
 *
 * Returns `undefined` when the report carries no nozzle-system data so the prior
 * rack state is preserved across partial MQTT deltas, and only yields a non-null
 * rack once the printer shows a rack marker (a `holder` block, a parked nozzle,
 * or a previously-seen rack) — so non-H2C machines never surface a rack.
 *
 * NOTE: `device.nozzle.info[]` is already consumed by `parseInstalledNozzleSpecs`,
 * but the rack flag, `holder` block, and swap ids have NOT been verified against
 * a live H2C report yet. Keep this defensive.
 */
function parseNozzleRack(
  print: Record<string, unknown>,
  previous: PrinterStatus['nozzleRack']
): PrinterStatus['nozzleRack'] | undefined {
  const device = isObject(print.device) ? print.device : null
  const nozzleJson = device && isObject(device.nozzle) ? device.nozzle : null
  const holderJson = device && isObject(device.holder) ? device.holder : null
  if (!nozzleJson && !holderJson) return undefined

  let sawRackMarker = previous != null || holderJson != null
  let nozzles = previous?.nozzles ?? []
  if (nozzleJson && Array.isArray(nozzleJson.info)) {
    const parsed: NonNullable<PrinterStatus['nozzleRack']>['nozzles'] = []
    for (const entry of nozzleJson.info.filter(isObject)) {
      const idRaw = numberOrNull(entry.id)
      if (idRaw === null) continue
      const onRack = ((idRaw >> 4) & 0xf) === 1
      if (onRack) sawRackMarker = true
      const typeInfo = parseNozzleMaterialToken(entry.type)
      parsed.push({
        nozzleId: idRaw & 0xf,
        onRack,
        diameter: parseReportedNozzleDiameter(entry.diameter) ?? parseReportedNozzleDiameter(entry.dia) ?? null,
        typeCode: typeInfo?.typeCode ?? null,
        material: typeInfo?.material ?? null,
        flow: typeInfo?.flow ?? null,
        wear: numberOrNull(entry.wear),
        loadedFilamentColor: 'color_m' in entry ? parseTrayColor(entry.color_m) : null
      })
    }
    // Mounted nozzles first, then the rack, each ordered by nozzle id.
    parsed.sort((left, right) => (left.onRack === right.onRack ? left.nozzleId - right.nozzleId : left.onRack ? 1 : -1))
    nozzles = parsed
  }

  if (!sawRackMarker) return undefined

  return {
    status: holderJson
      ? RACK_STATUS_BY_CODE[numberOrNull(holderJson.stat) ?? -1] ?? 'unknown'
      : previous?.status ?? 'unknown',
    position: holderJson
      ? RACK_POSITION_BY_CODE[numberOrNull(holderJson.pos) ?? 0] ?? 'unknown'
      : previous?.position ?? 'unknown',
    replacingFromNozzleId: nozzleJson && 'src_id' in nozzleJson
      ? numberOrNull(nozzleJson.src_id)
      : previous?.replacingFromNozzleId ?? null,
    replacingToNozzleId: nozzleJson && 'tar_id' in nozzleJson
      ? numberOrNull(nozzleJson.tar_id)
      : previous?.replacingToNozzleId ?? null,
    nozzles
  }
}

/**
 * Filament Track Switch (FTS) state: installed flag from `print.aux` bit 29,
 * connections from `print.device.fila_switch`. Mirrors BambuStudio's
 * `DevFilaSwitch::ParseFilaSwitchInfo`, including its array ordering quirk —
 * `in[0]`/`out[0]` are the switch's B side, `in[1]`/`out[1]` the A side.
 * Returns `undefined` (leave status untouched) for the fleet-wide case of no
 * FTS signal, and clears previous state to `null` when the module disappears.
 */
function parseFilamentTrackSwitch(
  print: Record<string, unknown>,
  previous: PrinterStatus['filamentTrackSwitch'] | null
): PrinterStatus['filamentTrackSwitch'] | undefined {
  const device = isObject(print.device) ? print.device : null
  const switchJson = device && isObject(device.fila_switch) ? device.fila_switch : null

  let installed = previous?.installed ?? false
  if ('aux' in print) {
    const installedBit = hexBitsValue(stringOrNull(print.aux), 29, 1)
    if (installedBit !== null) installed = installedBit === 1
  }

  if (!installed && !switchJson) {
    // No FTS signal: stay silent for the fleet; clear state if one was removed.
    return previous ? null : undefined
  }

  const next: NonNullable<PrinterStatus['filamentTrackSwitch']> = {
    installed,
    inputA: previous?.inputA ?? null,
    inputB: previous?.inputB ?? null,
    outputAExtruderId: previous?.outputAExtruderId ?? null,
    outputBExtruderId: previous?.outputBExtruderId ?? null,
    calibrating: previous?.calibrating ?? false,
    filamentPresent: previous?.filamentPresent ?? null
  }
  if (!switchJson) return next

  if (Array.isArray(switchJson.in) && switchJson.in.length === 2) {
    next.inputB = parseSwitchInputSlot(switchJson.in[0])
    next.inputA = parseSwitchInputSlot(switchJson.in[1])
  }
  if (Array.isArray(switchJson.out) && switchJson.out.length === 2) {
    next.outputBExtruderId = parseSwitchOutputExtruder(switchJson.out[0])
    next.outputAExtruderId = parseSwitchOutputExtruder(switchJson.out[1])
  }
  const stat = numberOrNull(switchJson.stat)
  if (stat !== null) next.calibrating = stat === 1
  const infoBits = numberOrNull(switchJson.info)
  if (infoBits !== null) next.filamentPresent = (infoBits & 1) === 1
  return next
}

/** `fila_switch.in[]` entry: `(ams_id << 8) | slot_id`, `-1` when nothing is docked. */
function parseSwitchInputSlot(value: unknown): { amsId: number; slotId: number } | null {
  const packed = numberOrNull(value)
  if (packed === null || packed < 0) return null
  return { amsId: (packed >> 8) & 0xff, slotId: packed & 0xff }
}

/** `fila_switch.out[]` entry: extruder id, `0xE` when the output is unmapped. */
function parseSwitchOutputExtruder(value: unknown): number | null {
  const id = numberOrNull(value)
  if (id === null || id === 0xe) return null
  return id
}

function parseInstalledNozzleSpecs(device: Record<string, unknown> | null): Map<number, InstalledNozzleSpec> {
  const specs = new Map<number, InstalledNozzleSpec>()
  const nozzle = device && isObject(device.nozzle) ? device.nozzle : null
  const nozzleInfo = nozzle && Array.isArray(nozzle.info)
    ? nozzle.info.filter(isObject)
    : []

  for (const entry of nozzleInfo) {
    const nozzleId = numberOrNull(entry.id) ?? numberOrNull(entry.pos)
    const diameter = parseReportedNozzleDiameter(entry.diameter)
      ?? parseReportedNozzleDiameter(entry.dia)
      ?? parseReportedNozzleDiameter(entry.nozzle_diameter)
    if (nozzleId === null || !diameter) continue
    const typeInfo = parseNozzleTypeInfo(entry.type)
      ?? parseNozzleTypeInfo(entry.nozzle_type)
      ?? { typeCode: null, material: null, flow: null }
    specs.set(nozzleId, {
      diameter,
      typeCode: typeInfo.typeCode,
      material: typeInfo.material,
      flow: typeInfo.flow
    })
  }

  return specs
}

function parseExtruderNozzleSpec(
  entry: Record<string, unknown>,
  nozzleSpecsByInstalledId: ReadonlyMap<number, InstalledNozzleSpec>
): InstalledNozzleSpec | null {
  const diameter = parseReportedNozzleDiameter(entry.diameter)
    ?? parseReportedNozzleDiameter(entry.dia)
    ?? parseReportedNozzleDiameter(entry.nozzle_diameter)
  const directType = parseNozzleTypeInfo(entry.type)
    ?? parseNozzleTypeInfo(entry.nozzle_type)

  const installedNozzleId = numberOrNull(entry.hnow)
    ?? numberOrNull(entry.nozzle_id)
    ?? numberOrNull(entry.current_nozzle_id)
  const installedSpec = installedNozzleId === null ? null : nozzleSpecsByInstalledId.get(installedNozzleId) ?? null
  if (diameter === null && !directType && !installedSpec) return null

  return {
    diameter: diameter ?? installedSpec?.diameter ?? null,
    typeCode: directType?.typeCode ?? installedSpec?.typeCode ?? null,
    material: directType?.material ?? installedSpec?.material ?? null,
    flow: directType?.flow ?? installedSpec?.flow ?? null
  }
}

function parseNozzleTypeInfo(value: unknown): Omit<InstalledNozzleSpec, 'diameter'> | null {
  const typeCode = stringOrNull(value)?.toUpperCase() ?? null
  if (!typeCode) return null

  const flowToken = typeCode.length >= 2 ? typeCode[1] : null
  const materialToken = typeCode.length >= 2 ? typeCode.slice(-2) : null

  return {
    typeCode,
    material: materialToken === '00'
      ? 'stainless-steel'
      : materialToken === '01'
        ? 'hardened-steel'
        : materialToken === '05'
          ? 'tungsten-carbide'
          : null,
    flow: flowToken === 'H' || flowToken === 'E'
      ? 'high'
      : flowToken === 'U'
        ? 'tpu-high'
        : flowToken === 'S' || flowToken === 'A' || flowToken === 'X'
          ? 'standard'
          : null
  }
}

function decodeNozzleTemperature(
  value: unknown,
  _previousTargetTemp: number | null
): { currentTemp: number | null; targetTemp: number | null } | null {
  const numeric = numberOrNull(value)
  if (numeric === null) return null

  if (numeric > 500) {
    const packed = Math.trunc(numeric)
    return {
      currentTemp: packed % 65536,
      targetTemp: Math.floor(packed / 65536)
    }
  }

  return {
    currentTemp: numeric,
    targetTemp: 0
  }
}

function parseReportedNozzleDiameter(value: unknown): string | null {
  const numeric = numberOrNull(value)
  if (numeric !== null) return normalizeNozzleDiameter(String(numeric))
  return normalizeNozzleDiameter(stringOrNull(value))
}

export function stringOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function parseVirtualTrayId(value: unknown): 254 | 255 | null {
  const parsed = numberOrNull(value)
  if (parsed === VIRTUAL_TRAY_MAIN_ID || parsed === VIRTUAL_TRAY_DEPUTY_ID) return parsed
  return null
}

export function parsePressureAdvanceProfilesFailure(print: Record<string, unknown>): string | null {
  if (print.result === 'fail') {
    return stringOrNull(print.reason) ?? 'Pressure-advance profile request failed'
  }
  return null
}

export function parsePressureAdvanceProfiles(print: Record<string, unknown>): PrinterPressureAdvanceProfile[] {
  const filaments = Array.isArray(print.filaments) ? print.filaments.filter(isObject) : []
  const fallbackNozzleDiameter = stringOrNull(print.nozzle_diameter)
  const profiles = filaments.map((entry) => printerPressureAdvanceProfileSchema.parse({
    caliIdx: intOrNull(entry.cali_idx) ?? -1,
    filamentId: stringOrNull(entry.filament_id) ?? '',
    settingId: stringOrNull(entry.setting_id) ?? '',
    name: stringOrNull(entry.name),
    kValue: numberOrNull(entry.k_value) ?? 0,
    nCoef: numberOrNull(entry.n_coef),
    nozzleDiameter: stringOrNull(entry.nozzle_diameter) ?? fallbackNozzleDiameter,
    confidence: intOrNull(entry.confidence)
  }))

  return profiles.filter((profile) => profile.caliIdx >= 0 && profile.kValue >= 0 && profile.kValue <= 10)
}

function parsePressureAdvanceStateDelta(
  print: Record<string, unknown>,
  ams: PrinterStatus['ams'],
  externalSpools: PrinterStatus['externalSpools']
): { ams: PrinterStatus['ams']; externalSpools: PrinterStatus['externalSpools'] } | null {
  if (print.command !== 'extrusion_cali_sel' && print.command !== 'extrusion_cali_set') return null

  const selection = resolvePressureAdvanceSelection(print)
  if (!selection) return null

  const kValue = print.command === 'extrusion_cali_set' ? numberOrNull(print.k_value) : null
  const caliIdx = print.command === 'extrusion_cali_sel' ? intOrNull(print.cali_idx) : null

  return {
    ams: ams.map((unit) => {
      if (unit.unitId !== selection.amsId) return unit
      return {
        ...unit,
        slots: unit.slots.map((slot) => {
          if (slot.slot !== selection.slot) return slot
          return {
            ...slot,
            ...(caliIdx !== null ? { caliIdx } : {}),
            ...(kValue !== null ? { k: kValue } : {})
          }
        })
      }
    }),
    externalSpools: externalSpools.map((spool) => {
      if (spool.amsId !== selection.amsId) return spool
      return {
        ...spool,
        ...(caliIdx !== null ? { caliIdx } : {}),
        ...(kValue !== null ? { k: kValue } : {})
      }
    })
  }
}

function resolvePressureAdvanceSelection(print: Record<string, unknown>): { amsId: number; slot: number } | null {
  const amsId = intOrNull(print.ams_id)
  const slotId = intOrNull(print.slot_id)
  if (amsId !== null && slotId !== null) return { amsId, slot: slotId }

  const trayId = intOrNull(print.tray_id)
  if (trayId === null) return null
  if (trayId === VIRTUAL_TRAY_MAIN_ID || trayId === VIRTUAL_TRAY_DEPUTY_ID) {
    return { amsId: trayId, slot: 0 }
  }
  if (trayId < 0) return null
  return { amsId: trayId >> 2, slot: trayId & 0x3 }
}

function isHexBitSet(value: string | null, bitIndex: number): boolean {
  if (!value || bitIndex < 0) return false
  const normalized = value.trim().toLowerCase()
  if (!/^[0-9a-f]+$/.test(normalized)) return false
  const nibbleIndexFromRight = Math.floor(bitIndex / 4)
  const digitIndex = normalized.length - 1 - nibbleIndexFromRight
  if (digitIndex < 0) return false
  const nibble = Number.parseInt(normalized[digitIndex] ?? '', 16)
  if (!Number.isFinite(nibble)) return false
  const mask = 1 << (bitIndex % 4)
  return (nibble & mask) !== 0
}

function clampPercentNullable(value: number | null): number | null {
  if (value === null) return null
  return Math.max(0, Math.min(100, value))
}

function parseAmsHumidityPercent(value: unknown, fallback: number | null): number | null {
  const numeric = numberOrNull(value)
  if (numeric === null) return fallback

  const rounded = Math.round(numeric)
  if (rounded < 1 || rounded > 100) return fallback
  return rounded
}

/**
 * Older AMS units report humidity as a 1-5 index. Clamp to that range and
 * round to the nearest integer; values outside the range are treated as
 * missing so the UI does not invent a "level 0" or "level 6".
 */
function clampHumidityLevel(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null
  const rounded = Math.round(value)
  if (rounded < 1 || rounded > 5) return null
  return rounded
}

function parseAmsTemperature(value: unknown, fallback: number | null): number | null {
  const numeric = numberOrNull(value)
  if (numeric === null) return fallback
  if (numeric < 0 || numeric > 100) return fallback
  return numeric
}

/**
 * The `tray_uuid` field is a 32-char hex string. Bambu reports an
 * all-zero UUID for empty slots and non-RFID third-party spools, so we
 * treat that as "no Bambu spool" and return `null`.
 */
function parseTrayUuid(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '' || /^0+$/.test(trimmed)) return null
  return trimmed.toUpperCase()
}
