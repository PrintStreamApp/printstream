/** Exercise real restrictive directory modes while intercepting every privileged OS effect. */
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { mock, test } from 'node:test'
import { systemdController } from './systemd.js'
import type { ServiceSpec } from './spec.js'

const linuxOnly = { skip: process.platform !== 'linux' }

/** The synthetic account only exists in the command fixture; no user or service is created. */
async function installFixture(body: (fixture: {
  spec: ServiceSpec & { writableInstallDir: string }
  calls: string[][]
  failOwnership(): void
  missingAccount(): void
}) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'systemd-owned-install-'))
  const install = path.join(root, 'install')
  await fs.mkdir(install, { mode: 0o700 })
  await fs.writeFile(path.join(install, 'sample-app'), 'fixture only\n', { mode: 0o755 })
  const calls: string[][] = []
  let installOwned = false
  let ownershipFails = false
  let accountMissing = false
  const writeFile = fs.writeFile.bind(fs)
  const chmod = fs.chmod.bind(fs)
  const effects = [
    // All callers are Linux-only fixtures, where this optional Node API exists.
    mock.method(process as NodeJS.Process & { getuid(): number }, 'getuid', () => 0),
    mock.method(fs, 'writeFile', (file: string, contents: string, encoding: BufferEncoding) =>
      writeFile(file.startsWith('/etc/systemd/system/') ? path.join(root, 'unit') : file, contents, encoding)),
    mock.method(fs, 'chmod', (file: string, mode: number) => chmod(file.startsWith('/etc/systemd/system/') ? path.join(root, 'unit') : file, mode)),
    mock.method(childProcess, 'spawnSync', (command: string, args: string[]) => {
      calls.push([command, ...args])
      if (command === 'id' && accountMissing) return { status: 1, stdout: '', stderr: '' }
      if (command === 'chown' && args.at(-1) === install) {
        if (ownershipFails) return { status: 1, stdout: '', stderr: 'fixture ownership refusal' }
        installOwned = true
      }
      if (command === 'systemctl' && args[0] === 'enable') {
        // 0755 on the file cannot overcome the real parent's 0700 traversal gate.
        assert.equal(installOwned, true, 'service starts before it owns the restrictive install directory')
      }
      return { status: 0, stdout: '12345\n', stderr: '' }
    })
  ]
  syncBuiltinESMExports()
  try {
    assert.equal((await fs.stat(install)).mode & 0o777, 0o700)
    assert.equal((await fs.stat(path.join(install, 'sample-app'))).mode & 0o777, 0o755)
    await body({ spec: {
      id: 'sample-app', displayName: 'Sample', description: 'Fixture',
      exePath: path.join(install, 'sample-app'), args: ['run'], writableInstallDir: install,
      dataDir: path.join(root, 'data'), logsDir: path.join(root, 'data/logs'), env: {}, serviceUser: 'sample-app'
    }, calls, failOwnership: () => { ownershipFails = true }, missingAccount: () => { accountMissing = true } })
  } finally {
    for (const effect of effects) effect.mock.restore()
    syncBuiltinESMExports()
    await fs.rm(root, { recursive: true, force: true })
  }
}

test('systemd transfers the explicit restrictive install directory before enable/start', linuxOnly, async () => {
  await installFixture(async ({ spec, calls, missingAccount }) => {
    missingAccount()
    await systemdController.install(spec)
    const transfer = calls.findIndex(row => row[0] === 'chown' && row.at(-1) === spec.writableInstallDir)
    const enable = calls.findIndex(row => row[0] === 'systemctl' && row[1] === 'enable')
    const createUser = calls.findIndex(row => row[0] === 'useradd')
    assert.ok(createUser >= 0 && createUser < transfer)
    assert.ok(transfer >= 0 && transfer < enable)
  })
})

test('systemd never infers ownership of an executable directory when the caller did not opt in', linuxOnly, async () => {
  await installFixture(async ({ spec, calls }) => {
    await assert.rejects(systemdController.install({ ...spec, writableInstallDir: undefined }), /service starts before/)
    assert.equal(calls.some(row => row[0] === 'chown' && row.at(-1) === spec.writableInstallDir), false)
  })
})

test('systemd refuses ambiguous install ownership targets before privileged effects', linuxOnly, async () => {
  await installFixture(async ({ spec, calls }) => {
    for (const changed of [
      { writableInstallDir: '/' }, { writableInstallDir: 'relative' },
      { writableInstallDir: path.join(spec.writableInstallDir, 'other') }, { serviceUser: undefined }
    ]) {
      await assert.rejects(systemdController.install({ ...spec, ...changed }), /exact dedicated executable directory/)
    }
    assert.deepEqual(calls, [])
  })
})

test('systemd refuses a substituted symlink install directory without changing its referent', linuxOnly, async () => {
  await installFixture(async ({ spec, calls }) => {
    const link = `${spec.writableInstallDir}-link`
    await fs.symlink(spec.writableInstallDir, link)
    await assert.rejects(systemdController.install({ ...spec, writableInstallDir: link, exePath: path.join(link, 'sample-app') }), /non-symlink directory/)
    assert.deepEqual(calls, [])
    assert.equal((await fs.stat(spec.writableInstallDir)).mode & 0o777, 0o700)
  })
})

test('systemd ownership failure refuses activation rather than relying on an automatic restart', linuxOnly, async () => {
  await installFixture(async ({ spec, calls, failOwnership }) => {
    failOwnership()
    await assert.rejects(systemdController.install(spec), /fixture ownership refusal/)
    assert.equal(calls.some(row => row[0] === 'systemctl'), false)
  })
})
