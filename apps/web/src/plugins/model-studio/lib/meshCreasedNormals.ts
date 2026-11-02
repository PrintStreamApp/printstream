/**
 * Smooth mesh normals at exact shared positions without changing geometry or triangle order.
 * Used by both STL imports and reopened 3MFs through meshParseCore. A fixed positional
 * tolerance is unsafe before instance scale: tiny source meshes can be enlarged hundreds
 * of times. Three's creased-normal helper also rounds position keys, so normal adjacency
 * is keyed by the original coordinates here, independently of the model's size or offset.
 */
import * as THREE from 'three'

/** Return triangle-soup geometry with crease-aware normals; every corner position is preserved. */
export function meshWithCreasedNormals(geometry: THREE.BufferGeometry, creaseAngle: number): THREE.BufferGeometry {
  const result = geometry.index ? geometry.toNonIndexed() : geometry.clone()
  const positions = result.getAttribute('position')
  const adjacentNormals = new Map<string, THREE.Vector3[]>()
  const keys: string[] = []
  const faceNormals: THREE.Vector3[] = []
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  const ab = new THREE.Vector3()
  const ac = new THREE.Vector3()
  for (let corner = 0; corner + 2 < positions.count; corner += 3) {
    a.fromBufferAttribute(positions, corner)
    b.fromBufferAttribute(positions, corner + 1)
    c.fromBufferAttribute(positions, corner + 2)
    const normal = new THREE.Vector3().crossVectors(ab.subVectors(b, a), ac.subVectors(c, a)).normalize()
    faceNormals.push(normal)
    for (let offset = 0; offset < 3; offset += 1) {
      const index = corner + offset
      const key = `${positions.getX(index)},${positions.getY(index)},${positions.getZ(index)}`
      keys.push(key)
      const normals = adjacentNormals.get(key)
      if (normals) normals.push(normal)
      else adjacentNormals.set(key, [normal])
    }
  }
  const creaseDot = Math.cos(creaseAngle)
  const normals = new Float32Array(positions.count * 3)
  const sum = new THREE.Vector3()
  for (let corner = 0; corner < keys.length; corner += 1) {
    const normal = faceNormals[Math.floor(corner / 3)]!
    sum.set(0, 0, 0)
    for (const adjacent of adjacentNormals.get(keys[corner]!)!) {
      if (normal.dot(adjacent) > creaseDot) sum.add(adjacent)
    }
    sum.normalize().toArray(normals, corner * 3)
  }
  result.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  return result
}
