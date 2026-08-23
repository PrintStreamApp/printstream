/**
 * The filament presets a project carries INSIDE itself, BambuStudio's `Metadata/filament_settings_N.config`
 * sidecars, and which of them nothing uses any more.
 *
 * WHY THEY EXIST AT ALL. When a slot names a preset BambuStudio cannot bind (an unknown name, an
 * empty one, a preset the user does not have installed), it fabricates one from the project's values
 * and names it `<original>(<project>.3mf)`. It then writes that preset into the archive as a sidecar
 * and re-embeds it on EVERY later save (`PresetCollection::get_project_embedded_presets`), so a
 * single bad save follows the project forever: the preset shows up in the user's filament dropdown,
 * on every machine that opens the file, indefinitely.
 *
 * WHY THEY GO STALE. Nothing removes one when the slot that caused it is repointed at a real preset.
 * A file repaired to bind its materials correctly still carries the sidecars from before the repair.
 * MEASURED on a real project: two sidecars named `Bambu Support For PLA/PETG @BBL H2D(Best Shot
 * Golf.3mf)` and `…-1(Best Shot Golf.3mf)`, referenced by no slot, where BambuStudio's own save of
 * the same project carries none.
 *
 * CONTRACT: this module only REPORTS. Removal is an explicit user action (`SceneEdit.removedEmbeddedPresets`)
 * for the same reason every other defect in a saved project is: see `repairs/index.ts`. An embedded
 * preset can be the only surviving record of settings the user tuned, so dropping one on their
 * behalf is not ours to decide even when nothing references it today.
 *
 * Counterpart: `three-mf/bake-documents.ts` drops the entries the user removed; the editor's
 * material section lists them.
 */

/** Where BambuStudio writes them: `Metadata/filament_settings_1.config`, `_2`, ... */
const EMBEDDED_FILAMENT_PRESET_PATTERN = /^Metadata\/filament_settings_(\d+)\.config$/

/** Whether `entryPath` is an embedded filament-preset sidecar. */
export function isEmbeddedFilamentPresetEntry(entryPath: string): boolean {
  return EMBEDDED_FILAMENT_PRESET_PATTERN.test(entryPath)
}

/** One preset the project carries inside itself. */
export interface EmbeddedProjectPreset {
  /** The archive entry, which is also its identity for removal. */
  entryPath: string
  /** The preset's own `name`, as it appears in BambuStudio's dropdown. Empty when unreadable. */
  name: string
  /** The system preset it derives from, when it declares one. */
  inherits: string | null
  /**
   * Whether any filament slot names this preset.
   *
   * An UNUSED preset is dead weight BambuStudio will nonetheless carry forever. A used one must
   * never be offered for removal: the slot would then name a preset that exists nowhere, which is
   * the very condition that mints these in the first place.
   */
  used: boolean
}

/**
 * Classify a project's embedded presets against the slots that could reference them.
 *
 * `settingsIds` is the project's `filament_settings_id`: the names slots bind by. Matching is on
 * the exact name, the way BambuStudio binds (`find_preset_internal`); a preset whose name cannot be
 * read is reported unused-but-unnamed rather than silently dropped from the list, so the user can
 * still see that the file carries something.
 */
export function classifyEmbeddedProjectPresets(
  entries: ReadonlyArray<{ entryPath: string; json: string }>,
  settingsIds: readonly string[]
): EmbeddedProjectPreset[] {
  const referenced = new Set(settingsIds.map((id) => id.trim()).filter((id) => id.length > 0))
  const presets: EmbeddedProjectPreset[] = []
  for (const entry of entries) {
    if (!isEmbeddedFilamentPresetEntry(entry.entryPath)) continue
    let name = ''
    let inherits: string | null = null
    try {
      const parsed: unknown = JSON.parse(entry.json)
      if (parsed && typeof parsed === 'object') {
        const record = parsed as Record<string, unknown>
        if (typeof record.name === 'string') name = record.name.trim()
        if (typeof record.inherits === 'string' && record.inherits.trim().length > 0) inherits = record.inherits.trim()
      }
    } catch {
      // An unreadable sidecar is still IN the file and still reaches BambuStudio, so it belongs in
      // the list. Reporting only the ones we can parse would hide exactly the broken ones.
    }
    presets.push({ entryPath: entry.entryPath, name, inherits, used: name.length > 0 && referenced.has(name) })
  }
  // Stable order by entry index, so the list does not reshuffle between opens.
  return presets.sort((a, b) => a.entryPath.localeCompare(b.entryPath, 'en', { numeric: true }))
}

/**
 * Whether a project's embedded presets include any nothing references.
 *
 * Cheap enough to call per render; used to decide whether the editor shows the section at all, a
 * project with no sidecars (the normal case) should not grow an empty panel.
 */
export function hasUnusedEmbeddedPresets(presets: readonly EmbeddedProjectPreset[]): boolean {
  return presets.some((preset) => !preset.used)
}
