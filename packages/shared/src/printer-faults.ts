/**
 * Durable printer-fault history shared by Jobs HTTP responses and the web cards.
 * Times describe observations, never the physical onset or end of a fault. Gaps
 * remain visible after reconciliation; an open gap makes an uncleared fault uncertain.
 */
import { z } from 'zod'

export const printerFaultSourceSchema = z.enum(['hms', 'device_error'])
export type PrinterFaultSource = z.infer<typeof printerFaultSourceSchema>

export const printerFaultSchema = z.object({
  id: z.string(),
  source: printerFaultSourceSchema,
  code: z.string(),
  message: z.string().nullable(),
  firstObservedAt: z.string(),
  lastObservedAt: z.string(),
  observedClearedAt: z.string().nullable(),
  state: z.enum(['active', 'uncertain', 'cleared']),
  alreadyPresent: z.boolean().default(false),
  gaps: z.array(z.object({
    startedAt: z.string(),
    endedAt: z.string().nullable(),
    reason: z.enum(['disconnect', 'restart'])
  }))
})
export type PrinterFault = z.infer<typeof printerFaultSchema>

/** A standalone reference for idle observations or retained history after job deletion. */
export const printerFaultHistorySchema = z.object({
  id: z.string(),
  printerId: z.string(),
  printerName: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  fault: printerFaultSchema
})
export type PrinterFaultHistory = z.infer<typeof printerFaultHistorySchema>
