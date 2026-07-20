process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import { SlicerClient, SlicerServiceError } from './slicer-client.js'

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
  let seenEnvelope: string | undefined
  const server = createServer((request, response) => {
    seenContentLength = request.headers['content-length']
    seenEnvelope = typeof request.headers['x-printstream-slice-request'] === 'string' ? request.headers['x-printstream-slice-request'] : undefined
    request.resume()
    request.on('end', () => {
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

    assert.equal(seenContentLength, String(sourceBytes.byteLength))
    assert.equal(typeof seenEnvelope, 'string')
    assert.equal(result.outputFileName, 'result.gcode.3mf')
    assert.equal(result.output.length, 1)
    assert.equal(await readFile(result.artifactPath, 'utf8'), artifactBytes.toString('utf8'))
    cleanupPaths.add(path.dirname(result.artifactPath))
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
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
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
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
    assert.equal(progressA?.[0]?.text, 'instance-a')
    assert.equal(progressB?.[0]?.text, 'instance-b')

    stubA.releaseSlices()
    stubB.releaseSlices()
    const [resultA, resultB] = await Promise.all([runA, runB])
    cleanupPaths.add(path.dirname(resultA.artifactPath))
    cleanupPaths.add(path.dirname(resultB.artifactPath))

    // Once a job completes, its instance binding is dropped and progress is a no-op.
    assert.equal(await client.progress('job-a'), null)
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
    const envelope = typeof request.headers['x-printstream-slice-request'] === 'string' ? request.headers['x-printstream-slice-request'] : ''
    const parsed = JSON.parse(Buffer.from(envelope, 'base64url').toString('utf8')) as { jobId?: string }
    request.resume()
    request.on('end', () => {
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
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
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
// the slice dialog — `filamentIsSupport` reached the API and never reached the
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
        // A custom preset from the slicer would shadow tenant storage; still dropped.
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
    server.close()
  }
})
