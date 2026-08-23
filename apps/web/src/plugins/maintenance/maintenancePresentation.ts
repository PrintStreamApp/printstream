/**
 * Presentation rules for maintenance status: colours, status wording, and the
 * phrasing of an interval or a due date.
 *
 * One module because the same task appears in three places, the printer card
 * chip, the section list, and the edit dialog, and a status that reads "Due" in
 * one and "Overdue" in another looks like two different states of two different
 * things. Every surface formats through here.
 *
 * Intervals are stored in days but read badly that way past a couple of months:
 * Bambu's guidance is written in months, so 90 days is shown as "3 months", not
 * "90 days". The stored unit does not change, only the wording.
 */
import type { MaintenanceStatus, MaintenanceTaskDto, MaintenanceTriggerDto } from '@printstream/shared'

export type MaintenanceColor = 'danger' | 'warning' | 'success' | 'neutral'

export function maintenanceStatusColor(status: MaintenanceStatus): MaintenanceColor {
  if (status === 'due') return 'danger'
  if (status === 'due-soon') return 'warning'
  if (status === 'ok') return 'success'
  return 'neutral'
}

export function maintenanceStatusLabel(task: Pick<MaintenanceTaskDto, 'status' | 'printerRequested'>): string {
  if (task.status === 'due') return task.printerRequested ? 'Printer asked' : 'Due'
  if (task.status === 'due-soon') return 'Due soon'
  if (task.status === 'ok') return 'OK'
  if (task.status === 'disabled') return 'Off'
  return 'Not logged'
}

/** Whole months when the interval divides evenly, otherwise days. */
export function formatDayInterval(days: number): string {
  if (days % 30 === 0 && days >= 30) {
    const months = days / 30
    return months === 1 ? 'Monthly' : `Every ${months} months`
  }
  if (days === 7) return 'Weekly'
  if (days % 7 === 0 && days >= 14) return `Every ${days / 7} weeks`
  return days === 1 ? 'Daily' : `Every ${days} days`
}

/**
 * The interval line under a task title, e.g. "Every 3 months, or every 3 kg of
 * filament". Multiple intervals are joined with "or" because whichever elapses
 * first wins: "and" would read as needing both.
 */
export function formatIntervals(task: Pick<MaintenanceTaskDto, 'intervals'>): string {
  const parts: string[] = []
  if (task.intervals.days != null) parts.push(formatDayInterval(task.intervals.days).toLowerCase())
  if (task.intervals.printHours != null) parts.push(`every ${formatNumber(task.intervals.printHours)} print hours`)
  if (task.intervals.filamentKilograms != null) parts.push(`every ${formatNumber(task.intervals.filamentKilograms)} kg of filament`)
  if (parts.length === 0) return 'No interval set'
  const joined = parts.join(', or ')
  return joined.charAt(0).toUpperCase() + joined.slice(1)
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * When the task next comes due, in plain words. Falls back to the leading usage
 * trigger when there is no calendar interval, so an hours- or kilograms-driven
 * task still says something concrete rather than going blank.
 */
export function formatDueSummary(task: MaintenanceTaskDto, now: Date = new Date()): string {
  if (task.status === 'disabled') return 'Switched off'
  if (task.printerRequested) return 'The printer is asking for this'
  if (task.status === 'not-logged') return 'Mark it done to start tracking'

  if (task.dueAt) {
    const days = Math.round((new Date(task.dueAt).getTime() - now.getTime()) / MS_PER_DAY)
    if (days < 0) return `Overdue by ${formatDayCount(-days)}`
    if (days === 0) return 'Due today'
    return `Due in ${formatDayCount(days)}`
  }

  const leading = leadingUsageTrigger(task)
  if (leading) {
    const remaining = Math.max(0, leading.interval - (leading.elapsed ?? 0))
    if (leading.kind === 'printHours') return `Due in ${formatNumber(remaining)} print hours`
    return `Due in ${formatNumber(remaining)} kg of filament`
  }
  return 'No interval set'
}

function leadingUsageTrigger(task: MaintenanceTaskDto): MaintenanceTriggerDto | null {
  const measured = task.triggers.filter((trigger) => !trigger.unavailable && trigger.progress != null)
  if (measured.length === 0) return null
  return measured.reduce((best, trigger) => ((trigger.progress ?? 0) > (best.progress ?? 0) ? trigger : best))
}

function formatDayCount(days: number): string {
  if (days < 14) return days === 1 ? '1 day' : `${days} days`
  const weeks = Math.round(days / 7)
  if (weeks < 9) return `${weeks} weeks`
  const months = Math.round(days / 30)
  return months === 1 ? '1 month' : `${months} months`
}

/**
 * Why a usage trigger is inert, in words the user can act on. An untracked
 * metric is NOT the same as a fresh one, and saying nothing here is what would
 * make a permanently-green consumable task look correct.
 */
export function unavailableTriggerNote(trigger: MaintenanceTriggerDto): string | null {
  if (!trigger.unavailable) return null
  if (trigger.kind === 'filamentKilograms') return 'No filament use recorded yet, so the roll count is not tracking.'
  if (trigger.kind === 'printHours') return 'No print hours recorded yet.'
  return null
}

export function lubricantLabel(lubricant: MaintenanceTaskDto['lubricant']): string | null {
  if (lubricant === 'oil') return 'Oil'
  if (lubricant === 'grease') return 'Grease'
  return null
}
