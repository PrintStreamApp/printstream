import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { ensureBridgeDesktopConfig, getDefaultBridgeDesktopConfig } from './config.js'

test('ensureBridgeDesktopConfig creates a default config file when missing', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bridge-desktop-config-'))
  const result = await ensureBridgeDesktopConfig(dir)

  assert.equal(result.created, true)
  assert.deepEqual(result.config, getDefaultBridgeDesktopConfig())
  assert.equal(
    await readFile(result.filePath, 'utf8'),
    JSON.stringify(getDefaultBridgeDesktopConfig(), null, 2) + '\n'
  )
})

test('ensureBridgeDesktopConfig normalizes partial existing config files', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bridge-desktop-config-'))
  const filePath = path.join(dir, 'bridge-desktop.json')
  await writeFile(filePath, JSON.stringify({ bridgeName: 'Workshop Bridge' }) + '\n', 'utf8')

  const result = await ensureBridgeDesktopConfig(dir)

  assert.equal(result.created, false)
  assert.deepEqual(result.config, {
    ...getDefaultBridgeDesktopConfig(),
    bridgeName: 'Workshop Bridge'
  })
  assert.equal(
    await readFile(filePath, 'utf8'),
    JSON.stringify(result.config, null, 2) + '\n'
  )
})