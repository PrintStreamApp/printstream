process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildLibraryFileOrderBy } from './library.js'

test('name/date/size sorts map to their columns and honor direction', () => {
  assert.deepEqual(buildLibraryFileOrderBy('name', 'asc'), { name: 'asc' })
  assert.deepEqual(buildLibraryFileOrderBy('date', 'desc'), { uploadedAt: 'desc' })
  assert.deepEqual(buildLibraryFileOrderBy('size', 'asc'), { sizeBytes: 'asc' })
})

test('mostPrinted sorts on the denormalized printCount rollup column', () => {
  assert.deepEqual(buildLibraryFileOrderBy('mostPrinted', 'desc'), { printCount: 'desc' })
})

test('lastPrinted sorts on lastPrintedAt with never-printed (null) files last', () => {
  assert.deepEqual(buildLibraryFileOrderBy('lastPrinted', 'desc'), { lastPrintedAt: { sort: 'desc', nulls: 'last' } })
  assert.deepEqual(buildLibraryFileOrderBy('lastPrinted', 'asc'), { lastPrintedAt: { sort: 'asc', nulls: 'last' } })
})
