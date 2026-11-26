import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { generateLinuxTrayScript } from './linux-tray.js'
import { generateWindowsTrayScript } from './windows-tray.js'
import { linuxRefreshFixture, windowsRefreshFixture } from './tray-provider-testkit.js'

const input = {
  appName: 'PrintStream', iconPath: '/fixture/icon.png', statusFile: '/fixture/status.json',
  logsDir: '/fixture/logs', exePath: '/fixture/printstream',
}
const source = generateLinuxTrayScript(input)
const bridge = {
  pid: 42, lifecycle: 'connected', appUrl: '', workspaceUrl: 'https://example.test/workspace',
  connectCode: 'fixture', connectUrl: 'https://example.test/connect',
  build: { buildRevision: 'bridge-build', releaseFingerprint: 'fingerprint' },
}
type ItemName = 'status' | 'open' | 'version' | 'code' | 'connect' | 'copy_code' | 'workspace' | 'update' | 'start_service' | 'stop_service' | 'restart_service'
interface RefreshResult {
  items: Record<ItemName, { visible: boolean; label: string }>
  app_url: string
  workspace_url: string
  connect_url: string
  connect_code: string
}

/** Execute only the generated Linux callback, retaining its actual exceptions. */
function refresh(statuses: readonly unknown[]): RefreshResult {
  const child = spawnSync('python3', ['-c', linuxRefreshFixture], {
    input: JSON.stringify([source, statuses]), encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024,
  })
  assert.equal(child.error, undefined)
  assert.equal(child.status, 0, child.stderr)
  return JSON.parse(child.stdout) as RefreshResult
}

const linuxOnly = { skip: process.platform === 'win32' ? 'Uses Python AST on the Linux validation host' : false }

test('Linux missing status retires all stale rows without dereferencing absence', linuxOnly, () => {
  const result = refresh([null])
  assert.equal(result.items.start_service.visible, true)
  for (const key of ['open', 'workspace', 'stop_service', 'restart_service', 'update'] as const) {
    assert.equal(result.items[key].visible, false)
  }
})

test('Linux live server with fingerprint and no workspace offers Open and stop controls', linuxOnly, () => {
  const result = refresh([{ pid: 42, lifecycle: 'running', appUrl: 'http://localhost:8080', build: 'abcdef0123456789' }])
  assert.equal(result.items.open.visible, true)
  assert.equal(result.items.stop_service.visible, true)
  assert.equal(result.items.start_service.visible, false)
  assert.equal(result.items.version.label, 'Version: abcdef012345')
})

test('Linux live bridge preserves object build, workspace and pairing rows', linuxOnly, () => {
  const result = refresh([bridge])
  assert.equal(result.items.workspace.visible, true)
  assert.equal(result.items.connect.visible, true)
  assert.equal(result.items.code.visible, true)
  assert.equal(result.items.version.label, 'Version: bridge-build')
})

test('Linux live bridge without a workspace remains running and offers pairing', linuxOnly, () => {
  const result = refresh([{ ...bridge, workspaceUrl: undefined }])
  assert.equal(result.items.stop_service.visible, true)
  assert.equal(result.items.start_service.visible, false)
  assert.equal(result.items.connect.visible, true)
})

test('Linux string build remains displayable alongside optional workspace metadata', linuxOnly, () => {
  const result = refresh([{ ...bridge, build: 'abcdef0123456789' }])
  assert.equal(result.items.version.label, 'Version: abcdef012345')
})

test('Linux running-to-missing status retires prior workspace and controls', linuxOnly, () => {
  const result = refresh([bridge, null])
  assert.equal(result.workspace_url, '')
  assert.equal(result.connect_url, '')
  assert.equal(result.connect_code, '')
  assert.equal(result.app_url, '')
  assert.equal(result.items.workspace.visible, false)
  assert.equal(result.items.stop_service.visible, false)
})
/** Run one actual emitted Windows tick with inert menu objects in a fresh process. */
function refreshWindows(which: 'version' | 'retirement'): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'tray-provider-'))
  try {
    const provider = generateWindowsTrayScript(input)
    const hash = createHash('sha256').update(provider).digest('hex')
    writeFileSync(path.join(dir, 'windows-tray.ps1'), provider)
    const fixture = path.join(dir, 'fixture.ps1')
    writeFileSync(fixture, windowsRefreshFixture)
    const child = spawnSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', fixture, '-ProviderSha256', hash, '-Case', which,
    ], { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 })
    assert.equal(child.error, undefined)
    assert.equal(child.status, 0, child.stderr + child.stdout)
    const result = JSON.parse(child.stdout) as { pass: boolean }
    assert.equal(result.pass, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const windowsOnly = { skip: process.platform !== 'win32' ? 'Requires actual Windows PowerShell; no visual claim' : false }
test('Windows string server build displays the fingerprint through actual emitted tick', windowsOnly, () => {
  refreshWindows('version')
})

test('Windows missing status retires prior workspace through actual emitted tick', windowsOnly, () => {
  refreshWindows('retirement')
})
