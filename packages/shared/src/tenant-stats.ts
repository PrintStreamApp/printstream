/**
 * Shared contract for the workspace (tenant) stats page: the durable print/
 * filament rollups (mirroring `TenantStats`), the get-started quick-start
 * checklist, and the activity history. Consumed by the tenant stats view.
 */
import { z } from 'zod'
import { statsActivityHistorySchema } from './stats-activity.js'

export const tenantStatsQuickStartItemSchema = z.object({
  id: z.enum(['connect-bridge', 'add-printer', 'start-first-print']),
  title: z.string().min(1),
  description: z.string().min(1),
  complete: z.boolean()
})

export type TenantStatsQuickStartItem = z.infer<typeof tenantStatsQuickStartItemSchema>

export const tenantStatsSummarySchema = z.object({
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

export type TenantStatsSummary = z.infer<typeof tenantStatsSummarySchema>

export const tenantStatsResponseSchema = z.object({
  setupRequired: z.boolean(),
  hasConnectedBridges: z.boolean(),
  quickStartCompletedCount: z.number().int().nonnegative(),
  quickStartItems: z.array(tenantStatsQuickStartItemSchema),
  stats: tenantStatsSummarySchema
})

export type TenantStatsResponse = z.infer<typeof tenantStatsResponseSchema>