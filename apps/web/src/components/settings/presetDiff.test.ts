/**
 * The preset diff's job is that every row it shows is a REAL difference.
 *
 * The cases below are the ones string equality gets wrong. They are not hypothetical: each is a
 * spelling BambuStudio actually writes depending on where the value landed, which is why
 * `processConfigValuesEqual` takes the catalog option at all.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { processSettingsCatalog } from '@printstream/shared'
import { buildPresetDiff, PRESET_DIFF_UNSET_LABEL } from './presetDiff.js'

const VISIBLE = { showDeveloperOptions: false }

function diff(left: Record<string, string | string[]>, right: Record<string, string | string[]>) {
  return buildPresetDiff(processSettingsCatalog, left, right, VISIBLE)
}

test('identical presets produce no rows', () => {
  const config = { layer_height: '0.2', sparse_infill_density: '15%' }
  assert.deepEqual(diff(config, { ...config }).rows, [])
})

test('a genuinely changed value produces one row with both sides', () => {
  const { rows } = diff({ layer_height: '0.2' }, { layer_height: '0.28' })
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.key, 'layer_height')
  assert.match(rows[0]?.left ?? '', /0\.2/)
  assert.match(rows[0]?.right ?? '', /0\.28/)
})

test('the same number spelled differently is not a difference', () => {
  // A preset JSON writes `"45.0"` where a project config writes `"45%"` for the same percent
  // option. Comparing the strings shows a row for a value nobody changed.
  assert.deepEqual(diff({ sparse_infill_density: '15' }, { sparse_infill_density: '15%' }).rows, [])
  assert.deepEqual(diff({ layer_height: '0.2' }, { layer_height: '0.20' }).rows, [])
})

test('absent equals empty, but absent versus a value is a row', () => {
  // A preset that never mentions a key means the same as an explicit empty one, so that pair is
  // not a difference; a preset that sets it against one that does not certainly is.
  assert.deepEqual(diff({}, { post_process: [] }).rows, [])

  const { rows } = diff({}, { layer_height: '0.3' })
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.left, PRESET_DIFF_UNSET_LABEL, 'the absent side names itself rather than rendering blank')
})

test('rows carry the breadcrumb and the label, not just the key', () => {
  const [row] = diff({ layer_height: '0.2' }, { layer_height: '0.3' }).rows
  assert.ok(row)
  assert.equal(row.label, 'Layer height')
  assert.ok(row.page.length > 0)
  assert.ok(row.group.length > 0)
})

test('rows come out in catalog order rather than sorted by key', () => {
  // A diff sorted by key name scatters related settings across the list; walking the page tree is
  // what makes the result read like the dialog the user already knows.
  const { rows } = diff(
    { sparse_infill_density: '15%', layer_height: '0.2' },
    { sparse_infill_density: '25%', layer_height: '0.3' }
  )
  const keys = rows.map((row) => row.key)
  assert.deepEqual(keys, ['layer_height', 'sparse_infill_density'])
})

test('a differing key with no catalog row is counted, never silently dropped', () => {
  // BambuStudio drops these from its own diff with no indication. Counting them keeps the omission
  // visible so the surface cannot claim two presets match when they do not.
  const { rows, skippedKeyCount } = diff({ printer_settings_id: 'A' }, { printer_settings_id: 'B' })
  assert.deepEqual(rows, [])
  assert.equal(skippedKeyCount, 1)
})

test('a develop-tier difference is counted even though it cannot be shown', () => {
  // The failure this guards is silent and the worst one this surface has: the key was marked seen
  // by the tree walk and then skipped for visibility, so the sweep ignored it too and the dialog
  // rendered "These presets match" over a real difference. Rows and count must not BOTH drop it.
  const developerKey = Object.entries(processSettingsCatalog.options)
    .find(([, option]) => option.mode === 'develop')?.[0]
  assert.ok(developerKey, 'expected the catalog to carry at least one develop-tier option')

  const hidden = diff({ [developerKey]: '1' }, { [developerKey]: '0' })
  assert.deepEqual(hidden.rows, [], 'a hidden option must not render a row')
  assert.equal(hidden.skippedKeyCount, 1, 'but the difference must still be reported')

  const revealed = buildPresetDiff(
    processSettingsCatalog,
    { [developerKey]: '1' },
    { [developerKey]: '0' },
    { showDeveloperOptions: true }
  )
  assert.equal(revealed.rows.length, 1, 'revealing develop-tier options shows it as a row instead')
  assert.equal(revealed.skippedKeyCount, 0, 'and stops counting it as skipped')
})

test('a boolean is shown by its meaning, not as 0 and 1', () => {
  const [row] = diff({ spiral_mode: '0' }, { spiral_mode: '1' }).rows
  assert.ok(row)
  assert.equal(row.left, 'off')
  assert.equal(row.right, 'on')
})
