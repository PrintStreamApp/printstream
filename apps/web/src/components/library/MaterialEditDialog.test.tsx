import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { installJsdomGlobals } from '../../test-utils/jsdom'
import type { SliceMaterialOption } from '../../lib/sliceProfileMatching'

const dom = installJsdomGlobals()

// Joy does SSR detection at import time, so load @mui/joy and the component
// under test only after the jsdom globals exist.
const React = (await import('react')).default
const { CssVarsProvider } = await import('@mui/joy/styles')
const { cleanup, fireEvent, render, screen } = await import('@testing-library/react')
const { MaterialEditDialog } = await import('./MaterialEditDialog')

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
const SUPPORT_OPTION = materialOption({
  id: 'profile:builtin:filament:support-pla',
  label: 'Support For PLA',
  materialType: 'PLA-S',
  profileId: 'builtin:filament:support-pla',
  material: 'Bambu Support For PLA',
  presetLabel: 'Support For PLA'
})

function renderDialog(props: {
  typeFilter: string
  materialOptions: SliceMaterialOption[]
  selectedOption: SliceMaterialOption | null
  onTypeFilterChange?: (value: string) => void
  onMaterialOptionChange?: (option: SliceMaterialOption | null) => void
}) {
  return render(
    <CssVarsProvider>
      <MaterialEditDialog
        filamentIndex={1}
        filamentLabel="PLA"
        typeFilter={props.typeFilter}
        typeOptions={['PLA', 'PLA-S']}
        onTypeFilterChange={props.onTypeFilterChange ?? (() => {})}
        materialOptions={props.materialOptions}
        selectedOption={props.selectedOption}
        onMaterialOptionChange={props.onMaterialOptionChange ?? (() => {})}
        color="#FFFFFF"
        onColorChange={() => {}}
        onClose={() => {}}
      />
    </CssVarsProvider>
  )
}

// Regression: the preset field was built assuming a slot ALWAYS has a preset
// (`disableClearable` + `value ?? undefined`). Once clearing became reachable, the
// null value reached Joy as `undefined` and its option/value diffing threw
// "Cannot read properties of undefined (reading 'id')", killing the whole route.
//
// It has to CLEAR an existing selection, not open empty: Joy latches controlled-ness
// on the first render, so opening with no value is treated as uncontrolled and Joy
// substitutes its own null. Only a field that starts with a value and then loses it
// stays controlled and hits the `value !== null` branch with `undefined`.
test('clearing an existing preset does not crash the field', () => {
  const { rerender } = renderDialog({ typeFilter: 'PLA', materialOptions: [PLA_OPTION], selectedOption: PLA_OPTION })
  assert.ok(screen.getByDisplayValue('Bambu PLA Basic'))

  rerender(
    <CssVarsProvider>
      <MaterialEditDialog
        filamentIndex={1}
        filamentLabel="PLA"
        typeFilter="PLA-S"
        typeOptions={['PLA', 'PLA-S']}
        onTypeFilterChange={() => {}}
        materialOptions={[SUPPORT_OPTION]}
        selectedOption={null}
        onMaterialOptionChange={() => {}}
        color="#FFFFFF"
        onColorChange={() => {}}
        onClose={() => {}}
      />
    </CssVarsProvider>
  )

  assert.ok(screen.getByPlaceholderText('Choose a material profile'))
  assert.equal(screen.getByRole('button', { name: 'Done' }).hasAttribute('disabled'), true)
})

test('opening a slot that has no preset renders rather than crashing', () => {
  renderDialog({ typeFilter: 'PLA-S', materialOptions: [SUPPORT_OPTION], selectedOption: null })

  assert.ok(screen.getByPlaceholderText('Choose a material profile'))
})

test('Done is disabled until a preset is chosen, and says why', () => {
  const { unmount } = renderDialog({ typeFilter: 'PLA-S', materialOptions: [SUPPORT_OPTION], selectedOption: null })

  assert.equal(screen.getByRole('button', { name: 'Done' }).hasAttribute('disabled'), true)
  assert.ok(screen.getByText('Choose a preset for this material to continue.'))
  unmount()

  renderDialog({ typeFilter: 'PLA', materialOptions: [PLA_OPTION], selectedOption: PLA_OPTION })
  assert.equal(screen.getByRole('button', { name: 'Done' }).hasAttribute('disabled'), false)
})

test('a type with no available presets explains itself rather than looking empty', () => {
  renderDialog({ typeFilter: 'PLA-S', materialOptions: [], selectedOption: null })

  assert.ok(screen.getByText(/No preset is available for this type/))
})

test('switching the material type clears a preset that belongs to the old type', () => {
  const typeChanges: string[] = []
  const optionChanges: Array<SliceMaterialOption | null> = []
  renderDialog({
    typeFilter: 'PLA',
    materialOptions: [PLA_OPTION],
    selectedOption: PLA_OPTION,
    onTypeFilterChange: (value) => typeChanges.push(value),
    onMaterialOptionChange: (option) => optionChanges.push(option)
  })

  fireEvent.click(screen.getByRole('combobox', { name: 'Type' }))
  fireEvent.click(screen.getByRole('option', { name: 'PLA-S' }))

  assert.deepEqual(typeChanges, ['PLA-S'])
  assert.deepEqual(optionChanges, [null])
})

test('re-picking the same material type keeps the current preset', () => {
  const optionChanges: Array<SliceMaterialOption | null> = []
  renderDialog({
    typeFilter: 'PLA',
    materialOptions: [PLA_OPTION],
    selectedOption: PLA_OPTION,
    onMaterialOptionChange: (option) => optionChanges.push(option)
  })

  fireEvent.click(screen.getByRole('combobox', { name: 'Type' }))
  fireEvent.click(screen.getByRole('option', { name: 'PLA' }))

  assert.deepEqual(optionChanges, [])
})
