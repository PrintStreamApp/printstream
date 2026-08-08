/**
 * The native update check, and the two things it must never do: ask when it is
 * not a native build, and say anything about the install when it does ask.
 *
 * The anonymity is not incidental. It is what lets the check run on a perpetual
 * key without breaking the promise that such an install makes no request
 * identifying itself, and it is what lets an owner whose updates window has
 * LAPSED still be told a release exists — which is how they learn there is
 * something to renew for.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { env } from './env.js'
import { getNativeUpdateInfo, resetNativeUpdateCheckForTests } from './native-update-check.js'

interface Captured { url: string; headers: Record<string, string | string[] | undefined> }

async function withManifest(
  body: unknown,
  run: (captured: Captured[]) => Promise<void>
): Promise<void> {
  const captured: Captured[] = []
  const server: Server = createServer((request, response) => {
    captured.push({ url: request.url ?? '', headers: request.headers })
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(body))
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const { port } = server.address() as AddressInfo
  const previous = env.NATIVE_UPDATE_ORIGIN
  env.NATIVE_UPDATE_ORIGIN = `http://127.0.0.1:${port}`
  try {
    await run(captured)
  } finally {
    env.NATIVE_UPDATE_ORIGIN = previous
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

/** The check is background+cached, so a test has to let one round trip land. */
async function settle(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (getNativeUpdateInfo() != null) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function asNative(fingerprint: string | null): void {
  resetNativeUpdateCheckForTests()
  env.SELF_HOSTED = true
  env.PRINTSTREAM_NATIVE = true
  env.PRINTSTREAM_SERVER_FINGERPRINT = fingerprint ?? undefined
}

test('a non-native build never asks at all', async () => {
  await withManifest({ current: { fingerprint: 'newbuild' } }, async (captured) => {
    resetNativeUpdateCheckForTests()
    env.PRINTSTREAM_NATIVE = false
    env.PRINTSTREAM_SERVER_FINGERPRINT = 'abc123'

    assert.equal(getNativeUpdateInfo(), null)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(captured.length, 0, 'a Docker or dev run must make no request whatsoever')
  })
})

test('a native build with no baked fingerprint never asks', async () => {
  // A locally-built binary. Telling a developer their own build is stale is
  // worse than saying nothing, and asking would be a request with no purpose.
  await withManifest({ current: { fingerprint: 'newbuild' } }, async (captured) => {
    asNative(null)
    assert.equal(getNativeUpdateInfo(), null)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(captured.length, 0)
  })
})

test('the request is anonymous — no licence key, no installation id', async () => {
  await withManifest({ current: { fingerprint: 'newbuild', binaries: {} } }, async (captured) => {
    asNative('oldbuild')
    getNativeUpdateInfo()
    await settle()

    assert.equal(captured.length, 1)
    assert.equal(captured[0]?.url, '/api/server-runtime/releases')
    const headerBlob = JSON.stringify(captured[0]?.headers ?? {}).toLowerCase()
    assert.ok(!headerBlob.includes('license'), 'the poll must not carry a licence key')
    assert.ok(!headerBlob.includes('installation'), 'the poll must not carry an installation id')
  })
})

test('a differing fingerprint reports an update, matching reports current', async () => {
  await withManifest({ current: { fingerprint: 'newbuild', binaries: {} } }, async () => {
    asNative('oldbuild')
    getNativeUpdateInfo()
    await settle()
    assert.equal(getNativeUpdateInfo()?.status, 'updateAvailable')
  })

  await withManifest({ current: { fingerprint: 'samebuild', binaries: {} } }, async () => {
    asNative('samebuild')
    getNativeUpdateInfo()
    await settle()
    assert.equal(getNativeUpdateInfo()?.status, 'current')
  })
})

test('a manifest offering nothing is not reported as an update', async () => {
  // A live server with no promoted native build answers `current: null`. Reading
  // that as "you are out of date" would nag every install forever.
  await withManifest({ current: null }, async () => {
    asNative('oldbuild')
    getNativeUpdateInfo()
    await settle()
    assert.equal(getNativeUpdateInfo()?.status, 'unknown')
  })
})

test('an unreachable server degrades to unknown rather than throwing', async () => {
  resetNativeUpdateCheckForTests()
  env.SELF_HOSTED = true
  env.PRINTSTREAM_NATIVE = true
  env.PRINTSTREAM_SERVER_FINGERPRINT = 'oldbuild'
  // Port 1 is reliably closed; the check must swallow it.
  env.NATIVE_UPDATE_ORIGIN = 'http://127.0.0.1:1'
  getNativeUpdateInfo()
  await settle()
  assert.equal(getNativeUpdateInfo()?.status, 'unknown')
})

test('only the binary for THIS platform is offered', async () => {
  const key = `${process.platform}-${process.arch}`
  await withManifest({
    current: {
      fingerprint: 'newbuild',
      binaries: { [key]: { url: 'https://x/mine' }, 'some-other-platform': { url: 'https://x/theirs' } }
    }
  }, async () => {
    asNative('oldbuild')
    getNativeUpdateInfo()
    await settle()
    assert.equal(getNativeUpdateInfo()?.downloadUrl, 'https://x/mine')
  })

  // Handing someone the wrong platform's binary is worse than no link at all.
  await withManifest({
    current: { fingerprint: 'newbuild', binaries: { 'some-other-platform': { url: 'https://x/theirs' } } }
  }, async () => {
    asNative('oldbuild')
    getNativeUpdateInfo()
    await settle()
    assert.equal(getNativeUpdateInfo()?.downloadUrl, null)
  })
})
