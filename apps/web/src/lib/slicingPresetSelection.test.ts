import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeFilamentVendorLabel, type SlicingPresetSummary } from '@printstream/shared'
import {
  buildSlicingPresetLabels,
  extractLayerHeightToken,
  formatSlicingPresetBrandedName,
  formatSlicingPresetDisplayName,
  isSelectableOrProjectFallbackSlicingPreset,
  isSelectableSlicingPreset,
  pickMachineDefaultFilamentProfile,
  pickSlicingPresetByDeclaredName,
  pickMostSimilarSlicingPresetByName,
  pickProjectFallbackSlicingPresetByName,
  pickSelectableSlicingPresetByName,
  pickStandardProcessProfile,
  resolveSliceDisabledReason,
  type SliceDisabledReasonInput
} from './slicingPresetSelection'

function buildProfile(id: string, name: string): SlicingPresetSummary {
  return {
    id,
    source: id.startsWith('builtin:') ? 'builtin' : 'custom',
    kind: 'process',
    name,
    updatedAt: null
  }
}

test('pickStandardProcessProfile prefers the 0.20mm Standard preset over the first in the list', () => {
  const profiles = [
    buildProfile('builtin:fine', '0.08mm Extra Fine @BBL X1C'),
    buildProfile('builtin:strength', '0.20mm Strength @BBL X1C'),
    buildProfile('builtin:standard', '0.20mm Standard @BBL X1C'),
    buildProfile('builtin:draft', '0.28mm Draft @BBL X1C')
  ]
  assert.equal(pickStandardProcessProfile(profiles)?.id, 'builtin:standard')
})

test('pickStandardProcessProfile falls back to any 0.20mm preset, then null', () => {
  const onlyOtherTwentyMicron = [
    buildProfile('builtin:fine', '0.08mm Extra Fine @BBL X1C'),
    buildProfile('builtin:strength', '0.20mm Strength @BBL X1C')
  ]
  assert.equal(pickStandardProcessProfile(onlyOtherTwentyMicron)?.id, 'builtin:strength')
  assert.equal(pickStandardProcessProfile([buildProfile('builtin:draft', '0.28mm Draft @BBL X1C')]), null)
})

test('pickSelectableSlicingPresetByName ignores project placeholders when a built-in profile has the same baked name', () => {
  const profiles = [
    buildProfile('project:process:0.20mm%20Standard%20%40BBL%20X1C', '0.20mm Standard @BBL X1C'),
    buildProfile('builtin:process:standard-x1c', '0.20mm Standard @BBL X1C')
  ]

  const match = pickSelectableSlicingPresetByName(profiles, '0.20mm Standard @BBL X1C')

  assert.equal(match?.id, 'builtin:process:standard-x1c')
})

test('isSelectableSlicingPreset excludes project-backed profile ids', () => {
  assert.equal(isSelectableSlicingPreset(buildProfile('project:machine:X1C', 'X1C')), false)
  assert.equal(isSelectableSlicingPreset(buildProfile('builtin:machine:X1C', 'X1C')), true)
})

test('pickProjectFallbackSlicingPresetByName returns the baked project profile when no selectable profile matches', () => {
  const profiles = [
    buildProfile('project:process:0.20mm%20Ryan%20%40BBL%20X1C', '0.20mm Ryan @BBL X1C'),
    buildProfile('builtin:process:standard-x1c', '0.20mm Standard @BBL X1C')
  ]

  const match = pickProjectFallbackSlicingPresetByName(profiles, '0.20mm Ryan @BBL X1C')

  assert.equal(match?.id, 'project:process:0.20mm%20Ryan%20%40BBL%20X1C')
})

test('pickProjectFallbackSlicingPresetByName returns the project profile even when a same-named installed preset exists', () => {
  const profiles = [
    buildProfile('project:process:0.20mm%20Standard%20%40BBL%20X1C', '0.20mm Standard @BBL X1C'),
    buildProfile('builtin:process:standard-x1c', '0.20mm Standard @BBL X1C')
  ]

  const match = pickProjectFallbackSlicingPresetByName(profiles, '0.20mm Standard @BBL X1C')

  assert.equal(match?.id, 'project:process:0.20mm%20Standard%20%40BBL%20X1C')
})

test('isSelectableOrProjectFallbackSlicingPreset keeps the embedded project profile on a same-name collision', () => {
  const profiles = [
    buildProfile('project:process:0.20mm%20Standard%20%40BBL%20X1C', '0.20mm Standard @BBL X1C'),
    buildProfile('builtin:process:standard-x1c', '0.20mm Standard @BBL X1C')
  ]

  // Both the project profile (carrying the 3MF overrides) and the installed
  // preset survive the filter; downstream dedupe then prefers the project profile.
  assert.equal(isSelectableOrProjectFallbackSlicingPreset(profiles[0] as SlicingPresetSummary, profiles, '0.20mm Standard @BBL X1C'), true)
  assert.equal(isSelectableOrProjectFallbackSlicingPreset(profiles[1] as SlicingPresetSummary, profiles, '0.20mm Standard @BBL X1C'), true)
})

test('isSelectableOrProjectFallbackSlicingPreset includes only the baked project fallback', () => {
  const profiles = [
    buildProfile('project:process:0.20mm%20Ryan%20%40BBL%20X1C', '0.20mm Ryan @BBL X1C'),
    buildProfile('project:process:0.20mm%20Standard%20%40BBL%20X1C', '0.20mm Standard @BBL X1C'),
    buildProfile('builtin:process:standard-x1c', '0.20mm Standard @BBL X1C')
  ]

  assert.equal(isSelectableOrProjectFallbackSlicingPreset(profiles[0] as SlicingPresetSummary, profiles, '0.20mm Ryan @BBL X1C'), true)
  assert.equal(isSelectableOrProjectFallbackSlicingPreset(profiles[1] as SlicingPresetSummary, profiles, '0.20mm Ryan @BBL X1C'), false)
  assert.equal(isSelectableOrProjectFallbackSlicingPreset(profiles[2] as SlicingPresetSummary, profiles, '0.20mm Ryan @BBL X1C'), true)
})

test('pickMostSimilarSlicingPresetByName chooses the closest process preset across printer models', () => {
  const profiles = [
    buildProfile('builtin:process:strength-h2d', '0.20mm Strength @BBL H2D'),
    buildProfile('builtin:process:standard-h2d', '0.20mm Standard @BBL H2D'),
    buildProfile('builtin:process:speed-h2d', '0.24mm Speed @BBL H2D')
  ]

  const match = pickMostSimilarSlicingPresetByName(profiles, '0.20mm Standard @BBL X1C')

  assert.equal(match?.id, 'builtin:process:standard-h2d')
})

test('pickMostSimilarSlicingPresetByName returns null when there is no usable target name', () => {
  const profiles = [buildProfile('builtin:process:standard-h2d', '0.20mm Standard @BBL H2D')]

  const match = pickMostSimilarSlicingPresetByName(profiles, '   ')

  assert.equal(match, null)
})

test('formatSlicingPresetDisplayName keeps the full process preset name including a custom suffix', () => {
  const profile = buildProfile('custom:442eadee', '0.20mm Standard @BBL H2D - Ryan')

  assert.equal(formatSlicingPresetDisplayName(profile), '0.20mm Standard @BBL H2D - Ryan')
})

test('formatSlicingPresetDisplayName keeps distinct labels for a built-in and a derived custom process preset', () => {
  const builtin = buildProfile('builtin:process:standard-h2d', '0.20mm Standard @BBL H2D')
  const custom = buildProfile('custom:442eadee', '0.20mm Standard @BBL H2D - Ryan')

  assert.notEqual(formatSlicingPresetDisplayName(builtin), formatSlicingPresetDisplayName(custom))
})

test('formatSlicingPresetDisplayName shows machine presets verbatim so nozzle sizes stay visible', () => {
  const profile: SlicingPresetSummary = {
    id: 'builtin:machine:h2d-04',
    source: 'builtin',
    kind: 'machine',
    name: 'Bambu Lab H2D 0.4 nozzle',
    updatedAt: null
  }

  assert.equal(formatSlicingPresetDisplayName(profile), 'Bambu Lab H2D 0.4 nozzle')
})

test('formatSlicingPresetDisplayName uses the filament alias without the printer suffix or vendor prefix', () => {
  const profile: SlicingPresetSummary = {
    id: 'builtin:filament:bambu-pla-basic-x1c',
    source: 'builtin',
    kind: 'filament',
    name: 'Bambu PLA Basic @BBL X1C',
    filamentVendor: 'Bambu Lab',
    updatedAt: null
  }

  assert.equal(formatSlicingPresetDisplayName(profile), 'PLA Basic')
})

function buildFilamentProfile(id: string, name: string, filamentType: string): SlicingPresetSummary {
  return {
    id,
    source: 'builtin',
    kind: 'filament',
    name,
    filamentType,
    updatedAt: null
  }
}

function buildMachineProfile(
  id: string,
  name: string,
  defaults: { defaultProcessProfile?: string; defaultFilamentProfiles?: string[] }
): SlicingPresetSummary {
  return {
    id,
    source: 'builtin',
    kind: 'machine',
    name,
    updatedAt: null,
    ...defaults
  }
}

test('extractLayerHeightToken pulls the leading layer-height token from a process name', () => {
  assert.equal(extractLayerHeightToken('0.20mm Standard @BBL H2D'), '0.20mm')
  assert.equal(extractLayerHeightToken('0.20 mm Standard @BBL H2D'), '0.20mm')
  assert.equal(extractLayerHeightToken('Standard'), null)
  assert.equal(extractLayerHeightToken(null), null)
})

// Issue #68: `default_print_profile` / `default_filament_profile` are references inside
// BambuStudio's preset system, so the lookup is exact. The substring fallback this
// replaced let a user's renamed derivative answer for the builtin it was derived from.
test('pickSlicingPresetByDeclaredName matches exactly and never a renamed derivative', () => {
  const derivative = buildProfile('custom:process:standard-ryan', '0.20mm Standard @BBL H2D - Ryan')
  const builtin = buildProfile('builtin:process:standard-h2d', '0.20mm Standard @BBL H2D')

  assert.equal(pickSlicingPresetByDeclaredName([derivative, builtin], '0.20mm Standard @BBL H2D')?.id, 'builtin:process:standard-h2d')
  assert.equal(pickSlicingPresetByDeclaredName([derivative], '0.20mm Standard @BBL H2D'), null)
  assert.equal(pickSlicingPresetByDeclaredName([builtin], null), null)
})

test('pickMachineDefaultFilamentProfile resolves the machine default and prefers a matching filament type', () => {
  const profiles = [
    buildFilamentProfile('builtin:filament:pla-basic-h2d', 'Bambu PLA Basic @BBL H2D', 'PLA'),
    buildFilamentProfile('builtin:filament:petg-hf-h2d', 'Bambu PETG HF @BBL H2D', 'PETG')
  ]
  const machine = buildMachineProfile('builtin:machine:h2d-04', 'Bambu Lab H2D 0.4 nozzle', {
    defaultFilamentProfiles: ['Bambu PLA Basic @BBL H2D']
  })

  // Falls back to the machine default filament profile.
  assert.equal(pickMachineDefaultFilamentProfile(profiles, machine, 'PLA')?.id, 'builtin:filament:pla-basic-h2d')
})

test('pickMachineDefaultFilamentProfile prefers a default whose filament type matches the project filament', () => {
  const profiles = [
    buildFilamentProfile('builtin:filament:pla-basic-h2d', 'Bambu PLA Basic @BBL H2D', 'PLA'),
    buildFilamentProfile('builtin:filament:petg-hf-h2d', 'Bambu PETG HF @BBL H2D', 'PETG')
  ]
  const machine = buildMachineProfile('builtin:machine:h2d-04', 'Bambu Lab H2D 0.4 nozzle', {
    defaultFilamentProfiles: ['Bambu PLA Basic @BBL H2D', 'Bambu PETG HF @BBL H2D']
  })

  assert.equal(pickMachineDefaultFilamentProfile(profiles, machine, 'PETG')?.id, 'builtin:filament:petg-hf-h2d')
})

test('pickMachineDefaultFilamentProfile returns null when no default resolves to an available profile', () => {
  const profiles = [buildFilamentProfile('builtin:filament:pla-basic-h2d', 'Bambu PLA Basic @BBL H2D', 'PLA')]

  assert.equal(pickMachineDefaultFilamentProfile(profiles, null, 'PLA'), null)
  assert.equal(
    pickMachineDefaultFilamentProfile(
      profiles,
      buildMachineProfile('builtin:machine:h2d-04', 'Bambu Lab H2D 0.4 nozzle', { defaultFilamentProfiles: [] }),
      'PLA'
    ),
    null
  )
  assert.equal(
    pickMachineDefaultFilamentProfile(
      profiles,
      buildMachineProfile('builtin:machine:h2d-04', 'Bambu Lab H2D 0.4 nozzle', {
        defaultFilamentProfiles: ['Nonexistent @BBL H2D']
      }),
      'PLA'
    ),
    null
  )
})
// A support slot taking the machine's model-filament default would print supports in
// model material. Types are compared DERIVED on both sides, so the support default
// (typed by base polymer + `filament_is_support`) is the one that matches.
test('pickMachineDefaultFilamentProfile keeps support and model filaments apart', () => {
  const modelPla = buildFilamentProfile('builtin:filament:pla-basic-h2d', 'Bambu PLA Basic @BBL H2D', 'PLA')
  const supportPla: SlicingPresetSummary = {
    ...buildFilamentProfile('builtin:filament:support-pla-h2d', 'Bambu Support For PLA @BBL H2D', 'PLA'),
    filamentIds: ['GFS02'],
    filamentIsSupport: true
  }
  const machine = buildMachineProfile('builtin:machine:h2d-04', 'Bambu Lab H2D 0.4 nozzle', {
    defaultFilamentProfiles: ['Bambu PLA Basic @BBL H2D', 'Bambu Support For PLA @BBL H2D']
  })

  assert.equal(pickMachineDefaultFilamentProfile([modelPla, supportPla], machine, 'PLA-S')?.id, 'builtin:filament:support-pla-h2d')
  assert.equal(pickMachineDefaultFilamentProfile([modelPla, supportPla], machine, 'PLA')?.id, 'builtin:filament:pla-basic-h2d')
  // Nothing eligible beats the wrong side of the support axis.
  assert.equal(pickMachineDefaultFilamentProfile([{ ...modelPla, filamentIsSupport: false }], machine, 'PLA-S'), null)
})

// A preset with no support flag at all (a slicer older than the field) stays eligible;
// vetoing on unknown would leave every support slot with no default.
test('pickMachineDefaultFilamentProfile stays lenient when the support flag is absent', () => {
  const unflagged = buildFilamentProfile('builtin:filament:pla-basic-h2d', 'Bambu PLA Basic @BBL H2D', 'PLA')
  const machine = buildMachineProfile('builtin:machine:h2d-04', 'Bambu Lab H2D 0.4 nozzle', {
    defaultFilamentProfiles: ['Bambu PLA Basic @BBL H2D']
  })

  assert.equal(pickMachineDefaultFilamentProfile([unflagged], machine, 'PLA-S')?.id, 'builtin:filament:pla-basic-h2d')
})

// Seeding a fresh slot reads real fields first: `/\bpla\b/` on the name also matches
// PLA-CF and the support PLAs.
function buildSliceDisabledReasonInput(overrides: Partial<SliceDisabledReasonInput> = {}): SliceDisabledReasonInput {
  // A fully valid slice; individual tests flip one signal to assert the reported reason.
  return {
    canSlice: false,
    configured: true,
    selectedSlicerTargetId: 'bambustudio-2-7-1-57',
    profilesError: null,
    slicerDataReady: true,
    printerProfileId: 'builtin:machine:h2d-04',
    processProfileId: 'builtin:process:0.20',
    printerProfileIncompatible: false,
    processProfileIncompatible: false,
    nozzleDiameterCount: 1,
    missingFilamentProfile: false,
    missingFilamentToolhead: false,
    targetMode: 'realPrinter',
    printerId: 'printer-1',
    submitting: false,
    ...overrides
  }
}

test('resolveSliceDisabledReason returns null when the slice is valid', () => {
  assert.equal(resolveSliceDisabledReason(buildSliceDisabledReasonInput({ canSlice: true })), null)
})

test('resolveSliceDisabledReason reports an empty machine profile as the blocking cause', () => {
  // The reported regression: a stale-empty slicer-profiles response left no selectable machine
  // profile, so printerProfileId stayed empty and the Slice button was silently disabled.
  assert.equal(
    resolveSliceDisabledReason(buildSliceDisabledReasonInput({ printerProfileId: '' })),
    'No matching printer profile is installed for this printer and nozzle.'
  )
})

test('resolveSliceDisabledReason surfaces the slicer-profiles error before per-field reasons', () => {
  assert.equal(
    resolveSliceDisabledReason(buildSliceDisabledReasonInput({
      profilesError: 'Couldn’t load slicer profiles: the slicer may be restarting. Reopen the editor to try again.',
      printerProfileId: ''
    })),
    'Couldn’t load slicer profiles: the slicer may be restarting. Reopen the editor to try again.'
  )
})

test('resolveSliceDisabledReason reports loading before incomplete-settings reasons', () => {
  assert.equal(
    resolveSliceDisabledReason(buildSliceDisabledReasonInput({ slicerDataReady: false, printerProfileId: '' })),
    'Loading slicer data…'
  )
})

test('resolveSliceDisabledReason flags a set-but-incompatible process selection', () => {
  // Regression: a slice dialog whose state predated a printer switch submitted an X1C process
  // against an H2D target: the id was non-empty, so the old gates let it through and the slicer
  // hard-rejected it ("process not compatible with printer"). The reason must name the mismatch.
  assert.equal(
    resolveSliceDisabledReason(buildSliceDisabledReasonInput({ processProfileIncompatible: true })),
    'The selected print settings aren’t compatible with the target printer: choose a compatible profile.'
  )
})

test('resolveSliceDisabledReason flags a set-but-incompatible machine selection', () => {
  assert.equal(
    resolveSliceDisabledReason(buildSliceDisabledReasonInput({ printerProfileIncompatible: true })),
    'The selected printer profile doesn’t match the target printer.'
  )
})

test('resolveSliceDisabledReason flags unmapped filament slots', () => {
  assert.equal(
    resolveSliceDisabledReason(buildSliceDisabledReasonInput({ missingFilamentProfile: true })),
    'Assign a filament to every material slot.'
  )
})


test('resolveSliceDisabledReason blocks a project newer than the selected slicer', () => {
  // A genuine gate, unlike the settings-repair notice: BambuStudio refuses to open the file at all,
  // so it must be reported ahead of any per-field reason.
  assert.equal(
    resolveSliceDisabledReason(buildSliceDisabledReasonInput({ blockedByProjectVersion: true, printerProfileId: '' })),
    'This project was saved by a newer Bambu Studio than the selected slicer.'
  )
  // Accepting the override clears it and normal validation resumes.
  assert.equal(
    resolveSliceDisabledReason(buildSliceDisabledReasonInput({ blockedByProjectVersion: false, canSlice: true })),
    null
  )
})

// The materials list showed the SAME filament three different ways, because the label it used
// dropped the vendor only when the profile happened to declare one. An installed catalogue preset
// declares `filamentVendor` and rendered "PLA Basic"; the identical preset carried inside a 3MF
// declares none and rendered "Bambu PLA Basic". Provenance is invisible to the user, so the rows
// read as different materials. The branded form must not depend on it.
test('formatSlicingPresetBrandedName names a filament the same way whichever provenance it came from', () => {
  const fromCatalogue: SlicingPresetSummary = {
    id: 'builtin:filament:pla-basic', source: 'builtin', kind: 'filament',
    name: 'Bambu PLA Basic @BBL X1C', filamentVendor: 'Bambu Lab', updatedAt: null
  }
  // A 3MF's own preset: same material, no vendor metadata to strip by.
  const fromProject: SlicingPresetSummary = {
    id: 'project:filament:0', source: 'builtin', kind: 'filament',
    name: 'Bambu PLA Basic', updatedAt: null
  }

  assert.equal(formatSlicingPresetBrandedName(fromCatalogue), 'Bambu PLA Basic')
  assert.equal(formatSlicingPresetBrandedName(fromProject), 'Bambu PLA Basic')
  assert.equal(
    formatSlicingPresetBrandedName(fromCatalogue),
    formatSlicingPresetBrandedName(fromProject),
    'provenance must not change how a material is named'
  )
  // The grouped pickers still get the compact form: vendor is their group header.
  assert.equal(formatSlicingPresetDisplayName(fromCatalogue), 'PLA Basic')
})

test('formatSlicingPresetBrandedName keeps non-filament preset names verbatim', () => {
  const process: SlicingPresetSummary = {
    id: 'builtin:process:standard', source: 'builtin', kind: 'process',
    name: '0.20mm Standard @BBL H2D - Ryan', updatedAt: null
  }
  assert.equal(formatSlicingPresetBrandedName(process), '0.20mm Standard @BBL H2D - Ryan')
})

// One vendor, one spelling. BambuStudio writes filament_vendor "Bambu Lab", while a 3MF's own
// preset carries no vendor and can only be named from the preset text ("Bambu"). Unnormalized, the
// material picker listed "Bambu Lab · Built-in profile" directly above "Bambu · 3MF project
// profile" for the same manufacturer, which reads as two brands.
test('a vendor is spelled the same whether it comes from metadata or the preset name', () => {
  assert.equal(normalizeFilamentVendorLabel('Bambu Lab'), 'Bambu')
  assert.equal(normalizeFilamentVendorLabel('Bambu'), 'Bambu')
  assert.equal(normalizeFilamentVendorLabel('  Bambu Lab  '), 'Bambu')
  // Other vendors pass through untouched, this is a spelling rule, not a brand table.
  assert.equal(normalizeFilamentVendorLabel('Polymaker'), 'Polymaker')
  assert.equal(normalizeFilamentVendorLabel(null), '')
})

test('picker labels stay clean until two presets share an alias, then show the full names', () => {
  // The failure this guards: a workspace preset derived from a built-in aliases to the same text,
  // so both rows read "Bambu PLA Basic" and the user cannot tell which is which, nor read the
  // selected value back afterwards. Only the colliding pair pays; unique aliases stay short.
  const profiles: SlicingPresetSummary[] = [
    { id: 'builtin:pla', source: 'builtin', kind: 'filament', name: 'Bambu PLA Basic @BBL H2D', filamentVendor: 'Bambu Lab' },
    { id: 'custom:pla-55', source: 'custom', kind: 'filament', name: 'Bambu PLA Basic @BBL H2D - 55 degree plate', filamentVendor: 'Bambu Lab' },
    { id: 'builtin:petg', source: 'builtin', kind: 'filament', name: 'Bambu PETG HF @BBL H2D', filamentVendor: 'Bambu Lab' }
  ]

  const labels = buildSlicingPresetLabels(profiles)

  assert.equal(labels.get('builtin:pla'), 'Bambu PLA Basic @BBL H2D')
  assert.equal(labels.get('custom:pla-55'), 'Bambu PLA Basic @BBL H2D - 55 degree plate')
  // No collision, so this one keeps the alias.
  assert.equal(labels.get('builtin:petg'), 'PETG HF')
})
