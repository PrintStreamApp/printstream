import assert from 'node:assert/strict'
import test from 'node:test'
import type { SlicingProfileSummary } from '@printstream/shared'
import { pickLoadedMaterialProfile, resolveLoadedMaterialPreset } from './loadedMaterialProfileSelection'

const selectedMachineProfile: SlicingProfileSummary = {
  id: 'machine:h2d-0.4',
  source: 'builtin',
  kind: 'machine',
  name: 'Bambu Lab H2D 0.4 nozzle',
  compatiblePrinters: ['Bambu Lab H2D 0.4 nozzle']
}

test('pickLoadedMaterialProfile prefers the selected printer specific profile over the matching base preset', () => {
  const profiles: SlicingProfileSummary[] = [
    {
      id: 'builtin:filament:base-abs',
      source: 'builtin',
      kind: 'filament',
      name: 'Bambu ABS @base',
      filamentIds: ['GFB00']
    },
    {
      id: 'builtin:filament:h2d-abs',
      source: 'builtin',
      kind: 'filament',
      name: 'Bambu ABS @BBL H2D',
      compatiblePrinters: ['Bambu Lab H2D 0.4 nozzle']
    }
  ]

  const profile = pickLoadedMaterialProfile(profiles, {
    trayName: 'ABS Orange',
    trayInfoIdx: 'GFB99',
    mappedPresetName: 'Bambu ABS @base',
    selectedMachineProfile,
    selectedPrinterModel: 'H2D'
  })

  assert.equal(profile?.name, 'Bambu ABS @BBL H2D')
})

test('pickLoadedMaterialProfile still upgrades an exact filament id base preset to the selected machine specific profile', () => {
  const profiles: SlicingProfileSummary[] = [
    {
      id: 'builtin:filament:base-abs',
      source: 'builtin',
      kind: 'filament',
      name: 'Bambu ABS @base',
      filamentIds: ['GFB00']
    },
    {
      id: 'builtin:filament:h2d-abs',
      source: 'builtin',
      kind: 'filament',
      name: 'Bambu ABS @BBL H2D',
      compatiblePrinters: ['Bambu Lab H2D 0.4 nozzle']
    }
  ]

  const profile = pickLoadedMaterialProfile(profiles, {
    trayName: 'ABS Orange',
    trayInfoIdx: 'GFB00',
    mappedPresetName: 'Bambu ABS @base',
    selectedMachineProfile,
    selectedPrinterModel: 'H2D'
  })

  assert.equal(profile?.name, 'Bambu ABS @BBL H2D')
})

test('resolveLoadedMaterialPreset falls back to the generic base preset when no printer specific match exists', () => {
  const profiles: SlicingProfileSummary[] = [
    {
      id: 'builtin:filament:base-abs',
      source: 'builtin',
      kind: 'filament',
      name: 'Bambu ABS @base',
      filamentIds: ['GFB00']
    }
  ]

  const resolved = resolveLoadedMaterialPreset(profiles, {
    trayName: 'ABS Orange',
    trayInfoIdx: 'GFB00',
    selectedMachineProfile,
    selectedPrinterModel: 'H2D'
  })

  assert.equal(resolved.profile?.name, 'Bambu ABS @base')
})