/**
 * Printer-setting changes belong to the printer preset they were made for (Bambu Studio never
 * transfers them to another printer). The reported failure: a P1P project's start G-code rode a
 * slice retargeted to an X2D, never selected a hotend, and the print ran on the wrong nozzle.
 */
import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { installJsdomGlobals } from '../../test-utils/jsdom'
const dom = installJsdomGlobals()
const { renderHook, act, cleanup } = await import('@testing-library/react')
const { useMachineSettingOverrides } = await import('./useMachineSettingOverrides')
afterEach(cleanup)
after(() => dom.window.close())

const P1P = { id: 'builtin:machine:p1p', name: 'Bambu Lab P1P 0.4 nozzle' }
const X2D = { id: 'builtin:machine:x2d', name: 'Bambu Lab X2D 0.4 nozzle' }
const P1P_START = { machine_start_gcode: ';===== machine: P1P =====' }

function render() {
  return renderHook(
    ({ preset }: { preset: { id: string; name: string } }) => useMachineSettingOverrides(preset.id, preset.name),
    { initialProps: { preset: P1P } }
  )
}

test('switching printer stops applying the previous printer\'s changes, and switching back restores them', () => {
  const view = render()
  act(() => view.result.current.seedMachineSettingOverrides(P1P_START, P1P.id, P1P.name))
  assert.deepEqual(view.result.current.machineSettingOverrides, P1P_START)

  view.rerender({ preset: X2D })
  assert.deepEqual(view.result.current.machineSettingOverrides, {}, 'nothing from the P1P reaches the X2D slice or save')
  assert.deepEqual(view.result.current.machineOverridesSetAside, { keyCount: 1, presetName: P1P.name })

  view.rerender({ preset: P1P })
  assert.deepEqual(view.result.current.machineSettingOverrides, P1P_START)
  assert.equal(view.result.current.machineOverridesSetAside, null)
})

test('an edit on the new printer starts from what applies there, not from the set-aside map', () => {
  const view = render()
  act(() => view.result.current.seedMachineSettingOverrides(P1P_START, P1P.id, P1P.name))
  view.rerender({ preset: X2D })

  act(() => view.result.current.setMachineSettingOverrides((current) => ({ ...current, enable_filament_dynamic_map: '1' })))
  assert.deepEqual(view.result.current.machineSettingOverrides, { enable_filament_dynamic_map: '1' })
  assert.equal(view.result.current.machineOverridesSetAside, null)
})

test('undo restores the held changes with the preset they belong to', () => {
  const view = render()
  act(() => view.result.current.seedMachineSettingOverrides(P1P_START, P1P.id, P1P.name))
  const snapshot = view.result.current.machineOverridesSnapshot
  view.rerender({ preset: X2D })
  act(() => view.result.current.setMachineSettingOverrides({ printable_height: '300' }))

  act(() => view.result.current.restoreMachineOverridesSnapshot(snapshot))
  assert.deepEqual(view.result.current.machineSettingOverrides, {}, 'still the X2D: the restored map belongs to the P1P')
  view.rerender({ preset: P1P })
  assert.deepEqual(view.result.current.machineSettingOverrides, P1P_START)
})

test('a snapshot from before scoping applies to whatever printer is selected', () => {
  const view = render()
  act(() => view.result.current.restoreMachineOverridesSnapshot({ machineSettingOverrides: { printable_height: '250' } }))
  view.rerender({ preset: X2D })
  assert.deepEqual(view.result.current.machineSettingOverrides, { printable_height: '250' })
})
