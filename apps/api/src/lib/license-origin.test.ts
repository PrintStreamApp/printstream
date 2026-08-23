process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { env } from './env.js'
import {
  DEFAULT_LICENSE_ORIGIN,
  resetLicenseOriginWarningForTests,
  resolveLicenseRefreshOrigin
} from './license-origin.js'

/**
 * Core carries no signer, so, like `license.test.ts`, these drive the resolver
 * from tokens pre-signed with a throwaway keypair, passed explicitly.
 */
const TEST_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA+cS1Gsms20cDaxSC2SAErlD3F8zrHa30jUkByBGXvGU=
-----END PUBLIC KEY-----`

/** commercial / Acme Corp / refreshOrigin https://staging.printstream.app. */
const KEY_WITH_ORIGIN =
  'PSL1.eyJ2IjoxLCJpZCI6ImxpY190ZXN0IiwiZWRpdGlvbiI6ImNvbW1lcmNpYWwiLCJsaWNlbnNlZSI6IkFjbWUgQ29ycCIsImlzc3VlZEF0IjoxNzAwMDAwMDAwLCJ1cGRhdGVzVW50aWwiOjE4MDAwMDAwMDAsImV4cGlyZXNBdCI6MTgwMDAwMDAwMCwibWF4UHJpbnRlcnMiOjQsInJlZnJlc2hPcmlnaW4iOiJodHRwczovL3N0YWdpbmcucHJpbnRzdHJlYW0uYXBwIn0.lE_ARn0h6Aw6NIkO7QCb3yZ2D6lVprI0yFiACzjSyGx9ZdWpbRmGOZi0Wx6ZAQd8PtM7Jm3uhhhzVBSrxJQUBQ'

/** The same payload with no `refreshOrigin`, a key issued before the field existed. */
const KEY_WITHOUT_ORIGIN =
  'PSL1.eyJ2IjoxLCJpZCI6ImxpY190ZXN0IiwiZWRpdGlvbiI6ImNvbW1lcmNpYWwiLCJsaWNlbnNlZSI6IkFjbWUgQ29ycCIsImlzc3VlZEF0IjoxNzAwMDAwMDAwLCJ1cGRhdGVzVW50aWwiOjE4MDAwMDAwMDAsImV4cGlyZXNBdCI6MTgwMDAwMDAwMCwibWF4UHJpbnRlcnMiOjR9.i3o3u23scKawSj5ccYj9FUPZaWKVz2WsmVRdeJzmi3e36eoXBrNd7ibzZbQAxJeonL0HIW3GG7fv1bZVFgoIAQ'

afterEach(() => {
  delete env.LICENSE_REFRESH_ORIGIN
  resetLicenseOriginWarningForTests()
})

test('a key names the deployment it refreshes against', () => {
  assert.equal(
    resolveLicenseRefreshOrigin(KEY_WITH_ORIGIN, TEST_PUBLIC_KEY_PEM),
    'https://staging.printstream.app'
  )
})

test('a key issued before the field existed still refreshes against the cloud', () => {
  // The back-compat contract: adding a signed field must not strand any key
  // already in the field, all of which refresh where they always have.
  assert.equal(resolveLicenseRefreshOrigin(KEY_WITHOUT_ORIGIN, TEST_PUBLIC_KEY_PEM), DEFAULT_LICENSE_ORIGIN)
})

test('an explicitly configured origin overrides the key', () => {
  env.LICENSE_REFRESH_ORIGIN = 'https://mirror.example.com'
  assert.equal(
    resolveLicenseRefreshOrigin(KEY_WITH_ORIGIN, TEST_PUBLIC_KEY_PEM),
    'https://mirror.example.com'
  )
})

test('the override is reported when it disagrees with the key', () => {
  // The disagreement is the state that produces a silent, weeks-late failure,
  // so it must be visible in the log even though the override still wins.
  const warnings: unknown[][] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => { warnings.push(args) }
  try {
    env.LICENSE_REFRESH_ORIGIN = 'https://mirror.example.com'
    resolveLicenseRefreshOrigin(KEY_WITH_ORIGIN, TEST_PUBLIC_KEY_PEM)
    resolveLicenseRefreshOrigin(KEY_WITH_ORIGIN, TEST_PUBLIC_KEY_PEM)
  } finally {
    console.warn = original
  }
  assert.equal(warnings.length, 1, 'a daily timer must not relog a permanent misconfiguration')
  assert.match(String(warnings[0]?.[0]), /overrides the deployment/)
})

test('an override matching the key is not reported', () => {
  const warnings: unknown[][] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => { warnings.push(args) }
  try {
    env.LICENSE_REFRESH_ORIGIN = 'https://staging.printstream.app'
    resolveLicenseRefreshOrigin(KEY_WITH_ORIGIN, TEST_PUBLIC_KEY_PEM)
  } finally {
    console.warn = original
  }
  assert.deepEqual(warnings, [])
})

test('an absent or unverifiable key falls back to the cloud', () => {
  // Callers reach here before deciding a request is worth making, so this must
  // answer rather than throw.
  assert.equal(resolveLicenseRefreshOrigin(null, TEST_PUBLIC_KEY_PEM), DEFAULT_LICENSE_ORIGIN)
  assert.equal(resolveLicenseRefreshOrigin('', TEST_PUBLIC_KEY_PEM), DEFAULT_LICENSE_ORIGIN)
  assert.equal(resolveLicenseRefreshOrigin('not-a-token', TEST_PUBLIC_KEY_PEM), DEFAULT_LICENSE_ORIGIN)
})

test('a key signed by another party cannot redirect the refresh', () => {
  // The whole reason the origin is inside the signature: an attacker who could
  // point an install at a server of their choosing would control its licence.
  assert.equal(resolveLicenseRefreshOrigin(KEY_WITH_ORIGIN), DEFAULT_LICENSE_ORIGIN)
})
