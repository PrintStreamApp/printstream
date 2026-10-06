import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'
import type { StagedImport } from '@printstream/shared'
import { instanceFromStagedImport, seedEmptyEditorState } from './editorModel'
import { captureEditorPlateThumbnails, shouldCapturePlateThumbnail } from './editorPlateThumbnailCapture'
import type { PlateThumbnailRenderer } from './plateThumbnail'

test('thumbnail capture skips unopened plates and pending displaced scenes', async () => {
  const state = seedEmptyEditorState()
  const opened = state.plates[0]!
  opened.sourcePlateIndex = opened.index
  const unopened = { ...opened, plateId: opened.plateId + 1, index: 2, sourcePlateIndex: 2 }
  const displaced = { ...opened, plateId: opened.plateId + 2, index: 3, sourcePlateIndex: 2 }
  state.plates.push(unopened, displaced)
  const liveThumbnails = { [opened.plateId]: 'data:image/png;base64,old' }

  assert.equal(shouldCapturePlateThumbnail(unopened, {}, liveThumbnails, new Set()), false)
  assert.equal(shouldCapturePlateThumbnail(displaced, {}, liveThumbnails, new Set([displaced.plateId])), false)
  assert.equal(shouldCapturePlateThumbnail(displaced, {}, liveThumbnails, new Set()), true)
  assert.equal(shouldCapturePlateThumbnail(unopened, { force: true, only: new Set([unopened.plateId]) }, liveThumbnails, new Set()), true)

  const rendered: number[] = []
  const updated: number[] = []
  const renderer: PlateThumbnailRenderer = {
    render: (_group, bed) => {
      rendered.push(bed.minX)
      return 'data:image/png;base64,fresh'
    },
    dispose: () => {}
  }
  opened.bed = { ...opened.bed, minX: 1 }
  displaced.bed = { ...displaced.bed, minX: 3 }
  const captured = await captureEditorPlateThumbnails(state, { updateLive: false }, {
    renderer,
    buildInstanceGroup: async () => null,
    getLiveThumbnails: () => liveThumbnails,
    getPendingScenePlates: () => new Set(),
    setLiveThumbnail: (plateId) => updated.push(plateId)
  })
  assert.deepEqual(rendered, [1, 3])
  assert.deepEqual(captured, [
    { plateIndex: 1, png: 'fresh' },
    { plateIndex: 3, png: 'fresh' }
  ])
  assert.deepEqual(updated, [], 'synthetic capture must not repaint live strip tiles')

  rendered.length = 0
  const pending = new Set([displaced.plateId])
  const afterArrival = await captureEditorPlateThumbnails(state, {}, {
    renderer,
    buildInstanceGroup: async () => null,
    getLiveThumbnails: () => liveThumbnails,
    getPendingScenePlates: () => pending,
    setLiveThumbnail: (plateId) => {
      if (plateId === opened.plateId) pending.delete(displaced.plateId)
    }
  })
  assert.deepEqual(rendered, [1, 3], 'a scene arriving during capture is read for its plate')
  assert.deepEqual(afterArrival.map((row) => row.plateIndex), [1, 3])
})

test('cancellation after an async group build disposes its geometry', async () => {
  const state = seedEmptyEditorState()
  const staged: StagedImport = {
    importId: 'cube', name: 'Cube', format: 'stl', triangleCount: 1,
    bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } }, parts: []
  }
  state.plates[0]!.instances.push(instanceFromStagedImport(staged))
  const controller = new AbortController()
  const geometry = new THREE.BufferGeometry()
  let disposed = false
  geometry.addEventListener('dispose', () => { disposed = true })
  const renderer: PlateThumbnailRenderer = {
    render: () => assert.fail('cancelled capture reached the renderer'),
    dispose: () => {}
  }

  await assert.rejects(captureEditorPlateThumbnails(state, { force: true, signal: controller.signal }, {
    renderer,
    buildInstanceGroup: async () => {
      const group = new THREE.Group()
      group.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()))
      controller.abort()
      return group
    },
    getLiveThumbnails: () => ({}),
    getPendingScenePlates: () => new Set(),
    setLiveThumbnail: () => assert.fail('cancelled capture changed a live thumbnail')
  }), { name: 'AbortError' })
  assert.equal(disposed, true)
})
