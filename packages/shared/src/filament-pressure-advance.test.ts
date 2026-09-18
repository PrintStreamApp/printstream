import assert from 'node:assert/strict'
import { test } from 'node:test'
import { withFilamentPressureAdvance } from './filament-pressure-advance.js'
import { applyFilamentSlotOverrides } from './filament-rebind.js'
import { bambuPressureAdvanceGcode, PRESSURE_ADVANCE_MODE_SETTING } from './pressure-advance-gcode.js'

test('linear K uses the same command as the tower, strips metadata, and can be deselected', () => {
  const settings = { enable_pressure_advance: '1', pressure_advance: '0.045', [PRESSURE_ADVANCE_MODE_SETTING]: 'linear' }
  const record = { printer_model: 'H2D', filament_start_gcode: ['; user script\n'] }
  const result = withFilamentPressureAdvance(record, { 1: settings }, [])
  assert.ok(String(result[1]!.filament_start_gcode).includes(bambuPressureAdvanceGcode(0.045, 'linear')))
  assert.match(String(result[1]!.filament_start_gcode), /M900 K0.045 L1000 M10/)
  assert.equal(result[1]![PRESSURE_ADVANCE_MODE_SETTING], undefined)
  const authored = { ...record, filament_start_gcode: [result[1]!.filament_start_gcode] }
  const native = withFilamentPressureAdvance(authored, { 1: { ...settings, [PRESSURE_ADVANCE_MODE_SETTING]: 'native' } }, [])
  assert.doesNotMatch(String(native[1]!.filament_start_gcode), /L1000|M10/)
  const off = withFilamentPressureAdvance(authored, { 1: { enable_pressure_advance: '0' } }, [])
  assert.equal(off[1]!.filament_start_gcode, '; user script\n')
})

test('K and flow reach the authored project together without changing other materials', () => {
  const record = {
    printer_model: 'Bambu Lab H2D',
    filament_colour: ['#FF0000', '#FFFFFF'],
    filament_settings_id: ['PETG', 'PLA'],
    filament_type: ['PETG', 'PLA'],
    filament_flow_ratio: ['0.95', '0.98'],
    filament_start_gcode: ['M106 S10\n', '; other material\n'],
    enable_pressure_advance: ['0', '0'],
    pressure_advance: ['0.02', '0.02']
  }
  const next = applyFilamentSlotOverrides(record, {
    1: { filament_flow_ratio: '1.14', enable_pressure_advance: '1', pressure_advance: '0.032' }
  }, [null, null])
  assert.deepEqual(next.filament_flow_ratio, ['1.14', '0.98'])
  assert.match((next.filament_start_gcode as string[])[0]!, /^M106 S10\n.*\nM400\nM900 K0.032\n/)
  assert.equal((next.filament_start_gcode as string[])[1], '; other material\n')
  assert.equal(record.filament_start_gcode[0], 'M106 S10\n')
})

test('re-authoring replaces generated K, preserves custom commands, and supports explicit Off', () => {
  const record = { printer_model: 'H2D', filament_start_gcode: ['M900 K0.01\n'] }
  const first = withFilamentPressureAdvance(record, { 1: { enable_pressure_advance: '1', pressure_advance: '0.025' } }, [])
  const authored = { ...record, filament_start_gcode: [first[1]!.filament_start_gcode] }
  const changed = withFilamentPressureAdvance(authored, { 1: { enable_pressure_advance: '1', pressure_advance: '0.035' } }, [])
  assert.equal(String(changed[1]!.filament_start_gcode).includes('K0.025'), false)
  assert.match(String(changed[1]!.filament_start_gcode), /M900 K0.01\n/)
  const off = withFilamentPressureAdvance(authored, { 1: { enable_pressure_advance: '0' } }, [])
  assert.equal(off[1]!.filament_start_gcode, 'M900 K0.01\n')
})

test('no selection leaves scripts alone, and non-Bambu machines keep native pressure advance', () => {
  assert.deepEqual(withFilamentPressureAdvance({ printer_model: 'H2D' }, {}, []), {})
  const overrides = { 1: { enable_pressure_advance: '1', pressure_advance: '0.03' } }
  assert.equal(withFilamentPressureAdvance({ printer_model: 'Voron' }, overrides, []), overrides)
  assert.throws(() => withFilamentPressureAdvance({ printer_model: 'H2D' }, {
    1: { enable_pressure_advance: '1', pressure_advance: 'NaN' }
  }, []), /K value/)
})
