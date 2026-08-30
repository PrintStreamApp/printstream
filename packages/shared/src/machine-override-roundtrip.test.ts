import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyMachineSettingOverrides, readMachineSettingOverrides } from './machine-retarget.js'

/**
 * A project-local printer override must survive being written and read back.
 *
 * The user-visible failure this pins is "I turned on Air filtration and saved, and it was not there
 * when I opened the file again" -- and its mirror, "I reset it and saved, and it came back". Neither
 * is a detection bug: both saves succeeded, both files were well-formed, and BambuStudio opened
 * both. The write and the read simply disagreed about where the machine slot is, and about whether
 * an empty override map means "nothing to do" or "clear what is recorded".
 *
 * So every case goes through the PAIR rather than asserting either half:
 *   apply -> read back -> the same map comes out
 * Asserting the writer alone cannot catch a reader that looks in the wrong slot, and the two
 * functions were written a page apart in different workspaces. They now sit together for this
 * reason; these tests are what keeps them together in behaviour rather than only in file position.
 *
 * The end-to-end file version of this (bake, persist, reopen through the API) is exercised by the
 * editor's save path; what cannot be covered there is the slot arithmetic across filament counts,
 * which is what actually broke.
 */

/** A minimal but INTERNALLY COHERENT project: the identity arrays state the filament count. */
function projectWith(filamentCount: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    printer_settings_id: 'Bambu Lab H2D 0.4 nozzle',
    printer_model: 'Bambu Lab H2D',
    nozzle_diameter: ['0.4', '0.4'],
    filament_settings_id: Array.from({ length: filamentCount }, () => 'Bambu PLA Basic @BBL H2D'),
    filament_colour: Array.from({ length: filamentCount }, () => '#FFFFFF'),
    filament_type: Array.from({ length: filamentCount }, () => 'PLA'),
    support_air_filtration: '0',
    printable_height: '325',
    ...extra
  }
}

/** The resolved printer preset the override is measured against. */
const PRESET = {
  support_air_filtration: '0',
  printable_height: '325'
}

// The count is the whole point: the machine slot is `filamentCount + 1`, so a pair that agrees at
// one count and not another is exactly the bug. Five is the real project this was reported on.
for (const filamentCount of [1, 2, 5]) {
  test(`an override written onto a ${filamentCount}-filament project reads back unchanged`, () => {
    const saved = applyMachineSettingOverrides(projectWith(filamentCount), { support_air_filtration: '1' }, PRESET)

    assert.equal(saved.support_air_filtration, '1', 'the VALUE is what the engine slices with')
    assert.deepEqual(
      readMachineSettingOverrides(saved, PRESET),
      { support_air_filtration: '1' },
      'and the record is where the reader looks for it'
    )
  })

  test(`resetting an override on a ${filamentCount}-filament project clears both the value and the record`, () => {
    const saved = applyMachineSettingOverrides(projectWith(filamentCount), { support_air_filtration: '1' }, PRESET)
    // An EMPTY map is a deliberate "reset everything", not "nothing to do". Returning early here is
    // what made clearing an override a silent no-op that the next open then undid.
    const reset = applyMachineSettingOverrides(saved, {}, PRESET)

    assert.equal(reset.support_air_filtration, '0', 'the preset value is restored, or the engine keeps slicing with the override')
    assert.deepEqual(readMachineSettingOverrides(reset, PRESET), {})
  })
}

test('a second override composes with the first instead of replacing it', () => {
  const first = applyMachineSettingOverrides(projectWith(5), { support_air_filtration: '1' }, PRESET)
  const second = applyMachineSettingOverrides(first, { support_air_filtration: '1', printable_height: '300' }, PRESET)

  assert.deepEqual(readMachineSettingOverrides(second, PRESET), {
    support_air_filtration: '1',
    printable_height: '300'
  })
})

test('dropping one of two overrides leaves the other recorded', () => {
  const both = applyMachineSettingOverrides(projectWith(5), { support_air_filtration: '1', printable_height: '300' }, PRESET)
  const one = applyMachineSettingOverrides(both, { printable_height: '300' }, PRESET)

  assert.deepEqual(readMachineSettingOverrides(one, PRESET), { printable_height: '300' })
  assert.equal(one.support_air_filtration, '0', 'the dropped key goes back to the preset value')
})

test('the write lands in the MACHINE slot, leaving the process and filament records untouched', () => {
  const project = projectWith(2, {
    // `[process, filament 1, filament 2, machine]` for a two-filament project.
    different_settings_to_system: ['wall_loops', 'nozzle_temperature', 'filament_flow_ratio', '']
  })
  const saved = applyMachineSettingOverrides(project, { support_air_filtration: '1' }, PRESET)

  assert.deepEqual(saved.different_settings_to_system, ['wall_loops', 'nozzle_temperature', 'filament_flow_ratio', 'support_air_filtration'],
    'a machine key written into a filament slot is how this vanished on reopen, and how a filament slot picked up a key it never had')
})

test('a key the preset has caught up to is not reported as an override', () => {
  // The record is BambuStudio's and is not re-checked when a preset changes underneath it, so a
  // stale entry must not badge the file as modified.
  const saved = applyMachineSettingOverrides(projectWith(2), { support_air_filtration: '1' }, PRESET)

  assert.deepEqual(readMachineSettingOverrides(saved, { ...PRESET, support_air_filtration: '1' }), {})
})

test('a project with no record at all reports no overrides', () => {
  // Absent is UNKNOWN, not modified. Answering with a value diff here is what reported 44 phantom
  // overrides on a real project.
  assert.deepEqual(readMachineSettingOverrides(projectWith(3), PRESET), {})
})

test('applying nothing to a project that records nothing leaves the file untouched', () => {
  // The one early return that is still correct: no override to write and none recorded means an
  // ordinary save must not rewrite the project's machine block at all.
  const project = projectWith(3)
  assert.equal(applyMachineSettingOverrides(project, {}, PRESET), project)
})
