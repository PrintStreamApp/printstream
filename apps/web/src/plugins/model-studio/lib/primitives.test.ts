/**
 * The primitives have to be CLOSED SOLIDS, not merely correct-looking meshes.
 *
 * They are generated geometry, so nothing upstream can be blamed and nothing downstream repairs
 * them: `buildStlGeometry`, which is the staged-import path a primitive travels, deliberately does
 * not weld. An unclosed one renders and slices fine and fails only at the mesh boolean's
 * closed-operand gate, which refuses it as "not a closed solid" and points the user at Repair mesh
 * for geometry the editor made itself.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isClosedSoup } from './meshBooleanCore.js'
import { PRIMITIVE_LABELS, primitivePartSoup, primitiveTriangleSoup, type PrimitiveKind } from './primitives.js'

const KINDS = Object.keys(PRIMITIVE_LABELS) as PrimitiveKind[]

/** Six times the enclosed volume via the divergence theorem; sign follows the winding. */
function signedVolume(soup: Float32Array): number {
  let total = 0
  for (let o = 0; o + 8 < soup.length; o += 9) {
    const ax = soup[o]!, ay = soup[o + 1]!, az = soup[o + 2]!
    const bx = soup[o + 3]!, by = soup[o + 4]!, bz = soup[o + 5]!
    const cx = soup[o + 6]!, cy = soup[o + 7]!, cz = soup[o + 8]!
    total += (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6
  }
  return total
}

/**
 * Directed-edge disagreement: a consistently oriented closed surface uses every directed edge once
 * and its reverse once. `isClosedSoup` pairs edges WITHOUT direction, so it cannot see a flipped
 * face; this can.
 */
function orientationFaults(soup: Float32Array): { doubled: number; unmatched: number } {
  const key = (o: number) => `${soup[o]},${soup[o + 1]},${soup[o + 2]}`
  const directed = new Map<string, number>()
  for (let o = 0; o + 8 < soup.length; o += 9) {
    const corners = [key(o), key(o + 3), key(o + 6)]
    for (let i = 0; i < 3; i++) {
      const edge = `${corners[i]}>${corners[(i + 1) % 3]}`
      directed.set(edge, (directed.get(edge) ?? 0) + 1)
    }
  }
  let doubled = 0
  let unmatched = 0
  for (const [edge, uses] of directed) {
    if (uses > 1) doubled++
    const [from, to] = edge.split('>')
    if (!directed.has(`${to}>${from}`)) unmatched++
  }
  return { doubled, unmatched }
}

test('every primitive is a closed solid, in both of its flavours', () => {
  // The seam was the failure: three.js writes a primitive's seam column twice, at `u = 0` and
  // `u = 1`, and the pair lands ~1e-15 apart because one comes from `angle = 0` and the other from
  // `angle = 2 * PI`. Cube passed throughout (a box has no seam), so a cube-only fixture proves
  // nothing here -- the round shapes are the whole point of this test.
  for (const kind of KINDS) {
    assert.ok(isClosedSoup(primitivePartSoup(kind, 10)), `the ${kind} PART soup is not a closed solid`)
    assert.ok(isClosedSoup(primitiveTriangleSoup(kind)), `the ${kind} OBJECT soup is not a closed solid`)
  }
})

test('every primitive agrees with itself about which way is out', () => {
  for (const kind of KINDS) {
    const soup = primitivePartSoup(kind, 10)
    const { doubled, unmatched } = orientationFaults(soup)
    assert.equal(doubled, 0, `the ${kind} uses ${doubled} directed edges twice, so a face is flipped`)
    assert.equal(unmatched, 0, `the ${kind} has ${unmatched} directed edges whose reverse is missing`)
    assert.ok(signedVolume(soup) > 0, `the ${kind} is wound inside out`)
  }
})

test('welding the seam changes connectivity without moving the surface', () => {
  // The repair may only merge points that were already coincident. A volume that shifts means it
  // moved geometry, which would change what the user sees and prints.
  const near = (actual: number, expected: number, what: string) =>
    assert.ok(Math.abs(actual - expected) < 0.01, `${what}: ${actual} should still be ${expected}`)
  near(signedVolume(primitivePartSoup('cube', 10)), 1000, 'a 10mm cube')
  // The round shapes are polygonal, so they inscribe just under the ideal figure; these are the
  // values measured BEFORE the weld, which is the point.
  near(signedVolume(primitivePartSoup('cylinder', 10)), 783.16, 'a 48-sided cylinder')
  near(signedVolume(primitivePartSoup('sphere', 10)), 520.85, 'a 48x32 sphere')
  near(signedVolume(primitivePartSoup('cone', 10)), 261.05, 'a 48-sided cone')
})

test('a part soup is centred on every axis and an object soup rests on the bed', () => {
  // The two flavours differ ONLY in framing, and the difference is load-bearing: a part is placed
  // by one point inside its host, an object stands on the plate.
  for (const kind of KINDS) {
    const part = primitivePartSoup(kind, 10)
    const object = primitiveTriangleSoup(kind)
    const extent = (soup: Float32Array, axis: number) => {
      let min = Infinity
      let max = -Infinity
      for (let i = axis; i < soup.length; i += 3) {
        min = Math.min(min, soup[i]!)
        max = Math.max(max, soup[i]!)
      }
      return { min, max }
    }
    for (let axis = 0; axis < 3; axis++) {
      const { min, max } = extent(part, axis)
      assert.ok(Math.abs(min + max) < 1e-5, `the ${kind} part is off-centre on axis ${axis}`)
    }
    assert.ok(Math.abs(extent(object, 2).min) < 1e-5, `the ${kind} object does not rest at z = 0`)
  }
})
