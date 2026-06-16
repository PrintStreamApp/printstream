process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { afterEach, mock, test } from 'node:test'
import type { Printer } from '@printstream/shared'
import { cameraStreamHub } from './camera-stream-hub.js'
import { getSharedCameraSnapshot, refreshSharedCameraSnapshot } from './camera-snapshot-cache.js'

const printer: Printer = {
  id: 'printer-1',
  name: 'Printer 1',
  host: 'printer.local',
  serial: 'SERIAL-1',
  accessCode: 'CODE',
  model: 'X1C',
  currentPlateType: null,
  currentNozzleDiameters: [],
  position: 0,
  createdAt: '2026-05-01T00:00:00.000Z',
  updatedAt: '2026-05-01T00:00:00.000Z'
}

afterEach(() => {
  mock.restoreAll()
})

test('getSharedCameraSnapshot reuses the live stream frame when available', async () => {
  const liveFrame = Buffer.from('live-frame')
  mock.method(cameraStreamHub, 'getLatestFrame', () => liveFrame)

  const result = await getSharedCameraSnapshot(printer)

  assert.deepEqual(result, liveFrame)
})

test('refreshSharedCameraSnapshot reuses the live stream frame when available', async () => {
  const liveFrame = Buffer.from('live-frame')
  mock.method(cameraStreamHub, 'getLatestFrame', () => liveFrame)

  const result = await refreshSharedCameraSnapshot(printer)

  assert.deepEqual(result, liveFrame)
})