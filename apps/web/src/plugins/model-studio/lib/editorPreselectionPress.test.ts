import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'
import type { GizmoMode } from '../editorGeometry'
import { handleEditorPreselectionPress } from './editorPreselectionPress'

function fixture(mode: GizmoMode) {
  const calls: string[] = []
  const raycaster = new THREE.Raycaster()
  raycaster.set(new THREE.Vector3(0, 0, 10), new THREE.Vector3(0, 0, -1))
  const orbit = { enabled: true }
  const options = {
    event: { button: 0, pointerId: 8 } as PointerEvent,
    mode,
    gizmoAxis: null as string | null,
    cutConnectorMode: false,
    cutConnectorTargets: { plane: null, section: null, markers: [] },
    editCutConnector: () => { calls.push('cut-edit') },
    getSelectedGroup: () => null as THREE.Group | null,
    hitOnSelected: () => null as { point: THREE.Vector3 } | null,
    editBrimEar: () => { calls.push('ear-edit') },
    beginMeasure: () => { calls.push('measure') },
    beginPaint: () => { calls.push('paint'); return true },
    beginText: () => { calls.push('text'); return true },
    tower: null as THREE.Object3D | null,
    beginTowerDrag: () => { calls.push('tower-drag') },
    aimPointerRay: () => { calls.push('aim') },
    raycaster,
    bedPlane: new THREE.Plane(new THREE.Vector3(0, 0, 1), 0),
    dragPoint: new THREE.Vector3(),
    canvas: { setPointerCapture: () => { calls.push('capture') } },
    orbit
  }
  return { calls, options, orbit }
}

test('non-primary and gizmo-handle presses stop before tools', () => {
  const nonPrimary = fixture('measure')
  nonPrimary.options.event = { button: 2 } as PointerEvent
  assert.equal(handleEditorPreselectionPress(nonPrimary.options), true)
  assert.deepEqual(nonPrimary.calls, [])

  const gizmo = fixture('measure')
  gizmo.options.gizmoAxis = 'X'
  assert.equal(handleEditorPreselectionPress(gizmo.options), true)
  assert.deepEqual(gizmo.calls, [])
})

test('Measure and connector Cut consume presses, including a connector miss', () => {
  const measure = fixture('measure')
  assert.equal(handleEditorPreselectionPress(measure.options), true)
  assert.deepEqual(measure.calls, ['measure'])

  const cut = fixture('cut')
  cut.options.cutConnectorMode = true
  assert.equal(handleEditorPreselectionPress(cut.options), true)
  assert.deepEqual(cut.calls, ['aim'])
})

test('brim-ear misses reach object selection while hits edit the selected object', () => {
  const miss = fixture('brimEars')
  assert.equal(handleEditorPreselectionPress(miss.options), false)
  assert.deepEqual(miss.calls, [])

  const hit = fixture('brimEars')
  const group = new THREE.Group()
  hit.options.getSelectedGroup = () => group
  hit.options.hitOnSelected = () => ({ point: new THREE.Vector3(0, 0, 0) })
  assert.equal(handleEditorPreselectionPress(hit.options), true)
  assert.deepEqual(hit.calls, ['ear-edit'])
})

test('paint and text consume their hits before tower picking', () => {
  const paint = fixture('paintColor')
  assert.equal(handleEditorPreselectionPress(paint.options), true)
  assert.deepEqual(paint.calls, ['paint'])

  const text = fixture('text')
  assert.equal(handleEditorPreselectionPress(text.options), true)
  assert.deepEqual(text.calls, ['text'])
})

test('the tower stays directly draggable in resting mode but not in a picking tool', () => {
  const tower = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2))
  tower.position.z = 1
  tower.updateMatrixWorld(true)
  const resting = fixture('select')
  resting.options.tower = tower
  assert.equal(handleEditorPreselectionPress(resting.options), true)
  assert.deepEqual(resting.calls, ['aim', 'tower-drag', 'capture'])
  assert.equal(resting.orbit.enabled, false)

  const layFace = fixture('layFace')
  layFace.options.tower = tower
  assert.equal(handleEditorPreselectionPress(layFace.options), false)
  assert.deepEqual(layFace.calls, [])
})
