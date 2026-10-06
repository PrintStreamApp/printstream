import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import type { EditorImportStore } from './lib/editorImportStore'
import type { EditorProjectSource } from './lib/editorProjectSource'
import type { GeometryCache, ImportGeometryCache } from './editorGeometry'
import { installJsdomGlobals } from '../../test-utils/jsdom'

const dom = installJsdomGlobals()
const { cleanup, renderHook } = await import('@testing-library/react')
const { useEditorGeometryLoaders } = await import('./useEditorGeometryLoaders')

afterEach(cleanup)
after(() => dom.window.close())

/** A one-triangle binary STL for the parser's Node fallback. */
function tinyBinaryStl(): ArrayBuffer {
  const bytes = new Uint8Array(84 + 50)
  const view = new DataView(bytes.buffer)
  view.setUint32(80, 1, true)
  const vertices = [0, 0, 0, 1, 0, 0, 0, 1, 0]
  for (let index = 0; index < vertices.length; index += 1) {
    view.setFloat32(84 + 12 + index * 4, vertices[index]!, true)
  }
  return bytes.buffer
}

function loaderRefs() {
  return {
    geometryCacheRef: { current: new Map() as GeometryCache },
    importGeometryCacheRef: { current: new Map() as ImportGeometryCache }
  }
}

test('part imports dedupe shared parses and keep solid indexes distinct', async () => {
  const requestedParts: Array<number | undefined> = []
  const importStore = {
    fetchMesh: async (_importId: string, partIndex?: number) => {
      requestedParts.push(partIndex)
      return tinyBinaryStl()
    }
  } as EditorImportStore
  const projectSource = {} as EditorProjectSource
  const refs = loaderRefs()
  const view = renderHook(() => useEditorGeometryLoaders(projectSource, importStore, refs.geometryCacheRef, refs.importGeometryCacheRef))

  const first = view.result.current.fetchImportGeometry('assembly', 2)
  assert.equal(view.result.current.fetchImportGeometry('assembly', 2), first)
  const geometry = await first
  assert.equal(geometry.getAttribute('position').count, 3)
  const merged = await view.result.current.fetchImportGeometry('assembly')
  assert.notEqual(merged, geometry)
  assert.deepEqual(requestedParts, [2, undefined])
  assert.deepEqual([...refs.importGeometryCacheRef.current.keys()], ['assembly#2', 'assembly'])
})

test('a failed source entry load is retried instead of poisoning the cache', async () => {
  let attempts = 0
  const projectSource = {
    loadEntry: async () => {
      attempts += 1
      throw new Error('entry unavailable')
    }
  } as unknown as EditorProjectSource
  const importStore = {} as EditorImportStore
  const refs = loaderRefs()
  const view = renderHook(() => useEditorGeometryLoaders(projectSource, importStore, refs.geometryCacheRef, refs.importGeometryCacheRef))

  await assert.rejects(view.result.current.fetchGeometry('3D/Objects/a.model'), /entry unavailable/)
  assert.equal(refs.geometryCacheRef.current.size, 0)
  await assert.rejects(view.result.current.fetchGeometry('3D/Objects/a.model'), /entry unavailable/)
  assert.equal(attempts, 2)
})
