import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { StandalonePlatformContext } from '@printstream/sea-runtime'
import { resolveServerPaths } from './app-identity.js'

function context(over: Partial<StandalonePlatformContext>): StandalonePlatformContext {
  return { platform: 'linux', arch: 'x64', isPrivileged: true, env: {}, homeDir: '/home/user', ...over }
}

test('resolveServerPaths composes the per-OS layout under the PrintStream identity', () => {
  const linux = resolveServerPaths(context({ platform: 'linux', isPrivileged: true }))
  assert.equal(linux.dataDir, '/var/lib/printstream')
  assert.equal(linux.configFile, '/var/lib/printstream/server.env')
  assert.equal(linux.dbDir, '/var/lib/printstream/db')
  assert.equal(linux.installDir, '/opt/printstream')
  assert.equal(linux.exeName, 'printstream')
  assert.equal(linux.controlSocket, '/var/lib/printstream/control.sock')
  assert.equal(linux.statusFile, '/var/lib/printstream/status.json')

  const win = resolveServerPaths(context({ platform: 'win32', env: { ProgramData: 'C:\\PD', ProgramFiles: 'C:\\PF' } }))
  assert.equal(win.dataDir, 'C:\\PD\\PrintStream')
  assert.equal(win.installDir, 'C:\\PF\\PrintStream')
  assert.equal(win.exeName, 'printstream.exe')
  assert.equal(win.controlSocket, '\\\\.\\pipe\\printstream')
})

test('an explicit data-dir override wins over the per-OS default', () => {
  const paths = resolveServerPaths(context({ env: { PRINTSTREAM_DATA_DIR: '/srv/ps' } }))
  assert.equal(paths.dataDir, '/srv/ps')
  assert.equal(paths.dbDir, '/srv/ps/db')
  assert.equal(paths.libraryDir, '/srv/ps/library')
  assert.equal(paths.configFile, '/srv/ps/server.env')
})
