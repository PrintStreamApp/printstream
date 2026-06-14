process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { tenantStatsRouter } from './stats.js'
import type { RequestAuthContext } from '../lib/auth-context.js'
import { env } from '../lib/env.js'
import { HttpError } from '../lib/http-error.js'
import { prisma } from '../lib/prisma.js'
import { printerManager } from '../lib/printer-manager.js'
import type { RequestTenantSummary } from '../lib/tenant-context.js'

const TEST_TENANT = { id: 'tenant-1', slug: 'tenant-1', name: 'Tenant 1' } as const

const originalPrinterCount = prisma.printer.count
const originalPrinterFindMany = prisma.printer.findMany
const originalBridgeCount = prisma.bridge.count
const originalTenantStatsFindFirst = prisma.tenantStats.findFirst
const originalPrintJobFindMany = prisma.printJob.findMany
const originalPrintJobGroupBy = prisma.printJob.groupBy
const originalSnapshots = printerManager.snapshots
const originalGetTenantId = printerManager.getTenantId

afterEach(() => {
  prisma.printer.count = originalPrinterCount
  prisma.printer.findMany = originalPrinterFindMany
  prisma.bridge.count = originalBridgeCount
  prisma.tenantStats.findFirst = originalTenantStatsFindFirst
  prisma.printJob.findMany = originalPrintJobFindMany
  prisma.printJob.groupBy = originalPrintJobGroupBy
  printerManager.snapshots = originalSnapshots
  printerManager.getTenantId = originalGetTenantId
})

test('stats returns quick start when the workspace still needs bridge and printer setup', async () => {
  prisma.printer.count = (async () => 0) as typeof prisma.printer.count
  prisma.printer.findMany = (async () => []) as typeof prisma.printer.findMany
  prisma.bridge.count = (async () => 0) as typeof prisma.bridge.count
  prisma.tenantStats.findFirst = (async () => ({
    totalPrints: 0,
    successfulPrints: 0,
    failedPrints: 0,
    cancelledPrints: 0,
    successfulPrintDurationSeconds: 0,
    failedPrintDurationSeconds: 0,
    cancelledPrintDurationSeconds: 0,
    trackedFilamentPrints: 0,
    filamentUsedGrams: 0,
    successfulFilamentUsedGrams: 0,
    failedFilamentUsedGrams: 0,
    cancelledFilamentUsedGrams: 0,
    filamentUsedMeters: 0,
    successfulFilamentUsedMeters: 0,
    failedFilamentUsedMeters: 0,
    cancelledFilamentUsedMeters: 0
  })) as unknown as typeof prisma.tenantStats.findFirst
  prisma.printJob.findMany = (async () => []) as typeof prisma.printJob.findMany
  printerManager.snapshots = (() => []) as typeof printerManager.snapshots

  await withStatsApp({
    auth: {
      authEnabled: true,
      actor: { type: 'user', userId: 'user-1' },
      permissions: [],
      runtimePolicy: { demoMode: false }
    },
    tenant: TEST_TENANT
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/stats`)

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      setupRequired: true,
      hasConnectedBridges: false,
      quickStartCompletedCount: 0,
      quickStartItems: [
        {
          id: 'connect-bridge',
          title: 'Connect a bridge',
          description: 'Connect a bridge so this workspace can discover printers and relay printer activity.',
          complete: false
        },
        {
          id: 'add-printer',
          title: 'Add a printer',
          description: 'Add your first printer so this workspace can track status, jobs, and dispatch activity.',
          complete: false
        },
        {
          id: 'start-first-print',
          title: 'Start your first print',
          description: 'Send a first print once the workspace has printers online so history and production stats can build up.',
          complete: false
        }
      ],
      stats: {
        printerCount: 0,
        printsInProgress: 0,
        activityLast30Days: buildExpectedActivityHistory([], {}, {}),
        totalPrints: 0,
        successfulPrints: 0,
        failedPrints: 0,
        cancelledPrints: 0,
        failedOrCancelledPrints: 0,
        totalPrintHours: 0,
        successfulPrintHours: 0,
        failedPrintHours: 0,
        cancelledPrintHours: 0,
        wastedPrintHours: 0,
        filamentKilogramsPrinted: null,
        successfulFilamentKilogramsPrinted: null,
        failedFilamentKilogramsPrinted: null,
        cancelledFilamentKilogramsPrinted: null,
        wastedFilamentKilogramsPrinted: null,
        filamentMetersPrinted: null,
        successfulFilamentMetersPrinted: null,
        failedFilamentMetersPrinted: null,
        cancelledFilamentMetersPrinted: null,
        wastedFilamentMetersPrinted: null,
        filamentFeetPrinted: null,
        successfulFilamentFeetPrinted: null,
        failedFilamentFeetPrinted: null,
        cancelledFilamentFeetPrinted: null,
        wastedFilamentFeetPrinted: null
      }
    })
  })
})

test('stats omits the connect-bridge quick start item in managed-bridge mode', async () => {
  const originalManagedBridge = env.MANAGED_BRIDGE
  env.MANAGED_BRIDGE = true
  prisma.printer.count = (async () => 0) as typeof prisma.printer.count
  prisma.printer.findMany = (async () => []) as typeof prisma.printer.findMany
  prisma.bridge.count = (async () => 1) as typeof prisma.bridge.count
  prisma.tenantStats.findFirst = (async () => null) as unknown as typeof prisma.tenantStats.findFirst
  prisma.printJob.findMany = (async () => []) as typeof prisma.printJob.findMany
  printerManager.snapshots = (() => []) as typeof printerManager.snapshots

  try {
    await withStatsApp({
      auth: {
        authEnabled: true,
        actor: { type: 'user', userId: 'user-1' },
        permissions: [],
        runtimePolicy: { demoMode: false }
      },
      tenant: TEST_TENANT
    }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/stats`)

      assert.equal(response.status, 200)
      const body = await response.json()
      assert.deepEqual(body.quickStartItems.map((item: { id: string }) => item.id), ['add-printer', 'start-first-print'])
    })
  } finally {
    env.MANAGED_BRIDGE = originalManagedBridge
  }
})

test('stats returns live stats for a ready workspace', async () => {
  prisma.printer.count = (async () => 3) as typeof prisma.printer.count
  prisma.printer.findMany = (async () => ([
    { createdAt: buildActivityDate(34) },
    { createdAt: buildActivityDate(7) },
    { createdAt: buildActivityDate(1) }
  ])) as unknown as typeof prisma.printer.findMany
  prisma.bridge.count = (async () => 1) as typeof prisma.bridge.count
  prisma.tenantStats.findFirst = (async () => ({
    totalPrints: 12,
    successfulPrints: 9,
    failedPrints: 2,
    cancelledPrints: 1,
    successfulPrintDurationSeconds: 25200,
    failedPrintDurationSeconds: 3600,
    cancelledPrintDurationSeconds: 1800,
    trackedFilamentPrints: 0,
    filamentUsedGrams: 3250.5,
    successfulFilamentUsedGrams: 0,
    failedFilamentUsedGrams: 0,
    cancelledFilamentUsedGrams: 0,
    filamentUsedMeters: 104.75,
    successfulFilamentUsedMeters: 0,
    failedFilamentUsedMeters: 0,
    cancelledFilamentUsedMeters: 0
  })) as unknown as typeof prisma.tenantStats.findFirst
  prisma.printJob.findMany = (async (args?: unknown) => {
    if ((args as { where?: { finishedAt?: null } } | undefined)?.where?.finishedAt === null) {
      return [{ printerId: 'printer-2' }]
    }
    return [
      { printerId: 'printer-a', startedAt: buildActivityDate(7), finishedAt: buildActivityDate(6) },
      { printerId: 'printer-b', startedAt: buildActivityDate(2), finishedAt: buildActivityDate(1) },
      { printerId: 'printer-c', startedAt: buildActivityDate(1), finishedAt: buildActivityDate(0) }
    ]
  }) as typeof prisma.printJob.findMany
  printerManager.snapshots = (() => [
    { printerId: 'printer-1', stage: 'printing' },
    { printerId: 'printer-2', stage: 'idle' }
  ]) as typeof printerManager.snapshots
  printerManager.getTenantId = ((printerId: string) => {
    if (printerId === 'printer-1' || printerId === 'printer-2') return 'tenant-1'
    return undefined
  }) as typeof printerManager.getTenantId

  await withStatsApp({
    auth: {
      authEnabled: true,
      actor: { type: 'user', userId: 'user-1' },
      permissions: [],
      runtimePolicy: { demoMode: false }
    },
    tenant: TEST_TENANT
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/stats`)

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      setupRequired: false,
      hasConnectedBridges: true,
      quickStartCompletedCount: 3,
      quickStartItems: [
        {
          id: 'connect-bridge',
          title: 'Connect a bridge',
          description: 'Connect a bridge so this workspace can discover printers and relay printer activity.',
          complete: true
        },
        {
          id: 'add-printer',
          title: 'Add a printer',
          description: 'Add your first printer so this workspace can track status, jobs, and dispatch activity.',
          complete: true
        },
        {
          id: 'start-first-print',
          title: 'Start your first print',
          description: 'Send a first print once the workspace has printers online so history and production stats can build up.',
          complete: true
        }
      ],
      stats: {
        printerCount: 3,
        printsInProgress: 2,
        activityLast30Days: buildExpectedActivityHistory([34, 7, 1], { 7: 1, 6: 1, 2: 1, 1: 2, 0: 1 }, { 7: 12, 6: 12, 2: 12, 1: 24, 0: 12 }),
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
        filamentKilogramsPrinted: null,
        successfulFilamentKilogramsPrinted: null,
        failedFilamentKilogramsPrinted: null,
        cancelledFilamentKilogramsPrinted: null,
        wastedFilamentKilogramsPrinted: null,
        filamentMetersPrinted: null,
        successfulFilamentMetersPrinted: null,
        failedFilamentMetersPrinted: null,
        cancelledFilamentMetersPrinted: null,
        wastedFilamentMetersPrinted: null,
        filamentFeetPrinted: null,
        successfulFilamentFeetPrinted: null,
        failedFilamentFeetPrinted: null,
        cancelledFilamentFeetPrinted: null,
        wastedFilamentFeetPrinted: null
      }
    })
  })
})

test('stats falls back to legacy filament totals when breakdown columns are missing', async () => {
  let callCount = 0
  prisma.printer.count = (async () => 1) as typeof prisma.printer.count
  prisma.printer.findMany = (async () => ([
    { createdAt: buildActivityDate(12) }
  ])) as unknown as typeof prisma.printer.findMany
  prisma.bridge.count = (async () => 1) as typeof prisma.bridge.count
  prisma.tenantStats.findFirst = (async () => {
    callCount += 1
    if (callCount === 1) throw { code: 'P2022' }
    return {
      totalPrints: 4,
      successfulPrints: 3,
      failedPrints: 1,
      cancelledPrints: 0,
      successfulPrintDurationSeconds: 3600,
      trackedFilamentPrints: 2,
      filamentUsedGrams: 800,
      filamentUsedMeters: 25
    }
  }) as unknown as typeof prisma.tenantStats.findFirst
  prisma.printJob.groupBy = (async () => ([
    {
      result: 'success',
      _sum: {
        durationSeconds: 3600,
        filamentUsedGrams: 600,
        filamentUsedMeters: 18
      }
    },
    {
      result: 'failed',
      _sum: {
        durationSeconds: 900,
        filamentUsedGrams: 200,
        filamentUsedMeters: 7
      }
    }
  ])) as unknown as typeof prisma.printJob.groupBy
  prisma.printJob.findMany = (async (args?: unknown) => {
    if ((args as { where?: { finishedAt?: null } } | undefined)?.where?.finishedAt === null) {
      return []
    }

    return [
      { printerId: 'printer-z', startedAt: buildActivityDate(2), finishedAt: buildActivityDate(0) }
    ]
  }) as typeof prisma.printJob.findMany
  printerManager.snapshots = (() => []) as typeof printerManager.snapshots

  await withStatsApp({
    auth: {
      authEnabled: true,
      actor: { type: 'user', userId: 'user-1' },
      permissions: [],
      runtimePolicy: { demoMode: false }
    },
    tenant: TEST_TENANT
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/stats`)

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      setupRequired: false,
      hasConnectedBridges: true,
      quickStartCompletedCount: 3,
      quickStartItems: [
        {
          id: 'connect-bridge',
          title: 'Connect a bridge',
          description: 'Connect a bridge so this workspace can discover printers and relay printer activity.',
          complete: true
        },
        {
          id: 'add-printer',
          title: 'Add a printer',
          description: 'Add your first printer so this workspace can track status, jobs, and dispatch activity.',
          complete: true
        },
        {
          id: 'start-first-print',
          title: 'Start your first print',
          description: 'Send a first print once the workspace has printers online so history and production stats can build up.',
          complete: true
        }
      ],
      stats: {
        printerCount: 1,
        printsInProgress: 0,
        activityLast30Days: buildExpectedActivityHistory([12], { 2: 1, 1: 1, 0: 1 }, { 2: 12, 1: 24, 0: 12 }),
        totalPrints: 4,
        successfulPrints: 3,
        failedPrints: 1,
        cancelledPrints: 0,
        failedOrCancelledPrints: 1,
        totalPrintHours: 1.25,
        successfulPrintHours: 1,
        failedPrintHours: 0.25,
        cancelledPrintHours: 0,
        wastedPrintHours: 0.25,
        filamentKilogramsPrinted: 0.8,
        successfulFilamentKilogramsPrinted: 0.6,
        failedFilamentKilogramsPrinted: 0.2,
        cancelledFilamentKilogramsPrinted: 0,
        wastedFilamentKilogramsPrinted: 0.2,
        filamentMetersPrinted: 25,
        successfulFilamentMetersPrinted: 18,
        failedFilamentMetersPrinted: 7,
        cancelledFilamentMetersPrinted: 0,
        wastedFilamentMetersPrinted: 7,
        filamentFeetPrinted: 82.021,
        successfulFilamentFeetPrinted: 59.05512,
        failedFilamentFeetPrinted: 22.96588,
        cancelledFilamentFeetPrinted: 0,
        wastedFilamentFeetPrinted: 22.96588
      }
    })
  })

  assert.equal(callCount, 2)
})

async function withStatsApp(
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
  app.use('/api/stats', tenantStatsRouter)
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
      if (error) reject(error)
      else resolve()
    })
  })
}

function buildActivityDate(daysAgo: number): Date {
  const date = new Date()
  date.setUTCHours(12, 0, 0, 0)
  date.setUTCDate(date.getUTCDate() - daysAgo)
  return date
}

function buildExpectedActivityHistory(
  printerCreatedDaysAgo: number[],
  activePrinterCountsByDaysAgo: Record<number, number>,
  usedPrintHoursByDaysAgo: Record<number, number>
) {
  const printerCreationDates = printerCreatedDaysAgo.map((daysAgo) => buildActivityDate(daysAgo))
  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)
  const history: Array<{
    date: string
    activePrinterCount: number
    totalPrinterCount: number
    usedPrintHours: number
    capacityPrintHours: number
  }> = []

  for (let offset = 29; offset >= 0; offset -= 1) {
    const day = new Date(today)
    day.setUTCDate(day.getUTCDate() - offset)
    const nextDay = new Date(day)
    nextDay.setUTCDate(nextDay.getUTCDate() + 1)
    const daysAgo = offset

    const totalPrinterCount = printerCreationDates.filter((createdAt) => createdAt < nextDay).length
    history.push({
      date: day.toISOString().slice(0, 10),
      activePrinterCount: activePrinterCountsByDaysAgo[daysAgo] ?? 0,
      totalPrinterCount,
      usedPrintHours: usedPrintHoursByDaysAgo[daysAgo] ?? 0,
      capacityPrintHours: totalPrinterCount * 24
    })
  }

  return history
}