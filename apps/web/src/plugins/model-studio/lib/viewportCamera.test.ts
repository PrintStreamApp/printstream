/**
 * The camera rig both viewports drive.
 *
 * It exists because the editor and the read-only previews had drifted: the view cube was shared, so
 * both grew the same regions and modifiers, while only the editor learned to animate and to pivot
 * sensibly. The rules pinned here are the ones whose breakage is silent -- a swing that fights
 * `OrbitControls`, a pivot that creeps, a listener that outlives its viewport.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import { OrbitControls } from 'three-stdlib'
import {
  VIEW_TWEEN_MS,
  bedFitsComfortablyInView,
  createViewportCameraRig,
  installOrbitPivotBehavior
} from './viewportCamera.js'
import { VIEW_PRESET_CONFIG } from './viewCube.js'

/** The slice of `OrbitControls` the rig touches, so this runs with no DOM. */
function stubControls() {
  const listeners = new Map<string, Set<() => void>>()
  return {
    target: new THREE.Vector3(),
    enableDamping: true,
    updates: 0,
    update() { this.updates++ },
    addEventListener(type: string, fn: () => void) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(fn)
    },
    removeEventListener(type: string, fn: () => void) { listeners.get(type)?.delete(fn) },
    emit(type: string) { for (const fn of listeners.get(type) ?? []) fn() },
    listenerCount(type: string) { return listeners.get(type)?.size ?? 0 }
  }
}

function rigAt(position: THREE.Vector3, target = new THREE.Vector3()) {
  const camera = new THREE.PerspectiveCamera(45, 1.5, 0.1, 5000)
  camera.position.copy(position)
  camera.up.set(0, 0, 1)
  camera.lookAt(target)
  camera.updateMatrixWorld(true)
  const controls = stubControls()
  controls.target.copy(target)
  const rig = createViewportCameraRig(camera, controls as never, undefined)
  return { camera, controls, rig }
}

/** Minimal pointer-event target for testing gesture policy without a browser DOM. */
class PointerTargetStub {
  private readonly listeners = new Map<string, Set<(event: PointerEvent) => void>>()

  addEventListener(type: string, listener: (event: PointerEvent) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(listener)
  }

  removeEventListener(type: string, listener: (event: PointerEvent) => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  emit(type: string, event: Partial<PointerEvent>): void {
    const pointerEvent = { button: 0, pointerId: 1, pointerType: 'mouse', ...event } as PointerEvent
    for (const listener of this.listeners.get(type) ?? []) listener(pointerEvent)
  }
}

function orthographicCamera(halfExtent: number, x = 128, y = 128): THREE.OrthographicCamera {
  const camera = new THREE.OrthographicCamera(-halfExtent, halfExtent, halfExtent, -halfExtent, 0.1, 2000)
  camera.position.set(x, y, 500)
  camera.lookAt(x, y, 0)
  camera.updateProjectionMatrix()
  camera.updateMatrixWorld(true)
  return camera
}

test('a swing to where the camera already is SNAPS rather than spending its duration', () => {
  // Otherwise a click on the face you are already looking at reads as a delay, not a no-op.
  const { camera, controls, rig } = rigAt(new THREE.Vector3(0, -300, 0))
  rig.swingTo({ direction: VIEW_PRESET_CONFIG.front.direction, target: new THREE.Vector3(), distance: 300 })
  assert.equal(rig.advance(performance.now() + 1), false, 'nothing should be in flight')
  assert.ok(controls.updates > 0, 'the snap path must settle the controls itself')
  assert.ok(Math.abs(camera.position.distanceTo(controls.target) - 300) < 1e-6)
})

test('a real swing animates, and reports itself in flight until it lands', () => {
  const { rig } = rigAt(new THREE.Vector3(0, -300, 0))
  rig.swingTo({ direction: VIEW_PRESET_CONFIG.right.direction, target: new THREE.Vector3(), distance: 300 })
  assert.equal(rig.advance(performance.now()), true, 'the swing should have frames to paint')
  // Past its duration it lands and then reports done, so the caller can stop rendering.
  assert.equal(rig.advance(performance.now() + VIEW_TWEEN_MS + 50), true, 'the landing frame still paints')
  assert.equal(rig.advance(performance.now() + VIEW_TWEEN_MS + 100), false)
})

test('the rig never calls controls.update() while swinging', () => {
  // THE rule the swing depends on: `update()` ends in `lookAt(target)`, which would rebuild the
  // roll from the direction every frame and undo the orientation interpolation.
  const { controls, rig } = rigAt(new THREE.Vector3(0, -300, 0))
  rig.swingTo({ direction: VIEW_PRESET_CONFIG.top.direction, target: new THREE.Vector3(), distance: 300 })
  const before = controls.updates
  rig.advance(performance.now())
  rig.advance(performance.now() + 60)
  assert.equal(controls.updates, before, 'advancing a swing must not touch the controls')
})

test('the camera holds its radius and faces the target the whole way round', () => {
  const target = new THREE.Vector3(128, 128, 20)
  const { camera, controls, rig } = rigAt(new THREE.Vector3(128, -200, 220), target)
  rig.swingTo({ direction: VIEW_PRESET_CONFIG.left.direction, target, distance: 300 })
  const started = performance.now()
  for (let step = 0; step <= 10; step++) {
    rig.advance(started + (VIEW_TWEEN_MS * step) / 10)
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion)
    const toTarget = controls.target.clone().sub(camera.position).normalize()
    assert.ok(forward.angleTo(toTarget) < 1e-3, `looked away from the target at step ${step}`)
  }
  assert.ok(Math.abs(camera.position.distanceTo(controls.target) - 300) < 1e-3, 'radius drifted')
})

test('any camera gesture cancels the swing outright', () => {
  // Hooked on the controls' own `start`, which covers the WHEEL as well as a drag; a pointerdown
  // listener would miss a zoom and the swing would overwrite it on the next frame.
  const { rig, controls } = rigAt(new THREE.Vector3(0, -300, 0))
  rig.swingTo({ direction: VIEW_PRESET_CONFIG.top.direction, target: new THREE.Vector3(), distance: 300 })
  controls.emit('start')
  assert.equal(rig.advance(performance.now()), false, 'the user took the camera; stop steering it')
})

test('grounding seats the pivot on the plane, and doing it again moves nothing', () => {
  // Idempotence is the whole reason it is a PLANE and not the geometry under the cursor: a surface
  // hit shifts as the camera orbits, so the pivot creeps with every drag.
  const PLANE_Z = 20
  const { camera, controls, rig } = rigAt(new THREE.Vector3(120, -180, 260), new THREE.Vector3(120, 40, 90))
  camera.lookAt(controls.target)
  camera.updateMatrixWorld(true)
  rig.groundPivot(PLANE_Z)
  const seated = controls.target.clone()
  assert.ok(Math.abs(seated.z - PLANE_Z) < 1e-6, `the pivot landed at z=${seated.z}`)
  rig.groundPivot(PLANE_Z)
  assert.ok(controls.target.distanceTo(seated) < 1e-6, 'a second grounding moved the pivot')
})

test('grounding leaves a level camera alone rather than throwing the pivot at the horizon', () => {
  const { camera, controls, rig } = rigAt(new THREE.Vector3(0, -300, 20), new THREE.Vector3(0, 0, 20))
  camera.lookAt(controls.target)
  camera.updateMatrixWorld(true)
  const before = controls.target.clone()
  rig.groundPivot(20)
  assert.ok(controls.target.distanceTo(before) < 1e-9)
})

test('grounding stays ON the view axis, so it cannot rotate the camera', () => {
  // What makes the re-seat invisible: the ray through the middle of the viewport IS the forward
  // axis, so the new pivot is already dead ahead and only the RADIUS changes.
  const { camera, controls, rig } = rigAt(new THREE.Vector3(60, -200, 240), new THREE.Vector3(60, 20, 80))
  camera.lookAt(controls.target)
  camera.updateMatrixWorld(true)
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion)
  rig.groundPivot(20)
  const toPivot = controls.target.clone().sub(camera.position).normalize()
  assert.ok(forward.angleTo(toPivot) < 1e-6, 'the new pivot is off the view axis, so lookAt would swing')
})

test('projected bed size distinguishes an overview from a close-up', () => {
  const bounds = { minX: -25, maxX: 325, minY: 10, maxY: 190 }
  assert.equal(bedFitsComfortablyInView(orthographicCamera(250, 150, 100), bounds, 0), true)
  assert.equal(bedFitsComfortablyInView(orthographicCamera(180, 150, 100), bounds, 0), false)
})

test('grounding a panned overview does not abruptly centre the bed', () => {
  const camera = orthographicCamera(200, 200, 128)
  const controls = stubControls()
  controls.target.set(200, 128, 0)
  const rig = createViewportCameraRig(camera, controls as never)

  rig.groundPivot(0, { minX: -20, maxX: 300, minY: 18, maxY: 198 })

  assert.deepEqual(controls.target.toArray(), [200, 128, 0])
})

test('an in-place overview orbit preserves the bed centre screen position', () => {
  const camera = orthographicCamera(200, 200, 128)
  const controls = stubControls()
  controls.target.set(200, 128, 0)
  const rig = createViewportCameraRig(camera, controls as never)
  const bedCentre = new THREE.Vector3(128, 128, 0)
  const before = bedCentre.clone().project(camera)
  rig.beginInPlaceOrbit(bedCentre)
  assert.equal(controls.enableDamping, true, 'overview orbit retains the normal damping feel')

  // Simulate the orientation/position change OrbitControls makes around its own off-centre target.
  const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.3)
  camera.position.sub(controls.target).applyQuaternion(turn).add(controls.target)
  camera.quaternion.premultiply(turn)
  camera.updateMatrixWorld(true)
  controls.emit('change')

  const after = bedCentre.clone().project(camera)
  assert.ok(Math.abs(after.x - before.x) < 1e-6)
  assert.ok(Math.abs(after.y - before.y) < 1e-6)
  rig.endInPlaceOrbit()
})

test('repeated real OrbitControls updates keep an overview stable for the whole drag', () => {
  const camera = new THREE.OrthographicCamera(-200, 200, 200, -200, 0.1, 2000)
  camera.position.set(200, -300, 300)
  camera.up.set(0, 0, 1)
  camera.lookAt(200, 128, 0)
  camera.updateProjectionMatrix()
  camera.updateMatrixWorld(true)
  const controls = new OrbitControls(camera)
  controls.target.set(200, 128, 0)
  controls.enableDamping = true
  controls.update()
  camera.updateMatrixWorld(true)
  const rig = createViewportCameraRig(camera, controls)
  const bedCentre = new THREE.Vector3(128, 128, 0)
  const before = bedCentre.clone().project(camera)
  rig.beginInPlaceOrbit(bedCentre)

  for (let step = 1; step <= 60; step++) {
    controls.setAzimuthalAngle(step * 0.015)
    const projected = bedCentre.clone().project(camera)
    assert.ok(Math.abs(projected.x - before.x) < 1e-5, `horizontal jump at step ${step}`)
    assert.ok(Math.abs(projected.y - before.y) < 1e-5, `vertical jump at step ${step}`)
  }

  rig.endInPlaceOrbit()
  rig.dispose()
  controls.dispose()
})

test('an in-place perspective orbit preserves depth and cannot change zoom', () => {
  const camera = new THREE.PerspectiveCamera(45, 1.5, 0.1, 5000)
  camera.position.set(260, -380, 280)
  camera.up.set(0, 0, 1)
  camera.lookAt(200, 128, 0)
  camera.updateProjectionMatrix()
  camera.updateMatrixWorld(true)
  const controls = new OrbitControls(camera)
  controls.target.set(200, 128, 0)
  controls.update()
  camera.updateMatrixWorld(true)
  const rig = createViewportCameraRig(camera, controls)
  const bedCentre = new THREE.Vector3(128, 128, 0)
  const cameraSpaceBefore = bedCentre.clone().applyMatrix4(camera.matrixWorldInverse)
  rig.beginInPlaceOrbit(bedCentre)

  for (let step = 1; step <= 40; step++) {
    controls.setAzimuthalAngle(controls.getAzimuthalAngle() + 0.018)
    controls.setPolarAngle(controls.getPolarAngle() + (step <= 20 ? 0.004 : -0.004))
    const cameraSpace = bedCentre.clone().applyMatrix4(camera.matrixWorldInverse)
    assert.ok(cameraSpace.distanceTo(cameraSpaceBefore) < 1e-5, `framing changed at step ${step}`)
  }

  rig.endInPlaceOrbit()
  rig.dispose()
  controls.dispose()
})

test('a close-up orbits the viewed area but keeps its pivot on the bed', () => {
  const camera = orthographicCamera(100, 400, 128)
  const controls = stubControls()
  controls.target.set(400, 128, 0)
  const rig = createViewportCameraRig(camera, controls as never)

  rig.groundPivot(0, { minX: -20, maxX: 300, minY: 10, maxY: 190 })

  assert.deepEqual(controls.target.toArray(), [300, 128, 0])
})

test('mouse pan gestures cancel overview correction instead of fighting the pan', () => {
  const target = new PointerTargetStub()
  let begins = 0
  let ends = 0
  const release = installOrbitPivotBehavior(
    target as unknown as HTMLElement,
    { enabled: true },
    {
      groundPivot: () => undefined,
      isOverview: () => true,
      beginInPlaceOrbit: () => { begins++ },
      finishInPlaceOrbit: () => undefined,
      endInPlaceOrbit: () => { ends++ }
    },
    () => ({ planeZ: 0, bounds: { minX: -25, maxX: 325, minY: 10, maxY: 190 } })
  )

  target.emit('pointerdown', { button: 0 })
  assert.equal(begins, 1)
  target.emit('pointerdown', { button: 0, ctrlKey: true })
  target.emit('pointerdown', { button: 1 })
  target.emit('pointerdown', { button: 2 })
  assert.equal(begins, 1, 'only an unmodified left drag rotates')
  assert.equal(ends, 3, 'every mouse pan/dolly path cancels overview correction')

  release()
})

test('a two-finger touch gesture never re-seats the orbit pivot', () => {
  const target = new PointerTargetStub()
  const calls: Array<[number, unknown]> = []
  const release = installOrbitPivotBehavior(
    target as unknown as HTMLElement,
    { enabled: true },
    {
      groundPivot: (planeZ, bounds) => calls.push([planeZ, bounds]),
      isOverview: () => false,
      beginInPlaceOrbit: () => undefined,
      finishInPlaceOrbit: () => undefined,
      endInPlaceOrbit: () => undefined
    },
    () => ({ planeZ: 0, bounds: { minX: -25, maxX: 325, minY: 10, maxY: 190 } })
  )

  target.emit('pointerdown', { pointerType: 'touch', pointerId: 1 })
  target.emit('pointerdown', { pointerType: 'touch', pointerId: 2 })
  target.emit('pointermove', { pointerType: 'touch', pointerId: 1 })
  target.emit('pointerup', { pointerType: 'touch', pointerId: 2 })
  target.emit('pointermove', { pointerType: 'touch', pointerId: 1 })
  assert.equal(calls.length, 0, 'the remaining finger is still part of the multi-touch gesture')
  target.emit('pointerup', { pointerType: 'touch', pointerId: 1 })

  target.emit('pointerdown', { pointerType: 'touch', pointerId: 3 })
  target.emit('pointermove', { pointerType: 'touch', pointerId: 3 })
  target.emit('pointermove', { pointerType: 'touch', pointerId: 3 })
  assert.equal(calls.length, 1, 'a later one-finger rotate grounds exactly once')

  release()
  target.emit('pointerdown', { pointerType: 'mouse', pointerId: 4 })
  assert.equal(calls.length, 1, 'cleanup removes the policy listeners')
})

test('dispose releases the gesture listener', () => {
  // The rig outliving its viewport would keep a dead camera reachable from a live control.
  const { rig, controls } = rigAt(new THREE.Vector3(0, -300, 0))
  assert.equal(controls.listenerCount('start'), 1)
  rig.dispose()
  assert.equal(controls.listenerCount('start'), 0)
})
