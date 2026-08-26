import assert from 'node:assert/strict'
import test from 'node:test'
import {
  flatLayerHeightProfile,
  isFlatLayerHeightProfile,
  layerHeightAt,
  MIN_PROFILE_PAIRS,
  normalizeLayerHeightProfile,
  parseLayerHeightProfiles,
  serializeLayerHeightProfiles
} from './layer-height-profile.js'
import {
  adaptiveLayerHeightProfile,
  paintLayerHeightProfile,
  smoothLayerHeightProfile
} from './layer-height-adaptive.js'

/** Build order gives ordinals 1..3 to object ids 7, 4, 9. */
const ROOT_MODEL = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter">
  <resources>
    <object id="7" type="model"><mesh/></object>
    <object id="4" type="model"><mesh/></object>
    <object id="9" type="model"><mesh/></object>
  </resources>
  <build><item objectid="7"/><item objectid="4"/><item objectid="9"/></build>
</model>`

const BOUNDS = { min: 0.07, max: 0.3 }

function assertInvariants(profile: readonly number[], objectHeight: number, label: string) {
  assert.equal(profile.length % 2, 0, `${label}: even length`)
  assert.ok(profile.length >= MIN_PROFILE_PAIRS * 2, `${label}: at least ${MIN_PROFILE_PAIRS} pairs`)
  assert.equal(profile[0], 0, `${label}: starts at z=0`)
  assert.ok(Math.abs(profile[profile.length - 2]! - objectHeight) < 1e-6, `${label}: ends at the object top`)
  for (let i = 2; i < profile.length; i += 2) {
    assert.ok(profile[i]! >= profile[i - 2]!, `${label}: z non-decreasing at ${i}`)
  }
  for (let i = 1; i < profile.length; i += 2) {
    assert.ok(profile[i]! >= BOUNDS.min - 1e-9 && profile[i]! <= BOUNDS.max + 1e-9,
      `${label}: height ${profile[i]} inside the extruder band`)
  }
}

test('height is linearly interpolated between control points, not stepped', () => {
  const profile = [0, 0.1, 10, 0.3]
  assert.equal(layerHeightAt(profile, 0), 0.1)
  assert.ok(Math.abs(layerHeightAt(profile, 5) - 0.2) < 1e-9, 'midpoint is the mean, not a step')
  assert.equal(layerHeightAt(profile, 10), 0.3)
  assert.equal(layerHeightAt(profile, 99), 0.3, 'above the top holds the last height')
})

test('a flat profile carries three pairs, because BambuStudio rejects two', () => {
  const flat = flatLayerHeightProfile(20, 0.2)
  assert.equal(flat.length, MIN_PROFILE_PAIRS * 2)
  assertInvariants(flat, 20, 'flat')
  assert.ok(isFlatLayerHeightProfile(flat))
})

test('normalize anchors the profile to the object and clamps into the extruder band', () => {
  // Unsorted, unanchored, and out of band on both sides.
  const messy = [12, 0.9, 3, 0.001, 8, 0.25]
  const profile = normalizeLayerHeightProfile(messy, 20, BOUNDS)
  assert.ok(profile)
  assertInvariants(profile!, 20, 'normalized')
})

test('normalize pads a two-pair profile rather than emitting one Studio would reject', () => {
  // Studio writes at size>=4 but rejects at size<=4 (bbs_3mf.cpp:7612 vs :2940), so a 2-pair
  // profile round-trips to nothing. Padding is what stops a silent loss.
  const profile = normalizeLayerHeightProfile([0, 0.2, 20, 0.2], 20, BOUNDS)
  assert.ok(profile)
  assert.ok(profile!.length >= MIN_PROFILE_PAIRS * 2, `got ${profile!.length} values`)
  assertInvariants(profile!, 20, 'padded')
})

test('normalize refuses an object with no height rather than emitting a broken profile', () => {
  assert.equal(normalizeLayerHeightProfile([0, 0.2, 5, 0.2], 0, BOUNDS), null)
  assert.equal(normalizeLayerHeightProfile([], 20, BOUNDS), null)
})

test('profiles parse onto the right OBJECT IDS via the 1-based ordinal', () => {
  const text = 'object_id=1|0.000000;0.200000;10.000000;0.150000;20.000000;0.200000\n'
    + 'object_id=3|0.000000;0.100000;5.000000;0.100000;10.000000;0.100000\n'
  const parsed = parseLayerHeightProfiles(text, ROOT_MODEL)
  assert.deepEqual([...parsed.keys()].sort((a, b) => a - b), [7, 9])
  assert.deepEqual(parsed.get(7), [0, 0.2, 10, 0.15, 20, 0.2])
})

test('a malformed profile line is skipped, never zero-filled', () => {
  // BambuStudio's atof turns a bad token into 0, which collapses the object onto the bed.
  const text = [
    'object_id=1|0.0;0.2;nonsense;0.2;20.0;0.2',   // unparseable
    'object_id=2|0.0;0.2;20.0;0.2',                 // too short for Studio's own reader
    'object_id=2|0.0;0.2;10.0;0.2;20.0',            // odd length
    'object_id=3|0.0;0.1;5.0;0.1;10.0;0.1'          // good
  ].join('\n')
  const parsed = parseLayerHeightProfiles(text, ROOT_MODEL)
  assert.deepEqual([...parsed.keys()], [9], 'only the well-formed line survives')
})

test('profiles serialize to Studio six-decimal form against the SAVED ordinals', () => {
  const text = serializeLayerHeightProfiles(
    [{ objectId: 9, profile: [0, 0.1, 5, 0.1, 10, 0.1] }], ROOT_MODEL)
  assert.equal(text, 'object_id=3|0.000000;0.100000;5.000000;0.100000;10.000000;0.100000\n')
})

test('a profile too short or odd is dropped rather than written', () => {
  assert.equal(serializeLayerHeightProfiles([{ objectId: 7, profile: [0, 0.2, 20, 0.2] }], ROOT_MODEL), '')
  assert.equal(serializeLayerHeightProfiles([{ objectId: 7, profile: [0, 0.2, 10, 0.2, 20] }], ROOT_MODEL), '')
  assert.equal(serializeLayerHeightProfiles([], ROOT_MODEL), '', 'empty clears the file')
})

test('a profile round-trips through serialize and parse', () => {
  const profile = [0, 0.2, 10, 0.12, 20, 0.28]
  const reparsed = parseLayerHeightProfiles(
    serializeLayerHeightProfiles([{ objectId: 7, profile }], ROOT_MODEL), ROOT_MODEL)
  assert.deepEqual(reparsed.get(7), profile)
})

// --- algorithms ---------------------------------------------------------------------------------

/**
 * A UV sphere resting on the bed: near-horizontal at both poles (shallow, wants fine layers) and
 * vertical at the equator (wants coarse ones). A CONE is the wrong fixture here — its slope is
 * uniform, so the correct adaptive answer for one is a constant height, which cannot distinguish a
 * working implementation from a broken one.
 */
function sphereSoup(radius: number, segments = 48, rings = 48): Float32Array {
  const out: number[] = []
  const point = (i: number, j: number) => {
    const phi = (Math.PI * i) / rings
    const theta = (2 * Math.PI * j) / segments
    return [radius * Math.sin(phi) * Math.cos(theta), radius * Math.sin(phi) * Math.sin(theta), radius + radius * Math.cos(phi)] as const
  }
  for (let i = 0; i < rings; i += 1) {
    for (let j = 0; j < segments; j += 1) {
      const a = point(i, j), b = point(i + 1, j), c = point(i + 1, j + 1), d = point(i, j + 1)
      out.push(...a, ...b, ...c)
      out.push(...a, ...c, ...d)
    }
  }
  return new Float32Array(out)
}

test('adaptive gives fine layers where the surface is shallow and coarse where it is vertical', () => {
  // The whole point of the feature: a sphere's poles need thin layers, its equator does not.
  const profile = adaptiveLayerHeightProfile(sphereSoup(10), {
    objectHeight: 20, bounds: BOUNDS, nominalHeight: 0.2, quality: 0
  })
  assert.ok(profile, 'the sphere produced a profile')
  assertInvariants(profile!, 20, 'adaptive')
  assert.ok(!isFlatLayerHeightProfile(profile!), 'a sphere must NOT come back flat')
  const atPole = layerHeightAt(profile!, 0.2)
  const atEquator = layerHeightAt(profile!, 10)
  assert.ok(atPole < atEquator, `pole ${atPole} must be finer than equator ${atEquator}`)
  assert.ok(Math.abs(atPole - BOUNDS.min) < 0.02, `pole should approach the min layer height, got ${atPole}`)
  assert.ok(Math.abs(atEquator - BOUNDS.max) < 0.02, `equator should approach the max, got ${atEquator}`)
})

test('a uniform-slope solid correctly gets a CONSTANT adaptive height', () => {
  // A cone's slope never changes, so a varying profile would be the bug here.
  const out: number[] = []
  for (let i = 0; i < 48; i += 1) {
    const a0 = (i / 48) * Math.PI * 2, a1 = ((i + 1) / 48) * Math.PI * 2
    const x0 = Math.cos(a0) * 10, y0 = Math.sin(a0) * 10
    const x1 = Math.cos(a1) * 10, y1 = Math.sin(a1) * 10
    out.push(x0, y0, 0, x1, y1, 0, 0, 0, 20)
    out.push(0, 0, 0, x1, y1, 0, x0, y0, 0)
  }
  const profile = adaptiveLayerHeightProfile(new Float32Array(out), {
    objectHeight: 20, bounds: BOUNDS, nominalHeight: 0.2, quality: 0
  })
  assert.ok(profile)
  assert.ok(isFlatLayerHeightProfile(profile!, 1e-3), 'uniform slope => uniform layer height')
})

test('adaptive quality moves the whole curve: 0 is finer than 1', () => {
  const mean = (p: readonly number[]) => {
    let total = 0, count = 0
    for (let i = 1; i < p.length; i += 2) { total += p[i]!; count += 1 }
    return total / count
  }
  const soup = sphereSoup(10)
  const fine = adaptiveLayerHeightProfile(soup, { objectHeight: 20, bounds: BOUNDS, nominalHeight: 0.2, quality: 0 })
  const coarse = adaptiveLayerHeightProfile(soup, { objectHeight: 20, bounds: BOUNDS, nominalHeight: 0.2, quality: 1 })
  assert.ok(fine && coarse)
  assert.ok(mean(fine!) < mean(coarse!), `quality 0 (${mean(fine!)}) must be finer than 1 (${mean(coarse!)})`)
})

test('adaptive returns null for a soup with no usable facets', () => {
  assert.equal(adaptiveLayerHeightProfile(new Float32Array(), {
    objectHeight: 20, bounds: BOUNDS, nominalHeight: 0.2, quality: 0.5
  }), null)
})

test('smoothing reduces variation and keeps the invariants', () => {
  const spiky = [0, 0.3, 5, 0.07, 10, 0.3, 15, 0.07, 20, 0.3]
  const range = (p: readonly number[]) => {
    let lo = Infinity, hi = -Infinity
    for (let i = 1; i < p.length; i += 2) { lo = Math.min(lo, p[i]!); hi = Math.max(hi, p[i]!) }
    return hi - lo
  }
  const smoothed = smoothLayerHeightProfile(spiky, 20, { bounds: BOUNDS, radius: 5, keepMin: false })
  assert.ok(smoothed)
  assertInvariants(smoothed!, 20, 'smoothed')
  assert.ok(range(smoothed!) < range(spiky), `smoothing should flatten: ${range(smoothed!)} vs ${range(spiky)}`)
})

test('keep min never lets smoothing thicken a layer', () => {
  const profile = [0, 0.1, 5, 0.3, 10, 0.1, 15, 0.3, 20, 0.1]
  const smoothed = smoothLayerHeightProfile(profile, 20, { bounds: BOUNDS, radius: 4, keepMin: true })
  assert.ok(smoothed)
  for (let i = 1; i < smoothed!.length; i += 2) {
    const z = smoothed![i - 1]!
    assert.ok(smoothed![i]! <= layerHeightAt(profile, z) + 1e-9,
      `keepMin violated at z=${z}: ${smoothed![i]} > ${layerHeightAt(profile, z)}`)
  }
})

test('painting add detail thins the layers under the brush and leaves the rest alone', () => {
  const flat = flatLayerHeightProfile(20, 0.2)
  const painted = paintLayerHeightProfile(flat, 10, 'addDetail', {
    objectHeight: 20, bounds: BOUNDS, nominalHeight: 0.2, bandWidth: 4, strength: 0.05
  })
  assert.ok(painted)
  assertInvariants(painted!, 20, 'painted')
  assert.ok(layerHeightAt(painted!, 10) < 0.2 - 1e-9, 'the brush centre got thinner')
  assert.ok(Math.abs(layerHeightAt(painted!, 0.5) - 0.2) < 1e-6, 'far below the brush is untouched')
  assert.ok(Math.abs(layerHeightAt(painted!, 19.5) - 0.2) < 1e-6, 'far above the brush is untouched')
})

test('remove detail thickens, and reset pulls back toward the nominal height', () => {
  const flat = flatLayerHeightProfile(20, 0.2)
  const thick = paintLayerHeightProfile(flat, 10, 'removeDetail', {
    objectHeight: 20, bounds: BOUNDS, nominalHeight: 0.2, bandWidth: 4, strength: 0.05
  })
  assert.ok(thick && layerHeightAt(thick!, 10) > 0.2 + 1e-9)
  const reset = paintLayerHeightProfile(thick!, 10, 'resetToBase', {
    objectHeight: 20, bounds: BOUNDS, nominalHeight: 0.2, bandWidth: 4, strength: 0.05
  })
  assert.ok(reset)
  assert.ok(Math.abs(layerHeightAt(reset!, 10) - 0.2) < Math.abs(layerHeightAt(thick!, 10) - 0.2),
    'reset moved the painted band back toward nominal')
})

test('a brush stroke can never push a layer outside the extruder band', () => {
  let profile: readonly number[] = flatLayerHeightProfile(20, 0.2)
  for (let i = 0; i < 40; i += 1) {
    const next = paintLayerHeightProfile(profile, 10, 'addDetail', {
      objectHeight: 20, bounds: BOUNDS, nominalHeight: 0.2, bandWidth: 4, strength: 0.05
    })
    assert.ok(next)
    profile = next!
  }
  assertInvariants(profile, 20, 'repeatedly painted')
  assert.ok(layerHeightAt(profile, 10) >= BOUNDS.min - 1e-9, 'clamped at the thin end, not driven to zero')
})

test('the profile is PINNED to the first-layer height, or the engine discards all of it', () => {
  // Found by slicing, not by a test: BambuStudio compares profile[1] against
  // first_object_layer_height with `!=` on doubles (PrintObject.cpp:3341) and throws the WHOLE
  // profile away on any difference. An adaptive curve starting at 0.28 against a 0.2 first layer
  // produced 177 identical 0.200mm layers -- the feature silently doing nothing.
  const firstLayer = 0.2
  const profile = adaptiveLayerHeightProfile(sphereSoup(10), {
    objectHeight: 20, bounds: BOUNDS, nominalHeight: 0.2, quality: 0, firstLayerHeight: firstLayer
  })
  assert.ok(profile)
  assert.equal(profile![1], firstLayer, 'profile[1] must EQUAL the first-layer height exactly')
  assertInvariants(profile!, 20, 'pinned')
  assert.ok(!isFlatLayerHeightProfile(profile!), 'pinning must not flatten the curve')
})

test('smoothing and painting keep the first-layer pin', () => {
  const firstLayer = 0.2
  const base = flatLayerHeightProfile(20, 0.25, firstLayer)
  assert.equal(base[1], firstLayer, 'a flat profile honours it too')

  const smoothed = smoothLayerHeightProfile(base, 20, {
    bounds: BOUNDS, radius: 5, keepMin: false, firstLayerHeight: firstLayer
  })
  assert.ok(smoothed)
  assert.equal(smoothed![1], firstLayer, 'smoothing must not drift the first layer')

  const painted = paintLayerHeightProfile(base, 10, 'addDetail', {
    objectHeight: 20, bounds: BOUNDS, nominalHeight: 0.2, bandWidth: 4, strength: 0.05,
    firstLayerHeight: firstLayer
  })
  assert.ok(painted)
  assert.equal(painted![1], firstLayer, 'a stroke must not drift the first layer')
})
