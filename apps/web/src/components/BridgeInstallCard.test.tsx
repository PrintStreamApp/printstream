import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import type { BridgeStandaloneDownload } from '@printstream/shared'
import { installJsdomGlobals } from '../test-utils/jsdom'

const dom = installJsdomGlobals()

// ScrollableDialogBody (inside the install dialog) measures overflow via rAF,
// which jsdom does not provide.
const animationFrameWindow = dom.window as unknown as {
  requestAnimationFrame: (callback: () => void) => number
  cancelAnimationFrame: (handle: number) => void
}
animationFrameWindow.requestAnimationFrame = (callback) => dom.window.setTimeout(callback, 0) as unknown as number
animationFrameWindow.cancelAnimationFrame = (handle) => dom.window.clearTimeout(handle)

// Joy's popup machinery (Dropdown/Menu/Modal) does SSR detection at import time,
// so anything pulling in @mui/joy must load after the jsdom globals exist.
const React = (await import('react')).default
const { CssVarsProvider } = await import('@mui/joy/styles')
const { cleanup, fireEvent, render } = await import('@testing-library/react')
const { BridgeInstallCard } = await import('./BridgeInstallCard')

afterEach(() => {
  cleanup()
})

after(() => {
  dom.window.close()
})

function download(platformKey: string): BridgeStandaloneDownload {
  return {
    platformKey,
    buildRevision: 'abc123def456',
    releasedAt: '2026-06-12T00:00:00.000Z',
    url: `https://printstream.app/api/bridge-runtime/release-assets/printstream-bridge-abc123def456-${platformKey}`,
    fileName: `printstream-bridge-abc123def456-${platformKey}`,
    sizeBytes: 151_000_000,
    sha256: 'abc123'
  }
}

const ALL_DOWNLOADS = [
  download('linux-arm64'),
  download('linux-x64'),
  download('win32-x64')
]

test('flags the package matching the machine and opens its dialog with a Download button', async () => {
  const view = render(
    <CssVarsProvider>
      <BridgeInstallCard downloads={ALL_DOWNLOADS} detectedPlatformKey="win32-x64" serverUrl="https://printstream.example.com" />
    </CssVarsProvider>
  )

  // The chooser is a single Install button; the actual download link lives on
  // the install dialog, so it should not exist before a package is chosen.
  assert.equal(view.queryByRole('link', { name: 'Download' }), null)
  fireEvent.click(view.getByRole('button', { name: 'Install' }))

  const recommended = await view.findByRole('menuitem', { name: 'Windows (x64)' })
  assert.match(recommended.textContent ?? '', /Compatible with this machine/)
  fireEvent.click(recommended)

  const link = await view.findByRole('link', { name: 'Download' })
  assert.equal(link.getAttribute('href'), download('win32-x64').url)
  assert.equal(link.getAttribute('download'), download('win32-x64').fileName)
  assert.match(view.getByText(/Double-click the downloaded file/).textContent ?? '', /administrator prompt/)
})

test('a Linux package shows the chmod + sudo install command', async () => {
  const view = render(
    <CssVarsProvider>
      <BridgeInstallCard downloads={ALL_DOWNLOADS} detectedPlatformKey="win32-x64" serverUrl="https://printstream.example.com" />
    </CssVarsProvider>
  )

  fireEvent.click(view.getByRole('button', { name: 'Install' }))
  fireEvent.click(await view.findByRole('menuitem', { name: 'Linux (x64)' }))

  const link = await view.findByRole('link', { name: 'Download' })
  assert.equal(link.getAttribute('href'), download('linux-x64').url)
  assert.match(view.getByText(/chmod \+x/).textContent ?? '', /sudo \.\//)
})

test('without a detected platform nothing is flagged, and each package opens the dialog', async () => {
  const view = render(
    <CssVarsProvider>
      <BridgeInstallCard downloads={ALL_DOWNLOADS} detectedPlatformKey={null} serverUrl="https://printstream.example.com" />
    </CssVarsProvider>
  )

  fireEvent.click(view.getByRole('button', { name: 'Install' }))
  const items = await view.findAllByRole('menuitem')
  for (const item of items) {
    assert.doesNotMatch(item.textContent ?? '', /Compatible with this machine/)
  }

  fireEvent.click(view.getByRole('menuitem', { name: 'Linux (ARM64)' }))
  const link = await view.findByRole('link', { name: 'Download' })
  assert.equal(link.getAttribute('href'), download('linux-arm64').url)
})

test('the Docker entry opens a compose quick-start with the server origin filled in', async () => {
  const view = render(
    <CssVarsProvider>
      <BridgeInstallCard downloads={ALL_DOWNLOADS} detectedPlatformKey="win32-x64" serverUrl="https://printstream.example.com" />
    </CssVarsProvider>
  )

  fireEvent.click(view.getByRole('button', { name: 'Install' }))
  fireEvent.click(await view.findByRole('menuitem', { name: 'Run with Docker' }))

  const compose = (await view.findAllByText(/ghcr\.io\/printstreamapp\/printstream-bridge:latest/))[0]?.textContent ?? ''
  assert.match(compose, /BRIDGE_SERVER_URL: https:\/\/printstream\.example\.com/)
  // The dedicated bridge image's entrypoint is the bridge, so no `command:`.
  assert.doesNotMatch(compose, /command:/)
  assert.ok(view.getAllByText('docker compose up -d').length > 0)
})

test('without published native packages the Install button still offers Docker', async () => {
  const view = render(
    <CssVarsProvider>
      <BridgeInstallCard downloads={[]} detectedPlatformKey="win32-x64" serverUrl="https://printstream.example.com" />
    </CssVarsProvider>
  )

  // No native build label and no per-OS items, but Docker is always available.
  assert.equal(view.queryByText(/^Build /), null)
  fireEvent.click(view.getByRole('button', { name: 'Install' }))
  const items = await view.findAllByRole('menuitem')
  assert.deepEqual(items.map((item) => item.textContent), ['Run with Docker'])
})
