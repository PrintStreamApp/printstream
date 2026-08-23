/**
 * Changing the filament set must leave EVERY invariant satisfied, for every shape of change.
 *
 * This is the guarantee BambuStudio gets structurally: `set_num_filaments` and its siblings all end
 * in `update_multi_material_filament_presets`, so a caller cannot reach the sizing state without
 * the reconciler having run. `applyFilamentList` is our equivalent and has no such epilogue, and
 * three separate defects shipped from exactly that gap, each one "the count changed and something
 * did not follow it": `filament_self_index` left at its old length (a project BambuStudio refuses
 * to open), the flush matrix cloned so new pairs purged nothing, and the variant-scoped physics
 * dropped wholesale.
 *
 * Asserting the OUTCOME here rather than adding the epilogue is deliberate. With those three fixed,
 * an epilogue would be a refactor with nothing left to correct, and this states the property the
 * epilogue would have enforced without moving code that is load-bearing for every save. It fails
 * the moment a new per-filament array is added and forgotten, which is the failure mode that keeps
 * recurring, and it names the missing reconcile in the message so the next person knows why.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyFilamentList } from './bake-documents'
import { collectSettingsRepairReasons } from '../repairs/index.js'
import type { SceneEditFilament } from '../slicing'

/** A dual-nozzle H2D project with two filaments and every invariant satisfied. */
const HEALTHY: Record<string, unknown> = {
  filament_colour: ['#111111', '#222222'],
  filament_type: ['PLA', 'PETG'],
  filament_ids: ['GFA00', 'GFG02'],
  filament_settings_id: ['Bambu PLA Basic @BBL H2D', 'Bambu PETG HF @BBL H2D 0.4 nozzle'],
  extruder_variant_list: ['Direct Drive Standard', 'Direct Drive High Flow'],
  printer_extruder_variant: ['Direct Drive Standard', 'Direct Drive High Flow'],
  filament_extruder_variant: ['Direct Drive Standard', 'Direct Drive High Flow', 'Direct Drive Standard', 'Direct Drive High Flow'],
  filament_self_index: ['1', '1', '2', '2'],
  inherits_group: ['', '', '', ''],
  nozzle_temperature: ['220', '220', '255', '255'],
  nozzle_temperature_initial_layer: ['220', '220', '255', '255'],
  filament_flow_ratio: ['0.98', '0.98', '0.95', '0.95'],
  filament_density: ['1.26', '1.27'],
  filament_diameter: ['1.75', '1.75'],
  nozzle_diameter: ['0.4', '0.4'],
  // Two 2x2 blocks (one per extruder), 0 on the diagonal and a real purge off it, which is what a
  // Studio-written project carries. An all-zero fixture would let a zero cell pass as "carried".
  flush_volumes_matrix: ['0', '280', '280', '0', '0', '280', '280', '0'],
  flush_volumes_vector: ['140', '140', '140', '140'],
  flush_multiplier: ['1', '1']
}

/** A slot carrying its resolved preset, which is what the editor attaches to every save. */
function slot(index: number, overrides: Partial<SceneEditFilament> = {}): SceneEditFilament {
  const temps = HEALTHY.nozzle_temperature as string[]
  return {
    color: (HEALTHY.filament_colour as string[])[index] ?? '#FFFFFF',
    type: (HEALTHY.filament_type as string[])[index],
    settingsId: (HEALTHY.filament_settings_id as string[])[index],
    sourceIndex: index,
    config: {
      nozzle_temperature: [temps[index * 2], temps[index * 2]],
      nozzle_temperature_initial_layer: [temps[index * 2], temps[index * 2]],
      filament_flow_ratio: ['0.98', '0.98'],
      filament_density: [(HEALTHY.filament_density as string[])[index]],
      filament_diameter: ['1.75']
    },
    ...overrides
  } as SceneEditFilament
}

/** A brand new slot, which the editor clones from slot 0 while resolving its own preset. */
const ADDED = slot(0, {
  type: 'ABS',
  settingsId: 'Bambu ABS @BBL H2D',
  config: {
    nozzle_temperature: ['270', '270'],
    nozzle_temperature_initial_layer: ['270', '270'],
    filament_flow_ratio: ['0.95', '0.95'],
    filament_density: ['1.04'],
    filament_diameter: ['1.75']
  }
} as Partial<SceneEditFilament>)

const CHANGES: Array<[string, SceneEditFilament[]]> = [
  ['no change at all', [slot(0), slot(1)]],
  ['add a material', [slot(0), slot(1), ADDED]],
  ['add two materials', [slot(0), slot(1), ADDED, ADDED]],
  ['remove the last material', [slot(0)]],
  ['remove the first material', [slot(1)]],
  ['reorder the materials', [slot(1), slot(0)]],
  ['reorder and add', [slot(1), slot(0), ADDED]]
]

test('the project starts with every invariant satisfied', () => {
  // The control. Without it, a fixture that was broken to begin with would make every case below
  // pass for the wrong reason, or fail in a way that looks like the code.
  assert.deepEqual(collectSettingsRepairReasons(JSON.stringify(HEALTHY)), [])
})

for (const [label, filaments] of CHANGES) {
  test(`changing the filament set leaves no defect behind: ${label}`, () => {
    const out = applyFilamentList(JSON.stringify(HEALTHY), filaments)
    assert.deepEqual(
      collectSettingsRepairReasons(out),
      [],
      `${label} left the project needing repair. Something sized against the filament count did not `
      + 'follow it. Whatever array that is belongs in applyFilamentList, beside the ones that already do.'
    )
    // The three that shipped as defects, asserted by shape as well as by the reason list, since a
    // reason only fires where an inspector exists and the next one may not have an inspector yet.
    const record = JSON.parse(out) as Record<string, unknown>
    const slots = (record.filament_settings_id as string[]).length
    const rows = (record.filament_extruder_variant as string[]).length
    assert.equal((record.filament_self_index as string[]).length, rows, `${label}: self index must match the variant rows`)
    assert.equal((record.inherits_group as string[]).length, slots + 2, `${label}: inherits_group must be slots + 2`)
    const extruders = (record.nozzle_diameter as string[]).length
    assert.equal((record.flush_volumes_matrix as string[]).length, slots * slots * extruders, `${label}: flush matrix must be filaments^2 x extruders`)
  })
}

test('a new material purges against every existing one', () => {
  // The shape a length check cannot see: a correctly sized matrix whose new cells are all zero.
  const out = JSON.parse(applyFilamentList(JSON.stringify(HEALTHY), [slot(0), slot(1), ADDED])) as Record<string, unknown>
  const matrix = (out.flush_volumes_matrix as string[]).slice(0, 9)
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      if (row === col) continue
      assert.notEqual(matrix[row * 3 + col], '0', `(${row},${col}) is a swap between different materials and must purge`)
    }
  }
})

/**
 * A latent defect the change EXPOSES must be reported, not carried silently.
 *
 * `flush_multiplier` is sized on extruders, not filaments, so adding a material does not invalidate
 * it and the bake has no business rewriting it. But the engine only performs its size check above
 * one filament (and only when `nozzle_volume_type` matches the extruder count), so a project that
 * was already wrong sits clean at rest and becomes checkable the moment a second material arrives.
 * That is exactly when the user needs to be told, since the engine's own answer is a mid-slice
 * failure with an opaque exit code.
 */
test('adding a material reports a latent flush multiplier defect rather than hiding it', () => {
  const latent: Record<string, unknown> = {
    ...HEALTHY,
    filament_colour: ['#111111'],
    filament_type: ['PLA'],
    filament_ids: ['GFA00'],
    filament_settings_id: ['Bambu PLA Basic @BBL H2D'],
    filament_extruder_variant: ['Direct Drive Standard', 'Direct Drive High Flow'],
    filament_self_index: ['1', '1'],
    inherits_group: ['', '', ''],
    nozzle_temperature: ['220', '220'],
    nozzle_temperature_initial_layer: ['220', '220'],
    filament_flow_ratio: ['0.98', '0.98'],
    filament_density: ['1.26'],
    filament_diameter: ['1.75'],
    flush_volumes_matrix: ['0', '0'],
    flush_volumes_vector: ['140', '140'],
    // One entry for a two-nozzle machine. `nozzle_volume_type` present and matching is what makes
    // the engine perform the check at all, which is why this needs both to reproduce.
    nozzle_volume_type: ['0', '0'],
    flush_multiplier: ['1']
  }
  assert.deepEqual(collectSettingsRepairReasons(JSON.stringify(latent)), [], 'a single-filament project sits below the check')

  const out = applyFilamentList(JSON.stringify(latent), [slot(0), ADDED])
  assert.deepEqual(collectSettingsRepairReasons(out), ['flushMatrix'], 'the second material makes it checkable, so it must be reported')
  // Reported, NOT quietly rewritten: the add did not invalidate this array, so fixing it is the
  // user's to ask for.
  assert.deepEqual((JSON.parse(out) as Record<string, unknown>).flush_multiplier, ['1'])
})

/**
 * A key the engine dereferences WITHOUT a null check must never be deleted.
 *
 * `PresetBundle.cpp` reads `config.option<ConfigOptionFloats>("filament_diameter")->values.size()`
 * with no guard, so an absent key is a null dereference and BambuStudio dies opening the project
 * rather than reporting anything. The drop path here removes every non-identity filament array when
 * a material changed and no preset resolved, and `filament_diameter` was in that set.
 *
 * This is the distinction the engine forces on us: an absent key
 * and an empty one are not the same thing, and a key the engine assumes into existence is not
 * optional. Dropping it is worse than leaving a stale value, because a crash tells the user nothing.
 */
test('a material change never deletes a key the engine dereferences unguarded', () => {
  // The unresolved-preset path: a material changed and no slot carried a resolved config, which is
  // what triggers the wholesale drop.
  const out = JSON.parse(applyFilamentList(JSON.stringify(HEALTHY), [
    { color: '#111111', type: 'ABS', settingsId: 'Bambu ABS @BBL H2D', sourceIndex: 0 },
    { color: '#222222', type: 'PETG', settingsId: 'Bambu PETG HF @BBL H2D 0.4 nozzle', sourceIndex: 1 }
  ] as SceneEditFilament[])) as Record<string, unknown>

  assert.ok(Array.isArray(out.filament_diameter), 'filament_diameter must survive the drop')
  assert.equal((out.filament_diameter as string[]).length, 2, 'and stay one entry per slot')
  // The rest of the drop still happens: this guards one key, it does not disable the behaviour.
  assert.equal(out.nozzle_temperature, undefined)
})
