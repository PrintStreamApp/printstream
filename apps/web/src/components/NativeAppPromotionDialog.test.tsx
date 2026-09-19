import assert from 'node:assert/strict'
import { after, afterEach, beforeEach, test } from 'node:test'
import { installJsdomGlobals } from '../test-utils/jsdom'

const dom = installJsdomGlobals({ url: 'https://app.printstream.example/workspaces/home/printers' })
const originalUserAgent = dom.window.navigator.userAgent

beforeEach(async () => {
  dom.window.localStorage.clear()
  dom.window.sessionStorage.clear()
  setUserAgent('Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Mobile Safari/537.36')
  const { resetAppBusyForTests } = await import('../lib/appBusy')
  resetAppBusyForTests()
})

afterEach(async () => {
  const { cleanup } = await import('@testing-library/react')
  cleanup()
  const { resetAppBusyForTests } = await import('../lib/appBusy')
  resetAppBusyForTests()
})

after(() => {
  setUserAgent(originalUserAgent)
  dom.window.close()
})

test('offers Google Play once after sign-in and records dismissal', async () => {
  const { fireEvent, screen, waitFor } = await import('@testing-library/react')
  const { flagNativeAppPromotionAfterSignIn, isNativeAppPromotionDismissed } = await import('../lib/nativeAppPromotion')

  flagNativeAppPromotionAfterSignIn()
  await renderDialog()

  await screen.findByText('Take PrintStream with you')
  const storeLink = screen.getByRole('link', { name: 'Get it on Google Play' })
  assert.equal(storeLink.getAttribute('href'), 'https://play.google.com/store/apps/details?id=app.printstream')

  fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
  await waitFor(() => assert.equal(screen.queryByText('Take PrintStream with you'), null))
  assert.equal(isNativeAppPromotionDismissed('android'), true)
})

test('stays silent without a sign-in signal', async () => {
  const { screen } = await import('@testing-library/react')

  await renderDialog()

  assert.equal(screen.queryByText('Take PrintStream with you'), null)
})

async function renderDialog() {
  const { CssVarsProvider } = await import('@mui/joy/styles')
  const { render } = await import('@testing-library/react')
  const React = (await import('react')).default
  const { NativeAppPromotionDialog } = await import('./NativeAppPromotionDialog')

  return render(
    React.createElement(
      CssVarsProvider,
      null,
      React.createElement(NativeAppPromotionDialog, { authenticated: true })
    )
  )
}

function setUserAgent(userAgent: string) {
  Object.defineProperty(dom.window.navigator, 'userAgent', {
    configurable: true,
    value: userAgent
  })
}
