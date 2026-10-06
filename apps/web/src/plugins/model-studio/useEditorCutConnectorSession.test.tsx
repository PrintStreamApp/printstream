import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import * as THREE from 'three'
import { installJsdomGlobals } from '../../test-utils/jsdom'
import { CONNECTOR_DEFAULTS } from './lib/cutConnectors'
import type { CutAxis, CutMode } from './lib/meshCut'
import type { GizmoMode } from './editorGeometry'

const dom = installJsdomGlobals()
const { act, cleanup, renderHook } = await import('@testing-library/react')
const { useEditorCutConnectorSession } = await import('./useEditorCutConnectorSession')

afterEach(cleanup)
after(() => dom.window.close())

test('Cut connectors share settings, reseat with the plane, and pause in Dovetail mode', () => {
  const setCutAxis = () => undefined
  const view = renderHook(({ axis, offset, mode }: { axis: CutAxis; offset: number; mode: CutMode }) =>
    useEditorCutConnectorSession({
      gizmoMode: 'cut', selectedKey: 'cube', cutMode: mode, cutAxis: axis,
      clampedCutOffset: offset, setCutAxis
    }), {
    initialProps: { axis: 'z' as CutAxis, offset: 10, mode: 'plane' as CutMode }
  })

  act(() => {
    view.result.current.editCutConnectorsRef.current({
      kind: 'add', worldPoint: new THREE.Vector3(1, 2, 10)
    })
  })
  assert.equal(view.result.current.cutConnectors.length, 1)
  assert.equal(view.result.current.cutConnectors[0]!.radius, CONNECTOR_DEFAULTS.radius)

  act(() => view.result.current.applyConnectorSettings({ ...CONNECTOR_DEFAULTS, radius: 2 }))
  assert.equal(view.result.current.cutConnectors[0]!.radius, 2)

  view.rerender({ axis: 'z', offset: 14, mode: 'plane' })
  assert.equal(view.result.current.cutConnectors[0]!.z, 14)
  view.rerender({ axis: 'z', offset: 14, mode: 'dovetail' })
  assert.equal(view.result.current.activeConnectors.length, 0)
  assert.equal(view.result.current.cutConnectors.length, 1)
  view.rerender({ axis: 'z', offset: 14, mode: 'plane' })
  assert.equal(view.result.current.activeConnectors.length, 1)

  view.rerender({ axis: 'x', offset: 1, mode: 'plane' })
  assert.equal(view.result.current.cutConnectors.length, 0)
})

test('leaving Cut clears placed connectors and placement mode', () => {
  const setCutAxis = () => undefined
  const view = renderHook(({ gizmoMode }: { gizmoMode: GizmoMode }) =>
    useEditorCutConnectorSession({
      gizmoMode, selectedKey: 'cube', cutMode: 'plane', cutAxis: 'z',
      clampedCutOffset: 10, setCutAxis
    }), { initialProps: { gizmoMode: 'cut' as GizmoMode } })

  act(() => {
    view.result.current.editCutConnectorsRef.current({
      kind: 'add', worldPoint: new THREE.Vector3(1, 2, 10)
    })
    view.result.current.setCutConnectorMode(true)
  })
  assert.equal(view.result.current.placingConnectors, true)
  view.rerender({ gizmoMode: 'select' })
  assert.equal(view.result.current.cutConnectors.length, 0)
  assert.equal(view.result.current.placingConnectors, false)
  assert.equal(view.result.current.cutConnectorModeRef.current, false)
})
