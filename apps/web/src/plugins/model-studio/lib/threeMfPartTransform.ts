/**
 * Decodes baked 3MF component transforms when a tool promotes a saved part for editing.
 *
 * Part transforms use Three.js T*R*S composition. Object instances use the editor's
 * T*S*R convention instead, so their decomposeInstanceTransform policy is not interchangeable.
 */
import * as THREE from 'three'
import { createThreeMfMatrix } from './threeMfScene'

/** Preserve a saved part's full position, rotation, and scale for text or SVG re-editing. */
export function decomposeThreeMfPartTransform(transform: number[]): {
  position: THREE.Vector3
  rotation: THREE.Euler
  scale: THREE.Vector3
} {
  const position = new THREE.Vector3()
  const quaternion = new THREE.Quaternion()
  const scale = new THREE.Vector3()
  createThreeMfMatrix(transform).decompose(position, quaternion, scale)
  return { position, rotation: new THREE.Euler().setFromQuaternion(quaternion), scale }
}
