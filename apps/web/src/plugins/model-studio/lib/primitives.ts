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
 * Primitive soup for an added PART volume (normal part / negative part / modifier / support
 * blocker or enforcer), scaled so its largest dimension is `size` mm and centred on the ORIGIN in
 * every axis — unlike {@link primitiveTriangleSoup}, whose primitives rest on the bed. Centring is
 * what lets the caller place the part by a single point relative to its host model, and it makes
 * the gizmo pivot the part's own centre rather than a corner.
 */
export function primitivePartSoup(kind: PrimitiveKind, size: number): Float32Array {
  const geometry = buildPrimitiveGeometry(kind).toNonIndexed()
  // Three.js primitives are Y-up; parts live in the host's Z-up object space.
  geometry.rotateX(Math.PI / 2)
  geometry.computeBoundingBox()
  const box = geometry.boundingBox
  if (box) {
    const extent = Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z)
    const center = box.getCenter(new THREE.Vector3())
    geometry.translate(-center.x, -center.y, -center.z)
    if (extent > 0) geometry.scale(size / extent, size / extent, size / extent)
  }
  const positions = geometry.getAttribute('position')
  const soup = new Float32Array(positions.array.length)
  soup.set(positions.array as Float32Array)
  geometry.dispose()
  return soup
}
