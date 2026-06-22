/**
 * Printer wire/DTO contracts: the Zod schemas and inferred types that define the
 * normalized printer snapshot, commands, library/3MF, dispatch, and storage shapes
 * shared between the API and web client.
 *
 * Bambu printers expose state via MQTT. The API normalizes that into a
 * stable, web-friendly snapshot defined here so the UI never has to know
 * about the raw MQTT payload shape.
 *
 * This is the base layer of the printer contract: it depends only on `zod` and
 * `./logs.js`, never on the capability tables or action-availability logic.
 */
import { z } from 'zod'
import { auditLogEntrySchema } from './logs.js'

export const printerModelSchema = z.enum([
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
  'H2S',
  'unknown'
])
export type PrinterModel = z.infer<typeof printerModelSchema>

export const printerAirductModeSchema = z.enum([
  'cooling',
  'heating',
  'laser'
])
export type PrinterAirductMode = z.infer<typeof printerAirductModeSchema>

export const printerSelectableAirductModeSchema = z.enum([
  'cooling',
  'heating'
])
export type PrinterSelectableAirductMode = z.infer<typeof printerSelectableAirductModeSchema>

export const printerLightModeSchema = z.enum([
  'on',
  'off',
  'flashing',
  'unknown'
])
export type PrinterLightMode = z.infer<typeof printerLightModeSchema>

export const printerLightNodeSchema = z.enum([
  'chamber',
  'heatbed',
  'work'
])
export type PrinterLightNode = z.infer<typeof printerLightNodeSchema>

export const printerControllableLightNodeSchema = z.enum([
  'chamber',
  'heatbed'
])
export type PrinterControllableLightNode = z.infer<typeof printerControllableLightNodeSchema>

export const printerLightModesSchema = z.object({
  chamber: printerLightModeSchema.nullable(),
  heatbed: printerLightModeSchema.nullable(),
  work: printerLightModeSchema.nullable()
})
export type PrinterLightModes = z.infer<typeof printerLightModesSchema>

export const printerLightCapabilitiesSchema = z.object({
  chamber: z.boolean(),
  heatbed: z.boolean(),
  work: z.boolean()
})
export type PrinterLightCapabilities = z.infer<typeof printerLightCapabilitiesSchema>

export const printerPrintOptionSensitivitySchema = z.enum([
  'never_halt',
  'low',
  'medium',
  'high'
])
export type PrinterPrintOptionSensitivity = z.infer<typeof printerPrintOptionSensitivitySchema>

export const printerPrintOptionStateSchema = z.object({
  supported: z.boolean(),
  enabled: z.boolean().nullable()
})
export type PrinterPrintOptionState = z.infer<typeof printerPrintOptionStateSchema>

export const printerDetectionOptionStateSchema = printerPrintOptionStateSchema.extend({
  sensitivity: printerPrintOptionSensitivitySchema.nullable()
})
export type PrinterDetectionOptionState = z.infer<typeof printerDetectionOptionStateSchema>

export const printerPrintOptionKeySchema = z.enum([
  'aiMonitoring',
  'spaghettiDetection',
  'purgeChutePileupDetection',
  'nozzleClumpingDetection',
  'airPrintingDetection',
  'firstLayerInspection',
  'autoRecovery',
  'promptSound',
  'filamentTangleDetection'
])
export type PrinterPrintOptionKey = z.infer<typeof printerPrintOptionKeySchema>

export const printerPrintOptionsSchema = z.object({
  aiMonitoring: printerDetectionOptionStateSchema,
  spaghettiDetection: printerDetectionOptionStateSchema,
  purgeChutePileupDetection: printerDetectionOptionStateSchema,
  nozzleClumpingDetection: printerDetectionOptionStateSchema,
  airPrintingDetection: printerDetectionOptionStateSchema,
  firstLayerInspection: printerPrintOptionStateSchema,
  autoRecovery: printerPrintOptionStateSchema,
  promptSound: printerPrintOptionStateSchema,
  filamentTangleDetection: printerPrintOptionStateSchema
})
export type PrinterPrintOptions = z.infer<typeof printerPrintOptionsSchema>

export const printerCommandTransportSchema = z.object({
  mqttBedTemperature: z.boolean().nullable(),
  mqttAxisControl: z.boolean().nullable(),
  mqttHoming: z.boolean().nullable(),
  newFanControl: z.boolean().nullable()
})
export type PrinterCommandTransport = z.infer<typeof printerCommandTransportSchema>

export const printerNozzleMaterialSchema = z.enum([
  'stainless-steel',
  'hardened-steel',
  'tungsten-carbide'
])
export type PrinterNozzleMaterial = z.infer<typeof printerNozzleMaterialSchema>

export const printerNozzleFlowSchema = z.enum([
  'standard',
  'high',
  'tpu-high'
])
export type PrinterNozzleFlow = z.infer<typeof printerNozzleFlowSchema>

const printerBaseSchema = z.object({
  name: z.string().trim().min(1).max(64),
  host: z.string().trim().min(1),
  serial: z.string().trim().min(1),
  accessCode: z.string().trim().min(1),
  model: printerModelSchema.default('unknown'),
  currentPlateType: z.string().trim().min(1).nullable().default(null),
  currentNozzleDiameters: z.array(z.object({
    extruderId: z.number().int().min(0),
    diameter: z.string().regex(/^\d+(?:\.\d+)?$/).nullable()
  })).default([])
})

export const printerInputSchema = printerBaseSchema
export type PrinterInput = z.infer<typeof printerInputSchema>

export const printerMutationInputSchema = printerBaseSchema.extend({
  bridgeId: z.string().trim().min(1)
})
export type PrinterMutationInput = z.infer<typeof printerMutationInputSchema>

export const printerSchema = printerBaseSchema.extend({
  bridgeId: z.string().trim().min(1).nullable().optional(),
  id: z.string(),
  position: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /**
   * Whether a LAN access code is stored. Browser-facing responses populate this
   * and **blank the `accessCode` field itself** — the access code is the printer's
   * MQTT/FTPS/RTSP credential and must never reach the browser (the see development notes and
   * `toPublicPrinterDto`). Server-internal/transport DTOs leave it unset and carry
   * the real `accessCode`. Optional so internal builders need not set it.
   */
  accessCodeConfigured: z.boolean().optional()
})
export type Printer = z.infer<typeof printerSchema>

export const printerListSchema = z.object({
  printers: z.array(printerSchema)
})
export type PrinterList = z.infer<typeof printerListSchema>

export const printerStageSchema = z.enum([
  'idle',
  'preparing',
  'heating',
  'printing',
  'paused',
  'finished',
  'failed',
  'unknown'
])
export type PrinterStage = z.infer<typeof printerStageSchema>

export const amsSlotSchema = z.object({
  slot: z.number().int().min(0),
  trayName: z.string().nullable(),
  filamentType: z.string().nullable(),
  color: z.string().nullable(),
  /** Full normalized tray palette (`#RRGGBB`), including Bambu multi-color spools. */
  colors: z.array(z.string()),
  remainPercent: z.number().min(0).max(100).nullable(),
  /** Whether this slot is currently routed to an active extruder. */
  active: z.boolean(),
  /** Whether the printer currently reports this slot as being read/scanned. */
  isReading: z.boolean(),
  /** Whether the AMS reports physical filament/spool presence in this slot. */
  occupied: z.boolean().optional(),
  /** Bambu filament preset id reported by the printer, e.g. `GFA00`. */
  trayInfoIdx: z.string().nullable(),
  /** Selected pressure-advance calibration index; `-1` means printer default. */
  caliIdx: z.number().int().nullable(),
  /**
   * Pressure-advance K value the printer is currently using for this slot
   * (reported via MQTT `tray.k`). `null` when the printer has not reported
   * one yet or when no filament is loaded.
   */
  k: z.number().nullable(),
  /**
   * Non-empty when an RFID-tagged Bambu spool is loaded in this slot.
   * Used by the UI to lock down editable fields (filament type, color,
   * temps come from the spool itself).
   */
  trayUuid: z.string().nullable()
})
export type AmsSlot = z.infer<typeof amsSlotSchema>

export const printerAmsDryingPhaseSchema = z.enum([
  'idle',
  'starting',
  'drying',
  'cooling',
  'finishing',
  'unknown'
])
export type PrinterAmsDryingPhase = z.infer<typeof printerAmsDryingPhaseSchema>

export const amsUnitSchema = z.object({
  unitId: z.number().int().min(0),
  /** Physical extruder/nozzle this AMS unit feeds on dual-nozzle machines, when known. */
  nozzleId: z.number().int().min(0).nullable(),
  /** AMS 2 Pro / AMS HT units expose remote drying controls. */
  supportDrying: z.boolean(),
  /** Remaining drying time, in minutes, when the unit reports it. */
  dryTimeRemainingMinutes: z.number().int().nonnegative().nullable(),
  /** Whether the unit currently appears to be in a drying cycle. */
  dryingActive: z.boolean(),
  /** Best-effort phase label derived from the AMS drying status bits. */
  dryingPhase: printerAmsDryingPhaseSchema.optional(),
  /** Current/last reported drying filament profile identifier. */
  dryFilament: z.string().nullable(),
  /** Current/last reported drying target temperature, in C. */
  dryTemperature: z.number().nullable(),
  /** Current/last reported drying duration, in hours. */
  dryDurationHours: z.number().int().nonnegative().nullable(),
  /**
   * Relative humidity as an actual percentage (0-100). Only newer AMS units
   * (AMS 2 Pro, AMS HT) report this via MQTT `humidity_raw`. `null` when the
   * unit only exposes a coarse 1-5 level (see `humidityLevel`).
   */
  humidityPercent: z.number().min(0).max(100).nullable(),
  /**
   * Coarse humidity level reported by older AMS units via MQTT `humidity`,
   * where 1 means "very dry" and 5 means "wet". Always present on real AMS
   * hardware; prefer `humidityPercent` for display when available.
   */
  humidityLevel: z.number().int().min(1).max(5).nullable(),
  temperature: z.number().nullable(),
  slots: z.array(amsSlotSchema)
})
export type AmsUnit = z.infer<typeof amsUnitSchema>

export const printerAmsSettingsSchema = z.object({
  detectOnInsert: z.boolean().nullable(),
  detectOnPowerup: z.boolean().nullable(),
  remainEnabled: z.boolean().nullable(),
  autoRefill: z.boolean().nullable(),
  supportFilamentBackup: z.boolean().nullable()
})
export type PrinterAmsSettings = z.infer<typeof printerAmsSettingsSchema>

export const printerFilamentChangeSchema = z.object({
  currentStepIndex: z.number().int().min(0).nullable(),
  currentStepLabel: z.string().nullable(),
  steps: z.array(z.string())
})
export type PrinterFilamentChange = z.infer<typeof printerFilamentChangeSchema>

/**
 * Bambu models the built-in manual spool holder as a virtual tray rather than
 * as part of an AMS. `255` is the main/right extruder's external spool and
 * `254` is the deputy/left extruder's external spool on dual-nozzle machines.
 */
export const virtualTrayAmsIdSchema = z.union([z.literal(254), z.literal(255)])
export type VirtualTrayAmsId = z.infer<typeof virtualTrayAmsIdSchema>

export const externalSpoolSchema = z.object({
  /** Virtual tray id (`255` main/right, `254` deputy/left). */
  amsId: virtualTrayAmsIdSchema,
  /** Physical extruder/nozzle this external spool feeds, when known. */
  nozzleId: z.number().int().min(0).nullable(),
  trayName: z.string().nullable(),
  filamentType: z.string().nullable(),
  color: z.string().nullable(),
  /** Full normalized tray palette (`#RRGGBB`), including Bambu multi-color spools. */
  colors: z.array(z.string()),
  remainPercent: z.number().min(0).max(100).nullable(),
  /** Whether this manual spool is currently routed to an active extruder. */
  active: z.boolean(),
  /** Bambu filament preset id reported by the printer, e.g. `GFA00`. */
  trayInfoIdx: z.string().nullable(),
  /** Selected pressure-advance calibration index; `-1` means printer default. */
  caliIdx: z.number().int().nullable(),
  /** Reported pressure-advance K value, when present. */
  k: z.number().nullable(),
  /** RFID/Bambu tray UUID. Usually null for manual external spools. */
  trayUuid: z.string().nullable()
})
export type ExternalSpool = z.infer<typeof externalSpoolSchema>

export const printerPressureAdvanceProfileSchema = z.object({
  caliIdx: z.number().int().min(0),
  filamentId: z.string(),
  settingId: z.string(),
  name: z.string().nullable(),
  kValue: z.number(),
  nCoef: z.number().nullable(),
  nozzleDiameter: z.string().nullable(),
  confidence: z.number().int().nullable()
})
export type PrinterPressureAdvanceProfile = z.infer<typeof printerPressureAdvanceProfileSchema>

export const printerPressureAdvanceProfilesResponseSchema = z.object({
  profiles: z.array(printerPressureAdvanceProfileSchema)
})
export type PrinterPressureAdvanceProfilesResponse = z.infer<typeof printerPressureAdvanceProfilesResponseSchema>

/**
 * Print-dispatch tray mapping values. Standard AMS trays use the global tray
 * index (`ams_id * 4 + slot_id`), while external spools use Bambu's virtual
 * tray ids (`255` main/right, `254` deputy/left).
 */
export const printerTrayMappingSchema = z.union([
  z.number().int().min(0).max(15),
  virtualTrayAmsIdSchema
])
export type PrinterTrayMapping = z.infer<typeof printerTrayMappingSchema>

export const printerNozzleSchema = z.object({
  /** 0 = right/default, 1 = left/deputy on dual-nozzle machines. */
  extruderId: z.number().int().min(0),
  diameter: z.string().regex(/^\d+(?:\.\d+)?$/).nullable(),
  /** Raw Bambu nozzle type code such as `HS00`, `HS01`, `HH01`. */
  typeCode: z.string().nullable(),
  /** Human-friendly material family derived from the type code suffix. */
  material: printerNozzleMaterialSchema.nullable(),
  /** Human-friendly flow family derived from the type code. */
  flow: printerNozzleFlowSchema.nullable(),
  currentTemp: z.number().nullable(),
  targetTemp: z.number().nullable()
})
export type PrinterNozzle = z.infer<typeof printerNozzleSchema>

export const printerConnectionWarningCodeSchema = z.enum([
  'localConnectionFailed',
  'developerModeDisabled'
])
export type PrinterConnectionWarningCode = z.infer<typeof printerConnectionWarningCodeSchema>

export const printerConnectionWarningSchema = z.object({
  code: printerConnectionWarningCodeSchema,
  message: z.string()
})
export type PrinterConnectionWarning = z.infer<typeof printerConnectionWarningSchema>

/** A printer error: an HMS/device error code and its resolved message, if known. */
export const printerErrorSchema = z.object({
  code: z.string(),
  message: z.string().nullable()
})
export type PrinterError = z.infer<typeof printerErrorSchema>

export const printerStatusSchema = z.object({
  printerId: z.string(),
  online: z.boolean(),
  stage: printerStageSchema,
  subStage: z.string().nullable(),
  filamentChange: printerFilamentChangeSchema,
  progressPercent: z.number().min(0).max(100).nullable(),
  currentLayer: z.number().int().nonnegative().nullable(),
  totalLayers: z.number().int().nonnegative().nullable(),
  remainingMinutes: z.number().int().nonnegative().nullable(),
  /** Active printer-reported job id (`print.job_id`) when available. */
  jobId: z.string().nullable(),
  /** Active printer-reported task id (`print.task_id`) when available. */
  taskId: z.string().nullable().default(null),
  jobName: z.string().nullable(),
  lastJobName: z.string().nullable(),
  /** Raw MQTT `print.gcode_file`, used to locate externally-started job files on printer storage. */
  gcodeFile: z.string().nullable(),
  bedTemp: z.number().nullable(),
  bedTarget: z.number().nullable(),
  /** Legacy primary/right nozzle temperature fields kept for compatibility. */
  nozzleTemp: z.number().nullable(),
  nozzleTarget: z.number().nullable(),
  /** Per-extruder nozzle temperatures when the printer reports them. */
  nozzles: z.array(printerNozzleSchema),
  chamberTemp: z.number().nullable(),
  chamberTarget: z.number().nullable(),
  fanGearSpeed: z.number().nullable(),
  partFanPercent: z.number().nullable(),
  auxFanPercent: z.number().nullable(),
  chamberFanPercent: z.number().nullable(),
  /** Reported Wi-Fi RSSI in dBm, for example `-44`. */
  wifiSignalDbm: z.number().nullable(),
  /** Live IPv4 address reported by the printer over MQTT. */
  ipAddress: z.string().nullable(),
  /** Enclosure door state when the printer family reports one. */
  doorOpen: z.boolean().nullable(),
  /** Mode reported by H2/X2 airduct-capable printers. */
  ductMode: printerAirductModeSchema.nullable(),
  /** Selectable air-management modes reported live by the printer. */
  ductAvailableModes: z.array(printerSelectableAirductModeSchema),
  /** Per-light-node state reported by the printer. `null` means not applicable. */
  lightModes: printerLightModesSchema,
  /** Which light nodes are actually available on this printer. */
  lightCapabilities: printerLightCapabilitiesSchema,
  /** Printer-provided warning bit for turning off the chamber light mid-task. */
  chamberLightOffRequiresConfirm: z.boolean(),
  /** Legacy primary chamber-light state kept for quick-toggle compatibility. */
  lightOn: z.boolean().nullable(),
  speedLevel: z.number().int().nullable(),
  /** Which report-driven command transports the firmware currently advertises. */
  commandTransport: printerCommandTransportSchema,
  /** Resolved send-dialog options, including any live defaults reported by the printer. */
  printStartOptions: z.lazy(() => printerPrintStartOptionsSchema).optional(),
  printOptions: printerPrintOptionsSchema,
  deviceError: printerErrorSchema.nullable(),
  hmsErrors: z.array(printerErrorSchema),
  amsSettings: printerAmsSettingsSchema,
  ams: z.array(amsUnitSchema),
  externalSpools: z.array(externalSpoolSchema),
  /**
   * Currently-installed firmware version (e.g. `01.08.05.00`) reported by the
   * printer's `info.command=get_version` response for the `ota` module. Null
   * until the printer has answered the version request after a fresh connect.
   */
  firmwareVersion: z.string().nullable(),
  /**
   * Whether the printer reports an SD card inserted. Null when the printer
   * has not yet sent a state-bearing report (no information either way).
   */
  sdCardPresent: z.boolean().nullable(),
  /**
   * LAN connection-mode warnings from the bridge's periodic connection probe
   * (e.g. the printer is reachable but rejected the LAN connection because
   * LAN-only / developer mode is off). Empty when the connection looks healthy
   * or has not been probed yet.
   */
  connectionWarnings: z.array(printerConnectionWarningSchema).default([]),
  observedAt: z.string()
})
export type PrinterStatus = z.infer<typeof printerStatusSchema>

export const printerFanIdSchema = z.enum(['part', 'aux', 'chamber'])
export type PrinterFanId = z.infer<typeof printerFanIdSchema>

export const printerSpeedLevelSchema = z.number().int().min(1).max(4)
export type PrinterSpeedLevel = z.infer<typeof printerSpeedLevelSchema>

export const printerCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('pause') }),
  z.object({ type: z.literal('resume') }),
  z.object({ type: z.literal('ignoreHmsError') }),
  z.object({ type: z.literal('retryAmsFilamentChange') }),
  z.object({ type: z.literal('confirmAmsFilamentExtruded') }),
  z.object({ type: z.literal('stop') }),
  z.object({ type: z.literal('light'), node: printerControllableLightNodeSchema, on: z.boolean() }),
  z.object({ type: z.literal('setAirductMode'), mode: printerSelectableAirductModeSchema }),
  z.object({
    type: z.literal('setPrintOption'),
    option: printerPrintOptionKeySchema,
    enabled: z.boolean(),
    sensitivity: printerPrintOptionSensitivitySchema.optional()
  }),
  z.object({ type: z.literal('refresh') }),
  z.object({
    type: z.literal('setNozzleTemperature'),
    extruderId: z.number().int().min(0).max(1).default(0),
    target: z.number().int().min(0).max(320)
  }),
  z.object({
    type: z.literal('setBedTemperature'),
    target: z.number().int().min(0).max(120)
  }),
  z.object({
    type: z.literal('setChamberTemperature'),
    target: z.number().int().min(0).max(65)
  }),
  z.object({
    type: z.literal('setFanSpeed'),
    fan: printerFanIdSchema,
    percent: z.number().int().min(0).max(100)
  }),
  z.object({
    type: z.literal('setPrintSpeed'),
    level: printerSpeedLevelSchema
  }),
  z.object({
    type: z.literal('moveAxis'),
    axis: z.enum(['X', 'Y', 'Z']),
    distanceMm: z.union([z.literal(-10), z.literal(-1), z.literal(1), z.literal(10)])
  }),
  z.object({ type: z.literal('homeAxes') }),
  z.object({
    type: z.literal('extrudeFilament'),
    extruderId: z.number().int().min(0).max(1).default(0),
    distanceMm: z.union([z.literal(-10), z.literal(-1), z.literal(1), z.literal(10)])
  }),
  z.object({
    type: z.literal('setAmsUserSettings'),
    startupReadOption: z.boolean(),
    trayReadOption: z.boolean(),
    calibrateRemainFlag: z.boolean()
  }),
  z.object({
    type: z.literal('setAmsFilamentBackup'),
    enabled: z.boolean()
  }),
  z.object({
    type: z.literal('startAmsDrying'),
    amsId: z.number().int().min(0),
    filamentType: z.string().trim().min(1).max(64),
    temperature: z.number().int().min(30).max(90),
    durationHours: z.number().int().min(1).max(24),
    rotateTray: z.boolean().default(false),
    coolingTemp: z.number().int().min(0).max(90).default(50),
    closePowerConflict: z.boolean().default(false)
  }),
  z.object({
    type: z.literal('stopAmsDrying'),
    amsId: z.number().int().min(0)
  }),
  z.object({
    type: z.literal('rescanAmsSlot'),
    amsId: z.number().int().min(0),
    slotId: z.number().int().min(0).max(15)
  }),
  /**
   * Start the printer's built-in calibration routine. Firmware expects a
   * bitmask assembled from the selected routines, carried by
   * `print.command=calibration`.
   */
  z.object({
    type: z.literal('calibrate'),
    xcam: z.boolean().default(false),
    bedLeveling: z.boolean().default(false),
    vibration: z.boolean().default(false),
    motorNoise: z.boolean().default(false),
    nozzleOffset: z.boolean().default(false),
    highTempHeatbed: z.boolean().default(false),
    nozzleClumping: z.boolean().default(false)
  }),
  z.object({
    type: z.literal('clearHmsErrors'),
    /**
     * If provided, only this HMS code is acknowledged. Omit to clear all
     * currently reported errors. Codes are the dotted/underscored
     * 32-character strings reported in `print.hms[].code`.
     */
    code: z.string().min(1).max(64).optional()
  }),
  z.object({ type: z.literal('skipObjects'), objectIds: z.array(z.number().int()) }),
  z.object({
    type: z.literal('setAmsSlot'),
    /** 0-based AMS unit id (`A` = 0, `B` = 1, ...). */
    amsId: z.number().int().min(0),
    /** 0-based slot index within the unit (0..3 for a standard AMS). */
    slotId: z.number().int().min(0).max(15),
    /** Bambu filament preset id (e.g. `GFA00` for Bambu PLA Basic). Empty for custom. */
    trayInfoIdx: z.string().max(32).default(''),
    /** Tray color as 8-character hex with alpha (`RRGGBBAA`), no leading `#`. */
    trayColor: z
      .string()
      .regex(/^[0-9A-Fa-f]{6,8}$/, 'Color must be a 6-8 char hex string'),
    /** Filament type label, e.g. `PLA`, `PETG`. */
    trayType: z.string().min(1).max(32),
    nozzleTempMin: z.number().int().min(0).max(500),
    nozzleTempMax: z.number().int().min(0).max(500)
  }),
  /**
   * Reset an AMS slot to empty/unconfigured. Mirrors BambuStudio's
   * "reset" flow: an `ams_filament_setting` with all fields blanked.
   */
  z.object({
    type: z.literal('resetAmsSlot'),
    amsId: z.number().int().min(0),
    slotId: z.number().int().min(0).max(15)
  }),
  z.object({
    type: z.literal('loadAmsFilament'),
    amsId: z.number().int().min(0),
    slotId: z.number().int().min(0).max(15),
    extruderId: z.number().int().min(0).max(1).optional(),
    nozzleTemp: z.number().int().min(0).max(500).default(220)
  }),
  z.object({
    type: z.literal('unloadAmsFilament'),
    amsId: z.number().int().min(0),
    slotId: z.number().int().min(0).max(15),
    extruderId: z.number().int().min(0).max(1).optional(),
    nozzleTemp: z.number().int().min(0).max(500).default(220)
  }),
  z.object({
    type: z.literal('setExternalSpool'),
    amsId: virtualTrayAmsIdSchema,
    /** Bambu filament preset id (e.g. `GFA00` for Bambu PLA Basic). Empty for custom. */
    trayInfoIdx: z.string().max(32).default(''),
    /** Tray color as 8-character hex with alpha (`RRGGBBAA`), no leading `#`. */
    trayColor: z
      .string()
      .regex(/^[0-9A-Fa-f]{6,8}$/, 'Color must be a 6-8 char hex string'),
    /** Filament type label, e.g. `PLA`, `PETG`. */
    trayType: z.string().min(1).max(32),
    nozzleTempMin: z.number().int().min(0).max(500),
    nozzleTempMax: z.number().int().min(0).max(500)
  }),
  z.object({
    type: z.literal('resetExternalSpool'),
    amsId: virtualTrayAmsIdSchema
  }),
  z.object({
    type: z.literal('loadExternalSpool'),
    amsId: virtualTrayAmsIdSchema,
    extruderId: z.number().int().min(0).max(1).optional(),
    nozzleTemp: z.number().int().min(0).max(500).default(220)
  }),
  z.object({
    type: z.literal('unloadExternalSpool'),
    amsId: virtualTrayAmsIdSchema,
    extruderId: z.number().int().min(0).max(1).optional(),
    nozzleTemp: z.number().int().min(0).max(500).default(220)
  }),
  z.object({
    type: z.literal('selectAmsPressureAdvanceProfile'),
    amsId: z.number().int().min(0),
    slotId: z.number().int().min(0).max(15),
    caliIdx: z.number().int().min(-1),
    filamentId: z.string().max(32).default(''),
    nozzleDiameter: z.string().max(8).default('0.4'),
    extruderId: z.number().int().min(0).max(1).default(0)
  }),
  z.object({
    type: z.literal('createAmsPressureAdvanceProfile'),
    amsId: z.number().int().min(0),
    slotId: z.number().int().min(0).max(15),
    kValue: z.number().min(0).max(2),
    filamentId: z.string().max(32).default(''),
    settingId: z.string().max(64).default(''),
    profileName: z.string().trim().min(1).max(64),
    nozzleDiameter: z.string().max(8).default('0.4'),
    extruderId: z.number().int().min(0).max(1).default(0)
  }),
  z.object({
    type: z.literal('deleteAmsPressureAdvanceProfile'),
    amsId: z.number().int().min(0),
    slotId: z.number().int().min(0).max(15),
    caliIdx: z.number().int().min(0),
    filamentId: z.string().max(32).default(''),
    nozzleDiameter: z.string().max(8).default('0.4'),
    extruderId: z.number().int().min(0).max(1).default(0)
  }),
  /**
   * Directly set the pressure-advance K value for an AMS slot via
   * `extrusion_cali_set` with the firmware's `filaments[]` payload.
   */
  z.object({
    type: z.literal('setAmsKValue'),
    amsId: z.number().int().min(0),
    slotId: z.number().int().min(0).max(15),
    /** Pressure-advance K value, typical range 0..0.3. */
    kValue: z.number().min(0).max(2),
    /** Filament preset id to associate with the K profile. Optional. */
    filamentId: z.string().max(32).default(''),
    /** Optional nozzle diameter string (e.g. `0.4`). */
    nozzleDiameter: z.string().max(8).default('0.4'),
    /** Optional nozzle temperature reference (deg C). */
    nozzleTemp: z.number().int().min(0).max(500).default(220)
  })
])
export type PrinterCommand = z.infer<typeof printerCommandSchema>

export const printerReorderSchema = z.object({
  orderedIds: z.array(z.string()).min(1)
})
export type PrinterReorder = z.infer<typeof printerReorderSchema>

/**
 * A Bambu printer the API has heard from over its LAN broadcast
 * channel but the user has not yet adopted. The host already knows
 * the IP, serial, model code and friendly name; the LAN access code
 * still has to come from the printer's screen, so it is collected in
 * the Add Printer dialog.
 */
export const discoveredPrinterSchema = z.object({
  bridgeId: z.string().optional(),
  serial: z.string(),
  host: z.string(),
  /** Bambu device-model code (e.g. `BL-P002` for X1C). Best-effort. */
  modelCode: z.string().nullable(),
  /** Resolved short model label (e.g. `X1C`) when we can map the code. */
  model: printerModelSchema,
  /** Friendly name the printer reports for itself, when available. */
  name: z.string().nullable(),
  /** Reported firmware version, when available. */
  firmware: z.string().nullable(),
  /** ISO timestamp of the most recent broadcast received. */
  lastSeenAt: z.string()
})
export type DiscoveredPrinter = z.infer<typeof discoveredPrinterSchema>

export const discoveredPrintersSchema = z.object({
  printers: z.array(discoveredPrinterSchema)
})
export type DiscoveredPrinters = z.infer<typeof discoveredPrintersSchema>

export const printerConnectionValidationInputSchema = printerBaseSchema.pick({
  host: true,
  serial: true,
  accessCode: true
})
export type PrinterConnectionValidationInput = z.infer<typeof printerConnectionValidationInputSchema>

export const printerConnectionValidationSchema = z.object({
  ok: z.boolean(),
  mqttReachable: z.boolean(),
  developerModeEnabled: z.boolean().nullable(),
  warnings: z.array(printerConnectionWarningSchema)
})
export type PrinterConnectionValidation = z.infer<typeof printerConnectionValidationSchema>

export const projectFilamentChipSchema = z.object({
  label: z.string(),
  color: z.string().nullable()
})

export const printJobSchema = z.object({
  id: z.string(),
  printerId: z.string(),
  printerName: z.string(),
  jobName: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  progressPercent: z.number().int().min(0).max(100).nullable(),
  durationSeconds: z.number().int().nullable(),
  result: z.enum(['success', 'failed', 'cancelled', 'unknown']),
  jobKind: z.enum(['file', 'calibration', 'external']),
  calibrationOption: z.number().int().nullable(),
  fileId: z.string().nullable(),
  fileName: z.string().nullable(),
  fileSizeBytes: z.number().int().nonnegative().nullable(),
  projectFilamentChips: z.array(projectFilamentChipSchema),
  plate: z.number().int().positive().nullable(),
  useAms: z.boolean().nullable(),
  bedLevel: z.boolean().nullable(),
  amsMapping: z.array(printerTrayMappingSchema).nullable(),
  activity: z.array(auditLogEntrySchema),
  thumbnailPath: z.string().nullable(),
  snapshotPath: z.string().nullable()
})
export type PrintJob = z.infer<typeof printJobSchema>

export const libraryFileSchema = z.object({
  id: z.string(),
  name: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  uploadedAt: z.string(),
  kind: z.enum(['3mf', 'gcode', 'stl', 'step', 'other']),
  thumbnailPath: z.string().nullable(),
  folderId: z.string().nullable(),
  compatiblePrinterModels: z.array(printerModelSchema),
  plateTypeChips: z.array(z.string()),
  nozzleSizeChips: z.array(z.string()),
  projectFilamentChips: z.array(projectFilamentChipSchema),
  /** Plates in the 3MF project index; absent or 0 when unknown or not a 3MF. */
  plateCount: z.number().int().nonnegative().optional(),
  /** Display name of whoever added/replaced/restored the current content. */
  createdByName: z.string().nullable().optional(),
  /** Set when the content was produced by restoring this older version number. */
  restoredFromVersionNumber: z.number().int().positive().nullable().optional()
})
export type LibraryFile = z.infer<typeof libraryFileSchema>

export const libraryFileVersionSchema = libraryFileSchema.extend({
  libraryFileId: z.string(),
  versionId: z.string().nullable(),
  versionNumber: z.number().int().positive(),
  isCurrent: z.boolean()
})
export type LibraryFileVersion = z.infer<typeof libraryFileVersionSchema>

export const libraryFileVersionsResponseSchema = z.object({
  currentFileId: z.string(),
  versions: z.array(libraryFileVersionSchema)
})

export const libraryRecycleBinEntrySchema = libraryFileSchema.extend({
  deletedAt: z.string()
})
export type LibraryRecycleBinEntry = z.infer<typeof libraryRecycleBinEntrySchema>

export const libraryRecycleBinResponseSchema = z.object({
  files: z.array(libraryRecycleBinEntrySchema)
})
export type LibraryRecycleBinResponse = z.infer<typeof libraryRecycleBinResponseSchema>
export type LibraryFileVersionsResponse = z.infer<typeof libraryFileVersionsResponseSchema>

export const libraryThreeMfPreviewAssetSchema = z.object({
  kind: z.enum(['stl', 'step', 'stp']),
  entryPath: z.string().min(1)
})
export type LibraryThreeMfPreviewAsset = z.infer<typeof libraryThreeMfPreviewAssetSchema>

export const libraryThreeMfSceneBedSchema = z.object({
  minX: z.number(),
  maxX: z.number(),
  minY: z.number(),
  maxY: z.number(),
  plateType: z.string().nullable(),
  /** Unprintable / single-nozzle zones (bed coords) as labeled closed polygons. */
  excludeAreas: z.array(z.object({
    polygon: z.array(z.object({ x: z.number(), y: z.number() })),
    label: z.string().nullable().default(null)
  })).default([])
})
export type LibraryThreeMfSceneBed = z.infer<typeof libraryThreeMfSceneBedSchema>

export const libraryThreeMfScenePartSchema = z.object({
  entryPath: z.string().min(1),
  objectId: z.number().int().positive(),
  transform: z.array(z.number()).length(12),
  name: z.string().nullable(),
  sourceFile: z.string().nullable(),
  filamentId: z.number().int().positive().nullable(),
  filamentName: z.string().nullable(),
  color: z.string().nullable(),
  /** Raw `subtype` (e.g. support_blocker/support_enforcer/modifier_part) or null for a normal part. */
  subtype: z.string().nullable().default(null)
})
export type LibraryThreeMfScenePart = z.infer<typeof libraryThreeMfScenePartSchema>

/** Geometry belonging to one placed instance, with its transform relative to the instance frame. */
export const libraryThreeMfSceneInstancePartSchema = z.object({
  entryPath: z.string().min(1),
  /** Component (mesh) object id within `entryPath`. */
  componentObjectId: z.number().int().positive(),
  /** Component-local transform (12-element), applied under the instance placement. */
  transform: z.array(z.number()).length(12),
  /** Raw `subtype` (support_blocker/support_enforcer/modifier_part/...) or null for a normal part. */
  subtype: z.string().nullable().default(null),
  /** Per-part PROCESS overrides saved in the 3MF; the editor re-seeds its per-part gear from these. */
  processOverrides: z.record(z.string(), z.string()).optional()
})
export type LibraryThreeMfSceneInstancePart = z.infer<typeof libraryThreeMfSceneInstancePartSchema>

/**
 * One placed model instance on the plate, grouped for the interactive editor. `objectId` is the
 * root Bambu `object_id`; `instanceId` distinguishes copies of the same object. `transform` is the
 * plate-local placement (12-element, plate origin removed) the editor manipulates with its gizmos;
 * each part is rendered as `transform ∘ part.transform`.
 */
export const libraryThreeMfSceneInstanceSchema = z.object({
  objectId: z.number().int().positive(),
  instanceId: z.number().int().nonnegative(),
  name: z.string().nullable(),
  transform: z.array(z.number()).length(12),
  filamentId: z.number().int().positive().nullable(),
  filamentName: z.string().nullable(),
  color: z.string().nullable(),
  /**
   * Whether this instance prints (BambuStudio's "Printable" toggle, parsed from the build
   * `<item printable="0|1">` attribute). Omitted means printable; the editor seeds its
   * per-instance state from this so a reopened project keeps non-printable objects greyed.
   */
  printable: z.boolean().optional(),
  /**
   * Manual brim ears parsed from `Metadata/brim_ear_points.txt` (object-level, so
   * identical across copies of the same object). Object-local mm + ear radius.
   */
  brimEars: z.array(z.object({
    x: z.number(),
    y: z.number(),
    z: z.number(),
    radius: z.number()
  })).optional(),
  /**
   * Per-object PROCESS overrides saved in the 3MF (object-level `<metadata>` in
   * model_settings.config), keyed by setting key. The editor re-seeds its per-object gear
   * from these on reopen so saved overrides aren't invisible. Omitted when the object has none.
   */
  processOverrides: z.record(z.string(), z.string()).optional(),
  parts: z.array(libraryThreeMfSceneInstancePartSchema)
})
export type LibraryThreeMfSceneInstance = z.infer<typeof libraryThreeMfSceneInstanceSchema>

/**
 * Inputs to BambuStudio's prepare-mode wipe-tower footprint estimate
 * (`PartPlate::estimate_wipe_tower_size`). The rendered footprint is NOT
 * `prime_tower_width` squared — it grows with the purge volume, layer height and
 * filament count and depends on the plate's tallest object, so the final size is
 * derived client-side once the scene (filament count + heights) is known.
 */
export const libraryThreeMfPrimeTowerSizingSchema = z.object({
  /** Max per-filament prime volume in mm^3 (BambuStudio's `wipe_volume`). */
  wipeVolume: z.number(),
  layerHeight: z.number(),
  /** `prime_tower_infill_gap` as a ratio (percent / 100). */
  infillGap: z.number(),
  ribWall: z.boolean(),
  ribWidth: z.number(),
  extraRibLength: z.number(),
  /** Printer nozzle count; 2 (dual-nozzle) changes the purge-volume formula. */
  extruderCount: z.number().int(),
  /** A wipe tower is forced even for a single filament (timelapse / wrapping). */
  needWipeTower: z.boolean()
})
export type LibraryThreeMfPrimeTowerSizing = z.infer<typeof libraryThreeMfPrimeTowerSizingSchema>

/** Prime/wipe tower footprint (plate-local bed coords) when the plate prints one. */
export const libraryThreeMfPrimeTowerSchema = z.object({
  x: z.number(),
  y: z.number(),
  /** `prime_tower_width` config value (the footprint X extent when rib walls are off). */
  width: z.number(),
  sizing: libraryThreeMfPrimeTowerSizingSchema
})
export type LibraryThreeMfPrimeTower = z.infer<typeof libraryThreeMfPrimeTowerSchema>

export const libraryThreeMfSceneSchema = z.object({
  plateIndex: z.number().int().positive(),
  plateName: z.string().nullable(),
  bed: libraryThreeMfSceneBedSchema,
  parts: z.array(libraryThreeMfScenePartSchema),
  /** Per-instance grouping with editable plate-local placements (used by the 3D editor). */
  instances: z.array(libraryThreeMfSceneInstanceSchema).default([]),
  /** Prime tower for this plate, or null when disabled. */
  primeTower: libraryThreeMfPrimeTowerSchema.nullable().default(null),
  /** Project filament palette (1-based ids), for rendering colour paint in previews. */
  projectFilaments: z.array(z.object({
    id: z.number().int().positive(),
    color: z.string().nullable().default(null)
  })).optional(),
  /**
   * Layer-based filament changes for this plate (ToolChange entries parsed from
   * `Metadata/custom_gcode_per_layer.xml`): swap to `filamentId` at height `z` mm.
   */
  filamentChanges: z.array(z.object({
    z: z.number(),
    filamentId: z.number().int().positive(),
    color: z.string().nullable().default(null)
  })).optional()
})
export type LibraryThreeMfScene = z.infer<typeof libraryThreeMfSceneSchema>

export function isDirectPrintableFileName(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.endsWith('.gcode') || lower.endsWith('.gcode.3mf')
}

export function classifyLibraryFileKind(name: string): LibraryFile['kind'] {
  const lower = name.toLowerCase()
  if (isDirectPrintableFileName(lower)) return 'gcode'
  if (lower.endsWith('.3mf')) return '3mf'
  if (lower.endsWith('.stl')) return 'stl'
  if (lower.endsWith('.step') || lower.endsWith('.stp')) return 'step'
  return 'other'
}

export const libraryFolderSchema = z.object({
  id: z.string(),
  name: z.string(),
  parentId: z.string().nullable()
})
export type LibraryFolder = z.infer<typeof libraryFolderSchema>

/**
 * Response from minting a short-lived, unauthenticated download link for a
 * library file (e.g. the "Open in Bambu Studio" desktop deep link). `url` is
 * absolute and self-contained so an external client with no browser session
 * can fetch the file until `expiresAt`.
 */
export const libraryDownloadLinkResponseSchema = z.object({
  url: z.string().url(),
  expiresAt: z.string()
})
export type LibraryDownloadLinkResponse = z.infer<typeof libraryDownloadLinkResponseSchema>

export const bridgeLibraryEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  connected: z.boolean()
})
export type BridgeLibraryEntry = z.infer<typeof bridgeLibraryEntrySchema>

export const libraryBrowseModeSchema = z.enum([
  'flat',
  'bridge-root',
  'bridge-subtree'
])
export type LibraryBrowseMode = z.infer<typeof libraryBrowseModeSchema>

export const libraryBrowseResponseSchema = z.object({
  mode: libraryBrowseModeSchema,
  readOnly: z.boolean(),
  activeBridgeId: z.string().nullable(),
  bridgeEntries: z.array(bridgeLibraryEntrySchema),
  folders: z.array(libraryFolderSchema),
  files: z.array(libraryFileSchema),
  /**
   * The `files` list was capped at the server's per-listing limit ({@link fileLimit});
   * this folder/search holds more files than were returned. The UI surfaces a
   * "narrow your search / open a subfolder" notice so the cap is never silent.
   * Folders are not capped (they are few). Defaults keep older payloads valid.
   */
  truncated: z.boolean().default(false),
  /** The cap applied to `files` when `truncated` is true (so the UI can say "first N"). */
  fileLimit: z.number().int().positive().nullable().default(null)
})
export type LibraryBrowseResponse = z.infer<typeof libraryBrowseResponseSchema>

export const printOnOffAutoModeSchema = z.preprocess((value) => {
  if (value === true) return 'on'
  if (value === false) return 'off'
  return value
}, z.enum(['off', 'on', 'auto']))
export type PrintOnOffAutoMode = z.infer<typeof printOnOffAutoModeSchema>

export const printNozzleOffsetCalibrationModeSchema = z.preprocess((value) => {
  if (value === true) return 'auto'
  if (value === false) return 'off'
  return value
}, z.enum(['off', 'on', 'auto']))
export type PrintNozzleOffsetCalibrationMode = z.infer<typeof printNozzleOffsetCalibrationModeSchema>

export const printerPrintStartBooleanStateSchema = z.object({
  supported: z.boolean(),
  current: z.boolean().nullable()
})
export type PrinterPrintStartBooleanState = z.infer<typeof printerPrintStartBooleanStateSchema>

export const printerPrintStartModeStateSchema = z.object({
  supported: z.boolean(),
  autoSupported: z.boolean(),
  current: printOnOffAutoModeSchema.nullable()
})
export type PrinterPrintStartModeState = z.infer<typeof printerPrintStartModeStateSchema>

export const printerPrintStartNozzleOffsetStateSchema = z.object({
  supported: z.boolean(),
  current: printNozzleOffsetCalibrationModeSchema.nullable()
})
export type PrinterPrintStartNozzleOffsetState = z.infer<typeof printerPrintStartNozzleOffsetStateSchema>

export const printerPrintStartOptionsSchema = z.object({
  bedLevel: printerPrintStartModeStateSchema,
  vibrationCompensation: printerPrintStartBooleanStateSchema,
  flowCalibration: printerPrintStartModeStateSchema,
  firstLayerInspection: printerPrintStartBooleanStateSchema,
  timelapse: printerPrintStartBooleanStateSchema,
  filamentDynamicsCalibration: printerPrintStartBooleanStateSchema,
  nozzleOffsetCalibration: printerPrintStartNozzleOffsetStateSchema
})
export type PrinterPrintStartOptions = z.infer<typeof printerPrintStartOptionsSchema>

export const printFromLibrarySchema = z.object({
  fileId: z.string(),
  printerId: z.string(),
  useAms: z.boolean().default(true),
  bedLevel: printOnOffAutoModeSchema.default('on'),
  vibrationCompensation: z.boolean().default(false),
  flowCalibration: printOnOffAutoModeSchema.default('off'),
  firstLayerInspection: z.boolean().default(true),
  timelapse: z.boolean().default(false),
  filamentDynamicsCalibration: z.boolean().default(false),
  nozzleOffsetCalibration: printNozzleOffsetCalibrationModeSchema.default('auto'),
  allowIncompatibleFilament: z.boolean().default(false),
  allowPlateTypeMismatch: z.boolean().default(false),
  currentPlateType: z.string().trim().min(1).nullable().optional(),
  currentNozzleDiameters: printerBaseSchema.shape.currentNozzleDiameters.optional(),
  /** 1-based plate index inside a multi-plate 3MF. Defaults to 1. */
  plate: z.number().int().positive().default(1),
  /**
   * Optional tray mapping. The array is indexed by the file's filament id
   * (0-based after subtracting 1). Each value is either a global AMS tray
   * index or one of the external-spool virtual tray ids. Missing entries
   * fall back to the printer's default behavior.
   */
  amsMapping: z.array(printerTrayMappingSchema).optional()
})
export type PrintFromLibrary = z.infer<typeof printFromLibrarySchema>

export const printDispatchStatusSchema = z.enum([
  'queued',
  'uploading',
  'sent',
  'cancelled',
  'failed'
])
export type PrintDispatchStatus = z.infer<typeof printDispatchStatusSchema>

export const printDispatchJobSchema = z.object({
  id: z.string(),
  /** Durable tracked print-job id. Matches the unfinished/history `PrintJob.id`. */
  printJobId: z.string(),
  printerId: z.string(),
  printerName: z.string(),
  fileId: z.string(),
  fileName: z.string(),
  /** Final printer-visible job name (`subtask_name`), including plate label when applicable. */
  jobName: z.string(),
  fileSizeBytes: z.number().int().nonnegative(),
  sourceKind: z.enum(['3mf', 'gcode']),
  projectFilamentChips: z.array(projectFilamentChipSchema),
  plate: z.number().int().positive(),
  plateName: z.string().nullable(),
  useAms: z.boolean(),
  bedLevel: printOnOffAutoModeSchema,
  amsMapping: z.array(printerTrayMappingSchema).nullable(),
  status: printDispatchStatusSchema,
  progressMessage: z.string(),
  uploadAttempt: z.number().int().nonnegative(),
  uploadMaxAttempts: z.number().int().positive(),
  uploadBytesSent: z.number().int().nonnegative(),
  uploadTotalBytes: z.number().int().nonnegative().nullable(),
  uploadPercent: z.number().min(0).max(100).nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  cancelRequested: z.boolean()
})
export type PrintDispatchJob = z.infer<typeof printDispatchJobSchema>

export const threeMfFilamentSchema = z.object({
  id: z.number().int().positive(),
  filamentType: z.string().nullable(),
  filamentName: z.string().nullable(),
  color: z.string().nullable(),
  nozzleId: z.number().int().min(0).nullable(),
  nozzleDiameter: z.string().nullable(),
  chamberTemperature: z.number().nullable(),
  usedGrams: z.number().nullable(),
  usedMeters: z.number().nullable()
})
export type ThreeMfFilament = z.infer<typeof threeMfFilamentSchema>

export const threeMfPlateObjectSchema = z.object({
  id: z.number().int().nonnegative(),
  name: z.string()
})
export type ThreeMfPlateObject = z.infer<typeof threeMfPlateObjectSchema>

export const printerActivePrintObjectPreviewBoundsSchema = z.object({
  minX: z.number(),
  minY: z.number(),
  maxX: z.number(),
  maxY: z.number()
})
export type PrinterActivePrintObjectPreviewBounds = z.infer<typeof printerActivePrintObjectPreviewBoundsSchema>

export const printerActivePrintObjectSchema = z.object({
  id: z.number().int().nonnegative(),
  name: z.string(),
  previewPath: z.string().nullable(),
  previewBounds: printerActivePrintObjectPreviewBoundsSchema.nullable()
})
export type PrinterActivePrintObject = z.infer<typeof printerActivePrintObjectSchema>

export const threeMfPlateSchema = z.object({
  index: z.number().int().positive(),
  name: z.string().nullable(),
  hasThumbnail: z.boolean(),
  plateType: z.string().nullable(),
  nozzleSizes: z.array(z.string()),
  filaments: z.array(threeMfFilamentSchema),
  objects: z.array(threeMfPlateObjectSchema),
  /** Slicer-estimated print time (seconds) from slice_info's `prediction`, when sliced. */
  prediction: z.number().nullable().optional(),
  /** Slicer-estimated total filament weight (grams) from slice_info's `weight`. */
  weight: z.number().nullable().optional()
})
export type ThreeMfPlate = z.infer<typeof threeMfPlateSchema>

export const threeMfProjectFilamentSchema = z.object({
  id: z.number().int().positive(),
  filamentType: z.string().nullable(),
  filamentName: z.string().nullable(),
  color: z.string().nullable(),
  nozzleId: z.number().int().min(0).nullable(),
  chamberTemperature: z.number().nullable()
})
export type ThreeMfProjectFilament = z.infer<typeof threeMfProjectFilamentSchema>

export const threeMfIndexSchema = z.object({
  plates: z.array(threeMfPlateSchema),
  projectFilaments: z.array(threeMfProjectFilamentSchema),
  compatiblePrinterModels: z.array(printerModelSchema),
  /** Project filaments designated as support material; used as "in use" for the remove-guard even when no object references them directly. */
  supportFilamentIds: z.array(z.number().int().positive()).default([]),
  printerProfileName: z.string().nullable().default(null),
  processProfileName: z.string().nullable().default(null)
})
export type ThreeMfIndex = z.infer<typeof threeMfIndexSchema>

export const printerActivePrintObjectsUnavailableReasonSchema = z.enum([
  'internalStorageUnsupported'
])
export type PrinterActivePrintObjectsUnavailableReason = z.infer<typeof printerActivePrintObjectsUnavailableReasonSchema>

export const printerActivePrintObjectsSchema = z.object({
  objects: z.array(printerActivePrintObjectSchema),
  loading: z.boolean().default(false),
  unavailableReason: printerActivePrintObjectsUnavailableReasonSchema.nullable().default(null),
  unavailableMessage: z.string().nullable().default(null)
})
export type PrinterActivePrintObjects = z.infer<typeof printerActivePrintObjectsSchema>

export const printerFsEntrySchema = z.object({
  name: z.string(),
  /**
   * Absolute printer-side path of the entry. Only set on entries
   * returned by recursive listings, where the parent directory isn't
   * implicit from the request.
   */
  path: z.string().optional(),
  type: z.enum(['file', 'directory']),
  sizeBytes: z.number().int().nonnegative(),
  modifiedAt: z.string().nullable()
})
export type PrinterFsEntry = z.infer<typeof printerFsEntrySchema>

export const printerStorageListSchema = z.object({
  path: z.string(),
  entries: z.array(printerFsEntrySchema)
})
export type PrinterStorageList = z.infer<typeof printerStorageListSchema>

export const printerStoragePrintSchema = z.object({
  path: z.string().min(1),
  plate: z.number().int().positive().default(1),
  useAms: z.boolean().default(true),
  bedLevel: printOnOffAutoModeSchema.default('on'),
  vibrationCompensation: z.boolean().default(false),
  flowCalibration: printOnOffAutoModeSchema.default('off'),
  firstLayerInspection: z.boolean().default(true),
  timelapse: z.boolean().default(false),
  filamentDynamicsCalibration: z.boolean().default(false),
  nozzleOffsetCalibration: printNozzleOffsetCalibrationModeSchema.default('auto'),
  amsMapping: z.array(printerTrayMappingSchema).optional(),
  allowIncompatibleFilament: z.boolean().default(false)
})
export type PrinterStoragePrintInput = z.infer<typeof printerStoragePrintSchema>
