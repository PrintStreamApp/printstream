process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { afterEach, mock, test } from 'node:test'
import type { Printer } from '@printstream/shared'

const { printerEvents } = await import('./printer-events.js')
const printerManagerModule = await import('./printer-manager.js')
const activePrintObjectsModule = await import('./active-print-objects.js')

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
  activePrintObjectsModule.startActivePrintObjectCache()
  activePrintObjectsModule.stopActivePrintObjectCache()
  activePrintObjectsModule.setActivePrintObjectDepsForTests(null)
  activePrintObjectsModule.setActivePrintObjectPreloadTimeoutMsForTests(null)
  mock.restoreAll()
  mock.timers.reset()
})

test('job-start preload waits before reading printer storage', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })

  let getPrinterCalls = 0
  mock.method(printerManagerModule.printerManager, 'getPrinter', () => {
    getPrinterCalls += 1
    return printer
  })
  activePrintObjectsModule.setActivePrintObjectDepsForTests({
    getActivePrintJobAssets: async () => null,
    resolvePrinterArchivePath: async () => null,
    readPrinterStorageActivePrintObjectsFromMetadata: async () => [],
    getDispatchedPrintSource: async () => null,
    readPlateObjectsWithPreview: async () => [],
    readPrinterStorageActivePrintObjects: async () => []
  })

  activePrintObjectsModule.startActivePrintObjectCache()
  printerEvents.emit('job.started', { printer, jobName: 'Job 1' })

  await Promise.resolve()
  assert.equal(getPrinterCalls, 0)

  mock.timers.tick(9_000)
  await Promise.resolve()
  assert.equal(getPrinterCalls, 0)

  mock.timers.tick(1_500)
  await Promise.resolve()
  assert.ok(getPrinterCalls > 0)
})

test('job-finished clears a pending preload before it starts', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })

  let getPrinterCalls = 0
  mock.method(printerManagerModule.printerManager, 'getPrinter', () => {
    getPrinterCalls += 1
    return printer
  })

  activePrintObjectsModule.startActivePrintObjectCache()
  printerEvents.emit('job.started', { printer, jobName: 'Job 1' })
  printerEvents.emit('job.finished', { printer, jobName: 'Job 1', result: 'cancelled' })

  mock.timers.tick(12_000)
  await Promise.resolve()
  assert.equal(getPrinterCalls, 0)
})

test('fetchActivePrintObjects prefers live printer Metadata before local or archive sources', async () => {
  const directObjects = [{ id: 7, name: 'Bracket', previewPath: 'M 0 0 Z', previewBounds: null }]
  let dispatchedSourceCalls = 0
  let localObjectCalls = 0

  mock.method(printerManagerModule.printerManager, 'getPrinter', () => printer)
  mock.method(printerManagerModule.printerManager, 'getStatus', () => ({
    jobName: 'Job 1',
    gcodeFile: '/data/Metadata/plate_1.gcode',
    taskId: 'task-1'
  }))
  mock.method(printerManagerModule.printerManager, 'getLastJobName', () => 'Job 1')

  activePrintObjectsModule.setActivePrintObjectDepsForTests({
    getActivePrintJobAssets: async () => null,
    readPrinterStorageActivePrintObjectsFromMetadata: async () => directObjects,
    getDispatchedPrintSource: async () => {
      dispatchedSourceCalls += 1
      return '/tmp/source.3mf'
    },
    readPlateObjectsWithPreview: async () => {
      localObjectCalls += 1
      return []
    }
  })

  const objects = await activePrintObjectsModule.fetchActivePrintObjects(printer.id, {
    jobName: 'Job 1',
    gcodeFile: '/data/Metadata/plate_1.gcode',
    taskId: 'task-1'
  })

  assert.deepEqual(objects, directObjects)
  assert.equal(dispatchedSourceCalls, 0)
  assert.equal(localObjectCalls, 0)
})

test('fetchActivePrintObjects returns no objects when direct metadata and tracked local assets are unavailable', async () => {
  let dispatchedSourceCalls = 0
  let localObjectCalls = 0

  mock.method(printerManagerModule.printerManager, 'getPrinter', () => printer)
  mock.method(printerManagerModule.printerManager, 'getStatus', () => ({
    jobName: 'Job 1',
    gcodeFile: '/data/Metadata/plate_1.gcode',
    taskId: 'task-1'
  }))
  mock.method(printerManagerModule.printerManager, 'getLastJobName', () => 'Job 1')

  activePrintObjectsModule.setActivePrintObjectDepsForTests({
    getActivePrintJobAssets: async () => null,
    readPrinterStorageActivePrintObjectsFromMetadata: async () => null,
    getDispatchedPrintSource: async () => {
      dispatchedSourceCalls += 1
      return null
    },
    readPlateObjectsWithPreview: async () => {
      localObjectCalls += 1
      return []
    }
  })

  const objects = await activePrintObjectsModule.fetchActivePrintObjects(printer.id, {
    jobName: 'Job 1',
    gcodeFile: '/data/Metadata/plate_1.gcode',
    taskId: 'task-1'
  })

  assert.deepEqual(objects, [])
  assert.equal(dispatchedSourceCalls, 1)
  assert.equal(localObjectCalls, 0)
})

test('fetchActivePrintObjects returns placeholder objects for demo printers when extraction yields nothing', async () => {
  const demoPrinter = {
    ...printer,
    serial: 'DEMO-P1S-001'
  }

  mock.method(printerManagerModule.printerManager, 'getPrinter', () => demoPrinter)
  mock.method(printerManagerModule.printerManager, 'getStatus', () => ({
    jobName: 'Demo Job',
    gcodeFile: '/data/Metadata/plate_2.gcode',
    taskId: 'task-demo'
  }))
  mock.method(printerManagerModule.printerManager, 'getLastJobName', () => 'Demo Job')

  activePrintObjectsModule.setActivePrintObjectDepsForTests({
    getActivePrintJobAssets: async () => null,
    readPrinterStorageActivePrintObjectsFromMetadata: async () => null,
    getDispatchedPrintSource: async () => null,
    readPlateObjectsWithPreview: async () => []
  })

  const objects = await activePrintObjectsModule.fetchActivePrintObjects(demoPrinter.id, {
    jobName: 'Demo Job',
    gcodeFile: '/data/Metadata/plate_2.gcode',
    taskId: 'task-demo'
  })

  assert.equal(objects.length > 0, true)
  assert.equal(objects[0]?.name, 'Object 1')
  assert.match(objects[0]?.previewPath ?? '', /^M /)
})

test('fetchActivePrintObjects falls back to the authoritative live archive path when the printer reports one', async () => {
  const archiveObjects = [{ id: 7, name: 'Bracket', previewPath: 'M 0 0 Z', previewBounds: null }]
  let dispatchedSourceCalls = 0
  let localObjectCalls = 0

  mock.method(printerManagerModule.printerManager, 'getPrinter', () => printer)
  mock.method(printerManagerModule.printerManager, 'getStatus', () => ({
    jobName: 'Job 1',
    gcodeFile: '/cache/Current Print.gcode.3mf',
    taskId: 'task-1'
  }))
  mock.method(printerManagerModule.printerManager, 'getLastJobName', () => 'Job 1')

  activePrintObjectsModule.setActivePrintObjectDepsForTests({
    getActivePrintJobAssets: async () => null,
    readPrinterStorageActivePrintObjectsFromMetadata: async () => null,
    readPrinterStorageActivePrintObjects: async () => archiveObjects,
    getDispatchedPrintSource: async () => {
      dispatchedSourceCalls += 1
      return null
    },
    readPlateObjectsWithPreview: async () => {
      localObjectCalls += 1
      return []
    }
  })

  const objects = await activePrintObjectsModule.fetchActivePrintObjects(printer.id, {
    jobName: 'Job 1',
    gcodeFile: '/cache/Current Print.gcode.3mf',
    taskId: 'task-1'
  })

  assert.deepEqual(objects, archiveObjects)
  assert.equal(dispatchedSourceCalls, 1)
  assert.equal(localObjectCalls, 0)
})

test('fetchActivePrintObjects caches completed empty results for the current job', async () => {
  mock.method(printerManagerModule.printerManager, 'getPrinter', () => printer)
  mock.method(printerManagerModule.printerManager, 'getStatus', () => ({
    jobName: 'Job 1',
    gcodeFile: '/data/Metadata/plate_1.gcode',
    taskId: 'task-1'
  }))
  mock.method(printerManagerModule.printerManager, 'getLastJobName', () => 'Job 1')

  activePrintObjectsModule.setActivePrintObjectDepsForTests({
    getActivePrintJobAssets: async () => null,
    readPrinterStorageActivePrintObjectsFromMetadata: async () => [],
    getDispatchedPrintSource: async () => null,
    readPlateObjectsWithPreview: async () => []
  })

  const objects = await activePrintObjectsModule.fetchActivePrintObjects(printer.id, {
    jobName: 'Job 1',
    gcodeFile: '/data/Metadata/plate_1.gcode',
    taskId: 'task-1'
  })

  assert.deepEqual(objects, [])
  assert.deepEqual(
    activePrintObjectsModule.getCachedActivePrintObjects(printer.id, 'Job 1', '/data/Metadata/plate_1.gcode', 'task-1'),
    []
  )
})

test('fetchActivePrintObjects caches an empty result when the preload times out', async () => {
  mock.method(printerManagerModule.printerManager, 'getPrinter', () => printer)
  mock.method(printerManagerModule.printerManager, 'getStatus', () => ({
    jobName: 'Job 1',
    gcodeFile: '/data/Metadata/plate_1.gcode',
    taskId: 'task-1'
  }))
  mock.method(printerManagerModule.printerManager, 'getLastJobName', () => 'Job 1')
  activePrintObjectsModule.setActivePrintObjectPreloadTimeoutMsForTests(5)

  activePrintObjectsModule.setActivePrintObjectDepsForTests({
    getActivePrintJobAssets: async () => null,
    readPrinterStorageActivePrintObjectsFromMetadata: async (_printer, options) => {
      await new Promise((_, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted', 'AbortError')), { once: true })
      })
      return null
    },
    getDispatchedPrintSource: async () => null,
    readPlateObjectsWithPreview: async () => []
  })

  const objectsPromise = activePrintObjectsModule.fetchActivePrintObjects(printer.id, {
    jobName: 'Job 1',
    gcodeFile: '/data/Metadata/plate_1.gcode',
    taskId: 'task-1'
  })

  const objects = await objectsPromise

  assert.deepEqual(objects, [])
  assert.deepEqual(
    activePrintObjectsModule.getCachedActivePrintObjects(printer.id, 'Job 1', '/data/Metadata/plate_1.gcode', 'task-1'),
    []
  )
})

test('fetchActivePrintObjects keeps going to the local 3MF source when metadata is empty and the live archive is unavailable', async () => {
  const localObjects = [{ id: 8, name: 'Handle', previewPath: 'M 0 0 Z', previewBounds: null }]
  let archiveCalls = 0

  mock.method(printerManagerModule.printerManager, 'getPrinter', () => printer)
  mock.method(printerManagerModule.printerManager, 'getStatus', () => ({
    jobName: 'Job 1',
    gcodeFile: '/cache/Current Print.gcode.3mf',
    taskId: 'task-1'
  }))
  mock.method(printerManagerModule.printerManager, 'getLastJobName', () => 'Job 1')

  activePrintObjectsModule.setActivePrintObjectDepsForTests({
    getActivePrintJobAssets: async () => ({
      jobId: 'job-1',
      jobName: 'Job 1',
      plate: 1,
      printerFilePath: '/cache/Current Print.gcode.3mf',
      thumbnailPath: null,
      localSourcePath: '/tmp/source.3mf'
    }),
    readPrinterStorageActivePrintObjectsFromMetadata: async () => [],
    readPrinterStorageActivePrintObjects: async () => {
      archiveCalls += 1
      return null
    },
    getDispatchedPrintSource: async () => null,
    readPlateObjectsWithPreview: async () => localObjects
  })

  const objects = await activePrintObjectsModule.fetchActivePrintObjects(printer.id, {
    jobName: 'Job 1',
    gcodeFile: '/cache/Current Print.gcode.3mf',
    taskId: 'task-1'
  })

  assert.deepEqual(objects, localObjects)
  assert.equal(archiveCalls, 0)
})

test('fetchActivePrintObjects falls back to the local 3MF source when the live archive read throws', async () => {
  const localObjects = [{ id: 9, name: 'Bracket', previewPath: 'M 0 0 Z', previewBounds: null }]

  mock.method(printerManagerModule.printerManager, 'getPrinter', () => printer)
  mock.method(printerManagerModule.printerManager, 'getStatus', () => ({
    jobName: 'Job 1',
    gcodeFile: '/cache/Current Print.gcode.3mf',
    taskId: 'task-1'
  }))
  mock.method(printerManagerModule.printerManager, 'getLastJobName', () => 'Job 1')

  activePrintObjectsModule.setActivePrintObjectDepsForTests({
    getActivePrintJobAssets: async () => ({
      jobId: 'job-1',
      jobName: 'Job 1',
      plate: 1,
      printerFilePath: '/cache/Current Print.gcode.3mf',
      thumbnailPath: null,
      localSourcePath: '/tmp/source.3mf'
    }),
    readPrinterStorageActivePrintObjectsFromMetadata: async () => null,
    readPrinterStorageActivePrintObjects: async () => {
      throw new Error('archive read timed out')
    },
    getDispatchedPrintSource: async () => null,
    readPlateObjectsWithPreview: async () => localObjects
  })

  const objects = await activePrintObjectsModule.fetchActivePrintObjects(printer.id, {
    jobName: 'Job 1',
    gcodeFile: '/cache/Current Print.gcode.3mf',
    taskId: 'task-1'
  })

  assert.deepEqual(objects, localObjects)
})

test('fetchActivePrintObjects prefers a persisted exact printer archive path over Metadata plate hints', async () => {
  const archiveObjects = [{ id: 9, name: 'Persisted archive', previewPath: 'M 0 0 Z', previewBounds: null }]
  const archiveReads: Array<{ printerPath: string; plateIndex: number | null }> = []

  mock.method(printerManagerModule.printerManager, 'getPrinter', () => printer)
  mock.method(printerManagerModule.printerManager, 'getStatus', () => ({
    jobName: 'Job 1',
    gcodeFile: '/data/Metadata/plate_1.gcode',
    taskId: 'task-1'
  }))
  mock.method(printerManagerModule.printerManager, 'getLastJobName', () => 'Job 1')

  activePrintObjectsModule.setActivePrintObjectDepsForTests({
    getActivePrintJobAssets: async () => ({
      jobId: 'job-1',
      jobName: 'Job 1',
      plate: 1,
      printerFilePath: '/cache/Current Print.gcode.3mf',
      thumbnailPath: null,
      localSourcePath: null
    }),
    readPrinterStorageActivePrintObjectsFromMetadata: async () => null,
    readPrinterStorageActivePrintObjects: async (_printer, printerPath, plateIndex) => {
      archiveReads.push({ printerPath, plateIndex })
      return archiveObjects
    },
    getDispatchedPrintSource: async () => null,
    readPlateObjectsWithPreview: async () => []
  })

  const objects = await activePrintObjectsModule.fetchActivePrintObjects(printer.id, {
    jobName: 'Job 1',
    gcodeFile: '/data/Metadata/plate_1.gcode',
    taskId: 'task-1'
  })

  assert.deepEqual(objects, archiveObjects)
  assert.deepEqual(archiveReads, [{ printerPath: '/cache/Current Print.gcode.3mf', plateIndex: 1 }])
})

test('fetchActivePrintObjects prefers the persisted active job plate over a stale Metadata plate hint', async () => {
  const localObjects = [{ id: 12, name: 'Card Holder plate 2', previewPath: 'M 0 0 Z', previewBounds: null }]
  const localReads: Array<{ filePath: string; plateIndex: number | null }> = []

  mock.method(printerManagerModule.printerManager, 'getPrinter', () => printer)
  mock.method(printerManagerModule.printerManager, 'getStatus', () => ({
    jobName: 'Card Holder (3 rows)',
    gcodeFile: '/data/Metadata/plate_1.gcode',
    taskId: 'task-plate-2'
  }))
  mock.method(printerManagerModule.printerManager, 'getLastJobName', () => 'Card Holder (3 rows)')

  activePrintObjectsModule.setActivePrintObjectDepsForTests({
    getActivePrintJobAssets: async () => ({
      jobId: 'job-plate-2',
      jobName: 'Card Holder (3 rows)',
      plate: 2,
      printerFilePath: null,
      thumbnailPath: null,
      localSourcePath: '/tmp/card-holder.3mf'
    }),
    readPrinterStorageActivePrintObjectsFromMetadata: async () => null,
    getDispatchedPrintSource: async () => null,
    readPlateObjectsWithPreview: async (filePath, plateIndex) => {
      localReads.push({ filePath, plateIndex })
      return localObjects
    },
    readPrinterStorageActivePrintObjects: async () => []
  })

  const objects = await activePrintObjectsModule.fetchActivePrintObjects(printer.id, {
    jobName: 'Card Holder (3 rows)',
    gcodeFile: '/data/Metadata/plate_1.gcode',
    taskId: 'task-plate-2'
  })

  assert.deepEqual(objects, localObjects)
  assert.deepEqual(localReads, [{ filePath: '/tmp/card-holder.3mf', plateIndex: 2 }])
})

test('fetchActivePrintObjects reads a persisted local source before resolving a printer archive path', async () => {
  const localObjects = [{ id: 13, name: 'Local object', previewPath: 'M 0 0 Z', previewBounds: null }]
  let resolveCalls = 0

  mock.method(printerManagerModule.printerManager, 'getPrinter', () => printer)
  mock.method(printerManagerModule.printerManager, 'getStatus', () => ({
    jobName: 'Card Holder',
    gcodeFile: '/data/Metadata/plate_1.gcode',
    taskId: 'task-local'
  }))
  mock.method(printerManagerModule.printerManager, 'getLastJobName', () => 'Card Holder')

  activePrintObjectsModule.setActivePrintObjectDepsForTests({
    getActivePrintJobAssets: async () => ({
      jobId: 'job-local',
      jobName: 'Card Holder',
      plate: 1,
      printerFilePath: null,
      thumbnailPath: null,
      localSourcePath: '/tmp/card-holder.3mf'
    }),
    resolvePrinterArchivePath: async () => {
      resolveCalls += 1
      return '/cache/card-holder.gcode.3mf'
    },
    readPrinterStorageActivePrintObjectsFromMetadata: async () => null,
    getDispatchedPrintSource: async () => null,
    readPlateObjectsWithPreview: async () => localObjects,
    readPrinterStorageActivePrintObjects: async () => []
  })

  const objects = await activePrintObjectsModule.fetchActivePrintObjects(printer.id, {
    jobName: 'Card Holder',
    gcodeFile: '/data/Metadata/plate_1.gcode',
    taskId: 'task-local'
  })

  assert.deepEqual(objects, localObjects)
  assert.equal(resolveCalls, 0)
})

test('fetchActivePrintObjects falls back to a matched printer archive path when only Metadata hints are available', async () => {
  const archiveObjects = [{ id: 11, name: 'Matched archive', previewPath: 'M 0 0 Z', previewBounds: null }]
  const archiveReads: Array<{ printerPath: string; plateIndex: number | null }> = []

  mock.method(printerManagerModule.printerManager, 'getPrinter', () => printer)
  mock.method(printerManagerModule.printerManager, 'getStatus', () => ({
    jobName: 'Best Shot Golf - plate_4',
    gcodeFile: '/data/Metadata/plate_4.gcode',
    taskId: 'task-1'
  }))
  mock.method(printerManagerModule.printerManager, 'getLastJobName', () => 'Best Shot Golf - plate_4')

  activePrintObjectsModule.setActivePrintObjectDepsForTests({
    getActivePrintJobAssets: async () => ({
      jobId: 'job-1',
      jobName: 'plate_4',
      plate: 4,
      printerFilePath: null,
      thumbnailPath: null,
      localSourcePath: null
    }),
    resolvePrinterArchivePath: async () => '/Best Shot Golf - plate_4.gcode.3mf',
    readPrinterStorageActivePrintObjectsFromMetadata: async () => null,
    readPrinterStorageActivePrintObjects: async (_printer, printerPath, plateIndex) => {
      archiveReads.push({ printerPath, plateIndex })
      return archiveObjects
    },
    getDispatchedPrintSource: async () => null,
    readPlateObjectsWithPreview: async () => []
  })

  const objects = await activePrintObjectsModule.fetchActivePrintObjects(printer.id, {
    jobName: 'Best Shot Golf - plate_4',
    gcodeFile: '/data/Metadata/plate_4.gcode',
    taskId: 'task-1'
  })

  assert.deepEqual(objects, archiveObjects)
  assert.deepEqual(archiveReads, [{ printerPath: '/Best Shot Golf - plate_4.gcode.3mf', plateIndex: 4 }])
})

test('fetchActivePrintObjects infers the selected plate from external printer job data when no metadata plate hint is stored', async () => {
  const archiveObjects = [{ id: 10, name: 'External archive', previewPath: 'M 0 0 Z', previewBounds: null }]
  const archiveReads: Array<{ printerPath: string; plateIndex: number | null }> = []

  mock.method(printerManagerModule.printerManager, 'getPrinter', () => printer)
  mock.method(printerManagerModule.printerManager, 'getStatus', () => ({
    jobName: 'CSM - Bambu - 2 - Mast, Feeders, Counter holder, Mount feet',
    gcodeFile: '/CSM - Bambu - 2 - Mast_ Feeders_ Counter holder_ Mount feet.gcode.3mf',
    taskId: 'task-1'
  }))
  mock.method(printerManagerModule.printerManager, 'getLastJobName', () => 'CSM - Bambu - 2 - Mast, Feeders, Counter holder, Mount feet')

  activePrintObjectsModule.setActivePrintObjectDepsForTests({
    getActivePrintJobAssets: async () => ({
      jobId: 'job-1',
      jobName: 'CSM - Bambu - 2 - Mast, Feeders, Counter holder, Mount feet',
      plate: null,
      printerFilePath: '/CSM - Bambu - 2 - Mast_ Feeders_ Counter holder_ Mount feet.gcode.3mf',
      thumbnailPath: null,
      localSourcePath: null
    }),
    readPrinterStorageActivePrintObjectsFromMetadata: async () => null,
    readPrinterStorageActivePrintObjects: async (_printer, printerPath, plateIndex) => {
      archiveReads.push({ printerPath, plateIndex })
      return archiveObjects
    },
    getDispatchedPrintSource: async () => null,
    readPlateObjectsWithPreview: async () => []
  })

  const objects = await activePrintObjectsModule.fetchActivePrintObjects(printer.id, {
    jobName: 'CSM - Bambu - 2 - Mast, Feeders, Counter holder, Mount feet',
    gcodeFile: '/CSM - Bambu - 2 - Mast_ Feeders_ Counter holder_ Mount feet.gcode.3mf',
    taskId: 'task-1'
  })

  assert.deepEqual(objects, archiveObjects)
  assert.deepEqual(archiveReads, [{ printerPath: '/CSM - Bambu - 2 - Mast_ Feeders_ Counter holder_ Mount feet.gcode.3mf', plateIndex: 2 }])
})

test('inferActivePrintObjectsUnavailableState flags known internal-storage-only metadata paths on affected models', () => {
  const unavailableState = activePrintObjectsModule.inferActivePrintObjectsUnavailableState(
    { model: 'H2D' },
    '/data/Metadata/plate_1.gcode',
    []
  )

  assert.deepEqual(unavailableState, {
    unavailableReason: 'internalStorageUnsupported',
    unavailableMessage: 'This printer is only exposing the active job through internal metadata. PrintStream cannot read skippable objects from that proprietary path yet. If the printer supports it, enable Store Sent Files on External Storage for more reliable skip-object loading.'
  })
})

test('inferActivePrintObjectsUnavailableState stays generic for archive-backed paths', () => {
  const unavailableState = activePrintObjectsModule.inferActivePrintObjectsUnavailableState(
    { model: 'H2D' },
    '/cache/Current Print.gcode.3mf',
    []
  )

  assert.equal(unavailableState, null)
})