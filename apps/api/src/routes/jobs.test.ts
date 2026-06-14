process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { createWriteStream } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import express from 'express'
import yazl from 'yazl'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { JOBS_DELETE_PERMISSION, JOBS_VIEW_PERMISSION } from '@printstream/shared'
import { jobsRouter } from './jobs.js'
import type { RequestAuthContext } from '../lib/auth-context.js'
import { HttpError } from '../lib/http-error.js'
import { prisma } from '../lib/prisma.js'
import { rootPrisma } from '../lib/prisma.js'
import type { RequestTenantSummary } from '../lib/tenant-context.js'
import { restorePrismaMethodsAfterEach } from '../test-utils/prisma-stubs.js'

const TEST_TENANT = { id: 'tenant-1', slug: 'tenant-1', name: 'Tenant 1' } as const

// Auto-restore the prisma/rootPrisma methods these tests override, replacing the per-test
// `const original*` + try/finally restore bookkeeping with one declarative list.
restorePrismaMethodsAfterEach([
  [prisma.printJob, 'findMany'],
  [prisma.printJob, 'findFirst'],
  [prisma.printJob, 'delete'],
  [prisma, '$queryRaw'],
  [rootPrisma.auditLog, 'findMany']
])

function readRecordedSql(query: unknown): string {
  if (
    typeof query === 'object'
    && query != null
    && 'strings' in query
    && Array.isArray((query as { strings?: unknown }).strings)
  ) {
    return ((query as { strings: string[] }).strings).join(' ')
  }

  return String(query)
}

test('jobs history falls back to the legacy query when calibration columns are missing', async () => {
  let recordedQuery: string | null = null

  Object.defineProperty(prisma.printJob, 'findMany', {
    value: async () => {
      throw { code: 'P2022' }
    },
    configurable: true
  })
  Object.defineProperty(prisma, '$queryRaw', {
    value: async (query: unknown) => {
      recordedQuery = readRecordedSql(query)

      return [
      {
        id: 'job-1',
        printerId: 'printer-1',
        printerName: 'Printer 1',
        jobName: 'Calibration',
        startedAt: new Date('2026-05-01T10:00:00.000Z'),
        finishedAt: new Date('2026-05-01T10:10:00.000Z'),
        progressPercent: null,
        durationSeconds: 600,
        result: 'success',
        fileId: null,
        fileName: null,
        fileSizeBytes: null,
        plate: null,
        useAms: null,
        bedLevel: null,
        amsMapping: null,
        thumbnailPath: null
      },
      {
        id: 'job-2',
        printerId: 'printer-1',
        printerName: 'Printer 1',
        jobName: 'Queued print',
        startedAt: new Date('2026-05-01T11:00:00.000Z'),
        finishedAt: null,
        progressPercent: 5,
        durationSeconds: null,
        result: 'unknown',
        fileId: 'file-1',
        fileName: 'Queued print.3mf',
        fileSizeBytes: 1024,
        plate: 1,
        useAms: true,
        bedLevel: true,
        amsMapping: '[0]',
        thumbnailPath: null
      }
    ]
    },
    configurable: true
  })

  await withJobsApp({
    auth: {
      authEnabled: true,
      actor: { type: 'user', userId: 'user-1' },
      permissions: [JOBS_VIEW_PERMISSION],
      runtimePolicy: { demoMode: false }
    },
    tenant: TEST_TENANT
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/jobs`)
    assert.equal(response.status, 200)
    const body = await response.json() as {
      jobs: Array<{
        finishedAt: string | null
        jobKind: string
        calibrationOption: number | null
        jobName: string
        snapshotPath: string | null
      }>
    }
    assert.equal(body.jobs.length, 2)
    assert.equal(body.jobs[0]?.jobName, 'Calibration')
    assert.equal(body.jobs[0]?.jobKind, 'external')
    assert.equal(body.jobs[0]?.calibrationOption, null)
    assert.equal(body.jobs[0]?.snapshotPath, null)
    assert.equal(body.jobs[1]?.jobName, 'Queued print')
    assert.equal(body.jobs[1]?.finishedAt, null)
    assert.match(recordedQuery ?? '', /printer\."tenantId"/)
  })
})

test('jobs history only returns jobs for the active tenant', async () => {
  let requestedWhere: unknown = null

  Object.defineProperty(prisma.printJob, 'findMany', {
    value: async (args: unknown) => {
      requestedWhere = (args as { where?: unknown }).where ?? null
      return []
    },
    configurable: true
  })

  await withJobsApp({
    auth: {
      authEnabled: true,
      actor: { type: 'user', userId: 'user-1' },
      permissions: [JOBS_VIEW_PERMISSION],
      runtimePolicy: { demoMode: false }
    },
    tenant: TEST_TENANT
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/jobs?printerId=printer-1`)

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { jobs: [] })
  })

  assert.deepEqual(requestedWhere, {
    printer: { tenantId: 'tenant-1' },
    printerId: 'printer-1'
  })
})

test('jobs history includes related audit activity', async () => {
  Object.defineProperty(prisma.printJob, 'findMany', {
    value: async () => ([{
      id: 'job-1',
      printerId: 'printer-1',
      printer: { name: 'Printer 1' },
      jobName: 'Queued print',
      startedAt: new Date('2026-05-01T11:00:00.000Z'),
      finishedAt: new Date('2026-05-01T11:10:00.000Z'),
      progressPercent: 100,
      durationSeconds: 600,
      result: 'success',
      fileId: 'file-1',
      fileName: 'Queued print.3mf',
      fileSizeBytes: 1024,
      plate: 1,
      useAms: true,
      bedLevel: true,
      amsMapping: '[0]',
      sourceType: 'library',
      calibrationOption: null,
      thumbnailPath: null,
      snapshotPath: null,
      file: null
    }]),
    configurable: true
  })
  Object.defineProperty(rootPrisma.auditLog, 'findMany', {
    value: async () => ([{
      id: 'audit-1',
      tenantId: 'tenant-1',
      actorType: 'user',
      actorLabel: 'Operator',
      requestMethod: 'POST',
      action: 'start-print',
      resource: 'print job',
      summary: 'Queued print Queued print on Printer 1.',
      statusCode: 202,
      metadataJson: JSON.stringify({ jobId: 'job-1', printerId: 'printer-1' }),
      createdAt: new Date('2026-05-01T11:00:05.000Z'),
      actorUserId: 'user-operator',
      actorServiceAccountId: null,
      actorUser: { email: 'operator@example.com', displayName: 'Operator' },
      actorServiceAccount: null
    }]),
    configurable: true
  })

  await withJobsApp({
    auth: {
      authEnabled: true,
      actor: { type: 'user', userId: 'user-1' },
      permissions: [JOBS_VIEW_PERMISSION],
      runtimePolicy: { demoMode: false }
    },
    tenant: TEST_TENANT
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/jobs`)

    assert.equal(response.status, 200)
    const body = await response.json() as {
      jobs: Array<{
        activity: Array<{
          id: string
          summary: string
          actorLabel: string | null
          actorUserId: string | null
          action: string
          kind: string
        }>
      }>
    }
    assert.equal(body.jobs[0]?.activity.length, 1)
    assert.equal(body.jobs[0]?.activity[0]?.id, 'audit-1')
    assert.equal(body.jobs[0]?.activity[0]?.summary, 'Queued print Queued print on Printer 1.')
    assert.equal(body.jobs[0]?.activity[0]?.actorLabel, 'Operator')
    assert.equal(body.jobs[0]?.activity[0]?.actorUserId, 'user-operator')
    assert.equal(body.jobs[0]?.activity[0]?.action, 'start-print')
    assert.equal(body.jobs[0]?.activity[0]?.kind, 'audit')
  })
})

test('jobs history includes project filament chips when library metadata is available', async () => {
  const archivePath = await createFilamentChipArchive()

  Object.defineProperty(prisma.printJob, 'findMany', {
    value: async () => ([{
      id: 'job-1',
      printerId: 'printer-1',
      printer: { name: 'Printer 1' },
      jobName: 'Queued print',
      startedAt: new Date('2026-05-01T11:00:00.000Z'),
      finishedAt: new Date('2026-05-01T11:10:00.000Z'),
      progressPercent: 100,
      durationSeconds: 600,
      result: 'success',
      fileId: 'file-1',
      fileName: 'Queued print.3mf',
      fileSizeBytes: 1024,
      plate: 1,
      useAms: true,
      bedLevel: true,
      amsMapping: '[0]',
      sourceType: 'library',
      calibrationOption: null,
      thumbnailPath: null,
      snapshotPath: null,
      file: {
        sizeBytes: 1024,
        ownerBridgeId: null,
        storedPath: archivePath,
        kind: '3mf'
      }
    }]),
    configurable: true
  })

  await withJobsApp({
    auth: {
      authEnabled: true,
      actor: { type: 'user', userId: 'user-1' },
      permissions: [JOBS_VIEW_PERMISSION],
      runtimePolicy: { demoMode: false }
    },
    tenant: TEST_TENANT
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/jobs`)

    assert.equal(response.status, 200)
    const body = await response.json() as {
      jobs: Array<{
        projectFilamentChips: Array<{ label: string; color: string | null }>
      }>
    }
    assert.deepEqual(body.jobs[0]?.projectFilamentChips, [
      { label: 'Bambu PLA Basic - Custom', color: '#FFFFFF' },
      { label: 'Bambu PLA Basic - Custom-2', color: '#8E9089' }
    ])
  })
})

test('job history deletion only deletes finished jobs for the active tenant', async () => {
  let recordedWhere: unknown = null
  let deleteCalls = 0

  Object.defineProperty(prisma.printJob, 'findFirst', {
    value: async (args: unknown) => {
      recordedWhere = (args as { where?: unknown }).where ?? null
      return {
        id: 'job-1',
        finishedAt: new Date('2026-05-01T10:10:00.000Z'),
        thumbnailPath: 'job-1.png',
        snapshotPath: 'job-1.jpg'
      }
    },
    configurable: true
  })
  Object.defineProperty(prisma.printJob, 'delete', {
    value: async () => {
      deleteCalls += 1
      return {}
    },
    configurable: true
  })

  await withJobsApp({
    auth: {
      authEnabled: true,
      actor: { type: 'user', userId: 'user-1' },
      permissions: [JOBS_VIEW_PERMISSION, JOBS_DELETE_PERMISSION],
      runtimePolicy: { demoMode: false }
    },
    tenant: TEST_TENANT
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/jobs/job-1`, { method: 'DELETE' })
    assert.equal(response.status, 204)
  })

  assert.deepEqual(recordedWhere, {
    id: 'job-1',
    printer: { tenantId: 'tenant-1' }
  })
  assert.equal(deleteCalls, 1)
})

test('job history deletion rejects unfinished jobs', async () => {
  let deleteCalls = 0

  Object.defineProperty(prisma.printJob, 'findFirst', {
    value: async () => ({
      id: 'job-1',
      finishedAt: null,
      thumbnailPath: null,
      snapshotPath: null
    }),
    configurable: true
  })
  Object.defineProperty(prisma.printJob, 'delete', {
    value: async () => {
      deleteCalls += 1
      return {}
    },
    configurable: true
  })

  await withJobsApp({
    auth: {
      authEnabled: true,
      actor: { type: 'user', userId: 'user-1' },
      permissions: [JOBS_VIEW_PERMISSION, JOBS_DELETE_PERMISSION],
      runtimePolicy: { demoMode: false }
    },
    tenant: TEST_TENANT
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/jobs/job-1`, { method: 'DELETE' })
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: 'Only finished jobs can be deleted from history' })
  })

  assert.equal(deleteCalls, 0)
})

async function withJobsApp(
  input: { auth: RequestAuthContext; tenant?: RequestTenantSummary | null },
  run: (baseUrl: string) => Promise<void>
): Promise<void> {
  const app = express()
  app.use(express.json())
  app.use((request, _response, next) => {
    request.auth = input.auth
    request.tenant = input.tenant ?? null
    next()
  })
  app.use('/api/jobs', jobsRouter)
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    if (error instanceof HttpError) {
      response.status(error.statusCode).json({ error: error.message })
      return
    }
    response.status(500).json({ error: 'Internal server error' })
  })

  const server = await listen(app)
  const address = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${address.port}`
  try {
    await run(baseUrl)
  } finally {
    await close(server)
  }
}

function listen(app: express.Express): Promise<Server> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server))
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
}

/**
 * Build a self-contained 3MF whose project/slice metadata declares two named, coloured filaments,
 * so `readLibraryProjectFilamentChips` resolves project filament chips without a real library file.
 */
async function createFilamentChipArchive(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'printstream-jobs-chips-'))
  const archivePath = path.join(dir, 'filament-chips.gcode.3mf')
  const projectSettings = JSON.stringify({
    filament_settings_id: ['Bambu PLA Basic - Custom', 'Bambu PLA Basic - Custom-2'],
    filament_colour: ['#FFFFFF', '#8E9089'],
    filament_type: ['PLA', 'PLA']
  })
  const sliceInfo = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<config>',
    '  <plate>',
    '    <metadata key="index" value="1"/>',
    '    <filament id="1" type="PLA" color="#FFFFFF" used_g="10" used_m="3"/>',
    '    <filament id="2" type="PLA" color="#8E9089" used_g="5" used_m="1"/>',
    '  </plate>',
    '</config>'
  ].join('\n')
  const zipFile = new yazl.ZipFile()
  const output = createWriteStream(archivePath)
  await new Promise<void>((resolve, reject) => {
    output.on('close', resolve)
    output.on('error', reject)
    zipFile.outputStream.on('error', reject)
    zipFile.outputStream.pipe(output)
    zipFile.addBuffer(Buffer.from(projectSettings, 'utf8'), 'Metadata/project_settings.config')
    zipFile.addBuffer(Buffer.from(sliceInfo, 'utf8'), 'Metadata/slice_info.config')
    zipFile.end()
  })
  return archivePath
}