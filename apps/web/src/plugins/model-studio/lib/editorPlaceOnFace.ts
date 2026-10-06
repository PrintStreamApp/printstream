/**
 * Owns the viewport's place-on-face geometry change after the pointer has picked a face.
 *
 * The picked normal belongs to the visible pre-bake pose. Read it before converting an
 * exact-matrix object, then keep the printable footprint centred while resting it on the bed.
 */
import * as THREE from 'three'
import { DOWN_VECTOR, printableMeshBox, restObjectOnBed, rotorOf } from '../editorGeometry'

export interface PlaceOnFaceOptions {
  group: THREE.Group
  hit: { object: THREE.Object3D; face?: { normal: THREE.Vector3 } | null }
  recordHistory: () => void
  bakeExactMatrix: (group: THREE.Group) => void
  writeBackGroupTransform: (group: THREE.Group) => void
}

/** Place a picked face on the bed. Returns false for a hit without a face. */
export function placeObjectOnFace(options: PlaceOnFaceOptions): boolean {
  const { group, hit, recordHistory, bakeExactMatrix, writeBackGroupTransform } = options
  if (!hit.face) return false

  recordHistory()
  const worldNormal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize()
  bakeExactMatrix(group)

  // Rotating an off-centre object's geometry about its origin shifts its footprint sideways.
  const beforeBox = printableMeshBox(group, false)
  rotorOf(group).quaternion.premultiply(new THREE.Quaternion().setFromUnitVectors(worldNormal, DOWN_VECTOR))
  restObjectOnBed(group)
  const afterBox = printableMeshBox(group, false)
  if (!beforeBox.isEmpty() && !afterBox.isEmpty()) {
    group.position.x += (beforeBox.min.x + beforeBox.max.x) / 2 - (afterBox.min.x + afterBox.max.x) / 2
    group.position.y += (beforeBox.min.y + beforeBox.max.y) / 2 - (afterBox.min.y + afterBox.max.y) / 2
  }

  writeBackGroupTransform(group)
  return true
}
