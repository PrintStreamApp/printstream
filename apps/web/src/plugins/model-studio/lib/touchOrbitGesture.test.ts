import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import { guardTouchOrbitTransition } from './touchOrbitGesture.js'

function touchEvent(type: string, pointerId: number): Event {
  const event = new Event(type)
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    pointerType: { value: 'touch' }
  })
  return event
}

test('the remaining finger keeps panning until a multi-touch gesture fully ends', () => {
  const element = new EventTarget()
  const controls = { touches: { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN } }
  const dispose = guardTouchOrbitTransition(element as HTMLElement, controls as never)

  element.dispatchEvent(touchEvent('pointerdown', 1))
  assert.equal(controls.touches.ONE, THREE.TOUCH.ROTATE)
  element.dispatchEvent(touchEvent('pointerdown', 2))
  assert.equal(controls.touches.ONE, THREE.TOUCH.PAN)
  element.dispatchEvent(touchEvent('pointerup', 2))
  assert.equal(controls.touches.ONE, THREE.TOUCH.PAN)
  element.dispatchEvent(touchEvent('pointerup', 1))
  assert.equal(controls.touches.ONE, THREE.TOUCH.ROTATE)

  dispose()
})

test('cancellation and disposal restore the configured one-finger gesture', () => {
  const element = new EventTarget()
  const controls = { touches: { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN } }
  const dispose = guardTouchOrbitTransition(element as HTMLElement, controls as never)
  element.dispatchEvent(touchEvent('pointerdown', 1))
  element.dispatchEvent(touchEvent('pointerdown', 2))
  element.dispatchEvent(touchEvent('pointercancel', 2))
  element.dispatchEvent(touchEvent('pointercancel', 1))
  assert.equal(controls.touches.ONE, THREE.TOUCH.ROTATE)
  dispose()
  assert.equal(controls.touches.ONE, THREE.TOUCH.ROTATE)
})

test('losing pointer capture cannot leave later one-finger gestures in pan mode', () => {
  const element = new EventTarget()
  const controls = { touches: { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN } }
  const dispose = guardTouchOrbitTransition(element as HTMLElement, controls as never)

  element.dispatchEvent(touchEvent('pointerdown', 1))
  element.dispatchEvent(touchEvent('pointerdown', 2))
  element.dispatchEvent(touchEvent('lostpointercapture', 2))
  element.dispatchEvent(touchEvent('lostpointercapture', 1))
  assert.equal(controls.touches.ONE, THREE.TOUCH.ROTATE)

  dispose()
})
