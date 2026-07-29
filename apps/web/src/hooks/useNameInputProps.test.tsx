import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { installJsdomGlobals } from '../test-utils/jsdom'

const dom = installJsdomGlobals()

const React = (await import('react')).default
const { cleanup, fireEvent, render, screen } = await import('@testing-library/react')
const { useNameInputProps } = await import('./useNameInputProps')

afterEach(() => {
  cleanup()
})

after(() => {
  dom.window.close()
})

function NameField({ onAccept, canAccept, initialValue = 'benchy' }: {
  onAccept: () => void
  canAccept?: boolean
  initialValue?: string
}) {
  const [value, setValue] = React.useState(initialValue)
  const props = useNameInputProps({ onAccept, canAccept })
  return <input aria-label="Name" {...props} value={value} onChange={(event) => setValue(event.target.value)} />
}

test('the existing name is selected on open, so it can be typed straight over', () => {
  render(<NameField onAccept={() => {}} />)
  const input = screen.getByLabelText('Name') as HTMLInputElement
  assert.equal(input.selectionStart, 0)
  assert.equal(input.selectionEnd, 'benchy'.length)
})

test('re-focusing a half-typed name does not re-select it', () => {
  render(<NameField onAccept={() => {}} />)
  const input = screen.getByLabelText('Name') as HTMLInputElement
  fireEvent.change(input, { target: { value: 'benchy-v2' } })
  input.setSelectionRange(9, 9)
  fireEvent.focus(input)
  assert.equal(input.selectionStart, 9)
  assert.equal(input.selectionEnd, 9)
})

test('Enter accepts the value', () => {
  const calls: string[] = []
  render(<NameField onAccept={() => calls.push('accept')} />)
  fireEvent.keyDown(screen.getByLabelText('Name'), { key: 'Enter' })
  assert.deepEqual(calls, ['accept'])
})

test('Enter is swallowed rather than accepted while the value is invalid', () => {
  const calls: string[] = []
  render(<NameField onAccept={() => calls.push('accept')} canAccept={false} />)
  // Swallowed, not ignored: inside a <form> the browser would otherwise submit implicitly,
  // committing exactly the value the dialog just refused.
  const accepted = fireEvent.keyDown(screen.getByLabelText('Name'), { key: 'Enter' })
  assert.equal(accepted, false)
  assert.deepEqual(calls, [])
})

test('other keys pass through untouched', () => {
  const calls: string[] = []
  render(<NameField onAccept={() => calls.push('accept')} />)
  const passedThrough = fireEvent.keyDown(screen.getByLabelText('Name'), { key: 'a' })
  assert.equal(passedThrough, true)
  assert.deepEqual(calls, [])
})
