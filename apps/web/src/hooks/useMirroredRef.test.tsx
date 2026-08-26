import assert from 'node:assert/strict'
import { test } from 'node:test'
import { installJsdomGlobals } from '../test-utils/jsdom'

installJsdomGlobals()

const React = await import('react')
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { useMirroredRef } = await import('./useMirroredRef')

/** Mount a component and hand back what the hook exposed on the last render. */
function renderHook<T>(initial: T) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const seen: { value: T; set: (next: T) => void; ref: { current: T }; renders: number } = {
    value: initial, set: () => {}, ref: { current: initial }, renders: 0
  }
  function Probe() {
    const ref = React.useRef(initial)
    const [value, set] = useMirroredRef(ref, initial)
    seen.value = value
    seen.set = set
    seen.ref = ref
    seen.renders += 1
    return null
  }
  const root = createRoot(container)
  act(() => { root.render(React.createElement(Probe)) })
  return { seen, unmount: () => act(() => { root.unmount() }) }
}

test('the setter writes the ref and the state, and the ref lands synchronously', () => {
  const { seen, unmount } = renderHook<string | null>(null)
  assert.equal(seen.value, null)
  assert.equal(seen.ref.current, null)

  // The load-bearing assertion. A setter that forgets the ref, or -- as the editor's hand-rolled
  // pair did -- calls ITSELF instead of assigning it, leaves every non-render reader on the old
  // value. Read the ref straight after the call, outside act(), because that is exactly what a
  // pointer handler or a debounced rebuild does.
  let refDuringCall: string | null = 'unset'
  act(() => {
    seen.set('host-1')
    refDuringCall = seen.ref.current
  })
  assert.equal(refDuringCall, 'host-1', 'the ref is current before React re-renders')
  assert.equal(seen.ref.current, 'host-1')
  assert.equal(seen.value, 'host-1', 'and render sees it too')

  act(() => { seen.set(null) })
  assert.equal(seen.ref.current, null, 'clearing writes through as well')
  assert.equal(seen.value, null)
  unmount()
})

test('the setter identity is stable, so an effect depending on it does not re-fire', () => {
  const { seen, unmount } = renderHook(0)
  const first = seen.set
  act(() => { seen.set(1) })
  assert.equal(seen.set, first, 'same setter across a value change')
  unmount()
})
