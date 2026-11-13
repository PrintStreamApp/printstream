/**
 * The flushing dialog must describe the printer that is SELECTED. A P1P project switched to an
 * H2D used to show one purge grid from the P1P, which the bake then dropped for having the wrong
 * block count.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { flushContextForSelectedMachine } from './flushContextForMachine'

const P1P_PROJECT = JSON.stringify({
  printer_settings_id: 'Bambu Lab P1P 0.4 nozzle',
  printer_model: 'Bambu Lab P1P',
  nozzle_diameter: ['0.4'],
  filament_colour: ['#FFFFFF', '#000000'],
  filament_type: ['PLA', 'PLA'],
  filament_settings_id: ['Bambu PLA Basic @BBL P1P', 'Bambu PLA Basic @BBL P1P'],
  flush_volumes_matrix: ['0', '280', '280', '0'],
  flush_multiplier: ['1']
})

const H2D = {
  name: 'Bambu Lab H2D 0.4 nozzle',
  config: {
    printer_model: 'Bambu Lab H2D',
    nozzle_diameter: ['0.4', '0.4'],
    physical_extruder_map: ['1', '0'],
    default_nozzle_volume_type: ['Standard', 'Standard'],
    extruder_max_nozzle_count: ['1', '1']
  }
}

test('a switched printer gets its own extruder count, not the stored file\'s', () => {
  assert.equal(flushContextForSelectedMachine(P1P_PROJECT, null)?.extruderCount, 1, 'unresolved reads the file as stored')
  const context = flushContextForSelectedMachine(P1P_PROJECT, H2D)
  assert.equal(context?.extruderCount, 2)
  assert.equal(context?.multiplier.length, 2)
})

test('the project\'s own printer reads the file exactly as stored', () => {
  const own = { name: 'Bambu Lab P1P 0.4 nozzle', config: { printer_model: 'Bambu Lab P1P', nozzle_diameter: ['0.4'] } }
  const context = flushContextForSelectedMachine(P1P_PROJECT, own)
  assert.equal(context?.extruderCount, 1)
  assert.deepEqual(context?.storedBlocks, [[[0, 280], [280, 0]]])
})
