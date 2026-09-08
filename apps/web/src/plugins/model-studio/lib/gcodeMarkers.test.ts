/**
 * The marker geometry's four silent failure modes.
 *
 * Every one of these is invisible when wrong: a flipped winding disappears under front-side
 * culling and reads as "markers do not render", a wrong `layerIndexEnd` scrubs the wrong range, an
 * off-by-one on the index-width switch wraps indices into garbage triangles only past 6553 markers,
 * and the Z offset is a fraction of a millimetre. None of them throws.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildGcodeMarkerGeometry } from './gcodeMarkers'

type Parsed = Parameters<typeof buildGcodeMarkerGeometry>[0]

/** `markers` is [x, y, z, kind, width, height] per marker; `layerEnd` is cumulative per layer. */
function parsed(markers: number[][], layerEnd: number[]): Parsed {
  return {
    markerPositions: new Float32Array(markers.flatMap((m) => [m[0]!, m[1]!, m[2]!])),
    markerKinds: new Uint8Array(markers.map((m) => m[3]!)),
    markerWidths: new Float32Array(markers.map((m) => m[4]!)),
    markerHeights: new Float32Array(markers.map((m) => m[5]!)),
    markerLayerEnd: layerEnd,
    layerCount: layerEnd.length
  }
}

test('every diamond triangle faces outward, so nothing is culled away', () => {
  // The preview renders front-side only. A reversed winding is not a subtle shading difference,
  // it is an invisible marker, and it looks identical to the feature not being wired up.
  const built = buildGcodeMarkerGeometry(parsed([[10, 20, 1, 0, 0.4, 0.2]], [1]), 0)
  const position = built.geometry.getAttribute('position')
  const index = built.geometry.getIndex()!
  const centre = { x: 10, y: 20, z: 1 - 0.2 * 0.5 }

  for (let tri = 0; tri < index.count / 3; tri++) {
    const [ia, ib, ic] = [index.getX(tri * 3), index.getX(tri * 3 + 1), index.getX(tri * 3 + 2)]
    const a = { x: position.getX(ia), y: position.getY(ia), z: position.getZ(ia) }
    const b = { x: position.getX(ib), y: position.getY(ib), z: position.getZ(ib) }
    const c = { x: position.getX(ic), y: position.getY(ic), z: position.getZ(ic) }
    const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }
    const ac = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z }
    const normal = {
      x: ab.y * ac.z - ab.z * ac.y,
      y: ab.z * ac.x - ab.x * ac.z,
      z: ab.x * ac.y - ab.y * ac.x
    }
    // From the body's centre toward the face: an outward normal agrees with it.
    const outward = {
      x: (a.x + b.x + c.x) / 3 - centre.x,
      y: (a.y + b.y + c.y) / 3 - centre.y,
      z: (a.z + b.z + c.z) / 3 - centre.z
    }
    const dot = normal.x * outward.x + normal.y * outward.y + normal.z * outward.z
    assert.ok(dot > 0, `triangle ${tri} is wound inward (dot ${dot})`)
  }
})

test('the diamond straddles the bead, offset by half the UNSCALED layer height', () => {
  // Studio centres it half a layer height below the move (`LegacyRenderer.cpp:1232`). Using the
  // 1.5x-scaled height instead would float the marker off the bead it marks.
  const height = 0.2
  const built = buildGcodeMarkerGeometry(parsed([[0, 0, 5, 0, 0.4, height]], [1]), 0)
  const position = built.geometry.getAttribute('position')
  let minZ = Infinity
  let maxZ = -Infinity
  for (let v = 0; v < position.count; v++) {
    minZ = Math.min(minZ, position.getZ(v))
    maxZ = Math.max(maxZ, position.getZ(v))
  }
  assert.ok(Math.abs((minZ + maxZ) / 2 - (5 - height * 0.5)) < 1e-6, `centre ${(minZ + maxZ) / 2}`)
  // And the body itself IS scaled: 1.5x the layer height, apex to apex.
  assert.ok(Math.abs((maxZ - minZ) - height * 1.5) < 1e-6, `height ${maxZ - minZ}`)
})

test('layerIndexEnd is a cumulative INDEX count, per layer, for this kind only', () => {
  // The scrub sets a draw range from these, so they count indices rather than markers, and a
  // marker of another kind must not advance them.
  const built = buildGcodeMarkerGeometry(parsed([
    [0, 0, 0, 0, 0.4, 0.2],  // layer 0, kind 0
    [1, 0, 0, 1, 0.4, 0.2],  // layer 0, kind 1: not ours
    [2, 0, 1, 0, 0.4, 0.2],  // layer 1, kind 0
    [3, 0, 2, 1, 0.4, 0.2]   // layer 2, kind 1: not ours
  ], [2, 3, 4]), 0)

  const perMarkerIndices = built.geometry.getIndex()!.count / built.markerCount
  assert.equal(built.markerCount, 2)
  assert.deepEqual(built.layerIndexEnd, [perMarkerIndices, perMarkerIndices * 2, perMarkerIndices * 2])
  // Non-decreasing, and the last entry covers the whole buffer, or the top of the slider hides
  // markers that exist.
  assert.equal(built.layerIndexEnd.at(-1), built.geometry.getIndex()!.count)
})

test('a kind with no markers builds nothing but still answers the scrub', () => {
  const built = buildGcodeMarkerGeometry(parsed([[0, 0, 0, 1, 0.4, 0.2]], [1]), 0)
  assert.equal(built.markerCount, 0)
  assert.deepEqual(built.layerIndexEnd, [0], 'one entry per layer, so the slider can still index it')
  assert.equal(built.geometry.getIndex(), null)
})

test('the index array widens exactly when a Uint16 can no longer address the vertices', () => {
  // 10 vertices per marker. Uint16 addresses 0..65535, so 65536 vertices is the last that fits and
  // the switch belongs at ">", not ">=". One off here wraps indices silently and draws garbage
  // triangles only on plates past ~6553 markers of one kind.
  const many = (count: number) => parsed(
    Array.from({ length: count }, (_, i) => [i, 0, 0, 0, 0.4, 0.2]),
    [count]
  )
  const fits = buildGcodeMarkerGeometry(many(6553), 0)   // 65530 vertices
  const overflows = buildGcodeMarkerGeometry(many(6554), 0) // 65540 vertices

  assert.equal(fits.geometry.getAttribute('position').count, 65530)
  assert.ok(fits.geometry.getIndex()!.array instanceof Uint16Array)
  assert.equal(overflows.geometry.getAttribute('position').count, 65540)
  assert.ok(overflows.geometry.getIndex()!.array instanceof Uint32Array)
  // The highest index actually written must be addressable by the type chosen for it.
  const index = fits.geometry.getIndex()!
  let highest = 0
  for (let i = 0; i < index.count; i++) highest = Math.max(highest, index.getX(i))
  assert.ok(highest <= 65535, `highest index ${highest} does not fit a Uint16`)
})
