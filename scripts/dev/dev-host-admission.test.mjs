/** Preflight must not touch a running checkout, including launchers predating host leases. */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { acquireDevRunnerLease, assertNoCheckoutHostProcesses, devRunnerAdmissionRole, isCheckoutHostProcess } from './dev-host-admission.mjs'

test('live runner lease remains byte-identical when another launcher is rejected', () => {
  const configDir = mkdtempSync(path.join(tmpdir(), 'printstream-dev-admission-'))
  const file = path.join(configDir, 'printstream-runners/checkout.lock')
  try {
    const first = acquireDevRunnerLease({ configDir, slug: 'checkout' }, { pid: 123, isAlive: () => true })
    const original = readlinkSync(file)
    assert.throws(() => acquireDevRunnerLease({ configDir, slug: 'checkout' }, { pid: 456, isAlive: () => true }), /active dev launcher/)
    assert.equal(readlinkSync(file), original)
    first.release()
    const second = acquireDevRunnerLease({ configDir, slug: 'checkout' }, { pid: 456 })
    second.release()
  } finally {
    rmSync(configDir, { recursive: true, force: true })
  }
})

test('dead lease can be reclaimed and release never deletes a replacement owner', () => {
  const configDir = mkdtempSync(path.join(tmpdir(), 'printstream-dev-admission-'))
  const file = path.join(configDir, 'printstream-runners/checkout.lock')
  try {
    const first = acquireDevRunnerLease({ configDir, slug: 'checkout' }, { pid: 123 })
    const second = acquireDevRunnerLease({ configDir, slug: 'checkout' }, { pid: 456, isAlive: () => false })
    const replacement = readlinkSync(file)
    first.release()
    assert.equal(readlinkSync(file), replacement)
    second.release()
    symlinkSync('{"pid":null}', file)
    assert.throws(() => acquireDevRunnerLease({ configDir, slug: 'checkout' }), /active dev launcher/)
  } finally {
    rmSync(configDir, { recursive: true, force: true })
  }
})

test('exact legacy runner and independent bridge block admission; other worktrees and container watchers do not', () => {
  const match = (argv, cwd) => isCheckoutHostProcess({ argv: ['/node', ...argv], cwd }, '/repo')
  assert.equal(match(['scripts/dev/run-dev.mjs'], '/repo'), true)
  assert.equal(match(['/repo/scripts/dev/run-dev.mjs'], '/tmp'), true)
  assert.equal(match(['--env-file=.env', 'scripts/dev/run-dev.mjs'], '/repo'), true)
  assert.equal(match(['scripts/dev/run-dev.mjs', '--container-runtime'], '/repo'), false)
  assert.equal(match(['/repo/scripts/dev/run-service-dev.mjs', '--name=bridge'], '/repo/apps/bridge'), true)
  assert.equal(match(['/tsx', 'src/index.ts'], '/repo/apps/bridge'), true)
  assert.equal(match(['/repo/apps/bridge/src/index.ts'], '/repo/apps/bridge'), true)
  assert.equal(match(['/repo/apps/bridge/src/index.ts'], '/repo'), true)
  assert.equal(match(['/repo/apps/bridge/dist/index.js'], '/elsewhere'), true)
  assert.equal(match(['/repo/scripts/dev/run-service-dev.mjs', '--name=bridge'], '/repo'), true)
  assert.equal(match(['dist/index.js'], '/repo/apps/bridge'), true)
  assert.equal(match(['/other/scripts/dev/run-service-dev.mjs', '--name=bridge'], '/other/apps/bridge'), false)
})

test('unrelated unreadable cwd is skipped; actual candidates unreadable cwd refuse admission', () => {
  const procRoot = mkdtempSync(path.join(tmpdir(), 'printstream-dev-proc-'))
  const deniedCwd = () => {
    throw Object.assign(new Error('cwd denied'), { code: 'EACCES' })
  }
  try {
    const directory = path.join(procRoot, '331')
    mkdirSync(directory)
    writeFileSync(path.join(directory, 'cmdline'), ['/usr/lib/systemd/systemd', '--user'].join('\0'))
    assert.doesNotThrow(() => assertNoCheckoutHostProcesses('/repo', { procRoot, selfPid: 123, readCwd: deniedCwd }))
    writeFileSync(path.join(directory, 'cmdline'), ['/node', '/repo/apps/bridge/src/index.ts'].join('\0'))
    assert.throws(() => assertNoCheckoutHostProcesses('/repo', { procRoot, selfPid: 123, readCwd: deniedCwd }), { code: 'EACCES' })
    writeFileSync(path.join(directory, 'cmdline'), ['/node', '/repo/apps/bridge/src/index.ts', '--container-runtime'].join('\0'))
    assert.throws(() => assertNoCheckoutHostProcesses('/repo', { procRoot, selfPid: 123, readCwd: deniedCwd }), { code: 'EACCES' })
    writeFileSync(path.join(directory, 'cmdline'), ['/node', '/repo/scripts/dev/run-dev.mjs', '--container-runtime'].join('\0'))
    assert.doesNotThrow(() => assertNoCheckoutHostProcesses('/repo', { procRoot, selfPid: 123, readCwd: deniedCwd }))
  } finally {
    rmSync(procRoot, { recursive: true, force: true })
  }
})

test('admission guard cannot be stolen or cause another runner lease to disappear', () => {
  const configDir = mkdtempSync(path.join(tmpdir(), 'printstream-dev-admission-'))
  const file = path.join(configDir, 'printstream-runners/checkout.lock')
  try {
    const lease = acquireDevRunnerLease({ configDir, slug: 'checkout' }, { pid: 123 })
    const original = readlinkSync(file)
    symlinkSync('{"pid":999}', `${file}.admission`)
    assert.throws(() => acquireDevRunnerLease({ configDir, slug: 'checkout' }, { isAlive: () => false }), /admitting/)
    assert.equal(readlinkSync(file), original)
    lease.release()
  } finally {
    rmSync(configDir, { recursive: true, force: true })
  }
})

test('process inspection refuses an independent bridge and ignores self/container/worktree processes', () => {
  const procRoot = mkdtempSync(path.join(tmpdir(), 'printstream-dev-proc-'))
  const records = [
    [123, '/repo', ['/node', 'scripts/dev/run-dev.mjs']],
    [456, '/repo/apps/bridge', ['/node', '/repo/scripts/dev/run-service-dev.mjs', '--name=bridge']],
    [789, '/repo', ['/node', 'scripts/dev/run-dev.mjs', '--container-runtime']],
    [999, '/other', ['/node', 'scripts/dev/run-dev.mjs']]
  ]
  try {
    for (const [pid, cwd, argv] of records) {
      const directory = path.join(procRoot, String(pid))
      mkdirSync(directory)
      symlinkSync(cwd, path.join(directory, 'cwd'))
      writeFileSync(path.join(directory, 'cmdline'), argv.join('\0'))
    }
    assert.throws(() => assertNoCheckoutHostProcesses('/repo', { procRoot, selfPid: 123 }), /PID 456/)
    rmSync(path.join(procRoot, '456'), { recursive: true })
    assert.doesNotThrow(() => assertNoCheckoutHostProcesses('/repo', { procRoot, selfPid: 123 }))
  } finally {
    rmSync(procRoot, { recursive: true, force: true })
  }
})

test('a background launch admits only the child that runs the stack', () => {
  // The invoking process only hands off; the detached child (flagged by devkit) takes the lease.
  assert.equal(devRunnerAdmissionRole({ argv: ['node', 'run-dev.mjs', '--background'], env: {} }), 'launcher')
  assert.equal(devRunnerAdmissionRole({ argv: ['node', 'run-dev.mjs'], env: { DEVKIT_BACKGROUND_CHILD: '1' } }), 'background-child')
  assert.equal(devRunnerAdmissionRole({ argv: ['node', 'run-dev.mjs'], env: {} }), 'foreground')
})

test('the background child does not count its waiting launcher as a rival runner', () => {
  const procRoot = mkdtempSync(path.join(tmpdir(), 'printstream-dev-proc-'))
  const records = [
    [200, '/repo', ['/node', 'scripts/dev/run-dev.mjs', '--background']],
    [201, '/repo', ['/node', 'scripts/dev/run-dev.mjs']]
  ]
  try {
    for (const [pid, cwd, argv] of records) {
      const directory = path.join(procRoot, String(pid))
      mkdirSync(directory)
      symlinkSync(cwd, path.join(directory, 'cwd'))
      writeFileSync(path.join(directory, 'cmdline'), argv.join('\0'))
    }
    // Without the exemption the launcher reads as a second runner, which is what broke the launch.
    assert.throws(() => assertNoCheckoutHostProcesses('/repo', { procRoot, selfPid: 201 }), /PID 200/)
    assert.doesNotThrow(() => assertNoCheckoutHostProcesses('/repo', { procRoot, selfPid: 201, ignorePids: [200] }))
  } finally {
    rmSync(procRoot, { recursive: true, force: true })
  }
})

test('the lease is held by the background child, not refused because of its launcher', () => {
  const configDir = mkdtempSync(path.join(tmpdir(), 'printstream-dev-admission-'))
  try {
    // The launcher no longer takes a lease, so the child's claim is the first and succeeds.
    const lease = acquireDevRunnerLease({ configDir, slug: 'printstream' }, { pid: 201, isAlive: () => true })
    assert.throws(
      () => acquireDevRunnerLease({ configDir, slug: 'printstream' }, { pid: 202, isAlive: () => true }),
      /active dev launcher/
    )
    lease.release()
  } finally {
    rmSync(configDir, { recursive: true, force: true })
  }
})
