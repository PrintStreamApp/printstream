/**
 * Display formatting for a serialized setting value.
 *
 * The percent case is the one that shipped wrong and was caught against a real project: a
 * `percent` value serializes WITH its sign while the option also carries "%" as its sidetext, so
 * appending the unit unconditionally rendered "15% %". Tested against the real catalogue rather
 * than hand-made options, because the bug was in the relationship between two real fields.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { processSettingsCatalog, type ProcessSettingOption } from '@printstream/shared'
import { formatSettingValueForDisplay } from './settingValueDisplay.js'

const option = (key: string): ProcessSettingOption => {
  const found = processSettingsCatalog.options[key]
  assert.ok(found, `catalogue is missing ${key}, which this test is written against`)
  return found
}

test('a percent value is not given a second percent sign', () => {
  const infill = option('sparse_infill_density')
  assert.equal(infill.sidetext?.trim(), '%', 'fixture assumes this option carries % as its unit')
  assert.equal(formatSettingValueForDisplay(infill, '15%'), '15%')
})

test('a bare numeric value still gets its unit', () => {
  // The same option can hold either form depending on where the value came from, so the unit is
  // appended when it is genuinely absent.
  assert.equal(formatSettingValueForDisplay(option('sparse_infill_density'), '15'), '15 %')
  assert.equal(formatSettingValueForDisplay(option('layer_height'), '0.2'), '0.2 mm')
})

test('a value already carrying its unit is left alone', () => {
  assert.equal(formatSettingValueForDisplay(option('layer_height'), '0.2mm'), '0.2mm')
})

test('bools read as words, cased for their context', () => {
  const support = option('enable_support')
  // Lower case reads correctly inside the recommendation prompt's sentence; sentence case is for a
  // standalone cell or chip.
  assert.equal(formatSettingValueForDisplay(support, '1'), 'on')
  assert.equal(formatSettingValueForDisplay(support, '0'), 'off')
  assert.equal(formatSettingValueForDisplay(support, '1', { sentenceCase: true }), 'On')
  assert.equal(formatSettingValueForDisplay(support, '0', { sentenceCase: true }), 'Off')
})

test('an enum shows its catalogue label, and sentence case never re-cases it', () => {
  const brim = option('brim_type')
  const value = brim.enumValues?.[0]
  assert.ok(value, 'fixture assumes brim_type is an enum with values')
  const label = brim.enumLabels?.[0]
  assert.equal(formatSettingValueForDisplay(brim, value), label)
  assert.equal(formatSettingValueForDisplay(brim, value, { sentenceCase: true }), label,
    'an enum label is authored text: re-casing it would say something the catalogue does not')
})

test('an enum value the catalogue does not know is shown verbatim', () => {
  assert.equal(formatSettingValueForDisplay(option('brim_type'), 'not-a-brim'), 'not-a-brim')
})

test('an unknown option is shown verbatim rather than guessed at', () => {
  // The safe direction: a terse raw value beats one formatted against the wrong option, which
  // would name a setting the user never chose.
  assert.equal(formatSettingValueForDisplay(undefined, '1'), '1')
})

test('an empty value renders as nothing, never as a bare unit', () => {
  // A config key that is present but blank is "unset", which the parameter table's own sort
  // predicate already recognises. Appending the sidetext to it produced " mm": a unit with no
  // quantity in front of it, in the table and in the recommendation prompt alike.
  const mm = { key: 'layer_height', label: 'Layer height', type: 'float', sidetext: 'mm' } as unknown as Parameters<typeof formatSettingValueForDisplay>[0]
  assert.equal(formatSettingValueForDisplay(mm, ''), '')
  // Whitespace is NOT empty here, deliberately: `isUnsetCellValue` says the same, and a rule the
  // two disagree on is what makes a cell sort as set and paint as blank.
  assert.equal(formatSettingValueForDisplay(mm, '   '), '    mm')
  // And a real value still gets its unit.
  assert.equal(formatSettingValueForDisplay(mm, '0.2'), '0.2 mm')
})
