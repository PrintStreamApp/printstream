/**
 * Print-queue contracts shared by the API and web client (the `print-queue`
 * plugin): the queued-item DTO and its request bodies, plus a **pure, reusable
 * matcher** that decides which printers a queued item can run on.
 *
 * The matcher lives here on purpose so both sides use one implementation: the API
 * computes the AMS tray mapping at dispatch time, while the web recomputes
 * per-printer eligibility live as printer status (loaded AMS material) streams in —
 * no extra round-trips. Matching is type + exact-color against the printer's loaded
 * AMS slots; an opt-in "type-only" fallback ignores color. v1 is manual-dispatch
 * only (no autonomous auto-advance).
 */
import { z } from 'zod'
import {
  printFromLibrarySchema,
  isPrinterActiveJobStage,
  type PrinterModel,
  type PrinterStatus
} from './printer.js'
import { isPrinterModelCompatible } from './print-compatibility.js'

// ---------------------------------------------------------------------------
// Pure matcher (used by both the API dispatch path and the web eligibility view)
// ---------------------------------------------------------------------------

/** A filament a plate requires: 1-based project filament id, type, and color. */
export interface QueueRequiredFilament {
  id: number
  filamentType: string | null
  color: string | null
  /** Optional brand/preset name. Display only — the matcher routes on type + color. */
  filamentName?: string | null
  /** Grams this filament needs on the plate (from the slice), for the "how much is needed" / sufficiency UI. */
  usedGrams?: number | null
}

/** A filament currently loaded on a printer, flattened across AMS units + external spools. */
export interface QueueLoadedSlot {
  /** Bambu tray index: `amsUnitId * 4 + slot` for AMS trays, or `254`/`255` for external spools. */
  trayIndex: number
  filamentType: string | null
  color: string | null
  remainPercent: number | null
  occupied: boolean
}

export interface QueueMatchOptions {
  /** When true, a required filament matches a slot on type alone, ignoring color. */
  allowTypeOnlyMatch: boolean
}

export interface QueueMatchResult {
  /** True when every required filament was assigned a loaded slot. */
  matched: boolean
  /** Tray mapping indexed by `(filament.id - 1)`; `-1` for any filament left unmatched. */
  amsMapping: number[]
  /** Required filaments with no matching loaded slot. */
  missing: QueueRequiredFilament[]
}

/** Normalize a color to `#RRGGBB` (uppercase), or null when unparseable. */
export function normalizeHexColor(value: string | null | undefined): string | null {
  if (!value) return null
  const trimmed = value.trim()
  const match = /^#?([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(trimmed)
  if (!match) return null
  return `#${match[1]!.toUpperCase()}`
}

/** Flatten a printer's AMS units and external spools into a list of loaded slots. */
export function loadedSlotsFromStatus(status: PrinterStatus): QueueLoadedSlot[] {
  const slots: QueueLoadedSlot[] = []
  for (const unit of status.ams) {
    for (const slot of unit.slots) {
      slots.push({
        trayIndex: unit.unitId * 4 + slot.slot,
        filamentType: slot.filamentType,
        color: slot.color,
        remainPercent: slot.remainPercent,
        occupied: slot.occupied ?? slot.filamentType != null
      })
    }
  }
  for (const spool of status.externalSpools) {
    slots.push({
      trayIndex: spool.amsId,
      filamentType: spool.filamentType,
      color: spool.color,
      remainPercent: spool.remainPercent,
      occupied: spool.filamentType != null
    })
  }
  return slots
}

function typeMatches(required: string | null, slot: string | null): boolean {
  if (required == null) return true
  if (slot == null) return false
  return required.trim().toLowerCase() === slot.trim().toLowerCase()
}

function colorSatisfied(required: string | null, slot: string | null): boolean {
  const wanted = normalizeHexColor(required)
  if (wanted == null) return true
  const have = normalizeHexColor(slot)
  if (have == null) return false
  return wanted === have
}

/** Pick the best loaded slot for a required filament, or null when none matches. */
function pickSlot(
  required: QueueRequiredFilament,
  slots: QueueLoadedSlot[],
  options: QueueMatchOptions
): QueueLoadedSlot | null {
  const typeCandidates = slots.filter((slot) => slot.occupied && typeMatches(required.filamentType, slot.filamentType))
  if (typeCandidates.length === 0) return null
  const exact = typeCandidates.filter((slot) => colorSatisfied(required.color, slot.color))
  const pool = exact.length > 0 ? exact : options.allowTypeOnlyMatch ? typeCandidates : []
  if (pool.length === 0) return null
  // Deterministic tie-break by tray index. (Phase 2 may prefer lowest-remaining.)
  return pool.reduce((best, slot) => (slot.trayIndex < best.trayIndex ? slot : best))
}

/**
 * Match a plate's required filaments against a printer's loaded slots. With no
 * required filaments (e.g. a plain `.gcode` whose materials are unknown) the match
 * is unconstrained and succeeds.
 */
export function evaluateQueueMatch(
  required: QueueRequiredFilament[],
  slots: QueueLoadedSlot[],
  options: QueueMatchOptions
): QueueMatchResult {
  if (required.length === 0) return { matched: true, amsMapping: [], missing: [] }
  const maxId = required.reduce((max, filament) => Math.max(max, filament.id), 0)
  const amsMapping = new Array<number>(maxId).fill(-1)
  const missing: QueueRequiredFilament[] = []
  for (const filament of required) {
    const slot = pickSlot(filament, slots, options)
    if (slot) amsMapping[filament.id - 1] = slot.trayIndex
    else missing.push(filament)
  }
  return { matched: missing.length === 0, amsMapping, missing }
}

/** Human-readable list of missing materials, e.g. `PLA #1A1A1A, PETG`. */
export function describeMissingFilaments(missing: QueueRequiredFilament[]): string {
  return missing
    .map((filament) => {
      const type = filament.filamentType?.trim() || 'filament'
      const color = normalizeHexColor(filament.color)
      return color ? `${type} ${color}` : type
    })
    .join(', ')
}

/** What the matcher needs to know about a candidate printer. */
export interface QueuePrinterContext {
  printerId: string
  model: string
  status: PrinterStatus
}

/** What the matcher needs to know about a queued item to place it. */
export interface QueueItemPlacement {
  targetKind: QueueTargetKind
  targetPrinterId: string | null
  targetModel: string | null
  requiredFilaments: QueueRequiredFilament[]
  /** Printer models the (sliced) file is compatible with; empty = no model constraint. */
  compatibleModels: string[]
}

export interface QueuePrinterEligibility {
  printerId: string
  eligible: boolean
  idle: boolean
  amsMapping: number[] | null
  reason: string | null
  /** Required filaments with no matching loaded slot on this printer (empty unless material-blocked). */
  missing: QueueRequiredFilament[]
}

/** Non-material placement check for one printer: target pin, model pin, sliced-model fit, online. */
export interface QueuePlacementConstraints {
  eligible: boolean
  idle: boolean
  reason: string | null
}

/**
 * The placement checks that don't depend on loaded material — target/model pin, sliced-model
 * compatibility, and online state. Shared by {@link evaluateQueueItemForPrinter} (which then also
 * matches material) and the single-item manual-override dispatch (which lets the user choose the AMS
 * slots themselves, so it validates everything *except* the material match).
 */
export function evaluateQueuePlacementConstraints(
  item: QueueItemPlacement,
  printer: QueuePrinterContext
): QueuePlacementConstraints {
  const idle = printer.status.online && !isPrinterActiveJobStage(printer.status.stage)
  if (item.targetKind === 'printer' && item.targetPrinterId && printer.printerId !== item.targetPrinterId) {
    return { eligible: false, idle, reason: 'Pinned to a different printer' }
  }
  if (item.targetKind === 'model' && item.targetModel && printer.model !== item.targetModel) {
    return { eligible: false, idle, reason: `Pinned to ${item.targetModel}` }
  }
  if (item.compatibleModels.length > 0 && !isPrinterModelCompatible(item.compatibleModels as PrinterModel[], printer.model as PrinterModel)) {
    return { eligible: false, idle, reason: `Sliced for ${item.compatibleModels.join(' / ')}` }
  }
  if (!printer.status.online) {
    return { eligible: false, idle: false, reason: 'Printer offline' }
  }
  return { eligible: true, idle, reason: null }
}

/** Evaluate whether one printer can run a queued item, and how (tray mapping). */
export function evaluateQueueItemForPrinter(
  item: QueueItemPlacement,
  printer: QueuePrinterContext,
  options: QueueMatchOptions
): QueuePrinterEligibility {
  const base = evaluateQueuePlacementConstraints(item, printer)
  if (!base.eligible) {
    return { printerId: printer.printerId, eligible: false, idle: base.idle, amsMapping: null, reason: base.reason, missing: [] }
  }
  const { matched, amsMapping, missing } = evaluateQueueMatch(item.requiredFilaments, loadedSlotsFromStatus(printer.status), options)
  if (!matched) {
    return { printerId: printer.printerId, eligible: false, idle: base.idle, amsMapping: null, reason: `Needs ${describeMissingFilaments(missing)}`, missing }
  }
  return { printerId: printer.printerId, eligible: true, idle: base.idle, amsMapping, reason: null, missing: [] }
}

export interface QueueItemEligibilitySummary {
  eligiblePrinterIds: string[]
  idlePrinterIds: string[]
  /** First idle eligible printer (by input order), else first eligible, else null. */
  recommendedPrinterId: string | null
  recommendedAmsMapping: number[] | null
  /** No printer can run this item (material/target/offline). */
  blocked: boolean
  blockedReason: string | null
  /** When blocked on material, the required filaments no connected printer has loaded (for a rich
   *  "Needs ..." label); empty when blocked for a non-material reason (model/nozzle/offline). */
  missingFilaments: QueueRequiredFilament[]
  /** Eligible somewhere, but every eligible printer is busy. */
  waitingForFreePrinter: boolean
}

/**
 * Summarize a queued item against the fleet: which printers are eligible, a
 * recommended target (first idle eligible by the caller's ordering), and a blocked
 * reason when nothing matches. Callers order `printers` to express load-balancing
 * (the server passes least-recently-used first; the web passes display order).
 */
export function summarizeQueueItemEligibility(
  item: QueueItemPlacement,
  printers: QueuePrinterContext[],
  options: QueueMatchOptions
): QueueItemEligibilitySummary {
  const evaluations = printers.map((printer) => evaluateQueueItemForPrinter(item, printer, options))
  const eligible = evaluations.filter((entry) => entry.eligible)
  const idleEligible = eligible.filter((entry) => entry.idle)
  const recommended = idleEligible[0] ?? eligible[0] ?? null
  const blocked = eligible.length === 0
  // The representative material-block (first printer that's only missing filament) drives the rich
  // "Needs ..." chip; a non-material block (model/nozzle/offline) leaves missingFilaments empty.
  const materialBlock = blocked ? evaluations.find((entry) => entry.reason?.startsWith('Needs ')) ?? null : null
  return {
    eligiblePrinterIds: eligible.map((entry) => entry.printerId),
    idlePrinterIds: idleEligible.map((entry) => entry.printerId),
    recommendedPrinterId: recommended?.printerId ?? null,
    recommendedAmsMapping: recommended?.amsMapping ?? null,
    blocked,
    blockedReason: blocked ? pickBlockedReason(printers, evaluations) : null,
    missingFilaments: materialBlock?.missing ?? [],
    waitingForFreePrinter: !blocked && idleEligible.length === 0
  }
}

function pickBlockedReason(printers: QueuePrinterContext[], evaluations: QueuePrinterEligibility[]): string {
  if (printers.length === 0) return 'No printers available'
  const materialMiss = evaluations.find((entry) => entry.reason?.startsWith('Needs '))
  return materialMiss?.reason ?? evaluations[0]?.reason ?? 'No eligible printer'
}

// ---------------------------------------------------------------------------
// Contracts (DTO + request bodies + settings)
// ---------------------------------------------------------------------------

export const queueItemStatusSchema = z.enum(['queued', 'held', 'dispatching', 'printing', 'done', 'failed'])
export type QueueItemStatus = z.infer<typeof queueItemStatusSchema>

export const queueTargetKindSchema = z.enum(['any', 'printer', 'model'])
export type QueueTargetKind = z.infer<typeof queueTargetKindSchema>

export const queueTargetSchema = z.object({
  kind: queueTargetKindSchema.default('any'),
  printerId: z.string().min(1).nullish(),
  model: z.string().min(1).nullish()
})
  .refine((target) => target.kind !== 'printer' || !!target.printerId, { message: 'Pin a printer to target a specific printer' })
  .refine((target) => target.kind !== 'model' || !!target.model, { message: 'Pin a model to target a printer model' })
export type QueueTarget = z.infer<typeof queueTargetSchema>

/** Dispatch knobs stored per queued item (everything in PrintFromLibrary except what the queue owns). */
export const queuePrintOptionsSchema = printFromLibrarySchema.omit({
  fileId: true,
  printerId: true,
  plate: true,
  amsMapping: true
})
export type QueuePrintOptions = z.infer<typeof queuePrintOptionsSchema>

export const queueRequiredFilamentSchema = z.object({
  id: z.number().int().positive(),
  filamentType: z.string().nullable(),
  color: z.string().nullable(),
  /** Optional brand/preset name. Display only — the matcher routes on type + color. */
  filamentName: z.string().nullable().optional(),
  /** Grams this filament needs on the plate (from the slice). Display only. */
  usedGrams: z.number().nullable().optional()
})

/** A concrete slicer-slot -> AMS-tray mapping (indexed by `filament.id - 1`; `-1` = unmapped). */
export const queueAmsMappingSchema = z.array(z.number().int())

const queueLabelSchema = z.string().trim().max(120).nullish()

export const queueItemCreateSchema = z.object({
  libraryFileId: z.string().min(1),
  plate: z.number().int().positive().default(1),
  quantity: z.number().int().positive().max(999).default(1),
  target: queueTargetSchema.default({ kind: 'any' }),
  options: queuePrintOptionsSchema.optional(),
  /** Concrete AMS tray mapping (specific-printer target); the matcher computes one otherwise. */
  amsMapping: queueAmsMappingSchema.optional(),
  /** Override the plate's required materials (general "any printer" mapping). */
  requiredFilaments: z.array(queueRequiredFilamentSchema).max(64).optional(),
  label: queueLabelSchema
})
export type QueueItemCreateInput = z.infer<typeof queueItemCreateSchema>

export const queueItemUpdateSchema = z.object({
  plate: z.number().int().positive().optional(),
  quantity: z.number().int().positive().max(999).optional(),
  target: queueTargetSchema.optional(),
  options: queuePrintOptionsSchema.optional(),
  /** Set the manual AMS mapping override, or `null` to clear it. */
  amsMapping: queueAmsMappingSchema.nullable().optional(),
  requiredFilaments: z.array(queueRequiredFilamentSchema).max(64).optional(),
  label: queueLabelSchema,
  /** Hold (`held`) or resume (`queued`) only — lifecycle states are server-managed. */
  status: z.enum(['queued', 'held']).optional()
}).refine((value) => Object.keys(value).length > 0, { message: 'Provide at least one field to update' })
export type QueueItemUpdateInput = z.infer<typeof queueItemUpdateSchema>

export const queueReorderSchema = z.object({
  orderedIds: z.array(z.string().min(1)).max(1000)
})
export type QueueReorderInput = z.infer<typeof queueReorderSchema>

export const queueDispatchSchema = z.object({
  printerId: z.string().min(1).optional(),
  /**
   * Manual filament -> AMS-tray override for a single start (indexed by `filament.id - 1`). When set,
   * dispatch uses these slots verbatim and skips the automatic material match — the user has chosen the
   * slots themselves — so it requires an explicit `printerId`. The placement (target/model/online/idle)
   * is still validated.
   */
  amsMapping: queueAmsMappingSchema.optional(),
  /**
   * When true, run every pre-flight check a real Start runs (file resolved + readable on the bridge,
   * printer connected, print guards, plate/filament compatibility) and report what *would* happen,
   * WITHOUT uploading or starting — the "Check" / dry-run action. Returns a {@link QueueDryRunResult}.
   */
  dryRun: z.boolean().optional()
}).refine((value) => !value.amsMapping || !!value.printerId, {
  message: 'Choose a printer when overriding the AMS slots'
})
export type QueueDispatchInput = z.infer<typeof queueDispatchSchema>

/** Result of a dry-run dispatch ("Check"): whether a real Start would succeed and, if not, why. */
export const queueDryRunResultSchema = z.object({
  ok: z.boolean(),
  reason: z.string().nullable(),
  printerId: z.string().nullable(),
  printerName: z.string().nullable()
})
export type QueueDryRunResult = z.infer<typeof queueDryRunResultSchema>

export const queueItemSchema = z.object({
  id: z.string(),
  libraryFileId: z.string().nullable(),
  fileAvailable: z.boolean(),
  fileName: z.string(),
  kind: z.enum(['gcode', '3mf']),
  plateIndex: z.number().int().positive(),
  plateName: z.string().nullable(),
  quantity: z.number().int().positive(),
  completedCount: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
  sortKey: z.number(),
  target: queueTargetSchema,
  targetPrinterName: z.string().nullable(),
  requiredFilaments: z.array(queueRequiredFilamentSchema),
  /** Printer models the file is compatible with (empty = no model constraint). */
  compatibleModels: z.array(z.string()),
  /** Bed/plate type the file was sliced for (e.g. "Textured PEI Plate"); null for plain gcode. */
  plateType: z.string().nullable(),
  /** Nozzle diameters the file was sliced for (e.g. ["0.4"]); empty for plain gcode. */
  nozzleDiameters: z.array(z.string()),
  /** Manual AMS tray-mapping override, when one was set; otherwise null (matcher decides at dispatch). */
  amsMapping: queueAmsMappingSchema.nullable(),
  options: queuePrintOptionsSchema,
  status: queueItemStatusSchema,
  label: z.string().nullable(),
  lastPrinterId: z.string().nullable(),
  lastPrinterName: z.string().nullable(),
  lastResult: z.enum(['success', 'failed', 'cancelled']).nullable(),
  lastDispatchedAt: z.string().nullable(),
  lastFinishedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string()
})
export type QueueItem = z.infer<typeof queueItemSchema>

export const queueListSchema = z.object({
  items: z.array(queueItemSchema)
})
export type QueueList = z.infer<typeof queueListSchema>

export const queueSettingsSchema = z.object({
  /** Match a required filament on type alone when no exact color is loaded. */
  allowTypeOnlyMatch: z.boolean().default(false),
  /** How "Start all idle" and the recommended printer are chosen. */
  loadBalance: z.enum(['idle-lru', 'sort-order']).default('idle-lru')
})
export type QueueSettings = z.infer<typeof queueSettingsSchema>
