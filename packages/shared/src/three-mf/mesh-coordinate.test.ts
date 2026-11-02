import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatMeshCoordinate } from './mesh-coordinate.js'

test('mesh coordinates retain round-trip precision using plain decimals', () => {
  for (const value of [0, -0, 0.1234567890123456, -0.00000123456789, 1.23456789e-20, -1e-40, 1.23456789e30, Number.MIN_VALUE, Number.MAX_VALUE]) {
    const serialized = formatMeshCoordinate(value)
    assert.match(serialized, /^-?\d+(?:\.\d+)?$/)
    assert.equal(Number(serialized), value === 0 ? 0 : value)
  }
})
