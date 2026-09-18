import assert from 'node:assert/strict'
import test from 'node:test'
import {
  androidPasskeyOrigin,
  buildAndroidAssetLinks,
  parseAndroidCertificateFingerprints
} from './android-passkeys.js'

const FINGERPRINT = 'A0:A1:A2:A3:A4:A5:A6:A7:A8:A9:AA:AB:AC:AD:AE:AF:B0:B1:B2:B3:B4:B5:B6:B7:B8:B9:BA:BB:BC:BD:BE:BF'

test('Android certificate fingerprints normalize and deduplicate', () => {
  assert.deepEqual(
    parseAndroidCertificateFingerprints(`${FINGERPRINT.toLowerCase()}, ${FINGERPRINT}`),
    [FINGERPRINT]
  )
  assert.throws(
    () => parseAndroidCertificateFingerprints('not-a-certificate'),
    /SHA-256 fingerprints/
  )
})

test('Android passkey origin is the unpadded base64url certificate hash', () => {
  assert.equal(
    androidPasskeyOrigin(FINGERPRINT),
    'android:apk-key-hash:oKGio6SlpqeoqaqrrK2ur7CxsrO0tba3uLm6u7y9vr8'
  )
})

test('asset links associate both supported package ids with every certificate', () => {
  const statements = buildAndroidAssetLinks([FINGERPRINT])
  assert.deepEqual(statements.map((statement) => statement.target.package_name), [
    'app.printstream',
    'app.printstream.test'
  ])
  assert.deepEqual(statements[0]?.target.sha256_cert_fingerprints, [FINGERPRINT])
  for (const statement of statements) {
    assert.deepEqual(statement.relation, [
      'delegate_permission/common.get_login_creds',
      'delegate_permission/common.handle_all_urls'
    ])
  }
})

test('asset links stay empty until certificate identities are configured', () => {
  assert.deepEqual(buildAndroidAssetLinks([]), [])
})
