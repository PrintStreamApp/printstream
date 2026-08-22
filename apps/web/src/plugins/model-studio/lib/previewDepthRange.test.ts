import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fitPerspectiveDepthRange } from './previewDepthRange.js'

/**
 * Smallest depth step a linear 24-bit buffer can resolve at `z`, given the planes. This is the
 * number the whole module exists to control, so the tests assert on it rather than on the planes.
 */
function depthResolutionMm(z: number, near: number, far: number): number {
  return (z * z * (1 / near - 1 / far)) / (2 ** 24 - 1)
}

/** A framed H2D plate: ~350x320 bed, so a bounding sphere around 250mm viewed from ~700mm. */
const BED_RADIUS = 250
const FRAMED_DISTANCE = 700

test('the fitted range resolves depth far finer than a layer or the grid lift', () => {
  const { near, far } = fitPerspectiveDepthRange(FRAMED_DISTANCE, BED_RADIUS)

  const resolution = depthResolutionMm(FRAMED_DISTANCE, near, far)
  // The two separations that were being lost: a 0.2mm layer (top surface vs the infill under it)
  // and the 0.01mm the bed grid / nozzle-only zones sit above the plate's top face.
  assert.ok(resolution < 0.01 / 100, `resolution ${resolution} must clear the 0.01mm grid lift by 100x`)

  // ...and prove the old fixed range did NOT, or this test would pass either way.
  const legacy = depthResolutionMm(FRAMED_DISTANCE, 0.1, Math.max(FRAMED_DISTANCE * 20, 5000))
  assert.ok(legacy > 0.01, `the fixed 0.1/far range resolved only ${legacy}mm, coarser than the grid lift`)
})

test('the range still brackets the content when the camera dollies inside it', () => {
  // distance - radius goes negative here; an unclamped near would invert the projection.
  const { near, far } = fitPerspectiveDepthRange(40, BED_RADIUS)

  assert.ok(near > 0, 'near must stay positive')
  assert.ok(far > near, 'far must stay behind near')
  assert.ok(depthResolutionMm(40, near, far) < 0.01 / 10, 'close-up precision must still clear the grid lift')
})

test('the near plane keeps giving way as the camera closes in, so zoom never dead-ends', () => {
  // The reported bug: on a 350mm plate the near floor was a content-sized constant
  // (radius * 0.005 = 1.25mm), so past that distance the camera sat inside its own near plane and
  // the view clipped to nothing — zooming looked broken. The near plane must stay in FRONT of the
  // camera at every distance, including well inside a single extrusion.
  for (const distance of [10, 4, 1, 0.4, 0.1]) {
    const { near, far } = fitPerspectiveDepthRange(distance, BED_RADIUS)
    assert.ok(near < distance, `near ${near} must stay in front of a camera ${distance}mm from the target`)
    assert.ok(far > near, 'far must stay behind near')
  }

  // And prove the previous rule did NOT, or the loop above would pass either way.
  const legacyFloor = BED_RADIUS * 0.005
  assert.ok(legacyFloor > 0.4, `the old content-sized floor (${legacyFloor}mm) clipped a 0.4mm approach`)
})

test('just inside the content sphere the content-sized floor still binds, so precision is untouched', () => {
  // Only the CLOSE range changes. Just inside the sphere the radius floor is still the smaller of
  // the two, so the depth resolution this module exists to protect is exactly as before.
  const { near } = fitPerspectiveDepthRange(200, BED_RADIUS)
  assert.equal(near, BED_RADIUS * 0.005)

  // Outside the sphere the geometric answer wins, as it always did.
  assert.equal(fitPerspectiveDepthRange(260, BED_RADIUS).near, 10)
})

test('near never reaches zero even with degenerate content', () => {
  for (const radius of [0, -5, Number.NaN]) {
    const { near, far } = fitPerspectiveDepthRange(0, radius)
    assert.ok(Number.isFinite(near) && near > 0, `near must be a positive number for radius ${radius}`)
    assert.ok(Number.isFinite(far) && far > near, `far must exceed near for radius ${radius}`)
  }
})

test('the far plane always clears the back of the content', () => {
  const { far } = fitPerspectiveDepthRange(FRAMED_DISTANCE, BED_RADIUS)
  assert.ok(far >= FRAMED_DISTANCE + BED_RADIUS, 'content behind the centre must not be clipped')
})
