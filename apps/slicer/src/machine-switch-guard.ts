/**
 * Guards cross-model machine switches (slicing a project authored for printer A
 * onto printer B). Allows the switch when the target CLI exposes
 * `--estimate-mode`, or when the project is already shaped for the target H2-class
 * model; otherwise it throws rather than emit a bad slice. See
 * docs/slicer-cross-model-machine-switch.md.
 */
import type { CreateSlicingJob, SlicingProfileKind } from '@printstream/shared'

type SliceProfileFile = {
  kind: SlicingProfileKind
  name: string
}

const EMBEDDED_H2_MACHINE_MODELS = new Set(['H2D', 'H2DPRO', 'H2C'])

type EmbeddedMachineSwitchInput = {
  request: CreateSlicingJob
  profileFiles: readonly SliceProfileFile[]
  projectSettings: Record<string, unknown> | null
  supportedFlags?: ReadonlySet<string>
}

export function assertSupportedEmbeddedMachineSwitch(input: EmbeddedMachineSwitchInput): void {
  const { projectSettings } = input
  if (!projectSettings) return

  if (shouldUseEstimateModeMachineSwitch(input)) return

  const targetModel = resolveTargetPrinterModel(input.request, input.profileFiles)
  if (!targetModel || !EMBEDDED_H2_MACHINE_MODELS.has(targetModel)) return

  const sourceModel = resolveSourcePrinterModel(projectSettings)
  if (sourceModel === targetModel && hasEmbeddedH2MachineShape(projectSettings)) return

  throw new Error(
    `This slicer target cannot retarget this 3MF directly to ${formatPrinterModel(targetModel)} yet. `
    + `Use a Bambu Studio target that exposes --estimate-mode, or open it in Bambu Studio, switch the printer to ${formatPrinterModel(targetModel)}, save the .3mf, then slice that saved project.`
  )
}

export function shouldUseEstimateModeMachineSwitch(input: EmbeddedMachineSwitchInput): boolean {
  const { projectSettings, supportedFlags } = input
  if (!projectSettings || !supportedFlags?.has('--estimate-mode')) return false

  const targetModel = resolveTargetPrinterModel(input.request, input.profileFiles)
  const sourceModel = resolveSourcePrinterModel(projectSettings)
  return Boolean(targetModel && sourceModel && targetModel !== sourceModel)
}

function resolveTargetPrinterModel(request: CreateSlicingJob, profileFiles: readonly SliceProfileFile[]): string | null {
  if (request.target.mode === 'manualProfile') {
    const normalized = normalizePrinterModel(request.target.printerModel)
    if (normalized) return normalized
  }

  const machineProfile = profileFiles.find((profile) => profile.kind === 'machine')
  return normalizePrinterModel(machineProfile?.name)
}

function resolveSourcePrinterModel(projectSettings: Record<string, unknown>): string | null {
  return normalizePrinterModel(firstString(projectSettings.printer_model) ?? firstString(projectSettings.printer_settings_id))
}

function hasEmbeddedH2MachineShape(projectSettings: Record<string, unknown>): boolean {
  return stringArray(projectSettings.physical_extruder_map).length >= 2
    && stringArray(projectSettings.extruder_nozzle_stats).length >= 2
    && stringArray(projectSettings.extruder_max_nozzle_count).length >= 2
    && stringArray(projectSettings.default_nozzle_volume_type).length >= 2
}

function normalizePrinterModel(value: unknown): string | null {
  const normalized = typeof value === 'string'
    ? value.trim().toUpperCase()
    : Array.isArray(value)
      ? String(value[0] ?? '').trim().toUpperCase()
      : ''

  if (!normalized) return null
  if (normalized.includes('H2D PRO') || normalized.includes('H2DPRO') || normalized.includes('H2DP')) return 'H2DPRO'
  if (normalized.includes('H2D')) return 'H2D'
  if (normalized.includes('H2C')) return 'H2C'
  if (normalized.includes('H2S')) return 'H2S'
  if (normalized.includes('X2D')) return 'X2D'
  if (normalized.includes('P2S')) return 'P2S'
  if (normalized.includes('X1E')) return 'X1E'
  if (normalized.includes('X1 CARBON') || normalized.includes('X1C')) return 'X1C'
  if (normalized.includes('P1S')) return 'P1S'
  if (normalized.includes('P1P')) return 'P1P'
  if (normalized.includes('A2L')) return 'A2L'
  if (normalized.includes('A1 MINI') || normalized.includes('A1M')) return 'A1MINI'
  // Word-boundary match: the real value is "BAMBU LAB A1" (no trailing space), which a
  // bare `includes(' A1 ')` misses — leaving A1 projects/targets undetected.
  if (/(^|[^A-Z0-9])A1($|[^A-Z0-9])/.test(normalized)) return 'A1'
  return null
}

function formatPrinterModel(value: string): string {
  switch (value) {
    case 'H2DPRO': return 'H2D Pro'
    case 'H2D': return 'H2D'
    case 'H2C': return 'H2C'
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