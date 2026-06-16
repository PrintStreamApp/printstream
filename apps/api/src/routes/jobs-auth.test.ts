process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import {
  JOBS_DELETE_PERMISSION,
  JOBS_VIEW_PERMISSION,
  PRINTERS_CONTROL_PERMISSION
} from '@printstream/shared'
import { jobsRouter } from './jobs.js'
import type { RequestAuthContext } from '../lib/auth-context.js'
import { prisma } from '../lib/prisma.js'
import { restorePrismaMethodsAfterEach } from '../test-utils/prisma-stubs.js'
import { HttpError } from '../lib/http-error.js'
import type { RequestTenantSummary } from '../lib/tenant-context.js'

const TEST_TENANT = { id: 'tenant-1', slug: 'tenant-1', name: 'Tenant 1' } as const

const p = prisma as unknown as Record<string, Record<string, unknown>>
// Auto-restore the prisma/rootPrisma methods these tests override (was a per-method save/restore block).
restorePrismaMethodsAfterEach([
  [p.printJob, 'findMany'],
  [p.printJob, 'findFirst'],
  [p.printJob, 'delete']
])

afterEach(() => {
})

test('jobs list requires authentication once auth is enabled', async () => {
  await withJobsApp({
    auth: {
      authEnabled: true,
      actor: { type: 'anonymous' },
      permissions: [],
      runtimePolicy: { demoMode: false }
    }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/jobs`)

    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), { error: 'Authentication required.' })
  })
})

test('jobs list allows actors with jobs view permission', async () => {
  prisma.printJob.findMany = ((async () => []) as unknown) as typeof prisma.printJob.findMany

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
    assert.deepEqual(await response.json(), { jobs: [] })
  })
})

test('calibration replay returns 403 without printer control permission', async () => {
  prisma.printJob.findFirst = ((async () => ({
    id: 'job-1',
    printerId: 'printer-1',
    finishedAt: new Date('2026-05-01T10:10:00.000Z'),
    sourceType: 'calibration',
    fileId: null,
    useAms: true,
    bedLevel: true,
    plate: 1,
    amsMapping: null,
    vibrationCompensation: false,
    flowCalibration: 'on',
    firstLayerInspection: false,
    timelapse: false,
    filamentDynamicsCalibration: false,
    nozzleOffsetCalibration: 'off',
    allowIncompatibleFilament: false,
    allowPlateTypeMismatch: false,
    currentPlateType: null,
    currentNozzleDiameters: null,
    calibrationOption: 1
  })) as unknown) as typeof prisma.printJob.findFirst

  await withJobsApp({
    auth: {
      authEnabled: true,
      actor: { type: 'user', userId: 'user-1' },
      permissions: [JOBS_VIEW_PERMISSION],
      runtimePolicy: { demoMode: false }
    },
    tenant: TEST_TENANT
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/jobs/job-1/reprint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ printerId: 'printer-1' })
    })

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: 'You do not have permission to perform this action.' })
  })
})

test('calibration replay passes authorization with printer control permission', async () => {
  prisma.printJob.findFirst = ((async () => ({
    id: 'job-1',
    printerId: 'printer-1',
    finishedAt: new Date('2026-05-01T10:10:00.000Z'),
    sourceType: 'calibration',
    fileId: null,
    useAms: true,
    bedLevel: true,
    plate: 1,
    amsMapping: null,
    vibrationCompensation: false,
    flowCalibration: 'on',
    firstLayerInspection: false,
    timelapse: false,
    filamentDynamicsCalibration: false,
    nozzleOffsetCalibration: 'off',
    allowIncompatibleFilament: false,
    allowPlateTypeMismatch: false,
    currentPlateType: null,
    currentNozzleDiameters: null,
    calibrationOption: 1
  })) as unknown) as typeof prisma.printJob.findFirst

  await withJobsApp({
    auth: {
      authEnabled: true,
      actor: { type: 'user', userId: 'user-1' },
      permissions: [JOBS_VIEW_PERMISSION, PRINTERS_CONTROL_PERMISSION],
      runtimePolicy: { demoMode: false }
    },
    tenant: TEST_TENANT
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/jobs/job-1/reprint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ printerId: 'printer-1' })
    })

    assert.notEqual(response.status, 401)
    assert.notEqual(response.status, 403)
  })
})

test('job history deletion returns 403 without the delete permission', async () => {
  await withJobsApp({
    auth: {
      authEnabled: true,
      actor: { type: 'user', userId: 'user-1' },
      permissions: [JOBS_VIEW_PERMISSION],
      runtimePolicy: { demoMode: false }
    },
    tenant: TEST_TENANT
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/jobs/job-1`, {
      method: 'DELETE'
    })

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: 'You do not have permission to perform this action.' })
  })
})

test('job history deletion passes authorization with the delete permission', async () => {
  prisma.printJob.findFirst = ((async () => ({
    id: 'job-1',
    finishedAt: new Date('2026-05-01T10:10:00.000Z'),
    thumbnailPath: null,
    snapshotPath: null
  })) as unknown) as typeof prisma.printJob.findFirst
  prisma.printJob.delete = ((async () => ({})) as unknown) as typeof prisma.printJob.delete

  await withJobsApp({
    auth: {
      authEnabled: true,
      actor: { type: 'user', userId: 'user-1' },
      permissions: [JOBS_VIEW_PERMISSION, JOBS_DELETE_PERMISSION],
      runtimePolicy: { demoMode: false }
    },
    tenant: TEST_TENANT
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/jobs/job-1`, {
      method: 'DELETE'
    })

    assert.notEqual(response.status, 401)
    assert.notEqual(response.status, 403)
  })
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