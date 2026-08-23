import test from 'node:test'
import assert from 'node:assert/strict'
import { applyFilamentList } from './bake-documents.js'
import type { SceneEditFilament } from '../three-mf-scene.js'

/**
 * `inherits_group` is `[process, ...one entry per filament slot, machine]`. Leaving it at the old
 * width when the filament set shrinks is FATAL, not untidy: BambuStudio's CLI sizes its
 * filament-system-name vector from this array and then indexes `filament_settings_id` with it
 * without a bounds check (`BambuStudio.cpp`, `current_filaments_system_name`), so the extra entries
 * make it read past the end of the filament names and SIGSEGV while loading the project.
 *
 * Reproduced from the production file: 5 filaments -> 1 left `inherits_group` at 7 entries, and
 * every slice of that project died at exit 139 until it was cut back to 3.
 */
function project(filamentCount: number): string {
  const slot = <T>(value: T) => Array.from({ length: filamentCount }, () => value)
  return JSON.stringify({
    filament_colour: Array.from({ length: filamentCount }, (_u, i) => (i === 0 ? '#001489' : '#FFFFFF')),
    filament_type: Array.from({ length: filamentCount }, (_u, i) => (i === 0 ? 'PETG' : 'PLA')),
    filament_settings_id: Array.from({ length: filamentCount }, (_u, i) => (i === 0 ? 'Generic PETG' : 'Bambu PLA Basic')),
    ...(filamentCount > 0 ? { nozzle_temperature: slot('245') } : {}),
    // [process, ...filaments, machine]
    inherits_group: ['0.20mm Strength @BBL P1P', ...Array.from({ length: filamentCount }, (_u, i) => (i === 0 ? 'Generic PETG @BBL P1P' : 'Bambu PLA Basic @BBL P1P')), 'Bambu Lab P1S 0.4 nozzle'],
    different_settings_to_system: ['', ...Array.from({ length: filamentCount }, () => ''), '']
  })
}

const keepFirst: SceneEditFilament[] = [
  { color: '#001489', type: 'PETG', settingsId: 'Generic PETG', sourceIndex: 0 } as SceneEditFilament
]

test('shrinking the filament set cuts `inherits_group` to slots + 2', () => {
  const after = JSON.parse(applyFilamentList(project(5), keepFirst)) as Record<string, unknown>

  const slots = (after.filament_colour as unknown[]).length
  assert.equal(slots, 1)
  assert.equal((after.inherits_group as unknown[]).length, slots + 2)
})

test('the surviving slot keeps its own parent, and the process/machine ends are preserved', () => {
  const after = JSON.parse(applyFilamentList(project(5), keepFirst)) as Record<string, unknown>

  // The machine entry lives at the END, so it MOVES when the filament count changes: copying the
  // array verbatim would leave the machine slot holding a filament's parent.
  assert.deepEqual(after.inherits_group, [
    '0.20mm Strength @BBL P1P',
    'Generic PETG @BBL P1P',
    'Bambu Lab P1S 0.4 nozzle'
  ])
})

test('`inherits_group` stays in step with its twin `different_settings_to_system`', () => {
  const after = JSON.parse(applyFilamentList(project(5), keepFirst)) as Record<string, unknown>

  // Both carry the same [process, ...slots, machine] layout; one being rebuilt and the other not is
  // exactly how this shipped broken.
  assert.equal(
    (after.inherits_group as unknown[]).length,
    (after.different_settings_to_system as unknown[]).length
  )
})

test('growing the filament set also keeps the width correct', () => {
  const grown: SceneEditFilament[] = [
    { color: '#001489', type: 'PETG', settingsId: 'Generic PETG', sourceIndex: 0 },
    { color: '#FFFFFF', type: 'PLA', settingsId: 'Bambu PLA Basic', sourceIndex: 0 },
    { color: '#000000', type: 'PLA', settingsId: 'Bambu PLA Basic', sourceIndex: 0 }
  ] as SceneEditFilament[]
  const after = JSON.parse(applyFilamentList(project(1), grown)) as Record<string, unknown>

  assert.equal((after.filament_colour as unknown[]).length, 3)
  assert.equal((after.inherits_group as unknown[]).length, 5)
  assert.equal((after.inherits_group as string[])[4], 'Bambu Lab P1S 0.4 nozzle')
})

test('an unchanged filament count leaves the array alone', () => {
  const same: SceneEditFilament[] = [
    { color: '#001489', type: 'PETG', settingsId: 'Generic PETG', sourceIndex: 0 },
    { color: '#FFFFFF', type: 'PLA', settingsId: 'Bambu PLA Basic', sourceIndex: 1 }
  ] as SceneEditFilament[]
  const after = JSON.parse(applyFilamentList(project(2), same)) as Record<string, unknown>

  assert.deepEqual(after.inherits_group, [
    '0.20mm Strength @BBL P1P',
    'Generic PETG @BBL P1P',
    'Bambu PLA Basic @BBL P1P',
    'Bambu Lab P1S 0.4 nozzle'
  ])
})
