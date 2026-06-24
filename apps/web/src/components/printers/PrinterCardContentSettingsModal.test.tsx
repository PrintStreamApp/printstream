import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { defaultPrinterCardContentSettings, type PrinterCardContentSettings } from '@printstream/shared'
import { installJsdomGlobals } from '../../test-utils/jsdom'

const dom = installJsdomGlobals()

// ScrollableDialogBody measures overflow via rAF, which jsdom does not provide.
const animationFrameWindow = dom.window as unknown as {
  requestAnimationFrame: (callback: () => void) => number
  cancelAnimationFrame: (handle: number) => void
}
animationFrameWindow.requestAnimationFrame = (callback) => dom.window.setTimeout(callback, 0) as unknown as number
animationFrameWindow.cancelAnimationFrame = (handle) => dom.window.clearTimeout(handle)

// Joy's Modal does SSR detection at import time, so load @mui/joy and the
// component under test only after the jsdom globals exist.
const React = (await import('react')).default
const { CssVarsProvider } = await import('@mui/joy/styles')
const { cleanup, fireEvent, render } = await import('@testing-library/react')
const { PrinterCardContentSettingsModal } = await import('./PrinterCardContentSettingsModal')

afterEach(() => {
  cleanup()
})

after(() => {
  dom.window.close()
})

function settings(overrides: Partial<PrinterCardContentSettings> = {}): PrinterCardContentSettings {
  return { ...defaultPrinterCardContentSettings, ...overrides }
}

function renderModal(props: {
  initialSettings: PrinterCardContentSettings
  defaultSettings?: PrinterCardContentSettings
}) {
  const saves: PrinterCardContentSettings[] = []
  let closeCount = 0
  const view = render(
    <CssVarsProvider>
      <PrinterCardContentSettingsModal
        initialSettings={props.initialSettings}
        defaultSettings={props.defaultSettings ?? defaultPrinterCardContentSettings}
        onClose={() => { closeCount += 1 }}
        onSave={(next) => { saves.push(next) }}
      />
    </CssVarsProvider>
  )
  return { view, saves, closeCount: () => closeCount }
}

test('saves the edited card-content settings, leaving untouched toggles unchanged', async () => {
  const { view, saves } = renderModal({ initialSettings: settings() })

  // The HMS errors toggle defaults on; clicking its row turns it off.
  fireEvent.click(await view.findByText('HMS errors'))
  fireEvent.click(view.getByRole('button', { name: 'Save' }))

  const saved = saves.at(-1)
  assert.ok(saved)
  assert.equal(saved.hmsErrors, false)
  assert.equal(saved.printStatus, defaultPrinterCardContentSettings.printStatus)
  assert.equal(saved.nozzleTemperatures, defaultPrinterCardContentSettings.nozzleTemperatures)
})

test('the full-width snapshot and camera thumbnail toggle independently', async () => {
  // Both camera presentations can be enabled at once; enabling one must not
  // disable the other.
  const { view, saves } = renderModal({
    initialSettings: settings({ cameraThumbnail: true, fullWidthSnapshot: false })
  })

  fireEvent.click(await view.findByText('Full-width snapshot'))
  fireEvent.click(view.getByRole('button', { name: 'Save' }))

  const saved = saves.at(-1)
  assert.ok(saved)
  assert.equal(saved.fullWidthSnapshot, true)
  assert.equal(saved.cameraThumbnail, true)
})

test('Reset to defaults restores the provided default settings', async () => {
  const defaults = settings({ cameraThumbnail: false, fullWidthSnapshot: true })
  const { view, saves } = renderModal({
    initialSettings: settings({ cameraThumbnail: true, fullWidthSnapshot: false, footerControls: false }),
    defaultSettings: defaults
  })

  fireEvent.click(view.getByRole('button', { name: 'Reset to defaults' }))
  fireEvent.click(view.getByRole('button', { name: 'Save' }))

  const saved = saves.at(-1)
  assert.ok(saved)
  assert.deepEqual(saved, defaults)
})

test('Cancel dismisses without saving', async () => {
  const { view, saves, closeCount } = renderModal({ initialSettings: settings() })

  fireEvent.click(await view.findByText('HMS errors'))
  fireEvent.click(view.getByRole('button', { name: 'Cancel' }))

  assert.equal(saves.length, 0)
  assert.equal(closeCount(), 1)
})
