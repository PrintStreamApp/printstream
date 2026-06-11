import assert from 'node:assert/strict'
import { afterEach, mock, test } from 'node:test'
import { startCalibrationJob } from './calibration-jobs.js'
import { rootPrisma } from './prisma.js'
import { restorePrismaMethodsAfterEach } from '../test-utils/prisma-stubs.js'
import { consumePendingPrintJobSource, clearAllPendingPrintJobSources } from './pending-print-job-source.js'
import { printerEvents } from './printer-events.js'
import { printerManager } from './printer-manager.js'

restorePrismaMethodsAfterEach([
  [rootPrisma.printJob, 'findUnique'],
  [rootPrisma.printJob, 'create'],
  [rootPrisma.printer, 'findUnique']
])

afterEach(() => {
  clearAllPendingPrintJobSources()
  mock.restoreAll()
})

test('startCalibrationJob registers pending history metadata and emits an internal start marker', async () => {
  const dispatchEvents: Array<{ printerId: string; jobId: string; taskId: string | null; fileName: string }> = []
  const onDispatchStarting = (event: { printerId: string; jobId: string; taskId: string | null; fileName: string }) => {
    dispatchEvents.push(event)
  }
  printerEvents.on('print.job.starting', onDispatchStarting)
  mock.method(printerManager, 'publishCommand', () => true)
  Object.defineProperty(rootPrisma.printer, 'findUnique', {
    value: async () => ({ tenantId: 'tenant-1' }),
    configurable: true
  })
  Object.defineProperty(rootPrisma.printJob, 'findUnique', {
    value: async () => null,
    configurable: true
  })
  Object.defineProperty(rootPrisma.printJob, 'create', {
    value: async ({ data }: { data: Record<string, unknown> }) => ({
      id: String(data.id ?? 'job-1'),
      jobName: String(data.jobName ?? '')
    }),
    configurable: true
  })

  try {
    const startedJobId = await startCalibrationJob({
      printerId: 'printer-1',
      printerName: 'Demo printer',
      option: (1 << 1) | (1 << 2)
    })
    assert.notEqual(startedJobId, null)
    assert.equal(dispatchEvents.length, 1)
    assert.equal(dispatchEvents[0]?.printerId, 'printer-1')
    assert.equal(dispatchEvents[0]?.taskId, dispatchEvents[0]?.jobId ?? null)
    assert.equal(dispatchEvents[0]?.fileName, 'Calibration')
    assert.deepEqual(consumePendingPrintJobSource('printer-1'), {
      jobKind: 'calibration',
      jobId: dispatchEvents[0]?.jobId ?? null,
      taskId: dispatchEvents[0]?.jobId ?? null,
      fileId: null,
      fileName: null,
      fileSizeBytes: null,
      sourceKind: null,
      plate: null,
      useAms: null,
      bedLevel: null,
      amsMapping: null,
      calibrationOption: (1 << 1) | (1 << 2)
    })
  } finally {
    printerEvents.off('print.job.starting', onDispatchStarting)
  }
})