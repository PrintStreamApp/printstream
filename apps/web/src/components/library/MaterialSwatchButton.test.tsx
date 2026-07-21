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
const { MaterialSwatchButton } = await import('./MaterialSwatchButton')

afterEach(() => {
  cleanup()
})

after(() => {
  dom.window.close()
})

function loadedOption(overrides: Partial<SliceMaterialOption> & { id: string }): SliceMaterialOption {
  return {
    label: 'PLA Basic', group: 'AMS 1', materialType: 'PLA', brand: 'Bambu',
    profileId: 'builtin:filament:pla', material: 'Bambu PLA Basic', color: '#FFFFFF', colors: [],
    source: 'ams', trayId: 0, nozzleId: null, toolheadId: null, metadata: '',
    slotLabel: 'A1', presetLabel: 'Bambu PLA Basic', colorName: 'Jade White',
    remainingGrams: null, remainPercent: null,
    ...overrides
  }
}

const SLOT_A1 = loadedOption({ id: 'tray:0' })
const SLOT_A2 = loadedOption({ id: 'tray:1', trayId: 1, slotLabel: 'A2', colorName: 'Black', color: '#000000' })

function renderSwatch(props: {
  onOpenMaterialDialog?: () => void
  onSelect?: (option: SliceMaterialOption) => void
  loaded?: SliceMaterialOption[] | null
}) {
  const loaded = props.loaded === undefined ? [SLOT_A1, SLOT_A2] : props.loaded
  return render(
    <CssVarsProvider>
      <MaterialSwatchButton
        filamentIndex={0}
        presetName="Bambu PLA Basic"
        colorName="Jade White"
        color="#FFFFFF"
        presetUnmatched={false}
        selectedMaterialOptionId={null}
        loadedMaterials={loaded ? {
          groups: [{ label: 'AMS 1', options: loaded }],
          trayMap: new Map(),
          onSelect: props.onSelect ?? (() => {})
        } : null}
        onOpenMaterialDialog={props.onOpenMaterialDialog ?? (() => {})}
      />
    </CssVarsProvider>
  )
}

test('with a printer targeted, the swatch offers the loaded materials plus a manual escape hatch', () => {
  const picked: SliceMaterialOption[] = []
  let dialogOpened = 0
  renderSwatch({ onSelect: (option) => picked.push(option), onOpenMaterialDialog: () => { dialogOpened += 1 } })

  fireEvent.click(screen.getByRole('button', { name: /Change material 1/ }))
  assert.equal(dialogOpened, 0, 'opening the menu must not open the dialog')
  assert.ok(screen.getByText('AMS 1'), 'loaded materials stay grouped like the picker modal')
  assert.ok(screen.getByRole('menuitem', { name: /Choose manually/ }))

  fireEvent.click(screen.getByText('Bambu PLA Basic · Black'))
  assert.deepEqual(picked.map((option) => option.id), ['tray:1'])
})

test('the manual item opens the material dialog', () => {
  let dialogOpened = 0
  renderSwatch({ onOpenMaterialDialog: () => { dialogOpened += 1 } })

  fireEvent.click(screen.getByRole('button', { name: /Change material 1/ }))
  fireEvent.click(screen.getByRole('menuitem', { name: /Choose manually/ }))
  assert.equal(dialogOpened, 1)
})

// No printer target (or nothing loaded for the slot): there is nothing to list, so the row keeps
// its original one-click path into the dialog rather than opening a menu of one item.
test('without loaded materials the swatch opens the dialog directly', () => {
  let dialogOpened = 0
  renderSwatch({ loaded: null, onOpenMaterialDialog: () => { dialogOpened += 1 } })

  fireEvent.click(screen.getByRole('button', { name: /Edit material 1/ }))
  assert.equal(dialogOpened, 1)
  assert.equal(screen.queryByRole('menuitem'), null)
})
