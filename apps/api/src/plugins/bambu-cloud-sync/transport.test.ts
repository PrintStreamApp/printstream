import assert from 'node:assert/strict'
import { afterEach, beforeEach, mock, test } from 'node:test'
import { UNSUPPORTED_BRIDGE_RPC_ERROR_PREFIX } from '@printstream/shared'
import { bridgeSessionManager } from '../../lib/bridge-session-manager.js'
import { rootPrisma } from '../../lib/prisma.js'
import { usePrismaStubs } from '../../test-utils/prisma-stubs.js'
import { directBambuCloudRequest, performBambuCloudCall } from './transport.js'
import type { PluginLogger } from '../../plugin/types.js'

const WORKSPACE_ID = 'workspace-1'

const stubPrisma = usePrismaStubs()
const originalFetch = globalThis.fetch

/** Lines the transport logged, so a silent fallback can be asserted against. */
let logged: string[]
const logger: PluginLogger = {
  info: (message: string) => { logged.push(message) },
  warn: () => {},
  error: () => {}
}

interface RecordedCall {
  url: string
  method: string
  headers: Record<string, string>
}

/** Bridges the workspace owns, and which of them has a live session. */
function stubBridges(bridges: Array<{ id: string; connected: boolean }>): void {
  stubPrisma(rootPrisma.bridge, 'findMany', (async () => bridges.map((bridge) => ({ id: bridge.id }))) as never)
  mock.method(bridgeSessionManager, 'isConnected', (bridgeId: string) =>
    bridges.some((bridge) => bridge.id === bridgeId && bridge.connected))
}

function stubFetch(responder: (call: RecordedCall) => { status?: number; body?: string; setCookies?: string[] }): RecordedCall[] {
  const calls: RecordedCall[] = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value
    }
    const call: RecordedCall = { url: String(input), method: init?.method ?? 'GET', headers }
    calls.push(call)
    const result = responder(call)
    const responseHeaders = new Headers()
    for (const cookie of result.setCookies ?? []) responseHeaders.append('set-cookie', cookie)
    return new Response(result.body ?? '', { status: result.status ?? 200, headers: responseHeaders })
  }) as typeof globalThis.fetch
  return calls
}

beforeEach(() => {
  logged = []
})

afterEach(() => {
  globalThis.fetch = originalFetch
  mock.restoreAll()
})

test('a connected bridge takes the call, and nothing leaves this server', async () => {
  // The whole point of the bridge-preferred design: a workspace's Bambu traffic must
  // leave from that workspace's own connection, not the shared server egress IP.
  stubBridges([{ id: 'bridge-1', connected: true }])
  const requestRpc = mock.method(bridgeSessionManager, 'requestRpc', async () => ({ status: 200, body: { ok: true } }))
  const calls = stubFetch(() => ({ body: '{}' }))

  const result = await performBambuCloudCall(
    WORKSPACE_ID,
    { region: 'global', accessToken: 'token', request: { operation: 'listSettings' } },
    logger
  )

  assert.equal(result.route, 'bridge')
  assert.deepEqual(result.response.body, { ok: true })
  assert.equal(calls.length, 0, 'a bridge-served call must not also go out directly')
  assert.equal(requestRpc.mock.calls[0]?.arguments[1], 'bambu.cloud.request')
})

test('a bridge too old for the method falls back to a direct call and says so', async () => {
  stubBridges([{ id: 'bridge-1', connected: true }])
  mock.method(bridgeSessionManager, 'requestRpc', async () => {
    throw new Error(`${UNSUPPORTED_BRIDGE_RPC_ERROR_PREFIX} bambu.cloud.request`)
  })
  const calls = stubFetch(() => ({ body: '{"print":{"private":[]}}' }))

  const result = await performBambuCloudCall(
    WORKSPACE_ID,
    { region: 'global', accessToken: 'token', request: { operation: 'listSettings' } },
    logger
  )

  assert.equal(result.route, 'direct')
  assert.equal(calls.length, 1)
  // Re-routing a workspace onto the shared IP is the situation this design exists to
  // avoid, so it must be visible in the logs rather than inferred from rate limiting.
  assert.equal(logged.some((line) => line.includes('too old')), true)
})

test('a mid-call RPC failure falls back rather than failing the sync', async () => {
  stubBridges([{ id: 'bridge-1', connected: true }])
  mock.method(bridgeSessionManager, 'requestRpc', async () => { throw new Error('bridge session closed') })
  const calls = stubFetch(() => ({ body: '{}' }))

  const result = await performBambuCloudCall(
    WORKSPACE_ID,
    { region: 'global', accessToken: 'token', request: { operation: 'listSettings' } },
    logger
  )

  assert.equal(result.route, 'direct')
  assert.equal(calls.length, 1)
  assert.equal(logged.some((line) => line.includes('bridge session closed')), true)
})

test('a workspace whose only bridge is offline goes direct without attempting the RPC', async () => {
  stubBridges([{ id: 'bridge-1', connected: false }])
  const requestRpc = mock.method(bridgeSessionManager, 'requestRpc', async () => ({ status: 200, body: {} }))
  stubFetch(() => ({ body: '{}' }))

  const result = await performBambuCloudCall(
    WORKSPACE_ID,
    { region: 'global', accessToken: 'token', request: { operation: 'listSettings' } },
    logger
  )

  assert.equal(result.route, 'direct')
  assert.equal(requestRpc.mock.callCount(), 0)
})

test('the direct path pins every host to Bambu and carries the bearer token', async () => {
  const calls = stubFetch(() => ({ body: '{}' }))

  await directBambuCloudRequest({ region: 'global', accessToken: 'secret-token', request: { operation: 'listSettings' } })

  assert.match(calls[0]?.url ?? '', /^https:\/\/api\.bambulab\.com\//)
  assert.equal(calls[0]?.headers.authorization, 'Bearer secret-token')
})

test('MakerWorld metadata uses the workspace bridge instead of shared server egress', async () => {
  stubBridges([{ id: 'bridge-1', connected: true }])
  const requestRpc = mock.method(bridgeSessionManager, 'requestRpc', async () => ({ status: 200, body: { id: 42 } }))
  const calls = stubFetch(() => ({ body: '{}' }))

  const result = await performBambuCloudCall(
    WORKSPACE_ID,
    { region: 'global', accessToken: 'token', request: { operation: 'getMakerWorldDesign', designId: 42 } },
    logger
  )

  assert.equal(result.route, 'bridge')
  assert.equal(calls.length, 0)
  assert.equal(requestRpc.mock.calls[0]?.arguments[1], 'bambu.cloud.request')
})

test('a one-off bridge challenge is retried once on the same bridge', async () => {
  stubBridges([{ id: 'bridge-1', connected: true }])
  let attempt = 0
  const requestRpc = mock.method(bridgeSessionManager, 'requestRpc', async () => {
    attempt += 1
    return attempt === 1
      ? { status: 403, body: null, bodyText: '<html><title>Just a moment...</title></html>' }
      : { status: 200, body: { id: 42 } }
  })
  const calls = stubFetch(() => ({ body: '{}' }))

  const result = await performBambuCloudCall(
    WORKSPACE_ID,
    { region: 'global', accessToken: 'token', request: { operation: 'getMakerWorldDesign', designId: 42 } },
    logger,
    undefined,
    { waitBeforeChallengeRetry: async () => {} }
  )

  assert.equal(result.route, 'bridge')
  assert.equal(requestRpc.mock.callCount(), 2)
  assert.equal(calls.length, 0)
  assert.equal(logged.some((line) => line.includes('retrying once')), true)
})

test('a persistent bridge challenge stops after one retry', async () => {
  stubBridges([{ id: 'bridge-1', connected: true }])
  const requestRpc = mock.method(bridgeSessionManager, 'requestRpc', async () => ({
    status: 403,
    body: null,
    bodyText: '<html><title>Just a moment...</title></html>'
  }))

  const result = await performBambuCloudCall(
    WORKSPACE_ID,
    { region: 'global', accessToken: 'token', request: { operation: 'getMakerWorldDesign', designId: 42 } },
    logger,
    undefined,
    { waitBeforeChallengeRetry: async () => {} }
  )

  assert.equal(result.route, 'bridge')
  assert.equal(result.response.status, 403)
  assert.equal(requestRpc.mock.callCount(), 2)
})

test('a preset mutation is never replayed after an ambiguous challenge response', async () => {
  stubBridges([{ id: 'bridge-1', connected: true }])
  const requestRpc = mock.method(bridgeSessionManager, 'requestRpc', async () => ({
    status: 503,
    body: null
  }))

  const result = await performBambuCloudCall(
    WORKSPACE_ID,
    {
      region: 'global',
      accessToken: 'token',
      request: {
        operation: 'createSetting',
        payload: { type: 'filament', name: 'My PLA', version: '1.0.0.0', base_id: 'GFSA00', setting: {} }
      }
    },
    logger,
    undefined,
    { waitBeforeChallengeRetry: async () => {} }
  )

  assert.equal(result.response.status, 503)
  assert.equal(requestRpc.mock.callCount(), 1)
})

test('the MakerWorld direct fallback pins its host and sends the web client identity', async () => {
  const calls = stubFetch(() => ({ body: '{}' }))

  await directBambuCloudRequest({
    region: 'global',
    accessToken: 'secret-token',
    request: { operation: 'getMakerWorldDownloadTarget', instanceId: 99 }
  })

  assert.equal(calls[0]?.url, 'https://makerworld.com/api/v1/design-service/instance/99/f3mf')
  assert.equal(calls[0]?.headers.authorization, 'Bearer secret-token')
  assert.equal(calls[0]?.headers['x-bbl-app-source'], 'makerworld')
})

test('the China region reaches its own hosts on the direct path too', async () => {
  // The bridge relay has its own copy of this mapping; both sides must agree, and this
  // is the half that would silently send a China account to the global host.
  const calls = stubFetch(() => ({ body: '{}' }))

  await directBambuCloudRequest({ region: 'china', accessToken: 'token', request: { operation: 'listSettings' } })

  assert.match(calls[0]?.url ?? '', /^https:\/\/api\.bambulab\.cn\//)
  assert.match(calls[0]?.url ?? '', /[?&]version=/)
})

test('a China TOTP verification uses the China web origin for both CSRF legs', async () => {
  const calls = stubFetch((call) => call.url.endsWith('/api/csrf')
    ? { setCookies: ['session=web-session; Path=/', 'bbl_csrf_token=csrf-value; Path=/; HttpOnly'] }
    : { body: '{}', setCookies: ['token=issued-in-cookie; Path=/; HttpOnly'] })

  const result = await directBambuCloudRequest({
    region: 'china',
    request: { operation: 'verifyTotp', tfaKey: 'key', code: '123456' }
  })

  assert.equal(calls[0]?.url, 'https://bambulab.cn/api/csrf')
  assert.equal(calls[1]?.url, 'https://bambulab.cn/api/sign-in/tfa')
  assert.equal(calls[1]?.headers['x-bbl-csrf-token'], 'csrf-value')
  assert.equal(calls[1]?.headers.cookie, 'session=web-session; bbl_csrf_token=csrf-value')
  assert.equal(result.tokenCookie, 'issued-in-cookie')
})

test('a Cloudflare challenge on the TOTP CSRF leg keeps its upstream response', async () => {
  const calls = stubFetch(() => ({
    status: 403,
    body: '<html><title>Just a moment...</title><script src="https://challenges.cloudflare.com/x"></script></html>'
  }))

  const result = await directBambuCloudRequest({
    region: 'global',
    request: { operation: 'verifyTotp', tfaKey: 'key', code: '123456' }
  })

  assert.equal(calls.length, 1, 'a challenge must stop before the authenticator code is sent')
  assert.equal(result.status, 403)
  assert.equal(result.body, null)
  assert.match(result.bodyText ?? '', /Just a moment/)
})

test('sign-in calls on the direct path never carry a stale bearer token', async () => {
  const calls = stubFetch(() => ({ body: '{"loginType":"verifyCode"}' }))

  await directBambuCloudRequest({
    region: 'global',
    accessToken: 'a-stale-token',
    request: { operation: 'login', account: 'user@example.com', password: 'secret' }
  })

  assert.equal(calls[0]?.headers.authorization, undefined)
})

test('a non-JSON edge response is returned as bounded text, not thrown', async () => {
  stubFetch(() => ({ status: 403, body: '<html><title>Just a moment...</title></html>' }))

  const result = await directBambuCloudRequest({ region: 'global', accessToken: 'token', request: { operation: 'listSettings' } })

  assert.equal(result.status, 403)
  assert.equal(result.body, null)
  assert.match(result.bodyText ?? '', /Just a moment/)
})
