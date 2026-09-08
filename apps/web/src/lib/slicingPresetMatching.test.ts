import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { LibraryFile, SlicingPresetSummary, ThreeMfFilament, ThreeMfIndex, ThreeMfProjectFilament } from '@printstream/shared'
import { resolveInitialManualPrinterModel, isProcessProfileCompatible, buildFilamentMappings, buildBakedFilamentProfileSelection, buildProcessFilamentChoices, buildProjectSlicingPresets, buildSliceDialogProjectFilaments, plateModelFilamentIds, buildProfileMaterialOptionId, buildRedundantProjectPresetCandidates, buildSliceMaterialOptions, filterSliceMaterialOptions, isFilamentProfileCompatible, repointMaterialOptionToCompatibleAlias, narrowMaterialOptions, resolveProfileMaterialType, slicingPresetsResponseIsUsable, type SliceMaterialOption } from './slicingPresetMatching'
import { formatSlicingPresetBrandedName, formatSlicingPresetDisplayName } from './slicingPresetSelection'

function materialOption(overrides: Partial<SliceMaterialOption> & { id: string }): SliceMaterialOption {
  return {
    label: 'PETG', group: 'Built-in profiles', materialType: 'PETG', brand: 'Bambu',
    profileId: 'builtin:filament:PETG', material: 'Bambu PETG Basic', color: '#00AE42', colors: [],
    source: 'manual', trayId: null, nozzleId: null, toolheadId: null, metadata: '',
    slotLabel: null, presetLabel: 'Bambu PETG Basic', colorName: null, remainingGrams: null, remainPercent: null,
    ...overrides
  }
}

function machineProfile(name: string): SlicingPresetSummary {
  return { id: `builtin:machine:${name}`, source: 'builtin', kind: 'machine', name, compatiblePrinters: [name] }
}

function filamentProfile(name: string, compatiblePrinters: string[]): SlicingPresetSummary {
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
  const custom = (name: string): SlicingPresetSummary => ({ id: `custom:filament:${name}`, source: 'custom', kind: 'filament', name })
  assert.equal(slicingPresetsResponseIsUsable(null), false)
  assert.equal(slicingPresetsResponseIsUsable([]), false)
  assert.equal(slicingPresetsResponseIsUsable([custom('Bambu PETG HF - Custom'), custom('Bambu PLA Basic - Custom')]), false)
  // A response that includes at least one builtin preset is complete enough to use.
  assert.equal(slicingPresetsResponseIsUsable([custom('Bambu PETG HF - Custom'), FILAMENT_H2D]), true)
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

/** A plate with no slice metadata, its filament list is only a geometry estimate. */
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
    processProfileInherits: null,
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

test('counts a support material as used even when the sliced plate never consumed it', () => {
  // Regression: support materials are referenced by process settings
  // (support_filament / support_interface_filament), not by an object's extruder id, so a plate
  // sliced before the assignment lists only filament 1. The material assigned as the support
  // interface then vanished from the print dialog, leaving it unmappable to a tray.
  const withSupport = bakedIndex({ supportFilamentIds: [2] })
  assert.deepEqual(
    buildSliceDialogProjectFilaments(emptyFile, withSupport, 1).map((f) => [f.projectFilamentId, f.usedOnSelectedPlate]),
    [[1, true], [2, true], [3, false], [4, false]]
  )
})

test('a support material does not narrow an unsliced plate to itself', () => {
  // The union must not turn "no trustworthy plate data -> show everything" into
  // "show only the support material".
  const unsliced = bakedIndex({ plates: [unslicedPlate(1, [1])], supportFilamentIds: [2] })
  assert.deepEqual(
    buildSliceDialogProjectFilaments(emptyFile, unsliced, 1).map((f) => f.usedOnSelectedPlate),
    [true, true, true, true]
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
  const { buildLoadedPrinterMaterialOptions } = await import('./slicingPresetMatching')
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
  const { buildLoadedPrinterMaterialOptions } = await import('./slicingPresetMatching')
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
  const { buildLoadedPrinterMaterialOptions } = await import('./slicingPresetMatching')
  const profiles: SlicingPresetSummary[] = [
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
  const { matchPlateTypeByLabel } = await import('./slicingPresetMatching')
  // Options carry the label form; the desired value is the code form (or the reverse).
  assert.equal(matchPlateTypeByLabel(['cool_plate', 'High Temp Plate', 'textured_pei_plate'], 'high_temp_plate'), 'High Temp Plate')
  assert.equal(matchPlateTypeByLabel(['cool_plate', 'high_temp_plate'], 'High Temp Plate'), 'high_temp_plate')
  assert.equal(matchPlateTypeByLabel(['cool_plate', 'textured_pei_plate'], 'high_temp_plate'), null)
  assert.equal(matchPlateTypeByLabel(['cool_plate'], null), null)
})

test('resolvePreferredPlateType keeps the current plate by label and never falls back to Cool Plate', async () => {
  const { resolvePreferredPlateType } = await import('./slicingPresetMatching')
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
  const { mappings, unresolved } = buildFilamentMappings(
    projectFilaments,
    { 1: 'opt-petg', 2: 'opt-pla' },
    {}, {}, options,
    { 1: { nozzle_temperature: ['255'] } } // only slot 1 has an override
  )
  assert.deepEqual(mappings[0]?.settingOverrides, { nozzle_temperature: ['255'] })
  assert.equal(mappings[1]?.settingOverrides, undefined)
  assert.deepEqual(unresolved, [])
})

test('buildFilamentMappings omits settingOverrides when the map is empty', () => {
  const projectFilaments = [{ projectFilamentId: 1, label: 'PETG', color: '#00AE42', nozzleId: null }]
  const { mappings } = buildFilamentMappings(projectFilaments, { 1: 'opt-petg' }, {}, {}, [materialOption({ id: 'opt-petg' })], { 1: {} })
  assert.equal(mappings[0]?.settingOverrides, undefined)
})

// Issue #66: a slot must never vanish from the request. An unselected slot and a
// selection whose option no longer exists are both reported, not dropped.
test('buildFilamentMappings reports unresolved slots instead of silently dropping them', () => {
  const projectFilaments = [
    { projectFilamentId: 1, label: 'PETG', color: '#00AE42', nozzleId: null },
    { projectFilamentId: 2, label: 'PLA', color: '#FFFFFF', nozzleId: null },
    { projectFilamentId: 3, label: 'Support', color: '#101010', nozzleId: null }
  ]
  const { mappings, unresolved } = buildFilamentMappings(
    projectFilaments,
    { 1: 'opt-petg', 3: 'opt-that-no-longer-exists' },
    {}, {}, [materialOption({ id: 'opt-petg' })]
  )

  assert.deepEqual(mappings.map((mapping) => mapping.projectFilamentId), [1])
  assert.deepEqual(unresolved, [
    { projectFilamentId: 2, label: 'PLA', reason: 'unselected' },
    { projectFilamentId: 3, label: 'Support', reason: 'staleSelection' }
  ])
})

// Issue #66: the material picker filters by EXACT type equality, and support presets
// are typed by base polymer (`filament_type: ["PLA"]` + `filament_is_support`) while a
// project filament / AMS tray reports the derived `PLA-S`. Comparing those two
// spellings directly hid every valid support preset from the picker.
const SUPPORT_PLA_PRESET: SlicingPresetSummary = {
  id: 'builtin:filament:support-pla',
  source: 'builtin',
  kind: 'filament',
  name: 'Bambu Support For PLA @BBL H2D',
  filamentType: 'PLA',
  filamentIds: ['GFS02'],
  filamentIsSupport: true,
  filamentVendor: 'Bambu Lab'
}

test('a support preset is typed by its DERIVED display type, so a PLA-S filter finds it', () => {
  assert.equal(resolveProfileMaterialType(SUPPORT_PLA_PRESET), 'PLA-S')

  const options = buildSliceMaterialOptions([SUPPORT_PLA_PRESET], [])
  assert.deepEqual(narrowMaterialOptions(options, 'PLA-S').map((option) => option.materialType), ['PLA-S'])
  // ...and it must not leak into the plain-PLA bucket, where it would slice a model
  // body in support material.
  assert.deepEqual(narrowMaterialOptions(options, 'PLA'), [])
})

test('a model PLA preset stays out of the PLA-S bucket', () => {
  const modelPreset: SlicingPresetSummary = {
    id: 'builtin:filament:pla-basic',
    source: 'builtin',
    kind: 'filament',
    name: 'Bambu PLA Basic @BBL H2D',
    filamentType: 'PLA',
    filamentIsSupport: false
  }
  assert.equal(resolveProfileMaterialType(modelPreset), 'PLA')
  assert.deepEqual(narrowMaterialOptions(buildSliceMaterialOptions([modelPreset], []), 'PLA-S'), [])
})

// A 3MF's own support filament carries `filament_is_support` per slot, so the project
// preset it synthesizes must be typed PLA-S too, otherwise the project's own material
// disappears from its own picker.
test("a project 3MF's support filament synthesizes a preset typed PLA-S", () => {
  const bakedIndex = {
    projectFilaments: [
      { id: 1, filamentName: 'Bambu Support For PLA', filamentType: 'PLA', isSupport: true, color: '#101010', nozzleId: null }
    ],
    plates: []
  } as unknown as ThreeMfIndex

  const [projectPreset] = buildProjectSlicingPresets(bakedIndex, 'filament')
  assert.equal(projectPreset?.filamentIsSupport, true)
  assert.equal(resolveProfileMaterialType(projectPreset as SlicingPresetSummary), 'PLA-S')
})

// The name-only fallback (a preset carrying no filament_type/filament_is_support at all)
// must land in the same bucket rather than inventing a bare `SUPPORT` type.
test('a preset known only by name still derives the support display type', () => {
  assert.equal(resolveProfileMaterialType({
    id: 'project:filament:legacy',
    source: 'custom',
    kind: 'filament',
    name: 'Bambu Support For PLA'
  }), 'PLA-S')
})

/**
 * A project's own process preset is normally the basis for that project and stays selectable. The
 * exception is a real MACHINE change: process values like speed, acceleration, and cooling are
 * machine-tuned, and retargeting rewrites machine-owned keys only, so an A1-authored process left
 * selected on an H2D would slice with A1 values, which is what Ryan hit changing A1 -> H2D.
 */
function projectProcess(name: string): SlicingPresetSummary {
  return { id: `project:process:${encodeURIComponent(name)}`, source: 'custom', kind: 'process', name } as SlicingPresetSummary
}

test('a project process preset stops being compatible once the target model differs', () => {
  const preset = projectProcess('0.20mm Standard @BBL A1')
  assert.equal(isProcessProfileCompatible(preset, null, 'A1', [0.4], 'Textured PEI Plate'), true)
  assert.equal(isProcessProfileCompatible(preset, null, 'H2D', [0.4], 'Textured PEI Plate'), false)
})

test('a project process preset naming no machine stays compatible everywhere', () => {
  // Absence of evidence must not read as a mismatch: a hand-named preset would otherwise be
  // silently dropped from the list the moment any printer was selected.
  const preset = projectProcess('My Custom Process')
  assert.equal(isProcessProfileCompatible(preset, null, 'H2D', [0.4], 'Textured PEI Plate'), true)
  assert.equal(isProcessProfileCompatible(preset, null, 'A1', [0.4], 'Textured PEI Plate'), true)
})

test('a project process preset authored for the selected machine is kept', () => {
  const preset = projectProcess('0.20mm Standard @BBL H2D')
  assert.equal(isProcessProfileCompatible(preset, null, 'H2D', [0.4], 'Textured PEI Plate'), true)
})

test('a RENAMED project process preset is judged by its parent, which is what the engine reads', () => {
  // Prod, 7 Sep 2026. "0.20mm Speed - Tablet Mount" names no machine, so the name rule alone called
  // it compatible with an X2D and it stayed selected after the project was retargeted there. Its
  // parent lists only the P1P, and that is the name BambuStudio resolves the project's process
  // compatibility from, so every slice died on exit 239 with the picker offering no alternative.
  const preset = { ...projectProcess('0.20mm Speed - Tablet Mount'), derivedFromPresetName: '0.20mm Strength @BBL P1P' }
  assert.equal(isProcessProfileCompatible(preset, null, 'P1P', [0.4], 'Textured PEI Plate'), true)
  assert.equal(isProcessProfileCompatible(preset, null, 'X2D', [0.4], 'Textured PEI Plate'), false)
})

test('a resolvable parent is judged by its DECLARATIONS, which is the only way to see the nozzle', () => {
  // The axis a name cannot cover. "0.20mm Strength @BBL P1P" says nothing about a nozzle, but its
  // `compatible_printers` lists only the 0.4 machine, and that list is what the engine reads. Before
  // the catalogue was passed in, a 0.4 -> 0.6 switch on the SAME model passed every name rule and
  // the slice still died on exit 239.
  const parent: SlicingPresetSummary = {
    id: 'builtin:process:strength-p1p', source: 'builtin', kind: 'process',
    name: '0.20mm Strength @BBL P1P', compatiblePrinters: ['Bambu Lab P1P 0.4 nozzle']
  }
  const preset = { ...projectProcess('0.20mm Speed - Tablet Mount'), derivedFromPresetName: parent.name }
  const p1p04 = machineProfile('Bambu Lab P1P 0.4 nozzle')
  const p1p06 = machineProfile('Bambu Lab P1P 0.6 nozzle')

  assert.equal(isProcessProfileCompatible(preset, p1p04, 'P1P', [0.4], '', [parent]), true)
  assert.equal(isProcessProfileCompatible(preset, p1p06, 'P1P', [0.6], '', [parent]), false,
    'same model, different nozzle: only the parent\'s declared list can tell')
})

test('the picker judges a parent by the ENGINE\'s rule, so a save can never quietly overrule it', () => {
  // The picker's ordinary matcher is permissive (alias-expanded, text-based); the SAVE's fallback
  // tests a literal `compatible_printers` containment, which is what the engine does. Judged
  // loosely here, a P1P-lineage preset was offered for a P1P 0.6 machine and then silently replaced
  // at save time, discarding the project's tuned process values with nothing shown to the user.
  const parent: SlicingPresetSummary = {
    id: 'builtin:process:strength-p1p', source: 'builtin', kind: 'process',
    name: '0.20mm Strength @BBL P1P', compatiblePrinters: ['Bambu Lab P1P 0.4 nozzle']
  }
  const preset = { ...projectProcess('0.20mm Speed - Tablet Mount'), derivedFromPresetName: parent.name }

  assert.equal(isProcessProfileCompatible(preset, machineProfile('Bambu Lab P1P 0.4 nozzle'), 'P1P', [0.4], '', [parent]), true)
  assert.equal(isProcessProfileCompatible(preset, machineProfile('Bambu Lab P1P 0.6 nozzle'), 'P1P', [0.6], '', [parent]), false)

  // A parent declaring nothing fits everything, the same carve-out the save makes.
  const silent = { ...parent, id: 'builtin:process:silent', name: 'Silent Base', compatiblePrinters: undefined }
  const fromSilent = { ...projectProcess('Mine'), derivedFromPresetName: silent.name }
  assert.equal(isProcessProfileCompatible(fromSilent, machineProfile('Bambu Lab X2D 0.4 nozzle'), 'X2D', [0.4], '', [silent]), true)
})

test('with no machine preset resolved yet, a parent is never used to refuse', () => {
  // The machine profile settles after the catalogue; refusing on an absent comparison would drop
  // the project's own preset during that window, which is what once fed an incompatible builtin
  // to the CLI.
  const parent: SlicingPresetSummary = {
    id: 'builtin:process:strength-p1p', source: 'builtin', kind: 'process',
    name: '0.20mm Strength @BBL P1P', compatiblePrinters: ['Bambu Lab P1P 0.4 nozzle']
  }
  const preset = { ...projectProcess('My Process'), derivedFromPresetName: parent.name }
  assert.equal(isProcessProfileCompatible(preset, null, 'unknown', [0.4], '', [parent]), true)
})

test('a parent that is not installed falls back to reading its name, rather than refusing', () => {
  // Unknown is not wrong. A parent from the user's own BambuStudio is absent from this catalogue,
  // and dropping the project's own preset for that would be the exact over-refusal the project
  // branch exists to avoid.
  const preset = { ...projectProcess('My Process'), derivedFromPresetName: '0.20mm Strength @BBL P1P' }
  assert.equal(isProcessProfileCompatible(preset, null, 'P1P', [0.4], '', []), true)
  assert.equal(isProcessProfileCompatible(preset, null, 'X2D', [0.4], '', []), false, 'the name still counts')
})

test('a parent naming no machine is not evidence either, so the preset survives', () => {
  // The same absence-of-evidence rule as the leaf name: a preset derived from a user's own base
  // must not be dropped for saying too little.
  const preset = { ...projectProcess('My Custom Process'), derivedFromPresetName: 'My Own Base' }
  assert.equal(isProcessProfileCompatible(preset, null, 'X2D', [0.4], 'Textured PEI Plate'), true)
})

test('the project process preset carries the lineage the index reports', () => {
  // The hop that makes the rule above reachable: without it the summary is name-only and the parent
  // is invisible to every compatibility test.
  const [preset] = buildProjectSlicingPresets(
    bakedIndex({ processProfileName: '0.20mm Speed - Tablet Mount', processProfileInherits: '0.20mm Strength @BBL P1P' }),
    'process'
  )
  assert.equal(preset?.derivedFromPresetName, '0.20mm Strength @BBL P1P')

  // A project stating no lineage records none, rather than repeating its own name as a parent.
  const [plain] = buildProjectSlicingPresets(bakedIndex({ processProfileName: '0.20mm Standard @BBL X2D' }), 'process')
  assert.equal(plain?.derivedFromPresetName, undefined)
})

test('a project process preset is never dropped while the target model is still unresolved', () => {
  // The model is seeded from the file record and is 'unknown' until that (or the machine profile
  // list) resolves. Dropping the project's own preset during that window is what previously fed an
  // incompatible builtin to the CLI: exit 239, then SIGSEGV. No evidence must mean "keep it".
  const preset = projectProcess('0.20mm Standard @BBL A1')
  assert.equal(isProcessProfileCompatible(preset, null, 'unknown', [0.4], 'Textured PEI Plate'), true)
  assert.equal(isProcessProfileCompatible(preset, null, '', [0.4], 'Textured PEI Plate'), true)
})

/**
 * The initial target model must never be a plausible-looking guess. A wrong-but-specific model
 * during load rendered the wrong bed on fresh uploads and let a project's own presets be filtered
 * out against a machine the user never chose (exit 239, then SIGSEGV). "Not known" is a state.
 */
test('the initial target model is the project\'s own, or unknown', () => {
  const withModel = { compatiblePrinterModels: ['H2D'] } as unknown as LibraryFile
  assert.equal(resolveInitialManualPrinterModel(withModel), 'H2D')
})

test('a project that names no model resolves to unknown, not to the first available machine', () => {
  const withoutModel = { compatiblePrinterModels: [] } as unknown as LibraryFile
  assert.equal(resolveInitialManualPrinterModel(withoutModel), 'unknown')
})

// Token-boundary model matching: a plain substring compare let "a1" match "a10", leaking one
// vendor's profiles (a Geeetech A10 machine) into a Bambu A1 selection. A digit run must never
// split; letter<->digit class changes still bound tokens so the deliberate family permissiveness
// ("a1" inside "a1 mini"/"a1mini") survives.
test('matchesPrinterModel does not match across a digit run (A1 vs A10)', async () => {
  const { matchesPrinterModel } = await import('./slicingPresetMatching')
  const a10Profile = {
    id: 'custom:machine:Geeetech A10', source: 'custom', kind: 'machine',
    name: 'Geeetech A10 0.4 nozzle', printerModels: ['Geeetech A10']
  } as never
  assert.equal(matchesPrinterModel(a10Profile, 'A1'), false, 'an A1 selection must not adopt A10 profiles')
  assert.equal(matchesPrinterModel(a10Profile, 'Geeetech A10'), true, 'the A10 machine itself still matches')
})

test('matchesPrinterModel keeps the legitimate family and alias matches', async () => {
  const { matchesPrinterModel } = await import('./slicingPresetMatching')
  const a1Profile = {
    id: 'builtin:machine:Bambu Lab A1 0.4 nozzle', source: 'builtin', kind: 'machine',
    name: 'Bambu Lab A1 0.4 nozzle', printerModels: ['A1']
  } as never
  assert.equal(matchesPrinterModel(a1Profile, 'A1'), true)
  const x1cProfile = {
    id: 'builtin:machine:Bambu Lab X1 Carbon 0.4 nozzle', source: 'builtin', kind: 'machine',
    name: 'Bambu Lab X1 Carbon 0.4 nozzle', printerModels: ['X1 Carbon']
  } as never
  assert.equal(matchesPrinterModel(x1cProfile, 'X1C'), true, 'X1C matches X1 Carbon through the alias table')
})

test('tokenBoundaryIncludes bounds tokens at edges, punctuation, and class changes only', async () => {
  const { tokenBoundaryIncludes } = await import('./slicingPresetMatching')
  assert.equal(tokenBoundaryIncludes('a10 m pro', 'a1'), false, 'digit run must not split')
  assert.equal(tokenBoundaryIncludes('a1 mini', 'a1'), true)
  assert.equal(tokenBoundaryIncludes('a1mini', 'a1'), true, 'compact form: letter after digit is a boundary')
  assert.equal(tokenBoundaryIncludes('ba1', 'a1'), false, 'letter before letter is not a boundary')
  assert.equal(tokenBoundaryIncludes('a1', 'a1'), true)
})

// The catalogue filter's `printer_model` axis had no model-key guard, so an A1-mini preset was
// offered for an A1: `extractProfilePrinterTargets` alias-EXPANDS "Bambu Lab A1 mini" into A1's own
// family, and the text matcher then finds "a1" inside it at a legitimate token boundary. The
// `compatible_printers` axis always had that guard; this pins the same rule on the other one.
test('a preset declaring only the A1 mini is not offered for an A1', () => {
  const a1Machine: SlicingPresetSummary = {
    id: 'builtin:machine:a1-0.4', source: 'builtin', kind: 'machine', name: 'Bambu Lab A1 0.4 nozzle'
  }
  const miniOnly: SlicingPresetSummary = {
    id: 'builtin:filament:mini', source: 'builtin', kind: 'filament',
    name: 'Generic PLA', filamentType: 'PLA', printerModels: ['Bambu Lab A1 mini']
  }
  const a1: SlicingPresetSummary = {
    id: 'builtin:filament:a1', source: 'builtin', kind: 'filament',
    name: 'Generic PLA', filamentType: 'PLA', printerModels: ['Bambu Lab A1']
  }

  assert.equal(isFilamentProfileCompatible(miniOnly, a1Machine, null, 'A1', []), false)
  assert.equal(isFilamentProfileCompatible(a1, a1Machine, null, 'A1', []), true)
})

// Switching printer model silently reverted a material the user had chosen: the pick's preset was
// built for the old machine, so it left the compatible catalogue, the reconcile dropped it, and the
// slot re-seeded from the FILE: "Bambu PLA Basic" chosen on a P1P became the project's original
// "Generic PLA" on an A1. BambuStudio hands over to the same ALIAS instead
// (PreferedFilamentsProfileMatch scores a matching alias at INT_MAX).
test('a material pick hands over to the same product built for the new machine', () => {
  const p1p: SlicingPresetSummary = {
    id: 'builtin:filament:pla-basic-p1p', source: 'builtin', kind: 'filament',
    name: 'Bambu PLA Basic @BBL P1P', filamentType: 'PLA', filamentVendor: 'Bambu Lab',
    compatiblePrinters: ['Bambu Lab P1P 0.6 nozzle']
  }
  const a1: SlicingPresetSummary = {
    id: 'builtin:filament:pla-basic-a1', source: 'builtin', kind: 'filament',
    name: 'Bambu PLA Basic @BBL A1', filamentType: 'PLA', filamentVendor: 'Bambu Lab',
    compatiblePrinters: ['Bambu Lab A1 0.4 nozzle', 'Bambu Lab A1 0.6 nozzle']
  }
  // The A1-compatible catalogue: the P1P preset is gone, its A1 sibling is present.
  const options = buildSliceMaterialOptions([a1], [])

  const repointed = repointMaterialOptionToCompatibleAlias(
    buildProfileMaterialOptionId(p1p.id), [p1p, a1], options
  )
  assert.equal(repointed, buildProfileMaterialOptionId(a1.id))

  // No sibling for this machine -> null, so the caller falls back to the file's default rather than
  // inventing a different product.
  const unrelated: SlicingPresetSummary = { ...a1, id: 'builtin:filament:petg-a1', name: 'Bambu PETG HF @BBL A1', filamentType: 'PETG' }
  assert.equal(
    repointMaterialOptionToCompatibleAlias(buildProfileMaterialOptionId(p1p.id), [p1p, unrelated], buildSliceMaterialOptions([unrelated], [])),
    null
  )
})

// The handover has to survive the two ways the SAME preset reaches this function with different
// metadata: an installed profile declares `filament_vendor`, a project preset minted from a 3MF
// declares none. Both display formatters consult that field and so brand the two sides differently
// -- in OPPOSITE directions, which is why one vendor alone could never have caught it. BambuStudio's
// alias consults no vendor at all: `Preset.cpp` truncates the preset name at the first `@` and trims
// (`set_custom_preset_alias`), so it is symmetric by construction.
test('a material pick hands over whichever way the preset names its vendor', () => {
  // Polymaker: the brand is NOT the first word, so the branded form prefixes it on the installed
  // side ("Polymaker PolyLite PLA") and cannot on the project side ("PolyLite PLA").
  const projectPoly: SlicingPresetSummary = {
    id: 'project:filament:PolyLite%20PLA%20%40BBL%20H2D', source: 'custom', kind: 'filament',
    name: 'PolyLite PLA @BBL H2D', filamentType: 'PLA'
  }
  const installedPolyA1: SlicingPresetSummary = {
    id: 'builtin:filament:polylite-pla-a1', source: 'builtin', kind: 'filament',
    name: 'PolyLite PLA @BBL A1', filamentType: 'PLA', filamentVendor: 'Polymaker',
    compatiblePrinters: ['Bambu Lab A1 0.4 nozzle']
  }
  assert.equal(
    repointMaterialOptionToCompatibleAlias(
      buildProfileMaterialOptionId(projectPoly.id),
      [projectPoly, installedPolyA1],
      buildSliceMaterialOptions([installedPolyA1], [])
    ),
    buildProfileMaterialOptionId(installedPolyA1.id)
  )

  // Bambu: the brand IS the first word, so the display form STRIPS it on the installed side
  // ("PLA Basic") and cannot on the project side ("Bambu PLA Basic"). Swapping one formatter for
  // the other would fix the case above and break this one.
  const projectBambu: SlicingPresetSummary = {
    id: 'project:filament:Bambu%20PLA%20Basic%20%40BBL%20P1P', source: 'custom', kind: 'filament',
    name: 'Bambu PLA Basic @BBL P1P', filamentType: 'PLA'
  }
  const installedBambuA1: SlicingPresetSummary = {
    id: 'builtin:filament:pla-basic-a1', source: 'builtin', kind: 'filament',
    name: 'Bambu PLA Basic @BBL A1', filamentType: 'PLA', filamentVendor: 'Bambu Lab',
    compatiblePrinters: ['Bambu Lab A1 0.4 nozzle']
  }
  assert.equal(
    repointMaterialOptionToCompatibleAlias(
      buildProfileMaterialOptionId(projectBambu.id),
      [projectBambu, installedBambuA1],
      buildSliceMaterialOptions([installedBambuA1], [])
    ),
    buildProfileMaterialOptionId(installedBambuA1.id)
  )
})

test('the material picker searches brand and literal preset name, not just the displayed alias', () => {
  const builtin: SlicingPresetSummary = {
    id: 'builtin:filament:pla-basic-a1', source: 'builtin', kind: 'filament',
    name: 'Bambu PLA Basic @BBL A1', filamentType: 'PLA', filamentVendor: 'Bambu Lab',
    compatiblePrinters: ['Bambu Lab A1 0.4 nozzle']
  }
  const petg: SlicingPresetSummary = { ...builtin, id: 'builtin:filament:petg-a1', name: 'Bambu PETG HF @BBL A1', filamentType: 'PETG' }
  const options = buildSliceMaterialOptions([builtin, petg], [])
  const displayed = options.find((option) => option.id === buildProfileMaterialOptionId(builtin.id))!

  // The label is the ALIAS ("PLA Basic") with the vendor stripped, so a brand query used to match
  // nothing among built-ins, which is what a separate Brand dropdown existed to work around.
  assert.equal(displayed.label, 'PLA Basic')
  assert.equal(filterSliceMaterialOptions(options, 'bambu', '').length, 2)
  // Terms are ANDed, so more words narrow.
  assert.deepEqual(filterSliceMaterialOptions(options, 'bambu pla basic', '').map((o) => o.id), [displayed.id])
  // The literal name is searchable, which is how you find one machine's variant.
  assert.equal(filterSliceMaterialOptions(options, '@BBL A1', '').length, 2)
  assert.equal(filterSliceMaterialOptions(options, 'nonsense', '').length, 0)
})

// Opening a FILLED field must offer everything, not just the option already chosen. MUI blanks the
// query for its own filter only while the input matches `getOptionLabel`; this picker shows the
// BRANDED alias while getOptionLabel returns the plain one, so that never fires and the rule lives
// in our filter instead.
test('a query equal to the current selection lists every option, not just that one', () => {
  const a: SlicingPresetSummary = {
    id: 'builtin:filament:pla-basic', source: 'builtin', kind: 'filament',
    name: 'Bambu PLA Basic @BBL A1', filamentType: 'PLA', filamentVendor: 'Bambu Lab'
  }
  const b: SlicingPresetSummary = { ...a, id: 'builtin:filament:pla-matte', name: 'Bambu PLA Matte @BBL A1' }
  const options = buildSliceMaterialOptions([a, b], [])

  assert.equal(filterSliceMaterialOptions(options, 'Bambu PLA Basic', 'Bambu PLA Basic').length, 2)
  // Typing something else still filters normally.
  assert.equal(filterSliceMaterialOptions(options, 'Bambu PLA Matte', 'Bambu PLA Basic').length, 1)
})

// Only a project preset with an installed twin is worth comparing, and the twin is found by ALIAS,
// since the 3MF names "Bambu PETG HF" while the catalogue carries "Bambu PETG HF @BBL H2D 0.4
// nozzle". Matching raw names made every project preset a non-candidate, so none was ever checked.
test('redundant-project-preset candidates match the installed twin by alias', () => {
  const installed: SlicingPresetSummary = {
    id: 'builtin:filament:petg-hf-h2d', source: 'builtin', kind: 'filament',
    name: 'Bambu PETG HF @BBL H2D 0.4 nozzle', filamentType: 'PETG', filamentVendor: 'Bambu Lab'
  }
  const index = { projectFilaments: [{ id: 1, filamentName: 'Bambu PETG HF', filamentType: 'PETG', color: null, nozzleId: null, chamberTemperature: null }] } as unknown as ThreeMfIndex
  const projectProfiles = buildProjectSlicingPresets(index, 'filament')

  assert.deepEqual(
    buildRedundantProjectPresetCandidates(projectProfiles, [installed], index),
    [{ filamentProfileId: projectProfiles[0]!.id, projectFilamentId: 1 }]
  )
  // No installed twin -> not a candidate, because there is nothing to fall back to.
  assert.deepEqual(buildRedundantProjectPresetCandidates(projectProfiles, [], index), [])
})

// The same, with the shape a real 3MF actually produces: the slot carries the raw
// `filament_settings_id` alongside the display name. The previous fixture omitted
// it, so this path was never exercised against a suffixed preset -- which is how a
// change to what project presets are NAMED could silently stop the redundancy
// check finding any twin at all.
test('redundant-project-preset candidates still match when the slot carries its raw preset name', () => {
  const installed: SlicingPresetSummary = {
    id: 'builtin:filament:petg-hf-h2d', source: 'builtin', kind: 'filament',
    name: 'Bambu PETG HF @BBL H2D 0.4 nozzle', filamentType: 'PETG', filamentVendor: 'Bambu Lab'
  }
  const index = {
    projectFilaments: [{
      id: 1,
      filamentName: 'Bambu PETG HF',
      filamentPresetName: 'Bambu PETG HF @BBL H2D 0.4 nozzle',
      filamentType: 'PETG',
      color: null,
      nozzleId: null,
      chamberTemperature: null
    }]
  } as unknown as ThreeMfIndex
  const projectProfiles = buildProjectSlicingPresets(index, 'filament')

  assert.deepEqual(
    buildRedundantProjectPresetCandidates(projectProfiles, [installed], index),
    [{ filamentProfileId: projectProfiles[0]!.id, projectFilamentId: 1 }]
  )
})

// A THIRD-PARTY preset whose vendor is not the first word of its name. The alias is a display
// form: it prefixes the vendor, which an installed preset knows from `filament_vendor` and a
// project preset (minted from the 3MF, which records no vendor) cannot. So the two sides brand
// the SAME preset differently -- installed "Polymaker PolyLite PLA" against project "PolyLite
// PLA" -- and the twin was never found. Bambu hid it: "Bambu PLA Basic" already starts with its
// brand, so both sides agree and every fixture here happened to be Bambu.
//
// The consequence was not cosmetic. Never nominated means never checked, so the project preset
// stayed in the catalogue, shadowed its installed twin under the same label, and carried the
// `profileId: null` every project preset carries -- which is what the filament-physics repair
// resolves through. A Polymaker slot could therefore not be repaired at all: the defect blocked
// its own fix. Match the RAW name too, which is what BambuStudio binds on
// (`find_preset_internal(original_name)`, an exact lookup with no branding applied).
test('redundant-project-preset candidates match a twin whose vendor is not its name prefix', () => {
  const installed: SlicingPresetSummary = {
    id: 'builtin:filament:polylite-pla-h2d', source: 'builtin', kind: 'filament',
    name: 'PolyLite PLA @BBL H2D', filamentType: 'PLA', filamentVendor: 'Polymaker'
  }
  const index = {
    projectFilaments: [{
      id: 1,
      filamentName: 'PolyLite PLA',
      filamentPresetName: 'PolyLite PLA @BBL H2D',
      filamentType: 'PLA',
      color: null,
      nozzleId: null,
      chamberTemperature: null
    }]
  } as unknown as ThreeMfIndex
  const projectProfiles = buildProjectSlicingPresets(index, 'filament')

  assert.deepEqual(
    buildRedundantProjectPresetCandidates(projectProfiles, [installed], index),
    [{ filamentProfileId: projectProfiles[0]!.id, projectFilamentId: 1 }]
  )
  // Still nothing to fall back to when the catalogue does not carry that preset at all.
  assert.deepEqual(buildRedundantProjectPresetCandidates(projectProfiles, [], index), [])
})

// Closing the asymmetry at SOURCE rather than at each comparison: the 3MF records `filament_vendor`
// per slot, so a minted project preset now declares the same vendor its installed twin does and the
// two brand identically. Asserted on the FORMATTER, because that is the thing that consulted the
// missing field; every comparison built on it inherits the fix, and a future one cannot reintroduce
// the split by reaching for the branded name again.
test('a project preset brands identically to its installed twin, both vendors', () => {
  const index = {
    projectFilaments: [
      { id: 1, filamentName: 'PolyLite PLA', filamentPresetName: 'PolyLite PLA @BBL H2D', filamentVendor: 'Polymaker', filamentType: 'PLA', color: null, nozzleId: null, chamberTemperature: null },
      { id: 2, filamentName: 'Bambu PLA Basic', filamentPresetName: 'Bambu PLA Basic @BBL H2D', filamentVendor: 'Bambu Lab', filamentType: 'PLA', color: null, nozzleId: null, chamberTemperature: null }
    ]
  } as unknown as ThreeMfIndex
  const [projectPoly, projectBambu] = buildProjectSlicingPresets(index, 'filament')
  const installedPoly: SlicingPresetSummary = {
    id: 'builtin:filament:polylite-pla-h2d', source: 'builtin', kind: 'filament',
    name: 'PolyLite PLA @BBL H2D', filamentType: 'PLA', filamentVendor: 'Polymaker'
  }
  const installedBambu: SlicingPresetSummary = {
    id: 'builtin:filament:pla-basic-h2d', source: 'builtin', kind: 'filament',
    name: 'Bambu PLA Basic @BBL H2D', filamentType: 'PLA', filamentVendor: 'Bambu Lab'
  }

  assert.equal(formatSlicingPresetBrandedName(projectPoly!), formatSlicingPresetBrandedName(installedPoly))
  assert.equal(formatSlicingPresetBrandedName(projectBambu!), formatSlicingPresetBrandedName(installedBambu))
  // And the display form too, which strips rather than prepends: it was wrong the other way round.
  assert.equal(formatSlicingPresetDisplayName(projectPoly!), formatSlicingPresetDisplayName(installedPoly))
  assert.equal(formatSlicingPresetDisplayName(projectBambu!), formatSlicingPresetDisplayName(installedBambu))
})

// Two slots whose presets differ only past the `@` are TWO presets. Minting them
// from the display name collapsed them into one, so one slot's authored settings
// were served from the other's preset.
test('two slots sharing an alias but not a preset stay distinct', () => {
  const index = {
    projectFilaments: [
      { id: 1, filamentName: 'Bambu PLA Basic', filamentPresetName: 'Bambu PLA Basic @BBL H2D', filamentType: 'PLA', color: null, nozzleId: null },
      { id: 2, filamentName: 'Bambu PLA Basic', filamentPresetName: 'Bambu PLA Basic @BBL H2D - 55 degree plate', filamentType: 'PLA', color: null, nozzleId: null }
    ]
  } as unknown as ThreeMfIndex

  const presets = buildProjectSlicingPresets(index, 'filament')
  assert.equal(presets.length, 2, 'each distinct filament_settings_id is its own preset')
  assert.equal(new Set(presets.map((preset) => preset.id)).size, 2)
})

/**
 * A slot naming a preset the user does NOT have must still bind to the PROJECT's
 * own preset, which carries the settings the file was authored with. Regression:
 * project presets were minted from `filamentName` (a DISPLAY name, `@BBL...`
 * stripped) while the resolver looks them up by `filamentPresetName` (the raw
 * `filament_settings_id`). The two never matched for any suffixed preset, so the
 * project preset lost every time and an uninstalled one fell all the way through
 * to the machine default -- a stock preset, silently, with the project's own
 * settings neither shown nor applied.
 */
test("a slot whose preset is not installed binds to the project's own preset, not a stock one", () => {
  const bakedIndex = {
    projectFilaments: [
      {
        id: 1,
        filamentName: 'Bambu PLA Basic',
        filamentPresetName: 'Bambu PLA Basic @BBL H2D - 55 degree plate',
        filamentType: 'PLA',
        isSupport: false,
        color: '#101010',
        nozzleId: null
      }
    ],
    plates: []
  } as unknown as ThreeMfIndex

  // The catalogue has the stock parent but NOT the user's derived preset.
  const installed: SlicingPresetSummary[] = [{
    id: 'builtin:filament:bambu-pla-basic',
    source: 'builtin',
    kind: 'filament',
    name: 'Bambu PLA Basic @BBL H2D',
    filamentType: 'PLA',
    updatedAt: null
  }]

  const projectPresets = buildProjectSlicingPresets(bakedIndex, 'filament')
  const selection = buildBakedFilamentProfileSelection(bakedIndex, [...projectPresets, ...installed])

  assert.equal(
    selection[1],
    projectPresets[0]?.id,
    'the slot must bind to the project preset carrying its authored settings'
  )
})

// --- plateModelFilamentIds (the support-recommendation model-material set) ---

/** Shape of Ryan's real repro file: unsliced plates, PLA slot referenced as the interface. */
function unslicedPetgPlaIndex(): ThreeMfIndex {
  const filament = (id: number, filamentType: string, isSupport = false): Partial<ThreeMfProjectFilament> =>
    ({ id, filamentType, filamentName: filamentType, isSupport })
  const plate = (index: number, ids: number[]): Record<string, unknown> =>
    ({ index, weight: null, prediction: null, filaments: ids.map((id) => ({ id, usedGrams: null })) })
  return {
    projectFilaments: [filament(1, 'PETG'), filament(2, 'PETG'), filament(3, 'PLA')],
    supportFilamentIds: [3],
    plates: [plate(1, [1]), plate(2, [1, 2]), plate(3, [1, 2, 3])]
  } as unknown as ThreeMfIndex
}

test('plateModelFilamentIds excludes the support-referenced slot on an UNSLICED plate', () => {
  // The unsliced estimate attributes the interface slot to opted-in objects (plate 3 lists it),
  // and `usedOnSelectedPlate` treats every material as used when no plate is sliced, both of
  // which wrongly broke homogeneity for the issue-#79 repro file.
  assert.deepEqual([...plateModelFilamentIds(unslicedPetgPlaIndex(), 3) ?? []].sort(), [1, 2])
  assert.deepEqual([...plateModelFilamentIds(unslicedPetgPlaIndex(), 1) ?? []].sort(), [1])
})

test('plateModelFilamentIds falls back to every project material for plate 0 / unknown plates', () => {
  assert.deepEqual([...plateModelFilamentIds(unslicedPetgPlaIndex(), 0) ?? []].sort(), [1, 2])
})

test('plateModelFilamentIds excludes filament_is_support slots even when the plate lists them', () => {
  const index = {
    projectFilaments: [
      { id: 1, filamentType: 'PETG', filamentName: 'PETG', isSupport: false },
      { id: 2, filamentType: 'PLA-S', filamentName: 'Bambu Support For PLA/PETG', isSupport: true }
    ],
    supportFilamentIds: [2],
    plates: [{ index: 1, weight: 12, prediction: 900, filaments: [{ id: 1, usedGrams: 10 }, { id: 2, usedGrams: 2 }] }]
  } as unknown as ThreeMfIndex
  assert.deepEqual([...plateModelFilamentIds(index, 1) ?? []], [1])
})

test('plateModelFilamentIds never subtracts down to an empty set', () => {
  // A single-colour project whose one colour is ALSO set as the support base: the referenced
  // slot is the only candidate, so it IS the model material: dropping it would silently
  // disable the recommendation for exactly the projects that configured support.
  const index = {
    projectFilaments: [{ id: 1, filamentType: 'PETG', filamentName: 'PETG', isSupport: false }],
    supportFilamentIds: [1],
    plates: [{ index: 1, weight: null, prediction: null, filaments: [{ id: 1, usedGrams: null }] }]
  } as unknown as ThreeMfIndex
  assert.deepEqual([...plateModelFilamentIds(index, 1) ?? []], [1])
})

test('plateModelFilamentIds returns null with no baked index', () => {
  assert.equal(plateModelFilamentIds(null, 1), null)
})

// --- buildProcessFilamentChoices (the shared choices builder every process-dialog host uses) ---

test('choice ids are the 1-based POSITION, with classification from the baked config', () => {
  // Slot 2 was removed this session: positions and projectFilamentIds diverge, and the
  // config's filament indices speak positions.
  const bakedIndex = {
    projectFilaments: [
      { id: 1, filamentType: 'PETG', filamentName: 'PETG', filamentPresetName: 'Bambu PETG Basic @BBL X1C', isSupport: false, isSoluble: false },
      { id: 3, filamentType: 'PLA-S', filamentName: 'Support', filamentPresetName: 'Bambu Support For PLA/PETG @BBL X1C', isSupport: true, isSoluble: false }
    ],
    supportFilamentIds: [3],
    plates: []
  } as unknown as ThreeMfIndex
  const choices = buildProcessFilamentChoices({
    projectFilaments: [
      { projectFilamentId: 1, label: 'PETG', color: '#00AE42' },
      { projectFilamentId: 3, label: 'Support', color: '#FFFFFF' }
    ],
    materialOptions: [],
    filamentMaterialOptionIds: {},
    filamentColors: {},
    bakedIndex,
    selectedPlate: 0
  })
  assert.deepEqual(choices.map((choice) => choice.id), [1, 2], 'positions, not projectFilamentIds')
  assert.deepEqual(choices.map((choice) => choice.filamentType), ['PETG', 'PLA-S'])
  assert.deepEqual(choices.map((choice) => choice.isSupport), [false, true])
  assert.deepEqual(
    choices.map((choice) => choice.materialName),
    ['Bambu PETG Basic @BBL X1C', 'Bambu Support For PLA/PETG @BBL X1C'],
    'the FULL preset name, so the combination table can name-match'
  )
  // Plate 0 (all-plates/editor mode): the model set is every non-support project material.
  assert.deepEqual(choices.map((choice) => choice.usedByPlateModels), [true, false])
})

test('a session-added slot classifies from its selected option and is never a model material', () => {
  const bakedIndex = {
    projectFilaments: [{ id: 1, filamentType: 'PLA', filamentName: 'PLA', isSupport: false }],
    plates: []
  } as unknown as ThreeMfIndex
  const choices = buildProcessFilamentChoices({
    projectFilaments: [
      { projectFilamentId: 1, label: 'PLA', color: '#101010' },
      // Added this session: no baked entry exists for id 2.
      { projectFilamentId: 2, label: 'Added', color: null }
    ],
    materialOptions: [materialOption({ id: 'opt-support', materialType: 'PLA-S', material: 'Bambu Support For PLA/PETG @BBL X1C', label: 'Support For PLA/PETG' })],
    filamentMaterialOptionIds: { 2: 'opt-support' },
    filamentColors: { 2: '#EE7700' },
    bakedIndex,
    selectedPlate: 0
  })
  const added = choices[1]!
  assert.equal(added.label, 'Support For PLA/PETG', 'the chosen option names the slot')
  assert.equal(added.filamentType, 'PLA-S', "the option's type fills the missing baked entry")
  assert.equal(added.materialName, 'Bambu Support For PLA/PETG @BBL X1C')
  assert.equal(added.color, '#ee7700', 'normalized (lowercased) like every slice colour')
  assert.equal(added.usedByPlateModels, false, "the file's objects cannot print with a session-added slot")
})

test('with no baked index every plate-model flag is null so the table lookup is skipped', () => {
  const choices = buildProcessFilamentChoices({
    projectFilaments: [{ projectFilamentId: 1, label: 'PLA', color: '#101010' }],
    materialOptions: [],
    filamentMaterialOptionIds: {},
    filamentColors: {},
    bakedIndex: null,
    selectedPlate: 0
  })
  assert.equal(choices[0]!.usedByPlateModels, null)
  assert.equal(choices[0]!.filamentType, null)
})

test('a material in an AMS behind a Filament Track Switch is not pinned to one toolhead', async () => {
  const { buildLoadedPrinterMaterialOptions } = await import('./slicingPresetMatching')
  const unit = (unitId: number, over: Record<string, unknown>) => ({
    unitId,
    nozzleId: 0,
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
    }],
    ...over
  })
  // Both units REPORT nozzleId 0; only the second is behind the switch, which makes that binding
  // meaningless for it. The toolhead chosen here becomes the sliced `filament_map`, so pinning a
  // switched unit would undo exactly the routing freedom the switch provides.
  const source = {
    ams: [unit(0, {}), unit(1, { switchInput: 'B' })],
    externalSpools: [],
    nozzleCount: 2
  } as never

  const options = buildLoadedPrinterMaterialOptions(source, [], null, 'H2D')
  assert.equal(options.length, 2)

  const direct = options.find((option) => option.slotLabel === 'A1')
  const switched = options.find((option) => option.slotLabel === 'B1')
  assert.equal(direct?.nozzleId, 0)
  assert.ok(direct?.toolheadId, 'a directly-bound unit still names its toolhead')

  assert.equal(switched?.nozzleId, null)
  assert.equal(switched?.toolheadId, null, 'a switched unit must not name a toolhead')
  // The group label must not advertise a nozzle the material is not limited to.
  assert.doesNotMatch(switched?.group ?? '', /Nozzle/)
})

test('a project process preset stops being compatible once the target NOZZLE differs', () => {
  // The other half of the same idea as the model rule above. A project preset carries only a name,
  // so every declared axis passes for want of evidence, but the name usually states the nozzle it
  // was authored for, and a process tuned for 0.2 is not a process for 0.8.
  const preset = projectProcess('0.10mm Standard @BBL A1 0.2 nozzle')
  assert.equal(isProcessProfileCompatible(preset, null, 'A1', [0.2], 'Textured PEI Plate'), true)
  assert.equal(isProcessProfileCompatible(preset, null, 'A1', [0.8], 'Textured PEI Plate'), false)
})

test('a project process preset stating no nozzle stays compatible at any nozzle', () => {
  // Positive identification only, exactly as for the model: a preset that says nothing about the
  // nozzle must not be dropped for saying too little.
  const preset = projectProcess('0.20mm Standard @BBL A1')
  assert.equal(isProcessProfileCompatible(preset, null, 'A1', [0.2], 'Textured PEI Plate'), true)
  assert.equal(isProcessProfileCompatible(preset, null, 'A1', [0.8], 'Textured PEI Plate'), true)
})
