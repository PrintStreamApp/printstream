import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { WebSocket } from 'ws'
import { sweepBridgeSessionHeartbeat } from './bridge-session-server.js'

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

test('pings a live bridge socket to keep the proxied session alive', () => {
  const live = makeSocket(true)
  sweepBridgeSessionHeartbeat([live as unknown as WebSocket])
  assert.equal(live.terminated, false)
  assert.equal(live.pings, 1, 'a server->bridge ping is what stops an idle proxy from reaping the session')
  assert.equal(live.isAlive, false, 'flips to pending until the next pong')
})

test('treats a freshly-connected bridge socket (isAlive undefined) as alive', () => {
  const fresh = makeSocket(undefined)
  sweepBridgeSessionHeartbeat([fresh as unknown as WebSocket])
  assert.equal(fresh.terminated, false)
  assert.equal(fresh.pings, 1)
})

test('terminates a bridge socket that missed the previous pong (half-open)', () => {
  const dead = makeSocket(false)
  sweepBridgeSessionHeartbeat([dead as unknown as WebSocket])
  assert.equal(dead.terminated, true)
  assert.equal(dead.pings, 0)
})

test('two sweeps with no intervening pong terminate a previously-live bridge socket', () => {
  const socket = makeSocket(true)
  sweepBridgeSessionHeartbeat([socket as unknown as WebSocket]) // pings, isAlive -> false
  sweepBridgeSessionHeartbeat([socket as unknown as WebSocket]) // no pong -> terminate
  assert.equal(socket.terminated, true)
})
