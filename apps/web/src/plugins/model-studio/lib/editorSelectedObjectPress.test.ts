import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'
import type { GizmoMode } from '../editorGeometry'
import { handleEditorSelectedObjectPress } from './editorSelectedObjectPress'

function fixture(mode: GizmoMode) {
  const calls: string[] = []
  const group = new THREE.Group()
  const body = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2))
  group.add(body)
  group.updateMatrixWorld(true)
  const raycaster = new THREE.Raycaster()
  raycaster.set(new THREE.Vector3(0, 0, 10), new THREE.Vector3(0, 0, -1))
  const orbit = { enabled: true }
  const options = {
    event: { pointerId: 5 } as PointerEvent,
    group,
    instanceKey: 'object-a' as unknown,
    mode,
    aimPointerRay: () => { calls.push('aim') },
    raycaster,
    faceHull: null as THREE.Mesh | null,
    placeOnFace: (_hit: THREE.Intersection<THREE.Object3D>) => { calls.push('place'); return true },
    afterPlaceOnFace: () => { calls.push('after') },
    bedPlane: new THREE.Plane(new THREE.Vector3(0, 0, 1), 0),
    dragPoint: new THREE.Vector3(),
    resetPanelSync: () => { calls.push('reset') },
    beginBodyDrag: () => { calls.push('body') },
    beginCoDrag: () => { calls.push('co-drag') },
    canvas: { setPointerCapture: () => { calls.push('capture') } },
    orbit
  }
  return { calls, options, orbit }
}

test('Place on face prefers a hull hit and refreshes only after a committed placement', () => {
  const hit = fixture('layFace')
  const hull = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 1))
  hull.position.z = 2
  hull.updateMatrixWorld(true)
  hit.options.faceHull = hull
  hit.options.placeOnFace = (faceHit) => {
    assert.equal(faceHit.object, hull)
    hit.calls.push('place')
    return true
  }
  handleEditorSelectedObjectPress(hit.options)
  assert.deepEqual(hit.calls, ['aim', 'place', 'after'])

  const refused = fixture('layFace')
  refused.options.placeOnFace = () => false
  handleEditorSelectedObjectPress(refused.options)
  assert.deepEqual(refused.calls, ['aim'])
})

test('Move starts body and co-drag from a fresh bed hit, while resting leaves it alone', () => {
  const moving = fixture('translate')
  handleEditorSelectedObjectPress(moving.options)
  assert.deepEqual(moving.calls, ['aim', 'reset', 'body', 'co-drag', 'capture'])
  assert.equal(moving.orbit.enabled, false)

  const miss = fixture('translate')
  miss.options.raycaster.set(new THREE.Vector3(0, 0, 10), new THREE.Vector3(1, 0, 0))
  handleEditorSelectedObjectPress(miss.options)
  assert.deepEqual(miss.calls, ['aim'])

  const resting = fixture('select')
  handleEditorSelectedObjectPress(resting.options)
  assert.deepEqual(resting.calls, [])
})
