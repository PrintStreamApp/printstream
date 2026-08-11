import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applySupportRecommendationChanges,
  querySupportRecommendedCombination
} from './index.js'

test('matches a model type against an interface type', () => {
  const match = querySupportRecommendedCombination({
    interfaceName: null,
    interfaceType: 'PLA',
    modelName: null,
    modelType: 'PETG'
  })
  assert.ok(match)
  assert.equal(match?.matchedModel, 'type')
  assert.equal(match?.changes.support_style, 'tree_hybrid')
})

test('lookups are case-insensitive and whitespace-tolerant', () => {
  const match = querySupportRecommendedCombination({
    interfaceName: '  bambu support for abs ',
    interfaceType: 'ABS-S',
    modelName: null,
    modelType: 'abs'
  })
  assert.ok(match)
  assert.equal(match?.changes.support_type, 'tree(auto)')
})

test('a vendor-stripped interface label still matches its Bambu name entry', () => {
  // Display labels drop the vendor when the picker groups by vendor
  // (formatSlicingPresetDisplayName), so "Support For PLA/PETG" must reach
  // the "Bambu Support For PLA/PETG" entry.
  const match = querySupportRecommendedCombination({
    interfaceName: 'Support For PLA/PETG',
    interfaceType: 'PLA-S',
    modelName: null,
    modelType: 'PETG'
  })
  assert.ok(match)
  assert.equal(match?.changes.enable_support, '1')
})

test('name queries take precedence over type queries, mirroring Studio', () => {
  // An interface whose NAME hits the tree-hybrid entry but whose TYPE (PVA) hits the
  // smaller PLA<-PVA entry must resolve by name first (ConfigManipulation.cpp probes
  // name+name, then type+name, then name+type, then type+type).
  const match = querySupportRecommendedCombination({
    interfaceName: 'Bambu Support For PLA',
    interfaceType: 'PVA',
    modelName: null,
    modelType: 'PLA'
  })
  assert.ok(match)
  assert.equal(match?.changes.support_style, 'tree_hybrid')
  assert.ok(!('support_object_xy_distance' in (match?.changes ?? {})))
})

test('an unknown pairing returns null', () => {
  assert.equal(
    querySupportRecommendedCombination({
      interfaceName: 'Generic PC',
      interfaceType: 'PC',
      modelName: null,
      modelType: 'PETG'
    }),
    null
  )
})

test('a model name match reports matchedModel name', () => {
  const match = querySupportRecommendedCombination({
    interfaceName: null,
    interfaceType: 'ASA',
    modelName: 'Bambu PET-CF @BBL X1E',
    modelType: 'PET-CF'
  })
  assert.ok(match)
  assert.equal(match?.matchedModel, 'name')
})

test('applySupportRecommendationChanges fills every element of a vector value', () => {
  // support_interface_speed is per-extruder (coFloats); Studio's table writes the value
  // uniformly, so a dual-nozzle config must not keep a stale second element.
  const next = applySupportRecommendationChanges(
    { support_interface_speed: ['80', '120'], support_top_z_distance: '0.2' },
    { support_interface_speed: '50', support_top_z_distance: '0' }
  )
  assert.deepEqual(next.support_interface_speed, ['50', '50'])
  assert.equal(next.support_top_z_distance, '0')
})

test('applySupportRecommendationChanges leaves untouched keys alone', () => {
  const config = { support_interface_spacing: '0.5', other_key: 'x' }
  const next = applySupportRecommendationChanges(config, { support_interface_spacing: '0' })
  assert.equal(next.other_key, 'x')
  assert.equal(config.support_interface_spacing, '0.5')
})
