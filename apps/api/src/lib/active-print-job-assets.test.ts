import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, test } from 'node:test'
import { buildPlateGcodeFileHint } from '@printstream/shared'
import { rootPrisma } from './prisma.js'
import { restorePrismaMethodsAfterEach } from '../test-utils/prisma-stubs.js'
import { getActivePrintJobAssets } from './active-print-job-assets.js'

const tempDirs = new Set<string>()

restorePrismaMethodsAfterEach([[rootPrisma.printJob, 'findMany']])

afterEach(async () => {
  await Promise.all(Array.from(tempDirs, async (dir) => rm(dir, { recursive: true, force: true })))
  tempDirs.clear()
})

test('getActivePrintJobAssets resolves the local library file for the matching active job', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-active-job-assets-'))
  tempDirs.add(tempDir)
  const localPath = path.join(tempDir, 'cube.gcode.3mf')
  await writeFile(localPath, Buffer.from('3mf'))

  Object.defineProperty(rootPrisma.printJob, 'findMany', {
    value: async () => [{
      id: 'job-1',
      jobName: 'Target job',
      plate: 24,
      printerFilePath: '/cache/Cube.gcode.3mf',
      thumbnailPath: 'job-1.png',
      sourceType: 'library',
      startedAt: new Date('2026-05-13T19:03:36.329Z'),
      file: { ownerBridgeId: null, storedPath: localPath }
    }],
    configurable: true
  })

  const result = await getActivePrintJobAssets('printer-1', 'task-1', {
    resolveLocalPath: async (file) => file.storedPath
  })

  assert.deepEqual(result, {
    jobId: 'job-1',
    jobName: 'Target job',
    plate: 24,
    printerFilePath: '/cache/Cube.gcode.3mf',
    thumbnailPath: 'job-1.png',
    localSourcePath: localPath
  })
})

test('getActivePrintJobAssets resolves a local cache path for bridge-owned files', async () => {
  let resolveCalls = 0

  Object.defineProperty(rootPrisma.printJob, 'findMany', {
    value: async () => [{
      id: 'job-bridge',
      jobName: 'Bridge job',
      plate: 3,
      printerFilePath: null,
      thumbnailPath: 'job-bridge.png',
      sourceType: 'library',
      startedAt: new Date('2026-05-13T19:03:36.329Z'),
      file: { ownerBridgeId: 'bridge-1', storedPath: 'bridge-widget.3mf' }
    }],
    configurable: true
  })

  const result = await getActivePrintJobAssets('printer-1', 'task-bridge', {
    resolveLocalPath: async () => {
      resolveCalls += 1
      return '/tmp/bridge-cache/bridge-widget.3mf'
    }
  })

  assert.equal(resolveCalls, 1)
  assert.deepEqual(result, {
    jobId: 'job-bridge',
    jobName: 'Bridge job',
    plate: 3,
    printerFilePath: null,
    thumbnailPath: 'job-bridge.png',
    localSourcePath: '/tmp/bridge-cache/bridge-widget.3mf'
  })
})

test('getActivePrintJobAssets prefers the library-backed row when duplicate task ids exist', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-active-job-assets-'))
  tempDirs.add(tempDir)
  const localPath = path.join(tempDir, 'best-shot.gcode.3mf')
  await writeFile(localPath, Buffer.from('3mf'))

  Object.defineProperty(rootPrisma.printJob, 'findMany', {
    value: async () => [
      {
        id: 'external-1',
        jobName: 'plate_4',
        plate: null,
        printerFilePath: null,
        thumbnailPath: null,
        sourceType: 'external',
        startedAt: new Date('2026-05-13T19:04:20.830Z'),
        file: null
      },
      {
        id: 'library-1',
        jobName: 'Best Shot Golf - plate_4',
        plate: 4,
        printerFilePath: '/Best Shot Golf - plate_4.gcode.3mf',
        thumbnailPath: 'job-1.png',
        sourceType: 'library',
        startedAt: new Date('2026-05-13T19:03:36.329Z'),
        file: { ownerBridgeId: null, storedPath: localPath }
      }
    ],
    configurable: true
  })

  const result = await getActivePrintJobAssets('printer-1', 'task-1', {
    resolveLocalPath: async (file) => file.storedPath
  })

  assert.deepEqual(result, {
    jobId: 'library-1',
    jobName: 'Best Shot Golf - plate_4',
    plate: 4,
    printerFilePath: '/Best Shot Golf - plate_4.gcode.3mf',
    thumbnailPath: 'job-1.png',
    localSourcePath: localPath
  })
})

test('getActivePrintJobAssets returns null when there is no unfinished row for the tracked task', async () => {
  Object.defineProperty(rootPrisma.printJob, 'findMany', {
    value: async () => [],
    configurable: true
  })

  const result = await getActivePrintJobAssets('printer-1', 'missing-task')

  assert.equal(result, null)
})

test('getActivePrintJobAssets returns null when there is no tracked task id', async () => {
  const result = await getActivePrintJobAssets('printer-1', null)

  assert.equal(result, null)
})

test('getActivePrintJobAssets reads active jobs through rootPrisma for background-safe lookups', async () => {
  let rootFindManyCalls = 0

  Object.defineProperty(rootPrisma.printJob, 'findMany', {
    value: async () => {
      rootFindManyCalls += 1
      return []
    },
    configurable: true
  })

  const result = await getActivePrintJobAssets('printer-1', 'task-1')

  assert.equal(result, null)
  assert.equal(rootFindManyCalls, 1)
})

test('buildPlateGcodeFileHint derives a Metadata plate path', () => {
  assert.equal(buildPlateGcodeFileHint(24), 'Metadata/plate_24.gcode')
  assert.equal(buildPlateGcodeFileHint(null), null)
  assert.equal(buildPlateGcodeFileHint(0), null)
})