import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { installJsdomGlobals } from '../../test-utils/jsdom'

const dom = installJsdomGlobals()
const React = (await import('react')).default
const { CssVarsProvider } = await import('@mui/joy/styles')
const { cleanup, fireEvent, render } = await import('@testing-library/react')
const { RemoveMaterialDialog } = await import('./RemoveMaterialDialog')
afterEach(cleanup)
after(() => dom.window.close())

test('in-use deletion requires a surviving material and submits exactly that choice', () => {
  const calls: number[][] = []
  const view = render(React.createElement(CssVarsProvider, null, React.createElement(RemoveMaterialDialog, {
    materialId: 2,
    filaments: [1, 2, 3].map((id) => ({ projectFilamentId: id, label: `Material ${id}`, color: '#FFFFFF', nozzleId: null, usedOnSelectedPlate: true })),
    onRemove: (id, replacement) => calls.push([id, replacement]),
    onClose: () => {}
  })))
  const submit = view.getByRole('button', { name: 'Replace and remove' }) as HTMLButtonElement
  assert.equal(submit.disabled, true)
  fireEvent.click(view.getByRole('combobox'))
  assert.equal(view.queryByRole('option', { name: /Material 2/ }), null)
  fireEvent.click(view.getByRole('option', { name: /Material 3/ }))
  assert.equal(submit.disabled, false)
  fireEvent.click(submit)
  assert.deepEqual(calls, [[2, 3]])
})

test('cancel leaves the project alone', () => {
  let closed = false
  const view = render(React.createElement(CssVarsProvider, null, React.createElement(RemoveMaterialDialog, {
    materialId: 1,
    filaments: [1, 2].map((id) => ({ projectFilamentId: id, label: `Material ${id}`, color: '#FFFFFF', nozzleId: null, usedOnSelectedPlate: true })),
    onRemove: () => assert.fail('cancel must not remove'),
    onClose: () => { closed = true }
  })))
  fireEvent.click(view.getByRole('button', { name: 'Cancel' }))
  assert.equal(closed, true)
})
