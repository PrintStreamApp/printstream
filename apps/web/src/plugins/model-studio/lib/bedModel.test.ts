import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bedOpacityForCameraHeight } from './bedModel'

// The plate must not occlude the models when the user orbits underneath it — the plain grid is
// see-through by nature, and a solid modelled plate is not.
test('the plate stays opaque at or above plate level', () => {
  assert.equal(bedOpacityForCameraHeight(500), 1)
  assert.equal(bedOpacityForCameraHeight(0.5), 1)
  assert.equal(bedOpacityForCameraHeight(0), 1)
})

test('it fades as the camera drops below the plate', () => {
  const justBelow = bedOpacityForCameraHeight(-10)
  const lower = bedOpacityForCameraHeight(-30)
  assert.ok(justBelow < 1, 'starts fading immediately below the plate')
  assert.ok(lower < justBelow, 'keeps fading as the camera drops further')
})

test('it bottoms out at a small non-zero opacity rather than vanishing', () => {
  const deep = bedOpacityForCameraHeight(-10_000)
  assert.ok(deep > 0, 'the plate still reads as present from far below')
  assert.equal(deep, bedOpacityForCameraHeight(-40))
  assert.ok(deep < 0.2)
})
