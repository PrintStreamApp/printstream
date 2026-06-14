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