import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { LibraryFile, SlicingPresetSummary, ThreeMfFilament, ThreeMfIndex, ThreeMfProjectFilament } from '@printstream/shared'
import { resolveInitialManualPrinterModel, isProcessProfileCompatible, buildBakedFilamentProfileSelection, buildFilamentMappings, buildProjectSlicingPresets, extractMachineProfilePrinterModelOptions, buildSliceDialogProjectFilaments, buildProfileMaterialOptionId, buildRedundantProjectPresetCandidates, buildSliceMaterialOptions, filterSliceMaterialOptions, isFilamentProfileCompatible, repointMaterialOptionToCompatibleAlias, narrowMaterialOptions, resolveProfileMaterialType, slicingPresetsResponseIsUsable, type SliceMaterialOption } from './slicingPresetMatching'

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
// preset it synthesizes must be typed PLA-S too — otherwise the project's own material
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
 * machine-tuned, and retargeting rewrites machine-owned keys only — so an A1-authored process left
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
// slot re-seeded from the FILE — "Bambu PLA Basic" chosen on a P1P became the project's original
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
  // nothing among built-ins — which is what a separate Brand dropdown existed to work around.
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

// Only a project preset with an installed twin is worth comparing — and the twin is found by ALIAS,
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
