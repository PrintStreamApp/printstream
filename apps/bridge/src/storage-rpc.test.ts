import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Printer } from '@printstream/shared'
import { handleStorageRpc } from './storage-rpc.js'

const printer: Printer = {
  id: 'printer-1',
  name: 'Test Printer',
  host: 'printer.local',
  serial: 'TEST-001',
  accessCode: 'TEST',
  model: 'X1C',
  currentPlateType: 'Textured PEI Plate',
  currentNozzleDiameters: [{ extruderId: 0, diameter: '0.4' }],
  position: 0,
  createdAt: '2026-05-01T00:00:00.000Z',
  updatedAt: '2026-05-01T00:00:00.000Z'
}

test('storage RPC validates methods and cancels a prepared upload before FTP begins', async () => {
  const signal = new AbortController()
  const progress: Array<[number, number | null]> = []
  const reportProgress = (bytes: number, total: number | null) => progress.push([bytes, total])

  assert.deepEqual(await handleStorageRpc('library.read', {}, signal.signal, reportProgress), { handled: false })
  await assert.rejects(handleStorageRpc('storage.list', { printer, path: '' }, signal.signal, reportProgress))

  signal.abort()
  await assert.rejects(
    handleStorageRpc('storage.upload', {
      printer,
      remotePath: '/test.3mf',
      fileBase64: Buffer.from('test').toString('base64')
    }, signal.signal, reportProgress),
    /Bridge RPC cancelled/
  )
  assert.deepEqual(progress, [[0, null]])
})
