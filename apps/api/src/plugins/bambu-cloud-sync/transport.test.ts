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

function stubFetch(responder: (call: RecordedCall) => { status?: number; body?: string; setCookie?: string }): RecordedCall[] {
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
    if (result.setCookie) responseHeaders.append('set-cookie', result.setCookie)
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
    ? { setCookie: 'bbl_csrf_token=csrf-value; Path=/; HttpOnly' }
    : { body: '{"accessToken":"issued"}' })

  const result = await directBambuCloudRequest({
    region: 'china',
    request: { operation: 'verifyTotp', tfaKey: 'key', code: '123456' }
  })

  assert.equal(calls[0]?.url, 'https://bambulab.cn/api/csrf')
  assert.equal(calls[1]?.url, 'https://bambulab.cn/api/sign-in/tfa')
  assert.equal(calls[1]?.headers['x-bbl-csrf-token'], 'csrf-value')
  assert.deepEqual(result.body, { accessToken: 'issued' })
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
