import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SlicingProfileSummary } from '@printstream/shared'
import { buildFilamentBrands } from './useFilamentBrands.js'

function profile(overrides: Partial<SlicingProfileSummary>): SlicingProfileSummary {
  return { id: 'id', source: 'builtin', kind: 'filament', name: 'x', ...overrides } as SlicingProfileSummary
}

test('buildFilamentBrands returns unique, sorted vendors from visible filament profiles', () => {
  const brands = buildFilamentBrands([
    profile({ name: 'PolyTerra PLA @BBL X1C', filamentVendor: 'Polymaker' }),
    profile({ name: 'Bambu PLA Basic @BBL X1C', filamentVendor: 'Bambu Lab' }),
    profile({ source: 'custom', name: 'My Tuned PLA @BBL X1C', filamentVendor: 'Bambu Lab' }), // duplicate vendor
    profile({ kind: 'process', name: 'Some process @BBL X1C', filamentVendor: 'Ignored' }), // not a filament profile
    profile({ name: 'fdm_filament_common', filamentVendor: 'Internal' }), // internal BambuStudio resource
    profile({ name: 'No vendor @BBL X1C' }) // no vendor reported -> skipped
  ])

  assert.deepEqual(brands, ['Bambu Lab', 'Polymaker'])
})
