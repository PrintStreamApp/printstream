/**
 * The MACHINE-TARGET core of the slice-settings controller: the one implementation of the
 * printer / model / machine-profile / nozzle / plate-type target both hosts share (audit invariant
 * I9), and the only holder of the user's picks in that domain.
 *
 * Owns exactly one piece of state: the {@link MachineTargetIntent}, written only by the gesture
 * wrappers below. Every value it exposes is DERIVED from that intent plus the resolved inputs, by
 * the pure cascade in `lib/machineTargetResolution.ts` (invariants I1, I3, I5). Before S2 the same
 * answers lived in six useStates reconciled by five effects here and four more in the workspace
 * host, arbitrated by two "touched" refs, which is why "who set this value?" had no answer.
 *
 * What that buys, beyond the deletions:
 * - a user pick is never silently overwritten; when the current machine cannot represent it the
 *   resolution reports a {@link MachineTargetConflict} and the intent KEEPS the request, so
 *   switching back restores the choice (the E9 fix),
 * - the ordering model → nozzle → machine profile → plate is stated once instead of being reached
 *   by several effects converging over several renders,
 * - the S1 rule about same-identity updaters does not apply here at all: a memo recomputing on an
 *   unstable input costs a render, where a reconciliation effect looped.
 *
 * PRINTER-AWARENESS is parameters, not branches: the workspace host passes `printers` and any
 * `lockedPreferredPrinter`; the public host passes neither and resolves a manual target.
 *
 * Counterparts: `SliceFileModal.tsx`, `useLocalSliceSettingsController.ts`.
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import type { LibraryFile, Printer, PrinterNozzleFlow, SlicingPresetSummary, ThreeMfIndex } from '@printstream/shared'
import {
  EMPTY_MACHINE_TARGET_INTENT,
  resolveMachineTarget,
  type MachineTargetConflict,
  type MachineTargetIntent,
  type MachineTargetOrigin,
  type MachineTargetField
} from '../../lib/machineTargetResolution'

export type { MachineTargetConflict } from '../../lib/machineTargetResolution'

/** The machine fields of `SliceConfigSnapshot`. Only the intent: the rest re-derives on restore. */
export interface MachineTargetSnapshot {
  machineTargetIntent: MachineTargetIntent
}

export interface MachineTargetParams {
  file: LibraryFile
  bakedIndex: ThreeMfIndex | null
  machineProfiles: SlicingPresetSummary[]
  processProfiles: SlicingPresetSummary[]
  /** Real printers this host can target. Printer-less hosts omit it. */
  printers?: Printer[]
  /** Seeds and pins the target to this printer (the locked print-prep flow). */
  lockedPreferredPrinter?: Printer | null
  /** The project's 3MF index request settled: data, error, or nothing to fetch. */
  projectResolved: boolean
  /** The profile catalogue for the current engine target settled. */
  catalogueResolved: boolean
  /**
   * Bumped by the host when the engine target changes. A different catalogue means picks made
   * against the old one no longer bind, so the whole intent clears: uniformly, unlike the pre-S2
   * reset which cleared the model's touched flag and the process's but not the plate's.
   */
  resetToken?: unknown
}

export interface MachineTarget {
  targetMode: 'realPrinter' | 'manualProfile'
  printerId: string
  selectedPrinter: Printer | null
  /** Picks a printer AND the target mode in one gesture, two calls would cost two Ctrl+Z. */
  selectPrinter: (printer: Printer | null) => void
  selectedPrinterModel: string
  manualPrinterModel: string
  selectPrinterModel: (model: string) => void
  printerModelOptions: string[]
  printerProfileId: string
  /**
   * Pick the machine preset directly, rather than accepting the one the cascade resolved to.
   * Recorded as intent, so a pick survives the re-resolution that follows it; a pick the current
   * model/nozzle cannot offer is reported as a conflict and kept, not applied.
   */
  selectPrinterProfile: (profileId: string) => void
  selectedMachineProfile: SlicingPresetSummary | null
  targetPrinterModel: string | null
  nozzleDiameter: string
  setNozzleDiameter: React.Dispatch<React.SetStateAction<string>>
  nozzleDiameterOptions: string[]
  selectedNozzleDiameters: number[]
  nozzleFlow: PrinterNozzleFlow
  setNozzleFlow: React.Dispatch<React.SetStateAction<PrinterNozzleFlow>>
  plateType: string
  handlePlateTypeChange: (value: React.SetStateAction<string>) => void
  plateTypeOptions: string[]
  modelCompatibleMachineProfiles: SlicingPresetSummary[]
  compatibleMachineProfiles: SlicingPresetSummary[]
  selectableMachineProfiles: SlicingPresetSummary[]
  printerCompatibleProcessProfiles: SlicingPresetSummary[]
  /** User picks the current inputs cannot represent. Reported, never silently applied. */
  conflicts: MachineTargetConflict[]
  /** Where each value came from, for waiting-vs-answered UI and conflict copy, never for guards. */
  origins: Record<MachineTargetField, MachineTargetOrigin>
  /** Both async inputs settled: the target is final for these inputs. */
  resolved: boolean
  machineSnapshot: MachineTargetSnapshot
  restoreMachineSnapshot: (snapshot: MachineTargetSnapshot) => void
}

export function useMachineTarget(params: MachineTargetParams): MachineTarget {
  const {
    file, bakedIndex, machineProfiles, processProfiles,
    printers, lockedPreferredPrinter = null, projectResolved, catalogueResolved, resetToken
  } = params

  const [intent, setIntent] = useState<MachineTargetIntent>(EMPTY_MACHINE_TARGET_INTENT)
  // React's "adjust state when a prop changes" recipe rather than an effect: clearing during render
  // means the very first render after an engine change already resolves against the new catalogue,
  // where an effect would paint one frame of stale picks first.
  const [seenResetToken, setSeenResetToken] = useState(resetToken)
  if (seenResetToken !== resetToken) {
    setSeenResetToken(resetToken)
    setIntent(EMPTY_MACHINE_TARGET_INTENT)
  }

  // Identity-keyed on purpose. `bakedIndex`/`printers`/the profile arrays change identity on every
  // refetch while saying the same thing; for a MEMO that costs a recompute, and the repo's
  // content-signature rule is about effects and query keys, which would re-fire instead.
  const resolution = useMemo(
    () => resolveMachineTarget({
      file, bakedIndex, machineProfiles, processProfiles,
      printers, lockedPreferredPrinter, projectResolved, catalogueResolved
    }, intent),
    [file, bakedIndex, machineProfiles, processProfiles, printers, lockedPreferredPrinter, projectResolved, catalogueResolved, intent]
  )

  // The gesture wrappers accept `SetStateAction` so callers (and the editor's undo wrappers) keep
  // working unchanged; an updater is applied to the RESOLVED value, which is what the user sees.
  const resolutionRef = useRef(resolution)
  resolutionRef.current = resolution

  const selectPrinter = useCallback((printer: Printer | null) => {
    setIntent((previous) => ({ ...previous, printerId: printer?.id ?? '' }))
  }, [])
  const selectPrinterModel = useCallback((model: string) => {
    setIntent((previous) => ({ ...previous, printerModel: model }))
  }, [])
  const selectPrinterProfile = useCallback((profileId: string) => {
    setIntent((previous) => ({ ...previous, printerProfileId: profileId }))
  }, [])
  const setNozzleDiameter = useCallback((value: React.SetStateAction<string>) => {
    const next = typeof value === 'function' ? value(resolutionRef.current.nozzleDiameter) : value
    setIntent((previous) => ({ ...previous, nozzleDiameter: next }))
  }, [])
  const setNozzleFlow = useCallback((value: React.SetStateAction<PrinterNozzleFlow>) => {
    const next = typeof value === 'function' ? value(resolutionRef.current.nozzleFlow) : value
    setIntent((previous) => ({ ...previous, nozzleFlow: next }))
  }, [])
  const handlePlateTypeChange = useCallback((value: React.SetStateAction<string>) => {
    const next = typeof value === 'function' ? value(resolutionRef.current.plateType) : value
    setIntent((previous) => ({ ...previous, plateType: next }))
  }, [])

  const machineSnapshot = useMemo<MachineTargetSnapshot>(() => ({ machineTargetIntent: intent }), [intent])
  const restoreMachineSnapshot = useCallback((snapshot: MachineTargetSnapshot) => {
    setIntent(snapshot.machineTargetIntent ?? EMPTY_MACHINE_TARGET_INTENT)
  }, [])

  return {
    targetMode: resolution.targetMode,
    printerId: resolution.printerId,
    selectedPrinter: resolution.selectedPrinter,
    selectPrinter,
    selectedPrinterModel: resolution.selectedPrinterModel,
    manualPrinterModel: resolution.manualPrinterModel,
    selectPrinterModel,
    printerModelOptions: resolution.printerModelOptions,
    printerProfileId: resolution.printerProfileId,
    selectPrinterProfile,
    selectedMachineProfile: resolution.selectedMachineProfile,
    targetPrinterModel: resolution.targetPrinterModel,
    nozzleDiameter: resolution.nozzleDiameter,
    setNozzleDiameter,
    nozzleDiameterOptions: resolution.nozzleDiameterOptions,
    selectedNozzleDiameters: resolution.selectedNozzleDiameters,
    nozzleFlow: resolution.nozzleFlow,
    setNozzleFlow,
    plateType: resolution.plateType,
    handlePlateTypeChange,
    plateTypeOptions: resolution.plateTypeOptions,
    modelCompatibleMachineProfiles: resolution.modelCompatibleMachineProfiles,
    compatibleMachineProfiles: resolution.compatibleMachineProfiles,
    selectableMachineProfiles: resolution.selectableMachineProfiles,
    printerCompatibleProcessProfiles: resolution.printerCompatibleProcessProfiles,
    conflicts: resolution.conflicts,
    origins: resolution.origins,
    resolved: resolution.resolved,
    machineSnapshot,
    restoreMachineSnapshot
  }
}
