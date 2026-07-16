/**
 * Shared contract for a single printer's stats card: the durable per-printer
 * rollup (mirrors the `PrinterStats` model, including the manual pre-PrintStream
 * usage kept separate from tracked counters) plus the in-progress live count.
 * Consumed by the printer detail view.
 */
import { z } from 'zod'

export const printerStatsSchema = z.object({
  printsInProgress: z.number().int().nonnegative(),
  /**
   * User-entered usage from outside PrintStream's tracking (edited on the printer).
   * Already included in `totalPrints` / `totalPrintHours`; exposed separately so the
   * UI can prefill the edit form and label the manual share of the totals.
   */
  manualPrints: z.number().int().nonnegative(),
  manualPrintHours: z.number().nonnegative(),
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
export type PrinterStats = z.infer<typeof printerStatsSchema>

export const printerStatsResponseSchema = z.object({
  stats: printerStatsSchema
})
export type PrinterStatsResponse = z.infer<typeof printerStatsResponseSchema>