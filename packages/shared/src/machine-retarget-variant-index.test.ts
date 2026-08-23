import assert from 'node:assert/strict'
import test from 'node:test'
import { retargetProjectSettingsToMachine } from './machine-retarget.js'

/**
 * BambuStudio refuses to OPEN a project whose `filament_self_index` does not have exactly one
 * entry per `filament_extruder_variant` row (PresetBundle.cpp, gated on `extruder_variant_list`):
 * it throws "Invalid configuration file" in the GUI. The CLI is more tolerant, which is why this
 * went unnoticed: files sliced happily and could not be opened in Bambu Studio.
 *
 * The absent case is NOT benign: the option's default is a 1-element vector, so a missing key
 * compares as size 1 and fails the equality check for any real multi-variant machine.
 */

const H2D = {
  printer_model: ['Bambu Lab H2D'],
  nozzle_diameter: ['0.4', '0.4'],
  extruder_variant_list: [
    'Direct Drive Standard,Direct Drive High Flow',
    'Direct Drive Standard,Direct Drive High Flow,Direct Drive TPU High Flow'
  ],
  printer_extruder_variant: ['Direct Drive Standard', 'Direct Drive High Flow']
}

function retarget(filamentTypes: string[]): Record<string, unknown> {
  return retargetProjectSettingsToMachine(
    { filament_type: filamentTypes, filament_colour: filamentTypes.map(() => '#FFFFFF') },
    H2D,
    { printerSettingsId: 'Bambu Lab H2D 0.4 nozzle', printerModel: 'Bambu Lab H2D' }
  ) as Record<string, unknown>
}

test('a retarget writes filament_self_index alongside filament_extruder_variant', () => {
  const out = retarget(['PLA', 'PETG'])
  const variants = out.filament_extruder_variant as string[]
  const selfIndex = out.filament_self_index as string[]
  assert.ok(Array.isArray(selfIndex), 'filament_self_index must be written, its absence reads as size 1 to BambuStudio')
  assert.equal(selfIndex.length, variants.length, 'BambuStudio requires one index entry per variant row')
  assert.ok(variants.length >= 2, 'and at least one row per filament')
  // 1-based, grouped per filament: BambuStudio scans for the FIRST row matching each id.
  assert.equal(selfIndex[0], '1')
  assert.equal(selfIndex[selfIndex.length - 1], '2')
  assert.deepEqual([...new Set(selfIndex)], ['1', '2'], 'every filament is represented exactly once as a group')
})

test('the index follows variable-width blocks (TPU takes every printer variant)', () => {
  // The blocks are NOT uniform: a TPU filament gets all printer variants while the rest share the
  // non-TPU ones. This is precisely why the two arrays cannot be built independently.
  const out = retarget(['PLA', 'TPU'])
  const variants = out.filament_extruder_variant as string[]
  const selfIndex = out.filament_self_index as string[]
  assert.equal(selfIndex.length, variants.length)
  const pla = selfIndex.filter((entry) => entry === '1').length
  const tpu = selfIndex.filter((entry) => entry === '2').length
  assert.ok(tpu >= pla, 'the TPU slot claims at least as many variant rows as the shared block')
  assert.equal(pla + tpu, variants.length)
})

test('a single filament still gets a matching index', () => {
  const out = retarget(['PLA'])
  const variants = out.filament_extruder_variant as string[]
  const selfIndex = out.filament_self_index as string[]
  assert.equal(selfIndex.length, variants.length)
  assert.deepEqual([...new Set(selfIndex)], ['1'])
})

const BROKEN_H2D_PROJECT = JSON.stringify({
  extruder_variant_list: [
    'Direct Drive Standard,Direct Drive High Flow',
    'Direct Drive Standard,Direct Drive High Flow,Direct Drive TPU High Flow'
  ],
  printer_extruder_variant: ['Direct Drive Standard', 'Direct Drive High Flow'],
  filament_extruder_variant: ['Direct Drive Standard', 'Direct Drive High Flow', 'Direct Drive Standard', 'Direct Drive High Flow'],
  filament_type: ['PLA', 'PLA'],
  filament_colour: ['#FFFFFF', '#000000']
})

test('an ordinary save does NOT silently repair an existing broken project', async () => {
  const { applyFilamentList } = await import('./three-mf/bake-documents.js')
  // Deliberate: repairing a stored project is a USER action, surfaced by `needsSettingsRepair` and
  // invoked from the editor banner. Healing at rest would mutate someone's file without their
  // say-so and make the next such defect undiagnosable, the same rule the flush matrix follows.
  const after = JSON.parse(applyFilamentList(BROKEN_H2D_PROJECT, [
    { color: '#FFFFFF', type: 'PLA', sourceIndex: 0 },
    { color: '#000000', type: 'PLA', sourceIndex: 1 }
  ])) as Record<string, unknown>
  assert.equal(after.filament_self_index, undefined, 'the save must leave the defect alone')
})

test('the defect is DETECTED, so the user can be asked to repair it', async () => {
  const { inspectProjectFilamentSelfIndex, repairFilamentSelfIndex } = await import('./filament-variant-index.js')
  const inspection = inspectProjectFilamentSelfIndex(BROKEN_H2D_PROJECT)
  assert.ok(inspection)
  assert.equal(inspection.inconsistent, true, 'four variant rows against an absent index')
  assert.equal(inspection.variantRows, 4)
  assert.equal(inspection.actualLength, 0)
  assert.equal(inspection.repairable, true, 'and the repair is offerable')
  // What that repair would write, when the user asks for it.
  assert.deepEqual(repairFilamentSelfIndex(JSON.parse(BROKEN_H2D_PROJECT) as Record<string, unknown>), ['1', '1', '2', '2'])
})

test('a project with no variant topology is not flagged at all', async () => {
  const { inspectProjectFilamentSelfIndex } = await import('./filament-variant-index.js')
  // No `extruder_variant_list` means BambuStudio never runs the check, so there is nothing to
  // report: flagging it would send users to a repair that changes nothing.
  assert.equal(inspectProjectFilamentSelfIndex(JSON.stringify({ filament_type: ['PLA'], filament_colour: ['#FFFFFF'] })), null)
})
