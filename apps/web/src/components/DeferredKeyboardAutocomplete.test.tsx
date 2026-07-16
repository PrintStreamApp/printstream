import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { installJsdomGlobals } from '../test-utils/jsdom'

// Toggled per test: useTouchPointer reads matchMedia at mount, so each fresh
// render observes the current value.
let touchDevice = true
const dom = installJsdomGlobals({
  matchMedia: (query) => touchDevice && query === '(hover: none) and (pointer: coarse)'
})

// Joy does SSR detection at import time, so load @mui/joy and the component
// under test only after the jsdom globals exist.
const React = (await import('react')).default
const { CssVarsProvider } = await import('@mui/joy/styles')
const { cleanup, fireEvent, render } = await import('@testing-library/react')
const { DeferredKeyboardAutocomplete } = await import('./DeferredKeyboardAutocomplete')

afterEach(() => {
  cleanup()
})

after(() => {
  dom.window.close()
})

function renderAutocomplete() {
  const view = render(
    <CssVarsProvider>
      <DeferredKeyboardAutocomplete options={['Alpha', 'Beta']} placeholder="Pick one" />
    </CssVarsProvider>
  )
  return view.getByPlaceholderText('Pick one') as HTMLInputElement
}

test('touch devices suppress the on-screen keyboard until a repeat tap', () => {
  touchDevice = true
  const input = renderAutocomplete()
  assert.equal(input.getAttribute('inputmode'), 'none')

  // A tap on the not-yet-focused field keeps the suppression: that first tap
  // is the browse gesture, and focus lands after touchstart.
  fireEvent.touchStart(input)
  assert.equal(input.getAttribute('inputmode'), 'none')

  fireEvent.focus(input)
  input.focus()
  assert.equal(input.getAttribute('inputmode'), 'none')

  // Tapping the already-focused field lifts the suppression so the same tap
  // can summon the keyboard for type-to-filter.
  fireEvent.touchStart(input)
  assert.equal(input.getAttribute('inputmode'), null)

  // Blur re-arms the suppression for the next open.
  fireEvent.blur(input)
  assert.equal(input.getAttribute('inputmode'), 'none')
})

test('fine-pointer devices render a normal input', () => {
  touchDevice = false
  const input = renderAutocomplete()
  assert.equal(input.getAttribute('inputmode'), null)

  input.focus()
  fireEvent.touchStart(input)
  assert.equal(input.getAttribute('inputmode'), null)
})

test('forwards an external slotProps.input ref alongside its own', () => {
  touchDevice = true
  const ref = React.createRef<HTMLInputElement>()
  render(
    <CssVarsProvider>
      <DeferredKeyboardAutocomplete options={['Alpha']} placeholder="Pick one" slotProps={{ input: { ref } }} />
    </CssVarsProvider>
  )
  assert.ok(ref.current instanceof dom.window.HTMLInputElement)
})
