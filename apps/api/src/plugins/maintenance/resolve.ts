/**
 * Merges the four inputs a maintenance view needs into the wire DTOs: the shared
 * catalog, the user's per-printer overrides, the last completion, and the live
 * usage counters.
 *
 * This module owns the **override merge**, and it is the only place that does
 * it: the client receives intervals already resolved, so no surface can drift
 * on the precedence rules. Those rules:
 *
 * - An override interval wins over the catalog's.
 * - An interval named in `intervalsCleared` is off, even though the catalog has
 *   a value. A null column alone cannot say that (null also means "inherit"),
 *   which is why the cleared list exists.
 * - A `custom:` task has no catalog entry at all; its row supplies everything,
 *   and its catalog intervals report as all-null so the UI offers no reset.
 *
 * The due-date arithmetic itself is NOT here, it lives in
 * `@printstream/shared` (`evaluateMaintenanceTask`) so the rules are testable
 * without a database and identical wherever they are applied.
 */
import {
  evaluateMaintenanceTask,
  isCustomMaintenanceTaskKey,
  resolveMaintenanceSchedule,
  type MaintenanceIntervals,
  type MaintenanceLubricant,
  type MaintenanceSchedule,
  type MaintenanceTaskDefinition,
  type MaintenanceTaskDto,
  type MaintenanceTriggerDto
} from '@printstream/shared'
import type { MaintenanceLogRow, MaintenanceTaskRow } from './store.js'
import type { PrinterUsageCounters } from './usage.js'

const NO_INTERVALS: MaintenanceIntervals = { days: null, printHours: null, filamentKilograms: null }

function toNumber(value: unknown): number | null {
  if (value == null) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function catalogIntervalsOf(definition: MaintenanceTaskDefinition): MaintenanceIntervals {
  return {
    days: definition.intervalDays ?? null,
    printHours: definition.intervalPrintHours ?? null,
    filamentKilograms: definition.intervalFilamentKilograms ?? null
  }
}

/**
 * Resolve one interval kind. `cleared` beats everything (the user switched this
 * measure off), then the override value, then the catalog's.
 */
function effectiveInterval(
  catalogValue: number | null,
  overrideValue: number | null,
  cleared: boolean
): number | null {
  if (cleared) return null
  return overrideValue ?? catalogValue
}

function buildTriggerDtos(
  triggers: ReturnType<typeof evaluateMaintenanceTask>['triggers']
): MaintenanceTriggerDto[] {
  return triggers.map((trigger) => ({
    kind: trigger.kind,
    interval: trigger.interval,
    elapsed: trigger.elapsed,
    progress: trigger.progress,
    dueAt: trigger.dueAt?.toISOString() ?? null,
    unavailable: trigger.unavailable
  }))
}

/**
 * A user-defined task presented in the same shape as a catalog one. Its summary
 * says where it came from, because a custom task carries no Bambu sourcing and
 * the UI must not imply otherwise.
 */
function customDefinition(row: MaintenanceTaskRow): MaintenanceTaskDefinition {
  return {
    key: row.taskKey,
    title: row.customTitle ?? 'Custom maintenance task',
    summary: 'Added for this printer.',
    lubricant: (row.customLubricant as MaintenanceLubricant | null) ?? 'none',
    intervalDays: row.intervalDays ?? undefined,
    intervalPrintHours: row.intervalPrintHours ?? undefined,
    intervalFilamentKilograms: toNumber(row.intervalFilamentKilograms) ?? undefined
  }
}

export interface ResolveTasksInput {
  printerModel: string | null
  overrides: MaintenanceTaskRow[]
  /** Newest completion per task key. */
  completions: Map<string, MaintenanceLogRow>
  usage: PrinterUsageCounters
  /** Canonical HMS codes currently active on the printer. */
  activeHmsCodes: readonly string[]
  now: Date
}

export interface ResolvedTasks {
  schedule: MaintenanceSchedule
  tasks: MaintenanceTaskDto[]
}

/**
 * Build the full task list for one printer: every catalog task for its model,
 * then any custom tasks the user added, each evaluated against its completion
 * and the printer's usage.
 */
export function resolvePrinterTasks(input: ResolveTasksInput): ResolvedTasks {
  const schedule = resolveMaintenanceSchedule(input.printerModel)
  const overridesByKey = new Map(input.overrides.map((row) => [row.taskKey, row]))

  const catalogTasks = schedule.tasks.map((definition) =>
    buildTaskDto(definition, overridesByKey.get(definition.key) ?? null, 'catalog', input)
  )

  const customTasks = input.overrides
    .filter((row) => isCustomMaintenanceTaskKey(row.taskKey))
    .map((row) => buildTaskDto(customDefinition(row), row, 'custom', input))

  return { schedule, tasks: [...catalogTasks, ...customTasks] }
}

function buildTaskDto(
  definition: MaintenanceTaskDefinition,
  override: MaintenanceTaskRow | null,
  source: 'catalog' | 'custom',
  input: ResolveTasksInput
): MaintenanceTaskDto {
  const catalogIntervals = source === 'custom' ? NO_INTERVALS : catalogIntervalsOf(definition)
  const cleared = new Set(override?.intervalsCleared ?? [])

  const intervals: MaintenanceIntervals = {
    days: effectiveInterval(catalogIntervals.days, override?.intervalDays ?? null, cleared.has('days')),
    printHours: effectiveInterval(catalogIntervals.printHours, override?.intervalPrintHours ?? null, cleared.has('printHours')),
    filamentKilograms: effectiveInterval(
      catalogIntervals.filamentKilograms,
      toNumber(override?.intervalFilamentKilograms),
      cleared.has('filamentKilograms')
    )
  }

  const completion = input.completions.get(definition.key) ?? null
  const evaluation = evaluateMaintenanceTask({
    definition: {
      // Feed the ALREADY-MERGED intervals through as the definition, and pass no
      // override: the merge happened above, where the cleared-vs-inherit rule
      // lives. Passing both would apply precedence twice.
      intervalDays: intervals.days ?? undefined,
      intervalPrintHours: intervals.printHours ?? undefined,
      intervalFilamentKilograms: intervals.filamentKilograms ?? undefined,
      hmsCodes: definition.hmsCodes
    },
    override: { disabled: override?.disabledAt != null },
    completion: completion
      ? {
          completedAt: completion.completedAt,
          printHours: toNumber(completion.printHours),
          filamentKilograms: toNumber(completion.filamentKilograms)
        }
      : null,
    usage: input.usage,
    activeHmsCodes: input.activeHmsCodes,
    now: input.now
  })

  const customized = source === 'custom'
    ? false
    : intervals.days !== catalogIntervals.days
      || intervals.printHours !== catalogIntervals.printHours
      || intervals.filamentKilograms !== catalogIntervals.filamentKilograms

  return {
    key: definition.key,
    title: definition.title,
    summary: definition.summary,
    lubricant: definition.lubricant,
    source,
    intervalNote: definition.intervalNote ?? null,
    intervals,
    catalogIntervals,
    customized,
    disabled: override?.disabledAt != null,
    status: evaluation.status,
    progress: evaluation.progress,
    triggers: buildTriggerDtos(evaluation.triggers),
    dueAt: evaluation.dueAt?.toISOString() ?? null,
    lastCompletedAt: evaluation.lastCompletedAt?.toISOString() ?? null,
    printerRequested: evaluation.printerRequested
  }
}
