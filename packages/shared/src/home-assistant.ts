/**
 * Home Assistant bridge contracts shared by the API plugin and the PrintStream
 * web plugin. The custom integration consumes the same JSON shape from Python.
 */
import { z } from 'zod'
import {
  amsSlotSchema,
  externalSpoolSchema,
  printerModelSchema,
  printerStatusSchema
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

/**
 * The subset of live printer status the HA snapshot mirrors 1:1. Derived from
 * `printerStatusSchema.pick(...)` (not re-declared) so field types stay in lock-
 * step with the source contract and can't silently drift. The HA-specific
 * identity/camera/AMS fields are added via `.extend` below.
 */
const homeAssistantPrinterStatusFields = printerStatusSchema.pick({
  online: true,
  stage: true,
  subStage: true,
  progressPercent: true,
  currentLayer: true,
  totalLayers: true,
  remainingMinutes: true,
  jobName: true,
  lastJobName: true,
  gcodeFile: true,
  bedTemp: true,
  bedTarget: true,
  nozzleTemp: true,
  nozzleTarget: true,
  nozzles: true,
  chamberTemp: true,
  fanGearSpeed: true,
  partFanPercent: true,
  auxFanPercent: true,
  chamberFanPercent: true,
  wifiSignalDbm: true,
  ipAddress: true,
  doorOpen: true,
  ductMode: true,
  ductAvailableModes: true,
  lightModes: true,
  lightCapabilities: true,
  lightOn: true,
  speedLevel: true,
  printOptions: true,
  amsSettings: true,
  sdCardPresent: true,
  firmwareVersion: true,
  deviceError: true,
  hmsErrors: true,
  observedAt: true
})

export const homeAssistantPrinterSnapshotSchema = homeAssistantPrinterStatusFields.extend({
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
  // HA-curated AMS/spool summaries (smaller than the full status arrays).
  ams: z.array(homeAssistantAmsUnitSnapshotSchema),
  externalSpools: z.array(homeAssistantExternalSpoolSummarySchema)
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
