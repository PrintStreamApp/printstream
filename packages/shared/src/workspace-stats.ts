/**
 * Shared contract for the workspace (workspace) stats page: the durable print/
 * filament rollups (mirroring `WorkspaceStats`), the get-started quick-start
 * checklist, and the activity history. Consumed by the workspace stats view.
 */
import { z } from 'zod'
import { statsActivityHistorySchema } from './stats-activity.js'

export const workspaceStatsQuickStartItemSchema = z.object({
  id: z.enum(['connect-bridge', 'add-printer', 'start-first-print']),
  title: z.string().min(1),
  description: z.string().min(1),
  complete: z.boolean()
})

export type WorkspaceStatsQuickStartItem = z.infer<typeof workspaceStatsQuickStartItemSchema>

export const workspaceStatsSummarySchema = z.object({
  printerCount: z.number().int().nonnegative(),
  printsInProgress: z.number().int().nonnegative(),
  activityLast30Days: statsActivityHistorySchema,
  totalPrints: z.number().int().nonnegative(),
  successfulPrints: z.number().int().nonnegative(),
  failedPrints: z.number().int().nonnegative(),
  cancelledPrints: z.number().int().nonnegative(),
  failedOrCancelledPrints: z.number().int().nonnegative(),
  totalPrintHours: z.number().nonnegative(),
  successfulPrintHours: z.number().nonnegative(),
  failedPrintHours: z.number().nonnegative(),
  cancelledPrintHours: z.number().nonnegative(),
  wastedPrintHours: z.number().nonnegative(),
  filamentKilogramsPrinted: z.number().nonnegative().nullable(),
  successfulFilamentKilogramsPrinted: z.number().nonnegative().nullable(),
  failedFilamentKilogramsPrinted: z.number().nonnegative().nullable(),
  cancelledFilamentKilogramsPrinted: z.number().nonnegative().nullable(),
  wastedFilamentKilogramsPrinted: z.number().nonnegative().nullable(),
  filamentMetersPrinted: z.number().nonnegative().nullable(),
  successfulFilamentMetersPrinted: z.number().nonnegative().nullable(),
  failedFilamentMetersPrinted: z.number().nonnegative().nullable(),
  cancelledFilamentMetersPrinted: z.number().nonnegative().nullable(),
  wastedFilamentMetersPrinted: z.number().nonnegative().nullable(),
  filamentFeetPrinted: z.number().nonnegative().nullable(),
  successfulFilamentFeetPrinted: z.number().nonnegative().nullable(),
  failedFilamentFeetPrinted: z.number().nonnegative().nullable(),
  cancelledFilamentFeetPrinted: z.number().nonnegative().nullable(),
  wastedFilamentFeetPrinted: z.number().nonnegative().nullable()
})

export type WorkspaceStatsSummary = z.infer<typeof workspaceStatsSummarySchema>

export const workspaceStatsResponseSchema = z.object({
  setupRequired: z.boolean(),
  hasConnectedBridges: z.boolean(),
  quickStartCompletedCount: z.number().int().nonnegative(),
  quickStartItems: z.array(workspaceStatsQuickStartItemSchema),
  stats: workspaceStatsSummarySchema
})

export type WorkspaceStatsResponse = z.infer<typeof workspaceStatsResponseSchema>