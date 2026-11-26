/** Source-only scheduler handoff tests. Process creation and native ACL admission are mocked. */
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'
import { mock, test } from 'node:test'
import { scheduleWindowsInstallDirCleanup } from './windows-install-cleanup.js'

const warningText = 'Windows installation cleanup could not be started; installation operation claim retained for administrator recovery.'
type NativeInput = { action?: string; directory?: string; installDir?: string; payload?: string; contents?: string }

/** Delegate OS effects while the real scheduler retains admission, transfer and lifetime policy. */
function observeScheduler(failure: 'none' | 'acquire' | 'bootstrap' | 'ack', body: (state: {
  calls: { executable: string; args: string[]; options: unknown }[]
  records: NativeInput[]; helper: EventEmitter; warnings: string[]; unrefCalls: number
}) => void): void {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const state = { calls: [] as { executable: string; args: string[]; options: unknown }[], records: [] as NativeInput[],
    helper: new EventEmitter() as EventEmitter & { unref(): void }, warnings: [] as string[], unrefCalls: 0 }
  state.helper.unref = () => { state.unrefCalls++ }
  const spawn = mock.method(childProcess, 'spawn', (executable: string, args: string[], options: unknown) => {
    state.calls.push({ executable, args, options })
    return state.helper
  })
  const setup = mock.method(childProcess, 'spawnSync', (_executable: string, args: string[], options: { input?: string; timeout?: number }) => {
    if (options.input === undefined) {
      state.records.push({ action: 'ack' })
      assert.equal(options.timeout, 15000)
      const script = Buffer.from(args.at(-1)!, 'base64').toString('utf16le')
      assert.match(script, /received-[0-9a-f-]+/)
      assert.match(script, /AddSeconds\(10\)/)
      assert.equal(state.calls.length, 1, 'receiver acknowledgement follows the actual helper launch')
      return { status: failure === 'ack' ? null : 0, signal: failure === 'ack' ? 'SIGTERM' : null, stdout: '', stderr: '' }
    }
    const input = JSON.parse(options.input) as NativeInput
    state.records.push(input)
    if ((failure === 'acquire' && input.action) || (failure === 'bootstrap' && !input.action)) {
      return { status: 1, signal: null, stdout: '', stderr: 'private diagnostic' }
    }
    if (input.action) {
      const directory = 'C:\\Program Files\\.sea-operation-owned'
      return { status: 0, signal: null, stdout: JSON.stringify({ directory, claim: `${directory}\\active.json`,
        installDir: input.installDir, cutoff: '134000000000000000' }) }
    }
    return { status: 0, signal: null, stdout: JSON.stringify({ directory: input.directory, launcher: `${input.directory}\\cleanup.vbs` }) }
  })
  const warning = mock.method(console, 'warn', (message: string) => { state.warnings.push(message) })
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  syncBuiltinESMExports()
  try {
    const schedule = () => scheduleWindowsInstallDirCleanup('C:\\Program Files\\owned', 'owned')
    if (failure === 'acquire') assert.throws(schedule, /acquire refused/)
    else assert.equal(schedule(), undefined)
    body(state)
  } finally {
    Object.defineProperty(process, 'platform', platform)
    spawn.mock.restore()
    setup.mock.restore()
    warning.mock.restore()
    syncBuiltinESMExports()
  }
}

test('cleanup transfers its claim before secure hidden WScript handoff and leaves helper independent', () => {
  observeScheduler('none', ({ calls, records, unrefCalls }) => {
    assert.equal(unrefCalls, 1)
    assert.deepEqual(records.map((record) => record.action ?? 'bootstrap'), ['acquire', 'bootstrap', 'ack'])
    assert.match(records[1].payload!, /AssertInstallClaim \$control \$record.token/)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].executable, 'C:\\Windows\\System32\\wscript.exe')
    assert.deepEqual(calls[0].args.slice(0, 2), ['//nologo', '//B'])
    assert.match(calls[0].args[2], /^C:\\Program Files\\\.sea-cleanup-[0-9a-f-]+\\cleanup.vbs$/)
    assert.deepEqual(calls[0].options, { detached: true, stdio: 'ignore', windowsHide: true })
  })
})

test('bootstrap refusal never launches or releases the transferred claim and hides native diagnostics', () => {
  observeScheduler('bootstrap', ({ calls, records, warnings, unrefCalls }) => {
    assert.equal(calls.length, 0)
    assert.equal(unrefCalls, 0)
    assert.deepEqual(records.map((record) => record.action ?? 'bootstrap'), ['acquire', 'bootstrap'])
    assert.deepEqual(warnings, [warningText])
  })
})

test('native operation refusal prevents bootstrap and detached launch', () => {
  observeScheduler('acquire', ({ calls, records, warnings }) => {
    assert.equal(calls.length, 0)
    assert.deepEqual(records.map((record) => record.action), ['acquire'])
    assert.deepEqual(warnings, [])
  })
})

test('asynchronous cleanup spawn refusal retains the claim and reports only a fixed diagnostic', () => {
  observeScheduler('none', ({ helper, records, warnings }) => {
    assert.equal(helper.listenerCount('error'), 1)
    helper.emit('error', new Error('untrusted path or credential must not reach diagnostics'))
    assert.deepEqual(warnings, [warningText])
    assert.deepEqual(records.map((record) => record.action ?? 'bootstrap'), ['acquire', 'bootstrap', 'ack'])
  })
})


test('receiver acknowledgement timeout retains the transferred claim and reports uncertainty', () => {
  observeScheduler('ack', ({ calls, records, warnings, unrefCalls }) => {
    assert.equal(calls.length, 1)
    assert.equal(unrefCalls, 1)
    assert.deepEqual(records.map((record) => record.action ?? 'bootstrap'), ['acquire', 'bootstrap', 'ack'])
    assert.deepEqual(warnings, [warningText])
  })
})
