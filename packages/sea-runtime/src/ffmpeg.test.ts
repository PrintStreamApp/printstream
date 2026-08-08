import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { brotliCompressSync } from 'node:zlib'
import { ensureFfmpeg } from './ffmpeg.js'

const FAKE_FFMPEG = Buffer.from('#!/bin/sh\necho fake-ffmpeg\n')
const FAKE_LICENSE = Buffer.from('GPL v3 license text')

function assetReader(assets: Record<string, Buffer>) {
  return (key: string) => assets[key] ?? null
}

test('ensureFfmpeg prefers an explicit BRIDGE_FFMPEG_PATH', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bridge-ffmpeg-'))
  try {
    const env: Record<string, string | undefined> = { BRIDGE_FFMPEG_PATH: '/usr/local/bin/ffmpeg' }
    const status = await ensureFfmpeg({
      dataDir: dir,
      versionTag: 'b6.1.1',
      env,
      readAsset: assetReader({ ffmpeg: FAKE_FFMPEG }),
      systemFfmpegWorks: () => false
    })
    assert.deepEqual(status, { source: 'env', path: '/usr/local/bin/ffmpeg' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ensureFfmpeg extracts the bundled build once, with license, and sets the env path', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bridge-ffmpeg-'))
  try {
    const env: Record<string, string | undefined> = {}
    const status = await ensureFfmpeg({
      dataDir: dir,
      versionTag: 'b6.1.1',
      platform: 'linux',
      env,
      readAsset: assetReader({ ffmpeg: FAKE_FFMPEG, 'ffmpeg-license': FAKE_LICENSE }),
      systemFfmpegWorks: () => false
    })

    const expectedPath = path.join(dir, 'tools/ffmpeg-b6.1.1/ffmpeg')
    assert.deepEqual(status, { source: 'bundled', path: expectedPath })
    assert.equal(env.BRIDGE_FFMPEG_PATH, expectedPath)
    assert.deepEqual(await readFile(expectedPath), FAKE_FFMPEG)
    const mode = (await stat(expectedPath)).mode & 0o777
    assert.equal(mode & 0o100, 0o100)
    assert.deepEqual(await readFile(path.join(dir, 'tools/ffmpeg-b6.1.1/LICENSE')), FAKE_LICENSE)

    // Second run reuses the extraction without re-reading the asset.
    let assetReads = 0
    const again = await ensureFfmpeg({
      dataDir: dir,
      versionTag: 'b6.1.1',
      platform: 'linux',
      env: {},
      readAsset: (key) => {
        assetReads += 1
        return key === 'ffmpeg' ? FAKE_FFMPEG : null
      },
      systemFfmpegWorks: () => false
    })
    assert.equal(again.path, expectedPath)
    assert.equal(assetReads, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ensureFfmpeg decompresses the brotli-compressed asset shape', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bridge-ffmpeg-'))
  try {
    const status = await ensureFfmpeg({
      dataDir: dir,
      versionTag: 'b6.1.1',
      platform: 'linux',
      env: {},
      readAsset: assetReader({ 'ffmpeg.br': brotliCompressSync(FAKE_FFMPEG) }),
      systemFfmpegWorks: () => false
    })
    assert.equal(status.source, 'bundled')
    assert.deepEqual(await readFile(status.path ?? ''), FAKE_FFMPEG)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ensureFfmpeg prunes extractions from older builds', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bridge-ffmpeg-'))
  try {
    const oldDir = path.join(dir, 'tools/ffmpeg-b5.0.0')
    await mkdir(oldDir, { recursive: true })
    await writeFile(path.join(oldDir, 'ffmpeg'), 'old')

    await ensureFfmpeg({
      dataDir: dir,
      versionTag: 'b6.1.1',
      platform: 'linux',
      env: {},
      readAsset: assetReader({ ffmpeg: FAKE_FFMPEG }),
      systemFfmpegWorks: () => false
    })

    await assert.rejects(() => stat(oldDir))
    assert.ok(await stat(path.join(dir, 'tools/ffmpeg-b6.1.1/ffmpeg')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ensureFfmpeg uses ffmpeg.exe naming on Windows extractions', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bridge-ffmpeg-'))
  try {
    const status = await ensureFfmpeg({
      dataDir: dir,
      versionTag: 'b6.1.1',
      platform: 'win32',
      env: {},
      readAsset: assetReader({ ffmpeg: FAKE_FFMPEG }),
      systemFfmpegWorks: () => false
    })
    assert.equal(status.source, 'bundled')
    assert.ok(status.path?.endsWith('ffmpeg.exe'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ensureFfmpeg falls back to system ffmpeg, then reports missing', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bridge-ffmpeg-'))
  try {
    const system = await ensureFfmpeg({
      dataDir: dir,
      versionTag: null,
      env: {},
      readAsset: () => null,
      systemFfmpegWorks: () => true
    })
    assert.deepEqual(system, { source: 'system', path: 'ffmpeg' })

    const missing = await ensureFfmpeg({
      dataDir: dir,
      versionTag: 'b6.1.1',
      env: {},
      readAsset: () => null,
      systemFfmpegWorks: () => false
    })
    assert.deepEqual(missing, { source: 'missing', path: null })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
