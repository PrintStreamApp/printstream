/**
 * Replace a session material without renumbering surviving ids. The material controller owns
 * positional process settings and the bake's base-slot aliases; this module owns scene uses.
 * Returns a new state so one combined history frame can restore both ownership domains.
 */
import { FILAMENT_INDEX_PROCESS_KEYS, isNonRenderableThreeMfPartSubtype, type SceneEditFilament } from '@printstream/shared'
import { addedPartHostId, addedPartPaintKey, effectiveAddedParts, effectiveFilamentChanges, effectiveHeightRanges, partSlotKey, rebaseEditorStateFilamentIds, supportPaintKey, type EditorState } from './editorModel'
import { collectColorPaintFilamentIds } from './supportPaint'
import { decodePaintTree, remapColorPaintCode } from './trianglePaintTree'
import type { ThreeMfArchive } from './threeMfArchive'
import { permuteFilamentIndexOverrides, permutePerObjectFilamentIndexOverrides } from '../../../lib/filamentIndexOverrides'

/** Collect effective printed-material uses, including unassigned imports inheriting the first slot. */
export function sceneObjectMaterialIds(state: EditorState | null, sessionIds: readonly number[]): Set<number> {
  const used = new Set<number>()
  for (const plate of state?.plates ?? []) {
    for (const instance of plate.instances) {
      const fallback = instance.filamentId ?? sessionIds[0]
      const hostId = addedPartHostId(instance)
      const parts = [...instance.parts, ...(hostId == null ? [] : state?.addedParts?.[hostId] ?? [])]
      if (instance.parts.length === 0 && !instance.bodyRemoved && fallback != null) used.add(fallback)
      for (const part of parts) {
        if (isNonRenderableThreeMfPartSubtype(part.subtype ?? null)) continue
        const id = part.filamentId ?? fallback
        if (id != null) used.add(id)
      }
    }
  }
  return used
}

/** Read positive material positions from process settings; zero means the object's default. */
function filamentSettingRefs(overrides: Record<string, string | string[]> | undefined, keys: readonly string[] = FILAMENT_INDEX_PROCESS_KEYS): number[] {
  if (!overrides) return []
  const ids: number[] = []
  for (const key of keys) {
    const raw = overrides[key]
    for (const value of Array.isArray(raw) ? raw : [raw]) {
      const id = value != null ? Number.parseInt(value, 10) : Number.NaN
      if (Number.isInteger(id) && id > 0) ids.push(id)
    }
  }
  return ids
}

interface MaterialUsageInputs {
  state: EditorState | null
  sessionIds: readonly number[]
  bakedSupportIds?: readonly number[]
  processOverrides?: {
    globalOverrides: Record<string, string | string[]>
    value: Record<string, Record<string, string | string[]>>
  } | null
}

/**
 * Resolve current material references for removal, badges, and prime towers. Scene maps can retain
 * entries for deleted objects, so only settings and paint attached to live geometry are counted.
 * Source paint needs the separate archive scan and readiness guard below.
 */
export function editorMaterialUsage({ state, sessionIds, bakedSupportIds, processOverrides }: MaterialUsageInputs): {
  objectIds: Set<number>
  supportIds: Set<number>
} {
  const objectIds = sceneObjectMaterialIds(state, sessionIds)
  const supportIds = new Set<number>()
  const liveHostIds = new Set<number>()
  const settingMaps: Array<Record<string, string | string[]>> = []

  for (const plate of state?.plates ?? []) {
    for (const instance of plate.instances) {
      const hostId = addedPartHostId(instance)
      if (hostId != null) liveHostIds.add(hostId)
      if (!instance.bodyRemoved && instance.filamentId != null) objectIds.add(instance.filamentId)
      for (const part of instance.parts) {
        if (part.filamentId != null) objectIds.add(part.filamentId)
        if (hostId != null) {
          const settings = state?.partProcessOverrides?.[partSlotKey(hostId, part.partIndex)]
          if (settings) settingMaps.push(settings)
        }
      }
      for (const part of effectiveAddedParts(state, instance)) {
        if (part.filamentId != null) objectIds.add(part.filamentId)
        if (part.settings) settingMaps.push(part.settings)
      }
      for (const range of effectiveHeightRanges(state, instance)) settingMaps.push(range.settings)
    }
    for (const change of effectiveFilamentChanges(plate)) objectIds.add(change.filamentId)
  }

  for (const settings of settingMaps) {
    for (const position of [...filamentSettingRefs(settings), Number(settings.extruder ?? 0)]) {
      const id = sessionIds[position - 1]
      if (id != null) objectIds.add(id)
    }
  }
  for (const id of liveColorPaintMaterialIds(state)) objectIds.add(id)

  for (const id of bakedSupportIds ?? []) supportIds.add(state?.baseFilamentIds?.[id] ?? id)
  if (processOverrides) {
    const supportKeys = ['support_filament', 'support_interface_filament']
    const otherKeys = FILAMENT_INDEX_PROCESS_KEYS.filter((key) => !supportKeys.includes(key))
    const settings = [processOverrides.globalOverrides,
      ...Object.entries(processOverrides.value)
        .filter(([hostId]) => liveHostIds.has(Number(hostId)))
        .map(([, overrides]) => overrides)]
    for (const overrides of settings) {
      for (const position of filamentSettingRefs(overrides, supportKeys)) {
        const id = sessionIds[position - 1]
        if (id != null) supportIds.add(id)
      }
      for (const position of filamentSettingRefs(overrides, otherKeys)) {
        const id = sessionIds[position - 1]
        if (id != null) objectIds.add(id)
      }
    }
  }
  return { objectIds, supportIds }
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
 * A scanned source paint id needs replacement even if it has not entered the live plate state.
 * Until that scan succeeds, every surviving source slot stays guarded. A sliced index cannot
 * prove absence on skipped objects or unopened paint. Keep this guard separate from actual usage,
 * which controls towers and material badges.
 */
export function unverifiedSourceMaterialIds(
  sourceIds: readonly number[] | undefined,
  baseIds: Record<number, number> | undefined,
  sessionIds: readonly number[],
  sourcePaintIds?: ReadonlySet<number>
): Set<number> {
  const surviving = new Set(sessionIds)
  // Until the archive scan completes, retain the original conservative guard. The pinned base
  // bytes can outlive a save that shortened the current index.
  let candidates: number[] | readonly number[]
  if (sourcePaintIds) {
    candidates = [...sourcePaintIds].map((id) => baseIds?.[id] ?? id)
  } else if (baseIds) {
    candidates = Object.values(baseIds)
  } else {
    candidates = sourceIds ?? sessionIds
  }
  return new Set(candidates.filter((id) => surviving.has(id)))
}

/**
 * Index source colour paint by model entry and mesh id. A split paint code can name several
 * materials; unrecognized paint or XML makes absence unprovable, so the caller keeps the
 * conservative replacement prompt when this scan throws.
 */
export function sourceColorPaintMaterialIds(archive: ThreeMfArchive): Map<string, Set<number>> {
  const byMesh = new Map<string, Set<number>>()
  for (const entryPath of archive.entryNames()) {
    if (!entryPath.toLowerCase().endsWith('.model')) continue
    const xml = archive.entryText(entryPath)
    if (xml == null) throw new Error(`Missing model entry: ${entryPath}`)
    let scannedPaintCount = 0
    for (const object of xml.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/g)) {
      const paintCodes = [...object[2]!.matchAll(/\bpaint_color\s*=\s*["']([^"']*)["']/g)]
      if (paintCodes.length === 0) continue
      const objectId = object[1]!.match(/\bid\s*=\s*["'](\d+)["']/)?.[1]
      if (!objectId) throw new Error(`Painted object without an id in ${entryPath}`)
      const ids = new Set<number>()
      for (const match of paintCodes) {
        const code = match[1]!
        if (!decodePaintTree(code)) throw new Error(`Unrecognized colour paint in ${entryPath}`)
        collectColorPaintFilamentIds(code, ids)
        scannedPaintCount++
      }
      byMesh.set(`${entryPath}:${Number(objectId)}`, ids)
    }
    // Unknown XML structure must keep the removal guard conservative, not silently drop paint.
    if (scannedPaintCount !== [...xml.matchAll(/\bpaint_color\s*=\s*["']([^"']*)["']/g)].length) {
      throw new Error(`Colour paint outside a model object in ${entryPath}`)
    }
  }
  return byMesh
}

/** Source paint counts only while its mesh is still present and has no complete session override. */
export function liveSourceColorPaintMaterialIds(state: EditorState | null, byMesh: ReadonlyMap<string, ReadonlySet<number>>): Set<number> {
  const ids = new Set<number>()
  for (const plate of state?.plates ?? []) {
    for (const instance of plate.instances) {
      if (instance.source.kind !== 'object') continue
      for (const part of instance.parts) {
        if (isNonRenderableThreeMfPartSubtype(part.subtype ?? null)) continue
        if (state?.partMeshReplacements?.[partSlotKey(instance.objectId, part.partIndex)]) continue
        if (Object.hasOwn(state?.colorPaint ?? {}, supportPaintKey(instance.objectId, part.componentObjectId))) continue
        for (const id of byMesh.get(`${part.entryPath}:${part.componentObjectId}`) ?? []) ids.add(id)
      }
    }
  }
  return ids
}

/** Session paint on deleted objects or parts does not use a material in the current scene. */
export function liveColorPaintMaterialIds(state: EditorState | null): Set<number> {
  const ids = new Set<number>()
  const liveKeys = new Set<string>()
  for (const plate of state?.plates ?? []) {
    for (const instance of plate.instances) {
      const hostId = addedPartHostId(instance)
      if (hostId == null) continue
      for (const part of instance.parts) {
        if (!isNonRenderableThreeMfPartSubtype(part.subtype ?? null)) {
          liveKeys.add(supportPaintKey(hostId, part.componentObjectId))
        }
      }
      if (instance.source.kind === 'import' && instance.parts.length === 0 && !instance.bodyRemoved) {
        liveKeys.add(supportPaintKey(hostId, 0))
      }
      for (const part of effectiveAddedParts(state, instance)) {
        if (!isNonRenderableThreeMfPartSubtype(part.subtype ?? null)) liveKeys.add(addedPartPaintKey(part.importId))
      }
    }
  }
  for (const key of liveKeys) {
    for (const code of Object.values(state?.colorPaint?.[key] ?? {})) collectColorPaintFilamentIds(code, ids)
  }
  return ids
}
