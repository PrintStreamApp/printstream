/** Real isolated files prove foreign update bookkeeping grants no rename, deletion or state mutation. */
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { mock, test } from 'node:test'
import { confirmSelfUpdateHealthy, noteBootAttemptAndMaybeRollback, rollbackSelfUpdate, writeSelfUpdateState } from './self-update.js'

for (const action of ['boot', 'rollback', 'confirm'] as const) {
  test(`Windows ${action} refuses a backup for another executable without changing any files`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'sea-backup-authority-'))
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    const calls: string[] = []
    const native = mock.method(childProcess, 'spawnSync', (_command: string, _args: string[], options: { input: string }) => {
      const input = JSON.parse(options.input)
      calls.push(input.action)
      const control = 'C:\\Program Files\\.sea-operation-test'
      return { status: 0, signal: null, stdout: JSON.stringify({ directory: control,
        claim: `${control}\\active.json`, installDir: input.installDir }) }
    })
    const exePath = path.join(directory, 'owned.exe')
    const updateStateFile = path.join(directory, 'self-update.json')
    const heldBackFile = path.join(directory, 'held-back.json')
    try {
      for (const name of ['owned.exe', 'foreign.exe.old', 'owned.exe.old-foreign', 'owned.exe.failed', 'owned.exe.new', 'owned.exe.rollback-tmp', 'held-back.json']) {
        await writeFile(path.join(directory, name), `retained fixture: ${name}`)
      }
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      syncBuiltinESMExports()
      for (const name of ['foreign.exe.old', 'owned.exe.old-foreign']) {
        await writeSelfUpdateState(updateStateFile, { fromFingerprint: 'old', toFingerprint: 'new',
          updatedAt: new Date().toISOString(), bootAttempts: 20, backupPath: path.join(directory, name) })
        const snapshot = async () => Object.fromEntries(await Promise.all((await readdir(directory)).sort().map(async (file) =>
          [file, (await readFile(path.join(directory, file))).toString('base64') ])))
        const before = await snapshot()
        const input = { exePath, updateStateFile, heldBackFile }
        const operation = action === 'boot' ? noteBootAttemptAndMaybeRollback(input)
          : action === 'rollback' ? rollbackSelfUpdate(input) : confirmSelfUpdateHealthy(input)
        await assert.rejects(operation, /backup belongs to a different executable/)
        assert.deepEqual(await snapshot(), before, 'including foreign bytes, owned executable, rollback remnants and update/holdback state')
      }
      assert.deepEqual(calls, ['acquire', 'release', 'acquire', 'release'])
    } finally {
      Object.defineProperty(process, 'platform', platform)
      native.mock.restore()
      syncBuiltinESMExports()
      await rm(directory, { recursive: true, force: true })
    }
  })
}

/**
 * Runs `body` as Windows with a native admission that refuses to acquire, as when a crash left the
 * lock or PowerShell cannot run. Returns the actions the boot asked for.
 */
async function withRefusedLock(body: (directory: string) => Promise<void>): Promise<string[]> {
  const directory = await mkdtemp(path.join(tmpdir(), 'sea-boot-refused-'))
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const calls: string[] = []
  const native = mock.method(childProcess, 'spawnSync', (_command: string, _args: string[], options: { input: string; timeout: number }) => {
    calls.push(`${JSON.parse(options.input).action}:${options.timeout}`)
    return { status: 1, signal: null, stdout: '', stderr: 'claim held' }
  })
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  syncBuiltinESMExports()
  try { await body(directory) } finally {
    Object.defineProperty(process, 'platform', platform)
    native.mock.restore()
    syncBuiltinESMExports()
    await rm(directory, { recursive: true, force: true })
  }
  return calls
}

test('a boot that cannot take the Windows lock is still counted, with the longer boot timeout', async () => {
  const calls = await withRefusedLock(async (directory) => {
    const input = { exePath: path.join(directory, 'owned.exe'), updateStateFile: path.join(directory, 'self-update.json'), heldBackFile: path.join(directory, 'held-back.json') }
    await writeFile(input.exePath, 'new build')
    await writeFile(`${input.exePath}.old`, 'old build')
    await writeSelfUpdateState(input.updateStateFile, { fromFingerprint: 'old', toFingerprint: 'new', updatedAt: new Date().toISOString(), bootAttempts: 0, backupPath: `${input.exePath}.old` })
    assert.equal(await noteBootAttemptAndMaybeRollback(input), 'counted')
    assert.equal(JSON.parse(await readFile(input.updateStateFile, 'utf8')).bootAttempts, 1)
  })
  assert.deepEqual(calls, ['acquire:60000'])
})

test('past the limit without the lock, the binary is left alone and the log names clear-lock', async (context) => {
  const errors: string[] = []
  context.mock.method(console, 'error', (message: string) => { errors.push(message) })
  await withRefusedLock(async (directory) => {
    const input = { exePath: path.join(directory, 'owned.exe'), updateStateFile: path.join(directory, 'self-update.json'), heldBackFile: path.join(directory, 'held-back.json'), maxAttempts: 2 }
    await writeFile(input.exePath, 'new build')
    await writeFile(`${input.exePath}.old`, 'old build')
    await writeSelfUpdateState(input.updateStateFile, { fromFingerprint: 'old', toFingerprint: 'new', updatedAt: new Date().toISOString(), bootAttempts: 2, backupPath: `${input.exePath}.old` })
    assert.equal(await noteBootAttemptAndMaybeRollback(input), 'rollback-blocked')
    assert.equal(await readFile(input.exePath, 'utf8'), 'new build', 'no installed file is swapped without the lock')
    assert.equal(await readFile(`${input.exePath}.old`, 'utf8'), 'old build')
  })
  assert.equal(errors.length, 1)
  assert.match(errors[0]!, /update clear-lock/)
  assert.match(errors[0]!, /administrator/)
})

test('a healthy build whose update cannot be finalized keeps running and says what to do', async (context) => {
  const warnings: string[] = []
  context.mock.method(console, 'warn', (message: string) => { warnings.push(message) })
  await withRefusedLock(async (directory) => {
    const input = { exePath: path.join(directory, 'owned.exe'), updateStateFile: path.join(directory, 'self-update.json') }
    await writeSelfUpdateState(input.updateStateFile, { fromFingerprint: 'old', toFingerprint: 'new', updatedAt: new Date().toISOString(), bootAttempts: 1, backupPath: `${input.exePath}.old` })
    assert.equal(await confirmSelfUpdateHealthy(input), false)
    assert.equal(JSON.parse(await readFile(input.updateStateFile, 'utf8')).bootAttempts, 1, 'left pending for the next start')
  })
  assert.match(warnings.join('\n'), /update clear-lock/)
})
