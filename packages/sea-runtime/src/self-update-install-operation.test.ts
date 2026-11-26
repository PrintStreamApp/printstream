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
