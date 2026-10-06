import assert from 'node:assert/strict'
import test from 'node:test'
import type { RuntimeSlicerTarget } from './slicer-targets.js'
import { buildCliArgs, ensurePositionalInputArgument, insertArgsBeforePositionalInput } from './cli-args.js'

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

test('buildCliArgs retains a supported flag value and inserts generated args before the final input', () => {
  const args = buildCliArgs({
    slicerTarget: {
      cliArgsTemplate: '--slice {plate} --stale --remove old --export-json {input} {input}'
    } as RuntimeSlicerTarget,
    inputPath: INPUT,
    outputPath: '/work/output.gcode.3mf',
    outputFileName: 'output.gcode.3mf',
    plate: 2,
    supportedFlags: new Set(['--export-json']),
    profileArgs: ['--load-settings', 'machine.json'],
    manualFilamentMap: ['1', '2'],
    removedFlags: ['--remove'],
    removedStandaloneFlags: ['--stale'],
    bambuHomeDir: '/home/bambu',
    bambuConfigDir: '/home/bambu/config',
    bambuCacheDir: '/home/bambu/cache',
    bambuDataDir: '/home/bambu/data'
  })

  assert.deepEqual(args, [
    '--slice', '2', '--export-json', INPUT,
    '--load-settings', 'machine.json', '--filament-map', '1,2', INPUT
  ])
})

test('buildCliArgs removes unsupported export-json with its value and expands quoted paths', () => {
  const args = buildCliArgs({
    slicerTarget: {
      cliArgsTemplate: '--output "{output}" --export-json {input} {input}'
    } as RuntimeSlicerTarget,
    inputPath: INPUT,
    outputPath: '/work/output with spaces.gcode.3mf',
    outputFileName: 'output with spaces.gcode.3mf',
    plate: 1,
    supportedFlags: new Set(),
    profileArgs: [],
    manualFilamentMap: null,
    removedFlags: [],
    removedStandaloneFlags: [],
    bambuHomeDir: '/home/bambu',
    bambuConfigDir: '/home/bambu/config',
    bambuCacheDir: '/home/bambu/cache',
    bambuDataDir: '/home/bambu/data'
  })

  assert.deepEqual(args, ['--output', '/work/output with spaces.gcode.3mf', INPUT])
})
