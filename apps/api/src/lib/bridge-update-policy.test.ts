import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { buildBridgeUpdateSummary, getBridgeReleaseManifest } from './bridge-update-policy.js'
import { env } from './env.js'

// Pin the deployment mode: `resolveBridgeUpdateStatus` short-circuits to `current`
// when `isSelfHostedDeployment()` is true, which the public open-core build is by
// default (no `src/private`). These cases exercise the cloud drift/compatibility
// logic, so force cloud mode; the self-hosted case below overrides locally.
env.SELF_HOSTED = false

const FP = 'a'.repeat(64)
const OTHER_FP = 'b'.repeat(64)

function bundleFragment(extras: Record<string, unknown> = {}) {
  return {
    sourceFingerprint: FP,
    buildRevision: 'abc123def456',
    protocolVersion: 1,
    runnerAbiVersion: 'node22-ffmpeg7-v1',
    minimumRunnerAbiVersion: 'node22-ffmpeg7-v1',
    releasedAt: '2026-06-12T01:00:00.000Z',
    notesUrl: null,
    bundle: {
      url: `https://printstream.example.com/api/bridge-runtime/release-assets/bridge-${FP.slice(0, 12)}.zip`,
      sha256: 'abc123',
      signature: 'signature',
      sizeBytes: 42
    },
    ...extras
  }
}

async function writePointer(releasesDir: string, sourceFingerprint = FP) {
  await writeFile(path.join(releasesDir, 'current-bridge-build.json'), JSON.stringify({
    sourceFingerprint,
    buildRevision: 'abc123def456',
    promotedAt: '2026-06-12T02:00:00.000Z'
  }), 'utf8')
}

test('getBridgeReleaseManifest announces the promoted build with merged fragments', async () => {
  const releasesDir = await mkdtemp(path.join(tmpdir(), 'bridge-builds-'))
  try {
    await writePointer(releasesDir)
    await writeFile(path.join(releasesDir, `bridge-${FP.slice(0, 12)}.release.json`), JSON.stringify(bundleFragment()), 'utf8')
    await writeFile(path.join(releasesDir, `bridge-standalone-${FP.slice(0, 12)}.release.json`), JSON.stringify(bundleFragment({
      runnerAbiVersion: 'sea-node22-v1',
      minimumRunnerAbiVersion: 'sea-node22-v1',
      bundle: null,
      binaries: {
        'linux-x64': {
          url: `https://printstream.example.com/api/bridge-runtime/release-assets/printstream-bridge-${FP.slice(0, 12)}-linux-x64.gz`,
          sha256: 'def456',
          signature: 'signature',
          sizeBytes: 99,
          compression: 'gzip',
          downloadUrl: `https://printstream.example.com/api/bridge-runtime/release-assets/printstream-bridge-${FP.slice(0, 12)}-linux-x64`
        }
      }
    })), 'utf8')
    // A fragment for an unpromoted build must not leak into the manifest.
    await writeFile(path.join(releasesDir, `bridge-${OTHER_FP.slice(0, 12)}.release.json`), JSON.stringify(bundleFragment({ sourceFingerprint: OTHER_FP })), 'utf8')

    const manifest = getBridgeReleaseManifest(undefined, { releasesDir })
    assert.equal(manifest.schemaVersion, 2)
    assert.equal(manifest.current?.sourceFingerprint, FP)
    assert.equal(manifest.current?.bundle?.sha256, 'abc123')
    assert.equal(manifest.current?.binaries?.['linux-x64']?.sha256, 'def456')

    // The two fragments describe different runner families. Top-level ABI
    // coordinates must come from the Docker (bundle) fragment regardless of
    // merge order — legacy Docker bridges gate installs on them — while each
    // artifact carries its own family's coordinate.
    assert.equal(manifest.current?.runnerAbiVersion, 'node22-ffmpeg7-v1')
    assert.equal(manifest.current?.minimumRunnerAbiVersion, 'node22-ffmpeg7-v1')
    assert.equal(manifest.current?.bundle?.minimumRunnerAbiVersion, 'node22-ffmpeg7-v1')
    assert.equal(manifest.current?.binaries?.['linux-x64']?.minimumRunnerAbiVersion, 'sea-node22-v1')
  } finally {
    await rm(releasesDir, { recursive: true, force: true })
  }
})

test('getBridgeReleaseManifest rewrites release-asset URLs to the requesting origin', async () => {
  const releasesDir = await mkdtemp(path.join(tmpdir(), 'bridge-builds-'))
  try {
    await writePointer(releasesDir)
    await writeFile(path.join(releasesDir, `bridge-${FP.slice(0, 12)}.release.json`), JSON.stringify(bundleFragment({
      notesUrl: 'https://elsewhere.example.com/notes',
      binaries: {
        'linux-x64': {
          url: `https://printstream.example.com/api/bridge-runtime/release-assets/printstream-bridge-${FP.slice(0, 12)}-linux-x64.gz`,
          sha256: 'def456',
          signature: 'signature',
          sizeBytes: 99,
          compression: 'gzip',
          downloadUrl: `https://printstream.example.com/api/bridge-runtime/release-assets/printstream-bridge-${FP.slice(0, 12)}-linux-x64`
        }
      }
    })), 'utf8')

    // CI bakes one base URL into the shared fragments; each server must hand
    // out its own origin or bridges' same-origin download check rejects them.
    const manifest = getBridgeReleaseManifest(undefined, { releasesDir, assetOrigin: 'https://staging.example.net' })
    assert.equal(manifest.current?.bundle?.url, `https://staging.example.net/api/bridge-runtime/release-assets/bridge-${FP.slice(0, 12)}.zip`)
    assert.equal(manifest.current?.binaries?.['linux-x64']?.url, `https://staging.example.net/api/bridge-runtime/release-assets/printstream-bridge-${FP.slice(0, 12)}-linux-x64.gz`)
    assert.equal(manifest.current?.binaries?.['linux-x64']?.downloadUrl, `https://staging.example.net/api/bridge-runtime/release-assets/printstream-bridge-${FP.slice(0, 12)}-linux-x64`)
    // URLs outside the release-assets route are not the server's to rewrite.
    assert.equal(manifest.current?.notesUrl, 'https://elsewhere.example.com/notes')

    // Without a request origin (e.g. internal callers) URLs pass through.
    const untouched = getBridgeReleaseManifest(undefined, { releasesDir })
    assert.equal(untouched.current?.bundle?.url, `https://printstream.example.com/api/bridge-runtime/release-assets/bridge-${FP.slice(0, 12)}.zip`)
  } finally {
    await rm(releasesDir, { recursive: true, force: true })
  }
})

test('getBridgeReleaseManifest has no current build without a promotion pointer or artifacts', async () => {
  const releasesDir = await mkdtemp(path.join(tmpdir(), 'bridge-builds-'))
  try {
    assert.equal(getBridgeReleaseManifest(undefined, { releasesDir }).current, null)

    // Pointer without published fragments: still nothing to announce.
    await writePointer(releasesDir)
    assert.equal(getBridgeReleaseManifest(undefined, { releasesDir }).current, null)
  } finally {
    await rm(releasesDir, { recursive: true, force: true })
  }
})

test('buildBridgeUpdateSummary reports in-sync bridges as current', async () => {
  const releasesDir = await mkdtemp(path.join(tmpdir(), 'bridge-builds-'))
  try {
    await writePointer(releasesDir)
    const summary = buildBridgeUpdateSummary({
      releaseFingerprint: FP,
      protocolVersion: 1,
      runnerAbiVersion: 'sea-node22-v1'
    }, { releasesDir })

    assert.equal(summary.status, 'current')
    assert.equal(summary.latestReleaseFingerprint, FP)
    assert.equal(summary.manualUpdateCommand, null)
  } finally {
    await rm(releasesDir, { recursive: true, force: true })
  }
})

test('buildBridgeUpdateSummary flags fingerprint mismatches as update available', async () => {
  const releasesDir = await mkdtemp(path.join(tmpdir(), 'bridge-builds-'))
  try {
    await writePointer(releasesDir)
    const summary = buildBridgeUpdateSummary({
      releaseFingerprint: OTHER_FP,
      buildRevision: 'old',
      protocolVersion: 1,
      runnerAbiVersion: 'node22-ffmpeg7-v1'
    }, { releasesDir })

    assert.equal(summary.status, 'updateAvailable')
    assert.equal(summary.currentReleaseFingerprint, OTHER_FP)
    assert.equal(summary.latestBuildRevision, 'abc123def456')
  } finally {
    await rm(releasesDir, { recursive: true, force: true })
  }
})

test('buildBridgeUpdateSummary preserves a reported hold-back while fingerprints differ', async () => {
  const releasesDir = await mkdtemp(path.join(tmpdir(), 'bridge-builds-'))
  try {
    await writePointer(releasesDir)
    const summary = buildBridgeUpdateSummary({
      releaseFingerprint: OTHER_FP,
      protocolVersion: 1,
      runnerAbiVersion: 'sea-node22-v1',
      updateStatus: 'updateHeldBack'
    }, { releasesDir })

    assert.equal(summary.status, 'updateHeldBack')
    assert.equal(summary.manualUpdateCommand, 'printstream-bridge update apply')
  } finally {
    await rm(releasesDir, { recursive: true, force: true })
  }
})

test('buildBridgeUpdateSummary reports a bundled self-hosted bridge as current regardless of drift', async () => {
  const releasesDir = await mkdtemp(path.join(tmpdir(), 'bridge-builds-'))
  const previous = env.SELF_HOSTED
  env.SELF_HOSTED = true
  try {
    await writePointer(releasesDir)
    // A fingerprint mismatch (would be `updateAvailable` on cloud), a drifted
    // runner ABI (would be `runnerUpdateRequired`), and a self-reported
    // `unsupported` status all collapse to `current`: the bundled bridge is
    // lockstep with the app and has no independent update to surface or apply.
    const drifted = buildBridgeUpdateSummary({
      releaseFingerprint: OTHER_FP,
      protocolVersion: 1,
      runnerAbiVersion: 'old-runner',
      updateStatus: 'unsupported'
    }, { releasesDir })
    assert.equal(drifted.status, 'current')
    assert.equal(drifted.manualUpdateCommand, null)
  } finally {
    env.SELF_HOSTED = previous
    await rm(releasesDir, { recursive: true, force: true })
  }
})

test('buildBridgeUpdateSummary keeps protocol and runner compatibility gates', async () => {
  const releasesDir = await mkdtemp(path.join(tmpdir(), 'bridge-builds-'))
  try {
    assert.equal(buildBridgeUpdateSummary({
      releaseFingerprint: FP,
      protocolVersion: 0,
      runnerAbiVersion: 'node22-ffmpeg7-v1'
    }, { releasesDir }).status, 'updateRequired')

    const runner = buildBridgeUpdateSummary({
      releaseFingerprint: FP,
      protocolVersion: 1,
      runnerAbiVersion: 'old-runner'
    }, { releasesDir })
    assert.equal(runner.status, 'runnerUpdateRequired')
    assert.equal(runner.manualUpdateCommand, 'docker compose pull bridge && docker compose up -d bridge')

    assert.equal(buildBridgeUpdateSummary({
      protocolVersion: 1,
      runnerAbiVersion: 'sea-node22-v1'
    }, { releasesDir }).status, 'unknown')
  } finally {
    await rm(releasesDir, { recursive: true, force: true })
  }
})
