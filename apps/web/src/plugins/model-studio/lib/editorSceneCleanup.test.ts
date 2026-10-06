import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'
import type { GeometryCache, ImportGeometryCache } from '../editorGeometry'
import { disposeEditorSceneCaches, releaseEditorWebglCanvas } from './editorSceneCleanup'

test('context recovery is released before deliberate context loss and canvas removal', () => {
  const calls: string[] = []
  const canvas = {} as HTMLCanvasElement
  releaseEditorWebglCanvas({
    releaseContextRecovery: () => { calls.push('listener') },
    renderer: {
      domElement: canvas,
      dispose: () => { calls.push('dispose') },
      forceContextLoss: () => { calls.push('context-loss') }
    },
    container: {
      removeChild: (child: Node) => {
        assert.equal(child, canvas)
        calls.push('remove')
        return child
      }
    } as Pick<HTMLElement, 'removeChild'>
  })
  assert.deepEqual(calls, ['listener', 'dispose', 'context-loss', 'remove'])
})

test('cache ownership clears synchronously and pending geometries dispose on settle', async () => {
  const disposed: string[] = []
  const baked = new THREE.BufferGeometry()
  const imported = new THREE.BufferGeometry()
  baked.dispose = () => { disposed.push('baked') }
  imported.dispose = () => { disposed.push('imported') }
  let finishBaked: ((value: Map<number, THREE.BufferGeometry>) => void) | undefined
  let finishImported: ((value: THREE.BufferGeometry) => void) | undefined
  const geometryCache: GeometryCache = new Map([
    ['pending', new Promise((resolve) => { finishBaked = resolve })],
    ['failed', Promise.reject(new Error('load failed'))]
  ])
  const importGeometryCache: ImportGeometryCache = new Map([
    ['pending', new Promise((resolve) => { finishImported = resolve })]
  ])

  disposeEditorSceneCaches(geometryCache, importGeometryCache)
  assert.equal(geometryCache.size, 0)
  assert.equal(importGeometryCache.size, 0)
  assert.deepEqual(disposed, [])

  finishBaked?.(new Map([[1, baked]]))
  finishImported?.(imported)
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(disposed, ['baked', 'imported'])
})
