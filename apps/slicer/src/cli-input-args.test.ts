import assert from 'node:assert/strict'
import test from 'node:test'
import { ensurePositionalInputArgument, insertArgsBeforePositionalInput } from './cli-input-args.js'

const INPUT = '/work/input.3mf'

test('ensurePositionalInputArgument appends the input only when the template omits it', () => {
  assert.deepEqual(ensurePositionalInputArgument(['--slice', '1'], INPUT), ['--slice', '1', INPUT])
  assert.deepEqual(ensurePositionalInputArgument(['--slice', '1', INPUT], INPUT), ['--slice', '1', INPUT])
})

// The regression this module exists for: the default args template ends
// `--export-json {input} {input}`, so the FIRST occurrence is --export-json's value. Splicing
// there would produce `--export-json --load-settings … <input> <input>`, feeding a flag name to
// --export-json as its filename.
test('insertArgsBeforePositionalInput splices before the positional, not a flag value', () => {
  const args = ['--slice', '1', '--export-json', INPUT, INPUT]
  assert.deepEqual(
    insertArgsBeforePositionalInput(args, INPUT, ['--load-settings', 'machine.json']),
    ['--slice', '1', '--export-json', INPUT, '--load-settings', 'machine.json', INPUT]
  )
})

test('insertArgsBeforePositionalInput splices before a lone positional input', () => {
  assert.deepEqual(
    insertArgsBeforePositionalInput(['--slice', '1', INPUT], INPUT, ['--skip-objects', '3,5']),
    ['--slice', '1', '--skip-objects', '3,5', INPUT]
  )
})

test('insertArgsBeforePositionalInput is a no-op with nothing to add, and appends when the input is absent', () => {
  const args = ['--slice', '1', INPUT]
  assert.equal(insertArgsBeforePositionalInput(args, INPUT, []), args, 'unchanged array, not a copy')
  assert.deepEqual(insertArgsBeforePositionalInput(['--slice', '1'], INPUT, ['--x']), ['--slice', '1', '--x'])
})
