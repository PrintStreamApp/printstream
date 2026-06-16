import assert from 'node:assert/strict'
import { test } from 'node:test'
import { analyzePrintFinishGcode } from './print-finish-gcode.js'

test('detects parked-head terminal bed drop in P1-style finish gcode', () => {
  const analysis = analyzePrintFinishGcode([
    '; MACHINE_END_GCODE_START',
    'M400 ; wait for buffer to clear',
    'G92 E0 ; zero the extruder',
    'G1 E-0.8 F1800 ; retract',
    'G1 Z35.5 F900 ; lower z a little',
    'G1 X65 Y245 F12000 ; move to safe pos',
    'G1 Y265 F3000',
    'M140 S0 ; turn off bed',
    'M104 S0 ; turn off hotend',
    'M400 ; wait all motion done',
    'M17 S',
    'M17 Z0.4 ; lower z motor current',
    'G1 Z135 F600',
    'G1 Z133',
    'M73 P100 R0'
  ].join('\n'))

  assert.equal(analysis.hasTerminalParkedBedDrop, true)
})

test('detects parked-head terminal bed drop in H2D-style finish gcode', () => {
  const analysis = analyzePrintFinishGcode([
    '; MACHINE_END_GCODE_START',
    'M400 ; wait for buffer to clear',
    'G92 E0',
    'G1 E-0.8 F1800',
    'G1 Z1 F900',
    'G150.3',
    'G90',
    'G1 Z10.6 F900',
    'M140 S0',
    'M104 S0 T0',
    'M400 ; wait all motion done',
    'M17 S',
    'M17 Z0.4 ; lower z motor current',
    'G1 Z100.3 F600',
    'G1 Z98.3',
    'M18'
  ].join('\n'))

  assert.equal(analysis.hasTerminalParkedBedDrop, true)
})

test('does not report a terminal bed drop when the finish block lacks a reduced-current final Z move', () => {
  const analysis = analyzePrintFinishGcode([
    '; MACHINE_END_GCODE_START',
    'M400',
    'G1 E-0.8 F1800',
    'G1 X65 Y245 F12000',
    'G1 Y265 F3000',
    'M140 S0',
    'M104 S0',
    'M73 P100 R0'
  ].join('\n'))

  assert.equal(analysis.hasTerminalParkedBedDrop, false)
})

test('does not confuse the small end-of-print Z lift with the terminal bed drop', () => {
  const analysis = analyzePrintFinishGcode([
    '; MACHINE_END_GCODE_START',
    'G1 E-0.8 F1800',
    'G1 Z3.5 F900',
    'G1 X65 Y245 F12000',
    'G1 Y265 F3000',
    'M400',
    'M73 P100 R0'
  ].join('\n'))

  assert.equal(analysis.hasTerminalParkedBedDrop, false)
})