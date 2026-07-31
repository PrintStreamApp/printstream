/**
 * `filament_settings_id` must never carry an EMPTY name.
 *
 * It is the name BambuStudio and the CLI look a filament preset up by. An empty entry resolves to
 * nothing, so BambuStudio mints a project-embedded preset from its BARE CONFIG DEFAULTS (max
 * volumetric speed 2, flow ratio 1, `compatible_printers` All) and names it `(<project>.3mf)` —
 * literally the empty name plus the project suffix, with `1(<project>.3mf)` for a second one. It
 * then writes that junk preset into the file as a `Metadata/filament_settings_N.config` sidecar and
 * re-embeds it on every subsequent save, so one bad save follows the project forever. Reported from
 * a real file whose slots 2 and 3 read `1(test.3mf)` / `(test.3mf)`.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyFilamentList } from './bake-documents'
import type { SceneEditFilament } from '../slicing'

const filament = (overrides: Partial<SceneEditFilament>): SceneEditFilament =>
  ({ color: '#FFFFFF', sourceIndex: 0, ...overrides }) as SceneEditFilament

/** Every slot's name, for a project whose settings JSON is `base`. */
function settingsIdsFor(base: Record<string, unknown>, filaments: SceneEditFilament[]): unknown {
  return JSON.parse(applyFilamentList(JSON.stringify(base), filaments)).filament_settings_id
}

test('a from-scratch project never writes an empty preset name for an unresolved slot', () => {
  // No filament arrays at all (an editor-born project), so there is no source slot to inherit a
  // name from — the case that produced `(test.3mf)` in BambuStudio.
  const ids = settingsIdsFor({}, [
    filament({ settingsId: 'Bambu PLA Basic @BBL A1' }),
    filament({}),
    filament({})
  ]) as string[]
  assert.ok(Array.isArray(ids), 'the slot names must be written as an array')
  assert.equal(ids.length, 3)
  for (const [index, id] of ids.entries()) {
    assert.notEqual(id, '', `slot ${index + 1} must not carry an empty preset name`)
  }
  // Both unresolved slots clone slot 0's physics (sourceIndex 0), so they carry its preset name —
  // name and physics describe one material.
  assert.deepEqual(ids, [
    'Bambu PLA Basic @BBL A1',
    'Bambu PLA Basic @BBL A1',
    'Bambu PLA Basic @BBL A1'
  ])
})

test('a slot keeps its own resolved preset even when a later slot is unresolved', () => {
  // Guards the fallback from over-reaching: it must fill only the gaps.
  const ids = settingsIdsFor({}, [
    filament({ settingsId: 'Bambu PETG HF @BBL A1' }),
    filament({ settingsId: 'Bambu PLA Basic @BBL A1', sourceIndex: 1 }),
    filament({ sourceIndex: 1 })
  ]) as string[]
  assert.deepEqual(ids, [
    'Bambu PETG HF @BBL A1',
    'Bambu PLA Basic @BBL A1',
    'Bambu PLA Basic @BBL A1'
  ])
})

test('an unresolved slot falls back to the name of the slot it clones from', () => {
  // The base project has two PETG slots; the user adds a third whose material never resolved.
  const ids = settingsIdsFor(
    {
      filament_colour: ['#515151', '#000000'],
      filament_type: ['PETG', 'PETG'],
      filament_settings_id: ['Bambu PETG HF @BBL A1', 'Bambu PETG HF @BBL A1']
    },
    [
      filament({ settingsId: 'Bambu PLA Basic @BBL A1', sourceIndex: 0 }),
      filament({ sourceIndex: 1 }),
      filament({ sourceIndex: 1 })
    ]
  ) as string[]
  assert.deepEqual(ids, [
    'Bambu PLA Basic @BBL A1',
    'Bambu PETG HF @BBL A1',
    'Bambu PETG HF @BBL A1'
  ])
})

/**
 * `filament_ids` is BambuStudio's BINDING key and must describe the same preset as the NAME beside
 * it. Reproduces Ryan's real project: an ABS build (GFB00 = Bambu ABS, GFS06 = Bambu Support for
 * ABS) switched to PETG + PLA. Before the fix every save kept the ABS ids under PETG/PLA names, and
 * BambuStudio fabricated a defaults-only project preset per slot named `(<project>.3mf)`.
 */
const ABS_PROJECT = {
  filament_colour: ['#515151', '#000000', '#545454'],
  filament_type: ['ABS', 'ABS', 'ABS'],
  filament_ids: ['GFB00', 'GFB00', 'GFS06'],
  filament_settings_id: ['Bambu ABS @BBL H2D', 'Bambu ABS @BBL H2D', 'Bambu Support for ABS @BBL H2D']
}

function bake(base: Record<string, unknown>, filaments: SceneEditFilament[]): Record<string, unknown> {
  return JSON.parse(applyFilamentList(JSON.stringify(base), filaments))
}

test('switching material writes the new preset\'s filament id, not the old material\'s', () => {
  const out = bake(ABS_PROJECT, [
    filament({ type: 'PETG', settingsId: 'Bambu PETG HF @BBL H2D 0.4 nozzle', filamentId: 'GFG02', sourceIndex: 0 }),
    filament({ type: 'PETG', settingsId: 'Bambu PETG HF @BBL H2D 0.4 nozzle', filamentId: 'GFG02', sourceIndex: 1 }),
    filament({ type: 'PLA', settingsId: 'Bambu PLA Basic @BBL H2D', filamentId: 'GFA00', sourceIndex: 2 })
  ])
  // Exactly what BambuStudio's own save of this project produces.
  assert.deepEqual(out.filament_ids, ['GFG02', 'GFG02', 'GFA00'])
  assert.deepEqual(out.filament_settings_id, [
    'Bambu PETG HF @BBL H2D 0.4 nozzle',
    'Bambu PETG HF @BBL H2D 0.4 nozzle',
    'Bambu PLA Basic @BBL H2D'
  ])
})

test('a changed slot with no resolvable id reports unknown rather than the old material\'s id', () => {
  // BambuStudio emplaces `preset.filament_id`, which is "" when the preset declares none — an empty
  // entry keeps the array positional. Keeping GFB00 here would tell BambuStudio the slot is ABS.
  const out = bake(ABS_PROJECT, [
    filament({ type: 'PETG', settingsId: 'Some Third-Party PETG', sourceIndex: 0 }),
    filament({ type: 'ABS', sourceIndex: 1 }),
    filament({ type: 'ABS', sourceIndex: 2 })
  ])
  const ids = out.filament_ids as string[]
  assert.equal(ids[0], '', 'a changed slot must not inherit the previous material\'s id')
  // Untouched slots keep theirs.
  assert.deepEqual(ids.slice(1), ['GFB00', 'GFS06'])
})

test('an untouched project keeps its filament ids exactly', () => {
  const out = bake(ABS_PROJECT, [
    filament({ type: 'ABS', settingsId: 'Bambu ABS @BBL H2D', filamentId: 'GFB00', sourceIndex: 0 }),
    filament({ type: 'ABS', settingsId: 'Bambu ABS @BBL H2D', filamentId: 'GFB00', sourceIndex: 1 }),
    filament({ type: 'ABS', settingsId: 'Bambu Support for ABS @BBL H2D', filamentId: 'GFS06', sourceIndex: 2 })
  ])
  assert.deepEqual(out.filament_ids, ['GFB00', 'GFB00', 'GFS06'])
})

/**
 * A material change must leave the project SELF-CONTAINED. Dropping the old material's physics and
 * leaning on slice-time re-derivation is true for our slicer and false for BambuStudio: it opens a
 * project whose slots have no values, cannot name a preset for them, and shows each as an unnamed
 * `(<project>.3mf)` preset of bare defaults. Confirmed against a real affected file — restoring
 * exactly these keys made BambuStudio show all three materials correctly.
 */
test('a resolved preset authors the new material\'s physics instead of dropping it', () => {
  const out = bake(
    {
      ...ABS_PROJECT,
      nozzle_temperature: ['270', '270', '270'],
      filament_flow_ratio: ['0.9', '0.9', '0.9']
    },
    [
      filament({ type: 'PETG', settingsId: 'Bambu PETG HF @BBL H2D 0.4 nozzle', filamentId: 'GFG02', sourceIndex: 0, config: { nozzle_temperature: ['245'], filament_flow_ratio: ['0.95'] } }),
      filament({ type: 'PETG', settingsId: 'Bambu PETG HF @BBL H2D 0.4 nozzle', filamentId: 'GFG02', sourceIndex: 1, config: { nozzle_temperature: ['245'], filament_flow_ratio: ['0.95'] } }),
      filament({ type: 'PLA', settingsId: 'Bambu PLA Basic @BBL H2D', filamentId: 'GFA00', sourceIndex: 2, config: { nozzle_temperature: ['220'], filament_flow_ratio: ['0.98'] } })
    ]
  )
  // The keys SURVIVE, carrying the new materials' values — not the ABS ones, and not absent.
  assert.deepEqual(out.nozzle_temperature, ['245', '245', '220'])
  assert.deepEqual(out.filament_flow_ratio, ['0.95', '0.95', '0.98'])
})

test('without a resolved preset the old drop behaviour is unchanged', () => {
  // A host that cannot resolve the presets must be no worse off than before, never left with the
  // OLD material's temperatures under the new material's name.
  const out = bake(
    { ...ABS_PROJECT, nozzle_temperature: ['270', '270', '270'] },
    [
      filament({ type: 'PETG', settingsId: 'Bambu PETG HF @BBL H2D 0.4 nozzle', filamentId: 'GFG02', sourceIndex: 0 }),
      filament({ type: 'PETG', settingsId: 'Bambu PETG HF @BBL H2D 0.4 nozzle', filamentId: 'GFG02', sourceIndex: 1 }),
      filament({ type: 'PLA', settingsId: 'Bambu PLA Basic @BBL H2D', filamentId: 'GFA00', sourceIndex: 2 })
    ]
  )
  assert.equal('nozzle_temperature' in out, false, 'the old material\'s physics must not survive unauthored')
})

test('an untouched slot keeps the project\'s own values, not the preset\'s', () => {
  // Slot 2 did not change material, so its in-project value stands even though a sibling is
  // re-authored — a save must not quietly normalise settings the user did not touch.
  const out = bake(
    {
      filament_colour: ['#1', '#2'],
      filament_type: ['ABS', 'ABS'],
      filament_ids: ['GFB00', 'GFB00'],
      filament_settings_id: ['Bambu ABS @BBL H2D', 'Bambu ABS @BBL H2D'],
      nozzle_temperature: ['270', '265']
    },
    [
      filament({ type: 'PETG', settingsId: 'Bambu PETG HF @BBL H2D 0.4 nozzle', filamentId: 'GFG02', sourceIndex: 0, config: { nozzle_temperature: ['245'] } }),
      filament({ type: 'ABS', settingsId: 'Bambu ABS @BBL H2D', filamentId: 'GFB00', sourceIndex: 1, config: { nozzle_temperature: ['999'] } })
    ]
  )
  assert.deepEqual(out.nozzle_temperature, ['245', '265'])
})

test('saving a project whose physics was dropped restores it', () => {
  // The repair for `filamentPhysics`: an older save kept the names and dropped every value, so
  // BambuStudio showed unnamed default presets. Reopening and saving writes the materials back.
  // Regression-guarded because `rebindProjectFilamentPhysics` alone returns such a project UNCHANGED
  // (it only rewrites keys still present) — this needs `restoreFilamentPhysics`.
  const out = bake(
    {
      filament_colour: ['#1', '#2'],
      filament_type: ['PETG', 'PLA'],
      filament_ids: ['GFG02', 'GFA00'],
      filament_settings_id: ['Bambu PETG HF @BBL H2D 0.4 nozzle', 'Bambu PLA Basic @BBL H2D'],
      // Survives the physics drop, and is what declares 2 variants per slot — the width a
      // variant-scoped option is restored at. Without it the restore writes 1 column, correctly.
      filament_extruder_variant: ['Direct Drive Standard', 'Direct Drive High Flow', 'Direct Drive Standard', 'Direct Drive High Flow']
    },
    [
      filament({ type: 'PETG', settingsId: 'Bambu PETG HF @BBL H2D 0.4 nozzle', filamentId: 'GFG02', sourceIndex: 0, config: { nozzle_temperature: ['245', '245'], filament_density: ['1.28'] } }),
      filament({ type: 'PLA', settingsId: 'Bambu PLA Basic @BBL H2D', filamentId: 'GFA00', sourceIndex: 1, config: { nozzle_temperature: ['220', '220'], filament_density: ['1.26'] } })
    ]
  )
  // Widths follow BambuStudio's option definition x this project's declared variants — NOT the shape
  // of the preset that was resolved. `nozzle_temperature` is variant-scoped (2 per slot here),
  // `filament_density` is not (1 per slot), matching a real dual-nozzle project.
  assert.deepEqual(out.nozzle_temperature, ['245', '245', '220', '220'])
  assert.deepEqual(out.filament_density, ['1.28', '1.26'])
})
