import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import * as THREE from 'three'
import { installJsdomGlobals } from '../../test-utils/jsdom'
import type { MeasurePick } from './lib/editorMeasurePicking'
import type { GizmoMode } from './editorGeometry'

const dom = installJsdomGlobals()
const { cleanup, renderHook } = await import('@testing-library/react')
const { useEditorMeasurementOverlay } = await import('./useEditorMeasurementOverlay')

afterEach(cleanup)
after(() => dom.window.close())

test('a circle centre pick publishes its mounted marker and releases it on tool exit', () => {
  const scene = new THREE.Scene()
  const sceneRef = { current: scene }
  const centreTargetsRef: { current: Array<{ object: THREE.Object3D; slot: number }> } = { current: [] }
  const center = new THREE.Vector3(10, 20, 5)
  const circle = {
    kind: 'circle' as const,
    center,
    normal: new THREE.Vector3(0, 0, 1),
    radius: 3,
    rim: [new THREE.Vector3(13, 20, 5), new THREE.Vector3(10, 23, 5)]
  }
  const picks: MeasurePick[] = [{ feature: { kind: 'point', point: center.clone() }, source: circle }]
  const view = renderHook(({ mode }: { mode: GizmoMode }) => {
    useEditorMeasurementOverlay({
      sceneRef,
      gizmoMode: mode,
      measurePoints: picks,
      measureResult: null,
      measureCentreTargetsRef: centreTargetsRef,
      sceneReady: true,
      rebuildToken: 0
    })
  }, { initialProps: { mode: 'measure' as GizmoMode } })

  assert.equal(scene.children.length, 1)
  assert.equal(centreTargetsRef.current.length, 1)
  assert.equal(centreTargetsRef.current[0]?.slot, 0)
  assert.ok(centreTargetsRef.current[0]?.object.parent)

  view.rerender({ mode: 'select' })
  assert.equal(scene.children.length, 0)
  assert.deepEqual(centreTargetsRef.current, [])
})
