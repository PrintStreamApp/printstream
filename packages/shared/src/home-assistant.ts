/**
 * Home Assistant bridge contracts shared by the API plugin and the PrintStream
 * web plugin. The custom integration consumes the same JSON shape from Python.
 */
import { z } from 'zod'
import {
  amsSlotSchema,
  externalSpoolSchema,
  printerAmsSettingsSchema,
  printerAirductModeSchema,
  printerLightCapabilitiesSchema,
  printerLightModesSchema,
  printerModelSchema,
  printerNozzleSchema,
  printerPrintOptionsSchema,
  printerSelectableAirductModeSchema,
  printerStageSchema
} from './printer.js'
import { permissionSchema } from './permissions.js'

export const homeAssistantAmsSlotSummarySchema = amsSlotSchema.pick({
  slot: true,
  trayName: true,
  filamentType: true,
  color: true,
  colors: true,
  remainPercent: true,
  active: true,
  isReading: true,
  trayInfoIdx: true,
  k: true,
  trayUuid: true
})
export type HomeAssistantAmsSlotSummary = z.infer<typeof homeAssistantAmsSlotSummarySchema>

export const homeAssistantExternalSpoolSummarySchema = externalSpoolSchema.pick({
  amsId: true,
  nozzleId: true,
  trayName: true,
  filamentType: true,
  color: true,
  colors: true,
  remainPercent: true,
  active: true,
  trayInfoIdx: true,
  k: true,
  trayUuid: true
})
export type HomeAssistantExternalSpoolSummary = z.infer<typeof homeAssistantExternalSpoolSummarySchema>

export const homeAssistantAmsUnitSnapshotSchema = z.object({
  id: z.string(),
  printerId: z.string(),
  printerName: z.string(),
  printerSerial: z.string(),
  name: z.string(),
  unitId: z.number().int().min(0),
  nozzleId: z.number().int().min(0).nullable(),
  supportDrying: z.boolean(),
  dryingActive: z.boolean(),
  dryTimeRemainingMinutes: z.number().int().nonnegative().nullable(),
  dryFilament: z.string().nullable(),
  dryTemperature: z.number().nullable(),
  dryDurationHours: z.number().int().nonnegative().nullable(),
  humidityPercent: z.number().min(0).max(100).nullable(),
  humidityLevel: z.number().int().min(1).max(5).nullable(),
  temperature: z.number().nullable(),
  activeSlot: z.number().int().min(0).nullable(),
  slots: z.array(homeAssistantAmsSlotSummarySchema)
})
export type HomeAssistantAmsUnitSnapshot = z.infer<typeof homeAssistantAmsUnitSnapshotSchema>

export const homeAssistantPrinterSnapshotSchema = z.object({
  id: z.string(),
  serial: z.string(),
  name: z.string(),
  model: printerModelSchema,
  host: z.string(),
  detailPath: z.string(),
  cameraSupported: z.boolean(),
  cameraSnapshotPath: z.string().nullable(),
  cameraStreamPath: z.string().nullable(),
  coverImagePath: z.string().nullable(),
  online: z.boolean(),
  stage: printerStageSchema,
  subStage: z.string().nullable(),
  progressPercent: z.number().min(0).max(100).nullable(),
  currentLayer: z.number().int().nonnegative().nullable(),
  totalLayers: z.number().int().nonnegative().nullable(),
  remainingMinutes: z.number().int().nonnegative().nullable(),
  jobName: z.string().nullable(),
  lastJobName: z.string().nullable(),
  gcodeFile: z.string().nullable(),
  bedTemp: z.number().nullable(),
  bedTarget: z.number().nullable(),
  nozzleTemp: z.number().nullable(),
  nozzleTarget: z.number().nullable(),
  nozzles: z.array(printerNozzleSchema),
  chamberTemp: z.number().nullable(),
  fanGearSpeed: z.number().nullable(),
  partFanPercent: z.number().nullable(),
  auxFanPercent: z.number().nullable(),
  chamberFanPercent: z.number().nullable(),
  wifiSignalDbm: z.number().nullable(),
  ipAddress: z.string().nullable(),
  doorOpen: z.boolean().nullable(),
  ductMode: printerAirductModeSchema.nullable(),
  ductAvailableModes: z.array(printerSelectableAirductModeSchema),
  lightModes: printerLightModesSchema,
  lightCapabilities: printerLightCapabilitiesSchema,
  lightOn: z.boolean().nullable(),
  speedLevel: z.number().int().nullable(),
  printOptions: printerPrintOptionsSchema,
  amsSettings: printerAmsSettingsSchema,
  sdCardPresent: z.boolean().nullable(),
  firmwareVersion: z.string().nullable(),
  deviceError: z.object({
    code: z.string(),
    message: z.string().nullable()
  }).nullable(),
  hmsErrors: z.array(z.object({
    code: z.string(),
    message: z.string().nullable()
  })),
  ams: z.array(homeAssistantAmsUnitSnapshotSchema),
  externalSpools: z.array(homeAssistantExternalSpoolSummarySchema),
  observedAt: z.string()
})
export type HomeAssistantPrinterSnapshot = z.infer<typeof homeAssistantPrinterSnapshotSchema>

export const homeAssistantSnapshotSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string(),
  printers: z.array(homeAssistantPrinterSnapshotSchema)
})
export type HomeAssistantSnapshot = z.infer<typeof homeAssistantSnapshotSchema>

export const homeAssistantBridgeInfoSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string(),
  printerCount: z.number().int().nonnegative(),
  amsUnitCount: z.number().int().nonnegative(),
  snapshotPath: z.string()
})
export type HomeAssistantBridgeInfo = z.infer<typeof homeAssistantBridgeInfoSchema>

export const homeAssistantAccessTokenStateSchema = z.enum([
  'missing',
  'active',
  'revoked',
  'deleted',
  'misconfigured'
])
export type HomeAssistantAccessTokenState = z.infer<typeof homeAssistantAccessTokenStateSchema>

export const homeAssistantManagedServiceAccountSchema = z.object({
  id: z.string(),
  name: z.string(),
  tokenPrefix: z.string(),
  revokedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string()
})
export type HomeAssistantManagedServiceAccount = z.infer<typeof homeAssistantManagedServiceAccountSchema>

export const homeAssistantAccessStatusSchema = z.object({
  tokenRequired: z.literal(true),
  recommendedPermissions: z.array(permissionSchema),
  state: homeAssistantAccessTokenStateSchema,
  serviceAccount: homeAssistantManagedServiceAccountSchema.nullable(),
  missingPermissions: z.array(permissionSchema)
})
export type HomeAssistantAccessStatus = z.infer<typeof homeAssistantAccessStatusSchema>

export const homeAssistantCreateAccessTokenResponseSchema = z.object({
  serviceAccount: homeAssistantManagedServiceAccountSchema,
  token: z.string().min(1)
})
export type HomeAssistantCreateAccessTokenResponse = z.infer<typeof homeAssistantCreateAccessTokenResponseSchema>
