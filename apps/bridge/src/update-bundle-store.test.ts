import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'
import type { BridgeBuild } from '@printstream/shared'
import {
  BUNDLE_ENTRYPOINT_NAME,
  activateBridgeBundle,
  stageBridgeBundle,
  verifyBridgeBundleBytes
} from './update-bundle-store.js'
import {
  cleanupConfirmedBridgeReleases,
  confirmActiveBridgeReleaseHealthy,
  isActiveBridgeReleasePendingHealthCheck,
  readActiveReleasePointer,
  readHeldBackBridgeBuild,
  recordHeldBackBridgeBuild,
  resolveActiveBridgeEntrypoint,
  restorePreviousBridgeRelease
} from './release-pointer.js'
import { sha256Hex } from './update-signing.js'

const FP_A = 'a'.repeat(64)
const FP_B = 'b'.repeat(64)

function signedRelease(bytes: Buffer, fingerprint: string): { release: BridgeBuild; publicKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const sha256 = sha256Hex(bytes)
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    release: {
      sourceFingerprint: fingerprint,
      buildRevision: 'abc123def456',
      protocolVersion: 1,
      runnerAbiVersion: 'node22.22.3-ffmpeg7-v1',
      minimumRunnerAbiVersion: 'node22.22.3-ffmpeg7-v1',
      releasedAt: '2026-07-10T00:00:00.000Z',
      notesUrl: null,
      bundle: {
        url: `https://printstream.example.com/api/bridge-runtime/release-assets/bridge-bundle-${fingerprint.slice(0, 12)}.cjs.gz`,
        sha256,
        signature: sign(null, Buffer.from(sha256, 'utf8'), privateKey).toString('base64'),
        sizeBytes: bytes.byteLength,
        minimumRunnerAbiVersion: 'node22.22.3-ffmpeg7-v1'
      }
    }
  }
}

test('verifyBridgeBundleBytes accepts a gzipped bundle whose manifest describes the decompressed file', () => {
  const bundle = Buffer.from('console.log("bridge")')
  const { release, publicKeyPem } = signedRelease(bundle, FP_A)
  const verified = verifyBridgeBundleBytes({ release, downloadedBytes: gzipSync(bundle), publicKeyPem })
  assert.deepEqual(verified, bundle)
})

test('verifyBridgeBundleBytes rejects tampered bytes and wrong-key signatures', () => {
  const bundle = Buffer.from('console.log("bridge")')
  const { release, publicKeyPem } = signedRelease(bundle, FP_A)
  assert.throws(
    () => verifyBridgeBundleBytes({ release, downloadedBytes: gzipSync(Buffer.from('tampered')), publicKeyPem }),
    /size does not match|checksum does not match/
  )
  const otherKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString()
  assert.throws(
    () => verifyBridgeBundleBytes({ release, downloadedBytes: gzipSync(bundle), publicKeyPem: otherKey }),
    /signature is invalid/
  )
})

test('stage + activate + confirm keeps exactly one release on disk (minimal retention)', async () => {
  const releasesDir = await mkdtemp(path.join(tmpdir(), 'bridge-releases-'))
  try {
    // Install build A and confirm it healthy.
    const bundleA = Buffer.from('bundle A')
    const a = signedRelease(bundleA, FP_A)
    await activateBridgeBundle({
      releaseDirName: FP_A.slice(0, 12),
      releasesDir,
      stagedDir: await stageBridgeBundle({ release: a.release, verifiedBytes: bundleA, releasesDir })
    })
    assert.equal(await isActiveBridgeReleasePendingHealthCheck(releasesDir), true)
    assert.ok((await resolveActiveBridgeEntrypoint(releasesDir))?.endsWith(BUNDLE_ENTRYPOINT_NAME))
    assert.equal(await confirmActiveBridgeReleaseHealthy(releasesDir, FP_A.slice(0, 12)), true)
    await cleanupConfirmedBridgeReleases(releasesDir)

    // Install build B on top: A becomes the rollback target while B is pending.
    const bundleB = Buffer.from('bundle B')
    const b = signedRelease(bundleB, FP_B)
    await activateBridgeBundle({
      releaseDirName: FP_B.slice(0, 12),
      releasesDir,
      stagedDir: await stageBridgeBundle({ release: b.release, verifiedBytes: bundleB, releasesDir })
    })
    assert.equal((await readActiveReleasePointer(releasesDir))?.releasePath, FP_B.slice(0, 12))
    // Pending health check: cleanup must NOT prune the rollback target.
    assert.deepEqual(await cleanupConfirmedBridgeReleases(releasesDir), [])
    assert.ok((await readdir(releasesDir)).includes(FP_A.slice(0, 12)))

    // Confirm B → everything except B is pruned immediately.
    assert.equal(await confirmActiveBridgeReleaseHealthy(releasesDir, FP_B.slice(0, 12)), true)
    const removed = await cleanupConfirmedBridgeReleases(releasesDir)
    assert.deepEqual(removed, [FP_A.slice(0, 12)])
    const remaining = (await readdir(releasesDir)).filter((name) => !name.endsWith('.json') && name !== '.staging')
    assert.deepEqual(remaining, [FP_B.slice(0, 12)])
    // previous.json is gone with the release it pointed at.
    assert.equal(await restorePreviousBridgeRelease(releasesDir), false)
  } finally {
    await rm(releasesDir, { recursive: true, force: true })
  }
})

test('crash rollback: previous pointer restores and the failed build is held back', async () => {
  const releasesDir = await mkdtemp(path.join(tmpdir(), 'bridge-releases-'))
  try {
    const bundleA = Buffer.from('bundle A')
    const a = signedRelease(bundleA, FP_A)
    await activateBridgeBundle({
      releaseDirName: FP_A.slice(0, 12),
      releasesDir,
      stagedDir: await stageBridgeBundle({ release: a.release, verifiedBytes: bundleA, releasesDir })
    })
    await confirmActiveBridgeReleaseHealthy(releasesDir, FP_A.slice(0, 12))

    const bundleB = Buffer.from('bundle B')
    const b = signedRelease(bundleB, FP_B)
    await activateBridgeBundle({
      releaseDirName: FP_B.slice(0, 12),
      releasesDir,
      stagedDir: await stageBridgeBundle({ release: b.release, verifiedBytes: bundleB, releasesDir })
    })

    // What the launcher does when B dies before health confirmation:
    await recordHeldBackBridgeBuild(releasesDir, FP_B)
    assert.equal(await restorePreviousBridgeRelease(releasesDir), true)
    assert.equal((await readActiveReleasePointer(releasesDir))?.releasePath, FP_A.slice(0, 12))
    assert.equal(await readHeldBackBridgeBuild(releasesDir), FP_B)
  } finally {
    await rm(releasesDir, { recursive: true, force: true })
  }
})

test('release pointer rejects traversal and absolute paths', async () => {
  const releasesDir = await mkdtemp(path.join(tmpdir(), 'bridge-releases-'))
  try {
    await mkdir(path.join(releasesDir, 'x'), { recursive: true })
    await writeFile(path.join(releasesDir, 'current.json'), JSON.stringify({
      releasePath: '../escape',
      entrypoint: 'bridge.cjs'
    }), 'utf8')
    await assert.rejects(() => resolveActiveBridgeEntrypoint(releasesDir), /escape the releases directory/)
    await writeFile(path.join(releasesDir, 'current.json'), JSON.stringify({
      releasePath: 'x',
      entrypoint: '/etc/passwd'
    }), 'utf8')
    await assert.rejects(() => resolveActiveBridgeEntrypoint(releasesDir), /absolute paths/)
  } finally {
    await rm(releasesDir, { recursive: true, force: true })
  }
})

test('readActiveReleasePointer tolerates a corrupt pointer file', async () => {
  const releasesDir = await mkdtemp(path.join(tmpdir(), 'bridge-releases-'))
  try {
    await writeFile(path.join(releasesDir, 'current.json'), 'not json', 'utf8')
    assert.equal(await readActiveReleasePointer(releasesDir), null)
    assert.equal(await readFile(path.join(releasesDir, 'current.json'), 'utf8'), 'not json')
  } finally {
    await rm(releasesDir, { recursive: true, force: true })
  }
})
