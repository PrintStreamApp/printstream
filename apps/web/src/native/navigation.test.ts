import assert from 'node:assert/strict'
import test from 'node:test'
import { installJsdomGlobals } from '../test-utils/jsdom'
import { nativeReturnPath, rememberNativeReturnPath, readNativeReturnPath, clearNativeReturnPath } from './navigation'

test('return destinations are local app/setup paths, never auth or external URLs', () => {
  assert.equal(nativeReturnPath('/workspaces/shop/library?code=secret#file'), '/workspaces/shop/library')
  assert.equal(nativeReturnPath('/register?intent=cloud'), '/register')
  assert.equal(nativeReturnPath('/billing/customer-1?code=secret'), '/billing/customer-1')
  assert.equal(nativeReturnPath('/platform/account'), '/platform/account')
  for (const path of ['https://evil.test', '//evil.test', '/\\evil.test', '/workspaces/../api/logout', '/workspaces/%2e%2e', '/api/auth/callback', '/privacy']) {
    assert.equal(nativeReturnPath(path), null, path)
  }
})

test('policy detours retain their app or onboarding caller, and welcome clears it', () => {
  const dom = installJsdomGlobals()
  Object.assign(globalThis, { sessionStorage: dom.window.sessionStorage })
  try {
    rememberNativeReturnPath('/workspaces/shop/printers')
    rememberNativeReturnPath('/privacy')
    assert.equal(readNativeReturnPath('/privacy'), '/workspaces/shop/printers')
    rememberNativeReturnPath('/register')
    assert.equal(readNativeReturnPath('/terms'), '/register')
    assert.equal(readNativeReturnPath('/register'), null)
    clearNativeReturnPath()
    assert.equal(readNativeReturnPath('/'), null)
  } finally { dom.window.close() }
})
