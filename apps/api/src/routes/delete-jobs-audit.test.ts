process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import {
  LIBRARY_MANAGE_PERMISSION,
  PRINTERS_MANAGE_PERMISSION,
  PRINTERS_MANAGE_STORAGE_EDIT_SCOPE,
  type DeleteOperationJob,
  type Printer
} from '@printstream/shared'
import { libraryRouter } from './library.js'
import { printersRouter } from './printers.js'
import type { RequestAuthContext } from '../lib/auth-context.js'
import { installAuditLogCapture } from '../lib/audit-logs.js'
import { deleteOperationDispatcher } from '../lib/delete-operation-dispatcher.js'
import { HttpError } from '../lib/http-error.js'
import { rootPrisma } from '../lib/prisma.js'
import { printerManager } from '../lib/printer-manager.js'
import type { RequestTenantSummary } from '../lib/tenant-context.js'

const originalLibraryDelete = deleteOperationDispatcher.enqueueLibraryDelete
const originalPrinterStorageDelete = deleteOperationDispatcher.enqueuePrinterStorageDelete
const originalAuditLogCreate = rootPrisma.auditLog.create
const printerManagerPrototype = Object.getPrototypeOf(printerManager) as typeof printerManager
const originalGetPrinter = printerManagerPrototype.getPrinter
const TEST_TENANT: RequestTenantSummary = { id: 'tenant-1', slug: 'tenant-1', name: 'Tenant 1' }

const TEST_PRINTER: Printer = {
  id: 'printer-1',
  name: 'Printer 1',
  host: 'printer.local',
  serial: 'SERIAL-1',
  accessCode: 'CODE',
  model: 'X1C',
  currentPlateType: 'Textured PEI Plate',
  currentNozzleDiameters: [{ extruderId: 0, diameter: '0.4' }],
  position: 0,
  createdAt: '2026-05-01T00:00:00.000Z',
  updatedAt: '2026-05-01T00:00:00.000Z'
}

afterEach(() => {
  deleteOperationDispatcher.enqueueLibraryDelete = originalLibraryDelete
  deleteOperationDispatcher.enqueuePrinterStorageDelete = originalPrinterStorageDelete
  rootPrisma.auditLog.create = originalAuditLogCreate
  printerManagerPrototype.getPrinter = originalGetPrinter
})

test('library delete jobs write an explicit audit entry', async () => {
  const auditCreates: Array<Record<string, unknown>> = []
  rootPrisma.auditLog.create = (async (args: { data: Record<string, unknown> }) => {
    auditCreates.push(args.data)
    return { id: 'audit-1' } as never
  }) as unknown as typeof rootPrisma.auditLog.create
  deleteOperationDispatcher.enqueueLibraryDelete = (async () => createDeleteJob({
    id: 'delete-1',
    kind: 'library.delete',
    targetName: 'Library',
    summaryLabel: 'Test File.3mf',
    printerId: null,
    totalItems: 1
  })) as typeof deleteOperationDispatcher.enqueueLibraryDelete

  await withDeleteJobAuditApp(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/library/delete-jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileIds: ['file-1'] })
    })

    assert.equal(response.status, 202)
  })

  assert.equal(auditCreates.length, 1)
  assert.equal(auditCreates[0]?.action, 'delete')
  assert.equal(auditCreates[0]?.resource, 'library file')
  assert.equal(auditCreates[0]?.summary, 'Queued delete of library file Test File.3mf.')
  assert.equal(auditCreates[0]?.tenantId, TEST_TENANT.id)
  assert.equal(typeof auditCreates[0]?.metadataJson, 'string')
  assert.deepEqual(JSON.parse(String(auditCreates[0]?.metadataJson)), {
    deleteOperationId: 'delete-1',
    fileIds: ['file-1'],
    itemCount: 1,
    summaryLabel: 'Test File.3mf',
    requiredPermissions: [LIBRARY_MANAGE_PERMISSION]
  })
})

test('printer storage delete jobs write an explicit audit entry', async () => {
  const auditCreates: Array<Record<string, unknown>> = []
  rootPrisma.auditLog.create = (async (args: { data: Record<string, unknown> }) => {
    auditCreates.push(args.data)
    return { id: 'audit-2' } as never
  }) as unknown as typeof rootPrisma.auditLog.create
  printerManagerPrototype.getPrinter = (() => TEST_PRINTER as never) as typeof printerManagerPrototype.getPrinter
  deleteOperationDispatcher.enqueuePrinterStorageDelete = (() => createDeleteJob({
    id: 'delete-2',
    kind: 'printer.storage.delete',
    targetName: TEST_PRINTER.name,
    summaryLabel: 'plate.3mf',
    printerId: TEST_PRINTER.id,
    totalItems: 1
  })) as typeof deleteOperationDispatcher.enqueuePrinterStorageDelete

  await withDeleteJobAuditApp(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/printers/${TEST_PRINTER.id}/storage/delete-jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries: [{ path: '/plate.3mf', type: 'file' }] })
    })

    assert.equal(response.status, 202)
  })

  assert.equal(auditCreates.length, 1)
  assert.equal(auditCreates[0]?.action, 'delete')
  assert.equal(auditCreates[0]?.resource, 'printer storage entry')
  assert.equal(auditCreates[0]?.summary, 'Queued delete of printer storage entry plate.3mf on Printer 1.')
  assert.equal(auditCreates[0]?.tenantId, TEST_TENANT.id)
  assert.equal(typeof auditCreates[0]?.metadataJson, 'string')
  assert.deepEqual(JSON.parse(String(auditCreates[0]?.metadataJson)), {
    deleteOperationId: 'delete-2',
    printerId: TEST_PRINTER.id,
    printerName: TEST_PRINTER.name,
    entries: [{ path: '/plate.3mf', type: 'file' }],
    itemCount: 1,
    summaryLabel: 'plate.3mf',
    requiredPermissions: [PRINTERS_MANAGE_STORAGE_EDIT_SCOPE]
  })
})

function createDeleteJob(input: {
  id: string
  kind: DeleteOperationJob['kind']
  targetName: string
  summaryLabel: string
  printerId: string | null
  totalItems: number
}): DeleteOperationJob {
  return {
    id: input.id,
    kind: input.kind,
    targetName: input.targetName,
    summaryLabel: input.summaryLabel,
    printerId: input.printerId,
    status: 'queued',
    totalItems: input.totalItems,
    completedItems: 0,
    progressPercent: 0,
    progressMessage: 'Queued',
    error: null,
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
    startedAt: null,
    finishedAt: null
  }
}

async function withDeleteJobAuditApp(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express()
  const auth: RequestAuthContext = {
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [LIBRARY_MANAGE_PERMISSION, PRINTERS_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }
  app.use(express.json())
  app.use((request, _response, next) => {
    request.auth = auth
    request.tenant = TEST_TENANT
    next()
  })
  app.use(installAuditLogCapture())
  app.use('/api/library', libraryRouter)
  app.use('/api/printers', printersRouter)
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