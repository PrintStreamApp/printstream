import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { listBridgeStandaloneDownloads } from './bridge-standalone-downloads.js'
import { env } from './env.js'

// Pin cloud mode: `getBridgeReleaseManifest` (which this maps from) advertises no
// build on a self-hosted deployment — the public open-core build is self-hosted
// by default (no `src/private`). Standalone bridge downloads are a cloud-only
// surface; this suite asserts that cloud mapping.
env.SELF_HOSTED = false

const FP = 'c'.repeat(64)

function standaloneFragment(extras: Record<string, unknown> = {}) {
  return {
    sourceFingerprint: FP,
    buildRevision: 'abc123def456',
    protocolVersion: 1,
    runnerAbiVersion: 'sea-node22-v1',
    minimumRunnerAbiVersion: 'sea-node22-v1',
    releasedAt: '2026-06-12T00:00:00.000Z',
    notesUrl: null,
    bundle: null,
    binaries: {
      'linux-x64': {
        url: `https://printstream.example.com/api/bridge-runtime/release-assets/printstream-bridge-${FP.slice(0, 12)}-linux-x64.gz`,
        sha256: 'aaa',
        signature: 'sig',
        sizeBytes: 151_000_000,
        compression: 'gzip',
        downloadUrl: `https://printstream.example.com/api/bridge-runtime/release-assets/printstream-bridge-${FP.slice(0, 12)}-linux-x64`
      },
      'win32-x64': {
        url: `https://printstream.example.com/api/bridge-runtime/release-assets/printstream-bridge-${FP.slice(0, 12)}-windows-x64.exe.gz`,
        sha256: 'bbb',
        signature: 'sig',
        sizeBytes: 152_000_000,
        compression: 'gzip',
        downloadUrl: `https://printstream.example.com/api/bridge-runtime/release-assets/printstream-bridge-${FP.slice(0, 12)}-windows-x64.exe`
      }
    },
    ...extras
  }
}

async function promote(releasesDir: string) {
  await writeFile(path.join(releasesDir, 'current-bridge-build.json'), JSON.stringify({
    sourceFingerprint: FP,
    buildRevision: 'abc123def456',
    promotedAt: '2026-06-12T02:00:00.000Z'
  }), 'utf8')
}

test('listBridgeStandaloneDownloads maps the promoted build to browser downloads', async () => {
  const releasesDir = await mkdtemp(path.join(tmpdir(), 'bridge-downloads-'))
  try {
    await promote(releasesDir)
    await writeFile(path.join(releasesDir, 'standalone.release.json'), JSON.stringify(standaloneFragment()), 'utf8')

    const downloads = listBridgeStandaloneDownloads({ releasesDir })
    assert.deepEqual(downloads.map((entry) => entry.platformKey), ['linux-x64', 'win32-x64'])
    const windows = downloads.find((entry) => entry.platformKey === 'win32-x64')
    assert.equal(windows?.buildRevision, 'abc123def456')
    assert.equal(windows?.fileName, `printstream-bridge-${FP.slice(0, 12)}-windows-x64.exe`)
    assert.equal(windows?.url, `https://printstream.example.com/api/bridge-runtime/release-assets/printstream-bridge-${FP.slice(0, 12)}-windows-x64.exe`)
  } finally {
    await rm(releasesDir, { recursive: true, force: true })
  }
})

test('listBridgeStandaloneDownloads is empty without a promoted standalone build', async () => {
  const releasesDir = await mkdtemp(path.join(tmpdir(), 'bridge-downloads-'))
  try {
    // No pointer at all.
    assert.deepEqual(listBridgeStandaloneDownloads({ releasesDir }), [])

    // Fragment present but unpromoted.
    await writeFile(path.join(releasesDir, 'standalone.release.json'), JSON.stringify(standaloneFragment()), 'utf8')
    assert.deepEqual(listBridgeStandaloneDownloads({ releasesDir }), [])
  } finally {
    await rm(releasesDir, { recursive: true, force: true })
  }
})

test('listBridgeStandaloneDownloads skips gzip-only entries without a browser download URL', async () => {
  const releasesDir = await mkdtemp(path.join(tmpdir(), 'bridge-downloads-'))
  try {
    await promote(releasesDir)
    const fragment = standaloneFragment()
    const binaries = fragment.binaries as Record<string, Record<string, unknown>>
    delete binaries['linux-x64']?.downloadUrl
    await writeFile(path.join(releasesDir, 'standalone.release.json'), JSON.stringify(fragment), 'utf8')

    const downloads = listBridgeStandaloneDownloads({ releasesDir })
    assert.deepEqual(downloads.map((entry) => entry.platformKey), ['win32-x64'])
  } finally {
    await rm(releasesDir, { recursive: true, force: true })
  }
})
