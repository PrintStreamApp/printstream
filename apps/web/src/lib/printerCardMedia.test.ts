import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveBufferedCoverUrl, resolveBufferedSnapshotSrc } from './printerCardMedia.js'

test('resolveBufferedCoverUrl keeps the current cover visible while the same request is still active', () => {
  assert.equal(resolveBufferedCoverUrl({
    currentCoverUrl: 'blob:current-cover',
    previousCoverRequestUrl: 'https://example.test/current-cover',
    nextCoverRequestUrl: 'https://example.test/current-cover'
  }), 'blob:current-cover')
  assert.equal(resolveBufferedCoverUrl({
    currentCoverUrl: null,
    previousCoverRequestUrl: 'https://example.test/current-cover',
    nextCoverRequestUrl: 'https://example.test/current-cover'
  }), null)
})

test('resolveBufferedCoverUrl clears the cover when the request changes or disappears', () => {
  assert.equal(resolveBufferedCoverUrl({
    currentCoverUrl: 'blob:current-cover',
    previousCoverRequestUrl: 'https://example.test/number-plates',
    nextCoverRequestUrl: 'https://example.test/tire-rotation-markers'
  }), null)
  assert.equal(resolveBufferedCoverUrl({
    currentCoverUrl: 'blob:current-cover',
    previousCoverRequestUrl: 'https://example.test/current-cover',
    nextCoverRequestUrl: null
  }), null)
})

test('resolveBufferedSnapshotSrc preserves the current snapshot for the same printer when cache is temporarily empty', () => {
  assert.equal(resolveBufferedSnapshotSrc({
    previousPrinterId: 'printer-1',
    printerId: 'printer-1',
    currentDisplaySrc: 'https://example.test/current-snapshot',
    cachedSnapshotSrc: null
  }), 'https://example.test/current-snapshot')
})

test('resolveBufferedSnapshotSrc clears the old snapshot when the tile switches to a different printer without cached media', () => {
  assert.equal(resolveBufferedSnapshotSrc({
    previousPrinterId: 'printer-1',
    printerId: 'printer-2',
    currentDisplaySrc: 'https://example.test/current-snapshot',
    cachedSnapshotSrc: null
  }), null)
})

test('resolveBufferedSnapshotSrc prefers a newly cached snapshot for the active printer', () => {
  assert.equal(resolveBufferedSnapshotSrc({
    previousPrinterId: 'printer-1',
    printerId: 'printer-1',
    currentDisplaySrc: 'https://example.test/current-snapshot',
    cachedSnapshotSrc: 'https://example.test/cached-snapshot'
  }), 'https://example.test/cached-snapshot')
})