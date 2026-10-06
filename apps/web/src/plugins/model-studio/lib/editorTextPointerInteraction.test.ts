import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import { createEditorTextPointerInteraction } from './editorTextPointerInteraction'
import type { PaintHit } from './editorPaintStroke'

function pointer(pointerId = 7): PointerEvent {
  return { pointerId } as PointerEvent
}

function createFixture() {
  const captured = new Set<number>()
  const canvas = {
    style: { cursor: '' },
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
  const placements: { point: THREE.Vector3; normal: THREE.Vector3; phase: 'start' | 'move' }[] = []
  const states: string[] = []
  const active: boolean[] = []
  const orbit: boolean[] = []
  let history = 0
  let thumbnails = 0
  let over = true
  let picked: PaintHit | null = hit
  let place = (point: THREE.Vector3, normal: THREE.Vector3, phase: 'start' | 'move') => {
    placements.push({ point, normal, phase })
  }

  const textPointer = createEditorTextPointerInteraction({
    canvas,
    overText: () => over,
    hitOnSelected: () => picked,
    recordHistory: () => { history += 1 },
    setInteractionActive: (value) => { active.push(value) },
    setOrbitEnabled: (value) => { orbit.push(value) },
    setTextInteraction: (value) => { states.push(value) },
    placeTextAt: (point, normal, phase) => { place(point, normal, phase) },
    regenerateThumbnail: () => { thumbnails += 1 }
  })

  return {
    canvas,
    captured,
    hit,
    placements,
    states,
    active,
    orbit,
    textPointer,
    get history() { return history },
    get thumbnails() { return thumbnails },
    setOver: (value: boolean) => { over = value },
    setPick: (value: PaintHit | null) => { picked = value },
    setPlace: (value: typeof place) => { place = value }
  }
}

test('text drag starts on text and surface, records once, and keeps off-model position', () => {
  const fixture = createFixture()
  const event = pointer()
  fixture.setOver(false)
  assert.equal(fixture.textPointer.begin(event), false)
  fixture.setOver(true)
  fixture.setPick(null)
  assert.equal(fixture.textPointer.begin(event), false)
  assert.equal(fixture.history, 0)

  fixture.setPick(fixture.hit)
  assert.equal(fixture.textPointer.begin(event), true)
  assert.equal(fixture.history, 1)
  assert.deepEqual(fixture.active, [true])
  assert.deepEqual(fixture.orbit, [false])
  assert.equal(fixture.captured.has(event.pointerId), true)
  assert.equal(fixture.canvas.style.cursor, 'grabbing')
  assert.deepEqual(fixture.states, ['drag'])
  assert.deepEqual(fixture.placements.map(({ phase }) => phase), ['start'])
  assert.notEqual(fixture.placements[0]?.point, fixture.hit.point)
  assert.notEqual(fixture.placements[0]?.normal, fixture.hit.normal)

  fixture.setPick(null)
  assert.equal(fixture.textPointer.move(event, true), true)
  assert.equal(fixture.placements.length, 1)
  fixture.setPick(fixture.hit)
  fixture.setPlace((point, normal, phase) => { fixture.placements.push({ point, normal, phase }) })
  assert.equal(fixture.textPointer.move(event, true), true)
  assert.deepEqual(fixture.placements.map(({ phase }) => phase), ['start', 'move'])
  assert.equal(fixture.history, 1)
})

test('text hover leaves other pointer handlers available and release restores orbit and cursor', () => {
  const fixture = createFixture()
  const event = pointer()
  assert.equal(fixture.textPointer.move(event, true), false)
  assert.equal(fixture.canvas.style.cursor, 'grab')
  assert.equal(fixture.states.at(-1), 'hover')
  fixture.setOver(false)
  assert.equal(fixture.textPointer.move(event, true), false)
  assert.equal(fixture.canvas.style.cursor, '')
  assert.equal(fixture.states.at(-1), 'idle')
  assert.equal(fixture.textPointer.move(event, false), false)

  fixture.setOver(true)
  assert.equal(fixture.textPointer.begin(event), true)
  assert.equal(fixture.textPointer.finish(event), true)
  assert.deepEqual(fixture.active, [true, false])
  assert.deepEqual(fixture.orbit, [false, true])
  assert.equal(fixture.canvas.style.cursor, 'grab')
  assert.equal(fixture.states.at(-1), 'hover')
  assert.equal(fixture.captured.size, 0)
  assert.equal(fixture.thumbnails, 1)
  assert.equal(fixture.textPointer.finish(event), false)
  assert.equal(fixture.thumbnails, 1)
})

test('teardown releases an in-progress text drag without committing a thumbnail', () => {
  const fixture = createFixture()
  assert.equal(fixture.textPointer.begin(pointer()), true)
  fixture.textPointer.reset()
  assert.deepEqual(fixture.active, [true, false])
  assert.deepEqual(fixture.orbit, [false, true])
  assert.equal(fixture.captured.size, 0)
  assert.equal(fixture.canvas.style.cursor, '')
  assert.equal(fixture.thumbnails, 0)
  assert.equal(fixture.textPointer.finish(pointer()), false)
})
