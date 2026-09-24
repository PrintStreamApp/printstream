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

test('offers app downloads once after sign-in and records dismissal', async () => {
  const { fireEvent, screen, waitFor } = await import('@testing-library/react')
  const { flagNativeAppPromotionAfterSignIn, isNativeAppPromotionDismissed } = await import('../lib/nativeAppPromotion')

  flagNativeAppPromotionAfterSignIn()
  await renderDialog()

  await screen.findByText('Take PrintStream with you')
  assert.ok(screen.getByRole('button', { name: 'View app downloads' }))

  fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
  await waitFor(() => assert.equal(screen.queryByText('Take PrintStream with you'), null))
  assert.equal(isNativeAppPromotionDismissed('android'), true)
})

test('opens the cross-platform app downloads from the Windows offer', async () => {
  const { fireEvent, screen } = await import('@testing-library/react')
  const { flagNativeAppPromotionAfterSignIn } = await import('../lib/nativeAppPromotion')

  setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36')
  flagNativeAppPromotionAfterSignIn()
  let browseCount = 0
  await renderDialog(() => { browseCount += 1 })

  await screen.findByText('PrintStream for Windows')
  fireEvent.click(screen.getByRole('button', { name: 'View app downloads' }))
  assert.equal(browseCount, 1)
})

test('stays silent without a sign-in signal', async () => {
  const { fireEvent, screen } = await import('@testing-library/react')

  await renderDialog()

  assert.equal(screen.queryByText('Take PrintStream with you'), null)
})

async function renderDialog(onBrowseDownloads = () => undefined) {
  const { CssVarsProvider } = await import('@mui/joy/styles')
  const { render } = await import('@testing-library/react')
  const React = (await import('react')).default
  const { NativeAppPromotionDialog } = await import('./NativeAppPromotionDialog')

  return render(
    React.createElement(
      CssVarsProvider,
      null,
      React.createElement(NativeAppPromotionDialog, { authenticated: true, onBrowseDownloads })
    )
  )
}

function setUserAgent(userAgent: string) {
  Object.defineProperty(dom.window.navigator, 'userAgent', {
    configurable: true,
    value: userAgent
  })
}
