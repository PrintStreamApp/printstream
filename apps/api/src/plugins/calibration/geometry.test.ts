import assert from 'node:assert/strict'
import { test } from 'node:test'
import { boxMesh, flowRatioPlate, pressureAdvanceTower } from './geometry.js'

function signedVolume(positions: number[], indices: number[]): number {
  let volume = 0
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i]! * 3
    const b = indices[i + 1]! * 3
    const c = indices[i + 2]! * 3
    const ax = positions[a]!, ay = positions[a + 1]!, az = positions[a + 2]!
    const bx = positions[b]!, by = positions[b + 1]!, bz = positions[b + 2]!
    const cx = positions[c]!, cy = positions[c + 1]!, cz = positions[c + 2]!
    // (b x c) . a / 6, summed — positive for outward (CCW) winding.
    const crossX = by * cz - bz * cy
    const crossY = bz * cx - bx * cz
    const crossZ = bx * cy - by * cx
    volume += (ax * crossX + ay * crossY + az * crossZ) / 6
  }
  return volume
}

function isClosedManifold(indices: number[]): boolean {
  const edges = new Map<string, number>()
  for (let i = 0; i < indices.length; i += 3) {
    const tri = [indices[i]!, indices[i + 1]!, indices[i + 2]!]
    for (let e = 0; e < 3; e++) {
      const u = tri[e]!
      const v = tri[(e + 1) % 3]!
      const key = u < v ? `${u}_${v}` : `${v}_${u}`
      edges.set(key, (edges.get(key) ?? 0) + 1)
    }
  }
  // Every edge of a closed surface is shared by exactly two triangles.
  return [...edges.values()].every((count) => count === 2)
}

test('boxMesh is a closed manifold wound outward with the requested bounds', () => {
  const mesh = boxMesh({ width: 20, depth: 10, height: 4 }, 5, -3)
  assert.equal(mesh.positions.length, 24)
  assert.equal(mesh.indices.length, 36)
  assert.equal(isClosedManifold(mesh.indices), true)
  // Outward winding: signed volume equals the box volume (20 * 10 * 4 = 800).
  assert.equal(Math.round(signedVolume(mesh.positions, mesh.indices)), 800)
  assert.deepEqual(mesh.bounds, { min: { x: -5, y: -8, z: 0 }, max: { x: 15, y: 2, z: 4 } })
})

test('flowRatioPlate centres a patch per offset without overlap', () => {
  const offsets = [-10, 0, 10]
  // Force a single row for a deterministic centred layout.
  const patches = flowRatioPlate(offsets, { patchSize: 20, gap: 4, columns: 3 })
  assert.equal(patches.length, 3)
  assert.deepEqual(patches.map((p) => p.offsetPercent), offsets)
  // Row centred on x=0: three 20mm patches at 24mm pitch -> centres -24, 0, 24.
  const centres = patches.map((p) => (p.mesh.bounds.min.x + p.mesh.bounds.max.x) / 2)
  assert.deepEqual(centres.map((c) => Math.round(c)), [-24, 0, 24])
  // Patches do not overlap in x.
  assert.ok(patches[0]!.mesh.bounds.max.x < patches[1]!.mesh.bounds.min.x)
})

test('flowRatioPlate wraps into a centred grid and keeps patches on the bed', () => {
  const offsets = [-20, -15, -10, -5, 0, 5, 10, 15, 20]
  const patches = flowRatioPlate(offsets, { patchSize: 20, gap: 4 })
  assert.equal(patches.length, 9)
  // Whole grid stays well within a 256mm bed when centred at the origin.
  const xs = patches.flatMap((p) => [p.mesh.bounds.min.x, p.mesh.bounds.max.x])
  const ys = patches.flatMap((p) => [p.mesh.bounds.min.y, p.mesh.bounds.max.y])
  assert.ok(Math.max(...xs) - Math.min(...xs) < 128)
  assert.ok(Math.max(...ys) - Math.min(...ys) < 128)
})

test('pressureAdvanceTower height equals the K-step count in mm', () => {
  const tower = pressureAdvanceTower(0, 0.1, 0.002)
  // (0.1 - 0) / 0.002 = 50 steps -> 50mm.
  assert.equal(tower.heightMm, 50)
  assert.equal(tower.mesh.bounds.max.z, 50)
  // OrcaSlicer's 70x70mm tower footprint (bounding box), centred at origin.
  assert.equal(tower.mesh.bounds.max.x - tower.mesh.bounds.min.x, 70)
  assert.equal(tower.mesh.bounds.max.y - tower.mesh.bounds.min.y, 70)
  assert.equal(isClosedManifold(tower.mesh.indices), true)
})
