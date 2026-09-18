/** Pin catalogue isolation while refetches and explicit engine switches arrive. */
import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { installJsdomGlobals } from '../../test-utils/jsdom'

const dom = installJsdomGlobals()
const { renderHook, cleanup } = await import('@testing-library/react')
const { useHeldSnapshot } = await import('./useHeldSnapshot')
afterEach(cleanup)
after(() => dom.window.close())

test('holds background refreshes but adopts a cached catalogue on an engine switch', () => {
  const props = { value: ['A'], hold: true, ready: true, token: 0, scope: 'a' }
  const view = renderHook((p: typeof props) => useHeldSnapshot(p.value, p), { initialProps: props })
  view.rerender({ ...props, value: ['A refreshed'] })
  assert.deepEqual(view.result.current, ['A'])
  view.rerender({ ...props, scope: 'b', value: ['B'] })
  assert.deepEqual(view.result.current, ['B'])
  view.rerender({ ...props, scope: 'b', value: ['B refreshed'], token: 1 })
  assert.deepEqual(view.result.current, ['B refreshed'])
})

test('drops the previous engine while waiting, then holds the new ready catalogue', () => {
  const props = { value: ['A'], hold: true, ready: true, token: 0, scope: 'a' }
  const view = renderHook((p: typeof props) => useHeldSnapshot(p.value, p), { initialProps: props })
  view.rerender({ ...props, scope: 'b', value: [], ready: false })
  assert.deepEqual(view.result.current, [])
  view.rerender({ ...props, scope: 'b', value: ['B'] })
  assert.deepEqual(view.result.current, ['B'])
})
