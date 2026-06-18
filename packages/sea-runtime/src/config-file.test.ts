import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { parseConfigLines, readConfigFileValues, writeConfigFileValues } from './config-file.js'

test('parseConfigLines reads dotenv-style assignments with quotes and comments', () => {
  const values = parseConfigLines([
    '# PrintStream bridge configuration',
    'BRIDGE_SERVER_URL=https://printstream.app',
    'BRIDGE_NAME="Print Farm Bridge"',
    "BRIDGE_UPDATE_CHANNEL='beta'",
    'BRIDGE_RELEASE_RETENTION_DAYS=7 # keep a week',
    'export BRIDGE_AUTO_UPDATE=true',
    'not a config line'
  ].join('\n'))

  assert.deepEqual(values, {
    BRIDGE_SERVER_URL: 'https://printstream.app',
    BRIDGE_NAME: 'Print Farm Bridge',
    BRIDGE_UPDATE_CHANNEL: 'beta',
    BRIDGE_RELEASE_RETENTION_DAYS: '7',
    BRIDGE_AUTO_UPDATE: 'true'
  })
})

test('writeConfigFileValues updates existing keys in place and appends new ones', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bridge-config-'))
  const configFile = path.join(dir, 'bridge.env')
  try {
    await writeFile(configFile, '# managed by service install\nBRIDGE_SERVER_URL=http://old.example\nBRIDGE_NAME=Old\n', 'utf8')

    await writeConfigFileValues(configFile, {
      BRIDGE_SERVER_URL: 'https://printstream.app',
      BRIDGE_UPDATE_CHANNEL: 'beta',
      BRIDGE_NAME: undefined
    })

    const raw = await readFile(configFile, 'utf8')
    assert.match(raw, /^# managed by service install$/m)
    assert.match(raw, /^BRIDGE_SERVER_URL=https:\/\/printstream\.app$/m)
    assert.match(raw, /^BRIDGE_NAME=Old$/m)
    assert.match(raw, /^BRIDGE_UPDATE_CHANNEL=beta$/m)

    assert.deepEqual(await readConfigFileValues(configFile), {
      BRIDGE_SERVER_URL: 'https://printstream.app',
      BRIDGE_NAME: 'Old',
      BRIDGE_UPDATE_CHANNEL: 'beta'
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('writeConfigFileValues creates the file, quotes values with spaces, and removes null keys', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bridge-config-'))
  const configFile = path.join(dir, 'nested', 'bridge.env')
  try {
    await writeConfigFileValues(configFile, { BRIDGE_NAME: 'Print Farm Bridge' })
    assert.deepEqual(await readConfigFileValues(configFile), { BRIDGE_NAME: 'Print Farm Bridge' })

    await writeConfigFileValues(configFile, { BRIDGE_NAME: null })
    assert.deepEqual(await readConfigFileValues(configFile), {})
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
