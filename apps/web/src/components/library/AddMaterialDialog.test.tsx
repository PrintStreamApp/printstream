import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { installJsdomGlobals } from '../../test-utils/jsdom'
import type { SliceMaterialOption } from '../../lib/slicingPresetMatching'
import type { AddedMaterialChoice } from './useMaterialSlots'

const dom = installJsdomGlobals()

// Joy does SSR detection at import time, so load @mui/joy and the component
// under test only after the jsdom globals exist.
const React = (await import('react')).default
const { CssVarsProvider } = await import('@mui/joy/styles')
const { cleanup, fireEvent, render, screen } = await import('@testing-library/react')
const { AddMaterialDialog } = await import('./AddMaterialDialog')

afterEach(() => {
  cleanup()
})

after(() => {
  dom.window.close()
})

function materialOption(overrides: Partial<SliceMaterialOption> & { id: string }): SliceMaterialOption {
  return {
    label: 'PLA Basic', group: 'Built-in profiles', materialType: 'PLA', brand: 'Bambu',
    profileId: 'builtin:filament:pla', material: 'Bambu PLA Basic', color: '#FFFFFF', colors: [],
    source: 'manual', trayId: null, nozzleId: null, toolheadId: null, metadata: '',
    slotLabel: null, presetLabel: 'Bambu PLA Basic', colorName: null, remainingGrams: null, remainPercent: null,
    ...overrides
  }
}

const PLA_OPTION = materialOption({ id: 'profile:builtin:filament:pla' })

function renderAddDialog() {
  const added: AddedMaterialChoice[] = []
  const cancels: number[] = []
  render(
    <CssVarsProvider>
      <AddMaterialDialog
        filamentIndex={2}
        materialOptions={[PLA_OPTION]}
        onAdd={(choice) => added.push(choice)}
        onCancel={() => cancels.push(1)}
      />
    </CssVarsProvider>
  )
  return { added, cancels }
}

// The whole point of this dialog: the slot used to be appended the instant "Add material" was
// clicked, then seeded from the first material — or, failing that, from a machine default preset
// plus #FFFFFF, which the filament identity resolver names as the real product "Bambu PLA Basic,
// Jade White". Users saw a specific filament they had never chosen, and opening it showed no
// preset selected. Nothing may be created before a material is confirmed.
test('nothing is created until a material is confirmed', () => {
  const { added, cancels } = renderAddDialog()

  assert.ok(screen.getByText('Add material'), 'the dialog names the pending action, not a slot that exists')
  assert.equal(screen.getByRole('button', { name: 'Add' }).hasAttribute('disabled'), true)

  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  assert.deepEqual(added, [], 'cancelling creates no material')
  assert.deepEqual(cancels, [1])
})

test('confirming passes the chosen preset through rather than a default', () => {
  const { added } = renderAddDialog()

  fireEvent.click(screen.getByPlaceholderText('Choose a material profile'))
  fireEvent.click(screen.getByRole('option', { name: /PLA Basic/ }))

  const add = screen.getByRole('button', { name: 'Add' })
  assert.equal(add.hasAttribute('disabled'), false, 'a chosen preset enables the confirm')
  fireEvent.click(add)

  assert.equal(added.length, 1)
  assert.equal(added[0]?.optionId, PLA_OPTION.id)
  assert.equal(added[0]?.label, 'PLA')
})
