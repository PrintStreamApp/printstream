/**
 * Tenant stats summary route.
 *
 * Exposes setup-readiness and high-level workspace metrics for the tenant
 * stats page.
 */
import { Router } from 'express'
import { isPrinterActiveJobStage, tenantStatsResponseSchema, type TenantStatsResponse } from '@printstream/shared'
import { buildFilamentSummary } from '../lib/filament-summary.js'
import { isManagedBridgeMode } from '../lib/managed-bridge.js'
import { readTenantPrintOutcomeBreakdown } from '../lib/print-outcome-breakdown.js'
import { prisma } from '../lib/prisma.js'
import { isMissingColumnError } from '../lib/prisma-errors.js'
import { printerManager } from '../lib/printer-manager.js'
import { requireRequestTenantId } from '../lib/request-helpers.js'
import { readTenantStatsActivityHistory } from '../lib/stats-activity-history.js'
import { withTenantRequestContext } from '../lib/tenant-context.js'

function secondsToHours(seconds: number): number {
  return seconds / 3600
}

async function readTenantStatsRow() {
  try {
    return await prisma.tenantStats.findFirst({
      select: {
        totalPrints: true,
        successfulPrints: true,
        failedPrints: true,
        cancelledPrints: true,
        successfulPrintDurationSeconds: true,
        failedPrintDurationSeconds: true,
        cancelledPrintDurationSeconds: true,
        trackedFilamentPrints: true,
        filamentUsedGrams: true,
        successfulFilamentUsedGrams: true,
        failedFilamentUsedGrams: true,
        cancelledFilamentUsedGrams: true,
        filamentUsedMeters: true,
        successfulFilamentUsedMeters: true,
        failedFilamentUsedMeters: true,
        cancelledFilamentUsedMeters: true,
      }
    })
  } catch (error) {
    if (!isMissingColumnError(error)) throw error
    console.warn('Falling back to legacy tenant stats query; failed/cancelled breakdown columns are missing')
    const [row, legacyBreakdown] = await Promise.all([
      prisma.tenantStats.findFirst({
        select: {
          totalPrints: true,
          successfulPrints: true,
          failedPrints: true,
          cancelledPrints: true,
          successfulPrintDurationSeconds: true,
          trackedFilamentPrints: true,
          filamentUsedGrams: true,
          filamentUsedMeters: true,
        }
      }),
      readTenantPrintOutcomeBreakdown()
    ])

    return row == null
      ? null
      : {
          ...row,
          failedPrintDurationSeconds: legacyBreakdown.failedPrintDurationSeconds,
          cancelledPrintDurationSeconds: legacyBreakdown.cancelledPrintDurationSeconds,
          successfulFilamentUsedGrams: legacyBreakdown.successfulFilamentUsedGrams,
          failedFilamentUsedGrams: legacyBreakdown.failedFilamentUsedGrams,
          cancelledFilamentUsedGrams: legacyBreakdown.cancelledFilamentUsedGrams,
          successfulFilamentUsedMeters: legacyBreakdown.successfulFilamentUsedMeters,
          failedFilamentUsedMeters: legacyBreakdown.failedFilamentUsedMeters,
          cancelledFilamentUsedMeters: legacyBreakdown.cancelledFilamentUsedMeters,
        }
  }
}

export const tenantStatsRouter = Router()

tenantStatsRouter.get('/', async (request, response) => {
  const tenantId = requireRequestTenantId(request)

  const [printerCount, bridgeCount, statsRow, activityLast30Days, unfinishedJobs] = await withTenantRequestContext(request.tenant ?? null, async () => await Promise.all([
    prisma.printer.count(),
    prisma.bridge.count(),
    readTenantStatsRow(),
    readTenantStatsActivityHistory(),
    prisma.printJob.findMany({ where: { finishedAt: null }, select: { printerId: true } })
  ]))

  const activePrinterIds = new Set<string>(unfinishedJobs.map((job) => job.printerId))
  for (const status of printerManager.snapshots()) {
    if (printerManager.getTenantId(status.printerId) === tenantId && isPrinterActiveJobStage(status.stage)) {
      activePrinterIds.add(status.printerId)
    }
  }

  const hasConnectedBridges = bridgeCount > 0
  const totalPrints = statsRow?.totalPrints ?? 0
  const successfulPrints = statsRow?.successfulPrints ?? 0
  const failedPrints = statsRow?.failedPrints ?? 0
  const cancelledPrints = statsRow?.cancelledPrints ?? 0
  const successfulPrintHours = secondsToHours(statsRow?.successfulPrintDurationSeconds ?? 0)
  const failedPrintHours = secondsToHours(statsRow?.failedPrintDurationSeconds ?? 0)
  const cancelledPrintHours = secondsToHours(statsRow?.cancelledPrintDurationSeconds ?? 0)
  const filamentSummary = buildFilamentSummary({
    trackedFilamentPrints: statsRow?.trackedFilamentPrints ?? 0,
    filamentUsedGrams: Number(statsRow?.filamentUsedGrams ?? 0),
    successfulFilamentUsedGrams: Number(statsRow?.successfulFilamentUsedGrams ?? 0),
    failedFilamentUsedGrams: Number(statsRow?.failedFilamentUsedGrams ?? 0),
    cancelledFilamentUsedGrams: Number(statsRow?.cancelledFilamentUsedGrams ?? 0),
    filamentUsedMeters: Number(statsRow?.filamentUsedMeters ?? 0),
    successfulFilamentUsedMeters: Number(statsRow?.successfulFilamentUsedMeters ?? 0),
    failedFilamentUsedMeters: Number(statsRow?.failedFilamentUsedMeters ?? 0),
    cancelledFilamentUsedMeters: Number(statsRow?.cancelledFilamentUsedMeters ?? 0)
  })
  const setupRequired = !hasConnectedBridges || printerCount === 0
  const allQuickStartItems = [
    {
      id: 'connect-bridge',
      title: 'Connect a bridge',
      description: 'Connect a bridge so this workspace can discover printers and relay printer activity.',
      complete: hasConnectedBridges
    },
    {
      id: 'add-printer',
      title: 'Add a printer',
      description: 'Add your first printer so this workspace can track status, jobs, and dispatch activity.',
      complete: printerCount > 0
    },
    {
      id: 'start-first-print',
      title: 'Start your first print',
      description: 'Send a first print once the workspace has printers online so history and production stats can build up.',
      complete: totalPrints > 0
    }
  ] satisfies TenantStatsResponse['quickStartItems']
  // Managed-bridge installs own the bundled bridge themselves, so the operator
  // never "connects" one — drop that onboarding step.
  const quickStartItems = isManagedBridgeMode()
    ? allQuickStartItems.filter((item) => item.id !== 'connect-bridge')
    : allQuickStartItems

  response.json(tenantStatsResponseSchema.parse({
    setupRequired,
    hasConnectedBridges,
    quickStartCompletedCount: quickStartItems.filter((item) => item.complete).length,
    quickStartItems,
    stats: {
      printerCount,
      printsInProgress: activePrinterIds.size,
      activityLast30Days,
      totalPrints,
      successfulPrints,
      failedPrints,
      cancelledPrints,
      failedOrCancelledPrints: failedPrints + cancelledPrints,
      totalPrintHours: successfulPrintHours + failedPrintHours + cancelledPrintHours,
      successfulPrintHours,
      failedPrintHours,
      cancelledPrintHours,
      wastedPrintHours: failedPrintHours + cancelledPrintHours,
      ...filamentSummary
    }
  } satisfies TenantStatsResponse))
})