/** Nested dialogs must restore their own retained Joy popups without exposing background dialogs. */
import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { installJsdomGlobals } from '../test-utils/jsdom'

const dom = installJsdomGlobals()
const React = (await import('react')).default
const { useState } = await import('react')
const { CssVarsProvider } = await import('@mui/joy/styles')
const { Button, ModalDialog, Select, Option, Autocomplete } = await import('@mui/joy')
const { cleanup, fireEvent, render, waitFor } = await import('@testing-library/react')
const { BackAwareModal } = await import('./BackAwareModal')
afterEach(cleanup)
after(() => dom.window.close())

/** Use real retained body portals, matching a printer picker stacked above a material form. */
function Dialogs({ autocomplete = false }: { autocomplete?: boolean }) {
  const [nested, setNested] = useState(false)
  return <CssVarsProvider><BackAwareModal open onClose={() => {}}><ModalDialog>
    {autocomplete ? <Autocomplete aria-label="Material" options={['PLA', 'PETG']} />
      : <Select aria-label="Material" defaultValue="PLA"><Option value="PLA">PLA</Option><Option value="PETG">PETG</Option></Select>}
    <Button onClick={() => setNested(true)}>Choose printer</Button>
    <BackAwareModal open={nested} onClose={() => setNested(false)}><ModalDialog><Button onClick={() => setNested(false)}>Use printer</Button></ModalDialog></BackAwareModal>
  </ModalDialog></BackAwareModal></CssVarsProvider>
}

test('retained Select labels survive nesting and its reopened options remain accessible', async () => {
  const view = render(<Dialogs />)
  const combo = view.getByRole('combobox', { name: 'Material' })
  assert.equal(combo.textContent, 'PLA')
  fireEvent.click(view.getByRole('button', { name: 'Choose printer' }))
  fireEvent.click(view.getByRole('button', { name: 'Use printer' }))
  await waitFor(() => assert.ok(view.getByRole('combobox', { name: 'Material' })))
  fireEvent.click(combo)
  assert.ok(await view.findByRole('option', { name: 'PETG' }))
  fireEvent.click(view.getByRole('option', { name: 'PETG' }))
  await waitFor(() => assert.equal(combo.textContent, 'PETG'))
})

test('an open underlying popup stays inaccessible while a nested dialog is active', async () => {
  const view = render(<Dialogs />)
  fireEvent.click(view.getByRole('combobox', { name: 'Material' }))
  await view.findByRole('option', { name: 'PETG' })
  fireEvent.click(view.getByRole('button', { name: 'Choose printer' }))
  await waitFor(() => assert.ok(view.queryByRole('option', { name: 'PETG' }) === null))
  assert.ok(view.getByRole('button', { name: 'Use printer' }))
})

test('Autocomplete follows the same owned-popup accessibility after nested selection', async () => {
  const view = render(<Dialogs autocomplete />)
  fireEvent.click(view.getByRole('button', { name: 'Choose printer' }))
  fireEvent.click(view.getByRole('button', { name: 'Use printer' }))
  const input = await view.findByRole('combobox', { name: 'Material' })
  fireEvent.focus(input)
  fireEvent.change(input, { target: { value: 'PET' } })
  assert.ok(await view.findByRole('option', { name: 'PETG' }))
})
