import assert from 'node:assert/strict'
import test from 'node:test'
import type { SlicingProfileSummary } from '@printstream/shared'
import { resolveFilamentPreset } from './filamentPresetResolver'

const selectedMachineProfile: SlicingProfileSummary = {
  id: 'builtin:machine:h2d-0.4',
  source: 'builtin',
  kind: 'machine',
  name: 'Bambu Lab H2D 0.4 nozzle',
  compatiblePrinters: ['Bambu Lab H2D 0.4 nozzle']
}

const baseQuery = {
  trayName: '',
  trayInfoIdx: null,
  trayFilamentType: null,
  selectedMachineProfile,
  selectedPrinterModel: 'H2D'
}

function filamentPreset(overrides: Partial<SlicingProfileSummary> & { id: string; name: string }): SlicingProfileSummary {
  return { source: 'builtin', kind: 'filament', ...overrides }
}

test('resolves by exact filament id and prefers the printer-specific variant of the same product', () => {
  const profiles = [
    filamentPreset({ id: 'builtin:filament:base-abs', name: 'Bambu ABS @base', filamentIds: ['GFB00'], filamentType: 'ABS' }),
    filamentPreset({
      id: 'builtin:filament:h2d-abs',
      name: 'Bambu ABS @BBL H2D',
      filamentIds: ['GFB00'],
      filamentType: 'ABS',
      compatiblePrinters: ['Bambu Lab H2D 0.4 nozzle']
    })
  ]

  const resolution = resolveFilamentPreset(profiles, { ...baseQuery, trayName: 'ABS Orange', trayInfoIdx: 'GFB00', trayFilamentType: 'ABS' })

  assert.equal(resolution.status, 'resolved')
  assert.equal(resolution.profileId, 'builtin:filament:h2d-abs')
  assert.equal(resolution.matchedBy, 'filamentId')
  assert.equal(resolution.provenance, 'builtin')
})

test('falls back to the generic base preset when no printer-specific variant exists', () => {
  const profiles = [filamentPreset({ id: 'builtin:filament:base-abs', name: 'Bambu ABS @base', filamentIds: ['GFB00'], filamentType: 'ABS' })]

  const resolution = resolveFilamentPreset(profiles, { ...baseQuery, trayName: 'ABS Orange', trayInfoIdx: 'GFB00', trayFilamentType: 'ABS' })

  assert.equal(resolution.status, 'resolved')
  assert.equal(resolution.profileId, 'builtin:filament:base-abs')
})

// Regression for the "custom PLA labelled ASA - Custom" bug: a machine-compatible
// preset of a DIFFERENT filament family must never match.
test('never resolves a preset whose filament family conflicts with the tray type', () => {
  const profiles = [
    filamentPreset({
      id: 'custom:asa-custom',
      source: 'custom',
      name: 'ASA - Custom',
      filamentType: 'ASA',
      compatiblePrinters: ['Bambu Lab H2D 0.4 nozzle']
    })
  ]

  const resolution = resolveFilamentPreset(profiles, { ...baseQuery, trayInfoIdx: 'P00-C1', trayFilamentType: 'PLA' })

  assert.equal(resolution.status, 'unresolved')
  assert.equal(resolution.reason, 'noMatch')
})

test('machine compatibility alone never selects a preset — an unidentified tray stays unresolved', () => {
  const profiles = [
    filamentPreset({
      id: 'custom:mystery',
      source: 'custom',
      name: 'Mystery Blend - Custom',
      compatiblePrinters: ['Bambu Lab H2D 0.4 nozzle']
    })
  ]

  const resolution = resolveFilamentPreset(profiles, { ...baseQuery, trayFilamentType: 'PLA' })

  assert.equal(resolution.status, 'unresolved')
})

test('a bare typed tray resolves to a machine-compatible preset of the same family', () => {
  const profiles = [
    filamentPreset({
      id: 'builtin:filament:generic-pla-h2d',
      name: 'Generic PLA @BBL H2D',
      filamentType: 'PLA',
      compatiblePrinters: ['Bambu Lab H2D 0.4 nozzle']
    }),
    filamentPreset({ id: 'custom:asa-custom', source: 'custom', name: 'ASA - Custom', filamentType: 'ASA' })
  ]

  const resolution = resolveFilamentPreset(profiles, { ...baseQuery, trayFilamentType: 'PLA' })

  assert.equal(resolution.status, 'resolved')
  assert.equal(resolution.profileId, 'builtin:filament:generic-pla-h2d')
  assert.equal(resolution.matchedBy, 'filamentFamily')
})

// Issue #66: support presets are typed by base polymer + `filament_is_support`,
// while the tray reports the derived `PLA-S`. The two must not cross-match.
test('a support tray resolves to the support preset, never to the model preset of the same polymer', () => {
  const profiles = [
    filamentPreset({ id: 'builtin:filament:pla-basic', name: 'Bambu PLA Basic @BBL H2D', filamentType: 'PLA', filamentIsSupport: false }),
    filamentPreset({
      id: 'builtin:filament:support-pla',
      name: 'Bambu Support For PLA @BBL H2D',
      filamentType: 'PLA',
      filamentIsSupport: true,
      filamentIds: ['GFS02']
    })
  ]

  const resolution = resolveFilamentPreset(profiles, { ...baseQuery, trayFilamentType: 'PLA-S' })

  assert.equal(resolution.status, 'resolved')
  assert.equal(resolution.profileId, 'builtin:filament:support-pla')
})

test('a model-filament tray never resolves to a support preset', () => {
  const profiles = [
    filamentPreset({
      id: 'builtin:filament:support-pla',
      name: 'Bambu Support For PLA @BBL H2D',
      filamentType: 'PLA',
      filamentIsSupport: true
    })
  ]

  const resolution = resolveFilamentPreset(profiles, { ...baseQuery, trayFilamentType: 'PLA' })

  assert.equal(resolution.status, 'unresolved')
})

test("a spool's pinned preset wins outright and is reported as such", () => {
  const profiles = [
    filamentPreset({ id: 'builtin:filament:pla-basic', name: 'Bambu PLA Basic @BBL H2D', filamentType: 'PLA', filamentIds: ['GFA00'] }),
    filamentPreset({ id: 'custom:my-pla', source: 'custom', name: 'Ryan PLA', filamentType: 'PLA' })
  ]

  const resolution = resolveFilamentPreset(profiles, {
    ...baseQuery,
    trayInfoIdx: 'GFA00',
    trayFilamentType: 'PLA',
    pinnedPresetName: 'Ryan PLA'
  })

  assert.equal(resolution.status, 'resolved')
  assert.equal(resolution.profileId, 'custom:my-pla')
  assert.equal(resolution.matchedBy, 'pinnedPreset')
  assert.equal(resolution.provenance, 'workspace')
})

test('an empty catalogue reports noCatalogue so callers retry instead of blaming the slot', () => {
  const resolution = resolveFilamentPreset([], { ...baseQuery, trayInfoIdx: 'GFA00', trayFilamentType: 'PLA' })

  assert.equal(resolution.status, 'unresolved')
  assert.equal(resolution.reason, 'noCatalogue')
})

// The profile NAME must not act as a printer-model declaration: a preset merely
// named "@BBL H2D" with no declared targets must not outrank one that declares them.
test('printer-model ranking reads declared targets only, not the preset name', () => {
  const profiles = [
    filamentPreset({ id: 'builtin:filament:named-only', name: 'Generic PLA @BBL H2D', filamentType: 'PLA', filamentIds: ['GFA00'] }),
    filamentPreset({
      id: 'builtin:filament:declared',
      name: 'Generic PLA',
      filamentType: 'PLA',
      filamentIds: ['GFA00'],
      printerModels: ['Bambu Lab H2D']
    })
  ]

  const resolution = resolveFilamentPreset(profiles, { ...baseQuery, trayInfoIdx: 'GFA00', trayFilamentType: 'PLA' })

  assert.equal(resolution.status, 'resolved')
  assert.equal(resolution.profileId, 'builtin:filament:declared')
})

// Substring matching used to conflate these two genuinely different machines.
test('an A1 mini preset does not count as a match for an A1', () => {
  const a1MachineProfile: SlicingProfileSummary = {
    id: 'builtin:machine:a1-0.4',
    source: 'builtin',
    kind: 'machine',
    name: 'Bambu Lab A1 0.4 nozzle'
  }
  const profiles = [
    filamentPreset({ id: 'builtin:filament:mini', name: 'Generic PLA', filamentType: 'PLA', filamentIds: ['GFA00'], printerModels: ['Bambu Lab A1 mini'] }),
    filamentPreset({ id: 'builtin:filament:a1', name: 'Generic PLA', filamentType: 'PLA', filamentIds: ['GFA00'], printerModels: ['Bambu Lab A1'] })
  ]

  const resolution = resolveFilamentPreset(profiles, {
    ...baseQuery,
    trayInfoIdx: 'GFA00',
    trayFilamentType: 'PLA',
    selectedMachineProfile: a1MachineProfile,
    selectedPrinterModel: 'A1'
  })

  assert.equal(resolution.status, 'resolved')
  assert.equal(resolution.profileId, 'builtin:filament:a1')
})

// Deployment ordering: the web app can ship before the slicer whose catalogue carries
// `filamentIsSupport`. An absent flag must stay lenient rather than vetoing everything
// and blocking the slice.
test('a preset carrying no support flag is not vetoed either way', () => {
  const profiles = [filamentPreset({ id: 'builtin:filament:unflagged', name: 'Generic PLA', filamentType: 'PLA' })]

  for (const trayFilamentType of ['PLA', 'PLA-S']) {
    const resolution = resolveFilamentPreset(profiles, { ...baseQuery, trayFilamentType })
    assert.equal(resolution.status, 'resolved', `expected a match for a ${trayFilamentType} tray`)
    assert.equal(resolution.profileId, 'builtin:filament:unflagged')
  }
})
