import assert from 'node:assert/strict'
import test from 'node:test'
import { buildFilamentSlotCoverage } from './filament-slot-coverage.js'

const CATALOGUE = new Set([
  'Bambu PETG Basic @BBL H2D 0.4 nozzle',
  'Bambu Support For PLA/PETG @BBL H2D',
  'Generic PLA'
])

const hasBuiltinPreset = async (name: string) => CATALOGUE.has(name)

/** No workspace presets supplied: the default for every case that is about builtins. */
const noSupplied = new Map<string, string>()

// The exact field shape: a 2-filament project where slot 1 stays on the project's
// own preset (no file) and slot 2 uses a builtin. This used to emit ONE path for
// TWO slots: BambuStudio broadcast the support preset onto the PETG slot (210°C
// for PETG) and then segfaulted the loader with exit 139 (issue #66).
test('a slot left on the project preset is covered from the 3MF, not dropped', async () => {
  const paths = await buildFilamentSlotCoverage({
    slots: [
      { projectFilamentId: 1, profileId: null },
      { projectFilamentId: 2, profileId: 'builtin:filament:support' }
    ],
    requestedProfileIds: new Set(['builtin:filament:support']),
    embeddedPresetNames: ['Bambu PETG Basic @BBL H2D 0.4 nozzle', 'Bambu Support For PLA/PETG @BBL H2D'],
    hasBuiltinPreset,
    suppliedProfileIdsByName: noSupplied
  })

  assert.deepEqual(paths, [
    { origin: 'builtin', name: 'Bambu PETG Basic @BBL H2D 0.4 nozzle' },
    { origin: 'requested', profileId: 'builtin:filament:support' }
  ])
})

test("the request's own materialized preset wins over the 3MF's name, so per-material tunes ride along", async () => {
  const paths = await buildFilamentSlotCoverage({
    slots: [{ projectFilamentId: 1, profileId: 'builtin:filament:petg' }],
    requestedProfileIds: new Set(['builtin:filament:petg']),
    embeddedPresetNames: ['Bambu PETG Basic @BBL H2D 0.4 nozzle'],
    hasBuiltinPreset,
    suppliedProfileIdsByName: noSupplied
  })

  assert.deepEqual(paths, [{ origin: 'requested', profileId: 'builtin:filament:petg' }])
})

/**
 * The bug this replaced: a slot naming a preset we hold no file for was padded with Generic PLA.
 * `--load-filaments` presets WIN over the project's embedded values, so that did not "keep the
 * count" harmlessly, it sliced the user's material with Generic PLA's temperatures and flow and
 * stamped the output Generic PLA. Every workspace preset took this path, since none is a builtin.
 */
test('a slot whose 3MF name resolves to nothing collapses the list rather than substituting a material', async () => {
  const paths = await buildFilamentSlotCoverage({
    slots: [{ projectFilamentId: 1, profileId: null }, { projectFilamentId: 2, profileId: null }],
    // A poisoned/unknown display name in slot 1: the shape that produced the
    // "names filament \"Bambu PETG Basic\"" failures.
    embeddedPresetNames: ['Bambu PETG Basic', 'Bambu Support For PLA/PETG @BBL H2D'],
    requestedProfileIds: new Set<string>(),
    hasBuiltinPreset,
    suppliedProfileIdsByName: noSupplied
  })

  assert.equal(paths, null, "the project's own embedded settings drive every slot instead")
})

// The point of the supplied index: a workspace preset is reachable by the name the project gives
// its slot, exactly as a bundled one is. Without it, this slot fell through to the stand-in.
test('a slot naming a WORKSPACE preset is covered by the supplied file', async () => {
  const paths = await buildFilamentSlotCoverage({
    slots: [{ projectFilamentId: 1, profileId: null }],
    embeddedPresetNames: ['Bambu PLA Basic - Custom'],
    requestedProfileIds: new Set(['custom:filament:pla-basic-custom']),
    hasBuiltinPreset,
    suppliedProfileIdsByName: new Map([['Bambu PLA Basic - Custom', 'custom:filament:pla-basic-custom']])
  })

  assert.deepEqual(paths, [{ origin: 'requested', profileId: 'custom:filament:pla-basic-custom' }])
})

test('a supplied preset outranks a builtin of the same name, as a user preset does in Studio', async () => {
  const paths = await buildFilamentSlotCoverage({
    slots: [{ projectFilamentId: 1, profileId: null }],
    embeddedPresetNames: ['Generic PLA'],
    requestedProfileIds: new Set(['custom:filament:generic-pla']),
    hasBuiltinPreset,
    suppliedProfileIdsByName: new Map([['Generic PLA', 'custom:filament:generic-pla']])
  })

  assert.deepEqual(paths, [{ origin: 'requested', profileId: 'custom:filament:generic-pla' }])
})

test('slots are covered by their project filament id, not by mapping array order', async () => {
  const paths = await buildFilamentSlotCoverage({
    // Deliberately out of order.
    slots: [
      { projectFilamentId: 2, profileId: 'builtin:filament:support' },
      { projectFilamentId: 1, profileId: 'builtin:filament:petg' }
    ],
    requestedProfileIds: new Set(['builtin:filament:support', 'builtin:filament:petg']),
    embeddedPresetNames: ['a', 'b'],
    hasBuiltinPreset,
    suppliedProfileIdsByName: noSupplied
  })

  assert.deepEqual(paths, [
    { origin: 'requested', profileId: 'builtin:filament:petg' },
    { origin: 'requested', profileId: 'builtin:filament:support' }
  ])
})

// The invariant: never a SHORT list. With no Generic PLA to pad from, full
// coverage is impossible, so the whole list collapses and the project's own
// embedded config drives every slot instead.
test('coverage collapses to null rather than emitting a short list', async () => {
  const paths = await buildFilamentSlotCoverage({
    slots: [{ projectFilamentId: 1, profileId: null }, { projectFilamentId: 2, profileId: null }],
    requestedProfileIds: new Set<string>(),
    embeddedPresetNames: ['nope', 'also nope'],
    hasBuiltinPreset: async () => false,
    suppliedProfileIdsByName: noSupplied
  })

  assert.equal(paths, null)
})

test('the 3MF slot count wins when the request carries fewer mappings than the project has slots', async () => {
  const paths = await buildFilamentSlotCoverage({
    slots: [{ projectFilamentId: 1, profileId: 'builtin:filament:petg' }],
    requestedProfileIds: new Set(['builtin:filament:petg']),
    embeddedPresetNames: ['Bambu PETG Basic @BBL H2D 0.4 nozzle', 'Bambu Support For PLA/PETG @BBL H2D', 'Generic PLA'],
    hasBuiltinPreset,
    suppliedProfileIdsByName: noSupplied
  })

  assert.equal(paths?.length, 3)
  assert.deepEqual(paths?.[0], { origin: 'requested', profileId: 'builtin:filament:petg' })
})

test('a project with no filament slots loads no filaments', async () => {
  const paths = await buildFilamentSlotCoverage({
    slots: [],
    requestedProfileIds: new Set<string>(),
    embeddedPresetNames: [],
    hasBuiltinPreset,
    suppliedProfileIdsByName: noSupplied
  })

  assert.equal(paths, null)
})
