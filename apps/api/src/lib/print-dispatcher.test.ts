import assert from 'node:assert/strict'
import test from 'node:test'
import { env } from './env.js'
import { HttpError } from './http-error.js'
import { rootPrisma } from './prisma.js'
import { printDispatcher, getRemotePrintTarget, prunePlateAmsMapping, sanitizeRemoteName, buildProjectFilePrintCommand } from './print-dispatcher.js'
import { usePrismaStubs } from '../test-utils/prisma-stubs.js'

// Pin cloud mode: `assertBridgeAllowsPrinting` skips its update block entirely
// when `isSelfHostedDeployment()` is true, which the public open-core build is by
// default (no `src/private`). The bridge-update-block cases below assert the cloud
// behavior; the self-hosted case overrides locally.
env.SELF_HOSTED = false

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

test('active dispatch guard honors a synchronous printer reservation (TOCTOU window)', () => {
  // A dispatch reserves the printer synchronously before its prep awaits and before the
  // job lands in `this.jobs`; the guard must already report the printer as busy so a
  // concurrent dispatch can't slip through that window and double-print.
  const reserved = (printDispatcher as unknown as { reservedPrinterIds: Set<string> }).reservedPrinterIds
  reserved.add('printer-9')
  try {
    assert.equal(printDispatcher.hasActiveDispatchForPrinter('printer-9'), true)
    assert.throws(
      () => printDispatcher.assertNoActiveDispatchForPrinter('printer-9'),
      (error: unknown) => error instanceof HttpError && error.statusCode === 409
    )
  } finally {
    reserved.delete('printer-9')
  }
  // Releasing the reservation clears the guard.
  assert.equal(printDispatcher.hasActiveDispatchForPrinter('printer-9'), false)
})

test('cancel aborts an in-flight upload and flags the job without finishing it', async () => {
  const jobs = dispatchJobs()
  const controller = new AbortController()
  const fixture = buildDispatchFixture({ id: 'dispatch-uploading', printerId: 'printer-cancel', status: 'uploading' })
  ;(fixture as unknown as { abortController: AbortController }).abortController = controller
  jobs.set('dispatch-uploading', fixture)
  try {
    const result = await printDispatcher.cancel('tenant-1', 'dispatch-uploading')
    // The transfer's AbortSignal fires so the FTPS upload stops mid-stream...
    assert.equal(controller.signal.aborted, true)
    // ...and the job is flagged, but stays 'uploading' until runJob observes the abort
    // and performs the SD cleanup + cancelled finish.
    assert.equal(result?.cancelRequested, true)
    assert.equal(result?.status, 'uploading')
  } finally {
    jobs.delete('dispatch-uploading')
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

test('stop() cancels queued jobs, aborts in-flight uploads, and leaves sent prints running', async () => {
  const jobs = dispatchJobs()
  const saved = new Map(jobs)
  jobs.clear()

  stubPrisma(rootPrisma.printJob, 'findUnique', async () => ({
    startedAt: new Date('2026-05-10T10:00:00.000Z'),
    finishedAt: null,
    printerId: 'printer-1',
    jobName: 'Queued cube',
    tenantId: 'tenant-1',
    sourceType: 'library',
    fileId: 'file-1',
    plate: 1
  }))
  stubPrisma(rootPrisma.printJob, 'update', async (input: { where: { id: string } }) => ({ id: input.where.id }))
  stubPrisma(rootPrisma.printer, 'findUnique', async () => ({ tenantId: 'tenant-1' }))

  const controller = new AbortController()
  const uploading = buildDispatchFixture({ id: 'stop-uploading', printerId: 'printer-up', status: 'uploading' })
  ;(uploading as unknown as { abortController: AbortController }).abortController = controller

  jobs.set('stop-queued', buildDispatchFixture({ id: 'stop-queued', printerId: 'printer-q', status: 'queued' }))
  jobs.set('stop-uploading', uploading)
  jobs.set('stop-sent', buildDispatchFixture({ id: 'stop-sent', printerId: 'printer-s', status: 'sent' }))

  try {
    await printDispatcher.stop()

    // Queued job is cancelled outright.
    assert.equal(jobs.get('stop-queued')?.status, 'cancelled')
    // In-flight upload is aborted (runJob then performs the SD cleanup + cancelled finish).
    assert.equal(controller.signal.aborted, true)
    assert.equal(jobs.get('stop-uploading')?.cancelRequested, true)
    // A print already sent to the printer is the live print — left untouched.
    assert.equal(jobs.get('stop-sent')?.status, 'sent')
  } finally {
    jobs.clear()
    for (const [key, value] of saved) jobs.set(key, value)
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

test('assertBridgeAllowsPrinting never blocks on a self-hosted bundle, even for a blocking status', async () => {
  // The bundled bridge is lockstep with the app; a stale self-reported status
  // must not refuse dispatch (the print would silently never reach Jobs) for an
  // update the operator cannot apply independently of the whole bundle.
  const previous = env.SELF_HOSTED
  env.SELF_HOSTED = true
  try {
    for (const status of ['updateRequired', 'runnerUpdateRequired', 'unsupported']) {
      stubPrisma(rootPrisma.bridge, 'findFirst', async () => ({ name: 'Home', updateStatus: status }))
      await assert.doesNotReject(
        () => printDispatcher.assertBridgeAllowsPrinting('bridge-1', 'tenant-1'),
        `self-hosted should not block on status ${status}`
      )
    }
  } finally {
    env.SELF_HOSTED = previous
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
    ams_mapping: [0, 1],
    ams_mapping_2: [
      { ams_id: 0, slot_id: 0 },
      { ams_id: 0, slot_id: 1 }
    ]
  })
})

test('buildProjectFilePrintCommand derives ams_mapping_2 across the tray-index bands', () => {
  // Regular units, an AMS HT (128+ band, tray index IS the unit id), an external
  // virtual tray (id preserved, slot 0), a pruned -1 hole (0xff/0xff), and the
  // ambiguous AMS Lite Mixed band (24-27, sent unset so a wrong pair never
  // contradicts the correct legacy index) — matching BambuStudio's SD-card
  // resend flow. H2C (Vortek) firmware needs the v2 form to build its AMS
  // mapping table (0701-8012 without it).
  const payload = buildProjectFilePrintCommand({
    remoteName: 'a.gcode.3mf', param: 'Metadata/plate_1.gcode', subtaskName: 'a', submissionId: '1',
    bedLevel: 'off', flowCalibration: 'off', vibrationCompensation: false,
    firstLayerInspection: false, filamentDynamicsCalibration: false,
    nozzleOffsetCalibration: 'off', timelapse: false, useAms: true,
    amsMapping: [6, 128, -1, 255, 254, 25]
  })
  assert.deepEqual(payload.ams_mapping, [6, 128, -1, 255, 254, 25])
  assert.deepEqual(payload.ams_mapping_2, [
    { ams_id: 1, slot_id: 2 },
    { ams_id: 128, slot_id: 0 },
    { ams_id: 0xff, slot_id: 0xff },
    { ams_id: 255, slot_id: 0 },
    { ams_id: 254, slot_id: 0 },
    { ams_id: 0xff, slot_id: 0xff }
  ])
})

test('buildProjectFilePrintCommand carries ams_mapping_info and nozzles_info when resolved', () => {
  const base = {
    remoteName: 'a.gcode.3mf', param: 'Metadata/plate_1.gcode', subtaskName: 'a', submissionId: '1',
    bedLevel: 'off', flowCalibration: 'off', vibrationCompensation: false,
    firstLayerInspection: false, filamentDynamicsCalibration: false,
    nozzleOffsetCalibration: 'off', timelapse: false, useAms: true
  } as const
  const info = [{ ams: 128, targetColor: '0A2CA5FF', filamentId: 'GFA06', filamentType: 'PLA', nozzleId: 1, sourceColor: 'FF0000FF' }]
  const nozzles = [{ id: 1, type: null, flowSize: 'high_flow', diameter: 0.4 }]
  const payload = buildProjectFilePrintCommand({ ...base, amsMapping: [128], amsMappingInfo: info, nozzlesInfo: nozzles })
  assert.deepEqual(payload.ams_mapping_info, info)
  assert.deepEqual(payload.nozzles_info, nozzles)

  // ams_mapping_info rides only alongside a mapping; nulls are omitted entirely.
  const withoutMapping = buildProjectFilePrintCommand({ ...base, amsMappingInfo: info, nozzlesInfo: nozzles })
  assert.equal('ams_mapping_info' in withoutMapping, false)
  const withoutInfo = buildProjectFilePrintCommand({ ...base, amsMapping: [128], amsMappingInfo: null, nozzlesInfo: null })
  assert.equal('ams_mapping_info' in withoutInfo, false)
  assert.equal('nozzles_info' in withoutInfo, false)
})

test('buildProjectFilePrintCommand omits ams_mapping when empty', () => {
  const withEmpty = buildProjectFilePrintCommand({
    remoteName: 'a.gcode', param: 'a.gcode', subtaskName: 'a', submissionId: '1',
    bedLevel: 'off', flowCalibration: 'off', vibrationCompensation: false,
    firstLayerInspection: false, filamentDynamicsCalibration: false,
    nozzleOffsetCalibration: 'off', timelapse: false, useAms: false, amsMapping: []
  })
  assert.equal('ams_mapping' in withEmpty, false)
  assert.equal('ams_mapping_2' in withEmpty, false)
})

test('buildProjectFilePrintCommand includes skip_objects when identify_ids are supplied', () => {
  // The start command carries the skip list directly (what Bambu Handy sends);
  // firmware without partskip support ignores it and the mid-print fallback covers it.
  const payload = buildProjectFilePrintCommand({
    remoteName: 'a.gcode.3mf', param: 'Metadata/plate_1.gcode', subtaskName: 'a', submissionId: '1',
    bedLevel: 'off', flowCalibration: 'off', vibrationCompensation: false,
    firstLayerInspection: false, filamentDynamicsCalibration: false,
    nozzleOffsetCalibration: 'off', timelapse: false, useAms: false,
    skipObjects: [153, 154]
  })
  assert.deepEqual(payload.skip_objects, [153, 154])
})

test('buildProjectFilePrintCommand omits skip_objects when empty, null, or absent', () => {
  const base = {
    remoteName: 'a.gcode.3mf', param: 'Metadata/plate_1.gcode', subtaskName: 'a', submissionId: '1',
    bedLevel: 'off', flowCalibration: 'off', vibrationCompensation: false,
    firstLayerInspection: false, filamentDynamicsCalibration: false,
    nozzleOffsetCalibration: 'off', timelapse: false, useAms: false
  } as const
  assert.equal('skip_objects' in buildProjectFilePrintCommand({ ...base, skipObjects: [] }), false)
  assert.equal('skip_objects' in buildProjectFilePrintCommand({ ...base, skipObjects: null }), false)
  assert.equal('skip_objects' in buildProjectFilePrintCommand({ ...base }), false)
})
