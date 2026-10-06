/**
 * Reads and writes one process-settings dialog across baked parts, object bodies,
 * and session-added volumes. Baked/body overrides live in the state map; added
 * volumes own theirs. Cleared baked slots stay explicit so source metadata is removed.
 */
import type { ProcessSettingOverrides } from '@printstream/shared'
import { applyBulkOverridesToMember } from '../../../lib/processBulkOverrides'
import {
  addedPartHostId,
  BODY_PART_INDEX,
  effectiveAddedParts,
  partSlotKey,
  type EditorState
} from './editorModel'
import type { PartMember, PartRef, PartSelection } from './selectionModel'

export interface EditorPartProcessSettingsTarget {
  objectId: number
  members: ReadonlyArray<PartMember>
  name: string
}

/** Resolve the menu's bulk or gizmo selection into a named part-settings target. */
export function editorPartProcessSettingsTarget(
  state: EditorState | null,
  bulk: PartSelection | null,
  gizmoPart: PartRef | null
): EditorPartProcessSettingsTarget | null {
  const selection = bulk ?? (gizmoPart
    ? { objectId: gizmoPart.objectId, members: [gizmoPart.member] }
    : null)
  if (!selection || selection.members.length === 0) return null

  const owner = state?.plates.flatMap((plate) => plate.instances)
    .find((instance) => addedPartHostId(instance) === selection.objectId)
  if (selection.members.length > 1) {
    return {
      objectId: selection.objectId,
      members: [...selection.members],
      name: `${selection.members.length} parts`
    }
  }

  const only = selection.members[0]!
  let name: string | null | undefined
  switch (only.kind) {
    case 'baked':
      name = owner?.parts.find((part) => part.partIndex === only.partIndex)?.name
      break
    case 'added':
      name = owner && effectiveAddedParts(state, owner).find((part) => part.key === only.key)?.name
      break
    case 'body':
      name = owner?.name
      break
  }
  return { objectId: selection.objectId, members: [only], name: name ?? 'Part' }
}

/** Return one override map per selected member in dialog order. */
export function readEditorPartProcessOverrides(
  state: EditorState | null,
  target: EditorPartProcessSettingsTarget
): ProcessSettingOverrides[] {
  const owner = state?.plates.flatMap((plate) => plate.instances)
    .find((instance) => addedPartHostId(instance) === target.objectId)
  const volumes = new Map(
    (owner ? effectiveAddedParts(state, owner) : []).map((part) => [part.key, part])
  )
  return target.members.map((member) => {
    if (member.kind === 'added') return volumes.get(member.key)?.settings ?? {}
    const slot = partSlotKey(target.objectId,
      member.kind === 'baked' ? member.partIndex : BODY_PART_INDEX)
    return state?.partProcessOverrides?.[slot] ?? {}
  })
}

/**
 * Apply a bulk dialog result in one editor-state update.
 * Untouched mixed keys stay per member; an explicit empty baked/body entry clears
 * old settings from the source archive when the project is next saved.
 */
export function applyEditorPartProcessOverrides(
  state: EditorState,
  target: EditorPartProcessSettingsTarget,
  overrides: ProcessSettingOverrides,
  clearedKeys: readonly string[]
): EditorState {
  const serialized: Record<string, string> = {}
  for (const [key, value] of Object.entries(overrides)) {
    serialized[key] = Array.isArray(value) ? value.join(';') : value
  }
  const map = { ...(state.partProcessOverrides ?? {}) }
  const owner = state.plates.flatMap((plate) => plate.instances)
    .find((instance) => addedPartHostId(instance) === target.objectId)
  const volumes = new Map(
    (owner ? effectiveAddedParts(state, owner) : []).map((part) => [part.key, part])
  )

  for (const member of target.members) {
    if (member.kind === 'added') {
      const volume = volumes.get(member.key)
      if (!volume) continue
      const merged = applyBulkOverridesToMember(volume.settings, serialized, clearedKeys)
      // These volumes have no source metadata to clear, so an empty map can be omitted.
      if (Object.keys(merged).length === 0) delete volume.settings
      else volume.settings = merged
      continue
    }
    const slot = partSlotKey(target.objectId,
      member.kind === 'baked' ? member.partIndex : BODY_PART_INDEX)
    map[slot] = applyBulkOverridesToMember(map[slot], serialized, clearedKeys)
  }
  return { ...state, partProcessOverrides: map }
}
