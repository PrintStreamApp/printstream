import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import * as THREE from 'three'
import { INHERITED_PLATE_SETTINGS, type EditorInstance, type EditorPlate, type EditorState } from './lib/editorModel'
import { installJsdomGlobals } from '../../test-utils/jsdom'

const dom = installJsdomGlobals()
const { act, cleanup, renderHook } = await import('@testing-library/react')
const { useEditorPlatePacking } = await import('./useEditorPlatePacking')
const { toast } = await import('../../lib/toast')

afterEach(() => { cleanup(); toast.clear() })
after(() => dom.window.close())

function packingFixture(locked = false) {
  const instance = {
    key: 'source', source: { kind: 'object' }, objectId: 7, instanceId: 0,
    name: 'Part', position: new THREE.Vector3(12, 12, 0), rotation: new THREE.Euler(),
    scale: new THREE.Vector3(1, 1, 1), filamentId: 1, printable: true, parts: [], color: null
  } satisfies EditorInstance
  const plate = {
    index: 1, plateId: 1, sourcePlateIndex: null, name: null,
    ...INHERITED_PLATE_SETTINGS,
    locked,
    bed: { minX: 0, maxX: 40, minY: 0, maxY: 40, maxZ: 100, excludeAreas: [] },
    instances: [instance], primeTower: null
  } satisfies EditorPlate
  const stateRef = { current: { plates: [plate] } as unknown as EditorState }
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(8, 8, 2), new THREE.MeshBasicMaterial())
  const group = new THREE.Group()
  group.position.copy(instance.position)
  group.add(mesh)
  const groupByKeyRef = { current: new Map([[instance.key, group]]) }
  const kinds: Array<'structure' | 'transform' | undefined> = []
  const updatePlates = (update: (plates: EditorPlate[]) => EditorPlate[], kind?: 'structure' | 'transform') => {
    kinds.push(kind)
    stateRef.current = { ...stateRef.current, plates: update(stateRef.current.plates) }
  }
  const view = renderHook(() => useEditorPlatePacking({
    activePlateIndex: 1,
    stateRef,
    groupByKeyRef,
    primeTowerObjRef: { current: null },
    instanceNozzlesRef: { current: () => new Set<number>() },
    updatePlates
  }))
  return { ...view, stateRef, kinds, mesh }
}

test('fill bed adds linked copies as one structure edit', () => {
  const fixture = packingFixture()
  act(() => fixture.result.current.handleFillBedWithCopies('source'))

  const instances = fixture.stateRef.current.plates[0]!.instances
  assert.ok(instances.length > 1)
  assert.deepEqual(fixture.kinds, ['structure'])
  assert.ok(instances.every((instance) => instance.objectId === 7))
  assert.equal(instances[0]?.key, 'source')
  fixture.mesh.geometry.dispose()
  fixture.mesh.material.dispose()
})

test('locked plates reject both automatic placement gestures', () => {
  const fixture = packingFixture(true)
  act(() => {
    fixture.result.current.handleArrangeAll()
    fixture.result.current.handleFillBedWithCopies('source')
  })
  assert.deepEqual(fixture.kinds, [])
  assert.equal(fixture.stateRef.current.plates[0]?.instances.length, 1)
  fixture.mesh.geometry.dispose()
  fixture.mesh.material.dispose()
})
