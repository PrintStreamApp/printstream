/**
 * Built-in primitive shapes for the editor's "Add primitive" menu (Bambu Studio's
 * cube / cylinder / sphere / cone). Each primitive is produced as a world-unit
 * triangle soup (9 floats per triangle) sitting ON the bed (min z = 0) and centred
 * on the XY origin, ready for the staged-import pipeline (binary STL upload).
 */
import * as THREE from 'three'

export type PrimitiveKind = 'cube' | 'cylinder' | 'sphere' | 'cone'

export const PRIMITIVE_LABELS: Record<PrimitiveKind, string> = {
  cube: 'Cube',
  cylinder: 'Cylinder',
  sphere: 'Sphere',
  cone: 'Cone'
}

/** Default sizes (mm), matching Bambu Studio's primitives. */
function buildPrimitiveGeometry(kind: PrimitiveKind): THREE.BufferGeometry {
  switch (kind) {
    case 'cube':
      return new THREE.BoxGeometry(20, 20, 20)
    case 'cylinder':
      return new THREE.CylinderGeometry(10, 10, 20, 48)
    case 'sphere':
      return new THREE.SphereGeometry(10, 48, 32)
    case 'cone':
      return new THREE.ConeGeometry(10, 20, 48)
  }
}

/** Triangle soup for a primitive: Z-up, base resting at z = 0, centred on XY. */
export function primitiveTriangleSoup(kind: PrimitiveKind): Float32Array {
  const geometry = buildPrimitiveGeometry(kind).toNonIndexed()
  // Three.js primitives are Y-up; the bed is Z-up.
  geometry.rotateX(Math.PI / 2)
  geometry.computeBoundingBox()
  const minZ = geometry.boundingBox?.min.z ?? 0
  geometry.translate(0, 0, -minZ)
  const positions = geometry.getAttribute('position')
  const soup = new Float32Array(positions.array.length)
  soup.set(positions.array as Float32Array)
  geometry.dispose()
  return soup
}

/**
 * Cube soup for an added PART volume (negative part / modifier / support blocker):
 * `size` mm per side, centred on the origin so the part places at a point inside the
 * parent object rather than resting on the bed.
 */
export function primitivePartSoup(size: number): Float32Array {
  const geometry = new THREE.BoxGeometry(size, size, size).toNonIndexed()
  const positions = geometry.getAttribute('position')
  const soup = new Float32Array(positions.array.length)
  soup.set(positions.array as Float32Array)
  geometry.dispose()
  return soup
}
