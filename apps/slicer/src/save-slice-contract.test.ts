/**
 * Split-brain contract tests (audit finding F4 / stage S5).
 *
 * Several behaviours are deliberately split across the SAVE half (the shared bake) and the SLICE
 * half (this service), each doing the opposite of the other on purpose. They are correct only while
 * both halves stay in step, and nothing but prose enforced that — so a change to one half composed
 * wrongly with the other and produced silently bad G-code rather than a failure.
 *
 * These tests hold the two halves against each other. They deliberately import BOTH sides: if that
 * ever looks like an odd dependency for a slicer test, that IS the point.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyFilamentList, applyObjectProcessOverridesXml, rekeyObjectProcessOverrides } from '@printstream/shared/three-mf'
import { retargetProjectSettingsToMachine } from '@printstream/shared'
import { buildFilamentMapArgs } from './filament-map-args.js'
import { assertSupportedEmbeddedMachineSwitch, shouldRetargetEmbeddedMachine } from './machine-switch-guard.js'
import { COMPLETE_SETTINGS_SENTINEL_KEYS } from './project-settings-fallback.js'

/** A structurally complete project config, of the shape a real BambuStudio save produces. */
const completeSettings = () => JSON.stringify({
  printable_area: ['0x0', '256x0', '256x256', '0x256'],
  layer_height: '0.2',
  nozzle_temperature: ['220', '220'],
  nozzle_temperature_initial_layer: ['230', '230'],
  filament_type: ['PLA', 'ABS'],
  filament_settings_id: ['Bambu PLA Basic @BBL X1C', 'Bambu ABS @BBL X1C'],
  filament_colour: ['#FFFFFF', '#000000'],
  filament_flow_ratio: ['0.98', '0.95']
})

test('a material change drops exactly the sentinel the slicer repairs on', () => {
  // The save DROPS the old material's physics rather than cloning it, because cloning would leave
  // the project "PETG by name, ABS by temperature". It relies on the slicer noticing and
  // re-deriving. The two halves agree only if the dropped set includes the key the slicer checks.
  const changed = applyFilamentList(completeSettings(), [
    { color: '#FFFFFF', type: 'PLA', settingsId: 'Bambu PLA Basic @BBL X1C', sourceIndex: 0 },
    // Slot 2 changes material: ABS -> PETG.
    { color: '#00FF00', type: 'PETG', settingsId: 'Bambu PETG HF @BBL X1C', sourceIndex: 1 }
  ])
  const record = JSON.parse(changed) as Record<string, unknown>

  const missing = COMPLETE_SETTINGS_SENTINEL_KEYS.filter((key) => record[key] === undefined)
  assert.ok(
    missing.includes('nozzle_temperature'),
    'the save must drop nozzle_temperature so the slicer knows to re-derive the new material\'s physics'
  )
  // The identity the re-derivation reads from must survive the drop, or there is nothing to
  // rebuild the physics FROM and the slice falls back to a generic preset.
  assert.deepEqual(record.filament_settings_id, ['Bambu PLA Basic @BBL X1C', 'Bambu PETG HF @BBL X1C'])
  assert.deepEqual(record.filament_colour, ['#FFFFFF', '#00FF00'], 'the user\'s colours are identity, not physics')
})

test('no material change leaves the config complete, so an ordinary save never triggers repair', () => {
  // The other side of the contract: the repair path is expensive (a CLI --export-settings pass),
  // so a save that changed nothing about the materials must not look incomplete.
  const same = applyFilamentList(completeSettings(), [
    { color: '#FFFFFF', type: 'PLA', settingsId: 'Bambu PLA Basic @BBL X1C', sourceIndex: 0 },
    { color: '#000000', type: 'ABS', settingsId: 'Bambu ABS @BBL X1C', sourceIndex: 1 }
  ])
  const record = JSON.parse(same) as Record<string, unknown>
  const missing = COMPLETE_SETTINGS_SENTINEL_KEYS.filter((key) => record[key] === undefined)
  assert.deepEqual(missing, [], 'an unchanged material set must stay structurally complete')
})

test('a retarget keeps filament_nozzle_map one entry PER FILAMENT, and the CLI arg matches it', () => {
  // The nozzle-map pair: the save persists `filament_nozzle_map`, the slice RESETS it via the
  // machine retarget and then rewrites it from the request — and the engine trusts only
  // `--filament-map`. The map is per FILAMENT, never per extruder. Assigning the machine's
  // `physical_extruder_map` (one entry per EXTRUDER) straight across is finding M1: it only looks
  // right when filament count happens to equal extruder count, and otherwise BambuStudio reads a
  // filament's extruder past the end of the vector.
  const project = {
    filament_settings_id: ['A', 'B', 'C'],          // three filaments
    filament_nozzle_map: ['0', '0', '0'],
    nozzle_diameter: ['0.4'],
    physical_extruder_map: ['0']
  } as unknown as Parameters<typeof retargetProjectSettingsToMachine>[0]
  const dualNozzleMachine = {
    nozzle_diameter: ['0.4', '0.4'],
    physical_extruder_map: ['0', '1'],
    printer_model: 'Bambu Lab H2D'
  } as unknown as Parameters<typeof retargetProjectSettingsToMachine>[1]

  const next = retargetProjectSettingsToMachine(project, dualNozzleMachine, {
    printerSettingsId: 'Bambu Lab H2D 0.4 nozzle',
    printerModel: 'Bambu Lab H2D'
  })
  const map = next.filament_nozzle_map as string[]
  assert.equal(map.length, 3, 'one entry per FILAMENT — not per extruder, whatever the target has')
  for (const entry of map) {
    assert.ok(['0', '1'].includes(entry), `every slot must name an extruder the target HAS, got ${entry}`)
  }
  // Whatever the map says, the CLI argument must carry exactly it: the engine ignores the config
  // copy, so a disagreement here is a slice that silently uses different extruders than the file.
  assert.deepEqual(buildFilamentMapArgs(map), ['--filament-map', map.join(',')])
  assert.deepEqual(buildFilamentMapArgs(null), [], 'no assignment means no flag, not an empty one')
})

test('per-object overrides re-key onto the ids the bake wrote, whichever half applies them', () => {
  // Third F4 pair. Overrides are keyed by baked `object_id`, but a replaced object or an
  // independent copy is addressed by an identity that does not exist in the file yet — a retained
  // original id, or a negative placeholder. Only the bake knows what it became.
  //
  // The API re-keyed in its own later pass; the browser's local save handed the raw map to the bake
  // and never re-keyed at all, so saving to disk silently dropped the settings on any replaced or
  // copied object. The re-key now lives in the bake, where the map is known, and BOTH halves route
  // through this one function.
  const overrides = { '-7': { wall_loops: '4' }, '12': { sparse_infill_density: '25%' } }
  const moved = [{ originalObjectId: -7, bakedObjectId: 90 }]   // a copy's placeholder -> real id

  const rekeyed = rekeyObjectProcessOverrides(overrides, moved)
  assert.deepEqual(rekeyed['90'], { wall_loops: '4' }, 'the copy keeps its settings under its real id')
  assert.equal(rekeyed['-7'], undefined, 'the placeholder key must not survive into the file')
  assert.deepEqual(rekeyed['12'], { sparse_infill_density: '25%' }, 'untouched objects are left alone')

  // Idempotent, which is what lets the API keep its own later pass without double-applying.
  assert.deepEqual(rekeyObjectProcessOverrides(rekeyed, moved), rekeyed)
  // An object the bake did not move is not invented into existence.
  assert.deepEqual(rekeyObjectProcessOverrides(overrides, []), overrides)

  // And the re-keyed map is what actually reaches model_settings: the placeholder must never be
  // written as an <object id="-7"> nobody can address.
  const xml = '<config><object id="90"><metadata key="name" value="Copy"/></object></config>'
  const applied = applyObjectProcessOverridesXml(xml, rekeyed)
  assert.match(applied, /<metadata key="wall_loops" value="4"\/>/)
  assert.doesNotMatch(applied, /id="-7"/)
})

test('an H2 project missing its dual-nozzle shape is always either healed or refused, never sliced', () => {
  // Fourth F4 pair. The save heals H2 topology BEST-EFFORT (it re-authors from the bundled preset
  // when it can, and never blocks the save when it cannot); the slice HARD-FAILS what it cannot
  // heal. Those two only compose safely if the gap between them is empty — any input that reaches
  // the CLI with a missing H2 topology segfaults it resolving extruder variants.
  //
  // So the invariant is not "each half behaves sensibly" but: for an H2 target with the shape
  // missing, EXACTLY ONE of {heal, refuse} fires. Neither is a crash; both would be contradictory.
  const damaged = {
    printer_model: 'Bambu Lab H2D',
    physical_extruder_map: ['0'],          // single-nozzle remnants: the shape a bad save leaves
    default_nozzle_volume_type: ['Standard']
  }
  const healthy = {
    printer_model: 'Bambu Lab H2D',
    physical_extruder_map: ['0', '1'],
    extruder_nozzle_stats: ['a', 'b'],
    extruder_max_nozzle_count: ['1', '1'],
    default_nozzle_volume_type: ['Standard', 'Standard']
  }
  const inputFor = (projectSettings: Record<string, unknown>, withMachineProfile: boolean) => ({
    request: {
      sourceFileId: 'source',
      plate: 0,
      target: { mode: 'manualProfile', printerModel: 'H2D', printerProfileId: 'machine-profile' }
    },
    profileFiles: withMachineProfile ? [{ kind: 'machine', name: 'Bambu Lab H2D 0.4 nozzle' }] : [],
    projectSettings
  } as unknown as Parameters<typeof shouldRetargetEmbeddedMachine>[0])

  const verdict = (settings: Record<string, unknown>, withMachineProfile: boolean) => {
    const input = inputFor(settings, withMachineProfile)
    const heals = shouldRetargetEmbeddedMachine(input)
    let refuses = false
    try { assertSupportedEmbeddedMachineSwitch(input) } catch { refuses = true }
    return { heals, refuses }
  }

  // Damaged + a preset to author from: healed, and NOT refused — refusing a file we can repair
  // would be a false wall in front of a working slice.
  assert.deepEqual(verdict(damaged, true), { heals: true, refuses: false })
  // Damaged + nothing to author from: cannot heal, so it MUST refuse. This is the case that
  // reaches the CLI and segfaults if the guard ever stops firing.
  assert.deepEqual(verdict(damaged, false), { heals: false, refuses: true })
  // Intact: neither. Nothing to repair and nothing to complain about.
  assert.deepEqual(verdict(healthy, true), { heals: false, refuses: false })
  assert.deepEqual(verdict(healthy, false), { heals: false, refuses: false })
})
