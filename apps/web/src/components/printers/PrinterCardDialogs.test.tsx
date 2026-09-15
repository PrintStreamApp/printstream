import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import type { PrinterStatus } from '@printstream/shared'
import { installJsdomGlobals } from '../../test-utils/jsdom'

const dom = installJsdomGlobals()

const animationFrameWindow = dom.window as unknown as {
  requestAnimationFrame: (callback: () => void) => number
  cancelAnimationFrame: (handle: number) => void
}
animationFrameWindow.requestAnimationFrame = (callback) => dom.window.setTimeout(callback, 0) as unknown as number
animationFrameWindow.cancelAnimationFrame = (handle) => dom.window.clearTimeout(handle)

// Joy's Modal determines its host at import time, after jsdom is installed.
const React = (await import('react')).default
const { CssVarsProvider } = await import('@mui/joy/styles')
const { cleanup, render } = await import('@testing-library/react')
const { PrinterSettingsDialog } = await import('./PrinterCardDialogs')

afterEach(() => cleanup())
after(() => dom.window.close())

test('printer settings opens with a cached status from before newer options existed', async () => {
  const legacySettings = {
    aiMonitoring: { supported: false, enabled: null, sensitivity: null },
    spaghettiDetection: { supported: false, enabled: null, sensitivity: null },
    purgeChutePileupDetection: { supported: false, enabled: null, sensitivity: null },
    nozzleClumpingDetection: { supported: false, enabled: null, sensitivity: null },
    airPrintingDetection: { supported: false, enabled: null, sensitivity: null },
    firstLayerInspection: { supported: false, enabled: null },
    autoRecovery: { supported: false, enabled: null },
    promptSound: { supported: false, enabled: null },
    filamentTangleDetection: { supported: true, enabled: false }
  } as PrinterStatus['printOptions']

  const view = render(
    <CssVarsProvider>
      <PrinterSettingsDialog
        printerModel="H2D"
        printerName="Home"
        ductMode="cooling"
        ductAvailableModes={['cooling', 'heating']}
        settings={legacySettings}
        submitting={false}
        onClose={() => {}}
        onSubmit={() => {}}
      />
    </CssVarsProvider>
  )

  assert.ok(await view.findByText('Printer settings for Home'))
  assert.ok(view.getByText('Filament tangle detection'))
})
