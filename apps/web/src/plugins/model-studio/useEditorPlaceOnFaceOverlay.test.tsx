import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import * as THREE from 'three'
import { installJsdomGlobals } from '../../test-utils/jsdom'
import type { GizmoMode } from './editorGeometry'

const dom = installJsdomGlobals()
const { cleanup, renderHook } = await import('@testing-library/react')
const { useEditorPlaceOnFaceOverlay } = await import('./useEditorPlaceOnFaceOverlay')

afterEach(cleanup)
after(() => dom.window.close())

test('Place on Face replaces a rebuilt hull and disposes it when the tool closes', () => {
  const geometry = new THREE.BoxGeometry(10, 10, 10)
  const group = new THREE.Group()
  group.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()))
  const groupsRef = { current: new Map([['object-1', group]]) }
  const faceHullRef = { current: null as THREE.Mesh | null }
  const { rerender } = renderHook(
    ({ mode, rebuildToken }: { mode: GizmoMode; rebuildToken: number }) =>
      useEditorPlaceOnFaceOverlay({
        mode,
        selectedKey: 'object-1',
        groupsRef,
        faceHullRef,
        rebuildToken,
        faceHullToken: 0
      }),
    { initialProps: { mode: 'select' as GizmoMode, rebuildToken: 0 } }
  )

  assert.equal(group.children.length, 1)
  rerender({ mode: 'layFace', rebuildToken: 0 })
  const firstHull = faceHullRef.current
  assert.ok(firstHull)
  assert.equal(group.children.length, 2)
  let disposed = 0
  firstHull.geometry.addEventListener('dispose', () => { disposed += 1 })

  rerender({ mode: 'layFace', rebuildToken: 1 })
  assert.equal(disposed, 1)
  assert.notEqual(faceHullRef.current, firstHull)
  assert.equal(group.children.length, 2)

  rerender({ mode: 'select', rebuildToken: 1 })
  assert.equal(faceHullRef.current, null)
  assert.equal(group.children.length, 1)
  geometry.dispose()
})
