import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/browser'
import { registrationOptionsForTarget } from './passkeyRegistrationOptions'

const serverOptions = {
  rp: { id: 'printstream.example', name: 'PrintStream' },
  user: { id: 'user-id', name: 'person@example.com', displayName: 'Person' },
  challenge: 'challenge',
  pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
  authenticatorSelection: {
    residentKey: 'required',
    userVerification: 'preferred'
  }
} satisfies PublicKeyCredentialCreationOptionsJSON

test('local registration asks Chromium for the operating system authenticator', () => {
  const result = registrationOptionsForTarget(serverOptions, 'local-device')

  assert.deepEqual(result.hints, ['client-device'])
  assert.equal(result.authenticatorSelection?.authenticatorAttachment, 'platform')
  assert.equal(result.authenticatorSelection?.residentKey, 'required')
  assert.equal('authenticatorAttachment' in serverOptions.authenticatorSelection, false)
})

test('another-device registration preserves the portable server options', () => {
  const result = registrationOptionsForTarget(serverOptions, 'another-device')

  assert.equal(result, serverOptions)
})
