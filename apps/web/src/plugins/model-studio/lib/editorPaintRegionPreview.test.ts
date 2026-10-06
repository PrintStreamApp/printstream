import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import { createEditorPaintRegionPreview } from './editorPaintRegionPreview'
import type { PaintToolType } from '../editorGeometry'
import type { SupportPaintBrushMode } from './supportPaint'

test('paint region preview reuses an unchanged seed and disposes replaced or cleared overlays', () => {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 10, 0, 0, 0, 10, 0], 3))
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial())
  const settings: {
    tool: PaintToolType
    mode: SupportPaintBrushMode
    filamentId: number | null
    filamentColors: Record<number, string> | undefined
  } = { tool: 'fill', mode: 'enforcer', filamentId: null, filamentColors: undefined }
  let regionReads = 0
  const preview = createEditorPaintRegionPreview({
    getSettings: () => settings,
    previewRegion: () => {
      regionReads += 1
      return { codes: { 0: '4' } }
    }
  })

  preview.update(mesh, 0, 'supports')
  const first = mesh.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>
  assert.equal(first.name, 'paint-region-preview')
  assert.equal(first.material.opacity, 0.55)
  assert.equal(regionReads, 1)

  preview.update(mesh, 0, 'supports')
  assert.equal(mesh.children[0], first)
  assert.equal(regionReads, 1, 'an unchanged seed does not recompute the fill')

  let firstDisposed = false
  first.geometry.addEventListener('dispose', () => { firstDisposed = true })
  settings.mode = 'blocker'
  preview.update(mesh, 0, 'supports')
  const second = mesh.children[0] as THREE.Mesh
  assert.notEqual(second, first)
  assert.equal(regionReads, 2)
  assert.equal(firstDisposed, true)
  assert.equal(first.parent, null)

  let secondDisposed = false
  second.geometry.addEventListener('dispose', () => { secondDisposed = true })
  preview.clear()
  assert.equal(mesh.children.length, 0)
  assert.equal(secondDisposed, true)
})

test('paint region preview clears stale overlays when the source has no region', () => {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 10, 0, 0, 0, 10, 0], 3))
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial())
  let hasRegion = true
  const preview = createEditorPaintRegionPreview({
    getSettings: () => ({ tool: 'fill', mode: 'enforcer', filamentId: null, filamentColors: undefined }),
    previewRegion: () => hasRegion ? { codes: { 0: '4' } } : null
  })

  preview.update(mesh, 0, 'supports')
  assert.equal(mesh.children.length, 1)
  hasRegion = false
  preview.update(mesh, 1, 'supports')
  assert.equal(mesh.children.length, 0)
  preview.update(null, null, 'supports')
  assert.equal(mesh.children.length, 0)
})
