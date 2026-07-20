import assert from 'node:assert/strict'
import test from 'node:test'
import { buildFilamentSlotCoverage } from './filament-slot-coverage.js'

const CATALOGUE = new Set([
  'Bambu PETG Basic @BBL H2D 0.4 nozzle',
  'Bambu Support For PLA/PETG @BBL H2D',
  'Generic PLA'
])

const hasBuiltinPreset = async (name: string) => CATALOGUE.has(name)

// The exact field shape: a 2-filament project where slot 1 stays on the project's
// own preset (no file) and slot 2 uses a builtin. This used to emit ONE path for
// TWO slots — BambuStudio broadcast the support preset onto the PETG slot (210°C
// for PETG) and then segfaulted the loader with exit 139 (issue #66).
test('a slot left on the project preset is covered from the 3MF, not dropped', async () => {
  const paths = await buildFilamentSlotCoverage({
    slots: [
      { projectFilamentId: 1, profileId: null },
      { projectFilamentId: 2, profileId: 'builtin:filament:support' }
    ],
    requestedProfileIds: new Set(['builtin:filament:support']),
    embeddedPresetNames: ['Bambu PETG Basic @BBL H2D 0.4 nozzle', 'Bambu Support For PLA/PETG @BBL H2D'],
    hasBuiltinPreset
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
    hasBuiltinPreset
  })

  assert.deepEqual(paths, [{ origin: 'requested', profileId: 'builtin:filament:petg' }])
})

test('a slot whose 3MF name resolves to nothing is padded with Generic PLA, keeping the count', async () => {
  const paths = await buildFilamentSlotCoverage({
    slots: [{ projectFilamentId: 1, profileId: null }, { projectFilamentId: 2, profileId: null }],
    requestedProfileIds: new Set<string>(),
    // A poisoned/unknown display name in slot 1 — the shape that produced the
    // "names filament \"Bambu PETG Basic\"" failures.
    embeddedPresetNames: ['Bambu PETG Basic', 'Bambu Support For PLA/PETG @BBL H2D'],
    hasBuiltinPreset
  })

  assert.equal(paths?.length, 2)
  assert.deepEqual(paths, [
    { origin: 'builtin', name: 'Generic PLA' },
    { origin: 'builtin', name: 'Bambu Support For PLA/PETG @BBL H2D' }
  ])
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
    hasBuiltinPreset
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
    hasBuiltinPreset: async () => false
  })

  assert.equal(paths, null)
})

test('the 3MF slot count wins when the request carries fewer mappings than the project has slots', async () => {
  const paths = await buildFilamentSlotCoverage({
    slots: [{ projectFilamentId: 1, profileId: 'builtin:filament:petg' }],
    requestedProfileIds: new Set(['builtin:filament:petg']),
    embeddedPresetNames: ['Bambu PETG Basic @BBL H2D 0.4 nozzle', 'Bambu Support For PLA/PETG @BBL H2D', 'Generic PLA'],
    hasBuiltinPreset
  })

  assert.equal(paths?.length, 3)
  assert.deepEqual(paths?.[0], { origin: 'requested', profileId: 'builtin:filament:petg' })
})

test('a project with no filament slots loads no filaments', async () => {
  const paths = await buildFilamentSlotCoverage({
    slots: [],
    requestedProfileIds: new Set<string>(),
    embeddedPresetNames: [],
    hasBuiltinPreset
  })

  assert.equal(paths, null)
})
