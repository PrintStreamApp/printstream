import assert from 'node:assert/strict'
import test from 'node:test'
import { applyProcessConfigDefaults, processConfigValuesEqual, processSettingsCatalog, resolvedProcessModifiedKeys } from './process-settings.js'
import { filamentSettingsCatalog } from './filament-settings.js'
import { machineSettingsCatalog } from './machine-settings.js'

/**
 * Guards the GENERATED catalogs against the mistyping class that produced the phantom "changed"
 * speeds (`scripts/dev/lib/bambu-config-parse.mjs`, `mapType`).
 *
 * BambuStudio pluralizes every component of a vector option type, so `coFloatsOrPercents` needs
 * both plurals stripped; removing only the trailing one left `coFloatsOrPercent`, matched no case,
 * and fell through to `string`. A key typed `string` loses BOTH things that matter here: its
 * `default` (so `applyProcessConfigDefaults` cannot fill it, and a preset that omits the key reads
 * as "changed" against a project that sets it: the dialog flagged it, reset landed on the same
 * value, and the marker cleared) and its percent-aware comparator (so "50" and "50%" compare
 * unequal).
 */

/** Declared `coFloatsOrPercents` in PrintConfig.cpp, with BambuStudio's own defaults. */
const VECTOR_FLOAT_OR_PERCENT_DEFAULTS: Record<string, string> = {
  small_perimeter_speed: '50%',
  vertical_shell_speed: '80%',
  sparse_infill_acceleration: '100%'
}

test('vector float-or-percent process options keep their type and BambuStudio default', () => {
  for (const [key, expected] of Object.entries(VECTOR_FLOAT_OR_PERCENT_DEFAULTS)) {
    const option = processSettingsCatalog.options[key]
    assert.ok(option, `${key} is missing from the process catalog`)
    assert.equal(option.type, 'floatOrPercent', `${key} must not be typed as a string`)
    assert.equal(option.default, expected, `${key} lost its default`)
  }
})

test('the filament catalog gets the same treatment (it shares the parser)', () => {
  for (const key of ['filament_scarf_gap', 'filament_scarf_height']) {
    const option = filamentSettingsCatalog.options[key]
    assert.ok(option, `${key} is missing from the filament catalog`)
    assert.equal(option.type, 'floatOrPercent', `${key} must not be typed as a string`)
    assert.notEqual(option.default, undefined, `${key} lost its default`)
  }
})

/**
 * The shape-level guard, which is what would have caught this without knowing the key names: a
 * numeric bound on a `string` option means the generator failed to recognise a numeric type.
 */
test('no catalog option is typed string while carrying numeric bounds', () => {
  for (const [name, catalog] of [['process', processSettingsCatalog], ['filament', filamentSettingsCatalog], ['machine', machineSettingsCatalog]] as const) {
    const mistyped = Object.entries(catalog.options)
      .filter(([, option]) => option.type === 'string' && (option.min !== undefined || option.max !== undefined))
      .map(([key]) => key)
    assert.deepEqual(mistyped, [], `${name} catalog has string-typed options with numeric bounds`)
  }
})

test('a preset that omits a defaulted key is NOT reported as changed', () => {
  // The user-visible symptom: the dialog flagged a speed as changed, resetting it produced the
  // identical value, and the marker cleared. Both sides normalise through the catalog default now,
  // so there is nothing to flag.
  const key = 'small_perimeter_speed'
  const preset = { outer_wall_speed: '60' }
  const project = { outer_wall_speed: '60', [key]: '50%' }

  const baseline = applyProcessConfigDefaults(preset)
  const effective = applyProcessConfigDefaults(project)
  assert.equal(baseline[key], '50%', 'the baseline must inherit the catalog default')
  assert.ok(processConfigValuesEqual(baseline[key], effective[key], processSettingsCatalog.options[key]))
  assert.deepEqual(resolvedProcessModifiedKeys({ config: project, baseConfig: preset }), [])
})

test('percent-awareness is restored: a length is not a percentage', () => {
  const option = processSettingsCatalog.options.small_perimeter_speed
  assert.equal(processConfigValuesEqual('50', '50%', option), false, '50 mm/s is not 50%')
  assert.equal(processConfigValuesEqual('50%', '50.0%', option), true, 'same percentage, different spelling')
})

test('every option a catalog LAYS OUT carries a label', () => {
  // A laid-out option with no label renders as a nameless control: the machine catalog shipped five
  // unnamed number boxes on Motion ability (the limits define only `def->full_label`, which the
  // parser was dropping) and a nameless switch for `spaghetti_detector`, which BambuStudio has
  // commented out of both PrintConfig.cpp and its printer tab. Options the catalog carries but
  // never lays out are exempt, they exist for the conditional engine to read, not to render.
  for (const [name, catalog] of [
    ['process', processSettingsCatalog],
    ['filament', filamentSettingsCatalog],
    ['machine', machineSettingsCatalog]
  ] as const) {
    const laidOut = new Set(catalog.pages.flatMap((page) =>
      page.groups.flatMap((group) => group.lines.flatMap((line) => line.keys))))
    const unnamed = [...laidOut].filter((key) => {
      const option = catalog.options[key]
      return option && !option.label.trim()
    })
    assert.deepEqual(unnamed, [], `${name} catalog lays out options with no label`)
  }
})
