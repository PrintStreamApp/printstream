/**
 * The repair that lets a boolean's result be booleaned again.
 *
 * The bug these pin: chaining two booleans in the editor failed with "That operand is not a closed
 * solid" on a mesh the tool itself had just produced. The cause was not a hole -- the union of two
 * overlapping cubes comes back at exactly the right volume -- but T-junctions, which an edge-pairing
 * test cannot tell from a boundary.
 *
 * The whole risk in this area is a repair that is too eager, so the negative cases carry as much
 * weight as the positive ones: a genuine hole must still read as open afterwards, and a healthy mesh
 * must come back untouched rather than rebuilt.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { evaluateMeshBooleanSoups, isClosedSoup } from './meshBooleanCore.js'
import { healTriangleSoupTJunctions } from './meshTJunctions.js'

function quad(out: number[], a: number[], b: number[], c: number[], d: number[]): void {
  out.push(...a, ...b, ...c, ...a, ...c, ...d)
}

/** An axis-aligned box, optionally missing its lid so it has a genuine boundary. */
function boxSoup(
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  options: { lidless?: boolean } = {}
): Float32Array {
  const o: number[] = []
  quad(o, [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1])
  quad(o, [x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1])
  quad(o, [x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1])
  quad(o, [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1])
  if (!options.lidless) quad(o, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1])
  quad(o, [x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0])
  return new Float32Array(o)
}

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

const CUBE_A = boxSoup(0, 0, 0, 10, 10, 10)
const CUBE_B = boxSoup(5, 5, 5, 15, 15, 15)

test('a union can be used as an operand for the next boolean', async () => {
  // The reported defect, end to end: two overlapping cubes joined, then cut by a third. Before the
  // repair this threw MeshBooleanOpenOperandError on the union's own output.
  const union = await evaluateMeshBooleanSoups('union', [CUBE_A, CUBE_B])
  assert.ok(isClosedSoup(union), 'the tool refuses geometry it produced itself')
  const chained = await evaluateMeshBooleanSoups('difference', [union], [boxSoup(-1, -1, -1, 6, 6, 6)])
  assert.ok(chained.length > 0)
})

test('every operation returns something closed enough to reuse', async () => {
  for (const operation of ['union', 'difference', 'intersection'] as const) {
    const result = await evaluateMeshBooleanSoups(
      operation,
      operation === 'difference' ? [CUBE_A] : [CUBE_A, CUBE_B],
      operation === 'difference' ? [CUBE_B] : []
    )
    assert.ok(isClosedSoup(result), `${operation} produced an unusable result`)
  }
})

test('healing changes connectivity without moving the surface', async () => {
  // The repair may only ADD vertices that the mesh already carries. A volume that shifts means it
  // invented a coordinate, which is how a repair closes a real hole by lying about it.
  const union = await evaluateMeshBooleanSoups('union', [CUBE_A, CUBE_B])
  assert.ok(Math.abs(signedVolume(union) - 1875) < 1e-3, `union volume drifted to ${signedVolume(union)}`)
})

test('a genuine hole is still reported as open after healing', async () => {
  // The critical negative. A lidless box is deficient exactly as a T-junction is, but no vertex lies
  // inside its rim, so nothing is split and it must stay open.
  const lidless = boxSoup(0, 0, 0, 10, 10, 10, { lidless: true })
  assert.equal(isClosedSoup(lidless), false, 'the fixture is not actually open')
  const healed = healTriangleSoupTJunctions(lidless)
  assert.equal(isClosedSoup(healed), false, 'healing closed a hole it should have left alone')
})

test('a mesh with nothing wrong is returned as the very same array', () => {
  // Not merely equal: identical, so the common path costs one analysis and no rebuild.
  assert.equal(healTriangleSoupTJunctions(CUBE_A), CUBE_A)
})

test('a lone T-junction is split, and only where a vertex really lies on the edge', () => {
  // Two triangles meeting a third whose long edge they subdivide. Closed as a surface patch is not
  // the point here -- the point is that the long edge stops being used once.
  const soup = new Float32Array([
    // The undivided face, spanning 0,0 to 2,0.
    0, 0, 0, 2, 0, 0, 1, 1, 0,
    // Its neighbours below, meeting at the T-vertex (1,0).
    0, 0, 0, 1, -1, 0, 1, 0, 0,
    1, 0, 0, 1, -1, 0, 2, 0, 0
  ])
  const healed = healTriangleSoupTJunctions(soup)
  assert.equal(healed.length / 9, 4, 'the spanning triangle should have become two')
  // The T-vertex must now appear in the split triangles at exactly its original coordinates.
  const corners: string[] = []
  for (let o = 0; o + 2 < healed.length; o += 3) corners.push(`${healed[o]},${healed[o + 1]},${healed[o + 2]}`)
  assert.ok(corners.filter((c) => c === '1,0,0').length >= 4, 'the split did not reuse the T-vertex')
})

test('a vertex merely NEAR an edge is not treated as lying on it', () => {
  // The tolerance is relative to the model, and deliberately far tighter than any weld. A vertex a
  // visible distance off the line belongs to a separate feature.
  const soup = new Float32Array([
    0, 0, 0, 2, 0, 0, 1, 1, 0,
    0, 0, 0, 1, -1, 0, 1, 0.05, 0,
    1, 0.05, 0, 1, -1, 0, 2, 0, 0
  ])
  assert.equal(healTriangleSoupTJunctions(soup), soup, 'a nearby vertex was stitched onto the edge')
})

/** Sum of absolute triangle areas: subdividing must not change it, overlapping triangles do. */
function totalArea(soup: Float32Array): number {
  let area = 0
  for (let o = 0; o + 8 < soup.length; o += 9) {
    const ux = soup[o + 3]! - soup[o]!, uy = soup[o + 4]! - soup[o + 1]!, uz = soup[o + 5]! - soup[o + 2]!
    const vx = soup[o + 6]! - soup[o]!, vy = soup[o + 7]! - soup[o + 1]!, vz = soup[o + 8]! - soup[o + 2]!
    area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2
  }
  return area
}

test('an edge carrying SEVERAL T-vertices subdivides without overlapping itself', () => {
  // Two edges of one triangle each carry two T-vertices. That combination is what exposes the
  // ordering of the splits handed to the fan: with one split per edge a reversal is a no-op, and
  // every box fixture above has exactly one, so the whole class is invisible to them.
  const big = [0, 0, 0, 3, 0, 0, 0, 3, 0]
  const below = [
    0, 0, 0, 1, 0, 0, 0, -1, 0,
    1, 0, 0, 2, 0, 0, 0, -1, 0,
    2, 0, 0, 3, 0, 0, 0, -1, 0
  ]
  const left = [
    0, 3, 0, 0, 2, 0, -1, 0, 0,
    0, 2, 0, 0, 1, 0, -1, 0, 0,
    0, 1, 0, 0, 0, 0, -1, 0, 0
  ]
  const soup = new Float32Array([...big, ...below, ...left])
  const before = totalArea(soup)
  const healed = healTriangleSoupTJunctions(soup)
  assert.ok(healed.length > soup.length, 'the spanning triangle should have been subdivided')
  // Healing only ADDS connectivity, so the surface it covers cannot grow. Overlap shows up here.
  assert.ok(
    Math.abs(totalArea(healed) - before) < 1e-3,
    `area changed from ${before} to ${totalArea(healed)}: the subdivision overlaps itself`
  )
})
