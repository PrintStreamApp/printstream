/**
 * Stages and commits selected objects as one printable mesh while preserving their plate-space
 * placement. Helper volumes are excluded by collectWorldTriangles and reported to the caller.
 * A staged result is discarded if its source scene changes before the import finishes.
 */
import type { StagedImport } from '@printstream/shared'
import * as THREE from 'three'
import type { EditorImportStore } from './editorImportStore'
import { instanceFromStagedImport, type EditorInstance, type EditorPlate, type EditorState } from './editorModel'
import { collectWorldTriangles, rebaseTriangleSoup, triangleSoupToBinaryStl } from './meshCut'

export interface StagedObjectAssembly {
  import: StagedImport
  offset: { x: number; y: number; z: number }
}

/** Combine the selected world-space meshes and stage one normalized object for the active host. */
export async function stageEditorObjectAssembly(
  groups: readonly THREE.Group[],
  name: string,
  store: Pick<EditorImportStore, 'stageFile'>
): Promise<StagedObjectAssembly> {
  const soups = groups.map((group) => collectWorldTriangles(group))
  const length = soups.reduce((sum, soup) => sum + soup.length, 0)
  if (length === 0) throw new Error('The selected objects have no printable geometry to assemble.')

  const combined = new Float32Array(length)
  let writeOffset = 0
  for (const soup of soups) {
    combined.set(soup, writeOffset)
    writeOffset += soup.length
  }

  const { offset } = rebaseTriangleSoup(combined)
  const stl = triangleSoupToBinaryStl(combined)
  const file = new File([stl], `${name} (assembled).stl`, { type: 'application/octet-stream' })
  return { import: await store.stageFile(file, 'object'), offset }
}

export interface EditorObjectAssemblyOptions {
  keys: readonly string[]
  plateIndex: number
  stateRef: { current: EditorState | null }
  groups: ReadonlyMap<string, THREE.Group>
  importStore: Pick<EditorImportStore, 'stageFile' | 'meshUrl'>
  countHelperVolumes: (instance: EditorInstance, group: THREE.Group) => number
  updatePlates: (updater: (plates: EditorPlate[]) => EditorPlate[]) => void
}

export interface EditorObjectAssemblyResult {
  key: string
  count: number
  discardedHelpers: number
}

/** Merge live selected models in one plate edit, or return null if the source scene went away. */
export async function commitEditorObjectAssembly(
  options: EditorObjectAssemblyOptions
): Promise<EditorObjectAssemblyResult | null> {
  if (options.keys.length < 2) return null

  const sourceState = options.stateRef.current
  const plate = sourceState?.plates.find((entry) => entry.index === options.plateIndex)
  if (!plate) return null
  const members = options.keys
    .map((key) => ({
      instance: plate.instances.find((entry) => entry.key === key),
      group: options.groups.get(key)
    }))
    .filter((entry): entry is { instance: EditorInstance; group: THREE.Group } =>
      Boolean(entry.instance && entry.group))
  if (members.length < 2) return null

  const discardedHelpers = members.reduce((total, member) =>
    total + options.countHelperVolumes(member.instance, member.group), 0)
  const staged = await stageEditorObjectAssembly(
    members.map((member) => member.group),
    members[0]!.instance.name,
    options.importStore
  )

  // A late stage must not replace a new project or a source object deleted during the await.
  const livePlate = options.stateRef.current?.plates.find((entry) => entry.index === options.plateIndex)
  if (options.stateRef.current !== sourceState || !livePlate ||
    members.some((member) => !livePlate.instances.includes(member.instance))) return null

  const next = instanceFromStagedImport(staged.import, options.importStore.meshUrl)
  next.position.set(staged.offset.x, staged.offset.y, 0)
  next.filamentId = members[0]!.instance.filamentId
  next.printable = members.every((member) => member.instance.printable)
  const keySet = new Set(options.keys)
  options.updatePlates((plates) => plates.map((entry) =>
    entry.index === options.plateIndex
      ? { ...entry, instances: [...entry.instances.filter((item) => !keySet.has(item.key)), next] }
      : entry
  ))
  return { key: next.key, count: members.length, discardedHelpers }
}
