import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import * as THREE from 'three'
import { installJsdomGlobals } from '../../test-utils/jsdom'
import { CONNECTOR_DEFAULTS, type CutConnector } from './lib/cutConnectors'
import { primitiveTriangleSoup } from './lib/primitives'
import type { GizmoMode } from './editorGeometry'

const dom = installJsdomGlobals()
const { cleanup, renderHook } = await import('@testing-library/react')
const { useEditorCutConnectorOverlay } = await import('./useEditorCutConnectorOverlay')

afterEach(cleanup)
after(() => dom.window.close())

function fixture(cutSoup: Float32Array | null, connectors: CutConnector[], placing: boolean) {
  const scene = new THREE.Scene()
  const group = new THREE.Group()
  const material = new THREE.MeshStandardMaterial()
  group.add(new THREE.Mesh(new THREE.BoxGeometry(20, 20, 20), material))
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(30, 30))
  scene.add(plane)
  const targets = { plane, section: null as THREE.Object3D | null, markers: [] as THREE.Object3D[] }
  const ghostRef: { current: THREE.Mesh | null } = { current: null }
  const view = renderHook(({ mode }: { mode: GizmoMode }) => {
    useEditorCutConnectorOverlay({
      sceneRef: { current: scene },
      groupByKeyRef: { current: new Map([['cube', group]]) },
      selectedKey: 'cube',
      gizmoMode: mode,
      cutSoup,
      placingConnectors: placing,
      cutAxis: 'z',
      clampedCutOffset: 10,
      cutConnectorFace: 'lower',
      cutConnectors: connectors,
      connectorSettings: CONNECTOR_DEFAULTS,
      activeProblems: new Map(),
      cutConnectorTargetsRef: { current: targets },
      cutPlaneMeshRef: { current: plane },
      connectorGhostRef: ghostRef
    })
  }, { initialProps: { mode: 'cut' as GizmoMode } })
  return { ...view, scene, group, material, plane, targets, ghostRef }
}

test('placed connector markers appear in the scene and leave with the Cut tool', () => {
  const connector: CutConnector = { ...CONNECTOR_DEFAULTS, id: 'peg', x: 0, y: 0, z: 10 }
  const setup = fixture(null, [connector], false)
  assert.equal(setup.targets.markers.length, 1)
  assert.equal(setup.targets.markers[0]?.userData.connectorId, 'peg')
  assert.equal(setup.scene.children.length, 2)

  setup.rerender({ mode: 'select' })
  assert.deepEqual(setup.targets.markers, [])
  assert.deepEqual(setup.scene.children, [setup.plane])
})

test('cut-face placement clips the model and restores its material and plane on exit', () => {
  const setup = fixture(primitiveTriangleSoup('cube'), [], true)
  assert.equal(setup.material.clippingPlanes?.length, 1)
  assert.ok(setup.ghostRef.current)
  assert.ok(setup.targets.section)
  assert.equal(setup.plane.visible, false)

  setup.rerender({ mode: 'select' })
  assert.equal(setup.material.clippingPlanes, null)
  assert.equal(setup.ghostRef.current, null)
  assert.equal(setup.targets.section, null)
  assert.equal(setup.plane.visible, true)
  assert.deepEqual(setup.scene.children, [setup.plane])
})
