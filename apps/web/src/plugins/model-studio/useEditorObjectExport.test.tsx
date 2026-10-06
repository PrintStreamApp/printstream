import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import * as THREE from 'three'
import { installJsdomGlobals } from '../../test-utils/jsdom'
import { INHERITED_PLATE_SETTINGS, type EditorInstance, type EditorPlate, type EditorState } from './lib/editorModel'

const dom = installJsdomGlobals()
const { act, cleanup, renderHook } = await import('@testing-library/react')
const { useEditorObjectExport } = await import('./useEditorObjectExport')
const { toast } = await import('../../lib/toast')

afterEach(() => { cleanup(); toast.clear() })
after(() => dom.window.close())

function instance(key: string, name: string): EditorInstance {
  return {
    key, source: { kind: 'object' }, objectId: 1, instanceId: 0, name,
    position: new THREE.Vector3(), rotation: new THREE.Euler(), scale: new THREE.Vector3(1, 1, 1),
    filamentId: 1, printable: true, parts: [], color: null
  }
}

function plate(index: number, instances: EditorInstance[]): EditorPlate {
  return {
    index, plateId: index, sourcePlateIndex: null, name: null, ...INHERITED_PLATE_SETTINGS,
    bed: { minX: 0, maxX: 100, minY: 0, maxY: 100, maxZ: 100, excludeAreas: [] },
    instances, primeTower: null
  }
}

function group(): THREE.Group {
  const value = new THREE.Group()
  value.add(new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial()))
  return value
}

test('separate STL download names duplicates and reads the current active plate', () => {
  const first = instance('first', 'Bracket')
  const second = instance('second', 'Bracket')
  const otherPlate = instance('other', 'Other')
  const stateRef = { current: { plates: [plate(1, [first, second]), plate(2, [otherPlate])] } as EditorState }
  const groups = new Map([['first', group()], ['second', group()], ['other', group()]])
  const downloads: string[] = []
  const originalCreateUrl = URL.createObjectURL
  const originalRevokeUrl = URL.revokeObjectURL
  const originalClick = dom.window.HTMLAnchorElement.prototype.click
  const originalSetTimeout = globalThis.setTimeout
  URL.createObjectURL = () => 'blob:test-export'
  URL.revokeObjectURL = () => undefined
  dom.window.HTMLAnchorElement.prototype.click = function () { downloads.push(this.download) }
  globalThis.setTimeout = (() => 0) as unknown as typeof setTimeout

  try {
    let activePlateIndex = 1
    const { result, rerender } = renderHook(() => useEditorObjectExport({
      activePlateIndex,
      stateRef,
      groupByKeyRef: { current: groups },
      exportRequest: null,
      setExportRequest: () => undefined,
      saveAsBridgeId: null
    }))
    act(() => result.current.handleExportSeparateDownload(['first', 'second']))
    assert.deepEqual(downloads, ['Bracket.stl', 'Bracket (2).stl'])

    activePlateIndex = 2
    rerender()
    act(() => result.current.handleExportSeparateDownload(['first', 'other']))
    assert.deepEqual(downloads, ['Bracket.stl', 'Bracket (2).stl', 'Other.stl'])
  } finally {
    URL.createObjectURL = originalCreateUrl
    URL.revokeObjectURL = originalRevokeUrl
    dom.window.HTMLAnchorElement.prototype.click = originalClick
    globalThis.setTimeout = originalSetTimeout
    for (const entry of groups.values()) {
      entry.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose()
          child.material.dispose()
        }
      })
    }
  }
})
