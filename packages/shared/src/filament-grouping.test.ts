import assert from 'node:assert/strict'
import test from 'node:test'
import { filamentPrintableOnExtruder, solveFilamentGrouping } from './filament-grouping.js'

const toolheadIds = ['left', 'right'] as const

test('saving mode exhaustively separates the most expensive transition', () => {
  const result = solveFilamentGrouping({
    mode: 'saving',
    toolheadIds,
    filaments: [1, 2, 3].map((id) => ({ id, compatibleToolheadIds: toolheadIds })),
    flushVolumes: [[0, 100, 5], [100, 0, 5], [5, 5, 0]]
  })
  assert.ok(result)
  assert.notEqual(result.assignments[1], result.assignments[2])
  assert.equal(result.exhaustive, true)
})

test('match mode keeps loaded filaments on their current nozzles before minimizing purge', () => {
  const result = solveFilamentGrouping({
    mode: 'match',
    toolheadIds,
    filaments: [
      { id: 1, compatibleToolheadIds: toolheadIds, loadedToolheadId: 'left' },
      { id: 2, compatibleToolheadIds: toolheadIds, loadedToolheadId: 'left' }
    ],
    flushVolumes: [[0, 999], [999, 0]]
  })
  assert.deepEqual(result?.assignments, { 1: 'left', 2: 'left' })
  assert.equal(result?.movedCount, 0)
})

test('printable constraints reject invalid sides even when they score better', () => {
  const result = solveFilamentGrouping({
    mode: 'saving',
    toolheadIds,
    filaments: [
      { id: 1, compatibleToolheadIds: ['left'] },
      { id: 2, compatibleToolheadIds: ['left'] }
    ],
    flushVolumes: [[0, 999], [999, 0]]
  })
  assert.deepEqual(result?.assignments, { 1: 'left', 2: 'left' })
})

test('quality mode prefers the lower profile penalty', () => {
  const result = solveFilamentGrouping({
    mode: 'quality',
    toolheadIds,
    filaments: [{
      id: 1,
      compatibleToolheadIds: toolheadIds,
      qualityPenaltyByToolheadId: { left: 10, right: 0 }
    }]
  })
  assert.equal(result?.assignments[1], 'right')
})

test('ten or more filaments use the bounded heuristic', () => {
  const result = solveFilamentGrouping({
    mode: 'saving',
    toolheadIds,
    filaments: Array.from({ length: 10 }, (_unused, index) => ({ id: index + 1, compatibleToolheadIds: toolheadIds }))
  })
  assert.equal(result?.exhaustive, false)
  assert.equal(Object.keys(result?.assignments ?? {}).length, 10)
})

test('filament printable masks use slicer-extruder order rather than runtime nozzle ids', () => {
  assert.equal(filamentPrintableOnExtruder('3', 0), true)
  assert.equal(filamentPrintableOnExtruder('3', 1), true)
  assert.equal(filamentPrintableOnExtruder(['1'], 0), true)
  assert.equal(filamentPrintableOnExtruder(['1'], 1), false)
  assert.equal(filamentPrintableOnExtruder('2', 0), false)
  assert.equal(filamentPrintableOnExtruder('2', 1), true)
})
