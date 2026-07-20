import assert from 'node:assert/strict'
import test from 'node:test'
import { booleanValue, extractProfileMetadata, firstNumber, omitEmptyMetadata } from './profile-metadata.js'
import { resolveDisplayFilamentType } from './slicing-preset-identity.js'

// The seam between a BambuStudio preset JSON and the summary the slice UI matches on.
// Every field read here replaces a name-parsing guess somewhere downstream (issue #66).
test('a support filament preset carries its flag, not just its base polymer', () => {
  // Shape taken from BBL/filament/"Bambu Support For PLA @base.json".
  const metadata = extractProfileMetadata({
    type: 'filament',
    name: 'Bambu Support For PLA @base',
    filament_id: 'GFS02',
    filament_type: ['PLA'],
    filament_is_support: ['1'],
    filament_vendor: ['Bambu Lab']
  })

  assert.equal(metadata.filamentType, 'PLA')
  assert.equal(metadata.filamentIsSupport, true)
  assert.equal(metadata.filamentVendor, 'Bambu Lab')
  // Which is what makes the preset visible under the AMS/3MF's `PLA-S` type.
  assert.equal(
    resolveDisplayFilamentType({
      filamentType: metadata.filamentType,
      filamentIds: metadata.filamentIds,
      filamentIsSupport: metadata.filamentIsSupport
    }),
    'PLA-S'
  )
})

test('an explicit filament_is_support of "0" reads as false, not as absent', () => {
  // Absent vs false matters: metadata merges an `inherits` parent with `child ?? parent`,
  // so a child that turns the flag off must override an inherited `true`.
  assert.equal(extractProfileMetadata({ filament_type: ['PLA'], filament_is_support: ['0'] }).filamentIsSupport, false)
  assert.equal(Object.hasOwn(extractProfileMetadata({ filament_type: ['PLA'], filament_is_support: ['0'] }), 'filamentIsSupport'), true)
  assert.equal(Object.hasOwn(extractProfileMetadata({ filament_type: ['PLA'] }), 'filamentIsSupport'), false)
})

test('booleanValue reads BambuStudio ConfigOptionBools in every serialized shape', () => {
  assert.equal(booleanValue(['1']), true)
  assert.equal(booleanValue(['0']), false)
  assert.equal(booleanValue('1'), true)
  assert.equal(booleanValue(true), true)
  assert.equal(booleanValue(1), true)
  assert.equal(booleanValue(0), false)
  assert.equal(booleanValue(undefined), undefined)
  assert.equal(booleanValue(['maybe']), undefined)
})

test('a process preset carries its real layer_height instead of leaving it to the name', () => {
  const metadata = extractProfileMetadata({ type: 'process', name: '0.20mm Standard @BBL X1C', layer_height: '0.2' })
  assert.equal(metadata.layerHeight, 0.2)
  assert.equal(firstNumber(['0.28']), 0.28)
  assert.equal(firstNumber(undefined), undefined)
})

test('omitEmptyMetadata drops absent values but keeps meaningful false and zero', () => {
  assert.deepEqual(
    omitEmptyMetadata({ a: '', b: [], c: undefined, d: false, e: 'x', f: ['y'] }),
    { d: false, e: 'x', f: ['y'] }
  )
})
