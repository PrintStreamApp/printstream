/**
 * The rule that decides whether a bridge download needs `BRIDGE_SERVER_URL`.
 *
 * Worth a test of its own because both answers fail quietly when wrong: told to
 * configure an origin it already has, a cloud customer retypes a URL for no
 * reason; NOT told, a staging or self-hosted download installs cleanly and
 * registers with the cloud, then prints a connect code for a server the person
 * is not looking at.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { STANDALONE_BRIDGE_DEFAULT_SERVER_URL } from '@printstream/shared'
import { standaloneBridgeServerUrlOverride } from './bridges.js'

test('the cloud origin needs no override', () => {
  assert.equal(standaloneBridgeServerUrlOverride(STANDALONE_BRIDGE_DEFAULT_SERVER_URL), null)
  // The same origin written differently is still the same origin: a trailing
  // slash or different case must not make the cloud instruct its own customers.
  assert.equal(standaloneBridgeServerUrlOverride('https://printstream.app/'), null)
  assert.equal(standaloneBridgeServerUrlOverride('https://PrintStream.app'), null)
})

test('every other origin is stamped, including self-hosted', () => {
  assert.equal(
    standaloneBridgeServerUrlOverride('https://staging.printstream.app'),
    'https://staging.printstream.app'
  )
  // The case this also fixes: a self-hoster downloading from their own server
  // would otherwise ship their bridge to the cloud.
  assert.equal(standaloneBridgeServerUrlOverride('https://printer.lan:4000'), 'https://printer.lan:4000')
  // A subdomain is not the cloud, and must not be mistaken for it by a substring
  // comparison.
  assert.equal(standaloneBridgeServerUrlOverride('https://evil-printstream.app'), 'https://evil-printstream.app')
})

test('an unresolved origin falls back to the binary default rather than guessing', () => {
  assert.equal(standaloneBridgeServerUrlOverride(null), null)
})
