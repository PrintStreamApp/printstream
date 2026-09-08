import assert from 'node:assert/strict'
import test from 'node:test'
import {
  classifyCliFailure,
  formatSliceEngineCrashError,
  formatSliceFileVersionError,
  formatSlicePresetIncompatibilityError
} from './slice-error.js'

/**
 * The run's ALL-CHANNEL text: the `total_percent` frames only ever arrive over `--pipe`, so this
 * interleaving is what the crash grader must be handed, never the CLI's stdout/stderr.
 */
const OVERHANG_CRASH_OUTPUT = [
  '{"message":"Slicing begins","plate_count":1,"plate_index":1,"plate_percent":4,"total_percent":6}',
  '{"message":"Detect overhangs for auto-lift","plate_count":1,"plate_index":1,"plate_percent":71,"total_percent":66}',
  'Segmentation fault'
].join('\n')

/**
 * An observed production failure, verbatim channel split. Both of its attempts
 * aborted here, 10s apart, because the second one was never supposed to happen.
 */
const ABORT_PIPE_FRAMES = [
  '{"message":"Generating support","plate_count":1,"plate_index":2,"plate_percent":70,"total_percent":66}',
  '{"message":"Detect overhangs for auto-lift","plate_count":1,"plate_index":2,"plate_percent":71,"total_percent":66}'
].join('\n')
const ABORT_STDOUT = '[2026-09-07 05:09:29.563050] [0x0000767b9b4fc6c0] [error]   ZFiller: encounter idx from clip: 20'
const ABORT_STDERR = 'free(): invalid pointer\nAborted'

test('formatSliceEngineCrashError names the crash stage for a post-load segfault', () => {
  const message = formatSliceEngineCrashError(OVERHANG_CRASH_OUTPUT, 139)
  assert.ok(message, 'should produce a message')
  assert.match(message, /Detect overhangs for auto-lift/)
  assert.match(message, /engine exit 139/)
  // Must NOT contain the transient-crash text the API retry predicate keys on.
  assert.doesNotMatch(message, /exited with code 13[4-9]/i)
})

test('formatSliceEngineCrashError returns null for a load/teardown crash (stays retryable)', () => {
  const loadCrash = [
    '[2026-07-15 22:51:31] [trace]   Initializing StaticPrintConfigs',
    '{"message":"Prepare slicing","total_percent":3}',
    'Segmentation fault (core dumped)'
  ].join('\n')
  assert.equal(formatSliceEngineCrashError(loadCrash, 139), null)
  assert.equal(formatSliceEngineCrashError('', 139), null)
})

test('classifyCliFailure grades a signal death on the pipe channel, not on stdout/stderr', () => {
  // The regression this file exists for. BambuStudio's percent frames go ONLY to the --pipe FIFO,
  // so a grader fed stdout/stderr sees 0%, calls a deterministic 66% abort transient, and the API
  // burns a second full slice on a crash that cannot succeed.
  const message = classifyCliFailure({
    allChannelsText: `${ABORT_PIPE_FRAMES}\n${ABORT_STDOUT}\n${ABORT_STDERR}`,
    stdoutText: ABORT_STDOUT,
    stderrText: ABORT_STDERR,
    exitCode: 134
  })
  assert.match(message, /Detect overhangs for auto-lift/)
  assert.match(message, /engine exit 134/)
  assert.doesNotMatch(message, /exited with code 13[4-9]/i, 'must not match the API crash-retry predicate')
})

test('classifyCliFailure keeps a load-stage signal death retryable', () => {
  // The inverse: nothing reached 6%, so this stays a transient emulation flake and MUST keep the
  // `exited with code N` shape the API retries on.
  const message = classifyCliFailure({
    allChannelsText: '{"message":"Prepare slicing","total_percent":3}\nSegmentation fault',
    stdoutText: '',
    stderrText: 'Segmentation fault',
    exitCode: 139
  })
  assert.match(message, /Slicer CLI exited with code 139/)
})

test('classifyCliFailure prefers the CLI\'s own reason over the crash grader', () => {
  // A preset incompatibility is reported by the CLI in words; it must win even though the run also
  // carries post-load progress frames.
  const message = classifyCliFailure({
    allChannelsText: `${ABORT_PIPE_FRAMES}\nfilament preset Bambu PLA Basic @BBL A1 (slot 1) is not compatible with printer Bambu Lab A1 mini 0.4 nozzle.`,
    stdoutText: '[error]   run 3008: filament preset Bambu PLA Basic @BBL A1 (slot 1) is not compatible with printer Bambu Lab A1 mini 0.4 nozzle.',
    stderrText: '',
    exitCode: 251
  })
  assert.match(message, /Bambu Lab A1 mini 0\.4 nozzle/)
})

test('classifyCliFailure names the two models whose toolpaths collide', () => {
  // Verbatim from an observed production failure. The cause was supports on "Mount" reaching into
  // "Mast Bottom"; the engine said so and we replaced it with generic prime-tower advice, which
  // cost a trial-and-error hunt. The names are the whole value of this message.
  const message = classifyCliFailure({
    allChannelsText: '',
    stdoutText: [
      '[2026-09-07 05:12:37.319820] [0x0000727d890fa600] [error]   gcode path conflicts found between Mast Bottom and Mount',
      '[2026-09-07 05:12:37.319845] [0x0000727d890fa600] [error]   plate 2: found slicing result conflict!'
    ].join('\n'),
    stderrText: '',
    exitCode: 155
  })
  assert.match(message, /Mast Bottom/)
  assert.match(message, /Mount/)
  assert.match(message, /support/i, 'names the usual invisible cause')
  assert.doesNotMatch(message, /prime tower/i, 'must not blame the tower when the engine named two models')
})

test('classifyCliFailure keeps the prime-tower advice when the tower IS the conflict', () => {
  // The engine reports the tower as the literal name "WipeTower" (ConflictChecker.cpp), which is
  // the ONLY case where moving the tower is the right advice.
  const message = classifyCliFailure({
    allChannelsText: '',
    stdoutText: '[error]   gcode path conflicts found between WipeTower and Mount',
    stderrText: '',
    exitCode: 155
  })
  assert.match(message, /purge tower/i)
  assert.match(message, /Mount/)
  assert.doesNotMatch(message, /WipeTower/, 'the internal name is not shown to the user')
})

test('a run that logged a conflict but died of something else reports its own reason', () => {
  // The conflict line is logged mid-run, so a later unrelated failure would otherwise be reported
  // as a collision. Gated on the run's own CLI return code, not on the line being present.
  // Exit 156 (return -100) is raised at g-code-export time, i.e. AFTER the conflict check has
  // already logged, so this ordering is reachable rather than contrived.
  const message = classifyCliFailure({
    allChannelsText: '',
    stdoutText: [
      '[error]   gcode path conflicts found between Mast Bottom and Mount',
      'run found error, return -100, exit...'
    ].join('\n'),
    stderrText: '',
    exitCode: 156
  })
  assert.doesNotMatch(message, /Two models collide/, 'the stale conflict line must not become the verdict')
  assert.match(message, /Slicer CLI exited with code 156/)
})

test('a toolpath conflict with no engine detail still explains itself', () => {
  // The tail can lose the line; the fallback must not invent which models were involved.
  const message = classifyCliFailure({
    allChannelsText: '',
    stdoutText: 'run found error, return -101, exit...',
    stderrText: '',
    exitCode: 155
  })
  assert.match(message, /Slicer CLI exited with code 155/)
  assert.match(message, /support/i)
})

test('classifyCliFailure reports a host-runtime mismatch as a host problem', () => {
  const message = classifyCliFailure({
    allChannelsText: '',
    stdoutText: '',
    stderrText: "bambu-studio: /lib/x86_64-linux-gnu/libstdc++.so.6: version `GLIBCXX_3.4.32' not found",
    exitCode: 127
  })
  assert.match(message, /incompatible with this host runtime/)
  assert.match(message, /GLIBCXX_3\.4\.32/)
})

test('lifts a filament/printer incompatibility from BambuStudio stdout', () => {
  const output = [
    '[2026-06-15 16:31:12.580538] [0x000078e4a386e600] [trace]   Initializing StaticPrintConfigs',
    '{"message":"Start to load files","plate_count":0}',
    '[2026-06-15 16:31:12.980462] [0x000078e4a386e600] [error]   run 3008: filament preset Bambu PLA Basic @BBL A1 (slot 1) is not compatible with printer Bambu Lab A1 mini 0.4 nozzle.',
    'run found error, return -5, exit...'
  ].join('\n')
  const message = formatSlicePresetIncompatibilityError(output)
  assert.ok(message, 'should produce a message')
  assert.match(message, /Bambu PLA Basic @BBL A1/)
  assert.match(message, /Bambu Lab A1 mini 0\.4 nozzle/)
  assert.doesNotMatch(message, /run 3008|\[error\]|exit\.\.\./)
})

test('returns null when there is no incompatibility line', () => {
  assert.equal(formatSlicePresetIncompatibilityError('some unrelated CLI noise\nexit 0'), null)
  assert.equal(formatSlicePresetIncompatibilityError(''), null)
})

test('formatSliceFileVersionError names both versions and what to do about it', () => {
  // The real CLI line from BambuStudio 2.7.1.62 refusing a 2.8.0.50 project (exit 232),
  // captured on the native x86 slicer 2026-07-21.
  const output = [
    '[2026-07-21 19:53:46.471944] [0x00007] [warning] cli mode, Current BambuStudio Version 02.07.01.62',
    '[2026-07-21 19:53:46.540199] [0x00007] [error]   Version Check: File Version 2.8.0.50 not supported by current cli version 02.07.01.62',
    'run found error, return -24, exit...'
  ].join('\n')
  const message = formatSliceFileVersionError(output)
  assert.ok(message)
  // The CLI version is zero-padded in the log; users know it as 2.7.1.62.
  assert.match(message, /Bambu Studio 2\.8\.0\.50/)
  assert.match(message, /2\.7\.1\.62/)
  assert.doesNotMatch(message, /02\.07\.01\.62/)
})

test('formatSliceFileVersionError ignores unrelated output', () => {
  assert.equal(formatSliceFileVersionError(''), null)
  assert.equal(formatSliceFileVersionError('[error] some other failure\nrun found error, return -5, exit...'), null)
})

/**
 * The generic exit codes (-100 especially) say only "slicing failed"; BambuStudio prints the actual
 * reason a line or two earlier. Surfacing it is the difference between a user knowing what is wrong
 * and someone reading 48 lines of progress JSON out of the job log, which is how Ryan's
 * "Flush volumes matrix do not match to the correct size!" was found.
 */
test('a generic engine failure carries the engine\'s own last words', async () => {
  const { formatSliceCliExitError } = await import('./cli-exit-codes.js')
  const output = [
    '{"message":"Generating G-code","plate_index":1,"total_percent":75}',
    '[2026-07-27 03:59:02.6] [0x0000f90f] [warning] tree support default to organic support',
    '[2026-07-27 03:59:03.3] [0x0000f90f] [error]   found slicing or export error for partplate 1',
    'Flush volumes matrix do not match to the correct size!',
    'run found error, return -100, exit...'
  ].join('\n')

  const message = formatSliceCliExitError(output, 156)
  assert.match(message, /^Slicer CLI exited with code 156/, 'the API retry classifier matches this prefix')
  assert.match(message, /engine failed on this model/, 'keeps our explanation of -100')
  assert.match(message, /Flush volumes matrix do not match to the correct size!/, 'and the real reason')
})

test('prefers the engine\'s own words even when they land on the other stream', async () => {
  const { formatSliceCliExitError } = await import('./cli-exit-codes.js')
  // stdout and stderr arrive CONCATENATED, so the specific complaint can sit after the vague
  // tagged one and after `run found error`. Scanning must not stop at either.
  const output = [
    '[2026-07-27 04:17:29.1] [0x0000fb04] [error]   found slicing or export error for partplate 1',
    'run found error, return -100, exit...',
    'Flush volumes matrix do not match to the correct size!'
  ].join('\n')
  const message = formatSliceCliExitError(output, 156)
  assert.match(message, /Flush volumes matrix do not match to the correct size!/)
  assert.doesNotMatch(message, /found slicing or export error/, 'the vague line loses to the specific one')
})

test('engine detail is omitted when the log carries only noise', async () => {
  const { formatSliceCliExitError } = await import('./cli-exit-codes.js')
  const output = [
    '{"message":"Slicing begins","plate_index":1}',
    '[2026-07-27 03:59:02.6] [0x0000f90f] [warning] tree support default to organic support',
    'run found error, return -100, exit...'
  ].join('\n')
  const message = formatSliceCliExitError(output, 156)
  assert.doesNotMatch(message, /\(engine:/, 'no invented detail from progress or warnings')
})
