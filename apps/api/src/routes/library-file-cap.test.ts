process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { capLibraryFileRows, LIBRARY_BROWSE_FILE_LIMIT, parseLibraryFileIdsQuery } from './library.js'

test('returns all rows untouched when under the cap', () => {
  const result = capLibraryFileRows([1, 2, 3], 5)
  assert.deepEqual(result.rows, [1, 2, 3])
  assert.equal(result.truncated, false)
  assert.equal(result.fileLimit, null)
})

test('does not truncate when the count exactly equals the cap', () => {
  const result = capLibraryFileRows([1, 2, 3], 3)
  assert.deepEqual(result.rows, [1, 2, 3])
  assert.equal(result.truncated, false)
  assert.equal(result.fileLimit, null)
})

test('caps to the limit and flags truncation when over (drops the LIMIT+1 probe row)', () => {
  // The route fetches LIMIT + 1 to detect overflow; here limit=3 and 4 rows came back.
  const result = capLibraryFileRows([1, 2, 3, 4], 3)
  assert.deepEqual(result.rows, [1, 2, 3])
  assert.equal(result.truncated, true)
  assert.equal(result.fileLimit, 3, 'advertises the applied cap only when truncated')
})

test('the configured library cap is a sane positive integer bound', () => {
  assert.ok(LIBRARY_BROWSE_FILE_LIMIT > 0)
  assert.equal(Number.isInteger(LIBRARY_BROWSE_FILE_LIMIT), true)
})

test('parseLibraryFileIdsQuery returns null when no ids param is supplied', () => {
  assert.equal(parseLibraryFileIdsQuery(undefined), null)
  assert.equal(parseLibraryFileIdsQuery(['a', 'b']), null, 'array form (repeated query key) is ignored')
})

test('parseLibraryFileIdsQuery trims, drops empties, and de-duplicates', () => {
  assert.deepEqual(parseLibraryFileIdsQuery('a, b ,a, ,c'), ['a', 'b', 'c'])
})

test('parseLibraryFileIdsQuery returns an empty list for an explicit empty ids param', () => {
  // An explicit `?ids=` means "resolve these ids" with none given -> no files,
  // NOT a fall-through to the full (capped) library listing.
  assert.deepEqual(parseLibraryFileIdsQuery(''), [])
})

test('parseLibraryFileIdsQuery caps the id list to the query limit', () => {
  const many = Array.from({ length: 1500 }, (_value, index) => `id-${index}`).join(',')
  const parsed = parseLibraryFileIdsQuery(many)
  assert.equal(parsed?.length, 1000)
})
