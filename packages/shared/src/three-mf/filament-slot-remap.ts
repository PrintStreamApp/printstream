/**
 * Filament slot maps used while rewriting a 3MF's model and settings documents.
 *
 * A desired filament list names old slots through sourceIndex. The first retained source wins;
 * explicit replacements then override clone ancestry. The model-settings remap runs before
 * imported or added parts are written, so newly authored bindings stay in the new slot space.
 */
import { FILAMENT_INDEX_PROCESS_KEYS } from '../process-settings.js'
import type { SceneEditFilament } from '../slicing.js'
import { parseModelSettingsScene } from './scene-parser.js'

/**
 * Build a filament-id -> extruder-slot lookup from the project's `filament_maps` so a
 * reassignment to filament F writes the `extruder` slot the parser maps back to F. Only a
 * 1:1 map is inverted; otherwise the extruder equals the filament id (the parser's fallback).
 */
export function buildFilamentToExtruderMap(modelSettingsXml: string): Map<number, number> {
  const { plates } = parseModelSettingsScene(modelSettingsXml)
  const maps = plates.map((plate) => plate.filamentMaps).find((entry) => entry.length > 0) ?? []
  const inverse = new Map<number, number>()
  const positive = maps.filter((value) => Number.isInteger(value) && value > 0)
  if (positive.length > 0 && new Set(positive).size === positive.length) {
    maps.forEach((filament, index) => { if (filament > 0) inverse.set(filament, index + 1) })
  }
  return inverse
}

/**
 * The 1-based old-slot → new-slot map a desired filament list implies. `sourceIndex` names the
 * 0-based old slot each new slot was seeded from (null means "same slot"); the FIRST new slot
 * referencing an old slot wins, since kept slots precede cloned adds in the desired list. An old
 * slot with no entry was removed by this save: consumers drop or default references to it.
 */
export function filamentSlotIdRemap(filaments: SceneEditFilament[]): Map<number, number> {
  const remap = new Map<number, number>()
  filaments.forEach((filament, i) => {
    const src = filament.sourceIndex ?? i
    if (src >= 0 && !remap.has(src + 1)) remap.set(src + 1, i + 1)
  })
  // Explicit replacements override template ancestry: a new slot can clone a deleted slot's
  // settings without being the material the user chose to replace it with.
  filaments.forEach((filament, index) => {
    for (const sourceIndex of filament.replacedSourceIndices ?? []) remap.set(sourceIndex + 1, index + 1)
  })
  return remap
}

/**
 * True when the remap moves nothing: every kept slot keeps its number. A pure tail shrink counts
 * as identity, a dangling reference above the new count is clamped by each consumer (BambuStudio
 * reads an out-of-range paint state / extruder as unpainted/default), so the whole-archive mesh
 * rewrites gated on this stay reserved for saves that actually permute slots.
 */
export function isIdentityFilamentSlotRemap(remap: ReadonlyMap<number, number>): boolean {
  for (const [oldId, newId] of remap) {
    if (oldId !== newId) return false
  }
  return true
}

/**
 * Re-key every 1-based filament reference in `model_settings.config` metadata: the part/object
 * `extruder` assignments plus the per-object/per-part filament-index process overrides
 * (`support_filament` and friends). A reference whose material was removed falls back the way
 * BambuStudio's delete path does: `extruder` to material 1 (a part must have SOME material), the
 * process keys to absent (their 0/"Default" state, meaning the object's own filament).
 */
export function remapModelSettingsFilamentRefs(modelSettingsXml: string, remap: ReadonlyMap<number, number>): string {
  const filamentIndexKeys = new Set(FILAMENT_INDEX_PROCESS_KEYS)
  return modelSettingsXml.replace(
    /[ \t]*<metadata\s+key="([a-z_]+)"\s+value="(\d+)"\s*\/>\n?/g,
    (block, key: string, value: string) => {
      if (key !== 'extruder' && !filamentIndexKeys.has(key)) return block
      const oldId = Number.parseInt(value, 10)
      if (!Number.isInteger(oldId) || oldId < 1) return block
      const newId = remap.get(oldId)
      if (newId != null) return newId === oldId ? block : block.replace(`value="${value}"`, `value="${newId}"`)
      return key === 'extruder' ? block.replace(`value="${value}"`, 'value="1"') : ''
    }
  )
}
