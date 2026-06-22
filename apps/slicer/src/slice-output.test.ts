import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SlicingOutputLine } from '@printstream/shared'
import { appendCappedTail, appendOutput, appendStructuredOutput, MAX_COMBINED_OUTPUT_BYTES } from './slice-output.js'

test('appendStructuredOutput bounds the retained line count and keeps the most recent', () => {
  const lines: SlicingOutputLine[] = []
  for (let i = 0; i < 12_000; i += 1) {
    appendStructuredOutput(lines, 'stdout', `line ${i}`)
  }
  assert.ok(lines.length <= 5_000, `expected <= 5000 retained lines, got ${lines.length}`)
  assert.equal(lines.at(-1)?.text, 'line 11999', 'must keep the newest line')
})

test('appendOutput splits a chunk into non-empty trimmed lines', () => {
  const lines: SlicingOutputLine[] = []
  appendOutput(lines, 'stderr', 'first\n\n  second  \r\nthird')
  // appendOutput trims only trailing whitespace (trimEnd), preserving indentation.
  assert.deepEqual(lines.map((line) => line.text), ['first', '  second', 'third'])
  assert.ok(lines.every((line) => line.stream === 'stderr'))
})

test('appendCappedTail keeps only the most recent bytes', () => {
  let buffer = ''
  buffer = appendCappedTail(buffer, 'a'.repeat(MAX_COMBINED_OUTPUT_BYTES), MAX_COMBINED_OUTPUT_BYTES)
  buffer = appendCappedTail(buffer, 'TAIL', MAX_COMBINED_OUTPUT_BYTES)
  assert.equal(buffer.length, MAX_COMBINED_OUTPUT_BYTES)
  assert.ok(buffer.endsWith('TAIL'))
  assert.ok(!buffer.startsWith('a'.repeat(5)) || buffer.includes('TAIL'))
})

test('appendCappedTail leaves a short buffer untouched', () => {
  assert.equal(appendCappedTail('one ', 'two', 1024), 'one two')
})
