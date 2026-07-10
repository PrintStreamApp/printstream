import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  filamentIdentityLabel,
  isGenuineBambuTray,
  resolveFilamentIdentity,
  resolveProjectFilamentColorName
} from './filament-identity.js'
import { bambuSwatchForHex } from './bambu-colors.js'

const GENUINE_PLA_WHITE = {
  color: 'FFFFFFFF',
  colors: ['#FFFFFF'],
  trayName: null,
  trayInfoIdx: 'GFA00',
  filamentType: 'PLA',
  trayUuid: 'AA8D54B0C0FFEE00'
}

const CUSTOM_PLA_WHITE = {
  color: 'FFFFFFFF',
  colors: ['#FFFFFF'],
  trayName: null,
  trayInfoIdx: 'P00-C1', // custom (non-GF*) preset id
  filamentType: 'PLA',
  trayUuid: null
}

test('genuine Bambu tray resolves marketing identity (brand, preset, Jade White)', () => {
  const identity = resolveFilamentIdentity(GENUINE_PLA_WHITE)
  assert.equal(identity.genuineBambu, true)
  assert.equal(identity.brand, 'Bambu')
  assert.equal(identity.subtype, 'PLA Basic')
  assert.equal(identity.presetName, 'Bambu PLA Basic')
  assert.equal(identity.colorName, 'Jade White')
  assert.equal(filamentIdentityLabel(identity), 'Bambu PLA Basic · Jade White')
})

test('custom tray never claims Bambu identity — plain type + common colour', () => {
  const identity = resolveFilamentIdentity(CUSTOM_PLA_WHITE)
  assert.equal(identity.genuineBambu, false)
  assert.equal(identity.brand, null)
  assert.equal(identity.subtype, null)
  assert.equal(identity.presetName, null)
  assert.equal(identity.colorName, 'White')
  assert.equal(filamentIdentityLabel(identity), 'PLA · White')
})

test('a user-assigned Bambu preset id without RFID does not unlock marketing names', () => {
  const identity = resolveFilamentIdentity({ ...CUSTOM_PLA_WHITE, trayInfoIdx: 'GFA00' })
  assert.equal(identity.genuineBambu, false)
  assert.equal(identity.brand, null)
  assert.equal(identity.presetName, null)
  assert.equal(identity.colorName, 'White')
})

test('tracked spool fields override tray derivation', () => {
  const identity = resolveFilamentIdentity({
    ...CUSTOM_PLA_WHITE,
    spool: { brand: "Michael's", colorName: 'Bright White' }
  })
  assert.equal(identity.brand, "Michael's")
  assert.equal(identity.colorName, 'Bright White')
  assert.equal(filamentIdentityLabel(identity), "Michael's PLA · Bright White")
})

test('isGenuineBambuTray requires an RFID tag and rejects third-party preset ids', () => {
  assert.equal(isGenuineBambuTray({ trayUuid: 'AA8D54B0', trayInfoIdx: 'GFA00' }), true)
  assert.equal(isGenuineBambuTray({ trayUuid: 'AA8D54B0', trayInfoIdx: 'GFB60' }), false) // PolyLite ABS
  assert.equal(isGenuineBambuTray({ trayUuid: null, trayInfoIdx: 'GFA00' }), false)
  assert.equal(isGenuineBambuTray({ trayUuid: '0000000000000000', trayInfoIdx: 'GFA00' }), false)
})

// Regression for the "custom ASA labelled Jade White" bug: the swatch lookup is
// material-scoped, so a hex only names within its own family.
test('bambuSwatchForHex never falls back across material families', () => {
  assert.equal(bambuSwatchForHex('#FFFFFF', 'ASA'), null) // ASA White is #FFFAF2
  assert.equal(bambuSwatchForHex('#FFFFFF', 'PLA Basic')?.name, 'Jade White')
  assert.equal(bambuSwatchForHex('#FFFFFF', null)?.name, 'Jade White') // global lookup only with no material
})

test('resolveProjectFilamentColorName gates marketing names on a Bambu-branded filament name', () => {
  // Non-Bambu preset name (the profile-vendor bug path): common name only.
  assert.equal(
    resolveProjectFilamentColorName({ color: '#FFFFFF', filamentName: 'ASA - Custom', filamentType: 'ASA' }),
    'White'
  )
  // "Bambu Lab ASA" is Bambu-branded, but ASA has no #FFFFFF swatch and there is
  // no cross-family fallback → common name, not Jade White.
  assert.equal(
    resolveProjectFilamentColorName({ color: '#FFFFFF', filamentName: 'Bambu Lab ASA', filamentType: 'ASA' }),
    'White'
  )
  assert.equal(
    resolveProjectFilamentColorName({ color: '#FFFFFF', filamentName: 'Bambu PLA Basic', filamentType: 'PLA' }),
    'Jade White'
  )
})
