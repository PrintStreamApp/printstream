import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import { createEditorPaintPointerInteraction } from './editorPaintPointerInteraction'
import type { PaintHit } from './editorPaintStroke'

function pointer(pointerId = 9): PointerEvent {
  return { pointerId, clientX: 12, clientY: 24 } as PointerEvent
}

function createFixture() {
  const captured = new Set<number>()
  const canvas = {
    setPointerCapture: (id: number) => { captured.add(id) },
    hasPointerCapture: (id: number) => captured.has(id),
    releasePointerCapture: (id: number) => { captured.delete(id) }
  } as unknown as HTMLCanvasElement
  const hit: PaintHit = {
    mesh: new THREE.Mesh(),
    point: new THREE.Vector3(1, 2, 3),
    normal: new THREE.Vector3(0, 0, 1),
    faceIndex: 0
  }
  let picked: PaintHit | null = hit
  let pickingCount = 0
  let visible = false
  let history = 0
  let thumbnails = 0
  let committed = 0
  let applied = 0
  const hover: (PaintHit | null)[] = []
  const active: boolean[] = []
  const orbit: boolean[] = []
  const stroke = {
    active: false,
    start: (_hit: PaintHit, _x: number, _y: number) => { stroke.active = true; applied += 1 },
    move: (_x: number, _y: number): PaintHit | null => { applied += 1; return picked },
    reset: () => { stroke.active = false }
  }
  const paintPointer = createEditorPaintPointerInteraction({
    canvas,
    stroke,
    hitOnSelected: () => { pickingCount += 1; return picked },
    updateHover: (value) => { hover.push(value); visible = value !== null },
    hoverVisible: () => visible,
    clearHover: () => { visible = false; hover.push(null) },
    recordHistory: () => { history += 1 },
    setInteractionActive: (value) => { active.push(value) },
    setOrbitEnabled: (value) => { orbit.push(value) },
    regenerateThumbnail: () => { thumbnails += 1 },
    paintCommitted: () => { committed += 1 }
  })

  return {
    captured,
    hit,
    stroke,
    hover,
    active,
    orbit,
    paintPointer,
    get pickingCount() { return pickingCount },
    get history() { return history },
    get thumbnails() { return thumbnails },
    get committed() { return committed },
    get applied() { return applied },
    setPick: (value: PaintHit | null) => { picked = value }
  }
}

test('paint press misses fall through; a hit records one history step and owns the pointer', () => {
  const fixture = createFixture()
  const event = pointer()
  fixture.setPick(null)
  assert.equal(fixture.paintPointer.begin(event), false)
  assert.equal(fixture.history, 0)
  assert.equal(fixture.captured.size, 0)

  fixture.setPick(fixture.hit)
  assert.equal(fixture.paintPointer.begin(event), true)
  assert.equal(fixture.history, 1)
  assert.equal(fixture.applied, 1)
  assert.deepEqual(fixture.active, [true])
  assert.deepEqual(fixture.orbit, [false])
  assert.equal(fixture.captured.has(event.pointerId), true)
  assert.equal(fixture.hover.at(-1), fixture.hit)
})

test('paint move uses the stroke hit once; release signals one thumbnail and paint commit', () => {
  const fixture = createFixture()
  const event = pointer()
  assert.equal(fixture.paintPointer.move(event, true), false)
  assert.equal(fixture.pickingCount, 1)
  assert.equal(fixture.paintPointer.begin(event), true)
  const beforeMovePicks = fixture.pickingCount
  fixture.setPick(null)
  assert.equal(fixture.paintPointer.move(event, true), true)
  assert.equal(fixture.pickingCount, beforeMovePicks, 'stroke sampling already resolved hover')
  assert.equal(fixture.hover.at(-1), null)
  assert.equal(fixture.paintPointer.finish(event), true)
  assert.equal(fixture.stroke.active, false)
  assert.deepEqual(fixture.active, [true, false])
  assert.deepEqual(fixture.orbit, [false, true])
  assert.equal(fixture.captured.size, 0)
  assert.equal(fixture.thumbnails, 1)
  assert.equal(fixture.committed, 1)
  assert.equal(fixture.paintPointer.finish(event), false)
  assert.equal(fixture.committed, 1)
})

test('paint hover clears on mode exit and teardown cancels a captured stroke', () => {
  const fixture = createFixture()
  const event = pointer()
  assert.equal(fixture.paintPointer.move(event, true), false)
  assert.equal(fixture.paintPointer.move(event, false), false)
  assert.equal(fixture.hover.at(-1), null)

  assert.equal(fixture.paintPointer.begin(event), true)
  fixture.paintPointer.reset()
  assert.equal(fixture.stroke.active, false)
  assert.equal(fixture.captured.size, 0)
  assert.deepEqual(fixture.active, [true, false])
  assert.deepEqual(fixture.orbit, [false, true])
  assert.equal(fixture.thumbnails, 0)
  assert.equal(fixture.committed, 0)
})
