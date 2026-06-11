process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { afterEach, mock, test } from 'node:test'
import type { Printer } from '@printstream/shared'
import { bridgeSessionManager } from './bridge-session-manager.js'
import { rootPrisma } from './prisma.js'

const {
  downloadFileFromPrinter,
  downloadFileFromPrinterOffset,
  listPrinterDirectory,
  uploadBridgeLibraryFileToPrinterPath,
  uploadBridgeLibraryPlateToPrinterPath
} = await import('./printer-ftp.js')

const originalPrinterFindUnique = rootPrisma.printer.findUnique
const originalBridgeIsConnected = bridgeSessionManager.isConnected
const originalBridgeRequestRpc = bridgeSessionManager.requestRpc

const printer: Printer = {
  id: 'printer-1',
  name: 'Printer 1',
  host: '127.0.0.1',
  serial: 'SERIAL-1',
  accessCode: 'secret',
  model: 'P1S',
  currentPlateType: null,
  currentNozzleDiameters: [],
  position: 0,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString()
}

afterEach(() => {
  mock.restoreAll()
  rootPrisma.printer.findUnique = originalPrinterFindUnique
  bridgeSessionManager.isConnected = originalBridgeIsConnected
  bridgeSessionManager.requestRpc = originalBridgeRequestRpc
})

test('downloadFileFromPrinterOffset rejects when the safety byte limit is exceeded', async () => {
  rootPrisma.printer.findUnique = ((async () => ({ bridgeId: null })) as unknown) as typeof rootPrisma.printer.findUnique
  await assert.rejects(
    () => downloadFileFromPrinterOffset(printer, '/remote.zip', 0, undefined, { maxBytes: 4 }),
    /requires a connected bridge assignment/
  )
})

test('downloadFileFromPrinterOffset uses bridge RPC for bridged printers', async () => {
  rootPrisma.printer.findUnique = ((async () => ({ bridgeId: 'bridge-1' })) as unknown) as typeof rootPrisma.printer.findUnique
  bridgeSessionManager.isConnected = (() => true) as typeof bridgeSessionManager.isConnected

  bridgeSessionManager.requestRpc = (async (_bridgeId, method, params, options) => {
    assert.equal(method, 'storage.download')
    assert.deepEqual(params, {
      printer,
      remotePath: '/remote.zip',
      startAt: 0,
      maxBytes: 4,
      truncateAtMaxBytes: undefined
    })
    assert.deepEqual(options, { timeoutMs: 300_000 })
    return {
      bufferBase64: Buffer.from('ok').toString('base64')
    }
  }) as typeof bridgeSessionManager.requestRpc

  const buffer = await downloadFileFromPrinterOffset(printer, '/remote.zip', 0, undefined, { maxBytes: 4 })
  assert.equal(buffer.toString('utf8'), 'ok')
})

test('downloadFileFromPrinter rejects when no bridge is assigned', async () => {
  rootPrisma.printer.findUnique = ((async () => ({ bridgeId: null })) as unknown) as typeof rootPrisma.printer.findUnique
  await assert.rejects(
    () => downloadFileFromPrinter(printer, ['/cached/file.3mf']),
    /requires a connected bridge assignment/
  )
})

test('downloadFileFromPrinter uses bridge RPC for bridged printers', async () => {
  rootPrisma.printer.findUnique = ((async () => ({ bridgeId: 'bridge-1' })) as unknown) as typeof rootPrisma.printer.findUnique
  bridgeSessionManager.isConnected = (() => true) as typeof bridgeSessionManager.isConnected

  let requestMethod = ''
  let requestParams: unknown = null
  let requestOptions: unknown = null
  bridgeSessionManager.requestRpc = (async (_bridgeId, method, params, options) => {
    requestMethod = method
    requestParams = params
    requestOptions = options
    return {
      bufferBase64: Buffer.from('bridge-bytes').toString('base64')
    }
  }) as typeof bridgeSessionManager.requestRpc

  const buffer = await downloadFileFromPrinter(printer, ['/cached/file.3mf'])

  assert.equal(buffer?.toString('utf8'), 'bridge-bytes')
  assert.equal(requestMethod, 'storage.download')
  assert.deepEqual(requestParams, {
    printer,
    candidates: ['/cached/file.3mf'],
    maxBytes: undefined,
    truncateAtMaxBytes: undefined
  })
  assert.deepEqual(requestOptions, { timeoutMs: 300_000 })
})

test('listPrinterDirectory uses bridge RPC for bridged printers', async () => {
  rootPrisma.printer.findUnique = ((async () => ({ bridgeId: 'bridge-1' })) as unknown) as typeof rootPrisma.printer.findUnique
  bridgeSessionManager.isConnected = (() => true) as typeof bridgeSessionManager.isConnected

  bridgeSessionManager.requestRpc = (async (_bridgeId, method, params) => {
    assert.equal(method, 'storage.list')
    assert.deepEqual(params, {
      printer,
      path: '/projects',
      recursive: false
    })
    return {
      entries: [{
        name: 'cube.3mf',
        path: '/projects/cube.3mf',
        type: 'file',
        sizeBytes: 128,
        modifiedAt: '2024-01-01T00:00:00.000Z'
      }]
    }
  }) as typeof bridgeSessionManager.requestRpc

  const entries = await listPrinterDirectory(printer, '/projects')

  assert.deepEqual(entries, [{
    name: 'cube.3mf',
    path: '/projects/cube.3mf',
    type: 'file',
    sizeBytes: 128,
    modifiedAt: '2024-01-01T00:00:00.000Z'
  }])
})

test('uploadBridgeLibraryFileToPrinterPath uses bridge RPC for bridged printers', async () => {
  rootPrisma.printer.findUnique = ((async () => ({ bridgeId: 'bridge-1' })) as unknown) as typeof rootPrisma.printer.findUnique
  bridgeSessionManager.isConnected = (() => true) as typeof bridgeSessionManager.isConnected

  bridgeSessionManager.requestRpc = (async (_bridgeId, method, params, options) => {
    assert.equal(method, 'storage.uploadLibraryFile')
    assert.deepEqual(params, {
      printer,
      remotePath: '/cache/cube.3mf',
      storedPath: 'replica-cube.3mf'
    })
    assert.deepEqual(options, { timeoutMs: 1_800_000 })
    return { path: '/cache/cube.3mf', sizeBytes: 2048 }
  }) as typeof bridgeSessionManager.requestRpc

  const uploaded = await uploadBridgeLibraryFileToPrinterPath(printer, 'replica-cube.3mf', '/cache/cube.3mf')

  assert.deepEqual(uploaded, { path: '/cache/cube.3mf', sizeBytes: 2048 })
})

test('uploadBridgeLibraryPlateToPrinterPath uses bridge RPC for bridged printers', async () => {
  rootPrisma.printer.findUnique = ((async () => ({ bridgeId: 'bridge-1' })) as unknown) as typeof rootPrisma.printer.findUnique
  bridgeSessionManager.isConnected = (() => true) as typeof bridgeSessionManager.isConnected

  bridgeSessionManager.requestRpc = (async (_bridgeId, method, params, options) => {
    assert.equal(method, 'storage.uploadLibraryPlateFile')
    assert.deepEqual(params, {
      printer,
      remotePath: '/cache/cube-plate-2.3mf',
      storedPath: 'replica-cube.3mf',
      plate: 2
    })
    assert.deepEqual(options, { timeoutMs: 1_800_000 })
    return { path: '/cache/cube-plate-2.3mf', sizeBytes: 512 }
  }) as typeof bridgeSessionManager.requestRpc

  const uploaded = await uploadBridgeLibraryPlateToPrinterPath(printer, 'replica-cube.3mf', 2, '/cache/cube-plate-2.3mf')

  assert.deepEqual(uploaded, { path: '/cache/cube-plate-2.3mf', sizeBytes: 512 })
})