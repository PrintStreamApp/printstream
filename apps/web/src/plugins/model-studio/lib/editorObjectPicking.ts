/**
 * Interprets viewport ray hits for object selection and brim-ear edits.
 * The caller aims the shared raycaster first and owns the resulting selection or edit.
 */
import * as THREE from 'three'
import { BRIM_EAR_MARKER_NAME } from '../editorGeometry'

export type BrimEarPick =
  | { kind: 'add'; group: THREE.Group; worldPoint: THREE.Vector3 }
  | { kind: 'remove'; index: number }

/** Return the selected instance ancestor of the nearest hit, ignoring stale scene groups. */
export function pickEditorInstanceGroup(
  raycaster: THREE.Raycaster,
  groups: Map<string, THREE.Group>
): THREE.Group | null {
  const hits = raycaster.intersectObjects(Array.from(groups.values()), true)
  for (const hit of hits) {
    let node: THREE.Object3D | null = hit.object
    while (node) {
      const key = node.userData.instanceKey
      if (typeof key === 'string' && groups.has(key)) return node as THREE.Group
      node = node.parent
    }
  }
  return null
}

/** Prefer an ear marker at the model surface; otherwise add at the printable mesh hit. */
export function pickBrimEarEdit(
  raycaster: THREE.Raycaster,
  group: THREE.Group,
  meshHit: { point: THREE.Vector3 } | null
): BrimEarPick | null {
  const markers: THREE.Object3D[] = []
  group.traverse((node) => {
    if (node.name === BRIM_EAR_MARKER_NAME) markers.push(node)
  })

  const markerHit = raycaster.intersectObjects(markers, false)[0]
  const meshDistance = meshHit ? meshHit.point.distanceTo(raycaster.ray.origin) : Infinity
  if (markerHit && markerHit.distance <= meshDistance + 0.5) {
    const index = markerHit.object.userData.brimEarIndex
    if (typeof index === 'number') return { kind: 'remove', index }
  }
  return meshHit ? { kind: 'add', group, worldPoint: meshHit.point } : null
}
