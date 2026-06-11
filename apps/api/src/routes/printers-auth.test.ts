process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { afterEach, mock, test } from 'node:test'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import {
  PRINTERS_CONTROL_PERMISSION,
  PRINTERS_MANAGE_PERMISSION,
  PRINTERS_VIEW_PERMISSION,
  PRINTER_STORAGE_VIEW_PERMISSION,
  PRINTS_DISPATCH_PERMISSION,
  type PrinterStatsResponse,
  type Printer,
  type PrinterStatus
} from '@printstream/shared'
import { printersRouter, resolvePrinterStorageJobName } from './printers.js'
import type { RequestAuthContext } from '../lib/auth-context.js'
import { HttpError } from '../lib/http-error.js'
import { prisma, rootPrisma } from '../lib/prisma.js'
import { restorePrismaMethodsAfterEach } from '../test-utils/prisma-stubs.js'
import { bridgeSessionManager } from '../lib/bridge-session-manager.js'
import { printerDiscovery } from '../lib/printer-discovery.js'
import { printerManager } from '../lib/printer-manager.js'
import { savePrintJobThumbnail } from '../lib/print-job-thumbnails.js'
import type { RequestTenantSummary } from '../lib/tenant-context.js'

const p = prisma as unknown as Record<string, Record<string, unknown>>
const rp = rootPrisma as unknown as Record<string, Record<string, unknown>>
// Auto-restore the prisma/rootPrisma methods these tests override (was a per-method save/restore block).
restorePrismaMethodsAfterEach([
  [p.printer, 'findMany'],
  [rp.bridge, 'findMany'],
  [rp.printer, 'findUnique'],
  [rp.printJob, 'findUnique'],
  [rp.printJob, 'findMany'],
  [rp.printJob, 'create'],
  [p.printer, 'findFirst'],
  [p.printer, 'findUnique'],
  [p.printer, 'create'],
  [p.bridge, 'findUnique'],
  [p.printerStats, 'findUnique'],
  [p.printJob, 'groupBy']
])
const printerManagerPrototype = Object.getPrototypeOf(printerManager) as typeof printerManager
const TEST_TENANT: RequestTenantSummary = { id: 'tenant-1', slug: 'tenant-1', name: 'Tenant 1' }

const printer: Printer = {
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
  mock.restoreAll()
})

test('printer list only returns printers for the active tenant', async () => {
  let requestedWhere: unknown = null
  prisma.printer.findMany = ((async (args: { where?: unknown }) => {
    requestedWhere = args.where ?? null
    return []
  }) as unknown) as typeof prisma.printer.findMany

  await withPrintersApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [PRINTERS_VIEW_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/printers`)

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { printers: [] })
  }, TEST_TENANT)

  assert.deepEqual(requestedWhere, { tenantId: 'tenant-1' })
})

test('printer stats are resolved by the current printer serial and include live activity', async () => {
  let requestedWhere: unknown = null
  prisma.printer.findFirst = ((async (args: { where?: unknown; select?: unknown }) => {
    requestedWhere = args.where ?? null
    return { id: printer.id, tenantId: TEST_TENANT.id, serial: printer.serial } as never
  }) as unknown) as typeof prisma.printer.findFirst
  let requestedStatsWhere: unknown = null
  prisma.printerStats.findUnique = ((async (args: { where?: unknown; select?: unknown }) => {
    requestedStatsWhere = args.where ?? null
    return {
      totalPrints: 12,
      successfulPrints: 9,
      failedPrints: 2,
      cancelledPrints: 1,
      successfulPrintDurationSeconds: 25200,
      failedPrintDurationSeconds: 3600,
      cancelledPrintDurationSeconds: 1800,
      trackedFilamentPrints: 4,
      filamentUsedGrams: 1500,
      successfulFilamentUsedGrams: 1200,
      failedFilamentUsedGrams: 200,
      cancelledFilamentUsedGrams: 100,
      filamentUsedMeters: 420,
      successfulFilamentUsedMeters: 336,
      failedFilamentUsedMeters: 56,
      cancelledFilamentUsedMeters: 28
    } as never
  }) as unknown) as typeof prisma.printerStats.findUnique
  mock.method(printerManagerPrototype, 'getStatus', () => ({ stage: 'printing' } as never))

  await withPrintersApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [PRINTERS_VIEW_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/printers/${printer.id}/stats`)

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json() satisfies PrinterStatsResponse, {
      stats: {
        printsInProgress: 1,
        totalPrints: 12,
        successfulPrints: 9,
        failedPrints: 2,
        cancelledPrints: 1,
        failedOrCancelledPrints: 3,
        totalPrintHours: 8.5,
        successfulPrintHours: 7,
        failedPrintHours: 1,
        cancelledPrintHours: 0.5,
        wastedPrintHours: 1.5,
        filamentKilogramsPrinted: 1.5,
        successfulFilamentKilogramsPrinted: 1.2,
        failedFilamentKilogramsPrinted: 0.2,
        cancelledFilamentKilogramsPrinted: 0.1,
        wastedFilamentKilogramsPrinted: 0.3,
        filamentMetersPrinted: 420,
        successfulFilamentMetersPrinted: 336,
        failedFilamentMetersPrinted: 56,
        cancelledFilamentMetersPrinted: 28,
        wastedFilamentMetersPrinted: 84,
        filamentFeetPrinted: 1377.9528,
        successfulFilamentFeetPrinted: 1102.36224,
        failedFilamentFeetPrinted: 183.72704,
        cancelledFilamentFeetPrinted: 91.86352,
        wastedFilamentFeetPrinted: 275.59056
      }
    })
  }, TEST_TENANT)

  assert.deepEqual(requestedWhere, { id: printer.id })
  assert.deepEqual(requestedStatsWhere, {
    tenantId_printerSerial: {
      tenantId: TEST_TENANT.id,
      printerSerial: printer.serial
    }
  })
})

test('printer stats fall back to legacy filament totals when breakdown columns are missing', async () => {
  prisma.printer.findFirst = ((async () => ({ id: printer.id, tenantId: TEST_TENANT.id, serial: printer.serial } as never)) as unknown) as typeof prisma.printer.findFirst
  let callCount = 0
  prisma.printerStats.findUnique = ((async () => {
    callCount += 1
    if (callCount === 1) throw { code: 'P2022' }
    return {
      totalPrints: 5,
      successfulPrints: 4,
      failedPrints: 1,
      cancelledPrints: 0,
      successfulPrintDurationSeconds: 7200,
      trackedFilamentPrints: 3,
      filamentUsedGrams: 900,
      filamentUsedMeters: 30
    } as never
  }) as unknown) as typeof prisma.printerStats.findUnique
  prisma.printJob.groupBy = ((async () => ([
    {
      result: 'success',
      _sum: {
        durationSeconds: 7200,
        filamentUsedGrams: 720,
        filamentUsedMeters: 24
      }
    },
    {
      result: 'failed',
      _sum: {
        durationSeconds: 1800,
        filamentUsedGrams: 180,
        filamentUsedMeters: 6
      }
    }
  ])) as unknown) as typeof prisma.printJob.groupBy
  mock.method(printerManagerPrototype, 'getStatus', () => ({ stage: 'idle' } as never))

  await withPrintersApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [PRINTERS_VIEW_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/printers/${printer.id}/stats`)

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json() satisfies PrinterStatsResponse, {
      stats: {
        printsInProgress: 0,
        totalPrints: 5,
        successfulPrints: 4,
        failedPrints: 1,
        cancelledPrints: 0,
        failedOrCancelledPrints: 1,
        totalPrintHours: 2.5,
        successfulPrintHours: 2,
        failedPrintHours: 0.5,
        cancelledPrintHours: 0,
        wastedPrintHours: 0.5,
        filamentKilogramsPrinted: 0.9,
        successfulFilamentKilogramsPrinted: 0.72,
        failedFilamentKilogramsPrinted: 0.18,
        cancelledFilamentKilogramsPrinted: 0,
        wastedFilamentKilogramsPrinted: 0.18,
        filamentMetersPrinted: 30,
        successfulFilamentMetersPrinted: 24,
        failedFilamentMetersPrinted: 6,
        cancelledFilamentMetersPrinted: 0,
        wastedFilamentMetersPrinted: 6,
        filamentFeetPrinted: 98.4252,
        successfulFilamentFeetPrinted: 78.74016,
        failedFilamentFeetPrinted: 19.68504,
        cancelledFilamentFeetPrinted: 0,
        wastedFilamentFeetPrinted: 19.68504
      }
    })
  }, TEST_TENANT)

  assert.equal(callCount, 2)
})

test('printer status snapshot only returns statuses for the active tenant', async () => {
  let requestedWhere: unknown = null
  prisma.printer.findMany = ((async (args: { where?: unknown; select?: unknown }) => {
    requestedWhere = args.where ?? null
    return [{ id: 'printer-1' }, { id: 'printer-2' }] as never
  }) as unknown) as typeof prisma.printer.findMany
  mock.method(printerManagerPrototype, 'snapshots', () => ([
    {
      printerId: 'printer-1',
      online: true,
      stage: 'idle'
    },
    {
      printerId: 'printer-2',
      online: false,
      stage: 'failed'
    },
    {
      printerId: 'printer-3',
      online: true,
      stage: 'printing'
    }
  ] as PrinterStatus[]))

  await withPrintersApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [PRINTERS_VIEW_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/printers/status`)

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      statuses: {
        'printer-1': {
          printerId: 'printer-1',
          online: true,
          stage: 'idle'
        },
        'printer-2': {
          printerId: 'printer-2',
          online: false,
          stage: 'failed'
        }
      }
    })
  }, TEST_TENANT)

  assert.deepEqual(requestedWhere, { tenantId: 'tenant-1' })
})

test('printer cover serves persisted job thumbnails before printer storage lookup', async () => {
  const thumbnailPath = await savePrintJobThumbnail('job-with-thumbnail', Buffer.from('persisted-cover'))
  rootPrisma.printJob.findMany = ((async () => ([{
    id: 'job-with-thumbnail',
    jobName: 'Remote Job',
    plate: 1,
    printerFilePath: '/cache/remote-job.gcode.3mf',
    thumbnailPath,
    sourceType: 'external',
    startedAt: new Date('2026-05-01T00:00:00.000Z'),
    file: null
  }] as never)) as unknown) as typeof rootPrisma.printJob.findMany
  let printerStorageLookupCount = 0
  rootPrisma.printer.findUnique = ((async () => {
    printerStorageLookupCount += 1
    throw new Error('Printer storage should not be queried when a persisted thumbnail is available')
  }) as unknown) as typeof rootPrisma.printer.findUnique
  mock.method(printerManagerPrototype, 'getPrinter', () => printer)
  mock.method(printerManagerPrototype, 'getStatus', () => ({
    jobName: 'Remote Job',
    gcodeFile: '/cache/remote-job.gcode.3mf',
    taskId: 'task-1'
  } as never))

  await withPrintersApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [PRINTERS_VIEW_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/printers/${printer.id}/cover`)

    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'image/png')
    assert.equal(Buffer.from(await response.arrayBuffer()).toString(), 'persisted-cover')
  })

  assert.equal(printerStorageLookupCount, 0)
})

test('discovered printers stay visible when only another tenant already adopted the same serial', async () => {
  const otherTenant: RequestTenantSummary = { id: 'tenant-2', slug: 'tenant-2', name: 'Tenant 2' }
  let requestedWhere: unknown = null
  prisma.printer.findMany = ((async (args: { where?: unknown }) => {
    requestedWhere = args.where ?? null
    return []
  }) as unknown) as typeof prisma.printer.findMany
  rootPrisma.bridge.findMany = ((async () => ([{ id: 'bridge-1' }] as never)) as unknown) as typeof rootPrisma.bridge.findMany
  mock.method(printerDiscovery, 'list', () => ([{
    name: 'Shared Printer',
    host: 'printer.local',
    serial: printer.serial,
    model: printer.model
  }] as never))

  await withPrintersApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [PRINTERS_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/printers/discovered`)

    assert.equal(response.status, 200)
    assert.deepEqual((await response.json()).printers, [{
      name: 'Shared Printer',
      host: 'printer.local',
      serial: printer.serial,
      model: printer.model
    }])
  }, otherTenant)

  assert.deepEqual(requestedWhere, { tenantId: otherTenant.id })
})

test('adopting a printer only dismisses the discovery entry for the active tenant', async () => {
  prisma.printer.findFirst = ((async () => null as never) as unknown) as typeof prisma.printer.findFirst
  prisma.bridge.findUnique = ((async () => ({ id: 'bridge-1' } as never)) as unknown) as typeof prisma.bridge.findUnique
  prisma.printer.create = ((async () => ({
    id: printer.id,
    tenantId: TEST_TENANT.id,
    name: printer.name,
    host: printer.host,
    serial: printer.serial,
    accessCode: printer.accessCode,
    model: printer.model,
    bridgeId: 'bridge-1',
    currentPlateType: printer.currentPlateType,
    currentNozzleDiameters: '[{"extruderId":0,"diameter":"0.4"}]',
    position: printer.position,
    createdAt: new Date(printer.createdAt),
    updatedAt: new Date(printer.updatedAt)
  } as never)) as unknown) as typeof prisma.printer.create
  mock.method(printerManagerPrototype, 'add', () => undefined)
  const dismiss = mock.method(printerDiscovery, 'dismiss', () => undefined)
  const forget = mock.method(printerDiscovery, 'forget', () => undefined)

  await withPrintersApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [PRINTERS_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/printers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: printer.name,
        host: printer.host,
        serial: printer.serial,
        accessCode: printer.accessCode,
        model: printer.model,
        bridgeId: 'bridge-1',
        currentPlateType: printer.currentPlateType,
        currentNozzleDiameters: printer.currentNozzleDiameters
      })
    })

    assert.equal(response.status, 201)
  }, TEST_TENANT)

  assert.deepEqual(dismiss.mock.calls[0]?.arguments, [printer.serial, TEST_TENANT.id])
  assert.equal(forget.mock.callCount(), 0)
})

test('adopting a printer can assign it to a connected bridge', async () => {
  prisma.printer.findFirst = ((async () => null as never) as unknown) as typeof prisma.printer.findFirst
  prisma.bridge.findUnique = ((async () => ({ id: 'bridge-1' } as never)) as unknown) as typeof prisma.bridge.findUnique
  prisma.printer.create = ((async () => ({
    id: printer.id,
    tenantId: TEST_TENANT.id,
    name: printer.name,
    host: printer.host,
    serial: printer.serial,
    accessCode: printer.accessCode,
    model: printer.model,
    bridgeId: 'bridge-1',
    currentPlateType: printer.currentPlateType,
    currentNozzleDiameters: '[{"extruderId":0,"diameter":"0.4"}]',
    position: printer.position,
    createdAt: new Date(printer.createdAt),
    updatedAt: new Date(printer.updatedAt)
  } as never)) as unknown) as typeof prisma.printer.create
  const add = mock.method(printerManagerPrototype, 'add', () => undefined)
  mock.method(printerDiscovery, 'dismiss', () => undefined)

  await withPrintersApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [PRINTERS_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/printers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: printer.name,
        host: printer.host,
        serial: printer.serial,
        accessCode: printer.accessCode,
        model: printer.model,
        bridgeId: 'bridge-1',
        currentPlateType: printer.currentPlateType,
        currentNozzleDiameters: printer.currentNozzleDiameters
      })
    })

    assert.equal(response.status, 201)
  }, TEST_TENANT)

  assert.deepEqual(add.mock.calls[0]?.arguments, [{
    ...printer,
    bridgeId: 'bridge-1'
  }, TEST_TENANT.id, 'bridge-1'])
})

test('printer validation requires a bridge selection', async () => {
  await withPrintersApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [PRINTERS_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/printers/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        host: printer.host,
        serial: printer.serial,
        accessCode: printer.accessCode
      })
    })

    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: 'Bridge assignment is required' })
  }, TEST_TENANT)
})

test('printer validation runs through the selected bridge', async () => {
  prisma.bridge.findUnique = ((async () => ({ id: 'bridge-1' } as never)) as unknown) as typeof prisma.bridge.findUnique
  const isConnected = mock.method(bridgeSessionManager, 'isConnected', () => true)
  const requestRpc = mock.method(bridgeSessionManager, 'requestRpc', async (
    _bridgeId: string,
    method: string,
    params: unknown
  ) => {
    assert.equal(method, 'printer.validateConnection')
    assert.deepEqual(params, {
      host: printer.host,
      serial: printer.serial,
      accessCode: printer.accessCode
    })
    return {
      ok: true,
      mqttReachable: true,
      developerModeEnabled: true,
      warnings: []
    }
  })

  await withPrintersApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [PRINTERS_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/printers/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        host: printer.host,
        serial: printer.serial,
        accessCode: printer.accessCode,
        bridgeId: 'bridge-1'
      })
    })

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      ok: true,
      mqttReachable: true,
      developerModeEnabled: true,
      warnings: []
    })
  }, TEST_TENANT)

  assert.equal(isConnected.mock.callCount(), 1)
  assert.equal(requestRpc.mock.callCount(), 1)
  assert.deepEqual(requestRpc.mock.calls[0]?.arguments[0], 'bridge-1')
})

test('printer storage browse requires authentication once auth is enabled', async () => {
  await withPrintersApp({
    authEnabled: true,
    actor: { type: 'anonymous' },
    permissions: [],
    runtimePolicy: { demoMode: true }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/printers/${printer.id}/storage?path=/`)

    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), { error: 'Authentication required.' })
  })
})

test('printer storage browse allows the current parent storage-view permission', async () => {
  mock.method(printerManagerPrototype, 'getPrinter', () => printer)
  rootPrisma.printer.findUnique = ((async () => ({ bridgeId: 'bridge-1' })) as unknown) as typeof rootPrisma.printer.findUnique
  mock.method(bridgeSessionManager, 'isConnected', () => true)
  mock.method(bridgeSessionManager, 'startRpcRequest', (_bridgeId: string, method: string) => {
    assert.equal(method, 'storage.list')
    return { requestId: 'rpc-1', promise: Promise.resolve({ entries: [] }) }
  })

  await withPrintersApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [PRINTER_STORAGE_VIEW_PERMISSION],
    runtimePolicy: { demoMode: true }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/printers/${printer.id}/storage?path=/`)

    assert.equal(response.status, 200)
    assert.equal((await response.json()).path, '/')
  })
})

test('refresh commands allow the current parent printer-control permission', async () => {
  prisma.printer.findUnique = ((async () => ({ id: printer.id, name: printer.name, model: printer.model } as never)) as unknown) as typeof prisma.printer.findUnique
  mock.method(printerManagerPrototype, 'getStatus', () => null)
  mock.method(printerManagerPrototype, 'publishCommand', () => true)

  await withPrintersApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [PRINTERS_CONTROL_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/printers/${printer.id}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'refresh' })
    })

    assert.equal(response.status, 202)
  })
})

test('resume commands with a live device error publish the HMS resume payload', async () => {
  prisma.printer.findUnique = ((async () => ({ id: printer.id, name: printer.name, model: printer.model } as never)) as unknown) as typeof prisma.printer.findUnique
  mock.method(printerManagerPrototype, 'getStatus', () => ({
    online: true,
    stage: 'paused',
    jobId: 'job-123',
    deviceError: {
      code: '07008011',
      message: 'Build plate mismatch.'
    },
    hmsErrors: [],
    filamentChange: {
      currentStepIndex: null,
      currentStepLabel: null,
      steps: []
    }
  } as never))
  const publishCommand = mock.method(printerManagerPrototype, 'publishCommand', () => true)

  await withPrintersApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [PRINTERS_CONTROL_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/printers/${printer.id}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'resume' })
    })

    assert.equal(response.status, 202)
  })

  assert.equal(publishCommand.mock.callCount(), 1)
  assert.deepEqual(publishCommand.mock.calls[0]?.arguments, [printer.id, {
    print: {
      command: 'resume',
      err: '117473297',
      param: 'reserve',
      job_id: 'job-123'
    }
  }])
})

test('resume commands stay available for AMS filament runout warnings without a job id', async () => {
  prisma.printer.findUnique = ((async () => ({ id: printer.id, name: printer.name, model: printer.model } as never)) as unknown) as typeof prisma.printer.findUnique
  mock.method(printerManagerPrototype, 'getStatus', () => ({
    online: true,
    stage: 'paused',
    subStage: '4',
    jobId: null,
    deviceError: {
      code: '07008011',
      message: 'AMS filament ran out. Please insert a new filament into the same AMS slot.'
    },
    hmsErrors: [{
      code: '0700220000020001',
      message: 'AMS A Slot 3 filament has run out. Please insert a new filament.'
    }],
    filamentChange: {
      currentStepIndex: null,
      currentStepLabel: null,
      steps: []
    }
  } as never))
  const publishCommand = mock.method(printerManagerPrototype, 'publishCommand', () => true)

  await withPrintersApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [PRINTERS_CONTROL_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/printers/${printer.id}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'resume' })
    })

    assert.equal(response.status, 202)
  })

  assert.equal(publishCommand.mock.callCount(), 2)
  assert.deepEqual(publishCommand.mock.calls.map((call) => call.arguments), [
    [printer.id, { print: { command: 'clean_print_error' } }],
    [printer.id, { print: { command: 'resume' } }]
  ])
})

test('ignoreHmsError commands with a live device error publish the HMS ignore payload', async () => {
  prisma.printer.findUnique = ((async () => ({ id: printer.id, name: printer.name, model: printer.model } as never)) as unknown) as typeof prisma.printer.findUnique
  mock.method(printerManagerPrototype, 'getStatus', () => ({
    online: true,
    stage: 'paused',
    jobId: 'job-123',
    deviceError: {
      code: '07008011',
      message: 'Build plate mismatch.'
    },
    hmsErrors: [],
    filamentChange: {
      currentStepIndex: null,
      currentStepLabel: null,
      steps: []
    }
  } as never))
  const publishCommand = mock.method(printerManagerPrototype, 'publishCommand', () => true)

  await withPrintersApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [PRINTERS_CONTROL_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/printers/${printer.id}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'ignoreHmsError' })
    })

    assert.equal(response.status, 202)
  })

  assert.equal(publishCommand.mock.callCount(), 1)
  assert.deepEqual(publishCommand.mock.calls[0]?.arguments, [printer.id, {
    print: {
      command: 'ignore',
      err: '117473297',
      param: 'reserve',
      job_id: 'job-123'
    }
  }])
})

test('retryAmsFilamentChange commands publish the AMS control resume payload', async () => {
  prisma.printer.findUnique = ((async () => ({ id: printer.id, name: printer.name, model: printer.model } as never)) as unknown) as typeof prisma.printer.findUnique
  mock.method(printerManagerPrototype, 'getStatus', () => ({
    online: true,
    stage: 'paused',
    subStage: null,
    filamentChange: {
      currentStepIndex: 2,
      currentStepLabel: 'Confirm extruded',
      steps: ['Wait for AMS cooling', 'Switch track at Filament Track Switch', 'Confirm extruded']
    }
  } as never))
  const publishCommand = mock.method(printerManagerPrototype, 'publishCommand', () => true)

  await withPrintersApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [PRINTERS_CONTROL_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/printers/${printer.id}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'retryAmsFilamentChange' })
    })

    assert.equal(response.status, 202)
  })

  assert.equal(publishCommand.mock.callCount(), 1)
  assert.deepEqual(publishCommand.mock.calls[0]?.arguments, [printer.id, {
    print: {
      command: 'ams_control',
      param: 'resume'
    }
  }])
})

test('confirmAmsFilamentExtruded commands publish the AMS control done payload', async () => {
  prisma.printer.findUnique = ((async () => ({ id: printer.id, name: printer.name, model: printer.model } as never)) as unknown) as typeof prisma.printer.findUnique
  mock.method(printerManagerPrototype, 'getStatus', () => ({
    online: true,
    stage: 'paused',
    subStage: null,
    filamentChange: {
      currentStepIndex: 2,
      currentStepLabel: 'Confirm extruded',
      steps: ['Wait for AMS cooling', 'Switch track at Filament Track Switch', 'Confirm extruded']
    }
  } as never))
  const publishCommand = mock.method(printerManagerPrototype, 'publishCommand', () => true)

  await withPrintersApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [PRINTERS_CONTROL_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/printers/${printer.id}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'confirmAmsFilamentExtruded' })
    })

    assert.equal(response.status, 202)
  })

  assert.equal(publishCommand.mock.callCount(), 1)
  assert.deepEqual(publishCommand.mock.calls[0]?.arguments, [printer.id, {
    print: {
      command: 'ams_control',
      param: 'done'
    }
  }])
})

test('loadAmsFilament commands stay available during paused filament-runout recovery', async () => {
  prisma.printer.findUnique = ((async () => ({ id: printer.id, name: printer.name, model: printer.model } as never)) as unknown) as typeof prisma.printer.findUnique
  mock.method(printerManagerPrototype, 'getStatus', () => ({
    online: true,
    stage: 'paused',
    subStage: '6',
    deviceError: {
      code: '07008021',
      message: 'Filament ran out.'
    },
    hmsErrors: [],
    filamentChange: {
      currentStepIndex: 1,
      currentStepLabel: 'Heating nozzle',
      steps: ['Heating nozzle']
    },
    ams: [{
      unitId: 0,
      nozzleId: 0,
      supportDrying: false,
      dryTimeRemainingMinutes: null,
      dryingActive: false,
      dryFilament: null,
      dryTemperature: null,
      dryDurationHours: null,
      humidityPercent: null,
      humidityLevel: null,
      temperature: null,
      slots: [{
        slot: 1,
        trayName: null,
        filamentType: 'PLA',
        color: null,
        colors: [],
        remainPercent: null,
        active: false,
        isReading: false,
        trayInfoIdx: '',
        caliIdx: null,
        k: null,
        trayUuid: null
      }]
    }],
    externalSpools: []
  } as never))
  const publishCommand = mock.method(printerManagerPrototype, 'publishCommand', () => true)

  await withPrintersApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [PRINTERS_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/printers/${printer.id}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'loadAmsFilament', amsId: 0, slotId: 1, nozzleTemp: 220, extruderId: 0 })
    })

    assert.equal(response.status, 202)
  })

  assert.equal(publishCommand.mock.callCount(), 1)
  assert.deepEqual(publishCommand.mock.calls[0]?.arguments, [printer.id, {
    print: {
      command: 'ams_change_filament',
      curr_temp: 220,
      tar_temp: 220,
      ams_id: 0,
      target: 1,
      slot_id: 1,
      extruder_id: 0
    }
  }])
})

test('ignoreHmsError commands are rejected while paused on filament runout', async () => {
  prisma.printer.findUnique = ((async () => ({ id: printer.id, name: printer.name, model: printer.model } as never)) as unknown) as typeof prisma.printer.findUnique
  mock.method(printerManagerPrototype, 'getStatus', () => ({
    online: true,
    stage: 'paused',
    subStage: '6',
    jobId: 'job-123',
    deviceError: {
      code: '07008021',
      message: 'Filament ran out.'
    },
    hmsErrors: [],
    filamentChange: {
      currentStepIndex: null,
      currentStepLabel: null,
      steps: []
    }
  } as never))

  await withPrintersApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [PRINTERS_CONTROL_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/printers/${printer.id}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'ignoreHmsError' })
    })

    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), {
      error: 'Continue is not available while the printer is paused on filament runout'
    })
  })
})

test('ignoreHmsError commands are rejected for AMS filament runout warnings reported as filament change', async () => {
  prisma.printer.findUnique = ((async () => ({ id: printer.id, name: printer.name, model: printer.model } as never)) as unknown) as typeof prisma.printer.findUnique
  mock.method(printerManagerPrototype, 'getStatus', () => ({
    online: true,
    stage: 'paused',
    subStage: '4',
    jobId: null,
    deviceError: {
      code: '07008011',
      message: 'AMS filament ran out. Please insert a new filament into the same AMS slot.'
    },
    hmsErrors: [{
      code: '0700220000020001',
      message: 'AMS A Slot 3 filament has run out. Please insert a new filament.'
    }],
    filamentChange: {
      currentStepIndex: null,
      currentStepLabel: null,
      steps: []
    }
  } as never))

  await withPrintersApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [PRINTERS_CONTROL_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/printers/${printer.id}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'ignoreHmsError' })
    })

    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), {
      error: 'Continue is not available while the printer is paused on filament runout'
    })
  })
})

test('dual chamber light commands fan out to both chamber light nodes', async () => {
  prisma.printer.findUnique = ((async () => ({ id: printer.id, name: printer.name, model: 'H2D' } as never)) as unknown) as typeof prisma.printer.findUnique
  mock.method(printerManagerPrototype, 'getStatus', () => ({
    online: true,
    lightCapabilities: { chamber: true, heatbed: false, work: false }
  } as never))
  const publishCommand = mock.method(printerManagerPrototype, 'publishCommand', () => true)

  await withPrintersApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [PRINTERS_CONTROL_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/printers/${printer.id}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'light', node: 'chamber', on: true })
    })

    assert.equal(response.status, 202)
  })

  assert.equal(publishCommand.mock.callCount(), 2)
  assert.deepEqual(publishCommand.mock.calls[0]?.arguments, [printer.id, {
    system: {
      command: 'ledctrl',
      led_node: 'chamber_light',
      led_mode: 'on',
      led_on_time: 500,
      led_off_time: 500,
      loop_times: 0,
      interval_time: 0
    }
  }])
  assert.deepEqual(publishCommand.mock.calls[1]?.arguments, [printer.id, {
    system: {
      command: 'ledctrl',
      led_node: 'chamber_light2',
      led_mode: 'on',
      led_on_time: 500,
      led_off_time: 500,
      loop_times: 0,
      interval_time: 0
    }
  }])
})

test('single-nozzle printer temperature commands publish legacy M104 gcode', async () => {
  prisma.printer.findUnique = ((async () => ({ id: printer.id, name: printer.name, model: 'P1S' } as never)) as unknown) as typeof prisma.printer.findUnique
  mock.method(printerManagerPrototype, 'getStatus', () => ({ online: true } as never))
  const publishCommand = mock.method(printerManagerPrototype, 'publishCommand', () => true)

  await withPrintersApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [PRINTERS_CONTROL_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/printers/${printer.id}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'setNozzleTemperature', extruderId: 0, target: 250 })
    })

    assert.equal(response.status, 202)
  })

  assert.equal(publishCommand.mock.callCount(), 1)
  assert.deepEqual(publishCommand.mock.calls[0]?.arguments, [printer.id, {
    print: {
      command: 'gcode_line',
      param: 'M104 S250\n'
    }
  }])
})

test('dual-nozzle printer temperature commands publish set_nozzle_temp payloads', async () => {
  prisma.printer.findUnique = ((async () => ({ id: printer.id, name: printer.name, model: 'H2D' } as never)) as unknown) as typeof prisma.printer.findUnique
  mock.method(printerManagerPrototype, 'getStatus', () => ({ online: true } as never))
  const publishCommand = mock.method(printerManagerPrototype, 'publishCommand', () => true)

  await withPrintersApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [PRINTERS_CONTROL_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/printers/${printer.id}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'setNozzleTemperature', extruderId: 0, target: 250 })
    })

    assert.equal(response.status, 202)
  })

  assert.equal(publishCommand.mock.callCount(), 1)
  assert.deepEqual(publishCommand.mock.calls[0]?.arguments, [printer.id, {
    print: {
      command: 'set_nozzle_temp',
      extruder_index: 0,
      target_temp: 250
    }
  }])
})

test('printers without MQTT bed temperature control publish legacy M140 gcode', async () => {
  prisma.printer.findUnique = ((async () => ({ id: printer.id, name: printer.name, model: 'P1S' } as never)) as unknown) as typeof prisma.printer.findUnique
  mock.method(printerManagerPrototype, 'getStatus', () => ({
    online: true,
    commandTransport: { mqttBedTemperature: false, mqttAxisControl: false, mqttHoming: false, newFanControl: false }
  } as never))
  const publishCommand = mock.method(printerManagerPrototype, 'publishCommand', () => true)

  await withPrintersApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [PRINTERS_CONTROL_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/printers/${printer.id}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'setBedTemperature', target: 60 })
    })

    assert.equal(response.status, 202)
  })

  assert.deepEqual(publishCommand.mock.calls[0]?.arguments, [printer.id, {
    print: {
      command: 'gcode_line',
      param: 'M140 S60\n'
    }
  }])
})

test('printers with MQTT bed temperature control publish set_bed_temp payloads', async () => {
  prisma.printer.findUnique = ((async () => ({ id: printer.id, name: printer.name, model: 'X1C' } as never)) as unknown) as typeof prisma.printer.findUnique
  mock.method(printerManagerPrototype, 'getStatus', () => ({
    online: true,
    commandTransport: { mqttBedTemperature: true, mqttAxisControl: true, mqttHoming: true, newFanControl: true }
  } as never))
  const publishCommand = mock.method(printerManagerPrototype, 'publishCommand', () => true)

  await withPrintersApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [PRINTERS_CONTROL_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/printers/${printer.id}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'setBedTemperature', target: 60 })
    })

    assert.equal(response.status, 202)
  })

  assert.deepEqual(publishCommand.mock.calls[0]?.arguments, [printer.id, {
    print: {
      command: 'set_bed_temp',
      temp: 60
    }
  }])
})

test('printers without MQTT axis control publish legacy jog gcode using printer kinematics', async () => {
  prisma.printer.findUnique = ((async () => ({ id: printer.id, name: printer.name, model: 'A1' } as never)) as unknown) as typeof prisma.printer.findUnique
  mock.method(printerManagerPrototype, 'getStatus', () => ({
    online: true,
    stage: 'idle',
    commandTransport: { mqttBedTemperature: false, mqttAxisControl: false, mqttHoming: false, newFanControl: false }
  } as never))
  const publishCommand = mock.method(printerManagerPrototype, 'publishCommand', () => true)

  await withPrintersApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [PRINTERS_CONTROL_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/printers/${printer.id}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'moveAxis', axis: 'Y', distanceMm: 10 })
    })

    assert.equal(response.status, 202)
  })

  assert.deepEqual(publishCommand.mock.calls[0]?.arguments, [printer.id, {
    print: {
      command: 'gcode_line',
      param: 'M211 S \nM211 X1 Y1 Z1\nM1002 push_ref_mode\nG91 \nG1 Y-10.0 F3000\nM1002 pop_ref_mode\nM211 R\n'
    }
  }])
})

test('printers with MQTT homing support publish back_to_center payloads', async () => {
  prisma.printer.findUnique = ((async () => ({ id: printer.id, name: printer.name, model: 'X1C' } as never)) as unknown) as typeof prisma.printer.findUnique
  mock.method(printerManagerPrototype, 'getStatus', () => ({
    online: true,
    stage: 'idle',
    commandTransport: { mqttBedTemperature: true, mqttAxisControl: true, mqttHoming: true, newFanControl: true }
  } as never))
  const publishCommand = mock.method(printerManagerPrototype, 'publishCommand', () => true)

  await withPrintersApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [PRINTERS_CONTROL_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/printers/${printer.id}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'homeAxes' })
    })

    assert.equal(response.status, 202)
  })

  assert.deepEqual(publishCommand.mock.calls[0]?.arguments, [printer.id, {
    print: {
      command: 'back_to_center'
    }
  }])
})

test('printers without new fan control publish legacy M106 gcode', async () => {
  prisma.printer.findUnique = ((async () => ({ id: printer.id, name: printer.name, model: 'P1S' } as never)) as unknown) as typeof prisma.printer.findUnique
  mock.method(printerManagerPrototype, 'getStatus', () => ({
    online: true,
    commandTransport: { mqttBedTemperature: false, mqttAxisControl: false, mqttHoming: false, newFanControl: false }
  } as never))
  const publishCommand = mock.method(printerManagerPrototype, 'publishCommand', () => true)

  await withPrintersApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [PRINTERS_CONTROL_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/printers/${printer.id}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'setFanSpeed', fan: 'part', percent: 42 })
    })

    assert.equal(response.status, 202)
  })

  assert.deepEqual(publishCommand.mock.calls[0]?.arguments, [printer.id, {
    print: {
      command: 'gcode_line',
      param: 'M106 P1 S107\n'
    }
  }])
})

test('printers with new fan control publish set_fan payloads', async () => {
  prisma.printer.findUnique = ((async () => ({ id: printer.id, name: printer.name, model: 'X1C' } as never)) as unknown) as typeof prisma.printer.findUnique
  mock.method(printerManagerPrototype, 'getStatus', () => ({
    online: true,
    commandTransport: { mqttBedTemperature: true, mqttAxisControl: true, mqttHoming: true, newFanControl: true }
  } as never))
  const publishCommand = mock.method(printerManagerPrototype, 'publishCommand', () => true)

  await withPrintersApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [PRINTERS_CONTROL_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/printers/${printer.id}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'setFanSpeed', fan: 'aux', percent: 42 })
    })

    assert.equal(response.status, 202)
  })

  assert.deepEqual(publishCommand.mock.calls[0]?.arguments, [printer.id, {
    print: {
      command: 'set_fan',
      fan_index: 2,
      speed: 420
    }
  }])
})

test('printer settings commands require the current parent printer-manage permission', async () => {
  await withPrintersApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [PRINTERS_CONTROL_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/printers/${printer.id}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'setPrintOption', option: 'promptSound', enabled: true })
    })

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: 'You do not have permission to perform this action.' })
  })
})

test('print-from-storage allows the current parent print-dispatch permission', async () => {
  mock.method(printerManagerPrototype, 'getPrinter', () => printer)
  mock.method(printerManagerPrototype, 'publishCommand', () => true)
  rootPrisma.printer.findUnique = ((async () => ({ tenantId: TEST_TENANT.id })) as unknown) as typeof rootPrisma.printer.findUnique
  rootPrisma.printJob.findUnique = ((async () => null) as unknown) as typeof rootPrisma.printJob.findUnique
  rootPrisma.printJob.create = ((async ({ data }: { data: { id: string; jobName: string } }) => ({
    id: data.id,
    jobName: data.jobName
  })) as unknown) as typeof rootPrisma.printJob.create

  await withPrintersApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [PRINTS_DISPATCH_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/printers/${printer.id}/storage/print`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: '/job.gcode',
        plate: 1,
        useAms: true,
        timelapse: false,
        bedLevel: true,
        flowCalibration: false,
        vibrationCompensation: true,
        firstLayerInspection: false,
        nozzleOffsetCalibration: false,
        filamentDynamicsCalibration: false,
        allowIncompatibleFilament: false
      })
    })

    assert.equal(response.status, 202)
    assert.deepEqual(await response.json(), { path: '/job.gcode' })
  })
})

test('resolvePrinterStorageJobName preserves the selected 3MF plate name in the active job label', () => {
  assert.equal(
    resolvePrinterStorageJobName(
      'Best Shot Golf.gcode.3mf',
      '3mf',
      4,
      { plates: [{ index: 1, name: 'Front Nine' }, { index: 4, name: 'Back Nine' }] } as never
    ),
    'Best Shot Golf - Back Nine'
  )
})

test('resolvePrinterStorageJobName uses the file name for a single-plate 3MF instead of duplicating the plate', () => {
  assert.equal(
    resolvePrinterStorageJobName(
      'Best Shot Golf - Plate 4.gcode.3mf',
      '3mf',
      4,
      { plates: [{ index: 4, name: 'Plate 4' }] } as never
    ),
    'Best Shot Golf - Plate 4'
  )
})

test('print-from-storage maps auto print modes onto the printer command payload', async () => {
  const autoPrinter: Printer = { ...printer, model: 'H2D' }
  mock.method(printerManagerPrototype, 'getPrinter', () => autoPrinter)
  const publishCommand = mock.method(printerManagerPrototype, 'publishCommand', () => true)
  rootPrisma.printer.findUnique = ((async () => ({ tenantId: TEST_TENANT.id })) as unknown) as typeof rootPrisma.printer.findUnique
  rootPrisma.printJob.findUnique = ((async () => null) as unknown) as typeof rootPrisma.printJob.findUnique
  rootPrisma.printJob.create = ((async ({ data }: { data: { id: string; jobName: string } }) => ({
    id: data.id,
    jobName: data.jobName
  })) as unknown) as typeof rootPrisma.printJob.create

  await withPrintersApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [PRINTS_DISPATCH_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/printers/${autoPrinter.id}/storage/print`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: '/job.gcode',
        plate: 1,
        useAms: true,
        timelapse: false,
        bedLevel: 'auto',
        flowCalibration: 'auto',
        vibrationCompensation: true,
        firstLayerInspection: true,
        nozzleOffsetCalibration: 'auto',
        filamentDynamicsCalibration: true,
        allowIncompatibleFilament: false
      })
    })

    assert.equal(response.status, 202)
  })

  const publishPayload = publishCommand.mock.calls[0]?.arguments[1] as {
    print: {
      project_id: string
      subtask_id: string
      task_id: string
    }
  } | undefined
  assert.ok(publishPayload)

  assert.deepEqual(publishPayload, {
    print: {
      command: 'project_file',
      param: 'job.gcode',
      url: 'ftp:///job.gcode',
      file: 'job.gcode',
      md5: '',
      bed_type: 'auto',
      timelapse: false,
      bed_leveling: false,
      auto_bed_leveling: 2,
      flow_cali: false,
      auto_flow_cali: 2,
      vibration_cali: false,
      layer_inspect: false,
      use_ams: true,
      cfg: '0',
      extrude_cali_flag: 0,
      extrude_cali_manual_mode: 0,
      nozzle_offset_cali: 2,
      subtask_name: 'job',
      profile_id: '0',
      project_id: publishPayload.print.project_id,
      subtask_id: publishPayload.print.subtask_id,
      task_id: publishPayload.print.task_id
    }
  })
})

test('print-from-storage includes explicit AMS mappings in the printer command payload', async () => {
  const mappedPrinter: Printer = { ...printer, model: 'H2D' }
  mock.method(printerManagerPrototype, 'getPrinter', () => mappedPrinter)
  const publishCommand = mock.method(printerManagerPrototype, 'publishCommand', () => true)
  rootPrisma.printer.findUnique = ((async () => ({ tenantId: TEST_TENANT.id })) as unknown) as typeof rootPrisma.printer.findUnique
  rootPrisma.printJob.findUnique = ((async () => null) as unknown) as typeof rootPrisma.printJob.findUnique
  rootPrisma.printJob.create = ((async ({ data }: { data: { id: string; jobName: string } }) => ({
    id: data.id,
    jobName: data.jobName
  })) as unknown) as typeof rootPrisma.printJob.create

  await withPrintersApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [PRINTS_DISPATCH_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/printers/${mappedPrinter.id}/storage/print`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: '/job.gcode',
        plate: 1,
        useAms: true,
        timelapse: false,
        bedLevel: 'on',
        flowCalibration: 'off',
        vibrationCompensation: false,
        firstLayerInspection: true,
        nozzleOffsetCalibration: 'auto',
        filamentDynamicsCalibration: false,
        amsMapping: [0, 255],
        allowIncompatibleFilament: false
      })
    })

    assert.equal(response.status, 202)
  })

  const publishPayload = publishCommand.mock.calls[0]?.arguments[1] as { print: { ams_mapping?: number[] } } | undefined
  assert.ok(publishPayload)
  assert.deepEqual(publishPayload.print.ams_mapping, [0, 255])
})

test('print-from-storage uses the printer-reported first-layer inspection default when omitted', async () => {
  const firstLayerPrinter: Printer = { ...printer, model: 'X1C' }
  mock.method(printerManagerPrototype, 'getPrinter', () => firstLayerPrinter)
  mock.method(printerManagerPrototype, 'getStatus', () => ({
    printOptions: {
      aiMonitoring: { supported: false, enabled: null, sensitivity: null },
      spaghettiDetection: { supported: false, enabled: null, sensitivity: null },
      purgeChutePileupDetection: { supported: false, enabled: null, sensitivity: null },
      nozzleClumpingDetection: { supported: false, enabled: null, sensitivity: null },
      airPrintingDetection: { supported: false, enabled: null, sensitivity: null },
      firstLayerInspection: { supported: true, enabled: false },
      autoRecovery: { supported: false, enabled: null },
      promptSound: { supported: false, enabled: null },
      filamentTangleDetection: { supported: false, enabled: null }
    },
    printStartOptions: {
      bedLevel: { supported: true, autoSupported: false, current: null },
      vibrationCompensation: { supported: true, current: null },
      flowCalibration: { supported: true, autoSupported: false, current: null },
      firstLayerInspection: { supported: true, current: false },
      timelapse: { supported: true, current: null },
      filamentDynamicsCalibration: { supported: false, current: null },
      nozzleOffsetCalibration: { supported: false, current: null }
    }
  }) as PrinterStatus)
  const publishCommand = mock.method(printerManagerPrototype, 'publishCommand', () => true)
  rootPrisma.printer.findUnique = ((async () => ({ tenantId: TEST_TENANT.id })) as unknown) as typeof rootPrisma.printer.findUnique
  rootPrisma.printJob.findUnique = ((async () => null) as unknown) as typeof rootPrisma.printJob.findUnique
  rootPrisma.printJob.create = ((async ({ data }: { data: { id: string; jobName: string } }) => ({
    id: data.id,
    jobName: data.jobName
  })) as unknown) as typeof rootPrisma.printJob.create

  await withPrintersApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [PRINTS_DISPATCH_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/printers/${firstLayerPrinter.id}/storage/print`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: '/job.gcode',
        plate: 1,
        useAms: true,
        timelapse: false,
        bedLevel: 'on',
        flowCalibration: 'off',
        nozzleOffsetCalibration: 'off',
        allowIncompatibleFilament: false
      })
    })

    assert.equal(response.status, 202)
  })

  const publishPayload = publishCommand.mock.calls[0]?.arguments[1] as { print: { layer_inspect: boolean } } | undefined
  assert.ok(publishPayload)
  assert.equal(publishPayload.print.layer_inspect, false)
})

async function withPrintersApp(
  auth: RequestAuthContext,
  run: (baseUrl: string) => Promise<void>,
  tenant: RequestTenantSummary | null = null
): Promise<void> {
  const app = express()
  app.use(express.json())
  app.use((request, _response, next) => {
    request.auth = auth
    request.tenant = tenant
    next()
  })
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