/**
 * Three.js geometry adapters for placing text against an existing scene.
 *
 * The pure contour math lives in textSurfaceProjection.ts. These helpers read
 * exactly the vetted host meshes so a text part cannot project onto itself.
 */
import * as THREE from 'three'

/**
 * World-space triangles of specific meshes.
 *
 * Unlike `collectWorldTriangles`, which walks a whole group, this takes exactly the meshes the
 * caller vetted -- which for text means the host without the text's own part, since a Join part is
 * printed geometry and every group walk keeps it.
 */
export function worldTrianglesOf(meshes: readonly THREE.Mesh[]): Float32Array {
  const chunks: Float32Array[] = []
  let total = 0
  const vertex = new THREE.Vector3()
  for (const mesh of meshes) {
    const position = mesh.geometry.getAttribute('position')
    if (!position) continue
    mesh.updateWorldMatrix(true, false)
    const out = new Float32Array(position.count * 3)
    for (let i = 0; i < position.count; i += 1) {
      vertex.fromBufferAttribute(position as THREE.BufferAttribute, i).applyMatrix4(mesh.matrixWorld)
      out[i * 3] = vertex.x
      out[i * 3 + 1] = vertex.y
      out[i * 3 + 2] = vertex.z
    }
    chunks.push(out)
    total += out.length
  }
  const soup = new Float32Array(total)
  let offset = 0
  for (const chunk of chunks) { soup.set(chunk, offset); offset += chunk.length }
  return soup
}

/** Dot product of a projection-module vector against a three.js one. */
export function dotVec(a: { x: number; y: number; z: number }, b: THREE.Vector3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z
}

/**
 * The surface nearest a free point in space, with the normal it faces there.
 *
 * Used to re-seat DRAGGED text: the gizmo yields a position, and the placement needs the surface
 * under it. Six axis rays rather than a true closest-point query, because the answer only has to be
 * good enough to pick a face and its normal, and this needs no acceleration structure to stay
 * responsive during a drag.
 *
 * Rays are cast from OUTSIDE the model inward, not outward from the anchor: a point that has drifted
 * off the model sees nothing along an outward ray, and a point inside a wall sees the wall's back.
 * Casting inward finds the near face from either side, which is what makes text keep its grip while
 * the pointer wanders off the geometry and back on.
 */
export function nearestSurfaceAt(anchor: THREE.Vector3, targets: readonly THREE.Mesh[], box: THREE.Box3):
{ point: THREE.Vector3; normal: THREE.Vector3 } | null {
  if (targets.length === 0 || box.isEmpty()) return null
  const reach = box.getSize(new THREE.Vector3()).length()
  if (reach <= 0) return null
  const directions = [
    new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0),
    new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0),
    new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1)
  ]
  let best: { hit: THREE.Intersection; distance: number } | null = null
  const raycaster = new THREE.Raycaster()
  for (const direction of directions) {
    raycaster.set(anchor.clone().addScaledVector(direction, -reach), direction)
    raycaster.far = reach * 2
    for (const hit of raycaster.intersectObjects(targets as THREE.Mesh[], false)) {
      const distance = hit.point.distanceTo(anchor)
      if (!best || distance < best.distance) best = { hit, distance }
    }
  }
  if (!best?.hit.face) return null
  return {
    point: best.hit.point.clone(),
    normal: best.hit.face.normal.clone().transformDirection(best.hit.object.matrixWorld).normalize()
  }
}
