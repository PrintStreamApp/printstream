import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ProcessSettingsCatalog } from '@printstream/shared'
import {
  catalogKeyMatchesQuery,
  countModified,
  countShownPerPage,
  isKeyShown,
  pagesWithContent,
  pagesWithModified,
  type CatalogFilterContext
} from './catalogDialogFilter'

/** Two pages, so a per-page assertion can tell them apart. */
const catalog: ProcessSettingsCatalog = {
  pages: [
    {
      id: 'quality',
      title: 'Quality',
      groups: [{ title: 'Layers', lines: [{ keys: ['layer_height'] }, { keys: ['wall_loops'] }] }]
    },
    {
      id: 'speed',
      title: 'Speed',
      groups: [{ title: 'Travel', lines: [{ keys: ['travel_speed'] }, { keys: ['secret_speed'] }] }]
    }
  ],
  options: {
    layer_height: { type: 'float', label: 'Layer height', tooltip: 'How thick each layer is' },
    wall_loops: { type: 'int', label: 'Wall loops' },
    travel_speed: { type: 'float', label: 'Travel speed' },
    // Develop-tier: hidden unless developer mode is on.
    secret_speed: { type: 'float', label: 'Secret speed', mode: 'develop' }
  }
} as unknown as ProcessSettingsCatalog

function context(overrides: Partial<CatalogFilterContext> = {}): CatalogFilterContext {
  return {
    catalog,
    showDeveloperOptions: false,
    normalizedQuery: '',
    showChangedOnly: false,
    isModified: () => false,
    ...overrides
  }
}

test('a develop-tier option is hidden unless developer mode is on', () => {
  assert.equal(isKeyShown('secret_speed', context()), false)
  assert.equal(isKeyShown('secret_speed', context({ showDeveloperOptions: true })), true)
})

test('the conditional engine can hide a key the tier would have shown', () => {
  const hidden = context({ isKeyVisible: (key) => key !== 'wall_loops' })
  assert.equal(isKeyShown('layer_height', hidden), true)
  assert.equal(isKeyShown('wall_loops', hidden), false)
})

test('search matches a label, a key or a tooltip', () => {
  assert.equal(catalogKeyMatchesQuery(catalog, 'layer_height', 'layer height'), true)
  assert.equal(catalogKeyMatchesQuery(catalog, 'layer_height', 'layer_h'), true)
  assert.equal(catalogKeyMatchesQuery(catalog, 'layer_height', 'thick'), true)
  assert.equal(catalogKeyMatchesQuery(catalog, 'layer_height', 'nozzle'), false)
})

test('per-page counts are zero until a filter is engaged', () => {
  assert.deepEqual(countShownPerPage(context()), [0, 0])
})

test('per-page counts honour "Changed only", not just the search box', () => {
  // The drift this extraction settled: the process dialog counted under both filters and the
  // filament dialog counted only the search, so one of them showed a tab count that did not match
  // the rows behind it.
  const changedOnly = context({ showChangedOnly: true, isModified: (key) => key === 'travel_speed' })
  assert.deepEqual(countShownPerPage(changedOnly), [0, 1])
})

test('search and "Changed only" narrow to their intersection', () => {
  const both = context({
    normalizedQuery: 'speed',
    showChangedOnly: true,
    isModified: (key) => key === 'travel_speed' || key === 'layer_height'
  })
  // layer_height is modified but does not match "speed"; travel_speed is both.
  assert.deepEqual(countShownPerPage(both), [0, 1])
})

test('a page with nothing left to show is hidden', () => {
  const searching = context({ normalizedQuery: 'travel' })
  assert.deepEqual(pagesWithContent(searching), [false, true])
})

test('tab emphasis ignores the search box so it does not move while typing', () => {
  const searching = context({ normalizedQuery: 'travel', isModified: (key) => key === 'layer_height' })
  // Quality still carries the change even though the search has emptied that tab.
  assert.deepEqual([...pagesWithModified(searching)], [0])
})

test('a modified but hidden key marks nothing', () => {
  // Without the visibility gate a change on a line whose controlling toggle is off lit its tab and
  // the title's "*" with no changed row to show for it.
  const hidden = context({
    isKeyVisible: () => false,
    isModified: () => true
  })
  assert.deepEqual([...pagesWithModified(hidden)], [])
  assert.equal(countModified(hidden), 0)
})

test('the modified count spans the catalog and respects the developer tier', () => {
  const modified = context({ isModified: (key) => key === 'secret_speed' || key === 'layer_height' })
  assert.equal(countModified(modified), 1)
  assert.equal(countModified({ ...modified, showDeveloperOptions: true }), 2)
})

test('the modified count ignores the active filters', () => {
  // It drives the title's "*" and the Reset all button, which must not change as the user searches.
  const modified = context({ normalizedQuery: 'nothing matches this', isModified: (key) => key === 'layer_height' })
  assert.equal(countModified(modified), 1)
})
