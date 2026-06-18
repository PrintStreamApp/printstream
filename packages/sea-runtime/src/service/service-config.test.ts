import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateSystemdUnit, systemdUnitPath } from './systemd.js'
import { generateWinswConfig, winswConfigPath, winswWrapperPath } from './winsw.js'
import type { ServiceSpec } from './spec.js'

/** A synthetic, app-agnostic spec so these tests carry no bridge identity. */
const baseSpec: ServiceSpec = {
  id: 'sample-app',
  displayName: 'Sample App',
  description: 'A sample service.',
  exePath: '/opt/sample-app/sample-app',
  args: ['run'],
  dataDir: '/var/lib/sample-app',
  logsDir: '/var/lib/sample-app/logs',
  env: { SAMPLE_DATA_DIR: '/var/lib/sample-app' },
  configFile: '/var/lib/sample-app/app.env',
  serviceUser: 'sample-app'
}

test('systemd unit reflects the spec and the optional documentation URL', () => {
  assert.equal(systemdUnitPath(baseSpec), '/etc/systemd/system/sample-app.service')

  const withoutDocs = generateSystemdUnit(baseSpec)
  assert.match(withoutDocs, /Description=Sample App/)
  assert.match(withoutDocs, /User=sample-app/)
  assert.match(withoutDocs, /Environment=SAMPLE_DATA_DIR=/)
  assert.equal(/Documentation=/.test(withoutDocs), false, 'no Documentation line when unset')

  const withDocs = generateSystemdUnit({ ...baseSpec, documentationUrl: 'https://example.test' })
  assert.match(withDocs, /Documentation=https:\/\/example\.test/)
})

test('WinSW config and paths reflect the spec (win32 layout)', () => {
  const config = generateWinswConfig(baseSpec)
  assert.match(config, /<id>sample-app<\/id>/)
  assert.match(config, /<name>Sample App<\/name>/)
  assert.match(config, /<env name="SAMPLE_DATA_DIR"/)
  assert.ok(winswWrapperPath(baseSpec).endsWith('sample-app-service.exe'))
  assert.ok(winswConfigPath(baseSpec).endsWith('sample-app-service.xml'))
})

test('WinSW config emits a service account only when one is set', () => {
  // Default (LocalSystem): no <serviceaccount> block — the bridge's case.
  assert.equal(/<serviceaccount>/.test(generateWinswConfig(baseSpec)), false)

  // The self-hosted server pins NetworkService so PostgreSQL (which refuses to
  // run as an admin/LocalSystem account) can start.
  const withAccount = generateWinswConfig({ ...baseSpec, serviceAccount: 'NT AUTHORITY\\NetworkService' })
  assert.match(withAccount, /<serviceaccount>/)
  assert.match(withAccount, /<username>NT AUTHORITY\\NetworkService<\/username>/)
  assert.match(withAccount, /<allowservicelogon>true<\/allowservicelogon>/)
})
