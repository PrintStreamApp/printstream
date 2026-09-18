/**
 * Combines optional plugin-supplied filament settings with the user's explicit material edits.
 * Plugin values are ephemeral slice inputs; explicit edits always win and remain the only values
 * stored in the editor's undo/save state.
 */

export type FilamentSettingOverrides = Record<string, string | string[]>
export type PluginFilamentSettings = Record<number, Record<string, FilamentSettingOverrides>>

/** Add, replace, or remove one plugin's automatic settings for a project material. */
export function updatePluginFilamentSettings(
  current: PluginFilamentSettings,
  projectFilamentId: number,
  source: string,
  overrides: FilamentSettingOverrides | null
): PluginFilamentSettings {
  const currentForFilament = current[projectFilamentId] ?? {}
  if (overrides && Object.keys(overrides).length > 0) {
    if (JSON.stringify(currentForFilament[source]) === JSON.stringify(overrides)) return current
    return {
      ...current,
      [projectFilamentId]: { ...currentForFilament, [source]: overrides }
    }
  }
  if (!(source in currentForFilament)) return current

  const nextForFilament = { ...currentForFilament }
  delete nextForFilament[source]
  const next = { ...current }
  if (Object.keys(nextForFilament).length > 0) next[projectFilamentId] = nextForFilament
  else delete next[projectFilamentId]
  return next
}

/** Merge all automatic sources deterministically, then place explicit user edits on top. */
export function effectiveFilamentSettings(
  plugins: PluginFilamentSettings,
  projectFilamentId: number,
  explicit: FilamentSettingOverrides | undefined
): FilamentSettingOverrides | undefined {
  const automatic = Object.entries(plugins[projectFilamentId] ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .reduce<FilamentSettingOverrides>((merged, [, overrides]) => ({ ...merged, ...overrides }), {})
  const effective = { ...automatic, ...(explicit ?? {}) }
  return Object.keys(effective).length > 0 ? effective : undefined
}

/** Apply effective settings to the filament mappings that become the slice request. */
export function applyPluginFilamentSettings<T extends {
  projectFilamentId: number
  settingOverrides?: FilamentSettingOverrides
}>(mappings: readonly T[], plugins: PluginFilamentSettings): T[] {
  return mappings.map((mapping) => ({
    ...mapping,
    settingOverrides: effectiveFilamentSettings(
      plugins,
      mapping.projectFilamentId,
      mapping.settingOverrides
    )
  }))
}
