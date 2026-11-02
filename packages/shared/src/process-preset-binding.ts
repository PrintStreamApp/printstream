/**
 * Native process identity, values and changed-key records are one write. The native parent diff
 * includes a custom preset's own changes; it is distinct from the leaf diff used to transfer a
 * project's edits. Counterparts: PresetBundle::full_config and PresetCollection::load_external_preset.
 */
import { PRINT_PRESET_OPTIONS } from './generated/preset-options.generated.js'
import { processConfigValuesEqual, processSettingsCatalog, type ProcessConfig } from './process-settings.js'
import { filamentSlotCount, withChangedFromSystemSlot, withParallelPresetSlot } from './three-mf-project-config.js'
import { alignProcessConfigToLayout } from './process-variant-layout.js'

export interface ProcessPresetBinding {
  name: string
  parentName: string | null
  parentConfig?: ProcessConfig
}

/** Write only the process slots, preserving filament/printer records and their positions. */
export function applyProcessPresetBinding(
  record: Record<string, unknown>,
  preset: ProcessConfig,
  binding: ProcessPresetBinding
): void {
  const sourceBaseline = binding.parentName ? binding.parentConfig : preset
  const baseline = sourceBaseline ? alignProcessConfigToLayout(sourceBaseline, record) : undefined
  const changed: string[] = []
  for (const key of PRINT_PRESET_OPTIONS) {
    if (key === 'print_settings_id' || key === 'print_extruder_id' || key === 'print_extruder_variant') continue
    const value = record[key]
    if (typeof value !== 'string' && !(Array.isArray(value) && value.every((item) => typeof item === 'string'))) continue
    const original = baseline?.[key]
    // Missing parent: conservatively declare the effective settings rather than allowing native
    // normalization to erase a custom preset's values. Never substitute the leaf as its parent.
    if (original === undefined || !processConfigValuesEqual(value, original, processSettingsCatalog.options[key])) changed.push(key)
  }
  // The final project's filament identity arrays own the width, never either metadata array.
  const count = filamentSlotCount(record)
  record.print_settings_id = binding.name
  record.inherits_group = withParallelPresetSlot(record.inherits_group, 0, binding.parentName ?? '', count)
  record.different_settings_to_system = withChangedFromSystemSlot(record.different_settings_to_system, 0, changed, count)
}
