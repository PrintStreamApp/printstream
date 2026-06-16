import assert from 'node:assert/strict'
import { createPublicKey, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import yazl from 'yazl'
import type { BridgeBuild } from '@printstream/shared'
import { activateBridgeRelease, resolveBridgeReleaseUrl, sha256Hex, stageBridgeReleaseBundle, verifyBridgeReleaseBundle } from './update-bundles.js'
import { OFFICIAL_BRIDGE_UPDATE_PUBLIC_KEY } from './update-trust.js'

test('resolveBridgeReleaseUrl accepts release bundles from the configured cloud origin', () => {
  assert.equal(
    resolveBridgeReleaseUrl('https://printstream.example.com/releases/bridge.zip', 'https://printstream.example.com').href,
    'https://printstream.example.com/releases/bridge.zip'
  )
})

test('resolveBridgeReleaseUrl rejects release bundles from other origins', () => {
  assert.throws(
    () => resolveBridgeReleaseUrl('https://cdn.example.com/releases/bridge.zip', 'https://printstream.example.com'),
    /origin is not trusted/
  )
})

test('verifyBridgeReleaseBundle validates checksum and Ed25519 signature', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const bytes = Buffer.from('bridge bundle bytes')
  const sha256 = sha256Hex(bytes)
  const signature = sign(null, Buffer.from(sha256, 'utf8'), privateKey).toString('base64')
  const release: BridgeBuild = {
    sourceFingerprint: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    buildRevision: 'abc123def456',
    protocolVersion: 1,
    runnerAbiVersion: 'node22-ffmpeg7-v1',
    minimumRunnerAbiVersion: 'node22-ffmpeg7-v1',
    releasedAt: '2026-05-20T00:00:00.000Z',
    notesUrl: null,
    bundle: {
      url: 'https://printstream.example.com/releases/bridge.zip',
      sha256,
      signature,
      sizeBytes: bytes.byteLength
    }
  }

  assert.doesNotThrow(() => verifyBridgeReleaseBundle({
    release,
    bytes,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString()
  }))
})

test('official bridge update public key is a valid Ed25519 public key', () => {
  const key = createPublicKey(OFFICIAL_BRIDGE_UPDATE_PUBLIC_KEY)
  assert.equal(key.asymmetricKeyType, 'ed25519')
})

test('verifyBridgeReleaseBundle rejects modified bundle bytes', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const bytes = Buffer.from('bridge bundle bytes')
  const sha256 = sha256Hex(bytes)
  const signature = sign(null, Buffer.from(sha256, 'utf8'), privateKey).toString('base64')
  const release: BridgeBuild = {
    sourceFingerprint: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    buildRevision: 'abc123def456',
    protocolVersion: 1,
    runnerAbiVersion: 'node22-ffmpeg7-v1',
    minimumRunnerAbiVersion: 'node22-ffmpeg7-v1',
    releasedAt: '2026-05-20T00:00:00.000Z',
    notesUrl: null,
    bundle: {
      url: 'https://printstream.example.com/releases/bridge.zip',
      sha256,
      signature,
      sizeBytes: bytes.byteLength
    }
  }

  assert.throws(() => verifyBridgeReleaseBundle({
    release,
    bytes: Buffer.from('modified bytes'),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString()
  }), /checksum does not match/)
})

test('stageBridgeReleaseBundle extracts a verified zip and activateBridgeRelease writes current pointer', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const releasesDir = await mkdtemp(path.join(tmpdir(), 'bridge-releases-'))
  try {
    const bytes = await createZipBuffer({ 'dist/index.js': 'console.log("updated")\n' })
    const release = signedRelease({ bytes, privateKey })
    const stagedDir = await stageBridgeReleaseBundle({
      release,
      bytes,
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      releasesDir
    })
    const releaseDirName = release.sourceFingerprint.slice(0, 12)
    await activateBridgeRelease({ releaseDirName, releasesDir, stagedDir })

    assert.equal(await readFile(path.join(releasesDir, releaseDirName, 'dist/index.js'), 'utf8'), 'console.log("updated")\n')
    assert.deepEqual(JSON.parse(await readFile(path.join(releasesDir, 'current.json'), 'utf8')).releasePath, releaseDirName)
  } finally {
    await rm(releasesDir, { recursive: true, force: true })
  }
})

function signedRelease(input: { bytes: Buffer; privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'] }): BridgeBuild {
  const sha256 = sha256Hex(input.bytes)
  return {
    sourceFingerprint: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    buildRevision: 'abc123def456',
    protocolVersion: 1,
    runnerAbiVersion: 'node22-ffmpeg7-v1',
    minimumRunnerAbiVersion: 'node22-ffmpeg7-v1',
    releasedAt: '2026-05-20T00:00:00.000Z',
    notesUrl: null,
    bundle: {
      url: 'https://printstream.example.com/releases/bridge.zip',
      sha256,
      signature: sign(null, Buffer.from(sha256, 'utf8'), input.privateKey).toString('base64'),
      sizeBytes: input.bytes.byteLength
    }
  }
}

function createZipBuffer(files: Record<string, string>): Promise<Buffer> {
  const zip = new yazl.ZipFile()
  const chunks: Buffer[] = []
  for (const [filePath, content] of Object.entries(files)) {
    zip.addBuffer(Buffer.from(content, 'utf8'), filePath)
  }
  zip.end()
  return new Promise((resolve, reject) => {
    zip.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk))
    zip.outputStream.on('error', reject)
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)))
  })
}