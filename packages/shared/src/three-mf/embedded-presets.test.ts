/**
 * The measured case: a repaired project still carried two sidecars named
 * `Bambu Support For PLA/PETG @BBL H2D(Best Shot Golf.3mf)` that no slot referenced, where
 * BambuStudio's own save of the same project carried none.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyEmbeddedProjectPresets, hasUnusedEmbeddedPresets, isEmbeddedFilamentPresetEntry } from './embedded-presets.js'

const preset = (name: string, inherits?: string) => JSON.stringify({ name, from: 'project', ...(inherits ? { inherits } : {}) })

test('a preset no slot names is reported unused', () => {
  const presets = classifyEmbeddedProjectPresets(
    [
      { entryPath: 'Metadata/filament_settings_1.config', json: preset('Bambu Support For PLA/PETG @BBL H2D(Best Shot Golf.3mf)', 'Bambu Support For PLA/PETG @BBL H2D') },
      { entryPath: 'Metadata/filament_settings_2.config', json: preset('Bambu PETG HF @BBL H2D 0.4 nozzle') }
    ],
    ['Bambu PETG HF @BBL H2D 0.4 nozzle', 'Bambu PLA Basic @BBL H2D']
  )

  assert.equal(presets.length, 2)
  assert.equal(presets[0]?.used, false)
  assert.equal(presets[0]?.inherits, 'Bambu Support For PLA/PETG @BBL H2D')
  assert.equal(presets[1]?.used, true, 'a slot names it, so it must never be offered for removal')
  assert.equal(hasUnusedEmbeddedPresets(presets), true)
})

/** Matching is on the EXACT name, the way BambuStudio binds — not a prefix or a normalised form. */
test('a near-miss name does not count as used', () => {
  const presets = classifyEmbeddedProjectPresets(
    [{ entryPath: 'Metadata/filament_settings_1.config', json: preset('Bambu PETG HF @BBL H2D') }],
    ['Bambu PETG HF @BBL H2D 0.4 nozzle']
  )
  assert.equal(presets[0]?.used, false)
})

/**
 * An unreadable sidecar is still IN the file and still reaches BambuStudio. Reporting only the ones
 * we can parse would hide exactly the broken ones.
 */
test('an unreadable sidecar is still listed', () => {
  const presets = classifyEmbeddedProjectPresets(
    [{ entryPath: 'Metadata/filament_settings_1.config', json: '{ not json' }],
    ['whatever']
  )
  assert.equal(presets.length, 1)
  assert.equal(presets[0]?.name, '')
  assert.equal(presets[0]?.used, false)
})

test('non-preset entries are ignored', () => {
  assert.equal(isEmbeddedFilamentPresetEntry('Metadata/filament_settings_12.config'), true)
  assert.equal(isEmbeddedFilamentPresetEntry('Metadata/project_settings.config'), false)
  assert.equal(isEmbeddedFilamentPresetEntry('Metadata/filament_settings_.config'), false)
  const presets = classifyEmbeddedProjectPresets([{ entryPath: 'Metadata/project_settings.config', json: '{}' }], [])
  assert.deepEqual(presets, [])
})

/** Numeric order, so a 10th preset does not sort between the 1st and the 2nd. */
test('the list is stable and numerically ordered', () => {
  const presets = classifyEmbeddedProjectPresets(
    [
      { entryPath: 'Metadata/filament_settings_10.config', json: preset('J') },
      { entryPath: 'Metadata/filament_settings_2.config', json: preset('B') }
    ],
    []
  )
  assert.deepEqual(presets.map((entry) => entry.name), ['B', 'J'])
})

test('a project with no sidecars reports nothing to remove', () => {
  assert.equal(hasUnusedEmbeddedPresets(classifyEmbeddedProjectPresets([], ['a'])), false)
})
