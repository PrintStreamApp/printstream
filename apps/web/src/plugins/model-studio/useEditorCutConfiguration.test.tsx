import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { installJsdomGlobals } from '../../test-utils/jsdom'

const dom = installJsdomGlobals()
const { act, cleanup, renderHook } = await import('@testing-library/react')
const { useEditorCutConfiguration } = await import('./useEditorCutConfiguration')

afterEach(cleanup)
after(() => dom.window.close())

test('Cut keeps raw input and groove preferences while bounding live preview values', () => {
  const view = renderHook(() => useEditorCutConfiguration())
  assert.equal(view.result.current.cutAxis, 'z')
  assert.equal(view.result.current.cutOrientUpper, 'keep')
  assert.equal(view.result.current.cutOrientLower, 'keep')
  assert.equal(view.result.current.connectorSizeLimits.min, 0.5)
  assert.ok(view.result.current.connectorSizeLimits.max > 1)

  act(() => {
    view.result.current.setCutOffset(20)
    view.result.current.setCutRange({ min: -10, max: 10 })
    view.result.current.setGroove((current) => ({ ...current, flapsAngle: 1.2 }))
    view.result.current.setCutObjectSize({ x: 20, y: 20, z: 20 })
  })
  assert.equal(view.result.current.cutOffset, 20)
  assert.equal(view.result.current.clampedCutOffset, 10)
  assert.equal(view.result.current.grooveSizeLimits.max, 30)

  act(() => view.result.current.setCutAxis('x'))
  assert.equal(view.result.current.groove.flapsAngle, 1.2)
  assert.equal(view.result.current.clampedCutOffset, 10)
})
