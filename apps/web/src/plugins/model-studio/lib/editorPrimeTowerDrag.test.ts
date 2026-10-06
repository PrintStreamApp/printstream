import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import type { EditorPlate } from './editorModel'
import { createEditorPrimeTowerDrag } from './editorPrimeTowerDrag'

function bed(excludeAreas: EditorPlate['bed']['excludeAreas'] = []): EditorPlate['bed'] {
  return { minX: 0, maxX: 100, minY: 0, maxY: 100, maxZ: 100, excludeAreas }
}

test('prime tower drag keeps its full footprint on the bed and commits corner coordinates', () => {
  const tower = new THREE.Object3D()
  tower.position.set(50, 50, 0)
  tower.userData.towerWidth = 20
  tower.userData.towerDepth = 10
  const committed: number[][] = []
  const drag = createEditorPrimeTowerDrag({
    getBed: () => bed(),
    commitPosition: (x, y) => { committed.push([x, y]) }
  })

  drag.begin(tower, new THREE.Vector3(45, 48, 0))
  assert.equal(drag.active, true)
  assert.equal(drag.move(new THREE.Vector3(97, 95, 0)), true)
  assert.deepEqual(tower.position.toArray(), [90, 95, 0])
  assert.equal(drag.finish(), true)
  assert.deepEqual(committed, [[80, 90]])
  assert.equal(drag.active, false)
  assert.equal(drag.move(new THREE.Vector3(90, 90, 0)), false)
})

test('prime tower slides along an exclusion edge instead of entering it', () => {
  const tower = new THREE.Object3D()
  tower.position.set(50, 50, 0)
  tower.userData.towerWidth = 10
  tower.userData.towerDepth = 10
  const zone = { label: null, polygon: [
    { x: 60, y: 40 }, { x: 80, y: 40 }, { x: 80, y: 60 }, { x: 60, y: 60 }
  ] }
  const drag = createEditorPrimeTowerDrag({ getBed: () => bed([zone]), commitPosition: () => undefined })

  drag.begin(tower, new THREE.Vector3(50, 50, 0))
  drag.move(new THREE.Vector3(65, 55, 0))
  assert.deepEqual(tower.position.toArray(), [50, 55, 0])
})
