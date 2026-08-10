/**
 * The one-click native update, and its hard promises: never armed off the
 * packaged native app, never applied unsigned, and the licence key never
 * follows the download redirect off our origin. (The pre-migration database
 * backup is the boot side's job — apps/server/src/pre-update-backup.ts — and
 * is tested there.)
 */
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { env } from './env.js'
import { rootPrisma } from './prisma.js'
import { usePrismaStubs } from '../test-utils/prisma-stubs.js'
import { applyNativeUpdate, resetNativeUpdateApplyForTests } from './native-update-apply.js'

const stub = usePrismaStubs()

const OLD_BINARY = Buffer.from('old-server-binary')
const NEW_BINARY = Buffer.from('new-server-binary')
const OWN_FINGERPRINT = 'oldbuild'
const NEW_FINGERPRINT = 'newbuild'
const LICENSE_KEY = 'license-key-under-test'

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()

interface EnvSnapshot { [key: string]: unknown }
const ENV_KEYS = [
  'SELF_HOSTED', 'PRINTSTREAM_NATIVE', 'PRINTSTREAM_SERVER_FINGERPRINT', 'PRINTSTREAM_SERVER_EXE',
  'PRINTSTREAM_UPDATE_STATE_FILE', 'PRINTSTREAM_UPDATE_HELD_BACK_FILE',
  'NATIVE_UPDATE_ORIGIN', 'NATIVE_UPDATE_PUBLIC_KEY'
] as const
let envSnapshot: EnvSnapshot | null = null

function snapshotEnv(): void {
  envSnapshot ??= Object.fromEntries(ENV_KEYS.map((key) => [key, (env as EnvSnapshot)[key]]))
}

afterEach(() => {
  resetNativeUpdateApplyForTests()
  if (envSnapshot) {
    for (const key of ENV_KEYS) (env as EnvSnapshot)[key] = envSnapshot[key]
    envSnapshot = null
  }
})

interface Harness {
  dir: string
  exePath: string
  stateFile: string
  requests: Array<{ url: string; licenseHeader: string | null }>
  exitCalls: number
  seams: { exitForRestart: () => void }
  close: () => Promise<void>
}

async function makeHarness(options: {
  manifestFingerprint?: string
  signed?: boolean
  binaryBytes?: Buffer
} = {}): Promise<Harness> {
  snapshotEnv()
  const dir = await mkdtemp(path.join(tmpdir(), 'native-update-apply-'))
  const exePath = path.join(dir, 'printstream')
  await writeFile(exePath, OLD_BINARY, { mode: 0o755 })

  const servedBytes = options.binaryBytes ?? NEW_BINARY
  const sha256 = createHash('sha256').update(NEW_BINARY).digest('hex')
  const signed = options.signed ?? true

  const requests: Array<{ url: string; licenseHeader: string | null }> = []
  const server: Server = createServer((request, response) => {
    const url = request.url ?? ''
    requests.push({ url, licenseHeader: (request.headers['x-printstream-license'] as string | undefined) ?? null })
    if (url === '/api/server-runtime/releases') {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({
        schemaVersion: 1,
        generatedAt: '2026-08-09T00:00:00.000Z',
        current: {
          fingerprint: options.manifestFingerprint ?? NEW_FINGERPRINT,
          releasedAt: '2026-08-09T00:00:00.000Z',
          binaries: {
            [`${process.platform}-${process.arch}`]: {
              url: `${origin()}/api/server-runtime/release-assets/printstream-new`,
              sizeBytes: NEW_BINARY.byteLength,
              sha256: signed ? sha256 : null,
              signature: signed ? sign(null, Buffer.from(sha256, 'utf8'), privateKey).toString('base64') : null
            }
          }
        }
      }))
      return
    }
    if (url.startsWith('/api/server-runtime/release-assets/')) {
      // The licensed hop: answer with a redirect like the real channel.
      response.statusCode = 302
      response.setHeader('location', `${origin()}/signed/printstream-new`)
      response.end()
      return
    }
    if (url === '/signed/printstream-new') {
      response.end(servedBytes)
      return
    }
    response.statusCode = 404
    response.end()
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const { port } = server.address() as AddressInfo
  const origin = () => `http://127.0.0.1:${port}`

  const stateFile = path.join(dir, 'self-update.json')
  env.SELF_HOSTED = true
  env.PRINTSTREAM_NATIVE = true
  env.PRINTSTREAM_SERVER_FINGERPRINT = OWN_FINGERPRINT
  env.PRINTSTREAM_SERVER_EXE = exePath
  env.PRINTSTREAM_UPDATE_STATE_FILE = stateFile
  env.PRINTSTREAM_UPDATE_HELD_BACK_FILE = path.join(dir, 'update-held-back.json')
  env.NATIVE_UPDATE_ORIGIN = origin()
  env.NATIVE_UPDATE_PUBLIC_KEY = publicKeyPem

  stub(rootPrisma.setting, 'findUnique', async () => ({ key: 'license.installedKey', value: LICENSE_KEY }))

  const harness: Harness = {
    dir,
    exePath,
    stateFile,
    requests,
    exitCalls: 0,
    seams: {
      exitForRestart: () => {
        harness.exitCalls += 1
      }
    },
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(dir, { recursive: true, force: true })
    }
  }
  return harness
}

test('refuses on anything but an armed native run', async () => {
  const harness = await makeHarness()
  try {
    env.PRINTSTREAM_SERVER_EXE = undefined
    const noExe = await applyNativeUpdate(harness.seams)
    assert.equal(noExe.status, 'unavailable')

    env.PRINTSTREAM_SERVER_EXE = harness.exePath
    env.PRINTSTREAM_NATIVE = false
    const notNative = await applyNativeUpdate(harness.seams)
    assert.equal(notNative.status, 'unavailable')

    assert.equal(harness.requests.length, 0, 'a refused apply must make no network request')
    assert.equal(harness.exitCalls, 0)
  } finally {
    await harness.close()
  }
})

test('an already-current install is reported, not re-applied', async () => {
  const harness = await makeHarness({ manifestFingerprint: OWN_FINGERPRINT })
  try {
    const result = await applyNativeUpdate(harness.seams)
    assert.equal(result.status, 'current')
    assert.ok(!harness.requests.some((r) => r.url.startsWith('/signed/')), 'no download for a current install')
    assert.equal(harness.exitCalls, 0)
  } finally {
    await harness.close()
  }
})

test('an unsigned build is refused before any download', async () => {
  const harness = await makeHarness({ signed: false })
  try {
    const result = await applyNativeUpdate(harness.seams)
    assert.equal(result.status, 'unavailable')
    assert.match(result.message, /signed/)
    assert.ok(!harness.requests.some((r) => r.url.startsWith('/api/server-runtime/release-assets')))
    assert.deepEqual(await readFile(harness.exePath), OLD_BINARY)
  } finally {
    await harness.close()
  }
})

test('a full apply downloads with the licence key on our origin only, swaps, and restarts', async () => {
  const harness = await makeHarness()
  try {
    const result = await applyNativeUpdate(harness.seams)
    assert.equal(result.accepted, true, result.message)
    assert.equal(result.status, 'started')
    assert.equal(harness.exitCalls, 1)

    // The licensed hop carries the key; the signed redirect must NOT.
    const assetRequest = harness.requests.find((r) => r.url.startsWith('/api/server-runtime/release-assets/'))
    const signedRequest = harness.requests.find((r) => r.url.startsWith('/signed/'))
    assert.equal(assetRequest?.licenseHeader, LICENSE_KEY)
    assert.equal(signedRequest?.licenseHeader, null, 'the licence key must not follow the redirect')

    // Swap happened with a rollback backup and pending state.
    assert.deepEqual(await readFile(harness.exePath), NEW_BINARY)
    assert.deepEqual(await readFile(`${harness.exePath}.old`), OLD_BINARY)
    const state = JSON.parse(await readFile(harness.stateFile, 'utf8'))
    assert.equal(state.fromFingerprint, OWN_FINGERPRINT)
    assert.equal(state.toFingerprint, NEW_FINGERPRINT)
    assert.equal(state.bootAttempts, 0)
  } finally {
    await harness.close()
  }
})

test('tampered bytes are rejected and the running binary is untouched', async () => {
  const harness = await makeHarness({ binaryBytes: Buffer.from('tampered-bytes!!!') })
  try {
    const result = await applyNativeUpdate(harness.seams)
    assert.equal(result.status, 'failed')
    assert.deepEqual(await readFile(harness.exePath), OLD_BINARY)
    await assert.rejects(() => stat(harness.stateFile))
    assert.equal(harness.exitCalls, 0)
  } finally {
    await harness.close()
  }
})

test('a second apply while one runs reports busy', async () => {
  const harness = await makeHarness()
  try {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const first = applyNativeUpdate({ ...harness.seams, beforeDownload: () => gate })
    // Let the first apply reach the gate before racing the second.
    await new Promise((resolve) => setTimeout(resolve, 20))
    const second = await applyNativeUpdate(harness.seams)
    assert.equal(second.status, 'busy')
    release()
    assert.equal((await first).accepted, true)
  } finally {
    await harness.close()
  }
})
