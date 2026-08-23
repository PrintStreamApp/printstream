/**
 * `filament_is_support` must survive a material change, because it is the record of WHAT a slot is.
 *
 * Storing the raw `filament_type` was tried and reverted, because the same value is compared
 * against the editor's own display type to decide whether a slot's material changed. This flag
 * matters independently: it is what the engine derives the display type from, and dropping it with the
 * material physics turned a support slot into an ordinary one.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyFilamentList } from './bake-documents'

test('the support flag survives a material change and follows the slot', () => {
  // Found by adversarially reviewing the raw-type change above. `filament_type` no longer spells
  // out "-S", so `filament_is_support` is the ONLY remaining record that a slot is a support
  // material, and the engine derives the type the user sees from it (`PrintConfig.cpp:7569-7638`).
  // It used to be dropped with the material physics whenever no preset resolved, which turned a
  // support slot into an ordinary PLA in the saved file.
  const settings = JSON.stringify({
    filament_type: ['PLA', 'PLA'],
    filament_is_support: ['0', '1'],
    filament_colour: ['#FFFFFF', '#00FF00']
  })
  // Slots swapped, and no resolved preset for either, which is the case that dropped it.
  const out = applyFilamentList(settings, [
    { color: '#00FF00', type: 'PLA-S', sourceIndex: 1 },
    { color: '#FFFFFF', type: 'PLA', sourceIndex: 0 }
  ] as never, null as never)
  const record = JSON.parse(out) as { filament_type: string[]; filament_is_support: string[] }
  // The type keeps the derived spelling (the raw-type change was reverted); what matters here is
  // that the FLAG followed the slot rather than being dropped with the material physics.
  assert.deepEqual(record.filament_type, ['PLA-S', 'PLA'])
  assert.deepEqual(record.filament_is_support, ['1', '0'], 'the support flag was dropped or left in the old order')
})
