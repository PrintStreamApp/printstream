import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import type { TransformControls } from 'three-stdlib'
import { createEditorTransformInteraction } from './editorTransformInteraction'
import type { GizmoMode } from '../editorGeometry'

type Event = { value?: boolean }

function transformStub() {
  const listeners = new Map<string, Set<(event: Event) => void>>()
  const stub = {
    object: null as THREE.Object3D | null,
    addEventListener(type: string, callback: (event: Event) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(callback)
    },
    removeEventListener(type: string, callback: (event: Event) => void) {
      listeners.get(type)?.delete(callback)
    },
    emit(type: string, event: Event = {}) {
      for (const callback of listeners.get(type) ?? []) callback(event)
    },
    listenerCount(type: string) { return listeners.get(type)?.size ?? 0 }
  }
  return stub
}

function model(x = 0): THREE.Group {
  const group = new THREE.Group()
  group.position.set(x, 0, 2)
  group.add(new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2),
    new THREE.MeshBasicMaterial()))
  return group
}

test('object drag records one checkpoint, syncs the panel, rests on release, and removes listeners', () => {
  const transform = transformStub()
  const group = model()
  transform.object = group
  const orbit = { enabled: true }
  const guides = new THREE.Group()
  let mode: GizmoMode = 'scale'
  const calls: string[] = []
  const interaction = createEditorTransformInteraction({
    transform: transform as unknown as TransformControls,
    orbit,
    multiPivot: new THREE.Group(),
    snapGuides: guides,
    getSelectedKey: () => 'one',
    getSelectedKeys: () => ['one'],
    groupFor: () => group,
    getMode: () => mode,
    bakeExactMatrix: () => { calls.push('bake') },
    writeBackGroupTransform: () => { calls.push('write') },
    writeBackPartMesh: () => { calls.push('part') },
    syncSelectedTransform: () => { calls.push('sync') },
    setRotationReadout: () => undefined,
    regenerateActiveThumbnail: () => { calls.push('thumbnail') },
    recordHistory: () => { calls.push('history') },
    setInteractionActive: () => undefined
  })

  assert.equal(transform.listenerCount('dragging-changed'), 1)
  assert.equal(transform.listenerCount('objectChange'), 1)
  transform.emit('dragging-changed', { value: true })
  assert.equal(interaction.isDragging, true)
  assert.equal(interaction.changedOrientation, true)
  assert.equal(orbit.enabled, false)
  assert.deepEqual(calls.slice(0, 2), ['history', 'bake'])

  for (let i = 0; i < 3; i += 1) transform.emit('objectChange')
  assert.equal(calls.filter((call) => call === 'sync').length, 1)
  assert.ok(Math.abs(group.position.z - 1) < 1e-6)
  transform.emit('dragging-changed', { value: false })
  assert.equal(interaction.isDragging, false)
  assert.equal(orbit.enabled, true)
  assert.equal(calls.filter((call) => call === 'history').length, 1)
  assert.equal(calls.at(-1), 'thumbnail')

  interaction.markTranslationDrag()
  assert.equal(interaction.changedOrientation, false)
  interaction.dispose()
  assert.equal(transform.listenerCount('dragging-changed'), 0)
  assert.equal(transform.listenerCount('objectChange'), 0)
  mode = 'rotate'
  transform.emit('dragging-changed', { value: true })
  assert.equal(calls.filter((call) => call === 'history').length, 1)
})

test('a part drag writes the part without resting or writing the host', () => {
  const transform = transformStub()
  const host = model()
  const part = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial())
  part.userData.addedPartKey = 'text'
  host.add(part)
  transform.object = part
  const calls: string[] = []
  const interaction = createEditorTransformInteraction({
    transform: transform as unknown as TransformControls,
    orbit: { enabled: true },
    multiPivot: new THREE.Group(),
    snapGuides: new THREE.Group(),
    getSelectedKey: () => 'one',
    getSelectedKeys: () => ['one'],
    groupFor: () => host,
    getMode: () => 'translate',
    bakeExactMatrix: () => undefined,
    writeBackGroupTransform: () => { calls.push('host') },
    writeBackPartMesh: () => { calls.push('part') },
    syncSelectedTransform: () => { calls.push('sync') },
    setRotationReadout: () => undefined,
    regenerateActiveThumbnail: () => undefined,
    recordHistory: () => undefined,
    setInteractionActive: () => undefined
  })
  transform.emit('dragging-changed', { value: true })
  transform.emit('objectChange')
  transform.emit('dragging-changed', { value: false })
  assert.deepEqual(calls, ['part', 'part', 'sync'])
  interaction.dispose()
})

test('multi-selection moves members from one press snapshot and writes both on release', () => {
  const transform = transformStub()
  const first = model(0)
  const second = model(10)
  const pivot = new THREE.Group()
  pivot.position.set(5, 0, 0)
  transform.object = pivot
  const groups = new Map([['first', first], ['second', second]])
  const written: THREE.Object3D[] = []
  let history = 0
  const interaction = createEditorTransformInteraction({
    transform: transform as unknown as TransformControls,
    orbit: { enabled: true },
    multiPivot: pivot,
    snapGuides: new THREE.Group(),
    getSelectedKey: () => 'first',
    getSelectedKeys: () => ['first', 'second'],
    groupFor: (key) => groups.get(key) ?? null,
    getMode: () => 'translate',
    bakeExactMatrix: () => undefined,
    writeBackGroupTransform: (group) => { written.push(group) },
    writeBackPartMesh: () => undefined,
    syncSelectedTransform: () => undefined,
    setRotationReadout: () => undefined,
    regenerateActiveThumbnail: () => undefined,
    recordHistory: () => { history += 1 },
    setInteractionActive: () => undefined
  })

  transform.emit('dragging-changed', { value: true })
  pivot.position.x = 8
  transform.emit('objectChange')
  assert.ok(Math.abs(first.position.x - 3) < 1e-6)
  assert.ok(Math.abs(second.position.x - 13) < 1e-6)
  transform.emit('dragging-changed', { value: false })
  assert.equal(history, 1)
  assert.deepEqual(written.slice(-2), [first, second])
  interaction.dispose()
})
