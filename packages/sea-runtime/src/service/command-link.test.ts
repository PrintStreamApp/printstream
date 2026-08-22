/**
 * The PATH symlink a Unix install leaves behind, whose whole point is that
 * `printstream-bridge status` resolves for someone who did not memorize
 * `/opt/printstream-bridge/`. The rules under test are the two that decide
 * whether it is safe to run as root during an install: never clobber a file we
 * did not create, and never unlink one either.
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readlink, symlink, writeFile, stat, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { ensureCommandLink, removeCommandLink } from './command-link.js'

const isLinux = process.platform === 'linux'

async function scratch(): Promise<{ linkDir: string; exePath: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'command-link-'))
  const linkDir = path.join(root, 'bin')
  const installDir = path.join(root, 'opt', 'printstream-bridge')
  await mkdir(linkDir, { recursive: true })
  await mkdir(installDir, { recursive: true })
  const exePath = path.join(installDir, 'printstream-bridge')
  await writeFile(exePath, '#!/bin/sh\n', { mode: 0o755 })
  return { linkDir, exePath }
}

test('ensureCommandLink puts the command on PATH', { skip: !isLinux }, async () => {
  const { linkDir, exePath } = await scratch()
  const linkPath = await ensureCommandLink({ exePath, commandName: 'printstream-bridge', linkDir })
  assert.equal(linkPath, path.join(linkDir, 'printstream-bridge'))
  assert.equal(await readlink(linkPath!), exePath)
  // Resolves to a runnable file, which is the entire claim being made to users.
  assert.ok((await stat(linkPath!)).isFile())
})

test('ensureCommandLink re-points its own stale link after a reinstall', { skip: !isLinux }, async () => {
  const { linkDir, exePath } = await scratch()
  const linkPath = path.join(linkDir, 'printstream-bridge')
  await symlink('/opt/somewhere-else/printstream-bridge', linkPath)
  await ensureCommandLink({ exePath, commandName: 'printstream-bridge', linkDir })
  assert.equal(await readlink(linkPath), exePath)
})

test('ensureCommandLink refuses to clobber a real file it did not create', { skip: !isLinux }, async () => {
  const { linkDir, exePath } = await scratch()
  const linkPath = path.join(linkDir, 'printstream-bridge')
  await writeFile(linkPath, 'somebody else\n')
  assert.equal(await ensureCommandLink({ exePath, commandName: 'printstream-bridge', linkDir }), null)
  assert.ok((await lstat(linkPath)).isFile())
  assert.ok(!(await lstat(linkPath)).isSymbolicLink())
})

test('removeCommandLink removes our link and leaves anything else alone', { skip: !isLinux }, async () => {
  const { linkDir, exePath } = await scratch()
  const linkPath = path.join(linkDir, 'printstream-bridge')

  await ensureCommandLink({ exePath, commandName: 'printstream-bridge', linkDir })
  await removeCommandLink({ exePath, commandName: 'printstream-bridge', linkDir })
  assert.equal(await lstat(linkPath).catch(() => null), null)

  // A symlink to somebody else's binary that happens to share the name: an
  // uninstall must not take it with us.
  await symlink('/usr/bin/env', linkPath)
  await removeCommandLink({ exePath, commandName: 'printstream-bridge', linkDir })
  assert.equal(await readlink(linkPath), '/usr/bin/env')

  // Nothing there at all is not an error.
  await removeCommandLink({ exePath, commandName: 'nothing-here', linkDir })
})
