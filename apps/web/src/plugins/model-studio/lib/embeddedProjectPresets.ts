/**
 * Reads the project-embedded filament presets out of the archive the editor already has open.
 *
 * Deliberately NOT part of the 3MF index: the index is cached per file version and versioned, so
 * adding a field to it costs a `THREE_MF_INDEX_PARSER_VERSION` bump and a re-parse of every stored
 * project — for data only the editor can act on, and only while a project is open. The editor
 * already holds the whole archive in the tab (`editorReadsArchiveInBrowser`), so this is a read of
 * bytes that are in hand.
 *
 * Classification is the shared one (`@printstream/shared/three-mf`), so what the editor calls unused
 * is exactly what the bake would drop.
 */
import { classifyEmbeddedProjectPresets, isEmbeddedFilamentPresetEntry, type EmbeddedProjectPreset } from '@printstream/shared/three-mf'
import type { ThreeMfArchive } from './threeMfArchive'

export type { EmbeddedProjectPreset }

/**
 * The presets this project carries inside itself, each flagged used or not.
 *
 * `removed` are entries the session has already removed — they are dropped from the list rather
 * than shown greyed, because the removal is undoable and the list is the state of the project as it
 * would save right now.
 */
export function readEmbeddedProjectPresets(
  archive: ThreeMfArchive,
  removed: readonly string[] = []
): EmbeddedProjectPreset[] {
  const dropped = new Set(removed)
  const entries = archive.entryNames()
    .filter((name) => isEmbeddedFilamentPresetEntry(name) && !dropped.has(name))
    .map((entryPath) => ({ entryPath, json: archive.entryText(entryPath) ?? '' }))
  if (entries.length === 0) return []

  // The names slots bind by. Read from the project config rather than from the editor's material
  // list: a slot the user has repointed this session has not been saved yet, so the FILE's record is
  // what says whether the sidecar is still referenced in the project as it stands.
  let settingsIds: string[] = []
  const json = archive.indexEntries().projectSettingsJson
  if (json) {
    try {
      const parsed: unknown = JSON.parse(json)
      const ids = (parsed as { filament_settings_id?: unknown } | null)?.filament_settings_id
      if (Array.isArray(ids)) settingsIds = ids.filter((id): id is string => typeof id === 'string')
    } catch {
      // An unparseable project config means we cannot say what is referenced. Every preset then
      // reports unused, which would offer the user a removal we cannot stand behind — so report
      // nothing instead.
      return []
    }
  }
  return classifyEmbeddedProjectPresets(entries, settingsIds)
}
