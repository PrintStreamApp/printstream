/**
 * Reads the manual transform panel's display values from the live gizmo target.
 * Objects use plate-local placement, added parts use object-local TRS, and baked
 * or imported parts compose their drag group with the baked child matrix.
 */
import * as THREE from 'three'
import { partGroupRef, rotorOf, type SelectedTransform } from '../editorGeometry'

function transformDisplayValues(
  position: THREE.Vector3,
  rotation: THREE.Euler,
  scale: THREE.Vector3
): SelectedTransform {
  return {
    position: { x: position.x, y: position.y, z: position.z },
    rotationDeg: {
      x: THREE.MathUtils.radToDeg(rotation.x),
      y: THREE.MathUtils.radToDeg(rotation.y),
      z: THREE.MathUtils.radToDeg(rotation.z)
    },
    scalePct: { x: scale.x * 100, y: scale.y * 100, z: scale.z * 100 }
  }
}

/** Return display units for one live selection, or null until its part mesh exists. */
export function computeEditorSelectedTransform(object: THREE.Object3D): SelectedTransform | null {
  if (typeof object.userData.addedPartKey === 'string') {
    return transformDisplayValues(object.position, object.rotation, object.scale)
  }
  if (partGroupRef(object)) {
    const mesh = object.children.find((child) => (child as THREE.Mesh).isMesh === true)
    if (!mesh) return null
    object.updateMatrix()
    mesh.updateMatrix()
    const effective = new THREE.Matrix4().multiplyMatrices(object.matrix, mesh.matrix)
    const position = new THREE.Vector3()
    const quaternion = new THREE.Quaternion()
    const scale = new THREE.Vector3()
    effective.decompose(position, quaternion, scale)
    return transformDisplayValues(position, new THREE.Euler().setFromQuaternion(quaternion, 'XYZ'), scale)
  }
  return transformDisplayValues(object.position, rotorOf(object).rotation, object.scale)
}
