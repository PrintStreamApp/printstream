/**
 * Aggregate presentation for a grouped status toast: the one line that stands
 * in for N jobs while they are collapsed.
 *
 * Owns two rules the three job-toast surfaces (dispatch, slicing, deletes) used
 * to each answer for themselves: what tone the combined toast takes, and what
 * its headline says. Kept pure and Joy-free so both are testable without
 * mounting the portal; `StatusToastGroup` renders what this returns.
 *
 * The tone precedence is deliberate: a failure outranks work still in flight.
 * Three uploads running with one already failed is an alert, and colouring the
 * toast "busy" would hide the only thing the user has to act on.
 */
import { plural } from './plural'

export type StatusToastColor = 'neutral' | 'primary' | 'success' | 'warning' | 'danger'

/** The slice of a toast item this module reasons about. */
export interface StatusToastGroupMember {
  /** Still running (queued counts as running, it is work that has not landed). */
  active: boolean
  color: StatusToastColor
  /** Percent 0-100, or `null` while running with no reported extent. */
  progress: number | null
}

export interface StatusToastGroupSummary {
  total: number
  activeCount: number
  failedCount: number
  color: StatusToastColor
  /** True while anything is still running, which is what earns a spinner/bar. */
  busy: boolean
  /**
   * Combined percent across the running items, or `null` when none of them
   * reports an extent. An active item with no percent counts as 0 rather than
   * being dropped: a job that has not started yet is at zero, and averaging only
   * the items that do report would claim the batch is further along than it is.
   */
  progress: number | null
}

export function summarizeStatusToastGroup(items: readonly StatusToastGroupMember[]): StatusToastGroupSummary {
  const activeItems = items.filter((item) => item.active)
  const failedCount = items.filter((item) => item.color === 'danger').length
  const reportedCount = activeItems.filter((item) => item.progress != null).length

  return {
    total: items.length,
    activeCount: activeItems.length,
    failedCount,
    color: resolveGroupColor(items, failedCount, activeItems.length),
    busy: activeItems.length > 0,
    progress: reportedCount === 0
      ? null
      : Math.round(activeItems.reduce((sum, item) => sum + (item.progress ?? 0), 0) / activeItems.length)
  }
}

/** Words a surface supplies so the shared headline reads in its own domain. */
export interface StatusToastGroupWording {
  /** Present tense, for work in flight: `Sending`. */
  activeVerb: string
  /** Singular noun; counted through {@link plural}: `print`. */
  noun: string
  /** Past tense, for a settled batch: `sent`. */
  doneWord: string
}

export function formatStatusToastGroupHeadline(
  summary: StatusToastGroupSummary,
  wording: StatusToastGroupWording
): string {
  const { activeCount, failedCount, total } = summary

  if (activeCount > 0) {
    // Name the total whenever finished items are still listed below: a headline
    // reading "Deleting 1 item" above two rows looks like a miscount.
    const running = activeCount === total
      ? `${wording.activeVerb} ${plural(activeCount, wording.noun)}`
      : `${wording.activeVerb} ${activeCount} of ${plural(total, wording.noun)}`
    return failedCount > 0 ? `${running} - ${failedCount} failed` : running
  }
  if (failedCount > 0) {
    return failedCount === total
      ? `${plural(failedCount, wording.noun)} failed`
      : `${failedCount} of ${plural(total, wording.noun)} failed`
  }
  return `${plural(total, wording.noun)} ${wording.doneWord}`
}

function resolveGroupColor(
  items: readonly StatusToastGroupMember[],
  failedCount: number,
  activeCount: number
): StatusToastColor {
  if (failedCount > 0) return 'danger'
  if (activeCount > 0) return 'primary'
  if (items.some((item) => item.color === 'warning')) return 'warning'
  if (items.some((item) => item.color === 'success')) return 'success'
  return 'neutral'
}
