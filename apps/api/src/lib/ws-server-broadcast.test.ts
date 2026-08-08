import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WebSocket } from 'ws'
import { Broadcaster } from './ws-server.js'
import type { WsEvent } from '@printstream/shared'

interface FakeSocket {
  readyState: number
  sent: string[]
  closeHandler?: () => void
  send: (payload: string) => void
  once: (event: string, handler: () => void) => void
}

function makeSocket(): FakeSocket {
  const socket: FakeSocket = {
    readyState: WebSocket.OPEN,
    sent: [],
    send(payload) { this.sent.push(payload) },
    once(event, handler) { if (event === 'close') this.closeHandler = handler }
  }
  return socket
}

function ctx(workspaceId: string | null) {
  return { workspace: workspaceId == null ? null : { id: workspaceId }, auth: {} } as never
}

const EVENT: WsEvent = { type: 'printer.removed', printerId: 'p1' }

test('a workspace-scoped broadcast reaches only that workspace\'s sockets', () => {
  const broadcaster = new Broadcaster()
  const a1 = makeSocket()
  const a2 = makeSocket()
  const b1 = makeSocket()
  const anon = makeSocket()
  broadcaster.add(a1 as unknown as WebSocket, ctx('workspace-a'))
  broadcaster.add(a2 as unknown as WebSocket, ctx('workspace-a'))
  broadcaster.add(b1 as unknown as WebSocket, ctx('workspace-b'))
  broadcaster.add(anon as unknown as WebSocket, ctx(null))

  broadcaster.broadcast(EVENT, 'workspace-a')

  assert.equal(a1.sent.length, 1)
  assert.equal(a2.sent.length, 1)
  assert.equal(b1.sent.length, 0, 'other workspace must not receive')
  assert.equal(anon.sent.length, 0, 'unworkspaceed socket must not receive a workspace-scoped event')
})

test('a platform-wide broadcast (workspaceId null) reaches every connected socket', () => {
  const broadcaster = new Broadcaster()
  const a1 = makeSocket()
  const b1 = makeSocket()
  const anon = makeSocket()
  broadcaster.add(a1 as unknown as WebSocket, ctx('workspace-a'))
  broadcaster.add(b1 as unknown as WebSocket, ctx('workspace-b'))
  broadcaster.add(anon as unknown as WebSocket, ctx(null))

  broadcaster.broadcast(EVENT, null)

  assert.equal(a1.sent.length, 1)
  assert.equal(b1.sent.length, 1)
  assert.equal(anon.sent.length, 1)
})

test('closing a socket removes it from the workspace index', () => {
  const broadcaster = new Broadcaster()
  const a1 = makeSocket()
  const a2 = makeSocket()
  broadcaster.add(a1 as unknown as WebSocket, ctx('workspace-a'))
  broadcaster.add(a2 as unknown as WebSocket, ctx('workspace-a'))

  a1.closeHandler?.()
  broadcaster.broadcast(EVENT, 'workspace-a')

  assert.equal(a1.sent.length, 0, 'closed socket must not receive')
  assert.equal(a2.sent.length, 1)
  assert.equal(broadcaster.size(), 1)
})

test('broadcasting to an unknown workspace is a no-op (no sockets indexed)', () => {
  const broadcaster = new Broadcaster()
  const a1 = makeSocket()
  broadcaster.add(a1 as unknown as WebSocket, ctx('workspace-a'))

  broadcaster.broadcast(EVENT, 'workspace-z')

  assert.equal(a1.sent.length, 0)
})
