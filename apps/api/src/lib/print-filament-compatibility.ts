/**
 * Library-print compatibility guard.
 *
 * Compares the sliced filament requirements for a selected 3MF plate with
 * the trays the user mapped in the print dialog. The API uses this as a
 * final safety net so stale browser state or third-party clients cannot
 * silently dispatch obvious material mismatches.
 */
import {
  amsTrayIndex,
  amsUnitLetter,
  blacklistProhibitions,
  buildRequiredNozzleDiametersByExtruder,
  checkPrinterFilamentBlacklist,
  filamentBlacklistRefusalMessage,
  findFilamentCompatibilityIssues,
  filamentTrackSwitchMismatch,
  filamentTrackSwitchMismatchMessage,
  findLowFilamentSlots,
  findNozzleDiameterCompatibilityIssues,
  formatNozzleDiameterLabel,
  formatNozzleLabel,
  loadedSlotsFromStatus,
  trayIndexToAmsSlot,
  lowFilamentIssueSentence,
  queueRequiredFilamentFromPlate,
  resolvePrinterNozzleDiameters,
  isPlateTypeCompatible,
  isPrinterModelCompatible,
  trayCanSatisfyRequirement,
  type FilamentCompatibilityIssue,
  type PrinterNozzleDiameterSelection,
  type PrinterModel,
  type PrinterStatus
} from '@printstream/shared'
import { conflict, HttpError } from './http-error.js'
import { slotFilamentResolvers } from './slot-filament-registry.js'
import type { ThreeMfIndex } from './three-mf.js'

/**
 * The low-filament refusal, as its own type.
 *
 * Named so a caller that is REPORTING rather than starting (the queue's "Check" dry run) can tell
 * this apart from a genuine blocker and downgrade it to an advisory. It is the one guard here that
 * a person is routinely offered as a confirmation, so "would fail" is the wrong word for it, while
 * saying nothing makes the check silent about the thing it was pressed for.
 *
 * Same status and message as any other conflict; only the name is new.
 */
export class InsufficientFilamentError extends HttpError {
  constructor(message: string) {
    super(409, message)
    this.name = 'InsufficientFilamentError'
  }
}

interface LibraryPrintCompatibilityIndexInput {
  /** Required so the low-filament guard can read the same tracked grams the dialog graded with. */
  workspaceId: string
  printerId: string
  plate: number
  printerModel: PrinterModel
  printerStatus: PrinterStatus | undefined
  amsMapping?: number[]
  allowIncompatibleFilament?: boolean
  allowPlateTypeMismatch?: boolean
  allowFilamentTrackSwitchMismatch?: boolean
  allowInsufficientFilament?: boolean
  allowBlacklistedFilament?: boolean
  currentPlateType?: string | null
  currentNozzleDiameters?: PrinterNozzleDiameterSelection[]
}

interface AutomaticPrintCompatibilityInput {
  /** Required so the low-filament guard can read the same tracked grams the dialog graded with. */
  workspaceId: string
  printerId: string
  index: ThreeMfIndex | null
  plate: number
  printerModel: PrinterModel
  printerStatus: PrinterStatus | undefined
  useAms: boolean
  amsMapping?: number[]
  allowIncompatibleFilament?: boolean
  allowFilamentTrackSwitchMismatch?: boolean
  allowInsufficientFilament?: boolean
  allowBlacklistedFilament?: boolean
}

interface AutomaticCompatibilityIssue {
  filamentId: number
  filamentType: string | null
  filamentName: string | null
  nozzleId: number | null
}

export async function assertLibraryPrintCompatibilityForIndex(
  index: ThreeMfIndex,
  input: LibraryPrintCompatibilityIndexInput
): Promise<void> {
  assertCompatiblePrinterModel(index.compatiblePrinterModels, input.printerModel)
  assertPrinterHardwareCompatibility(index, input)
  // Before the `allowIncompatibleFilament` early return, for the same reason the Track Switch
  // check is: that flag consents to WHICH materials the trays hold, and "enough of it is left"
  // is a separate judgement the dialog asks separately.
  await assertSufficientFilament(index, input)
  assertFilamentBlacklist(index, input)
  const issues = getLibraryPrintCompatibilityIssues(index, input)
  // Nozzle-mismatch issues are overridable too: the tray→nozzle binding comes
  // from status parsing that can be wrong (H2D AMS/nozzle parsing is unverified
  // against live hardware), so a confirmed `allowIncompatibleFilament` must be
  // able to dispatch a physically-correct setup the parser misreads.
  if (input.allowIncompatibleFilament || issues.length === 0) return
  throw conflict(formatCompatibilityMessage(issues))
}

export async function assertAutomaticPrintCompatibility(
  input: AutomaticPrintCompatibilityInput
): Promise<void> {
  assertCompatiblePrinterModel(input.index?.compatiblePrinterModels ?? [], input.printerModel)
  // Printing a .3mf already sitting on the printer's storage still has to agree with the machine
  // about the switch: BambuStudio checks its SD-card path the same way (`slicing_with_fila_switch`
  // reads the plate data under `FROM_SDCARD_VIEW`). Skipped when there is no index to read it from.
  //
  // BEFORE the `allowIncompatibleFilament` early return, not after: that flag consents to the TRAY
  // assignments, and letting it also wave through "sliced for a different class of machine" would
  // make one checkbox grant two unrelated permissions.
  if (input.index) assertFilamentTrackSwitchMatch(input.index, input)
  if (input.index) await assertSufficientFilament(input.index, input)
  // Runs with or without an index: the rules grade the MATERIAL IN THE TRAY against the machine,
  // so they have something to say even when we cannot read what the file wants.
  assertFilamentBlacklist(input.index, input)
  if (input.allowIncompatibleFilament) return
  const issues = getAutomaticPrintCompatibilityIssues(input)
  if (issues.length === 0) return
  throw conflict(formatAutomaticCompatibilityMessage(issues))
}

function getLibraryPrintCompatibilityIssues(
  index: ThreeMfIndex,
  input: LibraryPrintCompatibilityIndexInput
): FilamentCompatibilityIssue[] {
  if (!input.printerStatus || !input.amsMapping || input.amsMapping.length === 0) return []

  const plate = index.plates.find((entry) => entry.index === input.plate) ?? index.plates[0]
  if (!plate) return []

  const trayByMappingValue = buildTrayLookup(input.printerStatus)
  const selectedTrays = new Map<number, { filamentType: string | null; label: string; nozzleId: number | null }>()
  for (const filament of plate.filaments) {
    const mappingValue = input.amsMapping[filament.id - 1]
    if (typeof mappingValue !== 'number' || !Number.isInteger(mappingValue) || mappingValue < 0) continue
    const tray = trayByMappingValue.get(mappingValue)
    if (!tray) continue
    selectedTrays.set(filament.id, tray)
  }

  return findFilamentCompatibilityIssues(
    plate.filaments.map((filament) => ({
      filamentId: filament.id,
      filamentType: filament.filamentType,
      filamentName: filament.filamentName,
      nozzleId: filament.nozzleId
    })),
    selectedTrays
  )
}

function assertPrinterHardwareCompatibility(
  index: ThreeMfIndex,
  input: LibraryPrintCompatibilityIndexInput
): void {
  const plate = index.plates.find((entry) => entry.index === input.plate) ?? index.plates[0]
  if (!plate) return

  assertFilamentTrackSwitchMatch(index, input)

  if (plate.plateType && !input.allowPlateTypeMismatch) {
    if (!input.currentPlateType) {
      throw conflict(`This plate was sliced for ${plate.plateType}. Choose the printer's current plate type or confirm the mismatch in the print dialog.`)
    }
    if (!isPlateTypeCompatible(plate.plateType, input.currentPlateType)) {
      throw conflict(`This plate was sliced for ${plate.plateType}, but the current printer plate is ${input.currentPlateType}. Confirm the mismatch in the print dialog to continue.`)
    }
  }

  const requiredNozzleDiameters = buildRequiredNozzleDiametersByExtruder(plate.filaments, plate.nozzleSizes)
  if (requiredNozzleDiameters.size === 0) return
  const effectiveNozzleDiameters = resolvePrinterNozzleDiameters(input.printerStatus, input.currentNozzleDiameters)

  // An undetected/unset diameter is "unknown", not "incompatible": the status
  // parser can fail to populate an extruder's diameter (seen on H2D), and
  // refusing a valid print because *we* could not detect the nozzle is the
  // wrong default. Only a positively conflicting diameter blocks dispatch;
  // the web dialog still warns on unknowns so the user can fix the setting.
  const issues = findNozzleDiameterCompatibilityIssues(requiredNozzleDiameters, effectiveNozzleDiameters)
    .filter((issue) => issue.selectedDiameter !== null)
  if (issues.length === 0) return

  const details = issues.map((issue) => {
    const nozzleLabel = formatNozzleLabel(issue.extruderId, 'long') ?? 'required nozzle'
    const requiredDiameter = formatNozzleDiameterLabel(issue.requiredDiameter) ?? issue.requiredDiameter
    const selectedDiameter = formatNozzleDiameterLabel(issue.selectedDiameter) ?? issue.selectedDiameter
    return `${nozzleLabel}: sliced for ${requiredDiameter}, printer is set to ${selectedDiameter}`
  })
  throw conflict(`Installed nozzle size does not match the sliced file. ${details.join(' | ')}.`)
}

/**
 * A file sliced for a Filament Track Switch machine should print on one, and vice versa: the two
 * cases group filaments across the extruders differently and the baked tool changes assume one.
 *
 * OVERRIDABLE via `allowFilamentTrackSwitchMismatch`, which is a deliberate divergence from
 * BambuStudio. Studio refuses this outright, but only when the printer sets
 * `is_support_check_track_switch_match_slice_printer`, a capability flag we do not parse and
 * cannot verify without FTS firmware. Without it, a hard block would make every file sliced before
 * a switch was fitted un-printable on that machine, all at once, with re-slicing the only way out.
 * So we surface it and let the user proceed, the same posture as the tray/nozzle checks.
 *
 * The override is its OWN flag rather than `allowIncompatibleFilament`: that one means "the trays I
 * picked are right", which is not the same judgement as "this file was sliced for a different
 * machine and I accept that". The dialogs ask the two questions separately.
 *
 * What counts as a mismatch is decided by the shared `filamentTrackSwitchMismatch`, the same
 * function the print dialogs warn from, so a dispatch can never be refused by a check the dialog
 * never showed.
 */
function assertFilamentTrackSwitchMatch(
  index: ThreeMfIndex,
  input: Pick<LibraryPrintCompatibilityIndexInput, 'printerStatus' | 'allowFilamentTrackSwitchMismatch'>
): void {
  if (input.allowFilamentTrackSwitchMismatch) return
  const mismatch = filamentTrackSwitchMismatch(index.slicedWithFilamentTrackSwitch, input.printerStatus)
  if (!mismatch) return
  throw conflict(filamentTrackSwitchMismatchMessage(mismatch.printerHasSwitch))
}

/**
 * A material Bambu forbids on this hardware. OVERRIDABLE via `allowBlacklistedFilament`.
 *
 * These are the rules BambuStudio keeps in `filaments_blacklist.json` and runs both on AMS slot
 * confirm and in its pre-print gauntlet: TPU through an AMS, abrasives through an E3D high-flow
 * nozzle, Bambu PET-CF in an AMS, and so on. They protect the PRINTER rather than the print, which
 * is why they are checked separately from everything above and consented to separately.
 *
 * Only PROHIBITIONS reach here. The rule set is two-severity and its warnings ("cold pull before
 * printing TPU") are advice with nothing to refuse: the dialog shows them, dispatch ignores them.
 * Refusing on a warning would ground a large fraction of ordinary TPU and CF prints.
 *
 * BambuStudio blocks a prohibition outright with no override. We diverge, deliberately, for the
 * reason recorded on the flag: half the rules key on nozzle flow and diameter that we decode from
 * a type code, and that decode is unverified against some live hardware. A misread nozzle would
 * make a physically-correct setup un-printable with re-slicing no help at all. Same posture as the
 * tray, plate and Track Switch checks above.
 *
 * What counts as prohibited comes from the shared `checkPrinterFilamentBlacklist`, and each
 * sentence from the shared rule text, the same two the print dialogs warn from, so a dispatch can
 * never be refused by a check the dialog never showed.
 */
function assertFilamentBlacklist(
  index: ThreeMfIndex | null,
  input: Pick<
    LibraryPrintCompatibilityIndexInput,
    'plate' | 'printerModel' | 'printerStatus' | 'amsMapping' | 'allowBlacklistedFilament'
  >
): void {
  if (input.allowBlacklistedFilament || !input.printerStatus) return
  // No mapping means nothing to grade. The dialogs grade the trays they mapped, so an unmapped
  // dispatch (an override-less history re-print, a calibration pinned to the external spool) must
  // not be refused over whatever else happens to be loaded.
  if (!input.amsMapping || input.amsMapping.length === 0) return
  const plate = index?.plates.find((entry) => entry.index === input.plate)
  const entries = checkPrinterFilamentBlacklist({
    printerModel: input.printerModel,
    status: input.printerStatus,
    amsMapping: input.amsMapping,
    plateFilamentIds: plate?.filaments.map((filament) => filament.id),
    supportFilamentIds: index?.supportFilamentIds
  }).filter((entry) => blacklistProhibitions(entry.findings).length > 0)
  if (entries.length === 0) return

  const trays = buildTrayLookup(input.printerStatus)
  throw conflict(filamentBlacklistRefusalMessage(entries.map((entry) => ({
    slotLabel: trays.get(entry.trayIndex)?.label ?? entry.fallbackLabel,
    findings: entry.findings
  }))))
}

/**
 * A print whose mapped slots run out mid-job. OVERRIDABLE via `allowInsufficientFilament`.
 *
 * Overridable and not a hard block because every input is an estimate: the printer reports a
 * percent, only for RFID spools, against an assumed 1kg reel. Refusing outright would ground
 * prints that are perfectly fine, to prevent something the printer already handles by pausing.
 *
 * What counts as too little comes from the shared `findLowFilamentSlots`, and each sentence from
 * the shared `lowFilamentIssueSentence`, the same two the print dialog warns from, so a dispatch
 * can never be refused by a check the dialog never showed.
 *
 * Holding that promise means grading the SAME NUMBERS, not merely running the same function. The
 * browser attaches filament-manager's tracked grams to each slot before grading, and
 * `knownRemainGrams` REPLACES the printer's percent estimate with them rather than taking the
 * lower of the two, so a tray the printer calls half empty can genuinely hold plenty (a 5kg
 * spool, or a hand-weighed figure on a manually tracked one). Grading without those grams was
 * therefore not a subset of the dialog's signals but a different, sometimes STRICTER answer, and
 * it refused prints whose dialog raised no warning and offered no confirmation to tick.
 *
 * So the tracked figure is read back through the plugin seam before refusing. Only for trays this
 * is about to reject: the resolver is a per-slot database read, and a print with nothing flagged
 * must not pay for it.
 */
async function assertSufficientFilament(
  index: ThreeMfIndex,
  input: Pick<
    LibraryPrintCompatibilityIndexInput,
    'plate' | 'printerStatus' | 'amsMapping' | 'allowInsufficientFilament' | 'workspaceId' | 'printerId'
  >
): Promise<void> {
  if (input.allowInsufficientFilament || !input.printerStatus) return
  // No fallback to plate 1: grading a plate the caller did not ask about refuses the
  // print over filament the dialog never showed.
  const plate = index.plates.find((entry) => entry.index === input.plate)
  if (!plate) return

  const required = plate.filaments.map(queueRequiredFilamentFromPlate)
  const autoRefillEnabled = input.printerStatus.amsSettings?.autoRefill === true
  const slots = loadedSlotsFromStatus(input.printerStatus)
  const issues = findLowFilamentSlots({ required, slots, amsMapping: input.amsMapping, autoRefillEnabled })
  if (issues.length === 0) return

  const tracked = await loadTrackedSlotGrams(input.workspaceId, input.printerId, issues.map((issue) => issue.trayIndex))
  if (tracked.size > 0) {
    const regraded = findLowFilamentSlots({
      required,
      slots: slots.map((slot) => tracked.has(slot.trayIndex)
        ? { ...slot, remainingGrams: tracked.get(slot.trayIndex) }
        : slot),
      amsMapping: input.amsMapping,
      autoRefillEnabled
    })
    if (regraded.length === 0) return
    issues.splice(0, issues.length, ...regraded)
  }

  const trays = buildTrayLookup(input.printerStatus)
  const details = issues.map((issue) =>
    lowFilamentIssueSentence(issue, trays.get(issue.trayIndex)?.label ?? 'The selected tray'))
  throw new InsufficientFilamentError(
    `Not enough filament loaded for this print. ${details.join(' ')}`
    + ' Load more filament or confirm the low-filament print in the dialog.'
  )
}

/**
 * Tracked grams for the given tray indexes, from whichever plugin owns spool inventory.
 *
 * Best-effort by design: with no resolver registered (filament-manager absent or disabled)
 * the map is empty and grading falls back to the printer's percent, which is exactly what
 * the browser does in the same situation.
 */
async function loadTrackedSlotGrams(
  workspaceId: string,
  printerId: string,
  trayIndexes: readonly number[]
): Promise<Map<number, number>> {
  const tracked = new Map<number, number>()
  if (slotFilamentResolvers.size() === 0) return tracked

  for (const trayIndex of new Set(trayIndexes)) {
    const ref = trayIndexToAmsSlot(trayIndex)
    if (!ref) continue
    const identity = await slotFilamentResolvers.resolve({ workspaceId, printerId, amsId: ref.amsId, slotId: ref.slotId })
    if (identity?.remainingGrams != null) tracked.set(trayIndex, identity.remainingGrams)
  }
  return tracked
}

function buildTrayLookup(status: PrinterStatus): Map<number, { filamentType: string | null; label: string; nozzleId: number | null }> {
  const trays = new Map<number, { filamentType: string | null; label: string; nozzleId: number | null }>()

  for (const spool of status.externalSpools) {
    trays.set(spool.amsId, {
      filamentType: spool.filamentType,
      label: externalSpoolLabel(spool.amsId, status.externalSpools.length),
      nozzleId: spool.nozzleId
    })
  }

  for (const unit of status.ams) {
    for (const slot of unit.slots) {
      trays.set(amsTrayIndex(unit.type, unit.unitId, slot.slot), {
        filamentType: slot.filamentType,
        label: `AMS ${amsUnitLetter(unit.unitId)} Slot ${slot.slot + 1}`,
        nozzleId: unit.nozzleId
      })
    }
  }

  return trays
}

function getAutomaticPrintCompatibilityIssues(
  input: AutomaticPrintCompatibilityInput
): AutomaticCompatibilityIssue[] {
  if (!input.index || !input.printerStatus) return []
  const plate = input.index.plates.find((entry) => entry.index === input.plate) ?? input.index.plates[0]
  if (!plate) return []

  const trayLookup = buildTrayLookup(input.printerStatus)
  const selectedTrays = new Map<number, { filamentType: string | null; label: string; nozzleId: number | null }>()

  if (input.amsMapping && input.amsMapping.length > 0) {
    for (const filament of plate.filaments) {
      const mappingValue = input.amsMapping[filament.id - 1]
      if (typeof mappingValue !== 'number' || !Number.isInteger(mappingValue) || mappingValue < 0) continue
      const tray = trayLookup.get(mappingValue)
      if (!tray) continue
      selectedTrays.set(filament.id, tray)
    }

    return findFilamentCompatibilityIssues(
      plate.filaments.map((filament) => ({
        filamentId: filament.id,
        filamentType: filament.filamentType,
        filamentName: filament.filamentName,
        nozzleId: filament.nozzleId
      })),
      selectedTrays
    ).map((issue) => ({
      filamentId: issue.filamentId,
      filamentType: issue.requiredFilamentType,
      filamentName: issue.requiredFilamentName,
      nozzleId: issue.nozzleId
    }))
  }

  const trays = Array.from(trayLookup.values()).filter((tray) =>
    input.useAms ? true : tray.label.startsWith('Ext')
  )

  return plate.filaments
    .filter((filament) => !trays.some((tray) => trayCanSatisfyRequirement({
      filamentId: filament.id,
      filamentType: filament.filamentType,
      filamentName: filament.filamentName,
      nozzleId: filament.nozzleId
    }, tray)))
    .map((filament) => ({
      filamentId: filament.id,
      filamentType: filament.filamentType,
      filamentName: filament.filamentName,
      nozzleId: filament.nozzleId
    }))
}

function formatCompatibilityMessage(issues: FilamentCompatibilityIssue[]): string {
  const details = issues.map((issue) => {
    const subject = issue.requiredFilamentName
      ?? issue.requiredFilamentType
      ?? `Filament #${issue.filamentId}`
    const trayLabel = issue.trayLabel ?? 'selected tray'
    const parts: string[] = []

    if (issue.typeMismatch) {
      parts.push(
        `needs ${issue.requiredFilamentType ?? 'the sliced material'} but ${trayLabel} is loaded with ${issue.selectedFilamentType ?? 'an unknown material'}`
      )
    }

    if (issue.nozzleMismatch) {
      parts.push(
        `${trayLabel} feeds the ${formatNozzleLabel(issue.trayNozzleId, 'long') ?? 'wrong nozzle'}, but this filament is assigned to the ${formatNozzleLabel(issue.nozzleId, 'long') ?? 'other nozzle'}`
      )
    }

    return `${subject}: ${parts.join('; ')}`
  })

  return `Selected tray assignments are incompatible with the sliced file. ${details.join(' | ')}. Review the mapping or confirm the incompatible print in the dialog.`
}

function formatAutomaticCompatibilityMessage(issues: AutomaticCompatibilityIssue[]): string {
  const details = issues.map((issue) => {
    const subject = issue.filamentName
      ?? issue.filamentType
      ?? `Filament #${issue.filamentId}`
    const nozzle = formatNozzleLabel(issue.nozzleId, 'long')
    return nozzle
      ? `${subject}: no compatible loaded tray was found for the ${nozzle}`
      : `${subject}: no compatible loaded tray was found`
  })
  return `No compatible loaded trays were found for the sliced file. ${details.join(' | ')}. Load matching filament or confirm the incompatible print in the dialog.`
}

function assertCompatiblePrinterModel(
  compatibleModels: readonly PrinterModel[],
  printerModel: PrinterModel
): void {
  if (isPrinterModelCompatible(compatibleModels, printerModel)) return
  if (compatibleModels.length === 0) return
  throw conflict(
    `This file is only compatible with ${compatibleModels.join(', ')} and cannot be printed on ${printerModel}.`
  )
}

function externalSpoolLabel(amsId: number, spoolCount: number): string {
  if (spoolCount > 1) return amsId === 255 ? 'Ext-R' : 'Ext-L'
  return 'Ext'
}

