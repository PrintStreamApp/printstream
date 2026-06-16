process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, mock, test } from 'node:test'
import type { Printer, PrinterStatus } from '@printstream/shared'
import yazl from 'yazl'
import { rootPrisma } from './prisma.js'
import { clearAllPendingPrintJobSources, peekPendingPrintJobSource, registerPendingPrintJobSource } from './pending-print-job-source.js'
import { printerEvents } from './printer-events.js'
import { printerManager } from './printer-manager.js'
import {
  buildResolvedExternalPrintJobName,
  cancelTrackedPrintJobRecord,
  createPrintJobStartRecord,
  failTrackedPrintJobStart,
  finishTrackedPrintJobRecord,
  reserveTrackedPrintJobStart,
  resolveRelevantPrintJobId,
  resolvePrintJobIdByTaskId,
  setPrintJobSnapshotEnsurerForTests,
  startPrintJobRecorder,
  stopPrintJobRecorder,
  upsertTrackedPrintJobRecord
} from './print-job-recorder.js'
import { restorePrismaMethodsAfterEach } from '../test-utils/prisma-stubs.js'

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

// Snapshot + auto-restore every rootPrisma method the suite overrides, so the tests can keep using
// raw Object.defineProperty at their setup sites without hand-tracking originals or a restore block.
restorePrismaMethodsAfterEach([
  [rootPrisma.printJob, 'findFirst'],
  [rootPrisma.printJob, 'findUnique'],
  [rootPrisma.printJob, 'create'],
  [rootPrisma.printJob, 'update'],
  [rootPrisma.printJob, 'updateMany'],
  [rootPrisma.printer, 'findUnique'],
  [rootPrisma.libraryFile, 'findUnique'],
  [rootPrisma.libraryFile, 'findMany'],
  [rootPrisma.printerStats, 'upsert'],
  [rootPrisma, '$transaction']
])

afterEach(() => {
  stopPrintJobRecorder()
  clearAllPendingPrintJobSources()
  mock.restoreAll()
  setPrintJobSnapshotEnsurerForTests(null)
  return Promise.all(Array.from(tempDirs, async (dir) => rm(dir, { recursive: true, force: true }))).then(() => {
    tempDirs.clear()
  })
})

function installRootTransactionMock(): void {
  Object.defineProperty(rootPrisma, '$transaction', {
    value: async (callback: (tx: typeof rootPrisma) => Promise<unknown>) => callback(rootPrisma),
    configurable: true
  })
}

async function createFilamentUsageArchive(fileName = 'fixture.gcode.3mf'): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'bambu-print-job-usage-'))
  tempDirs.add(dir)
  const filePath = path.join(dir, fileName)
  const zip = new yazl.ZipFile()

  zip.addBuffer(Buffer.from([
    '<config>',
    '  <plate>',
    '    <metadata key="index" value="1"/>',
    '    <metadata key="gcode_file" value="Metadata/plate_1.gcode"/>',
    '    <filament id="1" type="PLA Basic" color="#112233" used_g="12.5" used_m="4.2" group_id="0" nozzle_diameter="0.4"/>',
    '  </plate>',
    '</config>'
  ].join('\n'), 'utf8'), 'Metadata/slice_info.config')

  await new Promise<void>((resolve, reject) => {
    zip.outputStream
      .pipe(createWriteStream(filePath))
      .on('close', resolve)
      .on('error', reject)
    zip.end()
  })

  return filePath
}

// Deadline-based (not iteration-count-based): polls on setImmediate so it resolves the moment the
// async work settles, but a saturated CPU that needs more event-loop turns no longer trips it early.
async function waitForAssertion(assertion: () => void, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown = null
  for (;;) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
    }
    if (Date.now() >= deadline) break
    await new Promise((resolve) => setImmediate(resolve))
  }

  throw lastError
}

test('createPrintJobStartRecord falls back when calibration history columns are missing', async () => {
  let attempts = 0

  Object.defineProperty(rootPrisma.printer, 'findUnique', {
    value: async () => ({ tenantId: 'tenant-1' }),
    configurable: true
  })
  Object.defineProperty(rootPrisma.printJob, 'create', {
    value: async ({ data }: { data: Record<string, unknown> }) => {
      attempts += 1
      if (attempts === 1) {
        assert.equal(data.sourceType, 'calibration')
        assert.equal(data.calibrationOption, 6)
        throw { code: 'P2022' }
      }
      assert.equal('sourceType' in data, false)
      assert.equal('calibrationOption' in data, false)
      return {
        id: 'job-1',
        jobName: String(data.jobName ?? '')
      }
    },
    configurable: true
  })

  const created = await createPrintJobStartRecord({
    printerId: 'printer-1',
    jobName: 'Calibration',
    metadata: {
      jobKind: 'calibration',
      jobId: 'calibration:1',
      fileId: null,
      fileName: null,
      fileSizeBytes: null,
      sourceKind: null,
      plate: null,
      useAms: null,
      bedLevel: null,
      amsMapping: null,
      calibrationOption: 6
    }
  })

  assert.deepEqual(created, {
    id: 'job-1',
    jobName: 'Calibration'
  })
  assert.equal(attempts, 2)
})

test('reserveTrackedPrintJobStart precreates a durable job id and pending source', async () => {
  const creates: Array<Record<string, unknown>> = []
  const dispatchEvents: Array<{ printerId: string; jobId: string; fileName: string }> = []
  const onDispatchStarting = (event: { printerId: string; jobId: string; fileName: string }) => {
    dispatchEvents.push(event)
  }

  Object.defineProperty(rootPrisma.printer, 'findUnique', {
    value: async () => ({ tenantId: 'tenant-1' }),
    configurable: true
  })
  Object.defineProperty(rootPrisma.printJob, 'findUnique', {
    value: async () => null,
    configurable: true
  })
  Object.defineProperty(rootPrisma.printJob, 'create', {
    value: async ({ data }: { data: Record<string, unknown> }) => {
      creates.push(data)
      return {
        id: String(data.id ?? 'job-1'),
        jobName: String(data.jobName ?? '')
      }
    },
    configurable: true
  })

  printerEvents.on('print.job.starting', onDispatchStarting)

  try {
    const jobId = await reserveTrackedPrintJobStart({
      printerId: 'printer-1',
      jobName: 'Cube',
      fileName: 'Cube.3mf',
      metadata: {
        jobKind: 'file',
        jobId: null,
        fileId: 'file-1',
        fileName: 'Cube.3mf',
        fileSizeBytes: 123,
        sourceKind: '3mf',
        plate: 1,
        useAms: true,
        bedLevel: true,
        amsMapping: [0],
        calibrationOption: null
      }
    })

    assert.equal(creates.length, 1)
    assert.equal(creates[0]?.id, jobId)
    assert.equal(creates[0]?.jobName, 'Cube')
    assert.deepEqual(peekPendingPrintJobSource('printer-1'), {
      jobKind: 'file',
      jobId,
      fileId: 'file-1',
      fileName: 'Cube.3mf',
      fileSizeBytes: 123,
      sourceKind: '3mf',
      plate: 1,
      useAms: true,
      bedLevel: true,
      amsMapping: [0],
      calibrationOption: null
    })
    assert.deepEqual(dispatchEvents, [{ printerId: 'printer-1', jobId, taskId: null, fileName: 'Cube.3mf' }])
  } finally {
    printerEvents.off('print.job.starting', onDispatchStarting)
  }
})

test('resolveRelevantPrintJobId only returns active or pending tracked jobs', async () => {
  registerPendingPrintJobSource('printer-1', {
    jobKind: 'file',
    jobId: 'job-pending-1',
    taskId: 'task-pending-1',
    fileId: null,
    fileName: null,
    fileSizeBytes: null,
    sourceKind: 'gcode',
    plate: null,
    useAms: null,
    bedLevel: null,
    amsMapping: null,
    calibrationOption: null
  })

  assert.equal(await resolveRelevantPrintJobId('printer-1'), 'job-pending-1')

  clearAllPendingPrintJobSources()
  assert.equal(await resolveRelevantPrintJobId('printer-1'), null)
})

test('failTrackedPrintJobStart clears the matching pending source and finishes the job', async () => {
  const finished: Array<{ jobId: string; result: string }> = []

  registerPendingPrintJobSource('printer-1', {
    jobKind: 'file',
    jobId: 'job-1',
    fileId: null,
    fileName: null,
    fileSizeBytes: null,
    sourceKind: 'gcode',
    plate: null,
    useAms: null,
    bedLevel: null,
    amsMapping: null,
    calibrationOption: null
  })
  Object.defineProperty(rootPrisma.printJob, 'findUnique', {
    value: async () => ({
      startedAt: new Date('2026-05-03T10:00:00.000Z'),
      finishedAt: null,
      printerId: 'printer-1',
      jobName: 'Cube'
    }),
    configurable: true
  })
  Object.defineProperty(rootPrisma.printJob, 'update', {
    value: async (input: { where: { id: string }; data: Record<string, unknown> }) => {
      finished.push({ jobId: input.where.id, result: String(input.data.result ?? '') })
      return { id: input.where.id }
    },
    configurable: true
  })

  await failTrackedPrintJobStart({ printerId: 'printer-1', jobId: 'job-1' })

  assert.equal(peekPendingPrintJobSource('printer-1'), null)
  assert.deepEqual(finished, [{ jobId: 'job-1', result: 'failed' }])
})

test('job.finished does not synthesize a history row when the start event was missed', async () => {
  const creates: Array<Record<string, unknown>> = []
  const updates: Array<{ where: { id: string }; data: Record<string, unknown> }> = []
  const statsUpserts: Array<Record<string, unknown>> = []
  const finishedEvents: Array<{ jobId: string; result: 'success' | 'failed' | 'cancelled'; snapshotPath: string | null }> = []

  registerPendingPrintJobSource('printer-1', {
    jobKind: 'file',
    jobId: 'dispatch-1',
    taskId: 'task-1',
    fileId: 'file-1',
    fileName: 'Cube.3mf',
    fileSizeBytes: 123,
    sourceKind: '3mf',
    plate: 1,
    useAms: true,
    bedLevel: true,
    amsMapping: [0],
    calibrationOption: null
  })

  Object.defineProperty(rootPrisma.printer, 'findUnique', {
    value: async () => ({ tenantId: 'tenant-1', serial: 'SERIAL-1' }),
    configurable: true
  })
  Object.defineProperty(rootPrisma.printJob, 'findFirst', {
    value: async () => null,
    configurable: true
  })
  Object.defineProperty(rootPrisma.printJob, 'create', {
    value: async ({ data }: { data: Record<string, unknown> }) => {
      creates.push(data)
      return {
        id: 'job-1',
        jobName: String(data.jobName ?? '')
      }
    },
    configurable: true
  })
  Object.defineProperty(rootPrisma.printJob, 'findUnique', {
    value: async (input: { select?: Record<string, unknown> }) => (
      input.select && 'result' in input.select
        ? {
            id: 'job-1',
            startedAt: new Date('2026-05-03T10:00:00.000Z'),
            printerId: 'printer-1',
            result: 'success',
            durationSeconds: 0,
            filamentUsedGrams: null,
            filamentUsedMeters: null,
            printerStatsRecordedAt: null
          }
        : {
            startedAt: new Date('2026-05-03T10:00:00.000Z')
          }
    ),
    configurable: true
  })
  Object.defineProperty(rootPrisma.printJob, 'update', {
    value: async (input: { where: { id: string }; data: Record<string, unknown> }) => {
      updates.push(input)
      return { id: input.where.id }
    },
    configurable: true
  })
  Object.defineProperty(rootPrisma.printJob, 'updateMany', {
    value: async () => ({ count: 1 }),
    configurable: true
  })
  Object.defineProperty(rootPrisma.printerStats, 'upsert', {
    value: async (input: Record<string, unknown>) => {
      statsUpserts.push(input)
      return input
    },
    configurable: true
  })
  installRootTransactionMock()
  mock.method(printerManager, 'getStatus', () => ({ progressPercent: 100, taskId: 'task-1' }) as never)
  mock.method(printerManager, 'getPrinter', () => printer)
  setPrintJobSnapshotEnsurerForTests(async () => null)

  startPrintJobRecorder()
  printerEvents.on('print-job.finished', (event) => {
    finishedEvents.push({ jobId: event.jobId, result: event.result, snapshotPath: event.snapshotPath })
  })
  printerEvents.emit('job.finished', { printer, jobName: 'Cube.3mf', result: 'success' })
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(creates.length, 0)
  assert.equal(updates.length, 0)
  assert.equal(statsUpserts.length, 0)
  assert.deepEqual(finishedEvents, [])
})

test('finishTrackedPrintJobRecord resolves filament usage when the job ends', async () => {
  const updates: Array<{ where: { id: string }; data: Record<string, unknown> }> = []
  let filamentLookupCount = 0

  const jobState: {
    startedAt: Date
    finishedAt: Date | null
    tenantId: string
    printerId: string
    jobName: string
    sourceType: 'library'
    fileId: string | null
    plate: number | null
    result: string
    durationSeconds: number | null
    filamentUsedGrams: number | null
    filamentUsedMeters: number | null
    printerStatsRecordedAt: Date | null
  } = {
    startedAt: new Date('2026-05-03T10:00:00.000Z'),
    finishedAt: null,
    tenantId: 'tenant-1',
    printerId: 'printer-1',
    jobName: 'Cube.3mf',
    sourceType: 'library' as const,
    fileId: 'file-1',
    plate: 1,
    result: 'success',
    durationSeconds: 600,
    filamentUsedGrams: 42,
    filamentUsedMeters: 11,
    printerStatsRecordedAt: null
  }

  Object.defineProperty(rootPrisma.printJob, 'findUnique', {
    value: async (input: { select?: Record<string, unknown> }) => {
      if (input.select && 'result' in input.select) {
        return jobState
      }
      return {
        startedAt: jobState.startedAt,
        finishedAt: jobState.finishedAt,
        tenantId: jobState.tenantId,
        printerId: jobState.printerId,
        jobName: jobState.jobName,
        sourceType: jobState.sourceType,
        fileId: jobState.fileId,
        plate: jobState.plate
      }
    },
    configurable: true
  })
  Object.defineProperty(rootPrisma.printJob, 'update', {
    value: async (input: { where: { id: string }; data: Record<string, unknown> }) => {
      updates.push(input)
      jobState.finishedAt = (input.data.finishedAt as Date | null | undefined) ?? jobState.finishedAt
      jobState.durationSeconds = (input.data.durationSeconds as number | null | undefined) ?? jobState.durationSeconds
      jobState.result = String(input.data.result ?? jobState.result)
      jobState.filamentUsedGrams = (input.data.filamentUsedGrams as number | null | undefined) ?? jobState.filamentUsedGrams
      jobState.filamentUsedMeters = (input.data.filamentUsedMeters as number | null | undefined) ?? jobState.filamentUsedMeters
      return { id: input.where.id }
    },
    configurable: true
  })
  Object.defineProperty(rootPrisma.libraryFile, 'findUnique', {
    value: async () => {
      filamentLookupCount += 1
      return {
        tenantId: 'tenant-2',
        kind: '3mf',
        ownerBridgeId: null,
        storedPath: 'other-tenant.3mf'
      }
    },
    configurable: true
  })
  Object.defineProperty(rootPrisma.printJob, 'updateMany', {
    value: async () => ({ count: 1 }),
    configurable: true
  })
  Object.defineProperty(rootPrisma.printer, 'findUnique', {
    value: async () => ({ tenantId: 'tenant-1', serial: 'SERIAL-1' }),
    configurable: true
  })
  Object.defineProperty(rootPrisma.printerStats, 'upsert', {
    value: async () => ({ ok: true }),
    configurable: true
  })
  installRootTransactionMock()

  await finishTrackedPrintJobRecord({
    jobId: 'job-1',
    result: 'success'
  })

  assert.equal(filamentLookupCount, 1)
  assert.equal(updates.length, 1)
  assert.equal(updates[0]?.data.filamentUsedGrams, null)
  assert.equal(updates[0]?.data.filamentUsedMeters, null)
})

test('finishTrackedPrintJobRecord records filament usage for sliced .gcode.3mf library jobs', async () => {
  const archivePath = await createFilamentUsageArchive()
  const updates: Array<{ where: { id: string }; data: Record<string, unknown> }> = []
  const statsUpserts: Array<Record<string, unknown>> = []

  const jobState: {
    startedAt: Date
    finishedAt: Date | null
    tenantId: string
    printerId: string
    jobName: string
    sourceType: 'library'
    fileId: string | null
    plate: number | null
    result: string
    durationSeconds: number | null
    filamentUsedGrams: number | null
    filamentUsedMeters: number | null
    printerStatsRecordedAt: Date | null
  } = {
    startedAt: new Date('2026-05-03T10:00:00.000Z'),
    finishedAt: null,
    tenantId: 'tenant-1',
    printerId: 'printer-1',
    jobName: 'Cube.gcode.3mf',
    sourceType: 'library',
    fileId: 'file-1',
    plate: 1,
    result: 'success',
    durationSeconds: 600,
    filamentUsedGrams: null,
    filamentUsedMeters: null,
    printerStatsRecordedAt: null
  }

  Object.defineProperty(rootPrisma.printJob, 'findUnique', {
    value: async (input: { select?: Record<string, unknown> }) => {
      if (input.select && 'result' in input.select) {
        return jobState
      }
      return {
        startedAt: jobState.startedAt,
        finishedAt: jobState.finishedAt,
        tenantId: jobState.tenantId,
        printerId: jobState.printerId,
        jobName: jobState.jobName,
        sourceType: jobState.sourceType,
        fileId: jobState.fileId,
        plate: jobState.plate
      }
    },
    configurable: true
  })
  Object.defineProperty(rootPrisma.printJob, 'update', {
    value: async (input: { where: { id: string }; data: Record<string, unknown> }) => {
      updates.push(input)
      jobState.finishedAt = (input.data.finishedAt as Date | null | undefined) ?? jobState.finishedAt
      jobState.durationSeconds = (input.data.durationSeconds as number | null | undefined) ?? jobState.durationSeconds
      jobState.result = String(input.data.result ?? jobState.result)
      jobState.filamentUsedGrams = (input.data.filamentUsedGrams as number | null | undefined) ?? jobState.filamentUsedGrams
      jobState.filamentUsedMeters = (input.data.filamentUsedMeters as number | null | undefined) ?? jobState.filamentUsedMeters
      return { id: input.where.id }
    },
    configurable: true
  })
  Object.defineProperty(rootPrisma.libraryFile, 'findUnique', {
    value: async () => ({
      tenantId: 'tenant-1',
      kind: 'gcode',
      ownerBridgeId: null,
      storedPath: archivePath
    }),
    configurable: true
  })
  Object.defineProperty(rootPrisma.printJob, 'updateMany', {
    value: async () => ({ count: 1 }),
    configurable: true
  })
  Object.defineProperty(rootPrisma.printer, 'findUnique', {
    value: async () => ({ tenantId: 'tenant-1', serial: 'SERIAL-1' }),
    configurable: true
  })
  Object.defineProperty(rootPrisma.printerStats, 'upsert', {
    value: async (input: Record<string, unknown>) => {
      statsUpserts.push(input)
      return { ok: true }
    },
    configurable: true
  })
  installRootTransactionMock()

  await finishTrackedPrintJobRecord({
    jobId: 'job-1',
    result: 'success'
  })

  assert.equal(updates.length, 1)
  assert.equal(updates[0]?.data.filamentUsedGrams, 12.5)
  assert.equal(updates[0]?.data.filamentUsedMeters, 4.2)
  assert.equal(statsUpserts.length, 1)
  assert.deepEqual(statsUpserts[0]?.update, {
    totalPrints: { increment: 1 },
    successfulPrints: { increment: 1 },
    failedPrints: { increment: 0 },
    cancelledPrints: { increment: 0 },
    successfulPrintDurationSeconds: { increment: updates[0]?.data.durationSeconds },
    failedPrintDurationSeconds: { increment: 0 },
    cancelledPrintDurationSeconds: { increment: 0 },
    wastedPrintDurationSeconds: { increment: 0 },
    trackedFilamentPrints: { increment: 1 },
    filamentUsedGrams: { increment: 12.5 },
    successfulFilamentUsedGrams: { increment: 12.5 },
    failedFilamentUsedGrams: { increment: 0 },
    cancelledFilamentUsedGrams: { increment: 0 },
    wastedFilamentUsedGrams: { increment: 0 },
    filamentUsedMeters: { increment: 4.2 },
    successfulFilamentUsedMeters: { increment: 4.2 },
    failedFilamentUsedMeters: { increment: 0 },
    cancelledFilamentUsedMeters: { increment: 0 },
    wastedFilamentUsedMeters: { increment: 0 }
  })
})

test('status reconciliation closes an unfinished persisted job once a restored printer is idle again', async () => {
  const updates: Array<{ where: { id: string }; data: Record<string, unknown> }> = []

  Object.defineProperty(rootPrisma.printJob, 'findMany', {
    value: async () => ([{
      id: 'job-1',
      printerId: 'printer-1',
      taskId: 'task-idle',
      jobName: 'job-1',
      printerFilePath: null,
      sourceType: 'external',
      fileId: null,
      thumbnailPath: null,
      startedAt: new Date('2026-05-03T10:00:00.000Z')
    }]),
    configurable: true
  })
  Object.defineProperty(rootPrisma.printJob, 'findUnique', {
    value: async () => ({ startedAt: new Date('2026-05-03T10:00:00.000Z'), finishedAt: null }),
    configurable: true
  })
  Object.defineProperty(rootPrisma.printJob, 'update', {
    value: async (input: { where: { id: string }; data: Record<string, unknown> }) => {
      updates.push(input)
      return { id: input.where.id }
    },
    configurable: true
  })

  startPrintJobRecorder()
  printerEvents.emit('status', {
    printerId: 'printer-1',
    taskId: 'task-idle',
    online: true,
    stage: 'idle',
    progressPercent: 42
  } as never)
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(updates.length, 1)
  assert.equal(updates[0]?.where.id, 'job-1')
  assert.equal(updates[0]?.data.result, 'unknown')
  assert.equal(updates[0]?.data.progressPercent, 42)
  assert.ok(updates[0]?.data.finishedAt instanceof Date)
})

test('status reconciliation closes stale unfinished jobs when a terminal status no longer includes a task id', async () => {
  const updates: Array<{ where: { id: string }; data: Record<string, unknown> }> = []
  const updateManyCalls: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = []
  const unfinishedJobIds = new Set(['job-new', 'job-old'])

  Object.defineProperty(rootPrisma.printer, 'findUnique', {
    value: async () => ({ tenantId: 'tenant-1' }),
    configurable: true
  })

  Object.defineProperty(rootPrisma.printJob, 'findMany', {
    value: async ({ where }: { where: { printerId: string; finishedAt: null; taskId?: string } }) => {
      const rows = [{
        id: 'job-new',
        printerId: 'printer-1',
        taskId: 'task-old',
        jobName: 'Newest job',
        printerFilePath: null,
        sourceType: 'external',
        fileId: null,
        thumbnailPath: null,
        startedAt: new Date('2026-05-03T11:00:00.000Z')
      }, {
        id: 'job-old',
        printerId: 'printer-1',
        taskId: null,
        jobName: 'Older stale job',
        printerFilePath: null,
        sourceType: 'external',
        fileId: null,
        thumbnailPath: null,
        startedAt: new Date('2026-05-03T10:00:00.000Z')
      }].filter((row) => unfinishedJobIds.has(row.id))

      if (where.taskId) {
        return rows.filter((row) => row.taskId === where.taskId)
      }

      return rows
    },
    configurable: true
  })
  Object.defineProperty(rootPrisma.printJob, 'findUnique', {
    value: async ({ where }: { where: { id: string } }) => {
      if (where.id !== 'job-new') return null
      return {
        startedAt: new Date('2026-05-03T11:00:00.000Z'),
        finishedAt: null,
        printerId: 'printer-1',
        jobName: 'Newest job',
        taskId: 'task-old',
        tenantId: 'tenant-1',
        sourceType: 'external',
        fileId: null,
        plate: null
      }
    },
    configurable: true
  })
  Object.defineProperty(rootPrisma.printJob, 'update', {
    value: async (input: { where: { id: string }; data: Record<string, unknown> }) => {
      updates.push(input)
      unfinishedJobIds.delete(input.where.id)
      return { id: input.where.id }
    },
    configurable: true
  })
  Object.defineProperty(rootPrisma.printJob, 'updateMany', {
    value: async (input: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      updateManyCalls.push(input)
      const ids = ((input.where.id as { in?: string[] } | undefined)?.in) ?? []
      for (const id of ids) unfinishedJobIds.delete(id)
      return { count: 1 }
    },
    configurable: true
  })

  startPrintJobRecorder()
  printerEvents.emit('status', {
    printerId: 'printer-1',
    taskId: null,
    online: true,
    stage: 'idle',
    progressPercent: 42
  } as never)

  await waitForAssertion(() => {
    assert.equal(updates.length, 1)
    assert.equal(updateManyCalls.length, 1)
  })

  assert.equal(updates[0]?.where.id, 'job-new')
  assert.equal(updates[0]?.data.result, 'unknown')
  assert.equal(updates[0]?.data.progressPercent, 42)
  assert.deepEqual(updateManyCalls[0]?.where, { id: { in: ['job-old'] } })
  assert.equal(updateManyCalls[0]?.data.result, 'unknown')
  assert.equal(updateManyCalls[0]?.data.progressPercent, null)
})

test('status reconciliation closes stale unfinished jobs when the terminal task id does not match the persisted row', async () => {
  const updates: Array<{ where: { id: string }; data: Record<string, unknown> }> = []
  const updateManyCalls: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = []
  const unfinishedJobIds = new Set(['job-new', 'job-old'])

  Object.defineProperty(rootPrisma.printer, 'findUnique', {
    value: async () => ({ tenantId: 'tenant-1' }),
    configurable: true
  })

  Object.defineProperty(rootPrisma.printJob, 'findMany', {
    value: async ({ where }: { where: { printerId: string; finishedAt: null; taskId?: string } }) => {
      const rows = [{
        id: 'job-new',
        printerId: 'printer-1',
        taskId: null,
        jobName: 'Newest job',
        printerFilePath: null,
        sourceType: 'external',
        fileId: null,
        thumbnailPath: null,
        startedAt: new Date('2026-05-03T11:00:00.000Z')
      }, {
        id: 'job-old',
        printerId: 'printer-1',
        taskId: null,
        jobName: 'Older stale job',
        printerFilePath: null,
        sourceType: 'external',
        fileId: null,
        thumbnailPath: null,
        startedAt: new Date('2026-05-03T10:00:00.000Z')
      }].filter((row) => unfinishedJobIds.has(row.id))

      if (where.taskId) return []
      return rows
    },
    configurable: true
  })
  Object.defineProperty(rootPrisma.printJob, 'findUnique', {
    value: async ({ where }: { where: { id: string } }) => {
      if (where.id !== 'job-new') return null
      return {
        startedAt: new Date('2026-05-03T11:00:00.000Z'),
        finishedAt: null,
        printerId: 'printer-1',
        jobName: 'Newest job',
        taskId: null,
        tenantId: 'tenant-1',
        sourceType: 'external',
        fileId: null,
        plate: null
      }
    },
    configurable: true
  })
  Object.defineProperty(rootPrisma.printJob, 'update', {
    value: async (input: { where: { id: string }; data: Record<string, unknown> }) => {
      updates.push(input)
      unfinishedJobIds.delete(input.where.id)
      return { id: input.where.id }
    },
    configurable: true
  })
  Object.defineProperty(rootPrisma.printJob, 'updateMany', {
    value: async (input: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      updateManyCalls.push(input)
      const ids = ((input.where.id as { in?: string[] } | undefined)?.in) ?? []
      for (const id of ids) unfinishedJobIds.delete(id)
      return { count: 1 }
    },
    configurable: true
  })

  startPrintJobRecorder()
  printerEvents.emit('status', {
    printerId: 'printer-1',
    taskId: 'task-finished',
    online: true,
    stage: 'finished',
    progressPercent: 100
  } as never)

  await waitForAssertion(() => {
    assert.equal(updates.length, 1)
    assert.equal(updateManyCalls.length, 1)
  })

  assert.equal(updates[0]?.where.id, 'job-new')
  assert.equal(updates[0]?.data.result, 'success')
  assert.equal(updates[0]?.data.progressPercent, 100)
  assert.deepEqual(updateManyCalls[0]?.where, { id: { in: ['job-old'] } })
  assert.equal(updateManyCalls[0]?.data.result, 'unknown')
})

test('status reconciliation closes unrelated stale unfinished jobs after matching the terminal task', async () => {
  const updates: Array<{ where: { id: string }; data: Record<string, unknown> }> = []
  const updateManyCalls: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = []
  const unfinishedJobIds = new Set(['job-current', 'job-old'])

  Object.defineProperty(rootPrisma.printer, 'findUnique', {
    value: async () => ({ tenantId: 'tenant-1' }),
    configurable: true
  })

  Object.defineProperty(rootPrisma.printJob, 'findMany', {
    value: async ({ where }: { where: { printerId: string; finishedAt: null; taskId?: string } }) => {
      const rows = [{
        id: 'job-current',
        printerId: 'printer-1',
        taskId: 'task-finished',
        jobName: 'Current job',
        printerFilePath: null,
        sourceType: 'external',
        fileId: null,
        thumbnailPath: null,
        startedAt: new Date('2026-05-03T11:00:00.000Z')
      }, {
        id: 'job-old',
        printerId: 'printer-1',
        taskId: null,
        jobName: 'Older stale job',
        printerFilePath: null,
        sourceType: 'external',
        fileId: null,
        thumbnailPath: null,
        startedAt: new Date('2026-05-03T10:00:00.000Z')
      }].filter((row) => unfinishedJobIds.has(row.id))

      if (where.taskId) return rows.filter((row) => row.taskId === where.taskId)
      return rows
    },
    configurable: true
  })
  Object.defineProperty(rootPrisma.printJob, 'findUnique', {
    value: async ({ where }: { where: { id: string } }) => {
      if (where.id !== 'job-current') return null
      return {
        startedAt: new Date('2026-05-03T11:00:00.000Z'),
        finishedAt: null,
        printerId: 'printer-1',
        jobName: 'Current job',
        taskId: 'task-finished',
        tenantId: 'tenant-1',
        sourceType: 'external',
        fileId: null,
        plate: null
      }
    },
    configurable: true
  })
  Object.defineProperty(rootPrisma.printJob, 'update', {
    value: async (input: { where: { id: string }; data: Record<string, unknown> }) => {
      updates.push(input)
      unfinishedJobIds.delete(input.where.id)
      return { id: input.where.id }
    },
    configurable: true
  })
  Object.defineProperty(rootPrisma.printJob, 'updateMany', {
    value: async (input: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      updateManyCalls.push(input)
      const ids = ((input.where.id as { in?: string[] } | undefined)?.in) ?? []
      for (const id of ids) unfinishedJobIds.delete(id)
      return { count: 1 }
    },
    configurable: true
  })

  startPrintJobRecorder()
  printerEvents.emit('status', {
    printerId: 'printer-1',
    taskId: 'task-finished',
    online: true,
    stage: 'finished',
    progressPercent: 100
  } as never)

  await waitForAssertion(() => {
    assert.equal(updates.length, 1)
    assert.equal(updateManyCalls.length, 1)
  })

  assert.equal(updates[0]?.where.id, 'job-current')
  assert.equal(updates[0]?.data.result, 'success')
  assert.deepEqual(updateManyCalls[0]?.where, { id: { in: ['job-old'] } })
  assert.equal(updateManyCalls[0]?.data.result, 'unknown')
})

test('status reconciliation stores a snapshot when a restored printer reports a failed print', async () => {
  const updates: Array<{ where: { id: string }; data: Record<string, unknown> }> = []
  const snapshotCalls: Array<{ printerId: string; jobId: string }> = []
  const jobId = 'job-failed-snapshot'

  Object.defineProperty(rootPrisma.printJob, 'findMany', {
    value: async () => ([{
      id: jobId,
      printerId: 'printer-1',
      taskId: 'task-failed',
      jobName: jobId,
      printerFilePath: null,
      sourceType: 'external',
      fileId: null,
      thumbnailPath: null,
      startedAt: new Date('2026-05-03T10:00:00.000Z')
    }]),
    configurable: true
  })
  Object.defineProperty(rootPrisma.printJob, 'findUnique', {
    value: async () => ({ startedAt: new Date('2026-05-03T10:00:00.000Z'), finishedAt: null, printerId: 'printer-1' }),
    configurable: true
  })
  Object.defineProperty(rootPrisma.printJob, 'update', {
    value: async (input: { where: { id: string }; data: Record<string, unknown> }) => {
      updates.push(input)
      return { id: input.where.id }
    },
    configurable: true
  })
  mock.method(printerManager, 'getPrinter', () => printer)
  setPrintJobSnapshotEnsurerForTests(async (snapshotPrinter, snapshotJobId) => {
    snapshotCalls.push({ printerId: snapshotPrinter.id, jobId: snapshotJobId })
    return `${snapshotJobId}.jpg`
  })

  startPrintJobRecorder()
  printerEvents.emit('status', {
    printerId: 'printer-1',
    taskId: 'task-failed',
    online: true,
    stage: 'failed',
    progressPercent: 57
  } as never)
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(updates.length, 1)
  assert.equal(updates[0]?.where.id, jobId)
  assert.equal(updates[0]?.data.result, 'failed')
  assert.deepEqual(snapshotCalls, [{ printerId: 'printer-1', jobId }])
})

test('status reconciliation stores a snapshot when a restored printer reports a finished print', async () => {
  const updates: Array<{ where: { id: string }; data: Record<string, unknown> }> = []
  const snapshotCalls: Array<{ printerId: string; jobId: string }> = []
  const jobId = 'job-finished-snapshot'

  Object.defineProperty(rootPrisma.printJob, 'findMany', {
    value: async () => ([{
      id: jobId,
      printerId: 'printer-1',
      taskId: 'task-finished',
      jobName: jobId,
      printerFilePath: null,
      sourceType: 'external',
      fileId: null,
      thumbnailPath: null,
      startedAt: new Date('2026-05-03T10:00:00.000Z')
    }]),
    configurable: true
  })
  Object.defineProperty(rootPrisma.printJob, 'findUnique', {
    value: async () => ({ startedAt: new Date('2026-05-03T10:00:00.000Z'), finishedAt: null, printerId: 'printer-1' }),
    configurable: true
  })
  Object.defineProperty(rootPrisma.printJob, 'update', {
    value: async (input: { where: { id: string }; data: Record<string, unknown> }) => {
      updates.push(input)
      return { id: input.where.id }
    },
    configurable: true
  })
  mock.method(printerManager, 'getPrinter', () => printer)
  setPrintJobSnapshotEnsurerForTests(async (snapshotPrinter, snapshotJobId) => {
    snapshotCalls.push({ printerId: snapshotPrinter.id, jobId: snapshotJobId })
    return `${snapshotJobId}.jpg`
  })

  startPrintJobRecorder()
  printerEvents.emit('status', {
    printerId: 'printer-1',
    taskId: 'task-finished',
    online: true,
    stage: 'finished',
    progressPercent: 100
  } as never)
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(updates.length, 1)
  assert.equal(updates[0]?.where.id, jobId)
  assert.equal(updates[0]?.data.result, 'success')
  assert.deepEqual(snapshotCalls, [{ printerId: 'printer-1', jobId }])
})

test('job.finished stores a snapshot for cancelled jobs before emitting the recorded finish event', async () => {
  const finishedEvents: Array<{ jobId: string; snapshotPath: string | null; result: 'success' | 'failed' | 'cancelled' }> = []
  const snapshotCalls: Array<{ printerId: string; jobId: string }> = []

  Object.defineProperty(rootPrisma.printJob, 'findMany', {
    value: async () => ([{
      id: 'job-1',
      printerId: 'printer-1',
      taskId: 'task-cancelled',
      jobName: 'Cube.3mf',
      printerFilePath: null,
      sourceType: 'external',
      fileId: null,
      thumbnailPath: null,
      startedAt: new Date('2026-05-03T10:00:00.000Z')
    }]),
    configurable: true
  })
  Object.defineProperty(rootPrisma.printJob, 'findUnique', {
    value: async ({ where }: { where: { id: string } }) => {
      if (where.id === 'job-1') return { startedAt: new Date('2026-05-03T10:00:00.000Z') }
      return null
    },
    configurable: true
  })
  Object.defineProperty(rootPrisma.printJob, 'update', {
    value: async (input: { where: { id: string }; data: Record<string, unknown> }) => ({
      id: input.where.id,
      ...input.data
    }),
    configurable: true
  })
  mock.method(printerManager, 'getStatus', () => ({ progressPercent: 55, taskId: 'task-cancelled' }) as never)
  mock.method(printerManager, 'getPrinter', () => printer)
  setPrintJobSnapshotEnsurerForTests(async (snapshotPrinter, snapshotJobId) => {
    snapshotCalls.push({ printerId: snapshotPrinter.id, jobId: snapshotJobId })
    return `${snapshotJobId}.jpg`
  })

  startPrintJobRecorder()
  printerEvents.on('print-job.finished', (event) => {
    finishedEvents.push({ jobId: event.jobId, snapshotPath: event.snapshotPath, result: event.result })
  })
  printerEvents.emit('job.finished', { printer, jobName: 'Cube.3mf', result: 'cancelled' })
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(snapshotCalls, [{ printerId: 'printer-1', jobId: 'job-1' }])
  assert.deepEqual(finishedEvents, [{ jobId: 'job-1', snapshotPath: 'job-1.jpg', result: 'cancelled' }])
})

test('job.started reuses the dispatched unfinished row by id when the printer reports a different job name', async () => {
  const updates: Array<{ where: { id: string }; data: Record<string, unknown> }> = []
  let createCalls = 0

  registerPendingPrintJobSource('printer-1', {
    jobKind: 'file',
    jobId: 'dispatch-1',
    fileId: 'file-1',
    fileName: 'Cube.3mf',
    fileSizeBytes: 123,
    sourceKind: '3mf',
    plate: 1,
    useAms: true,
    bedLevel: true,
    amsMapping: [0],
    calibrationOption: null
  })

  Object.defineProperty(rootPrisma.printJob, 'findUnique', {
    value: async ({ where }: { where: { id: string } }) => {
      if (where.id !== 'dispatch-1') return null
      return { id: 'dispatch-1', jobName: 'Queued print', taskId: null }
    },
    configurable: true
  })
  Object.defineProperty(rootPrisma.printJob, 'findFirst', {
    value: async () => {
      throw new Error('job.started should reuse the dispatched row before falling back to jobName matching')
    },
    configurable: true
  })
  Object.defineProperty(rootPrisma.printJob, 'create', {
    value: async () => {
      createCalls += 1
      return { id: 'created-late', jobName: 'created-late' }
    },
    configurable: true
  })
  Object.defineProperty(rootPrisma.printJob, 'update', {
    value: async (input: { where: { id: string }; data: Record<string, unknown> }) => {
      updates.push(input)
      return { id: input.where.id }
    },
    configurable: true
  })
  mock.method(printerManager, 'getStatus', () => ({ gcodeFile: 'Metadata/plate_1.gcode', taskId: null }) as never)

  startPrintJobRecorder()
  printerEvents.emit('job.started', { printer, jobName: 'Cube - Plate 1' })
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(createCalls, 0)
  assert.equal(updates.length, 1)
  assert.equal(updates[0]?.where.id, 'dispatch-1')
  assert.equal(updates[0]?.data.jobName, 'Cube - Plate 1')
})

test('job.started reuses the dispatched unfinished row by id when the printer reports a different live task id', async () => {
  const updates: Array<{ where: { id: string }; data: Record<string, unknown> }> = []

  registerPendingPrintJobSource('printer-1', {
    jobKind: 'file',
    jobId: 'dispatch-1',
    fileId: 'file-1',
    fileName: 'Cube.3mf',
    fileSizeBytes: 123,
    sourceKind: '3mf',
    plate: 1,
    useAms: true,
    bedLevel: true,
    amsMapping: [0],
    calibrationOption: null
  })

  Object.defineProperty(rootPrisma.printJob, 'findUnique', {
    value: async ({ where }: { where: { id: string } }) => {
      if (where.id !== 'dispatch-1') return null
      return { id: 'dispatch-1', jobName: 'Queued print', taskId: null }
    },
    configurable: true
  })
  Object.defineProperty(rootPrisma.printJob, 'update', {
    value: async (input: { where: { id: string }; data: Record<string, unknown> }) => {
      updates.push(input)
      return { id: input.where.id }
    },
    configurable: true
  })
  mock.method(printerManager, 'getStatus', () => ({ gcodeFile: 'Metadata/plate_1.gcode', taskId: 'printer-task' }) as never)

  startPrintJobRecorder()
  printerEvents.emit('job.started', { printer, jobName: 'Queued print' })
  await waitForAssertion(() => {
    assert.equal(updates.length, 1)
  })

  assert.equal(updates.length, 1)
  assert.equal(updates[0]?.where.id, 'dispatch-1')
  assert.equal(updates[0]?.data.taskId, 'printer-task')
})

test('status syncs the tracked BH job to the printer task id when it appears after start', async () => {
  const updates: Array<{ where: { id: string }; data: Record<string, unknown> }> = []

  registerPendingPrintJobSource('printer-1', {
    jobKind: 'file',
    jobId: 'dispatch-1',
    fileId: 'file-1',
    fileName: 'Cube.3mf',
    fileSizeBytes: 123,
    sourceKind: '3mf',
    plate: 1,
    useAms: true,
    bedLevel: true,
    amsMapping: [0],
    calibrationOption: null
  })

  Object.defineProperty(rootPrisma.printJob, 'findUnique', {
    value: async ({ where }: { where: { id: string } }) => {
      if (where.id !== 'dispatch-1') return null
      return { id: 'dispatch-1', jobName: 'Queued print', taskId: null }
    },
    configurable: true
  })
  Object.defineProperty(rootPrisma.printJob, 'update', {
    value: async (input: { where: { id: string }; data: Record<string, unknown> }) => {
      updates.push(input)
      return { id: input.where.id }
    },
    configurable: true
  })

  let currentTaskId: string | null = null
  mock.method(printerManager, 'getStatus', () => ({ gcodeFile: 'Metadata/plate_1.gcode', taskId: currentTaskId }) as never)

  startPrintJobRecorder()
  printerEvents.emit('job.started', { printer, jobName: 'Queued print' })
  await new Promise((resolve) => setImmediate(resolve))

  currentTaskId = 'printer-task'
  printerEvents.emit('status', {
    printerId: 'printer-1',
    online: true,
    stage: 'printing',
    taskId: 'printer-task'
  } as PrinterStatus)
  await waitForAssertion(() => {
    assert.equal(updates.length, 1)
  })

  assert.equal(updates.length, 1)
  assert.equal(updates[0]?.where.id, 'dispatch-1')
  assert.equal(updates[0]?.data.taskId, 'printer-task')
})

test('status sync stores an exact printer archive path when the printer exposes it after start', async () => {
  const updates: Array<{ where: { id: string }; data: Record<string, unknown> }> = []

  registerPendingPrintJobSource('printer-1', {
    jobKind: 'file',
    jobId: 'dispatch-1',
    fileId: 'file-1',
    fileName: 'Cube.3mf',
    fileSizeBytes: 123,
    sourceKind: '3mf',
    plate: 1,
    useAms: true,
    bedLevel: true,
    amsMapping: [0],
    calibrationOption: null
  })

  Object.defineProperty(rootPrisma.printJob, 'findUnique', {
    value: async ({ where }: { where: { id: string } }) => {
      if (where.id !== 'dispatch-1') return null
      return { id: 'dispatch-1', jobName: 'Queued print', taskId: null, printerFilePath: null }
    },
    configurable: true
  })
  Object.defineProperty(rootPrisma.printJob, 'update', {
    value: async (input: { where: { id: string }; data: Record<string, unknown> }) => {
      updates.push(input)
      return { id: input.where.id }
    },
    configurable: true
  })

  let currentStatus: { gcodeFile: string | null; taskId: string | null } = {
    gcodeFile: 'Metadata/plate_1.gcode',
    taskId: null
  }
  mock.method(printerManager, 'getStatus', () => currentStatus as never)

  startPrintJobRecorder()
  printerEvents.emit('job.started', { printer, jobName: 'Queued print' })
  await new Promise((resolve) => setImmediate(resolve))

  currentStatus = {
    gcodeFile: '/cache/Current Print.gcode.3mf',
    taskId: 'printer-task'
  }
  printerEvents.emit('status', {
    printerId: 'printer-1',
    online: true,
    stage: 'printing',
    taskId: 'printer-task',
    gcodeFile: '/cache/Current Print.gcode.3mf'
  } as PrinterStatus)

  await waitForAssertion(() => {
    assert.equal(updates.length, 1)
  })

  assert.equal(updates[0]?.where.id, 'dispatch-1')
  assert.equal(updates[0]?.data.taskId, 'printer-task')
  assert.equal(updates[0]?.data.printerFilePath, '/cache/Current Print.gcode.3mf')
})

test('status within the tracked start grace binds the printer task id back to the pending BH job', async () => {
  const updates: Array<{ where: { id: string }; data: Record<string, unknown> }> = []

  registerPendingPrintJobSource('printer-1', {
    jobKind: 'file',
    jobId: 'dispatch-1',
    fileId: 'file-1',
    fileName: 'Cube.3mf',
    fileSizeBytes: 123,
    sourceKind: '3mf',
    plate: 1,
    useAms: true,
    bedLevel: true,
    amsMapping: [0],
    calibrationOption: null
  })

  Object.defineProperty(rootPrisma.printJob, 'findUnique', {
    value: async ({ where }: { where: { id: string } }) => {
      if (where.id !== 'dispatch-1') return null
      return { id: 'dispatch-1', jobName: 'Queued print', taskId: null }
    },
    configurable: true
  })
  Object.defineProperty(rootPrisma.printJob, 'update', {
    value: async (input: { where: { id: string }; data: Record<string, unknown> }) => {
      updates.push(input)
      return { id: input.where.id }
    },
    configurable: true
  })

  startPrintJobRecorder()
  printerEvents.emit('print.job.starting', {
    printerId: 'printer-1',
    jobId: 'dispatch-1',
    taskId: null,
    fileName: 'Cube.3mf'
  })
  printerEvents.emit('status', {
    printerId: 'printer-1',
    online: true,
    stage: 'printing',
    taskId: 'printer-task',
    gcodeFile: 'Metadata/plate_1.gcode'
  } as PrinterStatus)

  await waitForAssertion(() => {
    assert.equal(updates.length, 1)
  })

  assert.equal(updates[0]?.where.id, 'dispatch-1')
  assert.equal(updates[0]?.data.taskId, 'printer-task')
})

test('concurrent tracked start activation does not fall back to an external row', async () => {
  const creates: Array<Record<string, unknown>> = []
  const updates: Array<{ where: { id: string }; data: Record<string, unknown> }> = []
  let findUniqueCalls = 0
  let releaseFindUnique!: () => void
  const findUniqueGate = new Promise<void>((resolve) => {
    releaseFindUnique = resolve
  })

  registerPendingPrintJobSource('printer-1', {
    jobKind: 'file',
    jobId: 'dispatch-1',
    fileId: 'file-1',
    fileName: 'Cube.3mf',
    fileSizeBytes: 123,
    sourceKind: '3mf',
    plate: 1,
    useAms: true,
    bedLevel: true,
    amsMapping: [0],
    calibrationOption: null
  })

  Object.defineProperty(rootPrisma.printJob, 'findUnique', {
    value: async ({ where }: { where: { id: string } }) => {
      if (where.id !== 'dispatch-1') return null
      findUniqueCalls += 1
      await findUniqueGate
      return { id: 'dispatch-1', jobName: 'Queued print', taskId: null, printerFilePath: null }
    },
    configurable: true
  })
  Object.defineProperty(rootPrisma.printJob, 'update', {
    value: async (input: { where: { id: string }; data: Record<string, unknown> }) => {
      updates.push(input)
      return { id: input.where.id }
    },
    configurable: true
  })
  Object.defineProperty(rootPrisma.printer, 'findUnique', {
    value: async () => ({ tenantId: 'tenant-1' }),
    configurable: true
  })
  Object.defineProperty(rootPrisma.printJob, 'create', {
    value: async ({ data }: { data: Record<string, unknown> }) => {
      creates.push(data)
      return {
        id: `external-${creates.length}`,
        jobName: String(data.jobName ?? '')
      }
    },
    configurable: true
  })
  mock.method(printerManager, 'getStatus', () => ({ taskId: 'printer-task', gcodeFile: 'Metadata/plate_1.gcode' }) as never)

  startPrintJobRecorder()
  printerEvents.emit('print.job.starting', {
    printerId: 'printer-1',
    jobId: 'dispatch-1',
    taskId: null,
    fileName: 'Cube.3mf'
  })

  printerEvents.emit('status', {
    printerId: 'printer-1',
    online: true,
    stage: 'printing',
    taskId: 'printer-task',
    gcodeFile: 'Metadata/plate_1.gcode'
  } as PrinterStatus)
  printerEvents.emit('job.started', { printer, jobName: 'Queued print' })

  await waitForAssertion(() => {
    assert.equal(findUniqueCalls, 1)
  })

  releaseFindUnique()

  await waitForAssertion(() => {
    assert.equal(updates.length, 1)
  })

  assert.equal(creates.length, 0)
  assert.equal(updates[0]?.where.id, 'dispatch-1')
  assert.equal(updates[0]?.data.taskId, 'printer-task')
})

test('job.started creates an external print record keyed by the printer task id', async () => {
  const creates: Array<Record<string, unknown>> = []

  Object.defineProperty(rootPrisma.printer, 'findUnique', {
    value: async () => ({ tenantId: 'tenant-1' }),
    configurable: true
  })
  Object.defineProperty(rootPrisma.printJob, 'findFirst', {
    value: async () => null,
    configurable: true
  })
  Object.defineProperty(rootPrisma.printJob, 'create', {
    value: async ({ data }: { data: Record<string, unknown> }) => {
      creates.push(data)
      return {
        id: 'external-1',
        jobName: String(data.jobName ?? '')
      }
    },
    configurable: true
  })
  Object.defineProperty(rootPrisma.libraryFile, 'findMany', {
    value: async () => [],
    configurable: true
  })
  mock.method(printerManager, 'getStatus', () => ({ taskId: 'external-task', gcodeFile: '/cache/External Cube.gcode.3mf' }) as never)

  startPrintJobRecorder()
  printerEvents.emit('job.started', { printer, jobName: 'External cube' })
  await waitForAssertion(() => {
    assert.equal(creates.length, 1)
  })

  assert.equal(creates[0]?.taskId, 'external-task')
  assert.equal(creates[0]?.printerFilePath, '/cache/External Cube.gcode.3mf')
  assert.equal(creates[0]?.sourceType, 'external')
  assert.equal(creates[0]?.jobName, 'External cube')
  assert.equal(creates[0]?.plate, null)
})

test('job.started infers the external print plate from observed job data when the printer does not send Metadata plate hints', async () => {
  const creates: Array<Record<string, unknown>> = []

  Object.defineProperty(rootPrisma.printer, 'findUnique', {
    value: async () => ({ tenantId: 'tenant-1' }),
    configurable: true
  })
  Object.defineProperty(rootPrisma.printJob, 'findFirst', {
    value: async () => null,
    configurable: true
  })
  Object.defineProperty(rootPrisma.printJob, 'create', {
    value: async ({ data }: { data: Record<string, unknown> }) => {
      creates.push(data)
      return {
        id: 'external-plate-1',
        jobName: String(data.jobName ?? '')
      }
    },
    configurable: true
  })
  Object.defineProperty(rootPrisma.libraryFile, 'findMany', {
    value: async () => [],
    configurable: true
  })
  mock.method(printerManager, 'getStatus', () => ({
    taskId: 'external-task',
    gcodeFile: '/CSM - Bambu - 2 - Mast_ Feeders_ Counter holder_ Mount feet.gcode.3mf'
  }) as never)

  startPrintJobRecorder()
  printerEvents.emit('job.started', { printer, jobName: 'CSM - Bambu - 2 - Mast, Feeders, Counter holder, Mount feet' })
  await waitForAssertion(() => {
    assert.equal(creates.length, 1)
  })

  assert.equal(creates[0]?.plate, 2)
})

test('buildResolvedExternalPrintJobName replaces fallback plate labels with a resolved plate name', () => {
  assert.equal(
    buildResolvedExternalPrintJobName('Best Shot Golf - plate_4', '/Best Shot Golf - plate_4.gcode.3mf', 'Front Nine'),
    'Best Shot Golf - Front Nine'
  )
  assert.equal(
    buildResolvedExternalPrintJobName('plate_4', '/Best Shot Golf - plate_4.gcode.3mf', 'Front Nine'),
    'Best Shot Golf - Front Nine'
  )
})

test('resolvePrintJobIdByTaskId prefers the library-backed unfinished row when duplicate task ids exist', async () => {
  const duplicatePrinter = {
    ...printer,
    id: 'printer-duplicate-existing',
    serial: 'SERIAL-DUPLICATE-EXISTING'
  }

  Object.defineProperty(rootPrisma.printJob, 'findMany', {
    value: async () => ([
      {
        id: 'library-1',
        printerId: duplicatePrinter.id,
        taskId: 'external-task-preferred',
        jobName: 'Queued print',
        printerFilePath: '/cache/Current Print.gcode.3mf',
        sourceType: 'library',
        fileId: 'file-1',
        thumbnailPath: 'thumb.jpg',
        startedAt: new Date('2026-05-13T19:03:36.329Z')
      },
      {
        id: 'external-1',
        printerId: duplicatePrinter.id,
        taskId: 'external-task-preferred',
        jobName: 'plate_4',
        printerFilePath: null,
        sourceType: 'external',
        fileId: null,
        thumbnailPath: null,
        startedAt: new Date('2026-05-13T19:04:20.829Z')
      }
    ]),
    configurable: true
  })
  const resolved = await resolvePrintJobIdByTaskId(duplicatePrinter.id, 'external-task-preferred')

  assert.equal(resolved, 'library-1')
})

test('overlapping status starts only create one external print record for the same task', async () => {
  const overlapPrinterId = 'printer-overlap-external'
  const overlapTaskId = 'external-task-overlap'
  const creates: Array<Record<string, unknown>> = []
  let releaseFindMany!: () => void
  let resolveFindMany!: () => void
  let resolveCreate!: () => void
  const findManyGate = new Promise<void>((resolve) => {
    releaseFindMany = resolve
  })
  const findManySeen = new Promise<void>((resolve) => {
    resolveFindMany = resolve
  })
  const createSeen = new Promise<void>((resolve) => {
    resolveCreate = resolve
  })

  Object.defineProperty(rootPrisma.printer, 'findUnique', {
    value: async () => ({ tenantId: 'tenant-1' }),
    configurable: true
  })
  Object.defineProperty(rootPrisma.printJob, 'findMany', {
    value: async () => {
      resolveFindMany()
      await findManyGate
      return []
    },
    configurable: true
  })
  Object.defineProperty(rootPrisma.printJob, 'create', {
    value: async ({ data }: { data: Record<string, unknown> }) => {
      creates.push(data)
      resolveCreate()
      return {
        id: `external-${creates.length}`,
        jobName: String(data.jobName ?? '')
      }
    },
    configurable: true
  })
  Object.defineProperty(rootPrisma.libraryFile, 'findMany', {
    value: async () => [],
    configurable: true
  })

  startPrintJobRecorder()
  const status = {
    printerId: overlapPrinterId,
    online: true,
    stage: 'printing',
    taskId: overlapTaskId,
    gcodeFile: '/cache/External Cube.gcode.3mf'
  } as PrinterStatus

  printerEvents.emit('status', status)
  printerEvents.emit('status', status)
  printerEvents.emit('status', status)

  await findManySeen

  releaseFindMany()
  await createSeen

  assert.equal(creates.length, 1)
  assert.equal(creates[0]?.taskId, overlapTaskId)
  assert.equal(creates[0]?.sourceType, 'external')
})

test('status reconciliation prefers the library-backed unfinished row and closes duplicate externals for the task', async () => {
  const updates: Array<{ where: { id: string }; data: Record<string, unknown> }> = []
  const updateManyCalls: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = []
  const unfinishedJobIds = new Set(['library-1', 'external-1'])

  Object.defineProperty(rootPrisma.printer, 'findUnique', {
    value: async () => ({ tenantId: 'tenant-1' }),
    configurable: true
  })
  Object.defineProperty(rootPrisma.printJob, 'findMany', {
    value: async () => ([
      {
        id: 'library-1',
        printerId: 'printer-1',
        taskId: 'task-idle',
        jobName: 'Best Shot Golf - plate_4',
        printerFilePath: '/cache/Current Print.gcode.3mf',
        sourceType: 'library',
        fileId: 'file-1',
        thumbnailPath: 'thumb.jpg',
        startedAt: new Date('2026-05-13T19:03:36.329Z')
      },
      {
        id: 'external-1',
        printerId: 'printer-1',
        taskId: 'task-idle',
        jobName: 'plate_4',
        printerFilePath: null,
        sourceType: 'external',
        fileId: null,
        thumbnailPath: null,
        startedAt: new Date('2026-05-13T19:04:20.829Z')
      }
    ].filter((row) => unfinishedJobIds.has(row.id))),
    configurable: true
  })
  Object.defineProperty(rootPrisma.printJob, 'findUnique', {
    value: async ({ where }: { where: { id: string } }) => {
      if (where.id !== 'library-1') return null
      return {
        startedAt: new Date('2026-05-13T19:03:36.329Z'),
        finishedAt: null,
        printerId: 'printer-1',
        jobName: 'Best Shot Golf - plate_4',
        taskId: 'task-idle',
        tenantId: 'tenant-1',
        sourceType: 'library',
        fileId: 'file-1',
        plate: 1
      }
    },
    configurable: true
  })
  Object.defineProperty(rootPrisma.printJob, 'update', {
    value: async (input: { where: { id: string }; data: Record<string, unknown> }) => {
      updates.push(input)
      unfinishedJobIds.delete(input.where.id)
      return { id: input.where.id }
    },
    configurable: true
  })
  Object.defineProperty(rootPrisma.printJob, 'updateMany', {
    value: async (input: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      updateManyCalls.push(input)
      const ids = ((input.where.id as { in?: string[] } | undefined)?.in) ?? []
      for (const id of ids) unfinishedJobIds.delete(id)
      return { count: 1 }
    },
    configurable: true
  })
  mock.method(printerManager, 'getPrinter', () => null)

  startPrintJobRecorder()
  printerEvents.emit('status', {
    printerId: 'printer-1',
    taskId: 'task-idle',
    online: true,
    stage: 'idle',
    progressPercent: 42
  } as never)

  await waitForAssertion(() => {
    assert.equal(updateManyCalls.length, 1)
  })

  assert.equal(updates.length, 1)
  assert.equal(updates[0]?.where.id, 'library-1')
  assert.equal(updates[0]?.data.result, 'unknown')
  assert.deepEqual(updateManyCalls[0]?.where, { id: { in: ['external-1'] } })
  assert.equal(updateManyCalls[0]?.data.result, 'unknown')
})

test('upsertTrackedPrintJobRecord creates a persistent unfinished row for a dispatch-started print', async () => {
  const creates: Array<Record<string, unknown>> = []

  Object.defineProperty(rootPrisma.printer, 'findUnique', {
    value: async () => ({ tenantId: 'tenant-1' }),
    configurable: true
  })
  Object.defineProperty(rootPrisma.printJob, 'findUnique', {
    value: async () => null,
    configurable: true
  })
  Object.defineProperty(rootPrisma.printJob, 'create', {
    value: async ({ data }: { data: Record<string, unknown> }) => {
      creates.push(data)
      return {
        id: String(data.id ?? 'job-1'),
        jobName: String(data.jobName ?? '')
      }
    },
    configurable: true
  })

  await upsertTrackedPrintJobRecord({
    jobId: 'dispatch-1',
    printerId: 'printer-1',
    jobName: 'Queued print',
    metadata: {
      jobKind: 'file',
      jobId: 'dispatch-1',
      fileId: 'file-1',
      fileName: 'Queued print.3mf',
      fileSizeBytes: 1024,
      sourceKind: '3mf',
      plate: 1,
      useAms: true,
      bedLevel: true,
      amsMapping: [0],
      calibrationOption: null
    }
  })

  assert.equal(creates.length, 1)
  assert.equal(creates[0]?.id, 'dispatch-1')
  assert.equal(creates[0]?.jobName, 'Queued print')
  assert.equal(creates[0]?.result, 'unknown')
  assert.equal(creates[0]?.fileId, 'file-1')
})

test('cancelTrackedPrintJobRecord clears matching pending dispatch metadata and closes the unfinished row', async () => {
  const updates: Array<{ where: { id: string }; data: Record<string, unknown> }> = []
  let findUniqueCalls = 0

  registerPendingPrintJobSource('printer-1', {
    jobKind: 'file',
    jobId: 'dispatch-1',
    fileId: 'file-1',
    fileName: 'Queued print.3mf',
    fileSizeBytes: 1024,
    sourceKind: '3mf',
    plate: 1,
    useAms: true,
    bedLevel: true,
    amsMapping: [0],
    calibrationOption: null
  })

  Object.defineProperty(rootPrisma.printJob, 'findUnique', {
    value: async () => {
      findUniqueCalls += 1
      if (findUniqueCalls === 1) return { id: 'dispatch-1' }
      return { startedAt: new Date('2026-05-03T10:00:00.000Z'), finishedAt: null }
    },
    configurable: true
  })
  Object.defineProperty(rootPrisma.printJob, 'update', {
    value: async (input: { where: { id: string }; data: Record<string, unknown> }) => {
      updates.push(input)
      return { id: input.where.id }
    },
    configurable: true
  })

  await cancelTrackedPrintJobRecord({
    printerId: 'printer-1',
    jobId: 'dispatch-1'
  })

  assert.equal(peekPendingPrintJobSource('printer-1'), null)
  assert.equal(updates.length, 1)
  assert.equal(updates[0]?.where.id, 'dispatch-1')
  assert.equal(updates[0]?.data.result, 'cancelled')
  assert.ok(updates[0]?.data.finishedAt instanceof Date)
})

test('cancelTrackedPrintJobRecord creates and closes a cancelled history row when the dispatch never persisted an unfinished row', async () => {
  const creates: Array<Record<string, unknown>> = []
  const updates: Array<{ where: { id: string }; data: Record<string, unknown> }> = []
  let findUniqueCalls = 0

  Object.defineProperty(rootPrisma.printer, 'findUnique', {
    value: async () => ({ tenantId: 'tenant-1' }),
    configurable: true
  })
  Object.defineProperty(rootPrisma.printJob, 'findUnique', {
    value: async () => {
      findUniqueCalls += 1
      if (findUniqueCalls === 1) return null
      return { startedAt: new Date('2026-05-03T10:00:00.000Z'), finishedAt: null, printerId: 'printer-1', jobName: 'Queued print' }
    },
    configurable: true
  })
  Object.defineProperty(rootPrisma.printJob, 'create', {
    value: async ({ data }: { data: Record<string, unknown> }) => {
      creates.push(data)
      return { id: String(data.id ?? 'dispatch-1'), jobName: String(data.jobName ?? '') }
    },
    configurable: true
  })
  Object.defineProperty(rootPrisma.printJob, 'update', {
    value: async (input: { where: { id: string }; data: Record<string, unknown> }) => {
      updates.push(input)
      return { id: input.where.id }
    },
    configurable: true
  })

  await cancelTrackedPrintJobRecord({
    printerId: 'printer-1',
    jobId: 'dispatch-1',
    jobName: 'Queued print',
    startedAt: new Date('2026-05-03T10:00:00.000Z'),
    metadata: {
      jobKind: 'file',
      jobId: 'dispatch-1',
      fileId: 'file-1',
      fileName: 'Queued print.3mf',
      fileSizeBytes: 1024,
      sourceKind: '3mf',
      plate: 1,
      useAms: true,
      bedLevel: true,
      amsMapping: [0],
      calibrationOption: null
    }
  })

  assert.equal(creates.length, 1)
  assert.equal(creates[0]?.id, 'dispatch-1')
  assert.equal(creates[0]?.result, 'unknown')
  assert.equal(updates.length, 1)
  assert.equal(updates[0]?.where.id, 'dispatch-1')
  assert.equal(updates[0]?.data.result, 'cancelled')
})