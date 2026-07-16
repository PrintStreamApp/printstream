/**
 * Cross-model machine-switch detection for the slice pipeline.
 *
 * PrintStream is its own source of truth for 3MF machine changes: when a slice
 * targets a different printer model than the project's embedded machine, the
 * input is retargeted natively via the shared `retargetProjectSettingsToMachine`
 * (the same rewrite the editor's "save as a different printer" uses) before the
 * CLI ever sees it — see docs/slicer-cross-model-machine-switch.md.
 * `shouldRetargetEmbeddedMachine` decides when that applies;
 * `assertSupportedEmbeddedMachineSwitch` hard-fails the one case a retarget
 * can't help: a nominally same-model H2-family project that lacks the H2
 * dual-nozzle topology (which crashes the CLI's extruder-variant resolution).
 */
import { canonicalBambuModelKey, type CreateSlicingJob, type SlicingProfileKind } from '@printstream/shared'

type SliceProfileFile = {
  kind: SlicingProfileKind
  name: string
}

const EMBEDDED_H2_MACHINE_MODELS = new Set(['H2D', 'H2DPRO', 'H2C'])

type EmbeddedMachineSwitchInput = {
  request: CreateSlicingJob
  profileFiles: readonly SliceProfileFile[]
  projectSettings: Record<string, unknown> | null
}

/**
 * Whether the input 3MF's embedded machine must be authored to the target
 * before slicing — i.e. PrintStream rewrites `project_settings` to the target
 * machine preset ({@link retargetProjectSettingsToMachine}) so the CLI receives
 * a project that already natively targets the requested printer. True when a
 * target machine preset is available AND the project's embedded machine is a
 * DIFFERENT Bambu model OR absent entirely:
 *  - different model  → the cross-model switch (e.g. P1S -> X2D);
 *  - absent (null)    → a from-scratch project the editor never gave a machine
 *    (a new-project scaffold embeds filaments + plate type but no machine), so
 *    we author the chosen printer's machine in exactly as the save flow does.
 * False when the embedded machine already IS the target model (nothing to do),
 * when there is no machine preset to author from, or when the target model is
 * unresolvable (non-Bambu) — those slice on the standard path unchanged.
 */
export function shouldRetargetEmbeddedMachine(input: EmbeddedMachineSwitchInput): boolean {
  if (!input.projectSettings) return false
  // No machine preset in the request means nothing to author the machine from
  // (e.g. the legacy fallback-manual path) — leave the input untouched.
  if (!input.profileFiles.some((profile) => profile.kind === 'machine')) return false
  const targetModel = resolveTargetPrinterModel(input.request, input.profileFiles)
  if (!targetModel) return false
  const sourceModel = resolveSourcePrinterModel(input.projectSettings)
  return sourceModel !== targetModel
}

export function assertSupportedEmbeddedMachineSwitch(input: EmbeddedMachineSwitchInput): void {
  const { projectSettings } = input
  if (!projectSettings) return

  const targetModel = resolveTargetPrinterModel(input.request, input.profileFiles)
  if (!targetModel || !EMBEDDED_H2_MACHINE_MODELS.has(targetModel)) return

  // A cross-model job is retargeted natively, which rebuilds the dual-nozzle
  // topology from the target machine profile — nothing to guard.
  if (shouldRetargetEmbeddedMachine(input)) return
  // Same-model H2 project: it must already carry the H2 dual-nozzle shape, or
  // the CLI segfaults resolving extruder variants.
  if (hasEmbeddedH2MachineShape(projectSettings)) return

  throw new Error(
    `This 3MF targets ${formatPrinterModel(targetModel)} but is missing its dual-nozzle machine data, so it cannot be sliced as-is. `
    + `Open it in Bambu Studio, re-select the ${formatPrinterModel(targetModel)} printer, save the .3mf, then slice that saved project.`
  )
}

function resolveTargetPrinterModel(request: CreateSlicingJob, profileFiles: readonly SliceProfileFile[]): string | null {
  if (request.target.mode === 'manualProfile') {
    const normalized = canonicalBambuModelKey(request.target.printerModel)
    if (normalized) return normalized
  }

  const machineProfile = profileFiles.find((profile) => profile.kind === 'machine')
  return canonicalBambuModelKey(machineProfile?.name)
}

function resolveSourcePrinterModel(projectSettings: Record<string, unknown>): string | null {
  return canonicalBambuModelKey(firstString(projectSettings.printer_model) ?? firstString(projectSettings.printer_settings_id))
}

function hasEmbeddedH2MachineShape(projectSettings: Record<string, unknown>): boolean {
  return stringArray(projectSettings.physical_extruder_map).length >= 2
    && stringArray(projectSettings.extruder_nozzle_stats).length >= 2
    && stringArray(projectSettings.extruder_max_nozzle_count).length >= 2
    && stringArray(projectSettings.default_nozzle_volume_type).length >= 2
}

function formatPrinterModel(value: string): string {
  switch (value) {
    case 'H2DPRO': return 'H2D Pro'
    case 'A1mini': return 'A1 mini'
    default: return value
  }
}

function firstString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (Array.isArray(value)) {
    const first = value.find((entry) => typeof entry === 'string' && entry.trim())
    return typeof first === 'string' ? first.trim() : null
  }
  return null
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : []
}
