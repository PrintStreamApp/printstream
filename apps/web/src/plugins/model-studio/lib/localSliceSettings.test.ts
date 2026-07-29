import assert from 'node:assert/strict'
import test from 'node:test'
import type { SlicingPresetSummary } from '@printstream/shared'
import { mergeLocalProfilesIntoCatalogue } from './localSliceSettings'
import type { LocalSlicingPreset } from './localSlicingPresets'

const builtin = (name: string, kind: 'process' | 'filament' = 'process'): SlicingPresetSummary => ({
  id: `builtin:${kind}:${name}`, source: 'builtin', kind, name, updatedAt: '2026-01-01T00:00:00.000Z'
} as SlicingPresetSummary)

const local = (name: string, kind: 'process' | 'filament' = 'process'): LocalSlicingPreset => ({
  id: `local:${kind}:${name}`, kind, name, raw: { name, type: kind }, addedAt: '2026-07-22T00:00:00.000Z'
})

test('a user preset shadows a built-in of the same kind and name', () => {
  // Two entries with one name would make the choice arbitrary; uploading "0.20mm Standard" means
  // theirs. Mirrors how the api merges a workspace's customs over the built-ins.
  const merged = mergeLocalProfilesIntoCatalogue(
    [builtin('0.20mm Standard'), builtin('0.28mm Draft')],
    [local('0.20mm Standard')]
  )
  assert.equal(merged.filter((profile) => profile.name === '0.20mm Standard').length, 1)
  assert.equal(merged.find((profile) => profile.name === '0.20mm Standard')?.source, 'custom')
  assert.ok(merged.some((profile) => profile.name === '0.28mm Draft'), 'unrelated built-ins survive')
})

test('same name but a different KIND is not a shadow', () => {
  // A filament and a process can legitimately share a name; collapsing them would lose one.
  const merged = mergeLocalProfilesIntoCatalogue([builtin('Generic', 'filament')], [local('Generic', 'process')])
  assert.equal(merged.length, 2)
})

test('user presets are marked custom so existing surfaces tell them apart', () => {
  const [only] = mergeLocalProfilesIntoCatalogue([], [local('My PETG', 'filament')])
  assert.equal(only?.source, 'custom')
  assert.equal(only?.kind, 'filament')
})

test('no local presets leaves the catalogue untouched', () => {
  const catalogue = [builtin('0.20mm Standard')]
  assert.equal(mergeLocalProfilesIntoCatalogue(catalogue, []), catalogue)
})
