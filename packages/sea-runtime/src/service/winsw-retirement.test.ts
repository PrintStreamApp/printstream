/** Real controller orchestration with only subprocess and file-removal effects replaced. No Windows service is touched. */
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { mock, test } from 'node:test'
import { createWinswController, winswConfigPath, winswWrapperPath } from './winsw.js'
import type { ServiceSpec } from './spec.js'

const spec: ServiceSpec = { id: 'fixture', displayName: 'Fixture', description: 'Fixture only',
  exePath: 'C:\\Program Files\\Fixture\\fixture.exe', args: ['run'], dataDir: 'C:\\ProgramData\\Fixture',
  logsDir: 'C:\\ProgramData\\Fixture\\logs', env: {} }
const state = (status: string) => ({ State: status, ProcessId: status === 'Stopped' ? 0 : 123,
  PathName: `"${winswWrapperPath(spec)}"` })
const active = state('Running')
const inactive = state('Stopped')

/** Feed strict SCM observations and bounded command outcomes, recording every destructive effect. */
async function withController(observations: (unknown | Error)[], commandFailure: { action: string; timeout?: boolean } | null,
  run: (controller: ReturnType<typeof createWinswController>, calls: string[]) => Promise<void>): Promise<void> {
  const calls: string[] = []
  const native = mock.method(childProcess, 'spawnSync', (command: string, args: string[], options: { timeout?: number }) => {
    if (command === 'powershell') {
      calls.push('observe')
      assert.ok(observations.length, 'unexpected service query')
      const observed = observations.shift()
      if (observed instanceof Error) return { status: 1, signal: null, stdout: '', stderr: '', error: observed }
      return { status: 0, signal: null, stdout: JSON.stringify(observed), stderr: '' }
    }
    assert.equal(command, winswWrapperPath(spec))
    const action = args[0]!
    calls.push(action)
    if (action === 'stopwait' || action === 'uninstall') assert.equal(options.timeout, 60_000)
    if (commandFailure?.action === action) {
      return commandFailure.timeout
        ? { status: null, signal: 'SIGTERM', stdout: '', stderr: '', error: Object.assign(new Error('fixture timeout'), { code: 'ETIMEDOUT' }) }
        : { status: 1, signal: null, stdout: '', stderr: 'fixture command refused' }
    }
    return { status: 0, signal: null, stdout: '', stderr: '' }
  })
  const remove = mock.method(fs, 'rm', async (file: string) => {
    assert.ok([winswConfigPath(spec), winswWrapperPath(spec)].includes(file), 'only admitted wrapper artifacts may be removed')
    calls.push(file.endsWith('.xml') ? 'remove-config' : 'remove-wrapper')
  })
  syncBuiltinESMExports()
  try { await run(createWinswController({ resolveWinswAsset: () => null }), calls) } finally {
    native.mock.restore()
    remove.mock.restore()
    syncBuiltinESMExports()
  }
}

function assertFilesRetained(calls: string[]): void {
  assert.equal(calls.includes('remove-config'), false)
  assert.equal(calls.includes('remove-wrapper'), false)
}

test('WinSW uninstall waits for stop, verifies inactive, then verifies absence before deleting either artifact', async () => {
  await withController([active, inactive, null], null, async (controller, calls) => {
    await controller.uninstall(spec)
    assert.deepEqual(calls, ['observe', 'stopwait', 'observe', 'uninstall', 'observe', 'remove-config', 'remove-wrapper'])
  })
})

test('already inactive WinSW service still requires observed absence after uninstall', async () => {
  await withController([inactive, null], null, async (controller, calls) => {
    await controller.uninstall(spec)
    assert.deepEqual(calls, ['observe', 'uninstall', 'observe', 'remove-config', 'remove-wrapper'])
  })
})

test('genuinely absent WinSW service cleans only the orphan wrapper artifacts', async () => {
  await withController([null], null, async (controller, calls) => {
    await controller.uninstall(spec)
    assert.deepEqual(calls, ['observe', 'remove-config', 'remove-wrapper'])
  })
})

test('failed initial WinSW query preserves both wrapper artifacts without submitting commands', async () => {
  await withController([new Error('query refused')], null, async (controller, calls) => {
    await assert.rejects(controller.uninstall(spec), /query refused/)
    assert.deepEqual(calls, ['observe'])
  })
})

for (const timeout of [false, true]) {
  test(`WinSW stopwait ${timeout ? 'timeout' : 'failure'} refuses uninstall and both file removals`, async () => {
    await withController([active], { action: 'stopwait', timeout }, async (controller, calls) => {
      await assert.rejects(controller.uninstall(spec), /fixture/)
      assert.deepEqual(calls, ['observe', 'stopwait'])
      assertFilesRetained(calls)
    })
  })
}

for (const [label, observation] of [['still-running', active], ['stop-pending', state('Stop Pending')],
  ['disappeared', null], ['query-failure', new Error('post-stop query failed')]] as const) {
  test(`WinSW post-stop ${label} refuses uninstall and retains artifacts`, async () => {
    await withController([active, observation], null, async (controller, calls) => {
      await assert.rejects(controller.uninstall(spec))
      assert.deepEqual(calls, ['observe', 'stopwait', 'observe'])
      assertFilesRetained(calls)
    })
  })
}

test('WinSW uninstall command failure retains artifacts after the stopped observation', async () => {
  await withController([inactive], { action: 'uninstall' }, async (controller, calls) => {
    await assert.rejects(controller.uninstall(spec), /fixture command refused/)
    assert.deepEqual(calls, ['observe', 'uninstall'])
    assertFilesRetained(calls)
  })
})

for (const [label, observation] of [['marked-for-delete', inactive], ['restarted', active],
  ['unknown', state('Stop Pending')], ['query-failure', new Error('post-uninstall query failed')]] as const) {
  test(`successful WinSW uninstall with ${label} observation cannot delete its wrapper artifacts`, async () => {
    await withController([inactive, observation], null, async (controller, calls) => {
      await assert.rejects(controller.uninstall(spec))
      assert.deepEqual(calls, ['observe', 'uninstall', 'observe'])
      assertFilesRetained(calls)
    })
  })
}

test('normal WinSW stop uses the waiting command and returns only after observed inactive', async () => {
  await withController([active, inactive], null, async (controller, calls) => {
    controller.stop(spec)
    assert.deepEqual(calls, ['observe', 'stopwait', 'observe'])
    assertFilesRetained(calls)
  })
})

test('normal WinSW stop refuses a still-pending observation instead of pretending retirement', async () => {
  await withController([active, state('Stop Pending')], null, async (controller, calls) => {
    assert.throws(() => controller.stop(spec))
    assert.deepEqual(calls, ['observe', 'stopwait', 'observe'])
  })
})

test('normal WinSW stop of an already inactive service requires no repeated stop command', async () => {
  await withController([inactive], null, async (controller, calls) => {
    controller.stop(spec)
    assert.deepEqual(calls, ['observe'])
  })
})
