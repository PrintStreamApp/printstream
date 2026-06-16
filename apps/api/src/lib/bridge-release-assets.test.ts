import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { resolveBridgeReleaseAsset } from './bridge-release-assets.js'

test('resolveBridgeReleaseAsset returns a zip file directly under the release directory', async () => {
  const releasesDir = await mkdtemp(path.join(tmpdir(), 'bridge-release-assets-'))
  try {
    await writeFile(path.join(releasesDir, 'bridge-0.2.0.zip'), 'zip', 'utf8')

    const asset = await resolveBridgeReleaseAsset({
      releasesDir,
      fileName: 'bridge-0.2.0.zip'
    })
    assert.equal(asset.filePath, path.join(releasesDir, 'bridge-0.2.0.zip'))
    assert.equal(asset.contentType, 'application/zip')
  } finally {
    await rm(releasesDir, { recursive: true, force: true })
  }
})

test('resolveBridgeReleaseAsset serves standalone binaries as octet streams', async () => {
  const releasesDir = await mkdtemp(path.join(tmpdir(), 'bridge-release-assets-'))
  try {
    await writeFile(path.join(releasesDir, 'printstream-bridge-0.2.0-linux-x64'), 'elf', 'utf8')
    await writeFile(path.join(releasesDir, 'printstream-bridge-0.2.0-windows-x64.exe'), 'pe', 'utf8')

    const linuxAsset = await resolveBridgeReleaseAsset({
      releasesDir,
      fileName: 'printstream-bridge-0.2.0-linux-x64'
    })
    assert.equal(linuxAsset.contentType, 'application/octet-stream')

    const windowsAsset = await resolveBridgeReleaseAsset({
      releasesDir,
      fileName: 'printstream-bridge-0.2.0-windows-x64.exe'
    })
    assert.equal(windowsAsset.contentType, 'application/octet-stream')
  } finally {
    await rm(releasesDir, { recursive: true, force: true })
  }
})

test('resolveBridgeReleaseAsset rejects manifest fragments and traversal asset names', async () => {
  const releasesDir = await mkdtemp(path.join(tmpdir(), 'bridge-release-assets-'))
  try {
    await assert.rejects(() => resolveBridgeReleaseAsset({
      releasesDir,
      fileName: 'release.json'
    }), /asset name is invalid/)
    await assert.rejects(() => resolveBridgeReleaseAsset({
      releasesDir,
      fileName: '../bridge.zip'
    }), /asset name is invalid/)
    await assert.rejects(() => resolveBridgeReleaseAsset({
      releasesDir,
      fileName: '.hidden'
    }), /asset name is invalid/)
  } finally {
    await rm(releasesDir, { recursive: true, force: true })
  }
})

test('resolveBridgeReleaseAsset rejects missing assets', async () => {
  const releasesDir = await mkdtemp(path.join(tmpdir(), 'bridge-release-assets-'))
  try {
    await assert.rejects(() => resolveBridgeReleaseAsset({
      releasesDir,
      fileName: 'missing.zip'
    }), /asset was not found/)
  } finally {
    await rm(releasesDir, { recursive: true, force: true })
  }
})
