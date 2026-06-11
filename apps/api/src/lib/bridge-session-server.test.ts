process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, mock, test } from 'node:test'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import WebSocket from 'ws'
import { attachBridgeSessionServer } from './bridge-session-server.js'
import { rootPrisma } from './prisma.js'
import { hashBridgeRuntimeToken } from './bridge-runtime-auth.js'
import { bridgeSessionManager } from './bridge-session-manager.js'
import { wsBroadcaster } from './ws-server.js'

const originalFindUnique = rootPrisma.bridge.findUnique
const originalUpdate = rootPrisma.bridge.update
const originalPrinterFindMany = rootPrisma.printer.findMany

afterEach(() => {
  rootPrisma.bridge.findUnique = originalFindUnique
  rootPrisma.bridge.update = originalUpdate
  rootPrisma.printer.findMany = originalPrinterFindMany
  mock.restoreAll()
})

async function waitForCondition(check: () => boolean, message: string): Promise<void> {
  // Generous failsafe: resolves as soon as `check()` passes, so the ceiling only bounds a stuck
  // test and must survive a CPU-saturated parallel run.
  const timeoutAt = Date.now() + 3_000
  while (Date.now() < timeoutAt) {
    if (check()) return
    await delay(5)
  }

  assert.fail(message)
}

test('bridge session authenticates hello and answers RPC round-trips', async () => {
  rootPrisma.bridge.findUnique = ((async () => ({
    id: 'bridge-1',
    tenantId: 'tenant-1',
    runtimeTokenHash: hashBridgeRuntimeToken('runtime-token')
  })) as unknown) as typeof rootPrisma.bridge.findUnique
  const bridgeUpdates: Array<{ data: { buildRevision?: string; sourceFingerprint?: string } }> = []
  rootPrisma.bridge.update = ((async (input: { data: { buildRevision?: string; sourceFingerprint?: string } }) => {
    bridgeUpdates.push(input)
    return {
    id: 'bridge-1'
    }
  }) as unknown) as typeof rootPrisma.bridge.update
  rootPrisma.printer.findMany = ((async () => []) as unknown) as typeof rootPrisma.printer.findMany

  const httpServer = createServer()
  const attached = attachBridgeSessionServer(httpServer)
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()))
  const address = httpServer.address() as AddressInfo
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/bridge-runtime/connect`)

  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => {
      socket.send(JSON.stringify({
        type: 'bridge.hello',
        bridgeId: 'bridge-1',
        runtimeToken: 'runtime-token',
        version: '0.1.0',
        buildRevision: 'abc123',
        sourceFingerprint: 'source123'
      }))
    })

    socket.on('message', (data) => {
      const payload = JSON.parse(data.toString('utf8')) as { type: string; id?: string }
      if (payload.type === 'bridge.welcome') {
        void bridgeSessionManager.requestRpc('bridge-1', 'ping', { ok: true }).then((result) => {
          assert.deepEqual(result, { pong: true })
          resolve()
        }).catch(reject)
        return
      }

      if (payload.type === 'bridge.rpc.request' && payload.id) {
        socket.send(JSON.stringify({
          type: 'bridge.rpc.success',
          id: payload.id,
          result: { pong: true }
        }))
      }
    })

    socket.once('error', reject)
  })

  assert.equal(bridgeUpdates[0]?.data.buildRevision, 'abc123')
  assert.equal(bridgeUpdates[0]?.data.sourceFingerprint, 'source123')

  socket.close()
  await attached.close()
  await new Promise<void>((resolve, reject) => {
    httpServer.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
})

test('bridge session broadcasts bridge resource change when a bridge connects', async () => {
  rootPrisma.bridge.findUnique = ((async () => ({
    id: 'bridge-1',
    tenantId: 'tenant-1',
    version: '0.1.0',
    protocolVersion: 1,
    runnerAbiVersion: 'old-runner',
    updateChannel: 'stable',
    runtimeTokenHash: hashBridgeRuntimeToken('runtime-token')
  })) as unknown) as typeof rootPrisma.bridge.findUnique
  rootPrisma.bridge.update = ((async () => ({
    id: 'bridge-1'
  })) as unknown) as typeof rootPrisma.bridge.update
  rootPrisma.printer.findMany = ((async () => []) as unknown) as typeof rootPrisma.printer.findMany

  const broadcasts: Array<{ event: unknown; tenantId: string | null }> = []
  mock.method(wsBroadcaster, 'broadcast', (event: unknown, tenantId: string | null) => {
    broadcasts.push({ event, tenantId })
  })

  const httpServer = createServer()
  const attached = attachBridgeSessionServer(httpServer)
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()))
  const address = httpServer.address() as AddressInfo
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/bridge-runtime/connect`)

  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => {
      socket.send(JSON.stringify({
        type: 'bridge.hello',
        bridgeId: 'bridge-1',
        runtimeToken: 'runtime-token',
        version: '0.1.0',
        protocolVersion: 1,
        runnerAbiVersion: 'node22-ffmpeg7-v1',
        updateChannel: 'stable'
      }))
    })

    socket.on('message', (data) => {
      const payload = JSON.parse(data.toString('utf8')) as { type: string }
      if (payload.type === 'bridge.welcome') {
        resolve()
      }
    })

    socket.once('error', reject)
  })

  assert.deepEqual(
    broadcasts.map((entry) => ({
      event: (entry.event as { type?: string; resource?: string }).type === 'resource.changed'
        ? {
            type: (entry.event as { type?: string }).type,
            resource: (entry.event as { resource?: string }).resource
          }
        : entry.event,
      tenantId: entry.tenantId
    })),
    [{
      event: { type: 'resource.changed', resource: 'bridges' },
      tenantId: 'tenant-1'
    }]
  )

  socket.close()
  await attached.close()
  await new Promise<void>((resolve, reject) => {
    httpServer.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
})

test('bridge session broadcasts bridge resource change when a bridge disconnects', async () => {
  rootPrisma.bridge.findUnique = ((async () => ({
    id: 'bridge-1',
    tenantId: 'tenant-1',
    version: '0.1.0',
    protocolVersion: 1,
    runnerAbiVersion: 'node22-ffmpeg7-v1',
    updateChannel: 'stable',
    runtimeTokenHash: hashBridgeRuntimeToken('runtime-token')
  })) as unknown) as typeof rootPrisma.bridge.findUnique
  rootPrisma.bridge.update = ((async () => ({
    id: 'bridge-1'
  })) as unknown) as typeof rootPrisma.bridge.update
  rootPrisma.printer.findMany = ((async () => []) as unknown) as typeof rootPrisma.printer.findMany

  const broadcasts: Array<{ event: unknown; tenantId: string | null }> = []
  mock.method(wsBroadcaster, 'broadcast', (event: unknown, tenantId: string | null) => {
    broadcasts.push({ event, tenantId })
  })

  const httpServer = createServer()
  const attached = attachBridgeSessionServer(httpServer)
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()))
  const address = httpServer.address() as AddressInfo
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/bridge-runtime/connect`)

  let connectBroadcastCount = 0

  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => {
      socket.send(JSON.stringify({
        type: 'bridge.hello',
        bridgeId: 'bridge-1',
        runtimeToken: 'runtime-token',
        version: '0.1.0',
        protocolVersion: 1,
        runnerAbiVersion: 'node22-ffmpeg7-v1',
        updateChannel: 'stable'
      }))
    })

    socket.on('message', (data) => {
      const payload = JSON.parse(data.toString('utf8')) as { type: string }
      if (payload.type === 'bridge.welcome') {
        connectBroadcastCount = broadcasts.filter((entry) => {
          const event = entry.event as { type?: string; resource?: string }
          return event.type === 'resource.changed' && event.resource === 'bridges' && entry.tenantId === 'tenant-1'
        }).length
        socket.close()
      }
    })

    socket.once('close', () => resolve())
    socket.once('error', reject)
  })

  await waitForCondition(() => {
    const bridgeBroadcastCount = broadcasts.filter((entry) => {
      const event = entry.event as { type?: string; resource?: string }
      return event.type === 'resource.changed' && event.resource === 'bridges' && entry.tenantId === 'tenant-1'
    }).length
    return bridgeBroadcastCount >= connectBroadcastCount + 1
  }, 'Expected bridge disconnect to broadcast another bridge resource change.')

  await attached.close()
  await new Promise<void>((resolve, reject) => {
    httpServer.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
})

test('bridge heartbeat persistence is throttled between bridge hello updates', async () => {
  rootPrisma.bridge.findUnique = ((async () => ({
    id: 'bridge-1',
    tenantId: 'tenant-1',
    runtimeTokenHash: hashBridgeRuntimeToken('runtime-token')
  })) as unknown) as typeof rootPrisma.bridge.findUnique

  const bridgeUpdates: Array<{ where: unknown; data: { lastSeenAt?: Date } }> = []
  rootPrisma.bridge.update = ((async (input: { where: unknown; data: { lastSeenAt?: Date } }) => {
    bridgeUpdates.push(input)
    return { id: 'bridge-1' }
  }) as unknown) as typeof rootPrisma.bridge.update
  rootPrisma.printer.findMany = ((async () => []) as unknown) as typeof rootPrisma.printer.findMany

  let now = 1_000_000
  mock.method(Date, 'now', () => now)

  const httpServer = createServer()
  const attached = attachBridgeSessionServer(httpServer)
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()))
  const address = httpServer.address() as AddressInfo
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/bridge-runtime/connect`)

  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => {
      socket.send(JSON.stringify({
        type: 'bridge.hello',
        bridgeId: 'bridge-1',
        runtimeToken: 'runtime-token',
        version: '0.1.0'
      }))
    })

    socket.on('message', (data) => {
      void (async () => {
        const payload = JSON.parse(data.toString('utf8')) as { type: string }
        if (payload.type !== 'bridge.welcome') return

        assert.equal(bridgeUpdates.length, 1)

        now += 15_000
        socket.send(JSON.stringify({ type: 'bridge.heartbeat' }))
        await delay(25)
        assert.equal(bridgeUpdates.length, 1)

        now += 15_000
        socket.send(JSON.stringify({ type: 'bridge.heartbeat' }))
        await delay(25)
        assert.equal(bridgeUpdates.length, 1)

        now += 60_000
        socket.send(JSON.stringify({ type: 'bridge.heartbeat' }))
        await waitForCondition(
          () => bridgeUpdates.length === 2,
          'Expected a later heartbeat to persist bridge activity again.'
        )

        assert.deepEqual(bridgeUpdates.map((entry) => entry.where), [
          { id: 'bridge-1' },
          { id: 'bridge-1' }
        ])
        assert.ok(bridgeUpdates[1]?.data.lastSeenAt instanceof Date)
        resolve()
      })().catch(reject)
    })

    socket.once('error', reject)
  })

  socket.close()
  await attached.close()
  await new Promise<void>((resolve, reject) => {
    httpServer.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
})

test('bridge session forwards camera watch lifecycle and frame delivery', async () => {
  rootPrisma.bridge.findUnique = ((async () => ({
    id: 'bridge-1',
    tenantId: 'tenant-1',
    runtimeTokenHash: hashBridgeRuntimeToken('runtime-token')
  })) as unknown) as typeof rootPrisma.bridge.findUnique
  rootPrisma.bridge.update = ((async () => ({
    id: 'bridge-1'
  })) as unknown) as typeof rootPrisma.bridge.update
  rootPrisma.printer.findMany = ((async () => []) as unknown) as typeof rootPrisma.printer.findMany

  const httpServer = createServer()
  const attached = attachBridgeSessionServer(httpServer)
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()))
  const address = httpServer.address() as AddressInfo
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/bridge-runtime/connect`)

  const receivedFrame = new Promise<Buffer>((resolve, reject) => {
    let unsubscribe: (() => void) | null = null

    socket.once('open', () => {
      socket.send(JSON.stringify({
        type: 'bridge.hello',
        bridgeId: 'bridge-1',
        runtimeToken: 'runtime-token',
        version: '0.1.0'
      }))
    })

    socket.on('message', (data) => {
      const payload = JSON.parse(data.toString('utf8')) as { type: string; printerId?: string }
      if (payload.type === 'bridge.welcome') {
        unsubscribe = bridgeSessionManager.subscribeCameraFrames('bridge-1', 'printer-1', {
          onFrame(frame) {
            unsubscribe?.()
            resolve(frame)
          },
          onClose(error) {
            reject(error)
          }
        })
        return
      }

      if (payload.type === 'bridge.camera.watch' && payload.printerId === 'printer-1') {
        socket.send(JSON.stringify({
          type: 'bridge.camera.frame',
          printerId: 'printer-1',
          jpegBase64: Buffer.from('frame-1').toString('base64')
        }))
      }
    })

    socket.once('error', reject)
  })

  assert.deepEqual(await receivedFrame, Buffer.from('frame-1'))

  socket.close()
  await attached.close()
  await new Promise<void>((resolve, reject) => {
    httpServer.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
})

test('bridge session forwards RPC progress updates before success', async () => {
  rootPrisma.bridge.findUnique = ((async () => ({
    id: 'bridge-1',
    tenantId: 'tenant-1',
    runtimeTokenHash: hashBridgeRuntimeToken('runtime-token')
  })) as unknown) as typeof rootPrisma.bridge.findUnique
  rootPrisma.bridge.update = ((async () => ({
    id: 'bridge-1'
  })) as unknown) as typeof rootPrisma.bridge.update
  rootPrisma.printer.findMany = ((async () => []) as unknown) as typeof rootPrisma.printer.findMany

  const httpServer = createServer()
  const attached = attachBridgeSessionServer(httpServer)
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()))
  const address = httpServer.address() as AddressInfo
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/bridge-runtime/connect`)

  const progressUpdates: number[] = []

  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => {
      socket.send(JSON.stringify({
        type: 'bridge.hello',
        bridgeId: 'bridge-1',
        runtimeToken: 'runtime-token',
        version: '0.1.0'
      }))
    })

    socket.on('message', (data) => {
      const payload = JSON.parse(data.toString('utf8')) as { type: string; id?: string }
      if (payload.type === 'bridge.welcome') {
        void bridgeSessionManager.requestRpc('bridge-1', 'upload', { ok: true }, {
          onProgress(bytesSent) {
            progressUpdates.push(bytesSent)
          }
        }).then((result) => {
          assert.deepEqual(progressUpdates, [128, 512])
          assert.deepEqual(result, { done: true })
          resolve()
        }).catch(reject)
        return
      }

      if (payload.type === 'bridge.rpc.request' && payload.id) {
        socket.send(JSON.stringify({
          type: 'bridge.rpc.progress',
          id: payload.id,
          bytesSent: 128,
          totalBytes: 512
        }))
        socket.send(JSON.stringify({
          type: 'bridge.rpc.progress',
          id: payload.id,
          bytesSent: 512,
          totalBytes: 512
        }))
        socket.send(JSON.stringify({
          type: 'bridge.rpc.success',
          id: payload.id,
          result: { done: true }
        }))
      }
    })

    socket.once('error', reject)
  })

  socket.close()
  await attached.close()
  await new Promise<void>((resolve, reject) => {
    httpServer.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
})

test('bridge session forwards printer FTPS activity updates to the session manager', async () => {
  rootPrisma.bridge.findUnique = ((async () => ({
    id: 'bridge-1',
    tenantId: 'tenant-1',
    runtimeTokenHash: hashBridgeRuntimeToken('runtime-token')
  })) as unknown) as typeof rootPrisma.bridge.findUnique
  rootPrisma.bridge.update = ((async () => ({
    id: 'bridge-1'
  })) as unknown) as typeof rootPrisma.bridge.update
  rootPrisma.printer.findMany = ((async () => []) as unknown) as typeof rootPrisma.printer.findMany

  const httpServer = createServer()
  const attached = attachBridgeSessionServer(httpServer)
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()))
  const address = httpServer.address() as AddressInfo
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/bridge-runtime/connect`)
  const updates: Array<{ bridgeId: string; printerId: string; active: boolean }> = []

  const originalSetPrinterFtpActivity = bridgeSessionManager.setPrinterFtpActivity.bind(bridgeSessionManager)
  mock.method(bridgeSessionManager, 'setPrinterFtpActivity', (bridgeId: string, printerId: string, active: boolean) => {
    updates.push({ bridgeId, printerId, active })
    return originalSetPrinterFtpActivity(bridgeId, printerId, active)
  })

  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => {
      socket.send(JSON.stringify({
        type: 'bridge.hello',
        bridgeId: 'bridge-1',
        runtimeToken: 'runtime-token',
        version: '0.1.0'
      }))
    })

    socket.on('message', (data) => {
      void (async () => {
      const payload = JSON.parse(data.toString('utf8')) as { type: string }
      if (payload.type !== 'bridge.welcome') return

      socket.send(JSON.stringify({
        type: 'bridge.printer.ftps.active',
        printerId: 'printer-1',
        active: true
      }))
      await waitForCondition(
        () => updates.some((update) => update.printerId === 'printer-1' && update.active),
        'Expected printer FTPS activity update to be forwarded as active.'
      )

      socket.send(JSON.stringify({
        type: 'bridge.printer.ftps.active',
        printerId: 'printer-1',
        active: false
      }))
      await waitForCondition(
        () => updates.some((update) => update.printerId === 'printer-1' && !update.active),
        'Expected printer FTPS activity update to be forwarded as inactive.'
      )
      resolve()
      })().catch(reject)
    })

    socket.once('error', reject)
  })

  socket.close()
  await attached.close()
  await new Promise<void>((resolve, reject) => {
    httpServer.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
})

test('bridge session cancels timed-out RPC requests on the bridge runtime', async () => {
  rootPrisma.bridge.findUnique = ((async () => ({
    id: 'bridge-1',
    tenantId: 'tenant-1',
    runtimeTokenHash: hashBridgeRuntimeToken('runtime-token')
  })) as unknown) as typeof rootPrisma.bridge.findUnique
  rootPrisma.bridge.update = ((async () => ({
    id: 'bridge-1'
  })) as unknown) as typeof rootPrisma.bridge.update
  rootPrisma.printer.findMany = ((async () => []) as unknown) as typeof rootPrisma.printer.findMany

  const httpServer = createServer()
  const attached = attachBridgeSessionServer(httpServer)
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()))
  const address = httpServer.address() as AddressInfo
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/bridge-runtime/connect`)

  let requestId: string | null = null
  const cancelled = new Promise<void>((resolve, reject) => {
    socket.once('error', reject)
    socket.on('message', (data) => {
      const payload = JSON.parse(data.toString('utf8')) as { type: string; id?: string }
      if (payload.type === 'bridge.rpc.request') {
        requestId = payload.id ?? null
        return
      }
      if (payload.type === 'bridge.rpc.cancel') {
        assert.equal(payload.id, requestId)
        resolve()
      }
    })
  })

  const timedOut = new Promise<void>((resolve, reject) => {
    socket.once('open', () => {
      socket.send(JSON.stringify({
        type: 'bridge.hello',
        bridgeId: 'bridge-1',
        runtimeToken: 'runtime-token',
        version: '0.1.0'
      }))
    })

    socket.on('message', (data) => {
      const payload = JSON.parse(data.toString('utf8')) as { type: string }
      if (payload.type !== 'bridge.welcome') return
      void bridgeSessionManager.requestRpc('bridge-1', 'slow.upload', {}, { timeoutMs: 20 })
        .then(() => reject(new Error('RPC unexpectedly resolved')))
        .catch((error) => {
          assert.match((error as Error).message, /Bridge RPC timed out: slow\.upload/)
          resolve()
        })
    })
  })

  await Promise.all([timedOut, cancelled])

  socket.close()
  await attached.close()
  await new Promise<void>((resolve, reject) => {
    httpServer.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
})

test('bridge session sends cancel for explicitly cancelled RPC requests', async () => {
  rootPrisma.bridge.findUnique = ((async () => ({
    id: 'bridge-1',
    tenantId: 'tenant-1',
    runtimeTokenHash: hashBridgeRuntimeToken('runtime-token')
  })) as unknown) as typeof rootPrisma.bridge.findUnique
  rootPrisma.bridge.update = ((async () => ({
    id: 'bridge-1'
  })) as unknown) as typeof rootPrisma.bridge.update
  rootPrisma.printer.findMany = ((async () => []) as unknown) as typeof rootPrisma.printer.findMany

  const httpServer = createServer()
  const attached = attachBridgeSessionServer(httpServer)
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()))
  const address = httpServer.address() as AddressInfo
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/bridge-runtime/connect`)

  let startedRequestId: string | null = null
  const cancelled = new Promise<void>((resolve, reject) => {
    socket.once('open', () => {
      socket.send(JSON.stringify({
        type: 'bridge.hello',
        bridgeId: 'bridge-1',
        runtimeToken: 'runtime-token',
        version: '0.1.0'
      }))
    })

    socket.on('message', (data) => {
      const payload = JSON.parse(data.toString('utf8')) as { type: string; id?: string }
      if (payload.type === 'bridge.welcome') {
        const started = bridgeSessionManager.startRpcRequest('bridge-1', 'cancelled.upload', {})
        void started.promise.then(
          () => reject(new Error('RPC unexpectedly resolved')),
          (error) => {
            assert.match((error as Error).message, /Bridge RPC cancelled: cancelled\.upload/)
          }
        )
        return
      }

      if (payload.type === 'bridge.rpc.request' && payload.id) {
        startedRequestId = payload.id
        bridgeSessionManager.cancelRpcRequest(payload.id)
        return
      }

      if (payload.type === 'bridge.rpc.cancel') {
        assert.equal(payload.id, startedRequestId)
        resolve()
      }
    })

    socket.once('error', reject)
  })

  await cancelled

  socket.close()
  await attached.close()
  await new Promise<void>((resolve, reject) => {
    httpServer.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
})