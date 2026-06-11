import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseTrayColor, parseTrayColors } from './tray-colors.js'

test('parseTrayColor normalizes printer RGBA values and drops transparent/unset colors', () => {
  assert.equal(parseTrayColor('FFFFFFFF'), '#FFFFFF')
  assert.equal(parseTrayColor('ff6a13ff'), '#FF6A13')
  assert.equal(parseTrayColor('00000000'), null)
  assert.equal(parseTrayColor('000000'), null)
})

test('parseTrayColors keeps ordered unique multi-color palettes and falls back to the primary color', () => {
  assert.deepEqual(
    parseTrayColors(['FFFFFFFF', '9CDBD9FF', 'FFFFFFFF'], '#FFFFFF'),
    ['#FFFFFF', '#9CDBD9']
  )
  assert.deepEqual(parseTrayColors(null, '#00AE42'), ['#00AE42'])
  assert.deepEqual(parseTrayColors([], null), [])
})