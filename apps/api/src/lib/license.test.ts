import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readLicenseStatus, verifyLicenseToken } from './license.js'

/**
 * Core carries no signer (see the module header on `license.ts`), so these
 * tests drive verification from tokens pre-signed with a throwaway keypair
 * rather than minting them here. Round-tripping the signer is covered on the
 * cloud side, in `private/cloud/license-signing.test.ts`.
 *
 * The fixtures deliberately predate the `expiresAt`/`maxPrinters` payload
 * fields, so they also pin the back-compat contract: a key issued before those
 * fields existed must still verify, and read as perpetual + unlimited.
 */
const TEST_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAGO7ueTWuN977ufjIkvC4R4JM/Gt72cmY/18QBbSKXF0=
-----END PUBLIC KEY-----`

/** commercial / "Acme Corp" / issuedAt 1700000000 / updatesUntil 1800000000. */
const VALID_TOKEN =
  'PSL1.eyJ2IjoxLCJpZCI6ImxpY190ZXN0IiwiZWRpdGlvbiI6ImNvbW1lcmNpYWwiLCJsaWNlbnNlZSI6IkFjbWUgQ29ycCIsImlzc3VlZEF0IjoxNzAwMDAwMDAwLCJ1cGRhdGVzVW50aWwiOjE4MDAwMDAwMDB9.zCbcBTQAQdfUvONj-Dc6zS6gdZQvKD8d-N0eSQtt7c8SpKuJ8PmwqDyNfFaqlYKS9i5zN_1aRSkjxzmwX-YlDw'

/** The same payload, signed by a *different* keypair. */
const FOREIGN_TOKEN =
  'PSL1.eyJ2IjoxLCJpZCI6ImxpY190ZXN0IiwiZWRpdGlvbiI6ImNvbW1lcmNpYWwiLCJsaWNlbnNlZSI6IkFjbWUgQ29ycCIsImlzc3VlZEF0IjoxNzAwMDAwMDAwLCJ1cGRhdGVzVW50aWwiOjE4MDAwMDAwMDB9.ANjQ5LksFAfxNDcLEG4pOry6TFgo-guBRUHJkit2siWe4plQAVEdqPC6YkXUUZGl7jlzhdTjHQOGoT-daZWMDA'

test('verifyLicenseToken accepts a correctly signed token', () => {
  const payload = verifyLicenseToken(VALID_TOKEN, TEST_PUBLIC_KEY_PEM)
  assert.ok(payload)
  assert.equal(payload.edition, 'commercial')
  assert.equal(payload.licensee, 'Acme Corp')
  assert.equal(payload.updatesUntil, 1_800_000_000)
})

test('a key issued before expiresAt/maxPrinters existed reads as perpetual and unlimited', () => {
  const payload = verifyLicenseToken(VALID_TOKEN, TEST_PUBLIC_KEY_PEM)
  assert.ok(payload)
  assert.equal(payload.expiresAt, null)
  assert.equal(payload.maxPrinters, null)
})

test('verifyLicenseToken rejects a token signed by a different key', () => {
  assert.equal(verifyLicenseToken(FOREIGN_TOKEN, TEST_PUBLIC_KEY_PEM), null)
})

test('verifyLicenseToken rejects a tampered payload', () => {
  const forged = Buffer.from(JSON.stringify({
    v: 1,
    id: 'lic_test',
    edition: 'commercial',
    licensee: 'Hacker',
    issuedAt: 1_700_000_000,
    updatesUntil: 1_800_000_000
  })).toString('base64url')
  const tampered = `PSL1.${forged}.${VALID_TOKEN.split('.')[2]}`
  assert.equal(verifyLicenseToken(tampered, TEST_PUBLIC_KEY_PEM), null)
})

test('verifyLicenseToken rejects malformed tokens', () => {
  assert.equal(verifyLicenseToken('not-a-token', TEST_PUBLIC_KEY_PEM), null)
  assert.equal(verifyLicenseToken('PSL1.only-two', TEST_PUBLIC_KEY_PEM), null)
  assert.equal(verifyLicenseToken('WRONG.a.b', TEST_PUBLIC_KEY_PEM), null)
})

test('readLicenseStatus rejects a token not signed by the embedded vendor key', () => {
  // readLicenseStatus always verifies against the embedded production key, so a
  // fixture token signed by any other keypair must read as invalid. This is the
  // property that makes a self-generated key worthless in an unmodified build.
  const status = readLicenseStatus(VALID_TOKEN, 2_000)
  assert.equal(status.valid, false)
  assert.equal(status.edition, null)
})
