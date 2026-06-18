import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  resolveStandaloneDataDir,
  resolveStandaloneInstallDir,
  standaloneControlSocket,
  standaloneExeName,
  standalonePlatformKey,
  type StandaloneAppIdentity,
  type StandalonePlatformContext
} from './paths.js'

const identity: StandaloneAppIdentity = {
  appId: 'sample-app',
  displayName: 'Sample App'
}

function context(over: Partial<StandalonePlatformContext>): StandalonePlatformContext {
  return { platform: 'linux', arch: 'x64', isPrivileged: false, env: {}, homeDir: '/home/user', ...over }
}

test('data dir follows each platform convention and the identity', () => {
  assert.equal(
    resolveStandaloneDataDir(context({ platform: 'win32', env: { ProgramData: 'D:\\PD' } }), identity),
    'D:\\PD\\Sample App'
  )
  assert.equal(resolveStandaloneDataDir(context({ isPrivileged: true }), identity), '/var/lib/sample-app')
  assert.equal(
    resolveStandaloneDataDir(context({ env: { XDG_DATA_HOME: '/x/share' } }), identity),
    '/x/share/sample-app'
  )
})

test('install dir, exe name, control socket, platform key', () => {
  assert.equal(
    resolveStandaloneInstallDir(context({ platform: 'win32', env: { ProgramFiles: 'C:\\PF' } }), identity),
    'C:\\PF\\Sample App'
  )
  assert.equal(resolveStandaloneInstallDir(context({}), identity), '/opt/sample-app')

  assert.equal(standaloneExeName(identity, 'win32'), 'sample-app.exe')
  assert.equal(standaloneExeName(identity, 'linux'), 'sample-app')

  assert.equal(standaloneControlSocket(identity, 'win32', 'C:\\data'), '\\\\.\\pipe\\sample-app')
  assert.equal(standaloneControlSocket(identity, 'linux', '/var/lib/sample-app'), '/var/lib/sample-app/control.sock')

  assert.equal(standalonePlatformKey('linux', 'arm64'), 'linux-arm64')
})
