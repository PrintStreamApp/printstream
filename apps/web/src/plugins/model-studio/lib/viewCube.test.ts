/**
 * The view cube's clickable regions and the rule that keeps the camera's orbit frame stable.
 *
 * Both things pinned here shipped as bugs. The cube offered only its six faces, so the editor's
 * raised home angle was unreachable once you left it. And a preset wrote its own `up` onto the
 * camera, which re-based `OrbitControls`' polar axis, so picking Top changed how later drags
 * BEHAVED rather than only where the camera sat.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  VIEW_CUBE_FACE_LABELS,
  VIEW_CUBE_FACE_PRESETS,
  VIEW_CUBE_REGIONS,
  VIEW_PRESET_CONFIG,
  easeViewTween,
  oppositeViewCubeRegion,
  VIEW_CUBE_HINT,
  viewCubeLocalSign,
  viewOrientationFor,
  viewPositionFor,
  viewTweenOrientationAt,
  type ViewPreset
} from './viewCube.js'

test('the cube offers every face, edge and corner', () => {
  // 3x3 per face minus the interior cell: 6 faces + 12 edges + 8 corners.
  assert.equal(VIEW_CUBE_REGIONS.length, 26)
  const byKind = (count: number) => VIEW_CUBE_REGIONS.filter((r) => r.sign.filter((v) => v !== 0).length === count)
  assert.equal(byKind(1).length, 6, 'faces')
  assert.equal(byKind(2).length, 12, 'edges')
  assert.equal(byKind(3).length, 8, 'corners')
  assert.equal(new Set(VIEW_CUBE_REGIONS.map((r) => r.sign.join(','))).size, 26, 'regions must be distinct')
})

test('only the six faces name a preset, and they name the right one', () => {
  const presetOf = (sign: string) => VIEW_CUBE_REGIONS.find((r) => r.sign.join(',') === sign)?.preset
  assert.equal(presetOf('1,0,0'), 'right')
  assert.equal(presetOf('-1,0,0'), 'left')
  assert.equal(presetOf('0,1,0'), 'rear')
  assert.equal(presetOf('0,-1,0'), 'front')
  assert.equal(presetOf('0,0,1'), 'top')
  assert.equal(presetOf('0,0,-1'), 'bottom')
  assert.equal(VIEW_CUBE_REGIONS.filter((r) => r.preset !== null).length, 6)
})

test('a face region keeps the PRESET direction, lean and all', () => {
  // Not its own sign vector: Top's direction carries the lean that keeps `lookAt` resolvable, and
  // rebuilding it from (0, 0, 1) here would quietly drop it and reintroduce the degenerate view.
  const top = VIEW_CUBE_REGIONS.find((r) => r.preset === 'top')!
  assert.ok(top.direction.y < 0, 'the top view must keep its lean')
  assert.ok(Math.abs(top.direction.y) < 0.01, 'the lean must stay imperceptible')
})

test('every region direction is a unit vector pointing out of its own cell', () => {
  for (const region of VIEW_CUBE_REGIONS) {
    const { x, y, z } = region.direction
    assert.ok(Math.abs(Math.hypot(x, y, z) - 1) < 1e-9, `${region.label} is not normalized`)
    // An axis the cell does not face contributes nothing; one it does faces the same way.
    const components = [x, y, z]
    for (let axis = 0; axis < 3; axis++) {
      const sign = region.sign[axis]!
      if (sign === 0) assert.ok(Math.abs(components[axis]!) < 0.01, `${region.label} leaks onto axis ${axis}`)
      else assert.ok(Math.sign(components[axis]!) === sign, `${region.label} faces the wrong way on axis ${axis}`)
    }
  }
})

test('the front-top edge is reachable, which is what the home view needs', () => {
  // The editor opens on a raised front angle. Before edges were clickable there was no way back to
  // anything like it -- only flat-on to a face.
  const edge = VIEW_CUBE_REGIONS.find((r) => r.sign.join(',') === '0,-1,1')
  assert.ok(edge, 'the front-top edge must exist')
  assert.equal(edge.preset, null)
  assert.equal(edge.label, 'Top front')
})

test('labels read outside-in and never repeat a face', () => {
  assert.equal(VIEW_CUBE_REGIONS.find((r) => r.sign.join(',') === '1,-1,1')?.label, 'Top front right')
  assert.equal(VIEW_CUBE_REGIONS.find((r) => r.sign.join(',') === '-1,1,-1')?.label, 'Bottom rear left')
  assert.equal(new Set(VIEW_CUBE_REGIONS.map((r) => r.label)).size, 26, 'every region needs its own label')
})

test('no preset asks the camera to look along its own up vector', () => {
  // The degenerate case `lookAt` cannot resolve. Top and Bottom are the ones that would, and the
  // lean in their direction is what keeps the cross product alive with world Z as up.
  const WORLD_UP = { x: 0, y: 0, z: 1 }
  for (const preset of Object.keys(VIEW_PRESET_CONFIG) as ViewPreset[]) {
    const { direction } = VIEW_PRESET_CONFIG[preset]
    const cross = Math.hypot(
      direction.y * WORLD_UP.z - direction.z * WORLD_UP.y,
      direction.z * WORLD_UP.x - direction.x * WORLD_UP.z,
      direction.x * WORLD_UP.y - direction.y * WORLD_UP.x
    )
    assert.ok(cross > 1e-6, `${preset} is parallel to world up, so lookAt cannot orient it`)
  }
})

/** `BoxGeometry`'s material order as local axis unit vectors: +X, -X, +Y, -Y, +Z, -Z. */
const MATERIAL_LOCAL_AXES: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]
]

test('a region lands on the cube face it actually names', () => {
  // THE bug this file exists for. The cube's own axes are not the world's -- its materials make
  // local +Y the Top face and local +Z the Front face -- so a region placed by its WORLD sign sits
  // somewhere else entirely. It is invisible on the six faces, because a face lands on its own axis
  // either way; it shows up only on the edges and corners. Reported from the browser as the
  // top-front edge swinging the camera round to top-BACK.
  MATERIAL_LOCAL_AXES.forEach((localAxis, materialIndex) => {
    const preset = VIEW_CUBE_FACE_PRESETS[materialIndex]!
    const region = VIEW_CUBE_REGIONS.find((candidate) => candidate.preset === preset)!
    assert.deepEqual(
      viewCubeLocalSign(region.sign),
      [...localAxis],
      `the ${preset} region must sit on the cube face showing ${preset}`
    )
  })
})

test('the top-front edge sits between the Top and Front faces, not anywhere else', () => {
  // The exact reported case, spelled out: local +Y is Top and local +Z is Front, so their shared
  // edge is local (0, 1, 1). Reading the world sign straight through put it at (0, -1, 1), which is
  // the top-BACK edge of the mesh.
  const edge = VIEW_CUBE_REGIONS.find((r) => r.sign.join(',') === '0,-1,1')!
  assert.equal(edge.label, 'Top front')
  assert.deepEqual(viewCubeLocalSign(edge.sign), [0, 1, 1])
})

test('the local frame is a signed axis permutation, so faces stay faces', () => {
  // What makes the conversion safe to apply to the pick boxes: it never turns a zero component into
  // a non-zero one, so a face cell cannot become an edge cell or vice versa, and the 3x3 tiling
  // survives intact.
  for (const region of VIEW_CUBE_REGIONS) {
    const local = viewCubeLocalSign(region.sign)
    assert.equal(
      local.filter((value) => value !== 0).length,
      region.sign.filter((value) => value !== 0).length,
      `${region.label} changed kind under the conversion`
    )
    for (const value of local) assert.ok(value === -1 || value === 0 || value === 1, `${region.label} is not a sign vector`)
  }
  // And it is a bijection: 26 distinct regions must map to 26 distinct cells.
  assert.equal(new Set(VIEW_CUBE_REGIONS.map((r) => viewCubeLocalSign(r.sign).join(','))).size, 26)
})

import * as THREE from 'three'
import { CUT_AXIS_SIDES } from '../editorGeometry.js'

const ORIGIN = new THREE.Vector3()
/** Degrees between two orientations, along the shortest path. */
function degreesBetween(a: THREE.Quaternion, b: THREE.Quaternion): number {
  const delta = a.clone().invert().multiply(b)
  return (2 * Math.acos(Math.min(1, Math.abs(delta.w))) * 180) / Math.PI
}
/** Which way is up ON SCREEN for an orientation. */
function screenUp(orientation: THREE.Quaternion): THREE.Vector3 {
  return new THREE.Vector3(0, 1, 0).applyQuaternion(orientation)
}

test('a swing starts and ends exactly on the views it was given', () => {
  const from = viewOrientationFor(VIEW_PRESET_CONFIG.front.direction)
  const to = viewOrientationFor(VIEW_PRESET_CONFIG.top.direction)
  assert.ok(degreesBetween(viewTweenOrientationAt(from, to, 0), from) < 1e-4)
  assert.ok(degreesBetween(viewTweenOrientationAt(from, to, 1), to) < 1e-4)
  // A frame that lands past the end must not overshoot.
  assert.ok(degreesBetween(viewTweenOrientationAt(from, to, 1.7), to) < 1e-4)
  assert.ok(degreesBetween(viewTweenOrientationAt(from, to, -0.3), from) < 1e-4)
})

test('the roll never snaps part-way through a swing', () => {
  // THE reported bug. Interpolating only the direction and letting `lookAt` rebuild the roll each
  // frame is smooth across the middle of the sphere and violent at the poles, where a fractional
  // change of direction swings the up vector through a huge angle. Top to Bottom is the worst case,
  // being exactly antipodal. Interpolating the ORIENTATION spreads the turn evenly instead.
  const from = viewOrientationFor(VIEW_PRESET_CONFIG.top.direction)
  const to = viewOrientationFor(VIEW_PRESET_CONFIG.bottom.direction)
  const STEPS = 60
  let worstStep = 0
  let previous = screenUp(viewTweenOrientationAt(from, to, 0))
  for (let step = 1; step <= STEPS; step++) {
    const current = screenUp(viewTweenOrientationAt(from, to, step / STEPS))
    worstStep = Math.max(worstStep, (previous.angleTo(current) * 180) / Math.PI)
    previous = current
  }
  // An even 180 degrees over 60 steps is 3 per step; the easing peaks near 6. Anything approaching
  // the whole turn in one step is the snap.
  assert.ok(worstStep < 12, `the up vector jumped ${worstStep.toFixed(1)} degrees in one step`)
})

test('going between Top and Bottom TIPS the model rather than spinning it', () => {
  // Both views looking straight down an axis, the rotation between them is fixed by their screen-up
  // vectors. Sharing one (Studio's choice) makes it 180 degrees about the screen's VERTICAL axis --
  // a revolving-door spin. Opposing them makes it the horizontal axis, which is the model tipping
  // over to show its underside, and is why Bottom's lean matches Top's rather than opposing it.
  const top = viewOrientationFor(VIEW_PRESET_CONFIG.top.direction)
  const bottom = viewOrientationFor(VIEW_PRESET_CONFIG.bottom.direction)
  const delta = top.clone().invert().multiply(bottom)
  const scale = Math.sqrt(Math.max(1e-12, 1 - delta.w * delta.w))
  const axis = new THREE.Vector3(delta.x / scale, delta.y / scale, delta.z / scale)
  assert.ok(Math.abs(degreesBetween(top, bottom) - 180) < 1, 'the two views must be a half turn apart')
  // World X is the screen's horizontal axis in the Top view, whose screen-up is +Y.
  assert.ok(Math.abs(Math.abs(axis.x) - 1) < 1e-3, `expected a tip about world X, got ${axis.toArray()}`)
})

test('the camera holds its distance and keeps facing the target all the way round', () => {
  // Position is DERIVED from the orientation, so the two cannot disagree: no separate positional
  // interpolation to cut the chord and make the model loom mid-swing.
  const from = viewOrientationFor(VIEW_PRESET_CONFIG.left.direction)
  const to = viewOrientationFor(VIEW_PRESET_CONFIG.rear.direction)
  const target = new THREE.Vector3(128, 128, 20)
  for (let step = 0; step <= 12; step++) {
    const orientation = viewTweenOrientationAt(from, to, step / 12)
    const position = viewPositionFor(orientation, target, 300)
    assert.ok(Math.abs(position.distanceTo(target) - 300) < 1e-3, `radius drifted at step ${step}`)
    // The camera's own -Z is its forward; it must point back at the target.
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(orientation)
    const toTarget = target.clone().sub(position).normalize()
    assert.ok(forward.angleTo(toTarget) < 1e-3, `looked away from the target at step ${step}`)
  }
})

test('a swing takes the shortest way round', () => {
  const from = viewOrientationFor(VIEW_PRESET_CONFIG.front.direction)
  const to = viewOrientationFor(VIEW_PRESET_CONFIG.right.direction)
  let previous = Infinity
  for (let step = 0; step <= 20; step++) {
    const remaining = degreesBetween(viewTweenOrientationAt(from, to, step / 20), to)
    assert.ok(remaining <= previous + 1e-6, `the swing went backwards at ${step / 20}`)
    previous = remaining
  }
  assert.ok(degreesBetween(from, to) < 180.1, 'a preset pair should never need more than a half turn')
})

test('the easing is gentle at both ends and symmetric in the middle', () => {
  assert.equal(easeViewTween(0), 0)
  assert.equal(easeViewTween(1), 1)
  assert.ok(Math.abs(easeViewTween(0.5) - 0.5) < 1e-9, 'the midpoint must be the midpoint')
  // Slow to leave and slow to arrive is the point: a linear ramp starts at full speed.
  assert.ok(easeViewTween(0.1) < 0.1, 'must ease IN')
  assert.ok(easeViewTween(0.9) > 0.9, 'must ease OUT')
  // Clamped, so a late frame cannot drive the interpolation past its ends.
  assert.equal(easeViewTween(-1), 0)
  assert.equal(easeViewTween(2), 1)
})

test('a swing to where the camera already is stays put and stays finite', () => {
  const same = viewOrientationFor(VIEW_PRESET_CONFIG.front.direction)
  for (const progress of [0, 0.5, 1]) {
    const at = viewTweenOrientationAt(same, same, progress)
    assert.ok(Number.isFinite(at.x) && Number.isFinite(at.y) && Number.isFinite(at.z) && Number.isFinite(at.w))
    assert.ok(degreesBetween(at, same) < 1e-6)
  }
  assert.ok(viewPositionFor(same, ORIGIN, 100).length() > 99)
})

test('every region has an opposite, and it is the view from the other side', () => {
  for (const region of VIEW_CUBE_REGIONS) {
    const opposite = oppositeViewCubeRegion(region)
    // `|| 0` because negating a zero component yields -0, which deepStrictEqual separates from 0.
    // The lookup itself is immune, comparing joined strings where -0 prints as "0".
    assert.deepEqual(
      opposite.sign,
      region.sign.map((value) => -value || 0),
      `${region.label} has the wrong opposite`
    )
    // Opposing cells look at each other through the middle, so their directions are antipodal.
    const dot = region.direction.x * opposite.direction.x
      + region.direction.y * opposite.direction.y
      + region.direction.z * opposite.direction.z
    assert.ok(dot < -0.999, `${region.label} and ${opposite.label} are not opposite views`)
    // And it is an involution: the opposite of the opposite is where you started.
    assert.deepEqual(oppositeViewCubeRegion(opposite).sign, region.sign)
    // A face's opposite is the other face on that axis, never an edge or corner.
    assert.equal(opposite.preset === null, region.preset === null)
  }
})

test('the hint names all three gestures, since none of them are visible', () => {
  // The cube shows no affordance for its edges, for a second click, or for Shift. If the wording
  // drops one, that gesture is undiscoverable.
  assert.match(VIEW_CUBE_HINT, /edge/i)
  assert.match(VIEW_CUBE_HINT, /double-click/i)
  assert.match(VIEW_CUBE_HINT, /shift/i)
})

test('chaining swings never accumulates drift in the radius or the orientation', () => {
  // The reported bug was scene-level -- a Shift-click re-grounded the pivot, so the hit distance
  // silently became the new orbit radius and a run of clicks walked the camera in and out. The
  // scene no longer re-grounds, which leaves this as the remaining way drift could creep in:
  // repeatedly slerping and re-deriving a position can denormalise the quaternion, and the radius
  // is computed FROM it, so any denormalisation shows up as a zoom.
  const target = new THREE.Vector3(128, 128, 20)
  const DISTANCE = 340
  const tour = ['front', 'rear', 'right', 'left', 'top', 'bottom'] as const
  let orientation = viewOrientationFor(VIEW_PRESET_CONFIG.front.direction)
  for (let lap = 0; lap < 40; lap++) {
    const next = viewOrientationFor(VIEW_PRESET_CONFIG[tour[lap % tour.length]!].direction)
    // Walk the whole swing, not just its end, since every frame re-derives the position.
    for (let step = 1; step <= 8; step++) {
      orientation = viewTweenOrientationAt(orientation, next, step / 8)
      const position = viewPositionFor(orientation, target, DISTANCE)
      assert.ok(
        Math.abs(position.distanceTo(target) - DISTANCE) < 1e-6,
        `radius drifted to ${position.distanceTo(target)} on lap ${lap}`
      )
    }
  }
  assert.ok(Math.abs(orientation.length() - 1) < 1e-9, 'the orientation denormalised over the tour')
})

test('the far side of the bed is called Rear everywhere it is named', () => {
  // One axis must not have two words for its far side: the cube face, the region labels and the
  // cut-half names all describe the same +Y edge of the plate.
  assert.equal(VIEW_CUBE_FACE_LABELS.rear, 'Rear')
  assert.equal(VIEW_CUBE_REGIONS.find((r) => r.sign.join(',') === '0,1,0')?.label, 'Rear')
  assert.equal(VIEW_CUBE_REGIONS.find((r) => r.sign.join(',') === '0,1,1')?.label, 'Top rear')
  assert.equal(CUT_AXIS_SIDES.y.upper, 'rear')
})
