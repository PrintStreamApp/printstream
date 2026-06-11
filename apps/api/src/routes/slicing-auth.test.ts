process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { JOBS_VIEW_PERMISSION } from '@printstream/shared'
import type { RequestAuthContext } from '../lib/auth-context.js'
import { HttpError } from '../lib/http-error.js'
import { savePrintJobThumbnail } from '../lib/print-job-thumbnails.js'
import { type RequestTenantSummary } from '../lib/tenant-context.js'
import { slicingJobs } from '../lib/slicing-jobs.js'
import { slicingRouter } from './slicing.js'

const TEST_TENANT = { id: 'tenant-1', slug: 'tenant-1', name: 'Tenant 1' } as const

const originalGetThumbnailInfo = slicingJobs.getThumbnailInfo
const originalSetThumbnailPath = slicingJobs.setThumbnailPath

afterEach(() => {
  slicingJobs.getThumbnailInfo = originalGetThumbnailInfo
  slicingJobs.setThumbnailPath = originalSetThumbnailPath
})

test('slicing job thumbnail route serves persisted thumbnails for authorized tenants', async () => {
  const thumbnailPath = await savePrintJobThumbnail('slicing-job-1', Buffer.from('png'))
  slicingJobs.getThumbnailInfo = (() => ({
    thumbnailPath,
    sourceFileId: 'source-1',
    outputFileId: 'output-1',
    plate: 1
  })) as typeof slicingJobs.getThumbnailInfo
  slicingJobs.setThumbnailPath = (() => undefined) as typeof slicingJobs.setThumbnailPath

  await withSlicingApp({
    auth: {
      authEnabled: true,
      actor: { type: 'user', userId: 'user-1' },
      permissions: [JOBS_VIEW_PERMISSION],
      runtimePolicy: { demoMode: false }
    },
    tenant: TEST_TENANT
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/slicing/jobs/slicing-job-1/thumbnail`)

    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'image/png')
    assert.equal(Buffer.from(await response.arrayBuffer()).toString(), 'png')
  })
})

async function withSlicingApp(
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
  app.use('/api/slicing', slicingRouter)
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