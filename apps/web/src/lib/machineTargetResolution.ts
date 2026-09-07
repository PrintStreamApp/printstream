/**
 * The one place that answers "what machine is this project being prepared for?", engine target,
 * printer, model, machine profile, nozzle, and plate type, from a resolved-inputs snapshot plus
 * the user's explicit picks.
 *
 * OWNS the whole cascade, and owns it as a DERIVATION: nothing here is stored. Before S2 these
 * answers lived in six pieces of state reconciled by nine effects and arbitrated by two "touched"
 * refs, which is why no one could say who had set a value (audit F2). The shape that replaced it:
 *
 *     state   = intent                                   // sparse: only explicit user picks
 *     derived = resolveMachineTarget(snapshot, intent)   // this function
 *
 * CONTRACT for callers:
 * - The only mutable state is {@link MachineTargetIntent}. A field absent from it is derived; a
 *   field present in it is the user's, and is honoured whenever the current inputs can represent
 *   it. Nothing else may write a machine-target value (invariant I1).
 * - `origins` explains where each value came from. It is an OUTPUT, for the "Loading…"
 *   placeholder and for conflict copy, and must never become an input to a guard, or the
 *   pre-S2 arbitration problem grows back.
 * - `conflicts` lists user picks the current inputs cannot represent. They are reported, never
 *   silently swapped (invariant I5, and the E9 fix): the intent KEEPS the requested value, so
 *   switching back to a machine that offers it restores the choice for free.
 * - Resolution is a pure function of its arguments, so callers must key it on a CONTENT signature.
 *   `bakedIndex` and `printers` change identity on every refetch while saying the same thing.
 *
 * Readiness is two flags, and both must count a terminal FAILURE as resolved or the form waits
 * forever on a project index that will never arrive. Until `resolved`, fields answer with the best
 * available value and the model may still be `'unknown'`: see `resolveInitialManualPrinterModel`
 * for why not-knowing is represented rather than guessed.
 *
 * Counterparts: `components/library/useMachineTarget.ts` (the hook that holds the intent),
 * `components/library/SliceFileModal.tsx` and `plugins/model-studio/useLocalSliceSettingsController.ts`
 * (the two hosts). Absorbed `lib/bakedDefaultsSeed.ts`, whose one-shot seed this replaces.
 */
import type {
  LibraryFile,
  Printer,
  PrinterNozzleFlow,
  SlicingPresetSummary,
  SlicingTargetDescriptor,
  ThreeMfIndex
} from '@printstream/shared'
import {
  ensurePrinterModelOptions,
  isMachineProfileCompatible,
  isProcessProfileCompatible,
  matchesPrinterModel,
  matchPlateTypeByLabel,
  namesADifferentPrinterModel,
  pickMachineProfileByName,
  pickMachineProfileForPrinter,
  resolveCompatiblePlateTypes,
  resolveInitialManualPrinterModel,
  resolveProjectPlateType,
  resolveSliceDialogNozzleDiameterOptions,
  resolveSliceDialogTargetPrinterModel
} from './slicingPresetMatching'
import {
  isSelectableOrProjectFallbackSlicingPreset,
  isSelectableSlicingPreset,
  pickSelectableSlicingPresetByName
} from './slicingPresetSelection'

/**
 * Bambu's stock nozzle, and what a project with nothing to say should open on.
 *
 * The options are the union of every source SORTED ASCENDING, so taking the first gave 0.2 for any
 * model that offers one, which is a specialist size nobody starts a project on. This is the last
 * resort only: a project's own nozzle and a selected printer's both outrank it, so a 0.6 project
 * still opens on 0.6.
 */
const STOCK_NOZZLE_DIAMETER = '0.4'

/** The size a fresh target defaults to: the stock one when offered, else the smallest on offer. */
function defaultNozzleDiameter(options: readonly string[]): string {
  return options.includes(STOCK_NOZZLE_DIAMETER) ? STOCK_NOZZLE_DIAMETER : (options[0] ?? '')
}

/** Every explicit user pick in the machine-target domain. Absent = derive it. */
export interface MachineTargetIntent {
  /** A real printer the user chose; `''` clears it back to a manual profile target. */
  printerId?: string
  printerModel?: string
  nozzleDiameter?: string
  nozzleFlow?: PrinterNozzleFlow
  plateType?: string
  /**
   * A machine preset chosen by hand. Honoured only while the current model and nozzle can still
   * offer it, so switching printer does not silently slice with a preset for the old one; the
   * pick is KEPT either way, so switching back restores it (invariant I5).
   */
  printerProfileId?: string
}

export const EMPTY_MACHINE_TARGET_INTENT: MachineTargetIntent = {}

export interface MachineTargetInputs {
  file: LibraryFile
  bakedIndex: ThreeMfIndex | null
  machineProfiles: SlicingPresetSummary[]
  processProfiles: SlicingPresetSummary[]
  /**
   * The project's 3MF index request reached a terminal state: data, an error, or nothing to
   * fetch. NOT "data arrived": a failed index must not strand the form (before S2 that only worked
   * by accident, through a `!platesQuery.data` clause in the readiness flag).
   */
  projectResolved: boolean
  /** The profile catalogue for the current engine target reached a terminal state. */
  catalogueResolved: boolean
  /** Real printers the host can target. Printer-less hosts (the public editor) pass none. */
  printers?: Printer[]
  /** A printer the flow is pinned to (print-prep); overrides the intent's printer. */
  lockedPreferredPrinter?: Printer | null
}

export type MachineTargetField = 'printerModel' | 'nozzleDiameter' | 'plateType' | 'printerProfileId'

/**
 * Where a resolved value came from. `unseeded` means the inputs cannot answer yet: render it as
 * waiting, never as a real answer.
 */
export type MachineTargetOrigin = 'unseeded' | 'user' | 'project' | 'printer' | 'catalogue' | 'default'

/** A user pick the current inputs cannot represent. The intent keeps it; this reports the swap. */
export interface MachineTargetConflict {
  field: 'printerModel' | 'nozzleDiameter' | 'plateType' | 'printerProfileId'
  /** What the user asked for. */
  requested: string
  /** What is in force instead. */
  applied: string
}

export interface MachineTargetResolution {
  targetMode: 'realPrinter' | 'manualProfile'
  printerId: string
  selectedPrinter: Printer | null
  manualPrinterModel: string
  selectedPrinterModel: string
  printerModelOptions: string[]
  printerProfileId: string
  selectedMachineProfile: SlicingPresetSummary | null
  targetPrinterModel: string | null
  nozzleDiameter: string
  nozzleDiameterOptions: string[]
  selectedNozzleDiameters: number[]
  nozzleFlow: PrinterNozzleFlow
  plateType: string
  plateTypeOptions: string[]
  modelCompatibleMachineProfiles: SlicingPresetSummary[]
  compatibleMachineProfiles: SlicingPresetSummary[]
  selectableMachineProfiles: SlicingPresetSummary[]
  printerCompatibleProcessProfiles: SlicingPresetSummary[]
  origins: Record<MachineTargetField, MachineTargetOrigin>
  conflicts: MachineTargetConflict[]
  /** Both async inputs settled: these answers are final for this snapshot. */
  resolved: boolean
}

/**
 * The engine target to slice with: the user's pick while it still exists, else the declared
 * default, else the first STABLE target, else anything.
 *
 * Never falls back onto a prerelease engine: betas are opt-in only (they exist so a project saved
 * by a beta desktop build can be sliced at all). Encoded three times before S2 (two ladders in the
 * workspace host, one in the public host), which is exactly the F6 shape that drifts.
 */
export function resolveSlicerTargetId(
  targets: readonly SlicingTargetDescriptor[],
  defaultTargetId: string | null | undefined,
  intentTargetId: string | undefined
): string {
  if (intentTargetId && targets.some((target) => target.id === intentTargetId)) return intentTargetId
  return defaultTargetId
    ?? targets.find((target) => !target.prerelease)?.id
    ?? targets[0]?.id
    ?? ''
}

/**
 * The nozzle diameter the PROJECT itself was authored for, or null when it says nothing.
 *
 * Deliberately not `resolveSliceDialogNozzleDiameterOptions(...)[0]`, which is what the pre-S2 seed
 * used: that unions every source (including a hardcoded 0.4) and takes the ascending minimum, so a
 * 0.6-nozzle project always opened on 0.4, and then no machine profile matched the 0.4 it had just
 * invented, which the submit gate reported as an incompatible printer profile.
 */
export function resolveProjectNozzleDiameter(file: LibraryFile, bakedIndex: ThreeMfIndex | null): string | null {
  const candidates = [
    ...(bakedIndex?.plates.flatMap((plate) => plate.nozzleSizes) ?? []),
    ...(bakedIndex?.plates.flatMap((plate) => plate.filaments.map((filament) => filament.nozzleDiameter ?? '')) ?? []),
    ...file.nozzleSizeChips
  ]
    .map((entry) => Number.parseFloat(entry))
    .filter((entry) => Number.isFinite(entry) && entry > 0)
  if (candidates.length === 0) return null
  // A dual-nozzle project carries one entry per extruder; the smallest is the one whose presets the
  // process profiles are keyed on, and it is what the pre-S2 seed effectively chose among the
  // project's own values.
  return Math.min(...candidates).toString()
}

export function resolveMachineTarget(inputs: MachineTargetInputs, intent: MachineTargetIntent): MachineTargetResolution {
  const {
    file, bakedIndex, machineProfiles, processProfiles,
    projectResolved, catalogueResolved, printers = [], lockedPreferredPrinter = null
  } = inputs
  const conflicts: MachineTargetConflict[] = []
  const resolved = projectResolved && catalogueResolved

  // 1. Printer. A locked printer wins over the intent: the print-prep flow is pinned to it, and
  //    before S2 that was an effect racing the user's own picker.
  const selectedPrinter = lockedPreferredPrinter
    ?? (intent.printerId ? printers.find((printer) => printer.id === intent.printerId) ?? null : null)
  const targetMode: 'realPrinter' | 'manualProfile' = selectedPrinter ? 'realPrinter' : 'manualProfile'
  const printerId = selectedPrinter?.id ?? ''

  // 2. Model. The user's pick, then the project's own, then, only once BOTH inputs have settled,
  //    so "the project really has no model" and "first available" both mean something, the first
  //    installed machine. Until then it stays 'unknown' rather than showing a machine nobody chose.
  const printerModelOptions = ensurePrinterModelOptions(file.compatiblePrinterModels, selectedPrinter?.model, machineProfiles)
  const projectModel = bakedIndex?.compatiblePrinterModels[0] ?? null
  const fileModel = resolveInitialManualPrinterModel(file)
  let manualPrinterModel = 'unknown'
  let modelOrigin: MachineTargetOrigin = 'unseeded'
  if (intent.printerModel && printerModelOptions.includes(intent.printerModel)) {
    manualPrinterModel = intent.printerModel
    modelOrigin = 'user'
  } else if (projectModel) {
    manualPrinterModel = projectModel
    modelOrigin = 'project'
  } else if (fileModel !== 'unknown') {
    manualPrinterModel = fileModel
    modelOrigin = 'project'
  } else if (resolved && printerModelOptions[0] && printerModelOptions[0] !== 'unknown') {
    manualPrinterModel = printerModelOptions[0]
    modelOrigin = 'catalogue'
  }
  if (intent.printerModel && modelOrigin !== 'user') {
    conflicts.push({ field: 'printerModel', requested: intent.printerModel, applied: manualPrinterModel })
  }
  const selectedPrinterModel = targetMode === 'realPrinter' ? selectedPrinter?.model ?? 'unknown' : manualPrinterModel

  // 3. Nozzle. Its OPTIONS need the model (they come from that model's machine profiles); the
  //    machine profile in step 4 needs the nozzle. That is the one ordering the pre-S2 effects
  //    reached by converging over several renders instead of stating it.
  const modelCompatibleMachineProfiles = machineProfiles.filter((profile) => matchesPrinterModel(profile, selectedPrinterModel))
  const nozzleDiameterOptions = resolveSliceDialogNozzleDiameterOptions(file, selectedPrinter, modelCompatibleMachineProfiles, bakedIndex)
  const projectNozzle = resolveProjectNozzleDiameter(file, bakedIndex)
  const printerNozzle = selectedPrinter?.currentNozzleDiameters
    .map((entry) => Number.parseFloat(entry.diameter ?? ''))
    .filter((entry) => Number.isFinite(entry) && entry > 0)
    .sort((left, right) => left - right)[0]
    ?.toString() ?? null
  let nozzleDiameter = ''
  let nozzleOrigin: MachineTargetOrigin = 'unseeded'
  const offeredNozzle = (value: string | null | undefined): string | null =>
    value && nozzleDiameterOptions.includes(value) ? value : null
  const nozzleFromIntent = offeredNozzle(intent.nozzleDiameter)
  const nozzleFromProject = offeredNozzle(projectNozzle)
  const nozzleFromPrinter = offeredNozzle(printerNozzle)
  if (nozzleFromIntent) { nozzleDiameter = nozzleFromIntent; nozzleOrigin = 'user' }
  else if (nozzleFromProject) { nozzleDiameter = nozzleFromProject; nozzleOrigin = 'project' }
  else if (nozzleFromPrinter) { nozzleDiameter = nozzleFromPrinter; nozzleOrigin = 'printer' }
  else if (nozzleDiameterOptions.length > 0) {
    nozzleDiameter = defaultNozzleDiameter(nozzleDiameterOptions)
    nozzleOrigin = 'default'
  }
  if (intent.nozzleDiameter && nozzleOrigin !== 'user') {
    conflicts.push({ field: 'nozzleDiameter', requested: intent.nozzleDiameter, applied: nozzleDiameter })
  }
  const parsedNozzle = Number.parseFloat(nozzleDiameter)
  const selectedNozzleDiameters = Number.isFinite(parsedNozzle) && parsedNozzle > 0 ? [parsedNozzle] : []

  // 4. Machine profile. Derived unless the user picked one, which they do through
  //    `intent.printerProfileId` rather than a second writer.
  const compatibleMachineProfiles = machineProfiles.filter((profile) => isMachineProfileCompatible(profile, selectedPrinterModel, selectedNozzleDiameters))
  // Exact model for the PICKER. `isMachineProfileCompatible` matches on token boundaries, so an
  // "H2D Pro" preset passes for an "H2D" project (the model is a token of the variant's name) and
  // the picker offered a machine the project is not for. `namesADifferentPrinterModel` compares
  // CANONICAL keys (H2DPRO vs H2D) and answers false when a preset names no model at all, so
  // custom and hand-named presets are never hidden by it.
  //
  // Falls back to the unfiltered list rather than emptying: with no selectable machine there is no
  // target at all, and a catalogue holding only a neighbouring variant should still slice rather
  // than strand the user with an empty picker.
  const selectableForModel = compatibleMachineProfiles.filter(isSelectableSlicingPreset)
  const exactModelMachineProfiles = selectableForModel.filter((profile) => !namesADifferentPrinterModel(profile, selectedPrinterModel))
  const selectableMachineProfiles = exactModelMachineProfiles.length > 0 ? exactModelMachineProfiles : selectableForModel
  const bakedProfileName = bakedIndex?.printerProfileName ?? null
  const printerMatchedProfile = targetMode === 'realPrinter' ? pickMachineProfileForPrinter(selectableMachineProfiles, selectedPrinter) : null
  const bakedMatchedProfile = pickSelectableSlicingPresetByName(selectableMachineProfiles, bakedProfileName)
    ?? pickMachineProfileByName(selectableMachineProfiles, bakedProfileName, projectModel ?? 'unknown')
  // A hand-picked preset outranks every derived source, but only while it is still on offer: the
  // list is filtered by the selected model and nozzle, so a pick made for one printer must not
  // survive onto another. Honouring it here rather than writing it back is what keeps this a
  // derivation (invariant I1).
  const intentMachineProfile = intent.printerProfileId
    ? selectableMachineProfiles.find((profile) => profile.id === intent.printerProfileId) ?? null
    : null
  const pickedMachineProfile = intentMachineProfile ?? printerMatchedProfile ?? bakedMatchedProfile ?? selectableMachineProfiles[0] ?? null
  const printerProfileId = pickedMachineProfile?.id ?? ''
  const machineProfileOrigin: MachineTargetOrigin = intentMachineProfile
    ? 'user'
    : printerMatchedProfile
      ? 'printer'
      : bakedMatchedProfile
        ? 'project'
        : pickedMachineProfile
          ? 'catalogue'
          : 'unseeded'
  if (intent.printerProfileId && machineProfileOrigin !== 'user') {
    // Named, not id'd: both sides of this conflict are preset ids, which tell the reader nothing.
    const requestedName = machineProfiles.find((profile) => profile.id === intent.printerProfileId)?.name
    conflicts.push({
      field: 'printerProfileId',
      requested: requestedName ?? intent.printerProfileId,
      applied: pickedMachineProfile?.name ?? ''
    })
  }
  const selectedMachineProfile = pickedMachineProfile
  const targetPrinterModel = resolveSliceDialogTargetPrinterModel(selectedPrinterModel, selectedMachineProfile)

  // 5. Process profiles the target allows. Plate-type independent on purpose (it passes `''`), so
  //    step 6 can depend on this list without a cycle.
  const printerCompatibleProcessProfiles = processProfiles.filter((profile) =>
    isSelectableOrProjectFallbackSlicingPreset(profile, processProfiles, bakedIndex?.processProfileName ?? null)
    && isProcessProfileCompatible(profile, selectedMachineProfile, selectedPrinterModel, selectedNozzleDiameters, ''))

  // 6. Plate. Matched BY LABEL at every rung: the same plate arrives as a code (`high_temp_plate`)
  //    from the project and as a label ("High Temp Plate") from a profile, so comparing values
  //    drops a choice that never actually changed.
  //    The printer rung outranks the project's on purpose (issue #10): the project's plate is
  //    whatever the file happened to be saved with, but a real printer's configured plate states
  //    what is physically on that machine. `plateFromPrinter` is non-null only when a real printer
  //    is the target, so a model-only target still seeds from the project.
  const plateTypeOptions = resolveCompatiblePlateTypes(file, bakedIndex, selectedMachineProfile, printerCompatibleProcessProfiles)
  const plateFromIntent = matchPlateTypeByLabel(plateTypeOptions, intent.plateType)
  const plateFromProject = matchPlateTypeByLabel(plateTypeOptions, resolveProjectPlateType(file, bakedIndex))
  const plateFromPrinter = matchPlateTypeByLabel(plateTypeOptions, selectedPrinter?.currentPlateType)
  let plateType = ''
  let plateOrigin: MachineTargetOrigin = 'unseeded'
  if (plateFromIntent) { plateType = plateFromIntent; plateOrigin = 'user' }
  else if (plateFromPrinter) { plateType = plateFromPrinter; plateOrigin = 'printer' }
  else if (plateFromProject) { plateType = plateFromProject; plateOrigin = 'project' }
  else {
    // Never BambuStudio's rank-0 Cool Plate as the blind default, an unrelated profiles recompute
    // must not silently move a project onto a plate nobody chose.
    plateType = matchPlateTypeByLabel(plateTypeOptions, 'textured_pei_plate') ?? plateTypeOptions[0] ?? ''
    plateOrigin = 'default'
  }
  if (intent.plateType && plateOrigin !== 'user') {
    conflicts.push({ field: 'plateType', requested: intent.plateType, applied: plateType })
  }

  return {
    targetMode,
    printerId,
    selectedPrinter,
    manualPrinterModel,
    selectedPrinterModel,
    printerModelOptions,
    printerProfileId,
    selectedMachineProfile,
    targetPrinterModel,
    nozzleDiameter,
    nozzleDiameterOptions,
    selectedNozzleDiameters,
    nozzleFlow: intent.nozzleFlow ?? 'standard',
    plateType,
    plateTypeOptions,
    modelCompatibleMachineProfiles,
    compatibleMachineProfiles,
    selectableMachineProfiles,
    printerCompatibleProcessProfiles,
    origins: {
      printerModel: modelOrigin,
      nozzleDiameter: nozzleOrigin,
      plateType: plateOrigin,
      printerProfileId: machineProfileOrigin
    },
    // Only once the inputs have settled: a half-loaded catalogue cannot yet offer the user's pick,
    // and reporting that would flash "no installed profile targets the A1" during an ordinary load.
    // The VALUES are unaffected, a pick that becomes representable applies on its own.
    conflicts: resolved ? conflicts : [],
    resolved
  }
}
