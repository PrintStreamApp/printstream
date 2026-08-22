import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HttpError } from '../../lib/http-error.js'
import {
  BambuCloudError,
  beginBambuCloudLogin,
  getBambuCloudSetting,
  listBambuCloudSettings,
  readBambuCloudCredential,
  refreshBambuCloudCredential,
  type CallContext
} from './client.js'
import type { PluginLogger } from '../../plugin/types.js'

const logger: PluginLogger = { info: () => {}, warn: () => {}, error: () => {} }

/** A context whose transport answers with one scripted response. */
function contextReturning(response: { status: number; body?: unknown; bodyText?: string }): CallContext {
  return {
    workspaceId: 'workspace-1',
    logger,
    call: async () => ({ response: { body: null, ...response }, route: 'direct' as const })
  }
}

/** A context whose transport throws, the way a DNS failure or timeout does. */
function contextThrowing(error: Error): CallContext {
  return { workspaceId: 'workspace-1', logger, call: async () => { throw error } }
}

async function captureError(run: () => Promise<unknown>): Promise<BambuCloudError> {
  try {
    await run()
  } catch (error) {
    assert.ok(error instanceof BambuCloudError, `expected a BambuCloudError, got ${String(error)}`)
    return error
  }
  throw new Error('expected the call to throw')
}

test('a wrong password reaches the browser as Bambu\'s own message, not a 500', async () => {
  // THE regression this file exists for. `BambuCloudError` used to extend plain `Error`,
  // so the API's error middleware — which only preserves the message of an `HttpError` —
  // answered a bare 500 "Internal server error" and left the real text in the server log.
  // A wrong password was indistinguishable from a crash.
  const error = await captureError(() => beginBambuCloudLogin(
    contextReturning({ status: 400, body: { code: 1, error: 'Incorrect account or password.' } }),
    'global',
    'user@example.com',
    'wrong'
  ))

  assert.ok(error instanceof HttpError, 'must be an HttpError or the middleware discards the message')
  assert.equal(error.statusCode, 400, 'Bambu rejected the supplied credentials — a bad request, not a server fault')
  assert.match(error.message, /Incorrect account or password/)
  // Bambu's own wording leads; the raw status is not repeated at the user.
  assert.doesNotMatch(error.message, /returned 400/)
})

test('a failure Bambu describes with no message falls back to naming the status', async () => {
  const error = await captureError(() => beginBambuCloudLogin(
    contextReturning({ status: 418, body: {} }),
    'global',
    'user@example.com',
    'password'
  ))

  assert.match(error.message, /418/)
})

test('a dead credential answers 409, never 401', async () => {
  // 401 would read as "your PrintStream session expired" and send the user to the wrong
  // sign-in; the thing that is actually dead is the stored Bambu credential.
  const error = await captureError(() => listBambuCloudSettings(
    contextReturning({ status: 401, body: { code: 4, error: 'Please login.' } }),
    { region: 'global', accessToken: 'stale' }
  ))

  assert.equal(error.kind, 'expired')
  assert.equal(error.statusCode, 409)
  assert.match(error.message, /Reconnect the account/i)
})

test('a Cloudflare challenge answers 503, because it is temporary and not the user\'s doing', async () => {
  const error = await captureError(() => listBambuCloudSettings(
    contextReturning({ status: 403, bodyText: '<html><title>Just a moment...</title></html>' }),
    { region: 'global', accessToken: 'token' }
  ))

  assert.equal(error.kind, 'challenge')
  assert.equal(error.statusCode, 503)
})

test('the preset quota answers 409 with the message that says what to do about it', async () => {
  const error = await captureError(() => listBambuCloudSettings(
    contextReturning({ status: 400, body: { code: 14, error: 'quota exceeded' } }),
    { region: 'global', accessToken: 'token' }
  ))

  assert.equal(error.kind, 'quota')
  assert.equal(error.statusCode, 409)
  assert.match(error.message, /limit for stored presets/i)
})

test('a Bambu server fault is reported as an upstream failure, not our own', async () => {
  const error = await captureError(() => listBambuCloudSettings(
    contextReturning({ status: 502, bodyText: 'bad gateway' }),
    { region: 'global', accessToken: 'token' }
  ))

  assert.equal(error.statusCode, 502)
})

test('a transport failure becomes a readable error rather than escaping as a 500', async () => {
  // A raw `fetch` rejection (DNS, connection refused, the request timeout firing) is not
  // an HttpError, so unconverted it would surface as "Internal server error" with the
  // cause only in the log — the same failure mode as the wrong-password case above.
  const error = await captureError(() => listBambuCloudSettings(
    contextThrowing(new TypeError('fetch failed')),
    { region: 'global', accessToken: 'token' }
  ))

  assert.equal(error.statusCode, 502)
  assert.match(error.message, /Could not reach Bambu Cloud/)
  assert.match(error.message, /fetch failed/)
})

test('an expiry raised by the transport layer keeps its classification', async () => {
  // `runCall`'s catch must not re-wrap an already-classified error and lose its kind —
  // the sync engine keys "should I mark this credential dead?" off exactly that.
  const original = new BambuCloudError('already classified', 'expired', 401)
  const error = await captureError(() => listBambuCloudSettings(
    contextThrowing(original),
    { region: 'global', accessToken: 'token' }
  ))

  assert.equal(error, original)
  assert.equal(error.kind, 'expired')
})

test('a response shape Bambu changed is reported as a sentence, not a JSON dump', async () => {
  // A raw ZodError message is the issue list serialized as JSON, and it went straight to
  // the user: fifty presets each showing a paragraph of `{"code":"invalid_type",...}`.
  const error = await captureError(() => getBambuCloudSetting(
    contextReturning({ status: 200, body: { name: 'A preset', setting: 'not-an-object' } }),
    { region: 'global', accessToken: 'token' },
    'PP1'
  ))

  assert.doesNotMatch(error.message, /invalid_type|\{/, 'the raw Zod dump must not reach the user')
  assert.match(error.message, /unexpected response format/)
  assert.match(error.message, /setting/, 'still names the offending field so it stays diagnosable')
  assert.equal(error.statusCode, 502)
})

test('a login response yields the whole credential, not just the access token', () => {
  // Keeping only `accessToken` is what makes a connection die unpredictably: the refresh
  // token is the only thing that can renew it without password + 2FA. Field names are
  // BambuStudio's own `TokenResp` (src/slic3r/GUI/HttpServer.cpp).
  const before = Date.now()
  const credential = readBambuCloudCredential(
    { accessToken: 'a', refreshToken: 'r', expiresIn: 3600, refreshExpiresIn: 2_592_000 },
    'a'
  )

  assert.equal(credential.refreshToken, 'r')
  // Relative seconds are resolved to absolute instants — a lifetime is meaningless once
  // it has been written to disk and read back days later.
  const expiresAt = Date.parse(credential.expiresAt ?? '')
  assert.ok(expiresAt >= before + 3_600_000 && expiresAt <= Date.now() + 3_600_000)
  // NOT asserted: that the refresh token outlives the access token. Measured against a
  // live account, Bambu expires BOTH at the same instant (90 days), which is exactly why
  // renewal is scheduled as a fraction of the lifetime rather than just before expiry.
  assert.equal(Date.parse(credential.refreshExpiresAt ?? ''), Date.parse(credential.expiresAt ?? '') + (2_592_000 - 3600) * 1000)
})

test('a token response that states no lifetime degrades to unknown, not to a broken sign-in', () => {
  const credential = readBambuCloudCredential({ accessToken: 'a' }, 'a')

  assert.equal(credential.accessToken, 'a')
  assert.equal(credential.refreshToken, null)
  assert.equal(credential.expiresAt, null)
  assert.equal(credential.refreshExpiresAt, null)
})

test('a renewal returns the new credential', async () => {
  const credential = await refreshBambuCloudCredential(
    contextReturning({ status: 200, body: { accessToken: 'new-access', refreshToken: 'new-refresh', expiresIn: 3600 } }),
    'global',
    'old-refresh'
  )

  assert.equal(credential.accessToken, 'new-access')
  // Bambu issues a NEW refresh token each time; storing the old one would pin the
  // connection to the original refresh window and defeat the renewal.
  assert.equal(credential.refreshToken, 'new-refresh')
})

test('a refused renewal is an error the caller can act on, not a silent failure', async () => {
  const error = await captureError(() => refreshBambuCloudCredential(
    contextReturning({ status: 401, body: { code: 401, error: 'The client must authenticate itself to get the requested response.' } }),
    'global',
    'dead-refresh'
  ))

  assert.match(error.message, /authenticate itself/)
})
