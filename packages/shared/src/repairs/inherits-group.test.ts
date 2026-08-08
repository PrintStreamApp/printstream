import test from 'node:test'
import assert from 'node:assert/strict'
import { inspectProjectInheritsGroup, repairInheritsGroup } from './inherits-group.js'
import { collectSettingsRepairReasons } from './index.js'

/** `[process, ...one entry per filament slot, machine]`. */
function project(filamentCount: number, inheritsGroup: string[]): string {
  return JSON.stringify({
    filament_settings_id: Array.from({ length: filamentCount }, (_u, i) => `Filament ${i + 1}`),
    filament_colour: Array.from({ length: filamentCount }, () => '#FFFFFF'),
    filament_type: Array.from({ length: filamentCount }, () => 'PLA'),
    inherits_group: inheritsGroup
  })
}

// The production shape: 5 filaments dropped to 1, inherits_group left at 7 entries.
const PRODUCTION_STALE = [
  '0.20mm Strength @BBL P1P',
  'Generic PETG @BBL P1P', 'Bambu PLA Basic', 'Bambu PLA Basic', 'Bambu PLA Basic', 'Bambu PLA Basic',
  'Bambu Lab P1S 0.4 nozzle'
]

test('flags an inherits_group wider than the filament set', () => {
  const inspection = inspectProjectInheritsGroup(project(1, PRODUCTION_STALE))
  assert.ok(inspection)
  assert.equal(inspection.actualLength, 7)
  assert.equal(inspection.expectedLength, 3)
  assert.equal(inspection.inconsistent, true)
  assert.equal(inspection.repairable, true)
})

test('repair keeps the process entry and carries the machine across from the END', () => {
  const record = JSON.parse(project(1, PRODUCTION_STALE)) as Record<string, unknown>
  const repaired = repairInheritsGroup(record)

  // The machine sits LAST, so it moves when the count changes — a naive truncate would leave a
  // filament's parent sitting in the machine slot, which is how the CLI resolves the printer.
  assert.deepEqual(repaired, [
    '0.20mm Strength @BBL P1P',
    'Generic PETG @BBL P1P',
    'Bambu Lab P1S 0.4 nozzle'
  ])
})

test('a healthy project is not flagged and not rewritten', () => {
  const healthy = project(2, ['proc', 'f1', 'f2', 'machine'])
  assert.equal(inspectProjectInheritsGroup(healthy)?.inconsistent, false)
  assert.equal(repairInheritsGroup(JSON.parse(healthy) as Record<string, unknown>), null)
})

test('an inherits_group too SHORT is padded, keeping the machine last', () => {
  const record = JSON.parse(project(3, ['proc', 'f1', 'machine'])) as Record<string, unknown>
  const repaired = repairInheritsGroup(record)

  assert.equal(repaired?.length, 5)
  assert.equal(repaired?.[0], 'proc')
  assert.equal(repaired?.[4], 'machine')
  // Slots with no recorded parent are EMPTY, never guessed — the CLI reads empty as "system preset".
  assert.deepEqual(repaired?.slice(1, 4), ['f1', '', ''])
})

test('declines a group too short to tell the process entry from the machine', () => {
  // One entry could be either role; assigning it would move a preset name into the wrong slot.
  const record = JSON.parse(project(2, ['only-one'])) as Record<string, unknown>
  assert.equal(repairInheritsGroup(record), null)
  // Still reported, so a user is never told a file is clean when it is not.
  assert.equal(inspectProjectInheritsGroup(project(2, ['only-one']))?.inconsistent, true)
  assert.equal(inspectProjectInheritsGroup(project(2, ['only-one']))?.repairable, false)
})

test('projects with no inherits_group or no filament set are unaffected, not broken', () => {
  assert.equal(inspectProjectInheritsGroup(JSON.stringify({ filament_colour: ['#FFF'] })), null)
  assert.equal(inspectProjectInheritsGroup(JSON.stringify({ inherits_group: ['a', 'b'] })), null)
  assert.equal(inspectProjectInheritsGroup('not json'), null)
  assert.equal(inspectProjectInheritsGroup(null), null)
})

test('the defect list reports it', () => {
  assert.ok(collectSettingsRepairReasons(project(1, PRODUCTION_STALE)).includes('inheritsGroup'))
  assert.equal(collectSettingsRepairReasons(project(2, ['proc', 'f1', 'f2', 'machine'])).includes('inheritsGroup'), false)
})
