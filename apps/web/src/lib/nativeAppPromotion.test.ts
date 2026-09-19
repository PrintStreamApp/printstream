import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { installJsdomGlobals } from '../test-utils/jsdom'
import {
  dismissNativeAppPromotion,
  flagNativeAppPromotionAfterSignIn,
  isNativeAppPromotionDismissed,
  resolveNativeAppPromotion,
  takeNativeAppPromotionAfterSignInFlag
} from './nativeAppPromotion'

const dom = installJsdomGlobals({ url: 'https://app.printstream.example/auth' })

beforeEach(() => {
  dom.window.localStorage.clear()
  dom.window.sessionStorage.clear()
})

after(() => dom.window.close())

test('promotes the released Android app from client hints or the user agent', () => {
  const fromHints = resolveNativeAppPromotion({ uaDataPlatform: 'Android' })
  const fromUserAgent = resolveNativeAppPromotion({
    userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Mobile Safari/537.36'
  })
  const fromGenericClientHint = resolveNativeAppPromotion({
    uaDataPlatform: 'Linux',
    userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Mobile Safari/537.36'
  })

  assert.equal(fromHints?.platform, 'android')
  assert.equal(fromHints?.storeUrl, 'https://play.google.com/store/apps/details?id=app.printstream')
  assert.deepEqual(fromUserAgent, fromHints)
  assert.deepEqual(fromGenericClientHint, fromHints)
})

test('keeps the Windows promotion dormant until Store certification', () => {
  assert.equal(resolveNativeAppPromotion({ uaDataPlatform: 'Windows' }), null)
  assert.equal(resolveNativeAppPromotion({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }), null)
})

test('does not promote a native app on unsupported platforms', () => {
  assert.equal(resolveNativeAppPromotion({ uaDataPlatform: 'macOS' }), null)
  assert.equal(resolveNativeAppPromotion({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' }), null)
})

test('the sign-in signal is consumed once and dismissal is platform-specific', () => {
  flagNativeAppPromotionAfterSignIn()
  assert.equal(takeNativeAppPromotionAfterSignInFlag(), true)
  assert.equal(takeNativeAppPromotionAfterSignInFlag(), false)

  dismissNativeAppPromotion('android')
  assert.equal(isNativeAppPromotionDismissed('android'), true)
  assert.equal(isNativeAppPromotionDismissed('windows'), false)
})
