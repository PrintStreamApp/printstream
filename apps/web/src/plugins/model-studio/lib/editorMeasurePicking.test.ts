import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import { createEditorMeasurePicker, type MeasurePick } from './editorMeasurePicking'

/** A viewport whose centre ray hits the bed at the origin. */
function pickerFixture() {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100)
  camera.position.set(0, 0, 10)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld()
  const canvas = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 })
  } as unknown as HTMLCanvasElement
  const event = { clientX: 50, clientY: 50 } as PointerEvent
  const groups: THREE.Group[] = []
  const centreTargets: Array<{ object: THREE.Object3D; slot: number }> = []
  const picks: MeasurePick[] = []
  const pick = createEditorMeasurePicker({
    canvas,
    camera,
    pointer: new THREE.Vector2(),
    raycaster: new THREE.Raycaster(),
    bedPlane: new THREE.Plane(new THREE.Vector3(0, 0, 1), 0),
    getGroups: () => groups,
    getCentreTargets: () => centreTargets,
    getPicks: () => picks,
    getHoveredSource: () => null,
    getBed: () => ({ minX: -5, maxX: 5, minY: -5, maxY: 5 })
  })
  return { event, groups, centreTargets, picks, pick }
}

test('measure picker uses live scene groups and prefers model geometry over the bed', () => {
  const fixture = pickerFixture()
  const bed = fixture.pick(fixture.event, false)
  assert.equal(bed?.feature.kind, 'point')
  if (bed?.feature.kind === 'point') assert.equal(bed.feature.point.z, 0)

  const group = new THREE.Group()
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(4, 4).toNonIndexed(), new THREE.MeshBasicMaterial())
  mesh.position.z = 1
  group.add(mesh)
  group.updateMatrixWorld(true)
  fixture.groups.push(group)

  const model = fixture.pick(fixture.event, true)
  assert.equal(model?.feature.kind, 'point')
  assert.equal(model?.source.kind, 'plane')
  if (model?.feature.kind === 'point') assert.equal(model.feature.point.z, 1)
  mesh.geometry.dispose()
  mesh.material.dispose()
})

test('selected circle centre marker is pickable on a tap without prior hover', () => {
  const fixture = pickerFixture()
  const circle = {
    kind: 'circle' as const,
    center: new THREE.Vector3(0, 0, 0),
    normal: new THREE.Vector3(0, 0, 1),
    radius: 1,
    rim: []
  }
  const marker = new THREE.Mesh(new THREE.SphereGeometry(0.2), new THREE.MeshBasicMaterial())
  marker.position.z = 2
  marker.updateMatrixWorld(true)
  fixture.centreTargets.push({ object: marker, slot: 0 })
  fixture.picks.push({ feature: circle, source: circle })

  const picked = fixture.pick(fixture.event, false)
  assert.equal(picked?.source, circle)
  assert.equal(picked?.feature.kind, 'point')
  if (picked?.feature.kind === 'point') assert.deepEqual(picked.feature.point.toArray(), [0, 0, 0])
  marker.geometry.dispose()
  marker.material.dispose()
})
