/**
 * Print-queue contracts shared by the API and web client (the `print-queue`
 * plugin), plus the **pure material matcher** every print surface consolidates
 * on: the queue's dispatch/eligibility paths AND the print dialogs' auto
 * slot-selection (library `PrintModal`, printer-storage `StoragePrintModal`,
 * `QueueStartDialog`) all place a plate's required filaments onto a printer's
 * loaded slots through `evaluateQueueMatch`, no per-dialog heuristics.
 *
 * The matcher lives here on purpose so both sides use one implementation: the API
 * computes the AMS tray mapping at dispatch time, while the web recomputes
 * per-printer eligibility live as printer status (loaded AMS material) streams in,
 * no extra round-trips. Matching rules:
 *
 *   - An exact match is filament type + colour (an opt-in "type-only" fallback
 *     ignores colour). Only exact matches should ever be surfaced as automatic
 *     selections; near matches stay the user's call.
 *   - A nozzle binding is a HARD constraint: a filament bound to one extruder is
 *     never matched to a slot feeding the other, even when it is the only
 *     colour match. Slots with no known nozzle (single-nozzle machines, Filament
 *     Track Switch units, unknown wiring) remain eligible for every filament.
 *   - Ties break toward genuine preset-identity matches first, then the slot
 *     with the least filament that still holds ENOUGH for the job (so partial
 *     spools are consumed before fresh ones, without picking a remnant that
 *     would run out mid-print); AMS auto-refill pooling suppresses that
 *     drain-the-smallest preference because the printer chains matching trays
 *     itself. See `pickSlot`.
 */
import { z } from 'zod'
import {
  amsMappingEntrySchema,
  printFromLibrarySchema,
  isPrinterActiveJobStage,
  type PrinterModel,
  type PrinterStatus
} from './printer.js'
import { amsTrayIndex, isPhysicalAmsTrayIndex } from './ams-tray-index.js'
import { effectiveAmsNozzleId } from './filament-track-switch.js'
import { isPrinterModelCompatible } from './print-compatibility.js'
import { normalizeHexColor } from './filament-color.js'
import { isGenuineBambuTray } from './filament-identity.js'
import { filamentPresetNameFromId } from './bambu-filament-presets.js'
import { filamentPresetFamilyName } from './filament-rebind.js'
import { gradeSlotSufficiency, type SlotSufficiency } from './slot-remaining.js'

export { normalizeHexColor }

// ---------------------------------------------------------------------------
// Pure matcher (used by both the API dispatch path and the web eligibility view)
// ---------------------------------------------------------------------------

/**
 * A filament a plate requires: 1-based project filament id, type, and color.
 *
 * `filamentType` is the DERIVED display type (`PLA-S`, not a support preset's
 * raw `PLA`), a producer building requirements from preset data must derive
 * through `resolveDisplayFilamentType` first, never hand the matcher a raw
 * base type. Do NOT assume the two sides then agree textually: the declared
 * type of the SAME material drifts across Studio releases (Bambu PETG HF is
 * "PETG" in 2.7.1.57 and "PETG-HF" in 2.7.1.62), so the matcher's type gate
 * also accepts equal genuine preset identity (see `pickSlot`).
 */
export interface QueueRequiredFilament {
  id: number
  filamentType: string | null
  color: string | null
  /**
   * Optional brand/preset name ("Bambu PLA Basic @BBL X1C"). Never a
   * constraint: used for display and, when a loaded slot's genuine-Bambu
   * identity names the same preset, as a tie-break preference among exact
   * matches.
   */
  filamentName?: string | null
  /** Grams this filament needs on the plate (from the slice); also guards the lowest-remaining tie-break. */
  usedGrams?: number | null
  /**
   * Extruder this filament is bound to (0 = right/main, 1 = left/deputy);
   * null/absent = unconstrained. A binding is HARD for matching: the matcher
   * leaves the filament unmatched rather than crossing it.
   */
  nozzleId?: number | null
}

/** A filament currently loaded on a printer, flattened across AMS units + external spools. */
export interface QueueLoadedSlot {
  /** Bambu global tray index (see `amsTrayIndex`) for AMS trays, or `254`/`255` for external spools. */
  trayIndex: number
  filamentType: string | null
  color: string | null
  remainPercent: number | null
  occupied: boolean
  /**
   * Extruder this slot feeds (0 = right/main, 1 = left/deputy); null = reachable
   * by any extruder (single-nozzle machine, Filament Track Switch unit, unknown).
   */
  nozzleId: number | null
  /** RFID tray uuid; the percent-based remaining estimate is only trusted when this reads as a real tag. */
  trayUuid?: string | null
  /** Bambu preset id (`GFA00`); feeds the genuine-identity tie-break and auto-refill pooling. */
  trayInfoIdx?: string | null
  trayName?: string | null
  /** Full tray palette, for auto-refill pooling. */
  colors?: readonly string[]
  /**
   * Tracked-spool remaining grams (filament-manager), when the caller knows it.
   * Takes precedence over the percent estimate: mirrors `SlotOptionLabel`.
   */
  remainingGrams?: number | null
}

export interface QueueMatchOptions {
  /** When true, a required filament matches a slot on type alone, ignoring color. */
  allowTypeOnlyMatch: boolean
  /**
   * The printer's AMS auto-refill setting. When on, trays that pool for refill
   * are graded on their combined remaining and skip the drain-the-smallest
   * preference: the printer chains them itself.
   */
  autoRefillEnabled?: boolean
}

export interface QueueMatchResult {
  /** True when every required filament was assigned a loaded slot. */
  matched: boolean
  /** Tray mapping indexed by `(filament.id - 1)`; `-1` for any filament left unmatched. */
  amsMapping: number[]
  /** Required filaments with no matching loaded slot. */
  missing: QueueRequiredFilament[]
}

/** Flatten a printer's AMS units and external spools into a list of loaded slots. */
export function loadedSlotsFromStatus(status: PrinterStatus): QueueLoadedSlot[] {
  const slots: QueueLoadedSlot[] = []
  for (const unit of status.ams) {
    // A unit behind a Filament Track Switch is reachable by BOTH extruders; the
    // parser already leaves its nozzleId null (see `amsUnitSchema.switchInput`),
    // but re-derive here so a stale binding can never filter such a unit out.
    const unitNozzleId = effectiveAmsNozzleId(unit)
    for (const slot of unit.slots) {
      slots.push({
        trayIndex: amsTrayIndex(unit.type, unit.unitId, slot.slot),
        filamentType: slot.filamentType,
        color: slot.color,
        colors: slot.colors,
        remainPercent: slot.remainPercent,
        occupied: slot.occupied ?? slot.filamentType != null,
        nozzleId: unitNozzleId,
        trayUuid: slot.trayUuid,
        trayInfoIdx: slot.trayInfoIdx,
        trayName: slot.trayName
      })
    }
  }
  for (const spool of status.externalSpools) {
    slots.push({
      trayIndex: spool.amsId,
      filamentType: spool.filamentType,
      color: spool.color,
      colors: spool.colors,
      remainPercent: spool.remainPercent,
      occupied: spool.filamentType != null,
      nozzleId: spool.nozzleId,
      trayUuid: spool.trayUuid,
      trayInfoIdx: spool.trayInfoIdx,
      trayName: spool.trayName
    })
  }
  return slots
}

/**
 * Canonical form for display-type comparison: the `-BASIC` suffix is dropped because it IS the
 * plain grade: Studio 2.7.1.62 writes "PLA-BASIC" into a sliced file where the AMS wire (and
 * older Studio catalogues) say "PLA" for the same material. Only BASIC collapses: HF, CF, MATTE
 * and friends are real material/flow differences and must never equal the plain type by text
 * (a Bambu-branded variant still matches its own spools through the identity leg in `pickSlot`).
 */
function canonicalDisplayType(type: string): string {
  return type.trim().toLowerCase().replace(/-basic$/, '')
}

function typeMatches(required: string | null, slot: string | null): boolean {
  if (required == null) return true
  if (slot == null) return false
  return canonicalDisplayType(required) === canonicalDisplayType(slot)
}

function colorSatisfied(required: string | null, slot: string | null): boolean {
  const wanted = normalizeHexColor(required)
  if (wanted == null) return true
  const have = normalizeHexColor(slot)
  if (have == null) return false
  return wanted === have
}

/**
 * A nozzle binding is HARD: never match across it, even when the mismatched
 * slot is the only colour match, an empty row is the correct outcome there.
 * A slot with no known nozzle stays eligible for every filament (mirrors the
 * web's `filterTrayGroupsForFilament`).
 */
function nozzleCompatible(requiredNozzleId: number | null, slotNozzleId: number | null): boolean {
  if (requiredNozzleId == null || slotNozzleId == null) return true
  return requiredNozzleId === slotNozzleId
}

/**
 * The physical AMS slots the printer's auto-refill could chain a filament's tray to:
 * occupied, and on the right side of the nozzle binding.
 *
 * Includes the mapped tray itself, which is why a real pool is `length > 1`. It does
 * NOT filter on material: `traysMatchForAutoRefill` is the far stricter identity test
 * and applying a looser type check first would only mask which rule rejected a mate.
 * External spools are excluded because the printer cannot refill from them.
 *
 * Exported for `print-filament-sufficiency.ts`, so the dialog's low-filament warning
 * pools exactly the trays this matcher pools.
 */
export function refillCandidateSlots(
  required: Pick<QueueRequiredFilament, 'nozzleId'>,
  slots: readonly QueueLoadedSlot[]
): QueueLoadedSlot[] {
  return slots.filter((slot) =>
    slot.occupied
    && isPhysicalAmsTrayIndex(slot.trayIndex)
    && nozzleCompatible(required.nozzleId ?? null, slot.nozzleId))
}

/** The genuine-Bambu preset family a slot's identity declares, or null. The genuine gate is `isGenuineBambuTray`, never bypassed. */
function slotGenuinePresetFamily(slot: QueueLoadedSlot): string | null {
  if (!isGenuineBambuTray(slot)) return null
  const presetName = filamentPresetNameFromId(slot.trayInfoIdx?.trim() ?? '')
  return presetName ? filamentPresetFamilyName(presetName).toLowerCase() : null
}

interface GradedSlotCandidate {
  slot: QueueLoadedSlot
  /** 0 = the slot's genuine identity names the required preset; 1 = plain type+colour match. */
  identityRank: number
  /** How the slot (or its refill pool) measures up against the plate's stated usage. */
  sufficiency: SlotSufficiency
  /** Known remaining grams (combined across the refill pool when pooled); null when ungradeable. */
  remainGrams: number | null
  /** Pooled by AMS auto-refill: the printer chains these trays itself. */
  pooled: boolean
}

/** Preference order for the tie-break: a slot that demonstrably holds enough beats one we cannot grade. */
const SUFFICIENCY_PREFERENCE: Record<SlotSufficiency, number> = { enough: 0, unknown: 1, short: 2 }

function gradeCandidate(
  required: QueueRequiredFilament,
  slot: QueueLoadedSlot,
  refillCandidates: QueueLoadedSlot[],
  options: QueueMatchOptions,
  requiredPresetFamily: string | null
): GradedSlotCandidate {
  const identityRank =
    requiredPresetFamily != null && slotGenuinePresetFamily(slot) === requiredPresetFamily ? 0 : 1
  const grade = gradeSlotSufficiency({
    tray: slot,
    trayIsRefillable: refillCandidates.some((candidate) => candidate.trayIndex === slot.trayIndex),
    refillCandidates,
    requiredGrams: required.usedGrams ?? null,
    autoRefillEnabled: options.autoRefillEnabled
  })
  return { slot, identityRank, ...grade }
}

function compareCandidates(left: GradedSlotCandidate, right: GradedSlotCandidate): number {
  if (left.identityRank !== right.identityRank) return left.identityRank - right.identityRank
  const leftSufficiency = SUFFICIENCY_PREFERENCE[left.sufficiency]
  const rightSufficiency = SUFFICIENCY_PREFERENCE[right.sufficiency]
  if (leftSufficiency !== rightSufficiency) return leftSufficiency - rightSufficiency
  if (left.sufficiency === 'enough') {
    // Among slots that hold enough: consume the emptiest first, so partial
    // spools are used up before fresh ones. A pooled slot sorts after known
    // solos, deliberately draining the smallest of a chained pool gains
    // nothing, the printer refills it from its mates anyway.
    const leftKey = left.pooled ? Number.POSITIVE_INFINITY : left.remainGrams ?? Number.POSITIVE_INFINITY
    const rightKey = right.pooled ? Number.POSITIVE_INFINITY : right.remainGrams ?? Number.POSITIVE_INFINITY
    if (leftKey !== rightKey) return leftKey - rightKey
  } else if (left.sufficiency === 'short') {
    // Nothing holds enough: take the fullest, and let the print dialog's low-filament
    // confirmation (`print-filament-sufficiency.ts`) surface the shortfall.
    const leftKey = left.remainGrams ?? -1
    const rightKey = right.remainGrams ?? -1
    if (leftKey !== rightKey) return rightKey - leftKey
  }
  return left.slot.trayIndex - right.slot.trayIndex
}

/**
 * Pick the best loaded slot for a required filament, or null when none matches.
 *
 * Constraint order: occupied + same material (display type text, or genuine
 * preset identity when the text drifted) + nozzle-reachable (hard) → exact
 * colour (or the opt-in type-only fallback) → preference ranking (genuine
 * preset identity, then the sufficiency-guarded lowest-remaining tie-break,
 * then tray index for determinism).
 */
function pickSlot(
  required: QueueRequiredFilament,
  slots: QueueLoadedSlot[],
  options: QueueMatchOptions
): QueueLoadedSlot | null {
  const requiredPresetFamily = required.filamentName?.trim()
    ? filamentPresetFamilyName(required.filamentName).toLowerCase() || null
    : null
  // The type gate accepts EITHER equal display-type text OR equal genuine preset identity.
  // Identity must bridge because the type text for the SAME material drifts across Studio
  // releases (2.7.1.57 declares Bambu PETG HF as "PETG", 2.7.1.62 as "PETG-HF"), so a sliced
  // plate and the AMS wire can legitimately disagree about one spool. Mirrors BambuStudio's
  // mapping order: tray `setting_id` vs preset `filament_id` outranks type text
  // (`MachineObject::ams_filament_mapping`). The identity leg stays behind the genuine gate,
  // a hand-typed trayInfoIdx proves nothing.
  const typeSatisfied = (slot: QueueLoadedSlot) =>
    typeMatches(required.filamentType, slot.filamentType)
    || (requiredPresetFamily != null && slotGenuinePresetFamily(slot) === requiredPresetFamily)
  const compatible = slots.filter((slot) =>
    slot.occupied
    && typeSatisfied(slot)
    && nozzleCompatible(required.nozzleId ?? null, slot.nozzleId))
  if (compatible.length === 0) return null
  const exact = compatible.filter((slot) => colorSatisfied(required.color, slot.color))
  const pool = exact.length > 0 ? exact : options.allowTypeOnlyMatch ? compatible : []
  if (pool.length === 0) return null
  // Refill mates are the print-reachable AMS slots, computed once rather than per candidate. They
  // are deliberately NOT narrowed to `compatible`: `traysMatchForAutoRefill` demands identical type
  // text, which is strictly stronger than the type gate above, so filtering first could only hide
  // which of the two rules rejected a mate.
  const refillCandidates = refillCandidateSlots(required, slots)
  const graded = pool.map((slot) => gradeCandidate(required, slot, refillCandidates, options, requiredPresetFamily))
  graded.sort(compareCandidates)
  return graded[0]!.slot
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

/**
 * Combine an explicit per-filament tray mapping with the matcher's computed mapping. An explicit
 * slot (>= 0) wins; an entry left at the `-1` "auto" sentinel takes the computed (material-matched)
 * slot. This is THE precedence model for every surface that layers user picks over automatic
 * matches: the API's queue dispatch (mixing slot-mapped and material-matched filaments) and the
 * web print dialogs (user edits over auto-selected suggestions) share it so a user's explicit
 * choice can never be clobbered by a recomputed match. `null`/empty override → computed as-is.
 */
export function mergeAmsMapping(override: number[] | null, computed: number[] | undefined): number[] | undefined {
  if (!override || override.length === 0) return computed && computed.length > 0 ? computed : undefined
  if (!computed || computed.length === 0) return override
  const length = Math.max(override.length, computed.length)
  const merged: number[] = []
  for (let index = 0; index < length; index += 1) {
    const explicit = override[index]
    merged[index] = explicit != null && explicit >= 0 ? explicit : computed[index] ?? -1
  }
  return merged
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
 * The placement checks that don't depend on loaded material: target/model pin, sliced-model
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
  const { matched, amsMapping, missing } = evaluateQueueMatch(item.requiredFilaments, loadedSlotsFromStatus(printer.status), {
    ...options,
    // Auto-refill is printer truth, not a caller preference: derive it from the
    // status this evaluation already targets. (Optional chain: test stubs and
    // older cached statuses may omit amsSettings.)
    autoRefillEnabled: printer.status.amsSettings?.autoRefill === true
  })
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

/**
 * Dispatch knobs stored per queued item (everything in PrintFromLibrary except what the
 * queue owns). `skipObjects` rides along deliberately: it is plate-specific, so the
 * update route drops a stored selection whenever an item's plate changes without a
 * fresh options payload, a stale selection must never carry over to another plate.
 */
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
  /** Optional brand/preset name. Display + identity tie-break preference, never a hard constraint. */
  filamentName: z.string().nullable().optional(),
  /** Grams this filament needs on the plate (from the slice); guards the lowest-remaining tie-break. */
  usedGrams: z.number().nullable().optional(),
  /** Extruder binding (0 = right/main, 1 = left/deputy); a HARD matching constraint. Absent on rows queued before it existed. */
  nozzleId: z.number().int().nullable().optional()
})

/**
 * Build a matcher requirement from a plate's filament entry (the shared 3MF
 * index shape). One builder on purpose: the API's queue add-time inspection and
 * every web dialog flow through it, so a field the contract grows (usedGrams
 * and nozzleId were each silently dropped by hand-built copies) reaches the
 * matcher everywhere at once.
 */
export function queueRequiredFilamentFromPlate(filament: {
  id: number
  filamentType: string | null
  filamentName?: string | null
  color: string | null
  usedGrams?: number | null
  nozzleId?: number | null
}): QueueRequiredFilament {
  return {
    id: filament.id,
    filamentType: filament.filamentType,
    filamentName: filament.filamentName ?? null,
    color: filament.color,
    usedGrams: filament.usedGrams ?? null,
    nozzleId: filament.nozzleId ?? null
  }
}

/**
 * A concrete slicer-slot -> AMS-tray mapping (indexed by `filament.id - 1`; `-1` = unmapped).
 *
 * Shares `amsMappingEntrySchema` with the print-dispatch payloads rather than restating a bare
 * integer array: a queued mapping is dispatched through the same command builder, so the two
 * boundaries validating different things is how they came to disagree about `-1` at all. This
 * is the tighter of the two former rules, so it now rejects out-of-band tray indices the queue
 * used to forward to a printer unchecked.
 */
export const queueAmsMappingSchema = z.array(amsMappingEntrySchema)

const queueLabelSchema = z.string().trim().max(120).nullish()

/**
 * Links a queued item back to the order print it was queued for. When present, the
 * orders plugin mirrors the queue lifecycle onto the order print (queued → started →
 * awaiting-confirmation) so dispatching from the queue advances the order.
 */
export const queueOrderLinkSchema = z.object({
  orderId: z.string().min(1),
  orderPrintId: z.string().min(1)
})
export type QueueOrderLink = z.infer<typeof queueOrderLinkSchema>

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
  label: queueLabelSchema,
  /** When set, link this item to an order print so the queue advances the order. */
  orderLink: queueOrderLinkSchema.optional()
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
  /** Hold (`held`) or resume (`queued`) only: lifecycle states are server-managed. */
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
   * dispatch uses these slots verbatim and skips the automatic material match, the user has chosen the
   * slots themselves, so it requires an explicit `printerId`. The placement (target/model/online/idle)
   * is still validated.
   */
  amsMapping: queueAmsMappingSchema.optional(),
  /**
   * When true, run every pre-flight check a real Start runs (file resolved + readable on the bridge,
   * printer connected, print guards, plate/filament compatibility) and report what *would* happen,
   * WITHOUT uploading or starting: the "Check" / dry-run action. Returns a {@link QueueDryRunResult}.
   */
  dryRun: z.boolean().optional(),
  /**
   * Consent to start when a mapped slot will run out (see `print-filament-sufficiency.ts`).
   * Only this route carries it, because only this route is a person pressing Start: the
   * unattended sweep over idle printers allows the shortfall unconditionally, since there is
   * nobody there to answer and a stalled queue is worse than a print that pauses when dry.
   */
  allowInsufficientFilament: z.boolean().optional(),
  /**
   * Consent to start with a material Bambu forbids on this hardware (see `filament-blacklist.ts`).
   * Carried for the same reason as the flag above, and NOT set by the unattended sweep: a
   * shortfall makes a print pause, whereas an abrasive through the wrong nozzle damages the
   * printer, so an unattended queue must refuse it rather than assume consent.
   */
  allowBlacklistedFilament: z.boolean().optional()
}).refine((value) => !value.amsMapping || !!value.printerId, {
  message: 'Choose a printer when overriding the AMS slots'
})
export type QueueDispatchInput = z.infer<typeof queueDispatchSchema>

/** Result of a dry-run dispatch ("Check"): whether a real Start would succeed and, if not, why. */
export const queueDryRunResultSchema = z.object({
  ok: z.boolean(),
  reason: z.string().nullable(),
  /**
   * Something a real Start would ASK about rather than fail on: a low-filament slot, which
   * a person confirms in the start dialog and the unattended sweep waives outright.
   *
   * Separate from `reason` because the two mean opposite things to the reader. Reporting an
   * overridable guard as a failure told people a print would not start when both real paths
   * start it; dropping it entirely made "Check" quietly the one surface that would not
   * mention the thing they most wanted checked.
   */
  warning: z.string().nullable(),
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
  /** Order print this item was queued for (the orders plugin), or null for a standalone item. */
  orderId: z.string().nullable(),
  orderPrintId: z.string().nullable(),
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
