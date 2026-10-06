import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'
import { installJsdomGlobals } from '../../test-utils/jsdom'
import { TEXT_HIGHLIGHT_COLORS, type GizmoMode, type TextInteraction } from './editorGeometry'

installJsdomGlobals()

const { renderHook } = await import('@testing-library/react')
const { useEditorTextHighlight } = await import('./useEditorTextHighlight')

test('hosted Text tint changes in place and clears on drag, tool exit, and unmount', () => {
  const group = new THREE.Group()
  const material = new THREE.MeshStandardMaterial()
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material)
  mesh.userData.addedPartKey = 'text-part'
  group.add(mesh)
  const meshRef = { current: null as THREE.Mesh | null }
  let mode: GizmoMode = 'text'
  let partKey: string | null = 'text-part'
  let interaction: TextInteraction = 'hover'
  const { rerender, unmount } = renderHook(() => useEditorTextHighlight({
    mode, partKey, selectedKey: 'host', hostKeyRef: { current: 'host' },
    groupByKeyRef: { current: new Map([['host', group]]) }, meshRef,
    interaction, meshVersion: 0
  }))

  assert.equal(meshRef.current, mesh)
  assert.equal(group.children[0], mesh)
  assert.equal(material.emissive.getHex(), TEXT_HIGHLIGHT_COLORS.hover)

  interaction = 'drag'
  rerender()
  assert.equal(meshRef.current, mesh)
  assert.equal(material.emissive.getHex(), 0x000000)

  interaction = 'idle'
  rerender()
  assert.equal(material.emissive.getHex(), TEXT_HIGHLIGHT_COLORS.idle)

  mode = 'select'
  rerender()
  assert.equal(meshRef.current, null)
  assert.equal(material.emissive.getHex(), 0x000000)

  mode = 'text'
  partKey = null
  rerender()
  assert.equal(meshRef.current, null, 'standalone text does not use a hosted part highlight')

  partKey = 'text-part'
  rerender()
  assert.equal(material.emissive.getHex(), TEXT_HIGHLIGHT_COLORS.idle)
  unmount()
  assert.equal(material.emissive.getHex(), 0x000000)
})
