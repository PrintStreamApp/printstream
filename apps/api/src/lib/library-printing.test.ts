process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import type { PrintDispatchJob, PrintFromLibrary, Printer } from '@printstream/shared'
import { bridgeSessionManager } from './bridge-session-manager.js'
import { enqueueLibraryPrint } from './library-printing.js'
import { printDispatcher } from './print-dispatcher.js'
import { printerManager } from './printer-manager.js'
import { prisma } from './prisma.js'

const originalLibraryFileFindFirst = prisma.libraryFile.findFirst
const originalLibraryFileFindMany = prisma.libraryFile.findMany
const originalPrinterFindFirst = prisma.printer.findFirst
const originalIsConnected = bridgeSessionManager.isConnected
const originalGetPrinter = printerManager.getPrinter
const originalEnqueueSnapshotPrint = printDispatcher.enqueueSnapshotPrint

afterEach(() => {
  prisma.libraryFile.findFirst = originalLibraryFileFindFirst
  prisma.libraryFile.findMany = originalLibraryFileFindMany
  prisma.printer.findFirst = originalPrinterFindFirst
  bridgeSessionManager.isConnected = originalIsConnected
  printerManager.getPrinter = originalGetPrinter
  printDispatcher.enqueueSnapshotPrint = originalEnqueueSnapshotPrint
})

test('library print uses a unique connected replacement for stale disconnected bridge files', async () => {
  prisma.libraryFile.findFirst = ((async () => makeLibraryFile({
    id: 'old-file',
    ownerBridgeId: 'old-bridge',
    storedPath: 'old.gcode',
    snapshotKey: 'old-snapshot'
  })) as unknown) as typeof prisma.libraryFile.findFirst
  prisma.libraryFile.findMany = ((async () => [
    makeLibraryFile({
      id: 'new-file',
      ownerBridgeId: 'new-bridge',
      storedPath: 'new.gcode',
      snapshotKey: 'new-snapshot'
    })
  ]) as unknown) as typeof prisma.libraryFile.findMany
  prisma.printer.findFirst = ((async () => makePrinter()) as unknown) as typeof prisma.printer.findFirst
  bridgeSessionManager.isConnected = ((bridgeId: string) => bridgeId === 'new-bridge') as typeof bridgeSessionManager.isConnected
  printerManager.getPrinter = (() => makePrinter()) as typeof printerManager.getPrinter

  let dispatchedSnapshot: { id: string; ownerBridgeId?: string | null; storedPath: string } | null = null
  printDispatcher.enqueueSnapshotPrint = (async (input) => {
    dispatchedSnapshot = {
      id: input.snapshot.id,
      ownerBridgeId: input.snapshot.ownerBridgeId,
      storedPath: input.snapshot.storedPath
    }
    return makeJob()
  }) as typeof printDispatcher.enqueueSnapshotPrint

  await enqueueLibraryPrint(makePrintInput(), 'tenant-1')

  assert.deepEqual(dispatchedSnapshot, {
    id: 'new-file',
    ownerBridgeId: 'new-bridge',
    storedPath: 'new.gcode'
  })
})

test('library print recovers hidden stale snapshots with a unique connected replacement', async () => {
  prisma.libraryFile.findFirst = ((async () => makeLibraryFile({
    id: 'old-hidden-file',
    ownerBridgeId: 'old-bridge',
    storedPath: 'old-hidden.gcode',
    snapshotKey: 'old-hidden-snapshot',
    hidden: true
  })) as unknown) as typeof prisma.libraryFile.findFirst
  prisma.libraryFile.findMany = ((async () => [
    makeLibraryFile({
      id: 'new-visible-file',
      ownerBridgeId: 'new-bridge',
      storedPath: 'new-visible.gcode',
      snapshotKey: null
    })
  ]) as unknown) as typeof prisma.libraryFile.findMany
  prisma.printer.findFirst = ((async () => makePrinter()) as unknown) as typeof prisma.printer.findFirst
  bridgeSessionManager.isConnected = ((bridgeId: string) => bridgeId === 'new-bridge') as typeof bridgeSessionManager.isConnected
  printerManager.getPrinter = (() => makePrinter()) as typeof printerManager.getPrinter

  let dispatchedSnapshot: { id: string; ownerBridgeId?: string | null; storedPath: string } | null = null
  printDispatcher.enqueueSnapshotPrint = (async (input) => {
    dispatchedSnapshot = {
      id: input.snapshot.id,
      ownerBridgeId: input.snapshot.ownerBridgeId,
      storedPath: input.snapshot.storedPath
    }
    return makeJob()
  }) as typeof printDispatcher.enqueueSnapshotPrint

  await enqueueLibraryPrint(makePrintInput(), 'tenant-1')

  assert.deepEqual(dispatchedSnapshot, {
    id: 'new-visible-file',
    ownerBridgeId: 'new-bridge',
    storedPath: 'new-visible.gcode'
  })
})

function makeLibraryFile(overrides: Partial<{
  id: string
  ownerBridgeId: string | null
  storedPath: string
  snapshotKey: string | null
  hidden: boolean
}> = {}) {
  return {
    id: overrides.id ?? 'file-1',
    tenantId: 'tenant-1',
    ownerBridgeId: overrides.ownerBridgeId ?? 'bridge-1',
    name: 'part.gcode',
    storedPath: overrides.storedPath ?? 'part.gcode',
    sizeBytes: 123,
    kind: 'gcode',
    thumbnailPath: null,
    uploadedAt: new Date('2026-05-08T18:00:00.000Z'),
    currentVersionNumber: 1,
    folderId: null,
    snapshotKey: overrides.snapshotKey ?? 'snapshot-1',
    hidden: overrides.hidden ?? false
  }
}

function makePrinter(): Printer {
  return {
    id: 'printer-1',
    name: 'Printer One',
    host: 'printer-one.local',
    serial: 'SERIAL-1',
    accessCode: 'secret',
    model: 'P1S',
    bridgeId: 'new-bridge',
    currentPlateType: null,
    currentNozzleDiameters: [],
    position: 0,
    createdAt: '2026-05-08T18:00:00.000Z',
    updatedAt: '2026-05-08T18:00:00.000Z'
  }
}

function makePrintInput(): PrintFromLibrary {
  return {
    fileId: 'old-file',
    printerId: 'printer-1',
    useAms: true,
    bedLevel: 'on',
    vibrationCompensation: false,
    flowCalibration: 'off',
    firstLayerInspection: true,
    timelapse: false,
    filamentDynamicsCalibration: false,
    nozzleOffsetCalibration: 'auto',
    allowIncompatibleFilament: false,
    allowPlateTypeMismatch: false,
    currentPlateType: null,
    currentNozzleDiameters: [],
    plate: 1
  }
}

function makeJob(): PrintDispatchJob {
  return {
    id: 'job-1',
    printJobId: 'print-job-1',
    printerId: 'printer-1',
    printerName: 'Printer One',
    fileId: 'new-file',
    fileName: 'part.gcode',
    jobName: 'part.gcode',
    fileSizeBytes: 123,
    sourceKind: 'gcode',
    projectFilamentChips: [],
    plate: 1,
    plateName: null,
    useAms: true,
    bedLevel: 'on',
    amsMapping: null,
    status: 'queued',
    progressMessage: '',
    uploadAttempt: 0,
    uploadMaxAttempts: 3,
    uploadBytesSent: 0,
    uploadTotalBytes: null,
    uploadPercent: null,
    error: null,
    createdAt: new Date('2026-05-08T18:00:00.000Z').toISOString(),
    updatedAt: new Date('2026-05-08T18:00:00.000Z').toISOString(),
    startedAt: null,
    finishedAt: null,
    cancelRequested: false
  }
}
