import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'
import { installJsdomGlobals } from '../../test-utils/jsdom'
import type { PartRef } from './lib/selectionModel'

installJsdomGlobals()

const { renderHook } = await import('@testing-library/react')
const { useEditorManualTransforms } = await import('./useEditorManualTransforms')

function ref<T>(current: T) { return { current } }

test('added-part manual and keyboard transforms use local placement and one history step', () => {
  const group = new THREE.Group()
  const rotor = new THREE.Group()
  rotor.rotation.z = Math.PI / 2
  const part = new THREE.Group()
  part.userData.addedPartKey = 'part-1'
  group.add(rotor)
  rotor.add(part)

  const events: string[] = []
  const selectedKeyRef = ref<string | null>('instance-1')
  const gizmoPartRef = ref<PartRef | null>({ objectId: 1, member: { kind: 'added', key: 'part-1' } })
  const { result } = renderHook(() => useEditorManualTransforms({
    selectedKeyRef,
    groupByKeyRef: ref(new Map([['instance-1', group]])),
    gizmoPartRef,
    uniformScale: false,
    recordHistory: () => events.push('history'),
    writeBackPart: (object) => { assert.equal(object, part); events.push('write') },
    syncSelectedTransform: (object) => { assert.equal(object, part); events.push('sync') },
    regenerateActivePlateThumbnail: () => events.push('thumbnail'),
    mutateSelectedGroup: () => assert.fail('added part changed the object transform'),
    nudgeSelection: () => assert.fail('added part nudged the object selection')
  }))

  result.current.applyManualPosition('z', 4)
  assert.equal(part.position.z, 4)
  assert.deepEqual(events, ['history', 'write', 'sync', 'thumbnail'])

  result.current.applyManualRotation('x', 90)
  assert.ok(Math.abs(part.rotation.x - Math.PI / 2) < 1e-6)
  result.current.applyManualScale('y', 150)
  assert.equal(part.scale.y, 1.5)
  assert.equal(part.scale.x, 1)

  // The keyboard speaks plate coordinates even though the stored part placement is object-local.
  result.current.nudgeTransform(5, 0)
  group.updateWorldMatrix(true, true)
  const world = part.getWorldPosition(new THREE.Vector3())
  assert.ok(Math.abs(world.x - 5) < 1e-6)
  assert.ok(Math.abs(world.y) < 1e-6)
})

test('selected body falls through to instance transforms without part history', () => {
  const group = new THREE.Group()
  const events: string[] = []
  const { result } = renderHook(() => useEditorManualTransforms({
    selectedKeyRef: ref<string | null>('instance-1'),
    groupByKeyRef: ref(new Map([['instance-1', group]])),
    gizmoPartRef: ref<PartRef | null>({ objectId: 1, member: { kind: 'body' } }),
    uniformScale: true,
    recordHistory: () => events.push('part-history'),
    writeBackPart: () => assert.fail('body wrote as a part'),
    syncSelectedTransform: () => events.push('part-sync'),
    regenerateActivePlateThumbnail: () => events.push('part-thumbnail'),
    mutateSelectedGroup: (mutate) => { events.push('object'); mutate(group) },
    nudgeSelection: (dx, dy) => events.push(`nudge:${dx},${dy}`)
  }))

  result.current.applyManualPosition('x', 7)
  result.current.applyManualScale('y', 200)
  result.current.rotateTransformZ(Math.PI / 4)
  result.current.nudgeTransform(2, -3)

  assert.equal(group.position.x, 7)
  assert.deepEqual(group.scale.toArray(), [2, 2, 2])
  assert.ok(Math.abs(group.rotation.z - Math.PI / 4) < 1e-6)
  assert.deepEqual(events, ['object', 'object', 'object', 'nudge:2,-3'])
})

test('baked-part manual position composes with its mesh matrix before writeback', () => {
  const group = new THREE.Group()
  const part = new THREE.Group()
  part.userData.partRef = { componentObjectId: 20, partIndex: 2 }
  part.position.x = 1
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial())
  mesh.position.x = 4
  part.add(mesh)
  group.add(part)

  const events: string[] = []
  const { result } = renderHook(() => useEditorManualTransforms({
    selectedKeyRef: ref<string | null>('instance-1'),
    groupByKeyRef: ref(new Map([['instance-1', group]])),
    gizmoPartRef: ref<PartRef | null>({ objectId: 7, member: { kind: 'baked', partIndex: 2 } }),
    uniformScale: false,
    recordHistory: () => events.push('history'),
    writeBackPart: (object) => { assert.equal(object, part); events.push('write') },
    syncSelectedTransform: (object) => { assert.equal(object, part); events.push('sync') },
    regenerateActivePlateThumbnail: () => events.push('thumbnail'),
    mutateSelectedGroup: () => assert.fail('baked part changed the object transform'),
    nudgeSelection: () => assert.fail('baked part nudged the object selection')
  }))

  result.current.applyManualPosition('x', 9)
  assert.equal(part.position.x, 5)
  assert.equal(mesh.position.x, 4)
  assert.deepEqual(events, ['history', 'write', 'sync', 'thumbnail'])
})
