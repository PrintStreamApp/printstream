import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import * as THREE from 'three'
import { installJsdomGlobals } from '../../test-utils/jsdom'
import { INHERITED_PLATE_SETTINGS, type EditorPlate, type EditorState } from './lib/editorModel'

const dom = installJsdomGlobals()
const { act, cleanup, renderHook } = await import('@testing-library/react')
const { useEditorObjectPlacement } = await import('./useEditorObjectPlacement')
const { toast } = await import('../../lib/toast')

afterEach(() => { cleanup(); toast.clear() })
after(() => dom.window.close())

function placementFixture(options: { locked?: boolean; maxZ?: number | null } = {}) {
  const plate: EditorPlate = {
    index: 1, plateId: 1, sourcePlateIndex: null, name: null,
    ...INHERITED_PLATE_SETTINGS,
    locked: options.locked ?? false,
    bed: { minX: 0, maxX: 100, minY: 0, maxY: 100, maxZ: options.maxZ ?? 100, excludeAreas: [] },
    instances: [], primeTower: null
  }
  if (options.maxZ === null) plate.bed.maxZ = null

  const groups = new Map<string, THREE.Group>()
  for (const [key, x] of [['first', 10], ['second', 30]] as const) {
    const group = new THREE.Group()
    group.position.set(x, 10, 1)
    group.add(new THREE.Mesh(new THREE.BoxGeometry(4, 4, 2), new THREE.MeshBasicMaterial()))
    groups.set(key, group)
  }
  const events: string[] = []
  const view = renderHook(() => useEditorObjectPlacement({
    selectedKey: 'first',
    selectedKeyRef: { current: 'first' },
    allSelectedKeysRef: { current: () => ['first', 'second'] },
    activePlateIndex: 1,
    stateRef: { current: { plates: [plate] } as EditorState },
    groupByKeyRef: { current: groups },
    recordHistory: () => events.push('history'),
    bakeExactMatrix: (group) => events.push(`bake:${[...groups].find(([, value]) => value === group)?.[0]}`),
    writeBackGroupTransform: (group) => events.push(`write:${[...groups].find(([, value]) => value === group)?.[0]}`),
    syncSelectedTransform: (group) => events.push(`sync:${[...groups].find(([, value]) => value === group)?.[0]}`),
    regenerateActivePlateThumbnail: () => events.push('thumbnail')
  }))
  return { ...view, groups, events }
}

test('nudge and centre preserve the multi-selection spacing with one checkpoint each', () => {
  const fixture = placementFixture()
  const first = fixture.groups.get('first')!
  const second = fixture.groups.get('second')!

  act(() => fixture.result.current.nudgeSelection(5, -2))
  assert.deepEqual([first.position.x, second.position.x], [15, 35])
  assert.deepEqual(fixture.events, [
    'history', 'bake:first', 'write:first', 'bake:second', 'write:second', 'sync:first', 'thumbnail'
  ])

  fixture.events.length = 0
  act(() => fixture.result.current.centerSelectionOnPlate())
  assert.deepEqual([first.position.x, second.position.x], [40, 60])
  assert.deepEqual([first.position.y, second.position.y], [50, 50])
  assert.deepEqual(fixture.events, [
    'history', 'bake:first', 'write:first', 'bake:second', 'write:second', 'sync:first', 'thumbnail'
  ])
})

test('locked auto-orient and unknown-height scale leave the scene and history alone', () => {
  const locked = placementFixture({ locked: true })
  act(() => locked.result.current.handleAutoOrient())
  assert.deepEqual(locked.events, [])
  assert.deepEqual(locked.groups.get('first')!.rotation.toArray(), [0, 0, 0, 'XYZ'])

  const unknownHeight = placementFixture({ maxZ: null })
  act(() => unknownHeight.result.current.handleScaleToPrintVolume())
  assert.deepEqual(unknownHeight.events, [])
  assert.deepEqual(unknownHeight.groups.get('first')!.scale.toArray(), [1, 1, 1])
})
