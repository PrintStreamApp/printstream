import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SlicingOutputLine } from '@printstream/shared'
import { selectEngineLogLines } from './slicingEngineLog'

const line = (stream: SlicingOutputLine['stream'], text: string): SlicingOutputLine => ({
  stream,
  text,
  createdAt: '2026-09-07T05:12:37.000Z'
})

test("only the engine's own streams are shown, never our status lines", () => {
  // A `system` line is PrintStream's user-facing status and is already rendered above the
  // disclosure; repeating it here would read as engine output the engine never wrote.
  const selection = selectEngineLogLines([
    line('system', 'Starting the slice'),
    line('stdout', '[warning] cli mode, Current BambuStudio Version 02.07.01.62'),
    line('stderr', 'free(): invalid pointer'),
    line('system', 'Slicing... 10s elapsed')
  ])
  assert.deepEqual(selection.all.map((entry) => entry.text), [
    '[warning] cli mode, Current BambuStudio Version 02.07.01.62',
    'free(): invalid pointer'
  ])
  assert.equal(selection.hidden, 0)
})

test('the rendered tail keeps the END of the log, where the failure is', () => {
  const output = Array.from({ length: 10 }, (_, index) => line('stdout', `line ${index}`))
  const selection = selectEngineLogLines(output, 3)
  assert.deepEqual(selection.shown.map((entry) => entry.text), ['line 7', 'line 8', 'line 9'])
  // The count is reported so the UI can say what it dropped: a silent truncation reads as a
  // complete log.
  assert.equal(selection.hidden, 7)
})

test('a copy is never truncated, however long the log is', () => {
  const output = Array.from({ length: 5_000 }, (_, index) => line('stdout', `line ${index}`))
  const selection = selectEngineLogLines(output, 400)
  assert.equal(selection.all.length, 5_000, 'copy takes the whole log; a partial bug report is worse than none')
  assert.equal(selection.shown.length, 400)
})

test('a log shorter than the cap is shown whole, with nothing reported hidden', () => {
  const selection = selectEngineLogLines([line('stdout', 'only line')], 400)
  assert.deepEqual(selection.shown.map((entry) => entry.text), ['only line'])
  assert.equal(selection.hidden, 0)
})

test('an absent or engine-silent output is empty rather than throwing', () => {
  assert.deepEqual(selectEngineLogLines(undefined), { shown: [], hidden: 0, all: [] })
  assert.deepEqual(selectEngineLogLines([line('system', 'Queued')]).shown, [])
})
