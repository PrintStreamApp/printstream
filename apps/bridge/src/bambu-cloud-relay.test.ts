import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { performBambuCloudRequest } from './bambu-cloud-relay.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

interface RecordedCall {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

function stubFetch(responder: (call: RecordedCall) => { status?: number; body?: string; setCookies?: string[] }): RecordedCall[] {
  const calls: RecordedCall[] = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value
    }
    const call: RecordedCall = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : null
    }
    calls.push(call)
    const result = responder(call)
    const responseHeaders = new Headers()
    for (const cookie of result.setCookies ?? []) responseHeaders.append('set-cookie', cookie)
    return new Response(result.body ?? '', { status: result.status ?? 200, headers: responseHeaders })
  }) as typeof globalThis.fetch
  return calls
}

test('every slicer/setting call carries the version parameter Bambu requires', async () => {
  // A missing `version` is HTTP 400 and a non-XX.YY.ZZ.WW one is HTTP 422, on every verb.
  const calls = stubFetch(() => ({ body: '{"ok":true}' }))

  await performBambuCloudRequest({ region: 'global', accessToken: 't', request: { operation: 'listSettings' } })
  await performBambuCloudRequest({ region: 'global', accessToken: 't', request: { operation: 'getSetting', settingId: 'PFUS1' } })
  await performBambuCloudRequest({ region: 'global', accessToken: 't', request: { operation: 'deleteSetting', settingId: 'PFUS1' } })

  for (const call of calls) {
    assert.match(call.url, /[?&]version=1\.0\.0\.0$/, `missing version on ${call.url}`)
  }
})

test('an update is a PATCH against the setting id, not a delete-and-recreate', async () => {
  const calls = stubFetch(() => ({ body: '{"setting_id":"PFUS1"}' }))

  await performBambuCloudRequest({
    region: 'global',
    accessToken: 'token',
    request: {
      operation: 'patchSetting',
      settingId: 'PFUS1',
      payload: { type: 'filament', name: 'My PLA', version: '1.0.0.0', base_id: 'GFSA00', setting: { filament_type: ['PLA'] } }
    }
  })

  assert.equal(calls.length, 1, 'an update must be one call, a delete first would destroy the preset if the recreate failed')
  assert.equal(calls[0]?.method, 'PATCH')
  assert.match(calls[0]?.url ?? '', /\/v1\/iot-service\/api\/slicer\/setting\/PFUS1\?/)
})

test('the China region is reached on its own hosts', async () => {
  const calls = stubFetch(() => ({ body: '{}' }))
  await performBambuCloudRequest({ region: 'china', accessToken: 't', request: { operation: 'listSettings' } })
  assert.match(calls[0]?.url ?? '', /^https:\/\/api\.bambulab\.cn\//)
})

test('sign-in calls never carry the bearer token', async () => {
  const calls = stubFetch(() => ({ body: '{"loginType":"verifyCode"}' }))
  await performBambuCloudRequest({
    region: 'global',
    accessToken: 'a-stale-token',
    request: { operation: 'login', account: 'user@example.com', password: 'secret' }
  })
  assert.equal(calls[0]?.headers.authorization, undefined)
})

test('TOTP verification fetches a CSRF token and echoes it in both halves', async () => {
  // The web origin needs both the double-submit token and the rest of the session
  // cookies. Sending bbl_csrf_token alone reaches the handler but makes a valid code
  // read as "Login failed".
  const calls = stubFetch((call) => call.url.endsWith('/api/csrf')
    ? { setCookies: ['__cf_bm=edge-session; Path=/', 'bbl_csrf_token=csrf-value; Path=/; HttpOnly'] }
    : { body: '{}', setCookies: ['token=issued-in-cookie; Path=/; HttpOnly'] })

  const result = await performBambuCloudRequest({
    region: 'global',
    request: { operation: 'verifyTotp', tfaKey: 'key', code: '123456' }
  })

  assert.equal(calls.length, 2)
  assert.equal(calls[0]?.url, 'https://bambulab.com/api/csrf')
  // The TFA endpoint is on the WEB origin, not the API host.
  assert.equal(calls[1]?.url, 'https://bambulab.com/api/sign-in/tfa')
  assert.equal(calls[1]?.headers['x-bbl-csrf-token'], 'csrf-value')
  assert.equal(calls[1]?.headers.cookie, '__cf_bm=edge-session; bbl_csrf_token=csrf-value')
  assert.deepEqual(result.body, {})
  assert.equal(result.tokenCookie, 'issued-in-cookie')
})

test('TOTP reports a missing CSRF token instead of sending a doomed request', async () => {
  const calls = stubFetch(() => ({ body: '{}' }))
  const result = await performBambuCloudRequest({
    region: 'global',
    request: { operation: 'verifyTotp', tfaKey: 'key', code: '123456' }
  })

  assert.equal(calls.length, 1, 'the code must not be spent on a request Bambu will refuse')
  assert.equal(result.status, 0)
  assert.match(result.bodyText ?? '', /security token/i)
})

test('TOTP preserves a Cloudflare challenge from the CSRF request', async () => {
  const calls = stubFetch(() => ({
    status: 403,
    body: '<html><title>Just a moment...</title><script src="https://challenges.cloudflare.com/x"></script></html>'
  }))

  const result = await performBambuCloudRequest({
    region: 'global',
    request: { operation: 'verifyTotp', tfaKey: 'key', code: '123456' }
  })

  assert.equal(calls.length, 1, 'a challenge must stop before the authenticator code is sent')
  assert.equal(result.status, 403)
  assert.equal(result.body, null)
  assert.match(result.bodyText ?? '', /Just a moment/)
})

test('a non-JSON body is handed back as text rather than thrown away', async () => {
  // A Cloudflare interstitial arrives as HTML. The relay must not interpret it; the
  // API decides what it means, so it needs the excerpt to decide from.
  stubFetch(() => ({ status: 403, body: '<html><title>Just a moment...</title></html>' }))
  const result = await performBambuCloudRequest({ region: 'global', accessToken: 't', request: { operation: 'listSettings' } })

  assert.equal(result.status, 403)
  assert.equal(result.body, null)
  assert.match(result.bodyText ?? '', /Just a moment/)
})

test('the relay reports failures without interpreting them', async () => {
  // No throwing on 4xx: "is this credential dead" is an API-side rule, and the bridge
  // deploys separately, so a verdict baked in here could only be fixed by a rollout.
  stubFetch(() => ({ status: 401, body: '{"code":4,"error":"Please login."}' }))
  const result = await performBambuCloudRequest({ region: 'global', accessToken: 't', request: { operation: 'listSettings' } })

  assert.equal(result.status, 401)
  assert.deepEqual(result.body, { code: 4, error: 'Please login.' })
})
