import assert from 'node:assert/strict'
import test from 'node:test'
import {
  desktopPlatform,
  isNativeDesktop,
  isDesktopMakerWorldChallengeTest,
  supportsDesktopModelBrowserImport,
  supportsDesktopMakerWorldImport,
  supportsDesktopNotifications
} from './desktop-host.js'

test('older desktop hosts retain their existing notification capability by default', () => {
  setDesktopHost({ version: 1, request: async () => undefined })
  assert.equal(isNativeDesktop(), true)
  assert.equal(desktopPlatform(), null)
  assert.equal(supportsDesktopMakerWorldImport(), false)
  assert.equal(supportsDesktopModelBrowserImport('printables'), false)
  assert.equal(isDesktopMakerWorldChallengeTest(), false)
  assert.equal(supportsDesktopNotifications(), true)
  delete (globalThis as { window?: unknown }).window
})

test('an Electron host advertises browser import and notification parity', () => {
  setDesktopHost({
    version: 1,
    capabilities: {
      platform: 'win32',
      makerWorldBrowserImport: true,
      modelBrowserImport: ['makerworld', 'printables'],
      makerWorldChallengeTest: true,
      notifications: true
    },
    request: async () => undefined
  })
  assert.equal(isNativeDesktop(), true)
  assert.equal(desktopPlatform(), 'win32')
  assert.equal(supportsDesktopMakerWorldImport(), true)
  assert.equal(supportsDesktopModelBrowserImport('printables'), true)
  assert.equal(isDesktopMakerWorldChallengeTest(), true)
  assert.equal(supportsDesktopNotifications(), true)
  delete (globalThis as { window?: unknown }).window
})

function setDesktopHost(host: unknown): void {
  ;(globalThis as { window?: unknown }).window = { PrintStreamDesktop: host }
}
