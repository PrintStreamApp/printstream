import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SlicingPresetSummary } from '@printstream/shared'
import {
  DEFAULT_SLICING_PRESET_SORT_DIRECTION,
  DEFAULT_SLICING_PRESET_SORT_VALUE,
  filterSlicingPresets,
  formatSlicingPresetKind,
  setAllFilteredSlicingPresetsSelected,
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

test('sortSlicingPresets sorts by updated date, name, and type', () => {
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