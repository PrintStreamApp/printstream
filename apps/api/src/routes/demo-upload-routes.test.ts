process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { test } from 'node:test'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { PLUGINS_MANAGE_PERMISSION, type Permission } from '@printstream/shared'
import { adminPluginsRouter } from './admin-plugins.js'
import * as adminPluginsGuards from './admin-plugins.js'
import { libraryRouter } from './library.js'
import { printersRouter } from './printers.js'
import { HttpError } from '../lib/http-error.js'

const TEST_TENANT = { id: 'tenant-1', slug: 'tenant-1', name: 'Tenant 1' }
const DEMO_UPLOAD_MAX_BYTES = 15 * 1024 * 1024

test('library chunked upload init allows small temporary uploads in demo mode', async () => {
  await withUploadTestServer(libraryRouter, {
    tenant: TEST_TENANT,
    demoMode: true
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/uploads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileName: 'demo.3mf',
        sizeBytes: DEMO_UPLOAD_MAX_BYTES,
        hidden: false
      })
    })

    assert.equal(response.status, 201)
    const body = await response.json() as { uploadId: string; chunkSizeBytes: number; uploadedBytes: number }
    assert.equal(typeof body.uploadId, 'string')
    assert.equal(body.uploadedBytes, 0)
    assert.ok(body.chunkSizeBytes > 0)
  })
})

test('library upload rejects files larger than 15 MB in demo mode', async () => {
  await withUploadTestServer(libraryRouter, {
    tenant: TEST_TENANT,
    demoMode: true
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/uploads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileName: 'too-big.3mf',
        sizeBytes: DEMO_UPLOAD_MAX_BYTES + 1,
        hidden: false
      })
    })

    assert.equal(response.status, 413)
    assert.deepEqual(await response.json(), { error: 'In the public demo, uploads must be temporary files no larger than 15 MB.' })
  })
})

test('plugin upload returns 403 in demo mode', async () => {
  await withUploadTestServer(adminPluginsRouter, {
    authEnabled: true,
    permissions: [PLUGINS_MANAGE_PERMISSION],
    tenant: null,
    demoMode: true
  }, async (baseUrl) => {
    const form = new FormData()
    form.append('package', new Blob(['fake zip']), 'plugin.zip')
    const response = await fetch(`${baseUrl}/upload`, { method: 'POST', body: form })

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: 'File uploads are disabled in the public demo.' })
  })
})

test('plugin upload guard blocks hosted deployments and passes self-hosted ones', () => {
  const { createSelfHostedPluginUploadGuard } = adminPluginsGuards

  let error: unknown = null
  createSelfHostedPluginUploadGuard(() => false)(
    {} as never,
    {} as never,
    (caught?: unknown) => {
      error = caught ?? null
    }
  )
  assert.ok(error instanceof HttpError && error.statusCode === 403, 'cloud deployments are blocked')

  let passed = false
  createSelfHostedPluginUploadGuard(() => true)(
    {} as never,
    {} as never,
    (caught?: unknown) => {
      passed = caught == null
    }
  )
  assert.equal(passed, true, 'self-hosted deployments pass through')
})

test('printer storage upload returns 403 in demo mode', async () => {
  await withUploadTestServer(printersRouter, {
    tenant: TEST_TENANT,
    demoMode: true
  }, async (baseUrl) => {
    const form = new FormData()
    form.append('file', new Blob(['demo gcode']), 'demo.gcode.3mf')
    const response = await fetch(`${baseUrl}/demo-printer/storage/upload?path=/`, { method: 'POST', body: form })

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: 'Printer setup changes are disabled in the public demo.' })
  })
})

async function withUploadTestServer(
  router: express.Router,
  auth: {
    authEnabled?: boolean
    permissions?: Permission[]
    tenant: typeof TEST_TENANT | null
    demoMode?: boolean
  },
  run: (baseUrl: string) => Promise<void>
): Promise<void> {
  const app = express()
  app.use(express.json())
  app.use((request, _response, next) => {
    request.tenant = auth.tenant
    request.auth = {
      authEnabled: auth.authEnabled ?? false,
      actor: { type: 'user', userId: 'user-1' },
      permissions: auth.permissions ?? [],
      runtimePolicy: { demoMode: auth.demoMode ?? false }
    }
    next()
  })
  app.use(router)
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