process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { createWriteStream } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import type { CreateSlicingJob, SlicingOutputLine } from '@printstream/shared'
import yazl from 'yazl'
import { readPrintJobThumbnail, savePrintJobThumbnail } from './print-job-thumbnails.js'
import { SlicerServiceError, slicerClient } from './slicer-client.js'
import { SlicingJobs, resolveSlicingSourcePath, type PersistSlicedArtifact, type ResolveSlicingSource } from './slicing-jobs.js'
import { readEntry } from './three-mf.js'

// These suites slice from fixture paths that don't exist on disk and mock the
// slicer, so use the persisted path as-is rather than re-resolving from the DB.
// (Re-resolution itself is covered by the resolveSlicingSourcePath tests.)
const passthroughResolveSource: ResolveSlicingSource = async ({ sourcePath }) => sourcePath

const originalIsConfigured = slicerClient.isConfigured
const originalRun = slicerClient.run
const originalProgress = slicerClient.progress
const originalConsoleInfo = console.info
const originalConsoleWarn = console.warn
const originalConsoleError = console.error
const originalConsoleDebug = console.debug

afterEach(() => {
  slicerClient.isConfigured = originalIsConfigured
  slicerClient.run = originalRun
  slicerClient.progress = originalProgress
  console.info = originalConsoleInfo
  console.warn = originalConsoleWarn
  console.error = originalConsoleError
  console.debug = originalConsoleDebug
})

test('resolveSlicingSourcePath returns the persisted path when it still exists', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'printstream-slice-source-'))
  try {
    const sourcePath = path.join(dir, 'source.3mf')
    await writeFile(sourcePath, Buffer.from('3mf bytes'))
    const resolved = await resolveSlicingSourcePath({ sourceFileId: 'file-1', sourcePath })
    // The cached copy exists, so it is used as-is without any library re-fetch.
    assert.equal(resolved, sourcePath)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('slicing jobs surface live slicer output before the run finishes', async () => {
  const jobs = new SlicingJobs({ resolveSource: passthroughResolveSource })
  let releaseRun: (() => void) | undefined
  const runReleased = new Promise<void>((resolve) => {
    releaseRun = resolve
  })
  let progressCalls = 0

  slicerClient.isConfigured = (() => true) as typeof slicerClient.isConfigured
  slicerClient.progress = (async () => {
    progressCalls += 1
    if (progressCalls < 2) return []
    return [makeOutput('stdout', 'Processing layer 12/248')]
  }) as typeof slicerClient.progress
  slicerClient.run = (async () => {
    await runReleased
    throw new SlicerServiceError('Slicing failed', [])
  }) as typeof slicerClient.run

  const job = jobs.enqueue({
    tenantId: 'tenant-1',
    tenant: { id: 'tenant-1', slug: 'alpha', name: 'Alpha' },
    sourceFileId: 'file-1',
    sourceFileName: 'part.3mf',
    sourcePath: '/tmp/part.3mf',
    targetBridgeId: null,
    request: makeRequest()
  })

  await waitFor(async () => {
    const current = jobs.get('tenant-1', job.id)
    assert.equal(current.status, 'slicing')
    assert.equal(current.output.some((entry) => entry.text === 'Processing layer 12/248'), true)
  })

  if (releaseRun) releaseRun()

  await waitFor(async () => {
    const current = jobs.get('tenant-1', job.id)
    assert.equal(current.status, 'failed')
    assert.equal(current.error, 'Slicing failed')
  })
})

test('slicing jobs log lifecycle changes and CLI output lines', async () => {
  const jobs = new SlicingJobs({ resolveSource: passthroughResolveSource })
  const logged: string[] = []
  let releaseRun: (() => void) | undefined
  const runReleased = new Promise<void>((resolve) => {
    releaseRun = resolve
  })

  console.info = ((...args: unknown[]) => { logged.push(args.join(' ')) }) as typeof console.info
  console.warn = ((...args: unknown[]) => { logged.push(args.join(' ')) }) as typeof console.warn
  console.error = ((...args: unknown[]) => { logged.push(args.join(' ')) }) as typeof console.error
  console.debug = ((...args: unknown[]) => { logged.push(args.join(' ')) }) as typeof console.debug

  slicerClient.isConfigured = (() => true) as typeof slicerClient.isConfigured
  slicerClient.progress = (async () => [
    makeOutput('stdout', 'Processing layer 12/248'),
    makeOutput('stderr', 'warning: unsupported seam hint')
  ]) as typeof slicerClient.progress
  slicerClient.run = (async () => {
    await runReleased
    throw new SlicerServiceError('Slicing failed', [])
  }) as typeof slicerClient.run

  const job = jobs.enqueue({
    tenantId: 'tenant-1',
    tenant: { id: 'tenant-1', slug: 'alpha', name: 'Alpha' },
    sourceFileId: 'file-1',
    sourceFileName: 'part.3mf',
    sourcePath: '/tmp/part.3mf',
    targetBridgeId: null,
    request: makeRequest()
  })

  await waitFor(async () => {
    assert.equal(logged.some((entry) => entry.includes(`[slicing:${job.id}] Queued slicing job`)), true)
    assert.equal(logged.some((entry) => entry.includes('Processing layer 12/248')), true)
    assert.equal(logged.some((entry) => entry.includes('warning: unsupported seam hint')), true)
  })

  if (releaseRun) releaseRun()

  await waitFor(async () => {
    assert.equal(logged.some((entry) => entry.includes('failed: Slicing failed')), true)
  })
})

test('slicing jobs emit elapsed-time heartbeats when live output is unavailable', async () => {
  const jobs = new SlicingJobs({ progressPollIntervalMs: 10, progressHeartbeatIntervalMs: 20, resolveSource: passthroughResolveSource })
  let releaseRun: (() => void) | undefined
  const runReleased = new Promise<void>((resolve) => {
    releaseRun = resolve
  })

  slicerClient.isConfigured = (() => true) as typeof slicerClient.isConfigured
  slicerClient.progress = (async () => null) as typeof slicerClient.progress
  slicerClient.run = (async () => {
    await runReleased
    throw new SlicerServiceError('Slicing failed', [])
  }) as typeof slicerClient.run

  const job = jobs.enqueue({
    tenantId: 'tenant-1',
    tenant: { id: 'tenant-1', slug: 'alpha', name: 'Alpha' },
    sourceFileId: 'file-1',
    sourceFileName: 'part.3mf',
    sourcePath: '/tmp/part.3mf',
    targetBridgeId: null,
    request: makeRequest()
  })

  await waitFor(async () => {
    const current = jobs.get('tenant-1', job.id)
    assert.equal(current.output.some((entry) => entry.text.includes('Slicer is still processing...')), true)
  })

  if (releaseRun) releaseRun()

  await waitFor(async () => {
    const current = jobs.get('tenant-1', job.id)
    assert.equal(current.status, 'failed')
  })
})

test('slicing jobs reload persisted history after restart', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'slicing-jobs-state-'))
  const stateFilePath = path.join(tempDir, 'state.json')
  const options = {
    progressPollIntervalMs: 10,
    progressHeartbeatIntervalMs: 10,
    persistState: true,
    stateFilePath,
    resolveSource: passthroughResolveSource
  }

  slicerClient.isConfigured = (() => true) as typeof slicerClient.isConfigured
  slicerClient.progress = (async () => null) as typeof slicerClient.progress
  slicerClient.run = (async () => {
    throw new SlicerServiceError('Slicing failed', [])
  }) as typeof slicerClient.run

  const first = new SlicingJobs(options)
  const queued = first.enqueue({
    tenantId: 'tenant-1',
    tenant: { id: 'tenant-1', slug: 'alpha', name: 'Alpha' },
    sourceFileId: 'file-1',
    sourceFileName: 'part.3mf',
    sourcePath: '/tmp/part.3mf',
    targetBridgeId: null,
    request: makeRequest()
  })

  try {
    await waitFor(async () => {
      const current = first.get('tenant-1', queued.id)
      assert.equal(current.status, 'failed')
    })

    await waitFor(async () => {
      const raw = await readFile(stateFilePath, 'utf8')
      assert.equal(raw.includes(queued.id), true)
    })

    const reloaded = new SlicingJobs(options)
    const list = reloaded.list('tenant-1')
    assert.equal(list.length, 1)
    assert.equal(list[0]?.id, queued.id)
    assert.equal(list[0]?.status, 'failed')
    assert.equal(list[0]?.error, 'Slicing failed')
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('slicing jobs persist slice-to-print artifacts as hidden files', async () => {
  const persistedInputs: Array<{ hidden: boolean; folderId: string | null; fileName: string }> = []
  const jobs = new SlicingJobs({
    progressPollIntervalMs: 10,
    progressHeartbeatIntervalMs: 10_000,
    resolveSource: passthroughResolveSource,
    persistArtifact: async (input) => {
      persistedInputs.push({ hidden: input.hidden, folderId: input.folderId, fileName: input.fileName })
      return {
        file: {
        id: 'hidden-output-file',
        tenantId: input.tenantId,
        ownerBridgeId: input.bridgeId,
        name: input.fileName,
        storedPath: 'hidden-output.gcode.3mf',
        sizeBytes: input.sizeBytes,
        kind: 'gcode',
        folderId: null,
        hidden: input.hidden,
        uploadedAt: new Date(),
        thumbnailPath: null,
        currentVersionNumber: 1,
        snapshotKey: null
        },
        unchanged: false
      } as Awaited<ReturnType<PersistSlicedArtifact>>
    }
  })
  const tempDir = await mkdtemp(path.join(tmpdir(), 'slicing-jobs-success-'))
  const artifactPath = path.join(tempDir, 'result.gcode.3mf')
  await createTestThreeMf(artifactPath, { printer_settings_id: 'Bambu Lab X1C 0.4 nozzle' })

  slicerClient.isConfigured = (() => true) as typeof slicerClient.isConfigured
  slicerClient.progress = (async () => null) as typeof slicerClient.progress
  slicerClient.run = (async () => ({
    outputFileName: 'result.gcode.3mf',
    output: [],
    metadata: undefined,
    artifactPath
  })) as typeof slicerClient.run

  const job = jobs.enqueue({
    tenantId: 'tenant-1',
    tenant: { id: 'tenant-1', slug: 'alpha', name: 'Alpha' },
    sourceFileId: 'file-1',
    sourceFileName: 'part.3mf',
    sourcePath: '/tmp/part.3mf',
    targetBridgeId: 'bridge-1',
    request: {
      ...makeRequest(),
      outputFolderId: 'folder-1',
      hiddenOutput: true
    }
  })

  try {
    await waitFor(async () => {
      const current = jobs.get('tenant-1', job.id)
      assert.equal(current.status, 'ready')
      assert.equal(current.outputFileId, 'hidden-output-file')
      assert.equal(current.output.some((entry) => entry.text === 'Prepared sliced artifact for printing'), true)
    })

    assert.deepEqual(persistedInputs, [{ hidden: true, folderId: 'folder-1', fileName: 'result.gcode.3mf' }])
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('slicing jobs persist durable history thumbnails and clean them up on delete', async () => {
  const persistedThumbnailCalls: Array<{ jobId: string; preferredFileIds: Array<string | null | undefined>; plate: number }> = []
  const jobs = new SlicingJobs({
    progressPollIntervalMs: 10,
    progressHeartbeatIntervalMs: 10_000,
    resolveSource: passthroughResolveSource,
    persistArtifact: async (input) => ({
      file: {
      id: 'output-file-1',
      tenantId: input.tenantId,
      ownerBridgeId: input.bridgeId,
      name: input.fileName,
      storedPath: 'output.gcode.3mf',
      sizeBytes: input.sizeBytes,
      kind: 'gcode',
      folderId: input.folderId ?? null,
      hidden: input.hidden,
      uploadedAt: new Date(),
      thumbnailPath: null,
      currentVersionNumber: 1,
      snapshotKey: null
      },
      unchanged: false
    }) as Awaited<ReturnType<PersistSlicedArtifact>>,
    persistThumbnail: async (input) => {
      persistedThumbnailCalls.push(input)
      return await savePrintJobThumbnail(input.jobId, Buffer.from('png'))
    }
  })
  const tempDir = await mkdtemp(path.join(tmpdir(), 'slicing-jobs-history-thumb-'))
  const artifactPath = path.join(tempDir, 'result.gcode.3mf')
  await createTestThreeMf(artifactPath, { printer_settings_id: 'Bambu Lab X1C 0.4 nozzle' })

  slicerClient.isConfigured = (() => true) as typeof slicerClient.isConfigured
  slicerClient.progress = (async () => null) as typeof slicerClient.progress
  slicerClient.run = (async () => ({
    outputFileName: 'result.gcode.3mf',
    output: [],
    metadata: undefined,
    artifactPath
  })) as typeof slicerClient.run

  const job = jobs.enqueue({
    tenantId: 'tenant-1',
    tenant: { id: 'tenant-1', slug: 'alpha', name: 'Alpha' },
    sourceFileId: 'file-1',
    sourceFileName: 'part.3mf',
    sourcePath: '/tmp/part.3mf',
    targetBridgeId: 'bridge-1',
    request: makeRequest()
  })

  try {
    let thumbnailPath: string | null = null
    await waitFor(async () => {
      const current = jobs.get('tenant-1', job.id)
      assert.equal(current.status, 'ready')
      thumbnailPath = jobs.getThumbnailInfo('tenant-1', job.id).thumbnailPath
      assert.equal(typeof thumbnailPath, 'string')
    })

    assert.deepEqual(jobs.getThumbnailInfo('tenant-1', job.id), {
      thumbnailPath,
      sourceFileId: 'file-1',
      outputFileId: 'output-file-1',
      plate: 1
    })
    assert.deepEqual(persistedThumbnailCalls, [{
      jobId: job.id,
      preferredFileIds: ['output-file-1', 'file-1'],
      plate: 1
    }])

    assert.ok(thumbnailPath)
    assert.deepEqual(await readPrintJobThumbnail(thumbnailPath), Buffer.from('png'))
    await jobs.delete('tenant-1', job.id)
    assert.equal(await readPrintJobThumbnail(thumbnailPath), null)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('slicing jobs retry without incompatible builtin profiles after compatibility failures', async () => {
  const jobs = new SlicingJobs({ progressPollIntervalMs: 10, progressHeartbeatIntervalMs: 10_000, resolveSource: passthroughResolveSource })
  const runProfileCounts: number[] = []
  const runProfileKinds: string[][] = []
  const runJobIds: string[] = []

  slicerClient.isConfigured = (() => true) as typeof slicerClient.isConfigured
  slicerClient.progress = (async () => null) as typeof slicerClient.progress
  slicerClient.run = (async (input) => {
    runJobIds.push(input.jobId)
    runProfileCounts.push(input.profileFiles?.length ?? 0)
    runProfileKinds.push((input.profileFiles ?? []).map((profile) => `${profile.source}:${profile.kind}`))
    if (runProfileCounts.length === 1) {
      throw new SlicerServiceError('Slicer CLI exited with code 251', [
        makeOutput('stderr', ":file /opt/bambustudio/squashfs-root/resources/profiles/BBL/machine_full/Bambu Lab P1S.json's from unsupported")
      ])
    }
    throw new SlicerServiceError('Still failed after retry', [])
  }) as typeof slicerClient.run

  const job = jobs.enqueue({
    tenantId: 'tenant-1',
    tenant: { id: 'tenant-1', slug: 'alpha', name: 'Alpha' },
    sourceFileId: 'file-1',
    sourceFileName: 'part.3mf',
    sourcePath: '/tmp/part.3mf',
    targetBridgeId: null,
    profileFiles: [
      { id: 'builtin-machine', source: 'builtin', kind: 'machine', name: 'Bambu Lab P1S' },
      { id: 'custom-process', source: 'custom', kind: 'process', name: 'Project Quality', content: '{"type":"process","name":"Project Quality"}' }
    ],
    request: makeRequest()
  })

  await waitFor(async () => {
    const current = jobs.get('tenant-1', job.id)
    assert.equal(current.status, 'failed')
    assert.equal(runProfileCounts.length, 2)
    assert.equal(runJobIds.length, 2)
    assert.notEqual(runJobIds[0], runJobIds[1])
    assert.deepEqual(runProfileKinds, [
      ['builtin:machine', 'custom:process'],
      ['custom:process']
    ])
    assert.equal(current.output.some((entry) => entry.text.includes('Retrying slicer without incompatible built-in machine profile')), true)
  })
})

test('slicing jobs retry when compatibility fallback matches generated builtin:machine profile file names', async () => {
  const jobs = new SlicingJobs({ progressPollIntervalMs: 10, progressHeartbeatIntervalMs: 10_000, resolveSource: passthroughResolveSource })
  const runProfileKinds: string[][] = []
  const runJobIds: string[] = []

  slicerClient.isConfigured = (() => true) as typeof slicerClient.isConfigured
  slicerClient.progress = (async () => null) as typeof slicerClient.progress
  slicerClient.run = (async (input) => {
    runJobIds.push(input.jobId)
    runProfileKinds.push((input.profileFiles ?? []).map((profile) => `${profile.source}:${profile.kind}`))
    if (runProfileKinds.length === 1) {
      throw new SlicerServiceError('Slicer CLI exited with code 251', [
        makeOutput('stderr', "operator():file /work/job/profiles/builtin:machine:QmFtYnUgTGFiIFAxUyAwLjQgbm96emxl.json's from  unsupported")
      ])
    }
    throw new SlicerServiceError('Still failed after retry', [])
  }) as typeof slicerClient.run

  const job = jobs.enqueue({
    tenantId: 'tenant-1',
    tenant: { id: 'tenant-1', slug: 'alpha', name: 'Alpha' },
    sourceFileId: 'file-1',
    sourceFileName: 'part.3mf',
    sourcePath: '/tmp/part.3mf',
    targetBridgeId: null,
    profileFiles: [
      { id: 'builtin-machine', source: 'builtin', kind: 'machine', name: 'Bambu Lab P1S 0.4 nozzle' },
      { id: 'custom-process', source: 'custom', kind: 'process', name: 'Project Quality', content: '{"type":"process","name":"Project Quality"}' }
    ],
    request: makeRequest()
  })

  await waitFor(async () => {
    const current = jobs.get('tenant-1', job.id)
    assert.equal(current.status, 'failed')
    assert.equal(runJobIds.length, 2)
    assert.notEqual(runJobIds[0], runJobIds[1])
    assert.deepEqual(runProfileKinds, [
      ['builtin:machine', 'custom:process'],
      ['custom:process']
    ])
    assert.equal(current.output.some((entry) => entry.text.includes('Retrying slicer without incompatible built-in machine profile')), true)
  })
})

test('slicing jobs preserve manual machine/profile selections on retry after builtin machine removal', async () => {
  const jobs = new SlicingJobs({ progressPollIntervalMs: 10, progressHeartbeatIntervalMs: 10_000, resolveSource: passthroughResolveSource })
  const runJobIds: string[] = []
  const runMachineProfileIds: string[] = []
  const runProcessProfileIds: Array<string | null | undefined> = []
  const runFilamentMappingCounts: number[] = []
  const runProfileKinds: string[][] = []

  slicerClient.isConfigured = (() => true) as typeof slicerClient.isConfigured
  slicerClient.progress = (async () => null) as typeof slicerClient.progress
  slicerClient.run = (async (input) => {
    runJobIds.push(input.jobId)
    runMachineProfileIds.push(input.request.target.printerProfileId ?? '<null>')
    runProcessProfileIds.push(input.request.target.processProfileId)
    runFilamentMappingCounts.push(input.request.target.filamentMappings?.length ?? 0)
    runProfileKinds.push((input.profileFiles ?? []).map((profile) => `${profile.source}:${profile.kind}`))
    if (runJobIds.length <= 2) {
      throw new SlicerServiceError('Slicer CLI exited with code 251', [
        makeOutput('stderr', ":file /opt/bambustudio/squashfs-root/resources/profiles/BBL/machine_full/Bambu Lab P1S 0.4 nozzle.json's from  unsupported")
      ])
    }
    throw new SlicerServiceError('Still failed after fallback retry', [])
  }) as typeof slicerClient.run

  const job = jobs.enqueue({
    tenantId: 'tenant-1',
    tenant: { id: 'tenant-1', slug: 'alpha', name: 'Alpha' },
    sourceFileId: 'file-1',
    sourceFileName: 'part.3mf',
    sourcePath: '/tmp/part.3mf',
    targetBridgeId: null,
    profileFiles: [
      { id: 'builtin-machine', source: 'builtin', kind: 'machine', name: 'Bambu Lab P1S 0.4 nozzle' }
    ],
    request: makeRequest()
  })

  await waitFor(async () => {
    const current = jobs.get('tenant-1', job.id)
    assert.equal(current.status, 'failed')
    assert.equal(runJobIds.length, 2)
    assert.equal(runMachineProfileIds.length, 2)
    assert.deepEqual(runProfileKinds, [
      ['builtin:machine'],
      []
    ])
    assert.equal(runMachineProfileIds[0], 'printer-profile')
    assert.equal(runMachineProfileIds[1], 'printer-profile')
    assert.equal(runProcessProfileIds[0], 'process-profile')
    assert.equal(runProcessProfileIds[1], 'process-profile')
    assert.equal(runFilamentMappingCounts[0], 0)
    assert.equal(runFilamentMappingCounts[1], 0)
    assert.equal(current.output.some((entry) => entry.text.includes('Retrying slicer without incompatible built-in machine profile')), true)
  })
})

test('slicing jobs rewrite project settings and retry when compatibility fallback matches process_full profiles', async () => {
  const jobs = new SlicingJobs({ progressPollIntervalMs: 10, progressHeartbeatIntervalMs: 10_000, resolveSource: passthroughResolveSource })
  const runSourcePaths: string[] = []
  const runJobIds: string[] = []
  const tempDir = await mkdtemp(path.join(tmpdir(), 'slicing-jobs-test-'))
  const sourcePath = path.join(tempDir, 'source.3mf')
  await createTestThreeMf(sourcePath, {
    printer_settings_id: 'Bambu Lab X1C 0.4 nozzle',
    print_settings_id: '0.20mm Ryan @BBL X1C',
    default_print_profile: '0.20mm Standard @BBL X1C',
    inherits_group: ['0.20mm Standard @BBL X1C', 'Bambu PLA Basic @BBL X1C 0.4 nozzle'],
    print_compatible_printers: ['Bambu Lab X1C'],
    filament_settings_id: ['Bambu PLA Basic @BBL X1C'],
    filament_type: ['PLA'],
    filament_colour: ['#FFFFFF'],
    filament_vendor: ['Bambu']
  })

  slicerClient.isConfigured = (() => true) as typeof slicerClient.isConfigured
  slicerClient.progress = (async () => null) as typeof slicerClient.progress
  slicerClient.run = (async (input) => {
    runSourcePaths.push(input.sourcePath)
    runJobIds.push(input.jobId)
    if (runSourcePaths.length === 1) {
      throw new SlicerServiceError('Slicer CLI exited with code 251', [
        makeOutput('stderr', "operator():file /opt/bambustudio/squashfs-root/resources/profiles/BBL/process_full/0.20mm Standard @BBL X1C.json's from unsupported")
      ])
    }
    const rewrittenRaw = await readEntry(input.sourcePath, 'Metadata/project_settings.config')
    const rewrittenJson = JSON.parse(rewrittenRaw.toString('utf8'))
    assert.equal(rewrittenJson.print_settings_id, '')
    assert.equal(rewrittenJson.default_print_profile, '')
    assert.deepEqual(rewrittenJson.inherits_group, ['', 'Bambu PLA Basic @BBL X1C 0.4 nozzle'])
    throw new SlicerServiceError('Still failed after retry', [])
  }) as typeof slicerClient.run

  const job = jobs.enqueue({
    tenantId: 'tenant-1',
    tenant: { id: 'tenant-1', slug: 'alpha', name: 'Alpha' },
    sourceFileId: 'file-1',
    sourceFileName: 'part.3mf',
    sourcePath,
    targetBridgeId: null,
    request: makeRequest()
  })

  try {
    await waitFor(async () => {
      const current = jobs.get('tenant-1', job.id)
      assert.equal(current.status, 'failed')
      assert.equal(runJobIds.length, 2)
      assert.notEqual(runSourcePaths[0], runSourcePaths[1])
      assert.equal(current.output.some((entry) => entry.text.includes('Retrying slicer without incompatible built-in process profile')), true)
    })
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('slicing jobs retry incompatible built-in machine profiles per job without caching across subsequent jobs', async () => {
  const jobs = new SlicingJobs({ progressPollIntervalMs: 10, progressHeartbeatIntervalMs: 10_000, resolveSource: passthroughResolveSource })
  const runProfileKinds: string[][] = []
  const runJobIds: string[] = []

  slicerClient.isConfigured = (() => true) as typeof slicerClient.isConfigured
  slicerClient.progress = (async () => null) as typeof slicerClient.progress
  slicerClient.run = (async (input) => {
    runJobIds.push(input.jobId)
    runProfileKinds.push((input.profileFiles ?? []).map((profile) => `${profile.source}:${profile.kind}`))
    if (runJobIds.length === 1 || runJobIds.length === 3) {
      throw new SlicerServiceError('Slicer CLI exited with code 251', [
        makeOutput('stderr', "operator():file /work/job/profiles/builtin:machine:QmFtYnUgTGFiIFAxUyAwLjQgbm96emxl.json's from  unsupported")
      ])
    }
    throw new SlicerServiceError('Still failed after cache preflight', [])
  }) as typeof slicerClient.run

  const firstJob = jobs.enqueue({
    tenantId: 'tenant-1',
    tenant: { id: 'tenant-1', slug: 'alpha', name: 'Alpha' },
    sourceFileId: 'file-1',
    sourceFileName: 'part.3mf',
    sourcePath: '/tmp/part.3mf',
    targetBridgeId: null,
    profileFiles: [
      { id: 'builtin-machine', source: 'builtin', kind: 'machine', name: 'Bambu Lab P1S 0.4 nozzle' }
    ],
    request: makeRequest()
  })

  await waitFor(async () => {
    const current = jobs.get('tenant-1', firstJob.id)
    assert.equal(current.status, 'failed')
    assert.equal(runJobIds.length, 2)
  })

  const secondJob = jobs.enqueue({
    tenantId: 'tenant-1',
    tenant: { id: 'tenant-1', slug: 'alpha', name: 'Alpha' },
    sourceFileId: 'file-2',
    sourceFileName: 'part-2.3mf',
    sourcePath: '/tmp/part-2.3mf',
    targetBridgeId: null,
    profileFiles: [
      { id: 'builtin-machine-2', source: 'builtin', kind: 'machine', name: 'Bambu Lab P1S 0.4 nozzle' }
    ],
    request: makeRequest()
  })

  await waitFor(async () => {
    const current = jobs.get('tenant-1', secondJob.id)
    assert.equal(current.status, 'failed')
    assert.equal(runJobIds.length, 4)
    assert.deepEqual(runProfileKinds, [
      ['builtin:machine'],
      [],
      ['builtin:machine'],
      []
    ])
    assert.equal(current.output.some((entry) => entry.text.includes('Applying cached builtin-profile compatibility fallback for machine profile')), false)
    assert.equal(current.output.some((entry) => entry.text.includes('Retrying slicer without incompatible built-in machine profile')), true)
  })
})

test('slicing jobs do not proactively rewrite process profiles on subsequent jobs', async () => {
  const jobs = new SlicingJobs({ progressPollIntervalMs: 10, progressHeartbeatIntervalMs: 10_000, resolveSource: passthroughResolveSource })
  const runSourcePaths: string[] = []
  const tempDir = await mkdtemp(path.join(tmpdir(), 'slicing-jobs-test-'))
  const firstSourcePath = path.join(tempDir, 'first.3mf')
  const secondSourcePath = path.join(tempDir, 'second.3mf')
  await createTestThreeMf(firstSourcePath, {
    printer_settings_id: 'Bambu Lab X1C 0.4 nozzle',
    print_settings_id: '0.20mm Ryan @BBL X1C',
    default_print_profile: '0.20mm Standard @BBL X1C',
    inherits_group: ['0.20mm Standard @BBL X1C', 'Bambu PLA Basic @BBL X1C 0.4 nozzle']
  })
  await createTestThreeMf(secondSourcePath, {
    printer_settings_id: 'Bambu Lab X1C 0.4 nozzle',
    print_settings_id: '0.20mm Ryan @BBL X1C',
    default_print_profile: '0.20mm Standard @BBL X1C',
    inherits_group: ['0.20mm Standard @BBL X1C', 'Bambu PLA Basic @BBL X1C 0.4 nozzle']
  })

  slicerClient.isConfigured = (() => true) as typeof slicerClient.isConfigured
  slicerClient.progress = (async () => null) as typeof slicerClient.progress
  slicerClient.run = (async (input) => {
    runSourcePaths.push(input.sourcePath)
    if (runSourcePaths.length === 1 || runSourcePaths.length === 3) {
      throw new SlicerServiceError('Slicer CLI exited with code 251', [
        makeOutput('stderr', "operator():file /opt/bambustudio/squashfs-root/resources/profiles/BBL/process_full/0.20mm Standard @BBL X1C.json's from unsupported")
      ])
    }
    const rewrittenRaw = await readEntry(input.sourcePath, 'Metadata/project_settings.config')
    const rewrittenJson = JSON.parse(rewrittenRaw.toString('utf8'))
    assert.equal(rewrittenJson.print_settings_id, '')
    assert.equal(rewrittenJson.default_print_profile, '')
    assert.deepEqual(rewrittenJson.inherits_group, ['', 'Bambu PLA Basic @BBL X1C 0.4 nozzle'])
    throw new SlicerServiceError('Still failed after cache preflight', [])
  }) as typeof slicerClient.run

  const firstJob = jobs.enqueue({
    tenantId: 'tenant-1',
    tenant: { id: 'tenant-1', slug: 'alpha', name: 'Alpha' },
    sourceFileId: 'file-1',
    sourceFileName: 'first.3mf',
    sourcePath: firstSourcePath,
    targetBridgeId: null,
    request: makeRequest()
  })

  try {
    await waitFor(async () => {
      const current = jobs.get('tenant-1', firstJob.id)
      assert.equal(current.status, 'failed')
      assert.equal(runSourcePaths.length, 2)
    })

    const secondJob = jobs.enqueue({
      tenantId: 'tenant-1',
      tenant: { id: 'tenant-1', slug: 'alpha', name: 'Alpha' },
      sourceFileId: 'file-2',
      sourceFileName: 'second.3mf',
      sourcePath: secondSourcePath,
      targetBridgeId: null,
      request: makeRequest()
    })

    await waitFor(async () => {
      const current = jobs.get('tenant-1', secondJob.id)
      assert.equal(current.status, 'failed')
      assert.equal(runSourcePaths.length, 4)
      assert.equal(runSourcePaths[2], secondSourcePath)
      assert.notEqual(runSourcePaths[3], secondSourcePath)
      assert.equal(current.output.some((entry) => entry.text.includes('Applying cached builtin-profile compatibility fallback for process profile')), false)
      assert.equal(current.output.some((entry) => entry.text.includes('Retrying slicer without incompatible built-in process profile')), true)
    })
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

function makeRequest(): CreateSlicingJob {
  return {
    sourceFileId: 'file-1',
    target: {
      mode: 'manualProfile',
      printerProfileId: 'printer-profile',
      printerModel: 'X1C',
      processProfileId: 'process-profile',
      filamentMappings: []
    },
    plate: 1
  }
}

function makeOutput(stream: SlicingOutputLine['stream'], text: string): SlicingOutputLine {
  return {
    stream,
    text,
    createdAt: new Date().toISOString()
  }
}

async function waitFor(assertion: () => void | Promise<void>, timeoutMs = 3_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      await assertion()
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  await assertion()
}

async function createTestThreeMf(filePath: string, projectSettings: Record<string, unknown>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const zip = new yazl.ZipFile()
    const output = createWriteStream(filePath)
    zip.outputStream.pipe(output)
    zip.outputStream.on('error', reject)
    output.on('error', reject)
    output.on('finish', () => resolve())
    zip.addBuffer(Buffer.from(JSON.stringify(projectSettings, null, 2), 'utf8'), 'Metadata/project_settings.config')
    zip.addBuffer(Buffer.from('placeholder', 'utf8'), 'Metadata/slice_info.config')
    zip.end()
  })
}