import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import {
  LAN_ONLY_MODE_TRADEOFF,
  MANAGED_BRIDGE_STEP,
  PRINTER_CONNECTIVITY_STEPS
} from '../lib/printerConnectivityGuide'
import { installJsdomGlobals } from '../test-utils/jsdom'

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
const { cleanup, render } = await import('@testing-library/react')
const { ConnectivityGuideDialog } = await import('./ConnectivityGuideDialog')
const { runtimePolicyContext } = await import('../lib/runtimePolicy')

afterEach(() => {
  cleanup()
})

after(() => {
  dom.window.close()
})

test('renders every connectivity step and the LAN-only trade-off', () => {
  const view = render(
    <CssVarsProvider>
      <ConnectivityGuideDialog onClose={() => {}} />
    </CssVarsProvider>
  )

  for (const step of PRINTER_CONNECTIVITY_STEPS) {
    assert.ok(view.getByText(step.title), `missing step: ${step.title}`)
  }
  assert.ok(view.getByText(LAN_ONLY_MODE_TRADEOFF))
})

test('managed-bridge installs swap the bridge step for built-in-service wording', () => {
  const bridgeStep = PRINTER_CONNECTIVITY_STEPS.find((step) => step.id === 'bridge')
  assert.ok(bridgeStep)

  const view = render(
    <runtimePolicyContext.Provider value={{ demoMode: false, managedBridge: true, selfHosted: true }}>
      <CssVarsProvider>
        <ConnectivityGuideDialog onClose={() => {}} />
      </CssVarsProvider>
    </runtimePolicyContext.Provider>
  )

  assert.ok(view.getByText(MANAGED_BRIDGE_STEP.title))
  assert.equal(view.queryByText(bridgeStep.title), null)
  for (const step of PRINTER_CONNECTIVITY_STEPS.filter((entry) => entry.id !== 'bridge')) {
    assert.ok(view.getByText(step.title), `missing step: ${step.title}`)
  }
})
