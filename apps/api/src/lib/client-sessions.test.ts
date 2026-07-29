import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ClientSessions } from './client-sessions.js'

const GRACE_MS = 20

function afterGrace(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, GRACE_MS * 3))
}

test('a tab that closes is reported gone once the grace elapses', async () => {
  const sessions = new ClientSessions(GRACE_MS)
  const gone: string[] = []
  sessions.onGone((clientId) => gone.push(clientId))

  sessions.connected('tab-1')
  sessions.disconnected('tab-1')
  assert.deepEqual(gone, [], 'never before the grace')

  await afterGrace()
  assert.deepEqual(gone, ['tab-1'])
  sessions.reset()
})

test('a reload retracts the departure — the tab reconnects inside the grace', async () => {
  // The failure this guards: a reload, an in-app navigation, and a two-second blip are all just a
  // socket close, and the consumer reacts by cancelling the user's slice.
  const sessions = new ClientSessions(GRACE_MS)
  const gone: string[] = []
  sessions.onGone((clientId) => gone.push(clientId))

  sessions.connected('tab-1')
  sessions.disconnected('tab-1')
  sessions.connected('tab-1')

  await afterGrace()
  assert.deepEqual(gone, [], 'a tab that came back was never gone')
  assert.equal(sessions.isConnected('tab-1'), true)
  sessions.reset()
})

test('a tab with several sockets is only gone when its last one closes', async () => {
  const sessions = new ClientSessions(GRACE_MS)
  const gone: string[] = []
  sessions.onGone((clientId) => gone.push(clientId))

  sessions.connected('tab-1')
  sessions.connected('tab-1')
  sessions.disconnected('tab-1')

  await afterGrace()
  assert.deepEqual(gone, [], 'one socket left, so the tab is open')

  sessions.disconnected('tab-1')
  await afterGrace()
  assert.deepEqual(gone, ['tab-1'])
  sessions.reset()
})

test('one tab closing says nothing about another', async () => {
  const sessions = new ClientSessions(GRACE_MS)
  const gone: string[] = []
  sessions.onGone((clientId) => gone.push(clientId))

  sessions.connected('tab-1')
  sessions.connected('tab-2')
  sessions.disconnected('tab-2')

  await afterGrace()
  assert.deepEqual(gone, ['tab-2'])
  assert.equal(sessions.isConnected('tab-1'), true)
  sessions.reset()
})

// A reload used to be absorbed by the grace ON PURPOSE. It no longer should be: a reload drops the
// user out of the editor and the slice dialog, and an editor slice is persisted hidden from the
// library with no action on its toast, so finishing it produces a file nobody can reach.
test('leaving() departs the tab at once, while a silent socket drop still waits out the grace', async () => {
  const sessions = new ClientSessions(50)
  const gone: string[] = []
  sessions.onGone((clientId) => { gone.push(clientId) })

  sessions.connected('tab-a')
  sessions.leaving('tab-a')
  assert.deepEqual(gone, ['tab-a'], 'reported without waiting for the grace')
  assert.equal(sessions.isConnected('tab-a'), false)

  // The socket close that follows the beacon must not report the same tab twice.
  sessions.disconnected('tab-a')
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.deepEqual(gone, ['tab-a'], 'the trailing close is not a second departure')

  // A drop with no beacon (blip, lid, dead wifi) keeps the old behaviour.
  sessions.connected('tab-b')
  sessions.disconnected('tab-b')
  assert.deepEqual(gone, ['tab-a'], 'not reported yet')
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.deepEqual(gone, ['tab-a', 'tab-b'])
  sessions.reset()
})

test('a beacon that arrives before the socket close still only departs once', async () => {
  const sessions = new ClientSessions(50)
  const gone: string[] = []
  sessions.onGone((clientId) => { gone.push(clientId) })
  // Two tabs' worth of sockets for one id (a duplicated tab inherits the id).
  sessions.connected('tab-c')
  sessions.connected('tab-c')
  sessions.leaving('tab-c')
  sessions.disconnected('tab-c')
  sessions.disconnected('tab-c')
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.deepEqual(gone, ['tab-c'])
  sessions.reset()
})
