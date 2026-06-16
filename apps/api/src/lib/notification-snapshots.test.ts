process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { afterEach, mock, test } from 'node:test'
import type { Printer, PrinterStatus } from '@printstream/shared'

const { printerEvents } = await import('./printer-events.js')
const printerManagerModule = await import('./printer-manager.js')

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
})

const parkedHeadTerminalBedDropGcode = [
  '; MACHINE_END_GCODE_START',
  'M400 ; wait for buffer to clear',
  'G92 E0 ; zero the extruder',
  'G1 E-0.8 F1800 ; retract',
  'G1 Z1.1 F900 ; lower z a little',
  'G1 X65 Y245 F12000 ; move to safe pos',
  'G1 Y265 F3000',
  'M140 S0',
  'M104 S0',
  'M400 ; wait all motion done',
  'M17 S',
  'M17 Z0.4 ; lower z motor current',
  'G1 Z100.6 F600',
  'G1 Z98.6',
  'M73 P100 R0'
].join('\n')

const simpleFinishGcode = [
  '; MACHINE_END_GCODE_START',
  'M400',
  'G1 E-0.8 F1800',
  'G1 X65 Y245 F12000',
  'G1 Y265 F3000',
  'M140 S0',
  'M104 S0',
  'M73 P100 R0'
].join('\n')

test('pre-captures when printing advances past the final layer before job.finished', async () => {
  const snapshotsModule = await import(`./notification-snapshots.js?late-final=${Date.now()}`)

  mock.method(printerManagerModule.printerManager, 'getPrinter', () => printer)
  let fetchCalls = 0
  snapshotsModule.setNotificationSnapshotFetcherForTests(async () => {
    fetchCalls += 1
    return Buffer.from(`snapshot-${fetchCalls}`)
  })

  snapshotsModule.startNotificationSnapshotPrecapture()
  try {
    printerEvents.emit('status', makeStatus({ progressPercent: 96, currentLayer: 8, totalLayers: 10, remainingMinutes: 4, subStage: '6' }))
    await flushAsyncWork()
    assert.equal(fetchCalls, 0)

    printerEvents.emit('status', makeStatus({ progressPercent: 98, currentLayer: 10, totalLayers: 10, remainingMinutes: 1, subStage: '7' }))
    await flushAsyncWork()
    assert.equal(fetchCalls, 1)

    printerEvents.emit('status', makeStatus({ progressPercent: 99, currentLayer: 10, totalLayers: 10, remainingMinutes: 1, subStage: '8' }))
    await flushAsyncWork()
    assert.equal(fetchCalls, 2)

    const buffer = snapshotsModule.getPrecapturedSnapshot(printer.id)
    assert.deepEqual(buffer, Buffer.from('snapshot-2'))
  } finally {
    snapshotsModule.stopNotificationSnapshotPrecapture()
    snapshotsModule.setNotificationSnapshotFetcherForTests(null)
  }
})

test('captures on the first final-layer status that reports 100% while still printing', async () => {
  const snapshotsModule = await import(`./notification-snapshots.js?final-progress=${Date.now()}`)

  mock.method(printerManagerModule.printerManager, 'getPrinter', () => printer)
  let fetchCalls = 0
  snapshotsModule.setNotificationSnapshotFetcherForTests(async () => {
    fetchCalls += 1
    return Buffer.from(`snapshot-${fetchCalls}`)
  })

  snapshotsModule.startNotificationSnapshotPrecapture()
  try {
    printerEvents.emit('status', makeStatus({ progressPercent: 100, currentLayer: 10, totalLayers: 10, remainingMinutes: 1, subStage: '7' }))
    await flushAsyncWork()
    assert.equal(fetchCalls, 1)

    const buffer = snapshotsModule.getPrecapturedSnapshot(printer.id)
    assert.deepEqual(buffer, Buffer.from('snapshot-1'))
  } finally {
    snapshotsModule.stopNotificationSnapshotPrecapture()
    snapshotsModule.setNotificationSnapshotFetcherForTests(null)
  }
})

test('preserves the late final-layer snapshot when finish gcode parks before the terminal bed drop', async () => {
  const snapshotsModule = await import(`./notification-snapshots.js?preserve-late=${Date.now()}`)

  mock.method(printerManagerModule.printerManager, 'getPrinter', () => printer)
  snapshotsModule.setNotificationSnapshotFinishGcodeDepsForTests({
    getActivePrintJobAssets: async () => ({
      jobId: 'job-1',
      jobName: 'Calibration cube',
      plate: 1,
      printerFilePath: null,
      thumbnailPath: null,
      localSourcePath: '/tmp/print.3mf'
    }),
    readEntry: async () => Buffer.from(parkedHeadTerminalBedDropGcode)
  })

  let fetchCalls = 0
  snapshotsModule.setNotificationSnapshotFetcherForTests(async () => {
    fetchCalls += 1
    return Buffer.from(`snapshot-${fetchCalls}`)
  })

  snapshotsModule.startNotificationSnapshotPrecapture()
  try {
    printerEvents.emit('status', makeStatus({ progressPercent: 98, currentLayer: 10, totalLayers: 10, remainingMinutes: 1, subStage: '7', taskId: 'task-1' }))
    await flushAsyncWork()
    assert.equal(fetchCalls, 1)

    printerEvents.emit('status', makeStatus({ progressPercent: 99, currentLayer: 10, totalLayers: 10, remainingMinutes: 1, subStage: '8', taskId: 'task-1' }))
    await flushAsyncWork()
    assert.equal(fetchCalls, 2)

    printerEvents.emit('job.finished', { printer, jobName: 'Calibration cube', result: 'success' })
    await flushAsyncWork()
    assert.equal(fetchCalls, 2)

    const buffer = snapshotsModule.getPrecapturedSnapshot(printer.id)
    assert.deepEqual(buffer, Buffer.from('snapshot-2'))
  } finally {
    snapshotsModule.stopNotificationSnapshotPrecapture()
    snapshotsModule.setNotificationSnapshotFetcherForTests(null)
    snapshotsModule.setNotificationSnapshotFinishGcodeDepsForTests(null)
  }
})

test('job.finished still refreshes the snapshot when finish gcode lacks a parked-head terminal bed drop', async () => {
  const snapshotsModule = await import(`./notification-snapshots.js?refresh-late=${Date.now()}`)

  mock.method(printerManagerModule.printerManager, 'getPrinter', () => printer)
  snapshotsModule.setNotificationSnapshotFinishGcodeDepsForTests({
    getActivePrintJobAssets: async () => ({
      jobId: 'job-1',
      jobName: 'Calibration cube',
      plate: 1,
      printerFilePath: null,
      thumbnailPath: null,
      localSourcePath: '/tmp/print.3mf'
    }),
    readEntry: async () => Buffer.from(simpleFinishGcode)
  })

  let fetchCalls = 0
  snapshotsModule.setNotificationSnapshotFetcherForTests(async () => {
    fetchCalls += 1
    return Buffer.from(`snapshot-${fetchCalls}`)
  })

  snapshotsModule.startNotificationSnapshotPrecapture()
  try {
    printerEvents.emit('status', makeStatus({ progressPercent: 98, currentLayer: 10, totalLayers: 10, remainingMinutes: 1, subStage: '7', taskId: 'task-1' }))
    await flushAsyncWork()
    assert.equal(fetchCalls, 1)

    printerEvents.emit('status', makeStatus({ progressPercent: 99, currentLayer: 10, totalLayers: 10, remainingMinutes: 1, subStage: '8', taskId: 'task-1' }))
    await flushAsyncWork()
    assert.equal(fetchCalls, 2)

    printerEvents.emit('job.finished', { printer, jobName: 'Calibration cube', result: 'success' })
    await flushAsyncWork()
    assert.equal(fetchCalls, 3)

    const buffer = snapshotsModule.getPrecapturedSnapshot(printer.id)
    assert.deepEqual(buffer, Buffer.from('snapshot-3'))
  } finally {
    snapshotsModule.stopNotificationSnapshotPrecapture()
    snapshotsModule.setNotificationSnapshotFetcherForTests(null)
    snapshotsModule.setNotificationSnapshotFinishGcodeDepsForTests(null)
  }
})

test('preserves the late final-layer snapshot for external prints when finish gcode is available from the printer archive', async () => {
  const snapshotsModule = await import(`./notification-snapshots.js?external-printer-archive=${Date.now()}`)

  mock.method(printerManagerModule.printerManager, 'getPrinter', () => printer)
  snapshotsModule.setNotificationSnapshotFinishGcodeDepsForTests({
    getActivePrintJobAssets: async () => ({
      jobId: 'job-external',
      jobName: 'External cube',
      plate: 1,
      printerFilePath: '/cache/External Cube.gcode.3mf',
      thumbnailPath: null,
      localSourcePath: null
    }),
    readEntry: async () => {
      throw new Error('external printer archive flow should not read a local file')
    },
    readPrinterZipEntries: async (_printer: Printer, remotePath: string, entryPaths: string[]) => {
      assert.equal(remotePath, '/cache/External Cube.gcode.3mf')
      assert.deepEqual(entryPaths, ['Metadata/plate_1.gcode'])
      return new Map([[entryPaths[0]!, Buffer.from(parkedHeadTerminalBedDropGcode)]])
    }
  })

  let fetchCalls = 0
  snapshotsModule.setNotificationSnapshotFetcherForTests(async () => {
    fetchCalls += 1
    return Buffer.from(`snapshot-${fetchCalls}`)
  })

  snapshotsModule.startNotificationSnapshotPrecapture()
  try {
    printerEvents.emit('status', makeStatus({ progressPercent: 98, currentLayer: 10, totalLayers: 10, remainingMinutes: 1, subStage: '7', taskId: 'task-external' }))
    await flushAsyncWork()
    assert.equal(fetchCalls, 1)

    printerEvents.emit('status', makeStatus({ progressPercent: 99, currentLayer: 10, totalLayers: 10, remainingMinutes: 1, subStage: '8', taskId: 'task-external' }))
    await flushAsyncWork()
    assert.equal(fetchCalls, 2)

    printerEvents.emit('job.finished', { printer, jobName: 'External cube', result: 'success' })
    await flushAsyncWork()
    assert.equal(fetchCalls, 2)

    const buffer = snapshotsModule.getPrecapturedSnapshot(printer.id)
    assert.deepEqual(buffer, Buffer.from('snapshot-2'))
  } finally {
    snapshotsModule.stopNotificationSnapshotPrecapture()
    snapshotsModule.setNotificationSnapshotFetcherForTests(null)
    snapshotsModule.setNotificationSnapshotFinishGcodeDepsForTests(null)
  }
})

function makeStatus(overrides: Partial<PrinterStatus>): PrinterStatus {
  return {
    printerId: printer.id,
    online: true,
    stage: 'printing',
    subStage: '1',
    filamentChange: {
      currentStepIndex: null,
      currentStepLabel: null,
      steps: []
    },
    progressPercent: 0,
    currentLayer: 1,
    totalLayers: 10,
    remainingMinutes: 10,
    jobId: null,
    jobName: 'Calibration cube',
    lastJobName: 'Calibration cube',
    gcodeFile: 'Metadata/plate_1.gcode',
    bedTemp: null,
    bedTarget: null,
    nozzleTemp: null,
    nozzleTarget: null,
    nozzles: [],
    chamberTemp: null,
    chamberTarget: null,
    fanGearSpeed: null,
    partFanPercent: null,
    auxFanPercent: null,
    chamberFanPercent: null,
    wifiSignalDbm: null,
    ipAddress: null,
    doorOpen: null,
    ductMode: null,
    ductAvailableModes: [],
    lightModes: {
      chamber: null,
      heatbed: null,
      work: null
    },
    lightCapabilities: {
      chamber: false,
      heatbed: false,
      work: false
    },
    chamberLightOffRequiresConfirm: false,
    lightOn: null,
    speedLevel: null,
    commandTransport: {
      mqttBedTemperature: false,
      mqttAxisControl: false,
      mqttHoming: false,
      newFanControl: false
    },
    printOptions: {
      aiMonitoring: { supported: false, enabled: null, sensitivity: null },
      spaghettiDetection: { supported: false, enabled: null, sensitivity: null },
      purgeChutePileupDetection: { supported: false, enabled: null, sensitivity: null },
      nozzleClumpingDetection: { supported: false, enabled: null, sensitivity: null },
      airPrintingDetection: { supported: false, enabled: null, sensitivity: null },
      firstLayerInspection: { supported: false, enabled: null },
      autoRecovery: { supported: false, enabled: null },
      promptSound: { supported: false, enabled: null },
      filamentTangleDetection: { supported: false, enabled: null }
    },
    deviceError: null,
    hmsErrors: [],
    amsSettings: {
      detectOnInsert: null,
      detectOnPowerup: null,
      remainEnabled: null,
      autoRefill: null,
      supportFilamentBackup: null
    },
    ams: [],
    externalSpools: [],
    firmwareVersion: null,
    sdCardPresent: true,
    connectionWarnings: [],
    observedAt: new Date().toISOString(),
    ...overrides,
    taskId: overrides.taskId ?? null
  }
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise<void>((resolve) => setImmediate(resolve))
}