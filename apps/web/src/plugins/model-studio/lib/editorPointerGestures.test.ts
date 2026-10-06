import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'
import { createEditorActiveDragMove, createEditorPointerRelease } from './editorPointerGestures'

test('active drag movement requires a bed hit and routes tower, part, then body', () => {
  const raycaster = new THREE.Raycaster()
  raycaster.set(new THREE.Vector3(0, 0, 10), new THREE.Vector3(0, 0, -1))
  const calls: string[] = []
  let active = false
  let route: 'tower' | 'part' | 'body' = 'part'
  const move = createEditorActiveDragMove({
    isBodyActive: () => active,
    isPartActive: () => active,
    isTowerActive: () => active,
    aimPointerRay: () => { calls.push('aim') },
    raycaster,
    bedPlane: new THREE.Plane(new THREE.Vector3(0, 0, 1), 0),
    dragPoint: new THREE.Vector3(),
    moveTower: () => { calls.push('tower'); return route === 'tower' },
    movePart: () => { calls.push('part'); return route === 'part' },
    moveBody: () => { calls.push('body'); return route === 'body' },
    onBodyDragMove: () => { calls.push('selection') }
  })
  const event = {} as PointerEvent

  move(event)
  assert.deepEqual(calls, [])
  active = true
  move(event)
  assert.deepEqual(calls, ['aim', 'tower', 'part'])

  calls.length = 0
  route = 'body'
  move(event)
  assert.deepEqual(calls, ['aim', 'tower', 'part', 'body', 'selection'])

  calls.length = 0
  raycaster.set(new THREE.Vector3(0, 0, 10), new THREE.Vector3(1, 0, 0))
  move(event)
  assert.deepEqual(calls, ['aim'])
})

function rig() {
  const calls: string[] = []
  const orbit = { enabled: false }
  let capture = true
  const part = new THREE.Object3D()
  const body = new THREE.Group()
  let consumed = false
  let tower = false
  let movedPart: THREE.Object3D | null = null
  let movedBody: THREE.Group | null = null
  const release = createEditorPointerRelease({
    canvas: {
      hasPointerCapture: () => capture,
      releasePointerCapture: () => { capture = false; calls.push('capture') }
    },
    orbit,
    releaseSelectionClaim: () => { calls.push('claim') },
    finishMeasure: () => { calls.push('measure'); return consumed },
    finishText: () => { calls.push('text'); return false },
    finishPaint: () => { calls.push('paint'); return false },
    finishSelectionClick: () => { calls.push('selection') },
    clearBodyPeers: () => { calls.push('peers') },
    finishTower: () => { calls.push('tower'); return tower },
    finishPart: () => { calls.push('part'); return movedPart },
    finishBody: () => { calls.push('body'); return movedBody },
    syncSelectedTransform: (target) => { calls.push(target === part ? 'sync-part' : 'sync-body') },
    regenerateThumbnail: () => { calls.push('thumbnail') }
  })
  const event = { pointerId: 7 } as PointerEvent
  return {
    calls, orbit, part, body, event, release,
    setConsumed: () => { consumed = true },
    setTower: () => { tower = true },
    setPart: () => { movedPart = part },
    setBody: () => { movedBody = body },
    hasCapture: () => capture
  }
}

test('a tool release consumes the gesture before selection or drag cleanup', () => {
  const gesture = rig()
  gesture.setConsumed()
  gesture.release(gesture.event)
  assert.deepEqual(gesture.calls, ['claim', 'measure'])
  assert.equal(gesture.orbit.enabled, false)
  assert.equal(gesture.hasCapture(), true)
})

test('tower, part, and body releases keep their own sync and capture policy', () => {
  const tower = rig()
  tower.setTower()
  tower.release(tower.event)
  assert.deepEqual(tower.calls, ['claim', 'measure', 'text', 'paint', 'selection', 'peers', 'tower', 'capture'])
  assert.equal(tower.orbit.enabled, true)

  const part = rig()
  part.setPart()
  part.release(part.event)
  assert.deepEqual(part.calls.slice(-4), ['part', 'sync-part', 'capture', 'thumbnail'])
  assert.equal(part.calls.includes('body'), false)

  const body = rig()
  body.setBody()
  body.release(body.event)
  assert.deepEqual(body.calls.slice(-4), ['body', 'sync-body', 'capture', 'thumbnail'])
})
