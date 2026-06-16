import assert from 'node:assert/strict'
import test from 'node:test'
import { HttpError } from './http-error.js'
import { rootPrisma } from './prisma.js'
import { printDispatcher, getRemotePrintTarget, prunePlateAmsMapping, sanitizeRemoteName, buildProjectFilePrintCommand } from './print-dispatcher.js'
import { usePrismaStubs } from '../test-utils/prisma-stubs.js'

const stubPrisma = usePrismaStubs()

type DispatchJobStateFixture = {
  id: string
  tenantId: string
  printerId: string
  printerName: string
  fileId: string
  fileName: string
  jobName: string
  plateName: string | null
  fileSizeBytes: number
  sourceKind: '3mf' | 'gcode'
  projectFilamentChips: Array<{ label: string; color: string | null }>
  localPath: string | null
  bridgeLibraryPath: string | null
  remoteName: string
  options: {
    useAms: boolean
    bedLevel: 'on' | 'off' | 'auto'
    vibrationCompensation: boolean
    flowCalibration: 'on' | 'off' | 'auto'
    firstLayerInspection: boolean
    timelapse: boolean
    filamentDynamicsCalibration: boolean
    nozzleOffsetCalibration: 'on' | 'off' | 'auto'
    allowIncompatibleFilament: boolean
    allowPlateTypeMismatch: boolean
    currentPlateType: string | null
    currentNozzleDiameters: number[]
    plate: number
    amsMapping: number[] | null
  }
  status: 'queued' | 'uploading' | 'sent' | 'cancelled' | 'failed'
  progressMessage: string
  uploadAttempt: number
  uploadMaxAttempts: number
  uploadBytesSent: number
  uploadTotalBytes: number | null
  uploadPercent: number | null
  error: string | null
  createdAt: Date
  updatedAt: Date
  startedAt: Date | null
  finishedAt: Date | null
  cancelRequested: boolean
}

function dispatchJobs() {
  return (printDispatcher as unknown as {
    jobs: Map<string, DispatchJobStateFixture>
  }).jobs
}

function buildDispatchFixture(overrides: Partial<DispatchJobStateFixture> = {}): DispatchJobStateFixture {
  return {
    id: 'dispatch-1',
    tenantId: 'tenant-1',
    printerId: 'printer-1',
    printerName: 'Printer 1',
    fileId: 'file-1',
    fileName: 'cube.gcode.3mf',
    jobName: 'Cube',
    plateName: null,
    fileSizeBytes: 1024,
    sourceKind: '3mf',
    projectFilamentChips: [],
    localPath: null,
    bridgeLibraryPath: '/bridge/library/cube.gcode.3mf',
    remoteName: 'cube.gcode.3mf',
    options: {
      useAms: true,
      bedLevel: 'on',
      vibrationCompensation: false,
      flowCalibration: 'on',
      firstLayerInspection: true,
      timelapse: false,
      filamentDynamicsCalibration: false,
      nozzleOffsetCalibration: 'off',
      allowIncompatibleFilament: false,
      allowPlateTypeMismatch: false,
      currentPlateType: null,
      currentNozzleDiameters: [],
      plate: 1,
      amsMapping: null
    },
    status: 'queued',
    progressMessage: 'Waiting to send',
    uploadAttempt: 0,
    uploadMaxAttempts: 3,
    uploadBytesSent: 0,
    uploadTotalBytes: null,
    uploadPercent: null,
    error: null,
    createdAt: new Date('2026-05-10T10:00:00.000Z'),
    updatedAt: new Date('2026-05-10T10:00:00.000Z'),
    startedAt: null,
    finishedAt: null,
    cancelRequested: false,
    ...overrides
  }
}

test('active dispatch guard rejects another dispatch for the same printer', () => {
  const jobs = dispatchJobs()
  const existingJob = jobs.get('dispatch-active')

  jobs.set('dispatch-active', buildDispatchFixture({
    id: 'dispatch-active',
    printerId: 'printer-7',
    status: 'uploading',
    progressMessage: 'Uploading to printer storage',
    startedAt: new Date('2026-05-10T10:01:00.000Z')
  }))

  try {
    assert.equal(printDispatcher.hasActiveDispatchForPrinter('printer-7'), true)
    assert.throws(
      () => printDispatcher.assertNoActiveDispatchForPrinter('printer-7'),
      (error: unknown) => error instanceof HttpError && error.statusCode === 409 && error.message === 'A print is already being dispatched to this printer. Wait for it to finish or cancel it first.'
    )
  } finally {
    if (existingJob) jobs.set('dispatch-active', existingJob)
    else jobs.delete('dispatch-active')
  }
})

test('active dispatch guard ignores completed dispatch rows for the same printer', () => {
  const jobs = dispatchJobs()
  const existingJob = jobs.get('dispatch-sent')

  jobs.set('dispatch-sent', buildDispatchFixture({
    id: 'dispatch-sent',
    printerId: 'printer-8',
    status: 'sent',
    progressMessage: 'Start command sent',
    startedAt: new Date('2026-05-10T10:01:00.000Z'),
    finishedAt: new Date('2026-05-10T10:02:00.000Z')
  }))

  try {
    assert.equal(printDispatcher.hasActiveDispatchForPrinter('printer-8'), false)
    assert.doesNotThrow(() => printDispatcher.assertNoActiveDispatchForPrinter('printer-8'))
  } finally {
    if (existingJob) jobs.set('dispatch-sent', existingJob)
    else jobs.delete('dispatch-sent')
  }
})

test('cancel marks a failed dispatch as cancelled and closes its tracked history row', async () => {
  const jobs = dispatchJobs()

  const existingJob = jobs.get('dispatch-failed')
  const updates: Array<{ where: { id: string }; data: Record<string, unknown> }> = []

  stubPrisma(rootPrisma.printJob, 'findUnique', async () => ({
    startedAt: new Date('2026-05-10T10:00:00.000Z'),
    finishedAt: null,
    printerId: 'printer-1',
    jobName: 'Failed cube',
    tenantId: 'tenant-1',
    sourceType: 'library',
    fileId: 'file-1',
    plate: 1
  }))
  stubPrisma(rootPrisma.printJob, 'update', async (input: { where: { id: string }; data: Record<string, unknown> }) => {
    updates.push(input)
    return { id: input.where.id }
  })
  stubPrisma(rootPrisma.printer, 'findUnique', async () => ({ tenantId: 'tenant-1' }))

  jobs.set('dispatch-failed', {
    id: 'dispatch-failed',
    tenantId: 'tenant-1',
    printerId: 'printer-1',
    printerName: 'Printer 1',
    fileId: 'file-1',
    fileName: 'cube.gcode.3mf',
    jobName: 'Failed cube',
    plateName: null,
    fileSizeBytes: 1024,
    sourceKind: '3mf',
    projectFilamentChips: [],
    localPath: null,
    bridgeLibraryPath: '/bridge/library/cube.gcode.3mf',
    remoteName: 'cube.gcode.3mf',
    options: {
      useAms: true,
      bedLevel: 'on',
      vibrationCompensation: false,
      flowCalibration: 'on',
      firstLayerInspection: true,
      timelapse: false,
      filamentDynamicsCalibration: false,
      nozzleOffsetCalibration: 'off',
      allowIncompatibleFilament: false,
      allowPlateTypeMismatch: false,
      currentPlateType: null,
      currentNozzleDiameters: [],
      plate: 1,
      amsMapping: null
    },
    status: 'failed',
    progressMessage: 'Dispatch failed',
    uploadAttempt: 1,
    uploadMaxAttempts: 3,
    uploadBytesSent: 1024,
    uploadTotalBytes: 1024,
    uploadPercent: 100,
    error: 'Printer not connected',
    createdAt: new Date('2026-05-10T10:00:00.000Z'),
    updatedAt: new Date('2026-05-10T10:05:00.000Z'),
    startedAt: new Date('2026-05-10T10:01:00.000Z'),
    finishedAt: new Date('2026-05-10T10:05:00.000Z'),
    cancelRequested: false
  })

  try {
    const job = await printDispatcher.cancel('tenant-1', 'dispatch-failed')

    assert.ok(job)
    assert.equal(job?.status, 'cancelled')
    assert.equal(job?.progressMessage, 'Cancelled after failed dispatch')
    assert.equal(job?.cancelRequested, true)
    assert.equal(updates.length, 1)
    assert.equal(updates[0]?.where.id, 'dispatch-failed')
    assert.equal(updates[0]?.data.result, 'cancelled')
    assert.ok(updates[0]?.data.finishedAt instanceof Date)
  } finally {
    if (existingJob) jobs.set('dispatch-failed', existingJob)
    else jobs.delete('dispatch-failed')
  }
})

test('getRemotePrintTarget appends the plate label for multi-plate 3MFs', () => {
  const target = getRemotePrintTarget('Best_Shot_Golf.gcode.3mf', '3mf', 4, 'Plate 4', { isMultiPlate: true })
  assert.equal(target.subtaskName, 'Best_Shot_Golf - Plate 4')
  assert.equal(target.param, 'Metadata/plate_4.gcode')
  assert.equal(target.remoteName, 'Best_Shot_Golf - Plate 4.gcode.3mf')
})

test('getRemotePrintTarget does not duplicate the plate for a single-plate sliced 3MF', () => {
  const target = getRemotePrintTarget('Best Shot Golf - Plate 4.gcode.3mf', '3mf', 4, 'Plate 4', { isMultiPlate: false })
  assert.equal(target.subtaskName, 'Best Shot Golf - Plate 4')
  assert.equal(target.param, 'Metadata/plate_4.gcode')
  assert.equal(target.remoteName, 'Best Shot Golf - Plate 4.gcode.3mf')
})

test('assertBridgeAllowsPrinting rejects dispatch through a bridge that needs updating', async () => {
  for (const status of ['updateRequired', 'runnerUpdateRequired', 'unsupported']) {
    stubPrisma(rootPrisma.bridge, 'findFirst', async () => ({ name: 'Home', updateStatus: status }))
    await assert.rejects(
      () => printDispatcher.assertBridgeAllowsPrinting('bridge-1', 'tenant-1'),
      (error) => error instanceof HttpError && /needs to be updated/i.test(error.message),
      `status ${status} should block dispatch`
    )
  }
})

test('assertBridgeAllowsPrinting allows compatible or unevaluated bridges', async () => {
  // imageUpdateRequired warns without blocking: the app code stays lockstep
  // via bundle self-updates, so image drift is a rebuild reminder.
  for (const updateStatus of ['current', 'updateAvailable', 'updateHeldBack', 'imageUpdateRequired', null, undefined]) {
    stubPrisma(rootPrisma.bridge, 'findFirst', async () => ({ name: 'Home', updateStatus }))
    await assert.doesNotReject(
      () => printDispatcher.assertBridgeAllowsPrinting('bridge-1', 'tenant-1'),
      `status ${String(updateStatus)} should not block dispatch`
    )
  }
})

test('prunePlateAmsMapping reduces a single-nozzle plate to its used filament (H2D 0300-4010 fix)', () => {
  // 3-filament project, but the plate uses only filament 0 (blue/left). The other two
  // map to right-nozzle trays; sending them makes the printer run dual-nozzle offset
  // calibration on a nozzle the plate never uses. Prune to just the used filament.
  assert.deepEqual(prunePlateAmsMapping([2, 7, 4], new Set([0])), [2])
})

test('prunePlateAmsMapping leaves a genuinely multi-filament plate untouched', () => {
  assert.deepEqual(prunePlateAmsMapping([2, 7, 5], new Set([0, 1, 2])), [2, 7, 5])
  assert.deepEqual(prunePlateAmsMapping([2, 7], new Set([0, 1])), [2, 7])
})

test('prunePlateAmsMapping keeps a leading -1 but drops trailing unused entries', () => {
  // Plate uses only filament 1 (index 1): index 0 -> -1 (kept, positional), index 2 dropped.
  assert.deepEqual(prunePlateAmsMapping([5, 7, 4], new Set([1])), [-1, 7])
})

test('prunePlateAmsMapping is fail-safe: unchanged when usage is unknown or unmatched', () => {
  assert.deepEqual(prunePlateAmsMapping([2, 7, 4], new Set()), [2, 7, 4]) // read failed -> empty set
  assert.deepEqual(prunePlateAmsMapping([2, 7, 4], new Set([9])), [2, 7, 4]) // no mapped index matches
})

test('sanitizeRemoteName keeps brackets and common punctuation, strips reserved/non-ASCII', () => {
  // BambuStudio itself sends bracketed names to printers; only path separators,
  // FAT-reserved punctuation, and non-ASCII must be replaced.
  assert.equal(sanitizeRemoteName('Tablet Mount (landscape).gcode.3mf'), 'Tablet Mount (landscape).gcode.3mf')
  assert.equal(sanitizeRemoteName("Bob's bracket [v2] #3.gcode.3mf"), "Bob's bracket [v2] #3.gcode.3mf")
  assert.equal(sanitizeRemoteName('dir/sub\\name<bad>:e|d?*.gcode'), 'name_bad__e_d__.gcode')
  assert.equal(sanitizeRemoteName('h\u00e9llo\u4e16\u754c.gcode'), 'h_llo_.gcode')
})

test('buildProjectFilePrintCommand maps options onto the project_file payload', () => {
  const payload = buildProjectFilePrintCommand({
    remoteName: 'Widget - plate_2.gcode.3mf',
    param: 'Metadata/plate_2.gcode',
    subtaskName: 'Widget - plate_2',
    submissionId: '12345',
    bedLevel: 'auto',
    flowCalibration: 'on',
    vibrationCompensation: true,
    firstLayerInspection: false,
    filamentDynamicsCalibration: true,
    nozzleOffsetCalibration: 'off',
    timelapse: true,
    useAms: true,
    amsMapping: [0, 1]
  })
  assert.deepEqual(payload, {
    command: 'project_file',
    param: 'Metadata/plate_2.gcode',
    url: 'ftp:///Widget - plate_2.gcode.3mf',
    file: 'Widget - plate_2.gcode.3mf',
    md5: '',
    bed_type: 'auto',
    timelapse: true,
    bed_leveling: false,
    auto_bed_leveling: 2,
    flow_cali: true,
    auto_flow_cali: 1,
    vibration_cali: true,
    layer_inspect: false,
    use_ams: true,
    cfg: '0',
    extrude_cali_flag: 1,
    extrude_cali_manual_mode: 0,
    nozzle_offset_cali: 0,
    subtask_name: 'Widget - plate_2',
    profile_id: '0',
    project_id: '12345',
    subtask_id: '12345',
    task_id: '12345',
    ams_mapping: [0, 1]
  })
})

test('buildProjectFilePrintCommand omits ams_mapping when empty', () => {
  const withEmpty = buildProjectFilePrintCommand({
    remoteName: 'a.gcode', param: 'a.gcode', subtaskName: 'a', submissionId: '1',
    bedLevel: 'off', flowCalibration: 'off', vibrationCompensation: false,
    firstLayerInspection: false, filamentDynamicsCalibration: false,
    nozzleOffsetCalibration: 'off', timelapse: false, useAms: false, amsMapping: []
  })
  assert.equal('ams_mapping' in withEmpty, false)
})
