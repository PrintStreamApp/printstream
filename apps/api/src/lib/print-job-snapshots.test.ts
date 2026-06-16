process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, mock, test } from 'node:test'
import type { Printer } from '@printstream/shared'
import { rootPrisma } from './prisma.js'
import { restorePrismaMethodsAfterEach } from '../test-utils/prisma-stubs.js'
import { printerEvents } from './printer-events.js'
import { printerManager } from './printer-manager.js'
import {
  ensurePrintJobSnapshot,
  readPrintJobSnapshot,
  setPrintJobSnapshotFetcherForTests
} from './print-job-snapshots.js'
import {
  setNotificationSnapshotFetcherForTests,
  startNotificationSnapshotPrecapture,
  stopNotificationSnapshotPrecapture
} from './notification-snapshots.js'

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

const tempDirs = new Set<string>()

restorePrismaMethodsAfterEach([
  [rootPrisma.printJob, 'findUnique'],
  [rootPrisma.printJob, 'update']
])

afterEach(async () => {
  setPrintJobSnapshotFetcherForTests(null)
  setNotificationSnapshotFetcherForTests(null)
  stopNotificationSnapshotPrecapture()
  mock.restoreAll()
  await Promise.all(Array.from(tempDirs, async (dir) => rm(dir, { recursive: true, force: true })))
  tempDirs.clear()
})

test('ensurePrintJobSnapshot persists a fetched frame onto the job row', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bambu-job-snapshot-'))
  tempDirs.add(root)
  process.env.LIBRARY_DIR = path.join(root, 'library')

  const updates: Array<{ where: { id: string }; data: { snapshotPath: string } }> = []
  Object.defineProperty(rootPrisma.printJob, 'findUnique', {
    value: async () => ({ snapshotPath: null }),
    configurable: true
  })
  Object.defineProperty(rootPrisma.printJob, 'update', {
    value: async (input: { where: { id: string }; data: { snapshotPath: string } }) => {
      updates.push(input)
      return { id: input.where.id, snapshotPath: input.data.snapshotPath }
    },
    configurable: true
  })
  setPrintJobSnapshotFetcherForTests(async () => Buffer.from('camera-frame'))

  const storedPath = await ensurePrintJobSnapshot(printer, 'job-1')

  assert.equal(storedPath, 'job-1.jpg')
  assert.equal(updates.length, 1)
  assert.equal(updates[0]?.data.snapshotPath, 'job-1.jpg')
  const image = await readPrintJobSnapshot('job-1.jpg')
  assert.deepEqual(image, Buffer.from('camera-frame'))
})

test('ensurePrintJobSnapshot waits for an in-flight pre-capture started by job.finished', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bambu-job-snapshot-'))
  tempDirs.add(root)
  process.env.LIBRARY_DIR = path.join(root, 'library')

  const updates: Array<{ where: { id: string }; data: { snapshotPath: string } }> = []
  let resolveCapture!: (value: Buffer) => void

  Object.defineProperty(rootPrisma.printJob, 'findUnique', {
    value: async () => ({ snapshotPath: null }),
    configurable: true
  })
  Object.defineProperty(rootPrisma.printJob, 'update', {
    value: async (input: { where: { id: string }; data: { snapshotPath: string } }) => {
      updates.push(input)
      return { id: input.where.id, snapshotPath: input.data.snapshotPath }
    },
    configurable: true
  })
  mock.method(printerManager, 'getPrinter', () => printer)
  setNotificationSnapshotFetcherForTests(async () => {
    return await new Promise<Buffer>((resolve) => {
      resolveCapture = resolve
    })
  })
  setPrintJobSnapshotFetcherForTests(async () => {
    throw new Error('ensurePrintJobSnapshot should consume the in-flight pre-capture before falling back to a live fetch')
  })

  startNotificationSnapshotPrecapture()
  printerEvents.emit('job.finished', { printer, jobName: 'Target job', result: 'cancelled' })

  const storedPathPromise = ensurePrintJobSnapshot(printer, 'job-3')
  resolveCapture(Buffer.from('precaptured-frame'))
  const storedPath = await storedPathPromise

  assert.equal(storedPath, 'job-3.jpg')
  assert.equal(updates.length, 1)
  assert.equal(updates[0]?.data.snapshotPath, 'job-3.jpg')
  const image = await readPrintJobSnapshot('job-3.jpg')
  assert.deepEqual(image, Buffer.from('precaptured-frame'))
})