import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SlicingPresetSummary } from '@printstream/shared'
import {
  DEFAULT_SLICING_PRESET_SORT_DIRECTION,
  DEFAULT_SLICING_PRESET_SORT_VALUE,
  defaultSlicingPresetSources,
  filterSlicingPresets,
  formatSlicingPresetKind,
  formatSlicingPresetSource,
  setAllFilteredSlicingPresetsSelected,
  slicingPresetSourcesAreDefault,
  sortSlicingPresets,
  toggleSlicingPresetSelection
} from './slicingPresetDirectory'

const PROFILES: SlicingPresetSummary[] = [
  {
    id: 'machine-1',
    source: 'custom',
    kind: 'machine',
    name: 'Alpha Printer',
    updatedAt: '2026-05-27T10:00:00.000Z'
  },
  {
    id: 'filament-1',
    source: 'custom',
    kind: 'filament',
    name: 'Beta Material',
    updatedAt: '2026-05-27T09:00:00.000Z'
  },
  {
    id: 'process-1',
    source: 'custom',
    kind: 'process',
    name: 'Gamma Quality',
    updatedAt: '2026-05-27T08:00:00.000Z'
  }
]

test('slicing profile defaults sort by name ascending', () => {
  assert.equal(DEFAULT_SLICING_PRESET_SORT_VALUE, 'name')
  assert.equal(DEFAULT_SLICING_PRESET_SORT_DIRECTION, 'asc')
})

test('filterSlicingPresets matches profile names and kind labels', () => {
  assert.deepEqual(
    filterSlicingPresets(PROFILES, 'material', []).map((profile) => profile.id),
    ['filament-1']
  )
  assert.deepEqual(
    filterSlicingPresets(PROFILES, 'quality', ['process']).map((profile) => profile.id),
    ['process-1']
  )
})

test('filterSlicingPresets treats multiple selected kinds as OR', () => {
  assert.deepEqual(
    filterSlicingPresets(PROFILES, '', ['process', 'filament']).map((profile) => profile.id).sort(),
    ['filament-1', 'process-1']
  )
})

test('sortSlicingPresets sorts by updated date, name, type, and source', () => {
  assert.deepEqual(
    sortSlicingPresets(PROFILES, 'updatedAt', 'desc').map((profile) => profile.id),
    ['machine-1', 'filament-1', 'process-1']
  )
  assert.deepEqual(
    sortSlicingPresets(PROFILES, 'name', 'asc').map((profile) => profile.id),
    ['machine-1', 'filament-1', 'process-1']
  )
  assert.deepEqual(
    sortSlicingPresets(PROFILES, 'kind', 'asc').map((profile) => `${profile.id}:${formatSlicingPresetKind(profile.kind)}`),
    ['filament-1:Material', 'machine-1:Printer', 'process-1:Process']
  )
  const mixedSources = [{ ...PROFILES[0]!, source: 'builtin' as const }, PROFILES[1]!]
  assert.deepEqual(
    sortSlicingPresets(mixedSources, 'source', 'asc').map((profile) => formatSlicingPresetSource(profile.source)),
    ['Built-in presets', 'User presets']
  )
})

test('selection helpers toggle one profile or all filtered profiles', () => {
  const toggledOnce = toggleSlicingPresetSelection([], 'machine-1')
  assert.deepEqual(toggledOnce, ['machine-1'])
  assert.deepEqual(toggleSlicingPresetSelection(toggledOnce, 'machine-1'), [])

  const filteredProfiles = filterSlicingPresets(PROFILES, '', ['filament'])
  const allSelected = setAllFilteredSlicingPresetsSelected([], filteredProfiles, true)
  assert.deepEqual(allSelected, ['filament-1'])
  assert.deepEqual(setAllFilteredSlicingPresetsSelected(allSelected, filteredProfiles, false), [])
})

/** A built-in preset of the given kind: the shape a stock catalogue arrives as. */
function builtinPreset(id: string, kind: SlicingPresetSummary['kind']): SlicingPresetSummary {
  return { id, source: 'builtin', kind, name: id } as SlicingPresetSummary
}

test('a kind the workspace has customised opens on its own presets', () => {
  const mixed = [builtinPreset('builtin-1', 'process'), builtinPreset('builtin-2', 'process'), PROFILES[2]!]
  assert.deepEqual(defaultSlicingPresetSources(mixed), ['custom'])
})

test('a kind with no custom presets opens on the built-ins too', () => {
  // Otherwise the default hides every row and the empty state offers no way out: the Printer tab of
  // a stock install showed "No presets match" over 200+ built-ins, with Clear filters disabled.
  const builtinsOnly = [builtinPreset('builtin-1', 'machine'), builtinPreset('builtin-2', 'machine')]
  assert.deepEqual(defaultSlicingPresetSources(builtinsOnly).sort(), ['builtin', 'custom'])
})

test('an empty list still resolves a usable default', () => {
  // The list arrives after mount, so this is the state the panel first renders in.
  assert.deepEqual(defaultSlicingPresetSources([]).sort(), ['builtin', 'custom'])
})

test('the filter badge counts a source choice only when it differs from the resolved default', () => {
  // Counted against the RESOLVED default, so the view a tab OPENS as never lights up "Filters (1)",
  // and Clear, which returns to that same default, is never a button that does nothing.
  assert.equal(slicingPresetSourcesAreDefault(['custom'], ['custom']), true)
  assert.equal(slicingPresetSourcesAreDefault(['builtin', 'custom'], ['custom', 'builtin']), true)
  assert.equal(slicingPresetSourcesAreDefault(['builtin'], ['custom', 'builtin']), false)
  assert.equal(slicingPresetSourcesAreDefault(['custom', 'builtin'], ['custom']), false)
  assert.equal(slicingPresetSourcesAreDefault([], ['custom']), false)
})
