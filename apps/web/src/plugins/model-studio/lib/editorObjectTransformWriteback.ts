/**
 * Writes live object transforms into the editor model and converts a foreign
 * exact matrix when the user takes ownership of its transform. Placement of
 * an unedited exact-matrix object follows a different rule: `placeInstanceAt`
 * shifts its exact matrix without discarding shear.
 */
import type * as THREE from 'three'
import { rotorOf } from '../editorGeometry'
import type { EditorInstance, EditorState } from './editorModel'

/** Find the instance named by a live group, including one on an inactive plate. */
function instanceForGroup(state: EditorState | null, group: THREE.Object3D): EditorInstance | null {
  const key = group.userData.instanceKey
  if (typeof key !== 'string') return null
  for (const plate of state?.plates ?? []) {
    const instance = plate.instances.find((entry) => entry.key === key)
    if (instance) return instance
  }
  return null
}

/** Mutate the matching instance after a live object or gizmo drag. */
export function writeBackEditorObjectTransform(state: EditorState | null, group: THREE.Object3D): void {
  const instance = instanceForGroup(state, group)
  if (!instance) return
  instance.position.copy(group.position)
  instance.rotation.copy(rotorOf(group).rotation)
  instance.scale.copy(group.scale)
}

/**
 * Replace exact-matrix rendering with the editor's editable T-S-R form before
 * a user transform. The source instance already holds the decomposed mirror.
 */
export function prepareEditorObjectTransform(state: EditorState | null, group: THREE.Object3D): void {
  const instance = instanceForGroup(state, group)
  if (!instance?.exactMatrix) return
  instance.exactMatrix = undefined
  group.matrixAutoUpdate = true
  group.position.copy(instance.position)
  group.scale.copy(instance.scale)
  rotorOf(group).rotation.copy(instance.rotation)
}
