process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { afterEach, mock, test } from 'node:test'
import { WebSocket } from 'ws'
import { cameraStreamHub } from './camera-stream-hub.js'
import { CameraRelay } from './camera-relay.js'

afterEach(() => {
  mock.restoreAll()
})

test('camera relay keeps the upstream subscription active across rapid same-socket reopen churn', () => {
  const relay = new CameraRelay()
  const client = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send: () => undefined
  } as unknown as WebSocket

  let upstreamUnsubscribeCount = 0
  const subscribe = mock.method(cameraStreamHub, 'subscribe', () => () => {
    upstreamUnsubscribeCount += 1
  })

  relay.subscribe(client, 'printer-1')
  relay.subscribe(client, 'printer-1')
  relay.unsubscribe(client, 'printer-1')

  assert.equal(subscribe.mock.callCount(), 1)
  assert.equal(upstreamUnsubscribeCount, 0)

  relay.unsubscribe(client, 'printer-1')

  assert.equal(upstreamUnsubscribeCount, 1)
})