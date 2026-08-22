/**
 * Wire contracts for the `maintenance` plugin, shared by its API routes
 * (`apps/api/src/plugins/maintenance`) and its web client
 * (`apps/web/src/plugins/maintenance`).
 *
 * The catalog and the due-date math live next door in `printer-maintenance.ts`
 * and stay Zod-free; this module owns only what crosses the HTTP boundary.
 * Dates are ISO strings on the wire.
 *
 * Two shapes matter to callers:
 *
 * - {@link maintenancePrinterResponseSchema} is the printer detail view: every
 *   task with its EFFECTIVE intervals (catalog value, or the user's override)
 *   already resolved, so the client never re-implements the merge. The catalog
 *   values ride along in `catalogIntervals` purely so the UI can show what it is
 *   overriding and offer a reset.
 * - {@link maintenanceSummaryResponseSchema} is the printers-grid feed: one
 *   request covering every printer, so N printer cards do not make N requests.
 *
 * Interval fields use `null` to mean "no interval of this kind" and are absent
 * when unchanged — a PATCH that omits `intervalDays` leaves it alone, while one
 * sending `null` clears it. That distinction is the whole reason the task table
 * carries `intervalsCleared`.
 */
import { z } from 'zod'

export const maintenanceLubricantSchema = z.enum(['oil', 'grease', 'none'])
export const maintenanceStatusSchema = z.enum(['disabled', 'not-logged', 'ok', 'due-soon', 'due'])
export const maintenanceTriggerKindSchema = z.enum(['days', 'printHours', 'filamentKilograms'])

/** Where a task's definition comes from: the shared catalog, or the user. */
export const maintenanceTaskSourceSchema = z.enum(['catalog', 'custom'])

export const maintenanceIntervalsSchema = z.object({
  days: z.number().positive().nullable(),
  printHours: z.number().positive().nullable(),
  filamentKilograms: z.number().positive().nullable()
})
export type MaintenanceIntervals = z.infer<typeof maintenanceIntervalsSchema>

export const maintenanceTriggerSchema = z.object({
  kind: maintenanceTriggerKindSchema,
  interval: z.number().positive(),
  /** Accrued since the last completion; null when the metric is not being recorded. */
  elapsed: z.number().nullable(),
  progress: z.number().nullable(),
  dueAt: z.string().datetime().nullable(),
  /** The metric this trigger needs is unavailable, so it is inert rather than fresh. */
  unavailable: z.boolean()
})
export type MaintenanceTriggerDto = z.infer<typeof maintenanceTriggerSchema>

export const maintenanceTaskSchema = z.object({
  key: z.string().min(1),
  title: z.string().min(1),
  summary: z.string(),
  lubricant: maintenanceLubricantSchema,
  source: maintenanceTaskSourceSchema,
  /** Bambu's own wording for the interval, when the catalog carries one. */
  intervalNote: z.string().nullable(),
  /** Intervals actually in force: the user's override where set, else the catalog's. */
  intervals: maintenanceIntervalsSchema,
  /** What the catalog says, so the UI can label an override and offer a reset. */
  catalogIntervals: maintenanceIntervalsSchema,
  /** True where the user's value differs from the catalog's. */
  customized: z.boolean(),
  disabled: z.boolean(),
  status: maintenanceStatusSchema,
  progress: z.number().nullable(),
  triggers: z.array(maintenanceTriggerSchema),
  dueAt: z.string().datetime().nullable(),
  lastCompletedAt: z.string().datetime().nullable(),
  /** The printer is asking for this job via an active HMS code. */
  printerRequested: z.boolean()
})
export type MaintenanceTaskDto = z.infer<typeof maintenanceTaskSchema>

export const maintenanceScheduleInfoSchema = z.object({
  id: z.string(),
  label: z.string(),
  wikiUrl: z.string().url(),
  /**
   * The printer's model is not in the catalog, so these are general intervals
   * rather than Bambu's numbers for this machine. The UI must say so.
   */
  generic: z.boolean()
})
export type MaintenanceScheduleInfo = z.infer<typeof maintenanceScheduleInfoSchema>

export const maintenanceUsageSchema = z.object({
  /** Lifetime print hours; null when unavailable. */
  printHours: z.number().nonnegative().nullable(),
  /** Lifetime filament mass in kilograms — one roll is one kilogram. Null when untracked. */
  filamentKilograms: z.number().nonnegative().nullable()
})
export type MaintenanceUsageDto = z.infer<typeof maintenanceUsageSchema>

export const maintenancePrinterResponseSchema = z.object({
  printerId: z.string(),
  printerName: z.string(),
  printerModel: z.string(),
  schedule: maintenanceScheduleInfoSchema,
  usage: maintenanceUsageSchema,
  tasks: z.array(maintenanceTaskSchema)
})
export type MaintenancePrinterResponse = z.infer<typeof maintenancePrinterResponseSchema>

/** One printer's roll-up for the printers grid. */
export const maintenanceSummaryEntrySchema = z.object({
  printerId: z.string(),
  dueCount: z.number().int().nonnegative(),
  dueSoonCount: z.number().int().nonnegative(),
  /** True when at least one due task is due because the printer asked for it. */
  printerRequested: z.boolean()
})
export type MaintenanceSummaryEntry = z.infer<typeof maintenanceSummaryEntrySchema>

export const maintenanceSummaryResponseSchema = z.object({
  printers: z.array(maintenanceSummaryEntrySchema)
})
export type MaintenanceSummaryResponse = z.infer<typeof maintenanceSummaryResponseSchema>

export const maintenanceHistoryEntrySchema = z.object({
  id: z.string(),
  completedAt: z.string().datetime(),
  printHours: z.number().nonnegative().nullable(),
  filamentKilograms: z.number().nonnegative().nullable(),
  note: z.string().nullable(),
  performedBy: z.string().nullable()
})
export type MaintenanceHistoryEntry = z.infer<typeof maintenanceHistoryEntrySchema>

export const maintenanceHistoryResponseSchema = z.object({
  entries: z.array(maintenanceHistoryEntrySchema)
})
export type MaintenanceHistoryResponse = z.infer<typeof maintenanceHistoryResponseSchema>

/** Marking a task done. `completedAt` defaults to now; back-dating is allowed. */
export const maintenanceCompleteRequestSchema = z.object({
  completedAt: z.string().datetime().optional(),
  note: z.string().trim().max(500).optional()
})
export type MaintenanceCompleteRequest = z.infer<typeof maintenanceCompleteRequestSchema>

/**
 * A nullable interval that distinguishes three intents: absent = leave alone,
 * `null` = clear it (never due on this measure), a number = use this value.
 */
const intervalPatchSchema = z.number().positive().nullable().optional()

export const maintenanceTaskPatchRequestSchema = z.object({
  intervalDays: intervalPatchSchema,
  intervalPrintHours: intervalPatchSchema,
  intervalFilamentKilograms: intervalPatchSchema,
  disabled: z.boolean().optional(),
  /** Custom tasks only — the catalog owns wording for its own tasks. */
  title: z.string().trim().min(1).max(120).optional(),
  lubricant: maintenanceLubricantSchema.optional()
})
export type MaintenanceTaskPatchRequest = z.infer<typeof maintenanceTaskPatchRequestSchema>

/**
 * Define a task the catalog does not cover — the escape hatch for a printer
 * model newer than this build, or a shop's own routine.
 */
export const maintenanceCustomTaskRequestSchema = z.object({
  title: z.string().trim().min(1).max(120),
  lubricant: maintenanceLubricantSchema.default('none'),
  intervalDays: z.number().positive().nullable().optional(),
  intervalPrintHours: z.number().positive().nullable().optional(),
  intervalFilamentKilograms: z.number().positive().nullable().optional()
})
export type MaintenanceCustomTaskRequest = z.infer<typeof maintenanceCustomTaskRequestSchema>

/** Prefix marking a task key as user-defined rather than a catalog key. */
export const CUSTOM_MAINTENANCE_TASK_PREFIX = 'custom:'

export function isCustomMaintenanceTaskKey(taskKey: string): boolean {
  return taskKey.startsWith(CUSTOM_MAINTENANCE_TASK_PREFIX)
}
