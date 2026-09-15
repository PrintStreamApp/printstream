process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import { closeEphemeralServer } from '../test-utils/http-test-server.js'
import { SlicerClient, SlicerServiceError } from './slicer-client.js'
import {
  readPortableMachineBedAsset,
  setPortableMachineBedAsset,
  SLICE_UPLOAD_FRAME_HEADER_BYTES,
  SLICE_UPLOAD_FRAME_MAGIC,
  type ProcessConfig,
  type SliceUploadManifest
} from '@printstream/shared'

const cleanupPaths = new Set<string>()

afterEach(async () => {
  for (const cleanupPath of cleanupPaths) {
    await rm(cleanupPath, { recursive: true, force: true }).catch(() => undefined)
    cleanupPaths.delete(cleanupPath)
  }
})

test('slicer client streams slice responses to disk with content length', async () => {
  const sourceDir = await mkdtemp(path.join(tmpdir(), 'printstream-slicer-client-test-'))
  cleanupPaths.add(sourceDir)
  const sourcePath = path.join(sourceDir, 'input.3mf')
  const sourceBytes = Buffer.from('input-bytes')
  await writeFile(sourcePath, sourceBytes)

  const artifactBytes = Buffer.from('artifact-bytes')
  let seenContentLength: string | undefined
  let seenBody = Buffer.alloc(0)
  const server = createServer((request, response) => {
    seenContentLength = request.headers['content-length']
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      seenBody = Buffer.concat(chunks)
      response.statusCode = 200
      response.setHeader('Content-Type', 'application/octet-stream')
      response.setHeader('Content-Length', String(artifactBytes.byteLength))
      response.setHeader('X-PrintStream-Output-File-Name', encodeURIComponent('result.gcode.3mf'))
      response.setHeader('X-PrintStream-Output-Lines', Buffer.from(JSON.stringify([
        { stream: 'system', text: 'Collecting sliced artifact', createdAt: new Date().toISOString() }
      ]), 'utf8').toString('base64url'))
      response.end(artifactBytes)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))

  try {
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const client = new SlicerClient(`http://127.0.0.1:${address.port}`)
    const result = await client.run({
      jobId: 'job-1',
      sourceFileName: 'input.3mf',
      sourcePath,
      request: makeRequest(),
      signal: new AbortController().signal
    })

    assert.equal(seenContentLength, String(seenBody.byteLength))
    assert.equal(requestFrame(seenBody).manifest.envelope.jobId, 'job-1')
    assert.deepEqual(requestFrame(seenBody).source, sourceBytes)
    assert.equal(result.outputFileName, 'result.gcode.3mf')
    assert.equal(result.output.length, 1)
    assert.equal(await readFile(result.artifactPath, 'utf8'), artifactBytes.toString('utf8'))
    cleanupPaths.add(path.dirname(result.artifactPath))
  } finally {
    await closeEphemeralServer(server)
  }
})

test('slicer client moves portable bed assets out of the manifest and sends their raw bytes', async () => {
  const sourceDir = await mkdtemp(path.join(tmpdir(), 'printstream-slicer-client-assets-'))
  cleanupPaths.add(sourceDir)
  const sourcePath = path.join(sourceDir, 'input.3mf')
  const sourceBytes = Buffer.from('project')
  await writeFile(sourcePath, sourceBytes)

  // Two maximum-sized assets previously made the base64 request header ~3.7 MB and guaranteed a
  // 431 response against the slicer's 2 MB cap. The framed manifest must stay small instead.
  const modelBytes = Buffer.alloc(1024 * 1024, 1)
  const textureBytes = Buffer.alloc(1024 * 1024, 2)
  let config = setPortableMachineBedAsset({}, 'model', { name: 'bed.stl', bytes: modelBytes })
  config = setPortableMachineBedAsset(config, 'texture', { name: 'bed.svg', bytes: textureBytes })
  let seenBody = Buffer.alloc(0)
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      seenBody = Buffer.concat(chunks)
      response.statusCode = 200
      response.setHeader('Content-Length', '1')
      response.end('x')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))

  try {
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const client = new SlicerClient(`http://127.0.0.1:${address.port}`)
    const result = await client.run({
      jobId: 'job-assets',
      sourceFileName: 'input.3mf',
      sourcePath,
      request: makeRequest(),
      profileFiles: [{
        id: 'custom:machine',
        source: 'custom',
        kind: 'machine',
        name: 'Custom machine',
        content: JSON.stringify(config)
      }],
      signal: new AbortController().signal
    })
    cleanupPaths.add(path.dirname(result.artifactPath))

    const frame = requestFrame(seenBody)
    assert.ok(Buffer.byteLength(JSON.stringify(frame.manifest), 'utf8') < 16 * 1024)
    assert.deepEqual(frame.manifest.bedAssets.map((asset) => [asset.kind, asset.byteLength]), [
      ['model', modelBytes.byteLength],
      ['texture', textureBytes.byteLength]
    ])
    const transferredProfile = frame.manifest.envelope.profileFiles?.[0]
    const transferredConfig = JSON.parse(transferredProfile?.content ?? '{}') as ProcessConfig
    assert.equal(readPortableMachineBedAsset(transferredConfig, 'model'), null)
    assert.equal(readPortableMachineBedAsset(transferredConfig, 'texture'), null)
    assert.deepEqual(frame.assets, [modelBytes, textureBytes])
    assert.deepEqual(frame.source, sourceBytes)
  } finally {
    await closeEphemeralServer(server)
  }
})

test('slicer client surfaces structured worker errors', async () => {
  const sourceDir = await mkdtemp(path.join(tmpdir(), 'printstream-slicer-client-test-'))
  cleanupPaths.add(sourceDir)
  const sourcePath = path.join(sourceDir, 'input.3mf')
  await writeFile(sourcePath, 'input-bytes')

  const server = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      response.statusCode = 500
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({
        error: 'Slicer CLI exited with code 251',
        output: [{ stream: 'stderr', text: 'from unsupported', createdAt: new Date().toISOString() }]
      }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))

  try {
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const client = new SlicerClient(`http://127.0.0.1:${address.port}`)
    await assert.rejects(
      () => client.run({
        jobId: 'job-2',
        sourceFileName: 'input.3mf',
        sourcePath,
        request: makeRequest(),
        signal: new AbortController().signal
      }),
      (error: unknown) => {
        assert.ok(error instanceof SlicerServiceError)
        assert.equal(error.message, 'Slicer CLI exited with code 251')
        assert.equal(error.output[0]?.text, 'from unsupported')
        return true
      }
    )
  } finally {
    await closeEphemeralServer(server)
  }
})

test('slicer client spreads concurrent slices across instances and routes progress to the owning one', async () => {
  const sourceDir = await mkdtemp(path.join(tmpdir(), 'printstream-slicer-client-test-'))
  cleanupPaths.add(sourceDir)
  const sourcePath = path.join(sourceDir, 'input.3mf')
  await writeFile(sourcePath, 'input-bytes')

  const stubA = await createSlicerStub('instance-a')
  const stubB = await createSlicerStub('instance-b')

  try {
    const client = new SlicerClient([stubA.url, `${stubB.url}/`])

    const runA = client.run({
      jobId: 'job-a',
      sourceFileName: 'input.3mf',
      sourcePath,
      request: makeRequest(),
      signal: new AbortController().signal
    })
    const runB = client.run({
      jobId: 'job-b',
      sourceFileName: 'input.3mf',
      sourcePath,
      request: makeRequest(),
      signal: new AbortController().signal
    })

    // Wait until each instance holds one in-flight slice.
    await waitFor(() => stubA.sliceJobIds.length === 1 && stubB.sliceJobIds.length === 1)
    assert.deepEqual(stubA.sliceJobIds, ['job-a'])
    assert.deepEqual(stubB.sliceJobIds, ['job-b'])

    // Progress for each job must be read from the instance running it.
    const progressA = await client.progress('job-a')
    const progressB = await client.progress('job-b')
    assert.equal(progressA.kind === 'output' ? progressA.lines[0]?.text : null, 'instance-a')
    assert.equal(progressB.kind === 'output' ? progressB.lines[0]?.text : null, 'instance-b')

    stubA.releaseSlices()
    stubB.releaseSlices()
    const [resultA, resultB] = await Promise.all([runA, runB])
    cleanupPaths.add(path.dirname(resultA.artifactPath))
    cleanupPaths.add(path.dirname(resultB.artifactPath))

    // Once a job completes, its instance binding is dropped. That reports as `unclaimed`, NOT as a
    // lost slice: the watchdog must never fail a job for finishing normally.
    assert.deepEqual(await client.progress('job-a'), { kind: 'unclaimed' })
  } finally {
    await stubA.close()
    await stubB.close()
  }
})

test('slicer client reuses the free instance for sequential slices', async () => {
  const sourceDir = await mkdtemp(path.join(tmpdir(), 'printstream-slicer-client-test-'))
  cleanupPaths.add(sourceDir)
  const sourcePath = path.join(sourceDir, 'input.3mf')
  await writeFile(sourcePath, 'input-bytes')

  const stubA = await createSlicerStub('instance-a')
  const stubB = await createSlicerStub('instance-b')

  try {
    const client = new SlicerClient([stubA.url, stubB.url])
    for (const jobId of ['job-1', 'job-2', 'job-3']) {
      const run = client.run({
        jobId,
        sourceFileName: 'input.3mf',
        sourcePath,
        request: makeRequest(),
        signal: new AbortController().signal
      })
      await waitFor(() => stubA.sliceJobIds.length + stubB.sliceJobIds.length >= Number(jobId.slice(-1)))
      stubA.releaseSlices()
      stubB.releaseSlices()
      cleanupPaths.add(path.dirname((await run).artifactPath))
    }

    // With no overlap, the first (least-busy tie) instance takes every job.
    assert.deepEqual(stubA.sliceJobIds, ['job-1', 'job-2', 'job-3'])
    assert.deepEqual(stubB.sliceJobIds, [])
  } finally {
    await stubA.close()
    await stubB.close()
  }
})

/**
 * Minimal slicer-service stub: holds POST /slice responses until released (so
 * tests can observe in-flight assignment) and serves GET /jobs/:id progress
 * that names the instance, letting tests assert progress routing.
 */
// The one link no other test covers: every watchdog test above and in slicing-jobs.test.ts stubs
// `progress` and hands the watchdog a ready-made verdict, so nothing pins the mapping from an
// actual HTTP response to that verdict. If `/jobs/:id` were ever changed to answer 200-with-nothing
// for an unknown job -- a plausible tidy-up -- the classification would silently degrade to "no
// output yet", the watchdog would never fire again, and every existing test would still pass.
test('progress classifies a real 404 as a disowned job, not as silence', async () => {
  const sourceDir = await mkdtemp(path.join(tmpdir(), 'printstream-slicer-progress-test-'))
  cleanupPaths.add(sourceDir)
  const sourcePath = path.join(sourceDir, 'input.3mf')
  await writeFile(sourcePath, Buffer.from('input-bytes'))

  // Flipped between assertions instead of tearing the server down: killing the socket would also
  // fail the in-flight slice, and `run`'s finally would unbind the job, racing the assertion into
  // `unclaimed`.
  let jobsStatus = 404
  let sawSlice = false
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/jobs/')) {
      response.statusCode = jobsStatus
      response.end()
      return
    }
    // Never answered: the slice stays in flight, so the job stays bound to this instance.
    request.resume()
    request.on('end', () => { sawSlice = true })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address !== 'object') throw new Error('stub server has no address')

  const controller = new AbortController()
  try {
    const client = new SlicerClient(`http://127.0.0.1:${address.port}`)
    const running = client.run({
      jobId: 'job-lost',
      sourceFileName: 'input.3mf',
      sourcePath,
      request: makeRequest(),
      profileFiles: [],
      signal: controller.signal
    }).catch(() => null)
    await waitFor(() => sawSlice)

    // The instance is up and does not have this job: a restarted slicer. Conclusively lost.
    assert.deepEqual(await client.progress('job-lost'), { kind: 'unknown' })

    // A server error is NOT conclusive -- it gets the long grace, so it must not be reported as a
    // disowned job. A dead socket takes this same catch-and-classify path.
    jobsStatus = 503
    const sick = await client.progress('job-lost')
    assert.equal(sick.kind, 'unreachable')

    controller.abort()
    await running
  } finally {
    await closeEphemeralServer(server)
  }
})

async function createSlicerStub(name: string) {
  const sliceJobIds: string[] = []
  const pendingSlices: Array<() => void> = []
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/jobs/')) {
      response.statusCode = 200
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ output: [{ stream: 'system', text: name, createdAt: new Date().toISOString() }] }))
      return
    }
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const parsed = requestFrame(Buffer.concat(chunks)).manifest.envelope
      sliceJobIds.push(parsed.jobId ?? 'unknown')
      pendingSlices.push(() => {
        const artifactBytes = Buffer.from(`artifact-from-${name}`)
        response.statusCode = 200
        response.setHeader('Content-Type', 'application/octet-stream')
        response.setHeader('Content-Length', String(artifactBytes.byteLength))
        response.setHeader('X-PrintStream-Output-File-Name', encodeURIComponent('result.gcode.3mf'))
        response.end(artifactBytes)
      })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address !== 'object') throw new Error('stub server has no address')
  return {
    url: `http://127.0.0.1:${address.port}`,
    sliceJobIds,
    releaseSlices: () => {
      while (pendingSlices.length > 0) pendingSlices.shift()?.()
    },
    close: () => closeEphemeralServer(server)
  }
}

/** Decode enough of a framed request for transport assertions and HTTP stubs. */
function requestFrame(body: Buffer): { manifest: SliceUploadManifest; assets: Buffer[]; source: Buffer } {
  assert.equal(body.subarray(0, 4).toString('ascii'), SLICE_UPLOAD_FRAME_MAGIC)
  const manifestLength = body.readUInt32BE(4)
  const manifestEnd = SLICE_UPLOAD_FRAME_HEADER_BYTES + manifestLength
  const manifest = JSON.parse(body.subarray(SLICE_UPLOAD_FRAME_HEADER_BYTES, manifestEnd).toString('utf8')) as SliceUploadManifest
  const assets: Buffer[] = []
  let offset = manifestEnd
  for (const descriptor of manifest.bedAssets) {
    assets.push(body.subarray(offset, offset + descriptor.byteLength))
    offset += descriptor.byteLength
  }
  return { manifest, assets, source: body.subarray(offset) }
}

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function makeRequest() {
  return {
    sourceFileId: 'source-1',
    plate: 1,
    target: {
      mode: 'manualProfile' as const,
      printerModel: 'P1S',
      printerProfileId: 'project:machine:printer',
      processProfileId: 'project:process:process',
      filamentMappings: []
    }
  }
}
// Seam: slicer -> API -> browser. This hop used to rebuild each summary field by
// hand, so a field added to the shared schema was silently dropped on the way to
// the slice dialog: `filamentIsSupport` reached the API and never reached the
// picker, hiding every support preset (issue #66).
test('slicer client carries every schema field through, including the support flag and layer height', async () => {
  const server = createServer((request, response) => {
    if (!request.url?.startsWith('/profiles')) {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      profiles: [
        {
          id: 'builtin:filament:support-pla',
          source: 'builtin',
          kind: 'filament',
          name: 'Bambu Support For PLA @BBL H2D',
          filamentType: 'PLA',
          filamentIsSupport: true,
          filamentIds: ['GFS02'],
          filamentVendor: 'Bambu Lab',
          compatiblePrinters: ['Bambu Lab H2D 0.4 nozzle'],
          updatedAt: null
        },
        {
          id: 'builtin:process:standard',
          source: 'builtin',
          kind: 'process',
          name: '0.20mm Standard @BBL H2D',
          layerHeight: 0.2,
          updatedAt: null
        },
        // A custom preset from the slicer would shadow workspace storage; still dropped.
        { id: 'custom:nope', source: 'custom', kind: 'filament', name: 'Not the slicer’s to own' },
        // A malformed entry must not blank the whole catalogue.
        { id: '', source: 'builtin', kind: 'filament', name: '' }
      ]
    }))
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const port = (server.address() as { port: number }).port

  try {
    const client = new SlicerClient([`http://127.0.0.1:${port}`])
    const profiles = await client.profiles()

    assert.equal(profiles.length, 2)
    const filament = profiles.find((profile) => profile.kind === 'filament')
    assert.equal(filament?.filamentIsSupport, true)
    assert.equal(filament?.filamentType, 'PLA')
    assert.deepEqual(filament?.filamentIds, ['GFS02'])
    assert.equal(profiles.find((profile) => profile.kind === 'process')?.layerHeight, 0.2)
  } finally {
    await closeEphemeralServer(server)
  }
})
