import test from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeProfileFileName } from './profile-file-name.js'

test('sanitizeProfileFileName strips CLI-sensitive separators from custom profile ids', () => {
  assert.equal(
    sanitizeProfileFileName('custom:442eadee-4567-4559-b46c-b410d8f8dd54'),
    'custom-442eadee-4567-4559-b46c-b410d8f8dd54'
  )
})

test('sanitizeProfileFileName strips path separators and argument delimiters', () => {
  assert.equal(
    sanitizeProfileFileName('machine/profile;variant:0.4'),
    'machine-profile-variant-0.4'
  )
})