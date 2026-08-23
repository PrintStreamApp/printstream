import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  effectiveAmsNozzleId,
  extruderIdForSwitchInput,
  filamentTrackSwitchMatchesSlice,
  filamentTrackSwitchMismatch,
  filamentTrackSwitchMismatchDetail,
  filamentTrackSwitchMismatchMessage,
  isDualReachableAmsUnit,
  isFilamentTrackSwitchInstalled,
  isFilamentTrackSwitchReady,
  summarizeFilamentTrackSwitch
} from './filament-track-switch.js'
import type { FilamentTrackSwitch } from './printer-contracts.js'

/**
 * The FTS semantics ported from BambuStudio's `DevFilaSwitch` / `SelectMachineDialog`. No firmware
 * exposes this yet, so these fixtures ARE the contract, they encode what the C++ does, and a
 * change here should mean the vendored source changed or a real payload disagreed with it.
 */

function buildSwitch(overrides: Partial<FilamentTrackSwitch> = {}): FilamentTrackSwitch {
  return {
    installed: true,
    inputA: null,
    inputB: null,
    outputAExtruderId: null,
    outputBExtruderId: null,
    calibrating: false,
    filamentPresent: null,
    ...overrides
  }
}

test('a switch is only ready when every AMS unit names its input', () => {
  const trackSwitch = buildSwitch()

  // Mirrors DevFilaSwitch::IsReady, a unit with no switcher pos makes the whole switch unusable.
  assert.equal(
    isFilamentTrackSwitchReady({ filamentTrackSwitch: trackSwitch, ams: [{ switchInput: 'A' }, { switchInput: 'B' }] }),
    true
  )
  assert.equal(
    isFilamentTrackSwitchReady({ filamentTrackSwitch: trackSwitch, ams: [{ switchInput: 'A' }, { switchInput: null }] }),
    false
  )
})

test('an uninstalled or absent switch is never ready, but readiness is not the same as installed', () => {
  assert.equal(isFilamentTrackSwitchReady({ filamentTrackSwitch: null, ams: [] }), false)
  assert.equal(
    isFilamentTrackSwitchReady({ filamentTrackSwitch: buildSwitch({ installed: false }), ams: [] }),
    false
  )

  // Installed but not set up: the state Studio blocks load/unload and printing on. The two
  // predicates must disagree here, which is the whole reason both exist.
  const unconfigured = { filamentTrackSwitch: buildSwitch(), ams: [{ switchInput: null }] }
  assert.equal(isFilamentTrackSwitchInstalled(unconfigured), true)
  assert.equal(isFilamentTrackSwitchReady(unconfigured), false)
})

test('a unit behind the switch loses its nozzle binding, one in front of it keeps it', () => {
  assert.equal(effectiveAmsNozzleId({ switchInput: 'B', nozzleId: 0 }), null)
  assert.equal(isDualReachableAmsUnit({ switchInput: 'B' }), true)

  assert.equal(effectiveAmsNozzleId({ switchInput: null, nozzleId: 1 }), 1)
  assert.equal(isDualReachableAmsUnit({ switchInput: null }), false)
})

test('each input reports its own output extruder', () => {
  const trackSwitch = buildSwitch({ outputAExtruderId: 1, outputBExtruderId: 0 })
  assert.equal(extruderIdForSwitchInput(trackSwitch, 'A'), 1)
  assert.equal(extruderIdForSwitchInput(trackSwitch, 'B'), 0)

  // An unmapped output (0xE on the wire) parses to null and must stay null, not fall back to 0.
  assert.equal(extruderIdForSwitchInput(buildSwitch(), 'A'), null)
})

test('a slice matches a printer only when both agree about the switch', () => {
  assert.equal(filamentTrackSwitchMatchesSlice(true, true), true)
  assert.equal(filamentTrackSwitchMatchesSlice(false, false), true)
  assert.equal(filamentTrackSwitchMatchesSlice(true, false), false)
  assert.equal(filamentTrackSwitchMatchesSlice(false, true), false)

  // An absent flag reads as "no switch", exactly as BambuStudio's CLI defaults it, so a project
  // saved before the switch existed prints on a switch-less machine and is refused on one with it.
  assert.equal(filamentTrackSwitchMatchesSlice(null, false), true)
  assert.equal(filamentTrackSwitchMatchesSlice(undefined, true), false)
})

test('the summary groups units by input in unit-id order', () => {
  const summary = summarizeFilamentTrackSwitch({
    filamentTrackSwitch: buildSwitch({ calibrating: true }),
    ams: [
      { unitId: 3, switchInput: 'B' },
      { unitId: 1, switchInput: 'A' },
      { unitId: 2, switchInput: 'B' },
      { unitId: 4, switchInput: null }
    ] as never
  })

  assert.ok(summary)
  assert.deepEqual(summary.unitsByInput, { A: [1], B: [2, 3] })
  assert.equal(summary.calibrating, true)
  // Unit 4 names no input, so the switch is not ready even though three units do.
  assert.equal(summary.ready, false)
})

test('no switch reported means no summary at all', () => {
  assert.equal(summarizeFilamentTrackSwitch({ filamentTrackSwitch: null, ams: [] }), null)
})

test('the mismatch rule treats both kinds of unknown as "nothing to say"', () => {
  const withSwitch = { filamentTrackSwitch: buildSwitch() }
  const withoutSwitch = { filamentTrackSwitch: buildSwitch({ installed: false }) }

  // A real disagreement, in both directions.
  assert.deepEqual(filamentTrackSwitchMismatch(false, withSwitch), { printerHasSwitch: true })
  assert.deepEqual(filamentTrackSwitchMismatch(true, withoutSwitch), { printerHasSwitch: false })

  // Agreement.
  assert.equal(filamentTrackSwitchMismatch(true, withSwitch), null)
  assert.equal(filamentTrackSwitchMismatch(false, withoutSwitch), null)

  // Unknown #1: the printer never mentions an FTS (every machine today) or is offline. Warning
  // here would fire on every file on every printer in the field.
  assert.equal(filamentTrackSwitchMismatch(true, { filamentTrackSwitch: null }), null)
  assert.equal(filamentTrackSwitchMismatch(true, null), null)
  assert.equal(filamentTrackSwitchMismatch(true, undefined), null)

  // Unknown #2: the FILE's flag is undefined because an older server did not send it. Distinct
  // from `false`, which is a real answer, so undefined must not be read as "sliced without one".
  assert.equal(filamentTrackSwitchMismatch(undefined, withSwitch), null)
  assert.deepEqual(filamentTrackSwitchMismatch(false, withSwitch), { printerHasSwitch: true })
})

test('the dispatch refusal and the dialog warning describe the mismatch identically', () => {
  // One wording source: the refusal composes the dialog's clause, so the two surfaces cannot drift.
  for (const printerHasSwitch of [true, false]) {
    assert.ok(
      filamentTrackSwitchMismatchMessage(printerHasSwitch)
        .includes(filamentTrackSwitchMismatchDetail(printerHasSwitch))
    )
  }
})
