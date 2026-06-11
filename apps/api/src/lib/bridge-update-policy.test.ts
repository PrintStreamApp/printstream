import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { buildBridgeUpdateSummary, getBridgeReleaseManifest } from './bridge-update-policy.js'

test('buildBridgeUpdateSummary reports runner image updates separately from app updates', () => {
  const summary = buildBridgeUpdateSummary({
    version: '0.1.0',
    protocolVersion: 1,
    runnerAbiVersion: 'old-runner',
    updateChannel: 'stable'
  })

  assert.equal(summary.status, 'runnerUpdateRequired')
  assert.equal(summary.manualUpdateCommand, 'docker compose pull bridge && docker compose up -d bridge')
})

test('buildBridgeUpdateSummary reports stale bridge images when semver did not change', () => {
  const summary = buildBridgeUpdateSummary({
    version: '0.1.0',
    buildRevision: 'old-build',
    sourceFingerprint: 'old-source',
    protocolVersion: 1,
    runnerAbiVersion: 'node22-ffmpeg7-v1',
    updateStatus: 'current',
    updateChannel: 'stable'
  }, {
    latestBuildRevision: 'new-build',
    latestSourceFingerprint: 'new-source'
  })

  assert.equal(summary.status, 'imageUpdateRequired')
  assert.equal(summary.currentBuildRevision, 'old-build')
  assert.equal(summary.latestBuildRevision, 'new-build')
  assert.equal(summary.manualUpdateCommand, 'docker compose build bridge && docker compose up -d bridge')
})

test('getBridgeReleaseManifest merges signed release fragments by channel', async () => {
  const releasesDir = await mkdtemp(path.join(tmpdir(), 'bridge-release-fragments-'))
  try {
    await writeFile(path.join(releasesDir, 'stable-0.2.0.json'), JSON.stringify({
      channel: 'stable',
      version: '0.2.0',
      protocolVersion: 1,
      runnerAbiVersion: 'node22-ffmpeg7-v1',
      minimumRunnerAbiVersion: 'node22-ffmpeg7-v1',
      releasedAt: '2026-05-20T01:00:00.000Z',
      critical: false,
      notesUrl: null,
      bundle: {
        url: 'https://printstream.example.com/releases/bridge-0.2.0.zip',
        sha256: 'abc123',
        signature: 'signature',
        sizeBytes: 42
      }
    }), 'utf8')
    await writeFile(path.join(releasesDir, 'beta-0.3.0.json'), JSON.stringify({
      channel: 'beta',
      version: '0.3.0',
      protocolVersion: 1,
      runnerAbiVersion: 'node22-ffmpeg7-v1',
      minimumRunnerAbiVersion: 'node22-ffmpeg7-v1',
      releasedAt: '2026-05-20T02:00:00.000Z',
      critical: true,
      notesUrl: null,
      bundle: null
    }), 'utf8')

    const stableManifest = getBridgeReleaseManifest('stable', { releasesDir })
    assert.equal(stableManifest.channels.stable?.latestVersion, '0.2.0')
    assert.equal(stableManifest.channels.stable?.releases[0]?.version, '0.2.0')
    assert.equal(stableManifest.channels.beta, undefined)

    const fullManifest = getBridgeReleaseManifest(undefined, { releasesDir })
    assert.equal(fullManifest.channels.beta?.latestVersion, '0.3.0')
    assert.equal(fullManifest.channels.stable?.latestVersion, '0.2.0')
  } finally {
    await rm(releasesDir, { recursive: true, force: true })
  }
})