import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'
import { createCutConnectorHover, pickCutConnectorEdit } from './editorCutConnectorPicking'

function downRay(): THREE.Raycaster {
  const raycaster = new THREE.Raycaster()
  raycaster.set(new THREE.Vector3(0, 0, 10), new THREE.Vector3(0, 0, -1))
  return raycaster
}

test('a connector marker can be removed even while covering the cut section', () => {
  const marker = new THREE.Group()
  marker.userData.connectorId = 'connector-1'
  const markerMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1))
  marker.add(markerMesh)
  marker.position.z = 1
  marker.updateMatrixWorld(true)
  const section = new THREE.Mesh(new THREE.PlaneGeometry(4, 4))
  section.updateMatrixWorld(true)

  assert.deepEqual(pickCutConnectorEdit(downRay(), {
    plane: new THREE.Object3D(), section, markers: [marker]
  }), { kind: 'remove', id: 'connector-1' })

  markerMesh.geometry.dispose()
  section.geometry.dispose()
})

test('a section hit is exact, with an infinite-plane fallback outside the preview', () => {
  const section = new THREE.Mesh(new THREE.PlaneGeometry(2, 2))
  section.updateMatrixWorld(true)
  const plane = new THREE.Object3D()
  assert.deepEqual(pickCutConnectorEdit(downRay(), { plane, section, markers: [] }), {
    kind: 'add', worldPoint: new THREE.Vector3(0, 0, 0)
  })

  const outsidePreview = new THREE.Raycaster()
  outsidePreview.set(new THREE.Vector3(5, 0, 10), new THREE.Vector3(0, 0, -1))
  assert.deepEqual(pickCutConnectorEdit(outsidePreview, { plane, section, markers: [] }), {
    kind: 'add', worldPoint: new THREE.Vector3(5, 0, 0)
  })

  const parallel = new THREE.Raycaster()
  parallel.set(new THREE.Vector3(0, 0, 10), new THREE.Vector3(1, 0, 0))
  assert.equal(pickCutConnectorEdit(parallel, { plane, section, markers: [] }), null)
  section.geometry.dispose()
})

test('connector hover follows the live section and releases its copy cursor', () => {
  const canvas = {
    style: { cursor: '' },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 })
  } as unknown as HTMLCanvasElement
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100)
  camera.position.z = 10
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld()
  const section = new THREE.Mesh(new THREE.PlaneGeometry(4, 4))
  section.updateMatrixWorld(true)
  let active = true
  let currentSection: THREE.Object3D | null = section
  const hovers: Array<THREE.Vector3 | null> = []
  const hover = createCutConnectorHover({
    canvas,
    camera,
    pointer: new THREE.Vector2(),
    raycaster: new THREE.Raycaster(),
    isActive: () => active,
    getSection: () => currentSection,
    showHover: (point) => { hovers.push(point) }
  })
  const centre = { clientX: 50, clientY: 50 } as PointerEvent
  hover.update(centre)
  assert.equal(canvas.style.cursor, 'copy')
  assert.deepEqual(hovers[0], new THREE.Vector3(0, 0, 0))

  currentSection = null
  hover.update(centre)
  assert.equal(canvas.style.cursor, '')
  assert.equal(hovers.at(-1), null)
  currentSection = section
  hover.update(centre)
  active = false
  hover.update(centre)
  assert.equal(canvas.style.cursor, '')
  active = true
  hover.update(centre)
  assert.equal(canvas.style.cursor, 'copy')
  hover.dispose()
  assert.equal(canvas.style.cursor, '')
  section.geometry.dispose()
})
