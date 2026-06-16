import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SlicingProfileSummary } from '@printstream/shared'
import {
  DEFAULT_SLICING_PROFILE_SORT_DIRECTION,
  DEFAULT_SLICING_PROFILE_SORT_VALUE,
  filterSlicingProfiles,
  formatSlicingProfileKind,
  setAllFilteredSlicingProfilesSelected,
  sortSlicingProfiles,
  toggleSlicingProfileSelection
} from './slicingProfileDirectory'

const PROFILES: SlicingProfileSummary[] = [
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
  assert.equal(DEFAULT_SLICING_PROFILE_SORT_VALUE, 'name')
  assert.equal(DEFAULT_SLICING_PROFILE_SORT_DIRECTION, 'asc')
})

test('filterSlicingProfiles matches profile names and kind labels', () => {
  assert.deepEqual(
    filterSlicingProfiles(PROFILES, 'material', 'all').map((profile) => profile.id),
    ['filament-1']
  )
  assert.deepEqual(
    filterSlicingProfiles(PROFILES, 'quality', 'process').map((profile) => profile.id),
    ['process-1']
  )
})

test('sortSlicingProfiles sorts by updated date, name, and type', () => {
  assert.deepEqual(
    sortSlicingProfiles(PROFILES, 'updatedAt', 'desc').map((profile) => profile.id),
    ['machine-1', 'filament-1', 'process-1']
  )
  assert.deepEqual(
    sortSlicingProfiles(PROFILES, 'name', 'asc').map((profile) => profile.id),
    ['machine-1', 'filament-1', 'process-1']
  )
  assert.deepEqual(
    sortSlicingProfiles(PROFILES, 'kind', 'asc').map((profile) => `${profile.id}:${formatSlicingProfileKind(profile.kind)}`),
    ['filament-1:Material', 'machine-1:Printer', 'process-1:Quality']
  )
})

test('selection helpers toggle one profile or all filtered profiles', () => {
  const toggledOnce = toggleSlicingProfileSelection([], 'machine-1')
  assert.deepEqual(toggledOnce, ['machine-1'])
  assert.deepEqual(toggleSlicingProfileSelection(toggledOnce, 'machine-1'), [])

  const filteredProfiles = filterSlicingProfiles(PROFILES, '', 'filament')
  const allSelected = setAllFilteredSlicingProfilesSelected([], filteredProfiles, true)
  assert.deepEqual(allSelected, ['filament-1'])
  assert.deepEqual(setAllFilteredSlicingProfilesSelected(allSelected, filteredProfiles, false), [])
})