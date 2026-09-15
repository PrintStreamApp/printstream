import assert from 'node:assert/strict'
import test from 'node:test'
import { paintMapsAfterMeshReplacement } from './meshReplacementPaint'

test('mesh replacement drops every old paint channel and seeds only the new body colour', () => {
  const next = paintMapsAfterMeshReplacement({
    supportPaint: { '7:0': { 1: '8' }, '9:0': { 2: '4' } },
    seamPaint: { '7:3': { 4: '8' } },
    colorPaint: { '7:0': { 5: 'C' }, '9:0': { 6: '10' } },
    fuzzyPaint: { '7:1': { 7: '4' } }
  }, 7, { 0: '8' })

  assert.deepEqual(next, {
    supportPaint: { '9:0': { 2: '4' } },
    seamPaint: {},
    colorPaint: { '9:0': { 6: '10' }, '7:0': { 0: '8' } },
    fuzzyPaint: {}
  })
})
