import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/browser'
import { registrationOptionsForClient } from './passkeyRegistrationOptions'

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

test('native Windows registration strictly requests the operating system authenticator', () => {
  const result = registrationOptionsForClient({ ...serverOptions, hints: ['client-device'] }, true)

  assert.equal(result.hints, undefined)
  assert.equal(result.authenticatorSelection?.authenticatorAttachment, 'platform')
  assert.equal(result.authenticatorSelection?.residentKey, 'required')
  assert.equal('authenticatorAttachment' in serverOptions.authenticatorSelection, false)
})

test('web registration preserves the server options and browser provider choices', () => {
  const result = registrationOptionsForClient(serverOptions, false)

  assert.equal(result, serverOptions)
})
