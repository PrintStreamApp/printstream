import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extractErrorMessage } from './errors.js'

test('extractErrorMessage prefers nested error and message fields', () => {
  assert.equal(extractErrorMessage({ error: 'Printer offline', message: 'ignored' }), 'Printer offline')
  assert.equal(extractErrorMessage({ message: 'Request failed' }), 'Request failed')
})

test('extractErrorMessage unwraps Error instances and falls back for empty strings', () => {
  assert.equal(extractErrorMessage(new Error('Boom')), 'Boom')
  assert.equal(extractErrorMessage('   ', 'fallback message'), 'fallback message')
})

test('extractErrorMessage extracts useful text from HTML error bodies', () => {
  assert.equal(
    extractErrorMessage('<html><head><title>502 Bad Gateway</title></head><body><h1>ignored</h1></body></html>'),
    '502 Bad Gateway'
  )
  assert.equal(
    extractErrorMessage('<html><body><h1>Access denied</h1><p>Printer unreachable</p></body></html>'),
    'Access denied'
  )
})
test('extractErrorMessage scans only the head of a huge HTML body', () => {
  const filler = '<p>x</p>'.repeat(64 * 1024)
  assert.equal(
    extractErrorMessage(`<html><head><title>502 Bad Gateway</title></head><body>${filler}</body></html>`),
    '502 Bad Gateway'
  )
  // A title buried past the scan window is not worth hunting for; the strip
  // fallback (bounded to the same window) answers instead.
  const late = extractErrorMessage(`<html>${filler}<title>late title</title></html>`)
  assert.ok(!late.includes('late title'))
  assert.ok(late.startsWith('x x'))
})
