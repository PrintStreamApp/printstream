/**
 * Filament spool contracts shared by the API and web client (the
 * `filament-manager` plugin): a workspace's spool inventory, create/update
 * inputs, manual quantity adjustments, slot assignment, the per-spool
 * consumption ledger, and the live `plugin.event` payloads the API broadcasts
 * when inventory changes.
 *
 * `remainingGrams` is the canonical "amount left"; `remainPercent` is a derived
 * convenience (`remainingGrams / netWeightGrams`). `status` is derived by the
 * API and is not stored. Dates are ISO strings on the wire.
 */
import { z } from 'zod'

const optionalText = (max: number) => z.string().trim().max(max).nullable()

/** A primary or palette colour, normalised to `#RRGGBB`. */
export const filamentHexColorSchema = z
  .string()
  .trim()
  .regex(/^#[0-9A-Fa-f]{6}$/, 'Expected a #RRGGBB colour')
export type FilamentHexColor = z.infer<typeof filamentHexColorSchema>

/** Where `remainingGrams` is kept in sync from. */
export const filamentRemainSourceSchema = z.enum(['printer', 'tracked', 'manual'])
export type FilamentRemainSource = z.infer<typeof filamentRemainSourceSchema>

/** Reason a consumption-ledger row was written. */
export const filamentUsageSourceSchema = z.enum(['print', 'manual', 'rfid-sync'])
export type FilamentUsageSource = z.infer<typeof filamentUsageSourceSchema>

/** Derived lifecycle/availability bucket used for filtering and badges. */
export const filamentSpoolStatusSchema = z.enum(['available', 'loaded', 'low', 'empty', 'archived'])
export type FilamentSpoolStatus = z.infer<typeof filamentSpoolStatusSchema>

const gramsSchema = z.number().nonnegative().max(100_000)
const tempSchema = z.number().int().min(0).max(500)

/** Editable fields shared by create and update. */
const spoolWritableShape = {
  brand: optionalText(120).optional(),
  filamentType: z.string().trim().min(1).max(40),
  materialSubtype: optionalText(60).optional(),
  colorName: optionalText(80).optional(),
  colorHex: filamentHexColorSchema.nullable().optional(),
  colors: z.array(filamentHexColorSchema).max(16).optional(),
  trayInfoIdx: optionalText(32).optional(),
  bambuUuid: optionalText(64).optional(),
  /** Slicing preset (filament profile name) this spool slices with; null = auto-match at slice time. */
  slicingPresetName: optionalText(200).optional(),
  serial: optionalText(80).optional(),
  nozzleTempMin: tempSchema.nullable().optional(),
  nozzleTempMax: tempSchema.nullable().optional(),
  diameterMm: z.number().positive().max(10).optional(),
  netWeightGrams: z.number().int().positive().max(100_000).optional(),
  spoolCoreGrams: z.number().int().nonnegative().max(100_000).nullable().optional(),
  remainingGrams: gramsSchema.optional(),
  remainSource: filamentRemainSourceSchema.optional(),
  costCents: z.number().int().nonnegative().max(100_000_000).nullable().optional(),
  currency: z.string().trim().length(3).nullable().optional(),
  purchasedAt: z.string().datetime().nullable().optional(),
  vendor: optionalText(120).optional(),
  notes: optionalText(2_000).optional()
}

export const spoolCreateSchema = z.object(spoolWritableShape)
export type SpoolCreateInput = z.infer<typeof spoolCreateSchema>

export const spoolUpdateSchema = z
  .object({ ...spoolWritableShape, filamentType: spoolWritableShape.filamentType.optional(), archived: z.boolean().optional() })
  .refine((value) => Object.keys(value).length > 0, { message: 'Provide at least one field to update' })
export type SpoolUpdateInput = z.infer<typeof spoolUpdateSchema>

/**
 * Manual quantity correction: set an absolute `remainingGrams` (a weigh-in or
 * refill) or apply a signed `deltaGrams`. Writes a `manual` ledger row.
 */
export const spoolAdjustSchema = z
  .object({
    remainingGrams: gramsSchema.optional(),
    deltaGrams: z.number().min(-100_000).max(100_000).optional(),
    note: z.string().trim().max(500).optional()
  })
  .refine((value) => value.remainingGrams != null || value.deltaGrams != null, {
    message: 'Provide remainingGrams or deltaGrams'
  })
export type SpoolAdjustInput = z.infer<typeof spoolAdjustSchema>

/**
 * Associate a spool with a physical slot. `amsId` is the AMS unit id, or a
 * virtual-tray id (254/255) for an external spool; `slotId` is null for
 * external spools.
 */
export const spoolAssignSchema = z.object({
  printerId: z.string().min(1),
  amsId: z.number().int().min(0).max(255),
  slotId: z.number().int().min(0).max(15).nullable().optional()
})
export type SpoolAssignInput = z.infer<typeof spoolAssignSchema>

export const filamentSpoolSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
  archivedAt: z.string().nullable(),
  brand: z.string().nullable(),
  filamentType: z.string(),
  materialSubtype: z.string().nullable(),
  colorName: z.string().nullable(),
  colorHex: z.string().nullable(),
  colors: z.array(z.string()),
  trayInfoIdx: z.string().nullable(),
  bambuUuid: z.string().nullable(),
  /** Slicing preset (filament profile name) this spool slices with; null = auto-match. */
  slicingPresetName: z.string().nullable(),
  serial: z.string().nullable(),
  nozzleTempMin: z.number().nullable(),
  nozzleTempMax: z.number().nullable(),
  diameterMm: z.number(),
  netWeightGrams: z.number(),
  spoolCoreGrams: z.number().nullable(),
  remainingGrams: z.number(),
  /** Derived: remainingGrams / netWeightGrams, 0-100, null when net weight unknown. */
  remainPercent: z.number().nullable(),
  remainSource: filamentRemainSourceSchema,
  /** Derived availability bucket; not persisted. */
  status: filamentSpoolStatusSchema,
  costCents: z.number().nullable(),
  currency: z.string().nullable(),
  purchasedAt: z.string().nullable(),
  vendor: z.string().nullable(),
  notes: z.string().nullable(),
  loadedPrinterId: z.string().nullable(),
  /** Denormalised for display so listings need no extra printer lookup. */
  loadedPrinterName: z.string().nullable(),
  loadedAmsId: z.number().nullable(),
  loadedSlotId: z.number().nullable(),
  loadedAt: z.string().nullable(),
  lastSeenAt: z.string().nullable()
})
export type FilamentSpool = z.infer<typeof filamentSpoolSchema>

export const filamentSpoolListSchema = z.object({
  spools: z.array(filamentSpoolSchema)
})
export type FilamentSpoolList = z.infer<typeof filamentSpoolListSchema>

export const filamentUsageEntrySchema = z.object({
  id: z.string(),
  spoolId: z.string(),
  jobId: z.string().nullable(),
  grams: z.number(),
  source: filamentUsageSourceSchema,
  note: z.string().nullable(),
  recordedAt: z.string()
})
export type FilamentUsageEntry = z.infer<typeof filamentUsageEntrySchema>

export const filamentUsageListSchema = z.object({
  usage: z.array(filamentUsageEntrySchema)
})
export type FilamentUsageList = z.infer<typeof filamentUsageListSchema>

/**
 * One slice of a filament-usage breakdown: total grams used for a single
 * filament type or brand. "Used" is the inventory delta (net weight minus
 * remaining) summed across the workspace's spools, so it counts both
 * printer-tracked (Bambu remain%) and per-job-tracked spools.
 */
export const filamentUsageSliceSchema = z.object({
  label: z.string(),
  gramsUsed: z.number().nonnegative()
})
export type FilamentUsageSlice = z.infer<typeof filamentUsageSliceSchema>

/**
 * Aggregate filament-usage stats for the workspace's spool inventory, surfaced
 * on the stats page. `byType` and `byBrand` are each sorted by `gramsUsed`
 * descending; the client decides how many slices to name in a legend.
 */
export const filamentUsageStatsSchema = z.object({
  totalGramsUsed: z.number().nonnegative(),
  byType: z.array(filamentUsageSliceSchema),
  byBrand: z.array(filamentUsageSliceSchema)
})
export type FilamentUsageStats = z.infer<typeof filamentUsageStatsSchema>

/**
 * Build sorted filament-usage slices from raw per-group totals. "Used" is net
 * weight minus remaining (clamped to >= 0); duplicate labels merge, zero-usage
 * groups drop, and the result sorts by grams used descending. Pure so the
 * per-tenant aggregation and the platform-wide one share one rule.
 */
export function buildFilamentUsageSlices(
  rows: ReadonlyArray<{ label: string | null | undefined; netWeightGrams: number | null; remainingGrams: number | null }>,
  fallbackLabel: string
): FilamentUsageSlice[] {
  const totals = new Map<string, number>()
  for (const row of rows) {
    const used = Math.max(0, (row.netWeightGrams ?? 0) - (row.remainingGrams ?? 0))
    if (used <= 0) continue
    const trimmed = typeof row.label === 'string' ? row.label.trim() : ''
    const label = trimmed.length > 0 ? trimmed : fallbackLabel
    totals.set(label, (totals.get(label) ?? 0) + used)
  }
  return [...totals]
    .map(([label, gramsUsed]) => ({ label, gramsUsed }))
    .sort((left, right) => right.gramsUsed - left.gramsUsed)
}

/** Per-tenant plugin settings surfaced to the settings panel. */
export const filamentManagerSettingsSchema = z.object({
  autoAddBambuSpools: z.boolean()
})
export type FilamentManagerSettings = z.infer<typeof filamentManagerSettingsSchema>

/**
 * Live inventory-change events broadcast inside the `plugin.event` envelope
 * (`pluginName: 'filament-manager'`). Coarse on purpose: the web client reacts
 * by invalidating its spool queries.
 */
export const filamentManagerEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('spool.changed'), spoolId: z.string() }),
  z.object({ kind: z.literal('spools.changed') })
])
export type FilamentManagerEvent = z.infer<typeof filamentManagerEventSchema>
