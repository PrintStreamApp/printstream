import assert from 'node:assert/strict'
import test from 'node:test'
import type { SlicingProfileSummary } from '@printstream/shared'
import {
  extractLayerHeightToken,
  formatSlicingProfileDisplayName,
  isSelectableOrProjectFallbackSlicingProfile,
  isSelectableSlicingProfile,
  pickMachineDefaultFilamentProfile,
  resolveDefaultFilamentProfile,
  pickMostSimilarSlicingProfileByName,
  pickProjectFallbackSlicingProfileByName,
  pickSelectableSlicingProfileByName,
  pickStandardProcessProfile,
  resolveSliceDisabledReason,
  type SliceDisabledReasonInput
} from './slicingProfileSelection'

function buildProfile(id: string, name: string): SlicingProfileSummary {
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

test('pickSelectableSlicingProfileByName ignores project placeholders when a built-in profile has the same baked name', () => {
  const profiles = [
    buildProfile('project:process:0.20mm%20Standard%20%40BBL%20X1C', '0.20mm Standard @BBL X1C'),
    buildProfile('builtin:process:standard-x1c', '0.20mm Standard @BBL X1C')
  ]

  const match = pickSelectableSlicingProfileByName(profiles, '0.20mm Standard @BBL X1C')

  assert.equal(match?.id, 'builtin:process:standard-x1c')
})

test('isSelectableSlicingProfile excludes project-backed profile ids', () => {
  assert.equal(isSelectableSlicingProfile(buildProfile('project:machine:X1C', 'X1C')), false)
  assert.equal(isSelectableSlicingProfile(buildProfile('builtin:machine:X1C', 'X1C')), true)
})

test('pickProjectFallbackSlicingProfileByName returns the baked project profile when no selectable profile matches', () => {
  const profiles = [
    buildProfile('project:process:0.20mm%20Ryan%20%40BBL%20X1C', '0.20mm Ryan @BBL X1C'),
    buildProfile('builtin:process:standard-x1c', '0.20mm Standard @BBL X1C')
  ]

  const match = pickProjectFallbackSlicingProfileByName(profiles, '0.20mm Ryan @BBL X1C')

  assert.equal(match?.id, 'project:process:0.20mm%20Ryan%20%40BBL%20X1C')
})

test('pickProjectFallbackSlicingProfileByName returns the project profile even when a same-named installed preset exists', () => {
  const profiles = [
    buildProfile('project:process:0.20mm%20Standard%20%40BBL%20X1C', '0.20mm Standard @BBL X1C'),
    buildProfile('builtin:process:standard-x1c', '0.20mm Standard @BBL X1C')
  ]

  const match = pickProjectFallbackSlicingProfileByName(profiles, '0.20mm Standard @BBL X1C')

  assert.equal(match?.id, 'project:process:0.20mm%20Standard%20%40BBL%20X1C')
})

test('isSelectableOrProjectFallbackSlicingProfile keeps the embedded project profile on a same-name collision', () => {
  const profiles = [
    buildProfile('project:process:0.20mm%20Standard%20%40BBL%20X1C', '0.20mm Standard @BBL X1C'),
    buildProfile('builtin:process:standard-x1c', '0.20mm Standard @BBL X1C')
  ]

  // Both the project profile (carrying the 3MF overrides) and the installed
  // preset survive the filter; downstream dedupe then prefers the project profile.
  assert.equal(isSelectableOrProjectFallbackSlicingProfile(profiles[0] as SlicingProfileSummary, profiles, '0.20mm Standard @BBL X1C'), true)
  assert.equal(isSelectableOrProjectFallbackSlicingProfile(profiles[1] as SlicingProfileSummary, profiles, '0.20mm Standard @BBL X1C'), true)
})

test('isSelectableOrProjectFallbackSlicingProfile includes only the baked project fallback', () => {
  const profiles = [
    buildProfile('project:process:0.20mm%20Ryan%20%40BBL%20X1C', '0.20mm Ryan @BBL X1C'),
    buildProfile('project:process:0.20mm%20Standard%20%40BBL%20X1C', '0.20mm Standard @BBL X1C'),
    buildProfile('builtin:process:standard-x1c', '0.20mm Standard @BBL X1C')
  ]

  assert.equal(isSelectableOrProjectFallbackSlicingProfile(profiles[0] as SlicingProfileSummary, profiles, '0.20mm Ryan @BBL X1C'), true)
  assert.equal(isSelectableOrProjectFallbackSlicingProfile(profiles[1] as SlicingProfileSummary, profiles, '0.20mm Ryan @BBL X1C'), false)
  assert.equal(isSelectableOrProjectFallbackSlicingProfile(profiles[2] as SlicingProfileSummary, profiles, '0.20mm Ryan @BBL X1C'), true)
})

test('pickMostSimilarSlicingProfileByName chooses the closest process preset across printer models', () => {
  const profiles = [
    buildProfile('builtin:process:strength-h2d', '0.20mm Strength @BBL H2D'),
    buildProfile('builtin:process:standard-h2d', '0.20mm Standard @BBL H2D'),
    buildProfile('builtin:process:speed-h2d', '0.24mm Speed @BBL H2D')
  ]

  const match = pickMostSimilarSlicingProfileByName(profiles, '0.20mm Standard @BBL X1C')

  assert.equal(match?.id, 'builtin:process:standard-h2d')
})

test('pickMostSimilarSlicingProfileByName returns null when there is no usable target name', () => {
  const profiles = [buildProfile('builtin:process:standard-h2d', '0.20mm Standard @BBL H2D')]

  const match = pickMostSimilarSlicingProfileByName(profiles, '   ')

  assert.equal(match, null)
})

test('formatSlicingProfileDisplayName keeps the full process preset name including a custom suffix', () => {
  const profile = buildProfile('custom:442eadee', '0.20mm Standard @BBL H2D - Ryan')

  assert.equal(formatSlicingProfileDisplayName(profile), '0.20mm Standard @BBL H2D - Ryan')
})

test('formatSlicingProfileDisplayName keeps distinct labels for a built-in and a derived custom process preset', () => {
  const builtin = buildProfile('builtin:process:standard-h2d', '0.20mm Standard @BBL H2D')
  const custom = buildProfile('custom:442eadee', '0.20mm Standard @BBL H2D - Ryan')

  assert.notEqual(formatSlicingProfileDisplayName(builtin), formatSlicingProfileDisplayName(custom))
})

test('formatSlicingProfileDisplayName shows machine presets verbatim so nozzle sizes stay visible', () => {
  const profile: SlicingProfileSummary = {
    id: 'builtin:machine:h2d-04',
    source: 'builtin',
    kind: 'machine',
    name: 'Bambu Lab H2D 0.4 nozzle',
    updatedAt: null
  }

  assert.equal(formatSlicingProfileDisplayName(profile), 'Bambu Lab H2D 0.4 nozzle')
})

test('formatSlicingProfileDisplayName uses the filament alias without the printer suffix or vendor prefix', () => {
  const profile: SlicingProfileSummary = {
    id: 'builtin:filament:bambu-pla-basic-x1c',
    source: 'builtin',
    kind: 'filament',
    name: 'Bambu PLA Basic @BBL X1C',
    filamentVendor: 'Bambu Lab',
    updatedAt: null
  }

  assert.equal(formatSlicingProfileDisplayName(profile), 'PLA Basic')
})

function buildFilamentProfile(id: string, name: string, filamentType: string): SlicingProfileSummary {
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
): SlicingProfileSummary {
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
      profilesError: 'Couldn’t load slicer profiles — the slicer may be restarting. Reopen the editor to try again.',
      printerProfileId: ''
    })),
    'Couldn’t load slicer profiles — the slicer may be restarting. Reopen the editor to try again.'
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
  // against an H2D target — the id was non-empty, so the old gates let it through and the slicer
  // hard-rejected it ("process not compatible with printer"). The reason must name the mismatch.
  assert.equal(
    resolveSliceDisabledReason(buildSliceDisabledReasonInput({ processProfileIncompatible: true })),
    'The selected print settings aren’t compatible with the target printer — choose a compatible profile.'
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


test('resolveDefaultFilamentProfile prefers the machine default filament', () => {
  const profiles = [
    buildFilamentProfile('builtin:filament:pla-basic-h2d', 'Bambu PLA Basic @BBL H2D', 'PLA'),
    buildFilamentProfile('builtin:filament:generic-pla', 'Generic PLA @BBL H2D', 'PLA')
  ]
  const machine = buildMachineProfile('builtin:machine:h2d-04', 'Bambu Lab H2D 0.4 nozzle', {
    defaultFilamentProfiles: ['Bambu PLA Basic @BBL H2D']
  })
  assert.equal(resolveDefaultFilamentProfile(profiles, machine)?.id, 'builtin:filament:pla-basic-h2d')
})

test('resolveDefaultFilamentProfile falls back to Bambu PLA Basic then Generic PLA by name when no machine default', () => {
  const withBasic = [
    buildFilamentProfile('builtin:filament:generic-pla', 'Generic PLA @BBL H2D', 'PLA'),
    buildFilamentProfile('builtin:filament:pla-basic', 'Bambu PLA Basic @BBL H2D', 'PLA')
  ]
  // No machine default -> prefer Bambu PLA Basic over Generic PLA.
  assert.equal(resolveDefaultFilamentProfile(withBasic, null)?.id, 'builtin:filament:pla-basic')

  // No Basic -> Generic PLA.
  const genericOnly = [buildFilamentProfile('builtin:filament:generic-pla', 'Generic PLA @BBL H2D', 'PLA')]
  assert.equal(resolveDefaultFilamentProfile(genericOnly, null)?.id, 'builtin:filament:generic-pla')

  // Neither -> any PLA.
  const otherPla = [buildFilamentProfile('builtin:filament:pla-matte', 'Bambu PLA Matte @BBL H2D', 'PLA')]
  assert.equal(resolveDefaultFilamentProfile(otherPla, null)?.id, 'builtin:filament:pla-matte')
})

test('resolveDefaultFilamentProfile returns null when the catalogue has no PLA at all', () => {
  const noPla = [buildFilamentProfile('builtin:filament:petg', 'Bambu PETG HF @BBL H2D', 'PETG')]
  assert.equal(resolveDefaultFilamentProfile(noPla, null), null)
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
