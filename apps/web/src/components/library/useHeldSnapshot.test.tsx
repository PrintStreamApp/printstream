/** Pin catalogue isolation while refetches and explicit engine switches arrive. */
import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { installJsdomGlobals } from '../../test-utils/jsdom'

const dom = installJsdomGlobals()
const { renderHook, act, cleanup } = await import('@testing-library/react')
const React = await import('react')
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

test('an open process draft survives a catalogue resolver refresh but releases on source changes or close', () => {
  const first = async () => 'first baseline'
  const refreshed = async () => 'refreshed baseline'
  const props = { value: first, hold: true, ready: true, token: 0, scope: 'project-a:engine-a' }
  const view = renderHook((p: typeof props) => {
    const resolver = useHeldSnapshot(p.value, p)
    const [draft, setDraft] = React.useState('preset')
    // Mirrors the process dialog's initialization when its resolver identity changes.
    React.useEffect(() => { setDraft('preset') }, [resolver])
    return { resolver, draft, setDraft }
  }, { initialProps: props })
  act(() => { view.result.current.setDraft('edited') })
  view.rerender({ ...props, value: refreshed })
  assert.equal(view.result.current.resolver, first)
  assert.equal(view.result.current.draft, 'edited')

  view.rerender({ ...props, value: refreshed, scope: 'project-a:engine-b' })
  assert.equal(view.result.current.resolver, refreshed)
  assert.equal(view.result.current.draft, 'preset')
  act(() => { view.result.current.setDraft('engine-b edit') })
  view.rerender({ ...props, value: first, scope: 'project-b:engine-b' })
  assert.equal(view.result.current.resolver, first)
  assert.equal(view.result.current.draft, 'preset')

  view.rerender({ ...props, value: refreshed, hold: false, scope: 'project-b:engine-b' })
  view.rerender({ ...props, value: refreshed, scope: 'project-b:engine-b' })
  assert.equal(view.result.current.resolver, refreshed)
})
