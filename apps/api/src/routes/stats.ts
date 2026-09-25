/**
 * Workspace stats summary route.
 *
 * Exposes setup-readiness and high-level workspace metrics for the workspace
 * stats page.
 */
import { Router } from 'express'
import { PRINTERS_VIEW_PERMISSION, isPrinterActiveJobStage, workspaceMaterialOutcomesResponseSchema, workspacePrinterOutcomesResponseSchema, workspaceStatsResponseSchema, type WorkspaceStatsResponse } from '@printstream/shared'
import { requireRequestPermission } from '../lib/authorization.js'
import { buildFilamentSummary } from '../lib/filament-summary.js'
import { isManagedBridgeMode } from '../lib/managed-bridge.js'
import { readWorkspacePrintOutcomeBreakdown } from '../lib/print-outcome-breakdown.js'
import { prisma } from '../lib/prisma.js'
import { isMissingColumnError } from '../lib/prisma-errors.js'
import { printerManager } from '../lib/printer-manager.js'
import { requireRequestWorkspaceId } from '../lib/request-helpers.js'
import { readWorkspaceStatsActivityHistory } from '../lib/stats-activity-history.js'
import { readWorkspacePrinterOutcomes } from '../lib/workspace-printer-outcomes.js'
import { readWorkspaceMaterialOutcomes } from '../lib/workspace-material-outcomes.js'
import { parseStatsDateRangeQuery } from '../lib/stats-date-range.js'
import { readRangedPrintStats } from '../lib/ranged-print-stats.js'
import { withWorkspaceRequestContext } from '../lib/workspace-context.js'

function secondsToHours(seconds: number): number {
  return seconds / 3600
}

async function readWorkspaceStatsRow() {
  try {
    return await prisma.workspaceStats.findFirst({
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
    console.warn('Falling back to legacy workspace stats query; failed/cancelled breakdown columns are missing')
    const [row, legacyBreakdown] = await Promise.all([
      prisma.workspaceStats.findFirst({
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
      readWorkspacePrintOutcomeBreakdown()
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

export const workspaceStatsRouter = Router()

workspaceStatsRouter.get('/printers', requireRequestPermission(PRINTERS_VIEW_PERMISSION), async (request, response) => {
  const workspaceId = requireRequestWorkspaceId(request)
  const range = parseStatsDateRangeQuery(request.query)
  const printers = await withWorkspaceRequestContext(request.workspace ?? null, async () => (
    await readWorkspacePrinterOutcomes(workspaceId, range)
  ))
  response.json(workspacePrinterOutcomesResponseSchema.parse({ printers }))
})

workspaceStatsRouter.get('/materials', requireRequestPermission(PRINTERS_VIEW_PERMISSION), async (request, response) => {
  const workspaceId = requireRequestWorkspaceId(request)
  const range = parseStatsDateRangeQuery(request.query)
  const materials = await withWorkspaceRequestContext(request.workspace ?? null, async () => (
    await readWorkspaceMaterialOutcomes(workspaceId, range)
  ))
  response.json(workspaceMaterialOutcomesResponseSchema.parse({ materials }))
})

workspaceStatsRouter.get('/', async (request, response) => {
  const workspaceId = requireRequestWorkspaceId(request)
  const range = parseStatsDateRangeQuery(request.query)

  const [printerCount, bridgeCount, statsRow, activityLast30Days, unfinishedJobs, historicalPrintCount] = await withWorkspaceRequestContext(request.workspace ?? null, async () => await Promise.all([
    prisma.printer.count(),
    prisma.bridge.count(),
    range ? readRangedPrintStats({ workspaceId, range }) : readWorkspaceStatsRow(),
    readWorkspaceStatsActivityHistory(range),
    prisma.printJob.findMany({ where: { finishedAt: null }, select: { printerId: true } }),
    range ? prisma.printJob.count({ where: { result: { in: ['success', 'failed', 'cancelled'] } } }) : Promise.resolve(null)
  ]))

  const activePrinterIds = new Set<string>(unfinishedJobs.map((job) => job.printerId))
  for (const status of printerManager.snapshots()) {
    if (printerManager.getWorkspaceId(status.printerId) === workspaceId && isPrinterActiveJobStage(status.stage)) {
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
      complete: (historicalPrintCount ?? totalPrints) > 0
    }
  ] satisfies WorkspaceStatsResponse['quickStartItems']
  // Managed-bridge installs own the bundled bridge themselves, so the operator
  // never "connects" one: drop that onboarding step.
  const quickStartItems = isManagedBridgeMode()
    ? allQuickStartItems.filter((item) => item.id !== 'connect-bridge')
    : allQuickStartItems

  response.json(workspaceStatsResponseSchema.parse({
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
  } satisfies WorkspaceStatsResponse))
})
