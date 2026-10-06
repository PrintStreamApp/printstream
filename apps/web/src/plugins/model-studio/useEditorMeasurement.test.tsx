import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import * as THREE from 'three'
import { installJsdomGlobals } from '../../test-utils/jsdom'
import type { MeasurePick } from './lib/editorMeasurePicking'
import type { GizmoMode } from './editorGeometry'

const dom = installJsdomGlobals()
const { act, cleanup, renderHook } = await import('@testing-library/react')
const { useEditorMeasurement } = await import('./useEditorMeasurement')

afterEach(cleanup)
after(() => dom.window.close())

function point(x: number): MeasurePick {
  const feature = { kind: 'point' as const, point: new THREE.Vector3(x, 0, 0) }
  return { feature, source: feature }
}

test('Measure retains its first datum, toggles selected picks, and clears on context changes', () => {
  const first = point(0)
  const second = point(3)
  const third = point(8)
  const view = renderHook(
    ({ mode, plate }: { mode: GizmoMode; plate: number }) => useEditorMeasurement(mode, plate),
    { initialProps: { mode: 'measure' as GizmoMode, plate: 1 } }
  )

  act(() => view.result.current.addMeasurePointRef.current?.(first))
  act(() => view.result.current.addMeasurePointRef.current?.(second))
  assert.equal(view.result.current.measureResult?.distanceStrict?.dist, 3)
  assert.equal(view.result.current.measurePointsRef.current.length, 2)

  act(() => view.result.current.resetSlot(0))
  assert.deepEqual(view.result.current.measurePoints, [second])
  act(() => view.result.current.addMeasurePointRef.current?.(first))
  assert.deepEqual(view.result.current.measurePoints, [second, first])
  act(() => view.result.current.clear())
  assert.deepEqual(view.result.current.measurePoints, [])
  act(() => view.result.current.addMeasurePointRef.current?.(first))
  act(() => view.result.current.addMeasurePointRef.current?.(second))

  act(() => view.result.current.addMeasurePointRef.current?.(third))
  assert.deepEqual(view.result.current.measurePoints, [first, third])
  assert.equal(view.result.current.measureResult?.distanceStrict?.dist, 8)

  act(() => view.result.current.addMeasurePointRef.current?.(first))
  assert.deepEqual(view.result.current.measurePoints, [third])
  assert.equal(view.result.current.measureResult, null)
  act(() => view.result.current.addMeasurePointRef.current?.(third))
  assert.deepEqual(view.result.current.measurePoints, [])

  act(() => view.result.current.addMeasurePointRef.current?.(first))
  view.rerender({ mode: 'translate', plate: 1 })
  assert.deepEqual(view.result.current.measurePoints, [])
  view.rerender({ mode: 'measure', plate: 1 })
  act(() => view.result.current.addMeasurePointRef.current?.(first))
  view.rerender({ mode: 'measure', plate: 2 })
  assert.deepEqual(view.result.current.measurePoints, [])
})
