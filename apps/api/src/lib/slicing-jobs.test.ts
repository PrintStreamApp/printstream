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
import { SlicingJobs, resolveSlicingSourcePath, type AuthorSliceSettings, type PersistSlicedArtifact, type ResolveSlicingSource } from './slicing-jobs.js'
import { readEntry } from './three-mf.js'

// These suites slice from fixture paths that don't exist on disk and mock the
// slicer, so use the persisted path as-is rather than re-resolving from the DB.
// (Re-resolution itself is covered by the resolveSlicingSourcePath tests.)
const passthroughResolveSource: ResolveSlicingSource = async ({ sourcePath }) => sourcePath

// The settings-authoring step reaches the slicer's profile resolver and the workspace's stored
// presets, neither of which exists here. Its own behaviour is covered by
// slice-settings-authoring.test.ts; returning null is the "nothing to author" path, so the chain
// slices the file it already had. The test below drives the authored path explicitly.
const noAuthoring: AuthorSliceSettings = async () => null

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
  const jobs = new SlicingJobs({ resolveSource: passthroughResolveSource, authorSliceSettings: noAuthoring })
  let releaseRun: (() => void) | undefined
  const runReleased = new Promise<void>((resolve) => {
    releaseRun = resolve
  })
  let progressCalls = 0

  slicerClient.isConfigured = (() => true) as typeof slicerClient.isConfigured
  slicerClient.progress = (async () => {
    progressCalls += 1
    if (progressCalls < 2) return { kind: 'output', lines: [] }
    return { kind: 'output', lines: [makeOutput('stdout', 'Processing layer 12/248')] }
  }) as typeof slicerClient.progress
  slicerClient.run = (async () => {
    await runReleased
    throw new SlicerServiceError('Slicing failed', [])
  }) as typeof slicerClient.run

  const job = jobs.enqueue({
    workspaceId: 'workspace-1',
    workspace: { id: 'workspace-1', slug: 'alpha', name: 'Alpha' },
    sourceFileId: 'file-1',
    sourceFileName: 'part.3mf',
    sourcePath: '/tmp/part.3mf',
    targetBridgeId: null,
    request: makeRequest()
  })

  await waitFor(async () => {
    const current = jobs.get('workspace-1', job.id)
    assert.equal(current.status, 'slicing')
    assert.equal(current.output.some((entry) => entry.text === 'Processing layer 12/248'), true)
  })

  if (releaseRun) releaseRun()

  await waitFor(async () => {
    const current = jobs.get('workspace-1', job.id)
    assert.equal(current.status, 'failed')
    assert.equal(current.error, 'Slicing failed')
  })
})

test('slicing jobs log lifecycle changes and CLI output lines', async () => {
  const jobs = new SlicingJobs({ resolveSource: passthroughResolveSource, authorSliceSettings: noAuthoring })
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
  slicerClient.progress = (async () => ({ kind: 'output', lines: [
    makeOutput('stdout', 'Processing layer 12/248'),
    makeOutput('stderr', 'warning: unsupported seam hint')
  ] })) as typeof slicerClient.progress
  slicerClient.run = (async () => {
    await runReleased
    throw new SlicerServiceError('Slicing failed', [])
  }) as typeof slicerClient.run

  const job = jobs.enqueue({
    workspaceId: 'workspace-1',
    workspace: { id: 'workspace-1', slug: 'alpha', name: 'Alpha' },
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
  const jobs = new SlicingJobs({ progressPollIntervalMs: 10, progressHeartbeatIntervalMs: 20, resolveSource: passthroughResolveSource, authorSliceSettings: noAuthoring })
  let releaseRun: (() => void) | undefined
  const runReleased = new Promise<void>((resolve) => {
    releaseRun = resolve
  })

  slicerClient.isConfigured = (() => true) as typeof slicerClient.isConfigured
  slicerClient.progress = (async () => ({ kind: 'unclaimed' })) as typeof slicerClient.progress
  slicerClient.run = (async () => {
    await runReleased
    throw new SlicerServiceError('Slicing failed', [])
  }) as typeof slicerClient.run

  const job = jobs.enqueue({
    workspaceId: 'workspace-1',
    workspace: { id: 'workspace-1', slug: 'alpha', name: 'Alpha' },
    sourceFileId: 'file-1',
    sourceFileName: 'part.3mf',
    sourcePath: '/tmp/part.3mf',
    targetBridgeId: null,
    request: makeRequest()
  })

  await waitFor(async () => {
    const current = jobs.get('workspace-1', job.id)
    assert.equal(current.output.some((entry) => entry.text.includes('Slicing...')), true)
  })

  if (releaseRun) releaseRun()

  await waitFor(async () => {
    const current = jobs.get('workspace-1', job.id)
    assert.equal(current.status, 'failed')
  })
})

test('a slice the slicer stops acknowledging fails with the real reason, not a hang or a cancel', async () => {
  // The scenario this exists for: the slicer service restarts mid-slice. Its POST can sit
  // half-open until the 30-minute ceiling, so the progress channel is the only prompt signal —
  // and it used to be discarded while the job kept claiming it was slicing.
  const jobs = new SlicingJobs({
    progressPollIntervalMs: 5,
    progressHeartbeatIntervalMs: 10,
    lostUnknownGraceMs: 20,
    resolveSource: passthroughResolveSource, authorSliceSettings: noAuthoring
  })
  let aborted: AbortSignal | undefined

  slicerClient.isConfigured = (() => true) as typeof slicerClient.isConfigured
  // The instance is up and has never heard of this job.
  slicerClient.progress = (async () => ({ kind: 'unknown' })) as typeof slicerClient.progress
  slicerClient.run = ((async (input: { signal?: AbortSignal }) => {
    aborted = input.signal
    // Never resolves on its own — only the watchdog's abort can end this slice, which is the
    // half-open socket the ceiling would otherwise cover for.
    await new Promise<void>((resolve) => input.signal?.addEventListener('abort', () => resolve(), { once: true }))
    throw new Error('The operation was aborted')
  })) as unknown as typeof slicerClient.run

  const job = jobs.enqueue({
    workspaceId: 'workspace-1',
    workspace: { id: 'workspace-1', slug: 'alpha', name: 'Alpha' },
    sourceFileId: 'file-1',
    sourceFileName: 'part.3mf',
    sourcePath: '/tmp/part.3mf',
    targetBridgeId: null,
    request: makeRequest()
  })

  await waitFor(async () => {
    const current = jobs.get('workspace-1', job.id)
    assert.equal(current.status, 'failed')
  })
  const finished = jobs.get('workspace-1', job.id)
  assert.notEqual(finished.status, 'cancelled', 'a lost slice must not be blamed on the user')
  assert.match(finished.error ?? '', /slicer service restarted/i)
  assert.equal(aborted?.aborted, true, 'the slice request itself must be aborted, not left running')
  // The heartbeat must never have claimed progress while the slicer was disowning the job.
  assert.equal(finished.output.some((entry) => entry.text.includes('Slicing...')), false)
  assert.equal(finished.output.some((entry) => entry.text.includes('no longer tracking this job')), true)
})

test('slicing jobs reload persisted history after restart', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'slicing-jobs-state-'))
  const stateFilePath = path.join(tempDir, 'state.json')
  const options = {
    progressPollIntervalMs: 10,
    progressHeartbeatIntervalMs: 10,
    persistState: true,
    stateFilePath,
    resolveSource: passthroughResolveSource, authorSliceSettings: noAuthoring
  }

  slicerClient.isConfigured = (() => true) as typeof slicerClient.isConfigured
  slicerClient.progress = (async () => ({ kind: 'unclaimed' })) as typeof slicerClient.progress
  slicerClient.run = (async () => {
    throw new SlicerServiceError('Slicing failed', [])
  }) as typeof slicerClient.run

  const first = new SlicingJobs(options)
  const queued = first.enqueue({
    workspaceId: 'workspace-1',
    workspace: { id: 'workspace-1', slug: 'alpha', name: 'Alpha' },
    sourceFileId: 'file-1',
    sourceFileName: 'part.3mf',
    sourcePath: '/tmp/part.3mf',
    targetBridgeId: null,
    request: makeRequest()
  })

  try {
    await waitFor(async () => {
      const current = first.get('workspace-1', queued.id)
      assert.equal(current.status, 'failed')
    })

    await waitFor(async () => {
      const raw = await readFile(stateFilePath, 'utf8')
      assert.equal(raw.includes(queued.id), true)
    })

    const reloaded = new SlicingJobs(options)
    const list = reloaded.list('workspace-1')
    assert.equal(list.length, 1)
    assert.equal(list[0]?.id, queued.id)
    assert.equal(list[0]?.status, 'failed')
    assert.equal(list[0]?.error, 'Slicing failed')
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('listActive drops finished jobs older than the recency window while list keeps them', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'slicing-jobs-active-'))
  const stateFilePath = path.join(tempDir, 'state.json')
  const options = {
    progressPollIntervalMs: 10,
    progressHeartbeatIntervalMs: 10,
    persistState: true,
    stateFilePath,
    resolveSource: passthroughResolveSource, authorSliceSettings: noAuthoring
  }

  slicerClient.isConfigured = (() => true) as typeof slicerClient.isConfigured
  slicerClient.progress = (async () => ({ kind: 'unclaimed' })) as typeof slicerClient.progress
  slicerClient.run = (async () => {
    throw new SlicerServiceError('Slicing failed', [])
  }) as typeof slicerClient.run

  const first = new SlicingJobs(options)
  const queued = first.enqueue({
    workspaceId: 'workspace-1',
    workspace: { id: 'workspace-1', slug: 'alpha', name: 'Alpha' },
    sourceFileId: 'file-1',
    sourceFileName: 'part.3mf',
    sourcePath: '/tmp/part.3mf',
    targetBridgeId: null,
    request: makeRequest()
  })

  try {
    await waitFor(async () => {
      assert.equal(first.get('workspace-1', queued.id).status, 'failed')
    })
    await waitFor(async () => {
      const raw = await readFile(stateFilePath, 'utf8')
      assert.equal(raw.includes(queued.id), true)
    })

    // Age a CLONE of the real persisted record far past the recency window, then rehydrate —
    // the store never exposes a way to backdate a live job, and hand-writing a record from
    // scratch would drift from the persisted shape the hydrator actually accepts.
    const persisted = JSON.parse(await readFile(stateFilePath, 'utf8')) as { jobs: Array<Record<string, unknown>> }
    const template = persisted.jobs[0]
    assert.ok(template)
    const aged = '2026-01-01T00:00:00.000Z'
    persisted.jobs.push({ ...template, id: 'old-finished-job', createdAt: aged, updatedAt: aged, startedAt: aged, finishedAt: aged })
    await writeFile(stateFilePath, JSON.stringify(persisted), 'utf8')

    const reloaded = new SlicingJobs(options)
    assert.deepEqual(reloaded.list('workspace-1').map((job) => job.id).sort(), ['old-finished-job', queued.id].sort())
    assert.deepEqual(reloaded.listActive('workspace-1').map((job) => job.id), [queued.id])
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('slicing jobs persist slice-to-print artifacts as hidden files', async () => {
  const persistedInputs: Array<{ hidden: boolean; folderId: string | null; fileName: string }> = []
  const jobs = new SlicingJobs({
    progressPollIntervalMs: 10,
    progressHeartbeatIntervalMs: 10_000,
    resolveSource: passthroughResolveSource, authorSliceSettings: noAuthoring,
    persistArtifact: async (input) => {
      persistedInputs.push({ hidden: input.hidden, folderId: input.folderId, fileName: input.fileName })
      return {
        file: {
        id: 'hidden-output-file',
        workspaceId: input.workspaceId,
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
  slicerClient.progress = (async () => ({ kind: 'unclaimed' })) as typeof slicerClient.progress
  slicerClient.run = (async () => ({
    outputFileName: 'result.gcode.3mf',
    output: [],
    metadata: undefined,
    artifactPath
  })) as typeof slicerClient.run

  const job = jobs.enqueue({
    workspaceId: 'workspace-1',
    workspace: { id: 'workspace-1', slug: 'alpha', name: 'Alpha' },
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
      const current = jobs.get('workspace-1', job.id)
      assert.equal(current.status, 'ready')
      assert.equal(current.outputFileId, 'hidden-output-file')
      assert.equal(current.output.some((entry) => entry.text === 'Ready to print'), true)
    })

    assert.deepEqual(persistedInputs, [{ hidden: true, folderId: 'folder-1', fileName: 'result.gcode.3mf' }])
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('a successful slice keeps the project it handed the engine, linked to the output', async () => {
  // The project the CLI actually consumed lives in a temp dir that runSlicerJob deletes on
  // the way out, so this asserts the preserved bytes are read WHILE they still exist and are
  // the prepared project — not the library file, and not the sliced G-code.
  const preserved: Array<{ bytes: string; fileName: string; outputId: string; settings: unknown }> = []
  const jobs = new SlicingJobs({
    progressPollIntervalMs: 10,
    progressHeartbeatIntervalMs: 10_000,
    resolveSource: passthroughResolveSource, authorSliceSettings: noAuthoring,
    persistArtifact: async (input) => ({
      file: { id: 'output-file', ownerBridgeId: input.bridgeId, name: input.fileName },
      unchanged: false
    } as Awaited<ReturnType<PersistSlicedArtifact>>),
    preserveProject: async (input) => {
      preserved.push({
        bytes: (await readFile(input.preparedProjectPath)).toString('utf8'),
        fileName: input.fileName,
        outputId: input.output.id,
        settings: input.settings
      })
      return 'project-snapshot'
    }
  })
  const tempDir = await mkdtemp(path.join(tmpdir(), 'slicing-jobs-preserve-'))
  const sourcePath = path.join(tempDir, 'part.3mf')
  const artifactPath = path.join(tempDir, 'result.gcode.3mf')
  await writeFile(sourcePath, 'prepared project bytes')
  await createTestThreeMf(artifactPath, { printer_settings_id: 'Bambu Lab X1C 0.4 nozzle' })

  slicerClient.isConfigured = (() => true) as typeof slicerClient.isConfigured
  slicerClient.progress = (async () => ({ kind: 'unclaimed' })) as typeof slicerClient.progress
  slicerClient.run = (async () => ({
    outputFileName: 'result.gcode.3mf',
    output: [],
    metadata: undefined,
    artifactPath
  })) as typeof slicerClient.run

  const job = jobs.enqueue({
    workspaceId: 'workspace-1',
    workspace: { id: 'workspace-1', slug: 'alpha', name: 'Alpha' },
    sourceFileId: 'file-1',
    sourceFileName: 'part.3mf',
    sourcePath,
    targetBridgeId: 'bridge-1',
    request: { ...makeRequest(), plate: 2 }
  })

  try {
    await waitFor(async () => {
      assert.equal(jobs.get('workspace-1', job.id).status, 'ready')
    })
    assert.equal(preserved.length, 1)
    assert.equal(preserved[0]?.bytes, 'prepared project bytes')
    // Named after the SOURCE project, not the .gcode.3mf it produced.
    assert.equal(preserved[0]?.fileName, 'part.3mf')
    assert.equal(preserved[0]?.outputId, 'output-file')
    // Only what re-slicing the preserved project needs; the scene is already baked into it.
    assert.deepEqual(preserved[0]?.settings, { target: makeRequest().target, plate: 2 })
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('the project the engine slices is the project that gets kept', async () => {
  // The whole reason settings authoring sits in the rewrite chain rather than in the preservation
  // step: whatever the chain produces must be BOTH what the CLI reads and what we keep. If the two
  // ever diverge, "slice again" reopens a project that never produced this print.
  let slicedPath: string | null = null
  const preserved: string[] = []
  const tempDir = await mkdtemp(path.join(tmpdir(), 'slicing-jobs-authored-'))
  // Its OWN directory: every entry in the chain's `rewrittenSourcePaths` has its containing dir
  // removed wholesale afterwards, so sharing one with the artifact deletes the artifact.
  const authoredDir = await mkdtemp(path.join(tmpdir(), 'slicing-jobs-authored-out-'))
  const sourcePath = path.join(tempDir, 'part.3mf')
  const authoredPath = path.join(authoredDir, 'authored.3mf')
  const artifactPath = path.join(tempDir, 'result.gcode.3mf')
  await writeFile(sourcePath, 'the project before authoring')
  await writeFile(authoredPath, 'the project WITH this slice\'s settings')
  await createTestThreeMf(artifactPath, { printer_settings_id: 'Bambu Lab X1C 0.4 nozzle' })

  const jobs = new SlicingJobs({
    progressPollIntervalMs: 10,
    progressHeartbeatIntervalMs: 10_000,
    resolveSource: passthroughResolveSource,
    authorSliceSettings: async () => authoredPath,
    persistArtifact: async (input) => ({
      file: { id: 'output-file', ownerBridgeId: input.bridgeId, name: input.fileName },
      unchanged: false
    } as Awaited<ReturnType<PersistSlicedArtifact>>),
    preserveProject: async (input) => {
      preserved.push((await readFile(input.preparedProjectPath)).toString('utf8'))
      return 'project-snapshot'
    }
  })

  slicerClient.isConfigured = (() => true) as typeof slicerClient.isConfigured
  slicerClient.progress = (async () => ({ kind: 'unclaimed' })) as typeof slicerClient.progress
  slicerClient.run = (async (input: { sourcePath: string }) => {
    slicedPath = input.sourcePath
    return { outputFileName: 'result.gcode.3mf', output: [], metadata: undefined, artifactPath }
  }) as unknown as typeof slicerClient.run

  const job = jobs.enqueue({
    workspaceId: 'workspace-1',
    workspace: { id: 'workspace-1', slug: 'alpha', name: 'Alpha' },
    sourceFileId: 'file-1',
    sourceFileName: 'part.3mf',
    sourcePath,
    targetBridgeId: 'bridge-1',
    request: makeRequest()
  })

  try {
    await waitFor(async () => {
      assert.equal(jobs.get('workspace-1', job.id).status, 'ready')
    })
    assert.equal(slicedPath, authoredPath, 'the engine reads the authored project, not the raw source')
    assert.deepEqual(preserved, ['the project WITH this slice\'s settings'], 'and that is what we keep')
  } finally {
    await rm(tempDir, { recursive: true, force: true })
    await rm(authoredDir, { recursive: true, force: true })
  }
})

test('a slice whose output is not persisted keeps no project', async () => {
  // Preserving is only safe once the output is durable: a snapshot row is never swept, so
  // one written for a slice that produced nothing would be unreferenced bytes forever.
  let preserveCalls = 0
  const jobs = new SlicingJobs({
    progressPollIntervalMs: 10,
    progressHeartbeatIntervalMs: 10_000,
    resolveSource: passthroughResolveSource, authorSliceSettings: noAuthoring,
    persistArtifact: async () => { throw new Error('bridge offline') },
    preserveProject: async () => { preserveCalls += 1; return 'project-snapshot' }
  })
  const tempDir = await mkdtemp(path.join(tmpdir(), 'slicing-jobs-preserve-skip-'))
  const sourcePath = path.join(tempDir, 'part.3mf')
  const artifactPath = path.join(tempDir, 'result.gcode.3mf')
  await writeFile(sourcePath, 'prepared project bytes')
  await createTestThreeMf(artifactPath, { printer_settings_id: 'Bambu Lab X1C 0.4 nozzle' })

  slicerClient.isConfigured = (() => true) as typeof slicerClient.isConfigured
  slicerClient.progress = (async () => ({ kind: 'unclaimed' })) as typeof slicerClient.progress
  slicerClient.run = (async () => ({
    outputFileName: 'result.gcode.3mf',
    output: [],
    metadata: undefined,
    artifactPath
  })) as typeof slicerClient.run

  const job = jobs.enqueue({
    workspaceId: 'workspace-1',
    workspace: { id: 'workspace-1', slug: 'alpha', name: 'Alpha' },
    sourceFileId: 'file-1',
    sourceFileName: 'part.3mf',
    sourcePath,
    targetBridgeId: 'bridge-1',
    request: makeRequest()
  })

  try {
    await waitFor(async () => {
      assert.equal(jobs.get('workspace-1', job.id).status, 'failed')
    })
    assert.equal(preserveCalls, 0)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('the job list carries a finished job as its outcome line alone', async () => {
  // The list is polled by every open tab and grows with history — measured at 471 KB over 194
  // jobs, of which `output` was 208 KB. A finished job is rendered from its LAST system line (its
  // outcome) and nothing else, so that is all the list ships. An ACTIVE job must keep stdout — its
  // progress frames come from there.
  const jobs = new SlicingJobs({ progressPollIntervalMs: 5, resolveSource: passthroughResolveSource, authorSliceSettings: noAuthoring })
  let releaseRun: (() => void) | undefined
  const runReleased = new Promise<void>((resolve) => { releaseRun = resolve })

  slicerClient.isConfigured = (() => true) as typeof slicerClient.isConfigured
  // The engine's own chatter only ever arrives on stdout/stderr.
  slicerClient.progress = (async () => ({ kind: 'output', lines: [
    makeOutput('stdout', '{"message":"Exporting 3mf","total_percent":97}')
  ] })) as typeof slicerClient.progress
  slicerClient.run = (async () => {
    await runReleased
    throw new SlicerServiceError('Slicing failed', [])
  }) as typeof slicerClient.run

  const job = jobs.enqueue({
    workspaceId: 'workspace-1',
    workspace: { id: 'workspace-1', slug: 'alpha', name: 'Alpha' },
    sourceFileId: 'file-1',
    sourceFileName: 'part.3mf',
    sourcePath: '/tmp/part.3mf',
    targetBridgeId: null,
    request: makeRequest()
  })

  await waitFor(async () => {
    const whileActive = jobs.list('workspace-1').find((entry) => entry.id === job.id)
    assert.equal(whileActive?.output.some((line) => line.stream === 'stdout'), true, 'a running job keeps its progress frames')
  })

  if (releaseRun) releaseRun()
  await waitFor(async () => {
    assert.equal(jobs.get('workspace-1', job.id).status, 'failed')
  })

  const listed = jobs.list('workspace-1').find((entry) => entry.id === job.id)
  assert.equal(listed?.output.some((line) => line.stream !== 'system'), false, 'a finished job ships no engine log')
  assert.equal(listed?.output.length, 1, 'exactly its outcome, not every status line it passed through')
  assert.equal(listed?.output[0]?.text, 'Slicing failed', 'and that outcome is the last line, not the first')
  assert.equal(
    listed?.output.some((line) => line.text === 'Preparing the project'),
    false,
    'the earlier status lines are dead weight once the job is over'
  )
  // The single-job route is still the full record, engine log included.
  const full = jobs.get('workspace-1', job.id)
  assert.equal(full.output.some((line) => line.stream === 'stdout'), true)
  assert.equal(full.output.some((line) => line.text === 'Preparing the project'), true)
})

test('closing the tab that started a slice cancels it, and leaves other tabs and finished jobs alone', async () => {
  const jobs = new SlicingJobs({ resolveSource: passthroughResolveSource, authorSliceSettings: noAuthoring })
  let releaseRun: (() => void) | undefined
  const runReleased = new Promise<void>((resolve) => { releaseRun = resolve })

  slicerClient.isConfigured = (() => true) as typeof slicerClient.isConfigured
  slicerClient.progress = (async () => ({ kind: 'unclaimed' })) as typeof slicerClient.progress
  slicerClient.run = (async () => {
    await runReleased
    throw new SlicerServiceError('Slicing failed', [])
  }) as typeof slicerClient.run

  const enqueueFor = (ownerClientId: string | undefined) => jobs.enqueue({
    workspaceId: 'workspace-1',
    workspace: { id: 'workspace-1', slug: 'alpha', name: 'Alpha' },
    sourceFileId: 'file-1',
    sourceFileName: 'part.3mf',
    sourcePath: '/tmp/part.3mf',
    targetBridgeId: null,
    request: { ...makeRequest(), ownerClientId }
  })

  const mine = enqueueFor('tab-1')
  const theirs = enqueueFor('tab-2')
  // A job with no owning tab (a script, an integration) is nobody's to reap.
  const unowned = enqueueFor(undefined)

  jobs.cancelForOwner('tab-1')

  assert.equal(jobs.get('workspace-1', mine.id).cancelRequested, true)
  assert.equal(jobs.get('workspace-1', theirs.id).cancelRequested, false, "another tab's slice is untouched")
  assert.equal(jobs.get('workspace-1', unowned.id).cancelRequested, false, 'an unowned slice is untouched')

  if (releaseRun) releaseRun()
  await waitFor(async () => {
    assert.equal(jobs.get('workspace-1', theirs.id).status, 'failed')
  })

  // A slice that already finished belongs to the user, not to the tab that started it.
  const finishedStatus = jobs.get('workspace-1', theirs.id).status
  jobs.cancelForOwner('tab-2')
  assert.equal(jobs.get('workspace-1', theirs.id).status, finishedStatus, 'a terminal job is never re-cancelled')
})

test('slicing jobs persist durable history thumbnails and clean them up on delete', async () => {
  const persistedThumbnailCalls: Array<{ jobId: string; preferredFileIds: Array<string | null | undefined>; plate: number }> = []
  const jobs = new SlicingJobs({
    progressPollIntervalMs: 10,
    progressHeartbeatIntervalMs: 10_000,
    resolveSource: passthroughResolveSource, authorSliceSettings: noAuthoring,
    persistArtifact: async (input) => ({
      file: {
      id: 'output-file-1',
      workspaceId: input.workspaceId,
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
  slicerClient.progress = (async () => ({ kind: 'unclaimed' })) as typeof slicerClient.progress
  slicerClient.run = (async () => ({
    outputFileName: 'result.gcode.3mf',
    output: [],
    metadata: undefined,
    artifactPath
  })) as typeof slicerClient.run

  const job = jobs.enqueue({
    workspaceId: 'workspace-1',
    workspace: { id: 'workspace-1', slug: 'alpha', name: 'Alpha' },
    sourceFileId: 'file-1',
    sourceFileName: 'part.3mf',
    sourcePath: '/tmp/part.3mf',
    targetBridgeId: 'bridge-1',
    request: makeRequest()
  })

  try {
    let thumbnailPath: string | null = null
    await waitFor(async () => {
      const current = jobs.get('workspace-1', job.id)
      assert.equal(current.status, 'ready')
      thumbnailPath = jobs.getThumbnailInfo('workspace-1', job.id).thumbnailPath
      assert.equal(typeof thumbnailPath, 'string')
    })

    assert.deepEqual(jobs.getThumbnailInfo('workspace-1', job.id), {
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
    await jobs.delete('workspace-1', job.id)
    assert.equal(await readPrintJobThumbnail(thumbnailPath), null)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('slicing jobs retry without incompatible builtin profiles after compatibility failures', async () => {
  const jobs = new SlicingJobs({ progressPollIntervalMs: 10, progressHeartbeatIntervalMs: 10_000, resolveSource: passthroughResolveSource, authorSliceSettings: noAuthoring })
  const runProfileCounts: number[] = []
  const runProfileKinds: string[][] = []
  const runJobIds: string[] = []

  slicerClient.isConfigured = (() => true) as typeof slicerClient.isConfigured
  slicerClient.progress = (async () => ({ kind: 'unclaimed' })) as typeof slicerClient.progress
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
    workspaceId: 'workspace-1',
    workspace: { id: 'workspace-1', slug: 'alpha', name: 'Alpha' },
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
    const current = jobs.get('workspace-1', job.id)
    assert.equal(current.status, 'failed')
    assert.equal(runProfileCounts.length, 2)
    assert.equal(runJobIds.length, 2)
    assert.notEqual(runJobIds[0], runJobIds[1])
    assert.deepEqual(runProfileKinds, [
      ['builtin:machine', 'custom:process'],
      ['custom:process']
    ])
    assert.equal(current.output.some((entry) => entry.text.includes('Retrying without the incompatible built-in machine profile')), true)
  })
})

test('slicing jobs retry when compatibility fallback matches generated builtin:machine profile file names', async () => {
  const jobs = new SlicingJobs({ progressPollIntervalMs: 10, progressHeartbeatIntervalMs: 10_000, resolveSource: passthroughResolveSource, authorSliceSettings: noAuthoring })
  const runProfileKinds: string[][] = []
  const runJobIds: string[] = []

  slicerClient.isConfigured = (() => true) as typeof slicerClient.isConfigured
  slicerClient.progress = (async () => ({ kind: 'unclaimed' })) as typeof slicerClient.progress
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
    workspaceId: 'workspace-1',
    workspace: { id: 'workspace-1', slug: 'alpha', name: 'Alpha' },
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
    const current = jobs.get('workspace-1', job.id)
    assert.equal(current.status, 'failed')
    assert.equal(runJobIds.length, 2)
    assert.notEqual(runJobIds[0], runJobIds[1])
    assert.deepEqual(runProfileKinds, [
      ['builtin:machine', 'custom:process'],
      ['custom:process']
    ])
    assert.equal(current.output.some((entry) => entry.text.includes('Retrying without the incompatible built-in machine profile')), true)
  })
})

test('slicing jobs retry without builtin machine/process after a settings-merge compatibility failure', async () => {
  // Regression: the slicer now fails fast (instead of segfaulting) when its project-settings
  // repair export hits CLI_PROCESS_NOT_COMPATIBLE (exit 239) — e.g. a stale slice dialog pairing
  // an X1C process with an H2D machine. That message must keep flowing into the existing
  // exit-239 compatibility fallback so the slice recovers onto the project's own presets.
  const jobs = new SlicingJobs({ progressPollIntervalMs: 10, progressHeartbeatIntervalMs: 10_000, resolveSource: passthroughResolveSource, authorSliceSettings: noAuthoring })
  const runProfileKinds: string[][] = []

  slicerClient.isConfigured = (() => true) as typeof slicerClient.isConfigured
  slicerClient.progress = (async () => ({ kind: 'unclaimed' })) as typeof slicerClient.progress
  slicerClient.run = (async (input) => {
    runProfileKinds.push((input.profileFiles ?? []).map((profile) => `${profile.source}:${profile.kind}`))
    if (runProfileKinds.length === 1) {
      throw new SlicerServiceError('Slicer CLI exited with code 239 while merging project settings for slicing (process not compatible with printer)', [])
    }
    throw new SlicerServiceError('Still failed after retry', [])
  }) as typeof slicerClient.run

  const job = jobs.enqueue({
    workspaceId: 'workspace-1',
    workspace: { id: 'workspace-1', slug: 'alpha', name: 'Alpha' },
    sourceFileId: 'file-1',
    sourceFileName: 'part.3mf',
    sourcePath: '/tmp/part.3mf',
    targetBridgeId: null,
    profileFiles: [
      { id: 'builtin-machine', source: 'builtin', kind: 'machine', name: 'Bambu Lab H2D 0.4 nozzle' },
      { id: 'builtin-process', source: 'builtin', kind: 'process', name: '0.20mm Standard @BBL X1C' },
      { id: 'builtin-filament', source: 'builtin', kind: 'filament', name: 'Bambu PETG Basic @BBL H2D 0.4 nozzle' }
    ],
    request: makeRequest()
  })

  await waitFor(async () => {
    const current = jobs.get('workspace-1', job.id)
    assert.equal(current.status, 'failed')
    // The retry dropped the builtin machine + process (the incompatible pair) but kept the filament.
    assert.deepEqual(runProfileKinds, [
      ['builtin:machine', 'builtin:process', 'builtin:filament'],
      ['builtin:filament']
    ])
    assert.equal(current.output.some((entry) => entry.text.includes('Retrying without the incompatible built-in')), true)
  })
})

test('slicing jobs retry a signal-death slicer exit once with unchanged inputs, then fail', async () => {
  // Exit 139 (SIGSEGV) et al. happen intermittently under qemu emulation on inputs that slice
  // clean when re-run; one bounded retry absorbs the flake without masking a deterministic crash.
  const jobs = new SlicingJobs({ progressPollIntervalMs: 10, progressHeartbeatIntervalMs: 10_000, resolveSource: passthroughResolveSource, authorSliceSettings: noAuthoring })
  const runJobIds: string[] = []

  slicerClient.isConfigured = (() => true) as typeof slicerClient.isConfigured
  slicerClient.progress = (async () => ({ kind: 'unclaimed' })) as typeof slicerClient.progress
  slicerClient.run = (async (input) => {
    runJobIds.push(input.jobId)
    throw new SlicerServiceError('Slicer CLI exited with code 139', [])
  }) as typeof slicerClient.run

  const job = jobs.enqueue({
    workspaceId: 'workspace-1',
    workspace: { id: 'workspace-1', slug: 'alpha', name: 'Alpha' },
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
    const current = jobs.get('workspace-1', job.id)
    assert.equal(current.status, 'failed')
    // Exactly one retry: two run attempts with distinct attempt job ids, then the crash surfaces.
    assert.equal(runJobIds.length, 2)
    assert.notEqual(runJobIds[0], runJobIds[1])
    assert.equal(current.output.some((entry) => entry.text.includes('The slicer crashed mid-run; retrying')), true)
    assert.match(current.error ?? '', /exited with code 139/)
  })
})

test('slicing jobs do not crash-retry ordinary non-signal slicer failures', async () => {
  const jobs = new SlicingJobs({ progressPollIntervalMs: 10, progressHeartbeatIntervalMs: 10_000, resolveSource: passthroughResolveSource, authorSliceSettings: noAuthoring })
  let runs = 0

  slicerClient.isConfigured = (() => true) as typeof slicerClient.isConfigured
  slicerClient.progress = (async () => ({ kind: 'unclaimed' })) as typeof slicerClient.progress
  slicerClient.run = (async () => {
    runs += 1
    throw new SlicerServiceError('Slicer CLI exited with code 1', [])
  }) as typeof slicerClient.run

  const job = jobs.enqueue({
    workspaceId: 'workspace-1',
    workspace: { id: 'workspace-1', slug: 'alpha', name: 'Alpha' },
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
    const current = jobs.get('workspace-1', job.id)
    assert.equal(current.status, 'failed')
    assert.equal(runs, 1)
  })
})

test('slicing jobs preserve manual machine/profile selections on retry after builtin machine removal', async () => {
  const jobs = new SlicingJobs({ progressPollIntervalMs: 10, progressHeartbeatIntervalMs: 10_000, resolveSource: passthroughResolveSource, authorSliceSettings: noAuthoring })
  const runJobIds: string[] = []
  const runMachineProfileIds: string[] = []
  const runProcessProfileIds: Array<string | null | undefined> = []
  const runFilamentMappingCounts: number[] = []
  const runProfileKinds: string[][] = []

  slicerClient.isConfigured = (() => true) as typeof slicerClient.isConfigured
  slicerClient.progress = (async () => ({ kind: 'unclaimed' })) as typeof slicerClient.progress
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
    workspaceId: 'workspace-1',
    workspace: { id: 'workspace-1', slug: 'alpha', name: 'Alpha' },
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
    const current = jobs.get('workspace-1', job.id)
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
    assert.equal(current.output.some((entry) => entry.text.includes('Retrying without the incompatible built-in machine profile')), true)
  })
})

test('slicing jobs rewrite project settings and retry when compatibility fallback matches process_full profiles', async () => {
  const jobs = new SlicingJobs({ progressPollIntervalMs: 10, progressHeartbeatIntervalMs: 10_000, resolveSource: passthroughResolveSource, authorSliceSettings: noAuthoring })
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
  slicerClient.progress = (async () => ({ kind: 'unclaimed' })) as typeof slicerClient.progress
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
    workspaceId: 'workspace-1',
    workspace: { id: 'workspace-1', slug: 'alpha', name: 'Alpha' },
    sourceFileId: 'file-1',
    sourceFileName: 'part.3mf',
    sourcePath,
    targetBridgeId: null,
    request: makeRequest()
  })

  try {
    await waitFor(async () => {
      const current = jobs.get('workspace-1', job.id)
      assert.equal(current.status, 'failed')
      assert.equal(runJobIds.length, 2)
      assert.notEqual(runSourcePaths[0], runSourcePaths[1])
      assert.equal(current.output.some((entry) => entry.text.includes('Retrying without the incompatible built-in process profile')), true)
    })
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('slicing jobs retry incompatible built-in machine profiles per job without caching across subsequent jobs', async () => {
  const jobs = new SlicingJobs({ progressPollIntervalMs: 10, progressHeartbeatIntervalMs: 10_000, resolveSource: passthroughResolveSource, authorSliceSettings: noAuthoring })
  const runProfileKinds: string[][] = []
  const runJobIds: string[] = []

  slicerClient.isConfigured = (() => true) as typeof slicerClient.isConfigured
  slicerClient.progress = (async () => ({ kind: 'unclaimed' })) as typeof slicerClient.progress
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
    workspaceId: 'workspace-1',
    workspace: { id: 'workspace-1', slug: 'alpha', name: 'Alpha' },
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
    const current = jobs.get('workspace-1', firstJob.id)
    assert.equal(current.status, 'failed')
    assert.equal(runJobIds.length, 2)
  })

  const secondJob = jobs.enqueue({
    workspaceId: 'workspace-1',
    workspace: { id: 'workspace-1', slug: 'alpha', name: 'Alpha' },
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
    const current = jobs.get('workspace-1', secondJob.id)
    assert.equal(current.status, 'failed')
    assert.equal(runJobIds.length, 4)
    assert.deepEqual(runProfileKinds, [
      ['builtin:machine'],
      [],
      ['builtin:machine'],
      []
    ])
    assert.equal(current.output.some((entry) => entry.text.includes('Applying cached builtin-profile compatibility fallback for machine profile')), false)
    assert.equal(current.output.some((entry) => entry.text.includes('Retrying without the incompatible built-in machine profile')), true)
  })
})

test('slicing jobs do not proactively rewrite process profiles on subsequent jobs', async () => {
  const jobs = new SlicingJobs({ progressPollIntervalMs: 10, progressHeartbeatIntervalMs: 10_000, resolveSource: passthroughResolveSource, authorSliceSettings: noAuthoring })
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
  slicerClient.progress = (async () => ({ kind: 'unclaimed' })) as typeof slicerClient.progress
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
    workspaceId: 'workspace-1',
    workspace: { id: 'workspace-1', slug: 'alpha', name: 'Alpha' },
    sourceFileId: 'file-1',
    sourceFileName: 'first.3mf',
    sourcePath: firstSourcePath,
    targetBridgeId: null,
    request: makeRequest()
  })

  try {
    await waitFor(async () => {
      const current = jobs.get('workspace-1', firstJob.id)
      assert.equal(current.status, 'failed')
      assert.equal(runSourcePaths.length, 2)
    })

    const secondJob = jobs.enqueue({
      workspaceId: 'workspace-1',
      workspace: { id: 'workspace-1', slug: 'alpha', name: 'Alpha' },
      sourceFileId: 'file-2',
      sourceFileName: 'second.3mf',
      sourcePath: secondSourcePath,
      targetBridgeId: null,
      request: makeRequest()
    })

    await waitFor(async () => {
      const current = jobs.get('workspace-1', secondJob.id)
      assert.equal(current.status, 'failed')
      assert.equal(runSourcePaths.length, 4)
      assert.equal(runSourcePaths[2], secondSourcePath)
      assert.notEqual(runSourcePaths[3], secondSourcePath)
      assert.equal(current.output.some((entry) => entry.text.includes('Applying cached builtin-profile compatibility fallback for process profile')), false)
      assert.equal(current.output.some((entry) => entry.text.includes('Retrying without the incompatible built-in process profile')), true)
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