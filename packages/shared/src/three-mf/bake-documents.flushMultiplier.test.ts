/**
 * `applyFilamentList` must never treat the per-EXTRUDER flush/nozzle arrays as filament arrays.
 *
 * On a dual-nozzle machine with two filaments, `flush_multiplier` and `nozzle_volume_type` are
 * length-2 arrays indistinguishable from filament arrays by length alone, so the generic remap
 * used to reorder them with the filaments (swapping the EXTRUDERS' multipliers) and a filament add
 * stretched them to the filament count — the exact `flush_multiplier` shape BambuStudio's
 * g-code-time size check rejects (exit 156, "Flush volumes matrix do not match to the correct
 * size!"). They are machine-domain keys ({@link MACHINE_DOMAIN_ARRAY_KEYS}) and ride through
 * filament rewrites untouched.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyFilamentList } from './bake-documents'
import type { SceneEditFilament } from '../slicing'

const filament = (overrides: Partial<SceneEditFilament>): SceneEditFilament =>
  ({ color: '#FFFFFF', sourceIndex: 0, ...overrides }) as SceneEditFilament

const dualNozzleProject = {
  filament_colour: ['#000000', '#F4EE2A'],
  filament_type: ['PLA', 'PETG'],
  filament_settings_id: ['Bambu PLA Basic @BBL X2D', 'Generic PETG @BBL X2D'],
  nozzle_diameter: ['0.4', '0.4'],
  nozzle_volume_type: ['Standard', 'High Flow'],
  flush_volumes_matrix: ['0', '632', '136', '0', '0', '632', '136', '0'],
  flush_multiplier: ['1', '0.9'],
  flush_multiplier_fast: ['1.2', '1.1']
}

test('a filament reorder leaves the per-extruder flush and nozzle arrays untouched', () => {
  const after = JSON.parse(applyFilamentList(JSON.stringify(dualNozzleProject), [
    filament({ type: 'PETG', settingsId: 'Generic PETG @BBL X2D', sourceIndex: 1 }),
    filament({ type: 'PLA', settingsId: 'Bambu PLA Basic @BBL X2D', sourceIndex: 0 })
  ])) as Record<string, unknown>
  // The filament arrays moved with the slots...
  assert.deepEqual(after.filament_type, ['PETG', 'PLA'])
  // ...but the extruder arrays kept their extruder order.
  assert.deepEqual(after.flush_multiplier, ['1', '0.9'])
  assert.deepEqual(after.flush_multiplier_fast, ['1.2', '1.1'])
  assert.deepEqual(after.nozzle_volume_type, ['Standard', 'High Flow'])
})

test('a filament add keeps the per-extruder arrays at the extruder count', () => {
  const after = JSON.parse(applyFilamentList(JSON.stringify(dualNozzleProject), [
    filament({ type: 'PLA', settingsId: 'Bambu PLA Basic @BBL X2D', sourceIndex: 0 }),
    filament({ type: 'PETG', settingsId: 'Generic PETG @BBL X2D', sourceIndex: 1 }),
    filament({ type: 'ABS', settingsId: 'Generic ABS @BBL X2D', sourceIndex: 2 })
  ])) as Record<string, unknown>
  assert.equal((after.filament_type as unknown[]).length, 3)
  // Still one entry per EXTRUDER — stretching these to the filament count is the exit-156 shape.
  assert.deepEqual(after.flush_multiplier, ['1', '0.9'])
  assert.deepEqual(after.flush_multiplier_fast, ['1.2', '1.1'])
  assert.deepEqual(after.nozzle_volume_type, ['Standard', 'High Flow'])
  // The matrix, by contrast, IS filament-sized (per extruder block) and must grow: 3^2 x 2.
  assert.equal((after.flush_volumes_matrix as unknown[]).length, 18)
})

test('a filament removal keeps the per-extruder arrays at the extruder count', () => {
  const after = JSON.parse(applyFilamentList(JSON.stringify(dualNozzleProject), [
    filament({ type: 'PETG', settingsId: 'Generic PETG @BBL X2D', sourceIndex: 1 })
  ])) as Record<string, unknown>
  assert.equal((after.filament_type as unknown[]).length, 1)
  assert.deepEqual(after.flush_multiplier, ['1', '0.9'])
  assert.deepEqual(after.nozzle_volume_type, ['Standard', 'High Flow'])
})
