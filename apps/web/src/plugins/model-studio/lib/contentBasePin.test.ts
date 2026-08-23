import assert from 'node:assert/strict'
import test from 'node:test'
import { initialContentBasePin, nextContentBasePin } from './contentBasePin'

/**
 * The pin decides which bytes every save authors from, and a wrong answer is silent: the file
 * still opens, still slices, and just grows a stranded mesh object per solid per save. So each
 * branch of "move exactly once" gets a case.
 */

test('a session opened from a file starts pinned to that file head', () => {
  assert.deepEqual(initialContentBasePin('file-1', null), { fileId: 'file-1', versionId: null })
})

test('a session opened from an archived version starts pinned to it', () => {
  assert.deepEqual(initialContentBasePin('file-1', 'ver-3'), { fileId: 'file-1', versionId: 'ver-3' })
})

test('an editor-born project has no content base to pin', () => {
  assert.equal(initialContentBasePin(null, null), null)
})

test('the first save adopts the version it archived, those are the bytes we opened', () => {
  const pin = initialContentBasePin('file-1', null)
  assert.deepEqual(nextContentBasePin(pin, 'file-1', 'ver-9'), { fileId: 'file-1', versionId: 'ver-9' })
})

test('later saves do NOT move the pin, they archive our own output', () => {
  const afterFirst = { fileId: 'file-1', versionId: 'ver-9' }
  assert.deepEqual(nextContentBasePin(afterFirst, 'file-1', 'ver-10'), afterFirst)
  assert.deepEqual(nextContentBasePin(afterFirst, 'file-1', 'ver-11'), afterFirst)
})

test('a session opened on an archived version never moves', () => {
  const pin = initialContentBasePin('file-1', 'ver-3')
  assert.deepEqual(nextContentBasePin(pin, 'file-1', 'ver-9'), pin)
})

test('a saveAs onto a new file leaves the pin on the ORIGINAL', () => {
  // The new file archived nothing (it did not exist), so there is no version to adopt...
  const pin = initialContentBasePin('file-1', null)
  assert.deepEqual(nextContentBasePin(pin, 'file-2', null), pin)
  // ...and even a saveAs that OVERWROTE an existing file archived that file's content, not ours.
  assert.deepEqual(nextContentBasePin(pin, 'file-2', 'ver-77'), pin)
})

test('an editor-born project stays unpinned however many times it saves', () => {
  assert.equal(nextContentBasePin(null, 'file-1', 'ver-9'), null)
})
