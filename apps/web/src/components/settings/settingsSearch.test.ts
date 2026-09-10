/**
 * The cross-catalog search's ranking and its visibility gate.
 *
 * These run against the REAL generated catalogs rather than a fixture, because the thing worth
 * pinning is that a user's actual query finds the actual setting: a fixture would prove the sort
 * comparator works and nothing about whether "infill density" reaches `sparse_infill_density`.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { searchAllSettings, SETTINGS_CATALOG_KIND_LABELS } from './settingsSearch.js'

const VISIBLE = { showDeveloperOptions: false }

test('a setting is findable by its own key', () => {
  // BambuStudio's searcher cannot do this at all: its opt_key branch is commented out, so the one
  // identifier that appears in every log, preset file and bug report finds nothing there.
  const results = searchAllSettings('sparse_infill_density', VISIBLE)
  assert.equal(results[0]?.key, 'sparse_infill_density')
  assert.equal(results[0]?.kind, 'process')
})

test('an exactly-named setting outranks the descriptions that mention it', () => {
  // The ranking's whole job. "wall loops" appears in several tooltips, and a plain substring
  // search returns them in catalog order, which buries the option actually called Wall loops.
  const results = searchAllSettings('wall loops', VISIBLE)
  assert.equal(results[0]?.key, 'wall_loops')
})

test('every catalog is reachable, not just the process one', () => {
  // Asserted per kind with a key that belongs to it, rather than through one broad word: at the
  // default tier "temperature" genuinely only reaches filament settings (the machine and process
  // matches are develop-tier), so a single shared query proves nothing about coverage.
  const firstKindFor = (query: string) => searchAllSettings(query, { ...VISIBLE, limit: 5 })[0]?.kind
  assert.equal(firstKindFor('sparse_infill_density'), 'process')
  assert.equal(firstKindFor('nozzle_temperature'), 'filament')
  assert.equal(firstKindFor('printable_height'), 'machine')
})

test('every result carries the breadcrumb needed to act on it', () => {
  const [result] = searchAllSettings('layer height', VISIBLE)
  assert.ok(result, 'expected a match for a setting that certainly exists')
  assert.ok(result.page.length > 0, 'a result with no page cannot be found in its dialog')
  assert.ok(result.group.length > 0)
  assert.ok(SETTINGS_CATALOG_KIND_LABELS[result.kind])
})

test('develop-tier options are hidden unless developer options are on', () => {
  // A result the user cannot see in its own dialog would open a dialog that does not contain it.
  const hidden = searchAllSettings('', { showDeveloperOptions: false, limit: 5000 })
  assert.deepEqual(hidden, [], 'a blank query is not a request for the whole index')

  const plain = searchAllSettings('e', { showDeveloperOptions: false, limit: 5000 })
  const withDeveloper = searchAllSettings('e', { showDeveloperOptions: true, limit: 5000 })
  assert.ok(
    withDeveloper.length > plain.length,
    'revealing develop-tier options must widen the searchable set'
  )
})

test('a query matching nothing returns nothing rather than a nearest guess', () => {
  assert.deepEqual(searchAllSettings('zzzzznotasetting', VISIBLE), [])
})
