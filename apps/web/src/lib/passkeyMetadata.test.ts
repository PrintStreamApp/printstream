import assert from 'node:assert/strict'
import test from 'node:test'
import { describePasskey, formatPasskeyTransportLabel, suggestPasskeyNickname } from './passkeyMetadata'

test('describePasskey classifies synced internal passkeys as synced wallets', () => {
  const details = describePasskey({
    aaguid: null,
    backedUp: true,
    transports: ['internal']
  })

  assert.equal(details.defaultLabel, 'Synced passkey')
  assert.equal(details.providerLabel, null)
  assert.equal(details.walletLabel, 'Synced passkey wallet')
  assert.equal(details.authenticatorLabel, 'Built-in device authenticator')
  assert.equal(details.visualKind, 'synced')
})

test('describePasskey classifies hardware keys from their transports', () => {
  const details = describePasskey({
    aaguid: null,
    backedUp: false,
    transports: ['usb', 'nfc']
  })

  assert.equal(details.defaultLabel, 'Security key')
  assert.equal(details.visualKind, 'security-key')
  assert.equal(suggestPasskeyNickname({ aaguid: null, backedUp: false, transports: ['usb'] }), 'Security key')
})

test('describePasskey uses known AAGUID labels when available', () => {
  const details = describePasskey({
    aaguid: 'fa2b99dc-9e39-4257-8f92-4a30d23c4118',
    backedUp: false,
    transports: ['usb']
  })

  assert.equal(details.defaultLabel, 'YubiKey 5')
  assert.equal(details.providerLabel, 'Yubico')
  assert.equal(details.walletLabel, 'Yubico hardware security key')
})

test('describePasskey maps Bitwarden passkeys to provider-specific labels', () => {
  const details = describePasskey({
    aaguid: 'd548826e-79b4-db40-a3d8-11116f7e8349',
    backedUp: true,
    transports: ['internal', 'hybrid']
  })

  assert.equal(details.defaultLabel, 'Bitwarden passkey')
  assert.equal(details.providerLabel, 'Bitwarden')
  assert.equal(details.walletLabel, 'Bitwarden vault')
  assert.equal(details.providerKind, 'bitwarden')
  assert.equal(suggestPasskeyNickname({ aaguid: 'd548826e-79b4-db40-a3d8-11116f7e8349', backedUp: true, transports: ['internal'] }), 'Bitwarden passkey')
})

test('describePasskey maps Google Password Manager passkeys to provider-specific labels', () => {
  const details = describePasskey({
    aaguid: 'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4',
    backedUp: true,
    transports: ['internal', 'hybrid']
  })

  assert.equal(details.defaultLabel, 'Google Password Manager passkey')
  assert.equal(details.providerLabel, 'Google Password Manager')
  assert.equal(details.providerKind, 'google-password-manager')
})

test('formatPasskeyTransportLabel renders human-readable transport names', () => {
  assert.equal(formatPasskeyTransportLabel(['internal', 'hybrid']), 'Built-in, Hybrid / QR')
  assert.equal(formatPasskeyTransportLabel([]), 'Transport not reported')
})

test('describePasskey tolerates passkeys without transport metadata', () => {
  const missingTransportDetails = describePasskey({
    aaguid: null,
    backedUp: false,
    transports: undefined
  })

  assert.equal(missingTransportDetails.defaultLabel, 'Passkey authenticator')
  assert.equal(missingTransportDetails.transportLabel, 'Transport not reported')
  assert.equal(formatPasskeyTransportLabel(null), 'Transport not reported')
})