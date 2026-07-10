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
    trayFilamentType: 'ABS',
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
    trayFilamentType: 'ABS',
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
    trayFilamentType: 'ABS',
    selectedMachineProfile,
    selectedPrinterModel: 'H2D'
  })

  assert.equal(resolved.profile?.name, 'Bambu ABS @base')
})

// Regression for the "custom PLA labelled ASA - Custom / Bambu Lab ASA" bug: a
// machine-compatible profile of a DIFFERENT filament family must never match,
// and machine compatibility alone (zero identity signals) must select nothing.
test('pickLoadedMaterialProfile never selects a profile whose filament family conflicts with the tray type', () => {
  const profiles: SlicingProfileSummary[] = [
    {
      id: 'custom:filament:asa-custom',
      source: 'custom',
      kind: 'filament',
      name: 'ASA - Custom',
      filamentType: 'ASA',
      compatiblePrinters: ['Bambu Lab H2D 0.4 nozzle']
    }
  ]

  const profile = pickLoadedMaterialProfile(profiles, {
    trayName: '',
    trayInfoIdx: 'P00-C1',
    trayFilamentType: 'PLA',
    mappedPresetName: null,
    selectedMachineProfile,
    selectedPrinterModel: 'H2D'
  })

  assert.equal(profile, null)
})

test('pickLoadedMaterialProfile requires an identity signal — machine compatibility alone selects nothing', () => {
  const profiles: SlicingProfileSummary[] = [
    {
      id: 'custom:filament:mystery',
      source: 'custom',
      kind: 'filament',
      name: 'Mystery Blend - Custom',
      compatiblePrinters: ['Bambu Lab H2D 0.4 nozzle']
    }
  ]

  const profile = pickLoadedMaterialProfile(profiles, {
    trayName: '',
    trayInfoIdx: '',
    trayFilamentType: 'PLA',
    mappedPresetName: null,
    selectedMachineProfile,
    selectedPrinterModel: 'H2D'
  })

  assert.equal(profile, null)
})

test('pickLoadedMaterialProfile lets a bare typed tray pick a machine-compatible profile of the same family', () => {
  const profiles: SlicingProfileSummary[] = [
    {
      id: 'builtin:filament:generic-pla-h2d',
      source: 'builtin',
      kind: 'filament',
      name: 'Generic PLA @BBL H2D',
      filamentType: 'PLA',
      compatiblePrinters: ['Bambu Lab H2D 0.4 nozzle']
    },
    {
      id: 'custom:filament:asa-custom',
      source: 'custom',
      kind: 'filament',
      name: 'ASA - Custom',
      filamentType: 'ASA',
      compatiblePrinters: ['Bambu Lab H2D 0.4 nozzle']
    }
  ]

  const profile = pickLoadedMaterialProfile(profiles, {
    trayName: '',
    trayInfoIdx: '',
    trayFilamentType: 'PLA',
    mappedPresetName: null,
    selectedMachineProfile,
    selectedPrinterModel: 'H2D'
  })

  assert.equal(profile?.name, 'Generic PLA @BBL H2D')
})