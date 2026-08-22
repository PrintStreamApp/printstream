/**
 * The MACHINE (printer) settings catalog and its helpers.
 *
 * Thin by design: a machine preset has no project-embedded counterpart the way filament and process
 * presets do (a 3MF embeds those but only NAMES its printer), so there is no baseline-vs-embedded
 * diffing here — the resolved preset is the baseline. Everything else reuses the process catalog's
 * types and comparators, which is why the generated catalog is typed `ProcessSettingsCatalog`.
 *
 * What this module OWNS beyond the catalog re-export is the COLUMN model: over half the machine
 * options are vectors, and a vector's elements mean different things depending on which page the
 * option sits on. Collapsing them to element 0 (what `createProcessConfigAccessor` does, and what
 * the process dialog therefore does) silently edits one element of a preset that holds several.
 * See {@link machineColumnsForPage}.
 *
 * Counterpart: `scripts/dev/generate-machine-settings.mjs`, which produces the generated catalog
 * from BambuStudio's TabPrinter layout + PrintConfig.cpp metadata, and
 * `apps/web/src/components/settings/MachineSettingsDialog.tsx`, which renders these columns.
 */
import { machineSettingsCatalog } from './generated/machine-settings.generated.js'
import { diffProcessConfig, type ProcessConfig, type ProcessConfigValue } from './process-settings.js'

export { machineSettingsCatalog }

/**
 * Values that differ from the preset baseline, compared through the CATALOG option so a value
 * spelled differently but meaning the same (percent suffixes, numeric formatting) is not reported
 * as changed. Same rule as the process and filament diffs.
 */
export function diffMachineConfig(base: ProcessConfig, edited: ProcessConfig): ProcessConfig {
  return diffProcessConfig(base, edited, machineSettingsCatalog)
}

/**
 * The preset body to persist for an edited machine.
 *
 * Built over the RESOLVED config rather than the editor's own, because the editor only ever sees
 * the catalog's 77 options. BambuStudio's printer tab edits the rest through bespoke widgets we do
 * not have — the printable area, bed shape and exclusion zones, the model/variant identity — and a
 * save assembled from the editable keys alone would drop every one of them, quietly rebuilding the
 * preset around a different bed. So the resolved config is the base and only the keys the user
 * could actually change are laid over it.
 *
 * `type` is stamped because `parseProfileJson` reads it to route the preset into the machine
 * collection; the API re-derives and re-validates it either way.
 */
export function buildMachinePresetConfig(input: {
  /** The preset exactly as `/profiles/resolve-machine` returned it, non-catalog keys included. */
  resolved: ProcessConfig
  /** The preset baseline the editor started from (resolved + catalog defaults). */
  baseline: ProcessConfig
  /** The edited config. */
  edited: ProcessConfig
  name: string
}): ProcessConfig {
  return {
    ...input.resolved,
    ...diffMachineConfig(input.baseline, input.edited),
    name: input.name,
    type: 'machine'
  }
}

/** Catalog page ids whose vector options carry a per-column meaning. */
const EXTRUDER_PAGE_ID = 'extruder'
const MOTION_ABILITY_PAGE_ID = 'motion-ability'

/**
 * One editable element of a machine option.
 *
 * `label` is set only when the option really has more than one column — BambuStudio names its
 * extruder page "Extruder" (no number) on a single-extruder machine and only draws the
 * Normal/Silent legend in silent mode, so a lone column carries no label either.
 */
export interface MachineSettingColumn {
  /** Index into the option's vector; 0 for a scalar. */
  index: number
  /** Column name ("Extruder 2", "Silent"), or undefined when the option has a single column. */
  label?: string
}

const SINGLE_COLUMN: readonly MachineSettingColumn[] = [{ index: 0 }]

/**
 * How many extruders the preset describes.
 *
 * BambuStudio derives this from `nozzle_diameter`'s length and nothing else
 * (`TabPrinter::build_unregular_pages`: `m_extruders_count = nozzle_diameter->values.size()`),
 * so a preset whose other per-extruder vectors are shorter still has this many extruders — the
 * short ones are simply un-resized, which is why {@link machineColumnValue} falls back rather
 * than reporting a missing column.
 */
export function machineExtruderCount(config: ProcessConfig): number {
  const value = config.nozzle_diameter
  return Array.isArray(value) && value.length > 0 ? value.length : 1
}

/**
 * Whether the preset's motion limits carry a second (Silent mode) column.
 *
 * Mirrors `TabPrinter::build_kinematics_page`, which appends the option a second time at index 1
 * only when `m_use_silent_mode` — itself just `m_config->opt_bool("silent_mode")`. With silent
 * mode off the machine never reads element 1, so offering it would invite an edit that does
 * nothing.
 */
export function machineSupportsSilentMode(config: ProcessConfig): boolean {
  const value = config.silent_mode
  const scalar = Array.isArray(value) ? value[0] : value
  return scalar === '1' || scalar === 'true'
}

/**
 * The columns to render for `key` on `pageId`.
 *
 * A machine vector's elements are indexed by DIFFERENT things per page, which is the whole reason
 * this is page-driven rather than a property of the option:
 * - Extruder page — one element per extruder (`nozzle_diameter`, `retraction_length`,
 *   `extruder_offset`, ...). BambuStudio builds one page per extruder and passes the extruder index
 *   to every `append_single_option_line`.
 * - Motion ability page — element 0 is Normal mode and element 1 is Silent mode, NOT extruders
 *   (`append_option_line` appends index 1 behind `m_use_silent_mode`).
 * - Everywhere else — element 0 only. `nozzle_type` is a vector but its Basic information line is
 *   an `append_single_option_line` with no index, so BambuStudio shows the first element alone.
 *
 * A non-vector option always gets the single unlabelled column, whatever page it is on.
 */
export function machineColumnsForPage(
  key: string,
  pageId: string,
  config: ProcessConfig
): readonly MachineSettingColumn[] {
  if (!machineSettingsCatalog.options[key]?.vector) return SINGLE_COLUMN
  if (pageId === EXTRUDER_PAGE_ID) {
    const count = machineExtruderCount(config)
    if (count <= 1) return SINGLE_COLUMN
    return Array.from({ length: count }, (_entry, index) => ({ index, label: `Extruder ${index + 1}` }))
  }
  if (pageId === MOTION_ABILITY_PAGE_ID) {
    if (!machineSupportsSilentMode(config)) return SINGLE_COLUMN
    return [{ index: 0, label: 'Normal' }, { index: 1, label: 'Silent' }]
  }
  return SINGLE_COLUMN
}

/**
 * The value in one column, falling back to element 0 for a vector shorter than the extruder count.
 *
 * The fallback is not cosmetic: presets routinely carry a single-element `retraction_length` on a
 * machine whose `nozzle_diameter` has two, because BambuStudio resizes those vectors lazily. Showing
 * a blank there would read as "this extruder has no retraction".
 */
export function machineColumnValue(value: ProcessConfigValue | undefined, index: number): string {
  if (value === undefined) return ''
  if (!Array.isArray(value)) return value
  return value[index] ?? value[0] ?? ''
}

/**
 * `value` with one column replaced, widened to cover `index` if it was shorter.
 *
 * Widening repeats element 0 rather than padding with blanks, matching the fallback
 * {@link machineColumnValue} displays — otherwise editing extruder 2 of a one-element vector would
 * write an empty string into extruder 1's slot, which the engine reads as a missing value.
 * A scalar stays scalar when column 0 is edited, so a preset that never had a vector here does not
 * grow one.
 */
export function setMachineColumnValue(
  value: ProcessConfigValue | undefined,
  index: number,
  next: string
): ProcessConfigValue {
  if (index === 0 && !Array.isArray(value)) return next
  const base = Array.isArray(value) ? value : value === undefined ? [] : [value]
  const filler = base[0] ?? ''
  const widened = Array.from({ length: Math.max(base.length, index + 1) }, (_entry, position) => base[position] ?? filler)
  widened[index] = next
  return widened
}
