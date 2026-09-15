/**
 * Content pointer claims must begin before OrbitControls sees pointer-down and last until the same
 * pointer ends. Otherwise holding a selected object rotates or pans the camera.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPointerClaim } from './pointerClaim'

function harness() {
  const captures = new Set<number>()
  const target = {
    setPointerCapture(pointerId: number) { captures.add(pointerId) },
    hasPointerCapture(pointerId: number) { return captures.has(pointerId) },
    releasePointerCapture(pointerId: number) { captures.delete(pointerId) }
  }
  const control = { enabled: true }
  return { captures, control, claim: createPointerClaim(target, control) }
}

test('an owned primary press disables the camera until that pointer is released', () => {
  const { captures, control, claim } = harness()

  assert.equal(claim.claim({ button: 0, pointerId: 7 }, true), true)
  assert.equal(control.enabled, false)
  assert.deepEqual([...captures], [7])

  assert.equal(claim.release({ pointerId: 8 }), false, 'an unrelated pointer ended the claim')
  assert.equal(control.enabled, false)
  assert.equal(claim.release({ pointerId: 7 }), true)
  assert.equal(control.enabled, true)
  assert.equal(captures.size, 0)
})

test('empty-space and non-primary presses stay available to camera controls', () => {
  const { captures, control, claim } = harness()

  assert.equal(claim.claim({ button: 0, pointerId: 1 }, false), false)
  assert.equal(claim.claim({ button: 1, pointerId: 2 }, true), false)
  assert.equal(control.enabled, true)
  assert.equal(captures.size, 0)
})

test('dispose restores the camera when the viewport unmounts during a press', () => {
  const { captures, control, claim } = harness()

  claim.claim({ button: 0, pointerId: 3 }, true)
  claim.dispose()

  assert.equal(control.enabled, true)
  assert.equal(captures.size, 0)
})
