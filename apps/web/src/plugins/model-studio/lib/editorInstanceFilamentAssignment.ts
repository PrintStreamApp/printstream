/**
 * Plans a whole-object filament change across linked editor instances and session-added volumes.
 * Single-mesh models carry material on the instance, whereas multi-part models carry it on their
 * printed parts. `assignInstanceFilament` handles both; this module resolves object identity so
 * linked copies and their printable added volumes change together. The caller records one
 * plate-edit checkpoint, then applies the volume keys without another.
 */
import { threeMfPartSubtypeCarriesFilament } from '@printstream/shared'
import {
  addedPartHostId,
  assignInstanceFilament,
  type EditorInstance,
  type EditorPlate,
  type EditorState
} from './editorModel'

export interface InstanceFilamentAssignment {
  mapPlates: (plates: EditorPlate[]) => EditorPlate[]
  addedPartKeys: string[]
}

/**
 * Resolve selected instance keys to object identities before React applies the plate update.
 * Linked copies share an identity; a body-only change leaves added volumes untouched.
 */
export function planInstanceFilamentAssignment(
  state: EditorState | null,
  keys: readonly string[],
  filamentId: number,
  options: { includeVolumes?: boolean } = {}
): InstanceFilamentAssignment | null {
  const keySet = new Set(keys)
  if (keySet.size === 0) return null

  const ownerIds = new Set<number>()
  for (const plate of state?.plates ?? []) {
    for (const instance of plate.instances) {
      if (!keySet.has(instance.key)) continue
      const ownerId = addedPartHostId(instance)
      if (ownerId != null) ownerIds.add(ownerId)
    }
  }

  const targeted = (instance: EditorInstance) => {
    const ownerId = addedPartHostId(instance)
    return keySet.has(instance.key) || (ownerId != null && ownerIds.has(ownerId))
  }

  const addedPartKeys = (options.includeVolumes === false ? [] : Object.entries(state?.addedParts ?? {}))
    .filter(([hostId]) => ownerIds.has(Number(hostId)))
    .flatMap(([, parts]) => parts)
    .filter((part) => threeMfPartSubtypeCarriesFilament(part.subtype))
    .map((part) => part.key)

  return {
    mapPlates: (plates) => plates.map((plate) => ({
      ...plate,
      instances: plate.instances.map((instance) => (targeted(instance)
        ? assignInstanceFilament(instance, filamentId)
        : instance))
    })),
    addedPartKeys
  }
}
