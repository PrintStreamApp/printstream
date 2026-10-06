import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import { buildPlateInstances, countPlateLoadUnits, prefetchPlateGeometry } from './editorActivePlateBuildHelpers'
import type { EditorInstance, EditorPlate } from './editorModel'

test('plate progress counts each import solid and each project part', async () => {
  const plate = {
    instances: [
      { source: { kind: 'import', importId: 'staged' }, parts: [{}, {}] },
      { source: { kind: 'object' }, parts: [{ entryPath: 'one' }, { entryPath: 'two' }] }
    ]
  } as EditorPlate
  assert.equal(countPlateLoadUnits(plate), 4)

  const requests: string[] = []
  let loaded = 0
  prefetchPlateGeometry(
    plate,
    async (entryPath) => { requests.push(entryPath); return new Map() },
    async (importId, partIndex) => { requests.push(`${importId}:${partIndex}`); return new THREE.BufferGeometry() },
    () => { loaded += 1 }
  )
  await Promise.resolve()
  assert.deepEqual(requests, ['staged:0', 'staged:1', 'one', 'two'])
  assert.equal(loaded, 4)
})

test('a superseded model build disposes the late group before publication', async () => {
  let finishBuild: ((group: THREE.Group) => void) | null = null
  const groupReady = new Promise<THREE.Group>((resolve) => { finishBuild = resolve })
  const instance = { key: 'cube', position: { x: 0, y: 0, z: 0 } } as EditorInstance
  const plate = { instances: [instance] } as EditorPlate
  const target = new THREE.Group()
  const liveGroups = new Map<string, THREE.Group>()
  let cancelled = false
  let disposed = 0
  let published = 0
  const building = buildPlateInstances({
    plate,
    target,
    incremental: true,
    buildInstanceGroup: () => groupReady,
    isInstancePrinted: () => true,
    onIncrementalGroup: (key, group) => { liveGroups.set(key, group); published += 1 },
    setViewerError: () => assert.fail('cancelled build reported an error'),
    isCancelled: () => cancelled
  })

  const lateGroup = new THREE.Group()
  const geometry = new THREE.BoxGeometry(20, 20, 20)
  const disposeGeometry = geometry.dispose.bind(geometry)
  geometry.dispose = () => { disposed += 1; disposeGeometry() }
  lateGroup.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial()))
  cancelled = true
  finishBuild!(lateGroup)

  assert.equal(await building, null)
  assert.equal(disposed, 1)
  assert.equal(published, 0)
  assert.equal(target.children.length, 0)
  assert.equal(liveGroups.size, 0)
})
