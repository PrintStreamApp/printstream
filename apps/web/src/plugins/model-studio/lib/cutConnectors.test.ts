/**
 * Cut connector geometry, checked against BambuStudio's own arithmetic.
 *
 * The rules pinned here are the ones a plausible-looking port gets wrong silently: tolerances read
 * as ratios instead of millimetres, a Prism dowel left at half the length of a Frustum one, a peg
 * grown along with its hole, and a snap built to its nominal bulge rather than its real one.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isClosedSoup } from './meshBooleanCore.js'
import {
  CONNECTOR_DEFAULTS,
  CONNECTOR_SHAPE_SIDES,
  SNAP_BULGE_PROPORTION,
  SNAP_SPACE_PROPORTION,
  connectorBoresForSide,
  connectorProblemSummary,
  connectorSoup,
  findConnectorProblems,
  isPointInsideSoup,
  connectorUnitSoup,
  connectorVolumes,
  type CutConnector
} from './cutConnectors.js'

function connector(overrides: Partial<CutConnector> = {}): CutConnector {
  return { id: 'c1', x: 0, y: 0, z: 0, ...CONNECTOR_DEFAULTS, ...overrides }
}

function bounds(soup: Float32Array) {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < soup.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = soup[i + a]!
      if (v < min[a]!) min[a] = v
      if (v > max[a]!) max[a] = v
    }
  }
  return {
    min, max,
    size: [max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!]
  }
}

/**
 * How badly a soup's faces DISAGREE about which way is out.
 *
 * A consistently oriented closed surface uses every directed edge exactly once and its reverse
 * exactly once. A flipped face shows up as one direction used twice with its reverse missing --
 * which `isClosedSoup` cannot see, because it pairs edges without regard to direction, and which
 * bounds and closedness both pass. Zero for both counts is the only acceptable answer.
 */
function orientationFaults(soup: Float32Array): { doubled: number; unmatched: number } {
  const key = (o: number) => `${soup[o]!.toFixed(5)},${soup[o + 1]!.toFixed(5)},${soup[o + 2]!.toFixed(5)}`
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

test('every connector solid is closed, so it can serve as a volume', () => {
  for (const type of ['plug', 'dowel', 'snap'] as const) {
    for (const style of ['prism', 'frustum'] as const) {
      for (const shape of ['triangle', 'square', 'hexagon', 'circle'] as const) {
        const soup = connectorUnitSoup(type, style, shape)
        assert.ok(soup.length > 0, `${type}/${style}/${shape} produced nothing`)
        assert.ok(isClosedSoup(soup), `${type}/${style}/${shape} is not a closed solid`)
      }
    }
  }
})

test('a unit body is centred on the origin whatever its builder spans', () => {
  // The bipyramid is built spanning -1..+1 and the others 0..1; only centring makes them comparable,
  // and Studio does it in `add_volume` rather than in any builder, so it is easy to miss.
  for (const [type, style] of [['plug', 'prism'], ['plug', 'frustum'], ['dowel', 'frustum'], ['snap', 'prism']] as const) {
    const { min, max } = bounds(connectorUnitSoup(type, style, 'circle'))
    for (let axis = 0; axis < 3; axis++) {
      assert.ok(Math.abs(min[axis]! + max[axis]!) < 1e-5, `${type}/${style} is off-centre on axis ${axis}`)
    }
  }
})

test('shape selects the number of sides, and a circle is coarse enough not to shed slivers', () => {
  assert.equal(CONNECTOR_SHAPE_SIDES.triangle, 3)
  // 64, not Studio's 360: we DRILL the hole, so the cut face is re-tiled around it, and a 360-gon
  // forces slivers into that tiling whose normals shade as lines. See the constant's own header.
  assert.equal(CONNECTOR_SHAPE_SIDES.circle, 64)
  // A prism emits four triangles per side (two wall, two cap).
  assert.equal(connectorUnitSoup('plug', 'prism', 'triangle').length / 9, 3 * 4)
  assert.equal(connectorUnitSoup('plug', 'prism', 'hexagon').length / 9, 6 * 4)
})

test('tolerance widens the HOLE and leaves the peg exact', () => {
  // The rule a joint depends on: grow both and the fit is loose by twice what was asked.
  const c = connector({ radius: 2, height: 6, radiusTolerance: 0.25, heightTolerance: 0.5 })
  const { upper, lower } = connectorVolumes(c, 'z')
  const hole = bounds(upper.soup)
  const peg = bounds(lower.soup)
  assert.ok(Math.abs(peg.size[0]! - 4) < 1e-3, `peg width ${peg.size[0]} should be the exact 4mm`)
  assert.ok(Math.abs(peg.size[2]! - 6) < 1e-3, `peg height ${peg.size[2]} should be the exact 6mm`)
  assert.ok(Math.abs(hole.size[0]! - 4.5) < 1e-3, `hole width ${hole.size[0]} should be 4 + 2 * 0.25`)
  assert.ok(Math.abs(hole.size[2]! - 6.5) < 1e-3, `hole depth ${hole.size[2]} should be 6 + 0.5`)
})

test('the tolerances are millimetres, not ratios', () => {
  // Studio's struct comment says [0..1] and is stale. Read as a ratio, the default 0.1 would make a
  // 1.25mm connector's hole 10% bigger rather than 0.1mm bigger, and every joint would be loose.
  const c = connector({ radius: 10, radiusTolerance: 0.1 })
  const { upper } = connectorVolumes(c, 'z')
  const width = bounds(upper.soup).size[0]!
  assert.ok(Math.abs(width - 20.2) < 1e-3, `hole width ${width} should be 20 + 2 * 0.1mm, not a 10% ratio`)
})

test('a plug stands on the cut plane; a dowel straddles it', () => {
  const plug = connectorVolumes(connector({ type: 'plug', height: 6, heightTolerance: 0 }), 'z')
  // The peg rises from the plane at z = 0 into the half above it.
  const peg = bounds(plug.lower.soup)
  assert.ok(Math.abs(peg.min[2]!) < 1e-3, `a plug's base should sit on the plane, got ${peg.min[2]}`)
  assert.ok(Math.abs(peg.max[2]! - 6) < 1e-3)

  const dowel = connectorVolumes(connector({ type: 'dowel', style: 'frustum', height: 6, heightTolerance: 0 }), 'z')
  const pin = bounds(dowel.pin!)
  assert.ok(Math.abs(pin.min[2]! + pin.max[2]!) < 1e-3, 'a dowel should straddle the plane')
})

test('a Prism dowel is doubled so it matches a Frustum one', () => {
  // Studio's `height *= 2`, which looks arbitrary until you see that the bipyramid is already two
  // units tall. Without it the two styles differ in length at the same nominal height.
  const prism = bounds(connectorVolumes(connector({ type: 'dowel', style: 'prism', height: 5, heightTolerance: 0 }), 'z').pin!)
  const frustum = bounds(connectorVolumes(connector({ type: 'dowel', style: 'frustum', height: 5, heightTolerance: 0 }), 'z').pin!)
  assert.ok(Math.abs(prism.size[2]! - 10) < 1e-3, `prism dowel ${prism.size[2]} should be 2 * 5`)
  assert.ok(Math.abs(frustum.size[2]! - 10) < 1e-3, `frustum dowel ${frustum.size[2]} should also be 2 * 5`)
})

test('a dowel holes both halves and prints a pin; a plug holes one and pegs the other', () => {
  const dowel = connectorVolumes(connector({ type: 'dowel' }), 'z')
  assert.equal(dowel.upper.subtype, 'negative_part')
  assert.equal(dowel.lower.subtype, 'negative_part')
  assert.ok(dowel.pin, 'a dowel needs a separately printed pin')

  const plug = connectorVolumes(connector({ type: 'plug' }), 'z')
  assert.equal(plug.upper.subtype, 'negative_part')
  assert.equal(plug.lower.subtype, 'normal_part')
  assert.equal(plug.pin, undefined)
})

test("a snap's socket is a plain cylinder, not the snap's own barbed outline", () => {
  // This IS the mechanism: a barbed hole could not be entered. Studio swaps the mesh at cut time.
  const snap = connectorVolumes(connector({ type: 'snap', radius: 2, radiusTolerance: 0 }), 'z')
  const socket = bounds(snap.upper.soup)
  // A cylinder is as wide as it is deep across both axes; the barbed peg is not.
  assert.ok(Math.abs(socket.size[0]! - 4) < 1e-3, `socket should be a round 4mm bore, got ${socket.size[0]}`)
  assert.ok(Math.abs(socket.size[1]! - 4) < 1e-3)
  // The peg is not round: it bulges along the axis it springs on and is cut back across the slot.
  const peg = bounds(snap.lower.soup)
  assert.ok(peg.size[0]! > peg.size[1]! + 0.1, 'the snap peg should bulge along one axis only')
})

test("the snap's bulge is its real radius, not the nominal proportion", () => {
  // (1 + 2b) / (1 + b) = 1.1304 at the default, NOT 1 + b = 1.15. Studio's `m_len` only defines the
  // flattening; porting it as the radius makes every snap slightly too fat to seat.
  const soup = connectorUnitSoup('snap', 'prism', 'circle')
  const expected = (1 + 2 * SNAP_BULGE_PROPORTION) / (1 + SNAP_BULGE_PROPORTION)
  // The bulge reaches along X, away from the slot: each lobe's arc centre is its widest point.
  const reach = bounds(soup).size[0]! / 2
  assert.ok(Math.abs(reach - expected) < 1e-3, `bulge reach ${reach} should be ${expected}`)
})

test('the snap really is two lobes with a slot between them', () => {
  // The bounding box cannot show a gap, so assert the gap directly: nothing may lie strictly inside
  // the slot. Without it the "snap" is a solid peg that cannot compress, and nothing else would say
  // so -- it would look right, seat too tightly, and snap nothing.
  const soup = connectorUnitSoup('snap', 'prism', 'circle')
  const slotHalfWidth = SNAP_SPACE_PROPORTION
  let inside = 0
  for (let i = 0; i < soup.length; i += 3) if (Math.abs(soup[i]!) < slotHalfWidth - 1e-4) inside++
  assert.equal(inside, 0, `${inside} vertices sit inside the slot, so the lobes are joined`)
})

test('a connector orients along whichever axis the cut used', () => {
  for (const axis of ['x', 'y', 'z'] as const) {
    const soup = connectorSoup(connector({ radius: 1, height: 8, type: 'plug' }), axis, { grown: false })
    const size = bounds(soup).size
    const along = axis === 'x' ? 0 : axis === 'y' ? 1 : 2
    assert.ok(Math.abs(size[along]! - 8) < 1e-3, `${axis}: the 8mm length should run along ${axis}, got ${size}`)
  }
})

test('a connector is placed where it was put on the plane', () => {
  const soup = connectorSoup(connector({ x: 12, y: -7, z: 3, radius: 1, height: 4 }), 'z', { grown: false })
  const { min, max } = bounds(soup)
  assert.ok(Math.abs((min[0]! + max[0]!) / 2 - 12) < 1e-3)
  assert.ok(Math.abs((min[1]! + max[1]!) / 2 + 7) < 1e-3)
  // Standing on the plane rather than centred on it, so its base is at the plane's own height.
  assert.ok(Math.abs(min[2]! - 3) < 1e-3, `base should rest at z = 3, got ${min[2]}`)
})

/** A 20mm cube spanning 0..20 on every axis, as the validity fixtures' object. */
function cubeSoup(): Float32Array {
  const q = (out: number[], a: number[], b: number[], c: number[], d: number[]) => out.push(...a, ...b, ...c, ...a, ...c, ...d)
  const o: number[] = []
  q(o, [0, 0, 0], [20, 0, 0], [20, 0, 20], [0, 0, 20])
  q(o, [20, 20, 0], [0, 20, 0], [0, 20, 20], [20, 20, 20])
  q(o, [0, 20, 0], [0, 0, 0], [0, 0, 20], [0, 20, 20])
  q(o, [20, 0, 0], [20, 20, 0], [20, 20, 20], [20, 0, 20])
  q(o, [0, 0, 20], [20, 0, 20], [20, 20, 20], [0, 20, 20])
  q(o, [0, 20, 0], [20, 20, 0], [20, 0, 0], [0, 0, 0])
  return new Float32Array(o)
}

test('a point is inside the cross-section only when it is inside the solid', () => {
  const cube = cubeSoup()
  // The exact CENTRE of a face is the case an axis-aligned ray gets wrong, because it leaves
  // through the shared diagonal of that face's two triangles. It is also where a user aims.
  assert.equal(isPointInsideSoup(cube, { x: 10, y: 10, z: 10 }), true, 'the dead centre must read as inside')
  assert.equal(isPointInsideSoup(cube, { x: 25, y: 10, z: 10 }), false)
  assert.equal(isPointInsideSoup(cube, { x: 5, y: 5, z: 5 }), true)
  assert.equal(isPointInsideSoup(cube, { x: -5, y: 5, z: 5 }), false)
  // Every face centre and the body centre, none of which may be confused by a diagonal.
  for (const p of [{ x: 10, y: 10, z: 0 }, { x: 10, y: 0, z: 10 }, { x: 0, y: 10, z: 10 }] as const) {
    assert.equal(isPointInsideSoup(cube, { ...p, x: p.x || 0.01, y: p.y || 0.01, z: p.z || 0.01 }), true,
      `just inside the face centre at ${JSON.stringify(p)}`)
  }
})

test('a connector off the cross-section is refused', () => {
  const cube = cubeSoup()
  const placed = connector({ id: 'off', x: 40, y: 10, z: 10, radius: 1 })
  assert.equal(findConnectorProblems([placed], cube).get('off'), 'outsideContour')
  const inside = connector({ id: 'in', x: 10, y: 10, z: 10, radius: 1 })
  assert.equal(findConnectorProblems([inside], cube).size, 0)
})

test('a connector too close to the wall is refused as out of the object', () => {
  // Inside the solid but hanging over the edge: Studio tests the bounding box separately for
  // exactly this, because the centre passing the contour test says nothing about the rim.
  const cube = cubeSoup()
  const proud = connector({ id: 'proud', x: 19.5, y: 10, z: 10, radius: 2, radiusTolerance: 0 })
  assert.equal(findConnectorProblems([proud], cube).get('proud'), 'outsideObject')
})

test('overlapping connectors are refused, on Studio\'s own crude centre-distance rule', () => {
  const cube = cubeSoup()
  const a = connector({ id: 'a', x: 10, y: 10, z: 10, radius: 2 })
  const b = connector({ id: 'b', x: 13, y: 10, z: 10, radius: 2 })
  const clash = findConnectorProblems([a, b], cube)
  assert.equal(clash.get('a'), 'overlaps')
  assert.equal(clash.get('b'), 'overlaps')
  // Just clear of each other: 4mm apart with 2mm radii touch exactly and are allowed.
  const far = connector({ id: 'b', x: 14.5, y: 10, z: 10, radius: 2 })
  assert.equal(findConnectorProblems([a, far], cube).size, 0)
})

test('the warning reads the way Studio words it', () => {
  const cube = cubeSoup()
  const problems = findConnectorProblems([
    connector({ id: 'a', x: 40, y: 10, z: 10, radius: 1 }),
    connector({ id: 'b', x: 50, y: 10, z: 10, radius: 1 })
  ], cube)
  assert.equal(connectorProblemSummary(problems), '2 connectors are out of cut contour')
  assert.equal(connectorProblemSummary(new Map()), null)
})

/** Signed volume: positive only when every face is wound outward and they agree with each other. */
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

test('every connector is wound OUTWARD, and its faces agree with each other', () => {
  // The check `isClosedSoup` cannot make. Closedness is about which edges pair up and says nothing
  // about orientation, so every shape here shipped inside out and passed its tests: a peg rendered
  // as an open tube, because backface culling hid the walls that should show and showed the ones
  // that should not. The frustum plug was worse than inverted -- its sides disagreed with its base,
  // so the solid had no consistent orientation and the two cancelled to a signed volume of zero.
  for (const type of ['plug', 'dowel', 'snap'] as const) {
    for (const style of ['prism', 'frustum'] as const) {
      for (const shape of ['triangle', 'square', 'hexagon', 'circle'] as const) {
        const label = `${type}/${style}/${shape}`
        const soup = connectorUnitSoup(type, style, shape)
        const volume = signedVolume(soup)
        assert.ok(volume > 0, `${label} is inside out (signed volume ${volume})`)
        // Volume alone is not enough, and the snap proved it: its two chord faces were wound alike,
        // which left each lobe a shell you could see straight through, and the mismatched pair still
        // summed to a healthy positive 1.96. Only the directed-edge count localises the flip.
        const { doubled, unmatched } = orientationFaults(soup)
        assert.equal(doubled, 0, `${label} uses ${doubled} directed edges twice, so a face is flipped`)
        assert.equal(unmatched, 0, `${label} has ${unmatched} directed edges whose reverse is missing`)
      }
    }
  }
})

/** Area of a regular n-gon on the unit circumcircle -- what these solids are really built from. */
function polygonArea(sides: number): number {
  return (sides / 2) * Math.sin((2 * Math.PI) / sides)
}

test('the connector solids measure their analytic volumes', () => {
  // Orientation alone would pass on a mesh that is merely consistent; these pin the actual shape.
  //
  // Measured against the POLYGON's area, not the circle's. A connector circle is a 64-gon (see
  // CONNECTOR_SHAPE_SIDES for why it is not finer), which inscribes the circle and so encloses
  // about 0.16% less -- comparing to PI would either fail or need a tolerance loose enough to stop
  // catching a real error. The n-gon formula is exact for what is actually built, so the tolerance
  // stays tight enough to be worth having.
  const near = (actual: number, expected: number, what: string) =>
    assert.ok(Math.abs(actual - expected) < 1e-6, `${what}: ${actual} should be ${expected}`)
  const disc = polygonArea(CONNECTOR_SHAPE_SIDES.circle)
  near(signedVolume(connectorUnitSoup('plug', 'prism', 'circle')), disc, 'cylinder')
  near(signedVolume(connectorUnitSoup('plug', 'frustum', 'circle')), disc / 3, 'cone')
  // The bipyramid spans -1..+1, so it is two cones base to base.
  near(signedVolume(connectorUnitSoup('dowel', 'frustum', 'circle')), (2 * disc) / 3, 'bipyramid')
  // A square "circle of radius 1" is a diamond of diagonal 2, so area 2 and volume 2 at unit height.
  near(signedVolume(connectorUnitSoup('plug', 'prism', 'square')), polygonArea(4), 'square prism')
})

test('the bores for a side keep the index of the connector each came from', () => {
  // The preview and the cut both derive their bores here, and both need to say WHICH connector a
  // drilled hole belonged to. The filter drops the peg sides, so a bare array position is not the
  // connector's -- and getting that wrong drops the wrong connector's negative volume.
  const connectors: CutConnector[] = [
    { ...CONNECTOR_DEFAULTS, id: 'a', x: 0, y: 0, z: 0, type: 'plug' },
    { ...CONNECTOR_DEFAULTS, id: 'b', x: 2, y: 0, z: 0, type: 'dowel' },
    { ...CONNECTOR_DEFAULTS, id: 'c', x: 4, y: 0, z: 0, type: 'plug' }
  ]
  // A plug is a hole ABOVE and a peg below, so the lower side yields only the dowel.
  assert.deepEqual(
    connectorBoresForSide(connectors, 'z', 'lower').map((bore) => bore.connectorIndex),
    [1]
  )
  // Every type takes a hole on the upper side.
  assert.deepEqual(
    connectorBoresForSide(connectors, 'z', 'upper').map((bore) => bore.connectorIndex),
    [0, 1, 2]
  )
})
