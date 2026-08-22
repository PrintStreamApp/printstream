import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { probeRemoteImportHelper } from './extensionProbe'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost:5173/workspaces/default/import'
})

after(() => {
  dom.window.close()
})

test('probeRemoteImportHelper resolves true when the extension answers the page probe', async () => {
  const { window } = dom
  const handleProbe = (event: Event) => {
    const customEvent = event as CustomEvent<{ probeId?: string }>
    window.dispatchEvent(new window.MessageEvent('message', {
      source: window as unknown as MessageEventSource,
      data: {
        type: 'printstream-remote-import-helper-presence',
        probeId: customEvent.detail?.probeId
      }
    }))
  }
  window.addEventListener('printstream:remote-import-helper-probe', handleProbe)

  try {
    assert.equal(await probeRemoteImportHelper(window as unknown as Window, 50), true)
  } finally {
    window.removeEventListener('printstream:remote-import-helper-probe', handleProbe)
  }
})

test('probeRemoteImportHelper resolves false when no extension answers the probe', async () => {
  assert.equal(await probeRemoteImportHelper(dom.window as unknown as Window, 10), false)
})
