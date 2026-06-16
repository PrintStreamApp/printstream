process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { afterEach, beforeEach, mock, test } from 'node:test'
import type { Printer } from '@printstream/shared'
import { bridgeSessionManager } from './bridge-session-manager.js'
import { rootPrisma } from './prisma.js'

const { clearPrinterZipTransportHints, readPrinterZipEntries } = await import('./printer-remote-zip.js')
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

beforeEach(() => {
  clearPrinterZipTransportHints()
})

afterEach(() => {
  mock.restoreAll()
  clearPrinterZipTransportHints()
  rootPrisma.printer.findUnique = originalPrinterFindUnique
  bridgeSessionManager.isConnected = originalBridgeIsConnected
  bridgeSessionManager.requestRpc = originalBridgeRequestRpc
})

test('readPrinterZipEntries reads selected entries through bridge-backed zip RPC', async () => {
  const archive = createStoredZip([
    { path: 'Metadata/plate_2.png', data: Buffer.from('plate-preview') },
    { path: 'Metadata/slice_info.config', data: Buffer.from('slice-info') }
  ])

  rootPrisma.printer.findUnique = ((async () => ({ bridgeId: 'bridge-1' })) as unknown) as typeof rootPrisma.printer.findUnique
  bridgeSessionManager.isConnected = (() => true) as typeof bridgeSessionManager.isConnected
  bridgeSessionManager.requestRpc = (async (_bridgeId, method, params) => {
    if (method === 'storage.readZipEntries') {
      return {
        entries: {
          'Metadata/plate_2.png': Buffer.from('plate-preview').toString('base64'),
          'Metadata/slice_info.config': Buffer.from('slice-info').toString('base64')
        },
        remoteSize: 1024,
        bytesRead: 512
      }
    }
    // Prefix fallback path: used when restart offset hints are cached from disk
    if (method === 'storage.download') {
      const input = params as { startAt?: number; maxBytes?: number; truncateAtMaxBytes?: boolean }
      const startAt = Math.max(0, Math.trunc(input.startAt ?? 0))
      let buffer = archive.subarray(startAt)
      if (typeof input.maxBytes === 'number' && input.maxBytes > 0 && buffer.byteLength > input.maxBytes) {
        buffer = input.truncateAtMaxBytes ? buffer.subarray(0, input.maxBytes) : buffer
      }
      return { bufferBase64: buffer.toString('base64') }
    }
    throw new Error(`Unexpected RPC method: ${method}`)
  }) as typeof bridgeSessionManager.requestRpc

  const entries = await readPrinterZipEntries(printer, '/remote.zip', ['Metadata/plate_2.png', 'Metadata/slice_info.config'])

  assert.deepEqual(Array.from(entries.entries()), [
    ['Metadata/plate_2.png', Buffer.from('plate-preview')],
    ['Metadata/slice_info.config', Buffer.from('slice-info')]
  ])
})

test('readPrinterZipEntries falls back to a prefix read when suffix RPC fails', async () => {
  const fallbackPrinter: Printer = {
    ...printer,
    id: 'printer-fallback-1',
    serial: 'SERIAL-FALLBACK-1'
  }
  const archive = createStoredZip([
    { path: 'Metadata/slice_info.config', data: Buffer.from('slice-info') }
  ])

  rootPrisma.printer.findUnique = ((async () => ({ bridgeId: 'bridge-1' })) as unknown) as typeof rootPrisma.printer.findUnique
  bridgeSessionManager.isConnected = (() => true) as typeof bridgeSessionManager.isConnected

  let zipEntriesCalls = 0
  bridgeSessionManager.requestRpc = (async (_bridgeId, method, params) => {
    if (method === 'storage.readZipEntries') {
      zipEntriesCalls += 1
      throw new Error('502 restart offset not supported')
    }
    if (method === 'storage.download') {
      const input = params as {
        startAt?: number
        maxBytes?: number
        truncateAtMaxBytes?: boolean
      }
      const startAt = Math.max(0, Math.trunc(input.startAt ?? 0))
      let buffer = archive.subarray(startAt)
      if (typeof input.maxBytes === 'number' && input.maxBytes > 0 && buffer.byteLength > input.maxBytes) {
        buffer = input.truncateAtMaxBytes ? buffer.subarray(0, input.maxBytes) : buffer
      }
      return { bufferBase64: buffer.toString('base64') }
    }
    throw new Error(`Unexpected RPC method: ${method}`)
  }) as typeof bridgeSessionManager.requestRpc

  const firstResult = await readPrinterZipEntries(fallbackPrinter, '/remote.zip', ['Metadata/slice_info.config'])
  assert.equal(firstResult.get('Metadata/slice_info.config')?.toString('utf8'), 'slice-info')
  const zipEntriesCallsAfterFirstRead = zipEntriesCalls

  const secondResult = await readPrinterZipEntries(fallbackPrinter, '/remote.zip', ['Metadata/slice_info.config'])
  assert.equal(secondResult.get('Metadata/slice_info.config')?.toString('utf8'), 'slice-info')
  // After the first 502 failure, subsequent reads should skip the suffix path
  assert.equal(zipEntriesCalls, zipEntriesCallsAfterFirstRead)
})

test('readPrinterZipEntries uses a larger prefix budget for slice metadata configs during fallback reads', async () => {
  const fallbackPrinter: Printer = {
    ...printer,
    id: 'printer-fallback-2',
    serial: 'SERIAL-FALLBACK-2'
  }
  const archive = createStoredZip([
    { path: 'padding.bin', data: Buffer.alloc(300 * 1024, 0x61) },
    { path: 'Metadata/slice_info.config', data: Buffer.from('<plate><metadata key="index" value="1"/></plate>') },
    { path: 'Metadata/project_settings.config', data: Buffer.from('{"curr_bed_type":"Cool Plate"}') }
  ])

  rootPrisma.printer.findUnique = ((async () => ({ bridgeId: 'bridge-1' })) as unknown) as typeof rootPrisma.printer.findUnique
  bridgeSessionManager.isConnected = (() => true) as typeof bridgeSessionManager.isConnected
  bridgeSessionManager.requestRpc = (async (_bridgeId, method, params) => {
    if (method === 'storage.readZipEntries') {
      throw new Error('502 restart offset not supported')
    }
    if (method === 'storage.download') {
      const input = params as {
        startAt?: number
        maxBytes?: number
        truncateAtMaxBytes?: boolean
      }
      const startAt = Math.max(0, Math.trunc(input.startAt ?? 0))
      let buffer = archive.subarray(startAt)
      if (typeof input.maxBytes === 'number' && input.maxBytes > 0 && buffer.byteLength > input.maxBytes) {
        buffer = input.truncateAtMaxBytes ? buffer.subarray(0, input.maxBytes) : buffer
      }
      return { bufferBase64: buffer.toString('base64') }
    }
    throw new Error(`Unexpected RPC method: ${method}`)
  }) as typeof bridgeSessionManager.requestRpc

  const entries = await readPrinterZipEntries(fallbackPrinter, '/remote.zip', [
    'Metadata/slice_info.config',
    'Metadata/project_settings.config'
  ])

  assert.equal(entries.get('Metadata/slice_info.config')?.toString('utf8'), '<plate><metadata key="index" value="1"/></plate>')
  assert.equal(entries.get('Metadata/project_settings.config')?.toString('utf8'), '{"curr_bed_type":"Cool Plate"}')
})

function createStoredZip(entries: Array<{ path: string; data: Buffer }>): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let localOffset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf8')
    const crc32 = computeCrc32(entry.data)
    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt16LE(0, 6)
    localHeader.writeUInt16LE(0, 8)
    localHeader.writeUInt16LE(0, 10)
    localHeader.writeUInt16LE(0, 12)
    localHeader.writeUInt32LE(crc32 >>> 0, 14)
    localHeader.writeUInt32LE(entry.data.byteLength, 18)
    localHeader.writeUInt32LE(entry.data.byteLength, 22)
    localHeader.writeUInt16LE(name.byteLength, 26)
    localHeader.writeUInt16LE(0, 28)
    localParts.push(localHeader, name, entry.data)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(20, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt16LE(0, 8)
    centralHeader.writeUInt16LE(0, 10)
    centralHeader.writeUInt16LE(0, 12)
    centralHeader.writeUInt16LE(0, 14)
    centralHeader.writeUInt32LE(crc32 >>> 0, 16)
    centralHeader.writeUInt32LE(entry.data.byteLength, 20)
    centralHeader.writeUInt32LE(entry.data.byteLength, 24)
    centralHeader.writeUInt16LE(name.byteLength, 28)
    centralHeader.writeUInt16LE(0, 30)
    centralHeader.writeUInt16LE(0, 32)
    centralHeader.writeUInt16LE(0, 34)
    centralHeader.writeUInt16LE(0, 36)
    centralHeader.writeUInt32LE(0, 38)
    centralHeader.writeUInt32LE(localOffset, 42)
    centralParts.push(centralHeader, name)

    localOffset += localHeader.byteLength + name.byteLength + entry.data.byteLength
  }

  const centralDirectory = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralDirectory.byteLength, 12)
  eocd.writeUInt32LE(localOffset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...localParts, centralDirectory, eocd])
}

function computeCrc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      const mask = -(crc & 1)
      crc = (crc >>> 1) ^ (0xedb88320 & mask)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}