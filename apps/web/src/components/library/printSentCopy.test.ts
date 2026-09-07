import assert from 'node:assert/strict'
import test from 'node:test'
import { formatPrintSentMessage } from './printSentCopy'

test('names the single printer a send went to', () => {
  assert.equal(
    formatPrintSentMessage('bracket.gcode.3mf', ['Kitchen X1C']),
    'bracket.gcode.3mf is on its way to Kitchen X1C.'
  )
})

test('leads with the count when a send fanned out to several printers', () => {
  assert.equal(
    formatPrintSentMessage('bracket.gcode.3mf', ['Kitchen X1C', 'Garage P1S', 'Office A1']),
    'bracket.gcode.3mf is on its way to 3 printers: Kitchen X1C, Garage P1S, Office A1.'
  )
})

test('falls back to the unnamed form rather than asserting a printer it cannot name', () => {
  assert.equal(
    formatPrintSentMessage('bracket.gcode.3mf', []),
    'bracket.gcode.3mf is on its way to the printer.'
  )
})
