/**
 * The `hello` frame's build-id field, which both ends must treat as optional forever.
 *
 * It is the first field added to an existing WS event, and the compatibility risk runs
 * in both directions at once: servers and browsers update independently, and a hello
 * that fails to parse takes the whole event stream's first frame with it.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { wsEventSchema, wsHelloEventSchema } from './ws-events.js'

test('a hello from a server that predates the build id still parses', () => {
  // The upgrade order nobody controls: a browser holding a new bundle reconnects to a
  // server that has not been deployed yet. If this became required, that client would
  // drop every hello and lose the replayed printer snapshot behind it.
  const parsed = wsEventSchema.safeParse({ type: 'hello', serverTime: '2026-08-24T10:00:00.000Z' })
  assert.equal(parsed.success, true)
  assert.equal(parsed.success && parsed.data.type === 'hello' ? parsed.data.webBuildId : 'unset', undefined)
})

test('a hello carrying a build id parses it through', () => {
  const parsed = wsHelloEventSchema.safeParse({
    type: 'hello',
    serverTime: '2026-08-24T10:00:00.000Z',
    webBuildId: '2c41c442d2eb02dc'
  })
  assert.equal(parsed.success, true)
  assert.equal(parsed.success ? parsed.data.webBuildId : null, '2c41c442d2eb02dc')
})

test('an older client ignores the new field instead of rejecting the frame', () => {
  // Zod objects are non-strict, so this is the shape an un-updated bundle sees. Asserted
  // rather than assumed: turning on `.strict()` here would break every deployed client.
  const olderClientSchema = wsHelloEventSchema.omit({ webBuildId: true })
  const parsed = olderClientSchema.safeParse({
    type: 'hello',
    serverTime: '2026-08-24T10:00:00.000Z',
    webBuildId: '2c41c442d2eb02dc'
  })
  assert.equal(parsed.success, true)
})
