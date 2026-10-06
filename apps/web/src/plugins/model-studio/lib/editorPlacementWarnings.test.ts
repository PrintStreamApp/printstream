import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import { INHERITED_PLATE_SETTINGS, type EditorInstance, type EditorPlate } from './editorModel'
import { createEditorPlacementWarningRecompute, type PlacementFootprintCache } from './editorPlacementWarnings'
import type { PlacementWarning } from '../editorGeometry'

test('placement footprints shift on moves and rebuild for rotor changes and new scene groups', () => {
  const instance = {
    key: 'part', source: { kind: 'object' }, objectId: 7, instanceId: 0,
    name: 'Part', position: new THREE.Vector3(12, 12, 0), rotation: new THREE.Euler(),
    scale: new THREE.Vector3(1, 1, 1), filamentId: 1, printable: true, parts: [], color: null
  } satisfies EditorInstance
  const plate = {
    index: 1, plateId: 1, sourcePlateIndex: null, name: null,
    ...INHERITED_PLATE_SETTINGS,
    locked: false,
    bed: { minX: 0, maxX: 80, minY: 0, maxY: 80, maxZ: 100, excludeAreas: [] },
    instances: [instance], primeTower: null
  } satisfies EditorPlate
  const makeGroup = () => {
    const group = new THREE.Group()
    const rotor = new THREE.Group()
    group.userData.rotor = rotor
    group.position.copy(instance.position)
    rotor.add(new THREE.Mesh(new THREE.BoxGeometry(8, 5, 2), new THREE.MeshBasicMaterial()))
    group.add(rotor)
    return { group, rotor }
  }
  const first = makeGroup()
  const groups = new Map([[instance.key, first.group]])
  const activePlateRef: { current: EditorPlate | null } = { current: plate }
  const cache: PlacementFootprintCache = new Map()
  const published: PlacementWarning[][] = []
  const recompute = createEditorPlacementWarningRecompute({
    activePlateRef,
    groupByKeyRef: { current: groups },
    isInstancePrintedRef: { current: () => true },
    instanceNozzlesRef: { current: () => new Set<number>() },
    footprintCacheRef: { current: cache },
    primeTowerObjRef: { current: null },
    lastWarningSigRef: { current: '' },
    placementWarningsSetterRef: { current: (warnings) => { published.push(warnings) } }
  })

  recompute()
  const initial = cache.get(instance.key)
  assert.ok(initial)
  assert.equal(initial.group, first.group)
  recompute()
  assert.equal(published.length, 1, 'an unchanged warning set is not published twice')

  first.group.position.x += 2
  recompute()
  assert.equal(cache.get(instance.key), initial, 'translation reuses the original raster')

  first.rotor.rotation.z = Math.PI / 4
  recompute()
  const rotated = cache.get(instance.key)
  assert.ok(rotated)
  assert.notEqual(rotated, initial, 'rotor rotation invalidates the raster')

  const replacement = makeGroup()
  groups.set(instance.key, replacement.group)
  recompute()
  assert.equal(cache.get(instance.key)?.group, replacement.group)
  assert.notEqual(cache.get(instance.key), rotated, 'a rebuilt group invalidates the old raster')

  activePlateRef.current = null
  recompute()
  assert.equal(cache.size, 0, 'closing the plate releases cached scene groups')
})
