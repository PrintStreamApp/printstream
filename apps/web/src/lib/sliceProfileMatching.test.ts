import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { LibraryFile, SlicingProfileSummary, ThreeMfFilament, ThreeMfIndex, ThreeMfProjectFilament } from '@printstream/shared'
import { buildFilamentMappings, buildSliceDialogProjectFilaments, isFilamentProfileCompatible, slicingProfilesResponseIsUsable, type SliceMaterialOption } from './sliceProfileMatching'

function materialOption(overrides: Partial<SliceMaterialOption> & { id: string }): SliceMaterialOption {
  return {
    label: 'PETG', group: 'Built-in profiles', materialType: 'PETG', brand: 'Bambu',
    profileId: 'builtin:filament:PETG', material: 'Bambu PETG Basic', color: '#00AE42', colors: [],
    source: 'manual', trayId: null, nozzleId: null, toolheadId: null, metadata: '',
    slotLabel: null, presetLabel: 'Bambu PETG Basic', colorName: null, remainingGrams: null, remainPercent: null,
    ...overrides
  }
}

function machineProfile(name: string): SlicingProfileSummary {
  return { id: `builtin:machine:${name}`, source: 'builtin', kind: 'machine', name, compatiblePrinters: [name] }
}

function filamentProfile(name: string, compatiblePrinters: string[]): SlicingProfileSummary {
  return { id: `builtin:filament:${name}`, source: 'builtin', kind: 'filament', name, filamentType: 'PLA', compatiblePrinters }
}

const A1_MINI_MACHINE = machineProfile('Bambu Lab A1 mini 0.4 nozzle')
const H2D_MACHINE = machineProfile('Bambu Lab H2D 0.4 nozzle')
const FILAMENT_A1 = filamentProfile('Bambu PLA Basic @BBL A1', ['Bambu Lab A1 0.4 nozzle', 'Bambu Lab A1 0.6 nozzle'])
const FILAMENT_A1M = filamentProfile('Bambu PLA Basic @BBL A1M', ['Bambu Lab A1 mini 0.4 nozzle', 'Bambu Lab A1 mini 0.6 nozzle'])
const FILAMENT_H2D = filamentProfile('Bambu PLA Basic @BBL H2D', ['Bambu Lab H2D 0.4 nozzle'])

test('a full-A1 filament is rejected for an A1 mini machine even when the model string says "A1"', () => {
  // Regression: a model/machine mismatch (model "A1" while the machine profile is
  // "A1 mini") used to accept @BBL A1, which BambuStudio then rejects at slice time.
  assert.equal(isFilamentProfileCompatible(FILAMENT_A1, A1_MINI_MACHINE, null, 'A1', [0.4]), false)
  assert.equal(isFilamentProfileCompatible(FILAMENT_A1, A1_MINI_MACHINE, null, 'A1mini', [0.4]), false)
})

test('the matching A1 mini / H2D filament variants stay compatible with their machine', () => {
  assert.equal(isFilamentProfileCompatible(FILAMENT_A1M, A1_MINI_MACHINE, null, 'A1mini', [0.4]), true)
  assert.equal(isFilamentProfileCompatible(FILAMENT_H2D, H2D_MACHINE, null, 'H2D', [0.4]), true)
})

test('a builtin-less slicer-profiles response is rejected as not-yet-loaded', () => {
  // Regression: the slicer can answer while still indexing its bundled `*_full/` presets,
  // returning only the workspace's custom profiles. Caching that strands the editor on a
  // custom-only catalogue (Slice disabled; loaded materials collapse to e.g. "PLA Basic").
  const custom = (name: string): SlicingProfileSummary => ({ id: `custom:filament:${name}`, source: 'custom', kind: 'filament', name })
  assert.equal(slicingProfilesResponseIsUsable(null), false)
  assert.equal(slicingProfilesResponseIsUsable([]), false)
  assert.equal(slicingProfilesResponseIsUsable([custom('Bambu PETG HF - Custom'), custom('Bambu PLA Basic - Custom')]), false)
  // A response that includes at least one builtin preset is complete enough to use.
  assert.equal(slicingProfilesResponseIsUsable([custom('Bambu PETG HF - Custom'), FILAMENT_H2D]), true)
})

test('a full-A1 filament is rejected for an H2D machine', () => {
  assert.equal(isFilamentProfileCompatible(FILAMENT_A1, H2D_MACHINE, null, 'H2D', [0.4]), false)
  assert.equal(isFilamentProfileCompatible(FILAMENT_A1M, H2D_MACHINE, null, 'H2D', [0.4]), false)
})

function projectFilament(id: number, overrides: Partial<ThreeMfProjectFilament> = {}): ThreeMfProjectFilament {
  return {
    id,
    filamentType: 'PLA',
    filamentName: `Filament ${id}`,
    color: '#FFFFFF',
    nozzleId: null,
    chamberTemperature: null,
    ...overrides
  }
}

function plateFilament(id: number): ThreeMfFilament {
  return {
    id,
    filamentType: 'PLA',
    filamentName: `Filament ${id}`,
    color: '#FFFFFF',
    nozzleId: null,
    nozzleDiameter: null,
    chamberTemperature: null,
    usedGrams: null,
    usedMeters: null
  }
}

function plate(index: number, filamentIds: number[]): ThreeMfIndex['plates'][number] {
  return {
    index,
    name: null,
    hasThumbnail: false,
    plateType: null,
    nozzleSizes: [],
    filaments: filamentIds.map(plateFilament),
    objects: [],
    // Mark the plate sliced so its filament list is trusted for per-plate narrowing.
    weight: 10,
    prediction: 100
  }
}

/** A plate with no slice metadata — its filament list is only a geometry estimate. */
function unslicedPlate(index: number, filamentIds: number[]): ThreeMfIndex['plates'][number] {
  return { ...plate(index, filamentIds), weight: null, prediction: null }
}

function bakedIndex(overrides: Partial<ThreeMfIndex> = {}): ThreeMfIndex {
  return {
    plates: [plate(1, [1]), plate(2, [1, 2, 3])],
    projectFilaments: [projectFilament(1), projectFilament(2), projectFilament(3), projectFilament(4)],
    compatiblePrinterModels: [],
    supportFilamentIds: [],
    printerProfileName: null,
    processProfileName: null,
    ...overrides
  }
}

// projectFilamentChips is only read in the no-baked-index fallback path.
const emptyFile = { projectFilamentChips: [] } as unknown as LibraryFile

test('flags only the selected plate\'s materials as used', () => {
  const onPlateOne = buildSliceDialogProjectFilaments(emptyFile, bakedIndex(), 1)
  assert.deepEqual(
    onPlateOne.map((f) => [f.projectFilamentId, f.usedOnSelectedPlate]),
    [[1, true], [2, false], [3, false], [4, false]]
  )

  const onPlateTwo = buildSliceDialogProjectFilaments(emptyFile, bakedIndex(), 2)
  assert.deepEqual(
    onPlateTwo.map((f) => [f.projectFilamentId, f.usedOnSelectedPlate]),
    [[1, true], [2, true], [3, true], [4, false]]
  )
})

test('does not narrow to an UNSLICED plate (its geometry estimate misses colour-painted filaments)', () => {
  // Regression for an unsliced colour-painted project (white base id 1 + painted
  // black id 2): the plate records only the base extruder, so narrowing to it would
  // hide black from the print/slice material list. An unsliced plate must surface
  // the full project palette instead.
  const index = bakedIndex({
    plates: [unslicedPlate(1, [1])],
    projectFilaments: [projectFilament(1), projectFilament(2)]
  })
  const result = buildSliceDialogProjectFilaments(emptyFile, index, 1)
  assert.deepEqual(
    result.map((f) => [f.projectFilamentId, f.usedOnSelectedPlate]),
    [[1, true], [2, true]]
  )
})

test('treats every material as used when the plate has no filament data', () => {
  // Selecting "all plates" (index 0) matches no plate, so nothing is filtered out.
  const result = buildSliceDialogProjectFilaments(emptyFile, bakedIndex(), 0)
  assert.deepEqual(result.map((f) => f.usedOnSelectedPlate), [true, true, true, true])
})

test('labels fall back from name to type to a positional default', () => {
  const index = bakedIndex({
    projectFilaments: [
      projectFilament(1, { filamentName: 'Tangerine Yellow' }),
      projectFilament(2, { filamentName: null, filamentType: 'ABS' }),
      projectFilament(3, { filamentName: null, filamentType: null })
    ],
    plates: [plate(1, [1, 2, 3])]
  })
  const result = buildSliceDialogProjectFilaments(emptyFile, index, 1)
  assert.deepEqual(result.map((f) => f.label), ['Tangerine Yellow', 'ABS', 'Filament 3'])
})

test('falls back to project filament chips when no 3MF index is available', () => {
  const file = {
    projectFilamentChips: [
      { label: 'Red', color: '#FF0000' },
      { label: 'Blue', color: '#0000FF' }
    ]
  } as unknown as LibraryFile
  const result = buildSliceDialogProjectFilaments(file, null, 1)
  assert.deepEqual(
    result.map((f) => [f.projectFilamentId, f.label, f.usedOnSelectedPlate]),
    [[1, 'Red', true], [2, 'Blue', true]]
  )
})

// Loaded-material option identity: the row must be named by the FILAMENT's own
// identity (tracked spool > tray), never by a machine-matched profile's vendor.
test('buildLoadedPrinterMaterialOptions labels a tracked custom spool as itself', async () => {
  const { buildLoadedPrinterMaterialOptions } = await import('./sliceProfileMatching')
  const source = {
    ams: [{
      unitId: 0,
      nozzleId: null,
      type: 0,
      slots: [{
        slot: 1,
        trayName: null,
        filamentType: 'PLA',
        color: '#FFFFFF',
        colors: ['#FFFFFF'],
        remainPercent: null,
        active: false,
        isReading: false,
        occupied: true,
        trayInfoIdx: null,
        caliIdx: null,
        trayUuid: null,
        k: null
      }]
    }],
    externalSpools: [],
    nozzleCount: 1
  } as never
  const options = buildLoadedPrinterMaterialOptions(source, [], null, 'P1S', {
    printerId: 'printer-1',
    resolveSpool: (printerId, amsId, slotId) =>
      printerId === 'printer-1' && amsId === 0 && slotId === 1
        ? { spoolId: 'spool-1', brand: "Michael's", filamentType: 'PLA', materialSubtype: null, colorName: 'White', colorHex: '#FFFFFF', remainingGrams: 420, remainPercent: 42 }
        : null
  })
  assert.equal(options.length, 1)
  assert.equal(options[0]!.label, "Michael's PLA")
  assert.equal(options[0]!.brand, "Michael's")
  assert.equal(options[0]!.colorName, 'White')
  // Tracked remaining flows through so non-RFID spools show a figure.
  assert.equal(options[0]!.remainingGrams, 420)
  assert.equal(options[0]!.remainPercent, 42)
  assert.ok(options[0]!.metadata?.includes('White'))
})

test('buildLoadedPrinterMaterialOptions with no tracked spool labels a custom tray by its own identity', async () => {
  const { buildLoadedPrinterMaterialOptions } = await import('./sliceProfileMatching')
  const source = {
    ams: [{
      unitId: 0,
      nozzleId: null,
      type: 0,
      slots: [{
        slot: 0,
        trayName: null,
        filamentType: 'PLA',
        color: '#FFFFFF',
        colors: ['#FFFFFF'],
        remainPercent: null,
        active: false,
        isReading: false,
        occupied: true,
        trayInfoIdx: null,
        caliIdx: null,
        trayUuid: null,
        k: null
      }]
    }],
    externalSpools: [],
    nozzleCount: 1
  } as never
  const options = buildLoadedPrinterMaterialOptions(source, [], null, 'P1S', {
    printerId: 'printer-1',
    resolveSpool: () => null
  })
  assert.equal(options.length, 1)
  assert.equal(options[0]!.label, 'PLA')
  assert.equal(options[0]!.brand, '')
  assert.ok(options[0]!.metadata?.includes('White'))
})

test('a spool pinned to a slicing preset uses it (matched by display name) over the auto-match', async () => {
  const { buildLoadedPrinterMaterialOptions } = await import('./sliceProfileMatching')
  const profiles: SlicingProfileSummary[] = [
    { id: 'builtin:filament:generic-pla-h2d', source: 'builtin', kind: 'filament', name: 'Generic PLA @BBL H2D', filamentType: 'PLA', compatiblePrinters: ['Bambu Lab H2D 0.4 nozzle'] },
    { id: 'custom:filament:pla-basic-custom', source: 'custom', kind: 'filament', name: 'PLA Basic - Custom', filamentType: 'PLA', compatiblePrinters: ['Bambu Lab H2D 0.4 nozzle'] }
  ]
  const source = {
    ams: [{
      unitId: 0,
      nozzleId: null,
      type: 0,
      slots: [{
        slot: 1,
        trayName: null,
        filamentType: 'PLA',
        color: '#FFFFFF',
        colors: ['#FFFFFF'],
        remainPercent: null,
        active: false,
        isReading: false,
        occupied: true,
        trayInfoIdx: null,
        caliIdx: null,
        trayUuid: null,
        k: null
      }]
    }],
    externalSpools: [],
    nozzleCount: 1
  } as never
  const options = buildLoadedPrinterMaterialOptions(source, profiles, null, 'H2D', {
    printerId: 'printer-1',
    resolveSpool: () => ({
      spoolId: 'spool-1',
      brand: "Michael's",
      filamentType: 'PLA',
      materialSubtype: null,
      colorName: 'White',
      colorHex: '#FFFFFF',
      slicingPresetName: 'PLA Basic - Custom'
    })
  })
  assert.equal(options.length, 1)
  assert.equal(options[0]!.label, "Michael's PLA")
  assert.equal(options[0]!.profileId, 'custom:filament:pla-basic-custom')
  assert.equal(options[0]!.presetLabel, 'PLA Basic - Custom')
})


test('matchPlateTypeByLabel matches a code form against a profile label form (and vice versa)', async () => {
  const { matchPlateTypeByLabel } = await import('./sliceProfileMatching')
  // Options carry the label form; the desired value is the code form (or the reverse).
  assert.equal(matchPlateTypeByLabel(['cool_plate', 'High Temp Plate', 'textured_pei_plate'], 'high_temp_plate'), 'High Temp Plate')
  assert.equal(matchPlateTypeByLabel(['cool_plate', 'high_temp_plate'], 'High Temp Plate'), 'high_temp_plate')
  assert.equal(matchPlateTypeByLabel(['cool_plate', 'textured_pei_plate'], 'high_temp_plate'), null)
  assert.equal(matchPlateTypeByLabel(['cool_plate'], null), null)
})

test('resolvePreferredPlateType keeps the current plate by label and never falls back to Cool Plate', async () => {
  const { resolvePreferredPlateType } = await import('./sliceProfileMatching')
  const options = ['cool_plate', 'engineering_plate', 'High Temp Plate', 'textured_pei_plate', 'supertack_plate']
  // The current selection survives even when its value-form differs from the option's form.
  assert.equal(resolvePreferredPlateType(options, { current: 'high_temp_plate' }), 'High Temp Plate')
  // No current match -> the selected printer's loaded plate wins.
  assert.equal(resolvePreferredPlateType(options, { current: 'pei_smooth', printerPlateType: 'High Temp Plate' }), 'High Temp Plate')
  // Neither matches -> a stable Textured PEI default, NOT rank-0 Cool Plate.
  assert.equal(resolvePreferredPlateType(options, { current: 'nonexistent', printerPlateType: null }), 'textured_pei_plate')
  // Textured PEI absent -> the first option (documented last resort).
  assert.equal(resolvePreferredPlateType(['cool_plate', 'engineering_plate'], { current: 'nope' }), 'cool_plate')
})

test('buildFilamentMappings attaches per-material setting overrides to the matching slot only', () => {
  const projectFilaments = [
    { projectFilamentId: 1, label: 'PETG', color: '#00AE42', nozzleId: null },
    { projectFilamentId: 2, label: 'PLA', color: '#FFFFFF', nozzleId: null }
  ]
  const options = [
    materialOption({ id: 'opt-petg', profileId: 'builtin:filament:PETG' }),
    materialOption({ id: 'opt-pla', profileId: 'builtin:filament:PLA', material: 'Bambu PLA Basic' })
  ]
  const mappings = buildFilamentMappings(
    projectFilaments,
    { 1: 'opt-petg', 2: 'opt-pla' },
    {}, {}, options,
    { 1: { nozzle_temperature: ['255'] } } // only slot 1 has an override
  )
  assert.deepEqual(mappings[0]?.settingOverrides, { nozzle_temperature: ['255'] })
  assert.equal(mappings[1]?.settingOverrides, undefined)
})

test('buildFilamentMappings omits settingOverrides when the map is empty', () => {
  const projectFilaments = [{ projectFilamentId: 1, label: 'PETG', color: '#00AE42', nozzleId: null }]
  const mappings = buildFilamentMappings(projectFilaments, { 1: 'opt-petg' }, {}, {}, [materialOption({ id: 'opt-petg' })], { 1: {} })
  assert.equal(mappings[0]?.settingOverrides, undefined)
})
