import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { installJsdomGlobals } from '../test-utils/jsdom'
import {
  clearNativeAppPromotionAfterSignInFlag,
  dismissNativeAppPromotion,
  flagNativeAppPromotionAfterSignIn,
  hasNativeAppPromotionAfterSignInFlag,
  isNativeAppPromotionDismissed,
  resetNativeAppPromotionDismissalForDevelopment,
  resolveNativeAppPromotion
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

test('promotes the certified Windows app from client hints or the user agent', () => {
  const fromHints = resolveNativeAppPromotion({ uaDataPlatform: 'Windows' })
  const fromUserAgent = resolveNativeAppPromotion({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
  })

  assert.equal(fromHints?.platform, 'windows')
  assert.equal(fromHints?.storeUrl, 'https://apps.microsoft.com/detail/9N2CJ8BB9RTZ')
  assert.deepEqual(fromUserAgent, fromHints)
})

test('does not promote a native app on unsupported platforms', () => {
  assert.equal(resolveNativeAppPromotion({ uaDataPlatform: 'macOS' }), null)
  assert.equal(resolveNativeAppPromotion({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' }), null)
})

test('the sign-in signal persists until explicitly cleared and dismissal is platform-specific', () => {
  flagNativeAppPromotionAfterSignIn()
  assert.equal(hasNativeAppPromotionAfterSignInFlag(), true)
  assert.equal(hasNativeAppPromotionAfterSignInFlag(), true)
  clearNativeAppPromotionAfterSignInFlag()
  assert.equal(hasNativeAppPromotionAfterSignInFlag(), false)

  dismissNativeAppPromotion('android')
  assert.equal(isNativeAppPromotionDismissed('android'), true)
  assert.equal(isNativeAppPromotionDismissed('windows'), false)

  resetNativeAppPromotionDismissalForDevelopment('android')
  assert.equal(isNativeAppPromotionDismissed('android'), false)
  dismissNativeAppPromotion('android')
  resetNativeAppPromotionDismissalForDevelopment('android')
  assert.equal(isNativeAppPromotionDismissed('android'), true)
})
