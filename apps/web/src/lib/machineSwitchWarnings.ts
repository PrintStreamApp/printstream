/**
 * Warnings a MACHINE SWITCH should raise at the moment of switching, rather than letting the user
 * discover them at slice time.
 *
 * BambuStudio reports these conditions too (it never silently moves a user's objects), so surfacing
 * them is parity: the gap was only WHEN: an off-bed object previously showed up as the CLI's
 * "no object fully inside the print volume" (exit 206) after a slice attempt, and a layer height
 * outside the new machine's envelope was clamped by BambuStudio with no notice at all.
 *
 * Pure so both the editor (which knows the live scene) and the print flow can use it; the caller
 * supplies the counts/values it can see.
 */
import type { SlicingPresetSummary } from '@printstream/shared'
import { formatNozzleDiameterLabel } from '@printstream/shared'
import type { MachineTargetConflict } from './machineTargetResolution'
import { formatPlateTypeLabel, formatPrinterModelLabel } from './slicingPresetMatching'

export interface MachineSwitchWarning {
  /** Stable key so a host can dedupe/dismiss. */
  key: 'offBed' | 'layerHeight' | 'printerModelUnavailable' | 'printerProfileUnavailable' | 'nozzleUnavailable' | 'plateUnavailable' | 'machineOverridesCarried'
  message: string
}

export interface MachineSwitchWarningInput {
  /** Display name of the machine just switched to (for the message). */
  printerModel: string
  /** Printed objects that no longer fit the new bed (the editor's placement checks). */
  offBedObjectCount?: number
  /** The selected process preset's layer height, when known. */
  layerHeight?: number | null
  /** The target machine profile, for its layer-height envelope. */
  machineProfile?: SlicingPresetSummary | null
}

/**
 * Both warnings, or an empty list when the switch is clean. Layer height is only judged when BOTH
 * the process height and the machine's envelope are known, a missing bound must never invent a
 * warning (older slicer images do not report the envelope at all).
 */
export function machineSwitchWarnings(input: MachineSwitchWarningInput): MachineSwitchWarning[] {
  const warnings: MachineSwitchWarning[] = []
  const model = input.printerModel === 'unknown' ? 'this printer' : input.printerModel

  const offBed = input.offBedObjectCount ?? 0
  if (offBed > 0) {
    warnings.push({
      key: 'offBed',
      message: offBed === 1
        ? `1 object no longer fits the ${model} bed. Move, scale, or arrange it before slicing.`
        : `${offBed} objects no longer fit the ${model} bed. Move, scale, or arrange them before slicing.`
    })
  }

  const layerHeight = input.layerHeight ?? null
  const minLayerHeight = input.machineProfile?.minLayerHeight ?? null
  const maxLayerHeight = input.machineProfile?.maxLayerHeight ?? null
  if (layerHeight != null && layerHeight > 0) {
    // Rounded for display only; the comparison uses the real values with a small tolerance so a
    // 0.28 process against a 0.28 machine maximum never reads as out of range.
    const tolerance = 1e-6
    if (minLayerHeight != null && layerHeight < minLayerHeight - tolerance) {
      warnings.push({
        key: 'layerHeight',
        message: `This project's ${layerHeight}mm layer height is below the ${model}'s minimum (${minLayerHeight}mm). Pick a compatible process preset: the slicer will otherwise clamp it.`
      })
    } else if (maxLayerHeight != null && layerHeight > maxLayerHeight + tolerance) {
      warnings.push({
        key: 'layerHeight',
        message: `This project's ${layerHeight}mm layer height is above the ${model}'s maximum (${maxLayerHeight}mm). Pick a compatible process preset: the slicer will otherwise clamp it.`
      })
    }
  }

  return warnings
}

/**
 * The user-facing half of `resolveMachineTarget`'s conflicts: a pick the current target cannot
 * represent, named alongside what is in force instead.
 *
 * This exists because the pre-S2 reconciliation made the swap SILENTLY, a plate the new machine
 * did not offer became Textured PEI with no signal, which is the E9 guard violation the audit
 * recorded. Reporting it is the fix; the pick itself is still held (see `MachineTargetIntent`), so
 * switching back to a machine that offers it restores the choice.
 */
export function machineTargetConflictWarnings(conflicts: readonly MachineTargetConflict[]): MachineSwitchWarning[] {
  return conflicts.map((conflict) => {
    if (conflict.field === 'plateType') {
      return {
        key: 'plateUnavailable' as const,
        message: `The ${formatPlateTypeLabel(conflict.requested)} isn't available for this printer, so ${formatPlateTypeLabel(conflict.applied)} is selected instead.`
      }
    }
    if (conflict.field === 'nozzleDiameter') {
      const requested = formatNozzleDiameterLabel(conflict.requested) ?? `${conflict.requested} mm`
      const applied = formatNozzleDiameterLabel(conflict.applied) ?? `${conflict.applied} mm`
      return {
        key: 'nozzleUnavailable' as const,
        message: `This printer doesn't offer a ${requested} nozzle, so ${applied} is selected instead.`
      }
    }
    if (conflict.field === 'printerProfileId') {
      // Both sides arrive as NAMES (the resolver resolves them), because a preset id on screen
      // tells the reader nothing about which printer preset they lost.
      return {
        key: 'printerProfileUnavailable' as const,
        message: conflict.applied
          ? `The ${conflict.requested} preset isn't available for this printer and nozzle, so ${conflict.applied} is selected instead.`
          : `The ${conflict.requested} preset isn't available for this printer and nozzle.`
      }
    }
    return {
      key: 'printerModelUnavailable' as const,
      message: `No installed profile targets the ${formatPrinterModelLabel(conflict.requested)}, so ${formatPrinterModelLabel(conflict.applied)} is selected instead.`
    }
  })
}

/**
 * The project's own machine settings are still applied after a printer change, and they were
 * authored against a DIFFERENT machine.
 *
 * Kept rather than cleared, deliberately: they are the user's work, and silently discarding them on
 * a printer switch is the failure this project's conventions call worse than an unwanted value.
 * But an override is a diff against one specific preset's baseline, so carrying it can express
 * something the new machine cannot do -- a `printable_height` from a taller printer, or an
 * extruder-indexed vector from a dual-nozzle one. So it is carried AND said out loud, and the
 * settings dialog offers a per-key reset for anything the user does not want.
 *
 * Returns null when there is nothing to say: no overrides, or the machine did not change.
 */
export function machineOverridesCarriedWarning(input: {
  overriddenKeyCount: number
  previousPrinterModel: string | null
  printerModel: string
}): MachineSwitchWarning | null {
  if (input.overriddenKeyCount === 0) return null
  if (!input.previousPrinterModel || input.previousPrinterModel === input.printerModel) return null
  const count = input.overriddenKeyCount
  return {
    key: 'machineOverridesCarried',
    message: `${count} printer setting${count === 1 ? '' : 's'} you changed for `
      + `${formatPrinterModelLabel(input.previousPrinterModel)} ${count === 1 ? 'is' : 'are'} still applied to `
      + `${formatPrinterModelLabel(input.printerModel)}. Check them in the printer settings, or reset the ones you do not want.`
  }
}
