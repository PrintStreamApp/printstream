/**
 * The parameter table's column choice.
 *
 * The sanitizer reads a value that OUTLIVES the code that wrote it -- a stored preference survives
 * releases -- so each of its branches is a claim about data written by a past version. The one that
 * shipped wrong folded "the user cleared every column" into the same branch as "storage held
 * something unreadable", so a deliberate choice was silently replaced by the defaults on reopen.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PER_OBJECT_PROCESS_KEYS, processSettingsCatalog } from '@printstream/shared'
import {
  PARAMETER_TABLE_AVAILABLE_KEYS,
  PARAMETER_TABLE_DEFAULT_KEYS,
  parameterTableColumnLabel,
  sanitizeParameterTableColumns
} from './parameterTableColumns.js'

test('every pickable column is a key an object can actually override', () => {
  // A column outside `PER_OBJECT_PROCESS_KEYS` could only ever repeat the global value on every
  // row, which reads as agreement rather than as a column that cannot work.
  assert.deepEqual([...PARAMETER_TABLE_AVAILABLE_KEYS], [...PER_OBJECT_PROCESS_KEYS])
})

test('every default column is pickable and is in the catalogue', () => {
  for (const key of PARAMETER_TABLE_DEFAULT_KEYS) {
    assert.ok(PARAMETER_TABLE_AVAILABLE_KEYS.includes(key), `${key} is not pickable`)
    assert.ok(processSettingsCatalog.options[key], `${key} is not in the catalogue`)
  }
})

test('an absent or unreadable preference falls back to the defaults', () => {
  for (const stored of [null, undefined, 'not-an-array', 42, {}]) {
    assert.deepEqual(sanitizeParameterTableColumns(stored), [...PARAMETER_TABLE_DEFAULT_KEYS])
  }
})

test('an empty selection is HONOURED, not replaced by the defaults', () => {
  // Clearing every setting column is a real choice: name and plate still identify each object.
  // Folding it into the corruption branch discarded the preference on the next open.
  assert.deepEqual(sanitizeParameterTableColumns([]), [])
})

test('unknown and duplicate keys are dropped', () => {
  // A key can leave `PER_OBJECT_PROCESS_KEYS` between releases; a preference naming it would render
  // a column with no label and no values in any row.
  assert.deepEqual(
    sanitizeParameterTableColumns(['wall_loops', 'not_a_setting', 'wall_loops', 42, null, 'brim_type']),
    ['wall_loops', 'brim_type']
  )
})

test("the stored ORDER is the user's and is preserved", () => {
  // The picker allows any order and the table renders in that order, so re-sorting to the
  // catalogue's order here would silently undo a deliberate arrangement.
  const reversed = [...PARAMETER_TABLE_DEFAULT_KEYS].reverse()
  assert.deepEqual(sanitizeParameterTableColumns(reversed), reversed)
})

test('a column header uses the catalogue label, so it cannot disagree with the settings dialog', () => {
  assert.equal(parameterTableColumnLabel('wall_loops'), processSettingsCatalog.options.wall_loops?.label)
})

test('an unknown key falls back to the raw key rather than an empty header', () => {
  assert.equal(parameterTableColumnLabel('not_a_setting'), 'not_a_setting')
})

test('the fallback defaults are validated against the catalog, like a stored preference is', () => {
  // A default that leaves PER_OBJECT_PROCESS_KEYS would otherwise render a column with no label and
  // no values, and the picker only lists available keys, so there would be no checkbox to remove it.
  // Users with no stored preference would be the only ones unable to fix it.
  const available = new Set(PARAMETER_TABLE_AVAILABLE_KEYS)
  for (const key of sanitizeParameterTableColumns(null)) {
    assert.ok(available.has(key), `default column ${key} is not pickable, so it could never be removed`)
  }
  // And every default IS currently pickable, so today's fallback is the full default set.
  assert.deepEqual(sanitizeParameterTableColumns(null), sanitizeParameterTableColumns(undefined))
  assert.ok(sanitizeParameterTableColumns(null).length > 0)
})
