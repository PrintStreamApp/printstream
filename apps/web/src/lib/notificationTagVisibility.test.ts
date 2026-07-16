import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { JSDOM } from 'jsdom'
import { installJsdomGlobals } from '../test-utils/jsdom'

let dom: JSDOM
before(() => {
  dom = installJsdomGlobals()
  // jsdom defaults to a prerendering, unfocused document; model the focused
  // foreground tab the registry is designed to detect.
  setDocumentVisibility('visible')
  Object.defineProperty(dom.window.document, 'hasFocus', { configurable: true, value: () => true })
})
after(() => { dom.window.close() })

function setDocumentVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(dom.window.document, 'visibilityState', { configurable: true, value: state })
}

test('a tag is visible only while claimed, counted across overlapping claimants', async () => {
  const { claimNotificationTagVisible, isNotificationTagVisible } = await import('./notificationTagVisibility')

  assert.equal(isNotificationTagVisible('support:c1'), false, 'unclaimed tags are not visible')

  const releaseFirst = claimNotificationTagVisible('support:c1')
  const releaseSecond = claimNotificationTagVisible('support:c1')
  assert.equal(isNotificationTagVisible('support:c1'), true)
  assert.equal(isNotificationTagVisible('support:other'), false, 'claims are per tag')

  releaseFirst()
  releaseFirst() // Idempotent: a double release must not steal the second claim.
  assert.equal(isNotificationTagVisible('support:c1'), true, 'still claimed by the second claimant')

  releaseSecond()
  assert.equal(isNotificationTagVisible('support:c1'), false)
})

test('a claimed tag in a hidden document is not visible', async () => {
  const { claimNotificationTagVisible, isNotificationTagVisible } = await import('./notificationTagVisibility')

  const release = claimNotificationTagVisible('support:c2')
  try {
    setDocumentVisibility('hidden')
    assert.equal(isNotificationTagVisible('support:c2'), false)
    setDocumentVisibility('visible')
    assert.equal(isNotificationTagVisible('support:c2'), true)
  } finally {
    release()
  }
})
