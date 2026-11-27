/** Source-only lease lifetime tests. Native admission is mocked; no Windows process is launched. */
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { mock, test } from 'node:test'
import { setImmediate as yieldToLoop } from 'node:timers/promises'
import { clearStaleWindowsInstallOperation, describeClearInstallOperationResult, transferWindowsInstallOperation, withWindowsInstallOperation } from './windows-install-operation.js'

const executable = 'C:\\Program Files\\Example\\example.exe'
type Call = { action: string; token: string; installDir: string; serviceId: string }

/** Retain OS mocks through asynchronous settlement and restore the real platform even on rejection. */
async function withAdmission(body: (calls: Call[], refuse: () => void) => unknown): Promise<void> {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const calls: Call[] = []
  let rejected = false
  const native = mock.method(childProcess, 'spawnSync', (_command: string, _args: string[], options: { input: string }) => {
    const input = JSON.parse(options.input) as Call
    calls.push(input)
    if (rejected) return { status: 1, signal: null, stdout: '', stderr: 'private native detail' }
    const directory = 'C:\\Program Files\\.sea-operation-example'
    return { status: 0, signal: null, stdout: JSON.stringify({ directory, claim: `${directory}\\active.json`, installDir: input.installDir }) }
  })
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  syncBuiltinESMExports()
  try { await body(calls, () => { rejected = true }) } finally {
    Object.defineProperty(process, 'platform', platform)
    native.mock.restore()
    syncBuiltinESMExports()
  }
}

/** Explicitly controlled work makes lease boundaries deterministic without timers. */
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

test('Windows operation synchronously acquires and releases one matching claim', async () => {
  await withAdmission((calls) => {
    const result = withWindowsInstallOperation(executable, () => {
      assert.deepEqual(calls.map((call) => call.action), ['acquire'])
      return 42
    })
    assert.equal(result, 42)
    assert.deepEqual(calls.map((call) => call.action), ['acquire', 'release'])
    assert.equal(calls[0].token, calls[1].token)
    assert.equal(calls[0].serviceId, 'example')
  })
})

test('Windows operation releases synchronous rejection without swallowing the original error', async () => {
  await withAdmission((calls) => {
    const failure = new Error('fixture failure')
    assert.throws(() => withWindowsInstallOperation(executable, () => { throw failure }), (error) => error === failure)
    assert.deepEqual(calls.map((call) => call.action), ['acquire', 'release'])
  })
})

test('Windows operation retains ownership until asynchronous resolution or rejection', async () => {
  await withAdmission(async (calls) => {
    for (const reject of [false, true]) {
      const gate = deferred()
      const start = calls.length
      const operation = withWindowsInstallOperation(executable, async () => {
        await gate.promise
        if (reject) throw new Error('async fixture failure')
        return 'finished'
      })
      const settled = reject ? assert.rejects(operation, /async fixture failure/) : operation
      assert.deepEqual(calls.slice(start).map((call) => call.action), ['acquire'])
      gate.resolve()
      assert.equal(await settled, reject ? undefined : 'finished')
      assert.deepEqual(calls.slice(start).map((call) => call.action), ['acquire', 'release'])
    }
  })
})

test('nested synchronous and awaited asynchronous helpers share only the original claim', async () => {
  await withAdmission(async (calls) => {
    await withWindowsInstallOperation(executable, async () => {
      assert.equal(withWindowsInstallOperation(executable, () => 7), 7)
      await withWindowsInstallOperation(executable, async () => {
        await Promise.resolve()
        assert.deepEqual(calls.map((call) => call.action), ['acquire'])
      })
    })
    assert.deepEqual(calls.map((call) => call.action), ['acquire', 'release'])
  })
})

test('transferred cleanup claim survives preparation failure and cannot be transferred twice', async () => {
  await withAdmission((calls) => {
    assert.throws(() => withWindowsInstallOperation(executable, () => {
      const lease = transferWindowsInstallOperation()
      assert.equal(lease.transferred, true)
      assert.throws(transferWindowsInstallOperation, /active installation operation/)
      throw new Error('cleanup bootstrap preparation failed')
    }), /cleanup bootstrap preparation failed/)
    assert.deepEqual(calls.map((call) => call.action), ['acquire'], 'uncertain helper ownership must never release the durable claim')
    assert.throws(transferWindowsInstallOperation, /active installation operation/)
  })
})

test('rejected native admission never executes the installation callback or leaks native diagnostics', async () => {
  await withAdmission((calls, refuse) => {
    refuse()
    let mutations = 0
    assert.throws(() => withWindowsInstallOperation(executable, () => { mutations++ }), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /acquire refused/)
      assert.doesNotMatch(error.message, /private native detail/)
      return true
    })
    assert.equal(mutations, 0)
    assert.deepEqual(calls.map((call) => call.action), ['acquire'])
  })
})

test('in-flight nested sibling retains the operation after its outer callback settles', async () => {
  await withAdmission(async (calls) => {
    const gate = deferred()
    let sibling!: Promise<void>
    const operation = withWindowsInstallOperation(executable, async () => {
      sibling = withWindowsInstallOperation(executable, async () => { await gate.promise })
    })
    await Promise.resolve()
    await Promise.resolve()
    try {
      assert.deepEqual(calls.map((call) => call.action), ['acquire'], 'an admitted writer is still in flight')
    } finally {
      gate.resolve()
      await Promise.all([operation, sibling])
    }
    assert.deepEqual(calls.map((call) => call.action), ['acquire', 'release'])
  })
})

test('different executable in the same directory cannot borrow its sibling service claim', async () => {
  await withAdmission((calls, refuse) => {
    withWindowsInstallOperation(executable, () => {
      refuse()
      let entered = false
      assert.throws(() => withWindowsInstallOperation('C:\\Program Files\\Example\\other.exe', () => { entered = true }), /acquire refused|different|identity/)
      assert.equal(entered, false)
      // Transfer the original claim so mocked refusal does not affect its release.
      transferWindowsInstallOperation()
    })
    assert.equal(calls.filter((call) => call.action === 'release').length, 0)
  })
})

test('cleanup transfer refuses while a nested writer is still pending, then becomes available', async () => {
  await withAdmission(async (calls) => {
    await withWindowsInstallOperation(executable, async () => {
      const gate = deferred()
      const sibling = withWindowsInstallOperation(executable, async () => { await gate.promise })
      try {
        assert.throws(transferWindowsInstallOperation, /active installation operation|pending|flight|active.*writer/)
      } finally {
        gate.resolve()
        await sibling
      }
      transferWindowsInstallOperation()
    })
    assert.deepEqual(calls.map((call) => call.action), ['acquire'])
  })
})


test('a rejected detached child outlives a synchronous parent without releasing its claim early', async () => {
  await withAdmission(async (calls) => {
    const gate = deferred()
    let rejected!: Promise<void>
    const result = withWindowsInstallOperation(executable, () => {
      const sibling = withWindowsInstallOperation(executable, async () => {
        await gate.promise
        throw new Error('detached child failed')
      })
      rejected = assert.rejects(sibling, /detached child failed/)
      return 41
    })
    assert.equal(result, 41, 'synchronous callers retain their return contract')
    assert.deepEqual(calls.map((call) => call.action), ['acquire'])
    gate.resolve()
    await rejected
    await yieldToLoop()
    assert.deepEqual(calls.map((call) => call.action), ['acquire', 'release'])
  })
})

/** Runs `body` as Windows with a native `clear` that answers `reply`. */
async function withClearReply(reply: Record<string, unknown>, body: () => void): Promise<void> {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const directory = 'C:\\.sea-install-operation-example'
  const native = mock.method(childProcess, 'spawnSync', (_command: string, _args: string[], options: { input: string }) => {
    assert.equal(JSON.parse(options.input).action, 'clear')
    return { status: 0, signal: null, stdout: JSON.stringify({ directory, claim: `${directory}\\active.json`, installDir: 'C:\\Program Files\\Example', ...reply }) }
  })
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  syncBuiltinESMExports()
  try { body() } finally {
    Object.defineProperty(process, 'platform', platform)
    native.mock.restore()
    syncBuiltinESMExports()
  }
}

test('clear-lock reports what it removed, and never claims a removal it did not make', async () => {
  await withClearReply({ outcome: 'cleared', ownerPid: 4242, claimedAt: '2026-11-26T18:00:00.0000000Z' }, () => {
    assert.deepEqual(clearStaleWindowsInstallOperation(executable), { outcome: 'cleared', claim: 'C:\\.sea-install-operation-example\\active.json', pid: 4242, claimedAt: '2026-11-26T18:00:00.0000000Z' })
  })
  await withClearReply({ outcome: 'still-running', ownerPid: 4242 }, () => {
    assert.equal(clearStaleWindowsInstallOperation(executable).outcome, 'still-running')
  })
  await withClearReply({ outcome: 'none' }, () => {
    assert.equal(clearStaleWindowsInstallOperation(executable).outcome, 'none')
  })
  await withClearReply({ outcome: 'surprise' }, () => {
    assert.throws(() => clearStaleWindowsInstallOperation(executable), /nothing was assumed removed/)
  })
})

test('clear-lock does nothing outside Windows', () => {
  if (process.platform === 'win32') return
  assert.deepEqual(clearStaleWindowsInstallOperation(executable), { outcome: 'not-windows' })
})

test('clear-lock gives the manual route when PowerShell cannot run the check', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const native = mock.method(childProcess, 'spawnSync', () => ({ status: 1, signal: null, stdout: '', stderr: 'blocked' }))
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  syncBuiltinESMExports()
  try {
    const result = clearStaleWindowsInstallOperation(executable)
    assert.equal(result.outcome, 'refused')
    const { message, exitCode } = describeClearInstallOperationResult(result)
    assert.equal(exitCode, 4)
    assert.match(message, /\.sea-install-operation-<id>/)
    assert.doesNotMatch(message, /run 'update clear-lock'/)
  } finally {
    Object.defineProperty(process, 'platform', platform)
    native.mock.restore()
    syncBuiltinESMExports()
  }
})
