/**
 * Mirrors BambuStudio's preset-listing rules so PrintStream's `/profiles`
 * endpoint surfaces exactly the presets the slicer's own UI would show.
 *
 * Two BambuStudio behaviours matter here:
 *  - The preset browser only lists records whose `type` matches the collection
 *    and that carry a display `name`; bundled include files and color/parameter
 *    tables (e.g. `fdm_*`, `filament_*`, `*recommended_params`) are skipped.
 *  - A preset is hidden when its JSON `instantiation` value is the string
 *    `"false"` (see `Preset::load_presets`: `is_visible = instantiation != "false"`).
 *    This is how `@base`/template presets stay out of the picker even though the
 *    files exist on disk. A missing `instantiation` key means visible.
 */

export type SlicerProfileKind = 'machine' | 'process' | 'filament'

export function isVisibleBambuStudioProfile(
  kind: SlicerProfileKind,
  name: string | undefined,
  record: Record<string, unknown>
): name is string {
  if (record.type !== kind) return false
  if (!name) return false
  if (isInternalBambuStudioResourceName(name)) return false
  return isInstantiableBambuStudioProfile(record)
}

/** BambuStudio hides presets only when `instantiation` is explicitly `"false"`. */
export function isInstantiableBambuStudioProfile(record: Record<string, unknown>): boolean {
  return record.instantiation !== 'false'
}

export function isInternalBambuStudioResourceName(value: string): boolean {
  const normalized = value.trim().toLowerCase().replace(/[\\/]+/g, '_').replace(/\s+/g, '_')
  return normalized.startsWith('fdm_')
    || normalized.startsWith('filament_')
    || normalized.startsWith('filaments_')
    || normalized.includes('recommended_params')
}
