/**
 * Adapts a live `PrinterStatus` into filament-blacklist queries, one per loaded slot.
 *
 * OWNS the translation from "what this printer is reporting" to "what the rules key on": which
 * material a tray holds, which extruder it feeds, and what nozzle is on that extruder. The rules
 * themselves live in `filament-blacklist.ts`, which stays free of `PrinterStatus` so it can be
 * tested from plain values.
 *
 * CONTRACT: this is the ONLY adapter. The print dialogs and the dispatch guard both call
 * `checkPrinterFilamentBlacklist`, so a print cannot be refused over a nozzle reading the dialog
 * graded differently. Slot LABELS are deliberately not produced here and are injected by the
 * caller instead, following `lowFilamentIssueSentence`: the API names a tray "AMS A Slot 2" and the
 * web derives its label from the same tray groups its picker draws, and neither should have to
 * adopt the other's wording to use this.
 *
 * The material identity comes from `resolveFilamentIdentity`, not from the tray fields directly,
 * because a raw Bambu preset ID does not prove the physical vendor. Explicit PrintStream
 * identity takes precedence, including a user-declared vendor; RFID remains the raw-data gate. Reading `trayInfoIdx` here and calling it Bambu would brand any tray whose
 * preset id merely looks Bambu-shaped, which is exactly what the resolver exists to prevent.
 */
import { amsTrayIndex, amsUnitLetter } from './ams-tray-index.js'
import { isFilamentTrackSwitchInstalled, effectiveAmsNozzleId } from './filament-track-switch.js'
import { resolveFilamentIdentity } from './filament-identity.js'
import {
  checkFilamentBlacklist,
  isExternalSpoolTrayIndex,
  type FilamentBlacklistFinding,
  type FilamentBlacklistQuery
} from './filament-blacklist.js'
import { knownSlotMaterialType } from './slot-material-compatibility.js'
import type { SlotMaterialIdentity } from './slot-material.js'
import type { PrinterStatus } from './printer-contracts.js'

/** A tray, the rules that fired on it, and enough to say which tray it was. */
export interface FilamentBlacklistSlotFindings {
  /** Bambu global tray index (see `amsTrayIndex`); 254/255 are the external spools. */
  trayIndex: number
  /** The plate filament this tray was mapped to, 1-based, or null for a standalone slot check. */
  plateFilamentId: number | null
  /** A short fallback label ("AMS A Slot 2"), for a caller with no labeller of its own. */
  fallbackLabel: string
  findings: FilamentBlacklistFinding[]
}

interface SlotDescriptor {
  trayIndex: number
  fallbackLabel: string
  filamentType: string | null
  trayName: string | null
  trayInfoIdx: string | null
  trayUuid: string | null
  color: string | null
  colors: readonly string[]
  occupied: boolean
  materialIdentity?: SlotMaterialIdentity | null
  nozzleId: number | null
}

function externalSpoolLabel(amsId: number, spoolCount: number): string {
  if (spoolCount > 1) return amsId === 255 ? 'Ext-R' : 'Ext-L'
  return 'Ext'
}

/**
 * Every physical tray the printer reports, flattened.
 *
 * Re-derives each AMS unit's nozzle binding through `effectiveAmsNozzleId` rather than trusting
 * `unit.nozzleId`, for the reason that helper exists: a unit behind a Filament Track Switch reaches
 * both extruders, and a stale binding would pin its material to one nozzle and pick the wrong
 * nozzle's diameter to grade against.
 */
function describeSlots(status: PrinterStatus): SlotDescriptor[] {
  const slots: SlotDescriptor[] = []
  for (const unit of status.ams) {
    const unitNozzleId = effectiveAmsNozzleId(unit)
    for (const slot of unit.slots) {
      slots.push({
        trayIndex: amsTrayIndex(unit.type, unit.unitId, slot.slot),
        fallbackLabel: `AMS ${amsUnitLetter(unit.unitId)} Slot ${slot.slot + 1}`,
        materialIdentity: slot.materialIdentity,
        filamentType: slot.filamentType,
        trayName: slot.trayName,
        trayInfoIdx: slot.trayInfoIdx,
        trayUuid: slot.trayUuid,
        color: slot.color,
        colors: slot.colors ?? [],
        occupied: slot.occupied ?? slot.filamentType != null,
        nozzleId: unitNozzleId
      })
    }
  }
  for (const spool of status.externalSpools) {
    slots.push({
      trayIndex: spool.amsId,
      fallbackLabel: externalSpoolLabel(spool.amsId, status.externalSpools.length),
      materialIdentity: spool.materialIdentity,
      filamentType: spool.filamentType,
      trayName: spool.trayName,
      trayInfoIdx: spool.trayInfoIdx,
      trayUuid: spool.trayUuid,
      color: spool.color,
      colors: spool.colors ?? [],
      occupied: spool.filamentType != null,
      nozzleId: spool.nozzleId
    })
  }
  return slots
}

/**
 * The nozzle fitted to the extruder a tray feeds.
 *
 * Falls back to the sole nozzle on a single-extruder machine when the tray reports no binding,
 * which is the common case: only dual-nozzle machines populate `nozzleId`, and refusing to grade a
 * P1S because its AMS does not name an extruder would make the hardware rules dead on every
 * single-nozzle printer.
 */
function nozzleForSlot(status: PrinterStatus, nozzleId: number | null) {
  if (nozzleId != null) {
    const match = status.nozzles.find((nozzle) => nozzle.extruderId === nozzleId)
    if (match) return match
  }
  return status.nozzles.length === 1 ? status.nozzles[0] : undefined
}

/** Parse `PrinterNozzle.diameter` (a string, e.g. `"0.4"`) into a number the rules can compare. */
function parseDiameter(diameter: string | null | undefined): number | null {
  if (!diameter) return null
  const value = Number(diameter)
  return Number.isFinite(value) && value > 0 ? value : null
}

export interface PrinterFilamentBlacklistInput {
  /** Inventory identity by global tray index; explicit manual identity always wins. */
  inventoryIdentities?: ReadonlyMap<number, SlotMaterialIdentity>
  /** Canonical `PrinterModel` key for the target printer. */
  printerModel: string
  status: PrinterStatus | undefined
  /**
   * Positional over the plate's filaments, exactly as `ams_mapping` is: entry `i` is the tray index
   * chosen for filament `i + 1`, and a negative entry means unmapped.
   *
   * REQUIRED in practice: with no mapping nothing is graded. There is deliberately no "check every
   * loaded tray" fallback, because the print dialogs grade exactly the mapped trays, and a guard
   * that graded more would refuse a dispatch over a spool the dialog never mentioned and offered
   * no consent for. A surface that wants to grade one specific slot uses
   * {@link checkFilamentBlacklistForAssignment} instead.
   */
  amsMapping?: readonly number[]
  /**
   * The filament ids the selected plate actually uses. Entries of `amsMapping` outside this set
   * are skipped.
   *
   * This is not an optimisation. `sanitizeTrayMapping` rewrites an UNUSED filament's `-1` to `0`
   * before the request leaves the browser (harmless for every other guard, which index by plate
   * filament id), so without this the API grades tray 0 for a filament the plate does not print
   * and can refuse over a spool the dialog never graded. Absent means "grade every mapped entry",
   * which is right for a caller that already trimmed the mapping to the plate.
   */
  plateFilamentIds?: readonly number[]
  /** `auto_pa` while running automatic pressure-advance calibration; null for an ordinary print. */
  calibMode?: string | null
  /**
   * Plate filament ids that print SUPPORT, so the (currently dormant) support-only rules can grade.
   * Absent means "not known", which correctly keeps those rules inert rather than guessing.
   */
  supportFilamentIds?: readonly number[]
}

/**
 * Run the blacklist over the trays this print will actually use.
 *
 * Only mapped trays are graded, and each result names the plate filament it was mapped to. An
 * empty slot is never graded, because a rule about a material cannot say anything about no
 * material, and neither is a mapped entry for a filament the plate does not use.
 *
 * Returns only trays with at least one finding, so an empty array means "no rule had anything to
 * say" rather than "checked and safe".
 */
export function checkPrinterFilamentBlacklist(
  input: PrinterFilamentBlacklistInput
): FilamentBlacklistSlotFindings[] {
  if (!input.status) return []
  const hasFilamentSwitch = isFilamentTrackSwitchInstalled(input.status)
  const slots = describeSlots(input.status).map((slot) => ({
    ...slot,
    materialIdentity: slot.materialIdentity ?? input.inventoryIdentities?.get(slot.trayIndex)
  }))
  const slotsByTrayIndex = new Map(slots.map((slot) => [slot.trayIndex, slot]))
  const supportIds = new Set(input.supportFilamentIds ?? [])
  const knowsSupportUsage = input.supportFilamentIds != null

  const usedFilamentIds = input.plateFilamentIds ? new Set(input.plateFilamentIds) : null
  const targets: { slot: SlotDescriptor; plateFilamentId: number | null }[] = []
  for (const [index, trayIndex] of (input.amsMapping ?? []).entries()) {
    if (typeof trayIndex !== 'number' || !Number.isInteger(trayIndex) || trayIndex < 0) continue
    const plateFilamentId = index + 1
    if (usedFilamentIds && !usedFilamentIds.has(plateFilamentId)) continue
    const slot = slotsByTrayIndex.get(trayIndex)
    if (!slot) continue
    targets.push({ slot, plateFilamentId })
  }

  const results: FilamentBlacklistSlotFindings[] = []
  for (const { slot, plateFilamentId } of targets) {
    if (!slot.occupied) continue
    const findings = checkFilamentBlacklist(buildQuery({
      printerModel: input.printerModel,
      status: input.status,
      slot,
      hasFilamentSwitch,
      calibMode: input.calibMode ?? null,
      usedForSupport: knowsSupportUsage && plateFilamentId != null ? supportIds.has(plateFilamentId) : null
    }))
    if (findings.length === 0) continue
    results.push({
      trayIndex: slot.trayIndex,
      plateFilamentId,
      fallbackLabel: slot.fallbackLabel,
      findings
    })
  }
  return results
}

/**
 * Grade a filament a user is ABOUT to assign to a slot, rather than one already loaded.
 *
 * BambuStudio's second call site (`AMSMaterialsSetting::on_select_ok`): the point of assignment is
 * the earliest moment anyone can be told that TPU does not belong in an AMS, and it is far better
 * than finding out at print time.
 *
 * The slot supplies the HARDWARE context (which extruder it feeds, therefore which nozzle) while
 * the caller supplies the MATERIAL, because the material is exactly what has not been committed
 * yet. Returns an empty array for a slot the printer does not report.
 */
export function checkFilamentBlacklistForAssignment(input: {
  printerModel: string
  status: PrinterStatus | undefined
  /** The unit and slot being edited, as `AmsUnit.unitId` / `AmsSlot.slot`. */
  amsId: number
  slotId: number
  /** The material about to be assigned. */
  filamentType: string | null
  /** Bambu preset id about to be assigned, e.g. `GFU04`; empty or null when unknown. */
  filamentId: string | null
  filamentName?: string | null
  filamentVendor?: string | null
  /** PrintStream identity wins over the selected compatibility preset. */
  materialIdentity?: SlotMaterialIdentity | null
}): FilamentBlacklistFinding[] {
  if (!input.status) return []
  const unit = input.status.ams.find((entry) => entry.unitId === input.amsId)
  if (!unit) return []
  const trayIndex = amsTrayIndex(unit.type, unit.unitId, input.slotId)
  const nozzle = nozzleForSlot(input.status, effectiveAmsNozzleId(unit))

  return checkFilamentBlacklist({
    printerModel: input.printerModel,
    ...blacklistMaterialFields(input),
    nozzleFlow: nozzle?.flow ?? null,
    nozzleDiameter: parseDiameter(nozzle?.diameter),
    extruderId: effectiveAmsNozzleId(unit),
    externalSpool: isExternalSpoolTrayIndex(trayIndex),
    hasFilamentSwitch: isFilamentTrackSwitchInstalled(input.status),
    // Assigning a spool is not a calibration, and says nothing about what will be printed with it.
    calibMode: null,
    usedForSupport: null,
    usedForObject: null
  })
}

function buildQuery(input: {
  printerModel: string
  status: PrinterStatus
  slot: SlotDescriptor
  hasFilamentSwitch: boolean
  calibMode: string | null
  usedForSupport: boolean | null
}): FilamentBlacklistQuery {
  const { slot } = input
  const identity = resolveFilamentIdentity({
    color: slot.color,
    colors: slot.colors,
    trayName: slot.trayName,
    trayInfoIdx: slot.trayInfoIdx,
    filamentType: slot.filamentType,
    trayUuid: slot.trayUuid
  })
  const nozzle = nozzleForSlot(input.status, slot.nozzleId)

  return {
    printerModel: input.printerModel,
    ...blacklistMaterialFields({
      materialIdentity: slot.materialIdentity,
      filamentId: slot.trayInfoIdx,
      filamentType: identity.type ?? slot.filamentType,
      filamentName: identity.presetName ?? slot.trayName,
      filamentVendor: identity.brand
    }),
    nozzleFlow: nozzle?.flow ?? null,
    nozzleDiameter: parseDiameter(nozzle?.diameter),
    extruderId: slot.nozzleId,
    externalSpool: isExternalSpoolTrayIndex(slot.trayIndex),
    hasFilamentSwitch: input.hasFilamentSwitch,
    calibMode: input.calibMode,
    usedForSupport: input.usedForSupport,
    // Object usage is not derivable from anything we parse: a plate's filament list does not say
    // which entries draw geometry as opposed to support alone. Null keeps the rules that ask
    // correctly inert; none ship today.
    usedForObject: null
  }
}

/**
 * Draft and live checks use physical identity, never the compatibility preset's claimed brand.
 * A preset ID used solely for compatibility must not grant a material-specific whitelist exemption.
 * Unclassified physical names retain the hardware type's safety checks rather than disabling them.
 */
function blacklistMaterialFields(input: {
  materialIdentity?: SlotMaterialIdentity | null
  filamentId: string | null
  filamentType: string | null
  filamentName?: string | null
  filamentVendor?: string | null
}): Pick<FilamentBlacklistQuery, 'filamentId' | 'filamentType' | 'filamentName' | 'filamentVendor'> {
  const physical = input.materialIdentity
  if (!physical) {
    return {
      filamentId: input.filamentId || null,
      filamentType: input.filamentType,
      filamentName: input.filamentName ?? null,
      filamentVendor: input.filamentVendor ?? null
    }
  }

  // Rule names use "Bambu", while vendor comparisons also accept "Bambu Lab".
  const brand = physical.brand?.trim().replace(/^bambu lab$/i, 'Bambu') ?? null
  const product = physical.materialSubtype?.trim() || physical.filamentType.trim()
  const name = brand && !product.toLowerCase().startsWith(`${brand.toLowerCase()} `)
    ? `${brand} ${product}` : product
  return {
    filamentId: null,
    filamentType: knownSlotMaterialType(physical.filamentType) ?? input.filamentType,
    filamentName: name,
    filamentVendor: physical.brand
  }
}
