import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hashPassword, hashPasswordWithScrypt, needsRehash, verifyPassword } from './password-hash.js'

test('hashPassword produces an argon2id hash that verifies', async () => {
  const hash = await hashPassword('correct horse battery staple')
  assert.match(hash, /^\$argon2id\$/)
  assert.equal(await verifyPassword(hash, 'correct horse battery staple'), true)
  assert.equal(await verifyPassword(hash, 'wrong password value'), false)
})

test('verifyPassword returns false for a tampered or malformed hash', async () => {
  const hash = await hashPassword('another good password')
  assert.equal(await verifyPassword(`${hash}tampered`, 'another good password'), false)
  assert.equal(await verifyPassword('not-a-hash', 'another good password'), false)
  assert.equal(await verifyPassword('', 'another good password'), false)
})

test('needsRehash flags scrypt hashes for upgrade when argon2 is available', async () => {
  const argonHash = await hashPassword('upgrade me please')
  assert.equal(await needsRehash(argonHash), false)
  const scryptHash = await hashPasswordWithScrypt('upgrade me please')
  assert.equal(await needsRehash(scryptHash), true)
})

test('the scrypt fallback round-trips through verifyPassword', async () => {
  const hash = await hashPasswordWithScrypt('scrypt fallback password')
  assert.match(hash, /^scrypt\$/)
  assert.equal(await verifyPassword(hash, 'scrypt fallback password'), true)
  assert.equal(await verifyPassword(hash, 'scrypt fallback passworD'), false)
})
