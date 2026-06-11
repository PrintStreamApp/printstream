import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { resolveBridgeReleaseAssetPath } from './bridge-release-assets.js'

test('resolveBridgeReleaseAssetPath returns a zip file directly under the release directory', async () => {
  const releasesDir = await mkdtemp(path.join(tmpdir(), 'bridge-release-assets-'))
  try {
    await writeFile(path.join(releasesDir, 'bridge-0.2.0.zip'), 'zip', 'utf8')

    assert.equal(await resolveBridgeReleaseAssetPath({
      releasesDir,
      fileName: 'bridge-0.2.0.zip'
    }), path.join(releasesDir, 'bridge-0.2.0.zip'))
  } finally {
    await rm(releasesDir, { recursive: true, force: true })
  }
})

test('resolveBridgeReleaseAssetPath rejects non-zip and traversal asset names', async () => {
  const releasesDir = await mkdtemp(path.join(tmpdir(), 'bridge-release-assets-'))
  try {
    await assert.rejects(() => resolveBridgeReleaseAssetPath({
      releasesDir,
      fileName: 'release.json'
    }), /asset name is invalid/)
    await assert.rejects(() => resolveBridgeReleaseAssetPath({
      releasesDir,
      fileName: '../bridge.zip'
    }), /asset name is invalid/)
  } finally {
    await rm(releasesDir, { recursive: true, force: true })
  }
})

test('resolveBridgeReleaseAssetPath rejects missing assets', async () => {
  const releasesDir = await mkdtemp(path.join(tmpdir(), 'bridge-release-assets-'))
  try {
    await assert.rejects(() => resolveBridgeReleaseAssetPath({
      releasesDir,
      fileName: 'missing.zip'
    }), /asset was not found/)
  } finally {
    await rm(releasesDir, { recursive: true, force: true })
  }
})