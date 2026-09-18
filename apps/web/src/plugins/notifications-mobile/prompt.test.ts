import assert from 'node:assert/strict'
import { test } from 'node:test'
import { installJsdomGlobals } from '../../test-utils/jsdom'
import { dismissMobileNotificationOffer, isMobileNotificationOfferDismissed } from './prompt'

test('native notification deferral persists only for its account and membership selection', () => {
  const dom = installJsdomGlobals()
  try {
    const first = 'reviewer:demo,home'
    assert.equal(isMobileNotificationOfferDismissed(first), false)
    dismissMobileNotificationOffer(first)
    assert.equal(window.localStorage.getItem(first), '1')
    assert.equal(isMobileNotificationOfferDismissed(first), true)
    assert.equal(isMobileNotificationOfferDismissed('other-user:demo,home'), false)
    assert.equal(isMobileNotificationOfferDismissed('reviewer:demo,home,new'), false)
  } finally {
    dom.window.close()
  }
})

test('blocked storage still suppresses repeat offers for the current session', () => {
  const dom = installJsdomGlobals()
  const key = 'blocked-storage-user:first'
  try {
    Object.defineProperty(dom.window, 'localStorage', {
      configurable: true,
      get() { throw new Error('Storage blocked') }
    })
    assert.equal(isMobileNotificationOfferDismissed(key), false)
    assert.doesNotThrow(() => dismissMobileNotificationOffer(key))
    assert.equal(isMobileNotificationOfferDismissed(key), true)
  } finally {
    dom.window.close()
  }
})
