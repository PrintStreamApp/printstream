/**
 * Replace a session material without renumbering surviving ids. The material controller owns
 * positional process settings and the bake's base-slot aliases; this module owns scene uses.
 * Returns a new state so one combined history frame can restore both ownership domains.
 */
import { isNonRenderableThreeMfPartSubtype, type SceneEditFilament } from '@printstream/shared'
import { addedPartHostId, effectiveHeightRanges, rebaseEditorStateFilamentIds, type EditorState } from './editorModel'
import { collectColorPaintFilamentIds } from './supportPaint'
import { remapColorPaintCode } from './trianglePaintTree'
import { permuteFilamentIndexOverrides, permutePerObjectFilamentIndexOverrides } from '../../../lib/filamentIndexOverrides'

/** Collect effective printed-material uses, including unassigned imports inheriting the first slot. */
export function sceneObjectMaterialIds(state: EditorState | null, sessionIds: readonly number[]): Set<number> {
  const used = new Set<number>()
  for (const plate of state?.plates ?? []) {
    for (const instance of plate.instances) {
      const fallback = instance.filamentId ?? sessionIds[0]
      const hostId = addedPartHostId(instance)
      const parts = [...instance.parts, ...(hostId == null ? [] : state?.addedParts?.[hostId] ?? [])]
      if (instance.parts.length === 0 && fallback != null) used.add(fallback)
      for (const part of parts) {
        if (isNonRenderableThreeMfPartSubtype(part.subtype ?? null)) continue
        const id = part.filamentId ?? fallback
        if (id != null) used.add(id)
      }
    }
  }
  return used
}

/** Replace explicit references and the deleted default without changing surviving session ids. */
export function replaceEditorMaterial(
  state: EditorState,
  sessionIds: number[],
  removedId: number,
  replacementId: number
): EditorState {
  const ids = new Map(sessionIds.map((id) => [id, id === removedId ? replacementId : id]))
  const positions = new Map<number, number>()
  const survivors = sessionIds.filter((id) => id !== removedId)
  sessionIds.forEach((id, index) => positions.set(index + 1, survivors.indexOf(id === removedId ? replacementId : id) + 1))
  const next = rebaseEditorStateFilamentIds(state, ids)
  next.baseFilamentIds = { ...next.baseFilamentIds }
  // Base codes have not followed earlier replacements. Compose instead of applying the latest
  // deletion to them twice, and retain identities so a later session renumber is unambiguous.
  for (const id of sessionIds) {
    if (!(id in next.baseFilamentIds)) next.baseFilamentIds[id] = ids.get(id)!
  }
  if (next.partProcessOverrides) {
    next.partProcessOverrides = permutePerObjectFilamentIndexOverrides(next.partProcessOverrides, positions)
  }
  if (next.addedParts) {
    next.addedParts = Object.fromEntries(Object.entries(next.addedParts).map(([key, parts]) => [key, parts.map((part) => ({
      ...part,
      ...(part.settings ? { settings: permuteFilamentIndexOverrides(part.settings, positions) as Record<string, string> } : {})
    }))]))
  }
  const mapRanges = (ranges: ReturnType<typeof effectiveHeightRanges>) => ranges.map((range) => ({
    ...range,
    settings: {
      ...permuteFilamentIndexOverrides(range.settings, positions),
      ...(range.settings.extruder ? { extruder: String(positions.get(Number(range.settings.extruder)) ?? 0) } : {})
    } as Record<string, string>
  }))
  // Seeded bands must become explicit edits too; otherwise the unchanged sidecar restores
  // references to the deleted material when this scene is saved.
  next.heightRanges = { ...state.heightRanges }
  for (const plate of state.plates) {
    for (const instance of plate.instances) {
      const ranges = effectiveHeightRanges(state, instance)
      const hostId = addedPartHostId(instance)
      if (ranges.length && hostId != null) next.heightRanges[hostId] = mapRanges(ranges)
    }
  }
  for (const plate of next.plates) {
    for (const instance of plate.instances) {
      // Null is a real use of the first slot, not an absent assignment. Keep helper parts
      // inheriting their host, but pin that host before deletion changes the default slot.
      const fallback = instance.filamentId ?? (sessionIds[0] === removedId ? replacementId : null)
      instance.filamentId = fallback
    }
    if (plate.firstLayerFilamentSequence) plate.firstLayerFilamentSequence = [...new Set(plate.firstLayerFilamentSequence)]
    for (const range of plate.otherLayerFilamentSequences ?? []) range.filamentIds = [...new Set(range.filamentIds)]
  }
  return next
}

/** Remap untouched base colour paint lazily, including meshes on plates not built yet. */
export function remapBaseMaterialPaint(state: EditorState | null, codes: Record<number, string> | null): Record<number, string> | null {
  if (!codes || !state?.baseFilamentIds) return codes
  const ids = new Set<number>()
  for (const code of Object.values(codes)) collectColorPaintFilamentIds(code, ids)
  const remap = new Map([...ids].map((id) => [id, state.baseFilamentIds?.[id] ?? id]))
  return Object.fromEntries(Object.entries(codes).map(([index, code]) => [index, remapColorPaintCode(code, remap)]))
}

/** Bind references from pinned base bytes to the current ordered slots, across repeated saves. */
export function withBaseMaterialReferences(
  filaments: SceneEditFilament[],
  sessionIds: number[],
  baseIds: Record<number, number> | undefined
): SceneEditFilament[] {
  // Frames captured before the first remap still speak the original base id space. Their
  // configuration sourceIndex may have moved after a save, so it cannot identify base paint.
  const references = baseIds ?? Object.fromEntries(sessionIds.map((id) => [id, id]))
  return filaments.map((filament, index) => ({
    ...filament,
    replacedSourceIndices: Object.entries(references)
      .filter(([, id]) => id === sessionIds[index])
      .map(([baseId]) => Number(baseId) - 1)
  }))
}

/**
 * Source slots may occur in untouched paint even when the plate index reports no use. A sliced
 * index only reports what printed, so it cannot prove absence on skipped objects either.
 * Keep this uncertainty separate from actual usage (which controls towers and material badges).
 * Undefined source ids mean the index is still loading; an empty list means no base materials.
 */
export function unverifiedSourceMaterialIds(
  sourceIds: readonly number[] | undefined,
  baseIds: Record<number, number> | undefined,
  sessionIds: readonly number[]
): Set<number> {
  const surviving = new Set(sessionIds)
  // Saves can shorten the current index while paint still comes from the original pinned bytes.
  // Once available, the complete base map is authoritative, not that shortened index's keys.
  const candidates = baseIds ? Object.values(baseIds) : sourceIds ?? sessionIds
  return new Set(candidates.filter((id) => surviving.has(id)))
}
