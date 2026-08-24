/**
 * The collector's contract: WHICH defects a project carries, and which of them the Repair action
 * can actually fix. Every inspector already computes repairability; this is the seam that used to
 * throw it away, so a defect that declines reached the user as a button that silently did nothing
 * (issue #101).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { collectSettingsRepairReasons, collectSettingsRepairs, unrepairableSettingsRepairReasons } from './index.js'

/** `[process, ...one entry per filament slot, machine]`. */
function project(filamentCount: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    filament_settings_id: Array.from({ length: filamentCount }, (_u, i) => `Filament ${i + 1}`),
    filament_colour: Array.from({ length: filamentCount }, () => '#FFFFFF'),
    filament_type: Array.from({ length: filamentCount }, () => 'PLA'),
    ...extra
  })
}

// The shape confirmed on issue #101. A 1-entry `inherits_group` is too short to tell the process
// entry from the machine entry, so the repair DECLINES, correctly and permanently: guessing would
// move a preset name into the wrong role. It must still be reported (the file IS broken), but the
// user has to be told it needs a hand rather than offered an action that cannot work.
test('an inherits_group too short to disambiguate is reported but NOT repairable', () => {
  const json = project(2, { inherits_group: ['only-one'] })

  assert.ok(collectSettingsRepairReasons(json).includes('inheritsGroup'), 'still reported')
  assert.deepEqual(unrepairableSettingsRepairReasons(json), ['inheritsGroup'])
  assert.deepEqual(
    collectSettingsRepairs(json).filter((entry) => entry.reason === 'inheritsGroup'),
    [{ reason: 'inheritsGroup', repairable: false }]
  )
})

// A file can carry one of each, which is why repairability is per REASON rather than one flag on
// the file: dropping the button for the whole project would strand the fixable defect.
test('a repairable and an unrepairable defect coexist, and only the latter is listed', () => {
  const json = project(2, {
    inherits_group: ['only-one'],
    // Wrong-width flush matrix on a single-extruder machine: repairable from the topology alone.
    nozzle_diameter: ['0.4'],
    flush_volumes_matrix: ['0', '0', '0'],
    flush_multiplier: ['1']
  })
  const repairs = collectSettingsRepairs(json)

  assert.ok(repairs.length > 1, 'expected more than one defect')
  assert.ok(repairs.some((entry) => entry.repairable), 'at least one fixable')
  assert.deepEqual(unrepairableSettingsRepairReasons(json), ['inheritsGroup'])
})

// The healthy and the unreadable cases must both come back empty rather than throwing: a project
// with no readable settings is unaffected, not broken. The healthy fixture has to carry the
// filament PHYSICS sentinels too, or it trips `filamentPhysics` for a real reason: a project that
// names presets but carries none of their values is exactly the defect that check exists for.
test('a clean project and an unparseable one report nothing', () => {
  const clean = project(1, {
    inherits_group: ['0.20mm Standard', 'Bambu PLA Basic', 'Bambu Lab P1S 0.4 nozzle'],
    nozzle_temperature: ['220'],
    nozzle_temperature_initial_layer: ['220'],
    filament_flow_ratio: ['0.98'],
    filament_density: ['1.24'],
    filament_diameter: ['1.75']
  })
  assert.deepEqual(collectSettingsRepairs(clean), [])
  assert.deepEqual(unrepairableSettingsRepairReasons('not json'), [])
  assert.deepEqual(collectSettingsRepairs(null), [])
})

// The reason list stays exactly what it was, so every existing caller and the cached wire field
// are unaffected by carrying the extra signal.
test('collectSettingsRepairReasons still returns the plain reason list', () => {
  const json = project(2, { inherits_group: ['only-one'] })
  assert.deepEqual(collectSettingsRepairReasons(json), collectSettingsRepairs(json).map((entry) => entry.reason))
})
