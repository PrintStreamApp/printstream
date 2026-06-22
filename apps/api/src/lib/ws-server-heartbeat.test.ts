import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { WebSocket } from 'ws'
import { sweepWebSocketHeartbeat } from './ws-server.js'

interface FakeSocket {
  isAlive?: boolean
  terminated: boolean
  pings: number
  terminate: () => void
  ping: () => void
}

function makeSocket(isAlive: boolean | undefined): FakeSocket {
  const socket: FakeSocket = {
    isAlive,
    terminated: false,
    pings: 0,
    terminate() { this.terminated = true },
    ping() { this.pings += 1 }
  }
  return socket
}

test('terminates sockets that missed the previous pong (isAlive === false)', () => {
  const dead = makeSocket(false)
  sweepWebSocketHeartbeat([dead as unknown as WebSocket])
  assert.equal(dead.terminated, true)
  assert.equal(dead.pings, 0)
})

test('pings live sockets and marks them pending for the next sweep', () => {
  const live = makeSocket(true)
  sweepWebSocketHeartbeat([live as unknown as WebSocket])
  assert.equal(live.terminated, false)
  assert.equal(live.pings, 1)
  assert.equal(live.isAlive, false, 'must flip to pending until the next pong')
})

test('treats a freshly-connected socket (isAlive undefined) as alive', () => {
  const fresh = makeSocket(undefined)
  sweepWebSocketHeartbeat([fresh as unknown as WebSocket])
  assert.equal(fresh.terminated, false)
  assert.equal(fresh.pings, 1)
})

test('a second sweep with no intervening pong terminates a previously-live socket', () => {
  const socket = makeSocket(true)
  sweepWebSocketHeartbeat([socket as unknown as WebSocket]) // pings, isAlive -> false
  sweepWebSocketHeartbeat([socket as unknown as WebSocket]) // no pong arrived -> terminate
  assert.equal(socket.terminated, true)
})
