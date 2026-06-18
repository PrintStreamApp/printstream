import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateSystemdUnit } from '@printstream/sea-runtime'
import { resolveServerPaths } from './app-identity.js'
import { buildServerServiceSpec } from './service.js'

test('the server service spec produces a correct systemd unit', () => {
  const paths = resolveServerPaths({
    platform: 'linux',
    arch: 'x64',
    isPrivileged: true,
    env: {},
    homeDir: '/root'
  })
  const spec = buildServerServiceSpec(paths, 'linux')

  assert.equal(spec.id, 'printstream')
  assert.equal(spec.exePath, '/opt/printstream/printstream')
  assert.deepEqual(spec.args, ['run'])
  assert.equal(spec.serviceUser, 'printstream')
  assert.equal(spec.env.PRINTSTREAM_DATA_DIR, '/var/lib/printstream')

  const unit = generateSystemdUnit(spec)
  assert.match(unit, /Description=PrintStream/)
  assert.match(unit, /Documentation=https:\/\/printstream\.app/)
  assert.match(unit, /ExecStart=\/opt\/printstream\/printstream run/)
  assert.match(unit, /User=printstream/)
  assert.match(unit, /EnvironmentFile=-\/var\/lib\/printstream\/server\.env/)
})
