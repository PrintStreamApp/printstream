import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BridgeRuntimeFailure,
  createBridgeRegistrationFailure,
  recoverBridgeStateFromRegisterFailure
} from './runtime.js'

test('createBridgeRegistrationFailure classifies invalid persisted bridge credentials', async () => {
  const failure = createBridgeRegistrationFailure(
    new Response(JSON.stringify({ error: 'Bridge runtime credentials are invalid.' }), {
      status: 401,
      headers: { 'content-type': 'application/json' }
    }),
    { error: 'Bridge runtime credentials are invalid.' }
  )

  assert.ok(failure instanceof BridgeRuntimeFailure)
  assert.equal(failure.kind, 'invalid-credentials')

  const cleared: Array<{ filePath: string; installationId: string }> = []
  assert.equal(
    await recoverBridgeStateFromRegisterFailure(
      { installationId: 'install-1', bridgeId: 'bridge-1', runtimeToken: 'runtime-token' },
      failure,
      '/tmp/bridge-state.json',
      async (filePath, installationId) => {
        cleared.push({ filePath, installationId })
      }
    ),
    true
  )
  // The durable installationId is preserved so the bridge re-binds, not duplicates.
  assert.deepEqual(cleared, [{ filePath: '/tmp/bridge-state.json', installationId: 'install-1' }])
})

test('createBridgeRegistrationFailure summarizes non-json API failures without echoing html', () => {
  const failure = createBridgeRegistrationFailure(
    new Response('<html><body>502 Bad Gateway</body></html>', {
      status: 502,
      statusText: 'Bad Gateway',
      headers: { 'content-type': 'text/html' }
    }),
    '<html><body>502 Bad Gateway</body></html>'
  )

  assert.equal(failure.kind, 'registration-failed')
  assert.match(failure.message, /HTTP 502/)
  assert.match(failure.message, /Bad Gateway/)
  assert.doesNotMatch(failure.message, /<html>/)
})

test('recoverBridgeStateFromRegisterFailure ignores non-credential failures', async () => {
  const failure = new BridgeRuntimeFailure(
    'api-unavailable',
    'Bridge API at http://api:4000 is unavailable during registration: fetch failed. Retrying in 5s.'
  )

  let cleared = false
  assert.equal(
    await recoverBridgeStateFromRegisterFailure(
      { installationId: 'install-1', bridgeId: 'bridge-1', runtimeToken: 'runtime-token' },
      failure,
      '/tmp/bridge-state.json',
      async () => {
        cleared = true
      }
    ),
    false
  )
  assert.equal(cleared, false)
})