import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'
import { handleEditorObjectPointerPress } from './editorObjectPointerPress'
import type { GizmoMode } from '../editorGeometry'

function fixture(mode: GizmoMode = 'select') {
  const calls: string[] = []
  const group = new THREE.Group()
  group.userData.instanceKey = 'object-b'
  const raycaster = new THREE.Raycaster()
  raycaster.set(new THREE.Vector3(0, 0, 10), new THREE.Vector3(0, 0, -1))
  const orbit = { enabled: true }
  const options = {
    event: { button: 0, pointerId: 7, ctrlKey: false, metaKey: false } as PointerEvent,
    group: group as THREE.Group | null,
    selectedKey: 'object-a' as string | null,
    extraSelectedKeys: [] as string[],
    getMode: () => mode,
    setMode: (next: GizmoMode) => { mode = next; calls.push(`mode:${next}`) },
    beginEmptyClick: () => { calls.push('empty') },
    beginCollapseClick: () => { calls.push('collapse') },
    toggleAdditiveSelection: () => { calls.push('toggle') },
    selectExclusive: () => { calls.push('select') },
    raycaster,
    bedPlane: new THREE.Plane(new THREE.Vector3(0, 0, 1), 0),
    dragPoint: new THREE.Vector3(),
    resetPanelSync: () => { calls.push('reset') },
    beginBodyDrag: () => { calls.push('drag') },
    beginCoDrag: () => { calls.push('co-drag') },
    canvas: { setPointerCapture: () => { calls.push('capture') } },
    orbit
  }
  return { calls, options, orbit }
}

test('empty and additive presses stop before object or tool handling', () => {
  const empty = fixture()
  empty.options.group = null
  assert.equal(handleEditorObjectPointerPress(empty.options), true)
  assert.deepEqual(empty.calls, ['empty'])

  const additive = fixture('translate')
  additive.options.event = { pointerId: 7, ctrlKey: true } as PointerEvent
  assert.equal(handleEditorObjectPointerPress(additive.options), true)
  assert.deepEqual(additive.calls, ['toggle'])
})

test('a new object drags only in Move, and a picking tool resets before drag', () => {
  const moving = fixture('translate')
  assert.equal(handleEditorObjectPointerPress(moving.options), true)
  assert.deepEqual(moving.calls, ['select', 'reset', 'drag', 'capture'])
  assert.equal(moving.orbit.enabled, false)

  const tool = fixture('layFace')
  assert.equal(handleEditorObjectPointerPress(tool.options), true)
  assert.deepEqual(tool.calls, ['select', 'mode:select'])

  const resting = fixture('select')
  assert.equal(handleEditorObjectPointerPress(resting.options), true)
  assert.deepEqual(resting.calls, ['select'])
})

test('a multi-selection member keeps the set and only Move begins co-drag', () => {
  const rotating = fixture('rotate')
  rotating.options.extraSelectedKeys = ['object-b']
  assert.equal(handleEditorObjectPointerPress(rotating.options), true)
  assert.deepEqual(rotating.calls, ['collapse'])

  const moving = fixture('translate')
  moving.options.extraSelectedKeys = ['object-b']
  assert.equal(handleEditorObjectPointerPress(moving.options), true)
  assert.deepEqual(moving.calls, ['collapse', 'reset', 'drag', 'co-drag', 'capture'])

  const selected = fixture('translate')
  selected.options.selectedKey = 'object-b'
  selected.options.extraSelectedKeys = ['object-c']
  assert.equal(handleEditorObjectPointerPress(selected.options), false)
  assert.deepEqual(selected.calls, ['collapse'])
})
