/**
 * Static printer model -> capability tables and the `getPrinter*Capabilities`
 * family, plus the nozzle/diameter/control-availability helpers derived from
 * them. Answers "what can this printer model do?" and "can this control be used
 * given the current status?".
 *
 * Depends only on the wire contracts in `./printer-contracts.js`; it never
 * imports the action-availability logic.
 */
import type {
  PrinterModel,
  PrinterPrintStartOptions,
  PrinterStage,
  PrinterStatus
} from './printer-contracts.js'

export interface PrinterCalibrationCapabilities {
  xcam: boolean
  bedLeveling: boolean
  vibration: boolean
  motorNoise: boolean
  nozzleOffset: boolean
  highTempHeatbed: boolean
  nozzleClumping: boolean
}

export function getPrinterCalibrationCapabilities(model: PrinterModel): PrinterCalibrationCapabilities {
  switch (model) {
    case 'X1':
    case 'X1C':
    case 'X1E':
    case 'X2D':
      return {
        xcam: true,
        bedLeveling: true,
        vibration: true,
        motorNoise: true,
        nozzleOffset: false,
        highTempHeatbed: false,
        nozzleClumping: false
      }
    case 'P1S':
    case 'P1P':
    case 'A1':
    case 'A1mini':
    case 'A2L':
      return {
        xcam: false,
        bedLeveling: true,
        vibration: true,
        motorNoise: true,
        nozzleOffset: false,
        highTempHeatbed: false,
        nozzleClumping: false
      }
    case 'H2D':
    case 'H2DPRO':
    case 'H2C':
    case 'H2S':
    case 'P2S':
      return {
        xcam: false,
        bedLeveling: true,
        vibration: true,
        motorNoise: true,
        nozzleOffset: true,
        highTempHeatbed: true,
        nozzleClumping: true
      }
    case 'unknown':
    default:
      return {
        xcam: false,
        bedLeveling: true,
        vibration: true,
        motorNoise: false,
        nozzleOffset: false,
        highTempHeatbed: false,
        nozzleClumping: false
      }
  }
}

export interface PrinterPrintOptionCapabilities {
  bedLevel: boolean
  bedLevelAuto: boolean
  vibrationCompensation: boolean
  flowCalibration: boolean
  flowCalibrationAuto: boolean
  firstLayerInspection: boolean
  timelapse: boolean
  filamentDynamicsCalibration: boolean
  nozzleOffsetCalibration: boolean
}

export interface PrinterDisplayCapabilities {
  camera: boolean
  chamberTemperature: boolean
  doorState: boolean
  airductMode: boolean
}

const CAMERA_MODELS: ReadonlySet<PrinterModel> = new Set([
  'X1',
  'X1C',
  'X1E',
  'X2D',
  'P1S',
  'P2S',
  'P1P',
  'A1',
  'A1mini',
  'A2L',
  'H2D',
  'H2DPRO',
  'H2C',
  'H2S'
])

const AUTO_BED_LEVELING_MODELS: ReadonlySet<PrinterModel> = new Set([
  'X2D',
  'P2S',
  'H2D',
  'H2DPRO',
  'H2C',
  'H2S'
])

const FLOW_CALIBRATION_MODELS: ReadonlySet<PrinterModel> = new Set([
  'X1',
  'X1C',
  'X1E',
  'X2D',
  'P2S',
  'A1',
  'A1mini',
  'A2L',
  'H2D',
  'H2DPRO',
  'H2C',
  'H2S'
])

const AUTO_FLOW_CALIBRATION_MODELS: ReadonlySet<PrinterModel> = new Set([
  'X2D',
  'P2S',
  'H2D',
  'H2DPRO',
  'H2C',
  'H2S'
])

const FIRST_LAYER_INSPECTION_MODELS: ReadonlySet<PrinterModel> = new Set([
  'X1',
  'X1C',
  'X1E'
])

const DOOR_SENSOR_MODELS: ReadonlySet<PrinterModel> = new Set([
  'X1',
  'X1C',
  'X1E',
  'X2D',
  'P2S',
  'H2D',
  'H2DPRO',
  'H2C',
  'H2S'
])

const CHAMBER_TEMP_DISPLAY_MODELS: ReadonlySet<PrinterModel> = new Set([
  'X1',
  'X1C',
  'X1E',
  'X2D',
  'P2S',
  'H2D',
  'H2DPRO',
  'H2C',
  'H2S'
])

const AIRDUCT_MODELS: ReadonlySet<PrinterModel> = new Set([
  'X2D',
  'P2S',
  'H2D',
  'H2DPRO',
  'H2C',
  'H2S'
])

const SECONDARY_CHAMBER_LIGHT_MODELS: ReadonlySet<PrinterModel> = new Set([
  'X2D',
  'H2D',
  'H2DPRO',
  'H2C'
])

const ACTIVE_SKIP_OBJECT_EXTERNAL_STORAGE_MODELS: ReadonlySet<PrinterModel> = new Set([
  'P2S',
  'H2D',
  'H2DPRO',
  'H2S'
])

export function getPrinterDisplayCapabilities(model: PrinterModel): PrinterDisplayCapabilities {
  return {
    camera: CAMERA_MODELS.has(model),
    chamberTemperature: CHAMBER_TEMP_DISPLAY_MODELS.has(model),
    doorState: DOOR_SENSOR_MODELS.has(model),
    airductMode: AIRDUCT_MODELS.has(model)
  }
}

export function supportsPrinterCamera(model: PrinterModel): boolean {
  return getPrinterDisplayCapabilities(model).camera
}

export function supportsPrinterDoorSensor(model: PrinterModel): boolean {
  return getPrinterDisplayCapabilities(model).doorState
}

export function supportsPrinterChamberTemperatureDisplay(model: PrinterModel): boolean {
  return getPrinterDisplayCapabilities(model).chamberTemperature
}

export function supportsPrinterAirductMode(model: PrinterModel): boolean {
  return getPrinterDisplayCapabilities(model).airductMode
}

export function supportsPrinterSecondaryChamberLight(model: PrinterModel): boolean {
  return SECONDARY_CHAMBER_LIGHT_MODELS.has(model)
}

export function mayRequireExternalStorageForActiveSkipObjects(model: PrinterModel): boolean {
  return ACTIVE_SKIP_OBJECT_EXTERNAL_STORAGE_MODELS.has(model)
}

const CORE_XY_MOTION_MODELS: ReadonlySet<PrinterModel> = new Set([
  'X1',
  'X1C',
  'X1E',
  'X2D',
  'P1S',
  'P2S',
  'P1P',
  'H2D',
  'H2DPRO',
  'H2C',
  'H2S'
])

export function usesCoreXyMotionSystem(model: PrinterModel): boolean {
  return CORE_XY_MOTION_MODELS.has(model)
}

/** Print-start options that Bambu clients expose conditionally by model. */
export function getPrinterPrintStartOptions(
  model: PrinterModel,
  status?: (Pick<PrinterStatus, 'printOptions'> & { printStartOptions?: PrinterPrintStartOptions }) | null
): PrinterPrintStartOptions {
  if (status?.printStartOptions) return status.printStartOptions

  const calibration = getPrinterCalibrationCapabilities(model)
  const firstLayerInspectionSupported =
    status?.printOptions.firstLayerInspection.supported ?? supportsPrinterFirstLayerInspection(model)

  return {
    bedLevel: {
      supported: calibration.bedLeveling,
      autoSupported: supportsPrinterAutoBedLeveling(model),
      current: null
    },
    vibrationCompensation: {
      supported: calibration.vibration,
      current: null
    },
    flowCalibration: {
      supported: supportsPrinterFlowCalibration(model),
      autoSupported: supportsPrinterAutoFlowCalibration(model),
      current: null
    },
    firstLayerInspection: {
      supported: firstLayerInspectionSupported,
      current: firstLayerInspectionSupported
        ? status?.printOptions.firstLayerInspection.enabled ?? null
        : null
    },
    timelapse: {
      supported: supportsPrinterCamera(model),
      current: null
    },
    filamentDynamicsCalibration: {
      supported: false,
      current: null
    },
    nozzleOffsetCalibration: {
      supported: calibration.nozzleOffset,
      current: null
    }
  }
}

export function getPrinterPrintOptionCapabilities(
  model: PrinterModel,
  status?: (Pick<PrinterStatus, 'printOptions'> & { printStartOptions?: PrinterPrintStartOptions }) | null
): PrinterPrintOptionCapabilities {
  const options = getPrinterPrintStartOptions(model, status)
  return {
    bedLevel: options.bedLevel.supported,
    bedLevelAuto: options.bedLevel.autoSupported,
    vibrationCompensation: options.vibrationCompensation.supported,
    flowCalibration: options.flowCalibration.supported,
    flowCalibrationAuto: options.flowCalibration.autoSupported,
    firstLayerInspection: options.firstLayerInspection.supported,
    timelapse: options.timelapse.supported,
    filamentDynamicsCalibration: options.filamentDynamicsCalibration.supported,
    nozzleOffsetCalibration: options.nozzleOffsetCalibration.supported
  }
}

export function supportsPrinterAutoBedLeveling(model: PrinterModel): boolean {
  return AUTO_BED_LEVELING_MODELS.has(model)
}

export function supportsPrinterFlowCalibration(model: PrinterModel): boolean {
  return FLOW_CALIBRATION_MODELS.has(model)
}

export function supportsPrinterAutoFlowCalibration(model: PrinterModel): boolean {
  return AUTO_FLOW_CALIBRATION_MODELS.has(model)
}

export function supportsPrinterFirstLayerInspection(model: PrinterModel): boolean {
  return FIRST_LAYER_INSPECTION_MODELS.has(model)
}

export interface PrinterControlCapabilities {
  dualNozzles: boolean
  nozzleTemperature: boolean
  bedTemperature: boolean
  chamberTemperature: boolean
  partFan: boolean
  auxFan: boolean
  chamberFan: boolean
  printSpeed: boolean
  motion: boolean
  extruderControl: boolean
}

const DUAL_NOZZLE_MODELS: ReadonlySet<PrinterModel> = new Set(['X2D', 'H2D', 'H2DPRO', 'H2C'])
const CHAMBER_HEATER_MODELS: ReadonlySet<PrinterModel> = new Set(['X1E', 'H2D', 'H2DPRO', 'H2C', 'H2S'])
const AUX_FAN_MODELS: ReadonlySet<PrinterModel> = new Set(['X1C', 'X1E', 'X2D', 'P1S', 'P2S', 'H2D', 'H2DPRO', 'H2C', 'H2S'])
const CHAMBER_FAN_MODELS: ReadonlySet<PrinterModel> = new Set(['X1C', 'X1E', 'X2D', 'P1S', 'P2S', 'H2D', 'H2DPRO', 'H2C', 'H2S'])

export function getPrinterControlCapabilities(model: PrinterModel): PrinterControlCapabilities {
  return {
    dualNozzles: DUAL_NOZZLE_MODELS.has(model),
    nozzleTemperature: true,
    bedTemperature: true,
    chamberTemperature: CHAMBER_HEATER_MODELS.has(model),
    partFan: true,
    auxFan: AUX_FAN_MODELS.has(model),
    chamberFan: CHAMBER_FAN_MODELS.has(model),
    printSpeed: true,
    motion: true,
    extruderControl: true
  }
}

export function getPrinterChamberTemperatureMax(model: PrinterModel): number {
  return model === 'X1E' ? 60 : 65
}

export const PRINTER_EXTRUDER_CONTROL_MIN_TEMP_C = 170

export function isPrinterActiveJobStage(stage: PrinterStage | null | undefined): boolean {
  return stage === 'printing' || stage === 'paused' || stage === 'preparing' || stage === 'heating'
}

export function isPrinterIdleCompatibleStage(stage: PrinterStage | null | undefined): boolean {
  return stage == null || stage === 'idle' || stage === 'finished' || stage === 'failed' || stage === 'unknown'
}

export function canUsePrintSpeedControl(status: Pick<PrinterStatus, 'online' | 'stage'> | null | undefined): boolean {
  return status?.online === true && isPrinterActiveJobStage(status.stage)
}

export function canUseMotionControl(status: Pick<PrinterStatus, 'online' | 'stage'> | null | undefined): boolean {
  return status?.online === true && isPrinterIdleCompatibleStage(status.stage)
}

export function canUseExtruderControl(
  status: Pick<PrinterStatus, 'online' | 'stage' | 'nozzles' | 'nozzleTemp'> | null | undefined,
  extruderId = 0
): boolean {
  if (status?.online !== true || !isPrinterIdleCompatibleStage(status.stage)) return false
  const nozzles = status.nozzles.length > 0
    ? status.nozzles
    : [{ extruderId: 0, diameter: null, typeCode: null, material: null, flow: null, currentTemp: status.nozzleTemp, targetTemp: null }]
  const nozzle = nozzles.find((entry) => entry.extruderId === extruderId) ?? nozzles[0]
  return nozzle?.currentTemp != null && nozzle.currentTemp >= PRINTER_EXTRUDER_CONTROL_MIN_TEMP_C
}
