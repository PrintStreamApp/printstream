import assert from 'node:assert/strict'
import test from 'node:test'
import type { SlicingPresetSummary } from '@printstream/shared'
import { resolveFilamentPreset, resolveProjectFilamentPreset } from './filamentPresetResolver'

const selectedMachineProfile: SlicingPresetSummary = {
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

function filamentPreset(overrides: Partial<SlicingPresetSummary> & { id: string; name: string }): SlicingPresetSummary {
  return { source: 'builtin', kind: 'filament', ...overrides }
}

// Every variant of a product shares its filament id, so the printer axis is what separates them —
// and it does so by FILTER. Both fixtures declare their target because every real preset does: a
// preset with an `inherits` parent is served with the parent's `compatiblePrinters` merged in (the
// API's `resolveProfileMetadata`), our equivalent of BambuStudio inheriting from an `@base` preset.
// A live catalogue of 2901 filament presets had zero declaring neither field.
test('resolves by exact filament id and filters to the variant for this printer', () => {
  const profiles = [
    filamentPreset({
      id: 'builtin:filament:x1c-abs',
      name: 'Bambu ABS @BBL X1C',
      filamentIds: ['GFB00'],
      filamentType: 'ABS',
      compatiblePrinters: ['Bambu Lab X1 Carbon 0.4 nozzle']
    }),
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

test('a bare typed tray resolves to a machine-compatible preset of the same type', () => {
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
  assert.equal(resolution.matchedBy, 'filamentType')
})

// Issue #68: the family table folds every PLA variant into "PLA", so an exact
// derived-type match must outrank it — otherwise a plain PLA tray could take a
// composite preset (and its hardened-nozzle requirement) purely by list order.
test('an exact derived type outranks a family match, and the family match still catches a variant', () => {
  const profiles = [
    filamentPreset({ id: 'builtin:filament:pla-cf', name: 'Bambu PLA-CF @BBL H2D', filamentType: 'PLA-CF' }),
    filamentPreset({ id: 'builtin:filament:pla-basic', name: 'Bambu PLA Basic @BBL H2D', filamentType: 'PLA' })
  ]

  const plain = resolveFilamentPreset(profiles, { ...baseQuery, trayFilamentType: 'PLA' })
  assert.equal(plain.status === 'resolved' && plain.profileId, 'builtin:filament:pla-basic')

  const composite = resolveFilamentPreset(profiles, { ...baseQuery, trayFilamentType: 'PLA-CF' })
  assert.equal(composite.status === 'resolved' && composite.profileId, 'builtin:filament:pla-cf')

  // Nothing of that exact type left: the family tier still supplies a usable preset.
  const familyOnly = resolveFilamentPreset([profiles[1] as SlicingPresetSummary], { ...baseQuery, trayFilamentType: 'PLA-CF' })
  assert.equal(familyOnly.status, 'resolved')
  assert.equal(familyOnly.matchedBy, 'filamentFamily')
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

// The profile NAME must never act as a printer-model declaration. Asserted through the filter,
// which is the stronger form: a preset NAMED "@BBL H2D" while DECLARING X1C is rejected for an H2D
// machine. If the name were read as a declaration it would survive, and — being first — win.
test('the preset name is not a printer declaration', () => {
  const profiles = [
    filamentPreset({
      id: 'builtin:filament:named-h2d-declares-x1c',
      name: 'Generic PLA @BBL H2D',
      filamentType: 'PLA',
      filamentIds: ['GFA00'],
      printerModels: ['Bambu Lab X1 Carbon']
    }),
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
  const a1MachineProfile: SlicingPresetSummary = {
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

// Issue #68: a 3MF project filament slot used to pick its preset by matching the
// baked name — and, failing that, by substring-matching its TYPE into preset names.
const projectQuery = {
  presetName: null as string | null,
  filamentType: null as string | null,
  isSupport: null as boolean | null,
  selectedMachineProfile,
  selectedPrinterModel: 'H2D'
}

test("a slot's own embedded preset wins over an identically-named installed preset", () => {
  const profiles = [
    filamentPreset({ id: 'project:filament:Bambu%20PLA%20Basic%20%40BBL%20H2D', source: 'custom', name: 'Bambu PLA Basic @BBL H2D', filamentType: 'PLA' }),
    filamentPreset({ id: 'builtin:filament:pla-basic-h2d', name: 'Bambu PLA Basic @BBL H2D', filamentType: 'PLA', compatiblePrinters: ['Bambu Lab H2D 0.4 nozzle'] })
  ]

  const resolution = resolveProjectFilamentPreset(profiles, { ...projectQuery, presetName: 'Bambu PLA Basic @BBL H2D', filamentType: 'PLA' })

  assert.equal(resolution.status, 'resolved')
  assert.equal(resolution.profileId, 'project:filament:Bambu%20PLA%20Basic%20%40BBL%20H2D')
  assert.equal(resolution.matchedBy, 'projectPreset')
  assert.equal(resolution.provenance, 'project')
})

test("another slot's embedded preset never stands in for this one", () => {
  const profiles = [
    filamentPreset({ id: 'project:filament:Other%20PLA', source: 'custom', name: 'Other PLA', filamentType: 'PLA' })
  ]

  const resolution = resolveProjectFilamentPreset(profiles, { ...projectQuery, presetName: 'Bambu PLA Basic @BBL H2D', filamentType: 'PLA' })

  assert.equal(resolution.status, 'unresolved')
})

// The old type fallback substring-matched "PLA" into preset NAMES, so a slot could
// land on a composite or a support filament that merely spelled it.
test('a plain PLA slot with an unknown preset name never lands on PLA-CF or a support PLA', () => {
  const profiles = [
    filamentPreset({ id: 'builtin:filament:pla-cf', name: 'Bambu PLA-CF @BBL H2D', filamentType: 'PLA-CF', filamentIsSupport: false }),
    filamentPreset({ id: 'builtin:filament:support-pla', name: 'Bambu Support For PLA @BBL H2D', filamentType: 'PLA', filamentIds: ['GFS02'], filamentIsSupport: true }),
    filamentPreset({ id: 'builtin:filament:pla-basic', name: 'Bambu PLA Basic @BBL H2D', filamentType: 'PLA', filamentIsSupport: false })
  ]

  const resolution = resolveProjectFilamentPreset(profiles, { ...projectQuery, presetName: 'Some Vendor PLA', filamentType: 'PLA' })

  assert.equal(resolution.status, 'resolved')
  assert.equal(resolution.profileId, 'builtin:filament:pla-basic')
  assert.equal(resolution.matchedBy, 'filamentType')
})

// Cross-family switch (an X1C project sliced on an H2D): the project's own preset is
// filtered out of the catalogue, so BambuStudio's machine default takes the slot.
test("the target machine's declared default filament covers a slot whose preset is gone", () => {
  const profiles = [
    filamentPreset({ id: 'builtin:filament:pla-basic-h2d', name: 'Bambu PLA Basic @BBL H2D', filamentType: 'PLA', filamentIsSupport: false }),
    filamentPreset({ id: 'builtin:filament:petg-hf-h2d', name: 'Bambu PETG HF @BBL H2D', filamentType: 'PETG', filamentIsSupport: false })
  ]
  const machineProfile: SlicingPresetSummary = {
    ...selectedMachineProfile,
    defaultFilamentProfiles: ['Bambu PLA Basic @BBL H2D', 'Bambu PETG HF @BBL H2D']
  }

  const resolution = resolveProjectFilamentPreset(profiles, {
    ...projectQuery,
    presetName: 'Bambu PETG HF @BBL X1C',
    filamentType: 'PETG',
    selectedMachineProfile: machineProfile
  })

  assert.equal(resolution.status, 'resolved')
  assert.equal(resolution.profileId, 'builtin:filament:petg-hf-h2d')
  assert.equal(resolution.matchedBy, 'machineDefault')
})

// A support slot must not inherit a model filament: it would print supports in model
// material, which is the same class of error as the PLA-S filter that hid every
// support preset in issue #66.
test('a support slot refuses a model-filament machine default', () => {
  const profiles = [
    filamentPreset({ id: 'builtin:filament:pla-basic-h2d', name: 'Bambu PLA Basic @BBL H2D', filamentType: 'PLA', filamentIsSupport: false })
  ]
  const machineProfile: SlicingPresetSummary = { ...selectedMachineProfile, defaultFilamentProfiles: ['Bambu PLA Basic @BBL H2D'] }

  const resolution = resolveProjectFilamentPreset(profiles, {
    ...projectQuery,
    presetName: 'Bambu Support For PLA @BBL X1C',
    filamentType: 'PLA',
    isSupport: true,
    selectedMachineProfile: machineProfile
  })

  assert.equal(resolution.status, 'unresolved')
})

test('a support slot resolves to a support preset typed by its base polymer', () => {
  const profiles = [
    filamentPreset({ id: 'builtin:filament:pla-basic-h2d', name: 'Bambu PLA Basic @BBL H2D', filamentType: 'PLA', filamentIsSupport: false }),
    filamentPreset({ id: 'builtin:filament:support-pla-h2d', name: 'Bambu Support For PLA @BBL H2D', filamentType: 'PLA', filamentIds: ['GFS02'], filamentIsSupport: true })
  ]

  const resolution = resolveProjectFilamentPreset(profiles, {
    ...projectQuery,
    presetName: 'Bambu Support For PLA @BBL X1C',
    filamentType: 'PLA',
    isSupport: true
  })

  assert.equal(resolution.status, 'resolved')
  assert.equal(resolution.profileId, 'builtin:filament:support-pla-h2d')
})

// A workspace preset derived from "Bambu PLA Basic" inherits its `filament_id`, so an AMS tray
// reporting GFA00 matched the derivative and the built-in equally and the winner fell to catalogue
// order — which lists customs first. Choosing "Bambu PLA Basic - Cryogrip Pro Glacier" applies
// settings the user tuned for another situation to a slice they only said "this is what's in my
// AMS" about. BambuStudio's AMSMaterialsSetting::get_filament_by_id skips any preset that is not its
// own base before comparing filament_id, which is the rule mirrored here.
test('a tray never resolves to a preset DERIVED from the product it names', () => {
  const derived = filamentPreset({
    id: 'custom:b176997e',
    source: 'custom',
    name: 'Bambu PLA Basic - Cryogrip Pro Glacier @BBL H2D 0.6 nozzle',
    filamentIds: ['GFA00'],
    filamentType: 'PLA',
    derivedFromPresetName: 'Bambu PLA Basic @BBL H2D',
    compatiblePrinters: ['Bambu Lab H2D 0.4 nozzle']
  })
  const builtin = filamentPreset({
    id: 'builtin:filament:pla-basic',
    name: 'Bambu PLA Basic @BBL H2D',
    filamentIds: ['GFA00'],
    filamentType: 'PLA'
  })
  // Derivative first, and machine-targeted, so only the base rule can save this.
  const resolution = resolveFilamentPreset([derived, builtin], {
    ...baseQuery, trayName: 'PLA Black', trayInfoIdx: 'GFA00', trayFilamentType: 'PLA'
  })

  assert.equal(resolution.status, 'resolved')
  assert.equal(resolution.status === 'resolved' && resolution.profileId, 'builtin:filament:pla-basic')
  assert.equal(resolution.status === 'resolved' && resolution.matchedBy, 'filamentId')
})

test('a workspace filament with its OWN filament id still resolves — only derivatives are excluded', () => {
  const ownProduct = filamentPreset({
    id: 'custom:520dea35',
    source: 'custom',
    name: 'Polymaker Panchroma PLA',
    filamentIds: ['Pfbbaea8'],
    filamentType: 'PLA'
  })

  const resolution = resolveFilamentPreset([ownProduct], {
    ...baseQuery, trayName: 'Panchroma', trayInfoIdx: 'Pfbbaea8', trayFilamentType: 'PLA'
  })

  assert.equal(resolution.status, 'resolved')
  assert.equal(resolution.status === 'resolved' && resolution.profileId, 'custom:520dea35')
})

test('an explicit spool pin still selects a derivative — the excluded path is only the derived one', () => {
  const derived = filamentPreset({
    id: 'custom:b176997e',
    source: 'custom',
    name: 'Bambu PLA Basic - Cryogrip Pro Glacier',
    filamentIds: ['GFA00'],
    filamentType: 'PLA',
    derivedFromPresetName: 'Bambu PLA Basic @BBL H2D'
  })
  const builtin = filamentPreset({ id: 'builtin:filament:pla-basic', name: 'Bambu PLA Basic @BBL H2D', filamentIds: ['GFA00'], filamentType: 'PLA' })

  const resolution = resolveFilamentPreset([derived, builtin], {
    ...baseQuery,
    trayInfoIdx: 'GFA00',
    trayFilamentType: 'PLA',
    pinnedPresetName: 'Bambu PLA Basic - Cryogrip Pro Glacier'
  })

  assert.equal(resolution.status === 'resolved' && resolution.profileId, 'custom:b176997e')
  assert.equal(resolution.status === 'resolved' && resolution.matchedBy, 'pinnedPreset')
})

// Compatibility is a FILTER now, not a score. A preset declaring a different printer is rejected
// outright, so it cannot win on catalogue order when the identity signals tie — which is what
// happened while the machine axis merely outranked it. BambuStudio never offers an incompatible
// preset at all; it evaluates `compatible_printers` when loading the bundle.
test('a preset declaring a different printer is rejected, not outranked', () => {
  const h2dMachine: SlicingPresetSummary = {
    id: 'builtin:machine:h2d-0.4', source: 'builtin', kind: 'machine', name: 'Bambu Lab H2D 0.4 nozzle'
  }
  // The X1C preset is FIRST, so only a rejection (not a tiebreak) can keep it from winning.
  const profiles = [
    filamentPreset({ id: 'builtin:filament:x1c', name: 'Bambu PLA Basic @BBL X1C', filamentType: 'PLA', filamentIds: ['GFA00'], compatiblePrinters: ['Bambu Lab X1 Carbon 0.4 nozzle'] }),
    filamentPreset({ id: 'builtin:filament:h2d', name: 'Bambu PLA Basic @BBL H2D', filamentType: 'PLA', filamentIds: ['GFA00'], compatiblePrinters: ['Bambu Lab H2D 0.4 nozzle'] })
  ]

  const resolution = resolveFilamentPreset(profiles, {
    ...baseQuery, trayInfoIdx: 'GFA00', trayFilamentType: 'PLA', selectedMachineProfile: h2dMachine, selectedPrinterModel: 'H2D'
  })

  assert.equal(resolution.status === 'resolved' && resolution.profileId, 'builtin:filament:h2d')
})

// A vendor may reuse another's filament id — the live catalogue has QIDI presets carrying Bambu's
// GFA00 — so the id alone cannot be trusted without the compatibility filter behind it.
test('another vendor reusing the same filament id is rejected for a Bambu machine', () => {
  const h2dMachine: SlicingPresetSummary = {
    id: 'builtin:machine:h2d-0.4', source: 'builtin', kind: 'machine', name: 'Bambu Lab H2D 0.4 nozzle'
  }
  const profiles = [
    filamentPreset({ id: 'builtin:filament:qidi', name: 'QIDI PLA Rapido @Qidi', filamentType: 'PLA', filamentIds: ['GFA00'], compatiblePrinters: ['Qidi X-Plus 0.4 nozzle', 'Qidi X-Max 0.4 nozzle'] }),
    filamentPreset({ id: 'builtin:filament:h2d', name: 'Bambu PLA Basic @BBL H2D', filamentType: 'PLA', filamentIds: ['GFA00'], compatiblePrinters: ['Bambu Lab H2D 0.4 nozzle'] })
  ]

  const resolution = resolveFilamentPreset(profiles, {
    ...baseQuery, trayInfoIdx: 'GFA00', trayFilamentType: 'PLA', selectedMachineProfile: h2dMachine, selectedPrinterModel: 'H2D'
  })

  assert.equal(resolution.status === 'resolved' && resolution.profileId, 'builtin:filament:h2d')
})

// Regression: switching printer model made every Bambu material lose its brand. Compatibility
// became a filter, and `matchesCompatiblePrinters` answers false when there is no machine to judge
// against — so every preset declaring a printer (all of them) was vetoed and nothing resolved. The
// session seeds picks before a machine is known, and a model switch re-renders before the new
// machine profile arrives, so this path is hit in normal use.
test('resolves without a machine profile rather than rejecting everything', () => {
  const profiles = [
    filamentPreset({
      id: 'builtin:filament:pla-a1',
      name: 'Bambu PLA Basic @BBL A1',
      filamentIds: ['GFA00'],
      filamentType: 'PLA',
      compatiblePrinters: ['Bambu Lab A1 0.4 nozzle']
    })
  ]

  for (const selectedPrinterModel of ['', 'A1', 'unknown']) {
    const resolution = resolveFilamentPreset(profiles, {
      trayName: '', trayInfoIdx: 'GFA00', trayFilamentType: 'PLA',
      selectedMachineProfile: null,
      selectedPrinterModel
    })
    assert.equal(resolution.status, 'resolved', `model ${JSON.stringify(selectedPrinterModel)} should still resolve`)
    assert.equal(resolution.status === 'resolved' && resolution.profileId, 'builtin:filament:pla-a1')
  }
})

// A 3MF's `filament_settings_id` is the ALIAS BambuStudio displays ("Bambu PETG HF"); the installed
// preset carries its machine suffix ("Bambu PETG HF @BBL H2D 0.4 nozzle"). Comparing names only, a
// project filament never matched the catalogue and fell through to the machine default — turning a
// PETG project's material into Bambu PLA Basic.
test('a project filament matches an installed preset by alias, not just by exact name', () => {
  const petg = filamentPreset({
    id: 'builtin:filament:petg-hf-h2d',
    name: 'Bambu PETG HF @BBL H2D 0.4 nozzle',
    filamentType: 'PETG',
    filamentVendor: 'Bambu Lab'
  })
  const plaDefault = filamentPreset({
    id: 'builtin:filament:pla-basic-h2d', name: 'Bambu PLA Basic @BBL H2D', filamentType: 'PLA', filamentVendor: 'Bambu Lab'
  })

  const resolution = resolveProjectFilamentPreset([petg, plaDefault], {
    presetName: 'Bambu PETG HF',
    filamentType: 'PETG',
    isSupport: false,
    selectedMachineProfile: null,
    selectedPrinterModel: ''
  })

  assert.equal(resolution.status === 'resolved' && resolution.profileId, 'builtin:filament:petg-hf-h2d')
  assert.equal(resolution.status === 'resolved' && resolution.matchedBy, 'presetName')
})

// The file NAMES its preset (`filament_settings_id`), so this is a lookup, not a guess —
// BambuStudio's own load path is `find_preset_internal(original_name)` with no scoring at all
// (`PresetCollection::load_external_preset`). Pinning it here because the danger is structural
// rather than hypothetical: the name falls through to the ranked matcher, where `filamentId`
// outranks `presetName`, and a workspace preset that INHERITS the built-in carries the SAME
// filament id. If the exact-name step ever stops firing first, these two tie and catalogue order
// decides — and the project then diffs against the wrong basis and reports settings the user never
// changed.
test('a project slot binds to the installed preset it names, not an inheriting variant', () => {
  const profiles = [
    filamentPreset({
      id: 'custom:820e4ffc-1f59-461b-8bc6-472ab6c33844',
      source: 'custom',
      name: 'Bambu PLA Basic @BBL H2D - 55 degree plate',
      filamentIds: ['GFA00'],
      filamentType: 'PLA',
      compatiblePrinters: ['Bambu Lab H2D 0.4 nozzle']
    }),
    filamentPreset({
      id: 'builtin:filament:h2d-pla-basic',
      name: 'Bambu PLA Basic @BBL H2D',
      filamentIds: ['GFA00'],
      filamentType: 'PLA',
      compatiblePrinters: ['Bambu Lab H2D 0.4 nozzle']
    })
  ]

  const resolution = resolveProjectFilamentPreset(profiles, {
    presetName: 'Bambu PLA Basic @BBL H2D',
    filamentType: 'PLA',
    isSupport: false,
    selectedMachineProfile,
    selectedPrinterModel: 'H2D'
  })

  assert.equal(resolution.status, 'resolved')
  assert.equal(resolution.profileId, 'builtin:filament:h2d-pla-basic')
})

// The shipped failure, reduced: the app fed the resolver the DISPLAY name, whose `@BBL…` suffix
// the index parser strips. No installed preset is literally called "Bambu PLA Basic", so the exact
// lookup could never fire and the ranked path chose between two presets that tie on filament id —
// catalogue order handing it the workspace variant, which the settings dialog then diffed against.
test('the display name cannot identify a preset — the raw filament_settings_id can', () => {
  const profiles = [
    filamentPreset({
      id: 'custom:c1e90d62-b5bd-46eb-9766-ef5b066985d5',
      source: 'custom',
      name: 'Bambu PLA Basic @BBL H2D - 55 degree plate',
      filamentIds: ['GFA00'],
      filamentType: 'PLA',
      compatiblePrinters: ['Bambu Lab H2D 0.4 nozzle']
    }),
    filamentPreset({
      id: 'builtin:filament:h2d-pla-basic',
      name: 'Bambu PLA Basic @BBL H2D',
      filamentIds: ['GFA00'],
      filamentType: 'PLA',
      compatiblePrinters: ['Bambu Lab H2D 0.4 nozzle']
    })
  ]
  const slot = { filamentType: 'PLA', isSupport: false, selectedMachineProfile, selectedPrinterModel: 'H2D' }

  const raw = resolveProjectFilamentPreset(profiles, { ...slot, presetName: 'Bambu PLA Basic @BBL H2D' })
  assert.equal(raw.status, 'resolved')
  assert.equal(raw.profileId, 'builtin:filament:h2d-pla-basic')
  assert.equal(raw.matchedBy, 'presetName')

  // The catalogue order the API serves — customs first — is what decided it before.
  assert.equal(profiles[0]!.source, 'custom')
})
