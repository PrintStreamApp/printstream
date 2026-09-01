/**
 * A from-scratch bake must author its materials' PHYSICS, not just their names.
 *
 * Every editor-born project's first save composes `project_settings.config` from `{}`
 * (`applyProjectSettings('{}')` in `bake.ts`), so the record has no filament slots until
 * `applyFilamentList` writes the identity arrays. The physics-restore gate used to run BEFORE that:
 * `inspectProjectFilamentPhysics` counts slots, an empty record has none, and it answered `null`,
 * "nothing to judge". So a new project wrote every material's temperatures, flow, density and
 * diameter into the void however completely the editor had resolved them, and reopened flagged
 * `filamentPhysics` on a file the bake had just been HANDED the values for.
 *
 * The gate now runs last, judging the record the pass actually built. Two failures are pinned here
 * because they fail in opposite directions and a fix for one can easily reintroduce the other.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyFilamentList } from './bake-documents.js'
import { inspectProjectFilamentPhysics } from '../repairs/filament-physics.js'
import type { SceneEditFilament } from '../slicing.js'

/** The five completeness sentinels `inspectProjectFilamentPhysics` judges a slot on. */
const RESOLVED_PLA = {
  nozzle_temperature: ['220'],
  nozzle_temperature_initial_layer: ['220'],
  filament_flow_ratio: ['0.98'],
  filament_density: ['1.24'],
  filament_diameter: ['1.75']
}

const filament = (overrides: Partial<SceneEditFilament>): SceneEditFilament =>
  ({ color: '#FFFFFF', sourceIndex: 0, ...overrides }) as SceneEditFilament

test('a from-scratch bake writes the resolved physics, not only the material name', () => {
  const out = applyFilamentList('{}', [
    filament({ type: 'PLA', settingsId: 'Generic PLA', config: RESOLVED_PLA as never })
  ])
  const record = JSON.parse(out) as Record<string, unknown>

  // The identity the old behaviour got right, so the failure was invisible in the sidebar.
  assert.deepEqual(record.filament_settings_id, ['Generic PLA'])
  // ...and the values it dropped on the floor.
  assert.deepEqual(record.nozzle_temperature, ['220'], 'the slot kept its name but lost its physics')
  assert.deepEqual(record.filament_flow_ratio, ['0.98'])
  assert.equal(inspectProjectFilamentPhysics(out)?.inconsistent, false,
    'the bake must not produce a file its own defect check flags')
})

test('a from-scratch bake with NO resolved preset still writes nothing', () => {
  // The inverse, and the reason the gate cannot simply always write: a slot whose preset the
  // caller could not resolve has no values to author, and inventing plausible ones is exactly what
  // the repairs contract forbids. It stays flagged so the user can repair it deliberately.
  const out = applyFilamentList('{}', [filament({ type: 'PLA', settingsId: 'Generic PLA' })])
  const record = JSON.parse(out) as Record<string, unknown>
  assert.deepEqual(record.filament_settings_id, ['Generic PLA'])
  assert.equal(record.nozzle_temperature, undefined, 'no preset resolved means no values invented')
  assert.equal(inspectProjectFilamentPhysics(out)?.inconsistent, true)
})

test('an EXISTING project keeps carrying its physics through a material change', () => {
  // The path that already worked, pinned so moving the gate cannot have broken it: a base with
  // slots present takes the rebind branch, and the gate must not undo it.
  const base = JSON.stringify({
    filament_colour: ['#000000'],
    filament_type: ['PETG'],
    filament_settings_id: ['Generic PETG'],
    ...RESOLVED_PLA
  })
  const out = applyFilamentList(base, [
    filament({ type: 'PLA', settingsId: 'Generic PLA', config: RESOLVED_PLA as never })
  ])
  assert.equal(inspectProjectFilamentPhysics(out)?.inconsistent, false)
  assert.deepEqual((JSON.parse(out) as Record<string, unknown>).filament_settings_id, ['Generic PLA'])
})
