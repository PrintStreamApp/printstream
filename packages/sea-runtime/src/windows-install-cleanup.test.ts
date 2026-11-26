import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { WindowsInstallOperation } from './windows-install-operation.js'
import { buildInstallDirCleanupScript } from './windows-elevation.js'

/** Model an already admitted operation; native token validation is qualified separately. */
function cleanup(directory: string, name: string): string {
  const operation: WindowsInstallOperation = { installDir: directory, serviceId: name, token: 'fixture-token',
    directory: 'C:\\Program Files\\.sea-operation-test', claim: 'C:\\Program Files\\.sea-operation-test\\active.json',
    active: true, transferred: true, pending: new Set() }
  return buildInstallDirCleanupScript(directory, name, operation)
}

test('cleanup binds termination to the exact installed executable, leaving basename peers foreign', () => {
  const script = cleanup('C:\\Program Files\\PrintStream', 'printstream')
  assert.match(script, /TerminateInstalledProcess\(\$candidate.Id, 'C:\\Program Files\\PrintStream\\printstream.exe', \[long\]\$claim.cutoff\)/)
  assert.doesNotMatch(script, /Stop-Process/)
  assert.match(script, /QueryFullProcessImageName\(handle,/)
  assert.match(script, /TerminateProcess\(handle, 0\)/)
  assert.match(script, /finally\s*{\s*CloseHandle\(handle\)/)
  assert.match(script, /StringComparison.OrdinalIgnoreCase/)
  assert.match(script, /GetProcessTimes\(handle, out created/)
  assert.match(script, /created > cutoff/)
  assert.match(script, /'received-' \+ \$record.token/)
  assert.match(script, /\[IO.FileMode\]::CreateNew/)
  assert.ok(script.indexOf('AssertInstallClaim $control $record.token') < script.indexOf('Start-Sleep -Seconds 4'))
})

test('generic bridge cleanup retains its independent executable path and deferred deletion', () => {
  const script = cleanup('C:\\Program Files\\PrintStream Bridge', 'printstream-bridge')
  assert.match(script, /'C:\\Program Files\\PrintStream Bridge\\printstream-bridge.exe'/)
  assert.match(script, /Start-Sleep -Seconds 4/)
  assert.match(script, /Remove-Item -LiteralPath 'C:\\Program Files\\PrintStream Bridge'/)
  assert.match(script, /\$i -lt 120/)
  assert.match(script, /printstream-bridge-uninstall-cleanup.log/)
})

test('cleanup quotes owned paths without permitting executable name injection or drive-root deletion', () => {
  const script = cleanup("C:\\Apps\\Ryan's server", 'sample-server')
  assert.match(script, /'C:\\Apps\\Ryan''s server\\sample-server.exe'/)
  for (const name of ['', '../foreign', 'app;Stop-Process', "app'", '.']) {
    assert.throws(() => cleanup('C:\\Apps\\owned', name), /safe executable basename/)
  }
  for (const directory of ['relative', 'C:\\', '\\\\server\\share\\']) {
    assert.throws(() => cleanup(directory, 'app'), /absolute non-root/)
  }
})
